//! Parser for Claude Code's stream-json, which Amp (`--stream-json`) and the mock agent also emit.
//!
//! Each line is one JSON object with a `type`:
//!
//! * `system` (`init` carries the session id; hook and token events are ignored);
//! * `assistant`, holding content blocks `text`, `thinking` or `tool_use`;
//! * `user`, carrying `tool_result` blocks;
//! * `rate_limit_event` (Claude), whose `rejected` status carries when a usage limit resets;
//! * `result`, the final line. Amp puts an error's text in `error` rather than `result`.
//!
//! Lines that are not JSON, and types this parser does not know, are ignored rather than fatal:
//! the raw line is still in the run log.

use serde_json::Value;

use super::limits::{self, RateLimit};
use super::{AgentEvent, LineParser, Parsed, ResultInfo};

/// Tool result summaries are cut to this many characters; the full text stays in the log.
const SUMMARY_CHARS: usize = 300;

#[derive(Debug, Default)]
pub struct StreamJson {
    session_reported: bool,
    /// A `rate_limit_event` said the usage limit was reached, resetting at this time if given.
    rejected: Option<Option<i64>>,
    /// Amp's wording for its limits (the others are Claude's or the mock's).
    amp: bool,
}

impl StreamJson {
    /// For Amp's output.
    pub fn amp() -> Self {
        StreamJson {
            amp: true,
            ..Self::default()
        }
    }
}

impl StreamJson {
    fn session(&mut self, msg: &Value, out: &mut Vec<Parsed>) {
        if self.session_reported {
            return;
        }
        if let Some(id) = msg.get("session_id").and_then(Value::as_str)
            && !id.is_empty()
        {
            self.session_reported = true;
            out.push(Parsed::Event(AgentEvent::Session { id: id.to_string() }));
        }
    }
}

impl LineParser for StreamJson {
    fn parse(&mut self, line: &str) -> Vec<Parsed> {
        let mut out = Vec::new();
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return out;
        };
        self.session(&msg, &mut out);
        match msg.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                for block in content_blocks(&msg) {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) = block.get("text").and_then(Value::as_str)
                                && !text.is_empty()
                            {
                                out.push(Parsed::Event(AgentEvent::Text {
                                    text: text.to_string(),
                                }));
                            }
                        }
                        Some("thinking") => {
                            if let Some(text) = block.get("thinking").and_then(Value::as_str)
                                && !text.is_empty()
                            {
                                out.push(Parsed::Event(AgentEvent::Thinking {
                                    text: text.to_string(),
                                }));
                            }
                        }
                        Some("tool_use") => out.push(Parsed::Event(AgentEvent::ToolUse {
                            id: str_field(block, "id"),
                            name: str_field(block, "name"),
                            input: block.get("input").cloned().unwrap_or(Value::Null),
                        })),
                        _ => {}
                    }
                }
            }
            Some("user") => {
                for block in content_blocks(&msg) {
                    if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                        out.push(Parsed::Event(AgentEvent::ToolResult {
                            id: str_field(block, "tool_use_id"),
                            is_error: block
                                .get("is_error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            summary: summarize(block.get("content")),
                        }));
                    }
                }
            }
            Some("rate_limit_event") => {
                let info = msg.get("rate_limit_info");
                if info.and_then(|i| i.get("status")).and_then(Value::as_str) == Some("rejected") {
                    self.rejected =
                        Some(info.and_then(|i| i.get("resetsAt")).and_then(Value::as_i64));
                }
            }
            Some("result") => out.push(Parsed::Result(self.result(&msg))),
            _ => {}
        }
        out
    }
}

impl StreamJson {
    fn result(&self, msg: &Value) -> ResultInfo {
        let is_error = msg
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let text = ["result", "error"]
            .iter()
            .find_map(|k| msg.get(*k).and_then(Value::as_str))
            .filter(|t| !t.trim().is_empty())
            .map(String::from);
        // Claude reports an API 429 that outlasted its own retries this way too.
        let http_429 = msg.get("api_error_status").and_then(Value::as_u64) == Some(429);
        let rate_limit = if !is_error {
            None
        } else if let Some(resets_at) = self.rejected.or(http_429.then_some(None)) {
            // The structured time wins; the text is the fallback for when it is missing.
            let from_text = text
                .as_deref()
                .and_then(|t| limits::claude_text(t, &limits::local_now()));
            Some(RateLimit {
                resets_at: resets_at.or(from_text.and_then(|l| l.resets_at)),
            })
        } else {
            text.as_deref().and_then(|t| {
                if self.amp {
                    limits::amp_text(t)
                } else {
                    limits::claude_text(t, &limits::local_now())
                }
            })
        };
        ResultInfo {
            subtype: msg.get("subtype").and_then(Value::as_str).map(String::from),
            is_error,
            text,
            session_id: msg
                .get("session_id")
                .and_then(Value::as_str)
                .map(String::from),
            structured: msg
                .get("structured_output")
                .filter(|v| !v.is_null())
                .cloned(),
            turns: msg
                .get("num_turns")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok()),
            cost_usd: msg.get("total_cost_usd").and_then(Value::as_f64),
            rate_limit,
        }
    }
}

fn content_blocks(msg: &Value) -> &[Value] {
    msg.get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

pub(crate) fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// A short, single-string view of a tool result, whatever shape the content has.
pub(crate) fn summarize(content: Option<&Value>) -> String {
    let text = match content {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|p| match p.get("text").and_then(Value::as_str) {
                Some(t) => t.to_string(),
                None => p.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
    };
    text.chars().take(SUMMARY_CHARS).collect()
}
