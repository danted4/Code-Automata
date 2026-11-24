use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};

/// The project the user opened. Can only be built from an absolute, existing directory inside a git
/// repository; there is no fallback to the current directory (2.2.4's `getProjectDir` silently used
/// `process.cwd()` and so could act on the wrong repository).
///
/// `root` is the folder the user picked; task files live under it, as in 2.2.4. `repo_root` is the
/// top of its git repository; worktrees live under that, also as in 2.2.4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDir {
    root: PathBuf,
    repo_root: PathBuf,
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
        let root = tokio::fs::canonicalize(path)
            .await
            .map_err(|_| invalid("the path cannot be resolved"))?;
        let top = crate::git::run_git(&root, &["rev-parse", "--show-toplevel"])
            .await
            .map_err(|_| invalid("the directory is not inside a git repository"))?;
        let repo_root = tokio::fs::canonicalize(&top)
            .await
            .map_err(|_| invalid("the git repository root cannot be resolved"))?;

        Ok(ProjectDir { root, repo_root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn repo_root(&self) -> &Path {
        &self.repo_root
    }

    /// `<root>/.code-automata`
    pub fn state_dir(&self) -> PathBuf {
        self.root.join(".code-automata")
    }

    /// `<root>/.code-automata/tasks`
    pub fn tasks_dir(&self) -> PathBuf {
        self.state_dir().join("tasks")
    }

    /// `<repo_root>/.code-automata/worktrees`
    pub fn worktrees_dir(&self) -> PathBuf {
        self.repo_root.join(".code-automata").join("worktrees")
    }
}
