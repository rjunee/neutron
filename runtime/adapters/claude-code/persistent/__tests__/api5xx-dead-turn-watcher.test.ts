import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, appendFileSync, truncateSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  API_5XX_ERROR_RE,
  classifyApi5xxRecord,
  Api5xxDeadTurnCore,
  startApi5xxDeadTurnWatcher,
  realReadFrom,
  type DeadTurnNotice,
  type JsonlReadResult,
} from '../api5xx-dead-turn-watcher.ts'

/**
 * Per-turn API-5xx dead-turn notifier (Vajra port row #11). A mid-turn 5xx
 * aborts the turn before `reply()`, so the user sees nothing (Ryan 2026-06-16).
 * The watcher reads the turn JSONL and edge-fires a "resend your last message"
 * notice on a 5xx error record — matched on `result`/`system`/`error` records
 * ONLY (a `tool_result` that echoes "overloaded" must never trip it).
 */

const line = (o: unknown) => `${JSON.stringify(o)}\n`

// CC-shaped records ---------------------------------------------------------
const resultOverloaded = {
  type: 'result',
  subtype: 'error',
  is_error: true,
  result: 'API Error: 500 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  timestamp: '2026-06-16T12:00:00.000Z',
}
const systemRateLimit = {
  type: 'system',
  subtype: 'api_error',
  message: 'API Error: rate_limit_error',
  timestamp: '2026-06-16T12:00:01.000Z',
}
const healthyResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'all done',
  timestamp: '2026-06-16T12:00:05.000Z',
}
const userMentionsOverloaded = {
  type: 'user',
  message: { role: 'user', content: 'why was the server overloaded earlier?' },
  timestamp: '2026-06-16T12:00:02.000Z',
}
const toolResultEchoesOverloaded = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'curl: the upstream was overloaded_error' },
    ],
  },
  timestamp: '2026-06-16T12:00:03.000Z',
}
const assistantRecord = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] },
  timestamp: '2026-06-16T12:00:04.000Z',
}

describe('API_5XX_ERROR_RE', () => {
  test('matches the four 5xx/overload signatures', () => {
    expect(API_5XX_ERROR_RE.test('Overloaded')).toBe(true)
    expect(API_5XX_ERROR_RE.test('overloaded_error')).toBe(true)
    expect(API_5XX_ERROR_RE.test('rate_limit_error')).toBe(true)
    expect(API_5XX_ERROR_RE.test('internal_server_error')).toBe(true)
  })
  test('case-sensitive: lowercase prose "overloaded" alone does NOT match', () => {
    expect(API_5XX_ERROR_RE.test('the server felt overloaded today')).toBe(false)
  })
})

describe('classifyApi5xxRecord (allowlist + pattern)', () => {
  test('result record with overloaded_error → fire', () => {
    expect(classifyApi5xxRecord(JSON.stringify(resultOverloaded))).toBe('fire')
  })
  test('system api_error record with rate_limit_error → fire', () => {
    expect(classifyApi5xxRecord(JSON.stringify(systemRateLimit))).toBe('fire')
  })
  test('healthy result record → clear', () => {
    expect(classifyApi5xxRecord(JSON.stringify(healthyResult))).toBe('clear')
  })
  test('type:"user" record mentioning overloaded → ignore (not considered)', () => {
    expect(classifyApi5xxRecord(JSON.stringify(userMentionsOverloaded))).toBe('ignore')
  })
  test('tool_result echoing overloaded_error → ignore (not considered)', () => {
    expect(classifyApi5xxRecord(JSON.stringify(toolResultEchoesOverloaded))).toBe('ignore')
  })
  test('assistant record → ignore', () => {
    expect(classifyApi5xxRecord(JSON.stringify(assistantRecord))).toBe('ignore')
  })
  test('unparseable / empty / partial line → ignore', () => {
    expect(classifyApi5xxRecord('')).toBe('ignore')
    expect(classifyApi5xxRecord('   ')).toBe('ignore')
    expect(classifyApi5xxRecord('{"type":"result","is_error":tr')).toBe('ignore')
    expect(classifyApi5xxRecord('null')).toBe('ignore')
    expect(classifyApi5xxRecord('42')).toBe('ignore')
  })
})

