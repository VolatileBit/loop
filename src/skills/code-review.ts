import { readRuntimeSkill } from './bundled.js';

const REVIEW_SKILL = readRuntimeSkill('loop-code-review');

export function buildBuiltinReviewSkill(fixedPoint: string): string {
  return [
    REVIEW_SKILL,
    '',
    `Pin the supplied baseline: \`git diff ${fixedPoint}...HEAD\` and \`git log ${fixedPoint}..HEAD --oneline\`.`,
  ].join('\n');
}
