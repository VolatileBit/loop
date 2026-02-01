/**
 * Agent stdout scraping, before the provider seam.
 *
 * Every CLI was read the same way: strip ANSI, look for a handful of shapes,
 * and hope. It worked well enough for one agent and fell apart the moment a
 * second one arrived — the shapes below are Cursor's, and Claude Code's
 * `assistant` frames only survive because `looksLikeJson` hands them upward
 * untouched rather than guessing at them.
 */

export type ScrapedKind = 'text' | 'tool' | 'result' | 'error';

export type ScrapedEvent = {
  kind: ScrapedKind;
  text: string;
  /** Tool name, when the line announced one. */
  tool?: string;
};

const ANSI = new RegExp('\\[[0-9;]*[A-Za-z]', 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * A line the CLI meant as structured output rather than prose. These are handed
 * upward verbatim: guessing at a JSON frame's meaning is how the scraper got
 * reasoning text and answer text confused.
 */
export function looksLikeJson(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === '{' && last === '}') || (first === '[' && last === ']');
}

const TOOL_CALL = /^\s*(?:∙|•|\*)?\s*(?:Running|Calling|Using)\s+(?:tool\s+)?['"`]?([A-Za-z][\w.-]*)['"`]?/;
const TOOL_DONE = /^\s*(?:✓|✔|Done|Finished)\s+([A-Za-z][\w.-]*)/;
const ERROR_LINE = /^\s*(?:error|fatal|failed)\b[: ]/i;

export function extractToolName(line: string): string | null {
  const call = line.match(TOOL_CALL);
  if (call !== null && call[1] !== undefined) return call[1];
  const done = line.match(TOOL_DONE);
  if (done !== null && done[1] !== undefined) return done[1];
  return null;
}

/** One raw stdout line to an event, or null when there is nothing worth saying. */
export function scrapeLine(rawLine: string): ScrapedEvent | null {
  const line = stripAnsi(rawLine).replace(/\r$/, '');
  if (line.trim() === '') return null;
  if (looksLikeJson(line)) return { kind: 'result', text: line.trim() };
  if (ERROR_LINE.test(line)) return { kind: 'error', text: line.trim() };

  const tool = extractToolName(line);
  if (tool !== null) return { kind: 'tool', text: line.trim(), tool };

  return { kind: 'text', text: line.trim() };
}

export function summarize(events: readonly ScrapedEvent[]): { tools: number; errors: number; text: number } {
  let tools = 0;
  let errors = 0;
  let text = 0;
  for (const event of events) {
    if (event.kind === 'tool') tools += 1;
    else if (event.kind === 'error') errors += 1;
    else if (event.kind === 'text') text += 1;
  }
  return { tools, errors, text };
}
