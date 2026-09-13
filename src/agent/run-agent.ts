/**
 * Provider-agnostic agent-session runner: resolves the stage's provider+model,
 * spawns the agent CLI, feeds stdout lines through the provider's parser into
 * the stream display, enforces wall/idle timeouts, and classifies the outcome
 * (ok / stuck / interrupted / usage-limited).
 *
 * Agent process state stays local to each attempt. Provider quota availability
 * is the one shared process-lifetime concern, coordinated by
 * provider-availability.ts so later stages and parallel workers avoid CLIs
 * already known to be limited.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  resolveStageAgentCandidates,
  type StageAgentSettings,
  type StageCliFlags,
} from '../config/stage-settings.js';
import type { AgentCli, LoopConfig, StageName } from '../config/types.js';
import {
  isShuttingDown,
  killProcessTree,
  registerActiveChild,
  unregisterActiveChild,
} from '../interrupt/shutdown.js';
import { contentWidth, formatOutputPrefix, wrapToWidth } from '../logs/output-prefix.js';
import { caution, cost, detail, stage } from '../logs/style.js';
import {
  formatCompactNumber,
  formatElapsed,
  totalTokens,
  type AgentUsage,
} from '../usage/tokens.js';
import { createEvidenceTracker } from './evidence.js';
import { formatDuration } from './format.js';
import {
  type AgentAvailabilityTracker,
  type LimitedProvider,
  processAgentAvailability,
} from './provider-availability.js';
import {
  nextRetryDelayMs,
  parseInfraError,
  type InfraErrorSignature,
} from './providers/infra-error.js';
import { resolveAgentProvider } from './providers/index.js';
import type { AgentProvider, CanonicalAgentEvent } from './providers/types.js';
import { parseUsageLimitDetails, type UsageLimitDetails } from './providers/usage-limit.js';
import { AgentStreamDisplay } from './stream-display.js';

export type AgentStuckReason = 'wall-timeout' | 'idle-timeout' | 'interrupted' | null;

export type AgentAttemptTelemetry = {
  usage: AgentUsage | null;
  costUsd: number | null;
  agentCli: AgentCli;
  model: string;
  /**
   * Wall time for the whole child lifetime, so a session killed by a timeout
   * still reports how long it burned first.
   */
  elapsedMs: number;
  /** Largest measured single-request context, or null when the CLI reports none. */
  peakContextTokens: number | null;
};

/** How many sessions this stage lost to provider infrastructure, and to what. */
export type InfraRetrySummary = {
  retries: number;
  /** The signature of the last fault retried — names an outage in a stop reason. */
  signature: InfraErrorSignature;
};

export type AgentRunResult = {
  ok: boolean;
  output: string;
  usageLimited: boolean;
  /** Which limit window was hit and when it lifts (best-effort) — set iff `usageLimited`. */
  usageLimitDetails: UsageLimitDetails | null;
  stuckReason: AgentStuckReason;
  usage: AgentUsage | null;
  /** Dollar cost as reported by the CLI stream; null when the CLI reports none. */
  costUsd: number | null;
  /**
   * Verify commands this session proved in-stream (succeeded, nothing
   * tree-affecting after) — consumed by the verify-skip gate. Empty on
   * failed/stuck runs: their tree state is not trusted.
   */
  provenCommands: string[];
  /** The provider/model this run actually used (for StageUsage tagging). */
  agentCli: AgentCli;
  model: string;
  /** Wall time of this session, measured around the whole child lifetime. */
  elapsedMs: number;
  /**
   * The largest context any single request in this session occupied, from the
   * provider's per-request usage. Null when the CLI reports none — callers
   * then fall back to the cumulative estimate and say so.
   */
  peakContextTokens: number | null;
  /** The CLI's own session/thread id (best-effort) — feeds a later resume. */
  sessionId: string | null;
  /** Which provider infrastructure fault killed this session; null when the failure was ordinary. */
  infraSignature: InfraErrorSignature | null;
  /** Every real CLI session when usage-limit failover or an infra retry made this a multi-attempt stage. */
  attempts?: AgentAttemptTelemetry[];
  /** Set when at least one session was retried after an infrastructure fault. */
  infraRetries?: InfraRetrySummary;
};

