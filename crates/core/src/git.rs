//! Git worktrees and checkpoints, shelling out to `git`.
//!
//! Ported from `src/lib/git/worktree.ts`. Differences from 2.2.4:
//!
//! * arguments are passed as an array, never interpolated into a shell string;
//! * a worktree's status is read only if the directory really is a worktree root (2.2.4 ran
//!   `git status` in any directory under `.code-automata/worktrees/`, so a stray folder reported the
//!   main checkout's status);
//! * delete refuses to remove anything outside the worktrees directory;
//! * main-branch detection checks exact refs (2.2.4 matched any branch name containing "main");
//! * new: the base commit of each task branch, checkpoint commits, the diff since the last
//!   checkpoint, and squashing checkpoints for the pull request.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};

use serde::Serialize;

use crate::error::{CoreError, Result, io_at};
use crate::project::ProjectDir;
use crate::util::validate_task_id;

async fn git_output(cwd: &Path, args: &[&str]) -> Result<Output> {
    tokio::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| CoreError::Git {
            args: args.join(" "),
            stderr: format!("could not run git: {e}"),
        })
}

/// Run git and return trimmed stdout, or an error carrying stderr.
pub(crate) async fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = git_output(cwd, args).await?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(CoreError::Git {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    }
}

/// Run git where a non-zero exit is an answer, not an error (for example `diff --quiet`).
async fn git_succeeds(cwd: &Path, args: &[&str]) -> Result<bool> {
    Ok(git_output(cwd, args).await?.status.success())
}

pub async fn git_available() -> bool {
    tokio::process::Command::new("git")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|s| s.success())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub task_id: String,
    pub path: PathBuf,
    pub branch_name: String,
    pub main_repo: PathBuf,
    pub main_branch: String,
    /// Set by `create`; not known for worktrees found by `list`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_dirty: Option<bool>,
}

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
    /// Delete even with uncommitted changes.
    pub force: bool,
    /// Also delete the local branch `code-automata/<task id>`.
    pub delete_branch: bool,
    /// Also delete the branch on `origin`.
    pub delete_remote: bool,
    /// Path reported by `git worktree list`, when it differs from the computed one.
    pub path_override: Option<PathBuf>,
}

