use axum::Json;
use ca_core::CoreError;
use ca_core::engine::Engine;
use ca_core::engine::prompts::{DEFAULT_PLAN_TEMPLATE, DEFAULT_SUBTASKS_TEMPLATE};
use ca_core::engine::settings::Settings;

use super::Body;
use super::types::{PromptDefaults, SettingsResponse};
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
