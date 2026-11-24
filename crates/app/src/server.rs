//! The server, in this process, on a random port of `127.0.0.1`.
//!
//! The port is taken before the window exists, so the page can be told where the server is
//! before it loads. Serving starts once the login shell's `PATH` is known (up to 10 s on a slow
//! shell); requests the page sends before that wait in the listen backlog.

use std::sync::{Arc, Mutex};

use ca_core::agent::Binaries;
use ca_server::{AppState, Config};
use tokio::sync::{SetOnce, oneshot};

/// Origins the app's own page is served from: `tauri://localhost` on macOS and Linux,
/// `http://tauri.localhost` on Windows.
const APP_ORIGINS: [&str; 2] = ["tauri://localhost", "http://tauri.localhost"];
/// `cargo tauri dev` serves the page from Vite instead.
#[cfg(debug_assertions)]
const DEV_ORIGIN: &str = "http://localhost:5173";

pub struct Server {
    pub base_url: String,
    pub token: String,
    /// Set once serving starts.
    state: Arc<SetOnce<Arc<AppState>>>,
    bins: Arc<SetOnce<Binaries>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    done: tokio::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Server {
    /// Take a port, then resolve `PATH` and serve in the background.
    pub fn start() -> std::io::Result<Server> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = ca_server::new_token();
        let state = Arc::new(SetOnce::new());
        let bins_slot = Arc::new(SetOnce::new());
        let (stop_tx, stop_rx) = oneshot::channel::<()>();

        let config_token = token.clone();
        let state_slot = state.clone();
        let bins_out = bins_slot.clone();
        let done = tauri::async_runtime::spawn(async move {
            let started = std::time::Instant::now();
            let mut bins = Binaries::from_login_shell().await;
            let mock = mock_config();
            if let Some((agent, _)) = &mock {
                bins = bins.with_override(ca_core::Provider::Mock, agent);
            }
            log::info!(
                "PATH for agents ({} ms): {}",
                started.elapsed().as_millis(),
                bins.path_var()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default()
            );
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(l) => l,
                Err(e) => {
                    log::error!("cannot serve on port {port}: {e}");
                    return;
                }
            };
            let mut allowed_origins: Vec<String> = APP_ORIGINS.map(String::from).to_vec();
            #[cfg(debug_assertions)]
            allowed_origins.push(DEV_ORIGIN.into());
            let allow_mock = mock.is_some();
            let mock_scenario = mock.and_then(|(_, scenario)| scenario);
            let app_state = AppState::new(Config {
                token: config_token,
                port,
                allow_mock,
                mock_scenario,
                bins: bins.clone(),
                allowed_origins,
            });
            let _ = bins_out.set(bins);
            let _ = state_slot.set(app_state.clone());
            let stopped = async {
                let _ = stop_rx.await;
            };
            if let Err(e) = ca_server::serve(listener, app_state, stopped).await {
                log::error!("server stopped: {e}");
            }
        });
        log::info!("server on 127.0.0.1:{port}");
        Ok(Server {
            base_url: format!("http://127.0.0.1:{port}"),
            token,
            state,
            bins: bins_slot,
            stop: Mutex::new(Some(stop_tx)),
            done: tokio::sync::Mutex::new(Some(done)),
        })
    }

    /// The server's state, once it serves.
    pub async fn state(&self) -> Arc<AppState> {
        self.state.wait().await.clone()
    }

    /// The agent search path, once resolved; editors are found on it too.
    pub async fn bins(&self) -> Binaries {
        self.bins.wait().await.clone()
    }

    /// Tasks running now; 0 before the server serves.
    pub async fn running_count(&self) -> usize {
        match self.state.get() {
            Some(state) => state.running_count().await,
            None => 0,
        }
    }

    /// Stop serving and stop every engine; running tasks are left `interrupted`.
    pub async fn stop(&self) {
        let stop = self.stop.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
        let done = self.done.lock().await.take();
        if let Some(done) = done {
            let _ = done.await;
        }
    }
}

/// The mock agent and its default scenario, only in a debug build and only when asked for:
/// `CODE_AUTOMATA_MOCK_AGENT` names the `mock-agent` binary, `CODE_AUTOMATA_MOCK_SCENARIO`
/// optionally the scenario. A release build never offers it.
fn mock_config() -> Option<(std::path::PathBuf, Option<std::path::PathBuf>)> {
    #[cfg(debug_assertions)]
    {
        let agent = std::env::var_os("CODE_AUTOMATA_MOCK_AGENT")?;
        let scenario = std::env::var_os("CODE_AUTOMATA_MOCK_SCENARIO").map(Into::into);
        Some((agent.into(), scenario))
    }
    #[cfg(not(debug_assertions))]
    None
}
