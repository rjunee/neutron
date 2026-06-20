/**
 * Ported/adapted from Nova `gateway/tests/session-capture-cap.test.ts`.
 * Neutron pins `--session-id` up-front, so capture degenerates to the
 * JSONL-existence poll (the part that actually matters): bounded attempts,
 * succeed as soon as the transcript lands, give up cleanly after the cap.
 */

import { describe, it, expect } from 'bun:test'
import { captureSession } from '../session-capture.ts'

const noSleep = async (): Promise<void> => {}

describe('captureSession (JSONL gate poll)', () => {
  it('captures immediately when the JSONL already exists', async () => {
    const r = await captureSession('sid', '/cwd', { jsonlExists: () => true, sleep: noSleep })
    expect(r.captured).toBe(true)
    expect(r.attempts).toBe(1)
  })

  it('captures once the JSONL appears mid-poll', async () => {
    let calls = 0
    const r = await captureSession(
      'sid',
      '/cwd',
      {
        jsonlExists: () => {
          calls += 1
          return calls >= 3
        },
        sleep: noSleep,
      },
      { maxAttempts: 5, attemptDelayMs: 1 },
    )
    expect(r.captured).toBe(true)
    expect(r.attempts).toBe(3)
  })

  it('gives up after the attempt cap without ever capturing', async () => {
    let calls = 0
    const r = await captureSession(
      'sid',
      '/cwd',
      {
        jsonlExists: () => {
          calls += 1
          return false
        },
        sleep: noSleep,
      },
      { maxAttempts: 4, attemptDelayMs: 1 },
    )
    expect(r.captured).toBe(false)
    expect(r.attempts).toBe(4)
    expect(calls).toBe(4)
  })
})
