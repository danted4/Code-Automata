# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

Code-Automata runs AI coding agents through a five-phase Kanban workflow, one git worktree per task, inside a project (a git repository) the user opens. Persistence is files on disk under that project's `.code-automata/`, never this repo's working directory.

This branch (`v3-tauri`) is **3.0**, a rewrite in progress: a Rust core plus a React UI in a Tauri 2 desktop app. 2.2.4 (Electron + Next.js) is on `main`. 3.0 owes it nothing: no migration, no compatibility, and its design decisions are not binding.

License: **AGPL-3.0-or-later**. Repo: [danted4/Code-Automata](https://github.com/danted4/Code-Automata).

## Layout

```
Cargo.toml         Rust workspace
crates/core/       ca_core: task store, phase table, run engine, agent processes, git
  src/bin/         ca-engine (dev CLI), mock-agent (scripted agent for tests)
  tests/           integration and acceptance tests
crates/server/     ca_server: HTTP API and event stream in front of the engine (axum)
  src/bin/         ca-server (the server on its own: development, e2e)
crates/app/        the desktop app (Tauri 2): the UI in a window, the server in-process, the
                   native commands behind ui/src/lib/native.ts; tauri.conf.json, icons/
ui/                React UI: Vite, React Router, Tailwind, Zustand
  src/routes/      one file per page
  src/components/  kanban, tasks, worktrees, theme, ui (shadcn-style)
  src/lib/         api/ (client, endpoints, event stream, generated types), task-view and other
                   pure view logic, native (desktop-only actions), themes
  src/types/       global declarations
docs/images/       screenshots and logos
```

The UI also runs in a plain browser against `ca-server` (development and the e2e suite): `yarn dev` and `yarn preview` proxy `/api` to it and add its token.

## Commands

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo run -p code-automata-server --bin ca-server -- --port 7878 --token dev \
  --allow-mock --mock-scenario path/to/scenario.json    # mock tasks from the UI play this

# Desktop app. `cargo build`/`test`/`clippy` at the root leave it out (default-members); it
# needs the webview's development files on Linux (libwebkit2gtk-4.1-dev). Tauri CLI:
# `cargo install tauri-cli --version "^2.12" --locked`, or ui/node_modules/.bin/tauri.
cargo clippy -p code-automata-app --all-targets -- -D warnings
cargo test -p code-automata-app
cd crates/app && cargo tauri dev            # Vite + the app window
cd crates/app && cargo tauri build --debug --no-bundle && \
  CODE_AUTOMATA_SMOKE=1 ../../target/debug/code-automata   # prints "smoke: passed", exits 0

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

Releases: `.github/workflows/release.yml` builds the installers (universal macOS DMG, Windows NSIS, Linux AppImage and deb) on a `v*` tag that matches the version in `Cargo.toml` and `ui/package.json`, and creates a **draft** release with `latest.json` (the updater's manifest) and `checksums.sha256`. Run it by hand without a tag for a dry run (workflow artifacts only). Updates are signed with the `TAURI_SIGNING_PRIVATE_KEY` secret. A local `cargo tauri build` with bundles needs that key too (`TAURI_SIGNING_PRIVATE_KEY="$(cat <key file>)"`), or `--config '{"bundle":{"createUpdaterArtifacts":false}}'`. Installers are not code-signed.

CI: `.github/workflows/rust.yml` (macOS, Ubuntu, Windows) and `ui.yml` fail on any warning (clippy `-D warnings`, ESLint `--max-warnings 0`); `e2e.yml` runs the browser scenarios; `app.yml` lints, tests, builds and smoke-tests the desktop app on all three OSes.

## Invariants

**Project scoping.** Every UI request goes through `ui/src/lib/api/client.ts`, which sends the open project's path (`X-Project-Path`). Never assume the process's working directory is the user's project.

**On-disk layout.** Everything lives under `<repo root>/.code-automata/`, which the app adds to `.git/info/exclude`. `tasks/<id>/task.json` holds the task (schema in `crates/core/src/task.rs`, example in `crates/core/tests/fixtures/task-example.json`) with its logs beside it. `worktrees/<id>/` is the worktree on branch `code-automata/<id>`. There is no aggregate file.

**Workflow.** The phases are fixed: `planning → in_progress → ai_review → human_review → done`. Allowed moves, including rework, replan and reopen, are the table in `crates/core/src/transitions.rs`. Do not add phases. Dragging a card only moves it; agents are started, paused and resumed by buttons.

**Providers.** Claude Code, Cursor, Amp, plus `mock` for tests (never offered to users in a packaged build). Provider code lives in `crates/core/src/agent/`.

**Desktop-only actions** (folder picker, open in editor, reveal in file manager) go through `ui/src/lib/native.ts`, which calls the app's commands (`crates/app/src/native.rs`). In a plain browser it is `null` and the UI hides those actions.

**Child processes** are created with `ca_core::proc::command`, never `Command::new`: on Windows it sets `CREATE_NO_WINDOW`, without which the GUI app opens a console window per `git` or agent run. `crates/core/tests/no_console_windows.rs` fails on a plain `Command::new` in shipped code.

**UI data flow.** `lib/api` (typed calls, generated types) → Zustand stores, kept current by the project's event stream (`store/project-sync.ts`; no polling) → components. What a task shows (badge, buttons, progress) comes from pure functions in `lib/task-view.ts` and siblings, each with a Vitest test; keep business logic out of components.

## Testing

- Rust: unit tests beside the code; acceptance tests in `crates/core/tests/` run the whole engine on the mock agent. Live tests (`#[ignore]`) make real model calls.
- UI: Vitest, colocated in `ui/src/**/__tests__`.
- End-to-end: `ui/e2e/app.e2e.mjs` (Node's test runner) drives Chrome with agent-browser against the built UI, a real `ca-server` and the mock agent; one server and throwaway repository per scenario. Not Playwright. CI: `.github/workflows/e2e.yml`.

## Style

- Rust: edition 2024, no `unsafe`, Clippy clean.
- TypeScript: functional React, Tailwind with the components in `ui/src/components/ui`. Prefix unused variables with `_`; avoid `any`.
- Match the surrounding file; do not reformat unrelated code.
