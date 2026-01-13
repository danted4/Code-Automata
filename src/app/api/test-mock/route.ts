/**
 * Test API Route - Mock Adapter
 *
 * This endpoint tests the Mock CLI adapter without using any credits.
 * Visit: http://localhost:3000/api/test-mock
 */

import { NextResponse } from 'next/server';
import { CLIFactory } from '@/lib/cli/factory';

export async function GET() {
  try {
    // Create Mock adapter (NO API CALLS - COST FREE)
    const mockAdapter = CLIFactory.create('mock');

    // Initialize
    await mockAdapter.initialize({
      apiKey: 'mock-key',
      cwd: process.cwd(),
      mode: 'smart',
    });

    // Get capabilities
    const capabilities = mockAdapter.getCapabilities();

    // Execute a test prompt
    const messages: unknown[] = [];
    for await (const message of mockAdapter.execute({
      prompt: 'Create a simple function that adds two numbers',
    })) {
      messages.push(message);
    }

    return NextResponse.json({
      success: true,
      adapter: 'mock',
      capabilities,
      messages,
      totalMessages: messages.length,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
