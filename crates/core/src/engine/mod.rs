//! The run engine: drives tasks through planning, dev, checks, QA and human review, and keeps one
//! durable record of where each task is, so closing, crashing or pausing the app never loses the
//! place.
//!
//! * [`step::next_step`] decides what happens next from the task file alone.
//! * The driver ([`driver`]) executes one step at a time and writes each result, plus the next state,
//!   in a single store update.
//! * Opening a project takes an exclusive lock ([`lock`]) and reconciles runs left behind by a
//!   previous process ([`reconcile`]).
//! * Nothing starts on its own after a restart: interrupted tasks wait for the user's Resume.

pub mod checks;
pub mod driver;
pub mod extract;
pub mod lock;
pub mod output;
pub mod pr;
pub mod prompts;
pub mod reconcile;
pub mod runlog;
pub mod settings;
pub mod step;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{Semaphore, broadcast, watch};

use crate::agent::{AgentEvent, Binaries, Stopper};
use crate::error::{CoreError, Result};
use crate::git::{self, DeleteOptions, Worktrees};
use crate::project::ProjectDir;
use crate::store::TaskStore;
use crate::task::{
    AgentConfig, Answer, Phase, PlanningStage, RunKind, RunState, SubtaskStatus, Task,
};
use crate::transitions::Mover;
use crate::util::{now_ms, random_base36};

use self::lock::ProjectLock;
use self::settings::Settings;

/// Something the UI may want to redraw.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    /// The task file changed.
    TaskChanged { task_id: String },
    /// An agent working on the task did something.
    Agent {
        task_id: String,
        run_id: String,
        /// The run log the event is written to (`RunLogInfo::name`): one run can write several
        /// (triage, the step, a repair turn), each numbering its events from 1.
        log: String,
        /// The event's number in its run log (1-based), the same as the log line's `seq`.
        seq: u64,
        event: AgentEvent,
    },
    /// The task's driver stopped on an error that has no run to record it on (for example an
    /// engine bug). Shown to the user; the task file is unchanged.
    Error { task_id: String, message: String },
}

/// Why a driver is being asked to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Halt {
    /// The user paused: the run becomes `paused`.
    Pause,
    /// The app is closing (or the task is being deleted): the run becomes `interrupted`.
    Shutdown,
}

/// What the engine keeps about a task whose driver is running.
pub(crate) struct Control {
    pub halt: watch::Sender<Option<Halt>>,
    pub stopper: StdMutex<Option<Stopper>>,
    pub finished: watch::Sender<bool>,
    /// A command arrived while the driver was on its way out; it must look again before leaving.
    pub rerun: AtomicBool,
}

impl Control {
    fn request(&self, halt: Halt) {
        // send_replace, not send: send drops the value when nobody has subscribed, and the
        // driver reads it through the sender.
        self.halt.send_replace(Some(halt));
        if let Some(s) = self
            .stopper
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            s.stop();
        }
    }

    /// Resolves once a halt has been requested.
    pub async fn halted(&self) {
        let mut rx = self.halt.subscribe();
        loop {
            if rx.borrow_and_update().is_some() {
                return;
            }
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }

    pub fn halt_requested(&self) -> Option<Halt> {
        *self.halt.borrow()
    }
}

pub(crate) struct Inner {
    pub project: ProjectDir,
    pub store: TaskStore,
    pub bins: Binaries,
    pub settings: StdMutex<Settings>,
    pub boot_id: String,
    pub agents: Arc<Semaphore>,
    pub drivers: StdMutex<HashMap<String, Arc<Control>>>,
    pub events: broadcast::Sender<EngineEvent>,
    /// Serialises pull-request creation per task.
    pub pr_locks: StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    _lock: ProjectLock,
}

