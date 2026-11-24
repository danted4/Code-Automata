//! Automated checks: deterministic commands run in the worktree after the dev subtasks, before any
//! QA agent.
//!
//! The commands come from settings, or are detected:
//!
//! * **JavaScript/TypeScript** (`package.json`): the package manager comes from the lockfile, and
//!   the `typecheck`, `build` and `lint` scripts run if they exist. With no `typecheck` script but a
//!   `tsconfig.json`, `npx --no-install tsc --noEmit` runs; 2.2.4 ran `tsc` in every repository.
//!   A worktree without `node_modules` (a fresh worktree never has them) installs first from the
//!   lockfile.
//! * **Rust** (`Cargo.toml`): `cargo check --all-targets`.
//!
//! Each command runs with `sh -c` in the worktree, in its own process group, with `CI=1` and no
//! stdin so nothing waits for input, and with a timeout. The last 64 KB of its combined output is
//! kept.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;

use super::settings::CheckCommand;
use crate::task::Checks;
use crate::util::now_ms;

/// Output kept per command.
const TAIL_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRun {
    pub name: String,
    pub command: String,
    pub passed: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// The end of stdout and stderr together.
    pub output: String,
    pub duration: Duration,
}

/// The checks to run in `worktree` when settings name none.
pub fn detect(worktree: &Path) -> Vec<CheckCommand> {
    let mut checks = Vec::new();
    let check = |name: &str, command: String| CheckCommand {
        name: name.to_string(),
        command,
    };

    if let Ok(text) = std::fs::read_to_string(worktree.join("package.json")) {
        let scripts: Vec<String> = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("scripts").and_then(|s| s.as_object()).cloned())
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        let has = |s: &str| scripts.iter().any(|k| k == s);
        let (pm, install) = if worktree.join("pnpm-lock.yaml").exists() {
            ("pnpm", "pnpm install --frozen-lockfile")
        } else if worktree.join("yarn.lock").exists() {
            ("yarn", "yarn install --frozen-lockfile")
        } else if worktree.join("bun.lockb").exists() || worktree.join("bun.lock").exists() {
            ("bun", "bun install --frozen-lockfile")
        } else if worktree.join("package-lock.json").exists() {
            ("npm", "npm ci")
        } else {
            ("npm", "npm install")
        };
        if !worktree.join("node_modules").exists() {
            checks.push(check("install", install.to_string()));
        }
        if has("typecheck") {
            checks.push(check("typecheck", format!("{pm} run typecheck")));
        } else if worktree.join("tsconfig.json").exists() {
            checks.push(check(
                "typecheck",
                "npx --no-install tsc --noEmit".to_string(),
            ));
        }
        for script in ["build", "lint"] {
            if has(script) {
                checks.push(check(script, format!("{pm} run {script}")));
            }
        }
    }
    if worktree.join("Cargo.toml").exists() {
        checks.push(check(
            "cargo check",
            "cargo check --all-targets".to_string(),
        ));
    }
    checks
}

/// Run `commands` in order, stopping at the first failure (later checks would only repeat it).
pub async fn run_all(
    worktree: &Path,
    commands: &[CheckCommand],
    path_var: Option<&OsStr>,
    timeout: Duration,
) -> Vec<CheckRun> {
    let mut runs = Vec::new();
    for c in commands {
        let run = run_one(worktree, c, path_var, timeout).await;
        let failed = !run.passed;
        runs.push(run);
        if failed {
            break;
        }
    }
    runs
}

async fn run_one(
    worktree: &Path,
    check: &CheckCommand,
    path_var: Option<&OsStr>,
    timeout: Duration,
) -> CheckRun {
    let started = Instant::now();
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c")
        .arg(&check.command)
        .current_dir(worktree)
        .env("CI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(p) = path_var {
        cmd.env("PATH", p);
    }
    #[cfg(unix)]
    cmd.process_group(0);

    let finish = |passed, exit_code, timed_out, output: String| CheckRun {
        name: check.name.clone(),
        command: check.command.clone(),
        passed,
        exit_code,
        timed_out,
        output,
        duration: started.elapsed(),
    };
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return finish(false, None, false, format!("could not start: {e}")),
    };
    let pid = child.id();
    let (Some(mut out), Some(mut err)) = (child.stdout.take(), child.stderr.take()) else {
        return finish(false, None, false, "no output pipes".into());
    };

    // Read both pipes into one buffer while waiting, so a chatty command cannot block on a full
    // pipe, and keep only the tail.
    let collect = async {
        let mut buf = Vec::new();
        let (mut a, mut b) = ([0u8; 8192], [0u8; 8192]);
        let (mut out_open, mut err_open) = (true, true);
        while out_open || err_open {
            tokio::select! {
                n = out.read(&mut a), if out_open => match n {
                    Ok(0) | Err(_) => out_open = false,
                    Ok(n) => push_tail(&mut buf, &a[..n]),
                },
                n = err.read(&mut b), if err_open => match n {
                    Ok(0) | Err(_) => err_open = false,
                    Ok(n) => push_tail(&mut buf, &b[..n]),
                },
            }
        }
        let status = child.wait().await;
        (buf, status)
    };

    match tokio::time::timeout(timeout, collect).await {
        Ok((buf, status)) => {
            let code = status.ok().and_then(|s| s.code());
            let text = String::from_utf8_lossy(&buf).into_owned();
            finish(code == Some(0), code, false, text)
        }
        Err(_) => {
            kill_group(pid);
            finish(
                false,
                None,
                true,
                format!("timed out after {} s", timeout.as_secs()),
            )
        }
    }
}

