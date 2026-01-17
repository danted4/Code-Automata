# Code-Auto Implementation Plan - UPDATED

**Last Updated:** January 18, 2026 (Phase 3 Complete + Phase 4 Planning)
**Current Status:** Phase 3 (Worktree Integration) - 100% Complete ✅ | Phase 4 (Amp CLI Integration) - Ready to Start

**Important References:**
- **`AMP_CLI_RESEARCH.md`** - Complete amp CLI/SDK research, cost optimization, all parameters documented
- **`PHASE_3_4_COMPLETE.md`** - Phase 3.4 UI updates completion summary
- **`PHASE_3_VERIFICATION.md`** - Phase 3 worktree integration verification

---

## Overview

Build a Next.js web application that wraps amp CLI to provide Auto-Claude features (Kanban board, parallel agents, git worktrees, GitHub/GitLab integration) in the browser.

**Key Decisions:**
- **Next.js 15** with App Router and TypeScript ✅
- **amp SDK** (`@sourcegraph/amp-sdk`) for CLI integration (paid credits only)
- **shadcn/ui + Tailwind** for UI components ✅
- **Zustand** for state management ✅
- **Server-Sent Events (SSE)** for real-time agent streaming
- **File-based storage** (JSON) for tasks and memory ✅
- **Modular architecture** with pluggable CLI adapter layer ✅

---

## Progress Summary

### ✅ COMPLETED

#### Phase 1: CLI Adapter & Task Foundation
- [x] CLI adapter layer (base interface, mock, amp implementations)
- [x] Task data schema with 5-phase workflow
- [x] File-based task persistence
- [x] Task creation modal with CLI tool selection
- [x] Mock CLI adapter with intelligent subtask generation

#### Phase 2: Kanban Board & Workflow
- [x] Kanban board UI with drag-and-drop (dnd-kit)
- [x] **Planning Phase**: Q&A questions → Plan review → Auto-approval/Human approval
- [x] **Development Phase (in_progress)**: Dev subtask execution, progress tracking
- [x] **AI Review Phase**: QA subtask execution, verification
- [x] **Human Review Phase**: Review modal with work summary
- [x] Automatic phase transitions when subtasks complete
- [x] Progress dots (blue for dev, purple for QA)
- [x] Event propagation prevention for all modals
- [x] Proper task locking/unlocking based on review requirements

#### Phase 2.5: UI Polish & Modals (JUST COMPLETED)
- [x] Task detail modal (subtasks, logs)
- [x] QA stepper modal (answer questions about plan)
- [x] Plan review modal (approve/reject plan)
- [x] Human review modal (ready for merge, git options, file explorer)
- [x] Consistent theme styling across all modals
- [x] Event propagation prevention (click/drag leakage blocking)

### 🚧 IN PROGRESS / NEXT UP

#### Phase 3: Git Worktree Integration ✅ COMPLETE
**Status:** All phases (3.1, 3.2, 3.3, 3.4) complete and tested

##### Phase 3.1: WorktreeManager Implementation ✅
- [x] Create `src/lib/git/worktree.ts` with WorktreeManager class
  - [x] `getMainRepoPath()` - Auto-detect project root
  - [x] `getMainBranch()` - Auto-detect main/master branch
  - [x] `createWorktree(taskId)` - Create branch + worktree at `.code-auto/worktrees/{task-id}`
  - [x] `deleteWorktree(taskId)` - Clean up with `--force` if needed
  - [x] `getWorktreeStatus(taskId)` - Check existence and status
  - [x] Comprehensive error handling with user-friendly messages
  - [x] Singleton pattern for app-wide access
  - [x] 18/18 integration tests passing

##### Phase 3.2: Task Integration ✅
- [x] Task schema already has `worktreePath` and `branchName` fields
- [x] Update task creation endpoint: Auto-trigger worktree creation
- [x] Update task store: Persist worktree information
- [x] Pass `workingDirectory` parameter to CLI adapter on agent execution
- [x] Create `/api/git/worktree` endpoint for worktree CRUD operations
- [x] Update `/api/tasks/update` to preserve worktree on completion

##### Phase 3.3: Testing & Validation ✅
**Status:** All E2E tests passing (5/5) + Live end-to-end verification

Test Results:
- [x] ✅ `should create worktree when task is created` - Verifies worktree + .git created on task creation
- [x] ✅ `should verify all seeded tasks have worktrees` - Checks multiple tasks have worktrees  
- [x] ✅ `should verify task metadata has worktree and branch info` - Confirms branchName and worktreePath in task JSON
- [x] ✅ `should maintain unique branch per task` - All tasks get unique auto-claude/{taskId} branches
- [x] ✅ `should verify concurrent worktree independence` - Multiple worktrees have independent .git directories

Key Implementation Details:

**Mock CLI (Testing Only):**
- Enhanced with attendance file for testing/simulation proof-of-work
- Creates `subtask-attendance.txt` at worktree root for each subtask
- Simulates work by recording execution with timestamps
- Each subtask appends: `[step-N] Completed at {timestamp}`
- Files visible in `git status` as untracked changes
- **IMPORTANT:** This is mock-only behavior for testing worktree isolation

**Real Agents (amp SDK - Phase 4):**
- Will NOT use attendance file pattern
- Will create/modify actual files per task requirements
- Will make real code changes (new files, edits, refactors, etc.)
- Changes will naturally appear in `git status`
- Proof of work = actual code modifications, not simulated entries

