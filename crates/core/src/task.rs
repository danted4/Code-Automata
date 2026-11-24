//! The task file, schema 1.
//!
//! One file per task at `.code-automata/tasks/<id>/task.json`. Every piece of state lives in exactly
//! one place:
//!
//! * `phase` is the Kanban column and nothing else;
//! * `run` says whether an agent is working, paused, interrupted or failed, and on which subtask;
//! * a subtask is `pending`, `done` or `skipped` ("running" is `run.subtaskId`);
//! * `planning.stage` says where planning stands ("generating" is a `plan` run).
//!
//! Nothing derivable is stored (the branch and worktree path follow from the id; the last checkpoint
//! is the worktree's HEAD), and [`Task::validate`] rejects the combinations that could still
//! disagree, such as a run whose kind does not belong to the phase. Files are strict: unknown keys
//! and any other schema version are refused rather than guessed at.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{CoreError, Result};
use crate::util::{now_ms, random_base36, validate_task_id};

/// Version of the task file format. Files with any other value are refused.
pub const SCHEMA: u32 = 1;

/// The Kanban column. Fixed order; see `transitions` for which moves are allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Planning,
    InProgress,
    AiReview,
    HumanReview,
    Done,
}

impl Phase {
    pub const ALL: [Phase; 5] = [
        Phase::Planning,
        Phase::InProgress,
        Phase::AiReview,
        Phase::HumanReview,
        Phase::Done,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Planning => "planning",
            Phase::InProgress => "in_progress",
            Phase::AiReview => "ai_review",
            Phase::HumanReview => "human_review",
            Phase::Done => "done",
        }
    }
}

impl fmt::Display for Phase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Which CLI agent runs the task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Cursor,
    Amp,
    Mock,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    pub provider: Provider,
    /// Provider model id; `None` uses the provider's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Provider mode, such as Amp's `low`; `None` uses the provider's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Anything else a provider takes, passed through to its adapter.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub options: Map<String, Value>,
}

impl AgentConfig {
    pub fn new(provider: Provider) -> Self {
        AgentConfig {
            provider,
            model: None,
            mode: None,
            options: Map::new(),
        }
    }
}

