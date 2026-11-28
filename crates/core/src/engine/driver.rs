//! Executing a task's steps, one at a time.
//!
//! Each turn of the loop reads the task file, asks [`next_step`] what to do, does it, and writes
//! the result in one store update (for agent steps, the result and clearing the run happen
//! together). The loop stops when the task waits for the user, finishes, fails, or is halted.
//!
//! A run record exists only while a step is in progress or halted: `running` while it works,
//! `paused` / `interrupted` / `failed` when it stops early, `rate_limited` while its CLI's usage
//! limit lasts, and gone once its result is written.

use std::sync::Arc;

use serde_json::Value;

use super::limits::{self, Limit, LimitScope, now_secs};
use super::output::{
    AgentOutput, DevOut, PlanOut, QaOut, QuestionsOut, SubtaskKindOut, SubtasksOut, TriageOut,
    TriageVerdict, read_output,
};
use super::reconcile::process_started;
use super::runlog::{RunLogLine, RunLogWriter};
use super::settings::Settings;
use super::step::{AgentStep, Step, apply_finish_review, apply_rework, next_step};
use super::{Control, EngineEvent, Halt, Inner, RepoWorktree, checks, prompts};
use crate::agent::{self, Access, AgentEvent, Outcome, OutcomeKind, RunRequest};
use crate::error::{CoreError, Result};
use crate::git::{self, Worktrees};
use crate::task::{
    Phase, PlanningStage, QaVerdict, Question, Run, RunKind, RunState, Subtask, SubtaskKind,
    SubtaskStatus, Task,
};
use crate::transitions::{Mover, apply_move};
use crate::util::{ROOT_REPO, now_ms};

/// Diff shown to a resumed agent.
const DIFF_LIMIT: usize = 64 * 1024;

/// The agent of the task's current run's phase (a run without a record yet counts as dev).
fn run_agent_config(task: &Task) -> &crate::task::AgentConfig {
    task.agents
        .for_kind(task.run.as_ref().map_or(RunKind::Dev, |r| r.kind))
}

pub(crate) async fn drive(inner: Arc<Inner>, id: &str, control: &Control) {
    loop {
        // Copied out: the channel's read guard must not be held across an await.
        if let Some(halt) = control.halt_requested() {
            halt_queued_run(&inner, id, halt).await;
            break;
        }
        let task = match inner.store.load(id).await {
            Ok(Some(t)) => t,
            _ => break,
        };
        let settings = inner.settings();
        let step = match &task.run {
            // A resumed dev subtask: continue it, whatever next_step would pick.
            Some(r) if r.state == RunState::Queued && r.kind == RunKind::Dev => {
                match &r.subtask_id {
                    Some(sub) => Step::Agent(AgentStep::Dev(sub.clone())),
                    None => break,
                }
            }
            _ => next_step(&task, &settings),
        };
        let result = match step {
            Step::Wait(_) | Step::Halted => break,
            Step::CreateWorktree => create_worktree(&inner, id).await,
            Step::AutoApprove => inner
                .update(id, |t| {
                    t.planning.stage = PlanningStage::Approved;
                    Ok(())
                })
                .await
                .map(drop),
            Step::Move(phase) => inner
                .update(id, |t| apply_move(t, phase, Mover::Engine))
                .await
                .map(drop),
            Step::RunChecks => match run_checks(&inner, id, &settings, control).await {
                Ok(true) => Ok(()),
                Ok(false) => break,
                Err(e) => Err(e),
            },
            Step::Rework(cause) => inner
                .update(id, |t| apply_rework(t, cause, &settings).map(drop))
                .await
                .map(drop),
            Step::FinishReview => inner.update(id, apply_finish_review).await.map(drop),
            Step::Agent(step) => match run_agent(&inner, id, &task, step, &settings, control).await
            {
                Ok(true) => Ok(()),
                Ok(false) => break,
                Err(e) => Err(e),
            },
        };
        if let Err(e) = result {
            record_failure(&inner, id, &e.to_string()).await;
            break;
        }
    }
}

/// A halt that arrives while a resumed run is still queued.
async fn halt_queued_run(inner: &Inner, id: &str, halt: Halt) {
    let _ = inner
        .update(id, |t| {
            if let Some(run) = t.run.as_mut()
                && run.state.is_active()
            {
                run.state = halted_state(halt);
            }
            Ok(())
        })
        .await;
}

fn halted_state(halt: Halt) -> RunState {
    match halt {
        Halt::Pause => RunState::Paused,
        Halt::Shutdown => RunState::Interrupted,
    }
}

/// Make a failure visible: the current run (or a new one fitting the phase) becomes `failed`.
/// When no run can hold it, an `EngineEvent::Error` carries it instead.
pub(crate) async fn record_failure(inner: &Inner, id: &str, error: &str) {
    let mut recorded = false;
    let written = inner
        .update(id, |t| {
            recorded = mark_failed(t, error);
            Ok(())
        })
        .await;
    // Shown some other way when the task file could not take it (an update it refuses).
    if written.is_err() || !recorded {
        inner.emit(EngineEvent::Error {
            task_id: id.to_string(),
            message: error.to_string(),
        });
    }
}

