//! `mock-agent`: a scripted stand-in for an agent CLI, for tests and dev builds.
//!
//! Speaks Claude Code's stream-json on stdout and takes the same session flags:
//!
//! ```text
//! mock-agent --scenario <file> [--session-id <id> | --resume <id>] [--record <file>] [--read-only]
//! ```
//!
//! The prompt is read from stdin. The scenario is JSON: `{"steps": [...], "resumeSteps": [...]}`;
//! `resumeSteps`, when present, replaces `steps` for a `--resume` invocation. Each step is one of:
//!
//! | Step | Effect |
//! | --- | --- |
//! | `{"text": "…"}` | assistant text |
//! | `{"thinking": "…"}` | assistant thinking |
//! | `{"tool": {"name", "input", "output", "isError", "durationMs"}}` | a tool_use, a silent pause of `durationMs`, then its tool_result |
//! | `{"invalidUtf8": "stdout" \| "stderr"}` | a line of bytes that are not UTF-8 |
//! | `{"write": {"path", "content"}}` | write a file under the cwd (refused with `--read-only`) |
//! | `{"stderr": "…"}` | a line on stderr |
//! | `{"sleepMs": n}` | pause |
//! | `{"spawnChild": {"command", "pidFile"}}` | start `sh -c command` (inheriting stdout) and write its pid |
//! | `{"result": {"subtype", "text", "isError", "structured"}}` | the final result line |
//! | `{"exit": n}` | exit now with code n |
//! | `{"hang": true}` | never finish |
//!
//! Each invocation is appended to the `--record` file as one JSON line: the arguments, the prompt,
//! the cwd and whether it was a resume.

use std::io::{Read, Write};
use std::time::Duration;

use serde_json::{Value, json};

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let Some(scenario_path) = flag("--scenario") else {
        eprintln!("mock-agent: --scenario <file> is required");
        return 2;
    };
    let resume = flag("--resume");
    let session_id = resume
        .clone()
        .or_else(|| flag("--session-id"))
        .unwrap_or_else(|| "mock-session".to_string());
    let read_only = args.iter().any(|a| a == "--read-only");

    let mut prompt = String::new();
    let _ = std::io::stdin().read_to_string(&mut prompt);

    if let Some(record) = flag("--record") {
        let cwd = std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let line =
            json!({ "args": args, "prompt": prompt, "cwd": cwd, "resume": resume.is_some() });
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(record)
        {
            let _ = writeln!(f, "{line}");
        }
    }

    let scenario: Value = match std::fs::read_to_string(&scenario_path)
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!("mock-agent: cannot read scenario {scenario_path}: {e}");
            return 2;
        }
    };
    let steps = match (resume.is_some(), scenario.get("resumeSteps")) {
        (true, Some(Value::Array(s))) => s.clone(),
        _ => scenario
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    };

    emit(&json!({ "type": "system", "subtype": "init", "session_id": session_id }));
    for (n, step) in steps.iter().enumerate() {
        if let Some(text) = step.get("text").and_then(Value::as_str) {
            assistant(&session_id, json!({ "type": "text", "text": text }));
        } else if let Some(text) = step.get("thinking").and_then(Value::as_str) {
            assistant(&session_id, json!({ "type": "thinking", "thinking": text }));
        } else if let Some(tool) = step.get("tool") {
            let id = format!("tool-{n}");
            assistant(
                &session_id,
                json!({ "type": "tool_use", "id": id, "name": tool.get("name"), "input": tool.get("input") }),
            );
            if let Some(ms) = tool.get("durationMs").and_then(Value::as_u64) {
                std::thread::sleep(Duration::from_millis(ms));
            }
            tool_result(
                &session_id,
                &id,
                tool.get("output").and_then(Value::as_str).unwrap_or(""),
                tool.get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            );
        } else if let Some(write) = step.get("write") {
            let id = format!("tool-{n}");
            let path = write
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("out.txt");
            assistant(
                &session_id,
                json!({ "type": "tool_use", "id": id, "name": "Write", "input": { "file_path": path } }),
            );
            if read_only {
                tool_result(
                    &session_id,
                    &id,
                    "Write is not available in read-only mode",
                    true,
                );
            } else {
                let content = write.get("content").and_then(Value::as_str).unwrap_or("");
                match std::fs::write(path, content) {
                    Ok(()) => tool_result(&session_id, &id, "written", false),
                    Err(e) => tool_result(&session_id, &id, &e.to_string(), true),
                }
            }
        } else if let Some(stream) = step.get("invalidUtf8").and_then(Value::as_str) {
            let bytes: &[u8] = b"\xff\xfe not utf-8 \xc3\x28\n";
            if stream == "stderr" {
                let _ = std::io::stderr().write_all(bytes);
            } else {
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(bytes);
                let _ = out.flush();
            }
        } else if let Some(line) = step.get("stderr").and_then(Value::as_str) {
            eprintln!("{line}");
        } else if let Some(ms) = step.get("sleepMs").and_then(Value::as_u64) {
            std::thread::sleep(Duration::from_millis(ms));
        } else if let Some(child) = step.get("spawnChild") {
            let command = child
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("sleep 60");
            match std::process::Command::new("sh")
                .arg("-c")
                .arg(command)
                .spawn()
            {
                Ok(c) => {
                    if let Some(pid_file) = child.get("pidFile").and_then(Value::as_str) {
                        let _ = std::fs::write(pid_file, c.id().to_string());
                    }
                }
                Err(e) => eprintln!("mock-agent: spawn failed: {e}"),
            }
        } else if let Some(result) = step.get("result") {
            emit(&json!({
                "type": "result",
                "subtype": result.get("subtype").and_then(Value::as_str).unwrap_or("success"),
                "is_error": result.get("isError").and_then(Value::as_bool).unwrap_or(false),
                "result": result.get("text").and_then(Value::as_str).unwrap_or(""),
                "structured_output": result.get("structured").cloned().unwrap_or(Value::Null),
                "session_id": session_id,
                "num_turns": steps.len(),
                "total_cost_usd": 0.0,
            }));
        } else if let Some(code) = step.get("exit").and_then(Value::as_i64) {
            return i32::try_from(code).unwrap_or(1);
        } else if step.get("hang").and_then(Value::as_bool) == Some(true) {
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
    }
    0
}

fn emit(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn assistant(session_id: &str, block: Value) {
    emit(&json!({
        "type": "assistant",
        "session_id": session_id,
        "message": { "role": "assistant", "content": [block] },
    }));
}

fn tool_result(session_id: &str, id: &str, output: &str, is_error: bool) {
    emit(&json!({
        "type": "user",
        "session_id": session_id,
        "message": { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": id, "content": output, "is_error": is_error }
        ] },
    }));
}
