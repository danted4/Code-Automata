use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};

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
}
