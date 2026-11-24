# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

AGENTS.md (imported above) holds the layout, commands and invariants. What follows is only what it does not cover. Plan and phase notes live in the Obsidian vault under `Plans/code-automata/`.

## Running a single test

```bash
cargo test --test git worktree_lifecycle                          # one Rust integration test
cargo clippy --target x86_64-pc-windows-msvc --all-targets -- -D warnings   # Windows lint from macOS
cd ui && yarn vitest run src/lib/themes/__tests__/theme-config.test.ts   # one UI test file
cd ui && yarn vitest run -t "name of the test"                            # by test name
```

## Rust core

`crates/core` (`ca_core`) holds the task store, phase table and git layer.

- One directory per task: `.code-automata/tasks/<id>/task.json` plus that task's logs. `tests/fixtures/task-example.json` shows every field.
- Each piece of state lives in one place: `phase` is the column, `run` says whether an agent is working, paused, interrupted or failed and on which subtask, a subtask is only `pending`, `done` or `skipped`. Do not add derived or duplicated fields.
- Task files are strict: unknown keys and any `schema` other than 1 are refused.
- `Task::validate` ties `run` to the phase (plan/subtask_gen → planning, dev → in_progress, qa/checks → ai_review) and a dev/qa run to a pending subtask of its kind. `transitions::apply_move` drops a run the move leaves behind. Branch, worktree path and last checkpoint are derived (from the id and HEAD), not stored.
- `TaskStore::update` is the only write path: per-task lock, then atomic temp-file-and-rename. Reads never write.
- Phase moves go through `transitions::check_move`; UI edits through `apply_patch`, which accepts only `EDITABLE_FIELDS`.
- A project is always a git repository root; picking a subfolder opens its repository.

`crates/core/src/agent/` runs agent CLIs (Claude Code, Cursor, Amp, and the scripted `mock-agent` binary for tests):

- A run's outcome comes only from the provider's final `result` event; exit codes are ignored. No `result` means crashed, timed out or stopped.
- Agents and check commands run as their own process tree (`src/proc.rs`). On Unix that is a process group: stop and timeouts send SIGTERM, then SIGKILL after `kill_grace`. On Windows it is a Job Object with kill-on-close: stop kills at once, and the agents die with the engine process. Windows needs no orphan cleanup.
- Prompts go on stdin, never in arguments. Claude runs with project settings only and no MCP servers, so the user's own hooks and connectors never reach task agents.
- Live tests make real model calls: `cargo test --test live_agents -- --ignored --test-threads=1`. Amp spends credit; keep it to `--mode low`.

`crates/core/src/engine/` is the run engine (`Engine`):

- `step::next_step(task, settings)` is a pure function that decides the next step from the task file alone. Change behaviour there and in its table tests, not in the driver.
- `driver.rs` executes one step at a time. Each step's result, and clearing its run, go in one `TaskStore::update`. A run record exists only while a step is in progress or halted (`paused` / `interrupted` / `failed`).
- `Engine::open` takes `.code-automata/engine.lock` with `File::try_lock` (one window per project; the holder is named in `engine.owner`, since Windows locks block reads) and reconciles: runs left by another process become `interrupted`, and on Unix their orphaned agents are killed if pid and start time match. Nothing restarts on its own; the user resumes.
- Review (QA) and read-only (planning) runs have their changes, and any commits made during the run, discarded afterwards whatever the provider. Checks run against the last dev checkpoint and fail clearly if HEAD is elsewhere.
- Acceptance tests run the whole engine on the mock agent (`tests/engine.rs`); the crash test drives the `ca-engine` binary in a child process and SIGKILLs it. One live run through Claude: `cargo test --test live_engine -- --ignored --nocapture`.

`crates/server` (`ca_server`) is the HTTP API (axum) the UI talks to; the Tauri app will embed it:

- `127.0.0.1` only. Every request needs `Authorization: Bearer <launch token>` and a `Host` of `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard). There are no CORS headers.
- The project comes from the percent-encoded `X-Project-Path` header. One `Engine` per repository root, opened on first use and kept until the server stops, so other projects' tasks keep running.
- Handlers are thin: each calls one `Engine` method (`create_and_start` exists for that reason). `CoreError` maps to a status in `src/error.rs` (`Invalid` means the command does not fit the task's state, so 409).
- `GET /api/events` is Server-Sent Events: `hello` first (load the task list then), then `task` (the full task, or none when deleted), `agent`, `error` and `lagged` (resync).
- Each agent run also writes `<run>.events.ndjson` (`engine/runlog.rs`): a start line, then normalized `AgentEvent`s, which `GET /api/tasks/:id/runs/:name` replays.
- The UI's types in `ui/src/lib/api/types/` are generated by ts-rs from the Rust types (`#[cfg_attr(feature = "ts", ...)]`). After changing a serialized type: `rm -rf ui/src/lib/api/types && cargo test --workspace --features ts export_bindings`. CI fails if they differ. Map `i64`/`u64` fields to `number` with `ts(as = "f64")`.
- `tests/http.rs` drives the real router with `oneshot` on the mock agent. It finds core's `mock-agent` binary in the target directory, so build the workspace first when running `-p code-automata-server` alone.
