import { describe, expect, it } from 'vitest';

import { handleCtrlCPress, handleEscPress, initialInterruptState } from './state-machine.js';

describe('handleEscPress', () => {
  it('first press finishes the current issue, then exits', () => {
    const first = handleEscPress(initialInterruptState());
    expect(first.state).toMatchObject({ stopRequested: true, parkRequested: false });
    expect(first.isNewRequest).toBe(true);
    expect(first.message).toContain('finishing the current issue');
  });

  it('second press escalates to stopping at the next stage boundary', () => {
    const first = handleEscPress(initialInterruptState());
    const second = handleEscPress(first.state);
    expect(second.state).toMatchObject({ stopRequested: true, parkRequested: true });
    expect(second.isNewRequest).toBe(true);
    expect(second.message).toContain('next stage boundary');
  });

  it('further presses re-confirm rather than escalating again', () => {
    let state = handleEscPress(initialInterruptState()).state;
    state = handleEscPress(state).state;
    const third = handleEscPress(state);
    expect(third.state).toEqual(state);
    expect(third.isNewRequest).toBe(false);
    expect(third.message).toContain('already stopping');
  });
});

describe('handleCtrlCPress', () => {
  it('does not force-stop on the first press', () => {
    const first = handleCtrlCPress(initialInterruptState());
    expect(first.shouldForceStop).toBe(false);
    expect(first.state.sigintCount).toBe(1);
    expect(first.message).toContain('again to force-stop');
  });

  it('force-stops on the second press', () => {
    const first = handleCtrlCPress(initialInterruptState());
    const second = handleCtrlCPress(first.state);
    expect(second.shouldForceStop).toBe(true);
    expect(second.state.sigintCount).toBe(2);
  });

  it('a single Ctrl+C never force-stops regardless of ESC state', () => {
    const afterEsc = handleEscPress(initialInterruptState()).state;
    const ctrlC = handleCtrlCPress(afterEsc);
    expect(ctrlC.shouldForceStop).toBe(false);
  });
});
