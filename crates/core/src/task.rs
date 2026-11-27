//! The task file, schema 2 (schema 1 files, from 3.0, are converted on read: see `store`).
//!
//! One file per task at `.code-automata/tasks/<id>/task.json`. Every piece of state lives in exactly
//! one place:
//!
//! * `phase` is the Kanban column and nothing else;
//! * `run` says whether an agent is working, paused, interrupted or failed, and on which subtask;
//! * a subtask is `pending`, `done` or `skipped` ("running" is `run.subtaskId`);
//! * `planning.stage` says where planning stands ("generating" is a `plan` run).
//!
//! A task works on one or more repositories, keyed by name ([`ROOT_REPO`] when the project is
//! itself a repository): every per-repository value is a map with those keys.
//!
//! Nothing derivable is stored (the branch and worktree paths follow from the id; each repository's
//! last checkpoint is its worktree's HEAD), and [`Task::validate`] rejects the combinations that
//! could still disagree, such as a run whose kind does not belong to the phase. Files are strict: unknown keys
//! and any other schema version are refused rather than guessed at.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{CoreError, Result};
use crate::util::{ROOT_REPO, now_ms, random_base36, validate_repo_name, validate_task_id};

/// Version of the task file format. Files with any other value are refused.
pub const SCHEMA: u32 = 2;

/// The Kanban column. Fixed order; see `transitions` for which moves are allowed.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Cursor,
    Amp,
    Mock,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Answer {
    /// The option picked, if the question offered options.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubtaskKind {
    Dev,
    Qa,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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
    #[cfg_attr(feature = "ts", ts(as = "Option<f64>"))]
    pub finished_at: Option<i64>,
    /// The repositories the plan says it touches: guidance for the agent and the card, not a
    /// limit. Empty for a one-repository project.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub repos: Vec<String>,
    /// The commit made in each repository it changed when it finished. A finished dev subtask that
    /// changed nothing has none.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub checkpoints: BTreeMap<String, String>,
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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
            repos: Vec::new(),
            checkpoints: BTreeMap::new(),
            handoff: None,
            rework_round: None,
            verdict: None,
            skipped_reason: None,
        }
    }
}

