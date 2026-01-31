/**
 * CLI Adapters API
 *
 * Returns available CLI adapters and their configuration schemas
 */

import { NextResponse } from 'next/server';
import { CLIFactory } from '@/lib/cli/factory';
import { CursorAdapter } from '@/lib/cli/cursor';

export async function GET() {
  try {
    let adapters = CLIFactory.getAvailableAdapters();

    // Hide Mock CLI in packaged/production app (Electron in-process)
    if (process.versions?.electron) {
      adapters = adapters.filter((a) => a.name !== 'mock');
    }

    // Prefetch Cursor models to warm the cache before getConfigSchema() is called
    const prefetchPromises = adapters.map(async (adapter) => {
      if (adapter.name === 'cursor') {
        try {
          const cursorAdapter = new CursorAdapter();
          // Prefetch models (warms cache)
          await (
            cursorAdapter as unknown as { fetchAvailableModels: () => Promise<void> }
          ).fetchAvailableModels();
        } catch (err) {
          console.warn('[API] Failed to prefetch Cursor models:', err);
        }
      }
    });

    await Promise.all(prefetchPromises);

    // Get config schema for each adapter (now Cursor will have cached models)
    const adaptersWithSchemas = adapters
      .map((adapter) => {
        try {
          const adapterInstance = CLIFactory.create(adapter.name as 'amp' | 'mock' | 'cursor');
          return {
            name: adapter.name,
            displayName: adapter.displayName,
            configSchema: adapterInstance.getConfigSchema(),
          };
        } catch (err) {
          console.error(`Failed to load adapter ${adapter.name}:`, err);
          return null;
        }
      })
      .filter(Boolean);

    return NextResponse.json(adaptersWithSchemas);
  } catch (_error) {
    return NextResponse.json({ error: 'Failed to load CLI adapters' }, { status: 500 });
  }
}
