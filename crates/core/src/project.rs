use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::error::{CoreError, Result, io_at};
use crate::util::ROOT_REPO;

/// The line added to `.git/info/exclude`.
const EXCLUDE_LINE: &str = "/.code-automata/";

/// Serialises exclude-file updates within the process, so two concurrent first writes add the line
/// once.
fn exclude_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// What kind of folder a project is.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectKind {
    /// The root of a git repository: its one repository is [`ROOT_REPO`].
    Repo,
    /// A folder in no repository whose every non-hidden subfolder is a repository root.
    Workspace,
}

/// One repository of a project: its key ([`ROOT_REPO`] for a repository project, else the
/// subfolder's name) and its main checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub name: String,
    pub path: PathBuf,
}

/// The project the user opened: the root of a git repository, or a workspace (a folder outside any
/// repository whose every non-hidden direct subfolder is a repository root). A folder inside a
/// repository that is not its root is refused, as is anything inside Code-Automata's own worktrees.
/// There is no fallback to the current directory.
///
/// Everything Code-Automata stores lives under `<root>/.code-automata/`. A workspace's
/// repositories are found at open and never stored; tasks record the ones they use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDir {
    root: PathBuf,
    kind: ProjectKind,
    repos: Vec<RepoRef>,
}

impl ProjectDir {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let invalid = |reason: String| CoreError::InvalidProject {
            path: path.to_path_buf(),
            reason,
        };

        if !path.is_absolute() {
            return Err(invalid("the path must be absolute".into()));
        }
        let meta = tokio::fs::metadata(path)
            .await
            .map_err(|_| invalid("the directory does not exist or cannot be read".into()))?;
        if !meta.is_dir() {
            return Err(invalid("the path is not a directory".into()));
        }
        let folder = crate::util::canonicalize(path)
            .await
            .map_err(|_| invalid("the directory cannot be resolved".into()))?;

        // A task's worktree (or a workspace task's folder of worktrees) is not a project: opening
        // it would nest a second .code-automata.
        if inside_task_worktrees(&folder) {
            return Err(invalid(
                "this is inside Code-Automata's task worktrees; open the main repository or \
                 workspace instead"
                    .into(),
            ));
        }

        match repo_root(&folder).await.map_err(invalid)? {
            Some(top) if top == folder => Ok(ProjectDir {
                repos: vec![RepoRef {
                    name: ROOT_REPO.to_string(),
                    path: folder.clone(),
                }],
                root: folder,
                kind: ProjectKind::Repo,
            }),
            Some(top) => Err(invalid(format!(
                "this folder is inside the git repository at {}; open the repository root instead",
                top.display()
            ))),
            None => {
                let repos = workspace_repos(&folder).await.map_err(invalid)?;
                Ok(ProjectDir {
                    root: folder,
                    kind: ProjectKind::Workspace,
                    repos,
                })
            }
        }
    }

    /// The project folder: the repository root, or the workspace folder.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn kind(&self) -> ProjectKind {
        self.kind
    }

    pub fn is_workspace(&self) -> bool {
        self.kind == ProjectKind::Workspace
    }

    /// The project's repositories, found at open, sorted by name.
    pub fn repos(&self) -> &[RepoRef] {
        &self.repos
    }

    /// The main checkout of the repository a task file names. A workspace repository that has
    /// since gone still gets its path, so git reports what is missing.
    pub fn repo_path(&self, name: &str) -> Result<PathBuf> {
        crate::util::validate_repo_name(name)?;
        match (self.kind, name == ROOT_REPO) {
            (ProjectKind::Repo, true) => Ok(self.root.clone()),
            (ProjectKind::Workspace, false) => Ok(self.root.join(name)),
            (ProjectKind::Repo, false) => Err(CoreError::Invalid(format!(
                "this project is one repository; {name:?} is not one of its repositories"
            ))),
            (ProjectKind::Workspace, true) => Err(CoreError::Invalid(
                "this project is a workspace; its tasks name each repository".into(),
            )),
        }
    }

    /// `<root>/.code-automata`
    pub fn state_dir(&self) -> PathBuf {
        self.root.join(".code-automata")
    }

    /// `<root>/.code-automata/tasks`: one directory per task.
    pub fn tasks_dir(&self) -> PathBuf {
        self.state_dir().join("tasks")
    }

    /// `<root>/.code-automata/worktrees`
    pub fn worktrees_dir(&self) -> PathBuf {
        self.state_dir().join("worktrees")
    }

    /// Make git ignore `.code-automata/` in this clone by adding it to `info/exclude`, which is
    /// local and never committed, so the user's `.gitignore` is untouched. Idempotent; called before
    /// anything is first written under `.code-automata/`.
    ///
    /// The line is appended, never rewritten, so a crash cannot lose the user's existing entries,
    /// and the file is read as bytes, so a non-UTF-8 exclude file does not break task creation.
    ///
    /// A workspace's `.code-automata/` is in no repository, so there is nothing to exclude.
    pub async fn ensure_git_exclude(&self) -> Result<()> {
        if self.is_workspace() {
            return Ok(());
        }
        let _guard = exclude_lock().lock().await;
        // Ask git, so linked worktrees and custom GIT_DIR layouts resolve correctly.
        let rel =
            crate::git::run_git(&self.root, &["rev-parse", "--git-path", "info/exclude"]).await?;
        let path = {
            let p = PathBuf::from(&rel);
            if p.is_absolute() {
                p
            } else {
                self.root.join(p)
            }
        };
        let existing = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(CoreError::Io { path, source: e }),
        };
        let covered = String::from_utf8_lossy(&existing)
            .lines()
            .map(str::trim)
            .any(|l| {
                matches!(
                    l,
                    "/.code-automata/" | "/.code-automata" | ".code-automata/" | ".code-automata"
                )
            });
        if covered {
            return Ok(());
        }

        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await.map_err(io_at(dir))?;
        }
        let mut addition = String::new();
        if !existing.is_empty() && !existing.ends_with(b"\n") {
            addition.push('\n');
        }
        addition.push_str("# Code-Automata task state and worktrees\n");
        addition.push_str(EXCLUDE_LINE);
        addition.push('\n');
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(io_at(&path))?;
        file.write_all(addition.as_bytes())
            .await
            .map_err(io_at(&path))?;
        file.sync_all().await.map_err(io_at(&path))
    }
}

