/**
 * Agent Manager Singleton
 *
 * Global instance of AgentManager for API routes to use
 */

import { AgentManager } from './manager';

// Create singleton instance with Mock adapter by default
// This uses NO credits for testing
export const agentManager = new AgentManager('mock');

// Initialize with default config
agentManager.initialize({
  apiKey: 'mock-key', // Will be replaced with real API key in settings
  cwd: process.cwd(),
  mode: 'smart',
});

// Helper to switch to real amp adapter (when user configures API key)
export async function switchToAmpAdapter(apiKey: string) {
  const ampManager = new AgentManager('amp');
  await ampManager.initialize({
    apiKey,
    cwd: process.cwd(),
    mode: 'smart',
  });
  return ampManager;
}
