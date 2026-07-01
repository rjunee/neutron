/**
 * Unit tests for `buildOnboardingFinalize` (Path 1 onboarding finalizer).
 *
 * Exercises `finalize` against a real in-memory ProjectDb + a real
 * SqliteOnboardingStateStore, with a fake persona composer injected via the
 * optional `personaComposer` seam (so the test doesn't stand up the archetype
 * / cringe pipeline). Asserts the three load-bearing post-conditions:
 *   - phase flips to 'completed'
 *   - a real `projects` row exists for a named project (the rail query returns it)
 *   - emitProjectsChanged fired for the owner
 * plus idempotency: a second finalize on the now-completed row is a no-op.
 */

import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '../../../persistence/index.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import { SqliteOnboardingStateStore } from '../../../onboarding/interview/sqlite-state-store.ts'
import { slugifyProjectId } from '../../../onboarding/wow-moment/project-identity.ts'
import { MAX_ANALYSIS_PROJECTS } from '../../../onboarding/interview/phase-prompts.ts'
import {
  buildOnboardingFinalize,
  type OnboardingFinalizeDeps,
  type PersonaComposerLike,
} from '../build-onboarding-finalize.ts'

const PROJECT_SLUG = 'acme'
const USER_ID = 'google:test-owner'
const TOPIC_ID = 'topic-general'

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'finalize-'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  applyMigrations(db.raw())
  return db
}

/** A persona composer that records calls but does no real synthesis. */
function fakePersonaComposer(): PersonaComposerLike & { composed: number; committed: number } {
  const rec = {
    composed: 0,
    committed: 0,
    async compose(): Promise<unknown> {
      rec.composed += 1
      return { draft_id: 'fake', status: 'committed' }
    },
    async commit(): Promise<unknown> {
      rec.committed += 1
      return { committed_at: 0, git_sha: null, paths: [] }
    },
  }
  return rec
}

interface Harness {
  db: ProjectDb
  stateStore: SqliteOnboardingStateStore
  ownerHome: string
  persona: ReturnType<typeof fakePersonaComposer>
  invalidated: string[]
  projectsChanged: string[]
  onboardingCompleted: string[]
  deps: OnboardingFinalizeDeps
}

function makeHarness(): Harness {
  const db = makeDb()
  const ownerHome = mkdtempSync(join(tmpdir(), 'finalize-home-'))
  const stateStore = new SqliteOnboardingStateStore({ db, now: () => 1_700_000_000_000 })
  const persona = fakePersonaComposer()
  const invalidated: string[] = []
  const projectsChanged: string[] = []
  const onboardingCompleted: string[] = []
  const deps: OnboardingFinalizeDeps = {
    owner_home: ownerHome,
    project_slug: PROJECT_SLUG,
    db,
    stateStore,
    personaLoader: { invalidate: (f?: string): void => void invalidated.push(f ?? '*') },
    emitProjectsChanged: (uid: string): void => void projectsChanged.push(uid),
    emitOnboardingCompleted: (uid: string): void => void onboardingCompleted.push(uid),
    now: () => 1_700_000_000_000,
    log: (): void => {},
    personaComposer: persona,
  }
  return { db, stateStore, ownerHome, persona, invalidated, projectsChanged, onboardingCompleted, deps }
}

