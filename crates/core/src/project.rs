use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::error::{CoreError, Result, io_at};

/// The line added to `.git/info/exclude`.
const EXCLUDE_LINE: &str = "/.code-automata/";

/// Serialises exclude-file updates within the process, so two concurrent first writes add the line
/// once.
fn exclude_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

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

        // Tell "git could not run" apart from git's own answer.
        let out = crate::git::git_output(path, &["rev-parse", "--show-toplevel"], None)
            .await
            .map_err(|e| invalid(format!("git could not be run: {e}")))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(invalid(if stderr.contains("not a git repository") {
                "the directory is not inside a git repository".into()
            } else {
                format!("git could not read the repository: {}", stderr.trim())
            }));
        }
        let top = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let root = tokio::fs::canonicalize(&top)
            .await
            .map_err(|_| invalid("the git repository root cannot be resolved".into()))?;

        // A task's own worktree is not a project: opening it would nest a second .code-automata.
        if root
            .parent()
            .is_some_and(|p| p.ends_with(Path::new(".code-automata").join("worktrees")))
        {
            return Err(invalid(
                "this is a Code-Automata task worktree; open the main repository instead".into(),
            ));
        }
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
    ///
    /// The line is appended, never rewritten, so a crash cannot lose the user's existing entries,
    /// and the file is read as bytes, so a non-UTF-8 exclude file does not break task creation.
    pub async fn ensure_git_exclude(&self) -> Result<()> {
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
