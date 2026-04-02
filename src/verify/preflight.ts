/**
 * Readiness probe for whatever the verify command depends on — a database, a
 * running service, a built artifact.
 *
 * The environment a verify command needs was previously a documented
 * precondition that nothing enforced, so an outage produced a backlog of issues
 * each failing three fix cycles for the same reason. A probe turns that into
 * one clear stop.
 *
 * Loop deliberately never *starts* what the probe checks: bringing an
 * environment up is a side effect on the developer's own machine, and a gate
 * that migrates a live database is worse than a gate that refuses to run.
 */

import { resolveProjectPreflight } from '../config/project-settings.js';
import type { LoopConfig, PreflightConfig } from '../config/types.js';
import { bad, detail } from '../logs/style.js';
import { shell } from '../shared/shell.js';

export type PreflightResult = {
  ready: boolean;
  /** The probe that ran, or null when none is configured (always ready). */
  probe: PreflightConfig | null;
  /** Combined stdout+stderr of a failed probe; empty when ready or unconfigured. */
  output: string;
};

/**
 * Run the probe for `project`, if one is configured. `env` should be the same
 * map the sessions get, so the probe sees what the verify command will see.
 */
export function runPreflight(
  config: Pick<LoopConfig, 'preflight' | 'projects'>,
  project: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): PreflightResult {
  const probe = resolveProjectPreflight(config, project);
  if (!probe) return { ready: true, probe: null, output: '' };

  const result = shell(probe.cmd, cwd, env);
  if (result.ok) return { ready: true, probe, output: '' };
  return { ready: false, probe, output: result.output.trim() };
}

/** Failure lines for the console and the stop reason's details. */
export function describePreflightFailure(result: PreflightResult): string[] {
  if (result.ready || !result.probe) return [];
  return [
    `Probe: ${result.probe.cmd}`,
    `What to do: ${result.probe.message}`,
    ...(result.output ? [`Output: ${result.output.split('\n').slice(0, 5).join('\n        ')}`] : []),
  ];
}

/** Print the failure; the caller decides whether to stop. */
export function printPreflightFailure(project: string, result: PreflightResult): void {
  console.error(bad(`[loop] environment not ready for ${project} — not claiming work that would fail for the same reason.`));
  for (const line of describePreflightFailure(result)) console.error(detail(`  ${line}`));
}
