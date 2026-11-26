//! Git worktrees and checkpoints.
//!
//! Shells out to `git` rather than linking libgit2, so behaviour matches the git the user has.
//!
//! * Arguments are passed as an array, never through a shell.
//! * git runs with `LC_ALL=C` so its messages can be matched, and network calls have a timeout.
//! * A worktree's status is read only if the directory really is a worktree root; otherwise git
//!   would walk up and report the main checkout.
//! * Delete never removes anything outside the worktrees directory, and without `force` never
//!   removes a worktree git itself would not remove.
//! * Each task branch records the commit it started from; finished subtasks are checkpoint
//!   commits, squashed into one commit for the pull request.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use serde::Serialize;

use crate::error::{CoreError, Result, io_at};
use crate::project::ProjectDir;
use crate::util::validate_task_id;

/// Limit for commands that talk to a remote.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);

fn git_error(args: &[&str], stderr: impl Into<String>) -> CoreError {
    CoreError::Git {
        args: args.join(" "),
        stderr: stderr.into(),
    }
}

pub(crate) async fn git_output(
    cwd: &Path,
    args: &[&str],
    timeout: Option<Duration>,
) -> Result<Output> {
    let mut attempt = 0;
    let mut cleared = false;
    loop {
        let out = git_output_once(cwd, args, timeout).await?;
        let locked = !out.status.success() && retry_safe(args);
        if locked && !cleared && remove_dead_lock(&out.stderr).await {
            cleared = true;
            continue;
        }
        // Another git process (an editor's git integration, say) holding the index lock for a
        // moment: wait and try again rather than fail the task's step.
        if locked && attempt < INDEX_LOCK_RETRIES && index_held(&out.stderr) {
            attempt += 1;
            tokio::time::sleep(Duration::from_millis(100 * u64::from(attempt))).await;
            continue;
        }
        return Ok(out);
    }
}

/// About 2 s in all.
const INDEX_LOCK_RETRIES: u32 = 6;

/// Commands that take the index lock before changing anything, so a run that failed on the lock
/// did nothing and can simply run again. `worktree add`/`remove`, `branch` and `push` are left
/// out: they create or delete directories, branches or remote refs on their own schedule.
fn retry_safe(args: &[&str]) -> bool {
    matches!(
        subcommand(args),
        Some("reset" | "add" | "commit" | "clean" | "status" | "diff" | "write-tree")
    )
}

/// The git subcommand, past any leading `-c name=value` options (the identity fallback adds them).
fn subcommand<'a>(args: &[&'a str]) -> Option<&'a str> {
    let mut rest = args;
    while let [flag, _value, tail @ ..] = rest
        && *flag == "-c"
    {
        rest = tail;
    }
    rest.first().copied()
}

/// A lock older than this was left by a git process that died; waiting will not clear it.
const STALE_LOCK: Duration = Duration::from_secs(15);

/// `Some` when the command failed because an index lock exists, with the lock's path when git's
/// message names it.
fn index_lock_in(stderr: &[u8]) -> Option<Option<PathBuf>> {
    let text = String::from_utf8_lossy(stderr);
    if !(text.contains("index.lock") && text.contains("File exists")) {
        return None;
    }
    Some(
        text.split_once("Unable to create '")
            .and_then(|(_, rest)| rest.split_once("': File exists"))
            .map(|(path, _)| PathBuf::from(path)),
    )
}

/// How old an index lock must be before Windows may treat it as dead (see [`remove_dead_lock`]).
/// git holds a live lock open from creation until it renames it, which takes far less.
const DEAD_LOCK_AGE: Duration = Duration::from_secs(1);

/// Windows only: delete the index lock the command failed on if no process has it open, and say
/// whether it did. git for Windows creates lock files with `open(O_CREAT | O_EXCL)`, which it
/// routes to `_wopen`, and that cannot grant `FILE_SHARE_DELETE` (compat/mingw.c,
/// `mingw_open`). So while any git holds the lock, deleting it fails with a sharing violation and
/// nothing is removed; it can only succeed for a lock whose git is gone: killed mid-write, as a
/// run's leftover git is when its Job Object closes. Such a lock is never released and would fail
/// every later step (a checkpoint's `git add`, a reset) until the user deleted it by hand. On Unix
/// a lock cannot be told from a live one this way, so nothing is removed there.
async fn remove_dead_lock(stderr: &[u8]) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let Some(Some(lock)) = index_lock_in(stderr) else {
        return false;
    };
    if !removable_lock_path(&lock) {
        return false;
    }
    let old = std::fs::metadata(&lock)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age >= DEAD_LOCK_AGE);
    if !old {
        return false;
    }
    match tokio::fs::remove_file(&lock).await {
        Ok(()) => {
            log::warn!("removed {}, left by a git that is gone", lock.display());
            true
        }
        // Held open (a live git), or gone already: the normal retry decides.
        Err(_) => false,
    }
}

