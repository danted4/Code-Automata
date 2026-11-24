use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use ca_core::Provider;
use ca_core::agent::preflight;

use super::Body;
use super::types::{OpenProjectRequest, OpenProjectResponse, ProviderInfo};
use crate::error::ApiError;
use crate::state::AppState;

/// Open (or find) the project's engine. The UI calls this when the user picks a folder, to show
/// a clear error for a folder that is not a repository or is open in another app.
pub async fn open(
    State(state): State<Arc<AppState>>,
    Body(req): Body<OpenProjectRequest>,
) -> Result<Json<OpenProjectResponse>, ApiError> {
    let engine = state.engine(&req.path).await?;
    Ok(Json(OpenProjectResponse {
        root: engine.project().root().to_path_buf(),
        reconcile_problems: engine.reconcile_problems().to_vec(),
    }))
}

/// The agents a task can use, in the order the UI offers them, each with whether it is installed
/// and logged in.
pub async fn providers(State(state): State<Arc<AppState>>) -> Json<Vec<ProviderInfo>> {
    let mut offered = vec![
        (Provider::Claude, "Claude Code"),
        (Provider::Cursor, "Cursor"),
        (Provider::Amp, "Amp"),
    ];
    if state.config.allow_mock {
        offered.push((Provider::Mock, "Mock (tests)"));
    }
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
