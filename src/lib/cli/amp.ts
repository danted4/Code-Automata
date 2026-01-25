/**
 * Amp SDK Adapter
 *
 * Uses @sourcegraph/amp-sdk for type-safe, version-controlled integration
 * with the Amp agent. No subprocess management needed.
 *
 * Prerequisites:
 * - `@sourcegraph/amp-sdk` installed: npm install @sourcegraph/amp-sdk
 * - `AMP_API_KEY` environment variable set or `amp login` executed
 *
 * Usage:
 * const adapter = new AmpAdapter();
 * await adapter.initialize({ apiKey, cwd, mode: 'smart' });
 * for await (const message of adapter.execute({ prompt: 'your task' })) {
 *   console.log(message);
 * }
 */

import { execute } from '@sourcegraph/amp-sdk';
import type { AmpOptions, StreamMessage as AmpStreamMessage } from '@sourcegraph/amp-sdk';
import fs from 'fs/promises';
import path from 'path';
import {
  CLIAdapter,
  CLIConfig,
  CLICapabilities,
  CLIConfigSchema,
  ExecuteRequest,
  StreamMessage,
  ContextData,
} from './base';

export class AmpAdapter implements CLIAdapter {
  name = 'amp';
  displayName = 'Amp SDK';

  private config: CLIConfig | null = null;
  private activeThreads = new Map<string, string>();

  getConfigSchema(): CLIConfigSchema {
    return {
      fields: [
        {
          name: 'mode',
          label: 'Mode',
          type: 'select',
          options: [
            { value: 'smart', label: 'Smart Mode' },
            { value: 'rush', label: 'Rush Mode' },
          ],
          default: 'smart',
          description:
            'Smart mode uses Claude Opus 4.5 for complex tasks. Rush mode uses Claude Haiku for simpler tasks at lower cost.',
        },
      ],
    };
  }

  async initialize(config: CLIConfig): Promise<void> {
    this.config = config;

    // SDK will handle authentication via AMP_API_KEY env var
    // No need to verify CLI here since SDK is a library

    console.log('[AmpAdapter] Initialized with mode:', config.mode || 'smart');
  }

