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

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import type { OnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { slugifyProjectId } from '@neutronai/onboarding/wow-moment/project-identity.ts'
import { MAX_ANALYSIS_PROJECTS } from '@neutronai/onboarding/interview/phase-prompts.ts'
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

test('CONCURRENT finalize (boot + reconnect) does the work EXACTLY ONCE — atomic in-flight claim (F8 P1)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['Topline Revenue'],
    },
  })
  const finalizer = buildOnboardingFinalize(h.deps)

  // The exact F8 race: rearmFromDurableState (boot) + on_session_open (reconnect) both
  // invoke the SAME finalizer for the SAME user before either terminal write. Without
  // an atomic claim BOTH pass the completed-gate → double persona composition + double
  // materialization + double completion side effects. Promise.all starts call #1's sync
  // prefix (claim added before its first await), so call #2's sync claim-check sees the
  // in-flight user and no-ops.
  await Promise.all([
    finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded }),
    finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded }),
  ])

  // Persona composed/committed ONCE (not twice); rail refreshed once; row completed.
  expect(h.persona.committed).toBe(1)
  expect(h.persona.composed).toBe(1)
  expect(h.projectsChanged.filter((u) => u === USER_ID)).toHaveLength(1)
  expect(h.onboardingCompleted.filter((u) => u === USER_ID)).toHaveLength(1)
  expect((await h.stateStore.get(PROJECT_SLUG, USER_ID))?.phase).toBe('completed')

  // And a LATER finalize of the now-completed row is a clean no-op (claim released +
  // completed-gate) — the claim never permanently blocks a genuine future finalize.
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })
  expect(h.persona.committed).toBe(1)
})

test('CONCURRENT finalize whose TERMINAL write FAILS — both callers observe the failure, none falsely succeeds (F8 r2)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['Topline Revenue'],
    },
  })

  // Wrap the real store so the load-bearing terminal CAS throws (locked DB / disk full)
  // WHILE `failTerminal` is set; every other read/write delegates normally. Toggleable so
  // the healed retry can run through the SAME finalizer instance (proving the single-flight
  // claim was actually RELEASED, not merely a fresh empty map).
  const real = h.stateStore
  let completedAttempts = 0
  let failTerminal = true
  const togglingStore: OnboardingStateStore = {
    async get(slug, uid) { return real.get(slug, uid) },
    async upsert(inp) { return real.upsert(inp) },
    async rekey(a, b, c) { return real.rekey(a, b, c) },
    async delete(slug, uid) { return real.delete(slug, uid) },
    async deleteByOwner(slug) { return real.deleteByOwner(slug) },
    async completeIfPhaseStateMatches(inp) {
      completedAttempts += 1
      if (failTerminal) throw new Error('terminal CAS boom')
      return real.completeIfPhaseStateMatches(inp)
    },
  }
  const finalizer = buildOnboardingFinalize({ ...h.deps, stateStore: togglingStore })

  // Two concurrent finalizes. Coalescing runs ONE body; its terminal write throws, so
  // the SHARED promise rejects — BOTH callers must see it (allSettled → both
  // 'rejected'), never a false 'fulfilled' where a contender returns success while the
  // row is not completed. Pre-fix (silent Set no-op + swallowed terminal error) the
  // contender returned 'fulfilled' and no caller completed the row.
  const settled = await Promise.allSettled([
    finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded }),
    finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded }),
  ])
  expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected'])
  expect(completedAttempts).toBe(1) // coalesced: the body ran once (not once-per-caller)

  // The row is NOT completed — it stays pre-terminal for a later retry, and the
  // one-shot completed signal never fired (we never reached it).
  expect((await real.get(PROJECT_SLUG, USER_ID))?.phase).not.toBe('completed')
  expect(h.onboardingCompleted.filter((u) => u === USER_ID)).toHaveLength(0)

  // Heal the store and retry through the SAME finalizer instance. This proves the
  // single-flight claim was RELEASED on the prior rejection — if the rejected promise
  // were permanently retained in the in-flight map, this same-instance retry would
  // join the dead promise and never complete the row.
  failTerminal = false
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })
  expect((await real.get(PROJECT_SLUG, USER_ID))?.phase).toBe('completed')
})

