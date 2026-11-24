//! Process trees: a child process plus everything it starts, stopped together.
//!
//! * **Unix:** the child leads its own process group. Stopping sends SIGTERM to the group, then
//!   SIGKILL after a grace period; killing sends SIGKILL at once.
//! * **Windows:** the child runs in its own Job Object, created with kill-on-close. It is spawned
//!   suspended and assigned to the job before it runs (`process-wrap`), so nothing it starts can
//!   escape. Stopping and killing both terminate the job at once, since Windows has no SIGTERM.
//!   Because the job's only handle is held here, the whole tree also dies if this process exits,
//!   crash included, so a crashed engine leaves no orphaned agents behind.
//!
//! [`TreeChild::wait`] waits for the child itself, not for what it started: a leftover daemon must
//! not keep a finished run open.

use std::io;
use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};

pub(crate) struct TreeChild {
    #[cfg(unix)]
    child: tokio::process::Child,
    #[cfg(windows)]
    child: Box<dyn process_wrap::tokio::ChildWrapper>,
    #[cfg(windows)]
    job: process_wrap::tokio::JobObjectHandle,
    pid: Option<u32>,
}

/// Start `cmd` as the root of a new process tree.
pub(crate) fn spawn(mut cmd: Command) -> io::Result<TreeChild> {
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    {
        cmd.process_group(0);
        let child = cmd.spawn()?;
        let pid = child.id();
        Ok(TreeChild { child, pid })
    }
    #[cfg(windows)]
    {
        use process_wrap::tokio::{CommandWrap, JobObject, JobObjectChild, KillOnDrop};
        let mut wrap = CommandWrap::from(cmd);
        wrap.wrap(JobObject).wrap(KillOnDrop);
        let child = wrap.spawn()?;
        let any: &dyn std::any::Any = child.as_ref();
        let job = any
            .downcast_ref::<JobObjectChild>()
            .map(|c| c.job_handle().clone())
            .ok_or_else(|| io::Error::other("the process was not placed in a job object"))?;
        let pid = child.id();
        Ok(TreeChild { child, job, pid })
    }
}

impl TreeChild {
    pub fn id(&self) -> Option<u32> {
        self.pid
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        #[cfg(unix)]
        {
            self.child.stdin.take()
        }
        #[cfg(windows)]
        {
            self.child.stdin().take()
        }
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        #[cfg(unix)]
        {
            self.child.stdout.take()
        }
        #[cfg(windows)]
        {
            self.child.stdout().take()
        }
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        #[cfg(unix)]
        {
            self.child.stderr.take()
        }
        #[cfg(windows)]
        {
            self.child.stderr().take()
        }
    }

    /// Wait for the child itself to exit (not the rest of its tree). Cancel-safe.
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        #[cfg(unix)]
        {
            self.child.wait().await
        }
        // The job wrapper's own wait also waits for every process in the job; the layer under it
        // is the plain child.
        #[cfg(windows)]
        {
            self.child.inner_mut().wait().await
        }
    }

    /// Kill the whole tree now.
    ///
    /// On Unix this signals the process group the child led. Call it only while the child is
    /// unreaped, or right after reaping it while its group may still have members: once the group
    /// is empty its id can be reused.
    pub fn kill_now(&mut self) {
        #[cfg(unix)]
        if let Some(raw) = self.pid.and_then(|p| i32::try_from(p).ok()) {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(raw),
                nix::sys::signal::Signal::SIGKILL,
            );
        } else {
            let _ = self.child.start_kill();
        }
        #[cfg(windows)]
        let _ = self.job.terminate(1);
    }

    /// Stop the whole tree in the background: politely first where the platform can (Unix:
    /// SIGTERM, then SIGKILL after `grace`), at once where it cannot (Windows).
    pub fn terminate(&mut self, grace: Duration) {
        #[cfg(unix)]
        match self.pid {
            Some(pgid) => {
                tokio::spawn(terminate_group(pgid, grace));
            }
            None => {
                let _ = self.child.start_kill();
            }
        }
        #[cfg(windows)]
        {
            let _ = grace;
            let _ = self.job.terminate(1);
        }
    }
}

/// SIGTERM the group, wait up to `grace` for it to empty, then SIGKILL whatever is left.
///
/// The group id is the child's pid. Once the child has been reaped, the id stays reserved only
/// while some member of the group lives, so polling stops the moment the group is empty, and the
/// group is checked again immediately before SIGKILL. A wrong target would need the pid space to
/// wrap around inside that window.
#[cfg(unix)]
async fn terminate_group(pgid: u32, grace: Duration) {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;
    use tokio::time::Instant;

    let Ok(raw) = i32::try_from(pgid) else { return };
    let group = Pid::from_raw(raw);
    if killpg(group, Signal::SIGTERM).is_err() {
        return; // the group is already gone
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if killpg(group, None).is_err() {
            return;
        }
    }
    if killpg(group, None).is_ok() {
        let _ = killpg(group, Signal::SIGKILL);
    }
}

/// The shell that runs a user's command line: `sh -c` on Unix, `cmd /D /S /C` on Windows.
pub(crate) fn shell_command(line: &str) -> Command {
    #[cfg(unix)]
    {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(line);
        cmd
    }
    #[cfg(windows)]
    {
        // cmd does not parse arguments the way the C runtime does, so the line is passed raw.
        // With /S, cmd strips exactly the outer quotes and runs the rest as written. /D skips
        // AutoRun commands from the registry.
        // %ComSpec% rather than a PATH lookup: checks run with the user's PATH, which need not
        // include System32. A command line is limited to about 8191 characters.
        let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut cmd = Command::new(comspec);
        cmd.args(["/D", "/S", "/C"]).raw_arg(format!("\"{line}\""));
        cmd
    }
}
