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
pub mod settings;
pub mod step;

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{Semaphore, broadcast, watch};

use crate::agent::{AgentEvent, Binaries, Stopper};
use crate::error::{CoreError, Result};
use crate::git::{DeleteOptions, Worktrees};
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
        event: AgentEvent,
    },
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
}

pub(crate) struct Inner {
    pub project: ProjectDir,
    pub store: TaskStore,
    pub worktrees: Worktrees,
    pub bins: Binaries,
    pub settings: StdMutex<Settings>,
    pub boot_id: String,
    pub agents: Arc<Semaphore>,
    pub drivers: StdMutex<HashMap<String, Arc<Control>>>,
    pub events: broadcast::Sender<EngineEvent>,
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
}

/// One project's engine. Cheap to clone; all clones share the same state.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    /// Open a project: take its lock, load settings, and mark runs left by a previous process as
    /// interrupted (stopping their orphaned agents).
    pub async fn open(project: ProjectDir, bins: Binaries) -> Result<Engine> {
        let boot_id = format!("boot-{}-{}", now_ms(), random_base36(6));
        let lock = ProjectLock::acquire(&project, &boot_id).await?;
        let settings = Settings::load(&project).await?;
        let store = TaskStore::new(&project);
        reconcile::reconcile(&store, &boot_id).await?;
        let (events, _) = broadcast::channel(1024);
        let inner = Inner {
            worktrees: Worktrees::new(project.clone()),
            store,
            bins,
            agents: Arc::new(Semaphore::new(settings.max_concurrent_agents as usize)),
            settings: StdMutex::new(settings),
            boot_id,
            drivers: StdMutex::new(HashMap::new()),
            events,
            project,
            _lock: lock,
        };
        Ok(Engine {
            inner: Arc::new(inner),
        })
    }

    pub fn store(&self) -> &TaskStore {
        &self.inner.store
    }

    pub fn project(&self) -> &ProjectDir {
        &self.inner.project
    }

    pub fn settings(&self) -> Settings {
        self.inner.settings()
    }

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

    /// Run the task until it needs the user, finishes, fails or is paused. Does nothing if its
    /// driver is already running.
    pub async fn start(&self, id: &str) -> Result<()> {
        let task = self
            .inner
            .store
            .load(id)
            .await?
            .ok_or_else(|| CoreError::TaskNotFound(id.to_string()))?;
        if task.run.as_ref().is_some_and(|r| r.state.is_resumable()) {
            return Err(CoreError::Invalid(
                "this task is paused, interrupted or failed; resume it instead".into(),
            ));
        }
        self.spawn_driver(id);
        Ok(())
    }

    fn spawn_driver(&self, id: &str) {
        let mut drivers = self.inner.drivers.lock().unwrap_or_else(|p| p.into_inner());
        if drivers.contains_key(id) {
            return;
        }
        let (halt, _) = watch::channel(None);
        let (finished, _) = watch::channel(false);
        let control = Arc::new(Control {
            halt,
            stopper: StdMutex::new(None),
            finished,
        });
        drivers.insert(id.to_string(), control.clone());
        drop(drivers);
        let inner = self.inner.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            driver::drive(inner.clone(), &id, &control).await;
            inner
                .drivers
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
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
        if self.is_running(id) {
            return Err(CoreError::Invalid(
                "pause the task before requesting rework".into(),
            ));
        }
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
            return Ok(());
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

    /// Skip a pending subtask. Not while an agent is working on the task.
    pub async fn skip_subtask(&self, id: &str, subtask_id: &str) -> Result<Task> {
        if self.is_running(id) {
            return Err(CoreError::Invalid(
                "pause the task before skipping a subtask".into(),
            ));
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

    /// The user dragging a card.
    pub async fn move_task(&self, id: &str, to: Phase) -> Result<Task> {
        if self.is_running(id) {
            return Err(CoreError::Invalid("pause the task before moving it".into()));
        }
        let task = self.inner.store.move_phase(id, to, Mover::User).await?;
        self.inner.emit(EngineEvent::TaskChanged {
            task_id: id.to_string(),
        });
        Ok(task)
    }

    pub async fn create_pull_request(&self, id: &str) -> Result<String> {
        pr::create(&self.inner, id).await
    }

    /// Stop the task, remove its worktree and branch, and delete it.
    pub async fn delete_task(&self, id: &str) -> Result<()> {
        if let Some(control) = self.inner.control(id) {
            control.request(Halt::Shutdown);
            self.wait_idle(id).await;
        }
        let _ = self
            .inner
            .worktrees
            .delete(
                id,
                DeleteOptions {
                    force: true,
                    delete_branch: true,
                    ..DeleteOptions::default()
                },
            )
            .await?;
        self.inner.store.delete(id).await?;
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
