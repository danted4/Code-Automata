/**
 * Agent Stream API Route (Server-Sent Events)
 *
 * Streams agent logs in real-time to the browser
 */

import { NextRequest } from 'next/server';
import { agentManager } from '@/lib/agents/singleton';

export async function GET(req: NextRequest) {
  const threadId = req.nextUrl.searchParams.get('threadId');

  if (!threadId) {
    return new Response('Missing threadId', { status: 400 });
  }

  const session = agentManager.getAgentStatus(threadId);
  if (!session) {
    return new Response('Agent not found', { status: 404 });
  }

  const encoder = new TextEncoder();

  // Create readable stream for SSE
  const stream = new ReadableStream({
    async start(controller) {
      let lastSentIndex = 0;

      // Send initial connection message
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
      );

      // Stream logs every 100ms
      const interval = setInterval(() => {
        const currentSession = agentManager.getAgentStatus(threadId);
        if (!currentSession) {
          controller.close();
          clearInterval(interval);
          return;
        }

        // Send new logs since last check
        const newLogs = currentSession.logs.slice(lastSentIndex);
        newLogs.forEach((log) => {
          const data = JSON.stringify(log);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        });
        lastSentIndex = currentSession.logs.length;

        // Check if session completed/error/stopped
        if (currentSession.status !== 'running') {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'status',
                status: currentSession.status,
                error: currentSession.error,
              })}\n\n`
            )
          );
          controller.close();
          clearInterval(interval);
        }
      }, 100); // Check every 100ms

      // Cleanup on connection close
      req.signal.addEventListener('abort', () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
