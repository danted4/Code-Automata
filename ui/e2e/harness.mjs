/**
 * End-to-end harness: the built UI (`vite preview`), a real `ca-server` with the mock agent on a
 * throwaway git repository, and Chrome driven by agent-browser.
 *
 * Needs `cargo build` (ca-server and mock-agent in target/debug, or CA_TARGET_DIR), `yarn build`,
 * and agent-browser on PATH. Each test starts its own server with its own mock scenario; the
 * preview proxies /api to it.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(UI, '..');
const BIN = process.env.CA_TARGET_DIR ?? path.join(ROOT, 'target', 'debug');
const EXE = process.platform === 'win32' ? '.exe' : '';
export const ARTIFACTS = path.join(UI, 'e2e', 'artifacts');

const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 7878);
const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT ?? 4173);
const TOKEN = 'e2e-token';
const SESSION = 'ca-e2e';
export const BASE = `http://localhost:${PREVIEW_PORT}`;

/** Terminal colour codes: ESC [ ... m. */
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- processes -------------------------------------------------------------------------------

function waitForLine(child, pattern, what, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let seen = '';
    const done = (settle, value) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      settle(value);
    };
    const timer = setTimeout(
      () => done(reject, new Error(`${what} did not start in time:\n${seen}`)),
      timeoutMs
    );
    const onData = (chunk) => {
      // Colour codes (CI forces colour on) would split "localhost:4173".
      seen += chunk.toString().replace(ANSI_COLOUR, '');
      if (pattern.test(seen)) done(resolve, seen);
    };
    const onExit = (code) => done(reject, new Error(`${what} exited with ${code}:\n${seen}`));
    // A missing or non-executable binary: an error event, not an exit.
    const onError = (e) => done(reject, new Error(`${what} could not start: ${e.message}`));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

/** Start `child` and wait for its ready line; on any failure it is stopped before rethrowing. */
async function started(child, pattern, what) {
  try {
    await waitForLine(child, pattern, what);
  } catch (e) {
    await stopChild(child);
    throw e;
  }
}

function stopChild(child) {
  // Already gone: exited (exitCode) or killed by a signal (signalCode).
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  });
}

/** `vite preview` on the built UI, proxying /api to the test server. */
export async function startPreview() {
  if (!existsSync(path.join(UI, 'dist', 'index.html'))) {
    throw new Error('ui/dist is missing: run `yarn build` first');
  }
  const vite = path.join(UI, 'node_modules', '.bin', 'vite');
  const child = spawn(vite, ['preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: UI,
    env: {
      ...process.env,
      NO_COLOR: '1',
      CA_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
      CA_SERVER_TOKEN: TOKEN,
    },
  });
  await started(child, /localhost:\d+/, 'vite preview');
  return { stop: () => stopChild(child) };
}

/** A `ca-server` with the mock agent playing `rules` for every mock task. */
export async function startServer(rules) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ca-e2e-scenario-'));
  const scenario = path.join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      rules,
      steps: [{ result: { isError: true, text: 'no mock rule matched this prompt' } }],
    })
  );
  const server = path.join(BIN, `ca-server${EXE}`);
  if (!existsSync(server)) throw new Error(`${server} is missing: run \`cargo build\` first`);
  const child = spawn(
    server,
    [
      '--port',
      String(SERVER_PORT),
      '--token',
      TOKEN,
      '--allow-mock',
      '--mock-scenario',
      scenario,
      // A rate-limited task resumes moments after its reset.
      '--wake-grace-ms',
      '200',
    ],
    { env: { ...process.env, CODE_AUTOMATA_MOCK_AGENT: path.join(BIN, `mock-agent${EXE}`) } }
  );
  await started(child, /listening on/, 'ca-server');
  return { scenarioDir: dir, stop: () => stopChild(child) };
}

/** A throwaway repository with one commit, short timeouts and the given settings. */
export function makeRepo(settings = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ca-e2e-repo-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'E2E');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# e2e\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  mkdirSync(path.join(dir, '.code-automata'), { recursive: true });
  writeFileSync(
    path.join(dir, '.code-automata', 'settings.json'),
    JSON.stringify({
      schema: 1,
      checks: [],
      timeouts: { idleMinutes: 1, totalMinutes: 3 },
      ...settings,
    })
  );
  return { path: dir, git };
}

/**
 * A throwaway workspace: a plain folder holding one repository per name, each with a local bare
 * remote and the "other" host (push only), no checks, and short timeouts.
 */
