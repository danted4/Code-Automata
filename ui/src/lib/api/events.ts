/**
 * The project's event stream (`GET /api/events`, Server-Sent Events), read with `fetch` so it
 * carries the same headers as every other request. Reconnects on its own; the server's `hello`
 * after each (re)connect is the cue to reload the task list.
 */

import { apiUrl, requestHeaders } from './client';
import type { ServerEvent } from './types/ServerEvent';

export type StreamState = 'connecting' | 'open' | 'closed';

export type StreamHandlers = {
  onEvent: (event: ServerEvent) => void;
  onState?: (state: StreamState) => void;
};

const RETRY_MS = [500, 1000, 2000, 5000];

/** Follow `project`'s events until the returned function is called. */
export function followEvents(project: string, handlers: StreamHandlers): () => void {
  const abort = new AbortController();
  void run(project, handlers, abort.signal);
  return () => abort.abort();
}

async function run(project: string, handlers: StreamHandlers, signal: AbortSignal) {
  let failures = 0;
  while (!signal.aborted) {
    handlers.onState?.('connecting');
    try {
      const response = await fetch(apiUrl('/api/events'), {
        headers: requestHeaders(project),
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      failures = 0;
      handlers.onState?.('open');
      await readMessages(response.body, signal, handlers.onEvent);
    } catch {
      if (signal.aborted) break;
    }
    handlers.onState?.('closed');
    if (signal.aborted) break;
    const wait = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)];
    failures += 1;
    await sleep(wait, signal);
  }
}

/** Split the stream into SSE messages and hand each `data:` payload over as JSON. */
async function readMessages(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: ServerEvent) => void
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = message
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) {
          try {
            onEvent(JSON.parse(data) as ServerEvent);
          } catch {
            // A malformed message is skipped; the next one is independent.
          }
        }
        end = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
