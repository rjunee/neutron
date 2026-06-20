/**
 * 2026-05-29 r2 IMPORTANT fix — onboarding-handoff hook concurrency tests,
 * updated 2026-06-11 for Item 5 (free-form opening message, ISSUES #208):
 * the composer is now `ComposeProjectOpeningFn` (body-only, no button
 * labels) and every emit carries `options: []`.
 *
 * Pre-r2 `emitProjectSeeds` awaited each composer call serially, so the
 * wow_fired → completed transition was blocked for
 * `N × per-call-latency` (e.g. 8 projects × ~8 s Opus round-trip of
 * unmoving UI). This file pins the bounded-concurrency behaviour:
 *
 *   1. Total wall time for the parallel batch is ROUGHLY
 *      `ceil(N / pool) × per-call-latency`, not `N × per-call-latency`.
 *   2. Output is order-preserving (sidebar `created_at` order matches input).
 *   3. Per-row LLM failure isolation: one rejected composer call falls back
 *      to the deterministic prose while OTHER projects still get the LLM
 *      body.
 *   4. `mapWithBoundedConcurrency` respects its concurrency budget and
 *      collapses to serial when N <= pool size.
 *   5. With no composer wired (Open self-hoster path), the loop still
 *      emits per project — order + deterministic-prose fallback intact.
 *
 * The pre-Item-5 keyboard-shape block (ISSUES #69 — 2-button no-match
 * fallback vs 3-button rich-data keyboard) was REPLACED by the
 * zero-button block at the bottom: Item 5 removes ALL buttons from
 * newly-emitted openings. Legacy rows already in project DBs keep their
 * buttons; the inbound handling for those values lives (inert) in
 * `gateway/http/chat-bridge.ts` and is covered by its tests.
 */

import { afterEach, beforeEach, expect, test, describe } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import {
  buildOnboardingHandoffHook,
  mapWithBoundedConcurrency,
  DEFAULT_COMPOSER_CONCURRENCY,
  type ComposeProjectOpeningFn,
} from '../build-onboarding-handoff.ts'
import type { ImportResult } from '../../../onboarding/history-import/types.ts'

function fakeImportResult(names: ReadonlyArray<string>): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects: names.map((name) => ({
      name,
      rationale: `Pass-2 summary for ${name}.`,
      suggested_topics: [`${name} topic A`, `${name} topic B`],
    })),
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {
      typical_message_length: 'medium',
      formality: 'casual',
      directness: 'direct',
      hedging_frequency: 'low',
    },
    facts: {},
  } as unknown as ImportResult
}

describe('mapWithBoundedConcurrency', () => {
  test('preserves input order in output', async () => {
    const items = [10, 20, 30, 40, 50]
    const out = await mapWithBoundedConcurrency(items, 2, async (n) => {
      // Random-ish stagger so order would scramble if naive
      await new Promise<void>((r) => setTimeout(r, (50 - n) / 5))
      return n * 2
    })
    expect(out).toEqual([20, 40, 60, 80, 100])
  })

  test('respects concurrency budget — never more than N tasks in flight', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    await mapWithBoundedConcurrency(items, 4, async () => {
      inFlight += 1
      if (inFlight > peak) peak = inFlight
      await new Promise<void>((r) => setTimeout(r, 10))
      inFlight -= 1
      return 0
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1) // actually parallelised
  })

  test('parallel batch is faster than serial when work is genuinely slow', async () => {
    // 8 items × 50 ms per item.
    // Serial would be ~400 ms; pool=4 should be roughly ~100 ms.
    // Pin a generous upper bound that still proves parallelism.
    const items = Array.from({ length: 8 }, (_, i) => i)
    const t0 = Date.now()
    await mapWithBoundedConcurrency(items, 4, async () => {
      await new Promise<void>((r) => setTimeout(r, 50))
      return 0
    })
    const elapsed = Date.now() - t0
    // Serial floor would be 8 × 50 = 400ms. Parallel(4) floor is
    // ceil(8/4) × 50 = 100ms. Assert WELL under the serial floor
    // with extra CI slack — proving parallelism is the goal, not
    // pinning a tight latency target.
    expect(elapsed).toBeLessThan(350)
  })

  test('empty input returns empty array', async () => {
    const out = await mapWithBoundedConcurrency([], 4, async () => 'x')
    expect(out).toEqual([])
  })

  test('single item with concurrency 1 works (degenerate serial case)', async () => {
    const out = await mapWithBoundedConcurrency(['only'], 1, async (s) => `${s}!`)
    expect(out).toEqual(['only!'])
  })
})