/** Why a session is being resumed. Named in the prompt: "continue" alone leaves the agent guessing what stopped it. */
export type ResumeCause = 'usage-limit' | 'provider-fault';

/** The continuation prompt for a resumed session. */
export function resumeContinuePrompt(cause: ResumeCause): string {
  const interruption =
    cause === 'usage-limit'
      ? 'was interrupted by a provider usage limit and has been resumed now that the limit lifted'
      : 'was cut off by a fault on the provider side — nothing you did caused it — and has been resumed';
  return (
    `This session ${interruption}. ` +
    'Continue exactly where you left off and finish the original instructions — including the final response blocks they asked for.'
  );
}

export type RunAgentOptions = {
  config: LoopConfig;
  /** Raw --agent-cli/--model whole-run overrides, if given. */
  cliFlags?: StageCliFlags;
  /** Which pipeline stage this session is — drives provider/model resolution. */
  stage: StageName;
  /** The issue's project, when there is one — lets `projects.<name>.model/effort` apply. */
  project?: string;
  /** Where agent work happens (main repo or a worktree). */
  cwd: string;
  /** Combined stream log destination (parent dirs are created). */
  logPath: string;
  /** e.g. "SPEC-006/issue-07-implement" — used in log prefixes. */
  stageLabel: string;
  /** Echo the live stream to stdout. Pass false when maxParallelRuns > 1. */
  liveOutput?: boolean;
  /** Environment for the agent process; defaults to loop's own (see resolveProjectEnv). */
  env?: NodeJS.ProcessEnv;
  /** Observe the spawned child (e.g. per-worker tracking in the worker pool). */
  onSpawn?: (child: ChildProcess) => void;
  /**
   * Resume this previous session with `prompt` as the continuation instead of
   * starting fresh. Falls back to a fresh session (with the same prompt) when
   * the provider cannot build resume args.
   */
  resume?: { sessionId: string; cause?: ResumeCause } | null;
  /** Test seam: bypass the provider registry. */
  provider?: AgentProvider;
  /** Test seam: resolve a fresh provider for each candidate in the fallback chain. */
  providerFactory?: (agentCli: AgentCli) => AgentProvider;
  /** Shared provider quota knowledge; defaults to the process-lifetime tracker. */
  availability?: AgentAvailabilityTracker;
  /** Test seam: overrides the process-wide shutting-down check. */
  shuttingDown?: () => boolean;
};

/**
 * Final assistant text of a completed run (for parsing `## Loop commit` /
 * `## Loop handoff` / verdict blocks), resolved via the provider that
 * actually ran the session.
 */
export function extractAgentResultText(result: Pick<AgentRunResult, 'agentCli' | 'output'>): string {
  return resolveAgentProvider(result.agentCli).extractResultText(result.output);
}

/**
 * How a failed session should be described in a stop reason. An outage has to
 * read differently from a problem with the code, or the operator goes looking
 * for a bug that isn't there.
 */
export function describeAgentFailure(
  result: Pick<AgentRunResult, 'infraSignature' | 'infraRetries'>,
): string {
  if (!result.infraSignature) return 'failed';
  const sessions = (result.infraRetries?.retries ?? 0) + 1;
  return `failed after ${sessions} attempt(s) — provider fault (${result.infraSignature}); retries exhausted`;
}

