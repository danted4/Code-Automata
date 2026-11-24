# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

AGENTS.md (imported above) holds the commands, layout, architecture invariants and docs map. What follows is only what it does not cover.

## Running a single test

```bash
yarn vitest run src/lib/themes/__tests__/theme-config.test.ts   # one unit file
yarn vitest run -t "name of the test"                            # by test name
yarn playwright test e2e/kanban.spec.ts                          # one e2e spec
yarn playwright test e2e/kanban.spec.ts -g "name of the test"    # one e2e test
```

Playwright starts `yarn next:dev` on port 3000 itself (and reuses a server already running there outside CI). Unit coverage today is themes only; nothing under `src/lib/agents`, `src/lib/cli` or the agent routes has tests.

## Rust core (3.0 migration, branch `v3-tauri`)

The backend is being rewritten in Rust; the TypeScript app above is unchanged until the UI switches over. Plan and phase notes live in the Obsidian vault under `Plans/code-automata/`.

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings     # CI fails on any warning
cargo test                                    # all crates
cargo test --test git worktree_lifecycle      # one integration test
```

`crates/core` (`ca_core`) holds the task store, phase table and git layer. The 3.0 app shares nothing with 2.2.x on disk: no migration, no compatibility, and 2.2.x design decisions are not binding.

- One directory per task: `.code-automata/tasks/<id>/task.json` plus that task's logs. `tests/fixtures/task-example.json` shows every field.
- Each piece of state lives in one place: `phase` is the column, `run` says whether an agent is working, paused, interrupted or failed and on which subtask, a subtask is only `pending`, `done` or `skipped`. Do not add derived or duplicated fields.
- Task files are strict: unknown keys and any `schema` other than 1 are refused.
- `Task::validate` ties `run` to the phase (plan/subtask_gen → planning, dev → in_progress, qa/checks → ai_review) and a dev/qa run to a pending subtask of its kind. `transitions::apply_move` drops a run the move leaves behind. Branch, worktree path and last checkpoint are derived (from the id and HEAD), not stored.
- `TaskStore::update` is the only write path: per-task lock, then atomic temp-file-and-rename. Reads never write.
- Phase moves go through `transitions::check_move`; UI edits through `apply_patch`, which accepts only `EDITABLE_FIELDS`.
- A project is always a git repository root; picking a subfolder opens its repository.

## How a task actually runs

The orchestration is not in `src/lib`. It lives inside the route handlers under `src/app/api/agents/`, as closures that keep running after the HTTP response is sent:

1. `start-planning` → agent writes questions or a plan; `submit-answers`, `modify-plan`, `approve-plan`, `retry-plan-parse` drive the rest of planning. `auto-plan` covers tasks with no human review.
2. `start-development` → one agent generates subtasks as JSON (up to 2 "fix agent" re-prompts if it does not parse), the task moves to `in_progress`, then `executeSubtasksSequentially` starts one agent per `dev` subtask.
3. When every `dev` subtask is `completed`, the same file fires `startAIReviewAutomatically`, which runs the `qa` subtasks. `start-review` holds a second copy of that QA loop for the manual "Retry AI Review" button.
4. All `qa` subtasks `completed` → `human_review`.

Each agent run goes `startAgentForTask` (`src/lib/agents/registry.ts`) → `AgentManager.startAgent` (`manager.ts`) → `CLIAdapter.execute` (`src/lib/cli/*`). The adapter yields `StreamMessage`s; the manager appends each to `.code-automata/tasks/{taskId}/agent-stream-{threadId}.ndjson` and calls the route's `onComplete` closure on a `result` or `error` message. `/api/agents/stream` is an SSE endpoint that tails that NDJSON file, located through `.code-automata/thread-index.json`.

The sequential loops do not await the agent. They start it, then poll the task JSON once a second (`waitForSubtaskCompletion`, 30 min cap, `CODE_AUTOMATA_SUBTASK_WAIT_MS` overrides) until the `onComplete` closure has written `completed` or `blocked`.

The UI has no push channel for task state: `kanban/board.tsx` re-fetches `/api/tasks/list` every 3 s, and `task-card.tsx` decides whether to show "Retry Auto-Start" / "Retry AI Review" from `Date.now() - task.updatedAt` (10 s and 15 s).

## Traps in that design

Read these before touching the agent flow; several are the cause of resume/restart bugs.

- **Run state is memory-only.** The loop position, the `onComplete` closures, the manager and thread maps in `registry.ts`, and the child-process handles in the adapters all die with the Next.js server (app quit, crash, dev HMR). The task JSON then still says `in_progress` with an `assignedAgent` that no longer exists, and nothing reconciles it at startup.
- **`threadId` is not a provider session.** It is a local id (`cursor-<ts>-<rand>`, `amp-<ts>-<rand>`) minted per subtask. `CursorAdapter.threadChatIds` is read for `--resume` but never written, and `resumeThread` is a no-op in every adapter, so no run ever resumes a previous conversation.
- **Stop does not mean pause.** `/api/agents/stop` returns 404 if the thread is not in the in-memory map (always true after a restart), resets the task to `phase: 'planning'`, and leaves the sequential loop polling. `AmpAdapter.stopThread` only deletes a map entry; the SDK run continues.
- **Task JSON writes are not atomic or locked.** `saveTask` is a plain `writeFile`, and every writer does load → mutate → save. The polling loop, `onComplete`, `/api/tasks/update` (which spreads arbitrary body fields onto the task) and skip/delete/reorder routes can overwrite each other.
- **A task has two status axes** — `phase` (the Kanban column) and `status` (`pending | planning | in_progress | completed | blocked`), plus `planningStatus`. Routes set them independently; check all three when changing a transition.
- **`/api/tasks/update` forbids `ai_review`/`human_review` → `in_progress`**, which contradicts the rework rule in AGENTS.md. The code is the current behaviour.
- **`getProjectDir` silently falls back to `process.cwd()`** on a missing or invalid `X-Project-Path`, so a request that forgets `apiFetch` operates on this repo's own `.code-automata/`.
- `src/lib/agents/singleton.ts` is unused; `registry.ts` is the live path. `/api/agents/start` (used by drag-to-In-Progress) bypasses the subtask flow entirely.
