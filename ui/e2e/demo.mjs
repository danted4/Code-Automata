/**
 * The README's demo: a scripted run of the real UI against a real `ca-server`, recorded to video
 * with screenshots along the way. Headless at 1920×1080, so nothing of the desktop shows. Run with
 * `yarn demo` after `cargo build` and `yarn build`. macOS only: it owns
 * `/Users/Shared/code-automata-demo`, which it deletes at the start and at the end.
 *
 * The project is Code-Automata's own source at v3.1.2, and its tasks are 3.2's features. The
 * agents' answers are prepared: the server runs with `--demo-as claude`, so the agent list is the
 * production one and a test agent stands in for Claude Code, replaying the rules below. What the
 * agents read and search is the real 3.1.2 source, the files they write are 3.2's real versions
 * (so the Changes tab shows the real line counts), and the tests they report are 3.2's real test
 * names. No model is called.
 *
 * Writes `e2e/artifacts/demo/demo.mp4` and the screenshots next to it (`board.png` is the one the
 * README's hero image is made from).
 */

import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BEFORE = 'v3.1.2';
const AFTER = 'HEAD';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the project and what the agents see ------------------------------------------------------

function makeProject() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  execSync(`git archive ${BEFORE} -- . ':!docs/images' ':!ui/e2e' | tar -x -C "${PROJECT}"`, {
    cwd: REPO,
  });
  const git = (...args) => execFileSync('git', args, { cwd: PROJECT, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Code-Automata demo');
  git('config', 'user.email', 'demo@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'Release 3.1.2');
  mkdirSync(path.join(PROJECT, '.code-automata'), { recursive: true });
  // The app's default timeouts, and one quick check that really runs.
  writeFileSync(
    path.join(PROJECT, '.code-automata', 'settings.json'),
    JSON.stringify({
      schema: 1,
      checks: [{ name: 'No whitespace errors', command: 'git diff --check main' }],
    })
  );
}

const show = (ref, file) => {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};

/** A Read tool's output: lines of the 3.1.2 file, numbered. */
function readOut(file, from = 1, count = 18) {
  const lines = (show(BEFORE, file) ?? '').split('\n').slice(from - 1, from - 1 + count);
  return lines.map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n');
}

/** A Grep tool's output: real matches in the 3.1.2 source. */
function grepOut(pattern, paths) {
  try {
    const out = execFileSync('git', ['grep', '-n', '-e', pattern, BEFORE, '--', ...paths], {
      cwd: REPO,
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .filter(Boolean)
      .slice(0, 9)
      .map((l) => l.replace(`${BEFORE}:`, ''))
      .join('\n');
  } catch {
    return 'No matches found';
  }
}

/** The names of the tests in a 3.2 file, matching `filter`. */
function testNames(file, filter = /./) {
  const text = show(AFTER, file) ?? '';
  const names = [...text.matchAll(/#\[(?:tokio::)?test[^\]]*\]\s*(?:async\s+)?fn\s+(\w+)/g)]
    .map((m) => m[1])
    .filter((n) => filter.test(n));
  return names;
}

/** `cargo test` output for real 3.2 test names. */
function cargoOut(names, prefix = '') {
  const shown = names.slice(0, 14).map((n) => `test ${prefix}${n} ... ok`);
  const more = names.length > 14 ? [`… ${names.length - 14} more`] : [];
  return [
    `running ${names.length} tests`,
    ...shown,
    ...more,
    '',
    `test result: ok. ${names.length} passed; 0 failed; 0 ignored; 0 measured; finished in 2.31s`,
  ].join('\n');
}

/** Vitest output for a 3.2 test file. */
function vitestOut(file) {
  const count = ((show(AFTER, file) ?? '').match(/\b(it|test)\(/g) ?? []).length;
  return ` ✓ ${file.replace(/^ui\//, '')} (${count} tests)\n\n Test Files  1 passed (1)\n      Tests  ${count} passed (${count})`;
}

const tool = (name, input, output, durationMs = 1300) => ({
  tool: { name, input, output, durationMs },
});

// --- the agents' answers ----------------------------------------------------------------------

const MARK = {
  questions: '# Planning: clarifying questions',
  plan: '# Planning: implementation plan',
  subtasks: 'Break the approved plan',
};

/** A dev subtask's run: look around, write the real 3.2 files, run the tests. */
function devRun({
  intro,
  read,
  grep,
  think,
  doing,
  files,
  test,
  summary,
  handoff,
  learnings,
  wait = 0,
  linger = 0,
}) {
  const steps = [{ text: intro }];
  if (read) steps.push(tool('Read', { file_path: read[0] }, readOut(read[0], read[1] ?? 1), 1500));
  if (grep) steps.push(tool('Grep', { pattern: grep[0], path: grep[1][0] }, grepOut(...grep), 900));
  if (think) steps.push({ thinking: think });
  steps.push({ sleepMs: 2500 });
  steps.push({ text: doing });
  for (const f of files) {
    const content = show(AFTER, f);
    if (content === null) throw new Error(`${f} is not in ${AFTER}`);
    steps.push({ write: { path: f, content } }, { sleepMs: 1200 });
  }
  if (test) steps.push(tool('Bash', { command: test[0] }, test[1], 2600));
  if (linger) steps.push({ text: 'Tests pass.' }, { sleepMs: linger });
  if (wait) steps.push({ sleepMs: wait });
  steps.push(structured({ summary, handoff: handoff ?? '', learnings: learnings ?? [] }));
  return steps;
}

/** A QA subtask's run: read the change, run the tests, pass. */
function qaRun({ intro, read, test, summary, learnings, wait = 0 }) {
  return [
    { text: intro },
    tool('Read', { file_path: read }, readOut(read), 1200),
    tool('Bash', { command: test[0] }, test[1], 3200),
    ...(wait ? [{ sleepMs: wait }] : []),
    { text: 'All green; the behaviour matches the plan.' },
    structured({ passed: true, summary, findings: [], learnings: learnings ?? [] }),
  ];
}

/** Every rule of one task, each matching the task's title and its step. */
function story(title, { exploring, questions, plan, subtasks, runs }) {
  const task = `**Task:** ${title}`;
  const rules = [];
  const look = exploring ?? [];
  if (questions) {
    rules.push({
      whenPrompt: [task, MARK.questions],
      steps: [...look, structured({ questions })],
    });
  }
  rules.push({
    whenPrompt: [task, MARK.plan],
    steps: [
      { text: 'Writing the plan with your answers.' },
      ...look.slice(-2),
      { sleepMs: 1500 },
      structured({ plan }),
    ],
  });
  rules.push({
    whenPrompt: [task, MARK.subtasks],
    steps: [
      { text: 'Splitting the plan into subtasks.' },
      { sleepMs: 1500 },
      structured({ subtasks }),
    ],
  });
  for (const [id, steps] of Object.entries(runs)) {
    rules.push({ whenPrompt: [task, `(${id})`], steps });
  }
  return rules;
}

const subtask = (id, title, detail, progressLabel) => ({
  id,
  kind: id.startsWith('qa') ? 'qa' : 'dev',
  title,
  detail,
  ...(progressLabel ? { progressLabel } : {}),
});

// The main task, followed from start to Human Review.
const LIMITS = 'Pause tasks when a CLI hits its usage limit';
const LIMITS_DESCRIPTION = `When Claude Code, Codex or Cursor hits the subscription's usage limit, the run ends as a generic failure (Cursor even looks like a crash), and I have to resume it by hand after the reset. Every other task on the same CLI then fails the same way.

Instead, a task that hits a limit should wait for the reset and carry on by itself in the same session, and the other tasks on that CLI should wait too instead of failing. The card should say when it will resume.`;

const LIMITS_PLAN = `# Pause tasks when a CLI hits its usage limit

## Overview
Today a usage limit ends a run as a failure: \`AgentError\` for Claude Code and Codex, a crash for Cursor, whose message only reaches stderr. The task stops, and every other task on that CLI fails the same way at its next step.

After this change a run that hits a limit becomes **rate-limited**: it records when the limit resets, holds every other task on the same CLI, and resumes by itself in the same session at the reset.

## What each CLI reports
| CLI | Where | Reset time |
| --- | --- | --- |
| Claude Code | a rejected \`rate_limit_event\`, then an error result ("You've hit your session limit · resets 3:45pm (Europe/London)") | yes, and its scope (session, weekly, Opus) |
| Codex | \`turn.failed\`: "You've hit your usage limit … try again at 4:12 PM" | yes |
| Gemini CLI | \`RESOURCE_EXHAUSTED\` or HTTP 429 | no |
| Cursor | stderr only | no |
| Amp | the result's \`error\` field (dropped today) | no |

Only the final result, error events and stderr are read, never the agent's own text, so a task *about* rate limits cannot trip it.

## Steps
1. **Recognise limits** (\`agent/limits.rs\`, new): one parser per CLI giving \`RateLimit { resets_at, scope }\`. Times are read in the zone the CLI names, else local time; a time just past means now, more than eight days ahead is a misreading. \`LineParser::finish\` reads the last 50 stderr lines when a stream ends without a result.
2. **A waiting run** (\`task.rs\`, \`engine/step.rs\`): \`RunState::RateLimited\` with \`resetsAt\`, \`resetEstimated\` and the scope. Resumable like a pause; the next step is halted.
3. **One limiter for the app** (\`engine/limits.rs\`, new): CLI, or CLI and model family for Claude's Opus and Sonnet limits, to reset time. Shared by every open project's engine.
4. **Hold before starting** (\`engine/driver.rs\`): a step about to run a limited CLI becomes rate-limited without starting anything, checked before the run is written and again after the agent slot is taken.
5. **Wake-ups** (\`engine/mod.rs\`): a timer per task at the reset plus a minute's grace. It holds a weak engine reference and ticks against the wall clock, so a sleeping Mac cannot delay it. Rebuilt from the task files when a project opens, so a restart keeps it.
6. **The card** (\`ui/src/lib/task-view.ts\`, \`task-card.tsx\`, \`task-detail-modal.tsx\`): "Rate-limited", "Resumes at 15:42" (or "Retrying at …" when the CLI gave no time), and **Resume now**.

## Your answers
- Every task on the CLI waits, not only the one that hit the limit.
- After a restart, it resumes by itself once its project is open.
- No reset time given: retry after 30 minutes.
- Show the time in local time, with Resume now.

## Edge cases
- Pause while waiting cancels the wake-up; Resume now forgets the limit first, so it really tries.
- Editing a waiting task's agents to another CLI resumes it at once.
- A plain 429 limits only that run, not the CLI.

## Testing
- Recorded output of each CLI in \`tests/fixtures/streams/\` for the parsers.
- Engine tests on the mock agent: one limit holds a second task without starting it, both resume at the reset, pause cancels, a restart relearns the limit.
- Vitest for the card's status and text.`;

const LIMITS_RULES = story(LIMITS, {
  exploring: [
    { text: "I'll look at how a run's outcome is decided today and where it fails." },
    tool(
      'Read',
      { file_path: 'crates/core/src/agent/stream_json.rs' },
      readOut('crates/core/src/agent/stream_json.rs'),
      1600
    ),
    tool(
      'Grep',
      { pattern: 'AgentError', path: 'crates/core/src' },
      grepOut('AgentError', ['crates/core/src']),
      1000
    ),
    tool(
      'Read',
      { file_path: 'crates/core/src/engine/driver.rs' },
      readOut('crates/core/src/engine/driver.rs', 1, 24),
      1600
    ),
    {
      thinking:
        'A limit ends as AgentError for Claude and Codex and as Crashed for Cursor. The driver clears the session on both, so a retry starts over. Nothing holds other tasks on the same CLI.',
    },
    tool(
      'Grep',
      { pattern: 'stderr', path: 'crates/core/src/agent/process.rs' },
      grepOut('stderr', ['crates/core/src/agent/process.rs']),
      900
    ),
  ],
  questions: [
    {
      id: 'q1',
      text: 'When a CLI reports its usage limit, which tasks should wait?',
      options: ['Every task that uses that CLI', 'Only the task that hit the limit'],
      required: true,
    },
    {
      id: 'q2',
      text: 'If the app restarts while a task is waiting, what should happen at the reset?',
      options: ['Resume it once its project is open', 'Leave it paused until I resume it'],
      required: true,
    },
    {
      id: 'q3',
      text: 'Gemini, Cursor and Amp give no reset time. How long should a task wait before trying again?',
      options: ['30 minutes', '1 hour', 'Until I resume it'],
      required: true,
    },
    { id: 'q4', text: 'Anything the card should show while a task waits?', required: false },
  ],
  plan: LIMITS_PLAN,
  subtasks: [
    subtask(
      'dev-1',
      'Recognise usage limits in each CLI',
      'agent/limits.rs: a parser per CLI giving the reset time and scope; stream_json and Cursor read them; finish() reads stderr.',
      'Recognising limits'
    ),
    subtask(
      'dev-2',
      'A rate-limited run state',
      'RunState::RateLimited with resetsAt, resetEstimated and the scope; validated together; halted in next_step.',
      'Adding the run state'
    ),
    subtask(
      'dev-3',
      'One limiter shared by every project',
      'engine/limits.rs: CLI and model family to reset time; wake-up timers at the reset; relearned on open.',
      'Sharing limits'
    ),
    subtask(
      'dev-4',
      'Hold tasks before they start',
      'The driver checks the limiter before writing the run and after taking an agent slot.',
      'Holding tasks'
    ),
    subtask(
      'dev-5',
      'Show the wait on the card',
      '"Rate-limited", "Resumes at …" or "Retrying at …", and Resume now, on the card and in the details.',
      'Updating the card'
    ),
    subtask(
      'qa-1',
      'Check the engine under a limit',
      'Run the engine and parser tests; read the wake-up code.'
    ),
    subtask(
      'qa-2',
      'Check the card',
      'Run the view tests; check every status has its text and action.'
    ),
  ],
  runs: {
    'dev-1': devRun({
      intro: 'Starting with the parsers: what each CLI prints when it hits its limit.',
      read: ['crates/core/src/agent/stream_json.rs', 40],
      grep: ['is_error', ['crates/core/src/agent']],
      think:
        'Claude sends rate_limit_event before the error result; remember the rejected one and let the result decide. Cursor only says it on stderr.',
      doing: 'Adding agent/limits.rs and wiring it into the Claude and Cursor parsers.',
      files: [
        'crates/core/src/agent/limits.rs',
        'crates/core/src/agent/stream_json.rs',
        'crates/core/src/agent/cursor.rs',
      ],
      test: [
        'cargo test -p code-automata-core limits',
        cargoOut(testNames('crates/core/src/agent/limits.rs'), 'agent::limits::tests::'),
      ],
      summary: 'Each CLI’s usage limit is recognised with its reset time and scope.',
      handoff: 'limits::RateLimit { resets_at, scope }; OutcomeKind::RateLimited carries it.',
      learnings: [
        'Recorded CLI output for parser tests lives in crates/core/tests/fixtures/streams/, one file per CLI and case.',
      ],
    }),
    'dev-2': devRun({
      intro: 'Next, the run state that waits for a reset.',
      read: ['crates/core/src/task.rs', 1],
      grep: ['Interrupted', ['crates/core/src/task.rs', 'crates/core/src/engine/step.rs']],
      doing: 'Adding RunState::RateLimited and its fields, validated together.',
      files: ['crates/core/src/task.rs', 'crates/core/src/engine/step.rs'],
      test: [
        'cargo test -p code-automata-core --test schema',
        cargoOut(testNames('crates/core/tests/schema.rs')),
      ],
      summary: 'A run can wait for a reset; the step table halts it.',
      handoff: 'Run.resets_at, reset_estimated, limit_scope; is_resumable covers RateLimited.',
    }),
    'dev-3': devRun({
      intro: 'Now the limiter every project shares, and the wake-ups.',
      read: ['crates/core/src/engine/mod.rs', 1],
      grep: ['fn open', ['crates/core/src/engine/mod.rs']],
      think:
        'The timer must not keep the engine alive: hold a Weak<Inner>. Tick against the wall clock rather than one long sleep, which a sleeping Mac would stretch.',
      doing: 'Adding engine/limits.rs and the wake-up timers.',
      files: ['crates/core/src/engine/limits.rs', 'crates/core/src/engine/mod.rs'],
      test: [
        'cargo test -p code-automata-core engine::limits',
        cargoOut(testNames('crates/core/src/engine/limits.rs'), 'engine::limits::tests::'),
      ],
      summary:
        'One limiter for the app; each waiting task wakes at its reset, also after a restart.',
      handoff: 'Engine::open_with relearns limits from task files.',
      linger: 8000,
    }),
    'dev-4': devRun({
      intro: 'Holding tasks that would run a limited CLI.',
      read: ['crates/core/src/engine/driver.rs', 340],
      grep: ['Semaphore', ['crates/core/src/engine']],
      doing: 'Checking the limiter before the run is written and after the agent slot is taken.',
      files: ['crates/core/src/engine/driver.rs'],
      test: [
        'cargo test -p code-automata-core --test engine limit',
        cargoOut(testNames('crates/core/tests/engine.rs', /limit|rate/)),
      ],
      summary: 'A task about to use a limited CLI waits without starting anything.',
      handoff: 'execute() checks RateLimits::active before Running and after the permit.',
    }),
    'dev-5': devRun({
      intro: 'Last, the card.',
      read: ['ui/src/lib/task-view.ts', 1],
      grep: ['interrupted', ['ui/src/lib/task-view.ts']],
      doing: 'Adding the rate-limited status, its text and Resume now.',
      files: [
        'ui/src/lib/task-view.ts',
        'ui/src/components/kanban/task-card.tsx',
        'ui/src/components/tasks/task-detail-modal.tsx',
      ],
      test: [
        'yarn vitest run src/lib/task-view.test.ts',
        vitestOut('ui/src/lib/task-view.test.ts'),
      ],
      summary: '"Rate-limited", "Resumes at …" and Resume now on the card and in the details.',
      handoff: 'taskStatus gives rate_limited; primaryAction is resume_now.',
    }),
    'qa-1': qaRun({
      intro: 'Checking the engine: limits, holding and wake-ups.',
      wait: 7000,
      read: 'crates/core/src/engine/mod.rs',
      test: [
        'cargo test -p code-automata-core --test engine --test agent_parsers',
        cargoOut([
          ...testNames('crates/core/tests/engine.rs', /limit|rate/),
          ...testNames('crates/core/tests/agent_parsers.rs', /limit/),
        ]),
      ],
      summary:
        'A limit holds every task on the CLI without starting them; all resume at the reset, pause cancels, a restart relearns.',
      learnings: [
        'cargo test --test engine runs the whole engine on the mock agent; build the workspace first so mock-agent exists.',
      ],
    }),
    'qa-2': qaRun({
      intro: 'Checking the card for every state.',
      wait: 5000,
      read: 'ui/src/lib/task-view.ts',
      test: ['yarn vitest run', vitestOut('ui/src/lib/task-view.test.ts')],
      summary: 'Rate-limited cards show the reset in local time and offer Resume now.',
    }),
  },
});

/** A task the demo starts but does not follow: plain, plausible runs. */
function sideTask(title, { questions, plan, subtasks, runs }) {
  return story(title, {
    exploring: [{ text: 'Looking at the code involved.' }, { sleepMs: 2500 }],
    questions,
    plan,
    subtasks,
    runs,
  });
}

const CODEX = 'Add Codex as an agent';
const PHASES = 'Choose an agent per phase in the new-task dialog';
const MEMORY = 'Keep what agents learn about a project';

const RULES = [
  ...LIMITS_RULES,
  ...sideTask(CODEX, {
    plan: '# Add Codex as an agent\n\nRun `codex exec --json` headless with the prompt on stdin, a read-only sandbox for planning, and its JSONL events turned into the app’s.',
    subtasks: [
      subtask(
        'dev-1',
        'Codex command line',
        'codex exec with the sandbox per phase.',
        'Building the command'
      ),
      subtask('dev-2', 'Parse Codex events', 'Items, turns, the final answer.', 'Parsing events'),
      subtask('qa-1', 'Check Codex runs', 'Command lines and parser tests.'),
    ],
    runs: {
      'dev-1': devRun({
        intro: 'Adding the Codex adapter.',
        read: ['crates/core/src/agent/mod.rs', 1],
        doing: 'Writing agent/codex.rs.',
        files: ['crates/core/src/agent/codex.rs'],
        wait: 15000,
        summary: 'codex exec with read-only planning and full access for development.',
      }),
      'dev-2': devRun({
        intro: 'Parsing Codex events.',
        read: ['crates/core/src/agent/stream_json.rs', 1],
        doing: 'Recording a Codex stream for the parser tests.',
        files: ['crates/core/tests/fixtures/streams/codex-dev.ndjson'],
        wait: 15000,
        summary: 'Items become events; turn.completed is the answer.',
      }),
      'qa-1': qaRun({
        intro: 'Checking Codex runs.',
        read: 'crates/core/src/agent/mod.rs',
        test: [
          'cargo test --test agent_commands codex',
          cargoOut(testNames('crates/core/tests/agent_commands.rs', /codex/)),
        ],
        wait: 70000,
        summary: 'Codex command lines and events check out.',
      }),
    },
  }),
  ...sideTask(PHASES, {
    plan: '# An agent per phase\n\nTasks name an agent for planning, development and QA (task schema 3), and the dialog offers a CLI and model for each.',
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
        'A CLI and model per phase.',
        'Building the dialog'
      ),
      subtask('qa-1', 'Check the dialog', 'Form logic and schema upgrades.'),
    ],
    runs: {
      'dev-1': devRun({
        intro: 'Moving tasks to an agent per phase.',
        read: ['crates/core/src/store.rs', 200],
        doing: 'Adding upgrade_v2 and PhaseAgents.',
        files: ['crates/core/src/store.rs'],
        wait: 60000,
        summary: 'Tasks name an agent per phase; older files upgrade on read.',
      }),
      'dev-2': devRun({
        intro: 'Building the phase rows.',
        read: ['ui/src/components/tasks/agent-picker.tsx', 1],
        doing: 'Planning, Development and QA rows with model lists.',
        files: ['ui/src/components/tasks/agent-picker.tsx', 'ui/src/lib/agent-form.ts'],
        wait: 60000,
        summary: 'A CLI and model per phase in the dialog.',
      }),
      'qa-1': qaRun({
        intro: 'Checking the dialog.',
        read: 'ui/src/lib/agent-form.ts',
        test: [
          'yarn vitest run src/lib/agent-form.test.ts',
          vitestOut('ui/src/lib/agent-form.test.ts'),
        ],
        summary: 'The dialog creates per-phase tasks.',
      }),
    },
  }),
  ...sideTask(MEMORY, {
    questions: [
      {
        id: 'q1',
        text: 'Where should what agents learn be kept?',
        options: ['.code-automata/memory.md, editable in Settings', 'A section of AGENTS.md'],
        required: true,
      },
      {
        id: 'q2',
        text: 'Should planning runs get the memory too, or only development and QA?',
        options: ['Every prompt', 'Only development and QA'],
        required: true,
      },
    ],
    plan: '# Project memory',
    subtasks: [
      subtask('dev-1', 'Keep learnings', 'Append to memory.md.'),
      subtask('qa-1', 'Check memory', ''),
    ],
    runs: {},
  }),
];

// --- the browser ------------------------------------------------------------------------------

function shot(name) {
  ab('screenshot', path.join(OUT, `${name}.png`));
}

/** Scroll the nearest scrolling box around `testid` down, a step at a time, to its end. */
async function scrollThrough(testid, step = 110, everyMs = 450) {
  for (let i = 0; i < 80; i++) {
    const atEnd = js(`(() => {
      let el = document.querySelector('[data-testid="${testid}"]');
      while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      if (!el) return true;
      el.scrollBy(0, ${step});
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    })()`);
    if (atEnd) return;
    await pause(everyMs);
  }
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
    await pause(2000);

    // A new task, with an agent per phase and plan review.
    click('new-task-button');
    await until('the agent rows', () => exists('agent-phases'), Boolean, 60_000);
    ab('type', '[data-testid="new-task-title"]', LIMITS);
    fill('new-task-description', LIMITS_DESCRIPTION);
    click('new-task-plan-approval');
    await pause(3000);
    shot('new-task-agents');
    click('new-task-submit');
    await until('the card', () => card(LIMITS));

    // Planning explores the code: watch its run.
    await pause(800);
    openDetails(LIMITS);
    await until('the details', () => exists('task-detail-modal'));
    click('task-detail-tab-runs');
    await untilCard(LIMITS, 'questions', (c) => c.status === 'needs_answers', 60_000);
    await pause(2500);
    closeDialog();

    // Four questions.
    await pause(1000);
    cardAction(LIMITS, 'answer');
    await until('the questions', () => exists('questions-modal'));
    await pause(2500);
    shot('questions');
    click('question-option-q1-0');
    await pause(1500);
    click('questions-next');
    await pause(2000);
    click('question-option-q2-0');
    await pause(1500);
    click('questions-next');
    await pause(2000);
    click('question-option-q3-0');
    await pause(1500);
    click('questions-next');
    await pause(1500);
    ab(
      'type',
      '[data-testid="question-note-q4"]',
      'The reset time in my local time, and a way to resume early if I switch plans.'
    );
    await pause(1500);
    click('questions-submit');

    // The plan, read to the end, then approved.
    await untilCard(LIMITS, 'plan ready', (c) => c.status === 'needs_plan_review', 60_000);
    await pause(1000);
    cardAction(LIMITS, 'review_plan');
    await until('the plan', () => exists('plan-content'));
    // Long enough for the "Answers sent" toast to go.
    await pause(4500);
    shot('plan-review');
    await scrollThrough('plan-content');
    await pause(2000);
    click('plan-approve');

    // The rest of the release, so the board fills up.
    await pause(2500);
    await newTask(CODEX, "Run OpenAI's Codex CLI headless, like the other agents.");
    await newTask(PHASES, 'Pick the CLI and model for planning, development and QA separately.');
    await newTask(MEMORY, 'Keep lasting facts agents learn and give them to later tasks.', {
      approval: true,
    });

    // The subtasks, then development live.
    await untilCard(LIMITS, 'developing', (c) => c.phase === 'in_progress', 60_000);
    await pause(1500);
    openDetails(LIMITS);
    await until('the details', () => exists('task-detail-modal'));
    click('task-detail-tab-subtasks');
    await pause(4000);
    shot('task-details');
    click('task-detail-tab-runs');
    await pause(2000);
    await until(
      'test output in the run log',
      () =>
        js(
          `document.querySelector('[data-testid="run-events"]')?.innerText.includes('Tests pass.') ?? false`
        ),
      Boolean,
      30_000
    );
    await pause(1200);
    shot('agent-run');
    await pause(5000);
    click('task-detail-tab-changes');
    await pause(4000);
    closeDialog();

    await untilCard(MEMORY, 'questions', (c) => c.status === 'needs_answers', 60_000);
    await untilCard(PHASES, 'developing', (c) => c.phase === 'in_progress', 60_000);
    await pause(4500);
    shot('board');

    // QA runs the tests.
    await untilCard(
      LIMITS,
      'in AI review',
      (c) => c.phase === 'ai_review' || c.phase === 'human_review',
      150_000
    );
    await pause(1000);
    openDetails(LIMITS);
    await until('the details', () => exists('task-detail-modal'));
    click('task-detail-tab-runs');
    await pause(8000);
    closeDialog();

    // Human review.
    await untilCard(LIMITS, 'in human review', (c) => c.phase === 'human_review', 120_000);
    await pause(2000);
    cardAction(LIMITS, 'human_review');
    await until('the review', () => exists('human-review-modal'));
    await pause(4000);
    shot('human-review');
    await scrollThrough('human-review-modal');
    await pause(2500);
    closeDialog();
    await pause(1500);

    ab('open', `${BASE}/settings`);
    await until('the settings', () => exists('settings-mcp'));
    js(
      `document.querySelector('[data-testid="settings-mcp"]').closest('section').scrollIntoView({ block: 'start' }) || true`
    );
    await pause(3000);
    shot('settings-mcp-memory');
    ab('open', `${BASE}/`);
    await until('the board', () => exists('kanban-column-planning'));
    await pause(3000);
    ab('record', 'stop');
    // The README's hero: the board at the shape of the app window in the original artwork.
    ab('set', 'viewport', '1920', '899');
    ab('open', `${BASE}/`);
    await until('the board', () => exists('kanban-column-planning'));
    await pause(2500);
    shot('hero-board');
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