export async function runAgent(prompt: string, options: RunAgentOptions): Promise<AgentRunResult> {
  const availability = options.availability ?? processAgentAvailability;
  const resolvedCandidates = resolveStageAgentCandidates(
    options.config,
    options.cliFlags ?? {},
    options.stage,
    options.project,
  );
  const attempts: AgentRunResult[] = [];
  const ordinaryFailures = new Set<AgentCli>();
  const retryPolicy = options.config.agentRetries;
  const shuttingDown = options.shuttingDown ?? isShuttingDown;
  let failoverActive = !availability.isAvailable(resolvedCandidates[0]!.agentCli);
  let aggregateLog = '';
  let previousAttempt: { settings: StageAgentSettings; result: AgentRunResult } | null = null;
  let infraRetries: InfraRetrySummary | undefined;
  /** Set for the one attempt following a provider fault, so the retry keeps the dead session's work. */
  let retryResume: { sessionId: string; cause: ResumeCause } | null = null;
  const settle = (result: AgentRunResult): AgentRunResult =>
    withAttemptTelemetry(result, attempts, infraRetries);

  while (true) {
    // Availability is shared by parallel workers and can change while an
    // earlier provider session is running, so resolve the highest-priority
    // candidate immediately before every launch.
    const candidates = resolvedCandidates.filter(
      (candidate) =>
        !ordinaryFailures.has(candidate.agentCli) &&
        availability.isAvailable(candidate.agentCli),
    );
    if (candidates.length === 0) {
      const nonLimitFailure = [...attempts]
        .reverse()
        .find((attempt) => !attempt.usageLimited);
      if (nonLimitFailure) {
        return finalizeFailure(nonLimitFailure, attempts, resolvedCandidates.length, infraRetries);
      }
      // One configured CLI, and every attempt on it ended usage-limited: its own
      // result already carries the limit details, so report that rather than the
      // "no session started" placeholder below.
      if (resolvedCandidates.length === 1 && attempts.length > 0) {
        return settle(attempts.at(-1)!);
      }
      const limited = availability.soonestLimited(
        resolvedCandidates.map((candidate) => candidate.agentCli),
      );
      if (!limited) continue;
      return settle(cachedUsageLimitResult(resolvedCandidates, limited, options, aggregateLog));
    }

    const settings = candidates[0]!;
    const attemptNumber = attempts.length + 1;
    if (attemptNumber === 1) {
      const selectedIndex = resolvedCandidates.findIndex(
        (candidate) => candidate.agentCli === settings.agentCli,
      );
      const skipped = resolvedCandidates
        .slice(0, selectedIndex)
        .filter((candidate) => !availability.isAvailable(candidate.agentCli));
      if (skipped.length > 0) {
        console.log(
          `${formatOutputPrefix('loop', options.stageLabel)} skipping usage-limited ${skipped.map((candidate) => candidate.agentCli).join(', ')} — starting with ${settings.agentCli}.`,
        );
      }
    } else if (previousAttempt) {
      console.log(
        previousAttempt.result.usageLimited
          ? `${formatOutputPrefix('loop', options.stageLabel)} ${previousAttempt.settings.agentCli} usage limit reached — continuing with ${settings.agentCli}.`
          : `${formatOutputPrefix('loop', options.stageLabel)} ${previousAttempt.settings.agentCli} failed — trying ${settings.agentCli}.`,
      );
    }

    const provider =
      options.providerFactory?.(settings.agentCli) ??
      (attemptNumber === 1 &&
      settings.agentCli === resolvedCandidates[0]!.agentCli &&
      options.provider
        ? options.provider
        : resolveAgentProvider(settings.agentCli));
    // A stage that runs exactly one session keeps the plain log path, so the
    // common case stays a single stream file; anything multi-session gets a
    // file per attempt with the aggregate at the plain path.
    const multiSession = resolvedCandidates.length > 1 || attemptNumber > 1;
    const attemptLogPath = multiSession
      ? attemptLogPathFor(options.logPath, attemptNumber, settings.agentCli)
      : options.logPath;
    const resume = retryResume ?? (attemptNumber === 1 ? options.resume ?? null : null);
    retryResume = null;
    const result = await runAgentAttempt(
      prompt,
      { ...options, logPath: attemptLogPath, resume },
      settings,
      provider,
    );
    if (result.usageLimited && result.usageLimitDetails) {
      availability.markLimited(settings.agentCli, result.usageLimitDetails);
    }
    attempts.push(result);
    previousAttempt = { settings, result };

    if (multiSession) {
      if (attemptNumber === 2 && resolvedCandidates.length === 1) {
        // Attempt 1 wrote the plain log path back when this still looked like a
        // single-session stage; give it its own file now the aggregate owns that path.
        const first = attempts[0]!;
        writeFileSync(attemptLogPathFor(options.logPath, 1, first.agentCli), first.output);
        aggregateLog = `===== Loop agent attempt 1: ${first.agentCli} =====\n${first.output}`;
      }
      aggregateLog +=
        `${aggregateLog ? '\n' : ''}===== Loop agent attempt ${attemptNumber}: ${settings.agentCli} =====\n` +
        result.output;
      mkdirSync(path.dirname(options.logPath), { recursive: true });
      writeFileSync(options.logPath, aggregateLog);
    }

    if (result.ok) return settle(result);
    if (result.stuckReason === 'interrupted') {
      return settle(result);
    }
    if (result.usageLimited) {
      failoverActive = true;
      continue;
    }

    // A provider-side fault says nothing about the work: retry the same CLI in
    // place, before spending a failover slot or failing the stage.
    if (result.infraSignature && (infraRetries?.retries ?? 0) < retryPolicy.attempts) {
      const retryNumber = (infraRetries?.retries ?? 0) + 1;
      const delayMs = nextRetryDelayMs(retryPolicy, retryNumber);
      console.log(
        `${formatOutputPrefix('loop', options.stageLabel)} ${caution(
          `${settings.agentCli} session failed on a provider fault (${result.infraSignature}) — retrying in ${formatDuration(delayMs)} (attempt ${retryNumber} of ${retryPolicy.attempts}).`,
        )}`,
      );
      const cancelled = await sleepUnlessCancelled(delayMs, shuttingDown);
      if (!cancelled) {
        infraRetries = { retries: retryNumber, signature: result.infraSignature };
        // Reattach the dead session where the CLI supports it: a fault 20
        // minutes in should not throw away 20 minutes of exploration.
        retryResume = result.sessionId ? { sessionId: result.sessionId, cause: 'provider-fault' } : null;
        // The retry message above is this attempt's explanation; suppress the
        // generic "X failed — trying Y" line for what is the same provider.
        previousAttempt = null;
        continue;
      }
    }

    // An ordinary configured-primary failure does not activate failover.
    if (!failoverActive && settings.agentCli === resolvedCandidates[0]!.agentCli) {
      return settle(result);
    }
    ordinaryFailures.add(settings.agentCli);
  }
}

