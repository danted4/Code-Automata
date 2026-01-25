/**
 * Plan Validator
 *
 * Validates that generated plans conform to the required "Code-Auto plan format".
 * This is intentionally lightweight and mirrors the style of `subtask-validator.ts`.
 */

export interface PlanValidationError {
  field: string;
  issue: string;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationError[];
  warnings: string[];
}

const REQUIRED_SECTIONS: Array<{ heading: string; key: string }> = [
  { heading: 'Overview', key: 'overview' },
  { heading: 'Technical Approach', key: 'technical_approach' },
  { heading: 'Implementation Steps', key: 'implementation_steps' },
  { heading: 'Files to Modify', key: 'files_to_modify' },
  { heading: 'Testing Strategy', key: 'testing_strategy' },
  { heading: 'Potential Issues', key: 'potential_issues' },
  { heading: 'Success Criteria', key: 'success_criteria' },
];

function hasHeading(md: string, heading: string): boolean {
  // Allow "## Heading" (case-insensitive), with optional extra whitespace
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'im');
  return re.test(md);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(md: string, heading: string): string | null {
  // Captures content under "## heading" until next "## " or end.
  const re = new RegExp(
    `^##\\s+${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`,
    'im'
  );
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

function looksLikeNumberedSteps(section: string): boolean {
  // At least 2 numbered steps
  const matches = section.match(/^\s*\d+\.\s+\S+/gm);
  return (matches?.length || 0) >= 2;
}

function looksLikeFileList(section: string): boolean {
  // At least one bullet with a path-ish token
  const lines = section.split('\n').map((l) => l.trim());
  const bullets = lines.filter((l) => /^[-*]\s+/.test(l));
  return bullets.some((b) => /(?:^[-*]\s+)(?:`)?[./\w-]+\/[\w./-]+(?:`)?/.test(b));
}

export function validatePlanMarkdown(plan: unknown): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  const warnings: string[] = [];

  if (typeof plan !== 'string' || !plan.trim()) {
    errors.push({
      field: 'plan',
      issue: 'Missing or invalid "plan" (must be a non-empty markdown string)',
    });
    return { valid: false, errors, warnings };
  }

  const md = plan.trim();

  // Title is recommended, not strictly required (agents sometimes omit)
  if (!/^#\s+.+/m.test(md)) {
    warnings.push('Missing top-level title (recommend starting with `# Implementation Plan`).');
  }

  for (const sec of REQUIRED_SECTIONS) {
    if (!hasHeading(md, sec.heading)) {
      errors.push({
        field: `section:${sec.key}`,
        issue: `Missing required section heading: "## ${sec.heading}"`,
      });
    }
  }

  const impl = extractSection(md, 'Implementation Steps');
  if (impl && !looksLikeNumberedSteps(impl)) {
    errors.push({
      field: 'section:implementation_steps',
      issue: 'Implementation Steps must include a numbered list (e.g., `1. ...`, `2. ...`).',
    });
  }

  const files = extractSection(md, 'Files to Modify');
  if (files && !looksLikeFileList(files)) {
    warnings.push(
      'Files to Modify should include bullet points with file paths (e.g., `- src/app/api/foo/route.ts`).'
    );
  }

  if (md.length < 400) {
    warnings.push(`Plan looks very short (${md.length} chars). Consider adding more detail.`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function generatePlanValidationFeedback(result: PlanValidationResult): string {
  const parts: string[] = [];

  if (result.errors.length > 0) {
    parts.push('VALIDATION ERRORS - Please fix these issues:\n');
    result.errors.forEach((e, i) => parts.push(`${i + 1}. [${e.field}] ${e.issue}`));
  }

  if (result.warnings.length > 0) {
    parts.push('\nWARNINGS (not critical, but recommended):\n');
    result.warnings.forEach((w, i) => parts.push(`${i + 1}. ${w}`));
  }

  parts.push(
    '\nRequired output format: return ONLY valid JSON (no markdown fences) in the shape:\n'
  );
  parts.push(
    JSON.stringify(
      {
        plan: `# Implementation Plan

## Overview
...

## Technical Approach
...

## Implementation Steps
1. ...
2. ...

## Files to Modify
- src/...

## Testing Strategy
...

## Potential Issues
...

## Success Criteria
...`,
      },
      null,
      2
    )
  );

  return parts.join('\n');
}

