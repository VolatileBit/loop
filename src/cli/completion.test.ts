import { describe, expect, it } from 'vitest';

import { generateCompletionScript } from './completion.js';

describe('generateCompletionScript', () => {
  it('generates a bash script that shells out to loop __complete', () => {
    const script = generateCompletionScript('bash');
    expect(script).toContain('loop __complete --');
    expect(script).toContain('compgen');
    expect(script).toContain('complete -o default -F _loop_complete loop');
  });

  it('generates a zsh script that shells out to loop __complete', () => {
    const script = generateCompletionScript('zsh');
    expect(script).toContain('loop __complete --');
    expect(script).toContain('compadd');
    expect(script).toContain('compdef _loop loop');
  });
});