/**
 * Closes a session's rail with the figures worth reading: how long it took,
 * what it cost, and how close it came to the model's context window. An elbow,
 * not a tick — this prints before the outcome is judged, so it must not imply
 * the stage went well.
 */
function printStageClose(
  loopPrefix: string,
  session: {
    elapsedMs: number;
    costUsd: number | null;
    usage: AgentUsage | null;
    peakContextTokens: number | null;
  },
): void {
  const parts = [formatElapsed(session.elapsedMs)];
  if (session.costUsd !== null) parts.push(cost(`$${session.costUsd.toFixed(2)}`));
  if (session.usage) parts.push(`${formatCompactNumber(totalTokens(session.usage))} tokens`);
  if (session.peakContextTokens !== null) {
    parts.push(`peak context ${formatCompactNumber(session.peakContextTokens)}`);
  }
  console.log(`${loopPrefix} └ ${parts.join(' · ')}`);
}

/** Wait in slices so a force-stop cuts a backoff short. Resolves true when cancelled. */
async function sleepUnlessCancelled(ms: number, cancelled: () => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cancelled()) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, until - Date.now())));
  }
  return cancelled();
}

function cachedUsageLimitResult(
  candidates: readonly StageAgentSettings[],
  limited: LimitedProvider,
  options: RunAgentOptions,
  aggregateLog = '',
): AgentRunResult {
  const selected =
    candidates.find((candidate) => candidate.agentCli === limited.agentCli) ??
    candidates[0]!;
  const output =
    `no agent session started: every configured CLI remains usage-limited; ` +
    `next retry is ${new Date(limited.retryAtMs).toISOString()}.\n`;
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  writeFileSync(options.logPath, `${aggregateLog}${aggregateLog ? '\n' : ''}${output}`);
  console.log(`${formatOutputPrefix('loop', options.stageLabel)} ${output.trim()}`);
  return {
    ok: false,
    output,
    usageLimited: true,
    usageLimitDetails: limited.details,
    stuckReason: null,
    usage: null,
    costUsd: null,
    provenCommands: [],
    agentCli: selected.agentCli,
    model: selected.model,
    // No session was launched, so no wall time was spent on one.
    elapsedMs: 0,
    peakContextTokens: null,
    sessionId: null,
    infraSignature: null,
  };
}

