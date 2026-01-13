# Code-Auto Implementation Plan

## Overview

Build a Next.js web application that wraps amp CLI to provide Auto-Claude features (Kanban board, parallel agents, git worktrees, GitHub/GitLab integration) in the browser.

**Key Decisions:**
- **Next.js 14+** with App Router and TypeScript
- **amp SDK** (`@sourcegraph/amp-sdk`) for CLI integration (paid credits only)
- **shadcn/ui + Tailwind** for UI components
- **Zustand** for state management
- **Server-Sent Events (SSE)** for real-time agent streaming
- **File-based storage** (JSON) for tasks and memory
- **Modular architecture** with pluggable CLI adapter layer (swap amp for other CLIs later)

**Important Note on Free Mode:** Amp's free tier is ad-supported, requiring the amp UI to display ads. Since we're running amp as a headless process (SDK), free mode won't work. This app requires paid amp credits.

---

## Architecture

### Project Structure
```
Code-Auto/
├── src/
│   ├── app/                      # Next.js App Router
│   │   ├── page.tsx              # Main dashboard (Kanban)
│   │   ├── api/                  # API routes
│   │   │   ├── agents/           # Agent start/stop/stream
│   │   │   ├── tasks/            # Task CRUD
│   │   │   ├── worktrees/        # Git worktree ops
│   │   │   ├── github/           # GitHub integration
│   │   │   └── gitlab/           # GitLab integration
│   │   ├── settings/page.tsx     # Settings & API keys
│   │   └── task/[id]/page.tsx    # Task detail view
│   ├── lib/                      # Core business logic
│   │   ├── cli/                  # CLI Adapter Layer (PLUGGABLE)
│   │   │   ├── base.ts           # Abstract interface
│   │   │   ├── amp.ts            # Amp implementation
│   │   │   └── factory.ts        # CLI factory
│   │   ├── agents/               # Agent orchestration
│   │   ├── git/                  # Worktree management
│   │   ├── memory/               # File-based memory
│   │   ├── tasks/                # Task persistence
│   │   └── integrations/         # GitHub/GitLab
│   ├── components/               # React components
│   │   ├── kanban/               # Kanban board
│   │   ├── agents/               # Agent terminals
│   │   └── ui/                   # shadcn components
│   └── store/                    # Zustand stores
└── .auto-claude/                 # Data directory
    ├── worktrees/tasks/          # Git worktrees
    ├── memory/                   # Patterns, gotchas, history
    ├── tasks/                    # Task JSON files
    └── config.json               # Project config
```

### CLI Adapter Layer (Modular Design)

**Purpose:** Abstract amp CLI behind an interface so it can be swapped for other CLIs (Aider, Cursor, etc.) in the future.

**Key Files:**
- `src/lib/cli/base.ts` - Abstract `CLIAdapter` interface
- `src/lib/cli/amp.ts` - Amp SDK implementation
- `src/lib/cli/factory.ts` - Factory to create CLI adapters

**Interface:**
```typescript
interface CLIAdapter {
  initialize(config: CLIConfig): Promise<void>;
  execute(request: ExecuteRequest): AsyncIterable<StreamMessage>;
  createThread(workingDir: string): Promise<string>;
  resumeThread(threadId: string): Promise<void>;
  stopThread(threadId: string): Promise<void>;
  getCapabilities(): CLICapabilities;
}
```

**Benefits:** Change CLI provider by modifying `CLIFactory.create('amp')` to another provider. All business logic uses the interface, not amp-specific code.

---

## Core Features

### 1. Kanban Board

**6 Workflow Phases** (from Auto-Claude):
1. Discovery - Understanding requirements
2. Requirements - Defining specs
3. Context - Gathering codebase context
4. Spec - Creating implementation spec
5. Planning - Breaking down tasks
6. Validate - QA and verification

**Task Model:**
```typescript
interface Task {
  id: string;
  title: string;
  description: string;
  phase: WorkflowPhase;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  subtasks: Subtask[];
  assignedAgent?: string;        // Thread ID
  worktreePath?: string;
  branchName?: string;          // auto-claude/{task-name}
  githubIssue?: number;
  metadata: { complexity, dependencies };
}
```