impl Inner {
    pub fn settings(&self) -> Settings {
        self.settings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn emit(&self, event: EngineEvent) {
        // Errors also go to the log (the desktop app's log file), since nobody may be watching.
        if let EngineEvent::Error { task_id, message } = &event {
            log::error!("task {task_id}: {message}");
        }
        let _ = self.events.send(event);
    }

    pub async fn update<F>(&self, id: &str, change: F) -> Result<Task>
    where
        F: FnOnce(&mut Task) -> Result<()>,
    {
        let task = self.store.update(id, change).await?;
        self.emit(EngineEvent::TaskChanged {
            task_id: id.to_string(),
        });
        Ok(task)
    }

    fn control(&self, id: &str) -> Option<Arc<Control>> {
        self.drivers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
    }

    /// The folder the task's agents run in (see [`git::task_dir`]).
    pub fn task_dir(&self, id: &str) -> Result<std::path::PathBuf> {
        git::task_dir(&self.project, id)
    }

    /// Worktree operations on one repository of the project.
    pub fn repo_worktrees(&self, repo: &str) -> Result<Worktrees> {
        Worktrees::for_repo(&self.project, repo)
    }

    /// The task's repositories with their worktree paths, in name order. Empty before the
    /// worktrees exist.
    pub fn task_worktrees(&self, task: &Task) -> Result<Vec<RepoWorktree>> {
        task.repos()
            .map(|repo| {
                Ok(RepoWorktree {
                    repo: repo.to_string(),
                    path: self.repo_worktrees(repo)?.path_for(&task.id)?,
                })
            })
            .collect()
    }

    /// The repositories a new task gets: every repository of the project.
    pub fn project_repos(&self) -> Vec<String> {
        self.project
            .repos()
            .iter()
            .map(|r| r.name.clone())
            .collect()
    }

    async fn load(&self, id: &str) -> Result<Task> {
        self.store
            .load(id)
            .await?
            .ok_or_else(|| CoreError::TaskNotFound(id.to_string()))
    }
}

/// The files a task changed in one repository (see [`Engine::changes`]).
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoChanges {
    pub repo: String,
    /// At most [`git::MAX_CHANGED_FILES`], by path.
    pub files: Vec<git::ChangedFile>,
    /// How many files changed in all.
    #[cfg_attr(feature = "ts", ts(as = "f64"))]
    pub total: usize,
    /// Whether the repository has an `origin` remote: without one its work cannot be pushed, and
    /// Human Review says so instead of offering a pull request.
    pub has_remote: bool,
}

/// A repository's check commands and where they come from (see [`Engine::repo_checks`]).
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoChecks {
    pub repo: String,
    pub source: checks::CheckSource,
    pub commands: Vec<settings::CheckCommand>,
}

/// One repository's worktree for a task.
pub(crate) struct RepoWorktree {
    pub repo: String,
    pub path: std::path::PathBuf,
}

/// One project's engine. Cheap to clone; all clones share the same state.
///
/// Tasks are read and changed only through the engine, so its guards (nothing changes under a
/// running agent) and its change events always apply.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
    reconcile_problems: Arc<Vec<String>>,
}

impl Engine {
    /// Open a project: take its lock, load settings, and mark runs left by a previous process as
    /// interrupted (stopping their orphaned agents). A task file that cannot be reconciled is
    /// skipped and reported in [`Engine::reconcile_problems`], not fatal.
    pub async fn open(project: ProjectDir, bins: Binaries) -> Result<Engine> {
        let boot_id = format!("boot-{}-{}", now_ms(), random_base36(6));
        let lock = ProjectLock::acquire(&project, &boot_id).await?;
        let settings = Settings::load(&project).await?;
        let store = TaskStore::new(&project);
        let report = reconcile::reconcile(&store, &boot_id).await?;
        let (events, _) = broadcast::channel(1024);
        let inner = Inner {
            store,
            bins,
            // Fixed for the engine's lifetime; a changed maxConcurrentAgents applies on reopen.
            agents: Arc::new(Semaphore::new(settings.max_concurrent_agents as usize)),
            settings: StdMutex::new(settings),
            boot_id,
            drivers: StdMutex::new(HashMap::new()),
            events,
            pr_locks: StdMutex::new(HashMap::new()),
            project,
            _lock: lock,
        };
        Ok(Engine {
            inner: Arc::new(inner),
            reconcile_problems: Arc::new(report.problems),
        })
    }