test('finalize RE-COMPOSES persona AND re-materializes when phase_state changes mid-run (F8 r4/r6)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      agent_personality: 'warm',
      primary_projects: ['Alpha'],
    },
  })

  // A persona composer whose commit() runs an INTERLEAVED durable write mid-finalize
  // (once): it changes a PERSONA field (agent_personality) AND adds a project (Beta),
  // exactly the "extractor persists state B during finalization" schedule. The
  // consistency loop must react to BOTH — re-compose persona from the updated field
  // (Codex F8 r6 blocker 2) and re-materialize the fuller project set — before marking
  // completed. Guarded so the mutation fires once (else the loop re-mutates forever).
  let composes = 0
  let mutated = false
  const interleavingPersona: PersonaComposerLike = {
    async compose() { composes += 1; return { draft_id: 'x', status: 'composed' } },
    async commit() {
      if (!mutated) {
        mutated = true
        await h.stateStore.upsert({
          project_slug: PROJECT_SLUG,
          user_id: USER_ID,
          phase: 'persona_reviewed',
          phase_state_patch: { agent_personality: 'warm and direct', primary_projects: ['Alpha', 'Beta'] },
        })
      }
      return { committed_at: 0, git_sha: null, paths: [] }
    },
  }
  const finalizer = buildOnboardingFinalize({ ...h.deps, personaComposer: interleavingPersona })
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  // Persona re-composed from the updated field (≥2 composes = a repass fired).
  expect(composes).toBeGreaterThanOrEqual(2)
  const finalState = await h.stateStore.get(PROJECT_SLUG, USER_ID)
  expect(finalState?.phase).toBe('completed')
  expect(finalState?.phase_state['agent_personality']).toBe('warm and direct')
  // The interleaved project is materialized too, not suppressed by completed.
  const names = (
    h.db.raw().query('SELECT name FROM projects ORDER BY name').all() as { name: string }[]
  ).map((r) => r.name)
  expect(names).toContain('Alpha')
  expect(names).toContain('Beta')
})

test('finalize reconciles a NON-primary-projects materialization input changed mid-run — terminal CAS retry (F8 r6/r9)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['Alpha'],
    },
  })

  // A persona composer whose commit() (during compose, BEFORE the terminal CAS) changes a
  // materialization input OTHER than primary_projects — `non_work_interests` — once. The
  // byte-exact terminal CAS then observes phase_state != what we processed and FAILS
  // (changes=0), forcing a re-read + repass. The change is NOT lost (a coarse
  // primary_projects-only comparison would have missed it; the CAS catches ANY field
  // change), and the row completes only once a pass runs against unchanged state.
  let composes = 0
  let mutated = false
  const persona: PersonaComposerLike = {
    async compose() { composes += 1; return { draft_id: 'x', status: 'composed' } },
    async commit() {
      if (!mutated) {
        mutated = true
        await h.stateStore.upsert({
          project_slug: PROJECT_SLUG,
          user_id: USER_ID,
          phase: 'persona_reviewed',
          phase_state_patch: { non_work_interests: ['climbing'] },
        })
      }
      return { committed_at: 0, git_sha: null, paths: [] }
    },
  }
  const finalizer = buildOnboardingFinalize({ ...h.deps, personaComposer: persona })
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  expect(composes).toBeGreaterThanOrEqual(2) // the mid-run change forced a CAS retry + repass
  const finalState = await h.stateStore.get(PROJECT_SLUG, USER_ID)
  expect(finalState?.phase).toBe('completed')
  expect(finalState?.phase_state['non_work_interests']).toEqual(['climbing'])
})

