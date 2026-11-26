//! Request and response bodies that are not core types.

use std::collections::BTreeMap;
use std::path::PathBuf;

use ca_core::agent::preflight::Preflight;
use ca_core::engine::settings::Settings;
use ca_core::task::Answer;
use ca_core::{AgentConfig, Phase, Provider};
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
    /// The repository root, which is the project from now on (a subfolder opens its repository).
    pub root: PathBuf,
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
    pub agent: AgentConfig,
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

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestResponse {
    pub url: String,
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
}