    /// Tasks that could not be reconciled when the project was opened, with why.
    pub fn reconcile_problems(&self) -> &[String] {
        &self.reconcile_problems
    }

    pub fn project(&self) -> &ProjectDir {
        &self.inner.project
    }

    pub async fn get_task(&self, id: &str) -> Result<Option<Task>> {
        self.inner.store.load(id).await
    }

    pub async fn list_tasks(&self) -> Result<crate::store::TaskList> {
        self.inner.store.list().await
    }

    /// A user edit (title, description, agent, plan approval). The agent cannot change while the
    /// task is running or halted mid-step, since a resume continues with the agent that started.
    pub async fn patch_task(
        &self,
        id: &str,
        patch: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<Task> {
        if patch.contains_key("agent") {
            let task = self.inner.load(id).await?;
            if self.is_running(id) || task.run.is_some() {
                return Err(CoreError::Invalid(
                    "the agent cannot change while a step is running or halted".into(),
                ));
            }
        }
        let task = self.inner.store.apply_patch(id, patch).await?;
        self.inner.emit(EngineEvent::TaskChanged {
            task_id: id.to_string(),
        });
        Ok(task)
    }

    /// The task's logged agent runs, oldest first.
    pub async fn run_logs(&self, id: &str) -> Result<Vec<runlog::RunLogInfo>> {
        self.inner.load(id).await?;
        runlog::list(&self.inner.store.task_dir(id)?.join("runs")).await
    }

    /// One logged run's lines, by the name [`Engine::run_logs`] gave it.
    pub async fn run_log(&self, id: &str, name: &str) -> Result<Vec<runlog::RunLogLine>> {
        self.inner.load(id).await?;
        runlog::read(&self.inner.store.task_dir(id)?.join("runs"), name).await
    }

    /// Every worktree under `.code-automata/worktrees/`, with its task's title. A worktree whose
    /// task file exists but cannot be read is not an orphan.
    ///
    /// The repositories looked in are the project's as they are now (a workspace may have gained
    /// one since it was opened) plus every one a task file names; one that is gone or cannot be
    /// read is skipped (and logged), so it cannot hide the others.
    pub async fn worktrees(&self) -> Result<Vec<WorktreeEntry>> {
        let tasks = self.inner.store.list().await?;
        let mut repos: Vec<String> = match ProjectDir::open(self.inner.project.root()).await {
            Ok(now) => now.repos().iter().map(|r| r.name.clone()).collect(),
            Err(_) => self.inner.project_repos(),
        };
        for t in &tasks.tasks {
            for r in t.repos() {
                if !repos.iter().any(|x| x == r) {
                    repos.push(r.to_string());
                }
            }
        }
        repos.sort();
        let mut list = Vec::new();
        for repo in repos {
            let listed = match self.inner.repo_worktrees(&repo) {
                // A one-repository project lists (or fails) as before.
                Ok(w) if !self.inner.project.is_workspace() => w.list().await,
                Ok(w)
                    if tokio::fs::try_exists(w.main_checkout())
                        .await
                        .unwrap_or(false) =>
                {
                    w.list().await
                }
                Ok(_) => {
                    log::warn!(
                        "worktrees: the repository {repo} is gone; its worktrees are not listed"
                    );
                    continue;
                }
                Err(e) => Err(e),
            };
            match listed {
                Ok(found) => list.extend(found),
                // A one-repository project has nothing else to show: say why.
                Err(e) if !self.inner.project.is_workspace() => return Err(e),
                Err(e) => log::warn!("worktrees: could not list {repo}: {e}"),
            }
        }
        let unreadable: Vec<String> = tasks
            .skipped
            .iter()
            .filter_map(|s| s.path.parent()?.file_name()?.to_str().map(String::from))
            .collect();
        Ok(list
            .into_iter()
            .map(|worktree| {
                let task = tasks.tasks.iter().find(|t| t.id == worktree.task_id);
                let task_title = task.map(|t| t.title.clone());
                let task_done = task.is_some_and(|t| t.phase == Phase::Done);
                let orphan = task_title.is_none() && !unreadable.contains(&worktree.task_id);
                WorktreeEntry {
                    worktree,
                    task_title,
                    orphan,
                    task_done,
                }
            })
            .collect())
    }

    /// The files the task changed in each of its repositories, against each base commit: from the
    /// worktree (uncommitted work included) when it exists, else from the task branch. Only
    /// repositories with changes are listed.
    pub async fn changes(&self, id: &str) -> Result<Vec<RepoChanges>> {
        let task = self.inner.load(id).await?;
        let mut out = Vec::new();
        for w in self.inner.task_worktrees(&task)? {
            let Some(base) = task.base_commit(&w.repo) else {
                continue;
            };
            // Only a readable worktree: a leftover folder (no `.git`, or one git cannot read)
            // would fail or diff the wrong repository, so the branch is read instead.
            let status = git::status_at(&w.path).await;
            let (files, total) = if status.exists && status.error.is_none() {
                git::changed_files(&w.path, base, None).await?
            } else {
                let main = self.inner.repo_worktrees(&w.repo)?;
                let branch = Worktrees::branch_for(id);
                git::changed_files(main.main_checkout(), base, Some(&branch)).await?
            };
            if total > 0 {
                let main = self.inner.repo_worktrees(&w.repo)?;
                let has_remote =
                    git::run_git(main.main_checkout(), &["remote", "get-url", "origin"])
                        .await
                        .is_ok();
                out.push(RepoChanges {
                    repo: w.repo,
                    files,
                    total,
                    has_remote,
                });
            }
        }
        Ok(out)
    }

    /// Remove a worktree on its own:
    ///
    /// * an orphan (its task is gone): the folder and its local branch;
    /// * a done task's: the folder only, to free its space. The task and its branch (which holds
    ///   the work and the PR's commit) stay; reopening the task brings the worktree back.
    ///
    /// Any other task's worktree, readable or not, goes only with the task, through
    /// [`Engine::delete_task`].
    ///
    /// A done task's worktree with uncommitted changes is refused unless `force`: those changes
    /// are not on the branch and would be lost.
    pub async fn delete_worktree(
        &self,
        task_id: &str,
        force: bool,
    ) -> Result<crate::git::DeleteReport> {
        crate::util::validate_task_id(task_id)?;
        // The phase is read under the lock that reopening and pull requests hold, so a reopen
        // cannot slip between the check and the removal.
        let lock = self.pr_lock(task_id);
        let guard = lock.lock().await;
        let done_task = match self.inner.store.load(task_id).await {
            Ok(None) => false,
            Ok(Some(t)) if t.phase == Phase::Done => true,
            Ok(Some(_)) => {
                return Err(CoreError::Invalid(format!(
                    "task {task_id} is not done; its worktree goes with the task, or once it is done"
                )));
            }
            Err(CoreError::InvalidTaskId(id)) => return Err(CoreError::InvalidTaskId(id)),
            Err(e) => {
                return Err(CoreError::Invalid(format!(
                    "task {task_id} uses this worktree but cannot be read ({e}); delete the task instead"
                )));
            }
        };
        let named = self.task_repo_names(task_id).await;
        let status = git::task_status(&self.inner.project, task_id, &named).await?;
        if !status.exists {
            return Err(CoreError::NotFound(format!("worktree {task_id}")));
        }
        if done_task && !force && status.has_changes != Some(false) {
            return Err(CoreError::Invalid(
                "the worktree has uncommitted changes that are not on the task's branch; remove \
                 it anyway to discard them"
                    .into(),
            ));
        }
        let report = git::delete_task_worktrees(
            &self.inner.project,
            task_id,
            &named,
            DeleteOptions {
                force: true,
                delete_branch: !done_task,
                ..DeleteOptions::default()
            },
        )
        .await?;
        drop(guard);
        if done_task {
            self.inner.emit(EngineEvent::TaskChanged {
                task_id: task_id.to_string(),
            });
        } else {
            self.drop_pr_lock(task_id);
        }
        Ok(report)
    }

    /// The repositories a task file names, or none when it has no readable file.
    async fn task_repo_names(&self, id: &str) -> Vec<String> {
        match self.inner.store.load(id).await {
            Ok(Some(t)) => t.repos().map(String::from).collect(),
            _ => Vec::new(),
        }
    }

    fn pr_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .pr_locks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(id.to_string())
            .or_default()
            .clone()
    }

