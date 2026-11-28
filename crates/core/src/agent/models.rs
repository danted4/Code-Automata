//! The models each CLI offers, for the task dialog's dropdowns.
//!
//! A CLI that can list its models is asked (Cursor `models`, Gemini `--list-models`), and Codex's
//! own cache of the server's list is read; that list is what the account can use today. Claude
//! Code and Amp cannot list theirs, so a short curated list ships with the app, as it does for a
//! CLI whose listing fails. The dialog always adds "Default" (the CLI picks) and "Other…" (a typed
//! id), so a new model works before the app knows it.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::Binaries;
use crate::task::Provider;

const LIST_TIMEOUT: Duration = Duration::from_secs(15);

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    /// What is passed to the CLI (`--model`).
    pub id: String,
    pub label: String,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelSource {
    /// Listed by the CLI for this account.
    Cli,
    /// The app's own list (the CLI cannot list its models, or listing failed).
    Curated,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    pub provider: Provider,
    pub models: Vec<ModelOption>,
    pub source: ModelSource,
}

fn option(id: &str, label: &str) -> ModelOption {
    ModelOption {
        id: id.to_string(),
        label: label.to_string(),
    }
}

/// The app's own list for `provider`.
pub fn curated(provider: Provider) -> Vec<ModelOption> {
    match provider {
        Provider::Claude => vec![
            option("claude-fable-5-2", "Fable 5.2"),
            option("claude-opus-5-5", "Opus 5.5"),
            option("claude-sonnet-5-5", "Sonnet 5.5"),
            option("claude-haiku-5-5", "Haiku 5.5"),
        ],
        Provider::Codex => vec![
            option("gpt-6.2-sol", "GPT-6.2 Sol"),
            option("gpt-6.2-astra", "GPT-6.2 Astra"),
            option("gpt-6.1-sol", "GPT-6.1 Sol"),
        ],
        Provider::Gemini => vec![
            option("auto", "Auto"),
            option("pro", "Pro"),
            option("flash", "Flash"),
        ],
        Provider::Mock => vec![option("mock", "Mock")],
        // Amp picks through its modes; Cursor's list depends on the account.
        Provider::Amp | Provider::Cursor => Vec::new(),
    }
}

/// The models for `provider`: the CLI's own list when it can give one, else the curated list.
pub async fn list(provider: Provider, bins: &Binaries) -> ModelList {
    let listed = match provider {
        Provider::Cursor => run_list(provider, bins, &["models"])
            .await
            .map(|out| parse_cursor(&out)),
        Provider::Gemini => run_list(provider, bins, &["--list-models", "-o", "json"])
            .await
            .and_then(|out| serde_json::from_str::<Value>(&out).ok())
            .map(|json| parse_json_models(&json)),
        Provider::Codex => bins.home().and_then(read_codex_cache),
        Provider::Claude | Provider::Amp | Provider::Mock => None,
    };
    match listed.filter(|m| !m.is_empty()) {
        Some(models) => ModelList {
            provider,
            models,
            source: ModelSource::Cli,
        },
        None => ModelList {
            provider,
            models: curated(provider),
            source: ModelSource::Curated,
        },
    }
}

