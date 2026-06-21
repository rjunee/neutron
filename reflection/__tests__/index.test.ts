import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Substrate } from '../../runtime/substrate.ts'
import type { Event } from '../../runtime/events.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'

import { createReflection } from '../index.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-reflection-idx-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** A substrate that emits a fixed JSON verdict and records that it was called. */
function judgeSubstrate(verdict: string): { substrate: Substrate; calls: () => number } {
  let calls = 0
  const substrate: Substrate = {
    start(): SessionHandle {
      calls += 1
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: verdict }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'fake' }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
  return { substrate, calls: () => calls }
}

/** Wait for the fire-and-forget detection microtasks/timers to settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

describe('createReflection — diary read/write', () => {
  test('appendDiary then readDiary round-trips (the agent writes + reads its journal)', () => {
    const r = createReflection({ ownerDataDir: tmp, now: () => Date.parse('2026-06-21T08:00:00.000Z') })
    r.appendDiary({ text: 'Investigated the memory subsystems before building.' })
    const back = r.readDiary()
    expect(back).toHaveLength(1)
    expect(back[0]?.text).toBe('Investigated the memory subsystems before building.')
  })
})

describe('createReflection — correction detected → logged → retrievable → applied', () => {
  test('a corrective turn is detected, logged, and surfaced in the context block', async () => {
    const { substrate, calls } = judgeSubstrate(
      '{"is_correction":true,"wrong":"deployed to prod","right":"default to staging unless told otherwise","why":"prod is risky"}',
    )
    const r = createReflection({
      ownerDataDir: tmp,
      substrate,
      now: () => Date.parse('2026-06-21T08:00:00.000Z'),
    })

    // Before any correction, there is nothing to inject.
    expect(r.loadContext()).toBeNull()

    // The owner corrects the agent.
    r.onTurnComplete({
      user_text: 'no, do not deploy to prod — use staging',
      agent_text: 'I deployed the change to prod.',
      scope: 'project-globex',
    })
    await flush()

    // → logged + retrievable
    expect(calls()).toBe(1)
    const logged = r.readCorrections()
    expect(logged).toHaveLength(1)
    expect(logged[0]?.right).toBe('default to staging unless told otherwise')
    expect(logged[0]?.scope).toBe('project-globex')

    // → a diary breadcrumb was also dropped
    const diary = r.readDiary()
    expect(diary.some((e) => e.kind === 'correction')).toBe(true)

    // → APPLIED: the next session's context block carries the learning so the
    //   agent adapts silently.
    const ctx = r.loadContext()
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('<learned_corrections>')
    expect(ctx).toContain('default to staging unless told otherwise')
    expect(ctx).toContain('Apply them SILENTLY')
  })

  test('a non-corrective turn that passes the pre-gate is judged but not logged', async () => {
    const { substrate, calls } = judgeSubstrate('{"is_correction":false,"wrong":"","right":"","why":""}')
    const r = createReflection({ ownerDataDir: tmp, substrate })
    // "actually" trips the pre-gate, but the judge says it is not a correction.
    r.onTurnComplete({ user_text: 'actually, what is the weather today?', agent_text: 'It is sunny.' })
    await flush()
    expect(calls()).toBe(1)
    expect(r.readCorrections()).toHaveLength(0)
  })

  test('the deterministic pre-gate skips the LLM on ordinary turns', async () => {
    const { substrate, calls } = judgeSubstrate('{"is_correction":true,"wrong":"","right":"x","why":""}')
    const r = createReflection({ ownerDataDir: tmp, substrate })
    r.onTurnComplete({ user_text: 'thanks, that is perfect', agent_text: 'glad it helped' })
    await flush()
    expect(calls()).toBe(0) // pre-gate short-circuited; no dispatch, no log
    expect(r.readCorrections()).toHaveLength(0)
  })

  test('detection OFF (no substrate): onTurnComplete is a no-op, diary still works', async () => {
    const r = createReflection({ ownerDataDir: tmp })
    r.onTurnComplete({ user_text: 'no, that is wrong', agent_text: 'here is the answer' })
    await flush()
    expect(r.readCorrections()).toHaveLength(0) // no judge → nothing logged
    r.appendDiary({ text: 'still journaling without an LLM' })
    expect(r.readDiary()).toHaveLength(1) // diary + read-back unaffected
  })
})
