import { describe, expect, it } from 'vitest';

import { collectStageEffortErrors, validateEffortForAgent } from './effort.js';
import { DEFAULT_CONFIG } from './load-config.js';
import type { LoopConfig } from './types.js';

function config(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('validateEffortForAgent', () => {
  it('rejects effort for cursor', () => {
    expect(validateEffortForAgent('cursor', 'high')).toMatch(/not supported by the cursor agent CLI/);
  });

  it('accepts claude and codex levels documented by each CLI', () => {
    expect(validateEffortForAgent('claude-code', 'xhigh')).toBeNull();
    expect(validateEffortForAgent('codex', 'minimal')).toBeNull();
  });

  it('rejects unknown levels per provider', () => {
    expect(validateEffortForAgent('claude-code', 'minimal')).toMatch(/not valid for claude-code/);
    expect(validateEffortForAgent('codex', 'bogus')).toMatch(/not valid for codex/);
  });
});

describe('collectStageEffortErrors', () => {
  it('flags cursor stages with effort configured', () => {
    const cfg = config({ effort: 'high' });
    expect(collectStageEffortErrors(cfg, {}, ['implement'])).toEqual([
      expect.stringMatching(/Stage "implement": effort is not supported by the cursor agent CLI/),
    ]);
  });

  it('validates effort against the resolved provider per stage', () => {
    const cfg = config({
      stages: {
        implement: { agentCli: 'claude-code', effort: 'minimal' },
        review: { agentCli: 'codex', effort: 'high' },
      },
    });
    expect(collectStageEffortErrors(cfg, {}, ['implement', 'review'])).toEqual([
      expect.stringMatching(/Stage "implement": effort "minimal" is not valid for claude-code/),
    ]);
  });

  it('passes when effort is unset or valid for the resolved agent', () => {
    const cfg = config({
      stages: {
        implement: { agentCli: 'claude-code', effort: 'high' },
        review: { agentCli: 'codex', effort: 'medium' },
      },
    });
    expect(collectStageEffortErrors(cfg, {}, ['implement', 'review'])).toEqual([]);
  });

  it('validates configured fallback effort against its own CLI', () => {
    const cfg = config({
      agentCli: 'codex',
      fallbackAgents: [
        { agentCli: 'claude-code', effort: 'minimal' },
        { agentCli: 'cursor', effort: 'high' },
      ],
    });

    expect(collectStageEffortErrors(cfg, {}, ['implement'])).toEqual([
      expect.stringMatching(
        /Stage "implement" fallback "claude-code": effort "minimal" is not valid/,
      ),
      expect.stringMatching(
        /Stage "implement" fallback "cursor": effort is not supported/,
      ),
    ]);
  });
});
