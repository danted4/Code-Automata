//! The MCP servers a project allows its agents (`Settings::mcp_servers`), and how each CLI is given
//! exactly those and no others.
//!
//! A server is defined once, here, and translated per CLI: a `--mcp-config` file for Claude Code,
//! `-c mcp_servers.<name>=…` overrides for Codex, a settings file for Gemini CLI. Secrets (an
//! environment variable's value, a header) never go on a command line, where any local process
//! could read them: they go in a file only the user can read, deleted after the run, or in the
//! CLI's environment, referred to by name.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// One MCP server an agent may use.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum McpServer {
    /// A program the CLI starts, talking over stdin and stdout.
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
    },
    /// A server reached over HTTP (streamable HTTP).
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
}

/// The servers by name, as in settings.
pub type McpServers = BTreeMap<String, McpServer>;

/// A file a run needs (an MCP config, a schema), written before it starts, readable only by the
/// user, and deleted when it ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunFile {
    pub path: PathBuf,
    pub contents: String,
}

/// Claude Code's `--mcp-config` file: `{"mcpServers": {...}}`.
pub fn claude_config(servers: &McpServers) -> String {
    let entries: serde_json::Map<String, Value> = servers
        .iter()
        .map(|(name, server)| {
            let entry = match server {
                McpServer::Stdio { command, args, env } => {
                    json!({ "type": "stdio", "command": command, "args": args, "env": env })
                }
                McpServer::Http { url, headers } => {
                    json!({ "type": "http", "url": url, "headers": headers })
                }
            };
            (name.clone(), entry)
        })
        .collect();
    json!({ "mcpServers": entries }).to_string()
}

/// Gemini CLI's settings file with these servers (`mcpServers`), for
/// `GEMINI_CLI_SYSTEM_SETTINGS_PATH`.
pub fn gemini_settings(servers: &McpServers) -> String {
    let entries: serde_json::Map<String, Value> = servers
        .iter()
        .map(|(name, server)| {
            let entry = match server {
                McpServer::Stdio { command, args, env } => {
                    json!({ "command": command, "args": args, "env": env })
                }
                McpServer::Http { url, headers } => json!({ "httpUrl": url, "headers": headers }),
            };
            (name.clone(), entry)
        })
        .collect();
    json!({ "mcpServers": entries }).to_string()
}

/// Codex's `-c` overrides for these servers, and the environment the values they name come from.
///
/// A stdio server's variables are forwarded by name (`env_vars`), their values set in Codex's own
/// environment, so the commands the agent runs see them too (a Codex limit: it takes no file of
/// its own for them); `validate_servers` keeps them away from the variables that matter. An HTTP server's headers come from variables too (`env_http_headers`), named
/// `CODE_AUTOMATA_MCP_<n>_<m>`.
pub fn codex_overrides(servers: &McpServers) -> (Vec<String>, Vec<(String, String)>) {
    let mut args = Vec::new();
    let mut env = Vec::new();
    for (index, (name, server)) in servers.iter().enumerate() {
        let table = match server {
            McpServer::Stdio {
                command,
                args: argv,
                env: vars,
            } => {
                for (k, v) in vars {
                    env.push((k.clone(), v.clone()));
                }
                format!(
                    "{{command={},args={},env_vars={}}}",
                    toml_string(command),
                    toml_array(argv.iter()),
                    toml_array(vars.keys())
                )
            }
            McpServer::Http { url, headers } => {
                let mut pairs = Vec::new();
                for (i, (header, value)) in headers.iter().enumerate() {
                    let var = format!("CODE_AUTOMATA_MCP_{index}_{i}");
                    pairs.push(format!("{}={}", toml_string(header), toml_string(&var)));
                    env.push((var, value.clone()));
                }
                format!(
                    "{{url={},env_http_headers={{{}}}}}",
                    toml_string(url),
                    pairs.join(",")
                )
            }
        };
        args.push("-c".to_string());
        args.push(format!("mcp_servers.{}={table}", toml_key(name)));
    }
    (args, env)
}

/// A TOML basic string.
pub(crate) fn toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn toml_array<'a>(items: impl Iterator<Item = &'a String>) -> String {
    let items: Vec<String> = items.map(|s| toml_string(s)).collect();
    format!("[{}]", items.join(","))
}

