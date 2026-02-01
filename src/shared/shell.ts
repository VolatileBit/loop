import { spawnSync } from 'node:child_process';

export type ShellResult = { ok: boolean; output: string; code: number | null };

/** Run a shell command synchronously, capturing combined stdout+stderr. */
export function shell(
  command: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ShellResult {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { ok: result.status === 0, output, code: result.status };
}