async fn run_list(provider: Provider, bins: &Binaries, args: &[&str]) -> Option<String> {
    let binary = bins.locate(provider).ok()?;
    let (program, launch_args) = bins.launch(&binary);
    let mut cmd = crate::proc::command(&program);
    cmd.args(&launch_args)
        .args(args)
        .stdin(std::process::Stdio::null())
        .env("NO_COLOR", "1")
        .kill_on_drop(true);
    if let Some(path) = bins.path_var() {
        cmd.env("PATH", path);
    }
    let out = tokio::time::timeout(LIST_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Cursor's `models` prints one model per line, its id first ("gpt-5 - GPT-5", "• sonnet-4.5
/// (current)"), under a heading.
pub fn parse_cursor(text: &str) -> Vec<ModelOption> {
    let mut models = Vec::new();
    for line in text.lines() {
        let line = line.trim().trim_start_matches(['-', '*', '•', ' ']);
        if line.is_empty() || line.ends_with(':') || line.to_lowercase().starts_with("available") {
            continue;
        }
        let Some(id) = line.split_whitespace().next() else {
            continue;
        };
        let plausible = id.chars().any(|c| c.is_ascii_alphabetic())
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-:/[]=,".contains(c));
        if !plausible || models.iter().any(|m: &ModelOption| m.id == id) {
            continue;
        }
        let rest = line[id.len()..]
            .trim()
            .trim_start_matches(['-', '–', '—'])
            .trim();
        let label = if rest.is_empty() || rest.starts_with('(') {
            id.to_string()
        } else {
            rest.to_string()
        };
        models.push(option(id, &label));
    }
    models
}

/// A JSON model list in any of the shapes CLIs use: an array of ids, or of objects with an id
/// (`id`, `name`, `slug`, `model`) and maybe a label (`displayName`, `display_name`, `label`),
/// possibly under a `models` key.
pub fn parse_json_models(json: &Value) -> Vec<ModelOption> {
    let items = json
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| json.as_array());
    let Some(items) = items else {
        return Vec::new();
    };
    let mut models: Vec<ModelOption> = Vec::new();
    for item in items {
        let (id, label) = match item {
            Value::String(id) => (id.clone(), id.clone()),
            Value::Object(o) => {
                let id = ["slug", "id", "name", "model"]
                    .iter()
                    .find_map(|k| o.get(*k).and_then(Value::as_str));
                let Some(id) = id else { continue };
                let label = ["displayName", "display_name", "label"]
                    .iter()
                    .find_map(|k| o.get(*k).and_then(Value::as_str))
                    .unwrap_or(id);
                (id.to_string(), label.to_string())
            }
            _ => continue,
        };
        if !id.is_empty() && !models.iter().any(|m| m.id == id) {
            models.push(ModelOption { id, label });
        }
    }
    models
}

/// Codex keeps the server's model list for the account in `$CODEX_HOME` (default `~/.codex`).
fn read_codex_cache(home: &Path) -> Option<Vec<ModelOption>> {
    let dir = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".codex"));
    ["models_cache.json", "models.json"]
        .iter()
        .find_map(|name| {
            let text = std::fs::read_to_string(dir.join(name)).ok()?;
            let json = serde_json::from_str::<Value>(&text).ok()?;
            Some(parse_json_models(&json)).filter(|m| !m.is_empty())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cursor_lines_give_ids_and_labels() {
        let text = "Available models:\n\n  - auto - Auto\n  • gpt-5 (current)\n  sonnet-4.5-thinking - Claude 4.5 Sonnet Thinking\n";
        let models = parse_cursor(text);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["auto", "gpt-5", "sonnet-4.5-thinking"]);
        assert_eq!(models[0].label, "Auto");
        assert_eq!(models[1].label, "gpt-5");
        assert_eq!(models[2].label, "Claude 4.5 Sonnet Thinking");
    }

    #[test]
    fn json_lists_in_their_shapes() {
        let strings = parse_json_models(&json!(["gemini-3.5-flash", "gemini-3-pro-preview"]));
        assert_eq!(strings.len(), 2);
        let objects = parse_json_models(&json!({ "models": [
            { "slug": "gpt-6.2-sol", "display_name": "GPT-6.2 Sol" },
            { "name": "x" },
            { "nothing": 1 }
        ]}));
        assert_eq!(objects[0], option("gpt-6.2-sol", "GPT-6.2 Sol"));
        assert_eq!(objects[1], option("x", "x"));
        assert_eq!(objects.len(), 2);
        assert!(parse_json_models(&json!({ "a": 1 })).is_empty());
    }

    #[test]
    fn claude_and_amp_are_curated() {
        assert_eq!(curated(Provider::Claude)[0].id, "claude-fable-5-2");
        assert!(curated(Provider::Amp).is_empty());
    }
}
