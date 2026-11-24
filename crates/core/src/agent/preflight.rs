//! Is a provider usable: CLI installed, which version, logged in.
//!
//! Only commands that make no model call and cost nothing are used. The account name these
//! commands print is never kept or returned.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use super::Binaries;
use crate::task::{AgentConfig, Provider};

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub provider: Provider,
    pub binary: Option<PathBuf>,
    pub version: Option<String>,
    /// `None` when the login state could not be determined.
    pub logged_in: Option<bool>,
    /// What the user has to do, when the provider is not ready.
    pub problem: Option<String>,
}

impl Preflight {
    pub fn ready(&self) -> bool {
        self.binary.is_some() && self.logged_in == Some(true) && self.problem.is_none()
    }
}

/// Check `provider` as a task with default settings would run it.
pub async fn check(provider: Provider, bins: &Binaries) -> Preflight {
    check_agent(&AgentConfig::new(provider), bins).await
}

/// Check the provider of `agent` under exactly the environment its runs get (for example with the
/// API-key variables removed unless `useApiKeyFromEnv` is set), so preflight cannot pass on a key
/// the real run will not see.
pub async fn check_agent(agent: &AgentConfig, bins: &Binaries) -> Preflight {
    let provider = agent.provider;
    let mut report = Preflight {
        provider,
        binary: None,
        version: None,
        logged_in: None,
        problem: None,
    };
    let binary = match bins.locate(provider) {
        Ok(path) => path,
        Err(e) => {
            report.problem = Some(e.to_string());
            return report;
        }
    };
    report.binary = Some(binary.clone());
    if provider == Provider::Mock {
        report.logged_in = Some(true);
        return report;
    }
    let env_remove = match provider {
        Provider::Claude => super::claude::removed_env(agent),
        Provider::Cursor => super::cursor::removed_env(agent),
        Provider::Amp | Provider::Mock => Vec::new(),
    };
    let run = |args: &'static [&'static str]| run(&binary, args, bins, &env_remove);

    report.version = run(&["--version"])
        .await
        .filter(|o| o.ok)
        .and_then(|o| o.stdout.lines().next().map(|l| l.trim().to_string()))
        .filter(|v| !v.is_empty());

    let (logged_in, how_to_fix) = match provider {
        // JSON on stdout only; stderr may carry update notices or runtime warnings.
        Provider::Claude => (
            run(&["auth", "status"]).await.and_then(|o| {
                serde_json::from_str::<serde_json::Value>(o.stdout.trim())
                    .ok()?
                    .get("loggedIn")?
                    .as_bool()
            }),
            "run `claude` and log in",
        ),
        Provider::Cursor => (
            run(&["status"]).await.and_then(|o| {
                let text = format!("{}{}", o.stdout, o.stderr);
                if text.contains("Not logged in") {
                    Some(false)
                } else if o.ok && text.contains("Logged in") {
                    Some(true)
                } else {
                    None
                }
            }),
            "run `agent login`",
        ),
        Provider::Amp => (
            run(&["usage"]).await.and_then(|o| {
                let text = format!("{}{}", o.stdout, o.stderr);
                if o.ok && text.contains("Signed in as") {
                    Some(true)
                } else if text.contains("log in") || text.contains("API key") {
                    Some(false)
                } else {
                    None
                }
            }),
            "run `amp login`",
        ),
        Provider::Mock => (Some(true), ""),
    };
    report.logged_in = logged_in;
    report.problem = match logged_in {
        Some(true) => None,
        Some(false) => Some(format!("not logged in: {how_to_fix}")),
        None => Some(format!("could not check the login: {how_to_fix}")),
    };
    report
}

struct CheckOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// Run a quick command, or `None` if it could not run in time.
async fn run(
    binary: &PathBuf,
    args: &[&str],
    bins: &Binaries,
    env_remove: &[String],
) -> Option<CheckOutput> {
    let mut cmd = crate::proc::command(binary);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .env("NO_COLOR", "1")
        .kill_on_drop(true);
    if let Some(path) = bins.path_var() {
        cmd.env("PATH", path);
    }
    for key in env_remove {
        cmd.env_remove(key);
    }
    let out = tokio::time::timeout(CHECK_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    Some(CheckOutput {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}
