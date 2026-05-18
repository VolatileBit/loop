/**
 * Outbound notifications for the signals worth interrupting a human for — an
 * issue completing, an issue needing a human, an invocation ending, a fix-nits
 * batch finishing. Deliberately no progress or heartbeat events: webhooks are
 * for walking away from a run, not watching it.
 *
 * Delivery is fire-and-forget with a hard per-request timeout; failures are
 * console warnings and never stop a run — a dead Slack hook must not stop an
 * eight-hour backlog.
 */

import type { UsageLimitDetails } from '../agent/providers/usage-limit.js';
import type { UsageLimitPolicy, WebhookConfig, WebhookEventName } from '../config/types.js';
import { totalKnownCostUsd, totalTokens, formatCompactNumber, type StageUsage } from '../usage/tokens.js';
import { buildSlackPayload } from './slack.js';

export type WebhookEvent =
  | { event: 'issue-completed'; issue: { qualifiedId: string; title: string }; usage: StageUsage[] }
  | {
      event: 'issue-escalated';
      issue: { qualifiedId: string; title: string };
      /** The pipeline outcome that escalated it (verify-failed, needs-human, merge-conflict…). */
      outcome: string;
      usage: StageUsage[];
    }
  | {
      event: 'run-completed';
      stopReason: string;
      issuesProcessed: number;
      /** Issues parked for a human during this run — the backlog kept going past them. */
      issuesEscalated: number;
      /**
       * Issues a person owns (`delegated`). Reported separately so "backlog
       * complete" can never stand in for "complete, except your part".
       */
      issuesDelegated?: number;
      usage: StageUsage[];
    }
  | { event: 'fix-nits-completed'; outcome: string; fixed?: number; dismissed?: number; usage: StageUsage[] }
  | {
      event: 'polish-completed';
      /** The project that was polished. */
      polishedProject: string;
      /** `done`, or the phase that failed (`nits-failed`, `distill-failed`). */
      outcome: string;
      usage: StageUsage[];
    }
  | {
      event: 'goal-completed';
      goal: string;
      /** Why the goal loop ended: the evaluator's terminal verdicts, or a loop guard. */
      outcome: string;
      rounds: number;
      summary: string;
      usage: StageUsage[];
    }
  | {
      event: 'usage-limit';
      /** Which provider limit window was hit. */
      scope: 'session' | 'weekly';
      /** The resolved policy that made the run stop ('wait' here means the wait gave up). */
      policy: 'wait' | 'stop';
      /** Best-effort reset time (ISO), when the CLI reported one. */
      resetsAt: string | null;
      usage: StageUsage[];
    };

/** The `usage-limit` webhook event — sent when a limit makes a run stop (never when it just waits). */
export function usageLimitEvent(
  details: UsageLimitDetails | null,
  policy: UsageLimitPolicy,
  usage: StageUsage[],
): WebhookEvent {
  return {
    event: 'usage-limit',
    scope: details?.scope ?? 'session',
    policy,
    resetsAt: details?.resetsAtMs != null ? new Date(details.resetsAtMs).toISOString() : null,
    usage,
  };
}

export type NotifyContext = {
  repoRoot: string;
  /** The `loop run [project]` filter, when one was given. */
  project: string | null;
};

/** Compact "N tokens[ · $X.YZ]" summary; cost shown only when some CLI reported one. */
export function summarizeUsage(entries: readonly StageUsage[]): string {
  const tokens = entries.reduce((sum, entry) => sum + totalTokens(entry), 0);
  const costKnown = entries.some((entry) => entry.costUsd !== undefined);
  const cost = costKnown ? ` · $${totalKnownCostUsd(entries).toFixed(2)}` : '';
  return `${formatCompactNumber(tokens)} tokens${cost}`;
}