test('finalize completes onboarding: persona, projects row, rail refresh', async () => {
  const h = makeHarness()

  // Seed an in-flight onboarding row with two named projects.
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['Topline Revenue', 'Home Assistant'],
    },
  })
  expect(seeded.phase).toBe('wow_fired')

  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  // (1) Phase flipped to completed, with completed_at + wow_fired stamped.
  const after = await h.stateStore.get(PROJECT_SLUG, USER_ID)
  expect(after).not.toBeNull()
  expect(after?.phase).toBe('completed')
  expect(after?.completed_at).not.toBeNull()
  expect(after?.wow_fired).toBe(true)

  // (2) Real projects rows exist — exactly what the rail SELECTs.
  const rows = h.db
    .prepare<{ id: string; name: string }, []>(
      `SELECT id, name FROM projects WHERE deleted_at IS NULL ORDER BY name`,
    )
    .all()
  const names = rows.map((r) => r.name)
  expect(names).toContain('Topline Revenue')
  expect(names).toContain('Home Assistant')
  // Deterministic slug ids the rail/handoff key off.
  const topline = rows.find((r) => r.name === 'Topline Revenue')
  expect(topline?.id).toBe(slugifyProjectId('Topline Revenue'))

  // Each project got its cli wow-shell topic binding.
  const topic = h.db
    .prepare<{ one: number }, [string]>(
      `SELECT 1 AS one FROM topics
         WHERE channel_kind = 'cli' AND channel_topic_id = ?`,
    )
    .get(`wow-shell-${slugifyProjectId('Topline Revenue')}`)
  expect(topic).not.toBeNull()

  // (3) Persona committed + loader invalidated; rail refresh fired once.
  expect(h.persona.composed).toBe(1)
  expect(h.persona.committed).toBe(1)
  expect(h.invalidated.length).toBe(1)
  expect(h.projectsChanged).toEqual([USER_ID])
  // (4) One-shot onboarding-complete signal fired at the terminal transition
  // (Managed post-onboarding claim redirect). Exactly once, for the owner.
  expect(h.onboardingCompleted).toEqual([USER_ID])

  h.db.close()
})

test('finalize is idempotent: a second call on a completed row is a no-op', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: { primary_projects: ['Topline Revenue'] },
  })

  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  const completed = await h.stateStore.get(PROJECT_SLUG, USER_ID)
  expect(completed?.phase).toBe('completed')
  const firstChanged = h.projectsChanged.length
  const firstComposed = h.persona.composed
  expect(firstChanged).toBe(1)
  expect(firstComposed).toBe(1)

  // Second finalize — pass the now-completed state; must short-circuit before
  // touching persona / projects / rail.
  await finalizer.finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: completed!,
  })
  expect(h.projectsChanged.length).toBe(firstChanged)
  expect(h.persona.composed).toBe(firstComposed)
  // The onboarding-complete signal must ALSO fire exactly once — the idempotent
  // re-entry short-circuits before re-emitting it (so the client's claim
  // redirect can't be re-triggered by a defensive re-finalize).
  expect(h.onboardingCompleted).toEqual([USER_ID])

  h.db.close()
})

test('finalize reuses a pre-existing project whose name slugifies to the same id (no duplicate row)', async () => {
  const h = makeHarness()

  // A project row ALREADY exists under id 'x' whose name 'Acme' slugifies to
  // 'acme' (the slug finalize would otherwise mint a NEW row at). Pre-#fix
  // INSERT OR IGNORE de-duped only on the PK, so this would land a SECOND
  // 'acme' row → two Acme projects in the rail.
  const iso = new Date(0).toISOString()
  await h.db.run(
    `INSERT INTO projects
       (id, name, description, persona, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'private', 'personal', ?, ?)`,
    ['x', 'Acme', 'pre-existing context', iso, iso],
  )
  expect(slugifyProjectId('Acme')).toBe('acme') // guards the premise: id 'x' ≠ slug 'acme'

  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: { primary_projects: ['Acme'] },
  })

  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  // EXACTLY ONE Acme row — the pre-existing 'x' row was reused, not duplicated.
  const acmeRows = h.db
    .prepare<{ id: string; name: string }, []>(
      `SELECT id, name FROM projects WHERE name = 'Acme' AND deleted_at IS NULL`,
    )
    .all()
  expect(acmeRows.length).toBe(1)
  expect(acmeRows[0]?.id).toBe('x')
  // No second row was minted at the slug id.
  const slugRow = h.db
    .prepare<{ id: string }, [string]>(
      `SELECT id FROM projects WHERE id = ?`,
    )
    .get('acme')
  expect(slugRow ?? null).toBeNull()

  // The cli wow-shell topic binds to the EXISTING id 'x' (materialized against it).
  const topic = h.db
    .prepare<{ one: number }, [string]>(
      `SELECT 1 AS one FROM topics WHERE channel_kind = 'cli' AND channel_topic_id = ?`,
    )
    .get('wow-shell-x')
  expect(topic ?? null).not.toBeNull()

  h.db.close()
})

