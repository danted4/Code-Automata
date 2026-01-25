/**
 * CLI Adapters API
 *
 * Returns available CLI adapters and their configuration schemas
 */

import { NextResponse } from 'next/server';
import { CLIFactory } from '@/lib/cli/factory';

export async function GET() {
  try {
    const adapters = CLIFactory.getAvailableAdapters();

    // Get config schema for each adapter
    const adaptersWithSchemas = adapters.map(adapter => {
      try {
        const adapterInstance = CLIFactory.create(adapter.name as any);
        return {
          name: adapter.name,
          displayName: adapter.displayName,
          configSchema: adapterInstance.getConfigSchema(),
        };
      } catch (error) {
        console.error(`Failed to load adapter ${adapter.name}:`, error);
        return null;
      }
    }).filter(Boolean);

    return NextResponse.json(adaptersWithSchemas);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to load CLI adapters' },
      { status: 500 }
    );
  }
}