    /// Forget a task's lock once the task (or orphan) is gone.
    fn drop_pr_lock(&self, id: &str) {
        self.inner
            .pr_locks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
    }

    pub async fn worktree_usage(&self) -> Result<crate::git::DiskUsage> {
        Worktrees::new(self.inner.project.clone())
            .disk_usage()
            .await
    }

    pub fn settings(&self) -> Settings {
        self.inner.settings()
    }

    /// Each repository of the project as it is now, with the check commands a task would run in
    /// it and where they come from (detected from its main checkout's files).
    pub async fn repo_checks(&self) -> Vec<RepoChecks> {
        let settings = self.inner.settings();
        let project = match ProjectDir::open(self.inner.project.root()).await {
            Ok(now) => now,
            Err(_) => self.inner.project.clone(),
        };
        let mut out = Vec::new();
        for repo in project.repos() {
            let resolved = checks::commands_for(&project, &settings, &repo.name, &repo.path).await;
            out.push(RepoChecks {
                repo: repo.name.clone(),
                source: resolved.source,
                commands: resolved.commands,
            });
        }
        out
    }

    /// Save settings. `maxConcurrentAgents` takes effect the next time the project is opened.
    pub async fn save_settings(&self, settings: Settings) -> Result<()> {
        settings.save(&self.inner.project).await?;
        *self
            .inner
            .settings
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = settings;
        Ok(())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.inner.events.subscribe()
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.inner.control(id).is_some()
    }