describe('Api5xxDeadTurnCore.feed', () => {
  test('a result record with overloaded_error FIRES the notice', () => {
    const core = new Api5xxDeadTurnCore()
    const fired = core.feed(line(resultOverloaded))
    expect(fired).toHaveLength(1)
    expect(fired[0]?.reason).toBe('api_5xx_dead_turn')
    expect(fired[0]?.matched).toBe('overloaded_error')
    expect(core.latched).toBe(true)
  })

  test('a type:"user" record containing "overloaded" does NOT fire', () => {
    const core = new Api5xxDeadTurnCore()
    expect(core.feed(line(userMentionsOverloaded))).toHaveLength(0)
    expect(core.latched).toBe(false)
  })

  test('a tool_result echoing "overloaded" does NOT fire', () => {
    const core = new Api5xxDeadTurnCore()
    expect(core.feed(line(toolResultEchoesOverloaded))).toHaveLength(0)
    expect(core.latched).toBe(false)
  })

  test('a record split across two fs.watch callbacks is reassembled and matched', () => {
    const core = new Api5xxDeadTurnCore()
    const whole = line(resultOverloaded) // includes the trailing newline
    const cut = Math.floor(whole.length / 2)
    const part1 = whole.slice(0, cut)
    const part2 = whole.slice(cut)
    // First fragment: no complete line yet → nothing fires, nothing latches.
    expect(core.feed(part1)).toHaveLength(0)
    expect(core.latched).toBe(false)
    // Second fragment completes the record → it is reassembled and FIRES.
    const fired = core.feed(part2)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.matched).toBe('overloaded_error')
  })

  test('edge-latch: fires once on the rising edge, does not re-fire while present, clears on absent', () => {
    const core = new Api5xxDeadTurnCore()
    // Rising edge → fire once.
    expect(core.feed(line(resultOverloaded))).toHaveLength(1)
    expect(core.latched).toBe(true)
    // Still present (another 5xx record, e.g. a retried turn also 5xx'd) → NO re-fire.
    expect(core.feed(line(systemRateLimit))).toHaveLength(0)
    expect(core.latched).toBe(true)
    // Falling edge: a healthy considered record clears the latch.
    expect(core.feed(line(healthyResult))).toHaveLength(0)
    expect(core.latched).toBe(false)
    // A fresh 5xx after the clear fires AGAIN (rising edge restored).
    expect(core.feed(line(resultOverloaded))).toHaveLength(1)
    expect(core.latched).toBe(true)
  })

  test('ignored records (user/tool_result/assistant) never clear a live latch', () => {
    const core = new Api5xxDeadTurnCore()
    expect(core.feed(line(resultOverloaded))).toHaveLength(1)
    expect(core.latched).toBe(true)
    // None of these are considered records → latch must stay up.
    core.feed(line(userMentionsOverloaded))
    core.feed(line(toolResultEchoesOverloaded))
    core.feed(line(assistantRecord))
    expect(core.latched).toBe(true)
    // And a 5xx still doesn't re-fire while latched.
    expect(core.feed(line(systemRateLimit))).toHaveLength(0)
  })

  test('multiple records in one feed: only the first 5xx fires', () => {
    const core = new Api5xxDeadTurnCore()
    const chunk = line(assistantRecord) + line(resultOverloaded) + line(systemRateLimit)
    const fired = core.feed(chunk)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.matched).toBe('overloaded_error')
  })
})