**Both Flow Through Same Architecture:**
- Tasks auto-create worktrees on creation (via /api/tasks/create endpoint)
- Each task gets unique branch: `auto-claude/{task-id}`
- Worktrees stored at `.code-auto/worktrees/{task-id}`
- Metadata persisted in task JSON files
- Phase transitions automatic (planning → in_progress → ai_review → human_review)
- All 18 worktree integration tests passing

### Phase 3.4: UI Updates ✅ COMPLETE
- [x] Display branch name on task cards
- [x] Show branch in human review modal (prominently in header)
- [x] Add git status indicators (✓ clean, ⚠ changes)
- [x] Created `/api/git/status` endpoint for status checking

##### Phase 3.4: UI Updates ✅ COMPLETE
- [x] Display branch name on task cards (with GitBranch icon)
- [x] Show branch name in human review modal (badge in header)
- [x] Add git status indicator (✓ clean, ⚠ changes pending)
- [x] Auto-fetch git status when human review modal opens
- [x] Remove redundant branch display from modal footer

#### Phase 4: Amp CLI Integration (PRIORITY 2 - AFTER WORKTREES)
**Status:** Ready to Start
**Reference:** See `AMP_CLI_RESEARCH.md` for complete details
**Estimated Time:** 3-5 days (depending on scope)

**Key Decision:** This phase is broken into sub-phases. User can choose to implement all or skip certain features.

---

##### Phase 4.1: Basic Amp SDK Integration ✅ FOUNDATION (REQUIRED)
**Goal:** Get real amp SDK working end-to-end with minimal features

**Tasks:**
- [ ] Install `@sourcegraph/amp-sdk` dependency
- [ ] Create real amp adapter at `src/lib/cli/amp.ts` (currently stub)
- [ ] Implement `execute()` function with basic parameters:
  - [ ] `prompt` - Task description
  - [ ] `cwd` - Working directory (use worktree path)
  - [ ] `signal` - AbortSignal for cancellation
- [ ] Update CLI factory to switch between mock/amp based on environment
- [ ] Add `AMP_API_KEY` to `.env.local`
- [ ] Create `.env.example` with placeholder

**Files to Modify:**
- `src/lib/cli/amp.ts` - Real implementation
- `src/lib/cli/factory.ts` - Add mode switching logic
- `.env.local` - Add API key (gitignored)
- `.env.example` - Document required vars
- `package.json` - Add SDK dependency

**Testing:**
- [ ] Test ONE minimal prompt: "List files in current directory"
- [ ] Verify response is received
- [ ] Monitor cost (should be <$0.01)
- [ ] Verify worktree isolation works

**Success Criteria:**
- Real amp SDK executes successfully
- Response streaming works
- Agent runs in worktree (not main repo)
- Cost tracked and under budget

**Estimated Cost:** $0.05-0.10 for initial testing

---

##### Phase 4.2: Mode Selection & Cost Controls ⭐ HIGH VALUE (RECOMMENDED)
**Goal:** Enable rush mode for 67% cost savings

**Tasks:**
- [ ] Create `.amp/settings.json` generator function
- [ ] Add mode field to Task schema: `mode?: 'rush' | 'smart'`
- [ ] Update new-task-modal.tsx to show mode selection (may already exist)
- [ ] Generate settings file with selected mode before agent execution
- [ ] Pass `settingsFile` option to amp SDK execute()
- [ ] Default to **rush mode** for cost savings

**Settings File Generation:**
```typescript
// src/lib/cli/amp-settings.ts
export function generateAmpSettings(mode: 'rush' | 'smart', taskId: string) {
  const settingsPath = `.amp/tasks/${taskId}/settings.json`;
  const settings = {
    "amp.mode": mode,
    "amp.notifications.enabled": false  // Disable for headless
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}
```

**UI Changes:**
- [ ] Mode radio buttons in new task modal (if not already present)
- [ ] Show cost estimate difference (Rush: ~$0.03, Smart: ~$0.10)
- [ ] Add tooltip explaining when to use each mode

**Files to Modify:**
- `src/lib/tasks/schema.ts` - Add mode field
- `src/lib/cli/amp-settings.ts` - NEW: Settings generator
- `src/components/tasks/new-task-modal.tsx` - Mode UI (verify exists)
- `src/app/api/agents/start-*/route.ts` - Generate settings before execution

**Testing:**
- [ ] Test simple task with rush mode (should be 67% cheaper)
- [ ] Test complex task with smart mode (verify quality)
- [ ] Compare costs and results

**Success Criteria:**
- Mode selection works in UI
- Settings file generated correctly
- Rush mode uses Haiku 4.5 (verify via logs)
- Smart mode uses Opus 4.5 (verify via logs)
- Cost difference measurable

**Estimated Savings:** 67-77% per task when using rush mode

---

##### Phase 4.3: Thread Management (OPTIONAL - HIGH VALUE)
**Goal:** Enable thread continuation for 50-70% additional savings

**Tasks:**
- [ ] Add `threadId` field to Task schema
- [ ] Store thread ID after agent execution completes
- [ ] Add "Continue from previous task" checkbox in new task modal
- [ ] Implement thread continuation logic:
  - [ ] Find most recent completed task
  - [ ] Extract threadId from that task
  - [ ] Pass `continue: threadId` to amp SDK
- [ ] Thread compaction strategy:
  - [ ] Auto-compact if thread >100k tokens
  - [ ] Manual compact button in task detail modal

