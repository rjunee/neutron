/**
 * session-size-watchdog.test.ts — Vajra port row #13 (session-size watchdog +
 * compact affordance). Each test pins one explicit assertion from the port
 * brief; the headline one is the POST-COMPACT-size measurement (a huge raw file
 * whose post-compact region is small must NOT fire — the "Compact does nothing"
 * re-fire-forever bug the raw-`stat.size` approach reproduced).
 */

import { describe, expect, test } from 'bun:test'
import {
  measurePostCompactBytes,
  measurePostCompactSize,
  sessionJsonlPath,
  SessionSizeTracker,
  startSessionSizeWatchdog,
  SIZE_WARN_BYTES,
  SIZE_CRITICAL_BYTES,
  COMPACT_SUMMARY_MARKER,
  type SizeSeverity,
} from '../session-size-watchdog.ts'
import { encodeKey } from '../keystrokes.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A JSONL record line of roughly `n` bytes (ASCII), newline-terminated. */
function bigLine(n: number): string {
  const filler = 'x'.repeat(Math.max(0, n - 32))
  return JSON.stringify({ type: 'assistant', pad: filler }) + '\n'
}

describe('measurePostCompactBytes — the post-compact-size invariant', () => {
  test('no compact marker → full byte length is the live context', () => {
    const buf = Buffer.from(bigLine(1000) + bigLine(1000))
    expect(measurePostCompactBytes(buf)).toBe(buf.length)
  })

  test('measures ONLY the bytes after the LAST compact-summary record', () => {
    const pre = bigLine(4000)
    const summary = JSON.stringify({ type: 'summary', isCompactSummary: true }) + '\n'
    const post = bigLine(500) + bigLine(500)
    const buf = Buffer.from(pre + summary + post)
    expect(measurePostCompactBytes(buf)).toBe(Buffer.byteLength(post))
  })

  test('THE LESSON: a HUGE raw file with a small post-compact region is small', () => {
    // 8 MB of pre-compaction turns, then a compact-summary, then ~1 KB live.
    const pre = bigLine(8 * 1024 * 1024)
    const summary = `{"type":"summary","isCompactSummary":true,"x":"${'y'.repeat(50)}"}\n`
    const post = bigLine(1024)
    const buf = Buffer.from(pre + summary + post)
    // Raw size is ≥8 MB (would WARN under the buggy raw-stat approach)…
    expect(buf.length).toBeGreaterThan(SIZE_WARN_BYTES)
    // …but the post-compact size is tiny — the warn must NOT fire.
    expect(measurePostCompactBytes(buf)).toBe(Buffer.byteLength(post))
    expect(measurePostCompactBytes(buf)).toBeLessThan(SIZE_WARN_BYTES)
  })

  test('uses the LAST marker when several compactions happened', () => {
    const a = bigLine(1000)
    const sum1 = `{"isCompactSummary":true,"n":1}\n`
    const b = bigLine(2000)
    const sum2 = `{"isCompactSummary":true,"n":2}\n`
    const post = bigLine(300)
    const buf = Buffer.from(a + sum1 + b + sum2 + post)
    expect(measurePostCompactBytes(buf)).toBe(Buffer.byteLength(post))
  })

  test('marker on the final unterminated record → 0 post-compact bytes', () => {
    const buf = Buffer.from(bigLine(1000) + `{"isCompactSummary":true}`)
    expect(measurePostCompactBytes(buf)).toBe(0)
  })

  test('byte-accurate across multi-byte UTF-8 after the marker', () => {
    const summary = `{"isCompactSummary":true}\n`
    const post = `{"type":"assistant","t":"café 日本語 🎉"}\n`
    const buf = Buffer.from(summary + post)
    expect(measurePostCompactBytes(buf)).toBe(Buffer.byteLength(post, 'utf8'))
    // Sanity: byte length exceeds JS string length for this content.
    expect(Buffer.byteLength(post, 'utf8')).toBeGreaterThan(post.length)
  })

  test('marker matches the canonical CC (space-free) serialization', () => {
    expect(JSON.stringify({ isCompactSummary: true })).toContain(COMPACT_SUMMARY_MARKER)
  })
})

