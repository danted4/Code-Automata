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
//!
//! After "Install and restart" the page shows the download's progress, then that it is installing
//! (`UpdateEvent`, sent through the channel the page gives `watch_updates`). The download is about
//! 15 MB; without it the app looked stuck until the restart.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
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

/// How often the page hears about the download.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// What the page shows while an accepted update downloads and installs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum UpdateEvent {
    /// `total` is None when the server does not say how big the file is.
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    /// Downloaded and verified; the app stops and restarts (on Windows the installer takes over).
    Installing { version: String },
    /// The download or install failed; the app's error dialog says why.
    Failed { version: String },
    /// Downloaded, but a quit was already under way, so the update is dropped (the next check
    /// offers it again).
    Cancelled { version: String },
}

/// The page's channel for `UpdateEvent`s (the latest `watch_updates` call: a reload sends a new
/// one) and the last event, which a new channel is sent first.
#[derive(Default)]
pub struct UpdateWatch(Mutex<Watch<Channel<UpdateEvent>>>);

#[derive(Debug)]
struct Watch<C> {
    channel: Option<C>,
    last: Option<UpdateEvent>,
}

impl<C> Default for Watch<C> {
    fn default() -> Self {
        Self {
            channel: None,
            last: None,
        }
    }
}

impl<C: Clone> Watch<C> {
    /// A new channel replaces the old one; returns the event to send it first, if any.
    fn watch(&mut self, channel: C) -> Option<UpdateEvent> {
        self.channel = Some(channel);
        self.last.clone()
    }

    /// Remember the event; returns the channel to send it to, if the page gave one.
    fn record(&mut self, event: &UpdateEvent) -> Option<C> {
        self.last = Some(event.clone());
        self.channel.clone()
    }
}

/// The page asks to be told about update progress.
#[tauri::command]
pub fn watch_updates(app: AppHandle, on_event: Channel<UpdateEvent>) {
    let replay = match app.state::<UpdateWatch>().0.lock() {
        Ok(mut watch) => watch.watch(on_event.clone()),
        Err(_) => None,
    };
    if let Some(event) = replay {
        send(&on_event, event);
    }
}

fn notify(app: &AppHandle, event: UpdateEvent) {
    let channel = match app.state::<UpdateWatch>().0.lock() {
        Ok(mut watch) => watch.record(&event),
        Err(_) => None,
    };
    if let Some(channel) = channel {
        send(&channel, event);
    }
}

fn send(channel: &Channel<UpdateEvent>, event: UpdateEvent) {
    if let Err(e) = channel.send(event) {
        log::warn!("could not show the update's progress: {e}");
    }
}

/// Take over the quit to install. A quit already under way wins: then the update is dropped and
/// the event to hide the page's panel is returned (that quit may yet be cancelled, and the app
/// keep running).
fn claim_quit(running: &AtomicBool, version: &str) -> Result<(), UpdateEvent> {
    if running.swap(true, Ordering::SeqCst) {
        Err(UpdateEvent::Cancelled {
            version: version.to_string(),
        })
    } else {
        Ok(())
    }
}

/// Bytes downloaded so far, and whether the page is due to hear about them: at most every
/// `PROGRESS_EVERY`, plus the first chunk and the one that reaches the size (once, even if the
/// body runs past it).
#[derive(Debug, Default)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    last_sent: Option<Instant>,
    done_sent: bool,
}

