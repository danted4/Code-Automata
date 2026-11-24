use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use ca_core::ProjectDir;
use ca_core::agent::Binaries;
use ca_core::engine::Engine;
use tokio::sync::{Mutex, watch};

use crate::error::ApiError;

/// How the server was started.
#[derive(Debug, Clone)]
pub struct Config {
    /// Required as `Authorization: Bearer <token>`.
    pub token: String,
    /// The port the server listens on; `Host` must name it.
    pub port: u16,
    /// Offer the scripted mock agent (development and tests only).
    pub allow_mock: bool,
    /// Where the agent CLIs are.
    pub bins: Binaries,
}

pub struct AppState {
    pub(crate) config: Config,
    /// Open engines by repository root.
    engines: Mutex<HashMap<PathBuf, Arc<Engine>>>,
    /// The path a request named, to the repository root it opened (saves a `git` call per request).
    roots: Mutex<HashMap<PathBuf, PathBuf>>,
    closing: watch::Sender<bool>,
}

impl AppState {
    pub fn new(config: Config) -> Arc<AppState> {
        Arc::new(AppState {
            config,
            engines: Mutex::new(HashMap::new()),
            roots: Mutex::new(HashMap::new()),
            closing: watch::channel(false).0,
        })
    }

    /// The engine for the repository at or above `path`, opening it on first use.
    pub async fn engine(&self, path: &Path) -> Result<Arc<Engine>, ApiError> {
        if *self.closing.borrow() {
            return Err(ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "closing",
                "the app is closing",
            ));
        }
        let known_root = self.roots.lock().await.get(path).cloned();
        let root = match known_root {
            Some(root) => root,
            None => {
                let project = ProjectDir::open(path).await?;
                let root = project.root().to_path_buf();
                self.roots
                    .lock()
                    .await
                    .insert(path.to_path_buf(), root.clone());
                root
            }
        };
        // Held across the open, so two first requests for one project cannot both open it.
        let mut engines = self.engines.lock().await;
        if let Some(engine) = engines.get(&root) {
            return Ok(engine.clone());
        }
        let project = ProjectDir::open(&root).await?;
        let engine = Arc::new(Engine::open(project, self.config.bins.clone()).await?);
        engines.insert(root, engine.clone());
        Ok(engine)
    }

    /// Fires once the server starts shutting down.
    pub(crate) fn closing(&self) -> watch::Receiver<bool> {
        self.closing.subscribe()
    }

    /// Refuse new work and end the event streams.
    pub fn begin_shutdown(&self) {
        self.closing.send_replace(true);
    }

    /// Stop every engine; running tasks become `interrupted`.
    pub async fn shutdown_engines(&self) {
        self.begin_shutdown();
        let engines: Vec<Arc<Engine>> = self.engines.lock().await.values().cloned().collect();
        for engine in engines {
            engine.shutdown().await;
        }
    }
}

/// The engine of the project named by the request's `X-Project-Path` header.
pub struct Project(pub Arc<Engine>);

impl FromRequestParts<Arc<AppState>> for Project {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let raw = parts
            .headers
            .get("x-project-path")
            .ok_or_else(|| ApiError::bad_request("the X-Project-Path header is missing"))?;
        let decoded = percent_encoding::percent_decode(raw.as_bytes())
            .decode_utf8()
            .map_err(|_| ApiError::bad_request("X-Project-Path is not valid UTF-8"))?;
        if decoded.is_empty() {
            return Err(ApiError::bad_request("X-Project-Path is empty"));
        }
        Ok(Project(state.engine(Path::new(decoded.as_ref())).await?))
    }
}
