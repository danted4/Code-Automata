# Git Worktree Isolation Strategy

Code-Auto uses Git worktrees to provide isolated execution environments for concurrent task execution. Each task operates in its own worktree with a dedicated branch, enabling parallel development without conflicts.

## Overview

```
main-repo/
├── .code-auto/
│   └── worktrees/
│       ├── task-1234567890-abc/    # Task 1 worktree
│       ├── task-1234567891-def/    # Task 2 worktree
│       └── task-1234567892-ghi/    # Task 3 worktree
├── src/
└── ...
```

## Why Worktrees?

- **Isolation**: Each task has its own working directory; changes don't interfere with other tasks
- **Concurrency**: Multiple AI agents can work on different tasks simultaneously
- **Clean State**: Each worktree starts from the main branch with a clean slate
- **Easy Cleanup**: Worktrees can be removed without affecting the main repository
- **Git Integration**: Changes are tracked on dedicated branches for review

## WorktreeManager Implementation

The `WorktreeManager` class in [src/lib/git/worktree.ts](../src/lib/git/worktree.ts) handles all worktree operations.

### Key Interfaces

> Full type definitions: [TYPE_REFERENCE.md](./TYPE_REFERENCE.md#git-worktree-types)

#### [`WorktreeInfo`](../src/lib/git/worktree.ts#L18-L24)

```typescript
interface WorktreeInfo {
  path: string;        // Full path to worktree directory
  branchName: string;  // Git branch name (code-auto/{task-id})
  taskId: string;      // Unique task identifier
  mainRepo: string;    // Path to main repository
  mainBranch: string;  // Main branch name (main/master)
}
```

#### [`WorktreeStatus`](../src/lib/git/worktree.ts#L26-L33)

```typescript
interface WorktreeStatus {
  exists: boolean;
  path?: string;
  branchName?: string;
  hasChanges?: boolean;
  isDirty?: boolean;   // Has uncommitted changes
  error?: string;
}
```

### Core Methods

| Method | Description |
|--------|-------------|
| `createWorktree(taskId)` | Creates a new worktree with dedicated branch |
| `deleteWorktree(taskId, force?)` | Removes worktree and cleans up |
| `getWorktreeStatus(taskId)` | Checks worktree existence and state |
| `listWorktrees()` | Lists all active Code-Auto worktrees |
| `cleanupAllWorktrees(force?)` | Removes all worktrees (cleanup/reset) |

### Singleton Access

```typescript
import { getWorktreeManager } from '@/lib/git/worktree';

const manager = getWorktreeManager();
```

## Worktree Lifecycle

### 1. Creation

When a new task starts:

```typescript
const worktree = await manager.createWorktree('task-1234567890-abc');
// Creates:
//   - Directory: .code-auto/worktrees/task-1234567890-abc/
//   - Branch: code-auto/task-1234567890-abc
```

The worktree is created from the current main branch, ensuring a clean starting point.

### 2. Usage

During task execution:
- The AI agent operates within the worktree directory
- All subtasks for the same parent task share the worktree
- Changes are committed to the task's branch
- Multiple worktrees can execute concurrently

### 3. Cleanup

After task completion:

```typescript
// Check status first
const status = await manager.getWorktreeStatus('task-1234567890-abc');

if (status.isDirty) {
  // Commit or discard changes first, or force delete
  await manager.deleteWorktree('task-1234567890-abc', true);
} else {
  await manager.deleteWorktree('task-1234567890-abc');
}
```

## Directory Structure

```
.code-auto/
└── worktrees/
    └── {task-id}/
        ├── .git                # Worktree git link
        ├── src/                # Full copy of source
        ├── package.json
        └── ...                 # All project files
```

Each worktree contains a complete copy of the repository, linked to the main `.git` directory.

## Branch Naming Convention

All task branches follow the pattern:
```
code-auto/{task-id}
```

This convention:
- Clearly identifies AI-generated branches
- Groups all automation branches together
- Allows easy filtering in git tools

## Concurrent Execution

Multiple worktrees enable parallel task execution:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Task A        │     │   Task B        │     │   Task C        │
│   Worktree A    │     │   Worktree B    │     │   Worktree C    │
│   Branch A      │     │   Branch B      │     │   Branch C      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │     Main Repository     │
                    │     (shared .git)       │
                    └─────────────────────────┘
```

## Error Handling

The WorktreeManager handles common edge cases:

- **Worktree already exists**: Throws error; use different task ID or delete first
- **Uncommitted changes on delete**: Requires `force=true` or commit changes
- **Not in git repository**: Throws descriptive error
- **Directory cleanup**: Ensures directory is removed even if git command fails

## Best Practices

1. **Unique Task IDs**: Always use unique identifiers (timestamp + random suffix)
2. **Commit Frequently**: Commit changes after each subtask to preserve work
3. **Clean Up**: Delete worktrees after merging or discarding changes
4. **Check Status**: Use `getWorktreeStatus()` before operations to avoid errors
5. **Force with Caution**: Only use `force=true` when you're sure changes can be discarded
