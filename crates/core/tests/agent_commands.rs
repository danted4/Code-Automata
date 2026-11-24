//! Command lines each provider builds, checked as argument lists. No CLI is run.
#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};

use ca_core::agent::{Binaries, CommandSpec, RunRequest, command_for};
use ca_core::{AgentConfig, Provider};
use serde_json::json;

/// Fake executables for every provider, so `locate` succeeds without the real CLIs.
fn fake_bins(dir: &Path) -> Binaries {
    let mut bins = Binaries::default();
    for provider in [
        Provider::Claude,
        Provider::Cursor,
        Provider::Amp,
        Provider::Mock,
    ] {
        let path = dir.join(ca_core::agent::env::binary_name(provider));
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        bins = bins.with_override(provider, path);
    }
    bins
}

fn request(agent: AgentConfig) -> RunRequest {
    RunRequest::new(agent, "/work/tree", "SECRET PROMPT", "/logs/run.ndjson")
}

fn build(req: &RunRequest) -> CommandSpec {
    let dir = tempfile::tempdir().unwrap();
    command_for(req, &fake_bins(dir.path())).unwrap().0
}

fn value_after<'a>(spec: &'a CommandSpec, flag: &str) -> Option<&'a str> {
    spec.args
        .iter()
        .position(|a| a == flag)
        .and_then(|i| spec.args.get(i + 1))
        .map(String::as_str)
}

fn has(spec: &CommandSpec, flag: &str) -> bool {
    spec.args.iter().any(|a| a == flag)
}

fn assert_prompt_on_stdin_only(spec: &CommandSpec) {
    assert_eq!(spec.stdin, "SECRET PROMPT");
    assert!(
        !spec.args.iter().any(|a| a.contains("SECRET PROMPT")),
        "the prompt leaked into the arguments: {:?}",
        spec.args
    );
}

#[test]
fn claude_new_run() {
    let mut agent = AgentConfig::new(Provider::Claude);
    agent.model = Some("sonnet".into());
    let mut req = request(agent);
    req.max_turns = Some(12);
    let spec = build(&req);

    assert!(spec.program.ends_with("claude"));
    for flag in ["-p", "--verbose", "--strict-mcp-config"] {
        assert!(has(&spec, flag), "missing {flag}");
    }
    assert_eq!(value_after(&spec, "--output-format"), Some("stream-json"));
    assert_eq!(value_after(&spec, "--setting-sources"), Some("project"));
    assert_eq!(value_after(&spec, "--permission-mode"), Some("auto"));
    assert_eq!(value_after(&spec, "--model"), Some("sonnet"));
    assert_eq!(value_after(&spec, "--max-turns"), Some("12"));
    assert!(!has(&spec, "--tools"), "dev runs keep all tools");
    assert!(!has(&spec, "--resume"));

    let id = value_after(&spec, "--session-id").unwrap();
    assert_eq!(
        spec.session_id.as_deref(),
        Some(id),
        "the chosen id is known up front"
    );
    assert_eq!(id.len(), 36);
    assert_eq!(spec.env_remove, ["ANTHROPIC_API_KEY"]);
    assert_prompt_on_stdin_only(&spec);
}

