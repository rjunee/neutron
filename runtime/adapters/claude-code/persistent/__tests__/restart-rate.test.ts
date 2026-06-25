/**
 * restart-rate.test.ts — crash-loop guard (Vajra mechanism #20). Proves restart
 * markers <5min apart trigger a crash-loop warning EXACTLY ONCE (edge-latched),
 * and that a normally-spaced restart clears the latch and re-arms it.
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CRASH_LOOP_WINDOW_MS,
  buildCrashLoopWarningText,
  detectCrashLoop,
  evaluateRestartRate,
  loadRestartRate,
  parseRestartRateContents,
  pruneMarkers,
  recordAndEvaluateRestart,
  type RestartRateState,
} from '../restart-rate.ts'

const T0 = 1_750_000_000_000
const MIN = 60_000

function tmpMarkers(): string {
  return join(mkdtempSync(join(tmpdir(), 'neutron-rr-')), '.restart-markers.json')
}

describe('restart-rate — detectCrashLoop (pure)', () => {
  it('fewer than 2 markers → no loop', () => {
    expect(detectCrashLoop([]).crashLoop).toBe(false)
    expect(detectCrashLoop([T0]).crashLoop).toBe(false)
  })
  it('two markers <5min apart → crash loop', () => {
    const d = detectCrashLoop([T0, T0 + 2 * MIN])
    expect(d.crashLoop).toBe(true)
    expect(d.intervalMs).toBe(2 * MIN)
  })
  it('two markers ≥5min apart → no loop', () => {
    expect(detectCrashLoop([T0, T0 + 6 * MIN]).crashLoop).toBe(false)
  })
  it('uses the two MOST-RECENT markers regardless of order', () => {
    const d = detectCrashLoop([T0 + 2 * MIN, T0, T0 + 2 * MIN + 30_000])
    expect(d.crashLoop).toBe(true)
    expect(d.intervalMs).toBe(30_000)
  })
})

describe('restart-rate — pruneMarkers', () => {
  it('drops markers older than retention', () => {
    const kept = pruneMarkers([T0 - 2 * 60 * MIN, T0 - 30 * MIN, T0], T0, 60 * MIN)
    expect(kept).toEqual([T0 - 30 * MIN, T0])
  })
})

describe('restart-rate — evaluateRestartRate (edge latch)', () => {
  it('first ever boot → no warn (single marker)', () => {
    const r = evaluateRestartRate({ markers: [], inCrashLoop: false }, T0)
    expect(r.warn).toBe(false)
    expect(r.state.markers).toEqual([T0])
  })
  it('second boot <5min after first → WARN (absent→present edge)', () => {
    const prev: RestartRateState = { markers: [T0], inCrashLoop: false }
    const r = evaluateRestartRate(prev, T0 + 2 * MIN)
    expect(r.warn).toBe(true)
    expect(r.state.inCrashLoop).toBe(true)
  })
  it('third rapid boot → NO second warn (latched)', () => {
    const prev: RestartRateState = { markers: [T0, T0 + 2 * MIN], inCrashLoop: true }
    const r = evaluateRestartRate(prev, T0 + 4 * MIN)
    expect(r.detection.crashLoop).toBe(true)
    expect(r.warn).toBe(false) // already warned for this loop
  })
  it('a normally-spaced restart clears the latch (present→absent)', () => {
    const prev: RestartRateState = { markers: [T0, T0 + 2 * MIN], inCrashLoop: true }
    const r = evaluateRestartRate(prev, T0 + 2 * MIN + 10 * MIN)
    expect(r.detection.crashLoop).toBe(false)
    expect(r.state.inCrashLoop).toBe(false)
    expect(r.warn).toBe(false)
  })
  it('re-arms: after the latch clears, a new rapid pair warns again', () => {
    // cleared latch state, then two more rapid restarts
    let state: RestartRateState = { markers: [T0], inCrashLoop: false }
    let r = evaluateRestartRate(state, T0 + 20 * MIN) // spaced → no warn, latch stays false
    expect(r.warn).toBe(false)
    state = r.state
    r = evaluateRestartRate(state, T0 + 21 * MIN) // rapid → warn again
    expect(r.warn).toBe(true)
  })
})

describe('restart-rate — disk wrapper exactly-once', () => {
  it('records markers across boots and warns exactly once for a sustained loop', () => {
    const path = tmpMarkers()
    // boot 1 (first start) — no warn
    expect(recordAndEvaluateRestart(path, T0).warn).toBe(false)
    // boot 2, 118s later (the pristine 2026-05-21 signature) — WARN once
    expect(recordAndEvaluateRestart(path, T0 + 118_000).warn).toBe(true)
    // boot 3, still rapid — latched, NO repeat warn
    expect(recordAndEvaluateRestart(path, T0 + 200_000).warn).toBe(false)
    // boot 4, still rapid — still latched
    expect(recordAndEvaluateRestart(path, T0 + 280_000).warn).toBe(false)
    // state persisted
    const loaded = loadRestartRate(path)
    expect(loaded.inCrashLoop).toBe(true)
    expect(loaded.markers.length).toBe(4)
  })
})

describe('restart-rate — parse resilience', () => {
  it('corrupt contents → fresh empty state', () => {
    expect(parseRestartRateContents('not json')).toEqual({ markers: [], inCrashLoop: false })
  })
  it('accepts a bare legacy marker array', () => {
    const s = parseRestartRateContents(JSON.stringify([T0, T0 + 1000]))
    expect(s.markers).toEqual([T0, T0 + 1000])
    expect(s.inCrashLoop).toBe(false)
  })
  it('absent file → empty state', () => {
    expect(loadRestartRate(join(tmpdir(), 'does-not-exist-xyz.json'))).toEqual({
      markers: [],
      inCrashLoop: false,
    })
  })
})

describe('restart-rate — warning text', () => {
  it('mentions the interval and the 5-min window', () => {
    const text = buildCrashLoopWarningText({ crashLoop: true, intervalMs: 118_000, recentCount: 2 })
    expect(text).toContain('CRASH-LOOP')
    expect(text).toContain('118s apart')
    expect(text).toContain(`${CRASH_LOOP_WINDOW_MS / 60000}min`)
  })
})
