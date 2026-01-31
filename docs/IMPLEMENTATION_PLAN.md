# Code-Auto — Master Implementation Plan

**Last updated:** 2026-01-30  
**Location:** `docs/IMPLEMENTATION_PLAN.md` — Master plan and backlog (single source of truth).

## What we're building

Code-Auto is a Next.js app that turns a "task" into a Code-Auto style workflow:

- **Kanban workflow**: `planning → in_progress → ai_review → human_review → done`
- **Isolated execution**: one **git worktree + branch per task**
- **Pluggable agent runtime**: a `CLIAdapter` interface with multiple providers
- **Real-time visibility**: stream agent logs to the UI (SSE)
- **Desktop app**: Electron wrapper for native desktop experience
- **Multi-project support**: Open any project folder; tasks, worktrees, and logs are project-scoped

## Current state (code-backed)

### Working

- **Electron desktop app**: Native macOS/Windows/Linux app with custom dock icon, app name ("Code-Auto"), and theme-aware icons (light/dark). Runs via `yarn start` (`electron/main.js`, `scripts/build-dock-icon.js`).
- **Open Project / folder selection**: Select project directory on startup; path persisted in localStorage. All API routes accept `X-Project-Path` header; tasks, worktrees, and agent logs are scoped to the selected project (`src/store/project-store.ts`, `src/lib/project-dir.ts`, `src/components/project/open-project-modal.tsx`, `src/components/project/open-project-gate.tsx`).
- **Kanban UI + workflow plumbing**: task cards, phase transitions, modals (`src/components/**`)
- **Task persistence**: file-based JSON in `.code-auto/tasks/` (`src/lib/tasks/persistence.ts`)
- **Worktrees**: created on task create (best-effort), branch naming `code-auto/{taskId}` (`src/lib/git/worktree.ts`, `src/app/api/tasks/create/route.ts`)
- **CLI adapters**: Amp (SDK), Cursor (CLI), and Mock providers with preflight checks and JSON validation (`src/lib/cli/*`, `src/lib/amp/preflight.ts`, `src/lib/cursor/preflight.ts`)
- **Git status UI + API**: `/api/git/status` (`src/app/api/git/status/route.ts`)
- **SSE agent log streaming**: `/api/agents/stream` + UI terminal (`src/app/api/agents/stream/route.ts`, `src/components/agents/terminal.tsx`)
- **Auto-plan route** (no human review): generates a plan + subtasks (`src/app/api/agents/auto-plan/route.ts`)
- **Subtask JSON validation + feedback** (for subtask generation prompts): `src/lib/validation/subtask-validator.ts` + logic inside `src/lib/cli/amp.ts` and `src/lib/cli/cursor.ts`
- **Review Locally** (Human Review phase): Open Cursor or VS Code at worktree path; open folder in file manager. IDE detection, Electron IPC handlers (`electron/main.js`, `electron/preload.js`), HumanReviewModal (`src/components/tasks/human-review-modal.tsx`).
- **Task stays in planning until subtasks ready**: Task remains in `planning` phase until dev + QA subtasks are generated and validated; only then moves to `in_progress` (`src/app/api/agents/start-development/route.ts`).
- **Fix-agent retry for plan/subtask JSON**: When plan or subtask JSON parsing fails, a fix agent retries up to 2 times before blocking (`src/app/api/agents/submit-answers/route.ts`, `src/app/api/agents/start-development/route.ts`).
- **Resume blocked tasks**: `POST /api/agents/retry-plan-parse` re-parses plan from logs for tasks blocked during plan generation; Edit Task modal shows Resume button (`src/app/api/agents/retry-plan-parse/route.ts`, `src/components/tasks/edit-task-modal.tsx`).

### Implemented, but has correctness gaps (see "Known issues")

- **Subtask wait timeout** is configurable via `CODE_AUTO_SUBTASK_WAIT_MS` (default 30 min); may need tuning for real agent runs.

### Not implemented yet (explicit TODOs in code)