fn push_tail(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(bytes);
    if buf.len() > TAIL_BYTES {
        let cut = buf.len() - TAIL_BYTES;
        buf.drain(..cut);
    }
}

#[cfg(unix)]
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid
        && let Ok(raw) = i32::try_from(pid)
    {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(raw),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: Option<u32>) {}

/// The task-file record of a set of check runs.
pub fn summarize(runs: &[CheckRun]) -> Checks {
    if runs.is_empty() {
        return Checks {
            passed: true,
            summary: "no checks configured".into(),
            details: None,
            at: now_ms(),
        };
    }
    let passed = runs.iter().all(|r| r.passed);
    let summary = runs
        .iter()
        .map(|r| {
            let mark = if r.passed { "✓" } else { "✗" };
            let why = if r.timed_out { " (timed out)" } else { "" };
            format!("{mark} {}{why}", r.name)
        })
        .collect::<Vec<_>>()
        .join(", ");
    let details = runs
        .iter()
        .filter(|r| !r.passed)
        .map(|r| format!("$ {}\n{}", r.command, r.output.trim_end()))
        .collect::<Vec<_>>()
        .join("\n\n");
    Checks {
        passed,
        summary,
        details: (!details.is_empty()).then_some(details),
        at: now_ms(),
    }
}

/// What a rework subtask is told to fix after failing checks.
pub fn rework_feedback(runs: &[CheckRun]) -> String {
    let mut s = String::from("The automated checks failed. Fix the cause of each failure:\n");
    for r in runs.iter().filter(|r| !r.passed) {
        s.push_str(&format!(
            "\n## {} (`{}`){}\n\n```\n{}\n```\n",
            r.name,
            r.command,
            if r.timed_out { ", timed out" } else { "" },
            r.output.trim_end()
        ));
    }
    s
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn dir_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (name, text) in files {
            let path = d.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        d
    }

    fn names(c: &[CheckCommand]) -> Vec<(&str, &str)> {
        c.iter()
            .map(|c| (c.name.as_str(), c.command.as_str()))
            .collect()
    }

    #[test]
    fn detects_yarn_scripts_and_installs_first() {
        let d = dir_with(&[
            (
                "package.json",
                r#"{"scripts":{"typecheck":"tsc","build":"next build","test":"vitest"}}"#,
            ),
            ("yarn.lock", ""),
        ]);
        assert_eq!(
            names(&detect(d.path())),
            [
                ("install", "yarn install --frozen-lockfile"),
                ("typecheck", "yarn run typecheck"),
                ("build", "yarn run build"),
            ]
        );
    }

    #[test]
    fn tsc_only_with_a_tsconfig_and_no_install_when_modules_exist() {
        let d = dir_with(&[
            ("package.json", r#"{"scripts":{"lint":"eslint ."}}"#),
            ("package-lock.json", "{}"),
            ("node_modules/.keep", ""),
        ]);
        assert_eq!(names(&detect(d.path())), [("lint", "npm run lint")]);

        std::fs::write(d.path().join("tsconfig.json"), "{}").unwrap();
        assert_eq!(
            names(&detect(d.path()))[0],
            ("typecheck", "npx --no-install tsc --noEmit")
        );
    }

    #[test]
    fn detects_cargo_and_nothing_in_a_plain_repo() {
        let d = dir_with(&[("Cargo.toml", "[package]")]);
        assert_eq!(
            names(&detect(d.path())),
            [("cargo check", "cargo check --all-targets")]
        );
        let empty = dir_with(&[("README.md", "x")]);
        assert!(detect(empty.path()).is_empty());
    }

    #[tokio::test]
    async fn runs_stop_at_the_first_failure_and_keep_output() {
        let d = tempfile::tempdir().unwrap();
        let cmds = vec![
            CheckCommand {
                name: "ok".into(),
                command: "echo fine".into(),
            },
            CheckCommand {
                name: "bad".into(),
                command: "echo broken >&2; exit 3".into(),
            },
            CheckCommand {
                name: "never".into(),
                command: "touch ran.txt".into(),
            },
        ];
        let runs = run_all(d.path(), &cmds, None, Duration::from_secs(10)).await;
        assert_eq!(runs.len(), 2);
        assert!(runs[0].passed);
        assert_eq!(runs[1].exit_code, Some(3));
        assert!(runs[1].output.contains("broken"));
        assert!(!d.path().join("ran.txt").exists());

        let summary = summarize(&runs);
        assert!(!summary.passed);
        assert_eq!(summary.summary, "✓ ok, ✗ bad");
        assert!(summary.details.unwrap().contains("broken"));
        assert!(rework_feedback(&runs).contains("## bad"));
    }

    #[tokio::test]
    async fn a_hanging_check_times_out() {
        let d = tempfile::tempdir().unwrap();
        let cmds = vec![CheckCommand {
            name: "hang".into(),
            command: "sleep 30".into(),
        }];
        let started = Instant::now();
        let runs = run_all(d.path(), &cmds, None, Duration::from_millis(300)).await;
        assert!(runs[0].timed_out);
        assert!(!runs[0].passed);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn no_checks_is_a_pass() {
        let s = summarize(&[]);
        assert!(s.passed);
        assert_eq!(s.summary, "no checks configured");
    }
}