test('finalize NEVER falsely completes under continuous mid-run churn — the CAS keeps failing, so it defers (F8 r7/r8/r9)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['P0'],
    },
  })

  // A persona composer whose commit() appends a NEW unique project on EVERY pass — so the
  // durable phase_state is different on every pass, and the byte-exact terminal CAS can
  // NEVER match the state that pass processed. This is the fundamental impossibility the
  // r7↔r8↔r9 findings circled: you cannot BOTH always-complete AND never-complete-over-
  // unprocessed-state under perpetual mutation. The CAS resolves it correctly: it refuses
  // to stamp `completed` over changed state, so after the pass budget the finalizer
  // DEFERS (leaves the row non-terminal) rather than falsely completing. This can only
  // happen under an ACTIVE owner (who is generating the mutations), so a real owner always
  // has a further trigger — no permanent strand.
  let pass = 0
  const persona: PersonaComposerLike = {
    async compose() { return { draft_id: 'x', status: 'composed' } },
    async commit() {
      pass += 1
      const projects = Array.from({ length: pass + 1 }, (_, i) => `P${i}`)
      await h.stateStore.upsert({
        project_slug: PROJECT_SLUG,
        user_id: USER_ID,
        phase: 'persona_reviewed',
        phase_state_patch: { primary_projects: projects },
      })
      return { committed_at: 0, git_sha: null, paths: [] }
    },
  }
  const finalizer = buildOnboardingFinalize({ ...h.deps, personaComposer: persona })
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  // Deferred: NEVER falsely completed over unprocessed state (the CAS forbids it), and
  // the completed signal never fired. The row stays non-terminal for the next trigger.
  expect((await h.stateStore.get(PROJECT_SLUG, USER_ID))?.phase).not.toBe('completed')
  expect(h.onboardingCompleted.filter((u) => u === USER_ID)).toHaveLength(0)
})

test('finalize ABORTS on a deleted durable row (successful null read) — no persona/project side effects (F8 r11)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: { user_first_name: 'Sam', agent_name: 'Atlas', primary_projects: ['Alpha'] },
  })
  // The authoritative durable row is deleted AFTER the caller captured its snapshot.
  await h.stateStore.delete(PROJECT_SLUG, USER_ID)

  let composed = 0
  const persona: PersonaComposerLike = {
    async compose() { composed += 1; return { draft_id: 'x', status: 'composed' } },
    async commit() { return { committed_at: 0, git_sha: null, paths: [] } },
  }
  const finalizer = buildOnboardingFinalize({ ...h.deps, personaComposer: persona })
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  // A successful null read aborts BEFORE any side effect: no persona composed, no project
  // rows created, no completion signal, and no ghost row recreated.
  expect(composed).toBe(0)
  expect((h.db.raw().query('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0)
  expect(h.onboardingCompleted).toEqual([])
  expect(await h.stateStore.get(PROJECT_SLUG, USER_ID)).toBeNull()
})

test('finalize RECONCILES a project dropped mid-run — soft-deletes the stale row an earlier pass created (F8 r11)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: { user_first_name: 'Sam', agent_name: 'Atlas', primary_projects: ['Alpha'] },
  })

  // commit() (before the terminal CAS) DROPS Alpha and switches to Beta — but only AFTER
  // pass 0 has already materialized Alpha from the stale [Alpha] snapshot. The terminal CAS
  // then fails (state changed), pass 1 runs on [Beta] and completes, and the post-completion
  // reconcile must soft-delete Alpha's now-orphaned live row.
  let mutated = false
  const persona: PersonaComposerLike = {
    async compose() { return { draft_id: 'x', status: 'composed' } },
    async commit() {
      if (!mutated) {
        mutated = true
        await h.stateStore.upsert({
          project_slug: PROJECT_SLUG,
          user_id: USER_ID,
          phase: 'persona_reviewed',
          phase_state_patch: { primary_projects: ['Beta'], dropped_projects: ['Alpha'] },
        })
      }
      return { committed_at: 0, git_sha: null, paths: [] }
    },
  }
  const finalizer = buildOnboardingFinalize({ ...h.deps, personaComposer: persona })
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  expect((await h.stateStore.get(PROJECT_SLUG, USER_ID))?.phase).toBe('completed')
  // Beta is live; Alpha (materialized by the stale pass 0) is reconciled away.
  const live = (
    h.db.raw().query('SELECT name FROM projects WHERE deleted_at IS NULL ORDER BY name').all() as {
      name: string
    }[]
  ).map((r) => r.name)
  expect(live).toContain('Beta')
  expect(live).not.toContain('Alpha')
  // Alpha's row still exists but is soft-deleted.
  const alpha = h.db
    .raw()
    .query('SELECT deleted_at FROM projects WHERE id = ?')
    .get(slugifyProjectId('Alpha')) as { deleted_at: number | null } | null
  expect(alpha?.deleted_at).not.toBeNull()
})