/// Only an absolute path to a file named exactly `index.lock` may be deleted: the path comes from
/// git's message, and nothing else it might name (or a relative path, which would resolve against
/// this process's working directory) is ever touched.
fn removable_lock_path(lock: &Path) -> bool {
    lock.is_absolute() && lock.file_name().is_some_and(|n| n == "index.lock")
}

/// The command failed because another git process holds an index lock right now. A stale lock
/// (from a killed git) is not waited on: git's own message names the file to remove.
fn index_held(stderr: &[u8]) -> bool {
    let lock = match index_lock_in(stderr) {
        None => return false,
        Some(None) => return true,
        Some(Some(lock)) => lock,
    };
    match std::fs::metadata(&lock).and_then(|m| m.modified()) {
        Ok(modified) => modified.elapsed().map_or(true, |age| age < STALE_LOCK),
        // Gone by now: released, so a retry will get it.
        Err(_) => true,
    }
}

async fn git_output_once(cwd: &Path, args: &[&str], timeout: Option<Duration>) -> Result<Output> {
    let mut cmd = crate::proc::command("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        // Read-only commands (status, diff) must not refresh and lock the index: that lock would
        // make a write the engine runs at the same moment fail.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let run = cmd.output();
    let result = match timeout {
        Some(limit) => tokio::time::timeout(limit, run)
            .await
            .map_err(|_| git_error(args, format!("timed out after {}s", limit.as_secs())))?,
        None => run.await,
    };
    result.map_err(|e| git_error(args, format!("could not run git: {e}")))
}

fn check(args: &[&str], out: Output) -> Result<Vec<u8>> {
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(git_error(
            args,
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ))
    }
}

/// Run git and return trimmed stdout, or an error carrying stderr.
pub(crate) async fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = check(args, git_output(cwd, args, None).await?)?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Run git and return stdout untouched (for diffs and `-z` output).
async fn run_git_raw(cwd: &Path, args: &[&str]) -> Result<Vec<u8>> {
    check(args, git_output(cwd, args, None).await?)
}

/// Run git where a non-zero exit is an answer, not an error (for example `diff --quiet`).
async fn git_succeeds(cwd: &Path, args: &[&str]) -> Result<bool> {
    Ok(git_output(cwd, args, None).await?.status.success())
}

pub async fn git_available() -> bool {
    crate::proc::command("git")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await
        .is_ok_and(|s| s.success())
}

async fn branch_exists(repo: &Path, branch: &str) -> Result<bool> {
    git_succeeds(
        repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .await
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub task_id: String,
    pub path: PathBuf,
    /// `None` for a worktree on a detached HEAD.
    pub branch_name: Option<String>,
    pub main_repo: PathBuf,
    pub main_branch: String,
    /// Set by `create`; not known for worktrees found by `list`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_dirty: Option<bool>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_changes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DeleteOptions {
    /// Delete even with uncommitted changes, or when git refuses to remove the worktree.
    pub force: bool,
    /// Also delete the local branch `code-automata/<task id>`.
    pub delete_branch: bool,
    /// Also delete the branch on `origin`.
    pub delete_remote: bool,
    /// Path reported by `git worktree list`, when it differs from the computed one.
    pub path_override: Option<PathBuf>,
}

/// Non-fatal problems from a delete (a branch that could not be removed, for example).
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DeleteReport {
    pub warnings: Vec<String>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    #[cfg_attr(feature = "ts", ts(as = "f64"))]
    pub total_bytes: u64,
    #[cfg_attr(feature = "ts", ts(as = "BTreeMap<String, f64>"))]
    pub per_worktree: BTreeMap<String, u64>,
}

/// What is at a worktree path.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Probe {
    Missing,
    /// The directory exists but is not the root of a git work tree.
    NotWorktree,
    Worktree {
        path: PathBuf,
        branch: String,
        dirty: bool,
    },
    /// A worktree root whose state git could not read.
    Unreadable {
        path: PathBuf,
        error: String,
    },
}