    /// How many tasks have a step in progress (an agent, checks or git work).
    pub fn running_count(&self) -> usize {
        self.inner
            .drivers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len()
    }

    pub async fn create_task(
        &self,
        title: &str,
        description: &str,
        agent: AgentConfig,
        require_plan_approval: bool,
    ) -> Result<Task> {
        let mut task = Task::new(title, description, agent);
        task.require_plan_approval = require_plan_approval;
        let task = self.inner.store.create(task).await?;
        self.inner.emit(EngineEvent::TaskChanged {
            task_id: task.id.clone(),
        });
        Ok(task)
    }

    /// Create a task and start its planning at once. Returns the task as created.
    pub async fn create_and_start(
        &self,
        title: &str,
        description: &str,
        agent: AgentConfig,
        require_plan_approval: bool,
    ) -> Result<Task> {
        let task = self
            .create_task(title, description, agent, require_plan_approval)
            .await?;
        // A new task has no run to resume, so starting it cannot be refused.
        self.spawn_driver(&task.id);
        Ok(task)
    }

    /// Run the task until it needs the user, finishes, fails or is paused. Does nothing if its
    /// driver is already running.
    pub async fn start(&self, id: &str) -> Result<()> {
        let task = self.inner.load(id).await?;
        if task.run.as_ref().is_some_and(|r| r.state.is_resumable()) {
            return Err(CoreError::Invalid(
                "this task is paused, interrupted or failed; resume it instead".into(),
            ));
        }
        self.spawn_driver(id);
        Ok(())
    }

