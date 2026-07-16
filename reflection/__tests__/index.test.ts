import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'

import { createReflection, appendCorrection } from '../index.ts'
import { NexusStore } from '@neutronai/gateway/nexus/nexus-store.ts'
import { emitNexusEvent, reflectionLearningEvent } from '@neutronai/gateway/nexus/nexus-emit.ts'

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

  // Time-rot regression guard for #90 (commit 939c057). readDiary MUST thread the
  // injected clock into the read window; if it falls back to real Date.now(), a
  // write+read at an injected clock far from wall-clock reads an empty window.
  //
  // The injected clock here is set deliberately FAR in the past (2020) so the
  // day-file written for that date is always outside the default 7-day window
  // computed from real Date.now() — regardless of the wall-clock the suite runs
  // on. That makes this an ALWAYS-ON guard: it fails the instant readDiary stops
  // honoring the injected clock, rather than only once wall-clock drifts past the
  // hardcoded date (the silent-rot mode the original bug shipped in).
  test('readDiary honors the injected clock even far from wall-clock (no Date.now() read-window rot)', () => {
    const farPast = () => Date.parse('2020-06-21T08:00:00.000Z')
    const r = createReflection({ ownerDataDir: tmp, now: farPast })
    r.appendDiary({ text: 'Journaled under a clock years before wall-clock.' })
    // With the read window anchored to the injected clock the entry is found;
    // a Date.now()-defaulted read window would be empty here.
    const back = r.readDiary()
    expect(back).toHaveLength(1)
    expect(back[0]?.text).toBe('Journaled under a clock years before wall-clock.')
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

  test('loadBuildContext returns CORRECTIONS ONLY (excludes the diary) for the builder (RB2 (b))', () => {
    const r = createReflection({ ownerDataDir: tmp })
    appendCorrection({
      ownerDataDir: tmp,
      wrong: 'used JS',
      right: 'always prefer TypeScript',
      why: 'house style',
      scope: 'general',
      source: 'no, use TS',
      observed_at: Date.now(),
    })
    r.appendDiary({ text: 'A FREEFORM DIARY LINE that must never reach a tool-enabled builder' })

    // The CHAT read path carries both corrections AND the free-form diary.
    const chat = r.loadContext()
    expect(chat).toContain('always prefer TypeScript')
    expect(chat).toContain('<recent_diary>')
    expect(chat).toContain('A FREEFORM DIARY LINE')

    // The BUILD read path carries corrections ONLY — the diary (loosest surface) is
    // excluded from the tool-enabled Forge builder.
    const build = r.loadBuildContext()
    expect(build).toContain('always prefer TypeScript')
    expect(build).toContain('<learned_corrections>')
    expect(build).not.toContain('<recent_diary>')
    expect(build).not.toContain('A FREEFORM DIARY LINE')
  })

  test('loadBuildContext is null when there are no corrections (diary alone does not qualify)', () => {
    const r = createReflection({ ownerDataDir: tmp })
    r.appendDiary({ text: 'only a diary entry, no corrections yet' })
    expect(r.loadBuildContext()).toBeNull()
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

describe('createReflection — RC2 nexus learning emitter', () => {
  test('a detected correction ALSO lands as a scoped learning event on the nexus', async () => {
    const nexusHome = mkdtempSync(join(tmpdir(), 'neutron-refl-nexus-'))
    const nexus = new NexusStore({ owner_home: nexusHome })
    try {
      const { substrate } = judgeSubstrate(
        '{"is_correction":true,"wrong":"used spaces","right":"use tabs","why":"repo is tab-indented"}',
      )
      const r = createReflection({
        ownerDataDir: tmp,
        substrate,
        now: () => Date.parse('2026-06-21T08:00:00.000Z'),
        // The SAME glue the composer wires (scope → project nexus).
        emitLearning: ({ scope, correction }): void =>
          emitNexusEvent(nexus, scope, reflectionLearningEvent(correction)),
      })

      r.onTurnComplete({
        user_text: 'no, use tabs not spaces',
        agent_text: 'I indented with spaces.',
        scope: 'project-globex',
      })
      await flush()

      // The correction is still durable in the corrections-log (unchanged).
      expect(r.readCorrections()).toHaveLength(1)

      // AND it surfaced on the project nexus as a `learning` (fire-and-forget →
      // poll for it).
      let rows: Awaited<ReturnType<NexusStore['readRecent']>> = []
      for (let i = 0; i < 200; i++) {
        rows = await nexus.readRecent('project-globex', { limit: 100 })
        if (rows.length >= 1) break
        await new Promise((res) => setTimeout(res, 5))
      }
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('learning')
      expect(rows[0]?.actor_kind).toBe('reflection')
      expect(rows[0]?.body).toContain('use tabs')

      // Scoped: another project sees nothing.
      expect(await nexus.readRecent('other-proj', { limit: 100 })).toEqual([])
    } finally {
      nexus.closeAll()
      rmSync(nexusHome, { recursive: true, force: true })
    }
  })

  test('a non-correction turn emits no learning event', async () => {
    const nexusHome = mkdtempSync(join(tmpdir(), 'neutron-refl-nexus-'))
    const nexus = new NexusStore({ owner_home: nexusHome })
    try {
      const { substrate } = judgeSubstrate('{"is_correction":false,"wrong":"","right":"","why":""}')
      const r = createReflection({
        ownerDataDir: tmp,
        substrate,
        emitLearning: ({ scope, correction }): void =>
          emitNexusEvent(nexus, scope, reflectionLearningEvent(correction)),
      })
      r.onTurnComplete({ user_text: 'actually, what is the weather?', agent_text: 'sunny', scope: 'p1' })
      await flush()
      expect(await nexus.readRecent('p1', { limit: 100 })).toEqual([])
    } finally {
      nexus.closeAll()
      rmSync(nexusHome, { recursive: true, force: true })
    }
  })

  test('a throwing emitLearning never breaks the durable correction write', async () => {
    const { substrate } = judgeSubstrate(
      '{"is_correction":true,"wrong":"a","right":"b","why":"c"}',
    )
    const r = createReflection({
      ownerDataDir: tmp,
      substrate,
      emitLearning: () => {
        throw new Error('nexus exploded')
      },
    })
    r.onTurnComplete({ user_text: 'no, that is wrong', agent_text: 'x', scope: 'p1' })
    await flush()
    // The correction is still logged — the emitter throw was isolated.
    expect(r.readCorrections()).toHaveLength(1)
  })
})
