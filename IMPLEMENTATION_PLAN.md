# Code-Auto Implementation Plan - UPDATED

**Last Updated:** January 17, 2026 (Updated with Worktree Strategy)  
**Current Status:** Phase 2 (Kanban Board & Planning) - 100% Complete | Phase 3 (Worktree Integration) - Ready to Start

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

#### Phase 3: Git Worktree Integration (PRIORITY 1 - NEXT)
**Status:** Phase 3.1-3.2 Complete - Ready for Testing

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

##### Phase 3.3: Testing & Validation
- [ ] Test worktree creation on new task
- [ ] Test full workflow (planning → dev → review → human review) in isolated branch
- [ ] Verify changes stay in branch (don't touch main)
- [ ] Test worktree cleanup on task completion
- [ ] Test concurrent tasks with multiple worktrees
- [ ] Test with mock CLI only (no amp SDK costs)

##### Phase 3.4: UI Updates (After Core Works)
- [ ] Display branch name on task cards
- [ ] Show branch name in human review modal
- [ ] Add git status indicator (✓ no changes, ⚠ changes pending)
- [ ] Optional: Show worktree path in task details

#### Phase 4: Real Agent Integration (PRIORITY 2 - AFTER WORKTREES)
- [ ] Swap mock CLI for real amp SDK in development
- [ ] Test single minimal prompt first
- [ ] Verify amp streaming and thread management
- [ ] Monitor for cost/budget
- [ ] Full agent lifecycle testing with worktrees

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

**Session 5:** 🚧 Worktree Integration (CURRENT)
- Git research & architecture (COMPLETE)
- WorktreeManager implementation (NEXT)
- Task integration & testing
- UI updates for git status

**Session 6+:** Real Agents → Memory System → GitHub Integration

---

## Current Session (Session 5)

### Completed ✅
- [x] Key decision questions on worktree strategy
- [x] Git worktree research and validation  
- [x] Implementation plan refined with git commands
- [x] Architecture decisions documented
- [x] **Phase 3.1:** WorktreeManager class created and tested
- [x] **Phase 3.2:** Task integration endpoints created
- [x] 18/18 worktree integration tests passing
- [x] Build verification passed

### Next Steps (Phase 3.3: Testing & Validation)
1. Test actual task creation with worktree via UI/API
2. Run full workflow (planning → dev → review → human review) in isolated branch
3. Verify changes stay in branch, not on main
4. Test concurrent tasks with multiple worktrees
5. Test with mock CLI (no amp SDK costs)

### Then Phase 3.4 (UI Polish)
- Display branch name on task cards
- Show branch in human review modal  
- Add git status indicators

---

**Phase 3.1-3.2 Complete. Ready for Phase 3.3: Testing & Validation**