/// The task's run (or a new one fitting its phase) becomes `failed` with `error`. Whether there
/// was a place to record it.
fn mark_failed(t: &mut Task, error: &str) -> bool {
    if let Some(run) = t.run.as_mut() {
        run.state = RunState::Failed;
        run.error = Some(error.to_string());
        // A failed run waits for nothing (a rate-limited one's reset would make the file invalid).
        run.resets_at = None;
        run.reset_estimated = false;
        run.limit_scope = None;
        run.updated_at = now_ms();
        return true;
    }
    let (kind, subtask) = match t.phase {
        Phase::Planning => (RunKind::Plan, None),
        Phase::InProgress => (
            RunKind::Dev,
            t.subtasks_of(SubtaskKind::Dev)
                .find(|s| s.status == SubtaskStatus::Pending)
                .map(|s| s.id.clone()),
        ),
        Phase::AiReview => (RunKind::Checks, None),
        Phase::HumanReview | Phase::Done => return false,
    };
    if kind == RunKind::Dev && subtask.is_none() {
        return false; // no valid place to record it; the task stays where it is
    }
    let mut run = Run::new(kind, RunState::Failed, subtask);
    run.error = Some(error.to_string());
    t.run = Some(run);
    true
}

/// Create a worktree in every repository of the project and record each base commit, in one
/// update. A worktree a previous attempt created but never recorded is kept (its base recovered
/// from the branch). If one repository fails, the worktrees made by this attempt are removed again
/// and the step fails naming that repository.
async fn create_worktree(inner: &Inner, id: &str) -> Result<()> {
    let mut bases = std::collections::BTreeMap::new();
    let mut created: Vec<Worktrees> = Vec::new();
    // The repositories as they are now (a workspace may have gained one since it was opened),
    // checked by the same rules as opening it.
    let current = crate::project::ProjectDir::open(inner.project.root()).await?;
    let repos: Vec<String> = current.repos().iter().map(|r| r.name.clone()).collect();
    for repo in repos {
        let worktrees = inner.repo_worktrees(&repo)?;
        let result = async {
            let path = worktrees.path_for(id)?;
            if git::is_task_worktree(&path, id).await {
                // Created by a previous attempt that died before recording it.
                git::fork_point(worktrees.main_checkout(), &Worktrees::branch_for(id)).await
            } else {
                let info = worktrees.create(id).await?;
                created.push(worktrees.clone());
                info.base_commit.ok_or_else(|| {
                    CoreError::Invalid("worktree created without a base commit".into())
                })
            }
        }
        .await;
        match result {
            Ok(base) => {
                bases.insert(repo, base);
            }
            Err(e) => {
                for w in created {
                    let opts = git::DeleteOptions {
                        force: true,
                        delete_branch: true,
                        ..git::DeleteOptions::default()
                    };
                    if let Err(undo) = w.delete(id, opts).await {
                        log::warn!(
                            "task {id}: could not remove the worktree in {}: {undo}",
                            w.repo()
                        );
                    }
                }
                return Err(if inner.project.is_workspace() {
                    CoreError::Invalid(format!("the worktree in {repo}/ could not be created: {e}"))
                } else {
                    e
                });
            }
        }
    }
    inner
        .update(id, |t| {
            t.base_commits = bases;
            Ok(())
        })
        .await
        .map(drop)
}

/// `Ok(false)` when a halt stopped the checks (the run is marked paused or interrupted).
async fn run_checks(
    inner: &Inner,
    id: &str,
    settings: &Settings,
    control: &Control,
) -> Result<bool> {
    let task = inner
        .store
        .load(id)
        .await?
        .ok_or_else(|| CoreError::TaskNotFound(id.to_string()))?;
    // Checks are recorded against each repository's last dev checkpoint, which next_step compares
    // with. If HEAD is somewhere else (a hand-made commit in the worktree), say so once instead of
    // re-running checks that could never count as current.
    let mut plan = Vec::new();
    for repo in task.repos_to_check() {
        let wt = inner.repo_worktrees(repo)?.path_for(id)?;
        let expected = task
            .last_dev_checkpoint(repo)
            .ok_or_else(|| CoreError::Invalid("the task has no checkpoint to check".into()))?
            .to_string();
        let head = git::head(&wt).await?;
        if head != expected {
            let place = if repo == ROOT_REPO {
                "the worktree".to_string()
            } else {
                format!("the worktree of {repo}/")
            };
            return Err(CoreError::Invalid(format!(
                "{place} is at {head}, not at the last checkpoint {expected}; commits made by hand \
                 in a task worktree are not supported. Reset the worktree to the checkpoint or \
                 replan."
            )));
        }
        let commands = checks::commands_for(&inner.project, settings, repo, &wt).await;
        plan.push((repo.to_string(), wt, expected, commands));
    }
    let mut run = Run::new(RunKind::Checks, RunState::Running, None);
    run.boot_id = Some(inner.boot_id.clone());
    let run_id = run.id.clone();
    inner
        .update(id, |t| {
            t.run = Some(run);
            Ok(())
        })
        .await?;
    let mut results = std::collections::BTreeMap::new();
    for (repo, wt, expected, commands) in plan {
        // A halt drops the running check, whose guard kills its process group.
        let runs = tokio::select! {
            runs = checks::run_all(&wt, &commands.commands, inner.bins.path_var(), settings.timeouts.check()) => runs,
            () = control.halted() => {
                git::discard_to(&wt, &expected).await?;
                let state = control.halt_requested().map_or(RunState::Interrupted, halted_state);
                inner
                    .update(id, |t| {
                        if let Some(r) = t.run.as_mut()
                            && r.id == run_id
                        {
                            r.state = state;
                        }
                        Ok(())
                    })
                    .await?;
                return Ok(false);
            }
        };
        // Checks must not leave files that a later checkpoint would commit (ignored build output
        // stays).
        git::discard_to(&wt, &expected).await?;
        results.insert(repo, checks::summarize(&runs, &expected));
    }
    inner
        .update(id, |t| {
            t.review.checks = results;
            t.run = None;
            Ok(())
        })
        .await?;
    Ok(true)
}