**Storage:** `.auto-claude/tasks/{task-id}.json` + `implementation_plan.json` (Auto-Claude compatibility)

**UI:** shadcn/ui cards with @dnd-kit for drag-and-drop between phases

**Critical Files:**
- `src/lib/tasks/schema.ts` - Task data model
- `src/lib/tasks/persistence.ts` - JSON storage
- `src/components/kanban/board.tsx` - Kanban UI

---

### 2. Parallel Agent Execution

**Architecture:**
- Support up to 12 concurrent amp threads (matching Auto-Claude limit)
- Use amp SDK's native thread management (`continue: threadId`)
- Each task gets isolated thread with dedicated terminal view
- Real-time streaming via Server-Sent Events (SSE)

**Agent Manager:**
```typescript
class AgentManager {
  private cli: CLIAdapter;
  private activeAgents: Map<string, AgentSession>;

  async startAgent(taskId, prompt, options): Promise<threadId>
  async stopAgent(threadId): Promise<void>
  getAgentStatus(threadId): AgentSession
}
```

**Session Tracking:**
```typescript
interface AgentSession {
  taskId: string;
  threadId: string;
  status: 'running' | 'completed' | 'error' | 'stopped';
  startedAt: number;
  logs: AgentLog[];
}
```

**Streaming Pattern:**
1. Client calls `/api/agents/start` → Gets threadId
2. Client opens SSE connection to `/api/agents/stream?threadId=...`
3. Server streams logs every 100ms (batched for performance)
4. Client displays in terminal component with real-time updates

**Critical Files:**
- `src/lib/agents/manager.ts` - Agent pool management
- `src/app/api/agents/start/route.ts` - Start agent endpoint
- `src/app/api/agents/stream/route.ts` - SSE streaming
- `src/components/agents/terminal.tsx` - Real-time terminal UI

---

### 3. Git Worktree Isolation

**Pattern** (from Auto-Claude):
- Each task gets isolated worktree at `.auto-claude/worktrees/tasks/{task-name}/`
- Branch naming: `auto-claude/{task-name}`
- Protects main branch during experimental development
- Enables parallel work on multiple tasks

**Worktree Manager:**
```typescript
class WorktreeManager {
  async createWorktree(taskName, baseBranch): Promise<worktreePath>
  async removeWorktree(taskName, force): Promise<void>
  async listWorktrees(): Promise<WorktreeInfo[]>
  async getWorktreeStatus(worktreePath): Promise<GitStatus>
  async createPR(taskName, title, body, baseBranch): Promise<prUrl>
}
```

**Workflow:**
1. Task created → Auto-create worktree
2. Agent runs in worktree directory
3. Task completed → Create PR from worktree branch
4. PR merged → Clean up worktree

**Critical Files:**
- `src/lib/git/worktree.ts` - Git worktree operations
- `src/app/api/worktrees/create/route.ts` - API endpoint

---

### 4. Memory System (File-Based)

**Storage:**
- `.auto-claude/memory/patterns.json` - Learned successful approaches
- `.auto-claude/memory/gotchas.json` - Common pitfalls
- `.auto-claude/memory/history.json` - Task execution history

**Data Models:**
```typescript
interface Pattern {
  category: string;      // e.g., "react-patterns", "git-workflows"
  description: string;
  example?: string;
  addedAt: number;
}

interface Gotcha {
  issue: string;
  solution: string;
  context?: string;
  addedAt: number;
}

interface HistoryEntry {
  taskId: string;
  phase: string;
  success: boolean;
  duration: number;
  timestamp: number;
}
```

**Context Injection:**
When starting an agent, build context from memory and inject into prompt:
```
# Context from Memory System

## Learned Patterns
[relevant patterns for this phase]

## Known Issues
[gotchas that apply]

## Recent History
[similar tasks executed before]

# User Request
[actual task prompt]
```

