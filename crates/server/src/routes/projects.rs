use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use ca_core::Provider;
use ca_core::agent::preflight;

use super::Body;
use super::types::{
    ChooseCliRequest, CliPath, OpenProjectRequest, OpenProjectResponse, ProviderInfo,
};
use crate::error::ApiError;
use crate::state::AppState;

/// Open (or find) the project's engine. The UI calls this when the user picks a folder, to show
/// a clear error for a folder that is not a repository or is open in another app.
pub async fn open(
    State(state): State<Arc<AppState>>,
    Body(req): Body<OpenProjectRequest>,
) -> Result<Json<OpenProjectResponse>, ApiError> {
    // Checked on every open, even when the engine is already open: a workspace that gained a
    // folder that is not a repository is refused until it is moved out.
    let project = ca_core::ProjectDir::open(&req.path).await?;
    let engine = state.engine(project.root()).await?;
    Ok(Json(OpenProjectResponse {
        root: project.root().to_path_buf(),
        kind: project.kind(),
        repos: project.repos().iter().map(|r| r.name.clone()).collect(),
        reconcile_problems: engine.reconcile_problems().to_vec(),
    }))
}

/// The agents a task can use, in the order the UI offers them, each with whether it is installed
/// and logged in.
pub async fn providers(State(state): State<Arc<AppState>>) -> Json<Vec<ProviderInfo>> {
    let offered = offered(&state);
    // Each check starts a CLI and may take a second, so they run at once.
    let handles: Vec<_> = offered
        .iter()
        .map(|(provider, _)| {
            let (provider, bins) = (*provider, state.config.bins.clone());
            tokio::spawn(async move { preflight::check(provider, &bins).await })
        })
        .collect();
    let mut providers = Vec::with_capacity(offered.len());
    for ((provider, label), handle) in offered.into_iter().zip(handles) {
        let preflight = match handle.await {
            Ok(report) => report,
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        };
        providers.push(ProviderInfo {
            provider,
            label: label.to_string(),
            preflight,
        });
    }
    Json(providers)
}

/// The agents offered, in the order the UI shows them.
fn offered(state: &AppState) -> Vec<(Provider, &'static str)> {
    let mut offered: Vec<(Provider, &'static str)> = ca_core::agent::APP_PROVIDERS
        .iter()
        .map(|p| (*p, ca_core::agent::provider_label(*p)))
        .collect();
    if state.config.allow_mock {
        offered.push((Provider::Mock, "Mock (tests)"));
    }
    offered
}

/// The CLI file chosen for each agent whose file can be chosen (all but the mock agent).
pub async fn cli_paths(State(state): State<Arc<AppState>>) -> Json<Vec<CliPath>> {
    let chosen = state.config.bins.chosen_paths();
    Json(
        offered(&state)
            .into_iter()
            .filter(|(provider, _)| *provider != Provider::Mock)
            .map(|(provider, label)| CliPath {
                provider,
                label: label.to_string(),
                path: chosen.get(&provider).cloned(),
            })
            .collect(),
    )
}

/// Choose an agent's CLI file (or go back to finding it), then check the agent again so the UI
/// shows the result at once.
pub async fn choose_cli(
    State(state): State<Arc<AppState>>,
    Path(provider): Path<String>,
    Body(req): Body<ChooseCliRequest>,
) -> Result<Json<ProviderInfo>, ApiError> {
    // Parsed here, not by axum, so an unknown name gets the API's JSON error.
    let provider: Provider = serde_json::from_value(serde_json::Value::String(provider))
        .map_err(|_| ApiError::bad_request("no such agent"))?;
    let label = offered(&state)
        .into_iter()
        .find(|(p, _)| *p == provider && *p != Provider::Mock)
        .map(|(_, label)| label)
        .ok_or_else(|| ApiError::bad_request("this agent's file cannot be chosen"))?;
    let bins = &state.config.bins;
    bins.choose(provider, req.path).await.map_err(|e| match e {
        // A file that is not a usable CLI is a bad request, not a state conflict.
        ca_core::CoreError::Invalid(message) => ApiError::bad_request(message),
        other => other.into(),
    })?;
    Ok(Json(ProviderInfo {
        provider,
        label: label.to_string(),
        preflight: preflight::check(provider, bins).await,
    }))
}