- **Human review actions**: create MR/PR (Create MR button exists; push/create PR flow may need endpoints)
- **Memory context injection** into agent start route
  - TODO in `src/app/api/agents/start/route.ts`
- **Settings UI**: there is no `src/app/settings/*` route currently.

## Architecture (as implemented)

### Data & persistence

- **Tasks**: `.code-auto/tasks/{taskId}.json`
- **Per-task logs**: `.code-auto/tasks/{taskId}/*-logs.txt` (planning/dev/review/auto-plan/direct execution)
- **Code-Auto compatibility view**: `.code-auto/implementation_plan.json` (updated on every task save)

### Git worktrees

- Worktree base: `.code-auto/worktrees/{taskId}/`
- Branch per task: `code-auto/{taskId}`
- Created in `POST /api/tasks/create` via `WorktreeManager.createWorktree()`

### Agent runtime

- **AgentManager** (`src/lib/agents/manager.ts`)
  - Concurrency limit: 12
  - `startAgent()` runs `execute()` async in the background and stores logs in memory (`AgentSession.logs`)
- **Agent manager registry** (`src/lib/agents/registry.ts`)
  - Selects provider per task (`task.cliTool`) and keeps per-task managers in memory
  - Tracks `threadId → manager` so `GET /api/agents/stream` and `POST /api/agents/stop` work with multiple providers
- **Log streaming**: `GET /api/agents/stream?threadId=...` streams `AgentSession.logs` over SSE

### CLI adapter layer

- Interface + shared types: `src/lib/cli/base.ts`
- Factory: `src/lib/cli/factory.ts`
- Providers today:
  - `MockCLIAdapter` (`src/lib/cli/mock.ts`) — testing/simulation, respects per-thread working directory
  - `AmpAdapter` (`src/lib/cli/amp.ts`) — uses `@sourcegraph/amp-sdk` (`execute()`), includes subtask validation feedback loop
  - `CursorAdapter` (`src/lib/cli/cursor.ts`) — uses Cursor Agent CLI with `--print --output-format stream-json`, supports `--mode plan` for read-only planning, includes subtask validation feedback loop
  - **Amp preflight** (`src/lib/amp/preflight.ts`, `GET /api/amp/preflight`) — local-dev checks for `which amp` + login/API key readiness; UI blocks Amp runs until ready
  - **Cursor preflight** (`src/lib/cursor/preflight.ts`, `GET /api/cursor/preflight`) — local-dev checks for `which agent` + `agent status` auth readiness; UI blocks Cursor runs until ready

### UI state

- Zustand task store: `src/store/task-store.ts`
- Primary views/modals:
  - board: `src/components/kanban/*`
  - task detail page: `src/app/task/[id]/page.tsx`
  - modals: `src/components/tasks/*`
  - agent terminal: `src/components/agents/terminal.tsx`

## Runtime workflow (routes + state transitions)

```mermaid
flowchart TD
  CreateTask["POST /api/tasks/create"] --> Planning[planning]
  Planning -->|"requiresHumanReview=true"| Questions["/api/agents/start-planning (questions)"]
  Questions -->|"answers submitted"| Plan["/api/agents/submit-answers + plan gen"]
  Planning -->|"requiresHumanReview=false"| Plan
  Plan -->|"plan approved"| Dev["/api/agents/start-development"]
  Dev -->|"subtasks generated"| InProgress[in_progress]
  InProgress --> AIReview[ai_review]
  AIReview --> HumanReview[human_review]
  HumanReview --> Done[done]
```

### Task creation

- **Route**: `POST /api/tasks/create`
- **Effects**:
  - Creates task JSON
  - Attempts worktree creation and saves `worktreePath`/`branchName` if successful

### Planning (human review optional)

- **Route**: `POST /api/agents/start-planning`
- **If** `requiresHumanReview=true`:
  - agent returns `{ questions: [...] }` JSON
  - task moves to `planningStatus=waiting_for_answers`
  - User submits answers via `POST /api/agents/submit-answers`
  - Plan generation runs with fix-agent retry on parse failure