/// Where planning stands. While an agent is producing questions or a plan, the stage stays put and
/// a `plan` run is active.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningStage {
    #[default]
    NotStarted,
    /// Questions are waiting for the user's answers.
    Questions,
    /// The user answered; the plan is next.
    Answered,
    /// A plan is written and waiting for approval.
    PlanReady,
    Approved,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Answer {
    /// The option picked, if the question offered options.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<Answer>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Planning {
    #[serde(default)]
    pub stage: PlanningStage,
    /// In the order they are asked.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<Question>,
    /// The plan, as markdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// The user's feedback on the plan, waiting for a revision run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// Wait for the user's approval even when plan approval is off (set by replanning).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hold: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubtaskKind {
    Dev,
    Qa,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubtaskStatus {
    Pending,
    Done,
    /// Skipped by the user. Counts as finished for moving on, but is not reported as done.
    Skipped,
}

impl SubtaskStatus {
    pub fn is_finished(self) -> bool {
        matches!(self, SubtaskStatus::Done | SubtaskStatus::Skipped)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Subtask {
    pub id: String,
    pub kind: SubtaskKind,
    /// Short label for the card.
    pub title: String,
    /// What the agent is asked to do.
    pub detail: String,
    pub status: SubtaskStatus,
    /// Present-tense label shown while it runs ("Running tests").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    /// Commit made when it finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    /// The agent's note for the subtasks after this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<String>,
    /// Set on dev subtasks added by a rework round (1-based), for the "Reworking (n/m)" label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rework_round: Option<u32>,
    /// A finished QA subtask's verdict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<QaVerdict>,
    /// Why the engine skipped it (a user's skip has none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped_reason: Option<String>,
}

/// What a QA reviewer concluded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QaVerdict {
    pub passed: bool,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<String>,
}

impl Subtask {
    pub fn new(
        id: impl Into<String>,
        kind: SubtaskKind,
        title: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Subtask {
            id: id.into(),
            kind,
            title: title.into(),
            detail: detail.into(),
            status: SubtaskStatus::Pending,
            progress_label: None,
            finished_at: None,
            checkpoint: None,
            handoff: None,
            rework_round: None,
            verdict: None,
            skipped_reason: None,
        }
    }
}

/// Result of the automated typecheck/build/lint after QA.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checks {
    pub passed: bool,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    pub at: i64,
    /// The commit the checks ran against. They are current while it is the last dev checkpoint.
    pub commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Review {
    /// Rework rounds so far; capped by the engine.
    #[serde(default)]
    pub rework_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<Checks>,
    /// What the next rework round has to fix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

impl Review {
    pub fn is_empty(&self) -> bool {
        *self == Review::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullRequest {
    pub url: String,
}

/// What a run is doing. One run at a time per task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunKind {
    /// Planning questions, plan generation or plan modification.
    Plan,
    /// Turning the approved plan into subtasks.
    SubtaskGen,
    /// Working through dev subtasks.
    Dev,
    /// Working through QA subtasks.
    Qa,
    /// Automated typecheck/build/lint after QA.
    Checks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Queued,
    Running,
    /// Stopped by the user; resumes on the same step.
    Paused,
    /// The app or agent died mid-step; resumes on the same step.
    Interrupted,
    /// The agent reported an error or timed out.
    Failed,
    Done,
}

impl RunKind {
    /// The only phase a run of this kind can belong to.
    pub fn phase(self) -> Phase {
        match self {
            RunKind::Plan | RunKind::SubtaskGen => Phase::Planning,
            RunKind::Dev => Phase::InProgress,
            RunKind::Qa | RunKind::Checks => Phase::AiReview,
        }
    }

    /// The subtask kind a run of this kind works through, if any.
    pub fn subtask_kind(self) -> Option<SubtaskKind> {
        match self {
            RunKind::Dev => Some(SubtaskKind::Dev),
            RunKind::Qa => Some(SubtaskKind::Qa),
            RunKind::Plan | RunKind::SubtaskGen | RunKind::Checks => None,
        }
    }
}

impl RunState {
    /// An agent is (or is about to be) working on the task.
    pub fn is_active(self) -> bool {
        matches!(self, RunState::Queued | RunState::Running)
    }

    /// The run stopped part-way and can be resumed.
    pub fn is_resumable(self) -> bool {
        matches!(
            self,
            RunState::Paused | RunState::Interrupted | RunState::Failed
        )
    }
}

/// Durable record of the task's current or last run: the single answer to "where were we".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    pub id: String,
    pub kind: RunKind,
    pub state: RunState,
    /// Subtask being worked on, for `dev` and `qa` runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtask_id: Option<String>,
    /// 1 for the first try of the current step; incremented on retry and resume.
    pub attempt: u32,
    /// The provider that ran it (the task's agent config can change afterwards).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<Provider>,
    /// Provider conversation id, used to resume the same session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// When that process started, as `ps` reports it, so a reused pid is never mistaken for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_started: Option<String>,
    /// The app process that owns the run; a different boot id means the owner died.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Run {
    pub fn new(kind: RunKind, state: RunState, subtask_id: Option<String>) -> Self {
        let now = now_ms();
        Run {
            id: format!("run-{now}-{}", random_base36(6)),
            kind,
            state,
            subtask_id,
            attempt: 1,
            provider: None,
            session_id: None,
            pid: None,
            process_started: None,
            boot_id: None,
            started_at: now,
            updated_at: now,
            error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub schema: u32,
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,

    pub phase: Phase,
    pub agent: AgentConfig,
    /// Stop for the user's answers and plan approval; otherwise planning runs straight through.
    #[serde(default)]
    pub require_plan_approval: bool,
    #[serde(default)]
    pub planning: Planning,
    /// Dev and QA subtasks, in execution order within each kind.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtasks: Vec<Subtask>,
    #[serde(default, skip_serializing_if = "Review::is_empty")]
    pub review: Review,

    /// Commit the task's branch started from, set when its worktree is created. The branch
    /// (`code-automata/<id>`) and worktree path (`.code-automata/worktrees/<id>`) follow from the
    /// id and are not stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<PullRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<Run>,
}

impl Task {
    /// A new task in planning, with no run and no worktree yet. A blank title becomes the id.
    pub fn new(title: &str, description: &str, agent: AgentConfig) -> Self {
        let now = now_ms();
        let id = format!("task-{now}-{}", random_base36(5));
        let title = if title.trim().is_empty() {
            id.clone()
        } else {
            title.trim().to_string()
        };
        Task {
            schema: SCHEMA,
            id,
            title,
            description: description.to_string(),
            created_at: now,
            updated_at: now,
            phase: Phase::Planning,
            agent,
            require_plan_approval: false,
            planning: Planning::default(),
            subtasks: Vec::new(),
            review: Review::default(),
            base_commit: None,
            pull_request: None,
            run: None,
        }
    }

    pub fn subtask(&self, id: &str) -> Option<&Subtask> {
        self.subtasks.iter().find(|s| s.id == id)
    }

    pub fn subtask_mut(&mut self, id: &str) -> Option<&mut Subtask> {
        self.subtasks.iter_mut().find(|s| s.id == id)
    }

    pub fn subtasks_of(&self, kind: SubtaskKind) -> impl Iterator<Item = &Subtask> {
        self.subtasks.iter().filter(move |s| s.kind == kind)
    }

    /// True when the task has at least one subtask of `kind` and every one is done or skipped.
    pub fn all_finished(&self, kind: SubtaskKind) -> bool {
        let mut any = false;
        for s in self.subtasks_of(kind) {
            any = true;
            if !s.status.is_finished() {
                return false;
            }
        }
        any
    }

    /// The commit the latest finished dev subtask was checkpointed at, or the base commit.
    pub fn last_dev_checkpoint(&self) -> Option<&str> {
        self.subtasks_of(SubtaskKind::Dev)
            .filter_map(|s| s.checkpoint.as_deref())
            .last()
            .or(self.base_commit.as_deref())
    }

    pub fn has_active_run(&self) -> bool {
        self.run.as_ref().is_some_and(|r| r.state.is_active())
    }

    /// Structural checks run before every write.
    pub fn validate(&self) -> Result<()> {
        use CoreError::Invalid;
        validate_task_id(&self.id)?;
        if self.schema != SCHEMA {
            return Err(Invalid(format!("schema must be {SCHEMA}")));
        }
        if self.title.trim().is_empty() {
            return Err(Invalid("the title is empty".into()));
        }
        let mut seen = std::collections::HashSet::new();
        for s in &self.subtasks {
            if s.id.trim().is_empty() {
                return Err(Invalid("a subtask has an empty id".into()));
            }
            if !seen.insert(s.id.as_str()) {
                return Err(Invalid(format!("duplicate subtask id {:?}", s.id)));
            }
            match s.status {
                SubtaskStatus::Pending if s.finished_at.is_some() || s.checkpoint.is_some() => {
                    return Err(Invalid(format!(
                        "pending subtask {:?} has a finish time or checkpoint",
                        s.id
                    )));
                }
                SubtaskStatus::Done | SubtaskStatus::Skipped if s.finished_at.is_none() => {
                    return Err(Invalid(format!(
                        "finished subtask {:?} has no finish time",
                        s.id
                    )));
                }
                SubtaskStatus::Skipped if s.checkpoint.is_some() => {
                    return Err(Invalid(format!(
                        "skipped subtask {:?} has a checkpoint",
                        s.id
                    )));
                }
                _ => {}
            }
            if s.verdict.is_some() && (s.kind != SubtaskKind::Qa || s.status != SubtaskStatus::Done)
            {
                return Err(Invalid(format!(
                    "subtask {:?} has a verdict but is not a finished QA subtask",
                    s.id
                )));
            }
            if s.kind == SubtaskKind::Dev
                && s.status == SubtaskStatus::Done
                && s.checkpoint.is_none()
            {
                return Err(Invalid(format!(
                    "finished dev subtask {:?} has no checkpoint",
                    s.id
                )));
            }
            if s.skipped_reason.is_some() && s.status != SubtaskStatus::Skipped {
                return Err(Invalid(format!(
                    "subtask {:?} has a skip reason but is not skipped",
                    s.id
                )));
            }
            if s.rework_round.is_some() && s.kind != SubtaskKind::Dev {
                return Err(Invalid(format!(
                    "rework subtask {:?} must be a dev subtask",
                    s.id
                )));
            }
        }
        let mut seen = std::collections::HashSet::new();
        for q in &self.planning.questions {
            if !seen.insert(q.id.as_str()) {
                return Err(Invalid(format!("duplicate question id {:?}", q.id)));
            }
        }
        if let Some(run) = &self.run {
            self.validate_run(run)?;
        }
        Ok(())
    }

    /// A run must belong to the task's phase, and a `dev`/`qa` run must point at a subtask of its
    /// kind that is still pending (or finished, once the run itself is done).
    fn validate_run(&self, run: &Run) -> Result<()> {
        use CoreError::Invalid;
        if run.kind.phase() != self.phase {
            return Err(Invalid(format!(
                "a {:?} run cannot belong to a task in {}",
                run.kind, self.phase
            )));
        }
        match (run.kind.subtask_kind(), &run.subtask_id) {
            (None, None) => Ok(()),
            (None, Some(sub)) => Err(Invalid(format!(
                "a {:?} run does not work on subtasks but points at {sub:?}",
                run.kind
            ))),
            (Some(_), None) => Err(Invalid(format!(
                "a {:?} run must point at a subtask",
                run.kind
            ))),
            (Some(kind), Some(sub)) => {
                let Some(subtask) = self.subtask(sub) else {
                    return Err(Invalid(format!(
                        "run points at subtask {sub:?}, which does not exist"
                    )));
                };
                if subtask.kind != kind {
                    return Err(Invalid(format!(
                        "a {:?} run points at {sub:?}, which is a {:?} subtask",
                        run.kind, subtask.kind
                    )));
                }
                if run.state != RunState::Done && subtask.status != SubtaskStatus::Pending {
                    return Err(Invalid(format!(
                        "an unfinished run points at {sub:?}, which is already {:?}",
                        subtask.status
                    )));
                }
                Ok(())
            }
        }
    }
}