describe('measurePostCompactSize / sessionJsonlPath — fs boundary', () => {
  test('absent file → null (skip the tick, do not phantom-fire)', () => {
    expect(measurePostCompactSize('/no/such/transcript.jsonl')).toBe(null)
  })

  test('reads a real file and returns its post-compact size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-size-'))
    try {
      const p = join(dir, 's.jsonl')
      const post = bigLine(2048)
      writeFileSync(p, `{"isCompactSummary":true}\n` + post)
      expect(measurePostCompactSize(p)).toBe(Buffer.byteLength(post))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('path follows the CC <projectsDir>/<cwd-dashed>/<id>.jsonl layout', () => {
    expect(sessionJsonlPath('abc', '/Users/sam/proj', '/root/.claude/projects')).toBe(
      '/root/.claude/projects/-Users-sam-proj/abc.jsonl',
    )
  })
})

describe('SessionSizeTracker — tiered edge-latch (invariant §1)', () => {
  test('warn fires once on entering the band, never re-fires while in band', () => {
    const t = new SessionSizeTracker()
    expect(t.evaluate(SIZE_WARN_BYTES)).toBe('warn') // rising edge
    expect(t.evaluate(SIZE_WARN_BYTES + 1)).toBe(null) // still in band → no re-fire
    expect(t.evaluate(SIZE_WARN_BYTES + 100)).toBe(null)
  })

  test('latch clears on shrink, re-fires on re-entry', () => {
    const t = new SessionSizeTracker()
    expect(t.evaluate(SIZE_WARN_BYTES)).toBe('warn')
    expect(t.evaluate(0)).toBe(null) // dropped below → clears
    expect(t.latchedTier).toBe(0)
    expect(t.evaluate(SIZE_WARN_BYTES)).toBe('warn') // re-entry fires again
  })

  test('critical fires at ≥10MB; warn→critical escalation re-fires (tiered)', () => {
    const t = new SessionSizeTracker()
    expect(t.evaluate(SIZE_WARN_BYTES)).toBe('warn')
    expect(t.evaluate(SIZE_CRITICAL_BYTES)).toBe('critical') // escalation fires
    expect(t.evaluate(SIZE_CRITICAL_BYTES + 1)).toBe(null) // in band → no re-fire
  })

  test('a jump straight to critical fires critical only', () => {
    const t = new SessionSizeTracker()
    expect(t.evaluate(SIZE_CRITICAL_BYTES)).toBe('critical')
  })

  test('critical→warn de-escalates without firing; re-escalation fires critical', () => {
    const t = new SessionSizeTracker()
    expect(t.evaluate(SIZE_CRITICAL_BYTES)).toBe('critical')
    expect(t.evaluate(SIZE_WARN_BYTES)).toBe(null) // de-escalation, no fire
    expect(t.latchedTier).toBe(1)
    expect(t.evaluate(SIZE_CRITICAL_BYTES)).toBe('critical') // re-escalation fires
  })
})

/** Build a watchdog with a manual clock + a fake PTY write seam, returning the
 *  surfaced alerts and the raw key/data writes for assertion. */
function makeHarness(sizes: () => number | null) {
  const alerts: Array<{ severity: SizeSeverity; size: number }> = []
  const writes: string[] = []
  let clock = 0
  const wd = startSessionSizeWatchdog({
    readSize: sizes,
    surface: (severity, size) => alerts.push({ severity, size }),
    writeKey: (k) => writes.push(`KEY:${encodeKey(k)}`),
    write: (d) => writes.push(d),
    now: () => clock,
    // No real timer — tests call wd.tick() directly.
    setIntervalFn: () => 0,
    clearIntervalFn: () => {},
  })
  return { wd, alerts, writes, advance: (ms: number) => (clock += ms) }
}

describe('startSessionSizeWatchdog — tick wiring', () => {
  test('a post-compact size ≥5MB fires warn; ≥10MB fires critical', () => {
    let size = 0
    const { wd, alerts } = makeHarness(() => size)
    size = SIZE_WARN_BYTES
    wd.tick()
    expect(alerts).toEqual([{ severity: 'warn', size: SIZE_WARN_BYTES }])
    size = SIZE_CRITICAL_BYTES
    wd.tick()
    expect(alerts[1]).toEqual({ severity: 'critical', size: SIZE_CRITICAL_BYTES })
  })

  test('null size (no/unreadable transcript) skips the tick', () => {
    const { wd, alerts } = makeHarness(() => null)
    wd.tick()
    wd.tick()
    expect(alerts).toHaveLength(0)
  })

  test('warn fires once across many ticks while still in band', () => {
    const { wd, alerts } = makeHarness(() => SIZE_WARN_BYTES + 10)
    wd.tick()
    wd.tick()
    wd.tick()
    expect(alerts).toHaveLength(1)
  })
})

