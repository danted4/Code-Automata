/**
 * Subtask Validator
 * 
 * Validates that generated subtasks conform to the required schema.
 * Provides detailed feedback when validation fails.
 */

import { Subtask } from '../tasks/schema';

export interface ValidationError {
  field: string;
  issue: string;
  subtaskId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
}

/**
 * Validate subtasks JSON structure
 * Returns validation result and human-readable feedback
 */
export function validateSubtasks(data: any): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  // Check if data exists
  if (!data) {
    errors.push({
      field: 'root',
      issue: 'Output is empty or null',
    });
    return { valid: false, errors, warnings };
  }

  // Check if subtasks array exists
  if (!data.subtasks) {
    errors.push({
      field: 'subtasks',
      issue: 'Missing "subtasks" field. Expected: { "subtasks": [...] }',
    });
    return { valid: false, errors, warnings };
  }

  // Check if subtasks is an array
  if (!Array.isArray(data.subtasks)) {
    errors.push({
      field: 'subtasks',
      issue: `"subtasks" must be an array, got ${typeof data.subtasks}`,
    });
    return { valid: false, errors, warnings };
  }

  // Check array is not empty
  if (data.subtasks.length === 0) {
    errors.push({
      field: 'subtasks',
      issue: 'Subtasks array is empty. Generate at least 1 subtask.',
    });
    return { valid: false, errors, warnings };
  }

  // Check array size
  if (data.subtasks.length > 20) {
    warnings.push(
      `Subtasks count is ${data.subtasks.length}. Recommend keeping it under 15 for better sequential execution.`
    );
  }

  // Validate each subtask
  for (let i = 0; i < data.subtasks.length; i++) {
    const subtask = data.subtasks[i];
    const subtaskId = subtask?.id || `subtask[${i}]`;

    // Check if subtask is an object
    if (typeof subtask !== 'object' || subtask === null) {
      errors.push({
        field: `subtasks[${i}]`,
        issue: `Expected object, got ${typeof subtask}`,
        subtaskId,
      });
      continue;
    }

    // Validate required fields
    if (!subtask.id || typeof subtask.id !== 'string') {
      errors.push({
        field: `subtasks[${i}].id`,
        issue: 'Missing or invalid "id" (must be a non-empty string)',
        subtaskId,
      });
    }

    if (!subtask.content || typeof subtask.content !== 'string') {
      errors.push({
        field: `subtasks[${i}].content`,
        issue: 'Missing or invalid "content" (must be a non-empty string)',
        subtaskId,
      });
    }

    if (!subtask.label || typeof subtask.label !== 'string') {
      errors.push({
        field: `subtasks[${i}].label`,
        issue: 'Missing or invalid "label" (must be a non-empty string)',
        subtaskId,
      });
    }

    // Optional: activeForm
    if (subtask.activeForm && typeof subtask.activeForm !== 'string') {
      errors.push({
        field: `subtasks[${i}].activeForm`,
        issue: 'Invalid "activeForm" (must be a string)',
        subtaskId,
      });
    }

    // Optional: type validation
    if (subtask.type && !['dev', 'qa'].includes(subtask.type)) {
      errors.push({
        field: `subtasks[${i}].type`,
        issue: `Invalid "type" value "${subtask.type}". Must be "dev" or "qa".`,
        subtaskId,
      });
    }

    // Check for duplicate IDs
    if (subtask.id && data.subtasks.some((s: any, idx: number) => idx < i && s.id === subtask.id)) {
      errors.push({
        field: `subtasks[${i}].id`,
        issue: `Duplicate ID "${subtask.id}" found. Each subtask must have a unique ID.`,
        subtaskId,
      });
    }

    // Warnings for content quality
    if (subtask.content && subtask.content.length < 20) {
      warnings.push(
        `Subtask "${subtask.id}" has very short content (${subtask.content.length} chars). Consider providing more details.`
      );
    }

    if (subtask.label && subtask.label.length > 50) {
      warnings.push(
        `Subtask "${subtask.id}" has a long label (${subtask.label.length} chars). Keep labels under 50 characters.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Generate human-readable feedback for validation errors
 * This is sent back to the agent to fix the format
 */
export function generateValidationFeedback(result: ValidationResult): string {
  if (result.valid && result.warnings.length === 0) {
    return 'Validation successful! All subtasks conform to the required format.';
  }

  const parts: string[] = [];

  if (result.errors.length > 0) {
    parts.push('VALIDATION ERRORS - Please fix these issues:\n');
    result.errors.forEach((error, i) => {
      parts.push(
        `${i + 1}. [${error.field}] ${error.issue}${
          error.subtaskId ? ` (${error.subtaskId})` : ''
        }`
      );
    });
  }

  if (result.warnings.length > 0) {
    parts.push('\nWARNINGS (not critical, but recommended to fix):\n');
    result.warnings.forEach((warning, i) => {
      parts.push(`${i + 1}. ${warning}`);
    });
  }

  if (result.errors.length === 0) {
    parts.push('\nValidation PASSED with warnings. Please improve the format as noted above.\n');
  } else {
    parts.push(
      '\nPlease review your JSON output. Ensure it matches the required format:\n'
    );
    parts.push(
      JSON.stringify(
        {
          subtasks: [
            {
              id: 'subtask-1',
              content: 'Detailed description of work',
              label: 'Short label',
              activeForm: 'Optional: present continuous form',
              type: 'Optional: "dev" or "qa"',
            },
          ],
        },
        null,
        2
      )
    );
  }

  return parts.join('\n');
}

/**
 * Extract and validate JSON from text
 * Handles markdown code blocks and raw JSON
 */
export function extractAndValidateJSON(
  text: string
): { data: any; error: string | null } {
  try {
    const parsed = extractFirstValidJSON(text);
    if (parsed === null) {
      return {
        data: null,
        error:
          'No JSON found in output. Ensure you return valid JSON (no markdown fences, no extra text) in the format: { "subtasks": [...] } or { "plan": "..." }',
      };
    }

    return { data: parsed, error: null };
  } catch (e) {
    return {
      data: null,
      error: `Failed to parse JSON: ${
        e instanceof Error ? e.message : 'Unknown error'
      }. Please ensure output is valid JSON.`,
    };
  }
}

/**
 * Extract the FIRST valid JSON value from arbitrary text.
 *
 * Why: LLMs often include extra prose, markdown fences, or repeat JSON blocks.
 * We want the first successfully-parseable JSON object/array and ignore everything else.
 */
function extractFirstValidJSON(text: string): any | null {
  // Prefer fenced code blocks first.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const inner = (m[1] || '').trim();
    if (!inner) continue;
    const parsed = tryParseFirstJSONFromText(inner);
    if (parsed !== null) return parsed;
  }

  // Fallback: scan the whole text.
  return tryParseFirstJSONFromText(text);
}

function tryParseFirstJSONFromText(text: string): any | null {
  // Find the earliest '{' or '[' and then attempt to parse the shortest balanced JSON
  // value starting at each candidate position.
  const starts: Array<{ idx: number; ch: '{' | '[' }> = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') starts.push({ idx: i, ch });
  }

  for (const start of starts) {
    const extracted = extractBalancedJsonSubstring(text, start.idx);
    if (!extracted) continue;
    try {
      return JSON.parse(extracted);
    } catch {
      // keep scanning
    }
  }
  return null;
}

/**
 * Extract a balanced JSON substring starting at `startIdx` (which must be '{' or '[').
 * This is quote-aware so braces inside strings don't affect balancing.
 */
function extractBalancedJsonSubstring(text: string, startIdx: number): string | null {
  const open = text[startIdx];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) depth += 1;
    if (ch === close) depth -= 1;

    if (depth === 0) {
      return text.slice(startIdx, i + 1);
    }
  }

  return null;
}
