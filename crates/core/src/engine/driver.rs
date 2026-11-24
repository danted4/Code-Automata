//! Executing a task's steps, one at a time.
//!
//! Each turn of the loop reads the task file, asks [`next_step`] what to do, does it, and writes
//! the result in one store update (for agent steps, the result and clearing the run happen
//! together). The loop stops when the task waits for the user, finishes, fails, or is halted.
//!
//! A run record exists only while a step is in progress or halted: `running` while it works,
//! `paused` / `interrupted` / `failed` when it stops early, and gone once its result is written.

use std::sync::Arc;

use serde_json::Value;

use super::output::{
    AgentOutput, DevOut, PlanOut, QaOut, QuestionsOut, SubtaskKindOut, SubtasksOut, TriageOut,
    TriageVerdict, read_output,
};
use super::reconcile::process_started;
use super::runlog::{RunLogLine, RunLogWriter};
use super::settings::Settings;
use super::step::{AgentStep, Step, apply_finish_review, apply_rework, next_step};
use super::{Control, EngineEvent, Halt, Inner, checks, prompts};
use crate::agent::{self, Access, AgentEvent, Outcome, OutcomeKind, RunRequest};
use crate::error::{CoreError, Result};
use crate::git::{self, Worktrees};
use crate::task::{
    Phase, PlanningStage, QaVerdict, Question, Run, RunKind, RunState, Subtask, SubtaskKind,
    SubtaskStatus, Task,
};
use crate::transitions::{Mover, apply_move};
use crate::util::now_ms;

/// Diff shown to a resumed agent.
const DIFF_LIMIT: usize = 64 * 1024;

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
    let _ = inner
        .update(id, |t| {
            if let Some(run) = t.run.as_mut() {
                run.state = RunState::Failed;
                run.error = Some(error.to_string());
                run.updated_at = now_ms();
                recorded = true;
                return Ok(());
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
                Phase::HumanReview | Phase::Done => return Ok(()),
            };
            if kind == RunKind::Dev && subtask.is_none() {
                return Ok(()); // no valid place to record it; the task stays where it is
            }
            let mut run = Run::new(kind, RunState::Failed, subtask);
            run.error = Some(error.to_string());
            t.run = Some(run);
            recorded = true;
            Ok(())
        })
        .await;
    if !recorded {
        inner.emit(EngineEvent::Error {
            task_id: id.to_string(),
            message: error.to_string(),
        });
    }
}

