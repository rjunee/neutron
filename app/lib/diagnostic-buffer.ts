/**
 * @neutronai/app — the capped in-memory event ring buffer (pure).
 *
 * A crash on its own is rarely diagnosable. What makes it diagnosable is the
 * handful of things that happened just before it: which screen mounted, which
 * request failed, whether the socket had reconnected. So the app keeps a
 * rolling window of recent events and ships that window WITH the error.
 *
 * BOUNDED BY CONSTRUCTION. The buffer holds at most `capacity` events (default
 * 100) and overwrites the oldest — there is no growth path, no flush-to-free,
 * and no configuration that can turn it into a leak. That matters because this
 * runs on a phone, in the same process as the UI, for the entire life of the
 * app.
 *
 * PURE — no React, no React Native, no Expo, no clock of its own (the caller
 * stamps `at`). Unit-tested directly under `bun test`.
 */

export type DiagnosticLevel = 'error' | 'warn' | 'info';

/**
 * The event kinds the capture layer emits. `DiagnosticEvent.kind` is a plain
 * `string` so a call site can add a lifecycle marker without a schema change;
 * this union documents the ones a reader should expect to see.
 */
export type KnownDiagnosticKind =
  | 'js_error'
  | 'unhandled_rejection'
  | 'render_crash'
  | 'lifecycle';

export interface DiagnosticEvent {
  /** Epoch ms, stamped by the recorder. */
  at: number;
  level: DiagnosticLevel;
  /** One of `KnownDiagnosticKind`, or a call-site-specific marker. */
  kind: string;
  message: string;
  stack?: string;
  /** Free-form structured context. Redacted before it is ever stored. */
  context?: Record<string, unknown>;
}

export const DEFAULT_BUFFER_CAPACITY = 100;

/**
 * Fixed-capacity ring of recent events, oldest first on `snapshot()`.
 *
 * Implemented over a plain array with a shift-on-overflow rather than a modular
 * index: at n=100 the copy is free, and the straightforward version is the one
 * that stays correct.
 */
export class DiagnosticRingBuffer {
  private readonly events: DiagnosticEvent[] = [];
  readonly capacity: number;

  constructor(capacity: number = DEFAULT_BUFFER_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** Append one event, evicting the oldest once at capacity. */
  record(event: DiagnosticEvent): void {
    this.events.push(event);
    while (this.events.length > this.capacity) this.events.shift();
  }

  /** A copy of the current window, oldest first. Callers may keep it. */
  snapshot(): DiagnosticEvent[] {
    return this.events.slice();
  }

  /** Drop everything. Used after a snapshot has been committed to a report. */
  clear(): void {
    this.events.length = 0;
  }

  get size(): number {
    return this.events.length;
  }
}
