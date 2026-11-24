/**
 * Requests to the Code-Automata server (`crates/server`).
 *
 * Where the server is: the desktop app (Phase 5) sets `window.__CODE_AUTOMATA__` to its URL and
 * launch token before the UI loads. In `yarn dev` and `yarn preview` there is no such object: the
 * Vite proxy forwards `/api` to `ca-server` and adds the token itself, so the browser never
 * holds it.
 *
 * Every request names the open project with the percent-encoded `X-Project-Path` header.
 */

import { useProjectStore } from '@/store/project-store';

declare global {
  interface Window {
    __CODE_AUTOMATA__?: { baseUrl: string; token: string };
  }
}

/** An error response from the server: `{ error, code }` with its HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function connection(): { baseUrl: string; token: string | null } {
  const injected = typeof window !== 'undefined' ? window.__CODE_AUTOMATA__ : undefined;
  return injected ? injected : { baseUrl: '', token: null };
}

export type RequestOptions = {
  body?: unknown;
  /** The project; defaults to the open one. `null` sends no project header. */
  project?: string | null;
  signal?: AbortSignal;
};

/** Headers every request carries: auth when the app injected a token, and the project. */
export function requestHeaders(project: string | null | undefined): Headers {
  const headers = new Headers();
  const { token } = connection();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const path = project === undefined ? useProjectStore.getState().projectPath : project;
  if (path) headers.set('X-Project-Path', encodeURIComponent(path));
  return headers;
}

export function apiUrl(path: string): string {
  return `${connection().baseUrl}${path}`;
}

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const headers = requestHeaders(options.project);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { method, headers, body, signal: options.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'unreachable', 'Cannot reach the Code-Automata server.');
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON: reported below with the status.
  }
  if (!response.ok) {
    const err = json as { error?: unknown; code?: unknown } | undefined;
    throw new ApiError(
      response.status,
      typeof err?.code === 'string' ? err.code : 'http_error',
      typeof err?.error === 'string' ? err.error : `HTTP ${response.status}`
    );
  }
  return json as T;
}

/** A message for a toast from anything a request can throw. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
