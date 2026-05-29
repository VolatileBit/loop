import type { AgentCli } from '../../config/types.js';
import { createClaudeCodeProvider } from './claude-code.js';
import { createCursorProvider } from './cursor.js';
import { createCodexProvider } from './codex.js';
import type { AgentProvider } from './types.js';

export type { AgentProvider, BuildArgsInput, CanonicalAgentEvent, ExecObservation } from './types.js';
export { createClaudeCodeProvider } from './claude-code.js';
export { createCursorProvider } from './cursor.js';
export { createCodexProvider } from './codex.js';

const FACTORIES: Partial<Record<AgentCli, () => AgentProvider>> = {
  'claude-code': createClaudeCodeProvider,
  cursor: createCursorProvider,
  codex: createCodexProvider,
};

/**
 * Returns a *fresh* provider instance for one agent run (providers may keep
 * per-session parse state, so instances must not be shared across parallel runs).
 */
export function resolveAgentProvider(id: AgentCli): AgentProvider {
  const factory = FACTORIES[id];
  if (!factory) throw new Error(`no provider registered for "${id}"`);
  return factory();
}