test('finalize materializes from import_result.proposed_projects when supplied', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    // No primary_projects in phase_state — the import_result drives projects.
    phase_state_patch: { user_first_name: 'Sam' },
  })

  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
    import_result: {
      entities: [],
      topics: [],
      proposed_projects: [
        { name: 'Imported Project', rationale: 'Came from history import.', suggested_topics: [] },
      ],
      proposed_tasks: [],
      proposed_reminders: [],
      // voice_signals is part of ImportResult but unused here; cast keeps the
      // fixture minimal without pulling the full voice shape into the test.
    } as never,
  })

  const row = h.db
    .prepare<{ id: string; name: string }, []>(
      `SELECT id, name FROM projects WHERE deleted_at IS NULL`,
    )
    .get()
  expect(row?.name).toBe('Imported Project')
  expect(row?.id).toBe(slugifyProjectId('Imported Project'))

  h.db.close()
})

test('finalize unions interview-named projects with import_result.proposed_projects (no silent drop)', async () => {
  const h = makeHarness()
  // The owner named three projects conversationally; the import proposed a
  // partially-overlapping set ('Acme' overlaps; 'Infra' is import-only).
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: {
      user_first_name: 'Sam',
      primary_projects: ['Topline Revenue', 'Acme', 'Book'],
    },
  })

  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
    import_result: {
      entities: [],
      topics: [],
      proposed_projects: [
        { name: 'Acme', rationale: 'Seen across the export.', suggested_topics: [] },
        { name: 'Infra', rationale: 'Seen across the export.', suggested_topics: [] },
      ],
      proposed_tasks: [],
      proposed_reminders: [],
    } as never,
  })

  const rows = h.db
    .prepare<{ id: string; name: string }, []>(
      `SELECT id, name FROM projects WHERE deleted_at IS NULL ORDER BY name`,
    )
    .all()
  const names = rows.map((r) => r.name).sort()
  // Pre-fix this returned only ['Acme', 'Infra'] — 'Topline Revenue' and 'Book',
  // named in the chat but absent from the export, were silently dropped.
  expect(names).toEqual(['Acme', 'Book', 'Infra', 'Topline Revenue'])
  // 'Acme' (in both) is materialized exactly once — the import entry wins the
  // slug dedup (so it carries the import rationale), not duplicated.
  expect(rows.filter((r) => r.id === slugifyProjectId('Acme')).length).toBe(1)

  h.db.close()
})

test('finalize honors a curation DROP — a dropped project is never materialized, even from the import union', async () => {
  const h = makeHarness()
  // The owner curated their import: "drop Infra, keep the rest". The post-turn
  // extractor subtracted 'Infra' from primary_projects AND recorded it under
  // dropped_projects. The import's proposed_projects STILL lists 'Infra'.
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: {
      user_first_name: 'Sam',
      primary_projects: ['Topline Revenue', 'Acme', 'Book'],
      dropped_projects: ['Infra'],
    },
  })

  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
    import_result: {
      entities: [],
      topics: [],
      proposed_projects: [
        { name: 'Acme', rationale: 'Seen across the export.', suggested_topics: [] },
        { name: 'Infra', rationale: 'Seen across the export.', suggested_topics: [] },
      ],
      proposed_tasks: [],
      proposed_reminders: [],
    } as never,
  })

  const names = h.db
    .prepare<{ name: string }, []>(`SELECT name FROM projects WHERE deleted_at IS NULL ORDER BY name`)
    .all()
    .map((r) => r.name)
    .sort()
  // 'Infra' was dropped — it is NOT created even though it's in the import's
  // proposed_projects (the defensive union would otherwise have re-added it).
  expect(names).toEqual(['Acme', 'Book', 'Topline Revenue'])
  expect(names).not.toContain('Infra')

  h.db.close()
})