/// A bare TOML key when the name allows one, else a quoted one.
fn toml_key(name: &str) -> String {
    if !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        name.to_string()
    } else {
        toml_string(name)
    }
}

/// Variables a server may not set: Codex gets a stdio server's variables in its own environment
/// (it forwards them by name), where these would change how Codex, git and the agent's commands
/// run, or bring back an API key the run removed.
const RESERVED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "PWD",
    "NODE_OPTIONS",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "CURSOR_API_KEY",
];

/// Prefixes of variables a server may not set either: the app's own, the dynamic loader's (which
/// would load code into every program), git's and ssh's (which would change every commit and push).
const RESERVED_PREFIXES: &[&str] = &["CODE_AUTOMATA_", "LD_", "DYLD_", "GIT_", "SSH_"];

/// Where [`import_candidates`] says it found Gemini CLI's servers.
pub const GEMINI_SOURCE: &str = "Gemini CLI";

/// The allowlist as a whole: plain names, a command or address each, and variables that can be
/// put in an agent's environment (an identifier, not reserved, and one value across all servers).
pub fn validate_servers(servers: &McpServers) -> Result<(), String> {
    let mut seen: BTreeMap<&str, (&str, &str)> = BTreeMap::new();
    for (name, server) in servers {
        validate_name(name)?;
        match server {
            McpServer::Stdio { command, env, .. } => {
                if command.trim().is_empty() {
                    return Err(format!("MCP server {name:?} needs a command"));
                }
                for (var, value) in env {
                    let identifier = var
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                        && var.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
                    if !identifier {
                        return Err(format!(
                            "MCP server {name:?}: {var:?} is not a variable name"
                        ));
                    }
                    let upper = var.to_ascii_uppercase();
                    if RESERVED_ENV.contains(&upper.as_str())
                        || RESERVED_PREFIXES.iter().any(|p| upper.starts_with(p))
                    {
                        return Err(format!(
                            "MCP server {name:?} may not set {var}: it would change how the agent \
                             itself runs"
                        ));
                    }
                    match seen.get(var.as_str()) {
                        Some((other, v)) if *v != value.as_str() => {
                            return Err(format!(
                                "MCP servers {other:?} and {name:?} set {var} to different values"
                            ));
                        }
                        _ => {
                            seen.insert(var, (name, value));
                        }
                    }
                }
            }
            McpServer::Http { url, .. } => {
                if url.trim().is_empty() {
                    return Err(format!("MCP server {name:?} needs an address"));
                }
            }
        }
    }
    Ok(())
}

/// A server name must be a plain identifier: it becomes a JSON key and a TOML key.
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("an MCP server name must be 1 to 64 characters".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "MCP server name {name:?} may only hold letters, digits, '-' and '_'"
        ));
    }
    Ok(())
}

/// An MCP server found in a CLI's or the project's own configuration, offered for the allowlist.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCandidate {
    /// Where it was found ("Claude Code", ".mcp.json", …).
    pub source: String,
    pub name: String,
    pub server: McpServer,
}

