//! The task store: the only code that writes task files.
//!
//! * Reads never write. Loading a v1 file migrates it in memory only.
//! * Every change goes through [`TaskStore::update`], which holds a per-task lock across
//!   load → change → validate → write, so concurrent writers cannot lose each other's changes
//!   (2.2.4 did unlocked load-mutate-save from several places).
//! * Files are written to a temp file, flushed to disk, then renamed over the old one, so a crash
//!   leaves either the old file or the new one, never a half-written file.
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
use crate::migrate::migrate;
use crate::project::ProjectDir;
use crate::task::{Phase, SCHEMA_VERSION, Task};
use crate::transitions::{Mover, apply_patch, check_move};
use crate::util::{now_ms, random_base36, unique_u64, validate_task_id};

/// A task file that could not be read during [`TaskStore::list`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkippedFile {
    pub path: PathBuf,
    pub error: String,
}

#[derive(Debug, Clone, Default)]
pub struct TaskList {
    /// Newest first, as 2.2.4 sorted them.
    pub tasks: Vec<Task>,
    /// Corrupt or unreadable files, reported instead of failing the whole list.
    pub skipped: Vec<SkippedFile>,
}

/// Fields for a new task. Everything else starts at its default.
#[derive(Debug, Clone, Default)]
pub struct NewTask {
    pub title: String,
    pub description: String,
    pub cli_tool: Option<String>,
    pub cli_config: Option<Map<String, Value>>,
    pub requires_human_review: bool,
    pub metadata: Option<crate::task::TaskMetadata>,
}

#[derive(Debug)]
pub struct TaskStore {
    tasks_dir: PathBuf,
    plan_path: PathBuf,
    locks: StdMutex<HashMap<String, Arc<Mutex<()>>>>,
    aggregate: Mutex<()>,
}

impl TaskStore {
    pub fn new(project: &ProjectDir) -> Self {
        TaskStore {
            tasks_dir: project.tasks_dir(),
            plan_path: project.state_dir().join("implementation_plan.json"),
            locks: StdMutex::new(HashMap::new()),
            aggregate: Mutex::new(()),
        }
    }

    fn file_for(&self, id: &str) -> Result<PathBuf> {
        validate_task_id(id)?;
        Ok(self.tasks_dir.join(format!("{id}.json")))
    }

    fn lock_for(&self, id: &str) -> Arc<Mutex<()>> {
        let mut locks = self
            .locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks.entry(id.to_string()).or_default().clone()
    }

    /// Load one task, migrated to v2 in memory. `Ok(None)` if there is no such file.
    pub async fn load(&self, id: &str) -> Result<Option<Task>> {
        let path = self.file_for(id)?;
        read_task(&path).await
    }

    /// All tasks, newest first. Unreadable files are listed in `skipped`, not fatal.
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
            if name.starts_with('.') || !name.ends_with(".json") {
                continue;
            }
            let path = entry.path();
            match read_task(&path).await {
                Ok(Some(task)) => out.tasks.push(task),
                Ok(None) => {} // deleted between readdir and read
                Err(e) => out.skipped.push(SkippedFile {
                    path,
                    error: e.to_string(),
                }),
            }
        }
        out.tasks.sort_by_key(|t| std::cmp::Reverse(t.created_at));
        Ok(out)
    }

    /// Create a task with a fresh `task-<ms>-<5 chars>` id.
    pub async fn create(&self, new: NewTask) -> Result<Task> {
        let id = format!("task-{}-{}", now_ms(), random_base36(5));
        let mut task = Task::new(id, new.title, new.description);
        task.cli_tool = new.cli_tool;
        task.cli_config = new.cli_config;
        task.requires_human_review = Some(new.requires_human_review);
        if let Some(metadata) = new.metadata {
            task.metadata = metadata;
        }
        self.insert(task).await
    }

    /// Store a task built elsewhere. Fails if a task with that id exists.
    pub async fn insert(&self, mut task: Task) -> Result<Task> {
        let path = self.file_for(&task.id)?;
        let lock = self.lock_for(&task.id);
        let _guard = lock.lock().await;
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return Err(CoreError::TaskExists(task.id));
        }
        task.normalize();
        task.validate()?;
        write_json_atomic(&path, &task).await?;
        drop(_guard);
        self.refresh_aggregate().await;
        Ok(task)
    }

    /// The single way to change a task: `change` runs under the task's lock on a fresh copy, and the
    /// result is normalised, validated and written atomically. If `change` or validation fails,
    /// nothing is written.
    pub async fn update<F>(&self, id: &str, change: F) -> Result<Task>
    where
        F: FnOnce(&mut Task) -> Result<()>,
    {
        let path = self.file_for(id)?;
        let lock = self.lock_for(id);
        let guard = lock.lock().await;
        let mut task = read_task(&path)
            .await?
            .ok_or_else(|| CoreError::TaskNotFound(id.to_string()))?;
        change(&mut task)?;
        if task.id != id {
            return Err(CoreError::Invalid("a task's id cannot change".into()));
        }
        task.updated_at = now_ms();
        task.normalize();
        task.validate()?;
        write_json_atomic(&path, &task).await?;
        drop(guard);
        self.refresh_aggregate().await;
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

    /// Delete a task file. Returns false if it did not exist.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let path = self.file_for(id)?;
        let lock = self.lock_for(id);
        let guard = lock.lock().await;
        let existed = match tokio::fs::remove_file(&path).await {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(CoreError::Io { path, source: e }),
        };
        drop(guard);
        if existed {
            self.refresh_aggregate().await;
        }
        Ok(existed)
    }

    /// Rewrite `implementation_plan.json`, the per-phase summary 2.2.4 kept for compatibility.
    /// Best effort, as in 2.2.4: the task file is already saved, so a failure here is not an error.
    async fn refresh_aggregate(&self) {
        let _guard = self.aggregate.lock().await;
        let Ok(list) = self.list().await else {
            return;
        };
        let phases: Vec<Value> = Phase::ALL
            .iter()
            .map(|phase| {
                let tasks: Vec<Value> = list
                    .tasks
                    .iter()
                    .filter(|t| t.phase == *phase)
                    .map(|t| {
                        serde_json::json!({
                            "id": t.id,
                            "title": t.title,
                            "status": t.status,
                            "subtasks": t.subtasks.len(),
                            "assignedAgent": t.assigned_agent,
                        })
                    })
                    .collect();
                serde_json::json!({ "name": phase.as_str(), "tasks": tasks })
            })
            .collect();
        let plan = serde_json::json!({
            "version": "1.0",
            "updated": crate::util::iso8601(now_ms()),
            "totalTasks": list.tasks.len(),
            "phases": phases,
        });
        let _ = write_json_atomic(&self.plan_path, &plan).await;
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
    let mut task: Task = serde_json::from_slice(&bytes).map_err(|source| CoreError::Corrupt {
        path: path.to_path_buf(),
        source,
    })?;
    if task.schema_version > SCHEMA_VERSION {
        // Saving would silently downgrade it; refuse to load instead.
        return Err(CoreError::NewerSchema {
            path: path.to_path_buf(),
            found: task.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    migrate(&mut task);
    Ok(Some(task))
}

/// Write pretty JSON to a hidden temp file next to `path`, flush it to disk, then rename it over
/// `path`. The temp name starts with '.' and does not end in `.json`, so `list` never reads it.
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
