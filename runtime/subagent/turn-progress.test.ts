import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SubagentRegistry } from './registry.ts'
import {
  isRealTurnEvent,
  parseTailForLastTurnProgress,
  realReadJsonlTail,
  makeJsonlTurnProgressProbe,
} from './turn-progress.ts'

/**
 * JSONL turn-progress reader — the source-of-truth signal the stuck-turn
 * watchdog keys off (Vajra incident 2026-04-21: port probes lie, the transcript
 * is the truth). A wedged turn keeps emitting only `system` / `queue-operation`
 * records, so the latest REAL turn event (assistant output / genuine user or
 * tool_result activity) must go stale even while bookkeeping noise keeps writing.
 */

const TS = (ms: number) => new Date(ms).toISOString()
const line = (o: unknown) => JSON.stringify(o)

describe('isRealTurnEvent', () => {
  test('assistant records are progress', () => {
    expect(isRealTurnEvent({ type: 'assistant', message: { content: 'hi' } })).toBe(true)
  })
  test('user text + tool_result blocks are progress', () => {
    expect(isRealTurnEvent({ type: 'user', message: { content: 'do X' } })).toBe(true)
    expect(
      isRealTurnEvent({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    ).toBe(true)
  })
  test('system / queue-operation / empty / meta records are NOT progress', () => {
    expect(isRealTurnEvent({ type: 'system' })).toBe(false)
    expect(isRealTurnEvent({ type: 'queue-operation' })).toBe(false)
    expect(isRealTurnEvent({ type: 'user', message: { content: '   ' } })).toBe(false)
    expect(isRealTurnEvent({ type: 'user', message: { content: [] } })).toBe(false)
    expect(isRealTurnEvent({ type: 'assistant', isMeta: true })).toBe(false)
  })
})

describe('parseTailForLastTurnProgress', () => {
  test('a wedged tail (only system/queue noise after the last assistant) reports the OLD timestamp', () => {
    const tail = [
      line({ type: 'assistant', timestamp: TS(1_000), message: { content: 'working' } }),
      line({ type: 'system', timestamp: TS(2_000) }),
      line({ type: 'queue-operation', timestamp: TS(3_000) }),
      line({ type: 'system', timestamp: TS(4_000) }),
    ].join('\n')
    expect(parseTailForLastTurnProgress(tail, { hadTruncatedHead: false }).lastProgressMs).toBe(
      1_000,
    )
  })

  test('a progressing tail reports the latest real turn timestamp', () => {
    const tail = [
      line({ type: 'assistant', timestamp: TS(1_000), message: { content: 'a' } }),
      line({ type: 'user', timestamp: TS(2_000), message: { content: [{ type: 'tool_result' }] } }),
      line({ type: 'assistant', timestamp: TS(5_000), message: { content: 'b' } }),
    ].join('\n')
    expect(parseTailForLastTurnProgress(tail, { hadTruncatedHead: false }).lastProgressMs).toBe(
      5_000,
    )
  })

  test('a truncated head line is discarded; unparseable / timestamp-less lines are skipped', () => {
    const tail = [
      '{"type":"assistant","timestamp":"BROKEN', // truncated head — dropped
      'not json at all',
      line({ type: 'assistant', message: { content: 'no ts' } }),
      line({ type: 'assistant', timestamp: TS(7_000), message: { content: 'real' } }),
    ].join('\n')
    expect(parseTailForLastTurnProgress(tail, { hadTruncatedHead: true }).lastProgressMs).toBe(
      7_000,
    )
  })

  test('no real turn events → lastProgressMs null, but earliestEventMs tracks the noise floor', () => {
    const tail = [
      line({ type: 'system', timestamp: TS(2_000) }),
      line({ type: 'queue-operation', timestamp: TS(3_000) }),
      line({ type: 'queue-operation' }), // no timestamp — ignored
    ].join('\n')
    const parsed = parseTailForLastTurnProgress(tail, { hadTruncatedHead: false })
    expect(parsed.lastProgressMs).toBeNull()
    expect(parsed.earliestEventMs).toBe(2_000) // earliest timestamped record of any type
  })

  test('a truly empty tail → both null', () => {
    const parsed = parseTailForLastTurnProgress('', { hadTruncatedHead: false })
    expect(parsed.lastProgressMs).toBeNull()
    expect(parsed.earliestEventMs).toBeNull()
  })
})

describe('realReadJsonlTail', () => {
  test('reads the tail of a real file and flags a truncated head when offset > 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-progress-'))
    try {
      const p = join(dir, 'session.jsonl')
      const big = 'x'.repeat(2_000)
      writeFileSync(p, `${big}\nTAILMARKER\n`)
      const read = realReadJsonlTail(p, 64)
      expect(read).not.toBeNull()
      expect(read!.hadTruncatedHead).toBe(true)
      expect(read!.bytes.endsWith('TAILMARKER\n')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('missing / empty file → null (never throws)', () => {
    expect(realReadJsonlTail('/no/such/path.jsonl')).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'turn-progress-'))
    try {
      const p = join(dir, 'empty.jsonl')
      writeFileSync(p, '')
      expect(realReadJsonlTail(p)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('makeJsonlTurnProgressProbe', () => {
  const reg = new SubagentRegistry()
  // No persistence sink → create() populates the in-memory map synchronously;
  // read the record back (describe scope can't await).
  void reg.create({
    run_id: 'r1',
    instance_key: 'i',
    agent_kind: 'forge',
    spawn_depth: 0,
  })
  const rec = reg.byRunId('r1')!

  test('resolves path → reads tail → returns latest real-turn timestamp', () => {
    const probe = makeJsonlTurnProgressProbe({
      resolveTranscriptPath: () => '/fake/path.jsonl',
      readTail: () => ({
        bytes: [
          line({ type: 'assistant', timestamp: TS(1_000), message: { content: 'a' } }),
          line({ type: 'system', timestamp: TS(9_000) }),
        ].join('\n'),
        hadTruncatedHead: false,
      }),
    })
    expect(probe(rec)).toBe(1_000) // system record after the assistant is ignored
  })

  test('readable transcript with only noise in the tail → earliest floor, NOT null (no last_event_at fallback)', () => {
    // The last real progress record scrolled out of the 256 KB window; the tail
    // holds only system/queue noise. The probe must report a stale floor so the
    // watchdog stays on the JSONL signal rather than falling back to a
    // heartbeat-fresh last_event_at. Codex P2 finding, 2026-06-25.
    const probe = makeJsonlTurnProgressProbe({
      resolveTranscriptPath: () => '/fake/path.jsonl',
      readTail: () => ({
        bytes: [
          line({ type: 'system', timestamp: TS(4_000) }),
          line({ type: 'queue-operation', timestamp: TS(5_000) }),
        ].join('\n'),
        hadTruncatedHead: false,
      }),
    })
    expect(probe(rec)).toBe(4_000)
  })

  test('readable but zero parseable timestamps → null (genuine no-signal)', () => {
    const probe = makeJsonlTurnProgressProbe({
      resolveTranscriptPath: () => '/fake/path.jsonl',
      readTail: () => ({ bytes: 'not json\nalso not json\n', hadTruncatedHead: false }),
    })
    expect(probe(rec)).toBeNull()
  })

  test('null path (no transcript) → null', () => {
    const probe = makeJsonlTurnProgressProbe({
      resolveTranscriptPath: () => null,
      readTail: () => {
        throw new Error('should not be called')
      },
    })
    expect(probe(rec)).toBeNull()
  })

  test('unreadable file (readTail null) → null', () => {
    const probe = makeJsonlTurnProgressProbe({
      resolveTranscriptPath: () => '/fake/path.jsonl',
      readTail: () => null,
    })
    expect(probe(rec)).toBeNull()
  })
})
