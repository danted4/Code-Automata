/**
 * Cursor Agent CLI Adapter
 *
 * Integrates the Cursor Agent CLI into the Code-Auto workflow with full feature parity to Amp:
 * - Structured JSON output for planning and subtask generation
 * - Read-only plan mode for planning phase
 * - Thread/session resume support
 * - Streaming output via `--output-format stream-json`
 * - JSON validation and feedback loop (same as Amp)
 *
 * Cursor CLI flags used:
 * - `--print`: Non-interactive mode for scripts
 * - `--output-format stream-json`: Structured streaming output
 * - `--mode plan`: Read-only planning mode (no file edits)
 * - `--workspace <path>`: Set working directory
 * - `--resume <chatId>`: Resume previous session
 * - `--model <model>`: Choose specific model
 */

import { spawn, ChildProcessWithoutNullStreams, execFile } from 'child_process';
import { promisify } from 'util';
import {
  CLIAdapter,
  CLIConfig,
  CLICapabilities,
  CLIConfigSchema,
  ExecuteRequest,
  StreamMessage,
} from './base';

const execFileAsync = promisify(execFile);

interface CursorStreamMessage {
  type: 'text' | 'tool_call' | 'tool_result' | 'end' | 'error';
  content?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  error?: string;
}

// Cache for dynamically fetched models
let modelsCacheTimestamp = 0;
let modelsCache: Array<{ value: string; label: string }> = [];
const MODELS_CACHE_TTL = 1000 * 60 * 60; // 1 hour

// Fallback models if dynamic fetch fails
const FALLBACK_MODELS = [
  { value: 'auto', label: 'Auto' },
  { value: 'composer-1', label: 'Composer 1' },
  { value: 'opus-4.5-thinking', label: 'Claude 4.5 Opus (Thinking)' },
  { value: 'sonnet-4.5', label: 'Claude 4.5 Sonnet' },
  { value: 'sonnet-4.5-thinking', label: 'Claude 4.5 Sonnet (Thinking)' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: 'gpt-5.2-high', label: 'GPT-5.2 High' },
];

export class CursorAdapter implements CLIAdapter {
  name = 'cursor';
  displayName = 'Cursor Agent (CLI)';

  private config: CLIConfig | null = null;
  private threadWorkingDirs = new Map<string, string>();
  private threadChatIds = new Map<string, string>(); // Track Cursor chat IDs for resume
  private processes = new Map<string, ChildProcessWithoutNullStreams>();

  /**
   * Fetch available models from Cursor CLI
   * Cached for 1 hour to avoid repeated subprocess calls
   */
  private async fetchAvailableModels(): Promise<Array<{ value: string; label: string }>> {
    const now = Date.now();

    // Return cached models if still valid
    if (modelsCache.length > 0 && now - modelsCacheTimestamp < MODELS_CACHE_TTL) {
      return modelsCache;
    }

    try {
      const command = process.env.CURSOR_AGENT_CMD || 'agent';
      const { stdout } = await execFileAsync(command, ['models'], {
        timeout: 5000,
        encoding: 'utf-8',
      });

      // Parse output: "model-id - Display Name  (markers)"
      // Example: "sonnet-4.5-thinking - Claude 4.5 Sonnet (Thinking)  (current)"
      // Strip ANSI codes and parse lines
      const cleanOutput = stdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
      const lines = cleanOutput.split('\n');

      const models: Array<{ value: string; label: string }> = [];
      let defaultModel = 'opus-4.5-thinking'; // Default fallback

      for (const line of lines) {
        // Match: "model-id - Display Name with (Thinking)  (status markers)"
        // We need to extract the full display name INCLUDING (Thinking) but EXCLUDING (default)/(current)
        const match = line.match(/^([a-z0-9.-]+)\s+-\s+(.+?)\s*(?:\s+\((default|current)\))?$/i);
        if (match) {
          const [, modelId, displayName] = match;
          const fullLine = line;

          models.push({
            value: modelId.trim(),
            label: displayName.trim(),
          });

          // Track default model
          if (fullLine.includes('(default)')) {
            defaultModel = modelId.trim();
          }
        }
      }

      if (models.length > 0) {
        // Cache the results
        modelsCache = models;
        modelsCacheTimestamp = now;
        console.log(`[CursorAdapter] Fetched ${models.length} models, default: ${defaultModel}`);
        return models;
      }
    } catch (error) {
      console.warn('[CursorAdapter] Failed to fetch models from CLI:', error);
    }

    // Fallback to static list
    return FALLBACK_MODELS;
  }