test('finalize ABORTS (never completes) if the phase transitions to a live import mid-run (F8 r10)', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['Alpha'],
    },
  })

  // commit() (during compose, before the terminal CAS) transitions the row to a live
  // import phase — a concurrent import kicking off after the finalize trigger. The terminal
  // CAS pins the ORIGINAL phase, so it fails; the re-read sees a non-finalizable phase and
  // the finalizer ABORTS rather than stamping `completed` over the live import.
  let mutated = false
  const persona: PersonaComposerLike = {
    async compose() { return { draft_id: 'x', status: 'composed' } },
    async commit() {
      if (!mutated) {
        mutated = true
        await h.stateStore.upsert({ project_slug: PROJECT_SLUG, user_id: USER_ID, phase: 'import_running' })
      }
      return { committed_at: 0, git_sha: null, paths: [] }
    },
  }
  const finalizer = buildOnboardingFinalize({ ...h.deps, personaComposer: persona })
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  // Never finalized on top of the live import.
  const finalState = await h.stateStore.get(PROJECT_SLUG, USER_ID)
  expect(finalState?.phase).toBe('import_running')
  expect(finalState?.phase).not.toBe('completed')
  expect(h.onboardingCompleted.filter((u) => u === USER_ID)).toHaveLength(0)
})

test('finalize operates on the LIVE durable state, not a stale caller snapshot (F8 r3)', async () => {
  const h = makeHarness()
  // Snapshot A — the state a caller captured with ONE project.
  const snapA = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['Alpha'],
    },
  })
  // Durable state ADVANCES to B (an added project) before finalize runs — exactly
  // the coalescing boundary: a newer caller persisted more, then the older caller's
  // run wins the race carrying the stale snapshot A.
  await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: { primary_projects: ['Alpha', 'Beta'] },
  })

  // Finalize with the STALE snapshot A. finalize re-reads live durable state after
  // claiming, so it materializes BOTH Alpha AND Beta (the live set). Pre-fix (frozen
  // input.state) it materialized only Alpha and `completed` suppressed Beta forever.
  const finalizer = buildOnboardingFinalize(h.deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: snapA })

  const names = (
    h.db.raw().query('SELECT name FROM projects ORDER BY name').all() as { name: string }[]
  ).map((r) => r.name)
  expect(names).toContain('Alpha')
  expect(names).toContain('Beta')
})

test('finalize completes onboarding: persona, projects row, rail refresh', async () => {
  const h = makeHarness()

  // Seed an in-flight onboarding row with two named projects.
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['Topline Revenue', 'Home Assistant'],
    },
  })
  expect(seeded.phase).toBe('persona_reviewed')

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
    phase: 'persona_reviewed',
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

