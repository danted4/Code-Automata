/**
 * The README's demo: a scripted run of the real UI against a real `ca-server`, recorded to video
 * with screenshots along the way. Headless at 1920×1080, so nothing of the desktop shows. Run with
 * `yarn demo` after `cargo build` and `yarn build`.
 *
 * The story: the project is Code-Automata itself, and its tasks are 3.2's features. The server
 * runs with `--demo-as claude`: the agent list is the production one and Claude Code's tasks are
 * played by the mock agent from the rules below, so no model is called.
 *
 * Writes `e2e/artifacts/demo/demo.mp4` and the screenshots next to it (`board.png` is the one the
 * README's hero image is made from). The project lives in a neutral folder, removed afterwards.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  once,
  openDetails,
  openProject,
  startPreview,
  startServer,
  structured,
  until,
  untilCard,
} from './harness.mjs';

const OUT = path.join(ARTIFACTS, 'demo');
const HOME = '/Users/Shared/code-automata-demo';
const PROJECT = path.join(HOME, 'code-automata');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const MARK = {
  questions: '# Planning: clarifying questions',
  plan: '# Planning: implementation plan',
  subtasks: 'Break the approved plan',
};

/** A small repository that looks like the project. */
function makeProject() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: PROJECT, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Code-Automata demo');
  git('config', 'user.email', 'demo@example.com');
  git('config', 'commit.gpgsign', 'false');
  const files = {
    'README.md': '# Code-Automata\n\nAI coding agents on a Kanban board.\n',
    'Cargo.toml': '[workspace]\nmembers = ["crates/core", "crates/server"]\n',
    'crates/core/src/lib.rs': 'pub mod agent;\npub mod engine;\n',
    'crates/core/src/agent/mod.rs': '//! Running agent CLIs.\n',
    'crates/core/src/engine/mod.rs': '//! The run engine.\n',
    'ui/src/components/kanban/task-card.tsx': 'export function TaskCard() {}\n',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(PROJECT, file)), { recursive: true });
    writeFileSync(path.join(PROJECT, file), text);
  }
  mkdirSync(path.join(PROJECT, '.code-automata'), { recursive: true });
  // The app's default timeouts; no check commands (the demo has none to run).
  writeFileSync(
    path.join(PROJECT, '.code-automata', 'settings.json'),
    JSON.stringify({ schema: 1, checks: [] })
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'Code-Automata 3.1.2');
}

/**
 * One task's story: its questions, plan, subtasks and the work of each subtask. Each rule matches
 * the task's title and the step, so tasks tell different stories.
 */
function story(title, { questions, plan, subtasks, work, qa, limitOn }) {
  const task = `**Task:** ${title}`;
  const rules = [];
  if (limitOn) {
    // The CLI hits its usage limit once here; every task on it waits for the reset.
    rules.push(
      once([task, `(${limitOn})`], [{ text: 'Reading the parser' }, { rateLimit: { inSecs: 15 } }])
    );
  }
  if (questions) {
    rules.push({ whenPrompt: [task, MARK.questions], steps: [structured({ questions })] });
  }
  rules.push({ whenPrompt: [task, MARK.plan], steps: [structured({ plan })] });
  rules.push({ whenPrompt: [task, MARK.subtasks], steps: [structured({ subtasks })] });
  for (const [id, w] of Object.entries(work)) {
    rules.push({
      whenPrompt: [task, `(${id})`],
      steps: [
        { text: w.say },
        { tool: { name: 'Read', input: { file_path: w.reads }, output: '…', durationMs: 1800 } },
        ...w.files.map((f) => ({ write: { path: f, content: `// ${w.say}\n` } })),
        { sleepMs: w.ms ?? 3500 },
        structured({ summary: w.summary, handoff: w.handoff ?? '', learnings: w.learnings ?? [] }),
      ],
    });
  }
  rules.push({
    whenPrompt: [task, '(qa-1)'],
    steps: [
      { text: 'Running the tests' },
      {
        tool: { name: 'Bash', input: { command: qa.command }, output: qa.output, durationMs: 3000 },
      },
      structured({ passed: true, summary: qa.summary, findings: [] }),
    ],
  });
  return rules;
}

