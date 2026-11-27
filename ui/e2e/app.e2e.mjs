/**
 * The whole app in a browser: the built UI, a real ca-server and the mock agent. Run with
 * `yarn e2e` after `cargo build` and `yarn build`. See harness.mjs.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import {
  BASE,
  ab,
  card,
  cardAction,
  click,
  closeBrowser,
  closeDialog,
  createTask,
  exists,
  fill,
  js,
  makeRepo,
  makeWorkspace,
  once,
  openDetails,
  openProject,
  rules,
  screenshot,
  startPreview,
  startServer,
  until,
  untilCard,
} from './harness.mjs';

let preview;
let server;

before(async () => {
  preview = await startPreview();
});

after(async () => {
  await server?.stop();
  await preview?.stop();
  closeBrowser();
});

afterEach(async (t) => {
  if (t.passed === false || process.env.E2E_SCREENSHOTS) screenshot(t.name);
  await server?.stop();
  server = null;
});

const inReview = (c) => c.phase === 'human_review' && c.status === 'in_review';

test('1. open a project, create a task, run it to review, mark it done', async () => {
  const repo = makeRepo();
  server = await startServer(rules(2));
  ab('open', `${BASE}/`);
  js('localStorage.clear() || true');
  ab('open', `${BASE}/`);
  await until(
    'the open-project dialog',
    () =>
      exists('open-project-modal') ||
      js(`!!document.querySelector('input[placeholder*="projects"]')`)
  );
  ab('fill', 'input[placeholder*="projects"]', repo.path);
  js(
    `Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Open').click() || true`
  );
  await until(
    'the board',
    () => exists('kanban-column-planning') && !js(`!!document.querySelector('[role=dialog]')`)
  );

  await createTask('Greeting files', { description: 'Write two files' });
  const done = await untilCard('Greeting files', 'in review', inReview);
  assert.equal(done.badge, 'Review');

  cardAction('Greeting files', 'human_review');
  await until('the review dialog', () => exists('human-review-modal'));
  assert.match(js(`document.querySelector('[data-testid="review-checks"]').innerText`), /Passed/);
  click('review-mark-done');
  await untilCard('Greeting files', 'done', (c) => c.phase === 'done');
});

test('2. plan approval: answer questions, revise, approve', async () => {
  const repo = makeRepo();
  server = await startServer(rules(1));
  await openProject(repo.path);
  await createTask('Planned', { approval: true });

  await untilCard('Planned', 'questions', (c) => c.status === 'needs_answers');
  cardAction('Planned', 'answer');
  await until('the questions dialog', () => exists('questions-modal'));
  click('question-option-q1-0');
  click('questions-next');
  fill('question-note-q2', 'Keep it short');
  click('questions-submit');

  await untilCard('Planned', 'plan ready', (c) => c.status === 'needs_plan_review');
  cardAction('Planned', 'review_plan');
  await until('the plan', () => exists('plan-content'));
  click('plan-request-changes');
  fill('plan-feedback', 'Add a step');
  click('plan-send-feedback');
  await until('the revised plan', () =>
    js(
      `document.querySelector('[data-testid="plan-content"]')?.innerText.includes('REVISED') && !document.querySelector('[data-testid="plan-approve"]').disabled`
    )
  );
  click('plan-approve');
  await untilCard('Planned', 'in review', inReview);
});

test('3. pause during a dev subtask, then resume on the same one', async () => {
  const repo = makeRepo();
  const extra = [once('(dev-1)', [{ text: 'working slowly' }, { sleepMs: 60_000 }])];
  server = await startServer(rules(2, extra));
  await openProject(repo.path);
  await createTask('Pausable');
  await untilCard(
    'Pausable',
    'dev-1 running',
    (c) => c.phase === 'in_progress' && c.status === 'working'
  );
  cardAction('Pausable', 'pause');
  const paused = await untilCard('Pausable', 'paused', (c) => c.status === 'paused');
  assert.equal(paused.phase, 'in_progress');
  assert.equal(paused.action, 'resume');

  cardAction('Pausable', 'resume');
  await untilCard('Pausable', 'in review', inReview);

  openDetails('Pausable');
  click('task-detail-tab-runs');
  const states = await until(
    'the run list',
    () =>
      js(
        `Array.from(document.querySelectorAll('[data-testid^="run-state-"]')).map((e) => e.dataset.state)`
      ),
    (s) => Array.isArray(s) && s.includes('stopped')
  );
  assert.ok(states.includes('completed'), JSON.stringify(states));
  closeDialog();
});

test('4. a failing subtask shows why, and Retry reruns it', async () => {
  const repo = makeRepo();
  const extra = [once('(dev-1)', [{ result: { isError: true, text: 'compile error in file 1' } }])];
  server = await startServer(rules(1, extra));
  await openProject(repo.path);
  await createTask('Flaky');
  const failed = await untilCard('Flaky', 'failed', (c) => c.status === 'failed');
  assert.match(failed.error, /compile error in file 1/);
  assert.equal(failed.action, 'retry');
  cardAction('Flaky', 'retry');
  await untilCard('Flaky', 'in review', inReview);
});

test('5. skip a paused subtask', async () => {
  const repo = makeRepo();
  const extra = [once('(dev-1)', [{ text: 'stuck' }, { hang: true }])];
  server = await startServer(rules(2, extra));
  await openProject(repo.path);
  await createTask('Skippy');
  await untilCard(
    'Skippy',
    'dev-1 running',
    (c) => c.phase === 'in_progress' && c.status === 'working'
  );
  cardAction('Skippy', 'pause');
  await untilCard('Skippy', 'paused', (c) => c.status === 'paused');

  openDetails('Skippy');
  click('task-detail-tab-subtasks');
  await until('the skip button', () => exists('subtask-skip-dev-1'));
  click('subtask-skip-dev-1');
  click('subtask-skip-confirm');
  await until(
    'dev-1 skipped',
    () => js(`document.querySelector('[data-testid="subtask-row-dev-1"]')?.dataset.status`),
    (s) => s === 'skipped'
  );
  closeDialog();
  // With the paused subtask skipped, the task continues from the next step.
  const next = await untilCard(
    'Skippy',
    'ready to go on',
    (c) => c.action === 'resume' || c.action === 'start'
  );
  cardAction('Skippy', next.action);
  await untilCard('Skippy', 'in review', inReview);
});

test('6. failing checks start a rework round, then pass', async () => {
  // The check passes once the rework subtask has written fix.txt.
  const repo = makeRepo({ checks: [{ name: 'fixed', command: 'test -f fix.txt' }] });
  // A slow rework step, so the card can be seen in its rework round.
  const slowRework = {
    whenPrompt: '(rework-',
    steps: [
      { text: 'fixing' },
      { sleepMs: 3000 },
      { write: { path: 'fix.txt', content: 'fix' } },
      { result: { text: 'done', structured: { summary: 'fixed', handoff: 'fixed' } } },
    ],
  };
  server = await startServer(rules(1, [slowRework]));
  await openProject(repo.path);
  await createTask('Needs a fix');
  await untilCard('Needs a fix', 'reworking', (c) => c.rework === 'Reworking (1/2)');
  await untilCard('Needs a fix', 'in review', inReview);
  openDetails('Needs a fix');
  click('task-detail-tab-review');
  await until(
    'passing checks',
    () =>
      js(`document.querySelector('[data-testid="task-detail-checks-result"]')?.innerText ?? ''`),
    (s) => /pass/i.test(s)
  );
  closeDialog();
});

test('7. worktrees: orphans deleted, a task worktree only once the task is done', async () => {
  const repo = makeRepo();
  repo.git(
    'worktree',
    'add',
    '-q',
    '-b',
    'code-automata/orphan-1',
    path.join(repo.path, '.code-automata', 'worktrees', 'orphan-1')
  );
  server = await startServer(rules(1));
  await openProject(repo.path);
  await createTask('Has a worktree');
  await untilCard('Has a worktree', 'in review', inReview);
  const id = card('Has a worktree').id;

  ab('open', `${BASE}/worktrees`);
  await until(
    'both worktrees',
    () => exists(`worktree-card-${id}`) && exists('worktree-card-orphan-1')
  );
  assert.equal(exists(`worktree-delete-${id}`), false, 'a task worktree is not deletable here');
  click('worktree-delete-orphan-1');
  click('worktree-delete-confirm');
  await until('the orphan gone', () => !exists('worktree-card-orphan-1'));
  assert.equal(existsSync(path.join(repo.path, '.code-automata', 'worktrees', 'orphan-1')), false);

  // Once the task is done, its worktree can be removed; the task stays.
  ab('open', `${BASE}/`);
  await untilCard('Has a worktree', 'in review', inReview);
  cardAction('Has a worktree', 'human_review');
  await until('the review dialog', () => exists('human-review-modal'));
  click('review-mark-done');
  await untilCard('Has a worktree', 'done', (c) => c.phase === 'done');
  ab('open', `${BASE}/worktrees`);
  await until('the remove button', () => exists(`worktree-delete-${id}`));
  click(`worktree-delete-${id}`);
  click('worktree-delete-confirm');
  await until('the worktree gone', () => !exists(`worktree-card-${id}`));
  assert.equal(existsSync(path.join(repo.path, '.code-automata', 'worktrees', id)), false);
  ab('open', `${BASE}/`);
  await untilCard('Has a worktree', 'still done', (c) => c.phase === 'done');
});

test('8. settings: custom checks and a prompt template are saved', async () => {
  const repo = makeRepo();
  server = await startServer(rules(1));
  await openProject(repo.path);
  ab('open', `${BASE}/settings`);
  await until('the settings', () => exists('settings-checks-mode-custom'));
  click('settings-checks-mode-custom');
  await until('a check row', () => exists('settings-check-name-0'));
  fill('settings-check-name-0', 'lint');
  fill('settings-check-command-0', 'echo ok');
  fill('settings-prompt-plan', 'Write a short plan for {{title}}.');
  click('settings-save');
  const file = path.join(repo.path, '.code-automata', 'settings.json');
  const saved = await until(
    'settings.json',
    () => JSON.parse(readFileSync(file, 'utf8')),
    (s) => s.checks?.[0]?.name === 'lint'
  );
  assert.equal(saved.checks[0].command, 'echo ok');
  assert.equal(saved.prompts?.plan, 'Write a short plan for {{title}}.');
  ab('reload');
  await until(
    'the saved values',
    () => js(`document.querySelector('[data-testid="settings-check-command-0"]')?.value`),
    (v) => v === 'echo ok'
  );
});

test('9. a task keeps running while another project is open', async () => {
  const a = makeRepo();
  const b = makeRepo();
  // Everything for the task titled "Long A" hangs, so it is still running when we come back.
  server = await startServer(
    rules(1, [{ whenPrompt: 'Long A', steps: [{ text: 'thinking' }, { hang: true }] }])
  );
  await openProject(a.path);
  await createTask('Long A');
  await untilCard('Long A', 'running', (c) => c.status === 'working');

  await openProject(b.path);
  assert.equal(card('Long A'), null, 'project B shows only its own tasks');
  await createTask('Quick B');
  await untilCard('Quick B', 'in review', inReview);

  await openProject(a.path);
  await untilCard('Long A', 'still running', (c) => c.status === 'working');
  cardAction('Long A', 'pause');
  await untilCard('Long A', 'paused', (c) => c.status === 'paused');
});

test('10. the theme can be switched and is remembered', async () => {
  const repo = makeRepo();
  server = await startServer(rules(1));
  await openProject(repo.path);
  const before = js(
    `getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()`
  );
  // The switcher is a Radix select; drive it through the store the switcher writes to.
  ab('find', 'role', 'combobox', 'click');
  await until(
    'the theme options',
    () => js(`document.querySelectorAll('[role=option]').length`),
    (n) => n >= 2
  );
  js(
    `Array.from(document.querySelectorAll('[role=option]')).find((o) => /light/i.test(o.innerText)).click() || true`
  );
  const after = await until(
    'a new background',
    () =>
      js(
        `getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()`
      ),
    (v) => v && v !== before
  );
  ab('reload');
  await until(
    'the theme kept after reload',
    () =>
      js(
        `getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim()`
      ),
    (v) => v === after
  );
});

test('11. a workspace task changes two repositories and pushes each', async () => {
  const ws = makeWorkspace(['api', 'web']);
  const both = {
    whenPrompt: '(dev-1)',
    steps: [
      { write: { path: 'api/a.txt', content: 'a' } },
      { write: { path: 'web/w.txt', content: 'w' } },
      { result: { text: 'done', structured: { summary: 'wrote both', handoff: '' } } },
    ],
  };
  server = await startServer(rules(1, [both]));
  await openProject(ws.path);
  await createTask('Across repos');
  const done = await untilCard('Across repos', 'in review', inReview);
  assert.equal(
    js(
      `document.querySelector('[data-testid="task-card-${done.id}"] [data-testid="task-repos"]')?.innerText.replace(/\\s+/g, ' ').trim()`
    ),
    'api web'
  );

  cardAction('Across repos', 'human_review');
  await until('the review dialog', () => exists('human-review-modal'));
  const states = () =>
    js(
      `Array.from(document.querySelectorAll('[data-testid^="review-pr-row-"]')).map((r) => r.dataset.testid.replace('review-pr-row-', '') + ':' + r.dataset.state).join(' ')`
    );
  assert.equal(states(), 'api:create web:create');
  click('review-create-prs');
  await until('both pushed', states, (s) => s === 'api:current web:current');
  const branch = `refs/heads/code-automata/${done.id}`;
  assert.match(ws.remoteGit('api', 'ls-tree', '-r', '--name-only', branch), /a\.txt/);
  assert.match(ws.remoteGit('web', 'ls-tree', '-r', '--name-only', branch), /w\.txt/);
  assert.ok(!exists('review-create-prs'), 'nothing left to push');
});
