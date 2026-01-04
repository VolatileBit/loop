/**
 * Small environment helpers used while the config loader was finding its shape.
 */

export function readFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name];
  return raw === '1' || raw === 'true';
}

export function readNumber(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
