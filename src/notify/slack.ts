/**
 * Slack Block Kit rendering, kept apart from the plain message path so Slack
 * markup can never leak to a generic consumer — which may be a pager, or a
 * script parsing the JSON body.
 *
 * The shape of a message is chosen for how a notification is actually read: a
 * status emoji and one bold headline carry the outcome, and the accounting
 * (cost, tokens, elapsed) is demoted to a context block underneath. When a run
 * parks issues for a human, that count and the command to resume are promoted
 * *into* the headline — it is the only part a truncated phone notification
 * reliably shows.
 */

import { aggregateStageUsage, formatElapsed, type StageUsage } from '../usage/tokens.js';
import { summarizeUsage, type NotifyContext, type WebhookEvent } from './webhooks.js';

type SlackBlock =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] };

export type SlackPayload = {
  /** Fallback for clients that cannot render blocks (and for notification previews). */
  text: string;
  blocks: SlackBlock[];
};

/** Outcome → emoji. Anything unrecognized reads as "needs a look", never as success. */
function statusEmoji(event: WebhookEvent): string {
  switch (event.event) {
    case 'issue-completed':
      return ':white_check_mark:';
    case 'issue-escalated':
      return ':raising_hand:';
    case 'usage-limit':
      return ':hourglass:';
    case 'run-completed':
      return event.stopReason === 'all-complete' ? ':tada:' : ':warning:';
    case 'goal-completed':
      return event.outcome === 'reached' ? ':checkered_flag:' : ':warning:';
    case 'polish-completed':
      return event.outcome === 'done' ? ':sparkles:' : ':warning:';
    case 'fix-nits-completed':
      return event.outcome === 'done' ? ':broom:' : ':warning:';
  }
}

/** The one line worth reading, already Slack-escaped by construction (no user HTML). */
function headline(context: NotifyContext, event: WebhookEvent): string {
  const scope = context.project ? ` *${context.project}*` : '';
  switch (event.event) {
    case 'issue-completed':
      return `Issue \`${event.issue.qualifiedId}\` done${scope} — ${event.issue.title}`;
    case 'issue-escalated':
      return `Issue \`${event.issue.qualifiedId}\` needs a human (${event.outcome})${scope} — ${event.issue.title}`;
    case 'run-completed': {
      const parked =
        event.issuesEscalated > 0
          ? ` — *${event.issuesEscalated} issue(s) need you*, then \`loop run --unblock${context.project ? ` ${context.project}` : ''}\``
          : '';
      const base =
        event.stopReason === 'all-complete'
          ? `Backlog complete${scope}`
          : `Run stopped${scope}: ${event.stopReason}`;
      return `${base}${parked}`;
    }
    case 'fix-nits-completed':
      return `fix-nits ${event.outcome}${scope}`;
    case 'polish-completed':
      return event.outcome === 'done'
        ? `Polish of *${event.polishedProject}* complete — nits cleared, notes distilled`
        : `Polish of *${event.polishedProject}* stopped: ${event.outcome}`;
    case 'goal-completed':
      return event.outcome === 'reached'
        ? `Goal *${event.goal}* reached after ${event.rounds} round(s) — ${event.summary}`
        : `Goal *${event.goal}* stopped: ${event.outcome} after ${event.rounds} round(s) — ${event.summary}`;
    case 'usage-limit': {
      const resets = event.resetsAt ? ` — resets ${new Date(event.resetsAt).toLocaleString()}` : '';
      return `Stopped on the ${event.scope} usage limit (policy: ${event.policy})${resets}`;
    }
  }
}

/** Accounting: rare lines that decide whether a run is worth continuing. */
function contextLine(usage: readonly StageUsage[]): string {
  const aggregate = aggregateStageUsage([...usage]);
  const parts = [summarizeUsage(usage)];
  if (aggregate.elapsedMs > 0) parts.push(formatElapsed(aggregate.elapsedMs));
  return parts.join(' · ');
}

export function buildSlackPayload(
  context: NotifyContext,
  event: WebhookEvent,
  fallbackText: string,
): SlackPayload {
  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `${statusEmoji(event)} ${headline(context, event)}` } },
  ];
  if (event.usage.length > 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: contextLine(event.usage) }] });
  }
  return { text: fallbackText, blocks };
}
