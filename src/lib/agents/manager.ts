/**
 * Agent Manager
 *
 * Manages a pool of concurrent AI agent sessions
 * Supports up to 12 concurrent agents (matching Auto-Claude limit)
 */

import { CLIAdapter } from '@/lib/cli/base';
import { CLIFactory, CLIProvider } from '@/lib/cli/factory';
import { ContextData } from '@/lib/cli/base';

export interface AgentSession {
  taskId: string;
  threadId: string;
  status: 'running' | 'completed' | 'error' | 'stopped';
  startedAt: number;
  completedAt?: number;
  logs: AgentLog[];
  error?: string;
}

export interface AgentLog {
  timestamp: number;
  type: string;
  content: unknown;
}

export interface AgentOptions {
  workingDir: string;
  context?: ContextData;
  onComplete?: (result: AgentResult) => void | Promise<void>;
}

export interface AgentResult {
  success: boolean;
  output: string;
  error?: string;
}

export class AgentManager {
  private cli: CLIAdapter;
  private activeAgents = new Map<string, AgentSession>();
  private maxConcurrent = 12;

  constructor(cliProvider: CLIProvider = 'mock') {
    this.cli = CLIFactory.create(cliProvider);
  }

  /**
   * Initialize the agent manager
   */
  async initialize(config: {
    apiKey: string;
    cwd: string;
    mode?: 'smart' | 'rush';
  }): Promise<void> {
    await this.cli.initialize({
      apiKey: config.apiKey,
      cwd: config.cwd,
      mode: config.mode || 'smart',
    });
  }

  /**
   * Start a new agent on a task
   */
  async startAgent(
    taskId: string,
    prompt: string,
    options: AgentOptions
  ): Promise<string> {
    // Check concurrent limit
    if (this.activeAgents.size >= this.maxConcurrent) {
      throw new Error(
        `Maximum ${this.maxConcurrent} concurrent agents reached`
      );
    }

    // Create thread
    const threadId = await this.cli.createThread(options.workingDir);

    // Initialize session
    const session: AgentSession = {
      taskId,
      threadId,
      status: 'running',
      startedAt: Date.now(),
      logs: [],
    };

    this.activeAgents.set(threadId, session);

    // Start execution in background (don't await)
    this.executeAgent(threadId, prompt, options.context, options.onComplete).catch((error) => {
      session.status = 'error';
      session.error = error instanceof Error ? error.message : 'Unknown error';
      session.completedAt = Date.now();

      // Call completion callback with error
      if (options.onComplete) {
        Promise.resolve(options.onComplete({
          success: false,
          output: '',
          error: error instanceof Error ? error.message : 'Unknown error',
        })).catch(console.error);
      }
    });

    return threadId;
  }

  /**
   * Stop a running agent
   */
  async stopAgent(threadId: string): Promise<void> {
    const session = this.activeAgents.get(threadId);
    if (!session) {
      throw new Error(`Agent ${threadId} not found`);
    }

    await this.cli.stopThread(threadId);

    session.status = 'stopped';
    session.completedAt = Date.now();

    // Remove from active agents to free up slot
    this.activeAgents.delete(threadId);
  }

  /**
   * Get agent session status
   */
  getAgentStatus(threadId: string): AgentSession | undefined {
    return this.activeAgents.get(threadId);
  }

  /**
   * Get all active agents
   */
  listActiveAgents(): AgentSession[] {
    return Array.from(this.activeAgents.values());
  }

  /**
   * Get agents for a specific task
   */
  getAgentsForTask(taskId: string): AgentSession[] {
    return Array.from(this.activeAgents.values()).filter(
      (session) => session.taskId === taskId
    );
  }

  /**
   * Execute agent in background
   */
  private async executeAgent(
    threadId: string,
    prompt: string,
    context?: ContextData,
    onComplete?: (result: AgentResult) => void | Promise<void>
  ): Promise<void> {
    const session = this.activeAgents.get(threadId);
    if (!session) return;

    let output = '';

    try {
      // Execute with CLI adapter
      for await (const message of this.cli.execute({
        prompt,
        threadId,
        context,
      })) {
        // Store log
        session.logs.push({
          timestamp: message.timestamp,
          type: message.type,
          content: message.data,
        });

        // Collect output from assistant messages
        if (message.type === 'assistant' && message.data && typeof message.data === 'object') {
          const data = message.data as Record<string, unknown>;
          if (data.message && typeof data.message === 'string') {
            output += data.message + '\n';
          }
        }

        // Check if completed
        if (message.type === 'result') {
          session.status = 'completed';
          session.completedAt = Date.now();

          // Remove from active agents to free up slot
          this.activeAgents.delete(threadId);

          // Call completion callback
          if (onComplete) {
            await onComplete({
              success: true,
              output: output.trim(),
              error: undefined,
            });
          }
          break;
        }

        // Check if error
        if (message.type === 'error') {
          session.status = 'error';
          session.error = JSON.stringify(message.data);
          session.completedAt = Date.now();

          // Remove from active agents to free up slot
          this.activeAgents.delete(threadId);

          // Call completion callback with error
          if (onComplete) {
            await onComplete({
              success: false,
              output: output.trim(),
              error: JSON.stringify(message.data),
            });
          }
          break;
        }
      }
    } catch (error) {
      session.status = 'error';
      session.error = error instanceof Error ? error.message : 'Unknown error';
      session.completedAt = Date.now();

      // Remove from active agents to free up slot
      this.activeAgents.delete(threadId);

      // Call completion callback with error
      if (onComplete) {
        await onComplete({
          success: false,
          output: output.trim(),
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  /**
   * Get CLI capabilities
   */
  getCapabilities() {
    return this.cli.getCapabilities();
  }
}
