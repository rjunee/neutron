/**
 * Path-1 finalize PROGRESS MESSAGING — the owner must never sit in a silent
 * multi-minute window while their projects are built.
 *
 * THE BUG (live, Ryan's install 2026-07-18): `finalize` composed a per-project
 * opening (an LLM call) for EVERY materialized project before emitting the one
 * message that tells the owner what to do next. With 9 projects the openings
 * trickled in over several minutes with zero explanation and the closing landed
 * dead last: "its unclear what im supposed to do next".
 *
 * THE FIX: a STARTING message emitted through the SAME `deps.emitChatMessage`
 * seam BEFORE persona compose / materialization / the opening composes, plus a
 * closing that names both post-onboarding affordances (the project rail and the
 * General chat).
 *
 * These tests assert the EMITTED MESSAGE STREAM (order + count + copy) against a
 * real ProjectDb, a real SqliteOnboardingStateStore, and the real shared
 * create-project seams. The only fakes are the persona composer (avoids standing
 * up the archetype/cringe pipeline) and the emit sink, which IS the surface under
 * test.
 */

import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import { slugifyProjectId } from '@neutronai/onboarding/wow-moment/project-identity.ts'
import { buildScaffoldMaterializer, ensureProjectRow } from '../project-create.ts'
import {
  buildOnboardingFinalize,
  type OnboardingFinalizeDeps,
  type PersonaComposerLike,
} from '@neutronai/onboarding/openings/finalize.ts'

const OWNER_SLUG = 'acme'
const USER_ID = 'google:test-owner'
const TOPIC_ID = 'topic-general'
const NOW = 1_700_000_000_000

interface Emitted {
  project_id: string | null
  body: string
  dedupe_key: string
}

interface Harness {
  db: ProjectDb
  stateStore: SqliteOnboardingStateStore
  emitted: Emitted[]
  deps: OnboardingFinalizeDeps
}

function fakePersonaComposer(fail = false): PersonaComposerLike {
  return {
    async compose(): Promise<unknown> {
      if (fail) throw new Error('cringe cap exceeded')
      return { draft_id: 'fake' }
    },
    async commit(): Promise<unknown> {
      return { committed_at: 0, git_sha: null, paths: [] }
    },
  }
}

function makeHarness(opts: { personaFails?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'finalize-msg-'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  applyMigrations(db.raw())
  const ownerHome = mkdtempSync(join(tmpdir(), 'finalize-msg-home-'))
  const stateStore = new SqliteOnboardingStateStore({ db, now: () => NOW })
  const emitted: Emitted[] = []
  const deps: OnboardingFinalizeDeps = {
    owner_home: ownerHome,
    owner_slug: OWNER_SLUG,
    db,
    stateStore,
    personaLoader: { invalidate: (): void => {} },
    ensureProjectRow,
    materializer: buildScaffoldMaterializer({
      owner_home: ownerHome,
      project_slug: OWNER_SLUG,
      db,
      now: () => NOW,
    }),
    emitProjectsChanged: (): void => {},
    emitChatMessage: (input): void => {
      emitted.push({
        project_id: input.project_id,
        body: input.body,
        dedupe_key: input.dedupe_key,
      })
    },
    now: () => NOW,
    log: (): void => {},
    personaComposer: fakePersonaComposer(opts.personaFails === true),
  }
  return { db, stateStore, emitted, deps }
}

async function seed(h: Harness, projects: string[]): Promise<Awaited<ReturnType<SqliteOnboardingStateStore['upsert']>>> {
  return h.stateStore.upsert({
    owner_slug: OWNER_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Ryan',
      agent_name: 'Atlas',
      primary_projects: projects,
    },
  })
}

const startingMessages = (e: Emitted[]): Emitted[] =>
  e.filter((m) => m.dedupe_key === 'onboarding_starting')
const openingMessages = (e: Emitted[]): Emitted[] =>
  e.filter((m) => m.dedupe_key.startsWith('onboarding_opening:'))
const closingMessage = (e: Emitted[]): Emitted | undefined =>
  e.find((m) => m.dedupe_key === 'onboarding_closing')

test('STARTING message lands BEFORE any per-project opening, exactly once, and the closing lands LAST', async () => {
  const h = makeHarness()
  const seeded = await seed(h, ['Topline Revenue', 'Garden Rebuild', 'Quarterly Board Deck'])

  const ok = await buildOnboardingFinalize(h.deps).finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
  })
  expect(ok).toBe(true)

  // Exactly one starting message, and it is the owner's FIRST signal — no opening
  // may precede it (the whole point: no silent window while projects are built).
  const starts = startingMessages(h.emitted)
  expect(starts).toHaveLength(1)
  expect(h.emitted.indexOf(starts[0]!)).toBe(0)
  expect(starts[0]!.project_id).toBeNull() // General topic
  expect(starts[0]!.body.toLowerCase()).toContain('setting up your projects')

  // Every opening is a real per-project message that came AFTER the starting one.
  const openings = openingMessages(h.emitted)
  expect(openings.length).toBeGreaterThan(0)
  for (const opening of openings) {
    expect(h.emitted.indexOf(opening)).toBeGreaterThan(0)
    expect(opening.project_id).not.toBeNull()
  }

  // The closing is still the LAST thing the owner sees — after every opening.
  const closing = closingMessage(h.emitted)
  expect(closing).toBeDefined()
  expect(h.emitted.indexOf(closing!)).toBe(h.emitted.length - 1)
})

