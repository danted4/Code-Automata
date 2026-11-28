/**
 * The README's demo: a scripted run of the real UI against a real `ca-server` and the mock agent,
 * recorded to video with screenshots along the way. Headless at 1920×1080, so nothing of the
 * desktop shows. Run with `yarn demo` after `cargo build` and `yarn build`.
 *
 * Writes `e2e/artifacts/demo/demo.mp4` and the screenshots next to it (`board.png` is the one the
 * README's hero image is made from).
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ARTIFACTS,
  BASE,
  ab,
  card,
  cardAction,
  click,
  closeBrowser,
  closeDialog,
  exists,
  fill,
  js,
  makeRepo,
  openDetails,
  openProject,
  rules,
  sameAgentForAllPhases,
  startPreview,
  startServer,
  structured,
  until,
  untilCard,
} from './harness.mjs';

const OUT = path.join(ARTIFACTS, 'demo');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** A dev step that looks like work: a read, a pause, a write, then the answer. */
function devRule(i, ms) {
  return {
    whenPrompt: `(dev-${i})`,
    steps: [
      { text: `Looking at what step ${i} needs` },
      {
        tool: {
          name: 'Read',
          input: { file_path: `src/list.ts` },
          output: 'export function list() { … }',
          durationMs: Math.round(ms / 3),
        },
      },
      { write: { path: `src/step-${i}.ts`, content: `// step ${i}\n` } },
      { sleepMs: Math.round((ms * 2) / 3) },
      structured({
        summary: `Did step ${i}`,
        handoff: `step-${i}.ts exists`,
        learnings: i === 1 ? ['Run the tests with yarn test --run'] : [],
      }),
    ],
  };
}

function shot(name) {
  ab('screenshot', path.join(OUT, `${name}.png`));
}

async function newTask(title, description, { approval = false } = {}) {
  click('new-task-button');
  await until('the agent choice', () => exists('agent-same'), Boolean, 60_000);
  await pause(1200);
  sameAgentForAllPhases();
  await until('the agent list', () => exists('agent-option-mock'));
  fill('new-task-title', title);
  fill('new-task-description', description);
  click('agent-option-mock');
  if (approval) click('new-task-plan-approval');
  await pause(800);
  click('new-task-submit');
  await until(`"${title}"`, () => card(title));
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const preview = await startPreview();
  // A plain project name in the sidebar instead of the temporary folder's.
  const made = makeRepo({ checks: [] });
  const repo = { path: path.join(mkdtempSync(path.join(tmpdir(), 'ca-demo-')), 'acme-web') };
  renameSync(made.path, repo.path);
  const slowQa = {
    whenPrompt: '(qa-1)',
    steps: [
      { text: 'Running the tests' },
      {
        tool: {
          name: 'Bash',
          input: { command: 'yarn test --run' },
          output: '24 passed',
          durationMs: 3000,
        },
      },
      structured({ passed: true, summary: 'Tests pass; the list pages.', findings: [] }),
    ],
  };
  const server = await startServer(
    rules(3, [devRule(1, 5000), devRule(2, 6000), devRule(3, 5000), slowQa])
  );
  try {
    ab('set', 'viewport', '1920', '1080');
    await openProject(repo.path);
    ab('record', 'start', path.join(OUT, 'demo.mp4'));
    await pause(1500);

    // A task with plan review: the planner asks, the user answers and approves.
    click('new-task-button');
    await until('the agent choice', () => exists('agent-same'), Boolean, 60_000);
    await pause(2500);
    shot('new-task-agents');
    closeDialog();
    await pause(800);
    await newTask('Paginate the task list', 'Page the list endpoint at 50 items, with a cursor.', {
      approval: true,
    });
    await untilCard('Paginate the task list', 'questions', (c) => c.status === 'needs_answers');
    await pause(1200);
    cardAction('Paginate the task list', 'answer');
    await until('the questions', () => exists('questions-modal'));
    await pause(1500);
    click('question-option-q1-0');
    await pause(800);
    click('questions-next');
    fill('question-note-q2', 'Keep the page size configurable.');
    await pause(800);
    click('questions-submit');
    await untilCard(
      'Paginate the task list',
      'plan ready',
      (c) => c.status === 'needs_plan_review'
    );
    cardAction('Paginate the task list', 'review_plan');
    await until('the plan', () => exists('plan-content'));
    await pause(2500);
    shot('plan-review');
    click('plan-approve');

    // More tasks, so the board fills up.
    await pause(2500);
    await newTask('Dark mode toggle', 'Add a dark mode switch to the header, remembered per user.');
    await pause(4000);
    await newTask('Retry failed uploads', 'Retry an upload up to three times with backoff.');
    await pause(3000);
    await newTask('Audit log export', 'Export the audit log as CSV from the admin page.', {
      approval: true,
    });

    await untilCard(
      'Retry failed uploads',
      'working',
      (c) => c.phase === 'in_progress' && c.status === 'working',
      60_000
    );
    // Long enough for the "Task created" toast to go.
    await pause(5000);
    shot('board');

    openDetails('Dark mode toggle');
    await until('the details', () => exists('task-detail-modal'));
    await pause(3000);
    shot('task-details');
    closeDialog();

    await untilCard(
      'Paginate the task list',
      'in review',
      (c) => c.phase === 'human_review',
      120_000
    );
    await pause(1500);
    cardAction('Paginate the task list', 'human_review');
    await until('the review', () => exists('human-review-modal'));
    await pause(3000);
    shot('human-review');
    closeDialog();
    await pause(1500);

    ab('open', `${BASE}/settings`);
    await until('the settings', () => exists('settings-mcp'));
    js(
      `document.querySelector('[data-testid="settings-mcp"]').closest('section').scrollIntoView({ block: 'start' }) || true`
    );
    await pause(2500);
    shot('settings-mcp-memory');
    ab('open', `${BASE}/`);
    await until('the board', () => exists('kanban-column-planning'));
    await pause(3000);
    ab('record', 'stop');
    console.log(`demo written to ${OUT}`);
  } finally {
    await server.stop();
    await preview.stop();
    closeBrowser();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