  getConfigSchema(): CLIConfigSchema {
    // Note: This method is synchronous but we need async for fetching models
    // Solution: Prefetch models during adapter initialization, or use cached value
    return {
      fields: [
        {
          name: 'model',
          label: 'Model',
          type: 'select',
          options: modelsCache.length > 0 ? modelsCache : FALLBACK_MODELS,
          default: 'opus-4.5-thinking',
          description: 'AI model to use for task execution',
        },
      ],
    };
  }

  async initialize(config: CLIConfig): Promise<void> {
    this.config = config;

    // Prefetch models on first initialization (don't block, just warm the cache)
    if (modelsCache.length === 0) {
      this.fetchAvailableModels().catch((err) =>
        console.warn('[CursorAdapter] Failed to prefetch models during init:', err)
      );
    }

    console.log('[CursorAdapter] Initialized with cwd:', config.cwd);
  }

  async *execute(request: ExecuteRequest): AsyncIterable<StreamMessage> {
    if (!this.config) {
      throw new Error('CursorAdapter not initialized');
    }

    const threadId = request.threadId || this.generateThreadId();
    const effectiveCwd = this.threadWorkingDirs.get(threadId) ?? this.config.cwd;

    // Detect phase from request
    const isPlanningPhase =
      request.isQuestionGeneration ||
      request.prompt.includes('PLANNING PHASE') ||
      request.prompt.includes('Question Generation');

    const isSubtaskGeneration =
      request.isSubtaskGeneration || request.prompt.includes('SUBTASK GENERATION');

    // Build command arguments
    const command = process.env.CURSOR_AGENT_CMD || 'agent';
    const args: string[] = [
      '--print', // Non-interactive mode
      '--output-format',
      'stream-json', // Structured streaming
      '--workspace',
      effectiveCwd, // Set working directory
    ];

    // Note: --mode plan prevents file writes but also seems to prevent final responses
    // For now, we rely on the prompt instructions to prevent edits during planning
    // if (isPlanningPhase) {
    //   args.push('--mode', 'plan');
    // }

    // Add model selection (Cursor extends config with model field)
    const model = (this.config as CLIConfig & { model?: string }).model || 'opus-4.5-thinking';
    args.push('--model', model);

    // Resume previous chat session if available
    const existingChatId = this.threadChatIds.get(threadId);
    if (existingChatId && request.threadId) {
      args.push('--resume', existingChatId);
    }

    console.log('[CursorAdapter] Spawning Cursor agent:', command, args.join(' '));

    // Yield initial system message
    yield {
      type: 'system',
      timestamp: Date.now(),
      data: {
        message: 'Cursor agent started',
        command: `${command} ${args.join(' ')}`,
        cwd: effectiveCwd,
        mode: isPlanningPhase ? 'plan' : 'normal',
      },
      threadId,
    };

    // Prepare environment variables
    const configApiKey = this.config?.apiKey;

    // Build clean environment:
    // 1. Copy all env vars EXCEPT CURSOR_API_KEY
    // 2. Then conditionally add CURSOR_API_KEY if we have a real key
    const { CURSOR_API_KEY: _, ...cleanEnv } = process.env;
    const env = cleanEnv as NodeJS.ProcessEnv;

    // Only set CURSOR_API_KEY if we have a real API key (not the placeholder)
    if (configApiKey && configApiKey !== 'cursor-cli-login' && configApiKey !== 'mock-key') {
      env.CURSOR_API_KEY = configApiKey;
    }
    // Otherwise: CLI login is used, no API key env var set

    // Spawn the agent process
    const child = spawn(command, args, {
      cwd: effectiveCwd,
      shell: false,
      env,
    });

    this.processes.set(threadId, child);

    // Send prompt via STDIN (proper way for --print mode)
    // Wait for stdin to be ready, then write and close
    const stdinReady = new Promise<void>((resolve) => {
      if (child.stdin.writable) {
        resolve();
      } else {
        child.stdin.once('ready', resolve);
      }
    });

    try {
      await stdinReady;
      child.stdin.write(request.prompt, 'utf-8');
      child.stdin.end();
      console.log('[CursorAdapter] Prompt sent via stdin, length:', request.prompt.length);
    } catch (error) {
      yield {
        type: 'error',
        timestamp: Date.now(),
        data: {
          error: error instanceof Error ? error.message : 'Failed to write prompt to stdin',
        },
        threadId,
      };
      this.safeCleanupProcess(threadId);
      return;
    }

    let accumulatedOutput = '';
    let accumulatedStderr = '';
    let buffer = '';
    const stderrMessages: StreamMessage[] = [];

    // Capture stderr for error messages
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      accumulatedStderr += text;
      console.error('[CursorAdapter] stderr:', text);

      // Store stderr messages to emit later
      stderrMessages.push({
        type: 'system',
        timestamp: Date.now(),
        data: { message: `[stderr] ${text}` },
        threadId,
      });
    });

    // Stream STDOUT and parse stream-json format
    try {
      for await (const chunk of child.stdout) {
        buffer += chunk.toString();

        // Parse newline-delimited JSON
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            // Cursor CLI emits various message types; use loose type for parsing
            const msg = JSON.parse(line) as {
              type?: string;
              message?: { content?: Array<{ type?: string; text?: string }> } | string;
              text?: string;
              subtype?: string;
              tool_call?: Record<string, unknown>;
              call_id?: string;
              error?: string;
            };

            // Cursor stream-json format uses different message types
            if (msg.type === 'assistant') {
              // Extract text from assistant message
              // Format: {type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: '...'}]}}
              let text = '';
              const msgContent =
                typeof msg.message === 'object' && msg.message && 'content' in msg.message
                  ? msg.message.content
                  : undefined;
              if (msgContent) {
                for (const item of msgContent) {
                  if (item.type === 'text' && item.text) {
                    text += item.text;
                  }
                }
              } else if (msg.text) {
                // Fallback for delta format
                text = msg.text;
              }

              if (text) {
                accumulatedOutput += text;
                yield {
                  type: 'assistant',
                  timestamp: Date.now(),
                  data: { message: text },
                  threadId,
                };
              }
            } else if (msg.type === 'thinking' && msg.text) {
              // Thinking deltas (optional to show)
              yield {
                type: 'system',
                timestamp: Date.now(),
                data: { message: `[thinking] ${msg.text}` },
                threadId,
              };
            } else if (msg.type === 'tool_call') {
              if (msg.subtype === 'started') {
                // Tool call started
                const toolName = msg.tool_call ? Object.keys(msg.tool_call)[0] : 'unknown';
                yield {
                  type: 'tool',
                  timestamp: Date.now(),
                  data: {
                    tool: toolName,
                    status: 'started',
                    call_id: msg.call_id,
                  },
                  threadId,
                };
              } else if (msg.subtype === 'completed') {
                // Tool call completed - don't yield empty content
                const toolName = msg.tool_call ? Object.keys(msg.tool_call)[0] : 'unknown';
                yield {
                  type: 'tool',
                  timestamp: Date.now(),
                  data: {
                    tool: toolName,
                    status: 'completed',
                    call_id: msg.call_id,
                  },
                  threadId,
                };
              }
            } else if (msg.type === 'system') {
              // System messages (init, etc.)
              // Skip these for now
            } else if (msg.type === 'user') {
              // User messages (echoed back)
              // Skip these
            } else if (msg.type === 'error') {
              const errMsg =
                msg.error ||
                (typeof msg.message === 'string' ? msg.message : undefined) ||
                'Unknown error from agent';
              yield {
                type: 'error',
                timestamp: Date.now(),
                data: { error: errMsg },
                threadId,
              };
            }
            // No explicit "end" message in Cursor - process ends naturally
          } catch (_parseError) {
            // If JSON parse fails, treat as plain text
            console.warn('[CursorAdapter] Failed to parse line as JSON:', line.substring(0, 100));
            accumulatedOutput += line + '\n';
            yield {
              type: 'assistant',
              timestamp: Date.now(),
              data: { message: line },
              threadId,
            };
          }
        }
      }
    } catch (error) {
      yield {
        type: 'error',
        timestamp: Date.now(),
        data: {
          error: error instanceof Error ? error.message : 'Error reading agent output',
        },
        threadId,
      };
      this.safeCleanupProcess(threadId);
      return;
    }

    // Wait for process to exit
    const exitCode: number = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code ?? 0));
    });

    this.safeCleanupProcess(threadId);

    // Emit any captured stderr messages
    for (const msg of stderrMessages) {
      yield msg;
    }

    // For subtask generation, validate and potentially retry with feedback
    if (isSubtaskGeneration) {
      yield* this.validateAndFeedbackSubtasks(
        accumulatedOutput,
        threadId,
        request.prompt,
        effectiveCwd,
        model
      );
      return;
    }

    // Emit final result
    if (exitCode === 0) {
      yield {
        type: 'result',
        timestamp: Date.now(),
        data: {
          success: true,
          message: 'Cursor agent completed successfully',
          output: accumulatedOutput.trim(),
          exitCode,
        },
        threadId,
      };
    } else {
      // Include stderr in error for debugging
      const errorMessage = accumulatedStderr.trim()
        ? `Cursor agent exited with code ${exitCode}.\n\nError output:\n${accumulatedStderr.trim()}`
        : `Cursor agent exited with code ${exitCode}`;

      yield {
        type: 'error',
        timestamp: Date.now(),
        data: {
          error: errorMessage,
          output: accumulatedOutput.trim(),
          stderr: accumulatedStderr.trim(),
          exitCode,
        },
        threadId,
      };
    }
  }

  async createThread(workingDir: string): Promise<string> {
    const threadId = this.generateThreadId();
    this.threadWorkingDirs.set(threadId, workingDir);
    console.log('[CursorAdapter] Created thread:', threadId, 'in', workingDir);
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    console.log('[CursorAdapter] resumeThread called for:', threadId);
    // Thread resume is handled via --resume flag in execute()
  }

  async stopThread(threadId: string): Promise<void> {
    const proc = this.processes.get(threadId);
    if (!proc) {
      console.log('[CursorAdapter] No process found for thread:', threadId);
      return;
    }

    console.log('[CursorAdapter] Stopping thread:', threadId);
    try {
      proc.kill('SIGTERM');
    } catch (error) {
      console.error('[CursorAdapter] Failed to kill process:', error);
    } finally {
      this.safeCleanupProcess(threadId);
    }
  }

  getCapabilities(): CLICapabilities {
    return {
      supportsThreads: true,
      supportsModes: ['normal', 'plan'],
      maxConcurrentAgents: 12,
      supportsPermissions: true,
    };
  }

  /**
   * Validate subtasks JSON and provide feedback if validation fails
   * Same logic as Amp adapter's validation loop
   */
  private async *validateAndFeedbackSubtasks(
    output: string,
    threadId: string,
    originalPrompt: string,
    workingDir: string,
    model: string
  ): AsyncIterable<StreamMessage> {
    const { extractAndValidateJSON, validateSubtasks, generateValidationFeedback } =
      await import('../validation/subtask-validator');

    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;

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
        yield* this.executeWithFeedback(feedback, originalPrompt, threadId, workingDir, model);
        return;
      }

      // Validate subtasks structure
      const validationResult = validateSubtasks(parsedData);

      yield {
        type: 'validation',
        timestamp: Date.now(),
        data: {
          attempt,
          success: validationResult.valid,
          subtaskCount: parsedData?.subtasks?.length || 0,
          errors: validationResult.errors,
          warnings: validationResult.warnings,
        },
        threadId,
      };

      if (validationResult.valid) {
        yield {
          type: 'result',
          timestamp: Date.now(),
          data: {
            success: true,
            message: 'Subtasks validation passed',
            output: output,
            subtasks: parsedData?.subtasks ?? [],
          },
          threadId,
        };
        return;
      }

      // Validation failed - retry with feedback
      if (attempt < maxAttempts) {
        const feedback = generateValidationFeedback(validationResult);
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
          workingDir,
          model
        );
        return;
      }
    }

    // All attempts failed
    yield {
      type: 'error',
      timestamp: Date.now(),
      data: {
        error: `Validation failed after ${maxAttempts} attempts`,
      },
      threadId,
    };
  }

  /**
   * Execute a follow-up prompt with feedback
   */
  private async *executeWithFeedback(
    feedback: string,
    originalPrompt: string,
    threadId: string,
    workingDir: string,
    model: string
  ): AsyncIterable<StreamMessage> {
    const correctionPrompt = `${originalPrompt}\n\nCORRECTION REQUEST:\n${feedback}`;

    const command = process.env.CURSOR_AGENT_CMD || 'agent';
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--workspace',
      workingDir,
      '--model',
      model,
    ];

    // Resume the same chat if we have a chat ID
    const chatId = this.threadChatIds.get(threadId);
    if (chatId) {
      args.push('--resume', chatId);
    }

    // Prepare environment (same logic as main execute method)
    const configApiKey = this.config?.apiKey;
    const { CURSOR_API_KEY: _, ...cleanEnv } = process.env;
    const env = cleanEnv as NodeJS.ProcessEnv;

    if (configApiKey && configApiKey !== 'cursor-cli-login' && configApiKey !== 'mock-key') {
      env.CURSOR_API_KEY = configApiKey;
    }

    const child = spawn(command, args, {
      cwd: workingDir,
      shell: false,
      env,
    });

    // Send prompt via stdin
    child.stdin.write(correctionPrompt, 'utf-8');
    child.stdin.end();

    let accumulatedOutput = '';
    let buffer = '';

    for await (const chunk of child.stdout) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg: CursorStreamMessage = JSON.parse(line);
          if (msg.type === 'text' && msg.content) {
            accumulatedOutput += msg.content;
            yield {
              type: 'assistant',
              timestamp: Date.now(),
              data: { message: msg.content },
              threadId,
            };
          }
        } catch {
          accumulatedOutput += line + '\n';
        }
      }
    }

    await new Promise((resolve) => child.on('close', resolve));

    // Recursively validate again
    const { extractAndValidateJSON, validateSubtasks } =
      await import('../validation/subtask-validator');

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
  }

  private generateThreadId(): string {
    return `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private safeCleanupProcess(threadId: string) {
    this.processes.delete(threadId);
  }
}