function finalizeFailure(
  result: AgentRunResult,
  attempts: readonly AgentRunResult[],
  configuredCandidateCount: number,
  infraRetries?: InfraRetrySummary,
): AgentRunResult {
  return withAttemptTelemetry(
    {
      ...result,
      // Session identifiers are provider-specific. Once a configured chain is
      // involved, a later retry may select a different CLI.
      sessionId: configuredCandidateCount > 1 ? null : result.sessionId,
    },
    attempts,
    infraRetries,
  );
}

function withAttemptTelemetry(
  result: AgentRunResult,
  attempts: readonly AgentRunResult[],
  infraRetries?: InfraRetrySummary,
): AgentRunResult {
  // Usage must accumulate across every real session, retries included, or
  // --budget silently undercounts a stage that was retried.
  const withAttempts =
    attempts.length <= 1
      ? result
      : {
          ...result,
          attempts: attempts.map(({ usage, costUsd, agentCli, model, elapsedMs, peakContextTokens }) => ({
            usage,
            costUsd,
            agentCli,
            model,
            elapsedMs,
            peakContextTokens,
          })),
        };
  return infraRetries ? { ...withAttempts, infraRetries } : withAttempts;
}

function attemptLogPathFor(logPath: string, attempt: number, agentCli: AgentCli): string {
  const extension = path.extname(logPath);
  const stem = extension ? logPath.slice(0, -extension.length) : logPath;
  return `${stem}.attempt-${attempt}-${agentCli}${extension}`;
}