test('finalize does NOT emit the onboarding-complete signal when the terminal upsert fails', async () => {
  const h = makeHarness()
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: { primary_projects: ['Topline Revenue'] },
  })

  // Wrap the real store so ONLY the terminal CAS completion throws (locked DB / disk
  // full); every other read/write still delegates to the real store.
  const realStore = h.deps.stateStore
  const throwingStore = Object.create(realStore) as typeof realStore
  throwingStore.completeIfPhaseStateMatches = ((
    _input: Parameters<typeof realStore.completeIfPhaseStateMatches>[0],
  ) => {
    throw new Error('locked db')
  }) as typeof realStore.completeIfPhaseStateMatches

  const finalizer = buildOnboardingFinalize({ ...h.deps, stateStore: throwingStore })
  // The terminal write fails → finalize SURFACES it (rejects) so the caller retries
  // on the next trigger and a coalesced contender can't falsely report success (F8 r2).
  await expect(
    finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded }),
  ).rejects.toThrow('locked db')

  // The row never reached `completed`, so the claim-redirect signal must NOT
  // fire — otherwise a Managed client would be pulled to the claim flow despite
  // an unfinished onboarding.
  expect(h.onboardingCompleted).toEqual([])

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
    phase: 'persona_reviewed',
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
    phase: 'persona_reviewed',
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
    phase: 'persona_reviewed',
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
    phase: 'persona_reviewed',
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
    phase: 'persona_reviewed',
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
    phase: 'persona_reviewed',
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
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['Topline Revenue', 'Home Assistant'],
    },
  })

  const finalizer = buildOnboardingFinalize(deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  // Exactly one General closing (project_id === null) pointing at the rail + Work.
  const closings = emitted.filter((e) => e.project_id === null)
  expect(closings).toHaveLength(1)
  expect(closings[0]!.user_id).toBe(USER_ID)
  expect(closings[0]!.body).toMatch(/left rail/i)
  expect(closings[0]!.body).toMatch(/Work/)
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

test('no-context project opens with the HONEST prompt, not a fabricated status (SEV1)', async () => {
  const h = makeHarness()
  const emitted: Array<{ project_id: string | null; body: string }> = []
  const deps: OnboardingFinalizeDeps = {
    ...h.deps,
    emitChatMessage: (input): void => void emitted.push(input),
  }
  // A thin chat-answer project: no import, no rationale → materializer flags it
  // has_context=false → the opening must ask for context, never fabricate one.
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: { user_first_name: 'Sam', primary_projects: ['Mystery Thing'] },
  })
  const finalizer = buildOnboardingFinalize(deps)
  await finalizer.finalize({ user_id: USER_ID, topic_id: TOPIC_ID, state: seeded })

  const opening = emitted.find((e) => e.project_id === slugifyProjectId('Mystery Thing'))
  expect(opening).toBeDefined()
  expect(opening!.body).toContain("I don't have any context on Mystery Thing yet")
  // The exact bug: NO fabricated "here's where X stands" / "active, P2".
  expect(opening!.body.toLowerCase()).not.toContain("here's where")
  expect(opening!.body).not.toContain('active, P2')
  h.db.close()
})

test('a project WITH import context keeps a real summary opening (not the honest prompt)', async () => {
  const h = makeHarness()
  const emitted: Array<{ project_id: string | null; body: string }> = []
  const deps: OnboardingFinalizeDeps = {
    ...h.deps,
    emitChatMessage: (input): void => void emitted.push(input),
  }
  const seeded = await h.stateStore.upsert({
    project_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_reviewed',
    phase_state_patch: { user_first_name: 'Sam', primary_projects: ['Topline Revenue'] },
  })
  const finalizer = buildOnboardingFinalize(deps)
  await finalizer.finalize({
    user_id: USER_ID,
    topic_id: TOPIC_ID,
    state: seeded,
    import_result: {
      entities: [],
      topics: [],
      proposed_projects: [
        {
          name: 'Topline Revenue',
          rationale: 'The Topline revenue model is the highest-leverage thread in your history.',
          suggested_topics: ['revenue model'],
        },
      ],
      proposed_tasks: [],
      proposed_reminders: [],
      voice_signals: {},
      facts: {},
    } as never,
  })

  const opening = emitted.find((e) => e.project_id === slugifyProjectId('Topline Revenue'))
  expect(opening).toBeDefined()
  // Real grounding → NOT the honest no-context prompt.
  expect(opening!.body).not.toContain("I don't have any context on")
  expect(opening!.body.toLowerCase()).toContain('revenue')
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
    phase: 'persona_reviewed',
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
    phase: 'persona_reviewed',
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
    phase: 'persona_reviewed',
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
    } as unknown as import('@neutronai/onboarding/history-import/types.ts').ImportResult,
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
    phase: 'persona_reviewed',
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
    phase: 'persona_reviewed',
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
    phase: 'persona_reviewed',
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
