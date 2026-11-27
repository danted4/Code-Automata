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
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;

use super::settings::{CheckCommand, Settings};
use crate::project::ProjectDir;
use crate::task::Checks;
use crate::util::{ROOT_REPO, now_ms};

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

/// Where a repository's check commands came from.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckSource {
    /// The project's settings (a one-repository project's `checks`).
    Project,
    /// The workspace's settings for this repository.
    Workspace,
    /// The repository's own settings, saved when it was opened on its own.
    Repo,
    /// Detected from the worktree's files.
    Detected,
}

/// A repository's check commands and where they came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedChecks {
    pub commands: Vec<CheckCommand>,
    pub source: CheckSource,
}

/// The check commands for `repo`, whose worktree is `worktree`: a one-repository project's
/// settings, else detected; in a workspace, the workspace's setting for the repository, else the
/// repository's own saved commands, else detected.
pub async fn commands_for(
    project: &ProjectDir,
    settings: &Settings,
    repo: &str,
    worktree: &Path,
) -> ResolvedChecks {
    let resolved = |commands, source| ResolvedChecks { commands, source };
    if repo == ROOT_REPO {
        return match &settings.checks {
            Some(c) => resolved(c.clone(), CheckSource::Project),
            None => resolved(detect(worktree), CheckSource::Detected),
        };
    }
    if let Some(c) = settings.repos.get(repo).and_then(|r| r.checks.clone()) {
        return resolved(c, CheckSource::Workspace);
    }
    if let Ok(main) = project.repo_path(repo)
        && let Some(own) = Settings::load_repo_own(&main).await
        && let Some(c) = own.checks
    {
        return resolved(c, CheckSource::Repo);
    }
    resolved(detect(worktree), CheckSource::Detected)
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
    let mut cmd = crate::proc::shell_command(&check.command);
    cmd.current_dir(worktree)
        .env("CI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(p) = path_var {
        cmd.env("PATH", p);
    }

    let finish = |passed, exit_code, timed_out, output: String| CheckRun {
        name: check.name.clone(),
        command: check.command.clone(),
        passed,
        exit_code,
        timed_out,
        output,
        duration: started.elapsed(),
    };
    let child = match crate::proc::spawn(cmd) {
        Ok(c) => c,
        Err(e) => return finish(false, None, false, format!("could not start: {e}")),
    };
    // Kills the command's whole process tree however this function is left: normal exit, timeout,
    // or the future being dropped (pause, shutdown).
    let mut child = TreeGuard(child);
    let output = Arc::new(StdMutex::new(Vec::new()));
    let readers = [
        child
            .0
            .take_stdout()
            .map(|p| tokio::spawn(read_into(p, output.clone()))),
        child
            .0
            .take_stderr()
            .map(|p| tokio::spawn(read_into(p, output.clone()))),
    ];

    // The check is over when the command exits, not when its pipes close: something it started
    // (a daemon, a watcher) may hold them open indefinitely.
    let (exit_code, timed_out) = match tokio::time::timeout(timeout, child.0.wait()).await {
        Ok(status) => (status.ok().and_then(|s| s.code()), false),
        Err(_) => (None, true),
    };
    drop(child); // stop anything left in the tree, so the pipes close
    for reader in readers.into_iter().flatten() {
        let abort = reader.abort_handle();
        if tokio::time::timeout(DRAIN, reader).await.is_err() {
            // Something outside the tree (a setsid daemon) still holds the pipe; stop reading.
            abort.abort();
        }
    }
    let mut text = {
        let buf = output.lock().unwrap_or_else(|p| p.into_inner());
        String::from_utf8_lossy(&buf).into_owned()
    };
    if timed_out {
        text.push_str(&format!("\n[timed out after {} s]", timeout.as_secs()));
    }
    finish(
        exit_code == Some(0) && !timed_out,
        exit_code,
        timed_out,
        text,
    )
}

/// How long to keep reading after the command exits and its group is killed.
const DRAIN: Duration = Duration::from_millis(500);