describe('Compact action — escape then /compact\\r, fire-once + mid-compact lock', () => {
  test('requestCompact issues escape THEN /compact\\r exactly once', () => {
    const { wd, writes } = makeHarness(() => SIZE_WARN_BYTES)
    expect(wd.requestCompact()).toBe(true)
    expect(writes).toEqual([`KEY:${encodeKey('escape')}`, '/compact\r'])
    // A second press while mid-compact does NOT re-send (fire-once).
    expect(wd.requestCompact()).toBe(false)
    expect(writes).toEqual([`KEY:${encodeKey('escape')}`, '/compact\r'])
  })

  test('mid-compact lock suppresses warn during the grow-before-marker window', () => {
    let size = SIZE_WARN_BYTES + 100
    const { wd, alerts } = makeHarness(() => size)
    // User actuates compact → lock held.
    expect(wd.requestCompact()).toBe(true)
    expect(wd.isCompacting()).toBe(true)
    // The compaction is mid-flight: the file momentarily looks HUGE (no marker
    // yet). The tick must NOT warn while the lock is held.
    size = SIZE_CRITICAL_BYTES + 100
    wd.tick()
    expect(alerts).toHaveLength(0)
    // The summary marker lands → post-compact size drops below warn → lock clears.
    size = 1024
    wd.tick()
    expect(wd.isCompacting()).toBe(false)
    expect(alerts).toHaveLength(0)
    // A fresh climb after the lock cleared re-fires warn (latch was reset).
    size = SIZE_WARN_BYTES + 1
    wd.tick()
    expect(alerts).toEqual([{ severity: 'warn', size: SIZE_WARN_BYTES + 1 }])
  })

  test('lock auto-clears via timeout when post-compact stays ≥5MB (Codex P2)', () => {
    // A genuinely large conversation can stay ≥5MB even after a successful
    // compaction, OR the actuated /compact may have failed. The lock must NOT
    // persist forever silencing the watchdog — it auto-clears past the max-lock
    // window, and a still-large session re-surfaces the affordance.
    let size = SIZE_WARN_BYTES + 100
    const { wd, alerts, advance } = makeHarness(() => size)
    expect(wd.requestCompact()).toBe(true)
    expect(wd.isCompacting()).toBe(true)
    // Ticks within the lock window: still mid-compact, never clears on size alone
    // because the post-compact region stays ≥5MB.
    size = SIZE_CRITICAL_BYTES + 100
    advance(60_000) // < DEFAULT_COMPACT_LOCK_MAX_MS (2 min)
    wd.tick()
    expect(wd.isCompacting()).toBe(true)
    expect(alerts).toHaveLength(0)
    // Past the max-lock window → the lock auto-clears even though size is huge.
    advance(61_000) // now > 2 min total since actuation
    wd.tick()
    expect(wd.isCompacting()).toBe(false)
    // The tracker was reset, so the still-large size re-fires on the NEXT tick.
    wd.tick()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.severity).toBe('critical')
  })

  test('debounce floor blocks a second actuation even after the lock clears', () => {
    let size = SIZE_WARN_BYTES
    const { wd, writes, advance } = makeHarness(() => size)
    expect(wd.requestCompact()).toBe(true)
    // Lock clears (marker landed) but we are still within the debounce window.
    size = 1024
    wd.tick()
    expect(wd.isCompacting()).toBe(false)
    advance(5_000) // < DEFAULT_COMPACT_DEBOUNCE_MS (30s)
    expect(wd.requestCompact()).toBe(false)
    advance(30_000) // now past the floor
    expect(wd.requestCompact()).toBe(true)
    expect(writes.filter((w) => w === '/compact\r')).toHaveLength(2)
  })
})