    /// Make sure a driver will look at the task's current state. If one is running (possibly on
    /// its way out after deciding to wait), it is told to look again before it leaves; the check
    /// and the leaving happen under the same lock, so no request is lost.
    fn spawn_driver(&self, id: &str) {
        let mut drivers = self.inner.drivers.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = drivers.get(id) {
            existing.rerun.store(true, Ordering::SeqCst);
            return;
        }
        let (halt, _) = watch::channel(None);
        let (finished, _) = watch::channel(false);
        let control = Arc::new(Control {
            halt,
            stopper: StdMutex::new(None),
            finished,
            rerun: AtomicBool::new(false),
        });
        drivers.insert(id.to_string(), control.clone());
        drop(drivers);
        let inner = self.inner.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            loop {
                // In its own task, so a panic is caught here instead of leaving the driver
                // registered forever with its run marked running.
                let run = tokio::spawn({
                    let inner = inner.clone();
                    let id = id.clone();
                    let control = control.clone();
                    async move { driver::drive(inner, &id, &control).await }
                });
                if let Err(e) = run.await {
                    let message = format!("the engine stopped unexpectedly: {e}");
                    driver::record_failure(&inner, &id, &message).await;
                    inner.emit(EngineEvent::Error {
                        task_id: id.clone(),
                        message,
                    });
                }
                let mut drivers = inner.drivers.lock().unwrap_or_else(|p| p.into_inner());
                if control.rerun.swap(false, Ordering::SeqCst) && control.halt_requested().is_none()
                {
                    continue;
                }
                drivers.remove(&id);
                break;
            }
            control.finished.send_replace(true);
        });
    }

    /// Wait until the task's driver (if any) has stopped.
    pub async fn wait_idle(&self, id: &str) {
        let Some(control) = self.inner.control(id) else {
            return;
        };
        let mut rx = control.finished.subscribe();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// For commands that must not change a task under a working agent. A driver that is only
    /// passing through (leaving after deciding to wait) is given a few seconds to finish; a task
    /// that is still running after that, or has an agent or checks working, is refused rather
    /// than waited for (that could be the rest of the task).
    async fn settle(&self, id: &str, action: &str) -> Result<Task> {
        if self.is_running(id) {
            let task = self.inner.load(id).await?;
            if task.has_active_run() {
                return Err(CoreError::Invalid(format!(
                    "pause the task before {action}"
                )));
            }
            let _ = tokio::time::timeout(SETTLE_WAIT, self.wait_idle(id)).await;
        }
        let task = self.inner.load(id).await?;
        if self.is_running(id) || task.has_active_run() {
            return Err(CoreError::Invalid(format!(
                "pause the task before {action}"
            )));
        }
        Ok(task)
    }

    /// Record the user's answers and go on to the plan. Every required question needs an answer.
    pub async fn answer_questions(&self, id: &str, answers: Vec<(String, Answer)>) -> Result<()> {
        self.inner
            .update(id, |t| {
                if t.phase != Phase::Planning || t.planning.stage != PlanningStage::Questions {
                    return Err(CoreError::Invalid("there are no questions waiting".into()));
                }
                for (qid, answer) in answers {
                    let q = t
                        .planning
                        .questions
                        .iter_mut()
                        .find(|q| q.id == qid)
                        .ok_or_else(|| CoreError::Invalid(format!("no question {qid:?}")))?;
                    q.answer = Some(answer);
                }
                if let Some(q) = t
                    .planning
                    .questions
                    .iter()
                    .find(|q| q.required && q.answer.is_none())
                {
                    return Err(CoreError::Invalid(format!(
                        "question {:?} needs an answer",
                        q.id
                    )));
                }
                t.planning.stage = PlanningStage::Answered;
                Ok(())
            })
            .await?;
        self.spawn_driver(id);
        Ok(())
    }

    /// Ask for a revised plan from the user's feedback.
    pub async fn revise_plan(&self, id: &str, feedback: &str) -> Result<()> {
        if feedback.trim().is_empty() {
            return Err(CoreError::Invalid("the feedback is empty".into()));
        }
        self.inner
            .update(id, |t| {
                require_plan_ready(t)?;
                t.planning.revision = Some(feedback.trim().to_string());
                Ok(())
            })
            .await?;
        self.spawn_driver(id);
        Ok(())
    }

    /// Replace the plan with the user's own text.
    pub async fn edit_plan(&self, id: &str, plan: &str) -> Result<Task> {
        use self::output::AgentOutput as _;
        let checked = output::PlanOut {
            plan: plan.to_string(),
        };
        checked.validate().map_err(CoreError::Invalid)?;
        self.inner
            .update(id, |t| {
                require_plan_ready(t)?;
                t.planning.plan = Some(plan.to_string());
                Ok(())
            })
            .await
    }

    pub async fn approve_plan(&self, id: &str) -> Result<()> {
        self.inner
            .update(id, |t| {
                require_plan_ready(t)?;
                if t.planning.revision.is_some() {
                    return Err(CoreError::Invalid("a revision is still pending".into()));
                }
                t.planning.stage = PlanningStage::Approved;
                t.planning.hold = false;
                Ok(())
            })
            .await?;
        self.spawn_driver(id);
        Ok(())
    }

    /// Send a task in review back for rework, saying what to fix. Starts a fresh budget of
    /// automatic rework rounds.
    pub async fn request_rework(&self, id: &str, feedback: &str) -> Result<()> {
        self.settle(id, "requesting rework").await?;
        let settings = self.inner.settings();
        self.inner
            .update(id, |t| {
                step::apply_user_rework(t, feedback, &settings).map(drop)
            })
            .await?;
        self.spawn_driver(id);
        Ok(())
    }

    /// Stop the task's agent now; its run becomes `paused` and the card stays where it is.
    ///
    /// A pause that arrives just after a step finished finds no run to mark: the task then simply
    /// stops before its next step, with no `paused` run, and `start` or `resume` continues it.
    pub async fn pause(&self, id: &str) -> Result<()> {
        let control = self
            .inner
            .control(id)
            .ok_or_else(|| CoreError::Invalid("the task is not running".into()))?;
        control.request(Halt::Pause);
        self.wait_idle(id).await;
        Ok(())
    }

    /// Continue a paused, interrupted or failed task. A dev subtask continues from its partial work
    /// (in the same agent session when there is one); any other step starts again.
    pub async fn resume(&self, id: &str) -> Result<()> {
        if self.is_running(id) {
            let task = self.inner.load(id).await?;
            if task.has_active_run() {
                return Ok(()); // already running
            }
            // A driver on its way out (for example after a pause): let it finish, then resume.
            self.settle(id, "resuming").await?;
        }
        self.inner
            .update(id, |t| {
                let Some(run) = t.run.as_mut() else {
                    return Ok(()); // nothing halted: just continue
                };
                if run.state.is_active() {
                    // Left by a crash in this same process; treat it as interrupted.
                    run.state = RunState::Interrupted;
                }
                if !run.state.is_resumable() && run.state != RunState::Done {
                    return Ok(());
                }
                if run.kind == RunKind::Dev {
                    run.state = RunState::Queued;
                    run.attempt += 1;
                    run.error = None;
                    run.updated_at = now_ms();
                } else {
                    t.run = None;
                }
                Ok(())
            })
            .await?;
        self.spawn_driver(id);
        Ok(())
    }

    /// A halted dev run is being dropped (skip, replan): put the worktree back at the last
    /// checkpoint so its half-done edits (or work parked by a triage) cannot end up in another
    /// subtask's checkpoint.
    ///
    /// Only the dropped run's work goes: back to each repository's HEAD when the run started
    /// (`Run::heads`), never further (after a replan the last checkpoint is the base commit, and an
    /// earlier plan's commits are still on the branch). A run from before 3.1 has no heads: only
    /// its uncommitted work is discarded.
    async fn discard_dropped_dev_work(&self, task: &Task) -> Result<()> {
        let Some(run) = task.run.as_ref().filter(|r| r.kind == RunKind::Dev) else {
            return Ok(());
        };
        for w in self.inner.task_worktrees(task)? {
            git::unpark_changes(&w.path).await?;
            match run.heads.get(&w.repo) {
                Some(start) => git::discard_to(&w.path, start).await?,
                None => git::discard_changes(&w.path).await?,
            }
        }
        Ok(())
    }

    /// Skip a pending subtask. Not while an agent is working on the task. Skipping the subtask a
    /// halted run was on drops that run and its partial work.
    pub async fn skip_subtask(&self, id: &str, subtask_id: &str) -> Result<Task> {
        let task = self.settle(id, "skipping a subtask").await?;
        let drops_run = task.run.as_ref().and_then(|r| r.subtask_id.as_deref()) == Some(subtask_id);
        if drops_run {
            self.discard_dropped_dev_work(&task).await?;
        }
        self.inner
            .update(id, |t| {
                let sub = t
                    .subtask_mut(subtask_id)
                    .ok_or_else(|| CoreError::Invalid(format!("no subtask {subtask_id:?}")))?;
                if sub.status != SubtaskStatus::Pending {
                    return Err(CoreError::Invalid(
                        "only a pending subtask can be skipped".into(),
                    ));
                }
                sub.status = SubtaskStatus::Skipped;
                sub.finished_at = Some(now_ms());
                // The run pointed at it: it is over, and the next start picks the next subtask.
                if t.run.as_ref().and_then(|r| r.subtask_id.as_deref()) == Some(subtask_id) {
                    t.run = None;
                }
                Ok(())
            })
            .await
    }

    /// The user dragging a card. Replanning drops a halted dev run and its partial work.
    pub async fn move_task(&self, id: &str, to: Phase) -> Result<Task> {
        let task = self.settle(id, "moving it").await?;
        crate::transitions::check_move(&task, to, Mover::User)?;
        if to == Phase::Planning && task.phase != Phase::Planning {
            self.discard_dropped_dev_work(&task).await?;
        }
        // Reopening a done task whose worktree was removed brings it back from the branch. The
        // lock (which removal and pull requests hold) covers the restore and the move together.
        let reopening = task.phase == Phase::Done && to != Phase::Done;
        let lock = reopening.then(|| self.pr_lock(id));
        let _guard = match &lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };
        if reopening {
            let repos: Vec<String> = task.repos().map(String::from).collect();
            git::restore_task_worktrees(&self.inner.project, id, &repos).await?;
        }
        let task = self.inner.store.move_phase(id, to, Mover::User).await?;
        self.inner.emit(EngineEvent::TaskChanged {
            task_id: id.to_string(),
        });
        Ok(task)
    }

    /// Open the task's pull request, or push new work to the one already open.
    pub async fn create_pull_request(&self, id: &str) -> Result<pr::PrReport> {
        let lock = self.pr_lock(id);
        let _guard = lock.lock().await;
        self.settle(id, "opening a pull request").await?;
        pr::create(&self.inner, id).await
    }

    /// Stop the task, remove its worktree and branch, and delete it.
    pub async fn delete_task(&self, id: &str) -> Result<()> {
        if let Some(control) = self.inner.control(id) {
            control.request(Halt::Shutdown);
            self.wait_idle(id).await;
        }
        let named = self.task_repo_names(id).await;
        let _ = git::delete_task_worktrees(
            &self.inner.project,
            id,
            &named,
            DeleteOptions {
                force: true,
                delete_branch: true,
                ..DeleteOptions::default()
            },
        )
        .await?;
        self.inner.store.delete(id).await?;
        self.drop_pr_lock(id);
        self.inner.emit(EngineEvent::TaskChanged {
            task_id: id.to_string(),
        });
        Ok(())
    }

    /// Stop every running task; their runs become `interrupted`, ready to resume next time.
    pub async fn shutdown(&self) {
        let controls: Vec<(String, Arc<Control>)> = self
            .inner
            .drivers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (_, c) in &controls {
            c.request(Halt::Shutdown);
        }
        for (id, _) in &controls {
            self.wait_idle(id).await;
        }
    }
}

/// A worktree as the worktrees page shows it.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    #[serde(flatten)]
    #[cfg_attr(feature = "ts", ts(flatten))]
    pub worktree: crate::git::WorktreeInfo,
    /// The task's title; none when the task is gone or cannot be read.
    pub task_title: Option<String>,
    /// No task file at all: the worktree can be deleted on its own.
    pub orphan: bool,
    /// The task is done: its worktree can be removed on its own (the task and branch stay).
    pub task_done: bool,
}

/// How long a command waits for a driver that is between steps or on its way out.
const SETTLE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

fn require_plan_ready(t: &Task) -> Result<()> {
    if t.phase != Phase::Planning || t.planning.stage != PlanningStage::PlanReady {
        return Err(CoreError::Invalid(
            "there is no plan waiting for review".into(),
        ));
    }
    if t.has_active_run() {
        return Err(CoreError::Invalid("an agent is working on the plan".into()));
    }
    Ok(())
}