impl Progress {
    /// Count a chunk; true when the page should be told.
    fn chunk(&mut self, len: usize, total: Option<u64>, now: Instant) -> bool {
        self.downloaded += len as u64;
        if total.is_some() {
            self.total = total;
        }
        let done = !self.done_sent && self.total.is_some_and(|t| self.downloaded >= t);
        self.done_sent |= done;
        let due = self
            .last_sent
            .is_none_or(|sent| now.duration_since(sent) >= PROGRESS_EVERY);
        if done || due {
            self.last_sent = Some(now);
        }
        done || due
    }
}

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
    let version = update.version.clone();
    log::info!("downloading update {version}");
    notify(
        app,
        UpdateEvent::Downloading {
            version: version.clone(),
            downloaded: 0,
            total: None,
        },
    );
    let started = Instant::now();
    let mut progress = Progress::default();
    let on_chunk = |len: usize, total: Option<u64>| {
        if progress.chunk(len, total, Instant::now()) {
            notify(
                app,
                UpdateEvent::Downloading {
                    version: version.clone(),
                    downloaded: progress.downloaded,
                    total: progress.total,
                },
            );
        }
    };
    let bytes = match update.download(on_chunk, || {}).await {
        Ok(bytes) => {
            log::info!(
                "downloaded update {version}: {} bytes in {:.1} s",
                bytes.len(),
                started.elapsed().as_secs_f64()
            );
            bytes
        }
        Err(e) => {
            notify(app, UpdateEvent::Failed { version });
            return error(
                app,
                format!("The update could not be downloaded: {e}"),
                false,
            );
        }
    };
    // From here on this is a quit: a close request meanwhile must not start a second one, and a
    // quit already under way wins.
    if let Err(cancelled) = claim_quit(&app.state::<Quit>().running, &update.version) {
        log::info!("a quit is under way; update {} dropped", update.version);
        notify(app, cancelled);
        return;
    }
    log::info!("installing update {}", update.version);
    notify(
        app,
        UpdateEvent::Installing {
            version: update.version.clone(),
        },
    );
    app.state::<Server>().stop().await;
    app.state::<Quit>().done.store(true, Ordering::SeqCst);
    // On Windows this starts the installer and exits the app.
    match update.install(bytes) {
        Ok(()) => app.restart(),
        Err(e) => {
            remember_failed(app, &update.version);
            notify(
                app,
                UpdateEvent::Failed {
                    version: update.version.clone(),
                },
            );
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn progress_is_sent_first_then_at_most_every_interval_and_at_the_end() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut p = Progress::default();
        assert!(p.chunk(1000, Some(10_000), at(0)), "the first chunk");
        assert!(!p.chunk(1000, Some(10_000), at(50)));
        assert!(p.chunk(1000, Some(10_000), at(100)));
        assert!(!p.chunk(1000, Some(10_000), at(150)));
        assert_eq!((p.downloaded, p.total), (4000, Some(10_000)));
        assert!(p.chunk(6000, Some(10_000), at(160)), "the last chunk");
        assert_eq!(p.downloaded, 10_000);
        // A body longer than its stated size: the throttle still holds.
        assert!(!p.chunk(10, Some(10_000), at(170)));
        assert!(p.chunk(10, Some(10_000), at(260)));
    }

    #[test]
    fn a_quit_under_way_drops_the_update_and_hides_the_panel() {
        let running = AtomicBool::new(false);
        assert_eq!(claim_quit(&running, "3.1.1"), Ok(()));
        assert!(running.load(Ordering::SeqCst), "the install owns the quit");
        assert_eq!(
            claim_quit(&running, "3.1.1"),
            Err(UpdateEvent::Cancelled {
                version: "3.1.1".into()
            })
        );
    }

    #[test]
    fn a_new_channel_gets_the_last_event_first() {
        let mut watch = Watch::<&str>::default();
        let downloading = UpdateEvent::Downloading {
            version: "3.1.1".into(),
            downloaded: 5,
            total: Some(10),
        };
        assert_eq!(watch.record(&downloading), None, "no page yet");
        assert_eq!(watch.watch("page"), Some(downloading));
        let installing = UpdateEvent::Installing {
            version: "3.1.1".into(),
        };
        assert_eq!(watch.record(&installing), Some("page"));
        assert_eq!(watch.watch("reloaded page"), Some(installing));
        assert_eq!(Watch::<&str>::default().watch("page"), None);
    }

    #[test]
    fn an_unknown_size_still_reports_progress() {
        let start = Instant::now();
        let mut p = Progress::default();
        assert!(p.chunk(10, None, start));
        assert!(!p.chunk(10, None, start + Duration::from_millis(10)));
        assert!(p.chunk(10, None, start + Duration::from_millis(200)));
        assert_eq!((p.downloaded, p.total), (30, None));
    }

    #[test]
    fn events_are_shaped_for_the_page() {
        let json = |e: UpdateEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(UpdateEvent::Downloading {
                version: "3.1.1".into(),
                downloaded: 5,
                total: None
            }),
            serde_json::json!({"phase": "downloading", "version": "3.1.1", "downloaded": 5, "total": null})
        );
        assert_eq!(
            json(UpdateEvent::Installing {
                version: "3.1.1".into()
            }),
            serde_json::json!({"phase": "installing", "version": "3.1.1"})
        );
        assert_eq!(
            json(UpdateEvent::Failed {
                version: "3.1.1".into()
            }),
            serde_json::json!({"phase": "failed", "version": "3.1.1"})
        );
        assert_eq!(
            json(UpdateEvent::Cancelled {
                version: "3.1.1".into()
            }),
            serde_json::json!({"phase": "cancelled", "version": "3.1.1"})
        );
    }
}