async fn create_worktree(inner: &Inner, id: &str) -> Result<()> {
    let path = inner.worktrees.path_for(id)?;
    let base = if git::is_task_worktree(&path, id).await {
        // Created by a previous attempt that died before recording it.
        git::fork_point(inner.project.root(), &Worktrees::branch_for(id)).await?
    } else {
        inner
            .worktrees
            .create(id)
            .await?
            .base_commit
            .ok_or_else(|| CoreError::Invalid("worktree created without a base commit".into()))?
    };
    inner
        .update(id, |t| {
            t.base_commit = Some(base);
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
    let wt = inner.worktrees.path_for(id)?;
    // Checks are recorded against the last dev checkpoint, which next_step compares with. If HEAD
    // is somewhere else (a hand-made commit in the worktree), say so once instead of re-running
    // checks that could never count as current.
    let task = inner
        .store
        .load(id)
        .await?
        .ok_or_else(|| CoreError::TaskNotFound(id.to_string()))?;
    let expected = task
        .last_dev_checkpoint()
        .ok_or_else(|| CoreError::Invalid("the task has no checkpoint to check".into()))?
        .to_string();
    let head = git::head(&wt).await?;
    if head != expected {
        return Err(CoreError::Invalid(format!(
            "the worktree is at {head}, not at the last checkpoint {expected}; commits made by hand \
             in a task worktree are not supported. Reset the worktree to the checkpoint or replan."
        )));
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
    let commands = settings
        .checks
        .clone()
        .unwrap_or_else(|| checks::detect(&wt));
    // A halt drops the running check, whose guard kills its process group.
    let runs = tokio::select! {
        runs = checks::run_all(&wt, &commands, inner.bins.path_var(), settings.timeouts.check()) => runs,
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
    // Checks must not leave files that a later checkpoint would commit (ignored build output stays).
    git::discard_to(&wt, &expected).await?;
    let summary = checks::summarize(&runs, &expected);
    inner
        .update(id, |t| {
            t.review.checks = Some(summary);
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
    run.updated_at = now_ms();
    // A session is only resumed by the provider that created it (the task's agent may have been
    // changed while the run was halted).
    let session = run
        .session_id
        .clone()
        .filter(|_| run.provider.is_none_or(|p| p == task.agent.provider));
    if session.is_none() {
        run.session_id = None;
    }
    run.provider = Some(task.agent.provider);
    let ctx = Ctx {
        inner,
        id,
        run_id: run.id.clone(),
        settings,
        control,
        access,
        record_session: true,
        log_label: "run",
    };
    let task = inner
        .update(id, |t| {
            t.run = Some(run);
            Ok(())
        })
        .await?;
    let sub = subtask_id.as_ref().and_then(|s| task.subtask(s)).cloned();
    let wt = inner.worktrees.path_for(id)?;

    match step {
        AgentStep::Questions => {
            let Attempt::Answer(q) =
                attempt::<QuestionsOut>(&ctx, &task, prompts::questions(&task), None).await?
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
                Some(feedback) => prompts::plan_revision(&task, feedback),
                None => prompts::plan(&task, settings),
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
            let prompt = prompts::subtasks(&task, settings);
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
                        sub
                    })
                    .collect();
                Ok(())
            })
            .await
        }
        AgentStep::Qa(sub_id) => {
            let sub = sub.ok_or_else(|| CoreError::Invalid(format!("no subtask {sub_id:?}")))?;
            let prompt = prompts::qa(&task, &sub);
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
            let caps = agent::capabilities(task.agent.provider);
            let (prompt, resume_session) = if resuming {
                // A crash during an earlier triage may have left the work parked.
                git::unpark_changes(&wt).await?;
                let diff = git::diff_since_checkpoint(&wt, DIFF_LIMIT).await?;
                if settings.triage_on_resume && !diff.is_empty() {
                    match triage(&ctx, &task, &sub, &diff).await? {
                        None => return Ok(false),
                        Some(TriageVerdict::Done) => {
                            let summary = "Judged complete by triage after an interruption.";
                            return finish_dev(&ctx, &task, &sub, summary, "").await;
                        }
                        Some(TriageVerdict::Broken) => {
                            git::discard_changes(&wt).await?;
                            (prompts::dev(&task, &sub, None), None)
                        }
                        Some(TriageVerdict::Partial) => {
                            resume_prompt(&task, &sub, &diff, session.as_deref(), caps.resume)
                        }
                    }
                } else {
                    resume_prompt(&task, &sub, &diff, session.as_deref(), caps.resume)
                }
            } else {
                (prompts::dev(&task, &sub, None), None)
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
    diff: &git::WorkingDiff,
    session: Option<&str>,
    provider_resumes: bool,
) -> (String, Option<String>) {
    match session {
        Some(s) if provider_resumes => (prompts::resume_same_session(diff), Some(s.to_string())),
        _ => (prompts::dev(task, sub, Some(diff)), None),
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
    let wt = ctx.inner.worktrees.path_for(ctx.id)?;
    let label = if summary.trim().is_empty() {
        sub.title.clone()
    } else {
        format!(
            "{}: {}",
            sub.title,
            summary.lines().next().unwrap_or_default()
        )
    };
    let checkpoint = git::checkpoint_commit(&wt, &task.id, &sub.id, &label).await?;
    let sub_id = sub.id.clone();
    let handoff = handoff.trim().to_string();
    finish(ctx, |t| {
        if let Some(s) = t.subtask_mut(&sub_id) {
            s.status = SubtaskStatus::Done;
            s.finished_at = Some(now_ms());
            s.checkpoint = Some(checkpoint.commit);
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
    diff: &git::WorkingDiff,
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
    };
    let wt = ctx.inner.worktrees.path_for(ctx.id)?;
    git::park_changes(&wt).await?;
    let result =
        attempt::<TriageOut>(&triage_ctx, task, prompts::triage(task, sub, diff), None).await;
    git::unpark_changes(&wt).await?;
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
    let caps = agent::capabilities(task.agent.provider);
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
    };
    fail_run(ctx, &message).await?;
    Ok(false)
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
    let wt = inner.worktrees.path_for(ctx.id)?;
    let attempt_no = task.run.as_ref().map_or(1, |r| r.attempt);
    let log_path = inner
        .store
        .task_dir(ctx.id)?
        .join("runs")
        .join(format!("{}-{attempt_no}-{label}.ndjson", ctx.run_id));
    let mut req = RunRequest::new(task.agent.clone(), &wt, prompt, log_path.clone());
    req.resume = session;
    req.access = ctx.access;
    req.json_schema = schema;
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
    // Where a run that may not change anything must leave the worktree.
    let head_before = git::head(&wt).await?;
    let mut events_log = RunLogWriter::create(
        &log_path,
        RunLogLine::Start {
            at: now_ms(),
            run_id: ctx.run_id.clone(),
            attempt: attempt_no,
            label: label.to_string(),
            kind: task.run.as_ref().map_or(RunKind::Dev, |r| r.kind),
            subtask_id: task.run.as_ref().and_then(|r| r.subtask_id.clone()),
            provider: task.agent.provider,
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
            AgentEvent::Finished { outcome: o } => outcome = Some(o.clone()),
            _ => {}
        }
        events_log.event(&event).await;
        inner.emit(EngineEvent::Agent {
            task_id: ctx.id.to_string(),
            run_id: ctx.run_id.clone(),
            event,
        });
    }
    *ctx.control
        .stopper
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = None;
    if ctx.access != Access::Full {
        // Changes and any commits the agent made during this run; earlier commits stay.
        git::discard_to(&wt, &head_before).await?;
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
