//! The task store: the only code that writes task files.
//!
//! Layout: `.code-automata/tasks/<id>/task.json`, with the task's logs beside it in the same
//! directory, so deleting a task removes everything it owns.
//!
//! * Reads never write.
//! * Every change goes through [`TaskStore::update`], which holds a per-task lock across
//!   load → change → validate → write, so concurrent writers cannot lose each other's changes.
//! * Files are written to a temp file, flushed to disk, then renamed over the old one, so a crash
//!   leaves either the old file or the new one, never a half-written file.
//! * A file with another schema version, an unknown key or a bad value is refused, not guessed at.
//!
//! The locks are per process. Two app processes on one project are guarded separately, by the run
//! engine's project lock (Phase 3).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use serde_json::{Map, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::error::{CoreError, Result, io_at};
use crate::project::ProjectDir;
use crate::task::{Phase, SCHEMA, Task};
use crate::transitions::{Mover, apply_patch, check_move};
use crate::util::{now_ms, unique_u64, validate_task_id};

const TASK_FILE: &str = "task.json";

/// A task directory that could not be read during [`TaskStore::list`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkippedFile {
    pub path: PathBuf,
    pub error: String,
}

#[derive(Debug, Clone, Default)]
pub struct TaskList {
    /// Newest first.
    pub tasks: Vec<Task>,
    /// Unreadable task files, reported instead of failing the whole list.
    pub skipped: Vec<SkippedFile>,
}

#[derive(Debug)]
pub struct TaskStore {
    project: ProjectDir,
    tasks_dir: PathBuf,
    locks: StdMutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl TaskStore {
    pub fn new(project: &ProjectDir) -> Self {
        TaskStore {
            project: project.clone(),
            tasks_dir: project.tasks_dir(),
            locks: StdMutex::new(HashMap::new()),
        }
    }

    /// `.code-automata/tasks/<id>`: the task's file and its logs.
    pub fn task_dir(&self, id: &str) -> Result<PathBuf> {
        validate_task_id(id)?;
        Ok(self.tasks_dir.join(id))
    }

    fn file_for(&self, id: &str) -> Result<PathBuf> {
        Ok(self.task_dir(id)?.join(TASK_FILE))
    }

    fn lock_for(&self, id: &str) -> Arc<Mutex<()>> {
        let mut locks = self
            .locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks.entry(id.to_string()).or_default().clone()
    }

    /// Load one task. `Ok(None)` if there is no such task.
    pub async fn load(&self, id: &str) -> Result<Option<Task>> {
        read_task(&self.file_for(id)?).await
    }

    /// All tasks, newest first. Unreadable task files are listed in `skipped`, not fatal.
    pub async fn list(&self) -> Result<TaskList> {
        let mut out = TaskList::default();
        let mut entries = match tokio::fs::read_dir(&self.tasks_dir).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => {
                return Err(CoreError::Io {
                    path: self.tasks_dir.clone(),
                    source: e,
                });
            }
        };
        while let Some(entry) = entries.next_entry().await.map_err(io_at(&self.tasks_dir))? {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().await.is_ok_and(|t| t.is_dir());
            if !is_dir || validate_task_id(&name).is_err() {
                continue;
            }
            let path = entry.path().join(TASK_FILE);
            match read_task(&path).await {
                Ok(Some(task)) if task.id == name => out.tasks.push(task),
                Ok(Some(task)) => out.skipped.push(SkippedFile {
                    path,
                    error: format!("the file's id {:?} does not match its directory", task.id),
                }),
                Ok(None) => {} // a directory without a task file, or deleted meanwhile
                Err(e) => out.skipped.push(SkippedFile {
                    path,
                    error: e.to_string(),
                }),
            }
        }
        out.tasks.sort_by_key(|t| std::cmp::Reverse(t.created_at));
        Ok(out)
    }

