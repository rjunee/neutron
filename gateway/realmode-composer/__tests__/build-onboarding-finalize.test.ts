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
  deps: OnboardingFinalizeDeps
}

function makeHarness(): Harness {
  const db = makeDb()
  const ownerHome = mkdtempSync(join(tmpdir(), 'finalize-home-'))
  const stateStore = new SqliteOnboardingStateStore({ db, now: () => 1_700_000_000_000 })
  const persona = fakePersonaComposer()
  const invalidated: string[] = []
  const projectsChanged: string[] = []
  const deps: OnboardingFinalizeDeps = {
    owner_home: ownerHome,
    project_slug: PROJECT_SLUG,
    db,
    stateStore,
    personaLoader: { invalidate: (f?: string): void => void invalidated.push(f ?? '*') },
    emitProjectsChanged: (uid: string): void => void projectsChanged.push(uid),
    now: () => 1_700_000_000_000,
    log: (): void => {},
    personaComposer: persona,
  }
  return { db, stateStore, ownerHome, persona, invalidated, projectsChanged, deps }
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
