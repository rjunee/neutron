/**
 * @neutronai/app — the logical clock has to be right, or the tests on it lie.
 *
 * `harness-clock.ts` exists so an interaction test can measure milliseconds
 * without measuring the machine. That makes it load-bearing in a quiet way: if
 * its queue ever silently stopped firing, the suites built on it would still be
 * green — they would simply have stopped observing anything, which is the
 * failure mode this repo keeps rediscovering the expensive way.
 *
 * So the clock is checked the same way a gate is: each property it promises is
 * asserted, INCLUDING the two that only hurt later — that a zero-delay timer is
 * still a real one (everything React and `settle()` do rides on that path), and
 * that uninstalling really hands the process back. Bun runs ~100 test files per
 * process; a clock left installed here would freeze `Date.now()` for whatever
 * runs next.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import {
  advanceHarnessClock,
  harnessClockNow,
  installHarnessClock,
  uninstallHarnessClock,
} from './support/harness-clock';

/** Advance without React in the picture — the callback just runs. */
const step = async (run: () => void): Promise<void> => {
  run();
  await Promise.resolve();
};

afterEach(() => {
  uninstallHarnessClock();
});

describe('the harness clock', () => {
  it('holds a delayed timer until the test says that much time has passed', async () => {
    installHarnessClock();
    const fired: string[] = [];
    setTimeout(() => fired.push('at-250'), 250);

    // 240ms of logical time is not 250ms of logical time.
    await advanceHarnessClock(240, step);
    expect(fired).toEqual([]);

    await advanceHarnessClock(10, step);
    expect(fired).toEqual(['at-250']);
  });

  it('fires what is due in due order, each at the instant it was due', async () => {
    installHarnessClock();
    const seen: Array<{ tag: string; at: number }> = [];
    setTimeout(() => seen.push({ tag: 'late', at: harnessClockNow() }), 300);
    setTimeout(() => seen.push({ tag: 'early', at: harnessClockNow() }), 50);

    await advanceHarnessClock(900, step);

    // Due order, not scheduling order — and the timestamps are the deadlines
    // themselves, which is what lets a test do arithmetic on them.
    expect(seen).toEqual([
      { tag: 'early', at: 50 },
      { tag: 'late', at: 300 },
    ]);
    expect(harnessClockNow()).toBe(900);
  });

  it('moves Date.now() with the timeline, so a stub timestamps logical time', async () => {
    installHarnessClock();
    const started = Date.now();
    await advanceHarnessClock(900, step);
    expect(Date.now() - started).toBe(900);
  });

  it('leaves zero-delay timers real — that path is scheduling, not elapsed time', async () => {
    installHarnessClock();
    // Nothing advances the clock here. A `setTimeout(…, 0)` that had been queued
    // would never resolve, and `settle()` (which awaits exactly this) would
    // deadlock every harness suite in the repo.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(harnessClockNow()).toBe(0);
  });

  it('forgets a timer that was cleared', async () => {
    installHarnessClock();
    const fired: string[] = [];
    const handle = setTimeout(() => fired.push('never'), 100);
    clearTimeout(handle);
    await advanceHarnessClock(900, step);
    expect(fired).toEqual([]);
  });

  it('hands the process back on uninstall', async () => {
    const real_now = Date.now();
    installHarnessClock();
    expect(Date.now()).not.toBe(real_now);
    uninstallHarnessClock();

    // The real clock is back...
    expect(Math.abs(Date.now() - real_now)).toBeLessThan(60_000);
    // ...and so is the real timer: this delayed callback has to run on its own,
    // with nobody advancing anything.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  });
});
