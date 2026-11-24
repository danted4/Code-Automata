# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

Code-Automata runs AI coding agents through a five-phase Kanban workflow, one git worktree per task, inside a project (a git repository) the user opens. Persistence is files on disk under that project's `.code-automata/`, never this repo's working directory.

This branch (`v3-tauri`) is **3.0**, a rewrite in progress: a Rust core plus a React UI, later wrapped in a Tauri desktop app. 2.2.4 (Electron + Next.js) is on `main`. 3.0 owes it nothing: no migration, no compatibility, and its design decisions are not binding.

License: **AGPL-3.0-or-later**. Repo: [danted4/Code-Automata](https://github.com/danted4/Code-Automata).

## Layout

```
Cargo.toml         Rust workspace
crates/core/       ca_core: task store, phase table, run engine, agent processes, git
  src/bin/         ca-engine (dev CLI), mock-agent (scripted agent for tests)
  tests/           integration and acceptance tests
crates/server/     ca_server: HTTP API and event stream in front of the engine (axum)
  src/bin/         ca-server (the server on its own: development, e2e)
ui/                React UI: Vite, React Router, Tailwind, Zustand
  src/routes/      one file per page
  src/components/  kanban, tasks, worktrees, theme, ui (shadcn-style)
  src/lib/         api/ (client, endpoints, event stream, generated types), task-view and other
                   pure view logic, native (desktop-only actions), themes
  src/types/       global declarations
docs/images/       screenshots and logos
```

Not built yet: the Tauri shell `crates/app` (Phase 5). Until then the UI runs in a browser against `ca-server`: `yarn dev` and `yarn preview` proxy `/api` to it and add its token.

## Commands

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo run -p code-automata-server --bin ca-server -- --port 7878 --token dev \
  --allow-mock --mock-scenario path/to/scenario.json    # mock tasks from the UI play this

cd ui
yarn install
yarn dev            # http://localhost:5173, proxies /api to ca-server (CA_SERVER_URL, CA_SERVER_TOKEN)
yarn lint
yarn typecheck
yarn test           # Vitest
yarn build          # typecheck + vite build into ui/dist
yarn format         # Prettier
yarn e2e            # after `cargo build` and `yarn build`: ten agent-browser scenarios
```

CI: `.github/workflows/rust.yml` (macOS, Ubuntu, Windows) and `ui.yml` fail on any warning (clippy `-D warnings`, ESLint `--max-warnings 0`); `e2e.yml` runs the browser scenarios.

## Invariants

**Project scoping.** Every UI request goes through `ui/src/lib/api/client.ts`, which sends the open project's path (`X-Project-Path`). Never assume the process's working directory is the user's project.

**On-disk layout.** Everything lives under `<repo root>/.code-automata/`, which the app adds to `.git/info/exclude`. `tasks/<id>/task.json` holds the task (schema in `crates/core/src/task.rs`, example in `crates/core/tests/fixtures/task-example.json`) with its logs beside it. `worktrees/<id>/` is the worktree on branch `code-automata/<id>`. There is no aggregate file.

**Workflow.** The phases are fixed: `planning → in_progress → ai_review → human_review → done`. Allowed moves, including rework, replan and reopen, are the table in `crates/core/src/transitions.rs`. Do not add phases. Dragging a card only moves it; agents are started, paused and resumed by buttons.

**Providers.** Claude Code, Cursor, Amp, plus `mock` for tests (never offered to users in a packaged build). Provider code lives in `crates/core/src/agent/`.

**Desktop-only actions** (folder picker, open in editor, reveal in file manager) go through `ui/src/lib/native.ts`. It is `null` until the Tauri shell implements it, and the UI hides those actions then.

**UI data flow.** `lib/api` (typed calls, generated types) → Zustand stores, kept current by the project's event stream (`store/project-sync.ts`; no polling) → components. What a task shows (badge, buttons, progress) comes from pure functions in `lib/task-view.ts` and siblings, each with a Vitest test; keep business logic out of components.

## Testing

- Rust: unit tests beside the code; acceptance tests in `crates/core/tests/` run the whole engine on the mock agent. Live tests (`#[ignore]`) make real model calls.
- UI: Vitest, colocated in `ui/src/**/__tests__`.
- End-to-end: `ui/e2e/app.e2e.mjs` (Node's test runner) drives Chrome with agent-browser against the built UI, a real `ca-server` and the mock agent; one server and throwaway repository per scenario. Not Playwright. CI: `.github/workflows/e2e.yml`.

## Style

- Rust: edition 2024, no `unsafe`, Clippy clean.
- TypeScript: functional React, Tailwind with the components in `ui/src/components/ui`. Prefix unused variables with `_`; avoid `any`.
- Match the surrounding file; do not reformat unrelated code.