async fn probe(path: &Path) -> Probe {
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        return Probe::Missing;
    }
    let canonical = crate::util::canonicalize(path)
        .await
        .unwrap_or_else(|_| path.to_path_buf());
    let rev_parse = ["rev-parse", "--show-toplevel"];
    let out = match git_output(&canonical, &rev_parse, None).await {
        Ok(out) => out,
        // git could not run at all (no git on PATH): we know nothing, so nothing is deletable.
        Err(e) => {
            return Probe::Unreadable {
                path: canonical,
                error: e.to_string(),
            };
        }
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let has_git_entry = tokio::fs::symlink_metadata(canonical.join(".git"))
            .await
            .is_ok();
        // A plain folder outside any repository. A folder with its own `.git` that git rejects is
        // a broken worktree (admin dir pruned, repo moved) and may hold uncommitted work.
        return if stderr.contains("not a git repository") && !has_git_entry {
            Probe::NotWorktree
        } else {
            Probe::Unreadable {
                path: canonical,
                error: stderr.trim().to_string(),
            }
        };
    }
    let top = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let top = crate::util::canonicalize(&top)
        .await
        .unwrap_or_else(|_| PathBuf::from(top));
    if top != canonical {
        return Probe::NotWorktree;
    }
    let changes = run_git(&canonical, &["status", "--porcelain"]).await;
    let branch = run_git(&canonical, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    match (changes, branch) {
        (Ok(changes), Ok(branch)) => Probe::Worktree {
            path: canonical,
            branch,
            dirty: !changes.is_empty(),
        },
        (Err(e), _) | (_, Err(e)) => Probe::Unreadable {
            path: canonical,
            error: e.to_string(),
        },
    }
}

/// Where `branch` is checked out (main checkout or any worktree), if anywhere, in the form
/// [`comparable`] gives.
async fn checked_out_at(repo: &Path, branch: &str) -> Result<Option<PathBuf>> {
    let list = run_git(repo, &["worktree", "list", "--porcelain"]).await?;
    let want = format!("branch refs/heads/{branch}");
    let mut current: Option<PathBuf> = None;
    for line in list.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            current = Some(PathBuf::from(p));
        } else if line == want {
            return Ok(match current {
                Some(p) => Some(comparable(&p).await),
                None => None,
            });
        }
    }
    Ok(None)
}