/// What one agent attempt produced.
enum Attempt<T> {
    Answer(T),
    /// The run was halted or failed; its state is already written.
    Stopped,
}

struct Ctx<'a> {
    inner: &'a Inner,
    id: &'a str,
    run_id: String,
    settings: &'a Settings,
    control: &'a Control,
    access: Access,
    /// Store the agent's session id on the run (false for side runs such as triage, whose
    /// conversation must never be resumed as the dev subtask's).
    record_session: bool,
    /// Names this context's run logs: `run` for the step itself, `triage` for the check before a
    /// resume. A repair turn adds `-repair`. Side runs share the step's run id, so the label is
    /// what keeps their logs apart.
    log_label: &'static str,
    /// Files removed from a workspace task's folder after this context's runs (outside every
    /// repository), for the dev subtask's handoff note.
    removed: std::sync::Mutex<Vec<String>>,
    /// The agent the step runs (the phase's).
    agent: crate::task::AgentConfig,
}

impl Ctx<'_> {
    fn take_removed(&self) -> Vec<String> {
        std::mem::take(&mut *self.removed.lock().unwrap_or_else(|p| p.into_inner()))
    }
}

/// Run one agent step to its written result. `Ok(false)` means the task stopped (halted or
/// failed) and the driver should stop too.
async fn run_agent(
    inner: &Inner,
    id: &str,
    task: &Task,
    step: AgentStep,
    settings: &Settings,
    control: &Control,
) -> Result<bool> {
    let (kind, subtask_id, access) = match &step {
        AgentStep::Questions | AgentStep::Plan => (RunKind::Plan, None, Access::ReadOnly),
        AgentStep::Subtasks => (RunKind::SubtaskGen, None, Access::ReadOnly),
        AgentStep::Dev(s) => (RunKind::Dev, Some(s.clone()), Access::Full),
        AgentStep::Qa(s) => (RunKind::Qa, Some(s.clone()), Access::Review),
    };
    let resuming = task.run.as_ref().is_some_and(|r| {
        r.state == RunState::Queued && r.kind == kind && r.subtask_id == subtask_id
    });
    let mut run = match (&task.run, resuming) {
        (Some(r), true) => r.clone(),
        _ => Run::new(kind, RunState::Running, subtask_id.clone()),
    };
    run.state = RunState::Running;
    run.boot_id = Some(inner.boot_id.clone());
    run.pid = None;
    run.process_started = None;
    run.error = None;
    run.resets_at = None;
    run.reset_estimated = false;
    run.limit_scope = None;
    run.updated_at = now_ms();
    // A session is only resumed by the provider that created it (the phase's agent may have been
    // changed while the run was halted).
    let agent = task.agents.for_kind(kind).clone();
    let provider = agent.provider;
    let session = run
        .session_id
        .clone()
        .filter(|_| run.provider.is_none_or(|p| p == provider));
    if session.is_none() {
        run.session_id = None;
    }
    run.provider = Some(provider);
    if kind == RunKind::Dev && !resuming {
        // Where this run's work starts in each repository (see `Run::heads`).
        run.heads.clear();
        for w in inner.task_worktrees(task)? {
            run.heads.insert(w.repo, git::head(&w.path).await?);
        }
    }
    // The CLI is known to be rate-limited: wait for its reset without starting anything (not even
    // a triage), instead of every task on it failing in turn.
    if let Some((limit, scope)) = inner.limits.holding(&agent, now_secs()) {
        mark_rate_limited(&mut run, limit, scope, &limit_message(provider, None));
        inner
            .update(id, |t| {
                t.run = Some(run);
                Ok(())
            })
            .await?;
        return Ok(false);
    }
    let ctx = Ctx {
        inner,
        id,
        run_id: run.id.clone(),
        settings,
        control,
        access,
        record_session: true,
        log_label: "run",
        removed: std::sync::Mutex::new(Vec::new()),
        agent,
    };
    let task = inner
        .update(id, |t| {
            t.run = Some(run);
            Ok(())
        })
        .await?;
    let sub = subtask_id.as_ref().and_then(|s| task.subtask(s)).cloned();
    let worktrees = inner.task_worktrees(&task)?;
    let layout = layout_for(inner, &worktrees).await;
    let layout = layout.as_ref();

    match step {
        AgentStep::Questions => {
            let Attempt::Answer(q) =
                attempt::<QuestionsOut>(&ctx, &task, prompts::questions(&task, layout), None)
                    .await?
            else {
                return Ok(false);
            };
            finish(&ctx, |t| {
                t.planning.questions = q
                    .questions
                    .into_iter()
                    .map(|q| Question {
                        id: q.id,
                        text: q.text,
                        options: q.options,
                        required: q.required,
                        answer: None,
                    })
                    .collect();
                t.planning.stage = PlanningStage::Questions;
                Ok(())
            })
            .await
        }
        AgentStep::Plan => {
            let prompt = match &task.planning.revision {
                Some(feedback) => prompts::plan_revision(&task, feedback, layout),
                None => prompts::plan(&task, settings, layout),
            };
            let Attempt::Answer(p) = attempt::<PlanOut>(&ctx, &task, prompt, None).await? else {
                return Ok(false);
            };
            finish(&ctx, |t| {
                t.planning.plan = Some(p.plan);
                t.planning.revision = None;
                t.planning.stage = PlanningStage::PlanReady;
                Ok(())
            })
            .await
        }
        AgentStep::Subtasks => {
            let prompt = prompts::subtasks(&task, settings, layout);
            let Attempt::Answer(s) = attempt::<SubtasksOut>(&ctx, &task, prompt, None).await?
            else {
                return Ok(false);
            };
            finish(&ctx, |t| {
                t.subtasks = s
                    .subtasks
                    .into_iter()
                    .map(|s| {
                        let kind = match s.kind {
                            SubtaskKindOut::Dev => SubtaskKind::Dev,
                            SubtaskKindOut::Qa => SubtaskKind::Qa,
                        };
                        let mut sub = Subtask::new(s.id, kind, s.title, s.detail);
                        sub.progress_label = s.progress_label;
                        // Guidance only: names that are not the task's repositories are dropped.
                        sub.repos = s
                            .repos
                            .iter()
                            .map(|r| crate::util::plain_repo_name(r).to_string())
                            .filter(|r| r != ROOT_REPO && t.base_commits.contains_key(r))
                            .fold(Vec::new(), |mut v, r| {
                                if !v.contains(&r) {
                                    v.push(r);
                                }
                                v
                            });
                        sub
                    })
                    .collect();
                Ok(())
            })
            .await
        }
        AgentStep::Qa(sub_id) => {
            let sub = sub.ok_or_else(|| CoreError::Invalid(format!("no subtask {sub_id:?}")))?;
            let prompt = prompts::qa(&task, &sub, layout);
            let Attempt::Answer(v) = attempt::<QaOut>(&ctx, &task, prompt, None).await? else {
                return Ok(false);
            };
            finish(&ctx, |t| {
                if let Some(s) = t.subtask_mut(&sub_id) {
                    s.status = SubtaskStatus::Done;
                    s.finished_at = Some(now_ms());
                    s.verdict = Some(QaVerdict {
                        passed: v.passed,
                        summary: v.summary,
                        findings: v.findings,
                    });
                }
                Ok(())
            })
            .await
        }
        AgentStep::Dev(sub_id) => {
            let sub = sub.ok_or_else(|| CoreError::Invalid(format!("no subtask {sub_id:?}")))?;
            let caps = agent::capabilities(provider);
            let (prompt, resume_session) = if resuming {
                // A crash during an earlier triage may have left the work parked, and a crash
                // between two repositories' checkpoint commits may have left one committed: the
                // run's own commits become uncommitted work again. Never anything older than the
                // run (a run from before 3.1 has no heads: nothing is undone).
                let heads = task
                    .run
                    .as_ref()
                    .map(|r| r.heads.clone())
                    .unwrap_or_default();
                for w in &worktrees {
                    git::unpark_changes(&w.path).await?;
                    if let Some(start) = heads.get(&w.repo) {
                        git::uncommit_to(&w.path, start).await?;
                    }
                }
                let diff = repo_diffs(&worktrees).await?;
                if settings.triage_on_resume && !diff.is_empty() {
                    match triage(&ctx, &task, &sub, &diff, layout).await? {
                        None => return Ok(false),
                        Some(TriageVerdict::Done) => {
                            let summary = "Judged complete by triage after an interruption.";
                            return finish_dev(&ctx, &task, &sub, summary, "").await;
                        }
                        Some(TriageVerdict::Broken) => {
                            for w in &worktrees {
                                git::discard_changes(&w.path).await?;
                            }
                            (prompts::dev(&task, &sub, None, layout), None)
                        }
                        Some(TriageVerdict::Partial) => {
                            let session = session.as_deref();
                            resume_prompt(&task, &sub, &diff, session, caps.resume, layout)
                        }
                    }
                } else {
                    resume_prompt(&task, &sub, &diff, session.as_deref(), caps.resume, layout)
                }
            } else {
                (prompts::dev(&task, &sub, None, layout), None)
            };
            let Attempt::Answer(d) = attempt::<DevOut>(&ctx, &task, prompt, resume_session).await?
            else {
                return Ok(false);
            };
            finish_dev(&ctx, &task, &sub, &d.summary, &d.handoff).await
        }
    }
}