async fn read_into<R: tokio::io::AsyncRead + Unpin>(mut pipe: R, out: Arc<StdMutex<Vec<u8>>>) {
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => push_tail(
                &mut out.lock().unwrap_or_else(|p| p.into_inner()),
                &chunk[..n],
            ),
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

/// Kills a process tree when dropped.
struct TreeGuard(crate::proc::TreeChild);

impl Drop for TreeGuard {
    fn drop(&mut self) {
        self.0.kill_now();
    }
}

/// The task-file record of a set of check runs against `commit`.
pub fn summarize(runs: &[CheckRun], commit: &str) -> Checks {
    if runs.is_empty() {
        return Checks {
            passed: true,
            summary: "no checks configured".into(),
            details: None,
            at: now_ms(),
            commit: commit.to_string(),
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
        commit: commit.to_string(),
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
                // Valid in both sh and cmd.
                command: "echo broken 1>&2&& exit 3".into(),
            },
            CheckCommand {
                name: "never".into(),
                command: "echo x> ran.txt".into(),
            },
        ];
        let runs = run_all(d.path(), &cmds, None, Duration::from_secs(10)).await;
        assert_eq!(runs.len(), 2);
        assert!(runs[0].passed);
        assert_eq!(runs[1].exit_code, Some(3));
        assert!(runs[1].output.contains("broken"));
        assert!(!d.path().join("ran.txt").exists());

        let summary = summarize(&runs, "abc");
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
            command: SLEEP_30.into(),
        }];
        let started = Instant::now();
        let runs = run_all(d.path(), &cmds, None, Duration::from_millis(300)).await;
        assert!(runs[0].timed_out);
        assert!(!runs[0].passed);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_check_that_leaves_a_daemon_behind_still_passes_promptly() {
        let d = tempfile::tempdir().unwrap();
        let cmds = vec![CheckCommand {
            name: "build".into(),
            command: if cfg!(windows) {
                // The background ping inherits the output pipe and holds it open.
                "echo built& start \"\" /b ping -n 31 127.0.0.1".into()
            } else {
                "echo built; (sleep 30 &) ; exit 0".into()
            },
        }];
        let started = Instant::now();
        let runs = run_all(d.path(), &cmds, None, Duration::from_secs(10)).await;
        assert!(runs[0].passed, "{:?}", runs[0]);
        assert!(runs[0].output.contains("built"));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_timed_out_check_keeps_its_output() {
        let d = tempfile::tempdir().unwrap();
        let cmds = vec![CheckCommand {
            name: "slow".into(),
            command: format!("echo compiling module 7&& {SLEEP_30}"),
        }];
        let runs = run_all(d.path(), &cmds, None, Duration::from_millis(500)).await;
        assert!(runs[0].timed_out);
        assert!(
            runs[0].output.contains("compiling module 7"),
            "{:?}",
            runs[0].output
        );
        assert!(runs[0].output.contains("timed out"));
    }

    /// Thirty seconds of doing nothing, in the platform's check shell.
    const SLEEP_30: &str = if cfg!(windows) {
        "ping -n 31 127.0.0.1 > nul"
    } else {
        "sleep 30"
    };

    #[tokio::test]
    #[cfg(unix)] // needs the grandchild's pid from the shell ($!)
    async fn dropping_a_running_check_kills_its_processes() {
        let d = tempfile::tempdir().unwrap();
        let pid_file = d.path().join("pid");
        let cmds = vec![CheckCommand {
            name: "long".into(),
            command: format!("sleep 60 & echo $! > {}; wait", pid_file.display()),
        }];
        let path = d.path().to_path_buf();
        let task =
            tokio::spawn(async move { run_all(&path, &cmds, None, Duration::from_secs(60)).await });
        let mut pid = None;
        for _ in 0..100 {
            if let Ok(t) = std::fs::read_to_string(&pid_file)
                && let Ok(p) = t.trim().parse::<u32>()
            {
                pid = Some(p);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let pid = pid.expect("no pid");
        task.abort();
        let _ = task.await;
        let mut dead = false;
        for _ in 0..40 {
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            if !alive {
                dead = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(dead, "the check's child outlived the dropped check");
    }

    #[test]
    fn no_checks_is_a_pass() {
        let s = summarize(&[], "abc");
        assert!(s.passed);
        assert_eq!(s.summary, "no checks configured");
    }
}
