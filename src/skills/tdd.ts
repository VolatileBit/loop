import { readRuntimeSkill } from './bundled.js';

/** Shared with the installable Markdown skill; embedded when tddSkill is builtin. */
export const BUILTIN_TDD_SKILL = readRuntimeSkill('loop-tdd');
