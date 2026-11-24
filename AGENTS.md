# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

Code-Automata is an **Electron desktop app** (Next.js 15 + React 19 UI) that runs AI coding tasks through a 5-phase Kanban workflow. Each task lives in an isolated git worktree. It is **not** a SaaS backend; persistence is JSON on disk under the **user-selected project**, not this repo’s cwd (except as a fallback).

Current version: **2.2.4**. License: **AGPL-3.0-or-later**. Repo: [danted4/Code-Automata](https://github.com/danted4/Code-Automata).

## Commands

Package manager is **yarn**.

```bash
yarn install
yarn start          # Electron + Next.js (preferred)
yarn next:dev       # UI only at http://localhost:3000
yarn lint
yarn format
yarn typecheck
yarn test           # Vitest
yarn test:e2e       # Playwright
```

Packaged builds: `yarn build` (current platform), `yarn build:mac` / `build:linux` / `build:win`. Do not use `yarn build:all` on Apple Silicon without Rosetta (`yarn build:all:rosetta`). Releases are tag-driven GitHub Actions — see `docs/RELEASE.md`. Never `gh release upload` large DMG/ZIP; it can corrupt binaries.

Husky + lint-staged run ESLint and Prettier on commit.

## Layout

```
electron/           # Main process (main.js) + preload
scripts/            # Icons, prepare-build, after-pack, dev launcher
src/app/            # Next.js App Router (pages + API)
src/app/api/        # REST + SSE
src/components/     # UI (kanban, tasks, worktrees, theme)
src/lib/            # Domain: tasks, git, cli, agents, prompts
src/store/          # Zustand (project, tasks, theme)
e2e/                # Playwright
docs/               # Architecture and workflow — read before large changes
```

Path alias: `@/` → `src/`.

## Architecture invariants

**Project scoping.** The app operates on a git repo chosen at launch. Persist that path in `useProjectStore`. All API work that touches tasks/git/agents must go through `apiFetch` (sets `X-Project-Path`) or `buildStreamUrl` for EventSource (query `projectPath`). Server reads the path via `getProjectDir()` in `src/lib/project-dir.ts`. Do not assume `process.cwd()` is the user’s project.

**On-disk layout (inside the selected project):**

| Path                                      | Role                    |
| ----------------------------------------- | ----------------------- |
| `.code-automata/tasks/{taskId}.json`      | Task records            |
| `.code-automata/worktrees/{taskId}/`      | Isolated worktree       |
| `.code-automata/implementation_plan.json` | Compatibility aggregate |

Branch name: `code-automata/{taskId}`.

**Workflow.** Phases are fixed: `planning → in_progress → ai_review → human_review → done`. Backward only for rework: `ai_review` / `human_review` → `in_progress`. `in_progress` advances when **all** `dev` subtasks are `completed`; `ai_review` advances when **all** `qa` subtasks are `completed`. Do not invent extra phases or skip aggregation rules.

**CLI adapters.** Implement `CLIAdapter` (`src/lib/cli/base.ts`) and register in `CLIFactory`. Providers: `cursor`, `amp`, `mock`. UI order is Cursor → Amp → Mock. **Hide Mock** when `CODE_AUTOMATA_PACKAGED=1` or Electron is present (`src/app/api/cli/adapters/route.ts`). Packaged app never ships Mock as a user-facing backend.

**Agent pool.** `AgentManager` caps concurrent sessions at **12**.

**Packaged vs dev.** Production Electron spawns Next.js standalone (`node server.js`) as a subprocess. The Next process is **not** Electron, so `process.versions.electron` is missing — use `CODE_AUTOMATA_PACKAGED`. Packaged GUI PATH is empty; CLI discovery (`agent`, `amp`, `gh`, `cursor`, `code`) and Node 18+ resolution live in `electron/main.js`. See `docs/PACKAGED_APP.md` before changing spawn, PATH, or env.

**UI data flow.** Components → Zustand → `apiFetch` → App Router handlers → `src/lib/*` → filesystem/git. Keep business logic out of components; keep git/CLI details out of React.

## Adding a CLI provider

1. Implement `CLIAdapter` next to `amp.ts` / `cursor.ts` / `mock.ts`.
2. Register in `CLIFactory.create` / `getAvailableProviders`.
3. Add preflight if the tool needs a binary or API key (`src/lib/*/preflight.ts` + matching `/api/*/preflight` route).
4. Keep Mock last and filtered in packaged builds.

## Testing

- **Vitest**: unit tests colocated under `src/**/__tests__`.
- **Playwright**: `e2e/*.spec.ts`. Prefer Mock adapter; do not hit live Amp/Cursor in CI/e2e.
- After UI changes, run `yarn lint` and `yarn typecheck`. For Kanban/workflow/theme, run the relevant e2e spec.

## Style

- TypeScript, functional React, Tailwind + existing `src/components/ui` (shadcn-style).
- Unused vars: prefix `_`. Avoid `any`; ESLint warns.
- Format with Prettier (`yarn format`). Match surrounding file style; do not drive-by reformat.
- Electron main/preload stay CommonJS (`require`) unless you convert the whole Electron layer.

## Docs map

| Doc                                   | When to read               |
| ------------------------------------- | -------------------------- |
| `docs/ARCHITECTURE.md`                | Modules, state machine     |
| `docs/KANBAN_WORKFLOW.md`             | Phase UX                   |
| `docs/API_ROUTES.md`                  | Endpoint contracts         |
| `docs/CLI_ADAPTERS.md`                | Adapter contract           |
| `docs/CURSOR_INTEGRATION.md`          | Cursor CLI                 |
| `docs/DATA_FLOW.md`                   | Store ↔ API ↔ disk         |
| `docs/WORKTREE.md`                    | Git isolation              |
| `docs/PACKAGED_APP.md`                | DMG/AppImage/NSIS behavior |
| `docs/RELEASE.md` / `CODE_SIGNING.md` | Shipping                   |

Do not duplicate those docs here. Update them when you change the corresponding behavior.
