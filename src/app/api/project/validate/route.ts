/**
 * Project Validate API Route
 *
 * Validates that a project path exists, is a directory, and is a git repository.
 * Used by Open Project modal before saving selection.
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

export async function GET(req: NextRequest) {
  try {
    const rawPath = req.nextUrl.searchParams.get('path');
    if (!rawPath || typeof rawPath !== 'string') {
      return NextResponse.json({ valid: false, error: 'Path is required' }, { status: 400 });
    }

    const trimmed = rawPath.trim();
    if (!trimmed) {
      return NextResponse.json({ valid: false, error: 'Path cannot be empty' }, { status: 400 });
    }

    const resolved = path.resolve(trimmed);

    // Reject paths with .. traversal
    if (resolved.includes('..')) {
      return NextResponse.json({ valid: false, error: 'Invalid path' }, { status: 400 });
    }

    if (!path.isAbsolute(resolved)) {
      return NextResponse.json({ valid: false, error: 'Path must be absolute' }, { status: 400 });
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return NextResponse.json({ valid: false, error: 'Path is not a directory' }, { status: 400 });
    }

    // Check if it's a git repository
    try {
      execSync('git rev-parse --show-toplevel', {
        cwd: resolved,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return NextResponse.json(
        { valid: false, error: 'Path is not a git repository' },
        { status: 400 }
      );
    }

    return NextResponse.json({ valid: true });
  } catch (error) {
    return NextResponse.json(
      {
        valid: false,
        error: error instanceof Error ? error.message : 'Validation failed',
      },
      { status: 500 }
    );
  }
}
