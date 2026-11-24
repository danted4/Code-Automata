//! The stream parsers against real (sanitized) output captured from each CLI.
#![allow(clippy::unwrap_used)]

use ca_core::agent::cursor::CursorParser;
use ca_core::agent::stream_json::StreamJson;
use ca_core::agent::{AgentEvent, LineParser, Parsed, ResultInfo};

struct Parsed_ {
    events: Vec<AgentEvent>,
    result: Option<ResultInfo>,
}

fn parse(name: &str, mut parser: impl LineParser) -> Parsed_ {
    let path = format!(
        "{}/tests/fixtures/streams/{name}.ndjson",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut events = Vec::new();
    let mut result = None;
    for line in std::fs::read_to_string(path).unwrap().lines() {
        for p in parser.parse(line) {
            match p {
                Parsed::Event(e) => events.push(e),
                Parsed::Result(r) => {
                    assert!(result.is_none(), "{name}: two result events");
                    result = Some(r);
                }
            }
        }
    }
    let sessions = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Session { .. }))
        .count();
    assert_eq!(sessions, 1, "{name}: session reported {sessions} times");
    Parsed_ { events, result }
}

fn tool_names(events: &[AgentEvent]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolUse { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect()
}

fn texts(events: &[AgentEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn claude_killed_run_has_no_result() {
    let p = parse("claude-killed", StreamJson::default());
    assert!(p.result.is_none());
    assert_eq!(tool_names(&p.events)[0], "Write");
}

#[test]
fn claude_resumed_run_completes() {
    let p = parse("claude-resumed", StreamJson::default());
    let r = p.result.unwrap();
    assert!(r.succeeded());
    assert!(r.text.unwrap().contains("DONE"));
    assert!(r.cost_usd.is_some());
    assert!(r.turns.is_some());
}

#[test]
fn claude_structured_output_is_read() {
    let p = parse("claude-structured", StreamJson::default());
    let r = p.result.unwrap();
    assert!(r.succeeded());
    let s = r.structured.unwrap();
    assert_eq!(s["echo"], "hi");
    assert!(tool_names(&p.events).contains(&"Bash"));
    let results = p
        .events
        .iter()
        .filter(|e| matches!(e, AgentEvent::ToolResult { .. }))
        .count();
    assert!(results >= 1);
}

#[test]
fn claude_read_only_refusal_still_succeeds_with_an_answer() {
    let p = parse("claude-readonly", StreamJson::default());
    let r = p.result.unwrap();
    assert!(
        r.succeeded(),
        "the turn succeeds even though the write was refused"
    );
    assert!(r.text.unwrap().contains("couldn't"));
}

#[test]
fn cursor_killed_run_has_no_result() {
    let p = parse("cursor-killed", CursorParser::default());
    assert!(p.result.is_none());
}

#[test]
fn cursor_resumed_run_completes() {
    let p = parse("cursor-resumed", CursorParser::default());
    assert!(p.result.unwrap().succeeded());
    assert!(!tool_names(&p.events).is_empty());
}

#[test]
fn cursor_ask_mode_answers_in_text() {
    let p = parse("cursor-ask", CursorParser::default());
    let r = p.result.unwrap();
    assert!(r.succeeded());
    assert!(r.text.unwrap().contains("Ask mode"));
    assert_eq!(tool_names(&p.events), ["read"]);
}

#[test]
fn cursor_tool_calls_become_tool_events() {
    let p = parse("cursor-shell", CursorParser::default());
    let uses: Vec<_> = p
        .events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolUse { name, input, .. } => Some((name.clone(), input.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(uses[0].0, "shell");
    assert_eq!(uses[0].1["command"], "printf hi > c.txt");
    assert!(
        p.events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolResult { .. }))
    );
    assert!(!texts(&p.events).is_empty());
}

#[test]
fn amp_killed_run_reports_an_error_result() {
    let p = parse("amp-killed", StreamJson::default());
    let r = p.result.unwrap();
    assert_eq!(r.subtype.as_deref(), Some("error_during_execution"));
    assert!(r.is_error);
    assert!(!r.succeeded());
}

#[test]
fn amp_blocked_turn_reports_success_but_tool_errors_are_visible() {
    let p = parse("amp-blocked", StreamJson::default());
    assert!(
        p.result.unwrap().succeeded(),
        "Amp calls this success; judging the work is the engine's job"
    );
    assert_eq!(tool_names(&p.events), ["shell_command", "apply_patch"]);
}

#[test]
fn amp_runs_complete() {
    for name in ["amp-resumed", "amp-shell"] {
        let p = parse(name, StreamJson::default());
        assert!(p.result.unwrap().succeeded(), "{name}");
        assert!(texts(&p.events).contains("DONE"), "{name}");
    }
}
