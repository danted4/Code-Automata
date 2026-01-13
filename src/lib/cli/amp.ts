/**
 * Amp SDK Adapter
 *
 * Integrates with @sourcegraph/amp-sdk for real AI agent execution.
 * WARNING: This uses paid API credits. Use Mock adapter for testing.
 */

import { execute as ampExecute } from '@sourcegraph/amp-sdk';
import {
  CLIAdapter,
  CLIConfig,
  CLICapabilities,
  ExecuteRequest,
  StreamMessage,
  ContextData,
} from './base';

export class AmpAdapter implements CLIAdapter {
  private config: CLIConfig | null = null;
  private activeThreads = new Map<string, AbortController>();

  async initialize(config: CLIConfig): Promise<void> {
    if (!config.apiKey) {
      throw new Error('Amp API key required');
    }

    // amp SDK uses SOURCEGRAPH_API_KEY from environment
    process.env.SOURCEGRAPH_API_KEY = config.apiKey;
    this.config = config;

    console.log('[AmpAdapter] Initialized with mode:', config.mode || 'smart');
  }

  async *execute(request: ExecuteRequest): AsyncIterable<StreamMessage> {
    if (!this.config) {
      throw new Error('AmpAdapter not initialized');
    }

    const controller = new AbortController();
    const threadId = request.threadId || this.generateThreadId();
    this.activeThreads.set(threadId, controller);

    try {
      // Build prompt with context injection
      const fullPrompt = this.buildPromptWithContext(
        request.prompt,
        request.context
      );

      // Execute with amp SDK
      const messages = ampExecute({
        prompt: fullPrompt,
        options: {
          cwd: this.config.cwd,
          continue: request.threadId || false,
          logLevel: this.config.logLevel === 'debug' ? 'debug' : undefined,
          // TODO: Add permissions support later (requires amp SDK permission format)
          // TODO: Add signal support for cancellation (may need different approach)
          // Note: mode is set via model in settings, not here
          // To use Rush mode, user should configure their amp settings
        },
      });

      // Stream messages back in our standard format
      for await (const message of messages) {
        yield {
          type: this.mapMessageType(message.type),
          timestamp: Date.now(),
          data: message,
          threadId,
        };

        // If this is a result message, we're done
        if (message.type === 'result') {
          break;
        }
      }
    } catch (error) {
      // Yield error message
      yield {
        type: 'error',
        timestamp: Date.now(),
        data: {
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
        },
        threadId,
      };
    } finally {
      this.activeThreads.delete(threadId);
    }
  }

  async createThread(workingDir: string): Promise<string> {
    // amp creates threads automatically on first execute
    const threadId = this.generateThreadId();
    console.log('[AmpAdapter] Created thread:', threadId, 'in', workingDir);
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    // No-op: handled by execute() with threadId parameter
    console.log('[AmpAdapter] Thread resume will be handled by execute():', threadId);
  }

  async stopThread(threadId: string): Promise<void> {
    const controller = this.activeThreads.get(threadId);
    if (controller) {
      controller.abort();
      this.activeThreads.delete(threadId);
      console.log('[AmpAdapter] Stopped thread:', threadId);
    }
  }

  getCapabilities(): CLICapabilities {
    return {
      supportsThreads: true,
      supportsModes: ['smart', 'rush'], // Opus 4.5, Haiku 4.5
      maxConcurrentAgents: 12, // Match Auto-Claude limit
      supportsPermissions: true,
    };
  }

  /**
   * Build prompt with context injection from memory system
   */
  private buildPromptWithContext(
    prompt: string,
    context?: ContextData
  ): string {
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
   * Map amp message types to our standard types
   */
  private mapMessageType(ampType: string): StreamMessage['type'] {
    switch (ampType) {
      case 'system':
        return 'system';
      case 'assistant':
        return 'assistant';
      case 'result':
        return 'result';
      case 'error':
        return 'error';
      default:
        return 'tool'; // Default to tool for unknown types
    }
  }

  private generateThreadId(): string {
    return `amp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
