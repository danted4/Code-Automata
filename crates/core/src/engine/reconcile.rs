//! Making the task files true again when the engine opens.
//!
//! A run that was `queued` or `running` under another boot was owned by an engine that is gone
//! (closed, crashed, killed). The run is marked `interrupted`, and the user's Resume continues it.
//!
//! On Unix its agent may still be alive: agents run in their own process group, so they survive
//! their parent. If the recorded pid is alive *and* started at the recorded time (so it is not a
//! reused pid), its group is stopped first. On Windows there is nothing to stop: an agent's Job
//! Object dies with the engine that held it (see `crate::proc`), so no start time is recorded.
//!
//! Known gaps on Unix, both only after a crash:
//!
//! * A check command has no recorded pid, so one left running by a crashed engine is not stopped
//!   here (it ends on its own or at the next check's timeout).
//! * Between spawning an agent and writing its pid to the task file there is a moment in which a
//!   crash leaves an agent this cannot find.

use crate::error::Result;
use crate::store::TaskStore;
use crate::task::RunState;

/// The start time `ps` reports for `pid`, or `None` if there is no such process. Always `None` on
/// Windows, where orphans cannot outlive the engine.
pub async fn process_started(pid: u32) -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let out = crate::proc::command("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        // The date format follows the locale; the same pid must give the same text whatever
        // locale the recording and the checking process ran under.
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

#[derive(Debug, Default)]
pub struct Report {
    /// Tasks whose runs were marked interrupted.
    pub interrupted: Vec<String>,
    /// Tasks that could not be reconciled, with why; they are left as they were.
    pub problems: Vec<String>,
}

/// Mark every run left behind by another boot as interrupted. A task that cannot be updated is
/// reported and skipped, so one bad file cannot keep the project from opening.
pub async fn reconcile(store: &TaskStore, boot_id: &str) -> Result<Report> {
    let mut report = Report::default();
    for task in store.list().await?.tasks {
        let Some(run) = &task.run else { continue };
        if !run.state.is_active() || run.boot_id.as_deref() == Some(boot_id) {
            continue;
        }
        #[cfg(unix)]
        if let (Some(pid), Some(started)) = (run.pid, &run.process_started) {
            stop_orphan(pid, started).await;
        }
        let updated = store
            .update(&task.id, |t| {
                if let Some(run) = t.run.as_mut()
                    && run.state.is_active()
                {
                    run.state = RunState::Interrupted;
                    run.error = Some("Code-Automata stopped while this was running.".into());
                    run.updated_at = crate::util::now_ms();
                }
                Ok(())
            })
            .await;
        match updated {
            Ok(_) => report.interrupted.push(task.id),
            Err(e) => report.problems.push(format!("{}: {e}", task.id)),
        }
    }
    Ok(report)
}

/// Stop an orphaned agent's process group, but only if `pid` is still the process that was
/// recorded.
#[cfg(unix)]
async fn stop_orphan(pid: u32, recorded_start: &str) {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    if process_started(pid).await.as_deref() != Some(recorded_start) {
        return; // gone, or the pid now belongs to something else
    }
    let Ok(raw) = i32::try_from(pid) else { return };
    let group = Pid::from_raw(raw);
    if killpg(group, Signal::SIGTERM).is_err() {
        return;
    }
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        if killpg(group, None).is_err() {
            return;
        }
    }
    // Still there after 2 s; check it is still ours before the hard kill.
    if process_started(pid).await.as_deref() == Some(recorded_start) {
        let _ = killpg(group, Signal::SIGKILL);
    }
}
