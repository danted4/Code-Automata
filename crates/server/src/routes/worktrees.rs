use axum::Json;
use axum::extract::{Path, Query};
use ca_core::engine::WorktreeEntry;
use ca_core::git::{DeleteReport, DiskUsage};

use crate::error::ApiError;
use crate::state::Project;

pub async fn list(Project(engine): Project) -> Result<Json<Vec<WorktreeEntry>>, ApiError> {
    Ok(Json(engine.worktrees().await?))
}

pub async fn usage(Project(engine): Project) -> Result<Json<DiskUsage>, ApiError> {
    Ok(Json(engine.worktree_usage().await?))
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct DeleteQuery {
    /// Discard uncommitted changes in a done task's worktree (the UI asks first).
    force: bool,
}

/// Remove an orphaned worktree (with its branch) or a done task's (the task and branch stay). Any
/// other task's worktree goes only with the task. `?force=true` lets a done task's worktree with
/// uncommitted changes go.
pub async fn delete(
    Project(engine): Project,
    Path(id): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> Result<Json<DeleteReport>, ApiError> {
    Ok(Json(engine.delete_worktree(&id, q.force).await?))
}
