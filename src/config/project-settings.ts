/**
 * Per-project setting resolution. A `projects.<name>` entry is the more
 * specific setting, so its `verifyCmd` wins over the global one — including
 * a whole-run `--verify-cmd` flag (which overrides the *global default* only;
 * forcing one command onto projects that exist precisely because that command
 * is wrong for them would be a footgun).
 */

import type { UsageLimitScope } from '../agent/providers/usage-limit.js';
import type { LoopConfig, PreflightConfig, UsageLimitPolicy } from './types.js';

/** The verify command gating issues of `project` (global `verifyCmd` when no override). */
export function resolveProjectVerifyCmd(
  config: Pick<LoopConfig, 'verifyCmd' | 'projects'>,
  project: string,
): string | null {
  return config.projects[project]?.verifyCmd ?? config.verifyCmd;
}

/**
 * The environment for this project's sessions and verify runs: the inherited
 * process env, then the global `env`, then the project's own — merged key by
 * key, so a project adds to the cross-cutting settings rather than replacing
 * them. Agent sessions and loop's own verify runs get the *same* map, or a
 * command an agent proved by hand would behave differently when loop re-ran it.
 */
export function resolveProjectEnv(
  config: Pick<LoopConfig, 'env' | 'projects'>,
  project: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...baseEnv, ...config.env, ...config.projects[project]?.env };
}

/**
 * The readiness probe for this project. Unlike `env`, a project's probe
 * *replaces* the global one — two probes for one claim would just be a slower
 * way to say the same thing, and the project's is the more specific statement.
 */
export function resolveProjectPreflight(
  config: Pick<LoopConfig, 'preflight' | 'projects'>,
  project: string,
): PreflightConfig | null {
  return config.projects[project]?.preflight ?? config.preflight;
}

/** Whether this project's sessions may declare a replacement verify command. */
export function resolveProjectAllowDeclaredVerify(
  config: Pick<LoopConfig, 'allowDeclaredVerify' | 'projects'>,
  project: string,
): boolean {
  return config.projects[project]?.allowDeclaredVerify ?? config.allowDeclaredVerify;
}

/** The usage-limit policy for `scope` on this project's issues (top-level `usageLimits` when no override). */
export function resolveProjectUsageLimitPolicy(
  config: Pick<LoopConfig, 'usageLimits' | 'projects'>,
  project: string,
  scope: UsageLimitScope,
): UsageLimitPolicy {
  return config.projects[project]?.usageLimits?.[scope] ?? config.usageLimits[scope];
}
