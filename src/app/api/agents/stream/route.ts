/**
 * Agent Stream API Route (Server-Sent Events)
 *
 * Streams agent logs in real-time to the browser
 */

import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import { getTaskIdForThread } from '@/lib/agents/thread-index';
import { getAgentStreamLogPath } from '@/lib/agents/stream-log';
import { taskPersistence } from '@/lib/tasks/persistence';

export async function GET(req: NextRequest) {
  const threadId = req.nextUrl.searchParams.get('threadId');

  if (!threadId) {
    return new Response('Missing threadId', { status: 400 });
  }

  let taskId = await getTaskIdForThread(threadId);
  if (!taskId) {
    // Fallback: find task by assignedAgent (helps if index is missing)
    const tasks = await taskPersistence.listTasks().catch(() => []);
    taskId = tasks.find((t) => t.assignedAgent === threadId)?.id || null;
  }
  if (!taskId) return new Response('Agent not found', { status: 404 });
  const logPath = getAgentStreamLogPath(taskId, threadId);

  const encoder = new TextEncoder();

  // Create readable stream for SSE
  const stream = new ReadableStream({
    async start(controller) {
      let fileOffset = 0;
      let carry = '';
      let ready = false;

      // Send initial connection message
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
      );

      // Stream logs every 150ms by tailing the per-thread NDJSON file
      const interval = setInterval(async () => {
        try {
          // Wait briefly for file to appear on first connect
          if (!ready) {
            try {
              await fs.stat(logPath);
              ready = true;
            } catch {
              return;
            }
          }

          const stat = await fs.stat(logPath);
          const size = stat.size;
          if (size <= fileOffset) return;

          const toRead = Math.min(size - fileOffset, 64 * 1024);
          const fh = await fs.open(logPath, 'r');
          const buf = Buffer.alloc(toRead);
          const { bytesRead } = await fh.read(buf, 0, toRead, fileOffset);
          await fh.close();

          if (bytesRead <= 0) return;
          fileOffset += bytesRead;

          const chunk = carry + buf.toString('utf-8', 0, bytesRead);
          const lines = chunk.split('\n');
          carry = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            let obj: any;
            try {
              obj = JSON.parse(line);
            } catch {
              continue;
            }

            // Status lines are sent as a special message and then we close
            if (obj && obj.type === 'status') {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
              controller.close();
              clearInterval(interval);
              return;
            }

            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          }
        } catch {
          controller.close();
          clearInterval(interval);
        }
      }, 150);

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
