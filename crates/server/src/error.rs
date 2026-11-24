use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use ca_core::CoreError;
use serde_json::json;

/// An error as the UI receives it: an HTTP status, a stable `code` and a message for the user.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }
}

impl From<CoreError> for ApiError {
    fn from(e: CoreError) -> Self {
        let message = e.to_string();
        let (status, code) = match &e {
            CoreError::TaskNotFound(_) | CoreError::NotFound(_) => {
                (StatusCode::NOT_FOUND, "not_found")
            }
            CoreError::Transition { .. } => (StatusCode::CONFLICT, "invalid_move"),
            CoreError::ProjectLocked { .. } => (StatusCode::CONFLICT, "project_locked"),
            // A command that does not fit the task's current state.
            CoreError::Invalid(_) => (StatusCode::CONFLICT, "conflict"),
            CoreError::TaskExists(_) => (StatusCode::CONFLICT, "conflict"),
            CoreError::Patch(_) | CoreError::InvalidTaskId(_) => {
                (StatusCode::BAD_REQUEST, "bad_request")
            }
            CoreError::InvalidProject { .. } => (StatusCode::BAD_REQUEST, "invalid_project"),
            CoreError::Corrupt { .. }
            | CoreError::UnsupportedSchema { .. }
            | CoreError::IdMismatch { .. } => (StatusCode::INTERNAL_SERVER_ERROR, "corrupt_task"),
            CoreError::Io { .. } | CoreError::Git { .. } => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
        };
        ApiError::new(status, code, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": self.message, "code": self.code })),
        )
            .into_response()
    }
}
