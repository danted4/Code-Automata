//! The Code-Automata desktop app: the UI (`ui/dist`) in a Tauri window, with the server
//! (`ca_server`) running in this process.
//!
//! * The page is told where the server is, and its launch token, by an initialization script
//!   that sets `window.__CODE_AUTOMATA__` before any of the UI's code runs.
//! * The page calls the server cross-origin; the server allows CORS for the app's own origin
//!   only. Every request still needs the token.
//! * Desktop-only actions (`ui/src/lib/native.ts`) are the commands in [`native`]. The page has no
//!   other Tauri permission.
//! * Quitting while tasks run asks first, then stops every engine, leaving those runs
//!   `interrupted` for Resume.
//! * A release build checks GitHub Releases for an update once after launch and offers it
//!   (`update.rs`).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_settings;
mod editors;
mod native;
mod paths;
mod server;
mod smoke;
mod terminals;
mod update;

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::server::Server;

/// The quit sequence runs once; `done` lets the final exit through.
#[derive(Default)]
pub(crate) struct Quit {
    pub(crate) running: AtomicBool,
    pub(crate) done: AtomicBool,
    code: AtomicI32,
}

fn main() {
    let app = tauri::Builder::default()
        // First, so a second launch hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("code-automata".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stderr),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Quit::default())
        .manage(update::UpdateWatch::default())
        .invoke_handler(tauri::generate_handler![
            native::pick_folder,
            native::pick_file,
            native::available_editors,
            native::path_exists,
            native::open_in_editor,
            native::reveal_folder,
            native::available_terminals,
            native::open_in_terminal,
            app_settings::get_app_settings,
            app_settings::set_app_settings,
            update::check_for_updates,
            update::watch_updates,
            smoke::smoke_report,
        ])
        .setup(|app| {
            log::info!("Code-Automata {} starting", env!("CARGO_PKG_VERSION"));
            let server = Server::start(app.handle().clone())?;
            let mut script = format!(
                "window.__CODE_AUTOMATA__ = Object.freeze({{ baseUrl: {}, token: {} }});",
                serde_json::to_string(&server.base_url)?,
                serde_json::to_string(&server.token)?,
            );
            let smoke = smoke::requested();
            if smoke {
                script.push_str(&smoke::prepare()?);
            }
            app.manage(server);

            let handle = app.handle().clone();
            let links = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Code-Automata")
                .inner_size(1440.0, 920.0)
                .min_inner_size(960.0, 640.0)
                .initialization_script(script)
                .on_navigation(move |url| {
                    if is_app_page(url) {
                        return true;
                    }
                    open_outside(&handle, url);
                    false
                })
                .on_new_window(move |url, _features| {
                    open_outside(&links, &url);
                    NewWindowResponse::Deny
                })
                .build()?;
            update::check_later(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                request_quit(window.app_handle(), 0, true);
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Code-Automata could not start: {e}");
            std::process::exit(1);
        });

    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event
            && !app.state::<Quit>().done.load(Ordering::SeqCst)
        {
            api.prevent_exit();
            request_quit(app, 0, true);
        }
    });
}

/// Quit: if tasks are running and `ask`, confirm first; then stop the server and its engines
/// (running tasks become `interrupted`) and exit with `code`.
pub(crate) fn request_quit(app: &AppHandle, code: i32, ask: bool) {
    let quit = app.state::<Quit>();
    if quit.running.swap(true, Ordering::SeqCst) {
        return;
    }
    quit.code.store(code, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let server = app.state::<Server>();
        let running = server.running_count().await;
        if ask && running > 0 && !confirm_quit(&app, running).await {
            app.state::<Quit>().running.store(false, Ordering::SeqCst);
            return;
        }
        log::info!("quitting; {running} running task(s) left interrupted");
        server.stop().await;
        smoke::cleanup();
        let quit = app.state::<Quit>();
        quit.done.store(true, Ordering::SeqCst);
        app.exit(quit.code.load(Ordering::SeqCst));
    });
}

/// The app cannot go on (the server could not serve, or stopped on an error): say why, then exit.
pub(crate) fn fatal(app: &AppHandle, message: String) {
    log::error!("{message}");
    if smoke::requested() {
        println!("smoke: FAILED: {message}");
        smoke::cleanup();
        std::process::exit(1);
    }
    let exit = app.clone();
    app.dialog()
        .message(format!("{message}\n\nThe log file has details."))
        .title("Code-Automata cannot continue")
        .kind(MessageDialogKind::Error)
        .show(move |_| {
            exit.state::<Quit>().done.store(true, Ordering::SeqCst);
            exit.exit(1);
        });
}

async fn confirm_quit(app: &AppHandle, running: usize) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tasks = if running == 1 {
        "1 task is".to_string()
    } else {
        format!("{running} tasks are")
    };
    app.dialog()
        .message(format!(
            "{tasks} running. Quitting stops them where they are; resume them next time."
        ))
        .title("Quit Code-Automata?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit".into(),
            "Cancel".into(),
        ))
        .show(move |quit| {
            let _ = tx.send(quit);
        });
    rx.await.unwrap_or(false)
}

/// The app's own pages: Tauri's origin on this OS (`server::APP_ORIGIN`), or Vite's under
/// `cargo tauri dev`. Only this OS's form: `http://tauri.localhost` on macOS or Linux would be
/// whatever listens on local port 80, and must not get the token.
fn is_app_page(url: &Url) -> bool {
    let host = url.host_str();
    let app = if cfg!(windows) {
        url.scheme() == "http" && host == Some("tauri.localhost")
    } else {
        url.scheme() == "tauri" && host == Some("localhost")
    };
    let dev = cfg!(debug_assertions)
        && url.scheme() == "http"
        && host == Some("localhost")
        && url.port() == Some(5173);
    (app && url.port().is_none()) || dev
}

/// Web links (a pull request, a link in a plan) open in the default browser, never in the app.
fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https")
        && let Err(e) = app.opener().open_url(url.as_str(), None::<&str>)
    {
        log::warn!("could not open {url}: {e}");
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn only_the_app_origin_is_shown_in_the_window() {
        let ok = |s: &str| is_app_page(&Url::parse(s).unwrap());
        assert_eq!(ok("tauri://localhost/index.html"), !cfg!(windows));
        assert_eq!(ok("http://tauri.localhost/settings"), cfg!(windows));
        assert!(!ok("https://tauri.localhost/settings"));
        assert!(!ok("http://tauri.localhost:8080/"));
        assert!(!ok("https://github.com/danted4/Code-Automata/pull/1"));
        assert!(!ok("http://127.0.0.1:7878/api/tasks"));
        assert!(!ok("tauri://evil/index.html"));
        assert!(!ok("file:///etc/passwd"));
        assert_eq!(ok("http://localhost:5173/"), cfg!(debug_assertions));
    }

    #[test]
    fn the_server_allows_the_same_origin_the_window_shows() {
        let origin = server::APP_ORIGIN;
        assert!(is_app_page(
            &Url::parse(&format!("{origin}/index.html")).unwrap()
        ));
    }
}
