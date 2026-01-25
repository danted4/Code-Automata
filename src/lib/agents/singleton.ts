/**
 * Agent Manager Singleton
 *
 * Global instance of AgentManager for API routes to use
 * 
 * Adapter selection:
 * - If AMP_API_KEY env var is set → Use real Amp adapter
 * - Otherwise → Use mock adapter for testing
 */

import { AgentManager } from './manager';

// Determine which adapter to use based on environment
const hasApiKey = !!process.env.AMP_API_KEY;
const defaultProvider = hasApiKey ? 'amp' : 'mock';

// Create singleton instance
export const agentManager = new AgentManager(defaultProvider);

// Initialize with appropriate config
agentManager.initialize({
  apiKey: process.env.AMP_API_KEY || 'mock-key',
  cwd: process.cwd(),
  mode: 'smart',
});

// Helper to create a manager with specific provider
export function createAgentManager(provider: 'amp' | 'mock', apiKey?: string) {
  const manager = new AgentManager(provider);
  manager.initialize({
    apiKey: apiKey || process.env.AMP_API_KEY || 'mock-key',
    cwd: process.cwd(),
    mode: 'smart',
  });
  return manager;
}
