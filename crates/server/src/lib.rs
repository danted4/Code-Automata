//! The HTTP server between the UI and the run engine.
//!
//! * Listens on `127.0.0.1` only. Every request needs the per-launch token as
//!   `Authorization: Bearer <token>`, and a `Host` of `127.0.0.1:<port>` or `localhost:<port>`,
//!   so neither another user's process nor a web page (through DNS rebinding) can drive it.
//! * The project is named per request by the `X-Project-Path` header, percent-encoded so any path
//!   survives. One engine per project, opened on first use and kept until the server stops:
//!   tasks in a project the UI is not showing keep running.
//! * JSON bodies, camelCase. Errors are `{ "error": "...", "code": "..." }`.
//! * `GET /api/events` is a Server-Sent Events stream of one project's task changes and agent
//!   output.

mod auth;
mod error;
mod events;
mod routes;
mod state;

use std::future::Future;
use std::sync::Arc;

use axum::Router;
use axum::middleware::from_fn_with_state;

pub use error::ApiError;
pub use events::ServerEvent;
pub use routes::types;
pub use state::{AppState, Config};

/// The whole API, behind the token and Host checks.
pub fn router(state: Arc<AppState>) -> Router {
    routes::api()
        .layer(from_fn_with_state(state.clone(), auth::check))
        .with_state(state)
}

/// Serve until `shutdown` completes, then stop every engine: running tasks are left
/// `interrupted`, as when the app quits.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: Arc<AppState>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let app = router(state.clone());
    let closing = state.clone();
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown.await;
            // Event streams end here; otherwise graceful shutdown would wait for them forever.
            closing.begin_shutdown();
        })
        .await;
    state.shutdown_engines().await;
    result
}

/// A random token for one launch: 32 bytes, hex.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    // The OS random source does not fail on any supported platform; if it ever did, a fixed
    // token would be worse than not starting.
    getrandom::fill(&mut bytes).unwrap_or_else(|e| panic!("no OS random source: {e}"));
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
