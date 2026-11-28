use axum::Json;
use ca_core::CoreError;
use ca_core::agent::mcp::{McpCandidate, import_candidates};
use ca_core::engine::Engine;
use ca_core::engine::MemoryView;
use ca_core::engine::prompts::{DEFAULT_PLAN_TEMPLATE, DEFAULT_SUBTASKS_TEMPLATE};
use ca_core::engine::settings::Settings;

use super::Body;
use super::types::{PromptDefaults, SaveMemoryRequest, SettingsResponse};
use crate::error::ApiError;
use crate::state::Project;

async fn response(engine: &Engine) -> Json<SettingsResponse> {
    Json(SettingsResponse {
        settings: engine.settings(),
        prompt_defaults: PromptDefaults {
            plan: DEFAULT_PLAN_TEMPLATE.to_string(),
            subtasks: DEFAULT_SUBTASKS_TEMPLATE.to_string(),
        },
        repo_checks: engine.repo_checks().await,
    })
}

/// MCP servers already configured on this computer or in the project, for the settings' Import.
/// Nothing is copied into the settings until the user saves them.
pub async fn mcp_import(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
    Project(engine): Project,
) -> Json<Vec<McpCandidate>> {
    let project = engine.project();
    let repos: Vec<(String, std::path::PathBuf)> = project
        .repos()
        .iter()
        .map(|r| (r.name.clone(), r.path.clone()))
        .collect();
    let home = state.config.bins.home().map(std::path::Path::to_path_buf);
    let root = project.root().to_path_buf();
    let found =
        tokio::task::spawn_blocking(move || import_candidates(home.as_deref(), &root, &repos))
            .await
            .unwrap_or_default();
    Json(found)
}

/// The project memory.
pub async fn memory(Project(engine): Project) -> Result<Json<MemoryView>, ApiError> {
    Ok(Json(engine.memory().await?))
}

/// Replace the project memory with the user's edit.
pub async fn save_memory(
    Project(engine): Project,
    Body(req): Body<SaveMemoryRequest>,
) -> Result<Json<MemoryView>, ApiError> {
    // A changed file is a conflict (409), too large a text a bad request (400).
    Ok(Json(engine.save_memory(&req.text, &req.base).await?))
}

pub async fn get(Project(engine): Project) -> Json<SettingsResponse> {
    response(&engine).await
}

/// Replace the project's settings. A value the engine refuses is a 400 with the reason.
pub async fn put(
    Project(engine): Project,
    Body(settings): Body<Settings>,
) -> Result<Json<SettingsResponse>, ApiError> {
    match engine.save_settings(settings).await {
        Ok(()) => Ok(response(&engine).await),
        Err(CoreError::Invalid(reason)) => Err(ApiError::bad_request(reason)),
        Err(e) => Err(e.into()),
    }
}