fn resume_prompt(
    task: &Task,
    sub: &Subtask,
    diff: &prompts::RepoDiffs,
    session: Option<&str>,
    provider_resumes: bool,
    layout: Option<&prompts::Layout>,
) -> (String, Option<String>) {
    match session {
        Some(s) if provider_resumes => (prompts::resume_same_session(diff), Some(s.to_string())),
        _ => (prompts::dev(task, sub, Some(diff), layout), None),
    }
}

/// Checkpoint a finished dev subtask and record it, in one update.
async fn finish_dev(
    ctx: &Ctx<'_>,
    task: &Task,
    sub: &Subtask,
    summary: &str,
    handoff: &str,
) -> Result<bool> {
    let label = if summary.trim().is_empty() {
        sub.title.clone()
    } else {
        format!(
            "{}: {}",
            sub.title,
            summary.lines().next().unwrap_or_default()
        )
    };
    // Only repositories whose HEAD moves get a checkpoint. All commits are made before the one
    // update that records them; a crash in between is undone on resume (`uncommit_to`).
    let mut checkpoints = std::collections::BTreeMap::new();
    for w in ctx.inner.task_worktrees(task)? {
        let checkpoint = git::checkpoint_commit(&w.path, &task.id, &sub.id, &label).await?;
        // A commit the agent made itself moves HEAD too, and counts as the checkpoint.
        if checkpoint.created || task.last_dev_checkpoint(&w.repo) != Some(&checkpoint.commit) {
            checkpoints.insert(w.repo, checkpoint.commit);
        }
    }
    let sub_id = sub.id.clone();
    let mut handoff = handoff.trim().to_string();
    let removed = ctx.take_removed();
    if !removed.is_empty() {
        if !handoff.is_empty() {
            handoff.push_str("\n\n");
        }
        handoff.push_str(&format!(
            "Removed after the run, because they were outside every repository: {}",
            removed.join(", ")
        ));
    }
    finish(ctx, |t| {
        if let Some(s) = t.subtask_mut(&sub_id) {
            s.status = SubtaskStatus::Done;
            s.finished_at = Some(now_ms());
            s.checkpoints = checkpoints;
            s.handoff = (!handoff.is_empty()).then_some(handoff);
        }
        Ok(())
    })
    .await
}

