/**
 * API Client
 *
 * Centralized fetch wrapper that adds X-Project-Path header from the project store.
 * Use this instead of raw fetch() for all API calls that need project context.
 */

import { useProjectStore } from '@/store/project-store';

export type ApiFetchOptions = RequestInit & {
  projectPath?: string | null;
};

/**
 * Fetch with project path header. Reads projectPath from store if not provided.
 */
export async function apiFetch(
  url: string | URL,
  options: ApiFetchOptions = {}
): Promise<Response> {
  const { projectPath: explicitPath, ...fetchOptions } = options;
  const projectPath =
    explicitPath !== undefined ? explicitPath : useProjectStore.getState().projectPath;

  const headers = new Headers(fetchOptions.headers);
  if (projectPath) {
    headers.set('X-Project-Path', projectPath);
  }

  return fetch(url, {
    ...fetchOptions,
    headers,
  });
}

/**
 * Build URL with projectPath query param for EventSource (SSE).
 * EventSource does not support custom headers.
 */
export function buildStreamUrl(baseUrl: string, params: Record<string, string>): string {
  const projectPath = useProjectStore.getState().projectPath;
  const searchParams = new URLSearchParams(params);
  if (projectPath) {
    searchParams.set('projectPath', projectPath);
  }
  const query = searchParams.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}