/// Is `folder` (canonical) inside a `.code-automata/worktrees/` directory?
fn inside_task_worktrees(folder: &Path) -> bool {
    let parts: Vec<_> = folder.components().map(|c| c.as_os_str()).collect();
    parts
        .windows(3)
        .any(|w| w[0] == ".code-automata" && w[1] == "worktrees" && !w[2].is_empty())
}

/// The repository `folder` is in, as git reports it, or `None` when it is in none. Any other git
/// failure is the reason the folder cannot be opened.
async fn repo_root(folder: &Path) -> std::result::Result<Option<PathBuf>, String> {
    let out = crate::git::git_output(folder, &["rev-parse", "--show-toplevel"], None)
        .await
        .map_err(|e| format!("git could not be run: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return if stderr.contains("not a git repository") {
            Ok(None)
        } else {
            Err(format!(
                "git could not read the repository: {}",
                stderr.trim()
            ))
        };
    }
    let top = String::from_utf8_lossy(&out.stdout).trim().to_string();
    crate::util::canonicalize(&top)
        .await
        .map(Some)
        .map_err(|_| "the git repository root cannot be resolved".to_string())
}

/// A workspace's repositories: every non-hidden direct subfolder, each of which must be a
/// repository root. Files are ignored; symlinks are followed.
async fn workspace_repos(folder: &Path) -> std::result::Result<Vec<RepoRef>, String> {
    let unreadable = |e: std::io::Error| format!("the folder cannot be listed: {e}");
    let mut entries = tokio::fs::read_dir(folder).await.map_err(unreadable)?;
    let mut repos = Vec::new();
    let mut not_repos = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(unreadable)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if !tokio::fs::metadata(&path).await.is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let child = crate::util::canonicalize(&path)
            .await
            .unwrap_or_else(|_| path.clone());
        let is_repo = crate::util::validate_repo_name(&name).is_ok()
            && matches!(repo_root(&child).await, Ok(Some(top)) if top == child);
        if is_repo {
            repos.push(RepoRef { name, path: child });
        } else {
            not_repos.push(name);
        }
    }
    if !not_repos.is_empty() {
        not_repos.sort();
        return Err(format!(
            "this folder is not a git repository, so it opens as a workspace only if every folder \
             in it is a git repository (hidden folders are ignored). Not repositories: {}. Move \
             them out or make them repositories; tasks already in this folder are safe on disk",
            not_repos.join(", ")
        ));
    }
    if repos.is_empty() {
        return Err(
            "this folder is not a git repository and holds no git repositories".to_string(),
        );
    }
    repos.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(repos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_worktree_paths_are_recognised() {
        let base = std::env::temp_dir().join("ws");
        let wt = base.join(".code-automata").join("worktrees");
        assert!(inside_task_worktrees(&wt.join("task-1")));
        assert!(inside_task_worktrees(&wt.join("task-1").join("api")));
        assert!(!inside_task_worktrees(&wt));
        assert!(!inside_task_worktrees(&base.join(".code-automata")));
        assert!(!inside_task_worktrees(&base.join("api")));
    }
}