/// Write a step's result and clear its run, together.
async fn finish<F>(ctx: &Ctx<'_>, apply: F) -> Result<bool>
where
    F: FnOnce(&mut Task) -> Result<()>,
{
    let run_id = ctx.run_id.clone();
    ctx.inner
        .update(ctx.id, |t| {
            if t.run.as_ref().map(|r| r.id.as_str()) != Some(run_id.as_str()) {
                return Err(CoreError::Invalid(
                    "the run changed while the agent was working".into(),
                ));
            }
            apply(t)?;
            t.run = None;
            Ok(())
        })
        .await?;
    Ok(true)
}

/// Ask a read-only agent how an interrupted subtask stands. `None` means the triage run itself
/// stopped (its state is written). The partial work is parked in a temporary commit while the
/// agent looks, because review runs discard changes afterwards, and is restored exactly after.
async fn triage(
    ctx: &Ctx<'_>,
    task: &Task,
    sub: &Subtask,
    diff: &prompts::RepoDiffs,
    layout: Option<&prompts::Layout>,
) -> Result<Option<TriageVerdict>> {
    let triage_ctx = Ctx {
        inner: ctx.inner,
        id: ctx.id,
        run_id: ctx.run_id.clone(),
        settings: ctx.settings,
        control: ctx.control,
        access: Access::Review,
        record_session: false,
        log_label: "triage",
        removed: std::sync::Mutex::new(Vec::new()),
        agent: ctx.agent.clone(),
    };
    let worktrees = ctx.inner.task_worktrees(task)?;
    for w in &worktrees {
        git::park_changes(&w.path).await?;
    }
    let result = attempt::<TriageOut>(
        &triage_ctx,
        task,
        prompts::triage(task, sub, diff, layout),
        None,
    )
    .await;
    for w in &worktrees {
        git::unpark_changes(&w.path).await?;
    }
    Ok(match result? {
        Attempt::Answer(t) => Some(t.verdict),
        Attempt::Stopped => None,
    })
}

/// Run the agent once (plus one repair turn if its answer cannot be read) and return the answer.
async fn attempt<T: AgentOutput>(
    ctx: &Ctx<'_>,
    task: &Task,
    prompt: String,
    session: Option<String>,
) -> Result<Attempt<T>> {
    let caps = agent::capabilities(run_agent_config(task).provider);
    let schema = caps.structured_output.then(T::schema);
    let resumed = session.is_some();
    let outcome = execute(ctx, task, prompt, session, schema.clone(), ctx.log_label).await?;
    if resumed
        && ctx.record_session
        && matches!(
            outcome.kind,
            OutcomeKind::AgentError { .. } | OutcomeKind::Crashed { .. }
        )
    {
        // The stored session may be expired or unknown; the next resume starts a fresh one
        // (with the diff) instead of failing the same way again.
        update_run(ctx, |r| r.session_id = None).await?;
    }
    if !handle_stop(ctx, &outcome).await? {
        return Ok(Attempt::Stopped);
    }
    let error = match read_output::<T>(&outcome) {
        Ok(answer) => return Ok(Attempt::Answer(answer)),
        Err(e) => e,
    };
    // One repair turn, in the same session when the provider resumes.
    let session = outcome.session_id.clone().filter(|_| caps.resume);
    let repaired = execute(
        ctx,
        task,
        prompts::repair::<T>(&error),
        session,
        schema,
        &format!("{}-repair", ctx.log_label),
    )
    .await?;
    if !handle_stop(ctx, &repaired).await? {
        return Ok(Attempt::Stopped);
    }
    match read_output::<T>(&repaired) {
        Ok(answer) => Ok(Attempt::Answer(answer)),
        Err(e) => {
            fail_run(ctx, &format!("the agent's answer could not be used: {e}")).await?;
            Ok(Attempt::Stopped)
        }
    }
}

/// Record how a run that did not complete ended. `Ok(true)` when it completed.
async fn handle_stop(ctx: &Ctx<'_>, outcome: &Outcome) -> Result<bool> {
    let message = match &outcome.kind {
        OutcomeKind::Completed => return Ok(true),
        OutcomeKind::Stopped => {
            let state = ctx
                .control
                .halt_requested()
                .map_or(RunState::Interrupted, halted_state);
            set_run_state(ctx, state, None).await?;
            return Ok(false);
        }
        OutcomeKind::TimedOut => "the agent timed out".to_string(),
        OutcomeKind::AgentError { message } => format!("the agent reported an error: {message}"),
        OutcomeKind::Crashed { exit_code } => format!(
            "the agent exited without finishing (exit code {})",
            exit_code.map_or("unknown".into(), |c| c.to_string())
        ),
        OutcomeKind::RateLimited {
            resets_at,
            message,
            scope,
        } => {
            let now = now_secs();
            // A reset that just passed (the CLI's clock, a late message) is this one: resume
            // after the grace. Anything older is not a time to trust.
            let limit = match resets_at.filter(|at| *at > now - JUST_PASSED_SECS) {
                Some(until) => Limit {
                    until: until.max(now),
                    estimated: false,
                },
                None => Limit {
                    until: now
                        + i64::try_from(ctx.inner.timing.unknown_reset_wait.as_secs())
                            .unwrap_or(1800),
                    estimated: true,
                },
            };
            let scope = limits::resolve(scope.clone(), &ctx.agent);
            ctx.inner.limits.record(ctx.agent.provider, &scope, limit);
            // Another task may have recorded a later reset meanwhile.
            let limit = match ctx.inner.limits.holding(&ctx.agent, now) {
                Some((held, _)) if scope != LimitScope::Run && held.until > limit.until => held,
                _ => limit,
            };
            let message = limit_message(ctx.agent.provider, Some(message));
            let run_id = ctx.run_id.clone();
            ctx.inner
                .update(ctx.id, |t| {
                    if let Some(run) = t.run.as_mut()
                        && run.id == run_id
                    {
                        mark_rate_limited(run, limit, scope, &message);
                    }
                    Ok(())
                })
                .await?;
            return Ok(false);
        }
    };
    fail_run(ctx, &message).await?;
    Ok(false)
}

/// A reset this recent counts as just passed rather than unknown.
const JUST_PASSED_SECS: i64 = 10 * 60;

/// The run waits for `limit` to reset.
fn mark_rate_limited(run: &mut Run, limit: Limit, scope: LimitScope, message: &str) {
    run.state = RunState::RateLimited;
    run.resets_at = Some(limit.until);
    run.reset_estimated = limit.estimated;
    run.limit_scope = (scope != LimitScope::Account).then_some(scope);
    run.error = Some(message.to_string());
    run.pid = None;
    run.updated_at = now_ms();
}

fn limit_message(provider: crate::task::Provider, cli_said: Option<&str>) -> String {
    let name = crate::agent::provider_label(provider);
    match cli_said.map(str::trim).filter(|m| !m.is_empty()) {
        Some(said) => format!("{name} hit its usage limit: {said}"),
        None => format!("{name} is at its usage limit; waiting for it to reset"),
    }
}

async fn fail_run(ctx: &Ctx<'_>, message: &str) -> Result<()> {
    set_run_state(ctx, RunState::Failed, Some(message)).await
}

async fn set_run_state(ctx: &Ctx<'_>, state: RunState, error: Option<&str>) -> Result<()> {
    let run_id = ctx.run_id.clone();
    ctx.inner
        .update(ctx.id, |t| {
            if let Some(run) = t.run.as_mut()
                && run.id == run_id
            {
                run.state = state;
                run.error = error.map(String::from);
                run.pid = None;
                run.resets_at = None;
                run.reset_estimated = false;
                run.limit_scope = None;
                run.updated_at = now_ms();
            }
            Ok(())
        })
        .await
        .map(drop)
}

/// Start the agent, keep the run record current (pid, start time, session id) and stream its
/// events, until it finishes. Review and read-only runs have their changes discarded afterwards.
async fn execute(
    ctx: &Ctx<'_>,
    task: &Task,
    prompt: String,
    session: Option<String>,
    schema: Option<Value>,
    label: &str,
) -> Result<Outcome> {
    let inner = ctx.inner;
    let cwd = inner.task_dir(ctx.id)?;
    let worktrees = inner.task_worktrees(task)?;
    let attempt_no = task.run.as_ref().map_or(1, |r| r.attempt);
    let log_path = inner
        .store
        .task_dir(ctx.id)?
        .join("runs")
        .join(format!("{}-{attempt_no}-{label}.ndjson", ctx.run_id));
    let agent_config = run_agent_config(task).clone();
    let provider = agent_config.provider;
    let mut req = RunRequest::new(agent_config, &cwd, prompt, log_path.clone());
    req.resume = session;
    req.access = ctx.access;
    req.json_schema = schema;
    // Planning is read-only: an MCP server (a database, GitHub) could change things outside the
    // worktree that no discard undoes, so it gets none. Dev and QA (which checks the work, often
    // through a browser server) get the project's allowlist.
    if ctx.access != Access::ReadOnly {
        req.mcp_servers = ctx.settings.mcp_servers.clone();
    }
    req.idle_timeout = Some(ctx.settings.timeouts.idle());
    req.tool_timeout = Some(ctx.settings.timeouts.tool());
    req.total_timeout = Some(ctx.settings.timeouts.total());

    // Waiting for a free agent slot gives way to a pause or shutdown.
    let _permit = tokio::select! {
        permit = inner.agents.clone().acquire_owned() => permit
            .map_err(|_| CoreError::Invalid("the engine is shutting down".into()))?,
        () = ctx.control.halted() => return Ok(stopped_outcome()),
    };
    if ctx.control.halt_requested().is_some() {
        return Ok(stopped_outcome());
    }
    // The CLI hit its limit while this run waited for a slot (or before a repair turn).
    if let Some((limit, scope)) = inner.limits.holding(&ctx.agent, now_secs()) {
        return Ok(Outcome {
            kind: OutcomeKind::RateLimited {
                resets_at: Some(limit.until),
                message: String::new(),
                scope,
            },
            ..stopped_outcome()
        });
    }
    // Where a run that may not change anything must leave each worktree.
    let mut heads_before = Vec::new();
    for w in &worktrees {
        heads_before.push(git::head(&w.path).await?);
    }
    let mut events_log = RunLogWriter::create(
        &log_path,
        RunLogLine::Start {
            at: now_ms(),
            run_id: ctx.run_id.clone(),
            attempt: attempt_no,
            label: label.to_string(),
            kind: task.run.as_ref().map_or(RunKind::Dev, |r| r.kind),
            subtask_id: task.run.as_ref().and_then(|r| r.subtask_id.clone()),
            provider,
        },
    )
    .await;
    let mut agent = match agent::start(req, &inner.bins).await {
        Ok(agent) => agent,
        Err(e) => {
            events_log.abandon(&e.to_string()).await;
            return Err(e);
        }
    };
    *ctx.control
        .stopper
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(agent.stopper());
    // A halt that arrived between the check above and registering the stopper.
    if ctx.control.halt_requested().is_some() {
        agent.stopper().stop();
    }

    let pid = agent.pid();
    let started = match pid {
        Some(p) => process_started(p).await,
        None => None,
    };
    let known_session = agent
        .session_id()
        .map(String::from)
        .filter(|_| ctx.record_session);
    update_run(ctx, |r| {
        r.pid = pid;
        r.process_started = started;
        if known_session.is_some() {
            r.session_id = known_session;
        }
    })
    .await?;

    let mut outcome = None;
    while let Some(event) = agent.next_event().await {
        match &event {
            AgentEvent::Session { id } if ctx.record_session => {
                let id = id.clone();
                update_run(ctx, |r| r.session_id = Some(id)).await?;
            }
            AgentEvent::Finished { outcome: o } => outcome = Some((**o).clone()),
            _ => {}
        }
        let seq = events_log.event(&event).await;
        inner.emit(EngineEvent::Agent {
            task_id: ctx.id.to_string(),
            run_id: ctx.run_id.clone(),
            log: events_log.name().to_string(),
            seq,
            event,
        });
    }
    *ctx.control
        .stopper
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = None;
    if ctx.access != Access::Full {
        // Changes and any commits the agent made during this run; earlier commits stay.
        for (w, head) in worktrees.iter().zip(&heads_before) {
            git::discard_to(&w.path, head).await?;
        }
    }
    if inner.project.is_workspace() {
        // The run's outcome is known; a file that cannot be removed is noted, never a failure.
        let removed = match remove_strays(&cwd, &worktrees).await {
            Ok(removed) => removed,
            Err(e) => {
                let note = format!("could not remove files left outside every repository: {e}");
                log::warn!("task {}: {note}", ctx.id);
                events_log.note(&note).await;
                Vec::new()
            }
        };
        if !removed.is_empty() {
            let note = format!(
                "removed after the run, outside every repository: {}",
                removed.join(", ")
            );
            log::info!("task {}: {note}", ctx.id);
            events_log.note(&note).await;
            ctx.removed
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .extend(removed);
        }
    }
    Ok(outcome.unwrap_or_else(stopped_outcome))
}

async fn update_run(ctx: &Ctx<'_>, change: impl FnOnce(&mut Run)) -> Result<()> {
    let run_id = ctx.run_id.clone();
    ctx.inner
        .update(ctx.id, |t| {
            if let Some(run) = t.run.as_mut()
                && run.id == run_id
            {
                change(run);
                run.updated_at = now_ms();
            }
            Ok(())
        })
        .await
        .map(drop)
}

fn stopped_outcome() -> Outcome {
    Outcome {
        kind: OutcomeKind::Stopped,
        session_id: None,
        final_text: String::new(),
        structured: None,
        turns: None,
        cost_usd: None,
    }
}

/// The uncommitted work in each of the task's worktrees, for a resumed subtask's prompt.
async fn repo_diffs(worktrees: &[RepoWorktree]) -> Result<prompts::RepoDiffs> {
    let mut diffs = Vec::new();
    // The limit is shared, so a resume prompt is no bigger with several repositories.
    let per_repo = DIFF_LIMIT / worktrees.len().max(1);
    for w in worktrees {
        diffs.push((
            w.repo.clone(),
            git::diff_since_checkpoint(&w.path, per_repo).await?,
        ));
    }
    Ok(prompts::RepoDiffs(diffs))
}

/// Remove whatever an agent left directly in a workspace task's folder: nothing there belongs to a
/// repository, so it would never be checkpointed or reach a pull request. Returns the names.
async fn remove_strays(dir: &std::path::Path, worktrees: &[RepoWorktree]) -> Result<Vec<String>> {
    let mut removed = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return Ok(removed);
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(crate::error::io_at(dir))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if worktrees.iter().any(|w| w.repo == name) {
            continue;
        }
        let path = entry.path();
        let is_dir = tokio::fs::symlink_metadata(&path)
            .await
            .is_ok_and(|m| m.is_dir());
        let result = if is_dir {
            tokio::fs::remove_dir_all(&path).await
        } else {
            tokio::fs::remove_file(&path).await
        };
        result.map_err(crate::error::io_at(&path))?;
        removed.push(name);
    }
    removed.sort();
    Ok(removed)
}

