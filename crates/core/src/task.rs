//! Task schema v2.
//!
//! Serialises to the same camelCase JSON as `src/lib/tasks/schema.ts`, so the existing UI can read a v2
//! file. v2 adds `schemaVersion`, a `run` record and a few fields; `status` and `assignedAgent` become
//! derived from the run and are recomputed on every save. Keys this code does not know are kept in
//! `extra` and written back unchanged.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SCHEMA_VERSION: u32 = 2;

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

/// Task-level `status` as the 2.2.4 UI understands it. Derived from the run in v2 (see
/// [`Task::derived_status`]). Subtasks also use this enum for their own status, which is not derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Blocked,
    Planning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningStatus {
    NotStarted,
    GeneratingQuestions,
    WaitingForAnswers,
    GeneratingPlan,
    PlanReady,
    PlanApproved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubtaskType {
    /// 2.2.4 always wrote `type`; a file without it is treated as a dev subtask.
    #[default]
    Dev,
    Qa,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    pub id: String,
    pub content: String,
    pub label: String,
    pub status: TaskStatus,
    #[serde(rename = "type", default)]
    pub kind: SubtaskType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    /// v2: commit recorded when this subtask completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_commit: Option<String>,
    /// v2: the agent's handoff note for the subtasks after this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanningAnswer {
    #[serde(default)]
    pub selected_option: String,
    #[serde(default)]
    pub additional_text: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanningQuestion {
    pub id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub answer: PlanningAnswer,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub order: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningDataStatus {
    #[default]
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanningData {
    #[serde(default)]
    pub questions: Vec<PlanningQuestion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<i64>,
    #[serde(default)]
    pub status: PlanningDataStatus,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Complexity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_complexity: Option<Complexity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_test_data: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Outcome of the automated checks after QA (from the `d-c-1_5` branch).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QaOverall {
    Pass,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaResult {
    pub overall: QaOverall,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
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

/// Durable record of the task's current run. This is the single source of truth for "where were we".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub kind: RunKind,
    pub state: RunState,
    /// Subtask being worked on, for `dev` and `qa` runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtask_id: Option<String>,
    /// 1 for the first try of the current step; incremented on retry and resume.
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Provider conversation id, used to resume the same session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Identifies the app process that owns the run; a different boot id means the owner died.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    /// Commit the current step started from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checkpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Run {
    pub fn new(kind: RunKind, state: RunState, subtask_id: Option<String>) -> Self {
        let now = crate::util::now_ms();
        Run {
            id: format!("run-{now}-{}", crate::util::random_base36(6)),
            kind,
            state,
            subtask_id,
            attempt: 1,
            provider: None,
            session_id: None,
            pid: None,
            boot_id: None,
            started_at: now,
            updated_at: now,
            last_checkpoint: None,
            last_error: None,
            extra: Map::new(),
        }
    }
}

fn v1() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// Missing in 2.2.4 files, which deserialise as version 1.
    #[serde(default = "v1")]
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub phase: Phase,
    /// Derived on save from `run` and `phase`; never set it directly.
    pub status: TaskStatus,
    #[serde(default)]
    pub subtasks: Vec<Subtask>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_config: Option<Map<String, Value>>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_human_review: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_approved: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_status: Option<PlanningStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_data: Option<PlanningData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_logs_path: Option<String>,

    /// Derived on save: the active run's id, so the 2.2.4 UI still shows "agent working".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    /// v2: commit the task branch started from; checkpoint commits are squashed back onto it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa_failure_feedback: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rework_count: Option<u32>,
    /// `d-c-1_5` spelled this key `lastQAResult`, which camelCase would not produce.
    #[serde(
        rename = "lastQAResult",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_qa_result: Option<QaResult>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_issue: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gitlab_issue: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_request_url: Option<String>,

    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub metadata: TaskMetadata,

    /// v2: the current or most recent run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<Run>,

    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Task {
    /// A new task in planning with no run, as `POST /api/tasks/create` built it.
    pub fn new(id: String, title: String, description: String) -> Self {
        let now = crate::util::now_ms();
        let mut task = Task {
            schema_version: SCHEMA_VERSION,
            planning_logs_path: Some(format!(".code-automata/tasks/{id}/planning-logs.txt")),
            branch_name: Some(format!("code-automata/{id}")),
            title: if title.trim().is_empty() {
                id.clone()
            } else {
                title
            },
            id,
            description,
            phase: Phase::Planning,
            status: TaskStatus::Pending,
            subtasks: Vec::new(),
            cli_tool: None,
            cli_config: None,
            requires_human_review: Some(false),
            plan_approved: Some(false),
            locked: Some(false),
            planning_status: Some(PlanningStatus::NotStarted),
            planning_data: None,
            plan_content: None,
            assigned_agent: None,
            worktree_path: None,
            base_commit: None,
            qa_failure_feedback: None,
            rework_count: None,
            last_qa_result: None,
            github_issue: None,
            gitlab_issue: None,
            merge_request_url: None,
            created_at: now,
            updated_at: now,
            metadata: TaskMetadata::default(),
            run: None,
            extra: Map::new(),
        };
        task.normalize();
        task
    }

    pub fn subtask(&self, id: &str) -> Option<&Subtask> {
        self.subtasks.iter().find(|s| s.id == id)
    }

    pub fn subtask_mut(&mut self, id: &str) -> Option<&mut Subtask> {
        self.subtasks.iter_mut().find(|s| s.id == id)
    }

    pub fn subtasks_of(&self, kind: SubtaskType) -> impl Iterator<Item = &Subtask> {
        self.subtasks.iter().filter(move |s| s.kind == kind)
    }

    /// True when the task has at least one subtask of `kind` and all of them are completed.
    pub fn all_completed(&self, kind: SubtaskType) -> bool {
        let mut any = false;
        for s in self.subtasks_of(kind) {
            any = true;
            if s.status != TaskStatus::Completed {
                return false;
            }
        }
        any
    }

    pub fn has_active_run(&self) -> bool {
        self.run.as_ref().is_some_and(|r| r.state.is_active())
    }

    /// The 2.2.4-compatible `status`, computed from the run and the phase.
    pub fn derived_status(&self) -> TaskStatus {
        if let Some(run) = &self.run {
            match run.state {
                RunState::Queued | RunState::Running => {
                    return if self.phase == Phase::Planning {
                        TaskStatus::Planning
                    } else {
                        TaskStatus::InProgress
                    };
                }
                RunState::Failed => return TaskStatus::Blocked,
                RunState::Paused | RunState::Interrupted => return TaskStatus::Pending,
                RunState::Done => {}
            }
        }
        match self.phase {
            Phase::HumanReview | Phase::Done => TaskStatus::Completed,
            Phase::Planning | Phase::InProgress | Phase::AiReview => TaskStatus::Pending,
        }
    }

    /// Recompute the derived fields. The store calls this before every write.
    pub fn normalize(&mut self) {
        self.schema_version = SCHEMA_VERSION;
        self.status = self.derived_status();
        self.assigned_agent = self
            .run
            .as_ref()
            .filter(|r| r.state.is_active())
            .map(|r| r.id.clone());
    }

    /// Structural checks run before every write.
    pub fn validate(&self) -> crate::error::Result<()> {
        use crate::error::CoreError::Invalid;
        crate::util::validate_task_id(&self.id)?;
        let mut seen = std::collections::HashSet::new();
        for s in &self.subtasks {
            if s.id.trim().is_empty() {
                return Err(Invalid("a subtask has an empty id".into()));
            }
            if !seen.insert(s.id.as_str()) {
                return Err(Invalid(format!("duplicate subtask id {:?}", s.id)));
            }
        }
        if let Some(run) = &self.run
            && let Some(sub) = &run.subtask_id
            && self.subtask(sub).is_none()
        {
            return Err(Invalid(format!(
                "run points at subtask {sub:?}, which does not exist"
            )));
        }
        Ok(())
    }
}