/// `path` with symlinks resolved (macOS's /var is /private/var), so two spellings of one place
/// compare equal. A path that no longer exists is resolved through its parent.
async fn comparable(path: &Path) -> PathBuf {
    if let Ok(p) = crate::util::canonicalize(path).await {
        return crate::util::plain_path(p);
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => match crate::util::canonicalize(parent).await {
            Ok(p) => crate::util::plain_path(p).join(name),
            Err(_) => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

/// Does `path` hold a worktree on the task's branch?
pub async fn is_task_worktree(path: &Path, task_id: &str) -> bool {
    matches!(
        probe(path).await,
        Probe::Worktree { ref branch, .. } if *branch == Worktrees::branch_for(task_id)
    )
}

/// Status of the worktree at `path`. Only a directory that is itself a git work tree root counts;
/// otherwise git would walk up and report the main checkout.
pub async fn status_at(path: &Path) -> WorktreeStatus {
    match probe(path).await {
        Probe::Missing => WorktreeStatus::default(),
        Probe::NotWorktree => WorktreeStatus {
            exists: true,
            path: Some(path.to_path_buf()),
            error: Some("directory exists but is not a git worktree".into()),
            ..WorktreeStatus::default()
        },
        Probe::Worktree {
            path,
            branch,
            dirty,
        } => WorktreeStatus {
            exists: true,
            path: Some(path),
            branch_name: Some(branch),
            has_changes: Some(dirty),
            error: None,
        },
        Probe::Unreadable { path, error } => WorktreeStatus {
            exists: true,
            path: Some(path),
            error: Some(error),
            ..WorktreeStatus::default()
        },
    }
}

/// Worktree operations for one project.
#[derive(Debug, Clone)]
pub struct Worktrees {
    project: ProjectDir,
}

impl Worktrees {
    pub fn new(project: ProjectDir) -> Self {
        Worktrees { project }
    }

    pub fn base_path(&self) -> PathBuf {
        self.project.worktrees_dir()
    }

    pub fn path_for(&self, task_id: &str) -> Result<PathBuf> {
        validate_task_id(task_id)?;
        Ok(self.base_path().join(task_id))
    }

    pub fn branch_for(task_id: &str) -> String {
        format!("code-automata/{task_id}")
    }

    /// `origin`'s default branch, else a local `main` or `master`, else `main`.
    pub async fn main_branch(&self) -> String {
        let repo = self.project.root();
        if let Ok(full) = run_git(
            repo,
            &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        )
        .await
            && let Some(name) = full.strip_prefix("refs/remotes/origin/")
            && !name.is_empty()
        {
            return name.to_string();
        }
        for candidate in ["main", "master"] {
            if branch_exists(repo, candidate).await.unwrap_or(false) {
                return candidate.to_string();
            }
        }
        "main".to_string()
    }

    /// Create `.code-automata/worktrees/<id>` on a new branch `code-automata/<id>`, starting from the
    /// main checkout's current HEAD. The start commit is returned as `base_commit`.
    pub async fn create(&self, task_id: &str) -> Result<WorktreeInfo> {
        let path = self.path_for(task_id)?;
        let repo = self.project.root();
        let branch = Self::branch_for(task_id);
        let add = ["worktree", "add"];
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return Err(git_error(
                &add,
                format!(
                    "{} already exists; delete it first or use another task id",
                    path.display()
                ),
            ));
        }
        if branch_exists(repo, &branch).await? {
            return Err(git_error(
                &add,
                format!("branch {branch} already exists; delete it first or use another task id"),
            ));
        }
        self.project.ensure_git_exclude().await?;
        let base = self.base_path();
        tokio::fs::create_dir_all(&base)
            .await
            .map_err(io_at(&base))?;

        let base_commit = run_git(repo, &["rev-parse", "HEAD"]).await?;
        let path_str = path.to_string_lossy().to_string();
        run_git(
            repo,
            &["worktree", "add", "-b", &branch, &path_str, &base_commit],
        )
        .await?;

        Ok(WorktreeInfo {
            task_id: task_id.to_string(),
            path: crate::util::canonicalize(&path)
                .await
                .map_err(io_at(&path))?,
            branch_name: Some(branch),
            main_repo: repo.to_path_buf(),
            main_branch: self.main_branch().await,
            base_commit: Some(base_commit),
            is_dirty: Some(false),
        })
    }

    /// Bring back the worktree of a task whose worktree was removed (a done task's), on its
    /// existing branch `code-automata/<id>`, which holds the work. What is at the path decides:
    ///
    /// * the task's worktree on its branch: nothing to do;
    /// * nothing, or a folder that is not a worktree (what a removal that failed partway leaves,
    ///   with no `.git`; git run in it would walk up to the main checkout): it is cleared and the
    ///   worktree added;
    /// * a worktree on another branch (the user switched it) or one git cannot read: refused, and
    ///   left alone, since it may hold the user's uncommitted work.
    pub async fn restore(&self, task_id: &str) -> Result<()> {
        let path = self.path_for(task_id)?;
        let branch = Self::branch_for(task_id);
        let leftover = match probe(&path).await {
            Probe::Worktree { branch: on, .. } if on == branch => return Ok(()),
            Probe::Worktree { branch: on, .. } => {
                return Err(CoreError::Invalid(format!(
                    "the task's worktree {} is on {on}; switch it back to {branch}, then reopen \
                     the task",
                    path.display()
                )));
            }
            Probe::Unreadable { error, .. } => {
                return Err(CoreError::Invalid(format!(
                    "the task's worktree {} could not be read ({error}); fix or remove it, then \
                     reopen the task",
                    path.display()
                )));
            }
            Probe::NotWorktree => true,
            Probe::Missing => false,
        };
        let repo = self.project.root();
        if !branch_exists(repo, &branch).await? {
            return Err(CoreError::Invalid(format!(
                "the task's branch {branch} is gone, so its worktree cannot be brought back"
            )));
        }
        // Drop git's record of a removed folder first, so only a real checkout counts below.
        run_git(repo, &["worktree", "prune"]).await?;
        if let Some(elsewhere) = checked_out_at(repo, &branch).await?
            && elsewhere != comparable(&path).await
        {
            return Err(CoreError::Invalid(format!(
                "the task's branch {branch} is checked out in {}; switch that checkout to \
                 another branch, then reopen the task",
                elsewhere.display()
            )));
        }
        if leftover {
            // Not a worktree at all: a leftover folder (or file) in Code-Automata's own worktrees
            // directory. remove_dir_all does not follow symlinks.
            let meta = tokio::fs::symlink_metadata(&path)
                .await
                .map_err(io_at(&path))?;
            if meta.is_dir() {
                tokio::fs::remove_dir_all(&path)
                    .await
                    .map_err(io_at(&path))?;
            } else {
                tokio::fs::remove_file(&path).await.map_err(io_at(&path))?;
            }
            run_git(repo, &["worktree", "prune"]).await?;
        }
        let base = self.base_path();
        tokio::fs::create_dir_all(&base)
            .await
            .map_err(io_at(&base))?;
        let path_str = path.to_string_lossy().to_string();
        run_git(repo, &["worktree", "add", &path_str, &branch]).await?;
        Ok(())
    }

    pub async fn status(&self, task_id: &str) -> Result<WorktreeStatus> {
        let path = self.path_for(task_id)?;
        Ok(status_at(&path).await)
    }

    /// Remove a task's worktree, optionally with its local and remote branch.
    ///
    /// Without `force`, a dirty or unreadable worktree is refused, and if `git worktree remove`
    /// fails the git error is returned: files are only removed by hand when `force` is set or the
    /// directory is not a worktree at all. A missing directory still has its stale git record
    /// pruned and its branches deleted as asked.
    pub async fn delete(&self, task_id: &str, opts: DeleteOptions) -> Result<DeleteReport> {
        let computed = self.path_for(task_id)?;
        let path = opts.path_override.clone().unwrap_or(computed);
        self.ensure_inside_base(&path).await?;
        let repo = self.project.root();
        let remove = ["worktree", "remove"];

        match probe(&path).await {
            Probe::Missing => {
                run_git(repo, &["worktree", "prune"]).await?;
            }
            Probe::NotWorktree => {
                // Nothing git would track: a leftover folder inside our own worktrees directory.
                remove_dir_if_exists(&path).await?;
                run_git(repo, &["worktree", "prune"]).await?;
            }
            Probe::Worktree { dirty: true, .. } if !opts.force => {
                return Err(git_error(
                    &remove,
                    "the worktree has uncommitted changes; force the delete or commit first",
                ));
            }
            Probe::Unreadable { error, .. } if !opts.force => {
                return Err(git_error(
                    &remove,
                    format!("could not read the worktree's state ({error}); force the delete"),
                ));
            }
            Probe::Worktree { .. } | Probe::Unreadable { .. } => {
                let path_str = path.to_string_lossy().to_string();
                let mut args = vec!["worktree", "remove", path_str.as_str()];
                if opts.force {
                    // Twice: a single --force does not remove a locked worktree.
                    args.extend(["--force", "--force"]);
                }
                if let Err(e) = run_git(repo, &args).await {
                    if !opts.force {
                        return Err(e);
                    }
                    // Forced and git still refused (broken worktree): unlock so prune will drop the
                    // record, remove the files by hand, then prune.
                    let _ = run_git(repo, &["worktree", "unlock", path_str.as_str()]).await;
                    remove_dir_if_exists(&path).await?;
                    run_git(repo, &["worktree", "prune"]).await?;
                }
                remove_dir_if_exists(&path).await?;
            }
        }

        let mut report = DeleteReport::default();
        let branch = Self::branch_for(task_id);
        if opts.delete_branch
            && branch_exists(repo, &branch).await.unwrap_or(false)
            && let Err(e) = run_git(repo, &["branch", "-D", &branch]).await
        {
            report
                .warnings
                .push(format!("could not delete local branch {branch}: {e}"));
        }
        if opts.delete_remote {
            let args = ["push", "origin", "--delete", branch.as_str()];
            let result = match git_output(repo, &args, Some(NETWORK_TIMEOUT)).await {
                Ok(out) => check(&args, out).map(|_| ()),
                Err(e) => Err(e),
            };
            if let Err(e) = result {
                let msg = e.to_string();
                // Expected when the branch was never pushed (LC_ALL=C keeps this text stable).
                if !msg.contains("remote ref does not exist") {
                    report
                        .warnings
                        .push(format!("could not delete remote branch {branch}: {msg}"));
                }
            }
        }
        Ok(report)
    }

    /// Worktrees git knows about whose directory sits directly in `.code-automata/worktrees/`.
    pub async fn list(&self) -> Result<Vec<WorktreeInfo>> {
        let repo = self.project.root();
        let raw = run_git_raw(repo, &["worktree", "list", "--porcelain", "-z"]).await?;
        let main_branch = self.main_branch().await;
        let base = crate::util::canonicalize(self.base_path())
            .await
            .unwrap_or_else(|_| self.base_path());

        let mut found = Vec::new();
        // With -z, fields end in NUL and records end in an empty field.
        let text = String::from_utf8_lossy(&raw);
        for record in text.split("\0\0") {
            let mut path = None;
            let mut branch = None;
            for field in record.split('\0') {
                if let Some(p) = field.strip_prefix("worktree ") {
                    path = Some(PathBuf::from(p));
                } else if let Some(b) = field.strip_prefix("branch ") {
                    branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                }
            }
            let Some(path) = path else { continue };
            let path = if path.is_absolute() {
                path
            } else {
                repo.join(path)
            };
            // Compare canonical forms: on Windows canonicalize yields \\?\C:\... while git
            // prints C:/..., and on macOS /var vs /private/var. A gone directory keeps its raw parent.
            let Some(parent) = path.parent() else {
                continue;
            };
            let parent = crate::util::canonicalize(parent)
                .await
                .unwrap_or_else(|_| parent.to_path_buf());
            if parent != base {
                continue;
            }
            let Some(task_id) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
                continue;
            };
            if validate_task_id(&task_id).is_err() {
                continue;
            }
            let is_dirty = status_at(&path).await.has_changes;
            found.push(WorktreeInfo {
                task_id,
                path,
                branch_name: branch,
                main_repo: repo.to_path_buf(),
                main_branch: main_branch.clone(),
                base_commit: None,
                is_dirty,
            });
        }
        Ok(found)
    }

    /// Bytes used by each directory under `.code-automata/worktrees/`. Symlinks are not followed.
    pub async fn disk_usage(&self) -> Result<DiskUsage> {
        let base = self.base_path();
        tokio::task::spawn_blocking(move || disk_usage_blocking(&base))
            .await
            .map_err(|e| CoreError::Io {
                path: PathBuf::new(),
                source: std::io::Error::other(e),
            })?
    }

    async fn ensure_inside_base(&self, path: &Path) -> Result<()> {
        let base = self.base_path();
        let base = crate::util::canonicalize(&base).await.unwrap_or(base);
        let resolved = match crate::util::canonicalize(path).await {
            Ok(p) => p,
            // A prunable worktree's directory may be gone; check the path as written.
            Err(_) => path.to_path_buf(),
        };
        let inside = resolved.starts_with(&base)
            && resolved != base
            && !resolved
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir));
        if inside {
            Ok(())
        } else {
            Err(git_error(
                &["worktree", "remove"],
                format!(
                    "refusing to delete {}: it is not inside {}",
                    path.display(),
                    base.display()
                ),
            ))
        }
    }
}