**Thread Continuation Logic:**
```typescript
// In agent execution
const continueFrom = task.continueFromTask
  ? await getPreviousThreadId(task.continueFromTask)
  : undefined;

execute({
  prompt: task.description,
  options: {
    continue: continueFrom,  // Reuse context
    settingsFile: settingsPath
  }
})
```

**UI Components:**
- [ ] Checkbox: "☑ Continue from previous task" in new task modal
- [ ] Dropdown: Select which task to continue from (recent tasks only)
- [ ] Thread info display in task detail modal
- [ ] "Compact Thread" button for manual compaction

**Files to Modify:**
- `src/lib/tasks/schema.ts` - Add threadId, continueFromTask fields
- `src/components/tasks/new-task-modal.tsx` - Thread continuation UI
- `src/app/api/agents/start-*/route.ts` - Thread continuation logic
- `src/components/tasks/task-detail-modal.tsx` - Thread info display

**Testing:**
- [ ] Create task A, complete it, note threadId
- [ ] Create task B continuing from A
- [ ] Verify context is reused (fewer input tokens)
- [ ] Measure cost savings

**Success Criteria:**
- Thread IDs stored and retrieved correctly
- Continuation reduces input tokens by 50-70%
- Cost savings measurable
- Context properly maintained

**Estimated Savings:** 50-70% on input tokens for sequential tasks

---

##### Phase 4.4: Working Directory & Scope Controls (OPTIONAL - MEDIUM VALUE)
**Goal:** Reduce analysis scope for faster, cheaper execution

**Tasks:**
- [ ] Add `scopeDirectory` field to new task modal
- [ ] Pass as `cwd` option to amp SDK
- [ ] Default to worktree path (already have this)
- [ ] Allow user to narrow further (e.g., `./src/auth` within worktree)
- [ ] Permission patterns for file restrictions

**Permission Patterns:**
```typescript
// Automatically exclude common large directories
const defaultPatterns = [
  "!*/node_modules/*",
  "!*/.git/*",
  "!*/dist/*",
  "!*/build/*",
  "!*.log"
];

execute({
  options: {
    cwd: task.worktreePath || process.cwd(),
    permissions: {
      patterns: [...defaultPatterns, ...userPatterns]
    }
  }
})
```

**UI Components:**
- [ ] Input field: "Scope Directory (optional)" in new task modal
- [ ] Show default worktree path as placeholder
- [ ] Advanced settings: Pattern editor for power users

**Files to Modify:**
- `src/components/tasks/new-task-modal.tsx` - Scope directory input
- `src/app/api/agents/start-*/route.ts` - Apply cwd and patterns

**Testing:**
- [ ] Test with narrow scope (e.g., single folder)
- [ ] Verify agent only accesses specified directory
- [ ] Measure performance improvement

**Success Criteria:**
- Scope limiting works correctly
- Agent respects directory boundaries
- Cost reduction measurable (30-50%)

**Estimated Savings:** 30-50% on file analysis

---

##### Phase 4.5: Tool Restrictions & Security (OPTIONAL - LOW PRIORITY)
**Goal:** Fine-grained control over agent capabilities

**Tasks:**
- [ ] Create preset tool profiles:
  - **Minimal:** Only file read/write, no bash
  - **Standard:** Files + git commands
  - **Full:** All tools enabled
- [ ] Command allowlist configuration
- [ ] Strict mode toggle
- [ ] Generate settings.json with tool restrictions

**Tool Profiles:**
```typescript
const toolProfiles = {
  minimal: {
    "amp.tools.disable": ["bash", "search_web"],
    "amp.commands.strict": true
  },
  standard: {
    "amp.tools.disable": ["search_web"],
    "amp.commands.allowlist": ["git *", "npm run *"],
    "amp.commands.strict": true
  },
  full: {
    "amp.dangerouslyAllowAll": false  // Still require approval for risky ops
  }
};
```

**UI Components:**
- [ ] Tool profile dropdown in advanced settings
- [ ] Custom allowlist editor (textarea)
- [ ] Warning for full/dangerous mode

**Files to Modify:**
- `src/lib/cli/amp-settings.ts` - Tool profile logic
- `src/components/tasks/new-task-modal.tsx` - Tool profile UI

**Testing:**
- [ ] Test minimal profile - verify bash blocked
- [ ] Test standard profile - verify git allowed
- [ ] Test strict mode - verify approval required

**Success Criteria:**
- Tool restrictions enforced correctly
- Security boundaries respected
- No unexpected command execution

**Estimated Savings:** 10-20% on unnecessary operations

---

##### Phase 4.6: Timeout & Abort Controls (RECOMMENDED - SAFETY NET)
**Goal:** Prevent runaway costs

**Tasks:**
- [ ] Add timeout field to Task schema
- [ ] Default timeouts based on mode:
  - Rush mode: 120s default
  - Smart mode: 300s default
- [ ] Implement AbortController in agent execution
- [ ] UI controls:
  - [ ] Timeout slider in new task modal (30s - 600s)
  - [ ] "Stop Agent" button (already exists)
  - [ ] Timeout warning before execution

**Timeout Implementation:**
```typescript
const controller = new AbortController();
const timeout = task.timeout || (task.mode === 'rush' ? 120000 : 300000);

const timeoutId = setTimeout(() => {
  controller.abort();
  console.log(`Task ${task.id} timed out after ${timeout}ms`);
}, timeout);

try {
  await execute({
    prompt: task.description,
    signal: controller.signal,
    options: { ... }
  });
} finally {
  clearTimeout(timeoutId);
}
```