  async *execute(request: ExecuteRequest): AsyncIterable<StreamMessage> {
    if (!this.config) {
      throw new Error('AmpAdapter not initialized');
    }

    const threadId = request.threadId || this.generateThreadId();
    const effectiveCwd = this.activeThreads.get(threadId) ?? this.config.cwd;

    // Detect phase from request or prompt
    const isSubtaskGeneration = request.isSubtaskGeneration || 
      request.prompt.includes('SUBTASK GENERATION');
    const isPlanningPrompt =
      request.prompt.includes('PLANNING PHASE') ||
      request.prompt.includes('Question Generation') ||
      request.isQuestionGeneration === true;

    try {
      // Build prompt with context injection
      let fullPrompt = this.buildPromptWithContext(
        request.prompt,
        request.context
      );

      console.log('[AmpAdapter] Executing with mode:', this.config.mode);
      console.log('[AmpAdapter] Working directory:', effectiveCwd);
      console.log('[AmpAdapter] Is subtask generation:', isSubtaskGeneration);

      // Yield system message to indicate agent starting
      yield {
        type: 'system',
        timestamp: Date.now(),
        data: {
          message: 'Amp SDK agent started',
          threadId,
          mode: this.config.mode || 'smart',
        },
        threadId,
      };

      // SDK options configuration
      const options: AmpOptions = {
        cwd: effectiveCwd,
        // Planning should be read-only: do NOT allow write/edit/bash.
        dangerouslyAllowAll: !isPlanningPrompt,
        mode: (this.config.mode || 'smart') as 'smart' | 'rush' | 'large',
      };

      if (isPlanningPrompt) {
        // Enforce read-only behavior during planning with an explicit permission ruleset.
        // This prevents Amp from creating files (like ARCHITECTURE.md) before subtasks exist.
        const settingsFilePath = path.join(
          effectiveCwd,
          '.tmp',
          `amp-planning-settings-${threadId}.json`
        );
        await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
        await fs.writeFile(
          settingsFilePath,
          JSON.stringify(
            {
              'amp.permissions': [
                // Allow read-only project exploration
                { tool: 'Read', action: 'allow' },
                { tool: 'glob', action: 'allow' },
                { tool: 'Grep', action: 'allow' },

                // Explicitly reject write/exec tools with a helpful message
                {
                  tool: 'create_file',
                  action: 'reject',
                  message:
                    'Planning phase is read-only. Do not create files. Return ONLY valid JSON for the plan/questions.',
                },
                {
                  tool: 'edit_file',
                  action: 'reject',
                  message:
                    'Planning phase is read-only. Do not edit files. Return ONLY valid JSON for the plan/questions.',
                },
                {
                  tool: 'Bash',
                  action: 'reject',
                  message:
                    'Planning phase is read-only. Do not run Bash. Return ONLY valid JSON for the plan/questions.',
                },

                // Default: reject everything else (no prompts)
                {
                  tool: '*',
                  action: 'reject',
                  message:
                    'Planning phase is read-only. Only use Read/glob/Grep. Return ONLY valid JSON.',
                },
              ],
            },
            null,
            2
          ),
          'utf-8'
        );
        // Amp SDK supports loading a settings file per execution.
        (options as any).settingsFile = settingsFilePath;
      }

      // For subtask generation, add validation instructions
      if (isSubtaskGeneration) {
        fullPrompt += `\n\nVALIDATION REQUIREMENT:
Your output will be validated. Ensure you return ONLY valid JSON matching this exact format:
{
  "subtasks": [
    {
      "id": "subtask-1",
      "content": "Detailed description",
      "label": "Short label (3-5 words)",
      "activeForm": "Present continuous form (optional but recommended)"
    }
  ]
}

Rules:
1. Return ONLY valid JSON, no markdown or extra text
2. Each subtask must have: id, content, label
3. IDs must be unique and descriptive (e.g., "subtask-1")
4. Content should be detailed and specific
5. Labels should be short (3-5 words max)
6. Generate 5-15 subtasks total`;
      }

      // Execute via SDK
      const messages = execute({ prompt: fullPrompt, options });

      let accumulatedOutput = '';

      // Stream messages from SDK
      for await (const message of messages) {
        console.log('[AmpAdapter] Received message type:', message.type);

        // Map SDK message types to our standard format
        let streamType: StreamMessage['type'] = 'assistant';
        let data: any = message;

        if (message.type === 'system') {
          streamType = 'system';
          data = {
            message: `System: session initialized`,
            sessionId: message.session_id,
            tools: (message as any).tools,
          };
        } else if (message.type === 'assistant') {
          // The SDK provides a structured Anthropic-style message payload.
          // For downstream validators/parsers, we only want the *raw text* (like Mock does),
          // not JSON-stringified message objects (which escape quotes and break JSON extraction).
          const msg = (message as any).message;
          const content = Array.isArray(msg?.content) ? msg.content : [];

          const toolUses = content.filter((c: any) => c?.type === 'tool_use');
          for (const toolUse of toolUses) {
            yield {
              type: 'tool',
              timestamp: Date.now(),
              data: {
                tool: toolUse?.name,
                input: toolUse?.input,
                id: toolUse?.id,
              },
              threadId,
            };
          }

          const textParts = content
            .filter((c: any) => c?.type === 'text' && typeof c?.text === 'string')
            .map((c: any) => c.text);
          const text = textParts.join('');

          if (text) {
            streamType = 'assistant';
            accumulatedOutput += text + '\n';
            data = { message: text };
          } else {
            // If there's no text, don't emit an assistant message (we emitted tool_use above).
            continue;
          }
        } else if (message.type === 'result') {
          streamType = 'result';
          const resultMsg = message as any;
          const resultOutput =
            resultMsg.result || resultMsg.message || resultMsg.output || 'Completed';
          accumulatedOutput += String(resultOutput) + '\n';
          data = {
            success: !resultMsg.is_error,
            message: String(resultOutput),
            output: String(resultOutput),
          };
        } else if (message.type === 'user') {
          // Ignore echo'd user messages in streaming output.
          continue;
        }

        yield {
          type: streamType,
          timestamp: Date.now(),
          data,
          threadId,
        };
      }

      // For subtask generation, validate output and provide feedback
      if (isSubtaskGeneration) {
        yield* this.validateAndFeedbackSubtasks(accumulatedOutput, threadId, fullPrompt, options);
      } else {
        // SDK already emits a `result` message; don't emit a second one.
      }
    } catch (error) {
      yield {
        type: 'error',
        timestamp: Date.now(),
        data: {
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
        },
        threadId,
      };
    }
  }