/// Non-fatal problems from a delete (a branch that could not be removed, for example).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DeleteReport {
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub total_bytes: u64,
    pub per_worktree: BTreeMap<String, u64>,
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
        let repo = self.project.repo_root();
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
            let reference = format!("refs/heads/{candidate}");
            if git_succeeds(repo, &["show-ref", "--verify", "--quiet", &reference])
                .await
                .unwrap_or(false)
            {
                return candidate.to_string();
            }
        }
        "main".to_string()
    }

    /// Create `.code-automata/worktrees/<id>` on a new branch `code-automata/<id>`, starting from the
    /// main checkout's current HEAD (as 2.2.4 did). The start commit is returned as `base_commit`.
    pub async fn create(&self, task_id: &str) -> Result<WorktreeInfo> {
        let path = self.path_for(task_id)?;
        let repo = self.project.repo_root();
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return Err(CoreError::Git {
                args: "worktree add".into(),
                stderr: format!(
                    "{} already exists; delete it first or use another task id",
                    path.display()
                ),
            });
        }
        let base = self.base_path();
        tokio::fs::create_dir_all(&base)
            .await
            .map_err(io_at(&base))?;

        let base_commit = run_git(repo, &["rev-parse", "HEAD"]).await?;
        let branch = Self::branch_for(task_id);
        let path_str = path.to_string_lossy().to_string();
        run_git(
            repo,
            &["worktree", "add", "-b", &branch, &path_str, &base_commit],
        )
        .await?;

        Ok(WorktreeInfo {
            task_id: task_id.to_string(),
            path: tokio::fs::canonicalize(&path).await.map_err(io_at(&path))?,
            branch_name: branch,
            main_repo: repo.to_path_buf(),
            main_branch: self.main_branch().await,
            base_commit: Some(base_commit),
            is_dirty: Some(false),
        })
    }

    pub async fn status(&self, task_id: &str) -> Result<WorktreeStatus> {
        let path = self.path_for(task_id)?;
        Ok(status_at(&path).await)
    }

    /// Remove a task's worktree, optionally with its local and remote branch.
    pub async fn delete(&self, task_id: &str, opts: DeleteOptions) -> Result<DeleteReport> {
        let computed = self.path_for(task_id)?;
        let path = opts.path_override.clone().unwrap_or(computed);
        self.ensure_inside_base(&path).await?;
        let repo = self.project.repo_root();
        let exists = tokio::fs::try_exists(&path).await.unwrap_or(false);

        // Without an override and with nothing on disk there is nothing to do. With an override the
        // directory may be gone while git still lists it (prunable); removal below cleans that up.
        if !exists && opts.path_override.is_none() {
            return Ok(DeleteReport::default());
        }
        if exists && !opts.force {
            let status = status_at(&path).await;
            if status.has_changes == Some(true) {
                return Err(CoreError::Git {
                    args: "worktree remove".into(),
                    stderr:
                        "the worktree has uncommitted changes; force the delete or commit first"
                            .into(),
                });
            }
        }

        let path_str = path.to_string_lossy().to_string();
        let mut args = vec!["worktree", "remove", path_str.as_str()];
        if opts.force {
            args.push("--force");
        }
        if run_git(repo, &args).await.is_err() {
            // Broken or prunable worktree: remove the directory and let git forget it.
            remove_dir_if_exists(&path).await?;
            run_git(repo, &["worktree", "prune"]).await?;
        }
        remove_dir_if_exists(&path).await?;

        let mut report = DeleteReport::default();
        let branch = Self::branch_for(task_id);
        if opts.delete_branch
            && let Err(e) = run_git(repo, &["branch", "-D", &branch]).await
        {
            report
                .warnings
                .push(format!("could not delete local branch {branch}: {e}"));
        }
        if opts.delete_remote
            && let Err(e) = run_git(repo, &["push", "origin", "--delete", &branch]).await
        {
            let msg = e.to_string();
            // Expected when the branch was never pushed.
            if !msg.contains("remote ref does not exist") {
                report
                    .warnings
                    .push(format!("could not delete remote branch {branch}: {msg}"));
            }
        }
        Ok(report)
    }

    /// Worktrees git knows about under `.code-automata/worktrees/`.
    pub async fn list(&self) -> Result<Vec<WorktreeInfo>> {
        let repo = self.project.repo_root();
        let output = run_git(repo, &["worktree", "list", "--porcelain"]).await?;
        let main_branch = self.main_branch().await;
        let mut found = Vec::new();
        for line in output.lines() {
            let Some(raw) = line.strip_prefix("worktree ") else {
                continue;
            };
            let raw_path = PathBuf::from(raw.trim());
            let normalized = raw.replace('\\', "/");
            if !normalized.contains("/.code-automata/worktrees/") {
                continue;
            }
            let Some(task_id) = raw_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
            else {
                continue;
            };
            let path = if raw_path.is_absolute() {
                raw_path
            } else {
                repo.join(raw_path)
            };
            let is_dirty = status_at(&path).await.has_changes;
            found.push(WorktreeInfo {
                branch_name: Self::branch_for(&task_id),
                task_id,
                path,
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
        let base = tokio::fs::canonicalize(&base).await.unwrap_or(base);
        let resolved = match tokio::fs::canonicalize(path).await {
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
            Err(CoreError::Git {
                args: "worktree remove".into(),
                stderr: format!(
                    "refusing to delete {}: it is not inside {}",
                    path.display(),
                    base.display()
                ),
            })
        }
    }
}

/// Status of the worktree at `path`. Only a directory that is itself a git work tree root counts;
/// otherwise git would walk up and report the main checkout.
pub async fn status_at(path: &Path) -> WorktreeStatus {
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        return WorktreeStatus::default();
    }
    let canonical = tokio::fs::canonicalize(path)
        .await
        .unwrap_or_else(|_| path.to_path_buf());
    let not_worktree = WorktreeStatus {
        exists: true,
        path: Some(canonical.clone()),
        error: Some("directory exists but is not a git worktree".into()),
        ..WorktreeStatus::default()
    };

    let Ok(top) = run_git(&canonical, &["rev-parse", "--show-toplevel"]).await else {
        return not_worktree;
    };
    let top = tokio::fs::canonicalize(&top)
        .await
        .unwrap_or_else(|_| PathBuf::from(top));
    if top != canonical {
        return not_worktree;
    }

    let changes = run_git(&canonical, &["status", "--porcelain"]).await;
    let branch = run_git(&canonical, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    match (changes, branch) {
        (Ok(changes), Ok(branch)) => WorktreeStatus {
            exists: true,
            path: Some(canonical),
            branch_name: Some(branch),
            has_changes: Some(!changes.is_empty()),
            error: None,
        },
        (Err(e), _) | (_, Err(e)) => WorktreeStatus {
            error: Some(e.to_string()),
            ..not_worktree
        },
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// HEAD after the call.
    pub commit: String,
    /// False when there was nothing to commit and HEAD was returned unchanged.
    pub created: bool,
}

/// Uncommitted work in a worktree relative to its last checkpoint (HEAD).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiff {
    /// The checkpoint the diff is against.
    pub base: String,
    /// `git diff HEAD` for tracked files, cut to the size limit.
    pub diff: String,
    /// New files not yet tracked (paths only).
    pub untracked: Vec<String>,
    pub truncated: bool,
}

impl WorkingDiff {
    pub fn is_empty(&self) -> bool {
        self.diff.is_empty() && self.untracked.is_empty()
    }
}

pub async fn head(worktree: &Path) -> Result<String> {
    run_git(worktree, &["rev-parse", "HEAD"]).await
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

/// Commit everything in the worktree as the checkpoint for a finished subtask.
///
/// Hooks are skipped (`--no-verify`, as 2.2.4's PR commit did: worktrees usually lack
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
    let mut args = identity_args(worktree).await;
    args.extend(
        ["commit", "--no-verify", "--no-gpg-sign", "-m", &message]
            .into_iter()
            .map(String::from),
    );
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(worktree, &refs).await?;
    Ok(Checkpoint {
        commit: head(worktree).await?,
        created: true,
    })
}

/// What changed since the last checkpoint, for the prompt of a resumed subtask. The tracked diff is
/// cut at `max_bytes` (on a character boundary). Does not modify the index.
pub async fn diff_since_checkpoint(worktree: &Path, max_bytes: usize) -> Result<WorkingDiff> {
    let base = head(worktree).await?;
    let mut diff = run_git(worktree, &["diff", "--no-color", "--no-ext-diff", "HEAD"]).await?;
    let untracked = run_git(worktree, &["ls-files", "--others", "--exclude-standard"])
        .await?
        .lines()
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();
    let mut truncated = false;
    if diff.len() > max_bytes {
        let mut cut = max_bytes;
        while !diff.is_char_boundary(cut) {
            cut -= 1;
        }
        diff.truncate(cut);
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
/// Returns the new commit, or `None` when there is nothing to squash. Hooks are skipped as for
/// checkpoints; the user's signing setting is respected, since this commit is the one that ships.
pub async fn squash_checkpoints(
    worktree: &Path,
    base_commit: &str,
    message: &str,
) -> Result<Option<String>> {
    run_git(worktree, &["add", "-A"]).await?;
    let ancestor = git_succeeds(
        worktree,
        &["merge-base", "--is-ancestor", base_commit, "HEAD"],
    )
    .await?;
    if !ancestor {
        return Err(CoreError::Git {
            args: "merge-base --is-ancestor".into(),
            stderr: format!("{base_commit} is not an ancestor of HEAD; refusing to squash"),
        });
    }
    let old_head = head(worktree).await?;
    run_git(worktree, &["reset", "--soft", base_commit]).await?;
    if git_succeeds(worktree, &["diff", "--cached", "--quiet"]).await? {
        // Nothing differs from the base; put the branch back where it was.
        run_git(worktree, &["reset", "--soft", &old_head]).await?;
        return Ok(None);
    }
    let mut args = identity_args(worktree).await;
    args.extend(
        ["commit", "--no-verify", "-m", message]
            .into_iter()
            .map(String::from),
    );
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    if let Err(e) = run_git(worktree, &refs).await {
        // Leave the branch exactly as it was (checkpoints intact) rather than rewound to the base.
        let _ = run_git(worktree, &["reset", "--soft", &old_head]).await;
        return Err(e);
    }
    Ok(Some(head(worktree).await?))
}
