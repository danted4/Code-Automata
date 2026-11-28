//! Command lines each provider builds, checked as argument lists. No CLI is run.
#![allow(clippy::unwrap_used)]

mod common;

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
        Provider::Codex,
        Provider::Gemini,
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
    req.access = ca_core::agent::Access::ReadOnly;
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
    req.access = ca_core::agent::Access::ReadOnly;
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
    req.access = ca_core::agent::Access::ReadOnly;
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

#[test]
fn amp_model_wins_over_mode() {
    let mut agent = AgentConfig::new(Provider::Amp);
    agent.mode = Some("low".into());
    agent.model = Some("anthropic/claude-sonnet".into());
    let spec = build(&request(agent));
    assert_eq!(
        value_after(&spec, "--model"),
        Some("anthropic/claude-sonnet")
    );
    assert!(!has(&spec, "--mode"), "Amp takes --model instead of --mode");
}

/// A fake CLI whose answers to `--version` and the login check are given as shell snippets.
#[cfg(unix)]
fn fake_cli(dir: &Path, name: &str, version: &str, login: &str) -> PathBuf {
    let path = dir.join(name);
    common::write_script(
        &path,
        &format!("#!/bin/sh\ncase \"$1\" in\n  --version) {version} ;;\n  *) {login} ;;\nesac\n"),
    );
    path
}