    /// Store a new task. Fails if a task with that id exists.
    pub async fn create(&self, task: Task) -> Result<Task> {
        let path = self.file_for(&task.id)?;
        let lock = self.lock_for(&task.id);
        let _guard = lock.lock().await;
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return Err(CoreError::TaskExists(task.id));
        }
        task.validate()?;
        self.project.ensure_git_exclude().await?;
        write_json_atomic(&path, &task).await?;
        Ok(task)
    }

    /// The single way to change a task: `change` runs under the task's lock on a fresh copy, and the
    /// result is validated and written atomically. If `change` or validation fails, nothing is
    /// written.
    pub async fn update<F>(&self, id: &str, change: F) -> Result<Task>
    where
        F: FnOnce(&mut Task) -> Result<()>,
    {
        let path = self.file_for(id)?;
        let lock = self.lock_for(id);
        let _guard = lock.lock().await;
        let mut task = read_task(&path)
            .await?
            .ok_or_else(|| CoreError::TaskNotFound(id.to_string()))?;
        change(&mut task)?;
        if task.id != id {
            return Err(CoreError::Invalid("a task's id cannot change".into()));
        }
        task.updated_at = now_ms();
        task.validate()?;
        write_json_atomic(&path, &task).await?;
        Ok(task)
    }

    /// Apply a UI edit. Only the fields in [`crate::transitions::EDITABLE_FIELDS`] are accepted.
    pub async fn apply_patch(&self, id: &str, patch: &Map<String, Value>) -> Result<Task> {
        self.update(id, |task| apply_patch(task, patch)).await
    }

    /// Move a task to another phase, subject to the phase table and its guards.
    pub async fn move_phase(&self, id: &str, to: Phase, mover: Mover) -> Result<Task> {
        self.update(id, |task| {
            check_move(task, to, mover)?;
            task.phase = to;
            Ok(())
        })
        .await
    }

    /// Delete a task and everything in its directory (logs included). Its worktree is separate;
    /// see `git::Worktrees::delete`. Returns false if there was no such task.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let dir = self.task_dir(id)?;
        let lock = self.lock_for(id);
        let _guard = lock.lock().await;
        match tokio::fs::remove_dir_all(&dir).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(CoreError::Io {
                path: dir,
                source: e,
            }),
        }
    }
}

async fn read_task(path: &Path) -> Result<Option<Task>> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(CoreError::Io {
                path: path.to_path_buf(),
                source: e,
            });
        }
    };
    let corrupt = |source| CoreError::Corrupt {
        path: path.to_path_buf(),
        source,
    };
    // Check the version before the strict parse, so a file in another format gets a clear error
    // rather than "unknown field".
    let value: Value = serde_json::from_slice(&bytes).map_err(corrupt)?;
    match value.get("schema") {
        Some(Value::Number(n)) if n.as_u64() == Some(u64::from(SCHEMA)) => {}
        other => {
            return Err(CoreError::UnsupportedSchema {
                path: path.to_path_buf(),
                found: other.map_or_else(|| "none".to_string(), Value::to_string),
                supported: SCHEMA,
            });
        }
    }
    serde_json::from_value(value).map(Some).map_err(corrupt)
}

/// Write pretty JSON to a hidden temp file next to `path`, flush it to disk, then rename it over
/// `path`. The temp name starts with '.', so it is never read as a task file.
pub(crate) async fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| CoreError::Invalid(format!("{} has no parent", path.display())))?;
    tokio::fs::create_dir_all(dir).await.map_err(io_at(dir))?;

    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| CoreError::Invalid(format!("could not serialise: {e}")))?;
    bytes.push(b'\n');

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{file_name}.{}-{}.tmp",
        std::process::id(),
        unique_u64()
    ));

    let result = async {
        let mut file = tokio::fs::File::create(&tmp).await.map_err(io_at(&tmp))?;
        file.write_all(&bytes).await.map_err(io_at(&tmp))?;
        file.sync_all().await.map_err(io_at(&tmp))?;
        drop(file);
        tokio::fs::rename(&tmp, path).await.map_err(io_at(path))
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}
