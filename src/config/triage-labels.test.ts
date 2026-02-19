import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRIAGE_LABELS,
  resolveTriageLabels,
  roleForLabel,
  TRIAGE_ROLES,
} from './triage-labels.js';

describe('DEFAULT_TRIAGE_LABELS', () => {
  it('covers every role with loop generic defaults', () => {
    expect(Object.keys(DEFAULT_TRIAGE_LABELS).sort()).toEqual([...TRIAGE_ROLES].sort());
    expect(DEFAULT_TRIAGE_LABELS.readyForAgent).toBe('ready');
    expect(DEFAULT_TRIAGE_LABELS.readyForHuman).toBe('needs-human');
    expect(DEFAULT_TRIAGE_LABELS.done).toBe('done');
    expect(DEFAULT_TRIAGE_LABELS.verifyFailed).toBe('verify-failed');
  });
});

describe('resolveTriageLabels', () => {
  it('returns the full default set when no overrides are configured', () => {
    expect(resolveTriageLabels({})).toEqual(DEFAULT_TRIAGE_LABELS);
    expect(resolveTriageLabels({ triageLabels: {} })).toEqual(DEFAULT_TRIAGE_LABELS);
  });

  it('applies a full override set (repo-pinned label strings)', () => {
    const pinned = {
      needsTriage: 'needs-triage',
      needsInfo: 'needs-info',
      readyForAgent: 'ready-for-agent',
      readyForHuman: 'ready-for-human',
      delegatedToHuman: 'delegated-to-human',
      wontfix: 'wontfix',
      inProgress: 'in-progress',
      done: 'agent-done',
      verifyFailed: 'verify-failed',
      agentFailed: 'agent-failed',
      agentInterrupted: 'agent-interrupted',
    } as const;
    expect(resolveTriageLabels({ triageLabels: pinned })).toEqual(pinned);
  });

  it('merges partial overrides over the defaults', () => {
    const labels = resolveTriageLabels({
      triageLabels: { done: 'agent-done', readyForAgent: 'ready-for-agent' },
    });
    expect(labels.done).toBe('agent-done');
    expect(labels.readyForAgent).toBe('ready-for-agent');
    expect(labels.readyForHuman).toBe(DEFAULT_TRIAGE_LABELS.readyForHuman);
    expect(labels.verifyFailed).toBe(DEFAULT_TRIAGE_LABELS.verifyFailed);
  });

  it('does not mutate the shared default object', () => {
    resolveTriageLabels({ triageLabels: { done: 'custom-done' } });
    expect(DEFAULT_TRIAGE_LABELS.done).toBe('done');
  });
});

describe('roleForLabel', () => {
  it('maps a label string back to its role for the resolved set', () => {
    const labels = resolveTriageLabels({ triageLabels: { done: 'agent-done' } });
    expect(roleForLabel('agent-done', labels)).toBe('done');
    expect(roleForLabel('ready', labels)).toBe('readyForAgent');
    expect(roleForLabel('done', labels)).toBeNull();
    expect(roleForLabel('unknown', labels)).toBeNull();
  });
});
