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
/// Connecting gives up after this, shared among the host's addresses. GitHub's download host has
/// four; one that never answers would otherwise cost the system's TCP timeout (about 75 s on
/// macOS) before the next is tried.
/// reqwest counts DNS, proxy and TLS in it too, and splits it among the addresses (5 s each of
/// four), so it is generous enough for a slow proxy or several dead addresses.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// A transfer that receives nothing for this long gives up (a download is then retried).
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// One request: the check, or one download attempt.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(900);
/// The whole download, every attempt included (about 15 MB); the panel cannot be closed meanwhile.
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(900);
/// A failed download is not tried again with less than this left before the deadline.
const MIN_RETRY_TIME: Duration = Duration::from_secs(60);
const CHECK_ATTEMPTS: u32 = 2;
const DOWNLOAD_ATTEMPTS: u32 = 3;

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
    /// Looking for a newer version (Settings shows it).
    Checking,
    /// Not checking, downloading or installing: the check ended or the update was declined.
    Idle,
    /// `total` is None when the server does not say how big the file is; `attempt` counts from 1
    /// (a failed attempt starts again from zero).
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
        attempt: u32,
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
    notify(app, UpdateEvent::Checking);
    let found = find(app).await;
    // The check is over, whatever it found; a question that follows is the app's own dialog.
    notify(app, UpdateEvent::Idle);
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

/// The updater, with the timeouts above.
fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    app.updater_builder()
        .timeout(NETWORK_TIMEOUT)
        .configure_client(|client| {
            client
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(READ_TIMEOUT)
        })
        .build()
}

/// Worth another try: a connection that failed or stalled, a transfer that broke off, or a server
/// error (5xx) or rate limit (429). Not a missing file (404), a refused request, a bad signature
/// or manifest: those fail the same way again.
fn retryable(e: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error;
    match e {
        Error::Reqwest(e) => e.is_connect() || e.is_timeout() || e.is_body() || e.is_request(),
        // The plugin's error for a download answered with a non-success status.
        Error::Network(message) => status_in(message).is_some_and(|s| s >= 500 || s == 429),
        _ => false,
    }
}

/// The HTTP status in the plugin's "… failed with status: 503 Service Unavailable".
fn status_in(message: &str) -> Option<u16> {
    let (_, rest) = message.rsplit_once("status: ")?;
    rest.split_whitespace().next()?.parse().ok()
}

/// The newest version, if it is newer; a failure worth it is tried once more. That includes "no
/// release found", which is also what the plugin says when `latest.json` was answered with an
/// error status (a 502 from GitHub's CDN, say): one more look costs two seconds.
async fn find(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    let updater = updater(app)?;
    let mut attempt = 1;
    loop {
        match updater.check().await {
            Err(e)
                if attempt < CHECK_ATTEMPTS
                    && (retryable(&e)
                        || matches!(e, tauri_plugin_updater::Error::ReleaseNotFound)) =>
            {
                log::warn!("update check failed ({e}); trying again");
                tokio::time::sleep(Duration::from_secs(2)).await;
                attempt += 1;
            }
            found => return found,
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
    let Some(bytes) = download(app, &update).await else {
        return;
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
        Ok(()) => relaunch(app),
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

/// Download the update, showing its progress. A failure worth it is tried again from the start,
/// within one deadline for the whole download. None when it failed, after saying so.
async fn download(app: &AppHandle, update: &Update) -> Option<Vec<u8>> {
    let version = update.version.clone();
    let deadline = Instant::now() + DOWNLOAD_DEADLINE;
    let starting = |attempt: u32| UpdateEvent::Downloading {
        version: version.clone(),
        downloaded: 0,
        total: None,
        attempt,
    };
    let mut attempt = 1;
    notify(app, starting(attempt));
    loop {
        log::info!("downloading update {version} (attempt {attempt})");
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
                        attempt,
                    },
                );
            }
        };
        let left = deadline.saturating_duration_since(Instant::now());
        let result = match tokio::time::timeout(left, update.download(on_chunk, || {})).await {
            Ok(Ok(bytes)) => Ok(bytes),
            Ok(Err(e)) => Err((retryable(&e), e.to_string())),
            Err(_) => Err((
                false,
                format!(
                    "it took longer than {} minutes",
                    DOWNLOAD_DEADLINE.as_secs() / 60
                ),
            )),
        };
        match result {
            Ok(bytes) => {
                log::info!(
                    "downloaded update {version}: {} bytes in {:.1} s",
                    bytes.len(),
                    started.elapsed().as_secs_f64()
                );
                return Some(bytes);
            }
            Err((true, e))
                if attempt < DOWNLOAD_ATTEMPTS
                    && deadline.saturating_duration_since(Instant::now()) > MIN_RETRY_TIME =>
            {
                log::warn!("downloading update {version} failed ({e}); trying again");
                attempt += 1;
                // Back to "connecting", saying it is another try, while it waits.
                notify(app, starting(attempt));
                tokio::time::sleep(Duration::from_secs(2 * u64::from(attempt - 1))).await;
            }
            Err((_, e)) => {
                notify(app, UpdateEvent::Failed { version });
                error(
                    app,
                    format!("The update could not be downloaded: {e}"),
                    false,
                );
                return None;
            }
        }
    }
}

