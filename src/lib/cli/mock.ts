/**
 * Mock CLI Adapter
 *
 * Simulates CLI responses without making actual API calls.
 * Use this for UI development and testing to conserve credits.
 */

import {
  CLIAdapter,
  CLIConfig,
  CLICapabilities,
  ExecuteRequest,
  StreamMessage,
} from './base';

export class MockCLIAdapter implements CLIAdapter {
  private config: CLIConfig | null = null;
  private activeThreads = new Map<string, MockThreadSession>();

  async initialize(config: CLIConfig): Promise<void> {
    this.config = config;
    console.log('[MockAdapter] Initialized with config:', {
      mode: config.mode,
      cwd: config.cwd,
    });
  }

  async *execute(request: ExecuteRequest): AsyncIterable<StreamMessage> {
    if (!this.config) {
      throw new Error('MockAdapter not initialized');
    }

    const threadId = request.threadId || this.generateThreadId();

    // Create or get thread session
    let session = this.activeThreads.get(threadId);
    if (!session) {
      session = {
        threadId,
        messages: [],
        startedAt: Date.now(),
      };
      this.activeThreads.set(threadId, session);
    }

    // Simulate system message
    yield {
      type: 'system',
      timestamp: Date.now(),
      data: {
        message: 'Mock agent initialized',
        tools: ['read_file', 'write_file', 'bash', 'search'],
        mode: this.config.mode || 'smart',
      },
      threadId,
    };

    // Simulate delay
    await this.delay(500);

    // Simulate assistant thinking
    yield {
      type: 'assistant',
      timestamp: Date.now(),
      data: {
        message: `[MOCK] Processing: "${request.prompt.substring(0, 50)}..."`,
        thinking: 'Analyzing the request and determining the best approach...',
      },
      threadId,
    };

    await this.delay(1000);

    // Simulate tool usage
    yield {
      type: 'tool',
      timestamp: Date.now(),
      data: {
        tool: 'search',
        parameters: { query: 'relevant code' },
        result: '[MOCK] Found 5 relevant files',
      },
      threadId,
    };

    await this.delay(800);

    // Simulate more assistant work
    yield {
      type: 'assistant',
      timestamp: Date.now(),
      data: {
        message: '[MOCK] I found the relevant code and am implementing the solution...',
      },
      threadId,
    };

    await this.delay(1200);

    // Simulate tool usage (file write)
    yield {
      type: 'tool',
      timestamp: Date.now(),
      data: {
        tool: 'write_file',
        parameters: { path: 'src/example.ts' },
        result: '[MOCK] File written successfully',
      },
      threadId,
    };

    await this.delay(500);

    // Simulate final result
    yield {
      type: 'result',
      timestamp: Date.now(),
      data: {
        success: true,
        message: '[MOCK] Task completed successfully!',
        summary: 'This is a simulated response from the Mock adapter. No real API calls were made.',
        filesModified: ['src/example.ts'],
        context: request.context ? 'Context was injected from memory' : undefined,
      },
      threadId,
    };

    // Store message in session
    session.messages.push({
      prompt: request.prompt,
      response: 'Mock response',
      timestamp: Date.now(),
    });
  }

  async createThread(workingDir: string): Promise<string> {
    const threadId = this.generateThreadId();
    console.log('[MockAdapter] Created thread:', threadId, 'in', workingDir);
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    console.log('[MockAdapter] Resuming thread:', threadId);
    // No-op for mock
  }

  async stopThread(threadId: string): Promise<void> {
    console.log('[MockAdapter] Stopping thread:', threadId);
    this.activeThreads.delete(threadId);
  }

  getCapabilities(): CLICapabilities {
    return {
      supportsThreads: true,
      supportsModes: ['smart', 'rush'],
      maxConcurrentAgents: 12,
      supportsPermissions: true,
    };
  }

  private generateThreadId(): string {
    return `mock-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

interface MockThreadSession {
  threadId: string;
  messages: Array<{
    prompt: string;
    response: string;
    timestamp: number;
  }>;
  startedAt: number;
}
