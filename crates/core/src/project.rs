use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result, io_at};

/// The line added to `.git/info/exclude`.
const EXCLUDE_LINE: &str = "/.code-automata/";

/// The project the user opened: always the root of a git repository. Picking a folder inside a
/// repository opens that repository. There is no fallback to the current directory.
///
/// Everything Code-Automata stores lives under `<root>/.code-automata/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDir {
    root: PathBuf,
}

impl ProjectDir {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let invalid = |reason: &str| CoreError::InvalidProject {
            path: path.to_path_buf(),
            reason: reason.to_string(),
        };

        if !path.is_absolute() {
            return Err(invalid("the path must be absolute"));
        }
        let meta = tokio::fs::metadata(path)
            .await
            .map_err(|_| invalid("the directory does not exist or cannot be read"))?;
        if !meta.is_dir() {
            return Err(invalid("the path is not a directory"));
        }
        let top = crate::git::run_git(path, &["rev-parse", "--show-toplevel"])
            .await
            .map_err(|_| invalid("the directory is not inside a git repository"))?;
        let root = tokio::fs::canonicalize(&top)
            .await
            .map_err(|_| invalid("the git repository root cannot be resolved"))?;
        Ok(ProjectDir { root })
    }

    /// The repository root.
    pub fn root(&self) -> &Path {
        &self.root
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
    pub async fn ensure_git_exclude(&self) -> Result<()> {
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
        let existing = match tokio::fs::read_to_string(&path).await {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(CoreError::Io { path, source: e }),
        };
        let covered = existing.lines().map(str::trim).any(|l| {
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
        let mut text = existing;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str("# Code-Automata task state and worktrees\n");
        text.push_str(EXCLUDE_LINE);
        text.push('\n');
        tokio::fs::write(&path, text).await.map_err(io_at(&path))
    }
}