/// Result of the automated typecheck/build/lint after QA.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checks {
    pub passed: bool,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[cfg_attr(feature = "ts", ts(as = "f64"))]
    pub at: i64,
    /// The commit the checks ran against. They are current while it is the last dev checkpoint.
    pub commit: String,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Review {
    /// Rework rounds so far; capped by the engine.
    #[serde(default)]
    pub rework_count: u32,
    /// The last checks of each repository that has changes.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub checks: BTreeMap<String, Checks>,
    /// What the next rework round has to fix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

impl Review {
    pub fn is_empty(&self) -> bool {
        *self == Review::default()
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullRequest {
    /// The pull (merge) request, or on a host Code-Automata cannot open one on, the page the host
    /// printed for opening it. None when the host printed no link (the branch is pushed).
    pub url: Option<String>,
    /// Where it was opened. None in task files from before 3.0.1, which were all GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<PrHost>,
    /// The newest dev checkpoint when the branch was last pushed to this PR. Any later dev work (a
    /// rework round, a retried subtask, a replan's new run) has a different newest checkpoint, and
    /// the PR lacks it until it is updated (the UI says so). None in task files from before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pushed_checkpoint: Option<String>,
}

/// How a task's pull request is opened, from the repository's `origin`.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrHost {
    /// With the GitHub CLI (`gh`): github.com and GitHub Enterprise.
    Github,
    /// With git push options, no CLI: gitlab.com and self-hosted GitLab (11.10 and later).
    Gitlab,
    /// Any other host: the branch is pushed and the host's own page opens the pull request.
    Other,
}

/// What a run is doing. One run at a time per task.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
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
    #[cfg_attr(feature = "ts", ts(as = "f64"))]
    pub started_at: i64,
    #[cfg_attr(feature = "ts", ts(as = "f64"))]
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// For a dev run: each repository's HEAD when the run started. Commits after it are this
    /// run's (a checkpoint commit a crash left unrecorded, or one the agent made), so a resume or a
    /// dropped run undoes those and never anything older, such as an earlier plan's checkpoints.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub heads: BTreeMap<String, String>,
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
            heads: BTreeMap::new(),
        }
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub schema: u32,
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[cfg_attr(feature = "ts", ts(as = "f64"))]
    pub created_at: i64,
    #[cfg_attr(feature = "ts", ts(as = "f64"))]
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

    /// The commit each repository's task branch started from, set when the worktrees are created.
    /// Its keys are the task's repositories; empty until then. The branch (`code-automata/<id>` in
    /// each repository) and worktree paths (`.code-automata/worktrees/<id>`, or `<id>/<repo>` in a
    /// workspace) follow from the id and are not stored.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub base_commits: BTreeMap<String, String>,
    /// The pull request of each repository that has one.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pull_requests: BTreeMap<String, PullRequest>,
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
            base_commits: BTreeMap::new(),
            pull_requests: BTreeMap::new(),
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

    /// The task's repositories (the keys of `base_commits`); none before its worktrees exist.
    pub fn repos(&self) -> impl Iterator<Item = &str> {
        self.base_commits.keys().map(String::as_str)
    }

    /// Have the task's worktrees been created?
    pub fn has_worktrees(&self) -> bool {
        !self.base_commits.is_empty()
    }

    /// The commit `repo`'s task branch started from.
    pub fn base_commit(&self, repo: &str) -> Option<&str> {
        self.base_commits.get(repo).map(String::as_str)
    }

    /// The checkpoint of the newest dev subtask that changed `repo`: the last work a squash puts in
    /// that repository's PR. None while no dev subtask has changed it.
    pub fn newest_dev_checkpoint(&self, repo: &str) -> Option<&str> {
        self.subtasks_of(SubtaskKind::Dev)
            .filter_map(|s| s.checkpoints.get(repo).map(String::as_str))
            .last()
    }

    /// The commit `repo`'s latest finished dev work was checkpointed at, or its base commit.
    pub fn last_dev_checkpoint(&self, repo: &str) -> Option<&str> {
        self.newest_dev_checkpoint(repo)
            .or_else(|| self.base_commit(repo))
    }

    /// The repositories some dev subtask has changed (whose last checkpoint is not the base).
    pub fn changed_repos(&self) -> Vec<&str> {
        self.repos()
            .filter(|r| {
                self.newest_dev_checkpoint(r)
                    .is_some_and(|c| Some(c) != self.base_commit(r))
            })
            .collect()
    }

    /// The repositories whose checks count: a one-repository task's repository always (as in
    /// 3.0), otherwise the ones some dev subtask changed.
    pub fn repos_to_check(&self) -> Vec<&str> {
        if self.base_commits.contains_key(ROOT_REPO) {
            vec![ROOT_REPO]
        } else {
            self.changed_repos()
        }
    }

    /// Did the checks of a repository that counts fail?
    pub fn checks_failed(&self) -> bool {
        self.repos_to_check()
            .iter()
            .any(|r| self.review.checks.get(*r).is_some_and(|c| !c.passed))
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
                SubtaskStatus::Pending if s.finished_at.is_some() || !s.checkpoints.is_empty() => {
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
                SubtaskStatus::Skipped if !s.checkpoints.is_empty() => {
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
            for repo in s.checkpoints.keys().chain(&s.repos) {
                self.known_repo(repo, &format!("subtask {:?}", s.id))?;
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
        for repo in self.base_commits.keys() {
            validate_repo_name(repo)?;
        }
        if self.base_commits.len() > 1 && self.base_commits.contains_key(ROOT_REPO) {
            return Err(Invalid(format!(
                "{ROOT_REPO:?} is the only repository of a one-repository task"
            )));
        }
        for repo in self.review.checks.keys() {
            self.known_repo(repo, "the checks")?;
        }
        for repo in self.pull_requests.keys() {
            self.known_repo(repo, "a pull request")?;
        }
        let mut seen = std::collections::HashSet::new();
        for q in &self.planning.questions {
            if !seen.insert(q.id.as_str()) {
                return Err(Invalid(format!("duplicate question id {:?}", q.id)));
            }
        }
        if let Some(run) = &self.run {
            self.validate_run(run)?;
            for repo in run.heads.keys() {
                self.known_repo(repo, "the run")?;
            }
        }
        Ok(())
    }

    /// `repo` must be one of the task's repositories.
    fn known_repo(&self, repo: &str, owner: &str) -> Result<()> {
        if self.base_commits.contains_key(repo) {
            Ok(())
        } else {
            Err(CoreError::Invalid(format!(
                "{owner} names repository {repo:?}, which is not one of the task's"
            )))
        }
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