- **Else**:
  - agent returns `{ plan: "...markdown..." }` JSON
  - task is auto-approved and triggers `POST /api/agents/start-development`
- **Resume blocked tasks**: `POST /api/agents/retry-plan-parse` for tasks blocked during plan generation (parse failure)

### Auto-plan (no human review)

- **Route**: `POST /api/agents/auto-plan`
  - Phase 1: plan generation (markdown or JSON containing plan)
  - Phase 2: subtask generation (JSON)
  - Saves plan, marks approved, saves subtasks

### Development + sequential execution + QA auto-run

- **Route**: `POST /api/agents/start-development`
  - Task stays in `planning` until subtasks are generated and validated (fix-agent retry on parse failure)
  - Generates subtasks, saves them onto the task
  - Moves to `in_progress`, executes dev subtasks sequentially
  - When all dev subtasks complete, moves to `ai_review` and auto-starts QA verification
  - When all QA subtasks complete, moves to `human_review`

### Direct execution (testing / minimal flow)

- **Route**: `POST /api/agents/execute-direct`
  - Chooses provider from `task.cliTool` by instantiating a dedicated `AgentManager`
  - Initializes adapter with `cwd = task.worktreePath` (if present)
  - Executes a single command/prompt and moves the task to `human_review`

### Log streaming

- **Route**: `GET /api/agents/stream?threadId=...`
  - Streams in-memory logs from `AgentManager.activeAgents`
  - Works for single-process dev; not resilient across restarts/multi-instance deployments

## Known issues / risks (must-fix before relying on real Amp runs)

### 1) 60s "wait for subtask completion" default

- `waitForSubtaskCompletion()` and `waitForQASubtaskCompletion()` max wait is configurable via `CODE_AUTO_SUBTASK_WAIT_MS` (default 30 min).
- **Impact**: real tasks may need longer; tune env var as needed.

### 2) SSE is in-memory only

- Logs are stored in memory in the server process.
- **Impact**: server restarts lose logs; multi-instance deployments won't share state.

## Canonical backlog (single TODO list)

### P0 — Fix correctness for real execution

- **Make provider selection per task** for `start-planning`, `start-development`, `auto-plan`:
  - Use `task.cliTool` and `task.cliConfig` instead of singleton defaults.
- **Make working directory per thread** for Amp adapter:
  - Use `threadId → workingDir` mapping when building SDK options.

### P1 — Finish the "human review" loop

- Implement MR/PR creation (push branch, create PR) — Create MR button exists; backend flow may need endpoints.
- Memory context injection path (currently TODO in `src/app/api/agents/start/route.ts`).

### P2 — Memory + settings + integrations

- Add a settings page (no `src/app/settings/*` currently).
- Cost tracking dashboard + budget alerts.
- GitHub/GitLab issue import and PR sync.

## Operational runbook

### Local development

```bash
yarn install
yarn start          # Starts Electron desktop app (Next.js dev + Electron)
yarn next:dev       # Next.js only (e.g. for web-only development)
yarn build          # Builds packaged Electron app for distribution
```

### E2E tests

```bash
yarn test:e2e
```

### Real Amp smoke test (minimal cost)

1. Confirm local Amp readiness (the UI checks this too):
   - `which amp` returns a path
   - `amp login` completed (preferred) **or** `AMP_API_KEY` is set
   - `GET /api/amp/preflight` returns `canRunAmp: true`
2. Create a task with `cliTool: "amp"` (New Task modal should show "Amp readiness: Ready").
3. Trigger a low-cost run:
   - `POST /api/agents/execute-direct` with a tiny prompt (e.g. "create TEST.md with hello")
4. Verify file changes landed in the task's worktree (`task.worktreePath`) and not in the main repo root.

## Definition of done (MVP)

- A task can reliably go from creation → planning → dev subtasks → QA subtasks → human review.
- All file changes happen inside the task's worktree.
- UI shows real-time logs.
- Human review provides Review Locally (open Cursor/VS Code/folder) and Create MR path.
