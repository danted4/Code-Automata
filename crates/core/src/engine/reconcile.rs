//! Making the task files true again when the engine opens.
//!
//! A run that was `queued` or `running` under another boot was owned by an engine that is gone
//! (closed, crashed, killed). Its agent may still be alive: agents run in their own process group,
//! so they survive their parent. If the recorded pid is alive *and* started at the recorded time
//! (so it is not a reused pid), its group is stopped. Then the run is marked `interrupted`, and
//! the user's Resume continues it.

use std::time::Duration;

use crate::error::Result;
use crate::store::TaskStore;
use crate::task::RunState;

/// The start time `ps` reports for `pid`, or `None` if there is no such process.
pub async fn process_started(pid: u32) -> Option<String> {
    let out = tokio::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// Mark every run left behind by another boot as interrupted. Returns the task ids changed.
pub async fn reconcile(store: &TaskStore, boot_id: &str) -> Result<Vec<String>> {
    let mut changed = Vec::new();
    for task in store.list().await?.tasks {
        let Some(run) = &task.run else { continue };
        if !run.state.is_active() || run.boot_id.as_deref() == Some(boot_id) {
            continue;
        }
        if let (Some(pid), Some(started)) = (run.pid, &run.process_started) {
            stop_orphan(pid, started).await;
        }
        store
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
            .await?;
        changed.push(task.id);
    }
    Ok(changed)
}

/// Stop an orphaned agent's process group, but only if `pid` is still the process that was
/// recorded.
async fn stop_orphan(pid: u32, recorded_start: &str) {
    if process_started(pid).await.as_deref() != Some(recorded_start) {
        return; // gone, or the pid now belongs to something else
    }
    #[cfg(unix)]
    {
        use nix::sys::signal::{Signal, killpg};
        use nix::unistd::Pid;
        let Ok(raw) = i32::try_from(pid) else { return };
        let group = Pid::from_raw(raw);
        if killpg(group, Signal::SIGTERM).is_err() {
            return;
        }
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if killpg(group, None).is_err() {
                return;
            }
        }
        // Still there after 2 s; check it is still ours before the hard kill.
        if process_started(pid).await.as_deref() == Some(recorded_start) {
            let _ = killpg(group, Signal::SIGKILL);
        }
    }
}