describe('buildOnboardingHandoffHook — bounded concurrency for composer calls', () => {
  let tmp: string
  let db: ProjectDb
  let store: ButtonStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-onboarding-handoff-'))
    db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    store = new ButtonStore({ db })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('parallel composer fan-out beats N × per-call serial latency', async () => {
    // Pre-r2 each composer round-trip ran serially: 6 projects × 1 s
    // per call = ~6 s of blocked transition. With pool=4 + 1 s per
    // call we should land near ceil(6/4) × 1 s = ~2 s.
    const projects = ['proj-1', 'proj-2', 'proj-3', 'proj-4', 'proj-5', 'proj-6']
    const PER_CALL_DELAY_MS = 200
    const composer: ComposeProjectOpeningFn = async (input) => {
      await new Promise<void>((r) => setTimeout(r, PER_CALL_DELAY_MS))
      return { body: `LLM body for ${input.name}.\n\nWhat would you like to do next?` }
    }
    const hook = buildOnboardingHandoffHook({
      buttonStore: store,
      composeProjectOpening: composer,
      composerConcurrency: 4,
    })
    const t0 = Date.now()
    await hook.emitProjectSeeds({
      project_slug: 'alice',
      user_id: 'u-1',
      primary_projects: projects,
      import_result: fakeImportResult(projects),
      observed_at: Date.now(),
    })
    const elapsed = Date.now() - t0
    // 6 calls × 200 ms serial = 1200 ms.
    // pool=4 → ceil(6/4) × 200 = 400 ms compose + serial emits.
    // Assert WELL under the serial floor with extra slack for CI
    // jitter on shared runners. The point of the test is to prove
    // parallelism (vs 1200 ms serial), not to pin a tight latency
    // target.
    expect(elapsed).toBeLessThan(1100)
  })

  test('per-row LLM failure is isolated — other rows still get LLM bodies', async () => {
    const projects = ['ok-a', 'fails', 'ok-b']
    const composer: ComposeProjectOpeningFn = async (input) => {
      if (input.name === 'fails') {
        throw new Error('synthetic LLM error')
      }
      return { body: `LLM-${input.name}` }
    }
    const hook = buildOnboardingHandoffHook({
      buttonStore: store,
      composeProjectOpening: composer,
      composerConcurrency: 4,
    })
    await hook.emitProjectSeeds({
      project_slug: 'alice',
      user_id: 'u-1',
      primary_projects: projects,
      import_result: fakeImportResult(projects),
      observed_at: Date.now(),
    })
    const generalTopic = 'web:u-1'
    const allRows = await Promise.all(
      projects.map(async (name) => {
        const { turns } = await store.listHistoryByTopic({
          topic_id: `${generalTopic}:${name}`,
          before: Date.now() + 1,
          before_prompt_id: null,
          limit: 1,
          now: Date.now(),
        })
        return { name, turn: turns[0] ?? null }
      }),
    )
    const okA = allRows.find((r) => r.name === 'ok-a')!
    const fails = allRows.find((r) => r.name === 'fails')!
    const okB = allRows.find((r) => r.name === 'ok-b')!
    expect(okA.turn).not.toBeNull()
    expect(fails.turn).not.toBeNull()
    expect(okB.turn).not.toBeNull()
    expect(okA.turn!.body).toContain('LLM-ok-a')
    expect(okB.turn!.body).toContain('LLM-ok-b')
    // Failed row falls back to the deterministic prose which reads from
    // the matched rationale.
    expect(fails.turn!.body).not.toContain('LLM-fails')
    expect(fails.turn!.body).toContain('Pass-2 summary for fails')
  })

  test('emit order matches primary_projects input order even when composer resolves out of order', async () => {
    const projects = ['first', 'second', 'third', 'fourth']
    // Reverse-staggered delays — last item resolves first if naive.
    const composer: ComposeProjectOpeningFn = async (input) => {
      const idx = projects.indexOf(input.name)
      const delay = (projects.length - idx) * 30
      await new Promise<void>((r) => setTimeout(r, delay))
      return { body: `LLM-${input.name}` }
    }
    const hook = buildOnboardingHandoffHook({
      buttonStore: store,
      composeProjectOpening: composer,
      composerConcurrency: 4,
    })
    await hook.emitProjectSeeds({
      project_slug: 'alice',
      user_id: 'u-1',
      primary_projects: projects,
      import_result: fakeImportResult(projects),
      observed_at: Date.now(),
    })
    // Pull each row's created_at; assert monotonic ascending in
    // primary_projects order.
    const tsByName = new Map<string, number>()
    for (const name of projects) {
      const { turns } = await store.listHistoryByTopic({
        topic_id: `web:u-1:${name}`,
        before: Date.now() + 1,
        before_prompt_id: null,
        limit: 1,
        now: Date.now(),
      })
      const turn = turns[0]
      if (turn !== undefined) tsByName.set(name, turn.created_at)
    }
    expect(tsByName.size).toBe(projects.length)
    let prev = -1
    for (const name of projects) {
      const ts = tsByName.get(name)!
      expect(ts).toBeGreaterThanOrEqual(prev)
      prev = ts
    }
  })

  test('no composer wired (Open self-hoster path) — deterministic prose emits in order', async () => {
    const projects = ['alpha', 'beta', 'gamma']
    const hook = buildOnboardingHandoffHook({
      buttonStore: store,
      // no composeProjectOpening
    })
    await hook.emitProjectSeeds({
      project_slug: 'alice',
      user_id: 'u-1',
      primary_projects: projects,
      import_result: fakeImportResult(projects),
      observed_at: Date.now(),
    })
    for (const name of projects) {
      const { turns } = await store.listHistoryByTopic({
        topic_id: `web:u-1:${name}`,
        before: Date.now() + 1,
        before_prompt_id: null,
        limit: 1,
        now: Date.now(),
      })
      expect(turns).toHaveLength(1)
      const turn = turns[0]!
      // Deterministic path reads the rationale from import_result.
      expect(turn.body).toContain(`Pass-2 summary for ${name}`)
      expect(turn.resolved).toBe(false)
    }
  })

  test('composerConcurrency option clamps to safe bounds', async () => {
    // Negative / zero clamp to 1; >16 clamps to 16. Verified
    // indirectly via the in-flight peak — a request for concurrency=0
    // would otherwise stall the loop forever.
    const projects = Array.from({ length: 4 }, (_, i) => `p${i}`)
    let inFlight = 0
    let peak = 0
    const composer: ComposeProjectOpeningFn = async (input) => {
      inFlight += 1
      if (inFlight > peak) peak = inFlight
      await new Promise<void>((r) => setTimeout(r, 20))
      inFlight -= 1
      return { body: `LLM-${input.name}` }
    }
    const hook = buildOnboardingHandoffHook({
      buttonStore: store,
      composeProjectOpening: composer,
      composerConcurrency: 0, // clamps to 1 (strict serial)
    })
    await hook.emitProjectSeeds({
      project_slug: 'alice',
      user_id: 'u-1',
      primary_projects: projects,
      import_result: fakeImportResult(projects),
      observed_at: Date.now(),
    })
    expect(peak).toBe(1)
  })

  test('DEFAULT_COMPOSER_CONCURRENCY constant is exported and reasonable', () => {
    expect(DEFAULT_COMPOSER_CONCURRENCY).toBeGreaterThanOrEqual(2)
    expect(DEFAULT_COMPOSER_CONCURRENCY).toBeLessThanOrEqual(8)
  })
})