#[tokio::test]
#[cfg(unix)] // the fake CLI is a shell script
async fn preflight_reads_claude_login_from_stdout_only() {
    use ca_core::agent::preflight::check;
    let dir = tempfile::tempdir().unwrap();
    let cases = [
        // A warning on stderr must not hide a good login.
        (
            r#"echo '{"loggedIn": true, "email": "someone@example.com"}'; echo 'update available' >&2"#,
            Some(true),
        ),
        (r#"echo '{"loggedIn": false}'"#, Some(false)),
        // Unreadable output is "could not check", not "not logged in".
        (r#"echo 'something went wrong'"#, None),
    ];
    for (login, expected) in cases {
        let bin = fake_cli(dir.path(), "claude", "echo '2.1.0 (Claude Code)'", login);
        let bins = Binaries::default().with_override(Provider::Claude, bin);
        let report = check(Provider::Claude, &bins).await;
        assert_eq!(report.logged_in, expected, "{login}");
        assert_eq!(report.version.as_deref(), Some("2.1.0 (Claude Code)"));
        assert_eq!(report.ready(), expected == Some(true));
        let json = serde_json::to_string(&report).unwrap();
        assert!(
            !json.contains("someone@example.com"),
            "the account leaked: {json}"
        );
    }
}

#[tokio::test]
#[cfg(unix)] // the fake CLI is a shell script
async fn preflight_reads_cursor_and_amp_logins() {
    use ca_core::agent::preflight::check;
    let dir = tempfile::tempdir().unwrap();
    let cursor_in = fake_cli(dir.path(), "agent", "echo 1", "echo '✓ Logged in as a@b.c'");
    let bins = Binaries::default().with_override(Provider::Cursor, cursor_in);
    assert_eq!(check(Provider::Cursor, &bins).await.logged_in, Some(true));

    let cursor_out = fake_cli(
        dir.path(),
        "agent2",
        "echo 1",
        "echo 'Not logged in'; exit 1",
    );
    let bins = Binaries::default().with_override(Provider::Cursor, cursor_out);
    assert_eq!(check(Provider::Cursor, &bins).await.logged_in, Some(false));

    let amp = fake_cli(dir.path(), "amp", "echo 1", "echo 'Signed in as a@b.c'");
    let bins = Binaries::default().with_override(Provider::Amp, amp);
    assert_eq!(check(Provider::Amp, &bins).await.logged_in, Some(true));
}

#[test]
fn preflight_and_runs_remove_the_same_variables() {
    use ca_core::agent::{claude, cursor};
    let mut agent = AgentConfig::new(Provider::Claude);
    assert_eq!(claude::removed_env(&agent), ["ANTHROPIC_API_KEY"]);
    assert_eq!(
        build(&request(agent.clone())).env_remove,
        claude::removed_env(&agent)
    );
    agent.options.insert("useApiKeyFromEnv".into(), json!(true));
    assert!(claude::removed_env(&agent).is_empty());

    let agent = AgentConfig::new(Provider::Cursor);
    assert_eq!(
        build(&request(agent.clone())).env_remove,
        cursor::removed_env(&agent)
    );
}

#[test]
fn review_access_keeps_the_shell_but_not_editing_tools() {
    let mut req = request(AgentConfig::new(Provider::Claude));
    req.access = ca_core::agent::Access::Review;
    let spec = build(&req);
    assert_eq!(
        value_after(&spec, "--disallowedTools"),
        Some("Edit,Write,NotebookEdit")
    );
    assert!(!has(&spec, "--tools"));

    let mut req = request(AgentConfig::new(Provider::Cursor));
    req.access = ca_core::agent::Access::Review;
    assert!(
        !has(&build(&req), "--mode"),
        "ask mode would block the shell QA needs"
    );
}

fn mcp_servers() -> ca_core::agent::mcp::McpServers {
    use ca_core::agent::mcp::McpServer;
    let mut servers = ca_core::agent::mcp::McpServers::new();
    servers.insert(
        "browser".into(),
        McpServer::Stdio {
            command: "npx".into(),
            args: vec!["@playwright/mcp".into()],
            env: [("TOKEN".to_string(), "s3cret".to_string())].into(),
        },
    );
    servers
}

fn no_secret_in_args(spec: &CommandSpec) {
    assert!(
        !spec.args.iter().any(|a| a.contains("s3cret")),
        "a secret leaked into the arguments: {:?}",
        spec.args
    );
}

#[test]
fn codex_new_run_dev_and_read_only() {
    let mut agent = AgentConfig::new(Provider::Codex);
    agent.model = Some("gpt-6.2-sol".into());
    agent.mode = Some("high".into());
    let spec = build(&request(agent));
    assert!(spec.program.ends_with("codex"));
    assert_eq!(spec.args[0], "exec");
    for flag in ["--json", "--skip-git-repo-check", "--ignore-user-config"] {
        assert!(has(&spec, flag), "missing {flag}");
    }
    assert_eq!(value_after(&spec, "-C"), Some("/work/tree"));
    assert_eq!(value_after(&spec, "--sandbox"), Some("danger-full-access"));
    assert_eq!(value_after(&spec, "-m"), Some("gpt-6.2-sol"));
    assert!(spec.args.iter().any(|a| a == "approval_policy=\"never\""));
    assert!(
        spec.args
            .iter()
            .any(|a| a == "model_reasoning_effort=\"high\"")
    );
    assert_eq!(
        spec.args.last().map(String::as_str),
        Some("-"),
        "prompt from stdin"
    );
    assert!(!has(&spec, "resume"));
    assert_eq!(
        spec.session_id, None,
        "the thread id comes on the first line"
    );
    assert_eq!(spec.env_remove, ["OPENAI_API_KEY", "CODEX_API_KEY"]);
    assert!(spec.files.is_empty());
    assert_prompt_on_stdin_only(&spec);

    let mut req = request(AgentConfig::new(Provider::Codex));
    req.access = ca_core::agent::Access::ReadOnly;
    assert_eq!(value_after(&build(&req), "--sandbox"), Some("read-only"));
}

#[test]
fn codex_resume_with_schema_and_mcp() {
    let mut req = request(AgentConfig::new(Provider::Codex));
    req.resume = Some("0199a213-81c0-7800-8aa1-bbab2a035a53".into());
    req.json_schema =
        Some(json!({ "type": "object", "properties": { "a": { "type": "string" } } }));
    req.mcp_servers = mcp_servers();
    let spec = build(&req);
    let n = spec.args.len();
    assert_eq!(
        spec.args[n - 3..],
        ["resume", "0199a213-81c0-7800-8aa1-bbab2a035a53", "-"]
    );
    assert_eq!(
        spec.session_id.as_deref(),
        Some("0199a213-81c0-7800-8aa1-bbab2a035a53")
    );
    // The schema goes in a file beside the run log, made strict.
    let schema_path = value_after(&spec, "--output-schema").unwrap();
    assert_eq!(schema_path, "/logs/run.schema.json");
    let file = &spec.files[0];
    let schema: serde_json::Value = serde_json::from_str(&file.contents).unwrap();
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["required"], json!(["a"]));
    // The allowed MCP server, its secret in the environment, named in the config.
    assert!(
        spec.args
            .iter()
            .any(|a| a.starts_with("mcp_servers.browser=") && a.contains("env_vars=[\"TOKEN\"]"))
    );
    assert!(
        spec.env_set
            .contains(&("TOKEN".to_string(), "s3cret".to_string()))
    );
    no_secret_in_args(&spec);
}

#[test]
fn gemini_new_run_resume_and_read_only() {
    let mut agent = AgentConfig::new(Provider::Gemini);
    agent.model = Some("gemini-3.5-flash".into());
    let spec = build(&request(agent));
    assert!(spec.program.ends_with("gemini"));
    assert_eq!(value_after(&spec, "-o"), Some("stream-json"));
    assert!(has(&spec, "--skip-trust"));
    assert_eq!(value_after(&spec, "-e"), Some("none"));
    assert_eq!(value_after(&spec, "-m"), Some("gemini-3.5-flash"));
    assert_eq!(value_after(&spec, "--approval-mode"), Some("yolo"));
    assert_eq!(
        value_after(&spec, "--allowed-mcp-server-names"),
        Some(ca_core::agent::gemini::NO_MCP_SERVER)
    );
    let id = value_after(&spec, "--session-id").unwrap();
    assert_eq!(spec.session_id.as_deref(), Some(id));
    assert_eq!(spec.env_remove, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    assert!(spec.files.is_empty() && spec.env_set.is_empty());
    assert_prompt_on_stdin_only(&spec);

    let mut req = request(AgentConfig::new(Provider::Gemini));
    req.resume = Some("abc".into());
    req.access = ca_core::agent::Access::ReadOnly;
    let spec = build(&req);
    assert_eq!(value_after(&spec, "--resume"), Some("abc"));
    assert!(!has(&spec, "--session-id"));
    assert_eq!(value_after(&spec, "--approval-mode"), Some("default"));
}

#[test]
fn gemini_and_claude_get_only_the_allowed_mcp_servers_in_a_file() {
    let mut req = request(AgentConfig::new(Provider::Gemini));
    req.mcp_servers = mcp_servers();
    let spec = build(&req);
    assert_eq!(
        value_after(&spec, "--allowed-mcp-server-names"),
        Some("browser")
    );
    let (var, path) = &spec.env_set[0];
    assert_eq!(var, "GEMINI_CLI_SYSTEM_SETTINGS_PATH");
    assert_eq!(path, "/logs/run.gemini-settings.json");
    assert!(spec.files[0].contents.contains("s3cret"));
    no_secret_in_args(&spec);

    let mut req = request(AgentConfig::new(Provider::Claude));
    req.mcp_servers = mcp_servers();
    let spec = build(&req);
    assert!(has(&spec, "--strict-mcp-config"));
    assert_eq!(
        value_after(&spec, "--mcp-config"),
        Some("/logs/run.mcp.json")
    );
    assert!(spec.files[0].contents.contains("@playwright/mcp"));
    no_secret_in_args(&spec);
    // None allowed: no config at all.
    let spec = build(&request(AgentConfig::new(Provider::Claude)));
    assert!(!has(&spec, "--mcp-config") && spec.files.is_empty());
}

#[tokio::test]
#[cfg(unix)] // the fake CLI is a shell script
async fn preflight_reads_codex_and_gemini_logins() {
    use ca_core::agent::preflight::check;
    let dir = tempfile::tempdir().unwrap();
    let codex_in = fake_cli(
        dir.path(),
        "codex",
        "echo 'codex-cli 0.172.0'",
        "echo 'Logged in using ChatGPT' >&2",
    );
    let bins = Binaries::default().with_override(Provider::Codex, codex_in);
    let report = check(Provider::Codex, &bins).await;
    assert_eq!(report.logged_in, Some(true));
    assert_eq!(report.version.as_deref(), Some("codex-cli 0.172.0"));
    let codex_out = fake_cli(
        dir.path(),
        "codex2",
        "echo 1",
        "echo 'Not logged in' >&2; exit 1",
    );
    let bins = Binaries::default().with_override(Provider::Codex, codex_out);
    assert_eq!(check(Provider::Codex, &bins).await.logged_in, Some(false));

    // Gemini: the sign-in chosen in its settings.
    let home = tempfile::tempdir().unwrap();
    let gemini = fake_cli(dir.path(), "gemini", "echo 0.71.1", "exit 0");
    let bins = Binaries::default()
        .with_override(Provider::Gemini, &gemini)
        .with_home(home.path());
    assert_eq!(check(Provider::Gemini, &bins).await.logged_in, Some(false));
    std::fs::create_dir_all(home.path().join(".gemini")).unwrap();
    std::fs::write(
        home.path().join(".gemini/settings.json"),
        r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#,
    )
    .unwrap();
    let report = check(Provider::Gemini, &bins).await;
    assert_eq!(report.logged_in, Some(true));
    assert!(report.ready());
}
