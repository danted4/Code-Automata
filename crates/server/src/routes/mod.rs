mod projects;
mod settings;
mod tasks;
pub mod types;
mod worktrees;

use std::sync::Arc;

use axum::Router;
use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::routing::{get, post};
use serde::de::DeserializeOwned;

use crate::error::ApiError;
use crate::events;
use crate::state::AppState;

pub fn api() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/projects/open", post(projects::open))
        .route("/api/providers", get(projects::providers))
        .route("/api/cli-paths", get(projects::cli_paths))
        .route(
            "/api/cli-paths/{provider}",
            axum::routing::put(projects::choose_cli),
        )
        .route("/api/events", get(events::stream))
        .route("/api/tasks", get(tasks::list).post(tasks::create))
        .route(
            "/api/tasks/{id}",
            get(tasks::get).patch(tasks::patch).delete(tasks::delete),
        )
        .route("/api/tasks/{id}/move", post(tasks::move_to))
        .route("/api/tasks/{id}/start", post(tasks::start))
        .route("/api/tasks/{id}/pause", post(tasks::pause))
        .route("/api/tasks/{id}/resume", post(tasks::resume))
        .route("/api/tasks/{id}/answers", post(tasks::answers))
        .route("/api/tasks/{id}/plan", axum::routing::put(tasks::edit_plan))
        .route("/api/tasks/{id}/plan/revise", post(tasks::revise_plan))
        .route("/api/tasks/{id}/plan/approve", post(tasks::approve_plan))
        .route("/api/tasks/{id}/rework", post(tasks::rework))
        .route(
            "/api/tasks/{id}/subtasks/{subtask}/skip",
            post(tasks::skip_subtask),
        )
        .route("/api/tasks/{id}/pull-request", post(tasks::pull_request))
        .route("/api/tasks/{id}/pull-requests", post(tasks::pull_requests))
        .route("/api/tasks/{id}/changes", get(tasks::changes))
        .route("/api/tasks/{id}/runs", get(tasks::runs))
        .route("/api/tasks/{id}/runs/{name}", get(tasks::run_events))
        .route("/api/worktrees", get(worktrees::list))
        .route("/api/worktrees/usage", get(worktrees::usage))
        .route(
            "/api/worktrees/{id}",
            axum::routing::delete(worktrees::delete),
        )
        .route("/api/settings", get(settings::get).put(settings::put))
        .fallback(|| async { ApiError::not_found("no such endpoint") })
}

/// A JSON request body whose rejections are API errors (400 with the reason), not axum's plain
/// text.
pub struct Body<T>(pub T);

impl<T, S> FromRequest<S> for Body<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(axum::Json(value)) => Ok(Body(value)),
            Err(rejection) => Err(ApiError::bad_request(describe(&rejection))),
        }
    }
}

fn describe(rejection: &JsonRejection) -> String {
    match rejection {
        JsonRejection::MissingJsonContentType(_) => "expected a JSON body".into(),
        other => other.body_text(),
    }
}

/// Refuse the mock agent unless the server offers it.
pub(crate) fn check_provider(
    state: &AppState,
    provider: ca_core::Provider,
) -> Result<(), ApiError> {
    if provider == ca_core::Provider::Mock && !state.config.allow_mock {
        return Err(ApiError::bad_request("the mock agent is not available"));
    }
    Ok(())
}
