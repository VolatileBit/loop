/**
 * Renders canonical agent events as a readable live console stream.
 *
 * Every line the agent produces carries a `│` gutter after the prefix, and the
 * continuation lines of a multi-line message hold the same column. The result
 * is a continuous vertical rail: a session reads as one quoted block, and
 * loop's own lines break out of it because they have no gutter. The rail is a
 * *character*, not a colour, so it survives `NO_COLOR` and the plain-text
 * invocation log — which is where telling loop from the agent matters most.
 *
 * Providers stream assistant/thinking text as *incremental* deltas (each event
 * carries only the new piece), then sometimes — but not always — a
 * consolidated event with the full text. We buffer deltas per text block and
 * flush a single clean line when the block ends (a consolidated message, a
 * thinking completion, a tool call, or the final result), so output reads as
 * whole messages rather than one token per line.
 */

import { formatDuration, truncate } from './format.js';
import { contentWidth, formatOutputPrefix, prefixWidth, wrapToWidth } from '../logs/output-prefix.js';
import { bad, detail, good } from '../logs/style.js';
import type { CanonicalAgentEvent } from './providers/types.js';

/** The rail every agent-side line hangs from. */
const GUTTER = '│';

export type StreamWriter = (chunk: string) => void;

export type AgentStreamDisplayOptions = {
  /**
   * Live console echo. Pass `false` to suppress all output while still
   * accepting events (used when maxParallelRuns > 1 — N interleaved raw
   * streams would be unreadable noise; the caller decides).
   */
  enabled?: boolean;
  showThinking?: boolean;
  write?: StreamWriter;
  /** e.g. "SPEC-006/issue-07-implement" — appended to [agent]/[think] prefixes for context. Empty = plain [agent]/[think]. */
  label?: string;
  /** Model requested by the caller, used when the provider's session event omits it. */
  fallbackModel?: string;
};

export class AgentStreamDisplay {
  private readonly enabled: boolean;
  private readonly showThinking: boolean;
  private readonly write: StreamWriter;
  private readonly label: string;
  private readonly fallbackModel: string;

  private bufferKind: 'assistant' | 'thinking' | null = null;
  private buffer = '';

  constructor(options: AgentStreamDisplayOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.showThinking = options.showThinking ?? true;
    this.write = options.write ?? ((chunk) => process.stdout.write(chunk));
    this.label = options.label ?? '';
    this.fallbackModel = options.fallbackModel ?? '';
  }

  private prefix(kind: 'assistant' | 'thinking'): string {
    const base = kind === 'thinking' ? 'think' : 'agent';
    return formatOutputPrefix(base, this.label);
  }

  /** Blank space the width of a prefix, so continuation lines hold its column. */
  private continuation(prefix: string): string {
    return ' '.repeat(prefixWidth(prefix));
  }

  /** Columns for the text itself: `${prefix} ${GUTTER} ` precedes every line. */
  private textWidth(prefix: string): number {
    return contentWidth(prefix, GUTTER.length + 2);
  }

  private setBufferKind(kind: 'assistant' | 'thinking'): void {
    if (this.bufferKind && this.bufferKind !== kind) this.flush();
    this.bufferKind = kind;
  }

  /** Emit any buffered assistant/thinking text as a clean, prefixed block. */
  flush(): void {
    const kind = this.bufferKind;
    const text = this.buffer.trim();
    this.bufferKind = null;
    this.buffer = '';
    if (!this.enabled || !kind || !text) return;
    if (kind === 'thinking' && !this.showThinking) return;
    this.emitBlock(this.prefix(kind), text);
  }

