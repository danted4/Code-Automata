//! One engine per project.
//!
//! An exclusive OS lock (`flock`) on `.code-automata/engine.lock`, held for as long as the engine
//! lives. The OS drops it when the process exits, crash included, so a stale lock can never block a
//! restart. The file holds the owner's pid and boot id, for the error shown to a second window.

use std::io::{Seek, Write};

use crate::error::{CoreError, Result, io_at};
use crate::project::ProjectDir;

#[derive(Debug)]
pub struct ProjectLock {
    #[cfg(unix)]
    _lock: nix::fcntl::Flock<std::fs::File>,
    #[cfg(not(unix))]
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

        #[cfg(unix)]
        {
            use nix::fcntl::{Flock, FlockArg};
            let mut lock = match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
                Ok(lock) => lock,
                Err((file, _)) => {
                    let holder = std::io::read_to_string(&file)
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    return Err(CoreError::ProjectLocked {
                        holder: if holder.is_empty() {
                            "unknown process".into()
                        } else {
                            holder
                        },
                    });
                }
            };
            write_owner(&mut lock, path, boot_id)?;
            Ok(ProjectLock { _lock: lock })
        }
        #[cfg(not(unix))]
        {
            // Windows: no cross-process lock yet (Phase 5); the file still records the owner.
            let mut file = file;
            write_owner(&mut file, path, boot_id)?;
            Ok(ProjectLock { _file: file })
        }
    }
}

fn write_owner(file: &mut std::fs::File, path: &std::path::Path, boot_id: &str) -> Result<()> {
    file.set_len(0).map_err(io_at(path))?;
    file.rewind().map_err(io_at(path))?;
    writeln!(file, "pid {} boot {boot_id}", std::process::id()).map_err(io_at(path))?;
    file.sync_all().map_err(io_at(path))
}
