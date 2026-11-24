/**
 * Built-in default prompt templates.
 * User-editable portion only; system suffix is appended by the loader.
 */

export const PLAN_GENERATION_DEFAULT_TEMPLATE = `You are an AI planning assistant. Your task is to help plan the implementation of the following task.

Title: {{task.title}}
Description: {{task.description}}

CLI Tool: {{task.cliTool}}
{{task.cliConfig}}

{{user_answers}}

Create a detailed plan in EXACTLY this structure (required headings):
- ## Overview
- ## Technical Approach
- ## Implementation Steps (numbered list)
- ## Files to Modify (bullet list of file paths)
- ## Testing Strategy
- ## Potential Issues
- ## Success Criteria

Format your plan in Markdown with clear headings and bullet points.`;

/** Shared instruction: do not write planning/subtask artifacts to the worktree. */
export const OUTPUT_NO_FILES_IN_WORKTREE = `
Do NOT create implementation-plan.json, planning-questions.json, plan.md, subtasks.json, or similar files in your working directory - they pollute the worktree and we cannot read them.
If you must write to a file for your workflow, use ONLY ../../scratch/ (relative to cwd - outside the worktree). You must still output the JSON in your chat message.`;

export const PLAN_GENERATION_SUFFIX = `

Return your plan in the following JSON format:
{
  "plan": "# Implementation Plan\\n\\n## Overview\\n...full markdown plan here..."
}

CRITICAL - Your response MUST contain the raw JSON as plain text in your message:
- The system ONLY captures your text/chat output. We cannot read files you create.
- You MUST output the JSON directly in your final message - writing to a file does NOT work.
- No markdown code fences, no explanatory text before or after the JSON.
- After your analysis, you MUST OUTPUT TEXT - do not just stop thinking.
- Your last message must be the raw JSON object, e.g. {"plan":"# Implementation Plan\\n\\n## Overview\\n..."}
${OUTPUT_NO_FILES_IN_WORKTREE}`;

/** Content injected for {{user_answers}} when generating plan from Q&A (internal, not user-editable) */
export const PLAN_USER_ANSWERS_INTRO = `Based on the user's answers above, create a comprehensive implementation plan that addresses their specific requirements and preferences.

Your plan should include:
1. **Overview**: Brief summary incorporating user preferences
2. **Technical Approach**: Architecture decisions based on user's choices
3. **Implementation Steps**: Numbered, actionable steps
4. **Files to Modify**: List of files to create/change
5. **Testing Strategy**: How to verify it works (considering user's testing preference)
6. **Potential Issues**: Known gotchas specific to chosen approach
7. **Success Criteria**: Clear completion criteria

Format your plan in Markdown with clear headings and bullet points.`;

export const SUBTASK_GENERATION_DEFAULT_TEMPLATE = `You are an AI development assistant. Your task is to break down an implementation plan into actionable subtasks.

**Task:** {{task.title}}
**Description:** {{task.description}}

**Approved Implementation Plan:**
{{planContent}}

# SUBTASK GENERATION

Your goal is to break down this plan into 5-15 concrete, actionable subtasks that can be executed sequentially.

For each subtask, provide:
- **id**: Unique identifier (e.g., "subtask-1", "subtask-2")
- **content**: Detailed description of what needs to be done (be specific about files, logic, etc.)
- **label**: Short label (3-5 words) for UI display (e.g., "Create API endpoint", "Add validation logic")
- **activeForm**: Present continuous form for progress display (e.g., "Creating API endpoint", "Adding validation logic")
- **type**: Either "dev" or "qa"

**Guidelines:**
1. Break down complex steps into smaller, manageable subtasks
2. Each subtask should be completable independently
3. Order subtasks logically (dependencies first)
4. Be specific about files, functions, and changes needed
5. Cap at 15 subtasks maximum
6. Include at least 2 QA subtasks ("type": "qa") that ONLY verify/test (e.g. run build/tests, validate docs/links/diagrams)
7. Put verification steps (build/test/lint/validate/verify) under QA, not dev
8. For QA subtasks that require manual human verification (e.g. UI testing, visual review), include "manual" in the label or content (e.g. "Manual QA: verify login flow")`;

export const SUBTASK_GENERATION_SUFFIX = `

Return your subtasks in the following JSON format:
{
  "subtasks": [
    {
      "id": "subtask-1",
      "content": "Create the API route file at src/app/api/example/route.ts with POST endpoint handler",
      "label": "Create API endpoint",
      "activeForm": "Creating API endpoint",
      "type": "dev"
    },
    {
      "id": "subtask-qa-1",
      "content": "Run the build and verify there are no errors; if there are, report them clearly without changing code",
      "label": "Verify build",
      "activeForm": "Verifying build",
      "type": "qa"
    }
  ]
}

CRITICAL - Your response MUST contain the raw JSON as plain text in your message:
- The system ONLY captures your text/chat output. We cannot read files you create.
- You MUST output the JSON directly in your final message - writing to a file does NOT work.
- No markdown code fences, no explanatory text before or after.
- Your last message must be the raw JSON object, e.g. {"subtasks":[{"id":"subtask-1","content":"...","label":"...","activeForm":"...","type":"dev"}]}
${OUTPUT_NO_FILES_IN_WORKTREE}`;
