/**
 * Onboarding handoff content-aware openings (2026-05-29 sprint, updated
 * 2026-06-11 for Item 5 — free-form opening message, ISSUES #208).
 *
 * Verifies the production `buildOnboardingHandoffHook` factory composes
 * per-project FREE-FORM openings from `import_result.proposed_projects`
 * (or the optional LLM composer) — paragraph + ONE next move, ZERO
 * buttons — instead of the v1 generic stub / the retired button-wall
 * seed.
 *
 * Coverage:
 *   1. Project with rich import_synthesis → opening body contains the
 *      summary text + a single next-move line; no options.
 *   2. Freeform-added project with no history → § 4.4 fallback prose.
 *   3. Multiple projects → one composer call per project, distinct
 *      bodies per-project (not all identical).
 *   4. LLM call failure for one project → that project gets the
 *      deterministic prose; OTHER projects still get LLM bodies.
 *   5. Per-project body length capped (OPENING_MESSAGE_MAX_CHARS).
 *   6. Idempotency preserved — re-fire on engine retry doesn't double-emit.
 *   + GAP2: cross-project signal still rescues unmatched freeform adds.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import {
  buildOnboardingHandoffHook,
  buildDeterministicProjectOpening,
  finalizeOpeningBody,
  indexProposedProjects,
  OPENING_MESSAGE_MAX_CHARS,
  type ComposeProjectOpeningFn,
  type ComposeProjectOpeningInput,
} from '../../../gateway/realmode-composer/build-onboarding-handoff.ts'
import type { ImportResult } from '../../history-import/types.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-handoff-content-aware-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  // Pin the store clock to the test fixture clock so listHistoryByTopic
  // / listTopicsByUser comparisons against `now` work uniformly across
  // run hosts (real wall-clock would always be > 2026 but the fixtures
  // pass 1.7e12 = 2023 timestamps).
  buttonStore = new ButtonStore({ db, now: () => 1_699_999_999_000 })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeImportResult(
  proposed_projects: Array<{ name: string; rationale: string; suggested_topics: string[] }>,
): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects,
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {} as ImportResult['voice_signals'],
    facts: { user_role: 'Founder', companies: ['Topline JV'], key_people: ['Jordan Lee'] },
  }
}

describe('Onboarding handoff content-aware openings (Item 5)', () => {
  test('1. Project with rich import_synthesis → opening contains summary + single next move, no buttons', async () => {
    const import_result = makeImportResult([
      {
        name: 'Topline',
        rationale:
          'Topline JV cash flow is the highest-leverage thread; the 4 open Jordan Lee threads need triage this week.',
        suggested_topics: ['Topline JV threads', 'Jordan Lee status email'],
      },
    ])
    const handoff = buildOnboardingHandoffHook({ buttonStore })
    await handoff.emitProjectSeeds({
      project_slug: 'casey',
      user_id: 'u-1',
      primary_projects: ['Topline'],
      import_result,
      observed_at: 1_700_000_000_000,
    })
    const topics = await buttonStore.listTopicsByUser({
      user_id_prefix: 'web:u-1',
      now: 1_700_000_001_000,
    })
    const tabs = topics.find((t) => t.project_id === 'topline')!
    expect(tabs).toBeDefined()
    expect(tabs.unread_count).toBe(1)
    const history = await buttonStore.listHistoryByTopic({
      topic_id: 'web:u-1:topline',
      before: 1_700_000_001_000,
      before_prompt_id: null,
      limit: 5,
      now: 1_700_000_001_000,
    })
    expect(history.turns.length).toBeGreaterThan(0)
    const seedTurn = history.turns[0]!
    const seedPrompt = await buttonStore.get(seedTurn.prompt_id, 1_700_000_001_000)
    expect(seedPrompt).not.toBeNull()
    // The FULL body (not the 50-char `last_body` preview) carries the
    // summary text + the single next-move line.
    expect(seedPrompt!.body).toContain('cash flow')
    expect(seedPrompt!.body).toContain('Want me to dig into Topline JV threads?')
    // Item 5 — NO buttons, the user types.
    expect(seedPrompt!.options).toHaveLength(0)
    expect(seedPrompt!.allow_freeform).toBe(true)
  })

  test('2. Freeform-added project with no history → § 4.4 fallback prose, no buttons', async () => {
    const handoff = buildOnboardingHandoffHook({ buttonStore })
    await handoff.emitProjectSeeds({
      project_slug: 'casey',
      user_id: 'u-2',
      primary_projects: ['LA Property'],
      // No import_result — freeform-added flow.
      import_result: null,
      observed_at: 1_700_000_000_000,
    })
    const topics = await buttonStore.listTopicsByUser({
      user_id_prefix: 'web:u-2',
      now: 1_700_000_001_000,
    })
    const laProperty = topics.find((t) => t.project_id === 'la-property')!
    expect(laProperty).toBeDefined()
    const history = await buttonStore.listHistoryByTopic({
      topic_id: 'web:u-2:la-property',
      before: 1_700_000_001_000,
      before_prompt_id: null,
      limit: 5,
      now: 1_700_000_001_000,
    })
    const seedPrompt = await buttonStore.get(history.turns[0]!.prompt_id, 1_700_000_001_000)
    // FULL body (not the 50-char preview) carries the § 4.4 voice.
    expect(seedPrompt!.body).toContain('LA Property')
    expect(seedPrompt!.body).toContain("don't have history on it yet")
    expect(seedPrompt!.body).toContain('tell me what it is and what you want me to track')
    // No 2-button [A]/[B] wall any more — prose only.
    expect(seedPrompt!.options).toHaveLength(0)
    expect(seedPrompt!.allow_freeform).toBe(true)
  })

  test('3. Multiple projects → composer called per-project, distinct bodies per-project', async () => {
    const composer: ComposeProjectOpeningFn = mock(
      async (input: ComposeProjectOpeningInput) => ({
        body: `LLM-composed opening for ${input.name}: based on ${input.imported_project?.rationale ?? 'no history'}.`,
      }),
    )
    const import_result = makeImportResult([
      { name: 'Topline', rationale: 'Cash flow attention this week.', suggested_topics: ['threads'] },
      { name: 'Northwind Labs', rationale: 'Clinical pilot ramp-up.', suggested_topics: ['milestones'] },
    ])
    const handoff = buildOnboardingHandoffHook({
      buttonStore,
      composeProjectOpening: composer,
    })
    await handoff.emitProjectSeeds({
      project_slug: 'casey',
      user_id: 'u-3',
      primary_projects: ['Topline', 'Northwind Labs', 'Acme'],
      import_result,
      observed_at: 1_700_000_000_000,
    })
    expect((composer as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(3)
    // Load each prompt's full body via get(prompt_id) — `last_body` on
    // the topic listing is truncated to a 50-char preview.
    const grabFullBody = async (topic_id: string): Promise<string> => {
      const h = await buttonStore.listHistoryByTopic({
        topic_id,
        before: 1_700_000_001_000,
        before_prompt_id: null,
        limit: 5,
        now: 1_700_000_001_000,
      })
      const p = await buttonStore.get(h.turns[0]!.prompt_id, 1_700_000_001_000)
      return p!.body
    }
    const toplineBody = await grabFullBody('web:u-3:topline')
    const northwindBody = await grabFullBody('web:u-3:northwind-labs')
    const acmeBody = await grabFullBody('web:u-3:acme')
    expect(toplineBody).toContain('LLM-composed opening for Topline')
    expect(northwindBody).toContain('LLM-composed opening for Northwind Labs')
    expect(acmeBody).toContain('LLM-composed opening for Acme')
    // Bodies are distinct (not all identical).
    expect(toplineBody).not.toBe(northwindBody)
    expect(toplineBody).not.toBe(acmeBody)
  })

  test('4. LLM call failure for one project → other projects still get content-aware bodies', async () => {
    let callCount = 0
    const composer: ComposeProjectOpeningFn = async (input: ComposeProjectOpeningInput) => {
      callCount += 1
      if (input.name === 'Topline') throw new Error('opus 429 quota')
      return { body: `LLM-composed for ${input.name}.` }
    }
    const import_result = makeImportResult([
      { name: 'Topline', rationale: 'Cash flow.', suggested_topics: ['threads'] },
      { name: 'Northwind Labs', rationale: 'Clinical ramp.', suggested_topics: ['milestones'] },
    ])
    const handoff = buildOnboardingHandoffHook({
      buttonStore,
      composeProjectOpening: composer,
    })
    await handoff.emitProjectSeeds({
      project_slug: 'casey',
      user_id: 'u-4',
      primary_projects: ['Topline', 'Northwind Labs'],
      import_result,
      observed_at: 1_700_000_000_000,
    })
    expect(callCount).toBe(2)
    const tabsHistory = await buttonStore.listHistoryByTopic({
      topic_id: 'web:u-4:topline',
      before: 1_700_000_001_000,
      before_prompt_id: null,
      limit: 5,
      now: 1_700_000_001_000,
    })
    const northwindHistory = await buttonStore.listHistoryByTopic({
      topic_id: 'web:u-4:northwind-labs',
      before: 1_700_000_001_000,
      before_prompt_id: null,
      limit: 5,
      now: 1_700_000_001_000,
    })
    const tabs = await buttonStore.get(tabsHistory.turns[0]!.prompt_id, 1_700_000_001_000)
    const northwind = await buttonStore.get(northwindHistory.turns[0]!.prompt_id, 1_700_000_001_000)
    // Topline fell back to the deterministic prose (the rationale lands in
    // the body since the import_result entry survives the throw).
    expect(tabs!.body).toContain('Cash flow')
    // Northwind got the LLM body.
    expect(northwind!.body).toContain('LLM-composed for Northwind Labs')
  })

  test('5. Per-project body length capped at OPENING_MESSAGE_MAX_CHARS', async () => {
    const oversize = 'A'.repeat(3000)
    const composer: ComposeProjectOpeningFn = async () => ({ body: oversize })
    const handoff = buildOnboardingHandoffHook({
      buttonStore,
      composeProjectOpening: composer,
    })
    await handoff.emitProjectSeeds({
      project_slug: 'casey',
      user_id: 'u-5',
      primary_projects: ['Topline'],
      import_result: makeImportResult([
        { name: 'Topline', rationale: 'Cash flow.', suggested_topics: [] },
      ]),
      observed_at: 1_700_000_000_000,
    })
    const history = await buttonStore.listHistoryByTopic({
      topic_id: 'web:u-5:topline',
      before: 1_700_000_001_000,
      before_prompt_id: null,
      limit: 5,
      now: 1_700_000_001_000,
    })
    const seed = await buttonStore.get(history.turns[0]!.prompt_id, 1_700_000_001_000)
    expect(seed!.body.length).toBeLessThanOrEqual(OPENING_MESSAGE_MAX_CHARS)
  })

  test('6. Idempotency — re-fire on engine retry collapses to the same row', async () => {
    const handoff = buildOnboardingHandoffHook({ buttonStore })
    const import_result = makeImportResult([
      { name: 'Topline', rationale: 'Cash flow.', suggested_topics: ['threads'] },
    ])
    await handoff.emitProjectSeeds({
      project_slug: 'casey',
      user_id: 'u-6',
      primary_projects: ['Topline'],
      import_result,
      observed_at: 1_700_000_000_000,
    })
    // Re-fire (engine crash-resume simulation).
    await handoff.emitProjectSeeds({
      project_slug: 'casey',
      user_id: 'u-6',
      primary_projects: ['Topline'],
      import_result,
      observed_at: 1_700_000_001_000,
    })
    const topics = await buttonStore.listTopicsByUser({
      user_id_prefix: 'web:u-6',
      now: 1_700_000_002_000,
    })
    const tabs = topics.find((t) => t.project_id === 'topline')!
    // Only ONE active unresolved opening (idempotency key collapses
    // re-emit onto the same row).
    expect(tabs.unread_count).toBe(1)
  })
})

describe('GAP2 — cross-project content-aware openings (2026-06-09, shape updated for Item 5)', () => {
  // Build an import_result whose cross-project signal (entities / topics /
  // inferred_interests) names a project the import never PROPOSED — the
  // exact shape of Sam's real signup, where "Buddhism" and "Biohacking"
  // were freeform additions not in `proposed_projects`.
  function makeCrossProjectImportResult(): ImportResult {
    return {
      entities: [
        { name: 'Buddhism study group', kind: 'concept', mention_count: 12 },
        { name: 'Topline JV', kind: 'company', mention_count: 40 },
      ],
      topics: [
        { name: 'Biohacking cold plunge protocol', recurrence_score: 0.8, recency_score: 0.9 },
        { name: 'Buddhism daily sit', recurrence_score: 0.7, recency_score: 0.6 },
      ],
      proposed_projects: [
        { name: 'Topline', rationale: 'B2B hospitality JV.', suggested_topics: ['Topline JV threads'] },
      ],
      proposed_tasks: [],
      proposed_reminders: [],
      voice_signals: {} as ImportResult['voice_signals'],
      facts: { key_people: ['Jordan Lee'], companies: ['Topline JV'] },
      inferred_interests: [
        { name: 'biohacking', basis: 'mentioned across 8 conversations', cadence_hint: 'weekly' },
      ],
    }
  }

  test('unmatched freeform-added project with cross-project signal → content-aware opening (not "no history")', async () => {
    const import_result = makeCrossProjectImportResult()
    const handoff = buildOnboardingHandoffHook({ buttonStore })
    await handoff.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-gap2a',
      // "Biohacking" was NOT a proposed project — it's a freeform add —
      // but the import's topics + inferred_interests name it.
      primary_projects: ['Biohacking'],
      import_result,
      observed_at: 1_700_000_000_000,
    })
    const history = await buttonStore.listHistoryByTopic({
      topic_id: 'web:u-gap2a:biohacking',
      before: 1_700_000_001_000,
      before_prompt_id: null,
      limit: 5,
      now: 1_700_000_001_000,
    })
    const seed = await buttonStore.get(history.turns[0]!.prompt_id, 1_700_000_001_000)
    expect(seed).not.toBeNull()
    // NOT the bland "no history" fallback — the body references the
    // import-derived signal that relates to Biohacking.
    expect(seed!.body).not.toContain("don't have history")
    expect(seed!.body.toLowerCase()).toContain('biohacking')
    // Item 5 — still no buttons; the content lives in the prose.
    expect(seed!.options).toHaveLength(0)
    expect(seed!.allow_freeform).toBe(true)
  })

  test('composer receives the synthesized cross-signal stand-in as imported_project for unmatched adds', async () => {
    const seen: ComposeProjectOpeningInput[] = []
    const composer: ComposeProjectOpeningFn = async (input) => {
      seen.push(input)
      return { body: `Opening for ${input.name}.` }
    }
    const handoff = buildOnboardingHandoffHook({ buttonStore, composeProjectOpening: composer })
    await handoff.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-gap2-composer',
      primary_projects: ['Biohacking'],
      import_result: makeCrossProjectImportResult(),
      observed_at: 1_700_000_000_000,
    })
    expect(seen).toHaveLength(1)
    // The GAP2 stand-in flows through so the LLM gets concrete material
    // even though no proposed_projects row matched.
    expect(seen[0]!.imported_project).not.toBeNull()
    expect(seen[0]!.imported_project!.rationale.toLowerCase()).toContain('biohacking')
    expect(seen[0]!.imported_project!.suggested_topics.length).toBeGreaterThan(0)
  })

  test('unmatched freeform-added project (Buddhism) also gets cross-project content-aware opening', async () => {
    const import_result = makeCrossProjectImportResult()
    const handoff = buildOnboardingHandoffHook({ buttonStore })
    await handoff.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-gap2b',
      primary_projects: ['Buddhism'],
      import_result,
      observed_at: 1_700_000_000_000,
    })
    const history = await buttonStore.listHistoryByTopic({
      topic_id: 'web:u-gap2b:buddhism',
      before: 1_700_000_001_000,
      before_prompt_id: null,
      limit: 5,
      now: 1_700_000_001_000,
    })
    const seed = await buttonStore.get(history.turns[0]!.prompt_id, 1_700_000_001_000)
    expect(seed!.body).not.toContain("don't have history")
    expect(seed!.body.toLowerCase()).toContain('buddhism')
    expect(seed!.options).toHaveLength(0)
  })

  test('truly signal-free freeform project → § 4.4 no-history prose (no buttons)', async () => {
    const import_result = makeCrossProjectImportResult()
    const handoff = buildOnboardingHandoffHook({ buttonStore })
    await handoff.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-gap2c',
      // No entity/topic/interest names "Underwater Basket Weaving".
      primary_projects: ['Underwater Basket Weaving'],
      import_result,
      observed_at: 1_700_000_000_000,
    })
    const history = await buttonStore.listHistoryByTopic({
      topic_id: 'web:u-gap2c:underwater-basket-weaving',
      before: 1_700_000_001_000,
      before_prompt_id: null,
      limit: 5,
      now: 1_700_000_001_000,
    })
    const seed = await buttonStore.get(history.turns[0]!.prompt_id, 1_700_000_001_000)
    expect(seed!.body).toContain("don't have history on it yet")
    expect(seed!.body).toContain('Underwater Basket Weaving')
    expect(seed!.options).toHaveLength(0)
  })

  test('no import at all → named § 4.4 prose, free-form reply', async () => {
    const handoff = buildOnboardingHandoffHook({ buttonStore })
    await handoff.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-gap2d',
      primary_projects: ['Home Finances'],
      import_result: null,
      observed_at: 1_700_000_000_000,
    })
    const history = await buttonStore.listHistoryByTopic({
      topic_id: 'web:u-gap2d:home-finances',
      before: 1_700_000_001_000,
      before_prompt_id: null,
      limit: 5,
      now: 1_700_000_001_000,
    })
    const seed = await buttonStore.get(history.turns[0]!.prompt_id, 1_700_000_001_000)
    expect(seed!.body).toContain('Home Finances')
    expect(seed!.options).toHaveLength(0)
    expect(seed!.allow_freeform).toBe(true)
  })
})

describe('build-onboarding-handoff helpers (pure)', () => {
  const NO_DOCS = { readme: null, transcript_summary: null, status_md: null }

  test('buildDeterministicProjectOpening: rich import → summary + dig-in offer', () => {
    const out = buildDeterministicProjectOpening(
      'Topline',
      {
        name: 'Topline',
        rationale: 'Cash flow is the highest-leverage thread this week.',
        suggested_topics: ['Topline JV threads'],
      },
      NO_DOCS,
    )
    expect(out.body).toContain('Cash flow')
    expect(out.body).toContain('Want me to dig into Topline JV threads?')
  })

  test('buildDeterministicProjectOpening: no import → § 4.4 fallback voice', () => {
    const out = buildDeterministicProjectOpening('LA Property', null, NO_DOCS)
    expect(out.body).toContain('LA Property')
    expect(out.body).toContain("I don't have history on it yet")
    expect(out.body).toContain('tell me what it is and what you want me to track')
  })

  test('buildDeterministicProjectOpening: rationale present, suggested_topics empty → open question', () => {
    const out = buildDeterministicProjectOpening(
      'Acme',
      { name: 'Acme', rationale: 'Brand launch in two weeks.', suggested_topics: [] },
      NO_DOCS,
    )
    expect(out.body).toContain('Brand launch')
    expect(out.body).toContain('What would you like to do next?')
  })

  test('finalizeOpeningBody: overlong body truncates at sentence boundary', () => {
    const long = `${'Hello world. '.repeat(80)}Final tail.`
    expect(finalizeOpeningBody(long).length).toBeLessThanOrEqual(OPENING_MESSAGE_MAX_CHARS)
  })

  test('indexProposedProjects: case-insensitive lookup; ignores malformed rows', () => {
    const ir = {
      entities: [],
      topics: [],
      proposed_projects: [
        { name: 'Topline Hospitality', rationale: 'r1', suggested_topics: ['t1'] },
        { name: '', rationale: 'r-empty-name', suggested_topics: [] },
      ],
      proposed_tasks: [],
      proposed_reminders: [],
      voice_signals: {} as ImportResult['voice_signals'],
      facts: {},
    } as ImportResult
    const idx = indexProposedProjects(ir)
    expect(idx.get('topline hospitality')).toBeDefined()
    expect(idx.get('TOPLINE HOSPITALITY'.toLowerCase())).toBeDefined()
    // Empty name was dropped.
    expect(idx.size).toBe(1)
  })

  test('indexProposedProjects: null import → empty Map', () => {
    expect(indexProposedProjects(null).size).toBe(0)
  })
})