**UI Components:**
- [ ] Timeout slider in new task modal
- [ ] Show estimated time in task card
- [ ] Timeout warning if task runs long

**Files to Modify:**
- `src/lib/tasks/schema.ts` - Add timeout field
- `src/components/tasks/new-task-modal.tsx` - Timeout slider
- `src/app/api/agents/start-*/route.ts` - Abort logic

**Testing:**
- [ ] Test timeout triggers correctly
- [ ] Verify agent stops gracefully
- [ ] Confirm no zombie processes

**Success Criteria:**
- Timeout enforced reliably
- Graceful shutdown on abort
- Prevents catastrophic costs

**Estimated Impact:** Prevents $1+ runaway tasks

---

##### Phase 4.7: Cost Tracking & Monitoring (OPTIONAL - HIGH VALUE FOR BUDGET)
**Goal:** Track actual usage and warn before budget exceeded

**Tasks:**
- [ ] Token usage tracking per task
- [ ] Cost calculation based on mode:
  - Opus 4.5: $5 input / $25 output per 1M tokens
  - Haiku 4.5: ~$1.50 input / ~$7.50 output per 1M tokens
- [ ] Cumulative budget tracking
- [ ] Warning thresholds (50%, 75%, 90% of budget)
- [ ] Usage dashboard in settings panel

**Cost Tracking:**
```typescript
interface TaskCostMetrics {
  taskId: string;
  mode: 'rush' | 'smart';
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  actualDuration: number;
  timestamp: number;
}

// Storage
.code-auto/usage/
├── daily-usage.json        # Daily aggregates
├── task-costs.json         # Per-task breakdown
└── budget-status.json      # Current budget state
```

**UI Components:**
- [ ] Budget indicator in header (e.g., "$3.47 / $27.00 used")
- [ ] Usage dashboard page:
  - [ ] Chart: Cost over time
  - [ ] Table: Most expensive tasks
  - [ ] Breakdown: Rush vs Smart usage
- [ ] Warning modal when approaching limits
- [ ] Cost estimate before starting task

**Files to Create:**
- `src/lib/usage/tracker.ts` - Cost calculation and tracking
- `src/lib/usage/storage.ts` - Usage persistence
- `src/app/settings/usage/page.tsx` - Usage dashboard UI

**Files to Modify:**
- `src/app/api/agents/start-*/route.ts` - Track token usage
- `src/store/task-store.ts` - Budget state management

**Testing:**
- [ ] Run task, verify cost tracked
- [ ] Check daily aggregation works
- [ ] Test warning thresholds trigger correctly

**Success Criteria:**
- Accurate cost tracking (±5%)
- Warnings trigger at correct thresholds
- Usage dashboard shows clear trends

**Estimated Value:** Prevents budget overruns, enables informed decisions

---

##### Phase 4.8: Streaming & Real-time Updates (OPTIONAL - UX IMPROVEMENT)
**Goal:** Show agent work in real-time

**Tasks:**
- [ ] Implement SSE streaming endpoint (currently TODO)
- [ ] Stream amp SDK responses to client
- [ ] Real-time log updates in task detail modal
- [ ] Progress indicators during execution

**Streaming Architecture:**
```
Client                   Server                    Amp SDK
  |                        |                          |
  |--POST /start-dev------>|                          |
  |<--202 Accepted---------|                          |
  |   { taskId, threadId } |                          |
  |                        |                          |
  |--GET /stream?taskId--->|                          |
  |                        |--execute()-------------->|
  |<--SSE: log message-----|<--yield message----------|
  |<--SSE: log message-----|<--yield message----------|
  |<--SSE: complete--------|<--done-------------------|
```

**Files to Modify:**
- `src/app/api/agents/stream/route.ts` - Implement SSE
- `src/lib/cli/amp.ts` - Yield messages for streaming
- `src/components/tasks/task-detail-modal.tsx` - Stream consumer

**Testing:**
- [ ] Verify real-time log updates
- [ ] Test connection handling
- [ ] Check performance under load

**Success Criteria:**
- Logs appear in real-time (<1s latency)
- Stable SSE connections
- Graceful reconnection on disconnect

**Estimated Value:** Better UX, visibility into agent work

---

##### Phase 4.9: Prompt Optimization & Templates (OPTIONAL - QUALITY IMPROVEMENT)
**Goal:** Improve task success rate and reduce costs

**Tasks:**
- [ ] Create prompt templates for common tasks:
  - "Fix bug in {file}"
  - "Add feature: {description}"
  - "Refactor {component}"
  - "Write tests for {function}"
- [ ] Prompt builder UI with guided inputs
- [ ] Auto-include file references for rush mode
- [ ] Prompt preview before execution

**Template Example:**
```typescript
const promptTemplates = {
  bugFix: (file: string, issue: string) =>
    `Fix the bug in ${file}. Issue: ${issue}\n\nPlease modify only this file and preserve existing functionality.`,

  addFeature: (description: string, files: string[]) =>
    `Add feature: ${description}\n\nModify these files:\n${files.map(f => `- ${f}`).join('\n')}\n\nUse existing patterns and conventions.`,

  writeTests: (functionName: string, file: string) =>
    `Write unit tests for the function "${functionName}" in ${file}.\n\nFollow existing test patterns and achieve >90% coverage.`
};
```

