# API Routes Documentation

This document describes all Next.js API routes in the Code-Auto application.

## Table of Contents

- [Agents API](#agents-api)
- [CLI API](#cli-api)
- [Git API](#git-api)
- [Tasks API](#tasks-api)
- [Test API](#test-api)
- [Error Handling](#error-handling)
- [Authentication](#authentication)

---

## Agents API

Routes for managing AI agent lifecycle and execution.

### POST `/api/agents/start`

Starts an AI agent on a task.

**Request Body:**
```json
{
  "taskId": "task-1234567890-abc12",
  "prompt": "Implement the feature according to the plan"
}
```

**Response (200):**
```json
{
  "success": true,
  "threadId": "thread-uuid-here",
  "message": "Agent started successfully"
}
```

**Error Responses:**
- `400` - Missing `taskId` or `prompt`
- `404` - Task not found
- `409` - Task already has an agent running
- `500` - Server error

---

### POST `/api/agents/start-planning`

Starts an AI agent to plan a task. Behavior depends on `requiresHumanReview` flag:
- If `true`: Generates clarifying questions first
- If `false`: Generates plan directly and auto-starts development

**Request Body:**
```json
{
  "taskId": "task-1234567890-abc12"
}
```

**Response (200):**
```json
{
  "success": true,
  "threadId": "thread-uuid-here",
  "planningStatus": "generating_questions" | "generating_plan",
  "message": "Planning agent started successfully"
}
```

**Error Responses:**
- `400` - Missing `taskId`
- `404` - Task not found
- `409` - Task already has an agent running
- `500` - Server error (includes retry count on failure)

---

### POST `/api/agents/start-development`

Starts the development phase after plan approval. Generates subtasks from the approved plan and executes them sequentially.

**Request Body:**
```json
{
  "taskId": "task-1234567890-abc12"
}
```

**Response (200):**
```json
{
  "success": true,
  "threadId": "thread-uuid-here",
  "message": "Development started - generating subtasks"
}
```

**Error Responses:**
- `400` - Missing `taskId` or task doesn't have approved plan
- `404` - Task not found
- `500` - Server error

---

### POST `/api/agents/start-review`

Starts the AI review phase. Executes QA subtasks sequentially.

**Request Body:**
```json
{
  "taskId": "task-1234567890-abc12"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "AI Review started - executing QA subtasks"
}
```

**Error Responses:**
- `400` - Missing `taskId`, task not in `ai_review` phase, or no QA subtasks
- `404` - Task not found
- `500` - Server error

---

### POST `/api/agents/stop`

Stops a running AI agent.

**Request Body:**
```json
{
  "threadId": "thread-uuid-here"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Agent stopped successfully"
}
```

**Error Responses:**
- `400` - Missing `threadId`
- `404` - Agent not found
- `500` - Server error

---

### GET `/api/agents/stream`

Server-Sent Events (SSE) endpoint for streaming agent logs in real-time.

**Query Parameters:**
- `threadId` (required) - The agent thread ID

**SSE Message Types:**

```json
// Connection established
{ "type": "connected" }

// Log message
{ "type": "log", "content": "...", "timestamp": 1234567890 }

// Status update (sent when agent completes/errors/stops)
{ "type": "status", "status": "completed" | "error" | "stopped", "error": "..." }
```

**Error Responses:**
- `400` - Missing `threadId`
- `404` - Agent not found

---

### POST `/api/agents/approve-plan`

Approves a plan and optionally starts development.

**Request Body:**
```json
{
  "taskId": "task-1234567890-abc12",
  "startDevelopment": true  // optional, default: false
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Plan approved and development started" | "Plan approved",
  "task": { /* updated task object */ }
}
```

**Error Responses:**
- `400` - Missing `taskId`
- `404` - Task not found
- `500` - Server error

---

### POST `/api/agents/modify-plan`

Modifies an existing plan via inline edit or AI feedback regeneration.

**Request Body (Inline Edit):**
```json
{
  "taskId": "task-1234567890-abc12",
  "method": "inline",
  "newPlan": "# Updated Implementation Plan\n..."
}
```

**Request Body (Feedback Regeneration):**
```json
{
  "taskId": "task-1234567890-abc12",
  "method": "feedback",
  "feedback": "Please add more error handling and consider edge cases"
}
```

**Response (200 - Inline):**
```json
{
  "success": true,
  "message": "Plan updated successfully"
}
```

**Response (200 - Feedback):**
```json
{
  "success": true,
  "message": "Plan regeneration started",
  "threadId": "thread-uuid-here"
}
```

**Error Responses:**
- `400` - Missing required fields or invalid method
- `404` - Task not found
- `500` - Server error

---

### POST `/api/agents/submit-answers`

Submits answers to planning questions and triggers plan generation.

**Request Body:**
```json
{
  "taskId": "task-1234567890-abc12",
  "answers": {
    "q1": {
      "selectedOption": "JWT tokens",
      "additionalText": "Prefer short-lived tokens"
    },
    "q2": {
      "selectedOption": "Combination approach",
      "additionalText": ""
    }
  }
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Answers submitted, plan generation started",
  "threadId": "thread-uuid-here"
}
```

**Error Responses:**
- `400` - Missing `taskId` or `answers`
- `404` - Task not found
- `500` - Server error

---

## CLI API

Routes for CLI adapter management.

### GET `/api/cli/adapters`

Returns available CLI adapters and their configuration schemas.

**Response (200):**
```json
[
  {
    "name": "amp",
    "displayName": "Amp CLI",
    "configSchema": {
      "apiKey": { "type": "string", "required": true },
      "model": { "type": "string", "default": "claude-3-5-sonnet" }
    }
  },
  {
    "name": "mock",
    "displayName": "Mock Adapter",
    "configSchema": { /* ... */ }
  }
]
```

**Error Responses:**
- `500` - Failed to load CLI adapters

---

## Git API

Routes for git operations and worktree management.

### GET `/api/git/status`

Check git status for a task's worktree.

**Query Parameters:**
- `taskId` (required) - The task ID

**Response (200):**
```json
{
  "hasChanges": true,
  "status": "Changes pending" | "Clean" | "No worktree",
  "clean": false,
  "exists": true
}
```

**Error Responses:**
- `400` - Missing `taskId`
- `404` - Task not found
- `500` - Server error

---

### POST `/api/git/worktree`

Manages git worktrees (create, delete, cleanup).

**Request Body (Create):**
```json
{
  "action": "create",
  "taskId": "task-1234567890-abc12"
}
```

**Response (200 - Create):**
```json
{
  "success": true,
  "worktreeInfo": {
    "path": "/path/to/.code-auto/worktrees/task-xxx",
    "branchName": "code-auto/task-xxx"
  },
  "message": "Worktree created at /path/to/..."
}
```

**Request Body (Delete):**
```json
{
  "action": "delete",
  "taskId": "task-1234567890-abc12",
  "force": false  // optional
}
```

**Response (200 - Delete):**
```json
{
  "success": true,
  "message": "Worktree deleted for task task-xxx"
}
```

**Request Body (Cleanup All):**
```json
{
  "action": "cleanup-all",
  "force": false  // optional
}
```

**Response (200 - Cleanup):**
```json
{
  "success": true,
  "message": "All worktrees cleaned up"
}
```

**Error Responses:**
- `400` - Missing `taskId` or unknown action
- `500` - Server error
- `503` - Git not available or not in a git repository

---

### GET `/api/git/worktree`

Query worktree status and information.

**Query Parameters:**
- `taskId` - Required for `status` and `info` actions
- `action` - One of: `status` (default), `list`, `info`

**Response (200 - Status):**
```json
{
  "status": {
    "exists": true,
    "hasChanges": false
  }
}
```

**Response (200 - List):**
```json
{
  "worktrees": [
    { "path": "/path/to/worktree1", "branch": "code-auto/task-1" },
    { "path": "/path/to/worktree2", "branch": "code-auto/task-2" }
  ],
  "count": 2
}
```

**Response (200 - Info):**
```json
{
  "taskId": "task-xxx",
  "mainRepo": "/path/to/main/repo",
  "mainBranch": "main",
  "worktreePath": "/path/to/.code-auto/worktrees/task-xxx",
  "branchName": "code-auto/task-xxx"
}
```

**Error Responses:**
- `400` - Missing required parameters or unknown action
- `500` - Server error
- `503` - Git not available

---

## Tasks API

Routes for task CRUD operations and subtask management.

### POST `/api/tasks/create`

Creates a new task with automatic git worktree setup.

**Request Body:**
```json
{
  "title": "Implement authentication",
  "description": "Add JWT-based authentication system",
  "phase": "planning",  // optional, default: "planning"
  "status": "pending",  // optional, default: "pending"
  "cliTool": "amp",     // optional
  "cliConfig": {},      // optional
  "requiresHumanReview": true,  // optional, default: false
  "metadata": {}        // optional
}
```

**Response (200):**
```json
{
  "id": "task-1234567890-abc12",
  "title": "Implement authentication",
  "description": "Add JWT-based authentication system",
  "phase": "planning",
  "status": "pending",
  "subtasks": [],
  "worktreePath": "/path/to/.code-auto/worktrees/task-xxx",
  "branchName": "code-auto/task-xxx",
  "createdAt": 1234567890,
  "updatedAt": 1234567890,
  /* ... other fields */
}
```

**Error Responses:**
- `500` - Server error

---

### GET `/api/tasks/list`

Lists all tasks.

**Response (200):**
```json
[
  {
    "id": "task-xxx",
    "title": "Task 1",
    "phase": "planning",
    /* ... */
  },
  {
    "id": "task-yyy",
    "title": "Task 2",
    "phase": "in_progress",
    /* ... */
  }
]
```

**Error Responses:**
- `500` - Server error

---

### PATCH `/api/tasks/update`

Updates a task's properties.

**Request Body:**
```json
{
  "taskId": "task-1234567890-abc12",
  "phase": "in_progress",
  "status": "in_progress",
  "title": "Updated title"
  // Any task fields can be updated
}
```

**Response (200):**
```json
{
  "id": "task-xxx",
  "title": "Updated title",
  "phase": "in_progress",
  "updatedAt": 1234567890,
  /* ... updated task object */
}
```

**Error Responses:**
- `400` - Missing `taskId`
- `404` - Task not found
- `500` - Server error

---

### POST `/api/tasks/reorder-subtasks`

Reorders subtasks within a task.

**Request Body:**
```json
{
  "taskId": "task-1234567890-abc12",
  "subtaskIds": ["subtask-3", "subtask-1", "subtask-2"]
}
```

**Response (200):**
```json
{
  "success": true
}
```

**Error Responses:**
- `400` - Missing/invalid `taskId` or `subtaskIds`, or IDs don't match existing subtasks
- `404` - Task not found
- `500` - Server error

---

### POST `/api/tasks/skip-subtask`

Marks a subtask as completed (skips it). Stops any running agent on the subtask.

**Request Body:**
```json
{
  "taskId": "task-1234567890-abc12",
  "subtaskId": "subtask-1"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Subtask skipped successfully"
}
```

**Notes:**
- Automatically transitions task to `ai_review` phase if all dev subtasks are completed

**Error Responses:**
- `400` - Missing required fields or subtask already completed
- `404` - Task or subtask not found
- `500` - Server error

---

### POST `/api/tasks/delete-subtask`

Removes a subtask from the task. Stops any running agent on the subtask.

**Request Body:**
```json
{
  "taskId": "task-1234567890-abc12",
  "subtaskId": "subtask-1"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Subtask deleted successfully"
}
```

**Notes:**
- Cannot delete completed subtasks
- Automatically transitions task to `ai_review` phase if all remaining dev subtasks are completed

**Error Responses:**
- `400` - Missing required fields or subtask already completed
- `404` - Task or subtask not found
- `500` - Server error

---

### POST `/api/tasks/seed`

Creates sample tasks for testing the Kanban board.

**Request Body:** None required

**Response (200):**
```json
{
  "success": true,
  "message": "Created 6 sample tasks",
  "tasks": [ /* array of created tasks */ ]
}
```

**Error Responses:**
- `500` - Server error

---

### POST `/api/tasks/seed-test`

Creates sample tasks for E2E testing (marked with `isTestData` flag in metadata).

**Request Body:** None required

**Response (200):**
```json
{
  "success": true,
  "message": "Created 6 test tasks",
  "tasks": [ /* array of created tasks with isTestData: true */ ]
}
```

**Error Responses:**
- `500` - Server error

---

## Test API

Routes for testing and development.

### GET `/api/test-mock`

Tests the Mock CLI adapter without using any API credits.

**Response (200):**
```json
{
  "success": true,
  "adapter": "mock",
  "capabilities": {
    "streaming": true,
    "tools": true
  },
  "messages": [ /* array of mock messages */ ],
  "totalMessages": 5
}
```

**Error Responses:**
- `500` - Server error with details

---

## Error Handling

All API routes follow a consistent error response format:

```json
{
  "error": "Error message describing what went wrong"
}
```

### Common HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `400` | Bad Request - Missing or invalid parameters |
| `404` | Not Found - Resource doesn't exist |
| `409` | Conflict - Resource state conflict (e.g., agent already running) |
| `500` | Internal Server Error |
| `503` | Service Unavailable - External dependency not available (e.g., Git) |

### Error Handling Pattern

All routes use try-catch blocks with consistent error extraction:

```typescript
try {
  // Route logic
} catch (error) {
  return NextResponse.json(
    {
      error: error instanceof Error ? error.message : 'Unknown error',
    },
    { status: 500 }
  );
}
```

---

## Authentication

Currently, the API routes do not implement authentication. All endpoints are accessible without authorization.

**Future Considerations:**
- Add API key authentication for external access
- Implement session-based auth for web UI
- Add rate limiting for agent operations

---

## Task Lifecycle Phases

Tasks move through the following phases:

| Phase | Description |
|-------|-------------|
| `planning` | Task is being planned (questions/plan generation) |
| `in_progress` | Development subtasks being executed |
| `ai_review` | QA subtasks being executed |
| `human_review` | Awaiting human review |
| `done` | Task completed |

### Planning Status Values

| Status | Description |
|--------|-------------|
| `not_started` | Planning not yet initiated |
| `generating_questions` | AI generating clarifying questions |
| `waiting_for_answers` | Waiting for user to answer questions |
| `generating_plan` | AI generating implementation plan |
| `plan_ready` | Plan generated, awaiting approval |
| `plan_approved` | Plan approved, ready for development |

### Task Status Values

| Status | Description |
|--------|-------------|
| `pending` | Waiting for action |
| `planning` | Currently in planning phase |
| `in_progress` | Actively being worked on |
| `blocked` | Blocked due to error |
| `completed` | Successfully completed |

---

## Subtask Schema

```typescript
interface Subtask {
  id: string;           // Unique identifier
  content: string;      // Detailed description
  label: string;        // Short label for UI
  type: 'dev' | 'qa';   // Development or QA verification
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;  // Present continuous form for progress display
  completedAt?: number; // Timestamp when completed
}
```
