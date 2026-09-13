import { readFileSync } from 'node:fs';

/** Markdown is shared by packaged skills and injected prompts; no second copy to drift. */
export function readRuntimeSkill(name: 'loop-tdd' | 'loop-code-review' | 'loop-handoff'): string {
  const url = new URL(`./runtime/${name}/SKILL.md`, import.meta.url);
  return readFileSync(url, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}