describe('startApi5xxDeadTurnWatcher (fs.watch driver, injected fs)', () => {
  // A growable in-memory file + a captured onChange so a test can simulate the
  // fs.watch firing deterministically (no real watcher timing).
  function harness(): {
    deps: Parameters<typeof startApi5xxDeadTurnWatcher>[0]
    notices: DeadTurnNotice[]
    write: (s: string) => void
    rotate: (s: string) => void
    fire: () => void
    closed: () => boolean
  } {
    let buf = ''
    let onChange: (() => void) | undefined
    let closed = false
    const notices: DeadTurnNotice[] = []
    const readFrom = (_path: string, offset: number): JsonlReadResult | null => {
      const size = Buffer.byteLength(buf, 'utf8')
      const start = size >= offset ? offset : 0
      return { bytes: buf.slice(start), size }
    }
    const deps: Parameters<typeof startApi5xxDeadTurnWatcher>[0] = {
      jsonlPath: '/virtual/projects/dashed/sess.jsonl',
      notify: (n) => {
        notices.push(n)
      },
      ensureDir: () => {},
      watchDir: (_dir, _base, cb) => {
        onChange = cb
        return { close: () => { closed = true } }
      },
      readFrom,
    }
    return {
      deps,
      notices,
      write: (s) => { buf += s },
      rotate: (s) => { buf = s },
      fire: () => onChange?.(),
      closed: () => closed,
    }
  }

  test('fires once when a 5xx record is appended and the watcher pumps', () => {
    const h = harness()
    const w = startApi5xxDeadTurnWatcher(h.deps)
    h.write(line(resultOverloaded))
    h.fire()
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.matched).toBe('overloaded_error')
    w.stop()
    expect(h.closed()).toBe(true)
  })

  test('reassembles a record delivered across two separate fs.watch callbacks', () => {
    const h = harness()
    startApi5xxDeadTurnWatcher(h.deps)
    const whole = line(resultOverloaded)
    const cut = Math.floor(whole.length / 2)
    h.write(whole.slice(0, cut))
    h.fire() // first callback: only a partial line is on disk
    expect(h.notices).toHaveLength(0)
    h.write(whole.slice(cut))
    h.fire() // second callback: the record completes → fires
    expect(h.notices).toHaveLength(1)
  })

  test('edge-latch across pumps: no re-fire while present, re-fires after a clear', () => {
    const h = harness()
    startApi5xxDeadTurnWatcher(h.deps)
    h.write(line(resultOverloaded)); h.fire()
    h.write(line(systemRateLimit)); h.fire() // still present
    expect(h.notices).toHaveLength(1)
    h.write(line(healthyResult)); h.fire() // clear
    h.write(line(resultOverloaded)); h.fire() // rising edge again
    expect(h.notices).toHaveLength(2)
  })

  test('initial read processes records already present before any change event', () => {
    const h = harness()
    h.write(line(resultOverloaded)) // present BEFORE start()
    startApi5xxDeadTurnWatcher(h.deps)
    expect(h.notices).toHaveLength(1)
  })

  test('file rotation/truncation resets the reassembly buffer (no fused record)', () => {
    const h = harness()
    startApi5xxDeadTurnWatcher(h.deps)
    // A long partial line buffered (no newline) — long enough that the rotated
    // file below is SHORTER than this offset, which is how truncation/rotation is
    // detectable (a same-path file shrinking below the read offset).
    h.write(`{"type":"result","is_error":false,"result":"${'x'.repeat(400)}`)
    h.fire()
    expect(h.notices).toHaveLength(0)
    // Rotation: brand-new shorter file whose first record is a real 5xx. The
    // stale partial must be dropped, not fused onto this line.
    h.rotate(line(resultOverloaded))
    h.fire()
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.matched).toBe('overloaded_error')
  })

  test('a throwing notify sink does not un-latch or crash the pump', () => {
    let buf = ''
    let onChange: (() => void) | undefined
    const readFrom = (_p: string, offset: number): JsonlReadResult | null => {
      const size = Buffer.byteLength(buf, 'utf8')
      return { bytes: buf.slice(size >= offset ? offset : 0), size }
    }
    let calls = 0
    startApi5xxDeadTurnWatcher({
      jsonlPath: '/virtual/x.jsonl',
      notify: () => { calls += 1; throw new Error('sink down') },
      ensureDir: () => {},
      watchDir: (_d, _b, cb) => { onChange = cb; return { close: () => {} } },
      readFrom,
    })
    buf += line(resultOverloaded)
    expect(() => onChange?.()).not.toThrow()
    expect(calls).toBe(1)
    // Still latched (a second 5xx must NOT re-fire despite the prior sink throw).
    buf += line(systemRateLimit)
    onChange?.()
    expect(calls).toBe(1)
  })
})

describe('realReadFrom (offset range read against a real file)', () => {
  test('reads only the bytes appended past the offset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api5xx-'))
    const path = join(dir, 'sess.jsonl')
    try {
      writeFileSync(path, 'first\n')
      const r1 = realReadFrom(path, 0)
      expect(r1?.bytes).toBe('first\n')
      appendFileSync(path, 'second\n')
      const r2 = realReadFrom(path, r1!.size)
      expect(r2?.bytes).toBe('second\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('missing file → null; empty file → empty bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api5xx-'))
    const path = join(dir, 'sess.jsonl')
    try {
      expect(realReadFrom(path, 0)).toBeNull()
      writeFileSync(path, '')
      expect(realReadFrom(path, 0)).toEqual({ bytes: '', size: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('truncation: file shorter than offset re-reads from 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api5xx-'))
    const path = join(dir, 'sess.jsonl')
    try {
      writeFileSync(path, 'aaaaaaaaaa\n')
      const size = realReadFrom(path, 0)!.size
      truncateSync(path, 0)
      writeFileSync(path, 'b\n')
      const r = realReadFrom(path, size)
      expect(r?.bytes).toBe('b\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('end-to-end against a real fs.watch + real file', () => {
  test('appending a 5xx result record fires the notice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api5xx-e2e-'))
    const path = join(dir, 'sess.jsonl')
    const notices: DeadTurnNotice[] = []
    writeFileSync(path, '')
    const w = startApi5xxDeadTurnWatcher({
      jsonlPath: path,
      notify: (n) => { notices.push(n) },
    })
    try {
      appendFileSync(path, line(assistantRecord))
      appendFileSync(path, line(resultOverloaded))
      // fs.watch is async; poll briefly. Also pump() directly as a deterministic
      // backstop so the assertion never flakes on watch-event timing.
      await new Promise((r) => setTimeout(r, 80))
      w.pump()
      expect(notices.length).toBeGreaterThanOrEqual(1)
      expect(notices[0]?.matched).toBe('overloaded_error')
    } finally {
      w.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
