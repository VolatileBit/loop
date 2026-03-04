/**
 * Semantic console styling.
 *
 * Call sites say what a line *means* — a verdict, a failure, secondary detail —
 * never which colour it is, so the palette lives in one place and a line's
 * weight can be re-tuned without hunting through the codebase.
 *
 * Free use of colour is safe because nothing styled here reaches an artifact:
 * the invocation log strips ANSI before appending (see invocation-log.ts), and
 * the per-stage stream logs are written from the raw provider output.
 *
 * Emphasis encodes *importance*, not who is speaking — the `│` gutter that
 * AgentStreamDisplay adds already carries that, and it survives `NO_COLOR` and
 * the plain-text log, which is where the distinction is needed most.
 */

const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
} as const;

/**
 * Badge backgrounds: a solid block of colour behind black text, so the handful
 * of lines that decide something are findable while scrolling past thousands
 * that do not. Colour carries the meaning — red failed, amber needs a look,
 * green succeeded, cyan is a neutral marker — so a badge never has to be read
 * to know roughly what happened.
 */
const BADGE_TONES = {
  bad: '\u001b[41m',
  caution: '\u001b[43m',
  good: '\u001b[42m',
  info: '\u001b[46m',
} as const;

/**
 * Badge text: black from the 6×6×6 cube, not SGR 30.
 *
 * Bold combined with one of the *basic eight* foregrounds (30—37) is the legacy
 * signal for "use the bright variant" — one intensity bit once served for both,
 * and ECMA-48 only ever called SGR 1 "increased intensity" without saying
 * whether that meant weight or brightness. Terminals still disagree: iTerm2,
 * Terminal.app and xterm.js brighten by default; kitty, Alacritty and Ghostty
 * do not. On the ones that do, black text came out grey on the colour block.
 *
 * Palette index 16 sits outside the 0—15 legacy range, so nothing brightens it
 * and bold is free to mean weight. The *backgrounds* stay basic ANSI on
 * purpose: those follow the reader's theme, which is what makes red look red in
 * their terminal rather than in ours.
 */
const BADGE_TEXT = '\u001b[38;5;16m';

export type BadgeTone = keyof typeof BADGE_TONES;

/**
 * Worker colours, keyed by issue id so every line about one issue matches.
 * Red and yellow are excluded on purpose: they mean failure and caution
 * elsewhere, and a worker that merely hashed to red would read as a worker in
 * trouble.
 */
const WORKER_COLORS = [CODES.cyan, CODES.green, CODES.magenta, CODES.blue] as const;

let enabled: boolean | null = null;

function detectColor(): boolean {
  const { NO_COLOR, FORCE_COLOR } = process.env;
  if (NO_COLOR !== undefined && NO_COLOR !== '') return false;
  if (FORCE_COLOR !== undefined && FORCE_COLOR !== '' && FORCE_COLOR !== '0') return true;
  return process.stdout.isTTY === true;
}

/** Whether styling is active. `NO_COLOR` wins over `FORCE_COLOR`; otherwise follow stdout. */
export function colorEnabled(): boolean {
  if (enabled === null) enabled = detectColor();
  return enabled;
}

/** Force styling on or off; `null` restores environment detection (tests). */
export function setColorEnabled(value: boolean | null): void {
  enabled = value;
}

function wrap(codes: string, text: string): string {
  if (!colorEnabled() || text === '') return text;
  return `${codes}${text}${CODES.reset}`;
}

/** A stage beginning or ending — structure, not detail. */
export function stage(text: string): string {
  return wrap(CODES.bold, text);
}

/**
 * A decision, rendered as a solid colour block: review verdicts, an issue's
 * outcome, a run's final state, the header opening an iteration. Padded so the
 * background reads as a block rather than tight-fitting text.
 */
export function badge(text: string, tone: BadgeTone = 'info'): string {
  // The padding exists to give the coloured background breathing room, so it
  // goes only where there is a background — otherwise it is stray whitespace.
  // The label stays upper-case, which still reads as a label unstyled.
  return colorEnabled() ? wrap(BADGE_TONES[tone] + BADGE_TEXT + CODES.bold, ` ${text} `) : text;
}

/** An interactive question's heading — it must not read as one more log line. */
export function question(text: string): string {
  return wrap(CODES.bold, text);
}

/** Something passed, merged, or completed. */
export function good(text: string): string {
  return wrap(CODES.green, text);
}

/** Something failed, escalated, or stopped the run. */
export function bad(text: string): string {
  return wrap(CODES.red, text);
}

/** Waiting, retrying, skipping — recoverable, but worth noticing. */
export function caution(text: string): string {
  return wrap(CODES.yellow, text);
}

/** Secondary information: tool traffic, log paths, breakdown tables. */
export function detail(text: string): string {
  return wrap(CODES.dim, text);
}

/**
 * Money. Deliberately *not* dim: a session emits hundreds of tool lines and at
 * most a handful of cost lines, and cost is what you read to decide whether to
 * keep a run going.
 */
export function cost(text: string): string {
  return wrap(CODES.bold, text);
}

/** Stable per-issue colour so every line about one worker's issue matches. */
export function worker(qualifiedId: string, text: string): string {
  let hash = 0;
  for (let index = 0; index < qualifiedId.length; index += 1) {
    hash = (hash * 31 + qualifiedId.charCodeAt(index)) >>> 0;
  }
  return wrap(WORKER_COLORS[hash % WORKER_COLORS.length]!, text);
}
