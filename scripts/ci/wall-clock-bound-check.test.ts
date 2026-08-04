// Unit tests for the wall-clock timing-assertion gate (ISSUES #438).
//
// The gate (scripts/ci/wall-clock-bound-check.mjs) bans assertions that compare
// REAL elapsed time against a threshold, because they measure the machine and
// red when the runner is loaded. These tests pin its PRECISION, and in
// particular every way the ad-hoc grep that found the original violations got it
// wrong: that grep keyed on variables named `elapsed`/`took`/`duration`/`ms`, so
// it missed an inline `Date.now() - start` bound entirely and flagged a comment
// and a fake-timer call that were never violations. Each of those is a locked
// case below.
import { describe, expect, test } from 'bun:test'
import {
  MARKER,
  MIN_JUSTIFICATION_CHARS,
  classifyMarker,
  findWallClockBounds,
  isTestFile,
  mightCarryBound,
} from './wall-clock-bound-check.mjs'

/** Convenience: hits with no (or an inadequate) opt-out marker — what fails CI. */
function offenders(src: string) {
  return findWallClockBounds(src).filter((h) => h.marker !== 'justified')
}

describe('findWallClockBounds — the shapes it MUST catch', () => {
  test('flags a delta bound to a variable (the classic form)', () => {
    const hits = offenders(`
      const start = Date.now()
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(2000)
    `)
    expect(hits.length).toBe(1)
    expect(hits[0]?.text).toContain('toBeLessThan')
  })

  // THE FALSE NEGATIVE THAT MOTIVATED AN AST MATCHER. The delta is never bound
  // to a name, so a matcher keyed on `elapsed`/`took`/`duration`/`ms` is blind
  // to it — and a real one of these survived the original sweep.
  test('flags an INLINE delta that is never bound to any variable', () => {
    const hits = offenders(`
      const start = Date.now()
      expect(Date.now() - start).toBeLessThan(2000)
    `)
    expect(hits.length).toBe(1)
  })

  test('flags a delta the variable name gives no hint about', () => {
    const hits = offenders(`
      const t0 = performance.now()
      const q = performance.now() - t0
      expect(q).toBeGreaterThan(5)
    `)
    expect(hits.length).toBe(1)
  })

  test('flags a delta wrapped in Math.abs / arithmetic', () => {
    expect(
      offenders(`
        const a = Date.now()
        expect(Math.abs(Date.now() - a)).toBeLessThan(60_000)
      `).length,
    ).toBe(1)
    expect(
      offenders(`
        const a = Date.now()
        const d = Date.now() - a
        expect(d / 2).toBeLessThan(50)
      `).length,
    ).toBe(1)
  })

  test('flags every real clock source, not just Date.now', () => {
    for (const clock of [
      'Date.now()',
      'performance.now()',
      'Bun.nanoseconds()',
      'process.hrtime.bigint()',
      'new Date().getTime()',
    ]) {
      const hits = offenders(`
        const t0 = ${clock}
        expect(${clock} - t0).toBeLessThan(1000)
      `)
      expect({ clock, n: hits.length }).toEqual({ clock, n: 1 })
    }
  })

  test('flags every threshold matcher', () => {
    for (const m of [
      'toBeLessThan',
      'toBeLessThanOrEqual',
      'toBeGreaterThan',
      'toBeGreaterThanOrEqual',
      'toBeCloseTo',
    ]) {
      const hits = offenders(`
        const t0 = Date.now()
        expect(Date.now() - t0).${m}(100)
      `)
      expect({ m, n: hits.length }).toEqual({ m, n: 1 })
    }
  })

  test('sees through a .not / .resolves modifier hop', () => {
    const hits = offenders(`
      const t0 = Date.now()
      expect(Date.now() - t0).not.toBeGreaterThan(100)
    `)
    expect(hits.length).toBe(1)
  })

  test('reports the line of each hit, and finds more than one per file', () => {
    const hits = offenders(`
      const t0 = Date.now()
      expect(Date.now() - t0).toBeLessThan(1)
      expect(Date.now() - t0).toBeGreaterThan(0)
    `)
    expect(hits.length).toBe(2)
    expect(hits[1]!.line).toBe(hits[0]!.line + 1)
  })
})

