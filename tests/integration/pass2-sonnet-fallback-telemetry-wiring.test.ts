/**
 * P2-v2 S22 (2026-05-17, Argus R2 follow-up) — production telemetry-
 * callback wiring regression test.
 *
 * MOTIVATION:
 *   S21 shipped the `importOnSonnetFallback` parameter on
 *   `buildLandingStack` and threaded it through
 *   `buildImportJobRunnerHook` → `buildPass2SubstrateCaller`, but
 *   `gateway/index.ts` (the only production caller of `buildLandingStack`)
 *   never supplied an actual callback. Result: the Pass-2 Sonnet
 *   fallback path silently succeeded on every Opus 429 BUT the
 *   `onboarding.pass2_sonnet_fallback_used` event stayed at 0 in
 *   journald + the metrics view. Dashboards built on that metric
 *   would render as "no fallback ever happens" forever.
 *
 *   S22 wires the production closure (`buildPass2SonnetFallbackTelemetryHook`)
 *   into the realmode composer. This test pins that wiring: when the
 *   PRODUCTION callback shape is threaded into the composer's
 *   `buildOnboardingEnginePieces` path (which is what `buildLandingStack`
 *   uses internally) AND the Pass-2 substrate caller triggers Sonnet
 *   fallback, a row lands in `gateway_events` with the documented event
 *   shape (project_slug, user_id, attempt_id, reason, source,
 *   synthesizer_model, primary_model, primary_error_message).
 *
 *   Without this test, a future refactor could land that drops the
 *   `importOnSonnetFallback` thread (the exact failure mode Argus R2
 *   flagged on S21 — code review didn't catch it because no test
 *   asserted the production-level wiring).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { JwksCache } from '@neutronai/jwt-validator/validator.ts'
import { buildOnboardingEnginePieces } from '@neutronai/gateway/realmode-composer/build-landing-stack.ts'
import { buildPass2SonnetFallbackTelemetryHook } from '@neutronai/gateway/realmode-composer/build-pass2-fallback-telemetry-hook.ts'
import { buildProductionOnboardingTelemetry } from '@neutronai/onboarding/telemetry/index.ts'
import type { SlugHistoryShimStore } from '@neutronai/gateway/http/chat-bridge.ts'
import { BEST_MODEL, SONNET_MODEL } from '@neutronai/runtime/models.ts'
import type { Substrate, AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Pass1LlmCall } from '@neutronai/onboarding/history-import/pass1-triage.ts'

const NOOP_SHIM_STORE: SlugHistoryShimStore = { lookup: async () => null }

let workdir: string
let db: ProjectDb

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-s22-fallback-telemetry-'))
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

// ---------------------------------------------------------------------------
// Substrate stub — scripted event streams per `start(spec)` call.
// Mirrors the shape used in pass2-sonnet-fallback.test.ts so the wiring
// regression here exercises the same model-switch behavior end-to-end.
// ---------------------------------------------------------------------------

interface ScriptedTurn {
  events: ReadonlyArray<Event>
}

interface SubstrateCall {
  spec: AgentSpec
}

function makeSubstrateStub(turns: ReadonlyArray<ScriptedTurn>): {
  substrate: Substrate
  calls: SubstrateCall[]
} {
  const calls: SubstrateCall[] = []
  let cursor = 0
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      const turn = turns[cursor]
      if (turn === undefined) {
        throw new Error(
          `substrate stub exhausted: caller dispatched ${cursor + 1} turns but only ${turns.length} scripted`,
        )
      }
      cursor += 1
      calls.push({ spec })
      const it = (async function* () {
        for (const ev of turn.events) yield ev
      })()
      return {
        events: it,
        respondToTool: () => Promise.reject(new Error('internal')),
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  }
  return { substrate, calls }
}

function pass2ErrorTurn(message: string): ScriptedTurn {
  return {
    events: [{ kind: 'error', message, retryable: true, retry_after_ms: 0 }],
  }
}

function pass2JsonTurn(payload: object): ScriptedTurn {
  return {
    events: [
      { kind: 'token', text: JSON.stringify(payload) },
      {
        kind: 'completion',
        usage: { input_tokens: 500, output_tokens: 250 },
        substrate_instance_id: 'cc-test',
      },
    ],
  }
}

const PASS2_JSON_BODY = {
  proposed_projects: [
    { name: 'Ledgerline', rationale: 'top topic', suggested_topics: ['sales'] },
  ],
  proposed_tasks: [{ title: 'Reply to Omar', priority_hint: 'P1' }],
  proposed_reminders: [
    { pattern: 'every weekday at 09:00', body: 'review threads' },
  ],
  facts: { user_role: 'CEO' },
}

// Pass-1 stub: enough signal that Pass-2 has a non-empty aggregated body
// to send through. The runner caps at one chunk for this in-memory parser
// (single record yielded below).
const pass1Ok: Pass1LlmCall = async () => ({
  result: {
    candidate_entities: [{ name: 'Ledgerline', kind: 'company', mention_count: 1 }],
    candidate_topics: [],
    candidate_tasks: [],
    voice_signals: {},
  },
  dollars_billed: 0.01,
})

// ---------------------------------------------------------------------------
// THE TEST — exercises the PRODUCTION wiring path.
// ---------------------------------------------------------------------------

test('S22: buildLandingStack-wired importJobRunner emits onboarding.pass2_sonnet_fallback_used on Sonnet fallback', async () => {
  // 1. Construct the production OnboardingTelemetry via the SAME helper
  //    the realmode composer + module graph use. The resolveAttemptId
  //    hook mint-on-miss is exercised end-to-end (no pre-seeded
  //    onboarding_state row).
  const telemetry = buildProductionOnboardingTelemetry({ db })

  // 2. Build the production importOnSonnetFallback closure via the
  //    factored helper that gateway/index.ts also uses. project_slug is
  //    resolved at emit time (R3 — mirrors importUrlSlugResolver); the
  //    static-slug case here pins one-arrow behavior with a constant
  //    resolver. user_id is captured by value. attempt_id is resolved
  //    automatically by the telemetry's resolveAttemptId hook.
  const PROJECT_SLUG = 'mira'
  const USER_ID = 'u-test-1'
  const importOnSonnetFallback = buildPass2SonnetFallbackTelemetryHook({
    telemetry,
    project_slug_resolver: () => PROJECT_SLUG,
    user_id: USER_ID,
  })

  // 3. Substrate stub — Pass-1 chunk, then Pass-2 Opus 429, then Pass-2
  //    Sonnet success. The runner dispatches Pass-1 first (Haiku), then
  //    Pass-2 (Opus → 429 → Sonnet succeeds).
  //    NOTE: pass1 is overridden via `importPass1Llm` so we don't have
  //    to script Pass-1 events on the substrate stub.
  const { substrate, calls } = makeSubstrateStub([
    // Pass-2 attempt 1 (Opus 4.7) — 429.
    pass2ErrorTurn('pass2 substrate error: HTTP 429: rate_limit_error (opus exhausted)'),
    // Pass-2 attempt 2 (Sonnet 4.6) — success.
    pass2JsonTurn(PASS2_JSON_BODY),
  ])

  // 4. buildOnboardingEnginePieces is the EXACT internal helper
  //    buildLandingStack uses to construct the engine + import-job-
  //    runner hook. Passing `importOnSonnetFallback` here mirrors the
  //    same field threading buildLandingStack does at gateway/index.ts.
  //    Pass-1 is overridden via `importPass1Llm` so Pass-1 doesn't
  //    consume from the substrate stub.
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: PROJECT_SLUG,
    owner_home: join(workdir, 'owner-home'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-mira-0001',
    slugHistoryStore: NOOP_SHIM_STORE,
    importSubstrate: substrate,
    importPass1Llm: pass1Ok,
    importOnSonnetFallback,
    // Override the default-built source parser with an in-memory
    // generator so we don't need a zip file on disk.
    importParse: async function* () {
      yield {
        conversation_id: 'c1',
        title: 'test conversation',
        messages: [
          { role: 'user', text: 'hello there' },
          { role: 'assistant', text: 'hi' },
        ],
      }
    },
  })

  // 5. Drive the runner. The Pass-2 substrate caller is wired with
  //    `fallback_model_preference: [SONNET_MODEL]` by
  //    buildImportJobRunnerHook + the production importOnSonnetFallback.
  expect(pieces.importJobRunner).not.toBeNull()
  const runnerHook = pieces.importJobRunner!
  const { job_id } = await runnerHook.start({ project_slug: PROJECT_SLUG, user_id: 'test-user', source: 'chatgpt-zip',
    payload: Buffer.from('placeholder'),
  })

  // 6. Wait for the background job to drive Pass-1 + Pass-2.
  //    Polls runner.status until terminal. 5s ceiling is enormous for
  //    an in-process stub-substrate job (typically completes <50ms).
  const deadline = Date.now() + 5_000
  let job: { status: string } | null = null
  while (Date.now() < deadline) {
    job = await runnerHook.status(job_id)
    if (job !== null && (job.status === 'completed' || job.status === 'failed')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(job?.status).toBe('completed')

  // 7. Two substrate calls fired: Opus (primary) + Sonnet (fallback).
  expect(calls.length).toBe(2)
  expect(calls[0]!.spec.model_preference[0]).toBe(BEST_MODEL)
  expect(calls[1]!.spec.model_preference[0]).toBe(SONNET_MODEL)

  // 8. THE KEY ASSERTION: a gateway_events row landed for
  //    `onboarding.pass2_sonnet_fallback_used` with the documented
  //    event shape. Pre-S22 this row WOULD NOT exist (no production
  //    call site wired the callback).
  const events = telemetry.list(PROJECT_SLUG)
  const fallbackEvents = events.filter(
    (e) => e.event === 'onboarding.pass2_sonnet_fallback_used',
  )
  expect(fallbackEvents.length).toBe(1)
  const row = fallbackEvents[0]!
  expect(row.project_slug).toBe(PROJECT_SLUG)
  expect(row.user_id).toBe(USER_ID)
  expect(row.module).toBe('onboarding')
  // attempt_id was resolved by the mint-on-miss path (no pre-seeded
  // onboarding_state row); proves the production resolveAttemptId hook
  // ran rather than collapsing to LEGACY_ATTEMPT_ID.
  expect(row.attempt_id).toBeDefined()
  expect(row.attempt_id.length).toBeGreaterThan(0)
  expect(row.attempt_id).not.toBe('legacy-pre-S30')
  // Payload conforms to Pass2SonnetFallbackUsedPayload.
  const payload = row.payload as Record<string, unknown>
  expect(payload.reason).toBe('429_exhausted_on_opus')
  expect(payload.source).toBe('chatgpt-zip')
  expect(payload.synthesizer_model).toBe(SONNET_MODEL)
  expect(payload.primary_model).toBe(BEST_MODEL)
  expect(typeof payload.primary_error_message).toBe('string')
  expect((payload.primary_error_message as string)).toContain('HTTP 429')

  // 9. Cross-check the raw gateway_events table directly — the
  //    SQL roundtrip proves the row is also queryable by the
  //    onboarding_metrics view (which aggregates from this table).
  interface RawRow {
    event_name: string
    project_slug: string
    user_id: string
    attempt_id: string
  }
  const rawRow = db
    .raw()
    .query<RawRow, [string]>(
      `SELECT event_name, project_slug, user_id, attempt_id
         FROM gateway_events
        WHERE event_name = ?`,
    )
    .get('onboarding.pass2_sonnet_fallback_used')
  expect(rawRow).not.toBeNull()
  expect(rawRow!.project_slug).toBe(PROJECT_SLUG)
  expect(rawRow!.user_id).toBe(USER_ID)
  expect(rawRow!.attempt_id).toBe(row.attempt_id)
})

// ---------------------------------------------------------------------------
// Negative-control regression — proves the assertion above isn't just
// counting any event named 'onboarding.pass2_sonnet_fallback_used'. The
// PRE-S22 wiring shape (no importOnSonnetFallback supplied) MUST NOT
// produce the row even though the Pass-2 fallback still fires.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// R3 slug-rename mid-import regression — pins the IMPORTANT fix.
//
// Pre-R3 the closure captured `project_slug` by value at composer-build
// time. If an owner renamed their url_slug mid-import (no-restart
// rename flow, MembershipStore.renameOwnerSlug) AND a Pass-2 fallback
// fired AFTER the rename, the telemetry row would land under the STALE
// slug. Because `OnboardingTelemetry.resolveAttemptId` mints-on-miss
// keyed off `project_slug`, the stale-slug emit could spawn a fresh
// `onboarding_state` row → split attempt bucket → corrupted state.
//
// R3 fix: the closure resolves the slug at EMIT time via a resolver
// (mirroring the budget-warning callback's `importUrlSlugResolver`).
// This test simulates the rename by flipping a captured `currentSlug`
// variable between the arming of the fallback and its firing, and
// asserts the emitted event carries the NEW slug, not the stale one.
// ---------------------------------------------------------------------------

test('R3 (Argus IMPORTANT): slug rename mid-import — fallback emit lands under the NEW slug, not the stale one', async () => {
  const telemetry = buildProductionOnboardingTelemetry({ db })

  // Live-mutable slug. Starts as 'mira-old' at composer-build time;
  // flips to 'mira-new' after the substrate stub's first turn (Opus
  // 429), simulating a MembershipStore.renameOwnerSlug call landing
  // between fallback-armed (Opus error) and fallback-fired (Sonnet
  // success → telemetry emit).
  let currentSlug = 'mira-old'
  const USER_ID = 'u-test-rename'

  const importOnSonnetFallback = buildPass2SonnetFallbackTelemetryHook({
    telemetry,
    project_slug_resolver: () => currentSlug,
    user_id: USER_ID,
  })

  // Substrate stub: the first turn (Opus 429) flips the slug as a
  // side-effect, mimicking a rename that lands between the Opus
  // failure and the Sonnet retry. The second turn (Sonnet success)
  // triggers the `Pass2SonnetFallbackHook` callback inside the
  // substrate caller, which calls `project_slug_resolver()` at emit
  // time and MUST observe the new slug.
  const calls: SubstrateCall[] = []
  let cursor = 0
  const turns: ReadonlyArray<ScriptedTurn> = [
    pass2ErrorTurn('pass2 substrate error: HTTP 429: rate_limit_error (opus exhausted)'),
    pass2JsonTurn(PASS2_JSON_BODY),
  ]
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      const turn = turns[cursor]
      if (turn === undefined) {
        throw new Error(
          `substrate stub exhausted: caller dispatched ${cursor + 1} turns but only ${turns.length} scripted`,
        )
      }
      cursor += 1
      calls.push({ spec })
      // FLIP THE SLUG mid-import. After the first turn (Opus 429)
      // streams, before the second turn (Sonnet) is dispatched,
      // simulate the slug-rename landing.
      if (cursor === 1) {
        currentSlug = 'mira-new'
      }
      const it = (async function* () {
        for (const ev of turn.events) yield ev
      })()
      return {
        events: it,
        respondToTool: () => Promise.reject(new Error('internal')),
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  }

  const pieces = buildOnboardingEnginePieces({
    db,
    // Pass the boot-time slug. The composer's *other* callers may
    // still use this stale-at-rename value; the resolver above is
    // the one that matters for the fallback emit.
    project_slug: 'mira-old',
    owner_home: join(workdir, 'owner-home-rename'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-mira-rename',
    slugHistoryStore: NOOP_SHIM_STORE,
    importSubstrate: substrate,
    importPass1Llm: pass1Ok,
    importOnSonnetFallback,
    importParse: async function* () {
      yield {
        conversation_id: 'c1',
        title: 'test rename conversation',
        messages: [
          { role: 'user', text: 'hello there' },
          { role: 'assistant', text: 'hi' },
        ],
      }
    },
  })

  const runnerHook = pieces.importJobRunner!
  const { job_id } = await runnerHook.start({ project_slug: 'mira-old', user_id: 'test-user', source: 'chatgpt-zip',
    payload: Buffer.from('placeholder'),
  })
  const deadline = Date.now() + 5_000
  let job: { status: string } | null = null
  while (Date.now() < deadline) {
    job = await runnerHook.status(job_id)
    if (job !== null && (job.status === 'completed' || job.status === 'failed')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(job?.status).toBe('completed')

  // Both substrate dispatches fired (Opus → 429, Sonnet → success).
  expect(calls.length).toBe(2)
  expect(calls[0]!.spec.model_preference[0]).toBe(BEST_MODEL)
  expect(calls[1]!.spec.model_preference[0]).toBe(SONNET_MODEL)

  // THE KEY ASSERTION: the emitted event landed under 'mira-new',
  // NOT 'mira-old'. Pre-R3 the captured-by-value closure would have
  // emitted under 'mira-old' here, and a stale-slug attempt-id
  // mint-on-miss would have split the bucket.
  const newSlugEvents = telemetry
    .list('mira-new')
    .filter((e) => e.event === 'onboarding.pass2_sonnet_fallback_used')
  expect(newSlugEvents.length).toBe(1)
  expect(newSlugEvents[0]!.project_slug).toBe('mira-new')
  expect(newSlugEvents[0]!.user_id).toBe(USER_ID)

  // And conversely: ZERO rows landed under the stale slug.
  const staleSlugEvents = telemetry
    .list('mira-old')
    .filter((e) => e.event === 'onboarding.pass2_sonnet_fallback_used')
  expect(staleSlugEvents.length).toBe(0)
})

test('S22 negative: WITHOUT importOnSonnetFallback wired, gateway_events row is NOT emitted (pre-S22 baseline)', async () => {
  const telemetry = buildProductionOnboardingTelemetry({ db })
  const { substrate } = makeSubstrateStub([
    pass2ErrorTurn('pass2 substrate error: HTTP 429: rate_limit_error'),
    pass2JsonTurn(PASS2_JSON_BODY),
  ])
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: 'mira-control',
    owner_home: join(workdir, 'owner-home-control'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-mira-0002',
    slugHistoryStore: NOOP_SHIM_STORE,
    importSubstrate: substrate,
    importPass1Llm: pass1Ok,
    // NO importOnSonnetFallback — this is the pre-S22 shape.
    importParse: async function* () {
      yield {
        conversation_id: 'c1',
        title: 'test',
        messages: [
          { role: 'user', text: 'hi' },
          { role: 'assistant', text: 'yo' },
        ],
      }
    },
  })
  const runnerHook = pieces.importJobRunner!
  const { job_id } = await runnerHook.start({ project_slug: 'mira-control', user_id: 'test-user', source: 'chatgpt-zip',
    payload: Buffer.from('placeholder'),
  })
  const deadline = Date.now() + 5_000
  let job: { status: string } | null = null
  while (Date.now() < deadline) {
    job = await runnerHook.status(job_id)
    if (job !== null && (job.status === 'completed' || job.status === 'failed')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(job?.status).toBe('completed')
  // The fallback still fired (synthesis came back via Sonnet) but no
  // telemetry row landed because the callback was unwired.
  const events = telemetry.list('mira-control')
  const fallbackEvents = events.filter(
    (e) => e.event === 'onboarding.pass2_sonnet_fallback_used',
  )
  expect(fallbackEvents.length).toBe(0)
})
