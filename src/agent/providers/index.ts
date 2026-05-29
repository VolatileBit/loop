import type { AgentCli } from '../../config/types.js';
import { createClaudeCodeProvider } from './claude-code.js';
import { createCodexProvider } from './codex.js';
import { createCopilotProvider } from './copilot.js';
import { createCursorProvider } from './cursor.js';
import type { AgentProvider } from './types.js';

export type { AgentProvider, BuildArgsInput, CanonicalAgentEvent, ExecObservation } from './types.js';
export { isSharedUsageLimitError, SHARED_USAGE_LIMIT_RE } from './usage-limit.js';
export { createClaudeCodeProvider } from './claude-code.js';
export { createCodexProvider } from './codex.js';
export { createCopilotProvider, COPILOT_DENIED_REMOTE_TOOLS } from './copilot.js';
export { createCursorProvider } from './cursor.js';

const FACTORIES: Record<AgentCli, () => AgentProvider> = {
  cursor: createCursorProvider,
  'claude-code': createClaudeCodeProvider,
  codex: createCodexProvider,
  copilot: createCopilotProvider,
};

/**
 * Returns a *fresh* provider instance for one agent run (providers may keep
 * per-session parse state, so instances must not be shared across parallel runs).
 */
export function resolveAgentProvider(id: AgentCli): AgentProvider {
  return FACTORIES[id]();
}