describe('findWallClockBounds — the false positives the name-based grep produced', () => {
  // The grep flagged a doc-comment that QUOTED a removed bound. An AST never
  // sees a comment as a node, so this is structurally impossible here.
  test('does NOT flag a bound quoted in a comment', () => {
    const hits = offenders(`
      // The wall-clock bound that used to sit here (\`elapsed < 2000\`) was the
      // flaky one: expect(Date.now() - start).toBeLessThan(2000). ISSUES #438.
      expect(result.kind).toBe('timeout')
    `)
    expect(hits.length).toBe(0)
  })

  // The grep flagged a fake-timer harness call. Handled on PRINCIPLE rather than
  // by allowlist: exact equality against a delta is only writable under a
  // LOGICAL clock, since real wall time is never exactly N.
  test('does NOT flag an exact-equality delta (a logical clock, by construction)', () => {
    const hits = offenders(`
      installHarnessClock()
      const started = Date.now()
      await advanceHarnessClock(900, step)
      expect(Date.now() - started).toBe(900)
    `)
    expect(hits.length).toBe(0)
  })

  test('does NOT flag a logical clock read that is not the wall clock', () => {
    const hits = offenders(`
      const t0 = harnessClockNow()
      expect(harnessClockNow() - t0).toBeLessThan(900)
    `)
    expect(hits.length).toBe(0)
  })

  // ~40 of these exist in the repo. A delta that merely WAITS is not a delta
  // that ASSERTS; requiring an expect() subject is what separates them.
  test('does NOT flag a polling loop or a waitFor guard', () => {
    const hits = offenders(`
      const start = Date.now()
      while (Date.now() - start < timeoutMs) { await tick() }
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      expect(rows.length).toBe(1)
    `)
    expect(hits.length).toBe(0)
  })

  // A clock read minus a CONSTANT is a point in time, not a duration.
  test('does NOT flag a past-timestamp fixture', () => {
    const hits = offenders(`
      await registry.update('r1', { last_event_at: Date.now() - 10 * 60_000 })
      const old = new Date(Date.now() - 60_000)
      expect(rows[0].stale).toBe(true)
    `)
    expect(hits.length).toBe(0)
  })

  test('does NOT flag an assertion on a clock value that is not a delta', () => {
    const hits = offenders(`
      const real_now = Date.now()
      expect(Date.now()).toBeGreaterThanOrEqual(real_now)
    `)
    expect(hits.length).toBe(0)
  })

  test('does NOT flag a non-clock numeric bound', () => {
    const hits = offenders(`
      expect(rows.length).toBeLessThan(100)
      expect(payload.size - baseline).toBeGreaterThan(0)
    `)
    expect(hits.length).toBe(0)
  })
})

describe('the WALL-CLOCK-BOUND-OK opt-out', () => {
  const justified = `
    const t0 = Date.now()
    const elapsed = Date.now() - t0
    // ${MARKER}: no deterministic assertion can replace this — both watchdogs
    // emit the identical error, so only the elapsed floor tells them apart. The
    // margin is measured at 8 ms against a 3000 ms budget under 2x CPU load.
    expect(elapsed).toBeGreaterThan(600)
  `

  test('a marker WITH a justification silences the gate', () => {
    const all = findWallClockBounds(justified)
    expect(all.length).toBe(1)
    expect(all[0]?.marker).toBe('justified')
    expect(offenders(justified).length).toBe(0)
  })

  // The whole point of requiring prose: an opt-out must stay an ARGUED
  // exception, not a silent one. A bare disable is its own failure class.
  test('a marker WITHOUT a justification is REJECTED, not honoured', () => {
    const bare = `
      const t0 = Date.now()
      // ${MARKER}: flaky
      expect(Date.now() - t0).toBeLessThan(100)
    `
    const all = findWallClockBounds(bare)
    expect(all.length).toBe(1)
    expect(all[0]?.marker).toBe('bare')
    expect(offenders(bare).length).toBe(1)
  })

  test('a bare marker with no colon or prose at all is REJECTED', () => {
    const naked = `
      const t0 = Date.now()
      // ${MARKER}
      expect(Date.now() - t0).toBeLessThan(100)
    `
    expect(findWallClockBounds(naked)[0]?.marker).toBe('bare')
  })

  test('the marker only silences the assertion it is attached to', () => {
    const src = `
      const t0 = Date.now()
      // ${MARKER}: this one is argued at length, with a measured margin of 8 ms
      // against a 3000 ms budget, and no deterministic substitute exists at all.
      expect(Date.now() - t0).toBeGreaterThan(1)
      expect(Date.now() - t0).toBeLessThan(5000)
    `
    const all = findWallClockBounds(src)
    expect(all.map((h) => h.marker)).toEqual(['justified', 'none'])
  })

  test('a trailing same-line marker is honoured too', () => {
    const src = `
      const t0 = Date.now()
      expect(Date.now() - t0).toBeLessThan(100) // ${MARKER}: the only observable that separates linear scanning from catastrophic backtracking; measured at 0.25 ms.
    `
    expect(findWallClockBounds(src)[0]?.marker).toBe('justified')
  })

  test('classifyMarker counts prose across continuation lines', () => {
    const short = classifyMarker(`// ${MARKER}: because`)
    expect(short.state).toBe('bare')
    const long = classifyMarker(
      `// ${MARKER}: split across\n// several continuation lines that together clear the bar comfortably.`,
    )
    expect(long.state).toBe('justified')
    expect(long.justification.length).toBeGreaterThanOrEqual(MIN_JUSTIFICATION_CHARS)
    expect(classifyMarker('// just an ordinary comment').state).toBe('none')
  })
})

describe('scope + prefilter', () => {
  test('scans test files only — production timeouts are not this flake class', () => {
    expect(isTestFile('gateway/http/__tests__/foo.test.ts')).toBe(true)
    expect(isTestFile('app/__tests__/bar.test.tsx')).toBe(true)
    expect(isTestFile('gateway/composer.ts')).toBe(false)
    expect(isTestFile('scripts/ci/lint.sh')).toBe(false)
  })

  test('the prefilter never rejects a file that carries a real hit', () => {
    expect(mightCarryBound('const t0 = Date.now()\nexpect(Date.now() - t0).toBeLessThan(1)')).toBe(true)
    expect(mightCarryBound('expect(performance.now() - t0).toBeLessThan(1)')).toBe(true)
    expect(mightCarryBound('expect(rows.length).toBe(1)')).toBe(false)
  })

  test('parses TSX without choking on JSX', () => {
    const hits = findWallClockBounds(
      `const t0 = Date.now()
       render(<Thing prop={1} />)
       expect(Date.now() - t0).toBeLessThan(100)`,
      'fixture.test.tsx',
    )
    expect(hits.length).toBe(1)
  })
})
