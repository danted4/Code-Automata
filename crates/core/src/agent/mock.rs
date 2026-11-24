//! The scripted mock agent (`mock-agent`, built from `src/bin/mock_agent.rs`).
//!
//! It speaks Claude's stream-json and takes the same `--session-id` / `--resume` flags, so it runs
//! through exactly the same process supervision as a real agent. The task's `agent.options` must
//! name a scenario file (`scenario`); `record` optionally names a file each invocation is appended
//! to, for tests that check how the agent was called.

use super::{Access, CommandSpec, RunRequest, option_str};
use crate::error::{CoreError, Result};
use crate::task::Provider;
use crate::util::uuid_v4;

pub fn command(req: &RunRequest, bins: &super::Binaries) -> Result<CommandSpec> {
    let scenario = option_str(&req.agent, "scenario").ok_or_else(|| {
        CoreError::Invalid("the mock agent needs options.scenario (a scenario file)".into())
    })?;
    let mut args = vec!["--scenario".to_string(), scenario.to_string()];
    if let Some(record) = option_str(&req.agent, "record") {
        args.extend(["--record".into(), record.to_string()]);
    }
    let session_id = match &req.resume {
        Some(id) => {
            args.extend(["--resume".into(), id.clone()]);
            id.clone()
        }
        None => {
            let id = uuid_v4();
            args.extend(["--session-id".into(), id.clone()]);
            id
        }
    };
    match req.access {
        Access::Full => {}
        Access::Review => args.push("--review".into()),
        Access::ReadOnly => args.push("--read-only".into()),
    }
    Ok(CommandSpec {
        program: bins.locate(Provider::Mock)?,
        args,
        env_remove: Vec::new(),
        env_set: Vec::new(),
        stdin: req.prompt.clone(),
        session_id: Some(session_id),
    })
}