const NINE_PROPOSED = [
  'Topline',
  'Northwind',
  'Acme Studio',
  'Acme',
  'Info Product Playbooks',
  'Functional Chocolate',
  'Home Finances',
  'Phantom Eight', // beyond the cap — never displayed to the user
  'Phantom Nine', // beyond the cap — never displayed to the user
]

test('finalize caps the IMPORT contribution to the displayed set — proposed projects beyond MAX_ANALYSIS_PROJECTS are never materialized (M1, 2026-06-30)', async () => {
  const h = makeHarness()
  // A >7 synthesis. The presentation only ever showed the user the first
  // MAX_ANALYSIS_PROJECTS (7); the engine now caps import_result + primary_projects
  // at the stamp chokepoint, so primary carries no phantoms. Drive finalize with
  // the displayed primary set (the engine-capped 7) AND a still-uncapped
  // import_result (9 proposed) and assert the import OVERFLOW (8th/9th) is not
  // materialized.
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: {
      user_first_name: 'Sam',
      primary_projects: NINE_PROPOSED.slice(0, MAX_ANALYSIS_PROJECTS),
    },
  })

  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
    import_result: {
      entities: [],
      topics: [],
      proposed_projects: NINE_PROPOSED.map((name) => ({
        name,
        rationale: 'Seen across the export.',
        suggested_topics: [],
      })),
      proposed_tasks: [],
      proposed_reminders: [],
    } as never,
  })

  const names = h.db
    .prepare<{ name: string }, []>(`SELECT name FROM projects WHERE deleted_at IS NULL ORDER BY name`)
    .all()
    .map((r) => r.name)
  // Exactly the displayed 7 — no phantoms.
  expect(names.length).toBe(MAX_ANALYSIS_PROJECTS)
  expect(names.sort()).toEqual([...NINE_PROPOSED.slice(0, MAX_ANALYSIS_PROJECTS)].sort())
  expect(names).not.toContain('Phantom Eight')
  expect(names).not.toContain('Phantom Nine')

  h.db.close()
})

test('finalize preserves an EXPLICIT user add even when its name collides with an unshown import overflow (Codex P2)', async () => {
  const h = makeHarness()
  // The owner explicitly named "Phantom Eight" in conversation (so it lives in
  // primary_projects as a real add). It also happens to be the 8th import
  // proposal — beyond the displayed cap. The cap reconciliation must NOT drop the
  // owner's explicit add: finalized = displayed ∪ explicit-adds, so it is created.
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: {
      user_first_name: 'Sam',
      primary_projects: [...NINE_PROPOSED.slice(0, MAX_ANALYSIS_PROJECTS), 'Phantom Eight'],
    },
  })

  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
    import_result: {
      entities: [],
      topics: [],
      proposed_projects: NINE_PROPOSED.map((name) => ({
        name,
        rationale: 'Seen across the export.',
        suggested_topics: [],
      })),
      proposed_tasks: [],
      proposed_reminders: [],
    } as never,
  })

  const names = h.db
    .prepare<{ name: string }, []>(`SELECT name FROM projects WHERE deleted_at IS NULL ORDER BY name`)
    .all()
    .map((r) => r.name)
  // Displayed 7 + the explicit add = 8; the explicit add survives the cap.
  expect(names).toContain('Phantom Eight')
  expect(names.length).toBe(MAX_ANALYSIS_PROJECTS + 1)
  // The truly-unshown overflow (never added) is still excluded.
  expect(names).not.toContain('Phantom Nine')

  h.db.close()
})

