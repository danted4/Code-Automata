//! Per-project engine settings: `.code-automata/settings.json`.
//!
//! A missing file means defaults. The file is strict like task files: unknown keys and any schema
//! other than 1 are refused, so a typo cannot silently fall back to a default.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::project::ProjectDir;

pub const SETTINGS_SCHEMA: u32 = 1;

/// One automated check: a shell command run in the task worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckCommand {
    pub name: String,
    pub command: String,
}

/// Each field falls back to its default on its own, so setting one timeout leaves the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Timeouts {
    /// No output for this long ends a run.
    pub idle_minutes: u32,
    /// A tool call open with no output for this long ends a run.
    pub tool_minutes: u32,
    /// Any single agent run longer than this is ended.
    pub total_minutes: u32,
    /// Any single check command longer than this fails.
    pub check_minutes: u32,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts {
            idle_minutes: 10,
            tool_minutes: 30,
            total_minutes: 120,
            check_minutes: 10,
        }
    }
}

impl Timeouts {
    pub fn idle(&self) -> Duration {
        minutes(self.idle_minutes)
    }
    pub fn tool(&self) -> Duration {
        minutes(self.tool_minutes)
    }
    pub fn total(&self) -> Duration {
        minutes(self.total_minutes)
    }
    pub fn check(&self) -> Duration {
        minutes(self.check_minutes)
    }
}

fn minutes(m: u32) -> Duration {
    Duration::from_secs(u64::from(m) * 60)
}

/// Replacements for the editable part of two prompts. The engine always appends its own output
/// instructions, so a custom template cannot break parsing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtasks: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub schema: u32,
    /// Check commands. `None` means detect them from the worktree (see `checks::detect`); an empty
    /// list means run no checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<Vec<CheckCommand>>,
    #[serde(default = "default_concurrency")]
    pub max_concurrent_agents: u32,
    #[serde(default)]
    pub timeouts: Timeouts,
    /// Rework rounds before a task goes to human review with its findings.
    #[serde(default = "default_rework_limit")]
    pub rework_limit: u32,
    /// Before resuming an interrupted dev subtask that left changes, ask a read-only agent whether
    /// the work is done, partial or broken.
    #[serde(default)]
    pub triage_on_resume: bool,
    #[serde(default, skip_serializing_if = "is_default_prompts")]
    pub prompts: PromptOverrides,
}

fn default_concurrency() -> u32 {
    12
}
fn default_rework_limit() -> u32 {
    2
}
fn is_default_prompts(p: &PromptOverrides) -> bool {
    *p == PromptOverrides::default()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            schema: SETTINGS_SCHEMA,
            checks: None,
            max_concurrent_agents: default_concurrency(),
            timeouts: Timeouts::default(),
            rework_limit: default_rework_limit(),
            triage_on_resume: false,
            prompts: PromptOverrides::default(),
        }
    }
}

impl Settings {
    pub fn path(project: &ProjectDir) -> std::path::PathBuf {
        project.state_dir().join("settings.json")
    }

    /// The project's settings, or defaults when there is no file.
    pub async fn load(project: &ProjectDir) -> Result<Settings> {
        let path = Self::path(project);
        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Settings::default()),
            Err(e) => return Err(CoreError::Io { path, source: e }),
        };
        let settings: Settings =
            serde_json::from_slice(&bytes).map_err(|source| CoreError::Corrupt {
                path: path.clone(),
                source,
            })?;
        settings.validate()?;
        Ok(settings)
    }

    pub async fn save(&self, project: &ProjectDir) -> Result<()> {
        self.validate()?;
        project.ensure_git_exclude().await?;
        crate::store::write_json_atomic(&Self::path(project), self).await
    }

    pub fn validate(&self) -> Result<()> {
        let bad = |m: &str| Err(CoreError::Invalid(format!("settings: {m}")));
        if self.schema != SETTINGS_SCHEMA {
            return bad(&format!("schema must be {SETTINGS_SCHEMA}"));
        }
        if self.max_concurrent_agents == 0 {
            return bad("maxConcurrentAgents must be at least 1");
        }
        let t = self.timeouts;
        if t.idle_minutes == 0
            || t.tool_minutes == 0
            || t.total_minutes == 0
            || t.check_minutes == 0
        {
            return bad("timeouts must be at least 1 minute");
        }
        if let Some(checks) = &self.checks
            && checks
                .iter()
                .any(|c| c.name.trim().is_empty() || c.command.trim().is_empty())
        {
            return bad("every check needs a name and a command");
        }
        Ok(())
    }
}