  /**
   * A whole message as one rail: the prefix opens it, every later line holds
   * the prefix's column, and each carries the gutter. Blank lines inside the
   * message keep the gutter too, so the rail never breaks mid-block.
   *
   * Long lines are wrapped here rather than left to the terminal: a terminal
   * wraps at its own window edge, and the overflow lands at column 0 with no
   * prefix and no gutter — one long sentence severs the rail.
   *
   * `style` is applied *per wrapped line*, never before wrapping: measuring or
   * splitting text that already carries escape codes would count them as
   * visible width and could cut a code in half.
   */
  private emitBlock(prefix: string, text: string, style: (line: string) => string = (line) => line): void {
    const continuation = this.continuation(prefix);
    const width = this.textWidth(prefix);

    let first = true;
    for (const rawLine of text.split('\n')) {
      for (const wrapped of rawLine === '' ? [''] : wrapToWidth(rawLine, width)) {
        const head = first ? prefix : continuation;
        first = false;
        this.write(`${head} ${GUTTER}${wrapped ? ` ${style(wrapped)}` : ''}\n`);
      }
    }
  }

  /** One agent-side message, gutter included and wrapped like any other. */
  private emitGutterLine(prefix: string, text: string, style?: (line: string) => string): void {
    this.flush();
    if (this.enabled) this.emitBlock(prefix, text, style);
  }

  /**
   * One line of tool traffic — truncated rather than wrapped, because a session
   * emits hundreds of these and a shell command spilling over four lines would
   * bury the message after it.
   *
   * The cut lands on exactly the column the wrapper would have broken at, so a
   * truncated line and a wrapped one share a right edge. Providers hand over
   * whole summaries for that reason: only here is the prefix width known, and a
   * fixed guess upstream either overflows or leaves the line short.
   *
   * `result` (an exit code, a failure reason) is kept out of the cut — it says
   * more than the last few characters of a long command — but capped at half
   * the line so a long failure body cannot squeeze the command out entirely.
   */
  private emitToolLine(prefix: string, summary: string, result: string | null): void {
    this.flush();
    if (!this.enabled) return;
    const width = this.textWidth(prefix);
    const tail = result ? ` (${truncate(result, Math.max(1, Math.floor(width / 2)))})` : '';
    this.emitBlock(prefix, `${truncate(summary, Math.max(1, width - tail.length))}${tail}`, detail);
  }

  handleEvent(event: CanonicalAgentEvent): void {
    switch (event.type) {
      case 'session-start': {
        this.emitGutterLine(
          this.prefix('assistant'),
          `session started (${event.model || this.fallbackModel || 'unknown model'})`,
          detail,
        );
        return;
      }

      case 'thinking-text': {
        if (event.text) {
          this.setBufferKind('thinking');
          this.buffer += event.text;
        }
        if (event.completed) this.flush();
        return;
      }

      case 'assistant-text': {
        // Consolidated events carry the full canonical text of the current
        // block; prefer it over the accumulated deltas, then flush the block.
        if (event.consolidated) {
          this.setBufferKind('assistant');
          if (event.text) this.buffer = event.text;
          this.flush();
          return;
        }
        if (event.text) {
          this.setBufferKind('assistant');
          this.buffer += event.text;
        }
        return;
      }

      // Tool traffic is the highest-volume, lowest-signal output a session
      // produces — hundreds of lines per stage — so it recedes.
      case 'tool-call-start': {
        this.emitToolLine(this.prefix('assistant'), `→ ${event.summary}`, null);
        return;
      }

      case 'tool-call-result': {
        this.emitToolLine(this.prefix('assistant'), `✓ ${event.summary}`, event.result);
        return;
      }

      case 'raw-line': {
        this.emitGutterLine(this.prefix('assistant'), event.text);
        return;
      }

      case 'result': {
        const duration = event.durationMs > 0 ? formatDuration(event.durationMs) : 'unknown duration';
        const preview = event.text?.trim() ? `: ${truncate(event.text, 120)}` : '';
        this.emitGutterLine(
          this.prefix('assistant'),
          `${event.ok ? 'finished' : 'failed'} (${duration})${preview}`,
          event.ok ? good : bad,
        );
        return;
      }
    }
  }
}