async fn remove_dir_if_exists(path: &Path) -> Result<()> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(CoreError::Io {
            path: path.to_path_buf(),
            source: e,
        }),
    }
}

fn disk_usage_blocking(base: &Path) -> Result<DiskUsage> {
    let mut usage = DiskUsage::default();
    let entries = match std::fs::read_dir(base) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(usage),
        Err(e) => {
            return Err(CoreError::Io {
                path: base.to_path_buf(),
                source: e,
            });
        }
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let size = dir_size(&entry.path());
        usage.total_bytes += size;
        usage
            .per_worktree
            .insert(entry.file_name().to_string_lossy().to_string(), size);
    }
    Ok(usage)
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.path().symlink_metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

// ---------------------------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------------------------

/// Result of [`checkpoint_commit`].
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// HEAD after the call.
    pub commit: String,
    /// False when there was nothing to commit and HEAD was returned unchanged.
    pub created: bool,
}

/// Uncommitted work in a worktree relative to its last checkpoint (HEAD).
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiff {
    /// The checkpoint the diff is against.
    pub base: String,
    /// `git diff HEAD` for tracked files, byte-for-byte, cut to the size limit.
    pub diff: String,
    /// New files not yet tracked (paths only), at most `MAX_UNTRACKED`.
    pub untracked: Vec<String>,
    /// The diff or the untracked list was cut.
    pub truncated: bool,
}