  async createThread(workingDir: string): Promise<string> {
    // SDK handles thread management automatically
    // Threads are created on first execute, continued by passing threadId
    const threadId = this.generateThreadId();
    this.activeThreads.set(threadId, workingDir);
    console.log('[AmpAdapter] Created thread:', threadId, 'in', workingDir);
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    // Resuming is handled by passing threadId to execute()
    const workingDir = this.activeThreads.get(threadId);
    console.log(
      '[AmpAdapter] Thread resume will be handled by execute():',
      threadId,
      'in',
      workingDir
    );
  }

  async stopThread(threadId: string): Promise<void> {
    // SDK handles process cleanup automatically
    this.activeThreads.delete(threadId);
    console.log('[AmpAdapter] Stopped thread:', threadId);
  }

  getCapabilities(): CLICapabilities {
    return {
      supportsThreads: true,
      supportsModes: ['smart', 'rush'],
      maxConcurrentAgents: 12,
      supportsPermissions: true,
    };
  }

  /**
   * Build prompt with context injection from memory system
   */
  private buildPromptWithContext(prompt: string, context?: ContextData): string {
    if (!context) {
      return prompt;
    }

    const parts: string[] = ['# Context from Memory System\n'];

    if (context.patterns && context.patterns.length > 0) {
      parts.push('\n## Learned Patterns');
      context.patterns.forEach((pattern) => {
        parts.push(`\n### ${pattern.category}`);
        parts.push(`${pattern.description}`);
        if (pattern.example) {
          parts.push(`Example: ${pattern.example}`);
        }
      });
    }

    if (context.gotchas && context.gotchas.length > 0) {
      parts.push('\n## Known Issues');
      context.gotchas.forEach((gotcha) => {
        parts.push(`\n**Issue:** ${gotcha.issue}`);
        parts.push(`**Solution:** ${gotcha.solution}`);
        if (gotcha.context) {
          parts.push(`Context: ${gotcha.context}`);
        }
      });
    }

    if (context.history && context.history.length > 0) {
      parts.push('\n## Recent History');
      context.history.forEach((entry) => {
        parts.push(
          `\n- Task ${entry.taskId} (${entry.phase}): ${
            entry.success ? 'Success' : 'Failed'
          } in ${entry.duration}ms`
        );
      });
    }

    parts.push('\n---\n\n# User Request\n\n' + prompt);

    return parts.join('\n');
  }

