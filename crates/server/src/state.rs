use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use ca_core::ProjectDir;
use ca_core::agent::Binaries;
use ca_core::engine::Engine;
use tokio::sync::{Mutex, OnceCell, watch};

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
    /// The scenario a mock task plays when it names none (the UI has no field for one).
    pub mock_scenario: Option<PathBuf>,
    /// Where the agent CLIs are.
    pub bins: Binaries,
    /// Page origins allowed to call the API cross-origin, exactly as browsers send them (the
    /// desktop app's `tauri://localhost`). Empty for `ca-server`.
    pub allowed_origins: Vec<String>,
}

pub struct AppState {
    pub(crate) config: Config,
    /// Engines by repository root. Each slot opens once; the map lock is held only to find the
    /// slot, so opening one project never holds up requests for another.
    engines: Mutex<HashMap<PathBuf, Arc<OnceCell<Arc<Engine>>>>>,
    closing: watch::Sender<bool>,
}

impl AppState {
    pub fn new(config: Config) -> Arc<AppState> {
        Arc::new(AppState {
            config,
            engines: Mutex::new(HashMap::new()),
            closing: watch::channel(false).0,
        })
    }

    /// The engine for the repository at or above `path`, opening it on first use.
    ///
    /// A request that names a repository root already open (what the UI sends once a project is
    /// open) costs one map lookup. Any other path is resolved with `git` every time, so a
    /// repository created later inside a folder is seen at once.
    pub async fn engine(&self, path: &Path) -> Result<Arc<Engine>, ApiError> {
        if *self.closing.borrow() {
            return Err(ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "closing",
                "the app is closing",
            ));
        }
        if !path.is_absolute() {
            return Err(ApiError::bad_request("the project path must be absolute"));
        }
        let open = self
            .engines
            .lock()
            .await
            .get(path)
            .and_then(|slot| slot.get().cloned());
        if let Some(engine) = open {
            return Ok(engine);
        }
        let project = ProjectDir::open(path).await?;
        let root = project.root().to_path_buf();
        let slot = self
            .engines
            .lock()
            .await
            .entry(root)
            .or_insert_with(|| Arc::new(OnceCell::new()))
            .clone();
        // Two first requests for one project: one opens it, the other waits for that. A failed
        // open leaves the slot empty for the next request to try again.
        let bins = self.config.bins.clone();
        let engine = slot
            .get_or_try_init(|| async move { Engine::open(project, bins).await.map(Arc::new) })
            .await?;
        if *self.closing.borrow() {
            // Opened while the server began to close, after shutdown_engines took its list.
            engine.shutdown().await;
            return Err(ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "closing",
                "the app is closing",
            ));
        }
        Ok(engine.clone())
    }

    /// The repository roots of the projects opened so far.
    pub async fn open_roots(&self) -> Vec<PathBuf> {
        self.engines
            .lock()
            .await
            .iter()
            .filter(|(_, slot)| slot.initialized())
            .map(|(root, _)| root.clone())
            .collect()
    }

    /// How many tasks are running across every open project.
    pub async fn running_count(&self) -> usize {
        self.engines
            .lock()
            .await
            .values()
            .filter_map(|slot| slot.get())
            .map(|engine| engine.running_count())
            .sum()
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
        let engines: Vec<Arc<Engine>> = self
            .engines
            .lock()
            .await
            .values()
            .filter_map(|slot| slot.get().cloned())
            .collect();
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
