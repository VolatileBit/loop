/**
 * Cheap, non-destructive auth probes for agent CLIs.
 *
 * Discovered via each binary's `--help`:
 * - `claude auth status` — JSON with `loggedIn`
 * - `codex login status` — text login state
 * - `cursor agent status` — loop spawns `cursor agent …`; the standalone
 *   `agent` CLI also exposes `status|whoami`, but startup checks `cursor`.
 */

import { spawnSync } from 'node:child_process';

import type { AgentCli } from '../config/types.js';

export const AUTH_PROBE_TIMEOUT_MS = 8000;

export type AgentAuthProbeSpec = {
  /** argv suffix after `${binaryName}` */
  args: readonly string[];
  /**
   * Return a short failure reason when auth looks missing; `undefined` means OK.
   * Called only when spawn did not time out or throw.
   */
  interpret: (stdout: string, stderr: string, status: number | null) => string | undefined;
};

/** `null` = no cheap auth-status command documented for this CLI. */
export const AGENT_AUTH_PROBE: Record<AgentCli, AgentAuthProbeSpec | null> = {
  'claude-code': {
    args: ['auth', 'status'],
    interpret(stdout, _stderr, status) {
      if (status !== 0) return (stdout || _stderr || 'claude auth status failed').trim().slice(0, 200);
      try {
        const parsed = JSON.parse(stdout) as { loggedIn?: boolean };
        if (parsed.loggedIn === true) return undefined;
        if (parsed.loggedIn === false) return 'not logged in (claude auth status)';
      } catch {
        // fall through
      }
      return stdout.trim().slice(0, 200) || 'claude auth status returned unexpected output';
    },
  },
  codex: {
    args: ['login', 'status'],
    interpret(stdout, stderr, status) {
      if (status === 0) return undefined;
      return (stderr || stdout || 'codex login status failed').trim().slice(0, 200);
    },
  },
  cursor: {
    args: ['agent', 'status'],
    interpret(stdout, stderr, status) {
      if (status === 0) return undefined;
      return (stderr || stdout || 'cursor agent status failed').trim().slice(0, 200);
    },
  },
  // No auth-status subcommand exists (probed against copilot 1.0.71): auth is
  // the OAuth device flow or env tokens (COPILOT_GITHUB_TOKEN/GH_TOKEN/
  // GITHUB_TOKEN) — a logged-out CLI surfaces at the first session.
  copilot: null,
};

export type AuthProbeOutcome =
  | { ok: true }
  | { ok: false; reason: string }
  | { ok: 'skipped'; reason: string };

export function probeAgentAuth(
  binaryName: string,
  spec: AgentAuthProbeSpec,
  spawn: typeof spawnSync = spawnSync,
): AuthProbeOutcome {
  const result = spawn(binaryName, [...spec.args], {
    encoding: 'utf8',
    timeout: AUTH_PROBE_TIMEOUT_MS,
  });

  if (result.error) {
    return { ok: false, reason: result.error.message.slice(0, 200) };
  }

  const stdout = (result.stdout ?? '').toString();
  const stderr = (result.stderr ?? '').toString();
  const failure = spec.interpret(stdout, stderr, result.status);
  if (failure) return { ok: false, reason: failure };
  return { ok: true };
}