**UI Components:**
- [ ] Template selector dropdown
- [ ] Guided form for template parameters
- [ ] Prompt preview/edit textarea
- [ ] "Optimize for rush mode" checkbox

**Files to Create:**
- `src/lib/prompts/templates.ts` - Template definitions
- `src/components/tasks/prompt-builder.tsx` - Builder UI

**Testing:**
- [ ] Test each template with rush mode
- [ ] Measure success rate improvement
- [ ] Compare cost vs freeform prompts

**Success Criteria:**
- Templates reduce iterations by 30%+
- Higher success rate on first attempt
- Lower average cost per task

**Estimated Savings:** 20-40% through reduced iterations

---

##### Phase 4.10: Testing & Validation (REQUIRED BEFORE PRODUCTION)
**Goal:** Verify amp integration works reliably

**Tasks:**
- [ ] Unit tests for amp adapter
- [ ] Integration tests for agent lifecycle
- [ ] E2E tests for full workflow (planning → dev → qa → review)
- [ ] Cost validation tests
- [ ] Error handling tests

**Test Scenarios:**
- [ ] Simple task with rush mode
- [ ] Complex task with smart mode
- [ ] Thread continuation across tasks
- [ ] Timeout abort
- [ ] Permission violations
- [ ] Network failures
- [ ] API key invalid/expired

**Files to Create:**
- `tests/unit/cli/amp.test.ts` - Adapter unit tests
- `tests/integration/agents/lifecycle.test.ts` - Integration tests
- `e2e/amp-workflow.spec.ts` - Full workflow E2E tests

**Success Criteria:**
- All tests passing
- Error cases handled gracefully
- Cost tracking accurate
- No memory leaks or zombie processes

**Estimated Time:** 1-2 days

---

### Phase 4 Summary

**Minimum Viable (Required):**
- Phase 4.1: Basic SDK Integration
- Phase 4.6: Timeout Controls
- Phase 4.10: Testing

**High Value (Recommended):**
- Phase 4.2: Mode Selection (67% savings)
- Phase 4.3: Thread Management (50% savings)
- Phase 4.7: Cost Tracking (budget protection)

**Optional Enhancements:**
- Phase 4.4: Scope Controls
- Phase 4.5: Tool Restrictions
- Phase 4.8: Real-time Streaming
- Phase 4.9: Prompt Templates

**Total Estimated Time:**
- Minimum: 2-3 days
- Recommended: 4-5 days
- Full Implementation: 6-8 days

**Budget for Testing:**
- Phase 4.1 only: ~$0.50
- With 4.2 + 4.3: ~$1.00
- Full testing: ~$2-3

**Expected ROI:**
- Without optimization: 270 tasks from $27
- With mode + thread: 1,350+ tasks from $27
- **5x improvement in budget efficiency**

#### Phase 5: MR/PR Creation & Git Integration (PRIORITY 3)
- [ ] "Create MR" button in human review modal
- [ ] "Review Changes Locally" (stage MR) implementation
- [ ] VS Code integration
- [ ] File explorer opening

### 📋 NOT STARTED

#### Phase 6: Memory System
- [ ] Patterns storage (learned approaches)
- [ ] Gotchas (known issues & solutions)
- [ ] History (task execution records)
- [ ] Context injection into agent prompts

#### Phase 7: GitHub/GitLab Integration
- [ ] GitHub issue import as tasks
- [ ] GitLab issue import as tasks
- [ ] Create PR from worktrees
- [ ] Bidirectional status sync
- [ ] PR comments with agent progress

#### Phase 8: Settings & Cost Management
- [ ] Settings panel for API keys
- [ ] Mode selection (Rush vs Smart)
- [ ] Usage tracking dashboard
- [ ] Budget alerts & thresholds
- [ ] Dev mode toggle

---

## Current Architecture

### Workflow Phases (5-Phase System)

**UPDATED:** Simplified from 6-phase to 5-phase for clearer workflow:

1. **Planning** → Generate plan via Q&A or direct → Human approval (if needed) → Auto-start dev
2. **in_progress** → Dev subtasks execute sequentially → Auto-transition to ai_review
3. **ai_review** → QA subtasks execute sequentially → Auto-transition to human_review
4. **human_review** → Manual review of changes → Approval to merge → Transition to done
5. **done** → Completed tasks

### Key Components

```
Frontend:
├── Kanban Board (task-card.tsx)
│   ├── Planning Phase → Q&A Modal, Plan Review Modal
│   ├── in_progress → Task Detail Modal (dev subtasks + logs)
│   ├── ai_review → Task Detail Modal (QA subtasks + logs)
│   └── human_review → Human Review Modal (review + merge options)
├── Task Creation (new-task-modal.tsx)
└── Theme System (CSS variables for consistent styling)

Backend:
├── /api/agents/start-planning → Generate questions/plan
├── /api/agents/start-development → Execute dev subtasks
├── /api/agents/start-review → Execute QA subtasks
├── /api/agents/stream → SSE streaming (TODO)
├── /api/tasks/* → Task CRUD operations
└── /api/cli/adapters → List available CLI tools

State Management:
└── task-store.ts (Zustand) → Global task state
```

---

## Technical Achievements

### 1. Automatic Phase Transitions ✅
- When all dev subtasks complete → Auto-transition to ai_review
- When all QA subtasks complete → Auto-transition to human_review
- Manual approval required only in human_review phase
- No manual button clicks needed for flow progression