async function runAgentAttempt(
  prompt: string,
  options: RunAgentOptions,
  settings: StageAgentSettings,
  provider: AgentProvider,
): Promise<AgentRunResult> {
  const { config, cwd, logPath, stageLabel } = options;
  const liveOutput = options.liveOutput ?? true;
  const shuttingDown = options.shuttingDown ?? isShuttingDown;

  const argsInput = {
    prompt,
    model: settings.model,
    effort: settings.effort,
    cwd,
    sandboxMode: options.config.sandboxMode,
    sandboxNetworkAccess: options.config.sandboxNetworkAccess,
  };
  // Resumed sessions get told they were interrupted, plus the full original
  // instructions — restating them is redundant for the session's context but
  // carries anything (like fresh verify output) rebuilt since the interrupt.
  const resumeArgs = options.resume
    ? provider.buildResumeArgs({
        ...argsInput,
        prompt: `${resumeContinuePrompt(options.resume.cause ?? 'usage-limit')}\n\n${prompt}`,
        sessionId: options.resume.sessionId,
      })
    : null;
  if (options.resume && !resumeArgs) {
    console.log(`${formatOutputPrefix('loop', stageLabel)} ${settings.agentCli} cannot resume sessions — starting fresh instead.`);
  }
  if (resumeArgs) {
    console.log(`${formatOutputPrefix('loop', stageLabel)} resuming ${settings.agentCli} session ${options.resume!.sessionId}.`);
  }
  const args = resumeArgs ?? provider.buildArgs(argsInput);

  mkdirSync(path.dirname(logPath), { recursive: true });

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    let combined = '';
    let stderrCombined = '';
    let lineBuffer = '';
    let stuckReason: AgentStuckReason = null;
    let settled = false;
    let lastResultEvent: Extract<CanonicalAgentEvent, { type: 'result' }> | null = null;
    // High-water mark, not a running total: a mid-session compaction lowers the
    // next request's context but must not lower the peak already reached.
    let peakContextTokens: number | null = null;
    const display = new AgentStreamDisplay({
      enabled: liveOutput,
      showThinking: config.showThinking,
      label: stageLabel,
      fallbackModel: settings.model === 'auto' ? '' : settings.model,
    });
    const evidence = createEvidenceTracker({ worktreeRoot: cwd });
    const loopPrefix = formatOutputPrefix('loop', stageLabel);

    // A stage boundary is structure, not a footnote: bold opens the block that
    // the dimmed agent stream below it fills.
    // Opens the rail the agent's gutter runs down and `└` below closes.
    console.log(
      `${loopPrefix} ${stage(`starting ${settings.agentCli} session`)} ` +
        detail(
          `(model=${settings.model}${settings.effort ? `; effort=${settings.effort}` : ''}; live=${liveOutput ? 'on' : 'off'}; wall=${formatDuration(config.agentTimeoutMs)}, idle=${formatDuration(config.agentIdleTimeoutMs)})`,
        ),
    );

    const handleLine = (line: string): void => {
      const turnContext = provider.parseTurnContextTokens(line);
      if (turnContext !== null && (peakContextTokens === null || turnContext > peakContextTokens)) {
        peakContextTokens = turnContext;
      }
      const parsed = provider.parseLine(line);
      if (!parsed) return;
      // Provider duration fields are inconsistent (and Codex omits one), so
      // Loop owns the stage clock and reports the same wall-time definition
      // for every provider.
      const event =
        parsed.type === 'result'
          ? { ...parsed, durationMs: Math.max(1, Date.now() - startedAt) }
          : parsed;
      if (event.type === 'result') lastResultEvent = event;
      // Evidence observations must follow stream order: tool starts may
      // invalidate, exec results may prove — see agent/evidence.ts.
      if (event.type === 'tool-call-start') {
        evidence.observeToolUse(event.toolName ?? 'unknown', event.toolInput ?? {});
      } else if (event.type === 'tool-call-result' && event.exec) {
        evidence.observeExec(event.exec.command, event.exec.ok);
      }
      display.handleEvent(event);
    };

    const ingest = (chunk: Buffer | string, stream: 'stdout' | 'stderr'): void => {
      const text = chunk.toString();
      combined += text;
      lastOutputAt = Date.now();

      if (stream === 'stderr') {
        stderrCombined += text;
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          if (!liveOutput) continue;
          // Agent stderr belongs to the same rail as its stdout, and is the one
          // stream nothing truncates — so it is also the one most likely to
          // break the gutter without wrapping.
          const stderrPrefix = formatOutputPrefix('agent', stageLabel, 'stderr');
          // ` │ ` sits between the prefix and the text, as on the stdout rail.
          for (const wrapped of wrapToWidth(line, contentWidth(stderrPrefix, 3))) {
            console.error(`${stderrPrefix} ${caution('│')} ${wrapped}`);
          }
        }
        return;
      }

      lineBuffer += text;
      let newlineIdx = lineBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        if (line) handleLine(line);
        newlineIdx = lineBuffer.indexOf('\n');
      }
    };

    const child = spawn(provider.binaryName, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group on Unix so we can kill the full agent tree (CLI + shell children).
      detached: process.platform !== 'win32',
    });
    registerActiveChild(child);
    options.onSpawn?.(child);

    child.stdout?.on('data', (chunk) => ingest(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => ingest(chunk, 'stderr'));

    const heartbeat = liveOutput
      ? null
      : setInterval(() => {
          const elapsed = Date.now() - startedAt;
          const idle = Date.now() - lastOutputAt;
          console.log(
            `${loopPrefix} agent running… elapsed ${formatDuration(elapsed)}, idle ${formatDuration(idle)}`,
          );
        }, config.heartbeatIntervalMs);

    const stopAgent = (reason: AgentStuckReason, signal: NodeJS.Signals): void => {
      stuckReason = reason;
      killProcessTree(child, signal);
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 5000);
    };

    const wallTimeout = setTimeout(() => {
      stopAgent('wall-timeout', 'SIGTERM');
    }, config.agentTimeoutMs);

    const idleTimeout = setInterval(() => {
      if (Date.now() - lastOutputAt >= config.agentIdleTimeoutMs) {
        stopAgent('idle-timeout', 'SIGTERM');
      }
    }, Math.min(config.heartbeatIntervalMs, config.agentIdleTimeoutMs));

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      unregisterActiveChild(child);
      display.flush();
      if (heartbeat) clearInterval(heartbeat);
      clearInterval(idleTimeout);
      clearTimeout(wallTimeout);

      if (shuttingDown()) {
        stuckReason = 'interrupted';
        combined += `\n[loop] interrupted by signal (child signal=${signal ?? 'none'}, code=${code ?? 'none'})\n`;
      } else if (stuckReason) {
        combined += `\n[loop] agent killed: ${stuckReason} (signal=${signal ?? 'none'}, code=${code ?? 'none'})\n`;
      }

      if (lineBuffer.trim()) handleLine(lineBuffer.trim());
      display.flush();

      writeFileSync(logPath, combined);

      const usage = provider.extractUsage(combined);
      // On a successful run, don't scan tool output / timestamps for limit
      // phrasings (false positives on "429" in ms values) — probe stderr only.
      const failed = stuckReason !== null || code !== 0 || lastResultEvent?.ok === false;
      const resultText = lastResultEvent?.text;
      const usageProbe = failed && resultText ? `${stderrCombined}\n${resultText}` : stderrCombined;

      // Classified over the same conservative probe as usage limits, and only
      // once a limit is ruled out: a quota hit is also a provider fault, but
      // its remedy is to wait for the window, not to retry immediately.
      const infraSignature: InfraErrorSignature | null =
        failed && !provider.isUsageLimitError(usageProbe) && provider.isInfraError(usageProbe)
          ? parseInfraError(usageProbe) ?? 'provider-reported'
          : null;

      const sessionId = provider.extractSessionId(combined);
      // A provider only implements `sessionContextPeak` when it holds a better
      // measurement than the stream did — codex keeps per-request usage in its
      // rollout and emits none in `--json` — so prefer it when it answers.
      const measuredPeak =
        sessionId && provider.sessionContextPeak
          ? provider.sessionContextPeak(sessionId)
          : null;

      const base = {
        output: combined,
        usage,
        costUsd: provider.extractCostUsd(combined),
        agentCli: settings.agentCli,
        model: settings.model,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        peakContextTokens: measuredPeak ?? peakContextTokens,
        sessionId,
        infraSignature,
      };
      const limitFields = (usageLimited: boolean) => ({
        usageLimited,
        usageLimitDetails: usageLimited ? parseUsageLimitDetails(usageProbe) : null,
      });

      printStageClose(loopPrefix, {
        elapsedMs: base.elapsedMs,
        costUsd: base.costUsd,
        usage,
        peakContextTokens: base.peakContextTokens,
      });

      if (stuckReason || code !== 0) {
        resolve({
          ...base,
          ok: false,
          ...limitFields(provider.isUsageLimitError(usageProbe)),
          stuckReason,
          provenCommands: [],
        });
        return;
      }

      if (lastResultEvent?.ok === false) {
        resolve({
          ...base,
          ok: false,
          ...limitFields(provider.isUsageLimitError(usageProbe)),
          stuckReason: null,
          provenCommands: [],
        });
        return;
      }

      resolve({
        ...base,
        ok: true,
        ...limitFields(false),
        stuckReason: null,
        provenCommands: evidence.provenCommands(),
      });
    };

    child.on('error', (error) => {
      combined += `\n[loop] spawn error: ${error.message}\n`;
      finish(1, null);
    });

    child.on('close', (code, signal) => {
      finish(code, signal);
    });
  });
}