impl WorkingDiff {
    pub const MAX_UNTRACKED: usize = 200;

    pub fn is_empty(&self) -> bool {
        self.diff.is_empty() && self.untracked.is_empty()
    }
}

pub async fn head(worktree: &Path) -> Result<String> {
    run_git(worktree, &["rev-parse", "HEAD"]).await
}

/// Throw away everything since the last checkpoint: tracked changes are reverted and untracked
/// files removed. Ignored files (build output, `node_modules`) are kept. This is what makes
/// read-only and review runs read-only whatever the provider allowed.
pub async fn discard_changes(worktree: &Path) -> Result<()> {
    run_git(worktree, &["reset", "--hard", "-q", "HEAD"]).await?;
    run_git(worktree, &["clean", "-fdq"]).await?;
    Ok(())
}

/// Like [`discard_changes`], and also drop any commits made after `commit` (an agent that ran
/// `git commit` during a run that may not change anything).
pub async fn discard_to(worktree: &Path, commit: &str) -> Result<()> {
    run_git(worktree, &["reset", "--hard", "-q", commit]).await?;
    run_git(worktree, &["clean", "-fdq"]).await?;
    Ok(())
}

/// Subject of the temporary commit that parks partial work (see [`park_changes`]).
pub const PARKED_SUBJECT: &str = "code-automata: parked partial work";

