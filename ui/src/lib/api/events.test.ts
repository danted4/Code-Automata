import { describe, expect, it } from 'vitest';
import { followEvents } from './events';
import type { ServerEvent } from './types/ServerEvent';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe('followEvents', () => {
  it('parses messages split across chunks, skips comments and bad JSON', async () => {
    const seen: ServerEvent[] = [];
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls > 1) return new Promise<Response>(() => {}); // stay "connecting" afterwards
      return new Response(
        streamOf([
          'data: {"type":"hel',
          'lo"}\n\n: keep-alive\n\n',
          'data: not json\n\n',
          'data: {"type":"lagged","missed":3}\r\n\r\n',
        ]),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const stop = followEvents('/repo', { onEvent: (e) => seen.push(e) });
      await new Promise((r) => setTimeout(r, 50));
      stop();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual([{ type: 'hello' }, { type: 'lagged', missed: 3 }]);
  });
});
