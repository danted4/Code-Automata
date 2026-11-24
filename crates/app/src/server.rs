//! The server, in this process, on a random port of `127.0.0.1`.
//!
//! The port is taken before the window exists, so the page can be told where the server is
//! before it loads. Serving starts once the login shell's `PATH` is known (up to 10 s on a slow
//! shell); requests the page sends before that wait in the listen backlog. Quitting during that
//! wait stops at once.
//!
//! If the server cannot serve, or stops on an error, the app says so in a dialog and exits: a
//! window whose every request fails would only look broken.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use ca_core::agent::Binaries;
use ca_server::{AppState, Config};
use tauri::AppHandle;
use tokio::sync::{SetOnce, oneshot};

/// The origin the app's own page is served from.
#[cfg(windows)]
pub const APP_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
pub const APP_ORIGIN: &str = "tauri://localhost";
/// `cargo tauri dev` serves the page from Vite instead.
#[cfg(debug_assertions)]
pub const DEV_ORIGIN: &str = "http://localhost:5173";

/// What the commands need once the server serves.
#[derive(Clone)]
struct Ready {
    state: Arc<AppState>,
    bins: Binaries,
}

pub struct Server {
    pub base_url: String,
    pub token: String,
    /// Set once serving starts, or with why it could not.
    ready: Arc<SetOnce<Result<Ready, String>>>,
    stopping: Arc<AtomicBool>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    done: tokio::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Server {
    /// Take a port, then resolve `PATH` and serve in the background.
    pub fn start(app: AppHandle) -> std::io::Result<Server> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = ca_server::new_token();
        let ready = Arc::new(SetOnce::new());
        let stopping = Arc::new(AtomicBool::new(false));
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

        let config_token = token.clone();
        let ready_out = ready.clone();
        let stopping_in = stopping.clone();
        let done = tauri::async_runtime::spawn(async move {
            let fail = |message: String| {
                let _ = ready_out.set(Err(message.clone()));
                if !stopping_in.load(Ordering::SeqCst) {
                    crate::fatal(&app, message);
                }
            };
            let started = std::time::Instant::now();
            let mut bins = tokio::select! {
                bins = Binaries::from_login_shell() => bins,
                _ = &mut stop_rx => {
                    let _ = ready_out.set(Err("the app is closing".into()));
                    return;
                }
            };
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
                Err(e) => return fail(format!("The server cannot listen on port {port}: {e}")),
            };
            #[cfg_attr(not(debug_assertions), allow(unused_mut))]
            let mut allowed_origins = vec![APP_ORIGIN.to_string()];
            #[cfg(debug_assertions)]
            allowed_origins.push(DEV_ORIGIN.into());
            let allow_mock = mock.is_some();
            let mock_scenario = mock.and_then(|(_, scenario)| scenario);
            let state = AppState::new(Config {
                token: config_token,
                port,
                allow_mock,
                mock_scenario,
                bins: bins.clone(),
                allowed_origins,
            });
            let _ = ready_out.set(Ok(Ready {
                state: state.clone(),
                bins,
            }));
            let stopped = async {
                let _ = stop_rx.await;
            };
            if let Err(e) = ca_server::serve(listener, state, stopped).await {
                fail(format!("The server stopped: {e}"));
            }
        });
        log::info!("server on 127.0.0.1:{port}");
        Ok(Server {
            base_url: format!("http://127.0.0.1:{port}"),
            token,
            ready,
            stopping,
            stop: Mutex::new(Some(stop_tx)),
            done: tokio::sync::Mutex::new(Some(done)),
        })
    }

    async fn ready(&self) -> Result<Ready, String> {
        self.ready.wait().await.clone()
    }

    /// The server's state, once it serves.
    pub async fn state(&self) -> Result<Arc<AppState>, String> {
        self.ready().await.map(|r| r.state)
    }

    /// The agent search path, once resolved; editors are found on it too.
    pub async fn bins(&self) -> Result<Binaries, String> {
        self.ready().await.map(|r| r.bins)
    }

    /// Tasks running now; 0 before the server serves.
    pub async fn running_count(&self) -> usize {
        match self.ready.get() {
            Some(Ok(ready)) => ready.state.running_count().await,
            _ => 0,
        }
    }

    /// Stop serving and stop every engine; running tasks are left `interrupted`.
    pub async fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
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