/// The MCP servers already configured on this computer and in the project, for the settings'
/// Import: Claude Code's (`~/.claude.json`, for the user and for this project), the project's
/// `.mcp.json` (and each workspace repository's), Codex's (`~/.codex/config.toml`) and Gemini
/// CLI's (`~/.gemini/settings.json`). Only stdio and HTTP servers; nothing is read but these files.
pub fn import_candidates(
    home: Option<&std::path::Path>,
    project_root: &std::path::Path,
    repo_roots: &[(String, PathBuf)],
) -> Vec<McpCandidate> {
    let mut out = Vec::new();
    // Gemini's `url` is an SSE server; only its `httpUrl` is streamable HTTP.
    let mut add = |source: &str, servers: Option<&Value>| {
        if let Some(Value::Object(servers)) = servers {
            for (name, entry) in servers {
                let gemini = source == GEMINI_SOURCE;
                if gemini && entry.get("httpUrl").is_none() && entry.get("command").is_none() {
                    continue;
                }
                // A name the settings would refuse is not offered.
                if validate_name(name).is_err() {
                    continue;
                }
                if let Some(server) = from_json(entry) {
                    out.push(McpCandidate {
                        source: source.to_string(),
                        name: name.clone(),
                        server,
                    });
                }
            }
        }
    };
    let read_json = |path: PathBuf| -> Option<Value> {
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
    };
    if let Some(home) = home
        && let Some(claude) = read_json(home.join(".claude.json"))
    {
        add("Claude Code", claude.get("mcpServers"));
        let key = project_root.to_string_lossy();
        add(
            "Claude Code (this project)",
            claude
                .get("projects")
                .and_then(|p| p.get(key.as_ref()))
                .and_then(|p| p.get("mcpServers")),
        );
    }
    if let Some(project) = read_json(project_root.join(".mcp.json")) {
        add(".mcp.json", project.get("mcpServers"));
    }
    for (name, root) in repo_roots {
        if root != project_root
            && let Some(repo) = read_json(root.join(".mcp.json"))
        {
            add(&format!("{name}/.mcp.json"), repo.get("mcpServers"));
        }
    }
    if let Some(home) = home {
        if let Ok(text) = std::fs::read_to_string(home.join(".codex").join("config.toml"))
            && let Ok(config) = text.parse::<toml::Table>()
            && let Ok(json) = serde_json::to_value(config.get("mcp_servers"))
        {
            add("Codex", Some(&json));
        }
        if let Some(gemini) = read_json(home.join(".gemini").join("settings.json")) {
            add(GEMINI_SOURCE, gemini.get("mcpServers"));
        }
    }
    out
}

