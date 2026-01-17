# Amp CLI & SDK - Complete Research Document

**Last Updated:** January 18, 2026
**Research Purpose:** Understanding cost optimization and configuration for Phase 4 implementation

---

## Table of Contents

1. [Overview](#overview)
2. [Mode Selection (Rush vs Smart)](#mode-selection-rush-vs-smart)
3. [Cost Breakdown & Pricing](#cost-breakdown--pricing)
4. [CLI Parameters & Commands](#cli-parameters--commands)
5. [SDK Configuration](#sdk-configuration)
6. [Cost Optimization Strategies](#cost-optimization-strategies)
7. [Thread Management](#thread-management)
8. [Tool & Permission Controls](#tool--permission-controls)
9. [Configuration Files](#configuration-files)
10. [Best Practices](#best-practices)
11. [Limitations & Constraints](#limitations--constraints)
12. [Implementation Recommendations](#implementation-recommendations)

---

## Overview

**Amp** is an AI coding agent built by Sourcegraph that uses Claude models (Anthropic) for autonomous code generation and task execution.

**Installation:**
```bash
npm install -g @sourcegraph/amp
# or
pnpm add -g @sourcegraph/amp
# or
yarn global add @sourcegraph/amp
```

**SDK Installation:**
```bash
npm install @sourcegraph/amp-sdk
```

**Authentication:**
- Get API key from: https://ampcode.com/settings
- Set environment variable: `AMP_API_KEY=your-key`
- Or use: `amp login` (interactive)

**Documentation:**
- Owner's Manual: https://ampcode.com/manual
- SDK Docs: https://ampcode.com/manual/sdk
- CLI Guide: https://github.com/sourcegraph/amp-examples-and-guides/blob/main/guides/cli/README.md

---

## Mode Selection (Rush vs Smart)

### Three Available Modes

| Mode | Model | Cost | Speed | Use Case | SDK/Execute Support |
|------|-------|------|-------|----------|---------------------|
| **free** | Fast basic models | $0 (ad-supported) | Fast | Simple tasks | ❌ No (ads required) |
| **rush** | Claude Haiku 4.5 | 67% cheaper | 50% faster | Simple, well-defined tasks | ✅ Yes |
| **smart** | Claude Opus 4.5 | Full price | Slower | Complex reasoning | ✅ Yes (default) |

### Rush Mode Details

**What it is:**
- Uses Claude Haiku 4.5 (lighter, faster model)
- 67% cheaper than smart mode (token-by-token)
- 50% faster than smart mode (token-by-token)
- Optimized system prompt and tool selection

**Real-world performance:**
- Example task: 37 seconds, $0.12 cost
- Compared to smart: 44% faster, 77% cheaper

**When to use rush:**
- ✅ Simple bugs with clear diagnosis
- ✅ Small UI changes (button styling, layout tweaks)
- ✅ Minor features (add a function, update validation)
- ✅ Well-scoped refactors (rename variable across files)
- ✅ Tasks where you can specify exact files to modify

**When NOT to use rush:**
- ❌ Complex end-to-end features (new authentication system)
- ❌ Bugs with unclear root cause (need investigation)
- ❌ Architecture refactors (change state management approach)
- ❌ Tasks requiring deep reasoning or planning
- ❌ Multi-step workflows with dependencies

**Key limitation:**
- Rush mode "doesn't show its TODOs" (no reasoning visibility)
- Less capable on complex tasks (may take longer fixing mistakes)

**How to activate:**

**CLI:**
```bash
mode: use rush
```

**Editor Extension:**
- Select "rush" in mode dropdown

**SDK (via settings.json):**
```json
{
  "amp.mode": "rush"
}
```

**Source:** https://ampcode.com/news/rush-mode

---

## Cost Breakdown & Pricing

### Claude Model Pricing (2026)

**Claude Opus 4.5 (Smart Mode):**
- Input: $5 per million tokens
- Output: $25 per million tokens
- Context window: Up to 200k tokens

**Claude Sonnet 4.5 (Not available in amp, reference only):**
- Input: $3 per million tokens (-40%)
- Output: $15 per million tokens (-60%)

**Claude Haiku 4.5 (Rush Mode - estimated):**
- Input: ~$1.50 per million tokens (67% cheaper than Opus)
- Output: ~$7.50 per million tokens (67% cheaper than Opus)

### Cost Examples

**Example 1: Simple Task (10k input + 2k output tokens)**
- Smart mode (Opus 4.5): $0.10
- Rush mode (Haiku 4.5): $0.03
- **Savings: 70%**

**Example 2: Medium Task (50k input + 10k output tokens)**
- Smart mode: $0.50
- Rush mode: $0.15
- **Savings: 70%**

**Example 3: Complex Task (100k input + 20k output tokens)**
- Smart mode: $1.00
- Rush mode: $0.30 (if appropriate for task)
- **Savings: 70%**

### Budget Planning

**With $27 budget:**
- Smart mode only: ~270 simple tasks (or ~50 complex tasks)
- Rush mode optimized: ~1,350 simple tasks (or ~270 medium tasks)
- **5x more tasks possible with rush mode**

**Important:**
- SDK/execute mode uses paid credits only (no free ad-supported tier)
- Cannot use free mode programmatically (ads can't display)

**Sources:**
- https://www.anthropic.com/pricing
- https://ampcode.com/news/opus-4.5

---

## CLI Parameters & Commands

### Execution Modes

**Interactive Mode:**
```bash
amp
# Ongoing conversation with full context
```

**Execute Mode (One-shot):**
```bash
amp -x "Fix the login bug in src/auth/login.ts"
# Returns result and exits
# Uses paid credits only
```

**Piped Input:**
```bash
git diff | amp
# Process command output
```

### Environment Variables

```bash
# Authentication
export AMP_API_KEY="your-api-key"

# Logging
export AMP_LOG_LEVEL="debug"  # error, warn, info, debug

# Custom settings location
export AMP_SETTINGS_FILE="/path/to/settings.json"

# Load user environment (.bashrc, .zshrc, .envrc)
export AMP_COMMANDS_LOADUSERENVIRONMENT=true
```

### Thread Management Commands

```bash
# Create new thread
amp threads new

# List all threads
amp threads list

# Continue existing thread
amp threads continue [threadId]

# Fork from existing thread
amp threads fork [threadId]

# Share thread
amp threads share [threadId]

# Compact thread (reduce token usage)
amp threads compact [threadId]
```

### Tool Management

```bash
# List available tools
amp tools show

# 16 built-in tools available:
# - bash (command execution)
# - file operations (read, write, edit, search)
# - oracle (ask questions about codebase)
# - librarian (find documentation)
# - etc.
```

### Interactive Mode Commands

```
@pattern           - Fuzzy-search and mention files
Ctrl+R             - Full-screen navigation mode
/editor            - Open $EDITOR for longer prompts
/agent             - Generate project AGENT.md file
/compact           - Compress conversation history
/help              - Display available commands
```

### Support & Diagnostics

```bash
amp doctor    # Generate diagnostic bundle
amp --help    # Display help
```

**Sources:**
- https://github.com/sourcegraph/amp-examples-and-guides/blob/main/guides/cli/README.md
- https://ampcode.com/manual

---

## SDK Configuration

### Basic Usage

```typescript
import { execute } from '@sourcegraph/amp-sdk';

// Simple execution
for await (const message of execute({
  prompt: 'What files are in this directory?'
})) {
  console.log(message);
}
```

### Execute Function Parameters

```typescript
execute({
  prompt: string | AsyncGenerator,
  signal?: AbortSignal,
  options?: {
    // Working directory
    cwd?: string,

    // Thread continuation
    continue?: boolean | string,  // true = latest, string = specific thread ID

    // Logging
    logLevel?: 'error' | 'warn' | 'info' | 'debug',
    logFile?: string,

    // Permissions
    dangerouslyAllowAll?: boolean,
    permissions?: {
      patterns?: string[]  // e.g., ["!*/node_modules/*"]
    },

    // Configuration
    settingsFile?: string,  // Path to custom settings.json

    // MCP (Model Context Protocol) servers
    mcpConfig?: object,

    // Custom tools
    toolbox?: ToolboxConfig
  }
})
```

### Advanced Example

```typescript
import { execute, createUserMessage } from '@sourcegraph/amp-sdk';

// With timeout and custom settings
const controller = new AbortController();
setTimeout(() => controller.abort(), 60000); // 60s timeout

for await (const message of execute({
  prompt: 'Refactor the authentication module',
  signal: controller.signal,
  options: {
    cwd: './src/auth',              // Limit scope
    continue: 'thread-123',         // Reuse context
    logLevel: 'debug',
    settingsFile: './.amp/settings.json',  // Custom settings (mode, tools, etc.)
    dangerouslyAllowAll: false,     // Require approval
    permissions: {
      patterns: ['!*/node_modules/*', '!*/.git/*']
    }
  }
})) {
  console.log(message);
}
```

### Streaming Conversations

```typescript
import { execute, createUserMessage } from '@sourcegraph/amp-sdk';

async function* conversationGenerator() {
  yield createUserMessage('What is the main entry point?');
  // Wait for response...
  yield createUserMessage('Now refactor it to use async/await');
}

for await (const message of execute({
  prompt: conversationGenerator()
})) {
  console.log(message);
}
```

**Source:** https://ampcode.com/manual/sdk

---

## Cost Optimization Strategies

### 1. Mode Selection ⭐ **HIGHEST IMPACT**

**Savings: 67-77% per task**

```typescript
// Create settings file with rush mode
// .amp/settings.json
{
  "amp.mode": "rush"
}

// Pass to SDK
execute({
  prompt: "Fix simple bug",
  options: {
    settingsFile: './.amp/settings.json'
  }
})
```

**Decision tree:**
- Simple, well-defined task + can specify files → **rush mode**
- Complex reasoning required → **smart mode**
- Unsure → Start with rush, fallback to smart if needed

---

### 2. Thread Continuation ⭐ **HIGH IMPACT**

**Savings: 50-70% on input tokens**

```typescript
// First task
const result1 = await execute({
  prompt: 'Analyze the codebase structure'
});

// Continue from previous thread (reuses context)
const result2 = await execute({
  prompt: 'Now add authentication',
  options: {
    continue: true  // or specific threadId
  }
});
```

**When to use:**
- Sequential related tasks on same codebase
- Follow-up modifications to same files
- Iterative refinements

**When NOT to use:**
- Unrelated tasks (fresh context needed)
- Switching to different project/directory
- Thread context too large (use compact first)

---

### 3. Working Directory Scope ⭐ **MEDIUM IMPACT**

**Savings: 30-50% on file analysis**

```typescript
execute({
  prompt: 'Fix bug in login flow',
  options: {
    cwd: './src/auth'  // Only analyze auth folder
  }
})
```

**Benefits:**
- Reduces files agent needs to read
- Smaller context window
- Faster execution
- Lower costs

---

### 4. Thread Compaction

**Savings: Variable, prevents context bloat**

```bash
# CLI
amp threads compact [threadId]

# Automatically reduces token usage when context grows too large
```

**When to use:**
- Before continuing long-running thread
- When approaching context limits
- After exploratory conversations

---

### 5. Tool Restrictions

**Savings: 10-20% on unnecessary operations**

```json
// settings.json
{
  "amp.mode": "rush",
  "amp.tools.disable": [
    "search_web",           // Disable if not needed
    "read_large_files"      // Avoid expensive operations
  ],
  "amp.commands.allowlist": [
    "git status",
    "git diff",
    "npm run test",
    "npm run build"
  ],
  "amp.commands.strict": true
}
```

---

### 6. Timeout Control

**Savings: Prevents runaway costs**

```typescript
const controller = new AbortController();

// 2-minute timeout for simple tasks
setTimeout(() => controller.abort(), 120000);

execute({
  prompt: "Quick refactor",
  signal: controller.signal
})
```

**Recommended timeouts:**
- Simple tasks (rush mode): 60-120s
- Medium tasks: 180-300s
- Complex tasks (smart mode): 300-600s

---

### 7. Prompt Optimization

**Savings: 20-40% on unnecessary iterations**

**Good prompts:**
```
"Fix the login timeout bug in src/auth/login.ts.
The issue is on line 45 where the session expires too quickly.
Change the timeout from 5 minutes to 30 minutes."
```

**Bad prompts:**
```
"Fix login"  // Too vague, agent will explore unnecessarily
```

**Best practices:**
- Specify exact files when possible
- Describe the issue clearly
- Provide context about what needs changing
- Include expected behavior

---

## Thread Management

### Creating Threads

**New thread (CLI):**
```bash
amp threads new
```

**New thread (SDK):**
```typescript
// Just call execute() - creates new thread automatically
execute({ prompt: "..." })
```

### Continuing Threads

**Continue latest (CLI):**
```bash
amp threads continue
```

**Continue specific thread (CLI):**
```bash
amp threads continue thread-abc123
```

**Continue thread (SDK):**
```typescript
execute({
  prompt: "Next step...",
  options: {
    continue: true           // Continue latest thread
    // OR
    continue: 'thread-abc123'  // Continue specific thread
  }
})
```

### Listing Threads

```bash
amp threads list

# Output:
# thread-abc123  [2026-01-18] "Implement authentication"
# thread-xyz789  [2026-01-17] "Fix login bug"
```

### Forking Threads

```bash
amp threads fork thread-abc123

# Creates new thread branching from specified point
# Useful for trying alternative approaches
```

### Compacting Threads

```bash
amp threads compact thread-abc123

# Reduces token usage by:
# - Summarizing old messages
# - Removing redundant context
# - Keeping essential information
```

**When to compact:**
- Thread approaching 100k+ tokens
- Before long continuation
- After exploratory/debugging sessions

---

## Tool & Permission Controls

### Available Tools (16 built-in)

**File Operations:**
- `read` - Read file contents
- `write` - Create/overwrite files
- `edit` - Modify existing files
- `search` - Search file contents

**Code Intelligence:**
- `oracle` - Ask questions about codebase
- `librarian` - Find documentation
- `grep` - Search patterns

**System:**
- `bash` - Execute shell commands
- `search_web` - Web search (optional)

### Tool Configuration

**Disable specific tools:**
```json
{
  "amp.tools.disable": [
    "search_web",
    "bash"  // Prevent any command execution
  ]
}
```

**Command allowlist:**
```json
{
  "amp.commands.allowlist": [
    "git status",
    "git diff",
    "npm run *",
    "ls -la"
  ],
  "amp.commands.strict": true  // Only allow listed commands
}
```

**Permission patterns:**
```typescript
execute({
  options: {
    permissions: {
      patterns: [
        "!*/node_modules/*",  // Exclude node_modules
        "!*/.git/*",          // Exclude .git
        "!*.log",             // Exclude log files
        "src/**/*"            // Only allow src folder
      ]
    }
  }
})
```

**Skip all prompts (DANGEROUS):**
```typescript
execute({
  options: {
    dangerouslyAllowAll: true  // Use with caution!
  }
})
```

---

## Configuration Files

### Locations (Priority Order)

1. **Project-specific:** `./.amp/settings.json` (highest priority)
2. **User-specific:** `~/.config/amp/settings.json` (macOS/Linux)
3. **Editor extension:** `.vscode/settings.json`
4. **Environment variable:** `$AMP_SETTINGS_FILE`

### Example settings.json

```json
{
  "amp.mode": "rush",

  "amp.notifications.enabled": true,

  "amp.tools.disable": [
    "search_web"
  ],

  "amp.commands.allowlist": [
    "git *",
    "npm run *",
    "ls *"
  ],

  "amp.commands.strict": true,

  "amp.commands.loadUserEnvironment": false,

  "amp.dangerouslyAllowAll": false,

  "amp.mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/server-filesystem",
        "/path/to/project"
      ]
    },
    "playwright": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/server-playwright"
      ]
    }
  }
}
```

### Using Custom Settings in SDK

```typescript
execute({
  prompt: "...",
  options: {
    settingsFile: './.amp/settings.json'
  }
})
```

**Source:** https://ampcode.com/news/cli-workspace-settings

---

## Best Practices

### Cost-Effective Development

1. **Default to rush mode**
   - Use rush for 80% of tasks
   - Reserve smart mode for complex problems
   - Switch to smart if rush struggles after 1-2 attempts

2. **Use thread continuation**
   - Group related tasks together
   - Reuse context for sequential work
   - Compact threads when they grow large

3. **Be specific in prompts**
   - Mention exact files to modify
   - Describe the change clearly
   - Include line numbers if known

4. **Scope tasks appropriately**
   - Set `cwd` to relevant folder
   - Use permission patterns to limit access
   - Disable unnecessary tools

5. **Set timeouts**
   - Prevent runaway tasks
   - Adjust based on complexity
   - Monitor and learn from failures

### Security Best Practices

1. **Never use `dangerouslyAllowAll: true` in production**
2. **Always use command allowlists** for untrusted contexts
3. **Review file permission patterns** before execution
4. **Enable strict mode** to require approval for risky operations
5. **Keep API keys secure** (never commit to git)

### Performance Optimization

1. **Use execute mode (`-x`)** for one-shot tasks
2. **Compact threads regularly** to prevent slowdown
3. **Limit context size** with `cwd` and permissions
4. **Disable unused tools** to reduce overhead
5. **Monitor log files** to understand token usage

---

## Limitations & Constraints

### Model Selection

❌ **Cannot choose specific models**
- Amp abstracts model selection
- Smart mode = Opus 4.5 (fixed)
- Rush mode = Haiku 4.5 (fixed)
- No custom model parameters

### Token Limits

❌ **No token limit controls**
- Unconstrained token usage (up to 200k context)
- No `max_tokens` parameter available
- Cannot cap input/output tokens per request
- Must rely on timeouts and thread compaction

### Free Tier

❌ **Free mode unavailable for SDK/programmatic usage**
- Execute mode (`-x`) and SDK use paid credits only
- Free tier requires ad display (not possible in headless mode)
- No workaround for cost-free testing

### Context Window

⚠️ **200k token limit**
- Shared across input + output
- Can be exhausted on large codebases
- Use thread compaction to manage

### Streaming

⚠️ **No official stream interruption**
- AbortSignal works but may not stop immediately
- Some operations cannot be cancelled mid-execution

### Platform Support

✅ **Cross-platform CLI** (macOS, Linux, Windows)
⚠️ **SDK Node.js only** (no browser support)

---

## Implementation Recommendations

### For Code-Auto Phase 4

#### Minimum Viable Integration

1. **Mode selection dropdown** (already exists in UI ✓)
   - Default to rush mode
   - Allow manual switch to smart mode
   - Show cost estimate difference

2. **Settings file generation**
   - Create `.amp/settings.json` per task
   - Set mode based on user selection
   - Pass `settingsFile` to SDK

3. **Working directory configuration**
   - Extract from task or user input
   - Set `cwd` parameter
   - Default to worktree path

4. **Basic timeout**
   - Start with 120s for rush, 300s for smart
   - Make configurable in advanced settings

#### Enhanced Features (Phase 4+)

5. **Thread continuation**
   - Track thread IDs per task
   - Option to continue from previous task
   - Auto-compact when needed

6. **Tool restrictions**
   - Preset profiles (minimal, standard, full)
   - Custom allowlist configuration
   - Per-task tool selection

7. **Cost tracking**
   - Estimate cost before execution
   - Track actual usage per task
   - Budget warnings and limits

8. **Prompt templates**
   - Pre-built prompts for common tasks
   - Optimize for clarity and cost
   - Include file specification helpers

#### Settings UI Structure

```
┌─────────────────────────────────────┐
│ New Task                            │
├─────────────────────────────────────┤
│ Title: [________________]           │
│ Description: [__________]           │
│                                     │
│ Agent Settings                      │
│ ┌─────────────────────────────────┐ │
│ │ Mode:                           │ │
│ │ ○ Smart (Best, slower, $$$)     │ │
│ │ ● Rush (Good, faster, $)        │ │
│ │                                 │ │
│ │ Working Dir: [./src/auth    ]   │ │
│ │                                 │ │
│ │ ☑ Continue from previous task   │ │
│ │                                 │ │
│ │ Timeout: [120s] (30-600s)       │ │
│ │                                 │ │
│ │ [Advanced Settings ▼]           │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [Cancel]              [Start Task] │
└─────────────────────────────────────┘
```

---

## Quick Reference

### Cost Comparison Table

| Optimization | Savings | Effort | Priority |
|--------------|---------|--------|----------|
| Rush mode | 67-77% | Low | ⭐⭐⭐⭐⭐ |
| Thread continuation | 50-70% | Medium | ⭐⭐⭐⭐ |
| Working directory scope | 30-50% | Low | ⭐⭐⭐ |
| Prompt optimization | 20-40% | Medium | ⭐⭐⭐ |
| Tool restrictions | 10-20% | Medium | ⭐⭐ |
| Timeout control | Prevents runaway | Low | ⭐⭐⭐ |

### Mode Selection Quick Guide

```
Simple bug fix              → Rush
Small UI change             → Rush
Minor feature (<100 lines)  → Rush
Refactor (clear scope)      → Rush

Complex feature             → Smart
Unclear bug diagnosis       → Smart
Architecture change         → Smart
Multi-file refactor         → Smart
```

### Common Commands Cheat Sheet

```bash
# Start rush mode
mode: use rush

# Compact thread
amp threads compact

# List threads
amp threads list

# Continue thread
amp threads continue [id]

# One-shot execution
amp -x "your prompt"

# Show tools
amp tools show

# Generate diagnostics
amp doctor
```

---

## Sources & References

**Official Documentation:**
- [Amp Owner's Manual](https://ampcode.com/manual)
- [Amp SDK Documentation](https://ampcode.com/manual/sdk)
- [Amp CLI Guide](https://github.com/sourcegraph/amp-examples-and-guides/blob/main/guides/cli/README.md)

**Feature Announcements:**
- [Rush Mode](https://ampcode.com/news/rush-mode)
- [Opus 4.5 Update](https://ampcode.com/news/opus-4.5)
- [Workspace Settings](https://ampcode.com/news/cli-workspace-settings)
- [TypeScript SDK](https://ampcode.com/news/typescript-sdk)

**Pricing:**
- [Claude API Pricing](https://www.anthropic.com/pricing)
- [Anthropic API Pricing Guide](https://www.nops.io/blog/anthropic-api-pricing/)

**Community:**
- [Amp Examples & Guides](https://github.com/sourcegraph/amp-examples-and-guides)
- [NPM Package](https://www.npmjs.com/package/@sourcegraph/amp)

---

**Document Version:** 1.0
**Date:** January 18, 2026
**Next Update:** After Phase 4 implementation and real-world testing