/// What a workspace task's agents are told about their folder (see [`prompts::Layout`]): each
/// repository with the instruction files at its root, and the workspace folder's own. `None` for a
/// one-repository project.
async fn layout_for(inner: &Inner, worktrees: &[RepoWorktree]) -> Option<prompts::Layout> {
    if !inner.project.is_workspace() {
        return None;
    }
    let present = |dir: std::path::PathBuf| async move {
        let mut found = Vec::new();
        for name in prompts::INSTRUCTION_FILES {
            if tokio::fs::try_exists(dir.join(name)).await.unwrap_or(false) {
                found.push(name);
            }
        }
        found
    };
    let mut repos = Vec::new();
    for w in worktrees {
        let instructions = present(w.path.clone())
            .await
            .into_iter()
            .map(|f| format!("{}/{f}", w.repo))
            .collect();
        repos.push(prompts::RepoLayout {
            name: w.repo.clone(),
            instructions,
        });
    }
    let root = inner.project.root().to_path_buf();
    let root_instructions = present(root.clone())
        .await
        .into_iter()
        .map(|f| root.join(f).to_string_lossy().into_owned())
        .collect();
    Some(prompts::Layout {
        repos,
        root_instructions,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::task::{AgentConfig, Provider};

    #[test]
    fn a_failure_on_a_rate_limited_run_leaves_a_valid_failed_run() {
        let mut t = Task::new("t", "", AgentConfig::new(Provider::Mock));
        let mut run = Run::new(RunKind::Plan, RunState::RateLimited, None);
        run.resets_at = Some(1_764_359_100);
        run.reset_estimated = true;
        run.limit_scope = Some(LimitScope::Run);
        t.run = Some(run);
        t.validate().unwrap();
        assert!(mark_failed(&mut t, "boom"));
        let run = t.run.as_ref().unwrap();
        assert_eq!(run.state, RunState::Failed);
        assert_eq!(run.error.as_deref(), Some("boom"));
        assert_eq!(
            (run.resets_at, run.reset_estimated, &run.limit_scope),
            (None, false, &None)
        );
        t.validate().unwrap();
    }
}