test('finalize emits a General closing message + one per-project opening (items 6/7)', async () => {
  const h = makeHarness()
  // Capture every emitChatMessage call.
  const emitted: Array<{
    user_id: string
    project_id: string | null
    body: string
    dedupe_key: string
  }> = []
  const deps: OnboardingFinalizeDeps = {
    ...h.deps,
    emitChatMessage: (input): void => void emitted.push(input),
  }

  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['Topline Revenue', 'Home Assistant'],
    },
  })

  const finalizer = buildOnboardingFinalize(deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  // Exactly one General closing (project_id === null) pointing at the rail + Plan.
  const closings = emitted.filter((e) => e.project_id === null)
  expect(closings).toHaveLength(1)
  expect(closings[0]!.user_id).toBe(USER_ID)
  expect(closings[0]!.body).toMatch(/left rail/i)
  expect(closings[0]!.body).toMatch(/Plan/)
  // No em dashes leaked into the closing (Sam hard rule).
  expect(closings[0]!.body).not.toContain('—')
  // Stable dedupe key so a re-finalize collapses onto the same row (idempotency).
  expect(closings[0]!.dedupe_key).toBe('onboarding_closing')

  // One opening per materialized project, keyed on the project's slug id.
  const openings = emitted.filter((e) => e.project_id !== null)
  const openingIds = openings.map((e) => e.project_id).sort()
  expect(openingIds).toEqual(
    [slugifyProjectId('Topline Revenue'), slugifyProjectId('Home Assistant')].sort(),
  )
  // Each opening has a non-empty body + a per-project dedupe key.
  for (const o of openings) {
    expect(o.body.trim().length).toBeGreaterThan(0)
    expect(o.dedupe_key).toBe(`onboarding_opening:${o.project_id}`)
  }

  h.db.close()
})

test('finalize with NO projects emits an honest closing (no "I created your projects" claim)', async () => {
  const h = makeHarness()
  const emitted: Array<{ project_id: string | null; body: string }> = []
  const deps: OnboardingFinalizeDeps = {
    ...h.deps,
    emitChatMessage: (input): void => void emitted.push(input),
  }
  // No primary_projects → nothing materializes.
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: { user_first_name: 'Sam', agent_name: 'Atlas', primary_projects: [] },
  })
  const finalizer = buildOnboardingFinalize(deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  // No per-project openings, and the closing must NOT claim projects were created.
  expect(emitted.filter((e) => e.project_id !== null)).toHaveLength(0)
  const closings = emitted.filter((e) => e.project_id === null)
  expect(closings).toHaveLength(1)
  expect(closings[0]!.body).not.toMatch(/created your projects/i)
  expect(closings[0]!.body).not.toMatch(/left rail/i)
  // Still a usable, real handoff.
  expect(closings[0]!.body.trim().length).toBeGreaterThan(0)

  h.db.close()
})

test('finalize without an emitChatMessage seam still completes (no closing/opening)', async () => {
  const h = makeHarness() // deps has NO emitChatMessage
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: { primary_projects: ['Topline Revenue'] },
  })
  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })
  const after = await h.stateStore.get(PROJECT_SLUG, USER_ID)
  expect(after?.phase).toBe('completed')
  h.db.close()
})

// ---------------------------------------------------------------------------
// HOBBY PROJECTS (2026-07-01, PART A) — outside-work interest answers now
// MATERIALIZE projects too (previously they landed only in persona-gen).
// ---------------------------------------------------------------------------

test('finalize materializes hobby/interest answers as projects (non_work_interests + inferred_interests)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: {
      primary_projects: ['Topline Revenue'],
      // Conversationally-captured hobbies (the shape post-turn-extractor writes).
      non_work_interests: [
        { name: 'Rock Climbing' },
        { name: 'Woodworking', cadence_hint: 'weekly' },
      ],
    },
  })

  const finalizer = buildOnboardingFinalize(h.deps)
  // An import that also inferred an interest → it materializes too.
  await finalizer.finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
    import_result: {
      proposed_projects: [],
      proposed_tasks: [],
      inferred_interests: [{ name: 'Photography', basis: 'you shared several photo edits' }],
    } as unknown as import('../../../onboarding/history-import/types.ts').ImportResult,
  })

  const names = h.db
    .prepare<{ name: string }, []>(
      `SELECT name FROM projects WHERE deleted_at IS NULL ORDER BY name`,
    )
    .all()
    .map((r) => r.name)
  // The work project AND every hobby now have a real projects row.
  expect(names).toContain('Topline Revenue')
  expect(names).toContain('Rock Climbing')
  expect(names).toContain('Woodworking')
  expect(names).toContain('Photography')
  h.db.close()
})