const subtask = (id, title, detail, progressLabel) => ({
  id,
  kind: id.startsWith('qa') ? 'qa' : 'dev',
  title,
  detail,
  ...(progressLabel ? { progressLabel } : {}),
});

const PAUSE_TITLE = 'Pause tasks on usage limits';
const CODEX_TITLE = 'Add Codex as an agent';
const PHASES_TITLE = 'An agent per phase in the new-task dialog';
const MEMORY_TITLE = 'Keep what agents learn about a project';

const RULES = [
  ...story(PAUSE_TITLE, {
    questions: [
      {
        id: 'q1',
        text: 'When a CLI hits its usage limit, which tasks should wait?',
        options: ['Every task on that CLI', 'Only the task that hit it'],
        required: true,
      },
      { id: 'q2', text: 'Anything else the pause should do?', required: false },
    ],
    plan: `# Pause tasks on usage limits

## Overview
When a CLI reports that the subscription's usage limit was reached, the task waits for the reset instead of failing, and every other task on that CLI waits with it.

## Implementation Steps
1. Recognise each CLI's limit message and reset time (\`agent/limits.rs\`).
2. A shared limiter per CLI, and a wake-up per task at the reset (\`engine/limits.rs\`).
3. The card shows "Rate-limited, resumes at …" with Resume now.

## Testing
Recorded output of each CLI for the parsers; engine tests with the mock agent.`,
    subtasks: [
      subtask(
        'dev-1',
        'Detect usage limits',
        'Read the limit and its reset time from each CLI.',
        'Detecting limits'
      ),
      subtask(
        'dev-2',
        'Pause and wake per CLI',
        'Hold every task on a limited CLI; resume at the reset.',
        'Pausing per CLI'
      ),
      subtask(
        'dev-3',
        'Rate-limited card',
        'Badge, "Resumes at …" and Resume now.',
        'Updating the card'
      ),
      subtask('qa-1', 'Verify pause and resume', 'Run the engine tests; check the card.'),
    ],
    work: {
      'dev-1': {
        say: 'Adding the limit parser',
        reads: 'crates/core/src/agent/mod.rs',
        files: ['crates/core/src/agent/limits.rs'],
        summary: 'Parse each CLI’s usage-limit message and reset time.',
        handoff: 'limits::RateLimit carries the reset time and scope.',
        learnings: ['Run the engine tests with cargo test --test engine'],
      },
      'dev-2': {
        say: 'Adding the per-CLI limiter',
        reads: 'crates/core/src/engine/mod.rs',
        files: ['crates/core/src/engine/limits.rs'],
        summary: 'A shared limiter per CLI and a wake-up at the reset.',
        handoff: 'RunState::RateLimited with resetsAt.',
      },
      'dev-3': {
        say: 'Showing the wait on the card',
        reads: 'ui/src/components/kanban/task-card.tsx',
        files: ['ui/src/lib/task-view.ts'],
        summary: 'Rate-limited badge, "Resumes at …" and Resume now.',
        handoff: 'taskStatus gives rate_limited; the card offers Resume now.',
      },
    },
    qa: {
      command: 'cargo test --test engine',
      output: 'test result: ok. 46 passed',
      summary: 'A limited task waits, others on the CLI wait too, and all resume at the reset.',
    },
  }),
  ...story(CODEX_TITLE, {
    plan: `# Add Codex as an agent

## Overview
Run OpenAI's Codex CLI headless, like the other agents.

## Implementation Steps
1. Build \`codex exec --json\` with the prompt on stdin and the right sandbox per phase.
2. Turn its JSONL events into the app's events and its final turn into the answer.

## Testing
Codex's event format, recorded; the command line per phase.`,
    subtasks: [
      subtask(
        'dev-1',
        'Codex command line',
        'codex exec with the sandbox per phase.',
        'Building the command'
      ),
      subtask('dev-2', 'Parse Codex events', 'Items, turns and usage limits.', 'Parsing events'),
      subtask('qa-1', 'Check Codex runs', 'Command lines and parser tests.'),
    ],
    limitOn: 'dev-1',
    work: {
      'dev-1': {
        say: 'Writing the Codex adapter',
        reads: 'crates/core/src/agent/mod.rs',
        files: ['crates/core/src/agent/codex.rs'],
        summary: 'codex exec with read-only planning and full-access development.',
      },
      'dev-2': {
        say: 'Parsing Codex events',
        reads: 'crates/core/src/agent/codex.rs',
        files: ['crates/core/tests/fixtures/streams/codex-dev.ndjson'],
        summary: 'Items become events; turn.completed is the answer.',
      },
    },
    qa: {
      command: 'cargo test --test agent_parsers',
      output: 'test result: ok. 22 passed',
      summary: 'Codex runs parse.',
    },
  }),
  ...story(PHASES_TITLE, {
    plan: `# An agent per phase

## Overview
Pick the CLI and model for planning, development and QA separately.

## Implementation Steps
1. Task files name an agent per phase (schema 3).
2. Three rows in the new-task dialog, models from each CLI's list.

## Testing
Schema upgrade tests; the dialog's form logic.`,
    subtasks: [
      subtask(
        'dev-1',
        'Agents per phase in tasks',
        'Schema 3 with an agent per phase.',
        'Upgrading the schema'
      ),
      subtask(
        'dev-2',
        'Three rows in the dialog',
        'CLI and model per phase.',
        'Building the dialog'
      ),
      subtask('qa-1', 'Check the dialog', 'Form logic and an end-to-end run.'),
    ],
    work: {
      'dev-1': {
        say: 'Adding agents per phase',
        reads: 'crates/core/src/engine/mod.rs',
        files: ['crates/core/src/task.rs'],
        summary: 'Tasks name an agent per phase; older files upgrade on read.',
        ms: 5000,
      },
      'dev-2': {
        say: 'Building the phase rows',
        reads: 'ui/src/components/kanban/task-card.tsx',
        files: ['ui/src/components/tasks/agent-picker.tsx'],
        summary: 'Planning, Development and QA rows with model lists.',
        ms: 6000,
      },
    },
    qa: {
      command: 'yarn test --run',
      output: '150 passed',
      summary: 'The dialog creates per-phase tasks.',
    },
  }),
  ...story(MEMORY_TITLE, {
    questions: [
      {
        id: 'q1',
        text: 'Where should what agents learn be kept?',
        options: ['.code-automata/memory.md', 'A section of AGENTS.md'],
        required: true,
      },
    ],
    plan: '# Project memory\n\n## Overview\nKeep lasting facts agents learn.\n\n## Implementation Steps\n1. Append learnings.\n2. Give them to every prompt.',
    subtasks: [
      subtask('dev-1', 'Keep learnings', 'Append to memory.md.'),
      subtask('qa-1', 'Check memory', 'Prompts carry it.'),
    ],
    work: {
      'dev-1': {
        say: 'Keeping learnings',
        reads: 'crates/core/src/engine/mod.rs',
        files: ['crates/core/src/engine/memory.rs'],
        summary: 'Learnings kept.',
      },
    },
    qa: { command: 'cargo test', output: 'ok', summary: 'Memory reaches prompts.' },
  }),
  // After the usage limit, the interrupted subtask continues in its session.
  {
    whenPrompt: 'You were interrupted before finishing',
    steps: [
      { text: 'Picking up where I stopped' },
      { write: { path: 'crates/core/src/agent/codex.rs', content: '// codex adapter\n' } },
      { sleepMs: 2500 },
      structured({
        summary: 'codex exec with read-only planning and full-access development.',
        handoff: '',
      }),
    ],
  },
];

