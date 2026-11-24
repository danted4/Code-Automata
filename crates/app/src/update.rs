//! Updates from GitHub Releases (`tauri-plugin-updater`, `latest.json` of the newest release).
//!
//! A few seconds after launch the app checks once. If a newer version exists it asks; nothing
//! downloads or installs without a click, because the restart stops running tasks (they are left
//! `interrupted`, as on quit, and Resume continues them). Updates are verified against the public
//! key in `tauri.conf.json`; the release workflow signs them.
//!
//! Debug builds and the smoke test never check.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::Quit;
use crate::server::Server;

const FIRST_CHECK: Duration = Duration::from_secs(5);

pub fn check_later(app: &AppHandle) {
    if cfg!(debug_assertions) || crate::smoke::requested() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        let found = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(e) => Err(e),
        };
        match found {
            Ok(Some(update)) => offer(&app, update).await,
            Ok(None) => log::info!("no update available"),
            Err(e) => log::warn!("update check failed: {e}"),
        }
    });
}

async fn offer(app: &AppHandle, update: Update) {
    log::info!("update {} available", update.version);
    let running = app.state::<Server>().running_count().await;
    let mut message = format!(
        "Code-Automata {} is available (you have {}). Install it and restart now?",
        update.version, update.current_version
    );
    if running > 0 {
        message.push_str(&format!(
            "\n\n{running} running task(s) will stop where they are; resume them after the restart."
        ));
    }
    if !ask(app, message).await {
        return;
    }
    // From here on this is a quit: a close request meanwhile must not start a second one.
    if app.state::<Quit>().running.swap(true, Ordering::SeqCst) {
        return;
    }
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(e) => {
            app.state::<Quit>().running.store(false, Ordering::SeqCst);
            return error(app, format!("The update could not be downloaded: {e}"));
        }
    };
    log::info!("installing update {}", update.version);
    app.state::<Server>().stop().await;
    app.state::<Quit>().done.store(true, Ordering::SeqCst);
    // On Windows this starts the installer and exits the app.
    if let Err(e) = update.install(bytes) {
        log::error!("the update could not be installed: {e}");
    }
    // The server is stopped either way; a restart brings it back (on the new version if the
    // install worked).
    app.restart();
}

async fn ask(app: &AppHandle, message: String) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title("Update available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and restart".into(),
            "Later".into(),
        ))
        .show(move |yes| {
            let _ = tx.send(yes);
        });
    rx.await.unwrap_or(false)
}

fn error(app: &AppHandle, message: String) {
    log::error!("{message}");
    app.dialog()
        .message(message)
        .title("Update failed")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}