**Critical Files:**
- `src/lib/memory/storage.ts` - JSON file operations
- `src/lib/memory/context.ts` - Context builder and injection

---

### 5. GitHub/GitLab Integration

**Features:**
- Import issues as tasks
- Create PRs from worktrees
- Bidirectional status sync
- Add comments with agent progress

**GitHub Integration:**
```typescript
class GitHubIntegration {
  async listIssues(owner, repo, filters)
  async createPR(owner, repo, params)
  async updateIssueStatus(owner, repo, issueNumber, status)
  async addIssueComment(owner, repo, issueNumber, comment)
}
```

**Authentication:**
- Personal Access Tokens stored in settings
- Saved to `.env.local` (not committed)
- Use `@octokit/rest` for GitHub, `@gitbeaker/node` for GitLab

**Critical Files:**
- `src/lib/integrations/github.ts` - GitHub API client
- `src/lib/integrations/gitlab.ts` - GitLab API client
- `src/app/api/github/` - API routes for GitHub ops

---

## State Management (Zustand)

**Stores:**
- `agent-store.ts` - Agent sessions, logs, start/stop actions
- `task-store.ts` - Tasks, Kanban state, CRUD operations
- `settings-store.ts` - API keys, CLI mode, preferences

**Benefits:**
- No boilerplate like Redux
- Better performance than Context for complex state
- Simple API: `const { tasks } = useTaskStore()`

---

## Cost Management & Testing Strategy

**Challenge:** Limited budget ($27 total credits for testing). Amp charges per API usage.

**Cost Control Features:**

1. **Usage Tracking Dashboard**
   - Real-time cost display in settings
   - Breakdown by task/agent
   - Daily/weekly spending trends
   - Warnings at thresholds (50%, 75%, 90% of budget)

2. **Development Mode (Mock Adapter)**
   ```typescript
   class MockCLIAdapter implements CLIAdapter {
     // Simulates amp responses without API calls
     // Use during UI development and testing
   }
   ```
   - Toggle in settings: "Development Mode (No API calls)"
   - Returns fake streaming responses for testing
   - Enables UI development without burning credits

3. **Smart Mode Selection**
   - **Rush Mode (Haiku 4.5)**: Cheaper, faster - use for simple tasks
   - **Smart Mode (Opus 4.5)**: More expensive - reserve for complex tasks
   - Show estimated cost before starting agent

4. **Session Limits**
   - Max tokens per session (configurable)
   - Auto-stop after N messages
   - Prompt before expensive operations

**Testing Best Practices:**
- Use Mock adapter for all UI/UX testing
- Only test with real amp SDK for critical path validation
- Start with Rush mode (cheaper) for testing
- Test with minimal prompts initially
- Keep detailed logs of what works to avoid retesting

---

## Implementation Phases

### Phase 1: Foundation & Basic Integration (Week 1)
**Goal:** Working Next.js app with amp SDK integration

Tasks:
1. Initialize Next.js 14 with TypeScript, Tailwind, shadcn/ui
2. Create project structure (all directories)
3. Implement CLI adapter layer (base interface + amp implementation + mock adapter)
4. Build Mock adapter for cost-free testing
5. Test basic amp SDK execution (ONE simple prompt only - conserve credits)
6. Build file-based task storage

**Verification:**
- Run `npm run dev` successfully
- Mock adapter returns simulated responses (use this for most testing)
- Execute ONE test prompt via real amp SDK to verify integration
- Save/load task from `.auto-claude/tasks/`

---

### Phase 2: Kanban & Task Management (Week 2)
**Goal:** Functional Kanban board with task CRUD

Tasks:
1. Build Kanban board component with @dnd-kit
2. Create task schema and persistence layer
3. Implement task API routes (create, update, list)
4. Add drag-drop between phases
5. Build task detail view
6. Connect Zustand store for task state

**Verification:**
- Create task from UI → Saved to `.auto-claude/tasks/{id}.json`
- Drag task between phases → Status updates
- View task details in dedicated page

---

### Phase 3: Agent Execution & Streaming (Week 2-3)
**Goal:** Start agents on tasks with real-time terminal output