/**
 * Item 5 (2026-06-11, ISSUES #208) — ZERO buttons on every emitted
 * opening, matched and unmatched alike.
 *
 * Supersedes the ISSUES #69 keyboard-shape block (2-button no-match
 * fallback vs 3-button rich-data keyboard): the free-form opening has
 * no keyboard at all — `options: []` + `allow_freeform: true` is the
 * only interaction shape. The silent-skip contract for LEGACY
 * `skip-for-now` buttons on pre-Item-5 rows still lives in
 * `gateway/http/chat-bridge.ts` (covered there).
 */
describe('buildOnboardingHandoffHook — zero-button free-form openings (Item 5)', () => {
  let tmp: string
  let db: ProjectDb
  let store: ButtonStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-onboarding-handoff-fb-'))
    db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    store = new ButtonStore({ db })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  async function grabSeed(topic_id: string) {
    const { turns } = await store.listHistoryByTopic({
      topic_id,
      before: Date.now() + 1,
      before_prompt_id: null,
      limit: 10,
      now: Date.now(),
    })
    expect(turns).toHaveLength(1)
    const persisted = await store.get(turns[0]!.prompt_id)
    expect(persisted).not.toBeNull()
    return persisted!
  }

  test('no-match project: § 4.4 prose fallback, options: [], allow_freeform', async () => {
    const projectName = 'No-Match-Project'
    const hook = buildOnboardingHandoffHook({ buttonStore: store })
    await hook.emitProjectSeeds({
      project_slug: 'alice',
      user_id: 'u-1',
      primary_projects: [projectName],
      // proposed_projects intentionally empty — guarantees no match.
      import_result: fakeImportResult([]),
      observed_at: Date.now(),
    })
    const persisted = await grabSeed(`web:u-1:${projectName.toLowerCase()}`)
    expect(persisted.options).toHaveLength(0)
    expect(persisted.allow_freeform).toBe(true)
    expect(persisted.body).toContain('No-Match-Project')
    expect(persisted.body).toContain('tell me what it is and what you want me to track')
  })

  test('matched project: free-form paragraph + next move, options: []', async () => {
    const projectName = 'Matched-Project'
    const hook = buildOnboardingHandoffHook({ buttonStore: store })
    await hook.emitProjectSeeds({
      project_slug: 'alice',
      user_id: 'u-1',
      primary_projects: [projectName],
      import_result: fakeImportResult([projectName]),
      observed_at: Date.now(),
    })
    const persisted = await grabSeed(`web:u-1:${projectName.toLowerCase()}`)
    expect(persisted.options).toHaveLength(0)
    expect(persisted.allow_freeform).toBe(true)
    expect(persisted.body).toContain(`Pass-2 summary for ${projectName}`)
    // Single next-move tail (first suggested topic → dig-in offer).
    expect(persisted.body).toContain(`Want me to dig into ${projectName} topic A?`)
  })

  test('LLM-composed opening also ships with zero options', async () => {
    const composer: ComposeProjectOpeningFn = async (input) => ({
      body: `Synthesized opening for ${input.name}.\n\nWant me to set a reminder for the filing window?`,
    })
    const hook = buildOnboardingHandoffHook({ buttonStore: store, composeProjectOpening: composer })
    await hook.emitProjectSeeds({
      project_slug: 'alice',
      user_id: 'u-1',
      primary_projects: ['Topline'],
      import_result: fakeImportResult(['Topline']),
      observed_at: Date.now(),
    })
    const persisted = await grabSeed('web:u-1:topline')
    expect(persisted.options).toHaveLength(0)
    expect(persisted.body).toContain('Synthesized opening for Topline.')
    expect(persisted.body).toContain('reminder for the filing window')
  })
})
