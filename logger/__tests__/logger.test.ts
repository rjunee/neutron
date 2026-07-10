/**
 * @neutronai/logger unit tests (refactor O1).
 *
 * Covers: level gating via NEUTRON_LOG_LEVEL (default + each level +
 * garbage), line formatting + logfmt escaping, `once` (GBrain-latch
 * semantics + clearOnce edge re-arm), `rateLimited` windowing
 * (wedge-cooldown semantics: stamp only on real emit), sink/clock
 * injection, and the per-process (cross-instance) latch scope.
 *
 * Every test injects a capturing sink, so nothing prints to the real
 * console; NEUTRON_LOG_LEVEL is saved/restored around every test and all
 * logger calls are synchronous within each test body, so the env flip can't
 * leak into concurrently-scheduled test files in the same bun process.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  createLogger,
  formatLogLine,
  formatLogValue,
  resetLoggerStateForTests,
  resolveLogLevel,
  type LogLevel,
} from '../index.ts'

type Captured = { level: LogLevel; line: string }

function capture(): { sink: (level: LogLevel, line: string) => void; lines: Captured[] } {
  const lines: Captured[] = []
  return { sink: (level, line) => lines.push({ level, line }), lines }
}

const savedLevel = process.env['NEUTRON_LOG_LEVEL']

beforeEach(() => {
  delete process.env['NEUTRON_LOG_LEVEL']
  resetLoggerStateForTests()
})

afterEach(() => {
  if (savedLevel === undefined) delete process.env['NEUTRON_LOG_LEVEL']
  else process.env['NEUTRON_LOG_LEVEL'] = savedLevel
  resetLoggerStateForTests()
})

// ---------------------------------------------------------------------------
// resolveLogLevel — NEUTRON_LOG_LEVEL parsing
// ---------------------------------------------------------------------------

describe('resolveLogLevel', () => {
  test('defaults to info when unset', () => {
    expect(resolveLogLevel(undefined)).toBe('info')
  })

  test('parses each standard level', () => {
    expect(resolveLogLevel('error')).toBe('error')
    expect(resolveLogLevel('warn')).toBe('warn')
    expect(resolveLogLevel('info')).toBe('info')
    expect(resolveLogLevel('debug')).toBe('debug')
  })

  test('trims and lowercases (repo env-parsing convention)', () => {
    expect(resolveLogLevel(' DEBUG ')).toBe('debug')
    expect(resolveLogLevel('Warn')).toBe('warn')
  })

  test('unknown values fall back to info', () => {
    expect(resolveLogLevel('verbose')).toBe('info')
    expect(resolveLogLevel('')).toBe('info')
    expect(resolveLogLevel('  ')).toBe('info')
  })
})

// ---------------------------------------------------------------------------
// Line formatting + escaping
// ---------------------------------------------------------------------------

describe('formatLogValue', () => {
  test('bare tokens pass through unquoted', () => {
    expect(formatLogValue('route')).toBe('route')
    expect(formatLogValue('web:owner/topic-1')).toBe('web:owner/topic-1')
  })

  test('numbers, booleans, null render bare', () => {
    expect(formatLogValue(42)).toBe('42')
    expect(formatLogValue(0.25)).toBe('0.25')
    expect(formatLogValue(true)).toBe('true')
    expect(formatLogValue(false)).toBe('false')
    expect(formatLogValue(null)).toBe('null')
  })

  test('values with spaces are double-quoted', () => {
    expect(formatLogValue('two words')).toBe('"two words"')
  })

  test('embedded double quotes are backslash-escaped', () => {
    expect(formatLogValue('say "hi"')).toBe('"say \\"hi\\""')
  })

  test('backslashes are escaped', () => {
    expect(formatLogValue('a\\b')).toBe('"a\\\\b"')
  })

  test('equals sign forces quoting (k=v splitting stays unambiguous)', () => {
    expect(formatLogValue('a=b')).toBe('"a=b"')
  })

  test('single quotes force quoting', () => {
    expect(formatLogValue("it's")).toBe('"it\'s"')
  })

  test('newline / tab / carriage return are escaped so lines stay single-line', () => {
    expect(formatLogValue('a\nb')).toBe('"a\\nb"')
    expect(formatLogValue('a\tb')).toBe('"a\\tb"')
    expect(formatLogValue('a\rb')).toBe('"a\\rb"')
  })

  test('empty string renders as ""', () => {
    expect(formatLogValue('')).toBe('""')
  })
})

describe('formatLogLine', () => {
  test('follows the LOG_TAG event=… k=v convention', () => {
    expect(formatLogLine('chat-bridge', 'route', { channel: 'web', topic: 7, delivered: true })).toBe(
      '[chat-bridge] event=route channel=web topic=7 delivered=true',
    )
  })

  test('no fields → tag + event only', () => {
    expect(formatLogLine('reminder-outbound', 'drain')).toBe('[reminder-outbound] event=drain')
  })

  test('undefined fields are omitted, null is kept', () => {
    expect(formatLogLine('s', 'e', { a: undefined, b: null, c: 1 })).toBe('[s] event=e b=null c=1')
  })

  test('event names needing quoting are escaped too', () => {
    expect(formatLogLine('s', 'two words')).toBe('[s] event="two words"')
  })

  test('field insertion order is emission order', () => {
    expect(formatLogLine('s', 'e', { z: 1, a: 2 })).toBe('[s] event=e z=1 a=2')
  })

  // Log-forging boundary: subsystem + field KEYS must be escaped too, or a
  // newline/space/=/quote in either forges a second line or an extra k=v pair
  // (Codex O1 review). The line must stay single-line + whitespace-splittable.
  test('a field key with a space is quoted (cannot forge a second pair)', () => {
    expect(formatLogLine('s', 'e', { 'bad key': 'v' })).toBe('[s] event=e "bad key"=v')
  })

  test('a field key with a newline is escaped (stays single-line)', () => {
    const line = formatLogLine('s', 'e', { 'a\nb': 'v' })
    expect(line).toBe('[s] event=e "a\\nb"=v')
    expect(line).not.toContain('\n')
  })

  test('field keys with = or quotes are quoted', () => {
    expect(formatLogLine('s', 'e', { 'a=b': 'v' })).toBe('[s] event=e "a=b"=v')
    expect(formatLogLine('s', 'e', { 'a"b': 'v' })).toBe('[s] event=e "a\\"b"=v')
  })

  test('an empty field key is quoted', () => {
    expect(formatLogLine('s', 'e', { '': 'v' })).toBe('[s] event=e ""=v')
  })

  test('a subsystem with a newline cannot forge a second line', () => {
    const line = formatLogLine('safe]\n[event=forged', 'evt', { ok: 'x' })
    expect(line).not.toContain('\n')
    expect(line).toBe('["safe]\\n[event=forged"] event=evt ok=x')
  })

  test('a subsystem with spaces or brackets is quoted', () => {
    expect(formatLogLine('two words', 'e')).toBe('["two words"] event=e')
    expect(formatLogLine('a]b', 'e')).toBe('["a]b"] event=e')
  })

  test('a normal single-token subsystem renders bare', () => {
    expect(formatLogLine('chat-bridge', 'e')).toBe('[chat-bridge] event=e')
  })
})

// ---------------------------------------------------------------------------
// Level gating via NEUTRON_LOG_LEVEL
// ---------------------------------------------------------------------------

describe('level gating', () => {
  test('default (unset) → error/warn/info emit, debug is suppressed', () => {
    const { sink, lines } = capture()
    const log = createLogger('gate', { sink })
    log.error('e')
    log.warn('w')
    log.info('i')
    log.debug('d')
    expect(lines.map((l) => l.level)).toEqual(['error', 'warn', 'info'])
  })

  test('NEUTRON_LOG_LEVEL=error → only error', () => {
    process.env['NEUTRON_LOG_LEVEL'] = 'error'
    const { sink, lines } = capture()
    const log = createLogger('gate', { sink })
    log.error('e')
    log.warn('w')
    log.info('i')
    log.debug('d')
    expect(lines.map((l) => l.level)).toEqual(['error'])
  })

  test('NEUTRON_LOG_LEVEL=warn → error + warn', () => {
    process.env['NEUTRON_LOG_LEVEL'] = 'warn'
    const { sink, lines } = capture()
    const log = createLogger('gate', { sink })
    log.error('e')
    log.warn('w')
    log.info('i')
    log.debug('d')
    expect(lines.map((l) => l.level)).toEqual(['error', 'warn'])
  })

  test('NEUTRON_LOG_LEVEL=debug → everything', () => {
    process.env['NEUTRON_LOG_LEVEL'] = 'debug'
    const { sink, lines } = capture()
    const log = createLogger('gate', { sink })
    log.error('e')
    log.warn('w')
    log.info('i')
    log.debug('d')
    expect(lines.map((l) => l.level)).toEqual(['error', 'warn', 'info', 'debug'])
  })

  test('garbage NEUTRON_LOG_LEVEL falls back to the info default', () => {
    process.env['NEUTRON_LOG_LEVEL'] = 'chatty'
    const { sink, lines } = capture()
    const log = createLogger('gate', { sink })
    log.debug('d')
    log.info('i')
    expect(lines.map((l) => l.level)).toEqual(['info'])
  })

  test('level is re-read per emit (not cached at createLogger time)', () => {
    const { sink, lines } = capture()
    const log = createLogger('gate', { sink })
    process.env['NEUTRON_LOG_LEVEL'] = 'error'
    log.info('hidden')
    process.env['NEUTRON_LOG_LEVEL'] = 'debug'
    log.debug('shown')
    expect(lines.map((l) => l.line)).toEqual(['[gate] event=shown'])
  })

  test('emitted lines carry the subsystem tag and fields', () => {
    const { sink, lines } = capture()
    const log = createLogger('chat-bridge', { sink })
    log.info('route', { channel: 'web', body: 'two words' })
    expect(lines).toEqual([{ level: 'info', line: '[chat-bridge] event=route channel=web body="two words"' }])
  })
})

// ---------------------------------------------------------------------------
// once — the GBrain latchIfUnavailable semantics
// ---------------------------------------------------------------------------

describe('once', () => {
  test('logs a key exactly once per process', () => {
    const { sink, lines } = capture()
    const log = createLogger('gbrain', { sink })
    log.once('gbrain_unavailable').warn('gbrain_unavailable', { path: 'a.md' })
    log.once('gbrain_unavailable').warn('gbrain_unavailable', { path: 'b.md' })
    log.once('gbrain_unavailable').warn('gbrain_unavailable', { path: 'c.md' })
    expect(lines.map((l) => l.line)).toEqual(['[gbrain] event=gbrain_unavailable path=a.md'])
  })

  test('distinct keys latch independently', () => {
    const { sink, lines } = capture()
    const log = createLogger('s', { sink })
    log.once('k1').info('e1')
    log.once('k2').info('e2')
    log.once('k1').info('e1-again')
    expect(lines.map((l) => l.line)).toEqual(['[s] event=e1', '[s] event=e2'])
  })

  test('the latch is per-process across logger instances of one subsystem', () => {
    const { sink, lines } = capture()
    const a = createLogger('shared', { sink })
    const b = createLogger('shared', { sink })
    a.once('k').info('first')
    b.once('k').info('second')
    expect(lines.map((l) => l.line)).toEqual(['[shared] event=first'])
  })

  test('different subsystems do not share latch keys', () => {
    const { sink, lines } = capture()
    createLogger('one', { sink }).once('k').info('e')
    createLogger('two', { sink }).once('k').info('e')
    expect(lines.map((l) => l.line)).toEqual(['[one] event=e', '[two] event=e'])
  })

  test('separator-boundary (subsystem/key with a newline) does NOT collide for once', () => {
    // (`a\nb`, `c`) and (`a`, `b\nc`) would share one joined key `a\nb\nc` under a
    // string-concatenated state key; the nested map keeps them distinct so neither
    // once() latch suppresses the other. Assert the isolation behaviorally (both
    // fire) rather than the exact formatted text, which escapes the newline.
    const { sink, lines } = capture()
    createLogger('a\nb', { sink }).once('c').info('first')
    createLogger('a', { sink }).once('b\nc').info('second')
    expect(lines.length).toBe(2)
    expect(lines.map((l) => l.line).join('|')).toContain('event=first')
    expect(lines.map((l) => l.line).join('|')).toContain('event=second')
  })

  test('separator-boundary isolation also holds for rateLimited', () => {
    let t = 0
    const { sink, lines } = capture()
    createLogger('a\nb', { sink, now: () => t }).rateLimited('c', 1000).info('first')
    createLogger('a', { sink, now: () => t }).rateLimited('b\nc', 1000).info('second')
    // Both fire in the same window — distinct pairs, no cross-suppression.
    expect(lines.length).toBe(2)
    expect(lines.map((l) => l.line).join('|')).toContain('event=first')
    expect(lines.map((l) => l.line).join('|')).toContain('event=second')
  })

  test('a level-suppressed emit does NOT burn the latch', () => {
    const { sink, lines } = capture()
    const log = createLogger('s', { sink })
    process.env['NEUTRON_LOG_LEVEL'] = 'error'
    log.once('k').debug('hidden')
    process.env['NEUTRON_LOG_LEVEL'] = 'debug'
    log.once('k').debug('shown')
    expect(lines.map((l) => l.line)).toEqual(['[s] event=shown'])
  })

  test('clearOnce re-arms the key (edge-triggered latch falling edge)', () => {
    const { sink, lines } = capture()
    const log = createLogger('banner', { sink })
    // Rising edge: banner appears → fires once, holds while present.
    log.once('temporary').warn('rate_limit_banner')
    log.once('temporary').warn('rate_limit_banner')
    // Falling edge: banner clears → re-arm.
    log.clearOnce('temporary')
    // Next rising edge fires again.
    log.once('temporary').warn('rate_limit_banner')
    expect(lines).toHaveLength(2)
  })

  test('clearOnce on a never-fired key is a no-op', () => {
    const { sink, lines } = capture()
    const log = createLogger('s', { sink })
    log.clearOnce('never')
    log.once('never').info('e')
    expect(lines).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// rateLimited — the wedge-alert cooldown semantics
// ---------------------------------------------------------------------------

describe('rateLimited', () => {
  test('logs at most once per window per key', () => {
    let now = 1_000_000
    const { sink, lines } = capture()
    const log = createLogger('wedge', { sink, now: () => now })
    const rl = () => log.rateLimited('session-1', 30_000)

    rl().warn('wedge_alert') // fires, stamps t=1_000_000
    now += 10_000
    rl().warn('wedge_alert') // within window → deduped
    now += 19_999
    rl().warn('wedge_alert') // 29_999 elapsed, still within → deduped
    now += 1
    rl().warn('wedge_alert') // exactly 30_000 elapsed → fires (now - last >= ms)
    expect(lines).toHaveLength(2)
  })

  test('windows are per key', () => {
    let now = 0
    const { sink, lines } = capture()
    const log = createLogger('wedge', { sink, now: () => now })
    log.rateLimited('a', 1000).info('e')
    log.rateLimited('b', 1000).info('e')
    log.rateLimited('a', 1000).info('e') // deduped
    expect(lines).toHaveLength(2)
  })

  test('a suppressed attempt does not extend the window (stamp on emit only)', () => {
    let now = 0
    const { sink, lines } = capture()
    const log = createLogger('wedge', { sink, now: () => now })
    log.rateLimited('k', 1000).info('first') // fires at t=0
    now = 999
    log.rateLimited('k', 1000).info('deduped') // suppressed — must NOT re-stamp
    now = 1000
    log.rateLimited('k', 1000).info('second') // 1000 elapsed since the EMIT → fires
    expect(lines.map((l) => l.line)).toEqual(['[wedge] event=first', '[wedge] event=second'])
  })

  test('a level-suppressed emit does not start a window', () => {
    let now = 0
    const { sink, lines } = capture()
    const log = createLogger('wedge', { sink, now: () => now })
    process.env['NEUTRON_LOG_LEVEL'] = 'error'
    log.rateLimited('k', 60_000).info('hidden') // level-gated, no stamp
    process.env['NEUTRON_LOG_LEVEL'] = 'info'
    log.rateLimited('k', 60_000).info('shown') // window never started → fires
    expect(lines.map((l) => l.line)).toEqual(['[wedge] event=shown'])
  })

  test('the window is shared per-process across logger instances', () => {
    let now = 0
    const { sink, lines } = capture()
    const a = createLogger('shared', { sink, now: () => now })
    const b = createLogger('shared', { sink, now: () => now })
    a.rateLimited('k', 1000).info('first')
    b.rateLimited('k', 1000).info('deduped')
    expect(lines).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Default sink routing (level → console method)
// ---------------------------------------------------------------------------

describe('default sink', () => {
  test('routes each level to its matching console method', () => {
    const calls: Array<[string, unknown]> = []
    const orig = {
      error: console.error,
      warn: console.warn,
      log: console.log,
      debug: console.debug,
    }
    console.error = (msg: unknown) => void calls.push(['error', msg])
    console.warn = (msg: unknown) => void calls.push(['warn', msg])
    console.log = (msg: unknown) => void calls.push(['log', msg])
    console.debug = (msg: unknown) => void calls.push(['debug', msg])
    try {
      process.env['NEUTRON_LOG_LEVEL'] = 'debug'
      const log = createLogger('sinktest')
      log.error('e')
      log.warn('w')
      log.info('i')
      log.debug('d')
    } finally {
      console.error = orig.error
      console.warn = orig.warn
      console.log = orig.log
      console.debug = orig.debug
    }
    expect(calls).toEqual([
      ['error', '[sinktest] event=e'],
      ['warn', '[sinktest] event=w'],
      ['log', '[sinktest] event=i'],
      ['debug', '[sinktest] event=d'],
    ])
  })
})
