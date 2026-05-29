/**
 * Live E2E: drives `loop run --once` with each *real* agent CLI against a
 * trivial fixture repo, to catch CLI updates breaking our provider
 * integrations (spawn args, stream parsing, verdict/usage extraction).
 *
 * The task is deliberately unambiguous and tiny — "write `hello` into
 * greeting.txt" — so sessions stay short; the value is the full pipeline
 * crossing every provider seam (implement session, shell verify, review
 * session with a parsed `## Loop verdict`, usage table).
 *
 * Opt-in via `npm run test:e2e`. CLIs missing from PATH are skipped;
 * `LOOP_E2E_CLIS=claude-code,codex` narrows the matrix.
 */

import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { AGENT_CLIS, type AgentCli } from '../src/config/types.js';
import { resolveAgentProvider } from '../src/agent/providers/index.js';

const execFileAsync = promisify(execFile);

const LOOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOP_BIN = path.join(LOOP_ROOT, 'bin', 'loop.js');

function isInstalled(binary: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(probe, [binary], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function selectedClis(): AgentCli[] {
  const filter = process.env.LOOP_E2E_CLIS;
  if (!filter) return [...AGENT_CLIS];
  const wanted = filter.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = wanted.filter((name) => !(AGENT_CLIS as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`LOOP_E2E_CLIS has unknown CLI(s): ${unknown.join(', ')}`);
  return wanted as AgentCli[];
}

const CHECK_SCRIPT = `import { readFileSync } from 'node:fs';
let text;
try {
  text = readFileSync('greeting.txt', 'utf8');
} catch {
  console.error('greeting.txt is missing');
  process.exit(1);
}
if (text.trim() !== 'hello') {
  console.error('greeting.txt must contain exactly "hello", got: ' + JSON.stringify(text));
  process.exit(1);
}
console.log('greeting ok');
`;

const ISSUE = `---
id: task-01
title: Create greeting.txt with hello
triage: ready
---

Create a file named \`greeting.txt\` at the repository root containing exactly the
word \`hello\` on a single line. Apart from that file (and this issue file's own
checklist), change nothing.

## Acceptance criteria

- [ ] \`greeting.txt\` exists at the repo root and contains exactly \`hello\`
`;

const roots: string[] = [];

function makeFixtureRepo(agentCli: AgentCli): string {
  const root = mkdtempSync(path.join(tmpdir(), `loop-e2e-${agentCli}-`));
  roots.push(root);
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'loop-e2e@example.com']);
  git(['config', 'user.name', 'Loop E2E']);
  git(['config', 'commit.gpgsign', 'false']);

  // Loop's contract: runtime state lives in gitignored `.loop/` (README).
  // Without this, run artifacts land in the diff and reviewers flag them.
  writeFileSync(path.join(root, '.gitignore'), '.loop/\n');
  writeFileSync(path.join(root, 'check.mjs'), CHECK_SCRIPT);
  writeFileSync(
    path.join(root, 'loop.config.json'),
    `${JSON.stringify(
      {
        agentCli,
        verifyCmd: 'node check.mjs',
        // Work directly in the fixture root: the worktree machinery is covered
        // by the unit/integration suite; this test isolates the provider seam.
        worktreeEnabled: false,
        // Pinned for the same reason: a session free to replace the gate makes
        // every failure here ambiguous between "the CLI integration broke" and
        // "the session chose a different command". Declared verify has its own
        // coverage in src/verify/ and src/pipeline/.
        allowDeclaredVerify: false,
        maxVerifyCycles: 2,
        maxReviewCycles: 1,
        agentTimeoutMs: 10 * 60_000,
        agentIdleTimeoutMs: 5 * 60_000,
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(path.join(root, 'issues', 'e2e'), { recursive: true });
  writeFileSync(path.join(root, 'issues', 'e2e', 'task-01.md'), ISSUE);
  git(['add', '-A']);
  git(['commit', '-m', 'e2e fixture']);
  return root;
}

afterAll(() => {
  if (process.env.LOOP_E2E_KEEP === '1') {
    console.log(`[e2e] keeping fixture repos:\n${roots.map((root) => `  ${root}`).join('\n')}`);
    return;
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe.each(selectedClis())('%s', (agentCli) => {
  const binary = resolveAgentProvider(agentCli).binaryName;
  const installed = isInstalled(binary);
  if (!installed) {
    console.warn(`[e2e] ${agentCli}: "${binary}" not found on PATH — skipping this provider.`);
  }

  it.skipIf(!installed)(
    'completes a trivial issue end to end (implement → verify → review)',
    async () => {
      const root = makeFixtureRepo(agentCli);

      let stdout = '';
      let stderr = '';
      let code = 0;
      try {
        const result = await execFileAsync(process.execPath, [LOOP_BIN, 'run', '--once', '--quiet'], {
          cwd: root,
          maxBuffer: 64 * 1024 * 1024,
          env: process.env,
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string; code?: number };
        stdout = failed.stdout ?? '';
        stderr = failed.stderr ?? '';
        code = failed.code ?? 1;
      }
      const transcript = `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;

      expect(code, `loop run exited ${code}\n${transcript}`).toBe(0);

      // The work happened and the gate actually holds.
      const greetingPath = path.join(root, 'greeting.txt');
      expect(existsSync(greetingPath), `greeting.txt missing\n${transcript}`).toBe(true);
      expect(readFileSync(greetingPath, 'utf8').trim()).toBe('hello');

      // The pipeline closed the loop: issue done, run bookkeeping written.
      const issue = readFileSync(path.join(root, 'issues', 'e2e', 'task-01.md'), 'utf8');
      expect(issue, `issue not marked done\n${transcript}`).toContain('triage: done');
      expect(stdout).toContain('Completed e2e/task-01');

      // --- per-seam artifact checks -------------------------------------

      // Run dir exists with the full artifact set.
      const projectRunsDir = path.join(root, '.loop', 'runs', 'e2e');
      const runDirs = readdirSync(projectRunsDir).map((name) => path.join(projectRunsDir, name));
      expect(runDirs, `no run dir recorded\n${transcript}`).toHaveLength(1);
      const runDir = runDirs[0]!;

      // Seam: prompt building — the implement prompt reached disk with the issue and the verify deal.
      const prompt = readFileSync(path.join(runDir, 'prompt.md'), 'utf8');
      expect(prompt).toContain('task-01');
      expect(prompt).toContain('node check.mjs');

      // Seam: raw stream capture — the agent log holds the CLI's own stream (JSON lines).
      const streamLog = readFileSync(path.join(runDir, 'agent.stream.log'), 'utf8');
      expect(streamLog.length, `agent.stream.log is empty\n${transcript}`).toBeGreaterThan(0);
      const jsonLines = streamLog.split('\n').filter((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      });
      expect(jsonLines.length, `no parseable JSON lines in ${binary}'s stream\n${transcript}`).toBeGreaterThan(0);

      // Seam: verify execution — the gate ran for real (or was legitimately
      // proven in-session, which the log records as SKIPPED with the reason).
      const verifyLog = readFileSync(path.join(runDir, 'verify.log'), 'utf8');
      expect(
        /greeting ok|SKIPPED/.test(verifyLog),
        `verify.log holds neither a real pass nor an evidence skip:\n${verifyLog}\n${transcript}`,
      ).toBe(true);

      // Seam: review verdict parsing — a review round ran and its verdict parsed.
      const reviewRound = path.join(runDir, 'reviews', 'round-1');
      expect(existsSync(reviewRound), `no review round artifacts\n${transcript}`).toBe(true);
      const reviewFiles = readdirSync(reviewRound).map((name) =>
        readFileSync(path.join(reviewRound, name), 'utf8'),
      );
      expect(
        reviewFiles.some((text) => text.includes('changesRequested') || text.includes('## Loop verdict')),
        `review artifacts hold no parsed verdict\n${transcript}`,
      ).toBe(true);

      // Seam: usage extraction — summary.json carries per-stage token counts
      // (the canary for a changed stream format), and the run index appended.
      const summary = JSON.parse(readFileSync(path.join(runDir, 'summary.json'), 'utf8')) as {
        outcome: string;
        issueDone: boolean;
        usage?: Array<{ stage: string; inputTokens: number; outputTokens: number }>;
      };
      expect(summary.outcome).toBe('completed');
      expect(summary.issueDone).toBe(true);
      const usage = summary.usage ?? [];
      expect(usage.length, `no usage entries — did ${binary}'s stream format change?\n${transcript}`).toBeGreaterThan(0);
      expect(usage.some((entry) => entry.stage === 'implement')).toBe(true);
      expect(
        usage.some((entry) => entry.inputTokens + entry.outputTokens > 0),
        `every stage reported zero tokens: ${JSON.stringify(usage)}\n${transcript}`,
      ).toBe(true);
      expect(stdout).toContain('token usage totals');
      expect(statSync(path.join(root, '.loop', 'runs.jsonl')).size).toBeGreaterThan(0);

      // Seam: commit bookkeeping — the work landed as at least one new commit
      // past the fixture baseline (loop's `type: summary (e2e/task-01)`
      // commit, or the session's own when it committed first).
      const gitLog = execFileSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf8' });
      const commitCount = gitLog.trim().split('\n').length;
      expect(commitCount, `no commit past the fixture baseline:\n${gitLog}\n${transcript}`).toBeGreaterThan(1);
    },
  );
});
