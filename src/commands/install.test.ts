import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCliArgs } from '../cli/args.js';
import { cleanupFixtureRepos, createFixtureRepo } from '../git/test-helpers.js';
import { chooseInstallScope, installPlanningSkills } from './install.js';

import { generate } from 'rulesync';

// Use the real dependency for success cases; inject failures only at its public API.
vi.mock('rulesync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rulesync')>();
  return { ...actual, generate: vi.fn(actual.generate) };
});
afterEach(() => { vi.mocked(generate).mockReset(); vi.unstubAllEnvs(); cleanupFixtureRepos(); });
const options = { targets: ['codexcli'] as const, force: false, dryRun: false };
const flags = () => ({ ...options, targets: [...options.targets] });

describe('install planning-skills', () => {
  it('parses the command, targets, preview, and overwrite options', () => {
    expect(parseCliArgs(['install', 'planning-skills', '--targets', 'codexcli,cursor', '--dry-run', '--force'])).toEqual({
      command: 'install', flags: { targets: ['codexcli', 'cursor'], interactive: false, dryRun: true, force: true, help: false },
    });
    expect(() => parseCliArgs(['install', 'unknown'])).toThrow(/Usage/);
    expect(() => parseCliArgs(['install', 'planning-skills', '--targets', '*'])).toThrow(/--targets/);
    expect(() => parseCliArgs(['install', 'planning-skills', '--wat'])).toThrow(/Unknown flag/);
    expect(parseCliArgs(['install', 'planning-skills', '--scope', 'user', '--interactive'])).toMatchObject({ flags: { scope: 'user', interactive: true } });
    expect(() => parseCliArgs(['install', 'planning-skills', '--scope', 'global'])).toThrow(/--scope/);
  });

  it('offers project or user scope, with explicit scope skipping the question', async () => {
    const question = vi.fn().mockResolvedValueOnce('2').mockResolvedValueOnce('1');
    const asker = { question, close: vi.fn() };
    expect(await chooseInstallScope({}, true, asker)).toBe('user');
    expect(await chooseInstallScope({}, true, asker)).toBe('project');
    expect(await chooseInstallScope({ scope: 'user' }, true, asker)).toBe('user');
    expect(await chooseInstallScope({}, false, asker)).toBe('project');
    expect(question).toHaveBeenCalledTimes(2);
  });

  it('previews and installs user skills beneath the selected home root', async () => {
    const homeRoot = createFixtureRepo();
    const userFlags = { ...flags(), scope: 'user' as const, targets: ['claudecode', 'codexcli', 'cursor', 'copilot'] as const };
    const options = { ...userFlags, targets: [...userFlags.targets] };
    const preview = await installPlanningSkills(homeRoot, { ...options, dryRun: true });
    expect(preview.written).toHaveLength(36);
    expect(existsSync(path.join(homeRoot, '.agents'))).toBe(false);
    await installPlanningSkills(homeRoot, options);
    for (const dir of ['.agents', '.claude', '.cursor', '.copilot']) {
      expect(readFileSync(path.join(homeRoot, dir, 'skills/to-spec/SKILL.md'), 'utf8')).toContain('name: to-spec');
      expect(existsSync(path.join(homeRoot, dir, 'skills/to-spec/references/loop-planning.md'))).toBe(true);
    }
    expect(existsSync(path.join(homeRoot, '.github'))).toBe(false);
    expect((await installPlanningSkills(homeRoot, options)).written).toEqual([]);
    writeFileSync(path.join(homeRoot, '.copilot/skills/to-spec/SKILL.md'), 'personal skill');
    await expect(installPlanningSkills(homeRoot, options)).rejects.toThrow(/Existing skills differ/);
    expect(readFileSync(path.join(homeRoot, '.copilot/skills/to-spec/SKILL.md'), 'utf8')).toBe('personal skill');
  });

  it('installs complete skills and companion references, and is idempotent', async () => {
    const root = createFixtureRepo();
    vi.stubEnv('PATH', ''); // No globally installed rulesync (or other CLI) can be used.
    writeFileSync(path.join(root, 'rulesync.jsonc'), '{unrelated config}');
    const installed = await installPlanningSkills(root, flags());
    expect(installed.written).toContain('.agents/skills/to-spec/references/loop-planning.md');
    expect(readFileSync(path.join(root, '.agents/skills/domain-modeling/ADR-FORMAT.md'), 'utf8')).toContain('# ADR Format');
    expect((await installPlanningSkills(root, flags())).written).toEqual([]);
    expect(readFileSync(path.join(root, 'rulesync.jsonc'), 'utf8')).toBe('{unrelated config}');
    expect(existsSync(path.join(root, '.claude'))).toBe(false);
    expect(existsSync(path.join(root, '.rulesync'))).toBe(false);
  });

  it('rejects an incomplete generated bundle before writing any project file', async () => {
    const root = createFixtureRepo();
    const actual = await vi.importActual<typeof import('rulesync')>('rulesync');
    vi.mocked(generate).mockImplementationOnce(async (options) => {
      const result = await actual.generate(options);
      rmSync(path.join(options!.outputRoots![0]!, '.agents/skills/to-spec/references'), { recursive: true });
      return result;
    });
    await expect(installPlanningSkills(root, flags())).rejects.toThrow(/omitted a required skill file/);
    expect(existsSync(path.join(root, '.agents'))).toBe(false);
  });

  it('previews without project writes', async () => {
    const root = createFixtureRepo();
    expect((await installPlanningSkills(root, { ...flags(), dryRun: true })).written.length).toBeGreaterThan(6);
    expect(existsSync(path.join(root, '.agents'))).toBe(false);
  });

  it('generates all four agent destinations using the bundled dependency', async () => {
    const root = createFixtureRepo();
    vi.stubEnv('PATH', '');
    await installPlanningSkills(root, { ...flags(), targets: ['claudecode', 'codexcli', 'cursor', 'copilot'] });
    for (const directory of ['.claude', '.agents', '.cursor', '.github']) {
      expect(readFileSync(path.join(root, directory, 'skills/to-issues/SKILL.md'), 'utf8')).toContain('name: to-issues');
      expect(readFileSync(path.join(root, directory, 'skills/to-spec/references/loop-planning.md'), 'utf8')).toContain('specsDir');
    }
  });

  it('refuses all writes on conflict, while explicit force replaces only bundled files', async () => {
    const root = createFixtureRepo();
    const existing = path.join(root, '.agents/skills/to-spec');
    mkdirSync(existing, { recursive: true });
    writeFileSync(path.join(existing, 'SKILL.md'), 'custom');
    writeFileSync(path.join(existing, 'personal.md'), 'keep');
    await expect(installPlanningSkills(root, flags())).rejects.toThrow(/Existing skills differ/);
    expect(existsSync(path.join(root, '.agents/skills/grilling'))).toBe(false);
    expect(readFileSync(path.join(existing, 'SKILL.md'), 'utf8')).toBe('custom');
    await installPlanningSkills(root, { ...flags(), force: true });
    expect(readFileSync(path.join(existing, 'SKILL.md'), 'utf8')).toContain('name: to-spec');
    expect(readFileSync(path.join(existing, 'personal.md'), 'utf8')).toBe('keep');
  });

  it('leaves the project untouched on generator failure or symlink destinations', async () => {
    const root = createFixtureRepo();
    vi.mocked(generate).mockRejectedValueOnce(new Error('Generation failed'));
    await expect(installPlanningSkills(root, flags())).rejects.toThrow(/generation failed/);
    expect(existsSync(path.join(root, '.agents'))).toBe(false);
    const outside = createFixtureRepo();
    symlinkSync(outside, path.join(root, '.agents'));
    await expect(installPlanningSkills(root, { ...flags(), force: true })).rejects.toThrow(/symlink/);
    expect(existsSync(path.join(outside, 'skills'))).toBe(false);
  });
});
