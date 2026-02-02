/**
 * CLI Factory
 *
 * Factory pattern to create CLI adapters.
 * Makes it easy to swap between amp, Cursor, and other CLIs in the future.
 */

import { CLIAdapter } from './base';
import { AmpAdapter } from './amp';
import { MockCLIAdapter } from './mock';
import { CursorAdapter } from './cursor';

export type CLIProvider = 'amp' | 'mock' | 'cursor';

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
      case 'cursor':
        return new CursorAdapter();
      default:
        throw new Error(`Unknown CLI provider: ${provider}`);
    }
  }

  /**
   * Get available providers (order: Cursor first, Amp second, Mock last)
   */
  static getAvailableProviders(): CLIProvider[] {
    return ['cursor', 'amp', 'mock'];
  }

  /**
   * Check if a provider is available
   *
   * Note: Returns true if provider is recognized, actual availability
   * (CLI installed, authenticated) is checked via preflight during execution
   */
  static isProviderAvailable(provider: string): provider is CLIProvider {
    // All known providers are considered "available"
    // Actual runtime checks (binary exists, auth OK) happen in preflight
    return ['amp', 'mock', 'cursor'].includes(provider as CLIProvider);
  }

  /**
   * Get available adapters with their metadata
   * Used for displaying CLI options in UI
   */
  static getAvailableAdapters(): Array<{ name: string; displayName: string }> {
    const providers = this.getAvailableProviders();
    return providers.map((provider) => {
      const adapter = this.create(provider);
      return {
        name: adapter.name,
        displayName: adapter.displayName,
      };
    });
  }
}
