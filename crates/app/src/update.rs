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
//! A version whose install failed is not offered again at launch (`update-failed` in the app data
//! folder), so a launch from a read-only place (the mounted DMG, a root-owned AppImage) does not
//! ask on every start. Debug builds and the smoke test never check.
//!
//! The launch check can be turned off (`checkUpdatesAtLaunch` in the app settings), and Settings
//! has a "Check for updates" button (`check_for_updates`), which offers even a version that failed
//! before. One check at a time: a click during the launch check (or its question) is told so.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::Quit;
use crate::server::Server;

const FIRST_CHECK: Duration = Duration::from_secs(5);
/// For the check and for the download (about 15 MB); a stalled download gives up.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

/// Set while a check (and the question it may ask) is under way.
static CHECKING: AtomicBool = AtomicBool::new(false);

/// What a manual check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckResult {
    /// No newer version.
    UpToDate,
    /// A newer version was offered (and the user chose Later, or installing failed and said so).
    Offered,
    /// Another check is already under way.
    Busy,
    /// Debug builds never update.
    Unavailable,
}

pub fn check_later(app: &AppHandle) {
    if cfg!(debug_assertions) || crate::smoke::requested() {
        return;
    }
    if !crate::app_settings::load(app).check_updates_at_launch {
        log::info!("update check at launch is off");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        if let Err(e) = check(&app, false).await {
            log::warn!("update check failed: {e}");
        }
    });
}

/// Look for a newer version and offer it. At launch (`manual` false) a version that failed to
/// install before is not offered again; a manual check offers it.
async fn check(app: &AppHandle, manual: bool) -> Result<CheckResult, String> {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return Ok(CheckResult::Busy);
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            CHECKING.store(false, Ordering::SeqCst);
        }
    }
    let _done = Done;
    let found = match app.updater_builder().timeout(NETWORK_TIMEOUT).build() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    match found.map_err(|e| e.to_string())? {
        Some(update) if !manual && failed_before(app).as_deref() == Some(&update.version) => {
            log::info!(
                "update {} failed to install before; not offered",
                update.version
            );
            Ok(CheckResult::UpToDate)
        }
        Some(update) => {
            offer(app, update).await;
            Ok(CheckResult::Offered)
        }
        None => {
            log::info!("no update available");
            Ok(CheckResult::UpToDate)
        }
    }
}

/// Settings' "Check for updates" button.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<CheckResult, String> {
    if cfg!(debug_assertions) {
        return Ok(CheckResult::Unavailable);
    }
    check(&app, true).await
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