  /**
   * Validate subtasks and provide feedback if validation fails
   * Re-executes with feedback until validation passes
   */
  private async *validateAndFeedbackSubtasks(
    output: string,
    threadId: string,
    originalPrompt: string,
    options: AmpOptions
  ): AsyncIterable<StreamMessage> {
    // Import validator
    const {
      extractAndValidateJSON,
      validateSubtasks,
      generateValidationFeedback,
    } = await import('../validation/subtask-validator');

    let attempt = 0;
    const maxAttempts = 3;
    let lastValidationResult = null;

    while (attempt < maxAttempts) {
      attempt++;

      // Extract JSON from output
      const { data: parsedData, error: parseError } = extractAndValidateJSON(output);

      if (parseError) {
        yield {
          type: 'validation',
          timestamp: Date.now(),
          data: {
            attempt,
            success: false,
            error: parseError,
          },
          threadId,
        };

        if (attempt >= maxAttempts) {
          yield {
            type: 'error',
            timestamp: Date.now(),
            data: {
              error: `Failed to parse JSON after ${maxAttempts} attempts: ${parseError}`,
            },
            threadId,
          };
          return;
        }

        // Re-prompt with feedback
        const feedback = `Previous output had a parsing error. ${parseError}\n\nPlease provide a corrected version with valid JSON format.`;
        yield* this.executeWithFeedback(feedback, originalPrompt, threadId, options);
        return;
      }

      // Validate subtasks structure
      lastValidationResult = validateSubtasks(parsedData);

      yield {
        type: 'validation',
        timestamp: Date.now(),
        data: {
          attempt,
          success: lastValidationResult.valid,
          subtaskCount: parsedData?.subtasks?.length || 0,
          errors: lastValidationResult.errors,
          warnings: lastValidationResult.warnings,
        },
        threadId,
      };

      // If validation passed, return success
      if (lastValidationResult.valid) {
        yield {
          type: 'result',
          timestamp: Date.now(),
          data: {
            success: true,
            message: 'Subtasks validation passed',
            output: output,
            subtasks: parsedData.subtasks,
          },
          threadId,
        };
        return;
      }

      // If validation failed and we have attempts left, re-prompt with feedback
      if (attempt < maxAttempts) {
        const feedback = generateValidationFeedback(lastValidationResult);
        yield {
          type: 'feedback',
          timestamp: Date.now(),
          data: {
            attempt,
            nextAttempt: attempt + 1,
            feedback,
          },
          threadId,
        };

        yield* this.executeWithFeedback(
          `Your previous output had validation issues. Please fix them:\n\n${feedback}\n\nPlease try again.`,
          originalPrompt,
          threadId,
          options
        );
        return;
      }
    }

    // All attempts failed
    const finalFeedback = generateValidationFeedback(lastValidationResult || { valid: false, errors: [], warnings: [] });
    yield {
      type: 'error',
      timestamp: Date.now(),
      data: {
        error: `Validation failed after ${maxAttempts} attempts`,
        lastValidationResult,
        feedback: finalFeedback,
      },
      threadId,
    };
  }

  /**
   * Execute a follow-up with feedback to correct previous output
   */
  private async *executeWithFeedback(
    feedback: string,
    originalPrompt: string,
    threadId: string,
    options: AmpOptions
  ): AsyncIterable<StreamMessage> {
    const correctionPrompt = `${originalPrompt}\n\nCORRECTION REQUEST:\n${feedback}`;

    const messages = execute({ prompt: correctionPrompt, options });

    let accumulatedOutput = '';

    for await (const message of messages) {
      let streamType: StreamMessage['type'] = 'assistant';
      let data: any = message;

      if (message.type === 'assistant') {
        const msgContent = JSON.stringify((message as any).message);
        accumulatedOutput += msgContent;
        data = { message: msgContent };
      } else if (message.type === 'result') {
        const resultMsg = message as any;
        const resultOutput = resultMsg.result || 'Completed';
        accumulatedOutput += resultOutput;
        data = {
          success: !resultMsg.is_error,
          message: resultOutput,
          output: resultOutput,
        };
      }

      yield {
        type: streamType,
        timestamp: Date.now(),
        data,
        threadId,
      };
    }

    // Recursively validate again
    const {
      extractAndValidateJSON,
      validateSubtasks,
      generateValidationFeedback,
    } = await import('../validation/subtask-validator');

    const { data: parsedData, error: parseError } = extractAndValidateJSON(accumulatedOutput);

    if (!parseError && parsedData) {
      const result = validateSubtasks(parsedData);
      if (result.valid) {
        yield {
          type: 'result',
          timestamp: Date.now(),
          data: {
            success: true,
            message: 'Subtasks validation passed',
            output: accumulatedOutput,
            subtasks: parsedData.subtasks,
          },
          threadId,
        };
        return;
      }
    }

    // If still invalid, the outer loop will handle it
  }

  private generateThreadId(): string {
    return `amp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
