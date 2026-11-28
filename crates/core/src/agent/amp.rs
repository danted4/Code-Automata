//! Amp CLI (`amp -x`).
//!
//! * **Start:** `amp -x --stream-json --no-ide --no-notifications --no-archive-after-execute`, with
//!   the prompt on stdin.
//! * **Resume:** `amp threads continue <thread id>` plus the same flags; the thread id (`T-…`) is
//!   `session_id` on the first event.
//! * **Archiving:** execute mode archives its thread when it ends, and an archived thread cannot be
//!   continued, hence `--no-archive-after-execute`.
//! * **Model:** `agent.model` maps to `--model`, else `agent.mode` to `--mode` (`low`, `medium`,
//!   `high`, `ultra`). Amp takes one or the other ("--model … instead of --mode"), so with both
//!   set the model wins and the mode is not passed.
//! * **Read-only:** not enforceable per run. Permission rules are removed on 2026-11-29 and plugins
//!   load only from global or project folders, so planning relies on the prompt, and the engine
//!   resets the worktree afterwards.
//! * **End of run:** a killed run still writes a final `result` with subtype
//!   `error_during_execution` (`is_error: true`) and exits 0: an agent error, or `Stopped` when we
//!   stopped it.

use super::{CommandSpec, RunRequest};
use crate::error::Result;
use crate::task::Provider;

pub fn command(req: &RunRequest, bins: &super::Binaries) -> Result<CommandSpec> {
    let mut args: Vec<String> = Vec::new();
    if let Some(id) = &req.resume {
        args.extend(["threads".into(), "continue".into(), id.clone()]);
    }
    args.extend(
        [
            "-x",
            "--stream-json",
            "--no-ide",
            "--no-notifications",
            "--no-archive-after-execute",
        ]
        .into_iter()
        .map(String::from),
    );
    // A thread keeps the mode it was created with, so only new threads take one.
    if req.resume.is_none() {
        if let Some(model) = &req.agent.model {
            args.extend(["--model".into(), model.clone()]);
        } else if let Some(mode) = &req.agent.mode {
            args.extend(["--mode".into(), mode.clone()]);
        }
    }
    Ok(CommandSpec {
        program: bins.locate(Provider::Amp)?,
        args,
        env_remove: Vec::new(),
        env_set: Vec::new(),
        stdin: req.prompt.clone(),
        session_id: req.resume.clone(),
        files: Vec::new(),
    })
}
