import { describe, expect, it, vi } from 'vitest';

import { askChoice, askWithDefault, askYesNo, formatQuestionBlock, type Asker } from './ask.js';

/** Replays canned answers and records every block it was asked to render. */
function scriptedAsker(answers: string[]): Asker & { blocks: string[] } {
  const blocks: string[] = [];
  return {
    blocks,
    question: (block: string) => {
      blocks.push(block);
      const next = answers.shift();
      if (next === undefined) throw new Error('scripted asker ran out of answers');
      return Promise.resolve(next);
    },
    close: () => {},
  };
}

describe('formatQuestionBlock', () => {
  it('renders a block, not one more log line', () => {
    const block = formatQuestionBlock('Verify command', ['Suggested: pnpm verify']);
    const lines = block.split('\n');
    // Leading blank line separates the question from whatever streamed above it.
    expect(lines[0]).toBe('');
    expect(lines[1]).toBe('Verify command');
    expect(lines[2]).toBe('Suggested: pnpm verify');
  });
});

describe('askWithDefault', () => {
  it('states how to accept the suggestion, so a bare default cannot read as a yes/no', async () => {
    const asker = scriptedAsker(['']);
    await expect(askWithDefault(asker, 'Verify command', 'pnpm verify')).resolves.toBe('pnpm verify');
    expect(asker.blocks[0]).toContain('Suggested: pnpm verify');
    expect(asker.blocks[0]).toContain('Press Enter to accept, or type a replacement.');
  });

  it('takes a typed replacement over the suggestion', async () => {
    const asker = scriptedAsker(['npm test']);
    await expect(askWithDefault(asker, 'Verify command', 'pnpm verify')).resolves.toBe('npm test');
  });

  it('re-asks when no default exists and the answer is empty', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const asker = scriptedAsker(['', '  ', 'issues']);
    try {
      await expect(askWithDefault(asker, 'Issues directory')).resolves.toBe('issues');
      expect(asker.blocks).toHaveLength(3);
    } finally {
      log.mockRestore();
    }
  });
});

describe('askYesNo', () => {
  it('looks unmistakably like a yes/no question', async () => {
    const asker = scriptedAsker(['']);
    await askYesNo(asker, 'Add a projects.<name> override entry?', false);
    expect(asker.blocks[0]).toContain('[y/N]');
  });

  it('honours the default on an empty answer, in both directions', async () => {
    await expect(askYesNo(scriptedAsker(['']), 'Proceed?', true)).resolves.toBe(true);
    await expect(askYesNo(scriptedAsker(['']), 'Proceed?', false)).resolves.toBe(false);
  });

  it('accepts y/yes/n/no in any case', async () => {
    await expect(askYesNo(scriptedAsker(['Y']), 'Proceed?')).resolves.toBe(true);
    await expect(askYesNo(scriptedAsker(['yes']), 'Proceed?')).resolves.toBe(true);
    await expect(askYesNo(scriptedAsker(['N']), 'Proceed?')).resolves.toBe(false);
    await expect(askYesNo(scriptedAsker(['no']), 'Proceed?')).resolves.toBe(false);
  });

  it('re-asks rather than guessing at anything else', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const asker = scriptedAsker(['maybe', 'y']);
    try {
      await expect(askYesNo(asker, 'Proceed?')).resolves.toBe(true);
      expect(asker.blocks).toHaveLength(2);
    } finally {
      log.mockRestore();
    }
  });
});

describe('askChoice', () => {
  it('lists the options and names the one Enter selects', async () => {
    const asker = scriptedAsker(['']);
    const choices = [
      { label: 'cursor', value: 'cursor' },
      { label: 'claude-code', value: 'claude-code' },
    ];
    await expect(askChoice(asker, 'Which agent CLI?', choices, 1)).resolves.toBe('claude-code');
    expect(asker.blocks[0]).toContain('2. claude-code (default)');
    expect(asker.blocks[0]).toContain('Enter 1-2, or press Enter for claude-code.');
  });

  it('re-asks on anything unparseable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const asker = scriptedAsker(['9', 'nope', '1']);
    try {
      await expect(
        askChoice(asker, 'Pick', [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]),
      ).resolves.toBe('a');
      expect(asker.blocks).toHaveLength(3);
    } finally {
      log.mockRestore();
    }
  });
});
