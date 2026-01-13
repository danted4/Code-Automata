/**
 * Base CLI Adapter Interface
 *
 * This abstract interface defines the contract for all CLI adapters,
 * enabling the modular architecture where amp can be swapped for other CLIs.
 */

export interface CLIAdapter {
  /**
   * Initialize the CLI adapter with configuration
   */
  initialize(config: CLIConfig): Promise<void>;

  /**
   * Execute a task with streaming response
   * Returns an async iterable of stream messages
   */
  execute(request: ExecuteRequest): AsyncIterable<StreamMessage>;

  /**
   * Create a new thread for isolated execution
   * @returns Thread ID
   */
  createThread(workingDir: string): Promise<string>;

  /**
   * Resume an existing thread
   */
  resumeThread(threadId: string): Promise<void>;

  /**
   * Stop a running thread
   */
  stopThread(threadId: string): Promise<void>;

  /**
   * Get the capabilities of this CLI adapter
   */
  getCapabilities(): CLICapabilities;
}

export interface CLIConfig {
  apiKey: string;
  cwd: string;
  mode?: 'smart' | 'rush'; // smart = Opus 4.5, rush = Haiku 4.5
  logLevel?: 'debug' | 'info' | 'error';
  permissions?: PermissionRule[];
  maxConcurrentAgents?: number;
}

export interface ExecuteRequest {
  prompt: string;
  threadId?: string; // Optional: resume existing thread
  context?: ContextData; // Optional: injected memory context
  permissions?: PermissionRule[];
}

export interface StreamMessage {
  type: 'system' | 'assistant' | 'tool' | 'result' | 'error';
  timestamp: number;
  data: unknown;
  threadId: string;
}

export interface CLICapabilities {
  supportsThreads: boolean;
  supportsModes: string[];
  maxConcurrentAgents: number;
  supportsPermissions: boolean;
}

export interface PermissionRule {
  action: string;
  allowed: boolean;
}

export interface ContextData {
  patterns?: Pattern[];
  gotchas?: Gotcha[];
  history?: HistoryEntry[];
}

export interface Pattern {
  category: string;
  description: string;
  example?: string;
  addedAt: number;
}

export interface Gotcha {
  issue: string;
  solution: string;
  context?: string;
  addedAt: number;
}

export interface HistoryEntry {
  taskId: string;
  phase: string;
  success: boolean;
  duration: number;
  timestamp: number;
}