#[test]
fn claude_resume_read_only_with_schema() {
    let mut req = request(AgentConfig::new(Provider::Claude));
    req.resume = Some("5b0c1d2e-3f40-4a51-b627-38394a5b6c7d".into());
    req.read_only = true;
    req.json_schema = Some(json!({ "type": "object" }));
    let spec = build(&req);

    assert_eq!(
        value_after(&spec, "--resume"),
        Some("5b0c1d2e-3f40-4a51-b627-38394a5b6c7d")
    );
    assert!(!has(&spec, "--session-id"));
    assert_eq!(value_after(&spec, "--tools"), Some("Read,Grep,Glob"));
    assert_eq!(
        value_after(&spec, "--json-schema"),
        Some(r#"{"type":"object"}"#)
    );
    assert_eq!(
        spec.session_id.as_deref(),
        Some("5b0c1d2e-3f40-4a51-b627-38394a5b6c7d")
    );
}

#[test]
fn claude_options_override_permissions_and_billing() {
    let mut agent = AgentConfig::new(Provider::Claude);
    agent
        .options
        .insert("permissionMode".into(), json!("acceptEdits"));
    agent.options.insert("useApiKeyFromEnv".into(), json!(true));
    let spec = build(&request(agent));
    assert_eq!(value_after(&spec, "--permission-mode"), Some("acceptEdits"));
    assert!(spec.env_remove.is_empty());
}

#[test]
fn cursor_runs() {
    let mut agent = AgentConfig::new(Provider::Cursor);
    agent.model = Some("auto".into());
    let spec = build(&request(agent.clone()));
    assert!(spec.program.ends_with("agent"));
    assert!(has(&spec, "-p"));
    assert!(has(&spec, "--trust"));
    assert_eq!(value_after(&spec, "--output-format"), Some("stream-json"));
    assert_eq!(value_after(&spec, "--workspace"), Some("/work/tree"));
    assert_eq!(value_after(&spec, "--model"), Some("auto"));
    assert!(!has(&spec, "--mode"), "dev runs use the default agent mode");
    assert!(
        !has(&spec, "--force"),
        "shell works without --force in print mode"
    );
    assert_eq!(spec.session_id, None, "Cursor reports its id on init");
    assert_eq!(spec.env_remove, ["CURSOR_API_KEY"]);
    assert_prompt_on_stdin_only(&spec);

    let mut req = request(agent);
    req.read_only = true;
    req.resume = Some("697e09e5".into());
    let spec = build(&req);
    assert_eq!(
        value_after(&spec, "--mode"),
        Some("ask"),
        "plan mode gives no text answer"
    );
    assert_eq!(value_after(&spec, "--resume"), Some("697e09e5"));
    assert_eq!(spec.session_id.as_deref(), Some("697e09e5"));
}

#[test]
fn amp_new_and_resumed_threads() {
    let mut agent = AgentConfig::new(Provider::Amp);
    agent.mode = Some("low".into());
    let spec = build(&request(agent.clone()));
    assert!(spec.program.ends_with("amp"));
    assert_eq!(spec.args[0], "-x");
    for flag in [
        "--stream-json",
        "--no-ide",
        "--no-notifications",
        "--no-archive-after-execute",
    ] {
        assert!(has(&spec, flag), "missing {flag}");
    }
    assert_eq!(value_after(&spec, "--mode"), Some("low"));
    assert!(spec.env_remove.is_empty());
    assert_prompt_on_stdin_only(&spec);

    let mut req = request(agent);
    req.resume = Some("T-01a20cc8".into());
    let spec = build(&req);
    assert_eq!(&spec.args[..4], ["threads", "continue", "T-01a20cc8", "-x"]);
    assert!(has(&spec, "--no-archive-after-execute"));
    assert!(
        !has(&spec, "--mode"),
        "a thread keeps the mode it was created with"
    );
}

#[test]
fn mock_needs_a_scenario() {
    let dir = tempfile::tempdir().unwrap();
    let bins = fake_bins(dir.path());
    let req = request(AgentConfig::new(Provider::Mock));
    assert!(command_for(&req, &bins).is_err());

    let mut agent = AgentConfig::new(Provider::Mock);
    agent.options.insert("scenario".into(), json!("/s.json"));
    let mut req = request(agent);
    req.read_only = true;
    let spec = command_for(&req, &bins).unwrap().0;
    assert_eq!(value_after(&spec, "--scenario"), Some("/s.json"));
    assert!(has(&spec, "--read-only"));
}

#[test]
fn a_missing_binary_is_a_clear_error() {
    let bins = Binaries::default(); // no PATH, no overrides
    let err = command_for(&request(AgentConfig::new(Provider::Claude)), &bins).unwrap_err();
    assert!(err.to_string().contains("not found"), "{err}");

    let bins = Binaries::default().with_override(Provider::Claude, PathBuf::from("/nope/claude"));
    let err = command_for(&request(AgentConfig::new(Provider::Claude)), &bins).unwrap_err();
    assert!(err.to_string().contains("not an executable"), "{err}");
}
