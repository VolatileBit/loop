/**
 * Drift guard for the tracked example config. Nothing in loop *reads* that
 * file, so without a test it rots silently — a renamed key or a new option
 * simply never reaches it, and the reference people copy from becomes wrong.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, makeTempRoot } from '../issues/test-helpers.js';
import { CONFIG_FILE_NAME, EXAMPLE_CONFIG_FILE_NAME, loadConfig } from './load-config.js';

afterEach(cleanupTempDirs);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const examplePath = path.join(repoRoot, EXAMPLE_CONFIG_FILE_NAME);

function exampleConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(examplePath, 'utf8')) as Record<string, unknown>;
}

describe('loop.config.example.json', () => {
  it('exists at the repo root', () => {
    expect(existsSync(examplePath)).toBe(true);
  });

  it('loads without error — every key it shows is a key loop still accepts', () => {
    const root = makeTempRoot('loop-example-config-');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, CONFIG_FILE_NAME), readFileSync(examplePath, 'utf8'));
    // loadConfig throws on unknown or mis-typed fields, which is the whole point.
    expect(() => loadConfig(root, { env: {} })).not.toThrow();
  });

  it('demonstrates every top-level option, so a new one cannot be forgotten', () => {
    const documented = new Set(Object.keys(exampleConfig()));
    const supported = Object.keys(loadConfig(makeTempRoot('loop-example-empty-'), { env: {} }));
    const missing = supported.filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });

  it('demonstrates every per-project override field', () => {
    const projects = exampleConfig().projects as Record<string, Record<string, unknown>>;
    const shown = new Set(Object.values(projects).flatMap((entry) => Object.keys(entry)));
    for (const field of [
      'verifyCmd',
      'spec',
      'model',
      'effort',
      'env',
      'preflight',
      'allowDeclaredVerify',
      'usageLimits',
    ]) {
      expect(shown.has(field), `example config never shows projects.<name>.${field}`).toBe(true);
    }
  });
});