/// Commit everything in the worktree as a temporary "parked" commit, so a read-only look at it
/// (which discards changes afterwards) cannot lose it. Returns false when there was nothing to park.
pub async fn park_changes(worktree: &Path) -> Result<bool> {
    run_git(worktree, &["add", "-A"]).await?;
    if git_succeeds(worktree, &["diff", "--cached", "--quiet"]).await? {
        return Ok(false);
    }
    run_with_identity(
        worktree,
        &[
            "commit",
            "--no-verify",
            "--no-gpg-sign",
            "-q",
            "-m",
            PARKED_SUBJECT,
        ],
    )
    .await?;
    Ok(true)
}

/// Undo [`park_changes`]: the parked work becomes uncommitted again, exactly as it was (new files
/// become untracked again). Does nothing unless HEAD is a parked commit, so it is safe to call
/// after a crash at any point.
pub async fn unpark_changes(worktree: &Path) -> Result<()> {
    let subject = run_git(worktree, &["log", "-1", "--format=%s"]).await?;
    if subject == PARKED_SUBJECT {
        run_git(worktree, &["reset", "-q", "--mixed", "HEAD~1"]).await?;
    }
    Ok(())
}

/// Run git with a time limit and return what it printed on stdout and stderr together: a push's
/// remote messages (a host's pull request link) are on stderr.
pub(crate) async fn run_git_all(cwd: &Path, args: &[&str], limit: Duration) -> Result<String> {
    let out = git_output(cwd, args, Some(limit)).await?;
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        return Err(git_error(args, stderr.trim().to_string()));
    }
    Ok(format!("{}{stderr}", String::from_utf8_lossy(&out.stdout)))
}

/// Where `branch` left the main checkout's history: used to recover a task's base commit when its
/// worktree exists but the commit was never recorded (a crash right after creating it).
pub async fn fork_point(repo: &Path, branch: &str) -> Result<String> {
    run_git(repo, &["merge-base", "HEAD", branch]).await
}

/// `-c user.name/-c user.email` when the repository has no identity configured, so commits made by
/// the engine never fail on a fresh machine. A configured identity is always used as-is.
async fn identity_args(worktree: &Path) -> Vec<String> {
    let has_email = run_git(worktree, &["config", "user.email"])
        .await
        .is_ok_and(|v| !v.is_empty());
    let has_name = run_git(worktree, &["config", "user.name"])
        .await
        .is_ok_and(|v| !v.is_empty());
    let mut args = Vec::new();
    if !has_name {
        args.extend(["-c".to_string(), "user.name=Code-Automata".to_string()]);
    }
    if !has_email {
        args.extend([
            "-c".to_string(),
            "user.email=code-automata@localhost".to_string(),
        ]);
    }
    args
}

async fn run_with_identity(worktree: &Path, args: &[&str]) -> Result<String> {
    let mut full = identity_args(worktree).await;
    full.extend(args.iter().map(|a| (*a).to_string()));
    let refs: Vec<&str> = full.iter().map(String::as_str).collect();
    run_git(worktree, &refs).await
}

/// Commit everything in the worktree as the checkpoint for a finished subtask.
///
/// Hooks are skipped (`--no-verify`: worktrees usually lack the tools hooks need, such as
/// `node_modules`) and signing is skipped (`--no-gpg-sign`: a passphrase prompt would hang a
/// non-interactive run). Checkpoints are squashed before the pull request, so neither reaches the
/// final history.
pub async fn checkpoint_commit(
    worktree: &Path,
    task_id: &str,
    subtask_id: &str,
    label: &str,
) -> Result<Checkpoint> {
    run_git(worktree, &["add", "-A"]).await?;
    if git_succeeds(worktree, &["diff", "--cached", "--quiet"]).await? {
        return Ok(Checkpoint {
            commit: head(worktree).await?,
            created: false,
        });
    }
    let message = format!(
        "code-automata: {label}\n\nCode-Automata-Task: {task_id}\nCode-Automata-Subtask: {subtask_id}"
    );
    run_with_identity(
        worktree,
        &["commit", "--no-verify", "--no-gpg-sign", "-m", &message],
    )
    .await?;
    Ok(Checkpoint {
        commit: head(worktree).await?,
        created: true,
    })
}

