/**
 * @neutronai/app — a logical clock for tests that measure an interaction.
 *
 * WHY THIS EXISTS. Some of what the composer does is timing, not state: the
 * gesture recogniser spends a fixed 250 ms deciding "tap or hold?", and whether
 * the microphone is already open during that window is the whole difference
 * between a voice note that keeps its first syllable and one that does not. A
 * test that wants to hold that line has to talk about milliseconds.
 *
 * Measuring those milliseconds against the WALL CLOCK makes the assertion a
 * statement about the machine. `voice-capture-starts-on-touch-down.test.tsx`
 * measured a 54 ms lead-in on a quiet box and 326 ms on a loaded one — same
 * code, same correctness, opposite verdicts. A gate that reddens for a reason
 * unrelated to the change under review is a gate people learn to merge past.
 *
 * WHAT THIS REPLACES IT WITH. One timeline that both the test and the code under
 * test agree on, and that only the test can move:
 *
 *   - `Date.now()` is pinned, so every timestamp a test or a stub takes is a
 *     position on the logical timeline rather than a reading of how busy the
 *     machine was.
 *   - `setTimeout` with a POSITIVE delay is queued instead of scheduled. That is
 *     the recogniser's long-press deadline — the deadline the measurement is
 *     about — and it now fires when the test says the finger has been down that
 *     long, not when the OS gets round to it.
 *   - `setTimeout` with a zero (or absent) delay still goes to the real timer.
 *     That path is not "elapsed time", it is the microtask/macrotask plumbing
 *     React and the harness's own `settle()` are built on; virtualising it would
 *     deadlock every flush.
 *
 * The result is a test that still measures the thing it was written to measure —
 * how much of a hold the microphone misses — with a number that a slow machine
 * cannot move.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not model how long the real
 * permission check, audio-session switch or native prepare take. It never could:
 * those are stubs here and return instantly, so the wall-clock figure this
 * replaces was measuring harness overhead, not device latency. The recogniser's
 * delay is the only interval in this interaction that is a real, fixed quantity,
 * and it is the one this clock reproduces exactly.
 *
 * PROCESS-GLOBAL. Same rule as everything else in `native-harness.ts`: Bun runs
 * ~100 test FILES per process, so a suite that installs this MUST call
 * {@link uninstallHarnessClock} in `afterAll` or every file after it inherits a
 * frozen `Date.now()` and a `setTimeout` that never fires.
 */

import { setSystemTime } from 'bun:test';

/**
 * The instant the logical timeline starts from. Fixed, so two runs of the same
 * test see byte-identical timestamps.
 */
const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

type TimeoutHandler = (...args: unknown[]) => void;

interface VirtualTimer {
  id: number;
  /** Position on the logical timeline at which this fires. */
  due_ms: number;
  /** Insertion order, so timers due at the same instant fire as scheduled. */
  seq: number;
  fn: TimeoutHandler;
  args: unknown[];
}

/** The handle handed back for a queued timer, recognisable by `clearTimeout`. */
interface VirtualHandle {
  __harness_virtual_timer: number;
}

function isVirtualHandle(value: unknown): value is VirtualHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as VirtualHandle).__harness_virtual_timer === 'number'
  );
}

let installed = false;
let now_ms = 0;
let next_id = 1;
let next_seq = 1;
let queue: VirtualTimer[] = [];

/**
 * The real timer functions, captured at INSTALL time rather than module load.
 *
 * happy-dom's global registrator replaces `globalThis.setTimeout` when the DOM
 * is registered, which `installNativeHarness()` does at a test file's top level.
 * Capturing at module load would hand back whichever implementation happened to
 * be in place first and strand the other.
 */
let real_set_timeout: typeof globalThis.setTimeout | null = null;
let real_clear_timeout: typeof globalThis.clearTimeout | null = null;

function setLogicalNow(ms: number): void {
  now_ms = ms;
  setSystemTime(new Date(EPOCH_MS + ms));
}

/** Where the logical timeline currently stands, in ms since the clock started. */
export function harnessClockNow(): number {
  return now_ms;
}

/**
 * Pin `Date.now()` and route delayed timers onto the logical timeline.
 *
 * Idempotent. Call it once per suite (`beforeAll`), reset per test with
 * {@link resetHarnessClock}, and undo it in `afterAll`.
 */
export function installHarnessClock(): void {
  if (installed) {
    resetHarnessClock();
    return;
  }
  real_set_timeout = globalThis.setTimeout;
  real_clear_timeout = globalThis.clearTimeout;
  installed = true;
  queue = [];
  setLogicalNow(0);

  const harnessSetTimeout = (
    handler: TimeoutHandler | string,
    delay?: number,
    ...args: unknown[]
  ): unknown => {
    const ms = typeof delay === 'number' && Number.isFinite(delay) ? delay : 0;
    // Zero-delay work is scheduling, not elapsed time — it stays real, because
    // `settle()` and React's own flushing await it.
    if (ms <= 0 || typeof handler !== 'function') {
      return (real_set_timeout as typeof globalThis.setTimeout)(
        handler as TimeoutHandler,
        delay,
        ...args,
      );
    }
    const timer: VirtualTimer = {
      id: next_id++,
      due_ms: now_ms + ms,
      seq: next_seq++,
      fn: handler,
      args,
    };
    queue.push(timer);
    return { __harness_virtual_timer: timer.id } satisfies VirtualHandle;
  };

  const harnessClearTimeout = (handle?: unknown): void => {
    if (isVirtualHandle(handle)) {
      queue = queue.filter((t) => t.id !== handle.__harness_virtual_timer);
      return;
    }
    (real_clear_timeout as typeof globalThis.clearTimeout)(handle as never);
  };

  globalThis.setTimeout = harnessSetTimeout as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = harnessClearTimeout as unknown as typeof globalThis.clearTimeout;
}

/** Back to the start of the timeline with nothing queued. Call in `beforeEach`. */
export function resetHarnessClock(): void {
  if (!installed) return;
  queue = [];
  setLogicalNow(0);
}

/** Hand the real timers and the real `Date` back. MUST run in `afterAll`. */
export function uninstallHarnessClock(): void {
  if (!installed) return;
  installed = false;
  queue = [];
  if (real_set_timeout !== null) globalThis.setTimeout = real_set_timeout;
  if (real_clear_timeout !== null) globalThis.clearTimeout = real_clear_timeout;
  real_set_timeout = null;
  real_clear_timeout = null;
  setSystemTime();
}

/**
 * Move the logical timeline forward by `ms`, firing what comes due on the way.
 *
 * Timers fire in due order at the instant they are due, so a test that advances
 * past two deadlines sees them land in the order a real hold would produce them,
 * each with the timestamp it would really have carried.
 *
 * `step` is how the caller lets React see the work: it receives the timer
 * callback and is expected to run it inside `act()` and then settle. Keeping
 * that on the caller's side is why this module needs no React import — which
 * matters, because the harness controls when React is first loaded.
 */
export async function advanceHarnessClock(
  ms: number,
  step: (run: () => void) => Promise<void>,
): Promise<void> {
  if (!installed) throw new Error('advanceHarnessClock() before installHarnessClock()');
  const target = now_ms + ms;
  for (;;) {
    const due = queue
      .filter((t) => t.due_ms <= target)
      .sort((a, b) => a.due_ms - b.due_ms || a.seq - b.seq)[0];
    if (due === undefined) break;
    queue = queue.filter((t) => t.id !== due.id);
    setLogicalNow(due.due_ms);
    await step(() => {
      due.fn(...due.args);
    });
  }
  setLogicalNow(target);
  await step(() => {});
}
