/**
 * CLI Factory
 *
 * Factory pattern to create CLI adapters.
 * Makes it easy to swap between amp and other CLIs in the future.
 */

import { CLIAdapter } from './base';
import { AmpAdapter } from './amp';
import { MockCLIAdapter } from './mock';

export type CLIProvider = 'amp' | 'mock';
// Future providers can be added here:
// export type CLIProvider = 'amp' | 'mock' | 'aider' | 'cursor' | ...;

export class CLIFactory {
  /**
   * Create a CLI adapter instance based on the provider type
   */
  static create(provider: CLIProvider): CLIAdapter {
    switch (provider) {
      case 'amp':
        return new AmpAdapter();
      case 'mock':
        return new MockCLIAdapter();
      // Future implementations:
      // case 'aider':
      //   return new AiderAdapter();
      // case 'cursor':
      //   return new CursorAdapter();
      default:
        throw new Error(`Unknown CLI provider: ${provider}`);
    }
  }

  /**
   * Get available providers
   */
  static getAvailableProviders(): CLIProvider[] {
    return ['amp', 'mock'];
  }

  /**
   * Check if a provider is available
   */
  static isProviderAvailable(provider: string): provider is CLIProvider {
    return ['amp', 'mock'].includes(provider);
  }
}