function shot(name) {
  ab('screenshot', path.join(OUT, `${name}.png`));
}

/** Create a task with the dialog's defaults: Claude Code with a model per phase. */
async function newTask(title, description, { approval = false } = {}) {
  click('new-task-button');
  await until('the agent rows', () => exists('agent-phases'), Boolean, 60_000);
  fill('new-task-title', title);
  fill('new-task-description', description);
  if (approval) click('new-task-plan-approval');
  await pause(900);
  click('new-task-submit');
  await until(`"${title}"`, () => card(title));
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  makeProject();
  const preview = await startPreview();
  const server = await startServer(RULES, ['--demo-as', 'claude']);
  try {
    ab('set', 'viewport', '1920', '1080');
    await openProject(PROJECT);
    ab('record', 'start', path.join(OUT, 'demo.mp4'));
    await pause(1500);

    // The first task: the dialog's agents per phase, plan review on.
    click('new-task-button');
    await until('the agent rows', () => exists('agent-phases'), Boolean, 60_000);
    fill('new-task-title', PAUSE_TITLE);
    fill(
      'new-task-description',
      'When a CLI hits its usage limit, wait for the reset instead of failing.'
    );
    click('new-task-plan-approval');
    await pause(2500);
    shot('new-task-agents');
    click('new-task-submit');
    await until('the card', () => card(PAUSE_TITLE));

    await untilCard(PAUSE_TITLE, 'questions', (c) => c.status === 'needs_answers');
    await pause(1200);
    cardAction(PAUSE_TITLE, 'answer');
    await until('the questions', () => exists('questions-modal'));
    await pause(2000);
    click('question-option-q1-0');
    await pause(900);
    click('questions-next');
    fill('question-note-q2', 'Resume on its own after a restart too.');
    await pause(1200);
    click('questions-submit');
    await untilCard(PAUSE_TITLE, 'plan ready', (c) => c.status === 'needs_plan_review');
    cardAction(PAUSE_TITLE, 'review_plan');
    await until('the plan', () => exists('plan-content'));
    // Long enough for the "Answers sent" toast to go.
    await pause(4500);
    shot('plan-review');
    click('plan-approve');

    // The rest of the release, so the board fills up.
    await pause(2000);
    await newTask(CODEX_TITLE, "Run OpenAI's Codex CLI headless, like the other agents.");
    await untilCard(CODEX_TITLE, 'rate-limited', (c) => c.status === 'rate_limited', 60_000);
    // Long enough for the "Task created" toast to go.
    await pause(4500);
    shot('rate-limited');
    await newTask(PHASES_TITLE, 'Choose the CLI and model for planning, development and QA.');
    await newTask(MEMORY_TITLE, 'Keep lasting facts agents learn and give them to later tasks.', {
      approval: true,
    });

    await untilCard(PHASES_TITLE, 'developing', (c) => c.phase === 'in_progress', 90_000);
    await untilCard(MEMORY_TITLE, 'questions', (c) => c.status === 'needs_answers', 60_000);
    await untilCard(
      CODEX_TITLE,
      'in review',
      (c) => c.phase === 'ai_review' || c.phase === 'human_review',
      90_000
    );
    // Long enough for the last toast to go.
    await pause(4500);
    shot('board');

    openDetails(PHASES_TITLE);
    await until('the details', () => exists('task-detail-modal'));
    await pause(3000);
    shot('task-details');
    closeDialog();

    await untilCard(PAUSE_TITLE, 'in review', (c) => c.phase === 'human_review', 120_000);
    await pause(1500);
    cardAction(PAUSE_TITLE, 'human_review');
    await until('the review', () => exists('human-review-modal'));
    await pause(3500);
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
    rmSync(HOME, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