export function buildEventMessage(context: NotifyContext, event: WebhookEvent): string {
  const prefix = context.project ? `loop [${context.project}]` : 'loop';
  switch (event.event) {
    case 'issue-completed':
      return `${prefix} issue ${event.issue.qualifiedId} done — ${event.issue.title} (${summarizeUsage(event.usage)})`;
    case 'issue-escalated':
      return (
        `${prefix} issue ${event.issue.qualifiedId} needs a human (${event.outcome}) — ${event.issue.title}. ` +
        `Fix the cause, then \`loop run --unblock${context.project ? ` ${context.project}` : ''}\`.`
      );
    case 'run-completed': {
      const escalatedNote = event.issuesEscalated > 0 ? `, ${event.issuesEscalated} escalated to a human` : '';
      const delegatedNote = event.issuesDelegated ? `, ${event.issuesDelegated} owned by a human` : '';
      const summary = `${event.issuesProcessed} issue${event.issuesProcessed === 1 ? '' : 's'} processed${escalatedNote}${delegatedNote}, ${summarizeUsage(event.usage)}`;
      return event.stopReason === 'all-complete'
        ? `${prefix} backlog complete 🎉 — ${summary}`
        : `${prefix} run stopped: ${event.stopReason} — ${summary}`;
    }
    case 'fix-nits-completed': {
      const detail =
        event.fixed !== undefined && event.dismissed !== undefined
          ? ` (${event.fixed} fixed, ${event.dismissed} dismissed)`
          : '';
      return `${prefix} fix-nits ${event.outcome}${detail} — ${summarizeUsage(event.usage)}`;
    }
    case 'polish-completed':
      return event.outcome === 'done'
        ? `${prefix} polish of ${event.polishedProject} complete ✨ — nits cleared, notes distilled into CONTEXT.md (${summarizeUsage(event.usage)})`
        : `${prefix} polish of ${event.polishedProject} stopped: ${event.outcome}`;
    case 'goal-completed': {
      const rounds = `${event.rounds} round${event.rounds === 1 ? '' : 's'}`;
      return event.outcome === 'reached'
        ? `${prefix} goal reached 🏁 after ${rounds} — ${event.summary} (${summarizeUsage(event.usage)})`
        : `${prefix} goal stopped: ${event.outcome} after ${rounds} — ${event.summary}`;
    }
    case 'usage-limit': {
      const resetNote = event.resetsAt
        ? ` — resets ${new Date(event.resetsAt).toLocaleString()}`
        : '';
      return `${prefix} stopped on the ${event.scope} usage limit (policy: ${event.policy})${resetNote}. Resume when the limit lifts.`;
    }
  }
}

/**
 * `${VAR}` references resolve from the environment so tokens never live in the
 * tracked config file. A reference to an unset variable invalidates the value
 * (returns null) rather than sending a request with a literal `${...}` in it.
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let missing = false;
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      missing = true;
      return '';
    }
    return resolved;
  });
  return missing ? null : expanded;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

const DELIVERY_TIMEOUT_MS = 5000;

async function deliver(
  webhook: WebhookConfig,
  context: NotifyContext,
  event: WebhookEvent,
  fetchImpl: FetchLike,
): Promise<void> {
  const url = expandEnv(webhook.url);
  if (url === null) {
    console.warn(
      `[loop] warning: webhook url references an unset environment variable — skipping (${webhook.url})`,
    );
    return;
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [name, rawValue] of Object.entries(webhook.headers ?? {})) {
    const value = expandEnv(rawValue);
    if (value === null) {
      console.warn(
        `[loop] warning: webhook header "${name}" references an unset environment variable — skipping webhook`,
      );
      return;
    }
    headers[name] = value;
  }

  const message = buildEventMessage(context, event);
  const costKnown = event.usage.some((entry) => entry.costUsd !== undefined);
  const body =
    webhook.format === 'slack'
      ? JSON.stringify(buildSlackPayload(context, event, message))
      : JSON.stringify({
          ...event,
          usage: summarizeUsage(event.usage),
          costUsd: costKnown ? totalKnownCostUsd(event.usage) : null,
          project: context.project,
          repoRoot: context.repoRoot,
          message,
          timestamp: new Date().toISOString(),
        });

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[loop] warning: webhook delivery failed (HTTP ${response.status}): ${url}`);
    }
  } catch (error) {
    console.warn(`[loop] warning: webhook delivery failed (${(error as Error).message}): ${url}`);
  }
}

export type Notifier = (event: WebhookEvent) => Promise<void>;

/**
 * One notifier per invocation. Sends to every configured webhook whose event
 * filter matches; awaits deliveries (each individually time-bounded) so the
 * process doesn't exit with notifications still in flight.
 */
export function createNotifier(
  webhooks: readonly WebhookConfig[],
  context: NotifyContext,
  fetchImpl: FetchLike = fetch,
): Notifier {
  return async (event) => {
    const matching = webhooks.filter(
      (webhook) => !webhook.events || webhook.events.includes(event.event as WebhookEventName),
    );
    await Promise.all(matching.map((webhook) => deliver(webhook, context, event, fetchImpl)));
  };
}
