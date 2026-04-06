/**
 * Pure interrupt state machine for the loop loop's keyboard handling.
 *
 * Model:
 * - ESC requests a graceful stop: claim nothing more, let the in-flight issue finish its
 *   whole pipeline. On a verify-heavy issue that can still be another twenty minutes and
 *   half a dozen sessions.
 * - A second ESC additionally stops at the next *stage* boundary, parking the in-flight
 *   issue at its checkpoint. This is graceful in the strict sense: loop already starts a
 *   fresh session at every stage boundary and carries continuity only on disk, so parking
 *   there discards exactly what an ordinary stage transition discards — the bookkeeping is
 *   the same as a usage-limit interruption because it is the same situation.
 *   Further presses just re-confirm; there is no third level and no time window between
 *   presses, since requiring a double-tap would only punish someone who pressed once and
 *   then decided they wanted out sooner.
 * - Ctrl+C (SIGINT) requires **two** presses to force-stop, to guard against an accidental
 *   single press killing an in-progress agent run. The first press only warns; any second
 *   press (at any point during the run) force-stops immediately.
 * - SIGTERM/SIGHUP are not part of this state machine — they always force-stop immediately
 *   (external kill signals, not an interactive "mistake-prone" keypress).
 */

export type InterruptState = {
  stopRequested: boolean;
  /** Second ESC: also stop at the next stage boundary, parking the in-flight issue. */
  parkRequested: boolean;
  sigintCount: number;
};

export function initialInterruptState(): InterruptState {
  return { stopRequested: false, parkRequested: false, sigintCount: 0 };
}

export type EscResult = {
  state: InterruptState;
  message: string;
  /** True only the first time ESC transitions stopRequested false -> true. */
  isNewRequest: boolean;
};

export function handleEscPress(state: InterruptState): EscResult {
  if (state.parkRequested) {
    return {
      state,
      isNewRequest: false,
      message:
        '[loop] already stopping at the next stage boundary — the in-flight issue will be parked at its checkpoint.',
    };
  }
  if (state.stopRequested) {
    return {
      state: { ...state, parkRequested: true },
      isNewRequest: true,
      message:
        '[loop] stopping at the next stage boundary (ESC x2) — the in-flight issue is parked at its checkpoint and resumes on the next `loop run`. Ctrl+C twice still force-stops now.',
    };
  }
  return {
    state: { ...state, stopRequested: true },
    isNewRequest: true,
    message:
      '[loop] stop requested (ESC) — finishing the current issue, then exiting before the next one. Press ESC again to stop at the next stage boundary instead, or Ctrl+C twice to force-stop now.',
  };
}

export type CtrlCResult = {
  state: InterruptState;
  shouldForceStop: boolean;
  message: string;
};

export function handleCtrlCPress(state: InterruptState): CtrlCResult {
  const sigintCount = state.sigintCount + 1;
  const nextState = { ...state, sigintCount };

  if (sigintCount >= 2) {
    return {
      state: nextState,
      shouldForceStop: true,
      message: '[loop] force-stop requested (Ctrl+C x2) — killing the current agent process now.',
    };
  }

  return {
    state: nextState,
    shouldForceStop: false,
    message:
      '[loop] press Ctrl+C again to force-stop immediately, or press ESC to gracefully finish the current task and exit.',
  };
}