test('finalize dedups a hobby against a same-named work project (work wins, one row)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: {
      primary_projects: ['Photography'], // also named as a hobby below
      non_work_interests: [{ name: 'Photography' }, { name: 'Baking' }],
    },
  })
  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  const photoRows = h.db
    .prepare<{ id: string }, []>(
      `SELECT id FROM projects WHERE name = 'Photography' AND deleted_at IS NULL`,
    )
    .all()
  expect(photoRows.length).toBe(1) // not doubled by the hobby union
  const bakingRows = h.db
    .prepare<{ id: string }, []>(
      `SELECT id FROM projects WHERE name = 'Baking' AND deleted_at IS NULL`,
    )
    .all()
  expect(bakingRows.length).toBe(1)
  h.db.close()
})

test('finalize honors a dropped hobby (dropped_projects excludes the interest slug)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: {
      primary_projects: ['Topline Revenue'],
      non_work_interests: [{ name: 'Woodworking' }],
      dropped_projects: ['Woodworking'],
    },
  })
  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  const wood = h.db
    .prepare<{ id: string }, []>(
      `SELECT id FROM projects WHERE name = 'Woodworking' AND deleted_at IS NULL`,
    )
    .all()
  expect(wood.length).toBe(0) // dropped → never materialized
  h.db.close()
})

// ---------------------------------------------------------------------------
// AGENTIC KICKOFF (2026-07-01, PART B) — the per-project opening prefers the
// one-time agentic kickoff, falling back to the deterministic opening, and
// fills the SINGLE opening slot (one-time by construction).
// ---------------------------------------------------------------------------

test('finalize emits the agentic kickoff body when the kickoff fires (one dedupe slot)', async () => {
  const h = makeHarness()
  const emitted: Array<{ project_id: string | null; body: string; dedupe_key: string }> = []
  h.deps.emitChatMessage = (input): void => {
    emitted.push({ project_id: input.project_id, body: input.body, dedupe_key: input.dedupe_key })
  }
  // A kickoff that fires for the work project with a doc-link body, and returns
  // null for anything it deems thin.
  h.deps.projectKickoff = {
    async composeKickoff(input): Promise<{
      body: string
      action: 'draft-doc'
      indexed: boolean
    } | null> {
      if (input.name === 'Topline Revenue') {
        return {
          body: `I drafted a starting plan - [Starting plan](docs:/${input.project_id}/starting-plan.md).`,
          action: 'draft-doc',
          indexed: true,
        }
      }
      return null
    },
  }

  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'wow_fired',
    phase_state_patch: { primary_projects: ['Topline Revenue', 'Quiet Corner'] },
  })
  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  const topline = emitted.find((e) => e.project_id === slugifyProjectId('Topline Revenue'))
  const quiet = emitted.find((e) => e.project_id === slugifyProjectId('Quiet Corner'))
  // The kickoff body was used for the project it fired on, keyed on the SINGLE
  // per-project opening slot (so a re-entry / on-connect recovery collapses onto it).
  expect(topline).toBeDefined()
  expect(topline!.body).toContain('docs:/')
  expect(topline!.body).toContain('Starting plan')
  expect(topline!.dedupe_key).toBe(`onboarding_opening:${slugifyProjectId('Topline Revenue')}`)
  // The project the kickoff declined still gets a (deterministic) opening.
  expect(quiet).toBeDefined()
  expect(quiet!.body.trim().length).toBeGreaterThan(0)
  expect(quiet!.body).not.toContain('docs:/')
  expect(quiet!.dedupe_key).toBe(`onboarding_opening:${slugifyProjectId('Quiet Corner')}`)

  h.db.close()
})
