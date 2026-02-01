import { describe, expect, it } from 'vitest';

import { extractToolName, looksLikeJson, scrapeLine, stripAnsi, summarize } from './parse-output.js';

/** Escape byte, built rather than typed so the fixture survives copy/paste. */
const ESC = String.fromCharCode(27);

describe('stripAnsi', () => {
  it('removes colour codes but keeps the text', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[39m`)).toBe('red');
  });
});

describe('looksLikeJson', () => {
  it('accepts whole objects and arrays', () => {
    expect(looksLikeJson('  {"a":1}  ')).toBe(true);
    expect(looksLikeJson('[1,2]')).toBe(true);
  });

  it('rejects prose and fragments', () => {
    expect(looksLikeJson('I will now read the file')).toBe(false);
    expect(looksLikeJson('{ partial')).toBe(false);
  });
});

describe('extractToolName', () => {
  it('reads the name out of a call announcement', () => {
    expect(extractToolName('∙ Running tool `Read`')).toBe('Read');
    expect(extractToolName('Calling Bash')).toBe('Bash');
  });

  it('reads the name out of a completion line', () => {
    expect(extractToolName('✓ Edit')).toBe('Edit');
  });

  it('returns null for ordinary prose', () => {
    expect(extractToolName('running the tests now')).toBeNull();
  });
});

describe('scrapeLine', () => {
  it('ignores blank lines', () => {
    expect(scrapeLine('   ')).toBeNull();
  });

  it('classifies json, errors, tools and prose', () => {
    expect(scrapeLine('{"type":"result"}')?.kind).toBe('result');
    expect(scrapeLine('Error: boom')?.kind).toBe('error');
    expect(scrapeLine('Running tool Read')).toEqual({ kind: 'tool', text: 'Running tool Read', tool: 'Read' });
    expect(scrapeLine('just talking')).toEqual({ kind: 'text', text: 'just talking' });
  });

  it('strips ansi and trailing carriage returns first', () => {
    expect(scrapeLine(`${ESC}[32mDone Bash${ESC}[39m\r`)?.tool).toBe('Bash');
  });
});

describe('summarize', () => {
  it('counts each kind', () => {
    const events = ['Running tool Read', 'Error: nope', 'chatting', 'chatting more']
      .map((line) => scrapeLine(line))
      .filter((event): event is NonNullable<typeof event> => event !== null);
    expect(summarize(events)).toEqual({ tools: 1, errors: 1, text: 2 });
  });
});