### 2. Modal Event Prevention ✅
- All modals prevent click/drag events from propagating to background
- Handlers: `stopPropagation()` + `preventDefault()` on:
  - `click`, `mouseDown`, `pointerDown`, `dragStart`
- Applied to: DialogContent, content divs, footer sections
- Cards stay non-draggable while modals are open

### 3. Flexible Planning ✅
- **With Human Review**: Generate Q&A questions → User answers → Generate plan → User approves → Start dev
- **Without Human Review**: Generate plan directly → Auto-approve → Start dev immediately
- Single "Start Task" button handles both flows
- Clarifying questions only asked when needed

### 4. Task Execution Model ✅
- **Planning**: Generates subtasks via mock/real CLI
- **Development**: Dev subtasks execute sequentially with logging
- **AI Review**: QA subtasks execute sequentially with different colored progress
- **Human Review**: Manual inspection before merge
- Subtask statuses: pending → in_progress → completed/skipped

### 5. Visual Feedback ✅
- Progress dots: Blue (dev completed) + Purple (QA completed)
- Progress percentage per phase
- Status indicators: "Planning in progress", "QA review in progress", "Ready for human review"
- Pause buttons to stop active agents
- Task cards highlight clickable state

---

## Files Structure (Current)

```
src/
├── app/
│   ├── page.tsx (Kanban board dashboard)
│   ├── api/
│   │   ├── agents/
│   │   │   ├── start-planning/route.ts ✅
│   │   │   ├── start-development/route.ts ✅
│   │   │   ├── start-review/route.ts ✅
│   │   │   ├── stop/route.ts ✅
│   │   │   └── stream/route.ts (TODO)
│   │   ├── tasks/
│   │   │   ├── create/route.ts ✅
│   │   │   ├── list/route.ts ✅
│   │   │   ├── update/route.ts ✅
│   │   │   ├── delete-subtask/route.ts ✅
│   │   │   ├── skip-subtask/route.ts ✅
│   │   │   └── reorder-subtasks/route.ts ✅
│   │   └── cli/
│   │       └── adapters/route.ts ✅
│   ├── task/[id]/page.ts (TODO)
│   └── settings/page.tsx (TODO)
├── components/
│   ├── kanban/
│   │   └── task-card.tsx ✅ (with all phase handlers)
│   ├── tasks/
│   │   ├── new-task-modal.tsx ✅
│   │   ├── task-detail-modal.tsx ✅
│   │   ├── qa-stepper-modal.tsx ✅
│   │   ├── plan-review-modal.tsx ✅
│   │   └── human-review-modal.tsx ✅ (NEW)
│   └── ui/ (shadcn/ui components) ✅
├── lib/
│   ├── agents/
│   │   └── singleton.ts ✅
│   ├── cli/
│   │   ├── base.ts ✅
│   │   ├── mock.ts ✅
│   │   ├── amp.ts ✅
│   │   └── factory.ts ✅
│   ├── git/
│   │   └── worktree.ts (TODO - NEXT PRIORITY)
│   ├── tasks/
│   │   ├── schema.ts ✅
│   │   └── persistence.ts ✅
│   ├── memory/
│   │   ├── storage.ts (TODO)
│   │   └── context.ts (TODO)
│   └── integrations/
│       ├── github.ts (TODO)
│       └── gitlab.ts (TODO)
└── store/
    └── task-store.ts ✅

.code-auto/
├── tasks/
│   ├── {task-id}.json
│   ├── {task-id}/planning-logs.txt
│   ├── {task-id}/development-logs.txt
│   └── {task-id}/review-logs.txt
└── config.json (TODO)
```

---

## Next Steps (Prioritized)

### PHASE 3: Git Worktree Integration (PRIORITY 1)
**Estimated Time:** 2-3 days  
**Strategy:** Git research complete; implementation ready to start with Phase 3.1

#### Git Worktree Architecture (Decided)

**Key Insights:**
- Git supports multiple linked worktrees per repository
- All worktrees share the same `.git` directory (no data duplication)
- Each worktree has independent `HEAD`, `index`, and branch tracking
- Worktrees can be created/deleted independently without affecting others

**Our Approach:**
- **Location:** `.code-auto/worktrees/{task-id}/`
- **Branch naming:** `auto-claude/{task-id}` (one branch per task)
- **Lifecycle:** Auto-create on task creation; auto-delete on completion (if no MR created)
- **Multi-task:** Support concurrent worktrees (multiple agents on different tasks)
- **Sequential subtasks:** All subtasks for same task work in same worktree

**Git Commands Used:**
```bash
# Create worktree with new branch
git worktree add <path> -b <branch-name>

# List all worktrees
git worktree list

# Delete worktree
git worktree remove <path> [--force]
```

#### Implementation Phases

**Phase 3.1: WorktreeManager (Foundation)**
1. Create `src/lib/git/worktree.ts` with:
   - Auto-detect main repo path and main branch
   - Create/delete worktrees with error handling
   - Query worktree status and git changes
   - UUID-based naming fallback for conflict prevention

**Phase 3.2: Task Integration (Core)**
1. Update `Task` schema: Add `worktreePath` and `branchName` fields
2. Update task creation: Trigger worktree creation immediately
3. Update agent execution: Pass `workingDirectory` to CLI adapter
4. Persist worktree info in task storage

