/**
 * Minimal Q&A seam for the guided init flow. Only the raw question primitive
 * touches stdin/stdout, so tests script the whole flow by injecting an Asker
 * that replays canned answers.
 *
 * Two things about readline shape this module:
 *
 * 1. With `terminal: true` (any TTY), readline **owns the input line** and
 *    repaints it from its *own* prompt — which defaults to `"> "`. Writing the
 *    question straight to stdout therefore survives only until the first
 *    repaint, and `loop init` asks its later questions after a multi-minute
 *    discovery session has streamed output, which makes a repaint certain. So
 *    the question block goes to stdout and readline is given only the short
 *    marker to repaint.
 * 2. A question is a *block*, not a log line: a bare `Prompt [default]:` reads
 *    like one more line of output, and a bracketed default with no instruction
 *    reads like a yes/no — inviting the answer "no", which would then be
 *    written into the config as, say, the verify command.
 */

import readline from 'node:readline';

import { detail, question as styleQuestion } from '../logs/style.js';

/** The only thing readline repaints. Everything else is written as a block above it. */
const INPUT_MARKER = '> ';

export type Asker = {
  /**
   * Render a question block (already-formatted lines, no trailing marker) and
   * read one line of input.
   */
  question(block: string): Promise<string>;
  close(): void;
};

/**
 * Unlike a bare readline question loop, lines that arrive while no question is
 * pending are buffered and served to later questions — so answers can be piped
 * in up front (`printf '\n\nmy-answer\n' | loop init --interactive`) even
 * though a long discovery session runs between questions. Stdin ending before
 * every question is answered fails with a clear error instead of hanging.
 */
export function createAsker(): Asker {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  rl.setPrompt(INPUT_MARKER);
  const buffered: string[] = [];
  let pendingResolve: ((line: string) => void) | null = null;
  let pendingReject: ((error: Error) => void) | null = null;
  let closed = false;

  const eofError = (): Error =>
    new Error('stdin ended before every setup question was answered — aborting guided setup');

  rl.on('line', (line) => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      resolve(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (pendingReject) {
      const reject = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      reject(eofError());
    }
  });

  return {
    question(block: string): Promise<string> {
      process.stdout.write(`${block}\n`);
      const alreadyPiped = buffered.shift();
      if (alreadyPiped !== undefined) {
        // Echo the consumed answer so the transcript reads like a real session.
        process.stdout.write(`${INPUT_MARKER}${alreadyPiped}\n`);
        return Promise.resolve(alreadyPiped);
      }
      if (closed) return Promise.reject(eofError());
      // readline paints the marker itself, so a repaint redraws the marker
      // rather than clobbering the block written above it.
      rl.prompt();
      return new Promise((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
    },
    close: () => rl.close(),
  };
}

/** A blank line, the bold question, then any guidance — never one dim line. */
export function formatQuestionBlock(prompt: string, lines: string[]): string {
  return ['', styleQuestion(prompt), ...lines.map((line) => detail(line))].join('\n');
}

/** Empty answer takes the suggested default; without a default, re-asks until non-empty. */
export async function askWithDefault(asker: Asker, prompt: string, defaultValue?: string): Promise<string> {
  const guidance =
    defaultValue !== undefined
      ? [`Suggested: ${defaultValue}`, 'Press Enter to accept, or type a replacement.']
      : ['Type a value (required).'];
  for (;;) {
    const answer = (await asker.question(formatQuestionBlock(prompt, guidance))).trim();
    if (answer !== '') return answer;
    if (defaultValue !== undefined) return defaultValue;
    console.log('A value is required.');
  }
}

/**
 * Yes/no questions look deliberately different from free-text ones: the two
 * were previously indistinguishable, so "no" could be captured as a literal
 * value rather than a refusal.
 */
export async function askYesNo(asker: Asker, prompt: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  for (;;) {
    const answer = (await asker.question(formatQuestionBlock(`${prompt} ${suffix}`, []))).trim().toLowerCase();
    if (answer === '') return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    console.log('Please answer y or n.');
  }
}

export type Choice<T> = { label: string; value: T };

/** Numbered menu; empty answer takes the default index; re-asks on anything unparseable. */
export async function askChoice<T>(
  asker: Asker,
  prompt: string,
  choices: readonly Choice<T>[],
  defaultIndex = 0,
): Promise<T> {
  const guidance = [
    ...choices.map(
      (choice, index) => `  ${index + 1}. ${choice.label}${index === defaultIndex ? ' (default)' : ''}`,
    ),
    `Enter 1-${choices.length}, or press Enter for ${choices[defaultIndex]?.label ?? 'the default'}.`,
  ];
  for (;;) {
    const answer = (await asker.question(formatQuestionBlock(prompt, guidance))).trim();
    if (answer === '') return choices[defaultIndex]!.value;
    const picked = Number.parseInt(answer, 10);
    if (!Number.isNaN(picked) && picked >= 1 && picked <= choices.length) {
      return choices[picked - 1]!.value;
    }
    console.log(`Please answer with a number between 1 and ${choices.length}.`);
  }
}
