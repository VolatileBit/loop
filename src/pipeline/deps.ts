/**
 * Injectable seams for the per-issue pipeline and its stage loops: the two
 * effectful stage runners (agent sessions and the external verify command)
 * are threaded as replaceable functions so pipeline/loop behavior — resume
 * entry points, failure tagging, triage transitions — is unit-testable
 * without spawning real agent CLIs or running a real verify command.
 */

import { runAgent } from '../agent/run-agent.js';
import { runVerifyCommand } from '../verify/run-verify.js';
import type { ShellVerifyResult, VerifyProgressOptions } from '../verify/run-verify.js';

export type PipelineDeps = {
  runAgent: typeof runAgent;
  runVerifyCommand: (
    verifyCmd: string,
    cwd: string,
    logPath: string,
    options?: VerifyProgressOptions,
  ) => ShellVerifyResult | Promise<ShellVerifyResult>;
};

export const DEFAULT_PIPELINE_DEPS: PipelineDeps = {
  runAgent,
  runVerifyCommand,
};

export function resolvePipelineDeps(deps?: Partial<PipelineDeps>): PipelineDeps {
  return { ...DEFAULT_PIPELINE_DEPS, ...deps };
}