**Phase 3.3: Testing & Validation (Quality)**
1. Create task → Verify worktree exists at correct path
2. Run full workflow → Verify changes in branch, not main
3. Multiple concurrent tasks → Verify independent worktrees
4. Mock CLI only (cost-free testing)

**Phase 3.4: UI Polish (UX)**
1. Show branch name on task cards
2. Display branch in human review modal
3. Add git status indicators
4. Optional: Show worktree path in details

### PHASE 4: Real Agent Integration (PRIORITY 2)
**Estimated Time:** 1-2 days

1. **Swap mock for real amp SDK**
   - Update CLI factory to use real amp when mode is "smart"
   - Keep mock for testing

2. **Test Minimal Prompt**
   - Single task, single agent, monitor cost
   - Verify streaming works
   - Check worktree isolation

3. **Full Workflow Test**
   - Planning → Q&A → Plan → Dev → Review → Human Review
   - Real agents execute in isolated worktrees
   - Cost monitoring active

### PHASE 5: MR/PR Creation (PRIORITY 3)
**Estimated Time:** 2-3 days

1. Implement "Create MR" endpoint
2. Implement "Review Locally" (stage changes)
3. Add VS Code integration
4. Add file explorer opening

### PHASE 6+: Memory & Integrations
After core workflow is solid with real agents and worktrees.

---

## Critical Implementation Notes

### For Worktree Integration:
- **Auto-detection**: Script detects main branch and repo root automatically
- **Branch naming**: `auto-claude/{task-id}` + UUID suffix for conflict prevention
- **Worktree location**: `.code-auto/worktrees/{task-id}/` (isolated from main)
- **Lifecycle**: Create on task creation; delete on completion (unless MR exists)
- **Multi-agent**: Multiple concurrent worktrees support parallel task execution
- **Error handling**: Comprehensive try-catch with user-friendly error messages
- **Safety**: All git operations validated and restricted to worktree paths
- **Persistence**: Store `worktreePath` and `branchName` in Task schema
- **CLI integration**: Pass `workingDirectory` parameter to CLI adapter for all agent execution

### For Real Agent Testing:
- **Cost Control**: Start with 1 minimal prompt only
- **Budget Alerts**: Implement before heavy testing
- **Logging**: Track all amp API calls for debugging
- **Fallback**: Always keep mock adapter ready for cost-free testing

### For PR Creation:
- **Prerequisites**: Requires git worktree with changes
- **Tools**: Use `gh` CLI or direct GitHub API
- **Base Branch**: Allow user to select before creating PR
- **Auto-linking**: Link to GitHub issue if available

---

## Dependencies Status

