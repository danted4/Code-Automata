//! Request and response bodies that are not core types.

use std::collections::BTreeMap;
use std::path::PathBuf;

use ca_core::agent::preflight::Preflight;
use ca_core::engine::settings::Settings;
use ca_core::task::Answer;
use ca_core::{Phase, PhaseAgents, Provider};
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenProjectRequest {
    pub path: PathBuf,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectResponse {
    /// The project folder: a repository root, or a workspace folder.
    pub root: PathBuf,
    pub kind: ca_core::project::ProjectKind,
    /// The repositories: `["."]` for a repository, the folder names in a workspace.
    pub repos: Vec<String>,
    /// Tasks that could not be reconciled when the project was opened, with why.
    pub reconcile_problems: Vec<String>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub provider: Provider,
    pub label: String,
    pub preflight: Preflight,
}

/// The CLI file the user chose for an agent, if any (kept per machine, not per project).
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliPath {
    pub provider: Provider,
    pub label: String,
    pub path: Option<PathBuf>,
}

/// `PUT /api/cli-paths/:provider`: the file to use, or `null` to find it again.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChooseCliRequest {
    pub path: Option<PathBuf>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTaskRequest {
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// The agent of each phase.
    pub agents: PhaseAgents,
    #[serde(default)]
    pub require_plan_approval: bool,
    /// Start planning at once (the default).
    #[serde(default = "yes")]
    #[cfg_attr(feature = "ts", ts(optional, as = "Option<bool>"))]
    pub start: bool,
}

fn yes() -> bool {
    true
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveRequest {
    pub to: Phase,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnswersRequest {
    /// By question id.
    pub answers: BTreeMap<String, Answer>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackRequest {
    pub feedback: String,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRequest {
    pub plan: String,
}

/// The editable part of the two prompts a user can change, as shipped.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDefaults {
    pub plan: String,
    pub subtasks: String,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    pub settings: Settings,
    pub prompt_defaults: PromptDefaults,
    /// Each repository's check commands as a task would run them, and where they come from.
    pub repo_checks: Vec<ca_core::engine::RepoChecks>,
}

/// `PUT /api/memory`: the project memory's new text.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveMemoryRequest {
    pub text: String,
    /// The text the edit started from (see `Engine::save_memory`).
    pub base: String,
}