/// One server entry as Claude Code, Codex, Gemini CLI and `.mcp.json` write it: `command`, `args`,
/// `env` for a program; `url` (Gemini: `httpUrl`) and `headers` (Codex: `http_headers`) for HTTP.
/// SSE servers and anything else are left out.
fn from_json(entry: &Value) -> Option<McpServer> {
    let strings = |v: Option<&Value>| -> BTreeMap<String, String> {
        v.and_then(Value::as_object)
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    };
    if let Some(command) = entry.get("command").and_then(Value::as_str) {
        let args = entry
            .get("args")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        return Some(McpServer::Stdio {
            command: command.to_string(),
            args,
            env: strings(entry.get("env")),
        });
    }
    if entry.get("type").and_then(Value::as_str) == Some("sse") {
        return None;
    }
    let url = entry
        .get("url")
        .or_else(|| entry.get("httpUrl"))
        .and_then(Value::as_str)?;
    Some(McpServer::Http {
        url: url.to_string(),
        headers: strings(entry.get("headers").or_else(|| entry.get("http_headers"))),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn servers() -> McpServers {
        let mut s = McpServers::new();
        s.insert(
            "browser".into(),
            McpServer::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "@playwright/mcp".into()],
                env: BTreeMap::from([("TOKEN".into(), "se\"cret".into())]),
            },
        );
        s.insert(
            "docs".into(),
            McpServer::Http {
                url: "https://example.com/mcp".into(),
                headers: BTreeMap::from([("Authorization".into(), "Bearer abc".into())]),
            },
        );
        s
    }

    #[test]
    fn settings_shape_round_trips_and_is_strict() {
        let json = serde_json::to_value(servers()).unwrap();
        assert_eq!(json["browser"]["type"], "stdio");
        assert_eq!(json["docs"]["type"], "http");
        let back: McpServers = serde_json::from_value(json).unwrap();
        assert_eq!(back, servers());
        let bad = json!({ "x": { "type": "stdio", "command": "a", "cwd": "/" } });
        assert!(serde_json::from_value::<McpServers>(bad).is_err());
    }

    #[test]
    fn claude_and_gemini_files_hold_every_server() {
        let claude: Value = serde_json::from_str(&claude_config(&servers())).unwrap();
        assert_eq!(claude["mcpServers"]["browser"]["command"], "npx");
        assert_eq!(claude["mcpServers"]["docs"]["type"], "http");
        let gemini: Value = serde_json::from_str(&gemini_settings(&servers())).unwrap();
        assert_eq!(
            gemini["mcpServers"]["docs"]["httpUrl"],
            "https://example.com/mcp"
        );
        assert_eq!(gemini["mcpServers"]["browser"]["env"]["TOKEN"], "se\"cret");
    }

    #[test]
    fn codex_gets_no_secret_in_its_arguments() {
        let (args, env) = codex_overrides(&servers());
        assert_eq!(
            args,
            [
                "-c",
                r#"mcp_servers.browser={command="npx",args=["-y","@playwright/mcp"],env_vars=["TOKEN"]}"#,
                "-c",
                r#"mcp_servers.docs={url="https://example.com/mcp",env_http_headers={"Authorization"="CODE_AUTOMATA_MCP_1_0"}}"#,
            ]
        );
        assert!(!args.iter().any(|a| a.contains("cret") || a.contains("abc")));
        assert_eq!(
            env,
            [
                ("TOKEN".to_string(), "se\"cret".to_string()),
                (
                    "CODE_AUTOMATA_MCP_1_0".to_string(),
                    "Bearer abc".to_string()
                )
            ]
        );
    }

    #[test]
    fn names_are_plain() {
        assert!(validate_name("browser_1").is_ok());
        assert!(validate_name("a.b").is_err());
        assert!(validate_name("").is_err());
    }

    #[test]
    fn import_reads_each_cli_and_the_project() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().into_owned();
        std::fs::write(
            home.path().join(".claude.json"),
            json!({
                "mcpServers": { "browser": { "type": "stdio", "command": "npx", "args": ["-y", "pw"] } },
                "projects": { root: { "mcpServers": { "db": { "command": "pg", "env": { "U": "me" } } } } }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            project.path().join(".mcp.json"),
            json!({ "mcpServers": {
                "docs": { "type": "http", "url": "https://d/mcp", "headers": { "A": "b" } },
                "old": { "type": "sse", "url": "https://s/sse" },
                "bad.name": { "command": "x" }
            }})
            .to_string(),
        )
        .unwrap();
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        std::fs::write(
            home.path().join(".codex/config.toml"),
            "model = \"x\"\n[mcp_servers.linear]\nurl = \"https://l/mcp\"\n[mcp_servers.fs]\ncommand = \"fs-mcp\"\nargs = [\"/tmp\"]\n",
        )
        .unwrap();
        std::fs::create_dir_all(home.path().join(".gemini")).unwrap();
        std::fs::write(
            home.path().join(".gemini/settings.json"),
            json!({ "mcpServers": {
                "g": { "httpUrl": "https://g/mcp" },
                "sse": { "url": "https://g/sse" }
            } })
            .to_string(),
        )
        .unwrap();

        let found = import_candidates(Some(home.path()), project.path(), &[]);
        let names: Vec<(&str, &str)> = found
            .iter()
            .map(|c| (c.source.as_str(), c.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("Claude Code", "browser"),
                ("Claude Code (this project)", "db"),
                (".mcp.json", "docs"),
                ("Codex", "fs"),
                ("Codex", "linear"),
                ("Gemini CLI", "g"),
            ]
        );
        assert_eq!(
            found[1].server,
            McpServer::Stdio {
                command: "pg".into(),
                args: vec![],
                env: BTreeMap::from([("U".into(), "me".into())])
            }
        );
        assert!(matches!(&found[5].server, McpServer::Http { url, .. } if url == "https://g/mcp"));
        assert!(import_candidates(None, project.path(), &[]).len() == 1);
    }

    #[test]
    fn variables_that_would_change_the_agent_or_collide_are_refused() {
        assert!(validate_servers(&servers()).is_ok());
        let stdio = |var: &str, value: &str| McpServer::Stdio {
            command: "x".into(),
            args: vec![],
            env: BTreeMap::from([(var.to_string(), value.to_string())]),
        };
        for var in [
            "PATH",
            "path",
            "OPENAI_API_KEY",
            "CODE_AUTOMATA_X",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "GIT_DIR",
            "SSH_AUTH_SOCK",
            "1BAD",
            "A-B",
        ] {
            let one = McpServers::from([("a".to_string(), stdio(var, "v"))]);
            assert!(validate_servers(&one).is_err(), "{var} was accepted");
        }
        let same = McpServers::from([
            ("a".to_string(), stdio("TOKEN", "1")),
            ("b".to_string(), stdio("TOKEN", "1")),
        ]);
        assert!(validate_servers(&same).is_ok());
        let clash = McpServers::from([
            ("a".to_string(), stdio("TOKEN", "1")),
            ("b".to_string(), stdio("TOKEN", "2")),
        ]);
        let err = validate_servers(&clash).unwrap_err();
        assert!(err.contains("different values"), "{err}");
    }
}