**Installed & Working:**
- ✅ next, react, react-dom, typescript
- ✅ tailwindcss, @radix-ui/*, shadcn/ui
- ✅ @dnd-kit/core, @dnd-kit/sortable (drag-drop)
- ✅ lucide-react (icons)
- ✅ zustand (state management)
- ✅ sonner (toast notifications)
- ✅ @sourcegraph/amp-sdk (ready to use)

**Not Yet Needed:**
- ⏳ @octokit/rest (GitHub API) - Phase 7
- ⏳ @gitbeaker/node (GitLab API) - Phase 7

---

## Success Criteria - UPDATED

### MVP Complete When:
- [x] Kanban board displays tasks across 5 phases
- [x] Can create/edit tasks from UI
- [x] Multiple agents work with mock (tested with Mock adapter)
- [ ] Each task has isolated worktree (PHASE 3 - NEXT)
- [ ] Worktree creation works end-to-end
- [ ] Changes stay in branch, not on main
- [ ] Can delete worktree on completion
- [ ] Full workflow works in isolated branch (planning → dev → review → human review)
- [ ] Can create PR from completed task (Phase 5 - After worktrees)
- [ ] Memory stores patterns/gotchas (Phase 6)
- [ ] Context injected into agent prompts (Phase 6)
- [ ] GitHub issues import as tasks (Phase 7)
- [x] Mock adapter works for all testing scenarios
- [ ] Real amp SDK integration verified with minimal tests
- [ ] Settings panel for API keys and dev mode toggle (Phase 8)

### Production Ready When:
- [ ] All error cases handled gracefully
- [ ] Usage tracking dashboard implemented
- [ ] Budget alerts working
- [ ] Documentation complete
- [ ] Performance tested with 12 concurrent agents (Mock)
- [ ] Security audit passed
- [ ] Onboarding flow complete
- [ ] Mode selection working

---

## Known Limitations & TODOs

1. **SSE Streaming**: Currently using polling; SSE streaming not fully implemented
2. **Settings Panel**: No persistent settings/API key management yet
3. **Cost Tracking**: Not tracking amp API costs yet
4. **GitHub Integration**: Not integrated yet
5. **Memory System**: Not implemented yet
6. **Real Agent Testing**: Only tested with mock so far

---

## Session Milestones

**Session 1-2:** ✅ Foundation & Planning Phase
- CLI adapters, mock CLI, task schema, planning workflow

**Session 3:** ✅ Development & Review Phases  
- Dev/QA subtask execution, automatic transitions

**Session 4:** ✅ Human Review Phase & UI Polish
- Human review modal, event propagation prevention, button styling

**Session 5:** ✅ Worktree Integration (COMPLETE)
- Git research & architecture ✅
- WorktreeManager implementation ✅
- Task integration & testing ✅
- UI updates for git status ✅

**Session 6:** Amp CLI Integration (Phase 4) - Choose sub-phases to implement
**Session 7+:** MR/PR Creation → Memory System → GitHub Integration

---

## Current Session (Session 5 - COMPLETE)

### Completed ✅
- [x] Key decision questions on worktree strategy
- [x] Git worktree research and validation
- [x] Implementation plan refined with git commands
- [x] Architecture decisions documented
- [x] **Phase 3.1:** WorktreeManager class created and tested
- [x] **Phase 3.2:** Task integration endpoints created
- [x] 18/18 worktree integration tests passing
- [x] Build verification passed
- [x] **Mock CLI enhanced** with attendance tracking
- [x] **E2E tests created** (5 comprehensive tests for Phase 3.3 validation)
- [x] **Phase 3.3:** Testing & Validation complete (5/5 E2E tests passing)
- [x] **Phase 3.4:** UI Updates complete

### Phase 3.4: UI Updates - Details ✅
1. ✅ Display branch name on task cards (GitBranch icon + monospace font)
2. ✅ Show branch prominently in human review modal header (badge style)
3. ✅ Add git status indicators (✓ clean, ⚠ changes with appropriate colors)
4. ✅ Created `/api/git/status` endpoint to fetch worktree status
5. ✅ Auto-fetch git status when human review modal opens
6. ✅ Removed redundant branch display from modal footer

### Session 5 Continued: Amp CLI Research ✅
7. ✅ Comprehensive research on amp CLI/SDK parameters
8. ✅ Cost optimization strategies documented
9. ✅ Mode selection (rush vs smart) research - 67% cost savings
10. ✅ Thread management and continuation research - 50% savings
11. ✅ Tool restrictions, permissions, and security research
12. ✅ Created **`AMP_CLI_RESEARCH.md`** - Complete reference document
13. ✅ Updated implementation plan with detailed Phase 4 breakdown (10 sub-phases)

**Session 5 Final Deliverables:**
- Phase 3: Complete worktree integration (all 4 sub-phases) ✅
- Phase 3.4: UI polish with branch display and git status ✅
- Amp Research: Comprehensive cost optimization guide ✅
- Phase 4 Planning: Detailed 10-phase implementation roadmap ✅

### Next Session (Session 6)
**Phase 4: Amp CLI Integration** (PRIORITY 1)
- See detailed Phase 4 breakdown above (10 sub-phases)
- Minimum: Phase 4.1 (Basic SDK) + 4.6 (Timeouts) + 4.10 (Testing)
- Recommended: Add 4.2 (Mode Selection) + 4.3 (Thread Management) + 4.7 (Cost Tracking)
- User can choose which sub-phases to implement/skip

---

## Session 5 Complete - Phase 3 Worktree Integration COMPLETE ✅

**Final Status:**
- Phase 3.1: WorktreeManager ✅ (18/18 tests passing)
- Phase 3.2: Task Integration ✅ (worktrees auto-created on task creation)
- Phase 3.3: Testing & Validation ✅ (5/5 E2E tests + live workflow verified)
- Phase 3.4: UI Updates ✅ (branch display + git status indicators)

**Deliverables:**
1. Enhanced Mock CLI with Testing Attendance File (Mock-Only)
   - Extracts subtask labels from execution prompts
   - **Actually writes** attendance file to worktree root for testing
   - Records execution proof with ISO timestamps (simulated work)
   - Tracks thread → worktree mapping for correct paths
   - Creates `subtask-attendance.txt` at worktree root (visible in git status)
   - **Note:** Real agents (Phase 4) will make actual code changes instead

2. Fixed Phase State Issues
   - Planning phase correctly stays as 'planning' (not 'pending')
   - Phase transitions: planning → in_progress → ai_review → human_review
   - Auto-transitions when all subtasks in phase complete

3. Live End-to-End Verification (Manual Testing)
   - ✅ Task created with worktree
   - ✅ Planning auto-starts and auto-completes
   - ✅ Dev phase auto-starts with subtask generation
   - ✅ All subtasks execute sequentially with attendance tracking
   - ✅ QA phase executes with verification subtasks  
   - ✅ Attendance file created in worktree with all executions
   - ✅ Git branch properly isolated (no main changes)
   - ✅ Working tree clean (no spurious file changes)

4. Comprehensive E2E Test Suite (e2e/worktree-integration.spec.ts)
   - ✅ Worktree creation on task creation
   - ✅ Seeded task worktree verification  
   - ✅ Task metadata validation (branch + worktree path)
   - ✅ Unique branch isolation per task
   - ✅ Concurrent worktree independence

**Phase 3: COMPLETE AND VERIFIED** ✅
- All core worktree functionality working end-to-end
- File operations at worktree root (visible in `git status`)
- All 10 subtasks execute with proof recorded
- Phase transitions automatic and reliable
- Branch isolation confirmed (no main pollution)
- Ready for Phase 3.4: UI enhancements

**Live Verification Summary:**
```
Task: task-1768647046113-gfw29
Status: All phases completed (planning → dev → qa)
Worktree: .code-auto/worktrees/task-1768647046113-gfw29 ✅
Branch: auto-claude/task-1768647046113-gfw29 ✅

Git Status Output:
On branch auto-claude/task-1768647046113-gfw29
Untracked files:
  subtask-attendance.txt ✅

Subtask Attendance (10 total):
[step-1] through [step-10] - all recorded with timestamps ✅
```