/// Start the app again (the installed version), then exit.
///
/// On macOS Tauri's restart runs `open -n` while this process still runs, and the Dock gives that
/// second instance an icon of its own, which stays beside the kept one after this one exits. So a
/// detached `sh` ([`RELAUNCH_SCRIPT`]) waits for this process to exit and then opens the bundle
/// normally, as a click on its Dock icon would, checking that it started. Elsewhere, and if the
/// script cannot start, Tauri's restart.
fn relaunch(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = std::env::current_exe()
        .ok()
        .and_then(|exe| app_bundle(&exe))
    {
        use std::os::unix::process::CommandExt;
        let log = app
            .path()
            .app_log_dir()
            .map(|d| d.join("relaunch.log"))
            .unwrap_or_else(|_| PathBuf::from("/dev/null"));
        let mut cmd = ca_core::proc::command("/bin/sh").into_std();
        cmd.args(["-c", RELAUNCH_SCRIPT, "sh"])
            .arg(std::process::id().to_string())
            .arg(&bundle)
            .args(["/usr/bin/open", "150", RUNNING_CHECK, "1"])
            .arg(&log)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0);
        match cmd.spawn() {
            Ok(_) => {
                log::info!("restarting {} once this process exits", bundle.display());
                app.exit(0);
                return;
            }
            Err(e) => log::warn!("could not schedule the restart ({e}); restarting directly"),
        }
    }
    app.restart();
}

