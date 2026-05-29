/**
 * Common bookkeeping after a successful agent stage: persist an agent-authored
 * handoff note for the next stage and return the parsed commit-type suggestion
 * (if the agent supplied one). Usage is recorded immediately after runAgent so
 * failed and usage-limited attempts are retained too.
 */

import { parseCommitSuggestion, type CommitSuggestion } from '../git/commit.js';
import { parseHandoffNote, writeHandoffIfPresent, type HandoffRef } from '../handoff/handoff.js';
import { extractAgentResultText, type AgentRunResult } from './run-agent.js';

export function afterAgentStage(
  result: AgentRunResult,
  root: string,
  issue: HandoffRef,
): CommitSuggestion | null {
  const text = extractAgentResultText(result);
  writeHandoffIfPresent(root, issue, parseHandoffNote(text));
  return parseCommitSuggestion(text);
}
