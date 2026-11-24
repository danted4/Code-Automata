//! Is a provider usable: CLI installed, which version, logged in.
//!
//! Only commands that make no model call and cost nothing are used. The account name these
//! commands print is never kept or returned.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use super::Binaries;
use crate::task::Provider;

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);

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

pub async fn check(provider: Provider, bins: &Binaries) -> Preflight {
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

    report.version = run(&binary, &["--version"], bins)
        .await
        .and_then(|(ok, out)| ok.then(|| out.lines().next().unwrap_or_default().trim().to_string()))
        .filter(|v| !v.is_empty());

    let (logged_in, how_to_fix) = match provider {
        Provider::Claude => (
            run(&binary, &["auth", "status"], bins)
                .await
                .map(|(_, out)| {
                    serde_json::from_str::<serde_json::Value>(&out)
                        .ok()
                        .and_then(|v| v.get("loggedIn").and_then(serde_json::Value::as_bool))
                        .unwrap_or(false)
                }),
            "run `claude` and log in",
        ),
        Provider::Cursor => (
            run(&binary, &["status"], bins)
                .await
                .map(|(ok, out)| ok && out.contains("Logged in") && !out.contains("Not logged in")),
            "run `agent login`",
        ),
        Provider::Amp => (
            run(&binary, &["usage"], bins)
                .await
                .map(|(ok, out)| ok && out.contains("Signed in as")),
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

/// Run a quick command; `(succeeded, stdout + stderr)`, or `None` if it could not run in time.
async fn run(binary: &PathBuf, args: &[&str], bins: &Binaries) -> Option<(bool, String)> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .env("NO_COLOR", "1")
        .kill_on_drop(true);
    if let Some(path) = bins.path_var() {
        cmd.env("PATH", path);
    }
    let out = tokio::time::timeout(CHECK_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some((out.status.success(), text))
}