/// What changed since the last checkpoint, for the prompt of a resumed subtask. The tracked diff is
/// cut at `max_bytes` (on a character boundary) and the untracked list at
/// [`WorkingDiff::MAX_UNTRACKED`]. Does not modify the index.
pub async fn diff_since_checkpoint(worktree: &Path, max_bytes: usize) -> Result<WorkingDiff> {
    let base = head(worktree).await?;
    let raw = run_git_raw(worktree, &["diff", "--no-color", "--no-ext-diff", "HEAD"]).await?;
    let mut diff = String::from_utf8_lossy(&raw).into_owned();
    let mut truncated = false;
    if diff.len() > max_bytes {
        let mut cut = max_bytes;
        while !diff.is_char_boundary(cut) {
            cut -= 1;
        }
        diff.truncate(cut);
        truncated = true;
    }

    let raw = run_git_raw(
        worktree,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )
    .await?;
    let mut untracked: Vec<String> = raw
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect();
    if untracked.len() > WorkingDiff::MAX_UNTRACKED {
        untracked.truncate(WorkingDiff::MAX_UNTRACKED);
        truncated = true;
    }

    Ok(WorkingDiff {
        base,
        diff,
        untracked,
        truncated,
    })
}

/// Replace every commit after `base_commit` (checkpoints plus any uncommitted work) with one commit.
///
/// The new commit is built with `commit-tree` and the branch is moved with a compare-and-swap
/// `update-ref`, so the branch is never left rewound part-way: it points either at the old head or
/// at the finished squash. Returns the new commit, or `None` when the branch was already at
/// `base_commit` with nothing new. When the work nets out to no change against the base, the branch
/// is moved back to `base_commit` and `None` is returned.
///
/// Hooks never run for `commit-tree`; the user's signing setting is respected, since this commit is
/// the one that ships.
pub async fn squash_checkpoints(
    worktree: &Path,
    base_commit: &str,
    message: &str,
) -> Result<Option<String>> {
    let ancestor = git_succeeds(
        worktree,
        &["merge-base", "--is-ancestor", base_commit, "HEAD"],
    )
    .await?;
    if !ancestor {
        return Err(git_error(
            &["merge-base", "--is-ancestor"],
            format!("{base_commit} is not an ancestor of HEAD; refusing to squash"),
        ));
    }

    run_git(worktree, &["add", "-A"]).await?;
    let tree = run_git(worktree, &["write-tree"]).await?;
    let base_tree = run_git(worktree, &["rev-parse", &format!("{base_commit}^{{tree}}")]).await?;
    let old_head = head(worktree).await?;
    let base_full = run_git(
        worktree,
        &["rev-parse", &format!("{base_commit}^{{commit}}")],
    )
    .await?;

    if tree == base_tree {
        if old_head != base_full {
            run_git(worktree, &["update-ref", "HEAD", &base_full, &old_head]).await?;
        }
        return Ok(None);
    }

    let sign = run_git(worktree, &["config", "--bool", "commit.gpgsign"])
        .await
        .is_ok_and(|v| v == "true");
    let mut args = vec!["commit-tree", "-p", base_full.as_str(), "-m", message];
    if sign {
        args.push("-S");
    }
    args.push(tree.as_str());
    let new_commit = run_with_identity(worktree, &args).await?;
    run_git(worktree, &["update-ref", "HEAD", &new_commit, &old_head]).await?;
    Ok(Some(new_commit))
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_an_absolute_index_lock_may_be_removed() {
        let abs = std::env::temp_dir()
            .join("repo")
            .join(".git")
            .join("index.lock");
        assert!(super::removable_lock_path(&abs));
        assert!(!super::removable_lock_path(std::path::Path::new(
            ".git/index.lock"
        )));
        assert!(!super::removable_lock_path(
            &abs.with_file_name("HEAD.lock")
        ));
        assert!(!super::removable_lock_path(&abs.with_file_name("index")));
        assert!(!super::removable_lock_path(
            &abs.with_file_name("index.lock.bak")
        ));
    }

    use super::*;

    #[test]
    fn retry_safety_looks_past_identity_options() {
        assert!(retry_safe(&["commit", "-m", "x"]));
        assert!(retry_safe(&[
            "-c",
            "user.name=CA",
            "-c",
            "user.email=ca@x",
            "commit",
            "-m",
            "x"
        ]));
        assert!(retry_safe(&["reset", "--hard", "-q", "HEAD"]));
        assert!(!retry_safe(&["worktree", "add", "-b", "b", "p", "c"]));
        assert!(!retry_safe(&["-c", "user.name=CA", "branch", "-D", "b"]));
        assert!(!retry_safe(&["-c"]));
        assert!(!retry_safe(&[]));
    }
}
