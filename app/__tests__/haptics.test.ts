/**
 * The haptic vocabulary, and the property that matters most: it can never break
 * the thing it annotates.
 *
 * Haptics are unavailable on a simulator, on web, on a device with the setting off,
 * and on hardware with no actuator — and `expo-haptics` REJECTS rather than no-ops
 * in some of those. A rejected promise on the recording-start path would surface to
 * the owner as a failed voice note, which is far worse than a missing buzz. So the
 * wrapper is fire-and-forget and swallows both rejections and synchronous throws.
 *
 * The KIND of feedback is also asserted, because it is a decision rather than a
 * detail: a rail tap gets the platform's "selection changed" tick (the lightest
 * thing either OS offers, and what the owner asked for — "very subtle"), while a
 * recording boundary gets a Light impact, since a selection tick is too faint to
 * confirm "the mic is live" without looking.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Module scope, synchronously: an `await` inside a describe body silently drops the
// whole block (hit twice this session).
const HERE = dirname(fileURLToPath(import.meta.url));

const selectionAsync = mock(async () => undefined);
const impactAsync = mock(async (_style?: unknown) => undefined);

// NOT `mock.module`: bun's module mocks are process-wide and persist, and this
// module is imported by the rail and the recorder — mocking the specifier leaked
// into unrelated chat suites sharing the CI shard and failed them while passing in
// isolation. The explicit seam is scoped to this file.
import {
  __setHapticsModuleForTests,
  hapticProjectSwitch,
  hapticRecordingStarted,
  hapticRecordingStopped,
} from '../lib/haptics';

beforeEach(() => {
  selectionAsync.mockClear();
  impactAsync.mockClear();
  __setHapticsModuleForTests({
    selectionAsync,
    impactAsync,
    ImpactFeedbackStyle: { Light: 'light' },
  });
});

afterEach(() => {
  // Restore the real module so nothing downstream inherits the stub.
  __setHapticsModuleForTests(undefined);
});

describe('the haptic vocabulary', () => {
  it('a project switch uses the SELECTION tick, not an impact', () => {
    selectionAsync.mockClear();
    impactAsync.mockClear();
    hapticProjectSwitch();
    expect(selectionAsync).toHaveBeenCalledTimes(1);
    // An impact here would be too much for something done dozens of times an hour.
    expect(impactAsync).not.toHaveBeenCalled();
  });

  it('recording start and stop use a LIGHT impact, not the selection tick', () => {
    selectionAsync.mockClear();
    impactAsync.mockClear();
    hapticRecordingStarted();
    hapticRecordingStopped();
    expect(impactAsync).toHaveBeenCalledTimes(2);
    expect(impactAsync.mock.calls[0]?.[0]).toBe('light');
    expect(impactAsync.mock.calls[1]?.[0]).toBe('light');
    expect(selectionAsync).not.toHaveBeenCalled();
  });
});

describe('a haptic can never break its caller', () => {
  it('attaches a .catch() so a rejection cannot leak — asserted on SOURCE, and here is why', () => {
    // WEAKER THAN THE REST OF THIS FILE, DELIBERATELY, AND SAID SO.
    //
    // Two behavioural routes were tried and neither can fail for the right reason.
    // `expect(fn).not.toThrow()` passes with the `.catch()` REMOVED, because
    // `void promise` does not throw synchronously — it leaks an unhandled rejection,
    // which is the actual failure mode. And observing that leak via
    // `process.on('unhandledRejection')` also passes with the catch removed, because
    // bun does not surface it to that handler inside a test.
    //
    // So rather than keep a test that cannot fail for its stated reason, this pins
    // the one line that carries the property. The rejection path itself is exercised
    // by the mock above; what this adds is that the guard is present at all.
    const SRC = readFileSync(join(HERE, '..', 'lib', 'haptics.ts'), 'utf8');
    expect(SRC).toContain('.catch(() => undefined)');
  });

  it('a rejecting haptic still does not throw at the call site', () => {
    impactAsync.mockClear();
    impactAsync.mockImplementationOnce(async () => {
      throw new Error('Haptics are not available on this device');
    });
    expect(() => hapticRecordingStarted()).not.toThrow();
  });

  it('swallows a SYNCHRONOUS throw', () => {
    selectionAsync.mockClear();
    selectionAsync.mockImplementationOnce((() => {
      throw new Error('module unavailable on this platform');
    }) as unknown as typeof selectionAsync);
    expect(() => hapticProjectSwitch()).not.toThrow();
  });

  it('returns void, so no caller can accidentally await hardware', () => {
    // An `async` wrapper would put a hardware call on the critical path of a state
    // transition, and a caller forgetting the await would produce an unhandled
    // rejection on exactly the devices where haptics are unavailable.
    selectionAsync.mockClear();
    expect(hapticProjectSwitch()).toBeUndefined();
  });
});

/**
 * The three call sites are WIRED — asserted on source, and labelled weaker.
 *
 * The wrapper above is fully behavioural, but a correct wrapper nobody calls buys
 * nothing. Driving the real sites would mean mounting the rail and running a real
 * recorder against device permissions and a live mic, which is a materially bigger
 * harness than this change; a half-built mount would pass without exercising the
 * path. So this pins the wiring textually and says so, per the precedent in #128.
 *
 * The PLACEMENT assertions matter as much as the presence ones: the start haptic
 * must sit after the abandoned-start check, and the stop haptic after the
 * discarded-clip early returns, or the device buzzes for a recording the owner
 * does not have.
 */
describe('the three call sites are wired', () => {
  const RECORDER = readFileSync(join(HERE, '..', 'lib', 'use-voice-recorder.ts'), 'utf8');
  const RAIL = readFileSync(join(HERE, '..', 'components', 'ProjectRail.tsx'), 'utf8');

  it('the rail fires the switch tick on tap, BEFORE onSelect', () => {
    // onSelect may navigate and unmount the row, so the order is load-bearing.
    const h = RAIL.indexOf('hapticProjectSwitch()');
    const s = RAIL.indexOf('onSelect(project.id)');
    expect(h).toBeGreaterThan(-1);
    expect(s).toBeGreaterThan(-1);
    expect(h).toBeLessThan(s);
  });

  it('recording-started fires AFTER the phase flips to recording', () => {
    const phase = RECORDER.indexOf("setPhase('recording')");
    const h = RECORDER.indexOf('hapticRecordingStarted()');
    expect(phase).toBeGreaterThan(-1);
    expect(h).toBeGreaterThan(phase);
  });

  it('recording-stopped fires only on a clip that SURVIVED review', () => {
    // It must come after `setPhase('review')`, which is past the early returns for
    // an unmounted host and a too-short or failed capture.
    const review = RECORDER.indexOf("setPhase('review')");
    const h = RECORDER.indexOf('hapticRecordingStopped()');
    expect(review).toBeGreaterThan(-1);
    expect(h).toBeGreaterThan(review);
  });
});