Tasks:
1. Implement AgentManager with thread pool
2. Create agent start/stop API routes
3. Build SSE streaming endpoint
4. Create terminal component with real-time logs
5. Add agent status indicators to Kanban cards
6. Implement concurrent agent limit (12 max)

**Verification:**
- Click "Start Agent" on task → Agent begins execution
- See real-time logs streaming in terminal
- Multiple agents run simultaneously (up to 12)
- Stop agent mid-execution successfully

---

### Phase 4: Git Worktree Integration (Week 3)
**Goal:** Isolated worktrees per task

Tasks:
1. Implement WorktreeManager
2. Auto-create worktree when task created
3. Configure agents to run in worktree directory
4. Add git status display in UI
5. Implement worktree cleanup on task completion
6. Build PR creation workflow

**Verification:**
- Create task → Worktree appears at `.auto-claude/worktrees/tasks/{task}/`
- Agent modifies files in worktree (not main branch)
- Create PR from worktree → PR opens on GitHub

---

### Phase 5: Memory System (Week 4)
**Goal:** Context persistence and learning

Tasks:
1. Implement MemoryStorage (patterns, gotchas, history)
2. Build ContextBuilder for prompt injection
3. Add memory recording after task completion
4. Create UI for viewing/editing memory
5. Integrate context into agent execution

**Verification:**
- Complete task → History entry saved
- Start new similar task → Context injected from memory
- View patterns/gotchas in settings UI

---

### Phase 6: External Integrations (Week 4-5)
**Goal:** GitHub/GitLab sync

Tasks:
1. Implement GitHubIntegration class
2. Implement GitLabIntegration class
3. Build issue import workflow
4. Add PR creation from worktrees using `gh` CLI
5. Implement bidirectional status sync
6. Build OAuth flow for auth (if needed)

**Verification:**
- Import GitHub issue → Creates task in Kanban
- Complete task → Update GitHub issue status
- Create PR from worktree → PR appears on GitHub with correct base branch

---

### Phase 7: Polish & Production (Week 5-6)
**Goal:** Production-ready application

Tasks:
1. Add comprehensive error handling
2. Build usage tracking dashboard (cost monitoring, warnings)
3. Build settings panel (API keys, mode selection, integrations, dev mode toggle)
4. Implement budget alerts and session limits
5. Create onboarding flow
6. Performance optimization (SSE batching, store selectors)
7. Write documentation (README, setup guide, cost management)
8. Add tests for critical paths (use Mock adapter)

**Verification:**
- All error cases handled gracefully
- Usage dashboard shows accurate costs
- Budget warnings trigger at thresholds
- Settings persist across sessions
- App handles 12 concurrent agents without performance issues
- All tests run with Mock adapter (no API costs)

---

## Critical Files to Create (Priority Order)

### Priority 1: Core Infrastructure
1. `src/lib/cli/base.ts` - CLI adapter interface (foundation for modularity)
2. `src/lib/cli/mock.ts` - Mock adapter for cost-free testing (create FIRST)
3. `src/lib/cli/amp.ts` - Amp SDK implementation (test minimally)
4. `src/lib/cli/factory.ts` - CLI factory pattern
5. `src/lib/tasks/schema.ts` - Task data model
6. `src/lib/tasks/persistence.ts` - File-based task storage

### Priority 2: Agent Execution
6. `src/lib/agents/manager.ts` - Agent pool management
7. `src/app/api/agents/start/route.ts` - Start agent endpoint
8. `src/app/api/agents/stream/route.ts` - SSE streaming
9. `src/store/agent-store.ts` - Agent state management

### Priority 3: UI Components
10. `src/components/kanban/board.tsx` - Main Kanban board
11. `src/components/agents/terminal.tsx` - Real-time terminal
12. `src/app/page.tsx` - Dashboard layout
13. `src/app/settings/page.tsx` - Settings UI