/// Restart the app once process `$1` has exited. `$2` the bundle, `$3` the `open` command, `$4`
/// how long to wait for the exit (in 0.2 s ticks), `$5` a shell test that the bundle's app runs,
/// `$6` seconds to give each open, `$7` a log file for the outcome.
///
/// If the exit takes too long, or the opened app does not show up after five tries (`open` may just
/// activate an instance LaunchServices still lists), it falls back to `open -n`: a second Dock
/// icon beats no app.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const RELAUNCH_SCRIPT: &str = r#"pid=$1 bundle=$2 open=$3 ticks=$4 running=$5 settle=$6 log=$7
say() { printf '%s %s\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$log"; }
i=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$i" -ge "$ticks" ]; then
    say "process $pid still running; opening a new instance"
    exec "$open" -n "$bundle"
  fi
  sleep 0.2
  i=$((i + 1))
done
for try in 1 2 3 4 5; do
  "$open" "$bundle"
  sleep "$settle"
  if eval "$running"; then
    say "started (open $try)"
    exit 0
  fi
done
say "not running after 5 opens; opening a new instance"
exec "$open" -n "$bundle"
"#;

/// [`RELAUNCH_SCRIPT`]'s test that the app runs: a process whose executable is in the bundle
/// (`comm`, so the `grep` itself never matches).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const RUNNING_CHECK: &str = r#"/bin/ps -axo comm= | /usr/bin/grep -qF "$bundle/Contents/MacOS/""#;

/// The `.app` bundle an executable is in (`X.app/Contents/MacOS/x`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_bundle(exe: &std::path::Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_app = bundle.extension().is_some_and(|e| e == "app");
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && is_app)
        .then(|| bundle.to_path_buf())
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
                relaunch(&after);
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
            attempt: 1,
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
    fn only_failures_worth_it_are_tried_again() {
        use tauri_plugin_updater::Error;
        let status = |s: &str| Error::Network(format!("Download request failed with status: {s}"));
        assert!(retryable(&status("503 Service Unavailable")));
        assert!(retryable(&status("429 Too Many Requests")));
        assert!(!retryable(&status("404 Not Found")));
        assert!(!retryable(&status("403 Forbidden")));
        assert!(!retryable(&Error::Network("something else".into())));
        assert!(!retryable(&Error::ReleaseNotFound));
        assert_eq!(status_in("failed with status: 502 Bad Gateway"), Some(502));
        assert_eq!(status_in("no status here"), None);
    }

    /// Runs [`RELAUNCH_SCRIPT`] with a fake `open` that logs its arguments and makes the app
    /// "run" (a marker file) from its `starts_on`-th plain open; returns the opens it saw.
    #[cfg(unix)]
    fn relaunch_with(pid: u32, starts_on: Option<u32>, ticks: u32) -> Vec<String> {
        let dir = tempfile::tempdir().unwrap();
        let calls = dir.path().join("calls");
        let marker = dir.path().join("running");
        let open = dir.path().join("open");
        let starts = starts_on.map_or(String::new(), |n| {
            format!(
                "[ \"$1\" != -n ] && [ $(grep -vc '^-n' {calls}) -ge {n} ] && touch {marker}\n",
                calls = calls.display(),
                marker = marker.display()
            )
        });
        std::fs::write(
            &open,
            format!(
                "#!/bin/sh\necho \"$*\" >> {calls}\n{starts}exit 0\n",
                calls = calls.display()
            ),
        )
        .unwrap();
        let chmod = std::process::Command::new("chmod")
            .arg("755")
            .arg(&open)
            .status()
            .unwrap();
        assert!(chmod.success());
        let check = format!("test -f {}", marker.display());
        let status = std::process::Command::new("/bin/sh")
            .args(["-c", RELAUNCH_SCRIPT, "sh", &pid.to_string(), "/Apps/X.app"])
            .arg(&open)
            .args([&ticks.to_string(), &check, "0.05"])
            .arg(dir.path().join("relaunch.log"))
            .status()
            .unwrap();
        assert!(status.success());
        std::fs::read_to_string(&calls)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[cfg(unix)]
    fn exited_pid() -> u32 {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    #[test]
    #[cfg(unix)]
    fn relaunch_opens_the_bundle_once_the_app_has_exited() {
        assert_eq!(relaunch_with(exited_pid(), Some(1), 150), ["/Apps/X.app"]);
    }

    #[test]
    #[cfg(unix)]
    fn relaunch_opens_again_when_the_first_open_started_nothing() {
        assert_eq!(
            relaunch_with(exited_pid(), Some(2), 150),
            ["/Apps/X.app", "/Apps/X.app"]
        );
    }

    #[test]
    #[cfg(unix)]
    fn relaunch_falls_back_to_a_new_instance() {
        let mut opens = vec!["/Apps/X.app"; 5];
        opens.push("-n /Apps/X.app");
        assert_eq!(relaunch_with(exited_pid(), None, 150), opens);
        // An app that does not exit in time: a new instance at once.
        let mut alive = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let calls = relaunch_with(alive.id(), Some(1), 2);
        alive.kill().unwrap();
        let _ = alive.wait();
        assert_eq!(calls, ["-n /Apps/X.app"]);
    }

    #[test]
    fn the_bundle_is_found_from_its_executable() {
        use std::path::Path;
        assert_eq!(
            app_bundle(Path::new(
                "/Applications/Code-Automata.app/Contents/MacOS/code-automata"
            )),
            Some(PathBuf::from("/Applications/Code-Automata.app"))
        );
        assert_eq!(app_bundle(Path::new("/usr/local/bin/code-automata")), None);
        assert_eq!(
            app_bundle(Path::new("/tmp/x/Contents/MacOS/code-automata")),
            None,
            "not an .app"
        );
    }

    #[test]
    fn events_are_shaped_for_the_page() {
        let json = |e: UpdateEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(UpdateEvent::Downloading {
                version: "3.1.1".into(),
                downloaded: 5,
                total: None,
                attempt: 2
            }),
            serde_json::json!({"phase": "downloading", "version": "3.1.1", "downloaded": 5, "total": null, "attempt": 2})
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
            json(UpdateEvent::Checking),
            serde_json::json!({"phase": "checking"})
        );
        assert_eq!(
            json(UpdateEvent::Idle),
            serde_json::json!({"phase": "idle"})
        );
        assert_eq!(
            json(UpdateEvent::Cancelled {
                version: "3.1.1".into()
            }),
            serde_json::json!({"phase": "cancelled", "version": "3.1.1"})
        );
    }
}
