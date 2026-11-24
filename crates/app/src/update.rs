//! Updates from GitHub Releases (`tauri-plugin-updater`, `latest.json` of the newest release).
//!
//! A few seconds after launch the app checks once. If a newer version exists it asks; nothing
//! downloads or installs without a click, because the restart stops running tasks (they are left
//! `interrupted`, as on quit, and Resume continues them). Updates are verified against the public
//! key in `tauri.conf.json`; the release workflow signs them.
//!
//! Only stable releases are offered: the endpoint is GitHub's "latest" release, which skips
//! pre-releases. An installed pre-release is offered the next stable version.
//!
//! A version whose install failed is not offered again (`update-failed` in the app data folder),
//! so a launch from a read-only place (the mounted DMG, a root-owned AppImage) does not ask on
//! every start. Debug builds and the smoke test never check.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::Quit;
use crate::server::Server;

const FIRST_CHECK: Duration = Duration::from_secs(5);
/// For the check and for the download (about 15 MB); a stalled download gives up.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

pub fn check_later(app: &AppHandle) {
    if cfg!(debug_assertions) || crate::smoke::requested() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        let found = match app.updater_builder().timeout(NETWORK_TIMEOUT).build() {
            Ok(updater) => updater.check().await,
            Err(e) => Err(e),
        };
        match found {
            Ok(Some(update)) if failed_before(&app).as_deref() == Some(&update.version) => {
                log::info!(
                    "update {} failed to install before; not offered",
                    update.version
                );
            }
            Ok(Some(update)) => offer(&app, update).await,
            Ok(None) => log::info!("no update available"),
            Err(e) => log::warn!("update check failed: {e}"),
        }
    });
}

async fn offer(app: &AppHandle, update: Update) {
    log::info!("update {} available", update.version);
    let message = format!(
        "Code-Automata {} is available (you have {}). Install it and restart now?\n\n\
         Tasks that are running then stop where they are; resume them after the restart.",
        update.version, update.current_version
    );
    if !ask(app, message).await {
        return;
    }
    // Quitting stays possible during the download; it simply cancels the update.
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(e) => {
            return error(
                app,
                format!("The update could not be downloaded: {e}"),
                false,
            );
        }
    };
    // From here on this is a quit: a close request meanwhile must not start a second one, and a
    // quit already under way wins.
    if app.state::<Quit>().running.swap(true, Ordering::SeqCst) {
        return;
    }
    log::info!("installing update {}", update.version);
    app.state::<Server>().stop().await;
    app.state::<Quit>().done.store(true, Ordering::SeqCst);
    // On Windows this starts the installer and exits the app.
    match update.install(bytes) {
        Ok(()) => app.restart(),
        Err(e) => {
            remember_failed(app, &update.version);
            // The server is stopped; the restart (on the old version) brings it back.
            error(
                app,
                format!(
                    "Code-Automata {} could not be installed: {e}\n\nThe app restarts on the \
                     current version and will not offer this update again. Download it from the \
                     releases page instead.",
                    update.version
                ),
                true,
            );
        }
    }
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

/// Say why the update failed; with `restart`, restart once the dialog is closed.
fn error(app: &AppHandle, message: String, restart: bool) {
    log::error!("{message}");
    let after = app.clone();
    app.dialog()
        .message(message)
        .title("Update failed")
        .kind(MessageDialogKind::Error)
        .show(move |_| {
            if restart {
                after.restart();
            }
        });
}

fn failed_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("update-failed"))
}

fn failed_before(app: &AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(failed_file(app)?).ok()?;
    Some(text.trim().to_string())
}

fn remember_failed(app: &AppHandle, version: &str) {
    let Some(file) = failed_file(app) else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&file, version) {
        log::warn!("could not record the failed update: {e}");
    }
}
