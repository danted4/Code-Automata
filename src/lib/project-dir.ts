/**
 * Project Directory Helper
 *
 * Resolves the project directory from request headers or query params.
 * Used by API routes to determine which project to operate on.
 */

import { NextRequest } from 'next/server';
import path from 'path';
import fs from 'fs';

/**
 * Get project directory from request. Reads X-Project-Path header or projectPath query param.
 * Validates path exists and is a directory. Falls back to process.cwd() if invalid or missing.
 */
export async function getProjectDir(request?: NextRequest): Promise<string> {
  let rawPath: string | null = null;

  if (request) {
    rawPath =
      request.headers.get('X-Project-Path') ?? request.nextUrl.searchParams.get('projectPath');
  }

  if (!rawPath || typeof rawPath !== 'string') {
    return process.cwd();
  }

  const trimmed = rawPath.trim();
  if (!trimmed) {
    return process.cwd();
  }

  try {
    const resolved = path.resolve(trimmed);

    // Reject paths with .. traversal (path.resolve normalizes, but check for safety)
    if (resolved.includes('..')) {
      return process.cwd();
    }

    // Must be absolute
    if (!path.isAbsolute(resolved)) {
      return process.cwd();
    }

    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) {
      return process.cwd();
    }

    return resolved;
  } catch {
    return process.cwd();
  }
}
