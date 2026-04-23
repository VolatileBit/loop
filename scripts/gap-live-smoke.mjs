/**
 * Live gap-smoke fixtures under /tmp. Run from the Loop repo root:
 *   node scripts/gap-live-smoke.mjs parallel|review-fix|interrupt
 *
 * Uses temporary fixture repos only. Bounded agent spend where needed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOOP_BIN = path.join(REPO_ROOT, 'bin/loop.js');

const LABELS = {
  readyForAgent: 'ready-for-agent',
  done: 'agent-done',
  agentFailed: 'agent-failed',
};

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

function writeFile(cwd, rel, contents) {
  const filePath = path.join(cwd, rel);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function commitAll(cwd, message) {
  git(['add', '-A'], cwd);
  git(['commit', '-m', message], cwd);
}

function createBaseFixture(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  git(['init', '-b', 'main'], root);
  git(['config', 'user.email', 'loop-gap@example.com'], root);
  git(['config', 'user.name', 'Loop Gap Smoke'], root);
  writeFile(root, 'README.md', '# gap smoke\n');
  commitAll(root, 'chore: init');

  writeFile(
    root,
    'loop.config.json',
    JSON.stringify(
      {
        agentCli: 'cursor',
        model: 'auto',
        verifyCmd: 'node .loop/verify.mjs',
        issuesDir: 'issues',
        worktreeEnabled: true,
        maxParallelRuns: 2,
        maxVerifyCycles: 2,
        maxReviewCycles: 2,
        triageLabels: LABELS,
        commitExcludePaths: ['issues/**'],
      },
      null,
      2,
    ) + '\n',
  );

  writeFile(
    root,
    '.loop/verify.mjs',
    `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
const checks = [
  ['alpha.txt', 'alpha\\n'],
  ['beta.txt', 'beta\\n'],
  ['fixme.txt', 'fixed\\n'],
];
for (const [file, expected] of checks) {
  if (existsSync(file) && readFileSync(file, 'utf8') === expected) process.exit(0);
}
console.error('per-issue verify: no matching artifact in', process.cwd());
process.exit(1);
`,
  );

  return root;
}

function writeIssue(root, qualifiedId, triage, extraFrontmatter = '') {
  const [scope, id] = qualifiedId.split('/');
  writeFile(
    root,
    `issues/${scope}/${id}.md`,
    `---
id: ${id}
title: ${id}
triage: ${triage}
${extraFrontmatter}---
## Acceptance criteria

- [ ] Create the artifact file for this issue only.

## Instructions

- PRD-A/issue-01: create \`alpha.txt\` containing exactly \`alpha\` on one line.
- PRD-B/issue-02: create \`beta.txt\` containing exactly \`beta\` on one line.
`,
  );
}

function runLoop(args, cwd, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LOOP_BIN, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (options.echo) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (options.echo) process.stderr.write(chunk);
    });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
        }, options.timeoutMs)
      : null;
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function rollingRoot(fixtureRoot) {
  return `${fixtureRoot}-loop`;
}

async function smokeParallel() {
  const root = createBaseFixture('loop-gap-parallel-');
  writeIssue(root, 'PRD-A/issue-01', LABELS.readyForAgent);
  writeIssue(root, 'PRD-B/issue-02', LABELS.readyForAgent);
  commitAll(root, 'chore: add parallel issues');

  console.log(`\n=== parallel smoke fixture: ${root} ===`);
  const dry = await runLoop(['run', '--dry-run', '--max-parallel-runs', '2'], root, { echo: true });
  console.log(`dry-run exit: ${dry.code}`);

  const live = await runLoop(
    ['run', '--max-parallel-runs', '2', '--agent-cli', 'cursor', '--model', 'auto'],
    root,
    { echo: true, timeoutMs: 600_000 },
  );

  const workRoot = rollingRoot(root);
  const alpha = existsSync(path.join(workRoot, 'alpha.txt')) ? readFileSync(path.join(workRoot, 'alpha.txt'), 'utf8') : null;
  const beta = existsSync(path.join(workRoot, 'beta.txt')) ? readFileSync(path.join(workRoot, 'beta.txt'), 'utf8') : null;
  console.log('\n=== parallel smoke outcome ===');
  console.log(JSON.stringify({ fixture: root, workRoot, exitCode: live.code, alpha, beta }, null, 2));
  return { root, live, alpha, beta };
}

async function smokeReviewFix() {
  const root = createBaseFixture('loop-gap-review-');
  writeFile(root, 'fixme.txt', 'broken\n');
  writeFile(
    root,
    'issues/PRD-R/issue-01.md',
    `---
id: issue-01
title: Review fix smoke
triage: ${LABELS.done}
---
## Acceptance criteria

- [x] artifact exists

## Instructions

fixme.txt must contain exactly \`fixed\` on one line (currently wrong).
`,
  );
  commitAll(root, 'chore: pre-implemented review-fix state');

  console.log(`\n=== review --fix smoke fixture: ${root} ===`);
  const live = await runLoop(
    ['review', '--fix', '--ids', 'PRD-R/issue-01', '--agent-cli', 'cursor', '--model', 'auto'],
    root,
    { echo: true, timeoutMs: 600_000 },
  );

  const workRoot = rollingRoot(root);
  const fixed = existsSync(path.join(workRoot, 'fixme.txt')) ? readFileSync(path.join(workRoot, 'fixme.txt'), 'utf8') : null;
  console.log('\n=== review --fix smoke outcome ===');
  console.log(JSON.stringify({ fixture: root, workRoot, exitCode: live.code, fixme: fixed }, null, 2));
  return { root, live, fixed };
}

async function smokeInterrupt() {
  const root = createBaseFixture('loop-gap-interrupt-');
  writeIssue(root, 'PRD-I/issue-01', LABELS.readyForAgent);
  commitAll(root, 'chore: interrupt issue');

  console.log(`\n=== interrupt smoke fixture: ${root} ===`);
  const child = spawn(
    process.execPath,
    [LOOP_BIN, 'run', '--once', '--agent-cli', 'cursor', '--model', 'auto'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => {
    stdout += c;
    process.stdout.write(c);
  });
  child.stderr.on('data', (c) => {
    stderr += c;
    process.stderr.write(c);
  });

  await new Promise((r) => setTimeout(r, 5000));
  console.log('\n[smoke] sending first SIGINT (graceful stop, non-TTY path)…');
  try {
    process.kill(child.pid, 'SIGINT');
  } catch (error) {
    console.log(`[smoke] first SIGINT skipped: ${error instanceof Error ? error.message : error}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log('[smoke] sending second SIGINT (force-stop)…');
  try {
    process.kill(child.pid, 'SIGINT');
  } catch (error) {
    console.log(`[smoke] second SIGINT skipped: ${error instanceof Error ? error.message : error}`);
  }

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut: true });
    }, 30_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut: false });
    });
  });

  console.log('\n=== interrupt smoke outcome ===');
  const interrupted = /received SIGINT|graceful stop|force-stop/i.test(`${stdout}\n${stderr}`);
  console.log(JSON.stringify({ fixture: root, ...result, sawInterruptBanner: interrupted }, null, 2));
  return { root, result };
}

const mode = process.argv[2] ?? 'all';
const runners = {
  parallel: smokeParallel,
  'review-fix': smokeReviewFix,
  interrupt: smokeInterrupt,
};

if (mode === 'all') {
  for (const [name, fn] of Object.entries(runners)) {
    console.log(`\n######## ${name} ########`);
    await fn();
  }
} else if (runners[mode]) {
  await runners[mode]();
} else {
  console.error(`Unknown mode: ${mode}. Use parallel|review-fix|interrupt|all`);
  process.exit(1);
}
