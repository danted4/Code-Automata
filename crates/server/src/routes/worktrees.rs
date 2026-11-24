use axum::Json;
use axum::extract::Path;
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

/// Remove an orphaned worktree. A task's own worktree goes only with the task.
pub async fn delete(
    Project(engine): Project,
    Path(id): Path<String>,
) -> Result<Json<DeleteReport>, ApiError> {
    Ok(Json(engine.delete_orphan_worktree(&id).await?))
}
