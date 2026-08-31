/**
 * The pure decision half of the run-scoped hang evidence. Every branch of
 * `decideHang` is reachable here with no clock, no filesystem and no process
 * table — which is the point of splitting it out: the rule that "an unknown check
 * must not authorise a kill" is the one this watchdog got wrong for 17 kills, and
 * it should be provable without booting anything.
 */

import { describe, expect, test } from 'bun:test'
import {
  decideHang,
  describeRunEvidence,
  freshestActivityAgeMs,
  unknownRunEvidence,
  type EvidenceObservation,
  type RunHangEvidence,
} from './run-evidence.ts'

const WINDOW = 60_000

const activity = (age_ms: number, detail = 'seen'): EvidenceObservation => ({
  observed: 'activity',
  age_ms,
  detail,
})
const nothing = (detail = 'looked, found none'): EvidenceObservation => ({ observed: 'nothing', detail })
const unknown = (detail = 'could not look'): EvidenceObservation => ({ observed: 'unknown', detail })

const evidence = (
  process: EvidenceObservation,
  artifacts: EvidenceObservation,
  ref: EvidenceObservation,
): RunHangEvidence => ({ process, artifacts, ref })

describe('decideHang — activity inside the window stands the run down', () => {
  test('a live process (age 0) stands down', () => {
    expect(decideHang(evidence(activity(0), nothing(), nothing()), WINDOW).action).toBe('stand-down')
  })

  test('an artifact touched inside the window stands down', () => {
    expect(decideHang(evidence(nothing(), activity(30_000), nothing()), WINDOW).action).toBe('stand-down')
  })

  test('branch-ref movement inside the window stands down', () => {
    expect(decideHang(evidence(nothing(), nothing(), activity(30_000)), WINDOW).action).toBe('stand-down')
  })

  test('activity at EXACTLY the window boundary stands down (the comparison is <=)', () => {
    expect(decideHang(evidence(nothing(), activity(WINDOW), nothing()), WINDOW).action).toBe('stand-down')
    // One millisecond older, with every other probe having positively looked: reap.
    expect(decideHang(evidence(nothing(), activity(WINDOW + 1), nothing()), WINDOW).action).toBe('reap')
  })

  test('in-window activity OUTRANKS an unknown probe — one positive beats one blind', () => {
    expect(decideHang(evidence(activity(0), unknown(), unknown()), WINDOW).action).toBe('stand-down')
  })
})

describe('decideHang — unknown defers, and never authorises a kill', () => {
  test('any single unknown probe defers, whichever one it is', () => {
    expect(decideHang(evidence(unknown(), nothing(), nothing()), WINDOW).action).toBe('defer')
    expect(decideHang(evidence(nothing(), unknown(), nothing()), WINDOW).action).toBe('defer')
    expect(decideHang(evidence(nothing(), nothing(), unknown()), WINDOW).action).toBe('defer')
  })

  test('unknown alongside activity that is OLDER than the window still defers', () => {
    expect(decideHang(evidence(nothing(), activity(10 * WINDOW), unknown()), WINDOW).action).toBe('defer')
  })

  test('unknownRunEvidence (the gatherer itself failed) defers', () => {
    expect(decideHang(unknownRunEvidence('process table unreadable'), WINDOW).action).toBe('defer')
  })

  test('a MALFORMED activity age is a broken probe, not activity and not quiet → defer', () => {
    // NaN sails past `age_ms <= window` as false and a negative age as true; either
    // way the run's fate would be decided on a number nobody can defend.
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(decideHang(evidence(nothing(), activity(bad), nothing()), WINDOW).action).toBe('defer')
    }
  })
})

describe('decideHang — every probe ran and none saw activity → reap', () => {
  test('all three positively quiet reaps', () => {
    expect(decideHang(evidence(nothing(), nothing(), nothing()), WINDOW).action).toBe('reap')
  })

  test('activity OLDER than the window counts as quiet', () => {
    expect(decideHang(evidence(nothing(), activity(120_000), nothing()), WINDOW).action).toBe('reap')
  })
})

describe('freshestActivityAgeMs', () => {
  test('is the minimum over well-formed activity ages', () => {
    expect(freshestActivityAgeMs(evidence(activity(90_000), activity(30_000), activity(60_000)))).toBe(30_000)
  })

  test('is null when no probe saw activity', () => {
    expect(freshestActivityAgeMs(evidence(nothing(), unknown(), nothing()))).toBeNull()
  })

  test('IGNORES a malformed age rather than returning it', () => {
    // A negative age would otherwise be "the freshest" and would beat every real
    // observation, including inside the dead-launcher override window.
    expect(freshestActivityAgeMs(evidence(activity(-5), activity(45_000), nothing()))).toBe(45_000)
    expect(freshestActivityAgeMs(evidence(activity(Number.NaN), nothing(), nothing()))).toBeNull()
  })
})

describe('describeRunEvidence — all nine clause forms', () => {
  test('the three activity forms, with minute rounding', () => {
    expect(describeRunEvidence(evidence(activity(0), activity(120_000), activity(300_000)))).toBe(
      'run process=live; newest artifact 2 min old; branch ref moved 5 min ago',
    )
  })

  test('the three nothing forms', () => {
    expect(describeRunEvidence(evidence(nothing(), nothing(), nothing()))).toBe(
      'run process=none observed; no run artifacts found; no branch ref movement recorded',
    )
  })

  test('the three unknown forms quote WHY the probe came back blind', () => {
    expect(
      describeRunEvidence(
        evidence(unknown('proc table EACCES'), unknown('scratch dir unreadable'), unknown('git reflog failed')),
      ),
    ).toBe(
      'run process=unknown (proc table EACCES); newest artifact unknown (scratch dir unreadable); ' +
        'branch ref unknown (git reflog failed)',
    )
  })

  test('minutes are ROUNDED, not truncated', () => {
    expect(describeRunEvidence(evidence(nothing(), activity(100_000), nothing()))).toContain(
      'newest artifact 2 min old',
    )
    expect(describeRunEvidence(evidence(nothing(), activity(89_000), nothing()))).toContain(
      'newest artifact 1 min old',
    )
  })

  test('a malformed activity is disclosed as unknown, never as a number', () => {
    const line = describeRunEvidence(evidence(nothing(), activity(Number.NaN, 'mtime scan'), nothing()))
    expect(line).toContain('newest artifact unknown (')
    expect(line).toContain('mtime scan')
    expect(line).not.toContain('NaN min old')
  })

  test('always exactly three clauses, in probe order', () => {
    expect(describeRunEvidence(unknownRunEvidence('gatherer threw')).split('; ')).toHaveLength(3)
  })
})

describe('unknownRunEvidence', () => {
  test('marks all three probes unknown with the given detail', () => {
    const e = unknownRunEvidence('boom')
    for (const o of [e.process, e.artifacts, e.ref]) {
      expect(o.observed).toBe('unknown')
      expect(o.detail).toBe('boom')
    }
  })
})
