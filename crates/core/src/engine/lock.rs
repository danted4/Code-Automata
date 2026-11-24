//! One engine per project.
//!
//! An exclusive OS lock on `.code-automata/engine.lock` (`File::try_lock`: `flock` on Unix,
//! `LockFileEx` on Windows), held for as long as the engine lives. The OS drops it when the
//! process exits, crash included, so a stale lock can never block a restart.
//!
//! The owner's pid and boot id go in `engine.owner` next to it, for the error shown to a second
//! window. A separate file because Windows locks are mandatory: nobody else can read a locked file.

use crate::error::{CoreError, Result, io_at};
use crate::project::ProjectDir;

#[derive(Debug)]
pub struct ProjectLock {
    /// Locked; closing it releases the lock.
    _file: std::fs::File,
}

impl ProjectLock {
    pub async fn acquire(project: &ProjectDir, boot_id: &str) -> Result<ProjectLock> {
        project.ensure_git_exclude().await?;
        let dir = project.state_dir();
        tokio::fs::create_dir_all(&dir).await.map_err(io_at(&dir))?;
        let path = dir.join("engine.lock");
        let boot_id = boot_id.to_string();
        tokio::task::spawn_blocking(move || Self::acquire_blocking(&path, &boot_id))
            .await
            .map_err(|e| CoreError::Io {
                path: std::path::PathBuf::new(),
                source: std::io::Error::other(e),
            })?
    }

    fn acquire_blocking(path: &std::path::Path, boot_id: &str) -> Result<ProjectLock> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(io_at(path))?;

        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                let holder = std::fs::read_to_string(owner_path(path))
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                // Empty: the holder has just taken the lock and not yet said who it is. (A
                // line from an earlier owner can show for that same instant.)
                return Err(CoreError::ProjectLocked {
                    holder: if holder.is_empty() {
                        "a window that is just starting".into()
                    } else {
                        holder
                    },
                });
            }
            // Anything but "held by someone else" (a network share without locking, for example)
            // is a real error.
            Err(std::fs::TryLockError::Error(source)) => {
                return Err(CoreError::Io {
                    path: path.to_path_buf(),
                    source,
                });
            }
        }
        // Through a temp file, so a second window never reads a half-written line.
        let owner = owner_path(path);
        let tmp = owner.with_file_name(format!("engine.owner.{}.tmp", std::process::id()));
        std::fs::write(&tmp, format!("pid {} boot {boot_id}\n", std::process::id()))
            .and_then(|()| std::fs::rename(&tmp, &owner))
            .map_err(io_at(&owner))?;
        Ok(ProjectLock { _file: file })
    }
}

fn owner_path(lock: &std::path::Path) -> std::path::PathBuf {
    lock.with_file_name("engine.owner")
}