### Priority 4: Git & Integrations
14. `src/lib/git/worktree.ts` - Worktree manager
15. `src/lib/integrations/github.ts` - GitHub client
16. `src/lib/memory/storage.ts` - Memory system
17. `src/lib/memory/context.ts` - Context builder

---

## Technical Considerations

### Long-Running Processes in Next.js
**Challenge:** API routes have timeouts (10s on Vercel)

**Solution:**
- Use SSE for streaming (serverless-compatible)
- Agent execution runs in background via singleton manager
- API route returns threadId immediately, client streams logs separately
- For local dev: Configure timeout in `next.config.js`

### State Persistence Across Restarts
**Challenge:** In-memory agent state lost on server restart

**Solution:**
- Save agent sessions to `.auto-claude/agents/{threadId}.json`
- On startup, restore active agents from disk
- Resume threads using `continue: threadId` option

### Security
- Store API keys in `.env.local` (never commit)
- Lock API routes to same origin
- Validate all git commands to prevent injection
- Restrict worktree operations to `.auto-claude/` directory

### Performance
- Batch SSE messages (send every 100ms)
- Limit log retention (last 1000 messages per agent)
- Use Zustand selectors to prevent re-renders
- Close SSE connections for completed agents

---

## Environment Variables

`.env.local`:
```bash
# Amp Configuration
SOURCEGRAPH_API_KEY=your-amp-api-key

# GitHub (optional)
GITHUB_TOKEN=ghp_your-token
GITHUB_OWNER=username
GITHUB_REPO=repo-name

# GitLab (optional)
GITLAB_TOKEN=your-token
GITLAB_PROJECT_ID=12345

# App Settings
MAX_CONCURRENT_AGENTS=12
DEFAULT_CLI_PROVIDER=amp
```

---

## Dependencies

**Core:**
- `next` - Next.js 14+
- `react`, `react-dom` - React 18+
- `typescript` - Type safety
- `@sourcegraph/amp-sdk` - Amp CLI integration

**UI:**
- `tailwindcss` - Styling
- `@radix-ui/*` - shadcn/ui primitives
- `@dnd-kit/core`, `@dnd-kit/sortable` - Drag and drop
- `lucide-react` - Icons

**State & Data:**
- `zustand` - State management
- `@octokit/rest` - GitHub API
- `@gitbeaker/node` - GitLab API

---

## Success Criteria

### MVP Complete When:
- [ ] Kanban board displays tasks across 6 phases
- [ ] Can create/edit tasks from UI
- [ ] Can start agent on task → Sees real-time output (test with Mock adapter)
- [ ] Multiple agents run in parallel (tested with Mock adapter)
- [ ] Each task has isolated worktree
- [ ] Can create PR from completed task
- [ ] Memory stores patterns/gotchas
- [ ] Context injected into agent prompts
- [ ] GitHub issues import as tasks
- [ ] Mock adapter works for all testing scenarios
- [ ] Real amp SDK integration verified with minimal tests (<$5 spent)
- [ ] Settings panel for API keys and dev mode toggle working

### Production Ready When:
- [ ] All error cases handled gracefully
- [ ] Usage tracking dashboard implemented with cost warnings
- [ ] Budget alerts working (50%, 75%, 90% thresholds)
- [ ] Documentation complete (README, setup guide, cost management guide)
- [ ] Performance tested with 12 concurrent agents (Mock adapter)
- [ ] Security audit passed (no API key leaks, injection vulnerabilities)
- [ ] Onboarding flow guides new users
- [ ] Mode selection (Rush vs Smart) with cost estimates

---

## Next Steps After Plan Approval

1. Initialize Next.js project with `npx create-next-app@latest`
2. Install dependencies from package.json
3. Create project structure (all directories)
4. Set up shadcn/ui with `npx shadcn-ui@latest init`
5. **CRITICAL: Implement Mock adapter FIRST** (enables cost-free development)
6. Implement Phase 1 tasks (CLI adapter base + mock + amp implementations)
7. Test amp SDK with ONE minimal prompt only (verify integration works)
8. Begin Phase 2 (Kanban board) - use Mock adapter for all testing

---

**Ready to begin implementation!**