test('closing message names BOTH affordances: click into each project in the left rail, and ask here', async () => {
  const h = makeHarness()
  const seeded = await seed(h, ['Topline Revenue'])
  await buildOnboardingFinalize(h.deps).finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  const body = closingMessage(h.emitted)?.body ?? ''
  expect(body.toLowerCase()).toContain('left rail')
  expect(body.toLowerCase()).toContain('click into each')
  // The General chat stays available for general questions — the affordance the
  // owner did not know existed.
  expect(body.toLowerCase()).toContain('general questions')
  // House style: no em dashes anywhere in onboarding copy.
  expect(body).not.toContain('—')
})

test('a JOINED and a RE-ENTERED finalize never show the owner the starting message twice', async () => {
  const h = makeHarness()
  const seeded = await seed(h, ['Topline Revenue', 'Garden Rebuild'])
  const finalizer = buildOnboardingFinalize(h.deps)

  // Two concurrent triggers (boot recovery + reconnect replay) COALESCE onto one run.
  await Promise.all([
    finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded }),
    finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded }),
  ])
  expect(startingMessages(h.emitted)).toHaveLength(1)

  // And a LATER finalize of the now-completed row is a clean no-op — the
  // completed-gate returns before any message is emitted.
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })
  expect(startingMessages(h.emitted)).toHaveLength(1)
  expect(h.emitted.filter((m) => m.dedupe_key === 'onboarding_closing')).toHaveLength(1)
})

test('ZERO-project finalize emits NO starting message and a closing that promises no rail', async () => {
  const h = makeHarness()
  const seeded = await seed(h, [])

  const ok = await buildOnboardingFinalize(h.deps).finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
  })
  expect(ok).toBe(true)

  // Nothing to materialize ⇒ never promise projects that are not coming.
  expect(startingMessages(h.emitted)).toHaveLength(0)
  expect(openingMessages(h.emitted)).toHaveLength(0)

  const body = closingMessage(h.emitted)?.body ?? ''
  expect(body.length).toBeGreaterThan(0)
  expect(body.toLowerCase()).not.toContain('left rail')
  expect(body.toLowerCase()).not.toContain("i've created your projects")
})

test('every project already SOFT-DELETED: no starting message, so the promise never contradicts the close', async () => {
  const h = makeHarness()
  // The owner previously deleted both projects. `ensureProjectRow` reports these
  // `skipped` and never resurrects them, so nothing will land and the starting
  // message must not promise otherwise (Codex P2).
  for (const name of ['Topline Revenue', 'Garden Rebuild']) {
    const iso = new Date(NOW).toISOString()
    h.db.run(
      `INSERT INTO projects (id, name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)`,
      [slugifyProjectId(name), name, iso, iso, iso],
    )
  }
  const seeded = await seed(h, ['Topline Revenue', 'Garden Rebuild'])

  await buildOnboardingFinalize(h.deps).finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
  })

  expect(startingMessages(h.emitted)).toHaveLength(0)
  expect(openingMessages(h.emitted)).toHaveLength(0)
  expect(closingMessage(h.emitted)?.body.toLowerCase()).not.toContain('left rail')
})

test('persona_files_committed is PERSISTED true by the terminal write after a successful finalize', async () => {
  const h = makeHarness()
  const seeded = await seed(h, ['Topline Revenue'])
  // Precondition: the column starts at its schema default.
  expect(seeded.persona_files_committed).toBe(false)

  await buildOnboardingFinalize(h.deps).finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  const row = await h.stateStore.get(OWNER_SLUG, USER_ID)
  expect(row?.phase).toBe('completed')
  expect(row?.persona_files_committed).toBe(true)
})

test('a FAILED persona compose leaves persona_files_committed false (the flag never lies)', async () => {
  const h = makeHarness({ personaFails: true })
  const seeded = await seed(h, ['Topline Revenue'])

  // Persona is best-effort: finalize still completes the row.
  const ok = await buildOnboardingFinalize(h.deps).finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
  })
  expect(ok).toBe(true)

  const row = await h.stateStore.get(OWNER_SLUG, USER_ID)
  expect(row?.phase).toBe('completed')
  expect(row?.persona_files_committed).toBe(false)
})
