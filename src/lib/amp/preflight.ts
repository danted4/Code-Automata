/**
 * Amp preflight (local dev)
 *
 * Goals:
 * - Require Amp CLI presence (installed via npm -g, discovered via `which amp`)
 * - Prefer `amp login` (CLI auth) over `AMP_API_KEY`
 * - Provide structured readiness + user instructions for UI and API routes
 *
 * Notes:
 * - This is best-effort and intentionally avoids returning any sensitive tokens.
 * - We may hydrate `process.env.AMP_API_KEY` from locally stored CLI config if found,
 *   but we never include the token in the returned result.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AmpAuthSource = 'cli_login' | 'env' | 'missing';

export interface AmpPreflightResult {
  ampCliPath: string | null;
  authSource: AmpAuthSource;
  canRunAmp: boolean;
  instructions: string[];
  diagnostics: {
    hasEnvApiKey: boolean;
    cliLoginDetected: boolean;
    cliLoginDetectionMethod: 'amp_whoami' | 'config_files' | 'none';
    hydratedEnvApiKey: boolean;
    detectedConfigDirs: string[];
  };
}

function withTimeoutMs<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function whichAmp(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, ['amp'], { timeout: 1500 });
    const resolved = stdout.trim().split('\n')[0]?.trim();
    return resolved ? resolved : null;
  } catch {
    return null;
  }
}

async function tryAmpWhoami(ampCliPath: string): Promise<boolean> {
  try {
    // Best-effort: this should be fast and non-interactive
    await withTimeoutMs(execFileAsync(ampCliPath, ['whoami'], { timeout: 1500 }), 1750);
    return true;
  } catch {
    return false;
  }
}

function extractLikelyTokenFromJson(obj: unknown): string | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [obj];

  const tokenKeyRegex = /^(amp_)?(api[_-]?key|token|access[_-]?token)$/i;

  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (Array.isArray(cur)) {
      for (const v of cur) queue.push(v);
      continue;
    }

    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (tokenKeyRegex.test(k) && typeof v === 'string') {
        const candidate = v.trim();
        // Avoid very short values that are unlikely to be real tokens
        if (candidate.length >= 20) return candidate;
      }
      queue.push(v);
    }
  }

  return null;
}

async function tryHydrateAmpApiKeyFromCliConfig(
  configDirs: string[]
): Promise<{ hydrated: boolean }> {
  if (process.env.AMP_API_KEY) {
    return { hydrated: false };
  }

  const candidateFileNames = [
    'config.json',
    'settings.json',
    'credentials.json',
    'auth.json',
    '.auth.json',
    'session.json',
  ];

  for (const dir of configDirs) {
    // 1) Try well-known filenames first
    for (const name of candidateFileNames) {
      const p = path.join(dir, name);
      if (!(await fileExists(p))) continue;
      try {
        const raw = await fs.readFile(p, 'utf-8');
        const parsed = JSON.parse(raw);
        const token = extractLikelyTokenFromJson(parsed);
        if (token) {
          process.env.AMP_API_KEY = token;
          return { hydrated: true };
        }
      } catch {
        // ignore
      }
    }

    // 2) Best-effort scan small json-ish files in the dir
    const entries = await listDirSafe(dir);
    for (const entry of entries) {
      const p = path.join(dir, entry);
      if (!/\.(json|txt)$/i.test(entry)) continue;
      try {
        const stat = await fs.stat(p);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        const raw = await fs.readFile(p, 'utf-8');
        // Try JSON parse; if it fails, skip (don’t regex-scan arbitrary text)
        const parsed = JSON.parse(raw);
        const token = extractLikelyTokenFromJson(parsed);
        if (token) {
          process.env.AMP_API_KEY = token;
          return { hydrated: true };
        }
      } catch {
        // ignore
      }
    }
  }

  return { hydrated: false };
}

function getCandidateAmpConfigDirs(): string[] {
  const home = os.homedir();
  const candidates = [
    // Linux/macOS typical
    path.join(home, '.config', 'amp'),
    path.join(home, '.config', 'sourcegraph', 'amp'),
    // macOS app support variants
    path.join(home, 'Library', 'Application Support', 'amp'),
    path.join(home, 'Library', 'Application Support', 'Sourcegraph', 'amp'),
    // fallback
    path.join(home, '.amp'),
  ];
  return candidates;
}

export async function ampPreflight(): Promise<AmpPreflightResult> {
  const instructions: string[] = [];

  const ampCliPath = await whichAmp();
  const hasEnvApiKey = !!process.env.AMP_API_KEY;

  if (!ampCliPath) {
    instructions.push('Install the Amp CLI so `which amp` returns a path.');
    instructions.push('After installing, restart `yarn dev` so the server picks it up.');
  }

  // Detect CLI login using a mix of (1) command and (2) config dir presence
  const detectedConfigDirs = getCandidateAmpConfigDirs().filter((d) => {
    // synchronous filter is ok; we’ll check existence async below
    return true;
  });

  const existingConfigDirs: string[] = [];
  await Promise.all(
    detectedConfigDirs.map(async (d) => {
      if (await fileExists(d)) existingConfigDirs.push(d);
    })
  );

  let cliLoginDetected = false;
  let cliLoginDetectionMethod: AmpPreflightResult['diagnostics']['cliLoginDetectionMethod'] =
    'none';

  if (ampCliPath) {
    const whoamiOk = await tryAmpWhoami(ampCliPath);
    if (whoamiOk) {
      cliLoginDetected = true;
      cliLoginDetectionMethod = 'amp_whoami';
    } else if (existingConfigDirs.length > 0) {
      // Best-effort: presence of config dir often indicates login/config has occurred
      const hasAnyFiles = (
        await Promise.all(existingConfigDirs.map(async (d) => (await listDirSafe(d)).length))
      ).some((n) => n > 0);
      if (hasAnyFiles) {
        cliLoginDetected = true;
        cliLoginDetectionMethod = 'config_files';
      }
    }
  }

  // Prefer CLI login, but fall back to env key.
  // Also: require the CLI even for SDK runs (local-dev constraint).
  const authSource: AmpAuthSource = cliLoginDetected
    ? 'cli_login'
    : hasEnvApiKey
      ? 'env'
      : 'missing';

  let hydratedEnvApiKey = false;
  if (authSource === 'cli_login' && !hasEnvApiKey) {
    // Best-effort: if the SDK still expects AMP_API_KEY, try to populate it from local config.
    const res = await tryHydrateAmpApiKeyFromCliConfig(existingConfigDirs);
    hydratedEnvApiKey = res.hydrated;
  }

  const canRunAmp = !!ampCliPath && (cliLoginDetected || !!process.env.AMP_API_KEY);

  if (!cliLoginDetected) {
    instructions.push('Run `amp login` to authenticate the CLI (preferred).');
  }
  if (!process.env.AMP_API_KEY) {
    instructions.push('Alternatively, set `AMP_API_KEY` in your environment.');
  }
  if (!canRunAmp) {
    instructions.push('After fixing auth/install, refresh this page to re-check readiness.');
  }

  return {
    ampCliPath,
    authSource,
    canRunAmp,
    instructions,
    diagnostics: {
      hasEnvApiKey,
      cliLoginDetected,
      cliLoginDetectionMethod,
      hydratedEnvApiKey,
      detectedConfigDirs: existingConfigDirs,
    },
  };
}