export function makeWorkspace(names) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ca-e2e-ws-')));
  const remotes = realpathSync(mkdtempSync(path.join(tmpdir(), 'ca-e2e-remotes-')));
  const repos = {};
  for (const name of names) {
    const repo = path.join(dir, name);
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'E2E');
    git('config', 'user.email', 'e2e@example.com');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const remote = path.join(remotes, `${name}.git`);
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
    git('remote', 'add', 'origin', remote);
    repos[name] = { checks: [], pullRequestHost: 'other' };
  }
  mkdirSync(path.join(dir, '.code-automata'), { recursive: true });
  writeFileSync(
    path.join(dir, '.code-automata', 'settings.json'),
    JSON.stringify({ schema: 1, timeouts: { idleMinutes: 1, totalMinutes: 3 }, repos })
  );
  const remoteGit = (name, ...args) =>
    execFileSync('git', args, { cwd: path.join(remotes, `${name}.git`), encoding: 'utf8' }).trim();
  return { path: dir, remoteGit };
}

// --- browser ---------------------------------------------------------------------------------

/** One agent-browser command in the e2e session; returns its output. */
export function ab(...args) {
  return execFileSync('agent-browser', ['--session', SESSION, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  }).trim();
}

/** Evaluate a JavaScript expression in the page and return its value. */
export function js(expression) {
  const out = ab('eval', expression);
  // The value comes back as JSON, objects spread over several lines.
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

const sel = (testid) => `[data-testid="${testid}"]`;

export function click(testid) {
  // A DOM click: agent-browser's pointer click can land on an overlay or a moving card.
  const ok = js(
    `(() => { const el = document.querySelector('${sel(testid)}'); if (!el) return false; el.scrollIntoView({block: 'center'}); el.click(); return true; })()`
  );
  if (!ok) throw new Error(`no element ${sel(testid)}`);
}

export function fill(testid, text) {
  ab('fill', sel(testid), text);
}

export function exists(testid) {
  return js(`!!document.querySelector('${sel(testid)}')`);
}

/** Poll `probe` (run in Node) until `accept` holds; returns the last value. */
export async function until(what, probe, accept = Boolean, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = probe();
      if (accept(last)) return last;
    } catch (e) {
      last = e instanceof Error ? e.message : e;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

/** Open the app with `project` already chosen (the open-project dialog has its own test). */
export async function openProject(project) {
  ab('open', `${BASE}/`);
  // Start clean (theme included), whatever an earlier or aborted run left behind.
  js('localStorage.clear() || true');
  js(
    `localStorage.setItem('code-automata-project', JSON.stringify({ state: { projectPath: ${JSON.stringify(project)}, recentPaths: [] }, version: 0 })) || true`
  );
  ab('open', `${BASE}/`);
  await until('the board', () => exists('kanban-column-planning'));
}

/** What the board shows for the card titled `title`, or null. */
export function card(title) {
  return js(`(() => {
    const c = Array.from(document.querySelectorAll('[data-testid^="task-card-"]'))
      .find((c) => c.querySelector('[data-testid="task-title"]')?.innerText === ${JSON.stringify(title)});
    if (!c) return null;
    const q = (id) => c.querySelector('[data-testid="' + id + '"]');
    return {
      id: c.dataset.testid.replace('task-card-', ''),
      phase: c.closest('[data-testid^="kanban-column-"]').dataset.testid.replace('kanban-column-', ''),
      status: c.dataset.status,
      badge: q('task-status')?.innerText ?? null,
      action: c.querySelector('[data-testid^="task-action-"]')?.dataset.testid.replace('task-action-', '') ?? null,
      rework: q('task-rework')?.innerText ?? null,
      error: q('task-error')?.innerText ?? null,
    };
  })()`);
}

/** Wait until the card titled `title` matches `accept`. */
export function untilCard(title, what, accept, timeoutMs) {
  return until(
    `"${title}": ${what}`,
    () => card(title),
    (c) => !!c && accept(c),
    timeoutMs
  );
}

/** Create a mock task through the new-task dialog. */
export async function createTask(title, { description = '', approval = false } = {}) {
  click('new-task-button');
  // Shown once the agents are loaded and the default chosen.
  await until('the agent choice', () => exists('agent-same'), Boolean, 60_000);
  // One agent for every phase (the default is one per phase when Claude Code is ready).
  sameAgentForAllPhases();
  await until('the agent list', () => exists('agent-option-mock'), Boolean, 60_000);
  fill('new-task-title', title);
  if (description) fill('new-task-description', description);
  click('agent-option-mock');
  if (approval) click('new-task-plan-approval');
  click('new-task-submit');
  await until('the new task card', () => card(title));
  await until('the dialog to close', () => !exists('new-task-modal'));
}

/** Tick "Use the same agent for all phases" unless it is ticked. */
export function sameAgentForAllPhases() {
  js(
    `(() => { const c = document.querySelector('[data-testid="agent-same"]'); if (c && c.getAttribute('data-state') !== 'checked') c.click(); return true; })()`
  );
}

/** Choose `value` in the native select `testid`, the way a user's pick reaches React. */
export function select(testid, value) {
  js(
    `(() => { const s = document.querySelector('[data-testid="${testid}"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
  );
}

export function cardAction(title, action) {
  const c = card(title);
  if (!c) throw new Error(`no card "${title}"`);
  js(
    `document.querySelector('[data-testid="task-card-${c.id}"] [data-testid="task-action-${action}"]').click() || true`
  );
}

export function openDetails(title) {
  const c = card(title);
  if (!c) throw new Error(`no card "${title}"`);
  js(
    `document.querySelector('[data-testid="task-card-${c.id}"] [data-testid="task-details-button"]').click() || true`
  );
}

export function closeDialog() {
  ab('press', 'Escape');
}

export function screenshot(name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  try {
    ab('screenshot', path.join(ARTIFACTS, `${name.replace(/[^a-z0-9-]+/gi, '-')}.png`));
  } catch {
    // Best effort.
  }
}

export function closeBrowser() {
  try {
    ab('close');
  } catch {
    // Already closed.
  }
}

// --- mock scenarios --------------------------------------------------------------------------

export const PLAN =
  '# Plan\n\n## Overview\nWrite the greeting files.\n\n## Implementation Steps\n1. one.txt\n2. two.txt';

export const structured = (value) => ({ result: { text: 'done', structured: value } });

/**
 * Rules for a task with `devs` dev subtasks and one QA subtask; `extra` rules come first, so they
 * can make one step fail, hang or go slowly.
 */
export function rules(devs, extra = []) {
  const subtasks = Array.from({ length: devs }, (_, i) => ({
    id: `dev-${i + 1}`,
    kind: 'dev',
    title: `Step ${i + 1}`,
    detail: `Write file ${i + 1}`,
  }));
  subtasks.push({ id: 'qa-1', kind: 'qa', title: 'Verify', detail: 'Check the files' });
  const out = [
    ...extra,
    {
      whenPrompt: 'You were interrupted before finishing',
      steps: [{ text: 'resuming' }, structured({ summary: 'resumed', handoff: 'resumed' })],
    },
    {
      whenPrompt: '# Planning: clarifying questions',
      steps: [
        structured({
          questions: [
            { id: 'q1', text: 'Which greeting?', options: ['hello', 'hi'], required: true },
            { id: 'q2', text: 'Anything else?', required: false },
          ],
        }),
      ],
    },
    {
      whenPrompt: 'Revise the implementation plan',
      steps: [structured({ plan: `${PLAN}\n3. REVISED step` })],
    },
    { whenPrompt: '# Planning: implementation plan', steps: [structured({ plan: PLAN })] },
    { whenPrompt: 'Break the approved plan', steps: [structured({ subtasks })] },
    {
      whenPrompt: '(rework-',
      steps: [
        { text: 'fixing' },
        { write: { path: 'fix.txt', content: 'fix' } },
        structured({ summary: 'fixed', handoff: 'fixed' }),
      ],
    },
    {
      whenPrompt: '(qa-1)',
      steps: [structured({ passed: true, summary: 'all good', findings: [] })],
    },
  ];
  for (let i = 1; i <= devs; i++) {
    out.push({
      whenPrompt: `(dev-${i})`,
      steps: [
        { text: `writing file ${i}` },
        { write: { path: `file-${i}.txt`, content: `${i}` } },
        structured({ summary: `wrote file ${i}`, handoff: `file-${i}.txt exists` }),
      ],
    });
  }
  return out;
}

/** A rule that plays `steps` the first time `whenPrompt` matches, then falls through. */
export function once(whenPrompt, steps) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ca-e2e-once-'));
  return { whenPrompt, onceFile: path.join(dir, 'played'), steps };
}
