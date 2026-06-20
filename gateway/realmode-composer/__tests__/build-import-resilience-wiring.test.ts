/**
 * 2026-05-25 (import-pipeline-resilience sprint, Argus r1 fix-pass) —
 * production-composer reachability regression for the three BLOCKERS
 * Argus surfaced on PR #311 r1:
 *
 *   BLOCKER #1 — entity-populator deps. `buildImportJobRunnerHook`
 *               accepts `ownerDataDir` / `writeEntity` /
 *               `gbrainSyncHook` and threads them into the
 *               `ImportJobRunner` so the post-completion + partial-
 *               synthesis fan-out actually fires
 *               `populateEntitiesFromImport(...)`. Before this fix,
 *               the production composer constructed the runner WITHOUT
 *               these deps so every import landed an `import_results`
 *               JSON row that nothing read.
 *
 *   BLOCKER #2 — `POST /api/import/<job_id>/resume` mount. Surfaced
 *               from `buildLandingStack` via the shared
 *               `importJobRunner` / `importPayloadResolver` /
 *               `stateStore` fields the boot shell consumes.
 *               `gateway/index.ts` builds the resume handler with
 *               those instances; without sharing, a resume would
 *               build a parallel runner that didn't see the in-flight
 *               cron tick state.
 *
 *   BLOCKER #3 — `ImportResumeReadinessProbe`. The composer
 *               default-builds the probe so the engine renders the
 *               `resume_import` button on `import_analysis_presented`
 *               when prior import is genuinely resumable. Without
 *               the default-build, the engine's
 *               `importResumeReadiness` dep stayed unwired and
 *               `can_resume_import` was always false.
 *
 * Each test exercises the construction-shape assertion AND a thin
 * behavioural check so a future refactor that wires through `undefined`
 * (or stubs the wiring out at the composer layer) trips a red test
 * rather than silently regressing production. All assertions walk the
 * shared `buildOnboardingEnginePieces` / `buildLandingStack` surface
 * — no parallel implementation diverging from prod.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { JwksCache } from '../../../jwt-validator/validator.ts'
import type { SlugHistoryShimStore } from '../../http/chat-bridge.ts'
import { buildLandingStack, buildOnboardingEnginePieces } from '../build-landing-stack.ts'
import { buildImportResumeHandler } from '../../upload/import-resume-handler.ts'
import type { ImportSource } from '../../../onboarding/history-import/types.ts'
import type {
  EntityPopulatorWriteEntityFn,
} from '../../../onboarding/history-import/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const REPO_LANDING_DIR = join(REPO_ROOT, 'landing')

const NOOP_SHIM_STORE: SlugHistoryShimStore = { lookup: async () => null }
const OWNER = 'alice'
const USER = 'u-alice'

let workdir: string
let ownerHome: string
let db: ProjectDb

function makeJwks(): JwksCache {
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify({ keys: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return new JwksCache('https://auth.example.test/.well-known/jwks.json', {
    fetch: fetchImpl,
  })
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-import-resilience-wiring-'))
  ownerHome = join(workdir, 'project-home')
  mkdirSync(ownerHome, { recursive: true })
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(workdir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// BLOCKER #1 — entity-populator wiring through the composer
// ---------------------------------------------------------------------------

test('BLOCKER #1 — composer threads entity-populator deps into ImportJobRunner (recorder fires on completed import)', async () => {
  // Recorder writeEntity captures every populator call. The deps
  // assertion is "if the composer didn't wire ownerDataDir +
  // writeEntity into runnerDeps, this stays at 0 even though the
  // populator's resolver said `pages_to_write > 0`."
  const calls: Array<{ ownerDataDir: string; kind: string; slug: string }> = []
  const writeEntity: EntityPopulatorWriteEntityFn = async (input) => {
    calls.push({
      ownerDataDir: input.ownerDataDir,
      kind: input.kind,
      slug: input.slug,
    })
    return { path: `${input.ownerDataDir}/entities/${input.kind}/${input.slug}.md`, changed: true, newLinks: [] }
  }
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: OWNER,
    owner_home: ownerHome,
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-aaaaaaaa',
    slugHistoryStore: NOOP_SHIM_STORE,
    importWriteEntity: writeEntity,
    // Deterministic Pass-1/Pass-2 stubs so the runner reaches the
    // populator branch without an LLM call.
    importPass1Llm: async () => ({
      result: {
        candidate_entities: [
          { kind: 'person', name: 'Alice Example', mention_count: 5 },
          { kind: 'person', name: 'Bob Example', mention_count: 3 },
        ],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0,
    }),
    importPass2Llm: async () => ({
      result: {
        proposed_projects: [],
        proposed_tasks: [],
        proposed_reminders: [],
        entities: [
          {
            kind: 'person',
            name: 'Alice Example',
            mention_count: 5,
            slug: 'alice-example',
            compiledTruth: 'A friend.',
          },
          {
            kind: 'person',
            name: 'Bob Example',
            mention_count: 3,
            slug: 'bob-example',
            compiledTruth: 'A colleague.',
          },
        ],
      },
      dollars_billed: 0,
    }),
    // Parser yields one conversation so the runner has Pass-1 chunks
    // to process before reaching Pass-2 + the populator.
    //
    // 2026-05-31 — user-role text MUST exceed MIN_USER_CONTENT_CHARS
    // (500 chars) or the chunker stamps skip_llm=true and the Pass-1
    // stub never fires → aggregated entities stay empty → populator
    // has nothing to write → calls.length stays at 0 and the test
    // fails for a reason unrelated to the composer's deps wiring.
    importParse: async function* () {
      yield {
        conversation_id: 'c1',
        messages: [
          {
            role: 'user' as const,
            text:
              'Hello Alice — I wanted to follow up on our conversation about ' +
              'the project planning we discussed last week. There are a few ' +
              'open items I would like to walk through with you, including the ' +
              'launch timeline, the engineering ramp, the marketing roll-out, ' +
              'and the budget. I also want to loop in Bob and Carol on the ' +
              'engineering side since they have context on the prior sprint. ' +
              'Let me know if you have time later this week to sync; otherwise ' +
              'we can do this asynchronously over email or Slack. Adding more ' +
              'context so the chunker keeps this above the 500-char skip_llm ' +
              'floor: the project name is "rainman" and the lead engineer is ' +
              'Bob and the PM is Carol.',
          },
          { role: 'assistant' as const, text: 'Hello back. Talked with Bob.' },
        ],
      }
    },
  })
  // Construction-shape assertion — the composer always default-builds
  // the runner, never null.
  expect(pieces.importJobRunner).not.toBeNull()
  const runner = pieces.importJobRunner!
  // Drive a job end-to-end. The stub LLMs resolve immediately so the
  // run completes within a few ticks.
  const { job_id } = await runner.start({
    project_slug: OWNER,
    user_id: USER,
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  for (let i = 0; i < 400; i++) {
    const s = await runner.status(job_id)
    // The runner persists `status='completed'` on both the happy and
    // partial-synthesis paths; the partial-vs-not distinction lives on
    // the import_results row's `partial` column, not on the job row.
    if (s !== null && (s.status === 'completed' || s.status === 'failed')) break
    await new Promise((r) => setTimeout(r, 5))
  }
  const finalStatus = await runner.status(job_id)
  expect(finalStatus).not.toBeNull()
  expect(finalStatus!.status).toBe('completed')
  // The populator fired against the composer-wired writeEntity recorder.
  // Without the composer change, calls.length stays at 0 (the runner's
  // ownerDataDir / writeEntity deps would be undefined and
  // `runEntityPopulator` would short-circuit).
  expect(calls.length).toBeGreaterThan(0)
  // ownerDataDir defaults to owner_home — the production composer's
  // documented contract.
  expect(calls[0]!.ownerDataDir).toBe(ownerHome)
})

// ---------------------------------------------------------------------------
// BLOCKER #2 — POST /api/import/<job_id>/resume mount reachability
// ---------------------------------------------------------------------------

test('BLOCKER #2 — buildLandingStack exposes runner+resolver+stateStore so resume handler mounts against the live engine instances', async () => {
  ensureChatHtml(REPO_LANDING_DIR)
  const landing = buildLandingStack({
    db,
    project_slug: OWNER,
    owner_home: ownerHome,
    jwks: makeJwks(),
    static_dir: REPO_LANDING_DIR,
    internal_handle: 't-aaaaaaaa',
    slugHistoryStore: NOOP_SHIM_STORE,
  })
  // Construction-shape assertion — these three fields are what the boot
  // shell pulls off the landing stack to build the resume handler.
  // Without them the boot shell's resume-mount branch falls through and
  // POST /api/import/<id>/resume 404s.
  expect(landing.importJobRunner).not.toBeNull()
  expect(landing.importPayloadResolver).not.toBeNull()
  expect(landing.stateStore).toBeDefined()
  // Build the handler the same way the production boot shell does.
  const handler = buildImportResumeHandler({
    db,
    project_slug: OWNER,
    owner_home: ownerHome,
    runner: landing.importJobRunner!,
    payloadResolver: landing.importPayloadResolver!,
    stateStore: landing.stateStore,
  })
  // Seed a resumable job row so the handler can walk to a non-404
  // response. The handler's lookup path joins on onboarding_state,
  // which doesn't exist here yet — but the route-ownership branch
  // fires BEFORE that lookup, so a POST against the resume path
  // returns a non-null Response. That's the "the route is owned"
  // assertion we need.
  db.raw().run(
    `INSERT INTO import_jobs (job_id, project_slug, source, status,
        dollars_spent, pass1_chunks_done, pass1_chunks_total,
        chunks_total_known, started_at)
     VALUES ('j-resumable', ?, 'chatgpt-zip', 'cancelled', 0, 0, 0, 0, ?)`,
    [OWNER, 1_700_000_000_000],
  )
  const res = await handler(
    new Request('http://x/api/import/j-resumable/resume', { method: 'POST' }),
  )
  // The route owns the path — non-null. The exact body / status depends
  // on whether the ZIP exists on disk; the assertion that catches the
  // mount regression is "the handler does NOT return null for this path".
  expect(res).not.toBeNull()
  // A second request against a non-owned path returns null so the
  // composition chain falls through to the next handler. Pins the
  // route-isolation guarantee.
  const fallthrough = await handler(
    new Request('http://x/api/upload/chatgpt-zip', { method: 'POST' }),
  )
  expect(fallthrough).toBeNull()
})

test('BLOCKER #2 — production resume handler routes to 404 (not null) for an unknown job_id under this project', async () => {
  // The 404 path is the strongest fingerprint that the chain reached
  // the resume handler — non-owned paths return null + fall through,
  // owned paths with no matching job return a 404 JSON body. Same
  // distinction Argus would catch in a "is the handler mounted?"
  // check.
  ensureChatHtml(REPO_LANDING_DIR)
  const landing = buildLandingStack({
    db,
    project_slug: OWNER,
    owner_home: ownerHome,
    jwks: makeJwks(),
    static_dir: REPO_LANDING_DIR,
    internal_handle: 't-aaaaaaaa',
    slugHistoryStore: NOOP_SHIM_STORE,
  })
  const handler = buildImportResumeHandler({
    db,
    project_slug: OWNER,
    owner_home: ownerHome,
    runner: landing.importJobRunner!,
    payloadResolver: landing.importPayloadResolver!,
    stateStore: landing.stateStore,
  })
  const res = await handler(
    new Request('http://x/api/import/does-not-exist/resume', { method: 'POST' }),
  )
  expect(res).not.toBeNull()
  expect(res!.status).toBe(404)
  const body = (await res!.json()) as { error: string }
  expect(body.error).toBe('job_not_found')
})

// ---------------------------------------------------------------------------
// BLOCKER #3 — ImportResumeReadinessProbe wired into the engine
// ---------------------------------------------------------------------------

test('BLOCKER #3 — composer default-builds a non-null ImportResumeReadinessProbe and threads it through to the engine', async () => {
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: OWNER,
    owner_home: ownerHome,
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-aaaaaaaa',
    slugHistoryStore: NOOP_SHIM_STORE,
  })
  // Construction-shape — the composer always default-builds the probe
  // when caller omits the field. Before this fix the engine's
  // `importResumeReadiness` dep was undefined and the
  // `can_resume_import` flag was always false.
  expect(pieces.importResumeReadiness).not.toBeNull()
  const probe = pieces.importResumeReadiness!
  // Behavioural check — the probe walks the same gate the HTTP
  // resume handler does: returns true for a resumable status + zip
  // on disk; false otherwise.
  const importsDir = join(ownerHome, 'imports')
  mkdirSync(importsDir, { recursive: true })
  const zipPath = join(importsDir, 'chatgpt.zip')
  writeFileSync(zipPath, 'fake-zip-bytes')
  db.raw().run(
    `INSERT INTO import_jobs (job_id, project_slug, source, status,
        dollars_spent, pass1_chunks_done, pass1_chunks_total,
        chunks_total_known, started_at)
     VALUES ('j-resumable', ?, 'chatgpt-zip', 'cancelled', 0, 0, 0, 0, ?)`,
    [OWNER, 1_700_000_000_000],
  )
  expect(
    await probe.isResumable({
      project_slug: OWNER,
      user_id: USER,
      source: 'chatgpt-zip' as ImportSource,
      job_id: 'j-resumable',
    }),
  ).toBe(true)
  // Same row, zip gone → false (gate matches handler semantics).
  rmSync(zipPath)
  expect(
    await probe.isResumable({
      project_slug: OWNER,
      user_id: USER,
      source: 'chatgpt-zip' as ImportSource,
      job_id: 'j-resumable',
    }),
  ).toBe(false)
  // Status `completed` → false even when ZIP exists.
  writeFileSync(zipPath, 'fake-zip-bytes')
  db.raw().run(
    `INSERT INTO import_jobs (job_id, project_slug, source, status,
        dollars_spent, pass1_chunks_done, pass1_chunks_total,
        chunks_total_known, started_at)
     VALUES ('j-completed', ?, 'chatgpt-zip', 'completed', 0, 0, 0, 0, ?)`,
    [OWNER, 1_700_000_000_000],
  )
  expect(
    await probe.isResumable({
      project_slug: OWNER,
      user_id: USER,
      source: 'chatgpt-zip' as ImportSource,
      job_id: 'j-completed',
    }),
  ).toBe(false)
  // Unknown job_id → false.
  expect(
    await probe.isResumable({
      project_slug: OWNER,
      user_id: USER,
      source: 'chatgpt-zip' as ImportSource,
      job_id: 'j-missing',
    }),
  ).toBe(false)
})

test('BLOCKER #3 — explicit null override opts out of the probe (legacy back-compat)', async () => {
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: OWNER,
    owner_home: ownerHome,
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-aaaaaaaa',
    slugHistoryStore: NOOP_SHIM_STORE,
    importResumeReadiness: null,
  })
  expect(pieces.importResumeReadiness).toBeNull()
})

function ensureChatHtml(staticDir: string): void {
  const target = join(staticDir, 'chat.html')
  if (!existsSync(target)) {
    writeFileSync(target, '<html></html>')
  }
}
