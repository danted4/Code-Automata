//! Is a provider usable: CLI installed, which version, logged in.
//!
//! Only commands that make no model call and cost nothing are used. The account name these
//! commands print is never kept or returned.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use super::Binaries;
use super::env::BinarySource;
use crate::task::{AgentConfig, Provider};

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub provider: Provider,
    pub binary: Option<PathBuf>,
    /// How `binary` was found.
    pub source: Option<BinarySource>,
    /// The file the user chose for this provider, if any, even when it no longer works (then
    /// `binary` is None and `problem` says so): the UI offers to go back to finding it.
    pub chosen: Option<PathBuf>,
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
        source: None,
        chosen: None,
        version: None,
        logged_in: None,
        problem: None,
    };
    // A recorded demo: the CLI the mock agent plays is ready, as it would be on a set-up machine.
    if bins.stand_in() == Some(provider) {
        report.binary = Some(PathBuf::from(super::env::binary_name(provider)));
        report.logged_in = Some(true);
        return report;
    }
    if provider != Provider::Mock {
        report.chosen = bins.chosen_paths().remove(&provider);
    }
    let (binary, source) = match bins.find(provider) {
        Ok(found) => found,
        Err(e) => {
            report.problem = Some(e.to_string());
            return report;
        }
    };
    report.binary = Some(binary.clone());
    report.source = Some(source);
    if provider == Provider::Mock {
        report.logged_in = Some(true);
        return report;
    }
    let env_remove = match provider {
        Provider::Claude => super::claude::removed_env(agent),
        Provider::Cursor => super::cursor::removed_env(agent),
        Provider::Codex => super::codex::removed_env(agent),
        Provider::Gemini => super::gemini::removed_env(agent),
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
        // Written to stderr: "Logged in using ChatGPT" (or an API key or token), else "Not
        // logged in" with exit code 1.
        Provider::Codex => (
            run(&["login", "status"]).await.and_then(|o| {
                let text = format!("{}{}", o.stdout, o.stderr);
                if text.contains("Not logged in") {
                    Some(false)
                } else if o.ok && text.contains("Logged in") || text.contains("API key configured")
                {
                    Some(true)
                } else {
                    None
                }
            }),
            "run `codex login`",
        ),
        // No status command: the sign-in method chosen in its settings, or a key it may use.
        Provider::Gemini => (
            gemini_signed_in(bins, agent),
            "run `gemini` once and sign in with Google",
        ),
        Provider::Mock => (Some(true), ""),
    };
    report.logged_in = logged_in;
    report.problem = match logged_in {
        Some(true) => None,
        Some(false) => Some(format!("not logged in: {how_to_fix}")),
        // Often an old version without the status command (an npm copy left behind by a move
        // to the native install), so the file is named.
        None => Some(format!(
            "could not read the login state from {}{}: {how_to_fix}, or update it, or choose \
             another file",
            binary.display(),
            report
                .version
                .as_deref()
                .map(|v| format!(" ({v})"))
                .unwrap_or_default()
        )),
    };
    report
}

/// Whether Gemini CLI has a sign-in it can use headless: a Google login chosen in
/// `~/.gemini/settings.json` (`security.auth.selectedType`, or the older `selectedAuthType`), or an
/// API key or Vertex setting. A key may also come from Gemini's own `.env` files or a shell the app
/// was not started from, and Vertex from Google's default credentials, none of which this can see:
/// those are unknown rather than "not signed in", unless the key is in the app's environment and
/// the run keeps it. Unknown without a home folder.
fn gemini_signed_in(bins: &Binaries, agent: &AgentConfig) -> Option<bool> {
    let home = bins.home()?;
    let settings = std::fs::read_to_string(home.join(".gemini").join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    let selected = settings.as_ref().and_then(|s| {
        s.pointer("/security/auth/selectedType")
            .or_else(|| s.get("selectedAuthType"))
            .and_then(serde_json::Value::as_str)
            .map(String::from)
    });
    let keys_kept = super::option_bool(agent, "useApiKeyFromEnv");
    let has_key = ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
        .iter()
        .any(|k| std::env::var_os(k).is_some());
    match selected.as_deref() {
        Some("oauth-personal" | "compute-default-credentials" | "cloud-shell") => Some(true),
        Some("gemini-api-key" | "vertex-ai") => (keys_kept && has_key).then_some(true),
        Some(_) => Some(true),
        None if keys_kept && has_key => Some(true),
        None => Some(false),
    }
}

struct CheckOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// Run a quick command, or `None` if it could not run in time.
async fn run(
    binary: &std::path::Path,
    args: &[&str],
    bins: &Binaries,
    env_remove: &[String],
) -> Option<CheckOutput> {
    let (program, launch_args) = bins.launch(binary);
    let mut cmd = crate::proc::command(&program);
    cmd.args(&launch_args)
        .args(args)
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
