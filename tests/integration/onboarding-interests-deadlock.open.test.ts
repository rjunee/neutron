/**
 * Onboarding must never deadlock on a required field the step guard cannot ask
 * for — the LIVE seam, end to end.
 *
 * THE BUG (live, Ryan's fresh install, 2026-07-18). His real row in
 * ~/neutron/data/project.db: `phase='work_interview_gap_fill'`,
 * `completed_at=NULL`, `persona_files_committed=0`, and a `phase_state` holding
 * `user_first_name=Ryan`, a settled import (`import_job_id`), 6
 * `primary_projects` and `agent_personality='Yoda'` — but NO
 * `non_work_interests` (his import analysed to `topics:[]`, so nothing
 * backfilled it).
 *
 * `auditRequiredFields` correctly refused to finalize on `non_work_interests`
 * (post-turn-extractor.ts finalize gate). But `buildOnboardingStepGuardFragment`
 * inspected only TWO hardcoded fields — `import_decision` and
 * `agent_personality` — and with both settled it returned NULL. So the live
 * agent received no forcing instruction for the one field still blocking it,
 * concluded onboarding was over, and went silent. Onboarding hung forever:
 * the audit REQUIRED a field the guard could never ASK for.
 *
 * THE ROOT DEFECT is not the missing field — it is that the guard's coverage set
 * was a hardcoded SUBSET of the audit's required set, so required field #6 would
 * have silently reintroduced the same deadlock. The fix makes the guard
 * AUDIT-DRIVEN: it walks `auditRequiredFields(...).missing` and renders one copy
 * block per missing field from a `Record<RequiredField, StepGuardCopy>` — total
 * coverage by construction, enforced at COMPILE TIME (a new union member without
 * copy is a missing-property type error) and at runtime by the exhaustiveness
 * test in `onboarding/interview/__tests__/onboarding-preamble.test.ts`.
 *
 * WHY THIS TEST BOOTS THE WHOLE STACK: this bug class recurs precisely because
 * tests mock past the real seam. There is no stubbed guard and no stubbed
 * extractor here — a real composer, the real `onboardingContext` closure, the
 * real post-turn extractor, the real finalize gate and the real finalizer. The
 * ONLY fake is the substrate, i.e. the model itself; the extractor's LLM call
 * rides that SAME substrate (it is a substrate-backed Anthropic client, see
 * post-turn-extractor.ts "Billing constraint"), so scripting the substrate fakes
 * the model and nothing else.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const GUARD_MARKER = '<onboarding_required_steps>'
const INTERESTS_STEP_MARKER = 'STILL OPEN - INTERESTS'
const IMPORT_STEP_MARKER = 'STILL OPEN - HISTORY IMPORT'
const PERSONALITY_STEP_MARKER = 'STILL OPEN - PERSONALITY'

/** A line unique to the post-turn extractor's prompt (post-turn-extractor.ts). */
const EXTRACTOR_MARKER = 'Output ONE JSON object on a single line'

/**
 * Ryan's EXACT stuck phase_state, verbatim from the live row. `import_job_id` is
 * what settles `import_decision` (an import that ACTUALLY ran IS the decision —
 * required-fields-audit.ts `isFilled`), which is exactly why BOTH hardcoded
 * guard checks were satisfied while the audit still required a fifth field.
 */
const RYAN_STUCK_PHASE_STATE: Record<string, unknown> = {
  user_first_name: 'Ryan',
  signup_via: 'web',
  import_job_id: 'synth-f95edf223877f2f9',
  import_source: 'chatgpt-zip',
  import_consumed_at: 1,
  primary_projects: [
    'Tabs (Tabs Labs LLC)',
    'Pristine Labs (Glow / Flow)',
    'Family & Personal Health',
    'Quintessential Megacorp (QMC) — Holdco & Operations',
    'Spiritual Practice: Buddhism, Shamanism & Magic',
    'Amascence / AmaSense Fragrance',
  ],
  agent_personality: 'Yoda',
  // non_work_interests: ABSENT — the unaskable blocker.
}

/** The owner's free-text answer to the interests ask (no buttons involved). */
const INTERESTS_REPLY = 'Outside work I surf most weekends and I read a lot of sci-fi.'

/** What a real extractor LLM returns for that answer. */
const INTERESTS_EXTRACTION = JSON.stringify({
  non_work_interests: [{ name: 'surfing', cadence_hint: 'weekly' }, { name: 'sci-fi reading' }],
})

let home: IsolatedHome

interface Harness {
  base: string
  db: ProjectDb
  specs: AgentSpec[]
  close(): Promise<void>
}
let harness: Harness | null = null

const promptOf = (spec: AgentSpec): string =>
  typeof spec.prompt === 'string' ? spec.prompt : JSON.stringify(spec.prompt ?? '')

/**
 * Stands in for the MODEL only. Answers the extractor call with the interests
 * extraction (as a real model would, given the owner's reply) and every
 * conversational turn with a bland acknowledgement.
 */
function scriptedSubstrate(specs: AgentSpec[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const prompt = promptOf(spec)
      const text =
        prompt.includes(EXTRACTOR_MARKER) && prompt.includes('surf')
          ? INTERESTS_EXTRACTION
          : prompt.includes(EXTRACTOR_MARKER)
            ? '{}'
            : 'ok'
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

beforeEach(() => {
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NOTIFY_SOCKET',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      // Makes the LLM pool non-null → the import substrate exists → the import IS
      // offered on this box, which is what put `import_decision` in scope for
      // Ryan's row in the first place.
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-interests-deadlock',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
    },
  })
})

afterEach(async () => {
  if (harness !== null) {
    await harness.close()
    harness = null
  }
  home.restore()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(50)
  }
}

async function startHarness(phase_state: Record<string, unknown>): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())

  const seedStore = new SqliteOnboardingStateStore({ db })
  await seedStore.upsert({
    owner_slug: 'owner',
    user_id: 'owner',
    phase: 'work_interview_gap_fill',
    phase_state_patch: phase_state,
  })

  const specs: AgentSpec[] = []
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => scriptedSubstrate(specs)) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) throw new Error('no fetch/ws')
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => graph.fetch!(req, srv),
    websocket: graph.websocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    db,
    specs,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* teardown only */
        }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

interface Sock {
  ws: WebSocket
  frames: Array<Record<string, unknown>>
}
async function openSocket(base: string): Promise<Sock> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/app/chat?token=dev:owner&platform=web`)
  const frames: Array<Record<string, unknown>> = []
  ws.onmessage = (e) => {
    try {
      frames.push(JSON.parse(String(e.data)))
    } catch {
      /* non-JSON frame */
    }
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
  })
  await waitFor(() => frames.some((f) => f['type'] === 'session_ready'))
  return { ws, frames }
}

function send(sock: Sock, body: string, id: string): void {
  sock.ws.send(JSON.stringify({ v: 1, type: 'user_message', body, client_msg_id: id }))
}

function row(db: ProjectDb): { phase: string; completed_at: number | null } | null {
  return (
    (db
      .raw()
      .query(
        "SELECT phase, completed_at FROM onboarding_state WHERE project_slug = 'owner' AND user_id = 'owner'",
      )
      .get() as { phase: string; completed_at: number | null } | null) ?? null
  )
}

function phaseState(db: ProjectDb): Record<string, unknown> {
  const r = db
    .raw()
    .query(
      "SELECT phase_state_json FROM onboarding_state WHERE project_slug = 'owner' AND user_id = 'owner'",
    )
    .get() as { phase_state_json: string } | null
  return r === null ? {} : (JSON.parse(r.phase_state_json) as Record<string, unknown>)
}

const promptsContaining = (specs: AgentSpec[], needle: string, from = 0): AgentSpec[] =>
  specs.slice(from).filter((s) => promptOf(s).includes(needle))

describe('Open onboarding — the interests deadlock (audit-driven step guard)', () => {
  test('REGRESSION: from Ryan\'s stuck state the guard forces the INTERESTS ask (pre-fix: no guard at all)', async () => {
    harness = await startHarness({ ...RYAN_STUCK_PHASE_STATE })
    const sock = await openSocket(harness.base)

    // A turn the agent would have treated as "we're done" — every step the OLD
    // guard knew about is settled.
    send(sock, 'sounds good', 'c-1')
    await waitFor(() => harness!.specs.length > 0)
    await sleep(300)

    // The guard rode this turn's prompt through the composer's REAL
    // `onboardingContext` closure. PRE-FIX this was null and no
    // `<onboarding_required_steps>` block existed on any prompt.
    const guarded = promptsContaining(harness.specs, GUARD_MARKER)
    expect(guarded.length).toBeGreaterThan(0)
    const prompt = promptOf(guarded[0]!)

    // It names the one field actually blocking finalize…
    expect(prompt).toContain(INTERESTS_STEP_MARKER)
    expect(prompt).toContain('OUTSIDE of work')
    expect(prompt).toContain('CANNOT finish without it')
    expect(prompt).toContain('You may not wrap up / finalize')
    // …as a FREE-TEXT ask, explicitly without a button block.
    expect(prompt).toContain('Do NOT attach an [[OPTIONS]] block')

    // …and does NOT re-ask the steps that are already settled.
    expect(prompt).not.toContain(IMPORT_STEP_MARKER)
    expect(prompt).not.toContain(PERSONALITY_STEP_MARKER)

    // The deadlock's other half is intact: finalize still (correctly) refuses
    // while the field is missing — nothing was loosened to make this pass.
    expect(row(harness.db)?.phase).toBe('work_interview_gap_fill')
    expect(row(harness.db)?.completed_at).toBeNull()

    sock.ws.close()
    await sleep(50)
  }, 45_000)

  test('END-TO-END: a free-text interests reply captures the field and onboarding REACHES finalize', async () => {
    harness = await startHarness({ ...RYAN_STUCK_PHASE_STATE })
    const sock = await openSocket(harness.base)

    // Precondition — genuinely stuck: no interests, not completed.
    expect(phaseState(harness.db)['non_work_interests']).toBeUndefined()
    expect(row(harness.db)?.completed_at).toBeNull()

    // A turn where the agent believes it is finished. The owner is modelled
    // FAITHFULLY: they only answer a question they were actually ASKED. So the
    // interests reply below is gated on the guard genuinely demanding the step
    // on a composed prompt — the deadlock is precisely that it never does.
    // PRE-FIX this wait times out: the agent goes silent, the owner has nothing
    // to answer, and onboarding hangs at work_interview_gap_fill forever.
    send(sock, 'sounds good', 'c-1')
    await waitFor(() => promptsContaining(harness!.specs, INTERESTS_STEP_MARKER).length > 0, 20_000)

    // Only now — having actually been asked — does the owner answer, in prose.
    send(sock, INTERESTS_REPLY, 'c-2')

    // The REAL outcome, not the audit's return value: the field lands durably…
    await waitFor(() => phaseState(harness!.db)['non_work_interests'] !== undefined, 25_000)
    const interests = phaseState(harness.db)['non_work_interests'] as unknown[]
    expect(Array.isArray(interests)).toBe(true)
    expect(interests.length).toBeGreaterThanOrEqual(1)

    // …and onboarding actually FINALIZES — the thing that could never happen
    // before, because the field could never be asked for.
    await waitFor(() => row(harness!.db)?.phase === 'completed', 25_000)
    const finalRow = row(harness.db)
    expect(finalRow?.phase).toBe('completed')
    expect(finalRow?.completed_at).not.toBeNull()

    sock.ws.close()
    await sleep(50)
  }, 60_000)

  test('the guard falls silent exactly when finalize fires (no residual forcing after completion)', async () => {
    // The invariant the deadlock violated, asserted at the live seam: a guard
    // that still demands a step MUST mean finalize is blocked, and vice versa.
    harness = await startHarness({
      ...RYAN_STUCK_PHASE_STATE,
      non_work_interests: ['surfing'],
    })
    const sock = await openSocket(harness.base)

    // Every required field present → the row finalizes…
    await waitFor(() => row(harness!.db)?.phase === 'completed', 25_000)
    expect(row(harness.db)?.completed_at).not.toBeNull()

    // …and no prompt ever carried a forcing block.
    expect(promptsContaining(harness.specs, GUARD_MARKER)).toHaveLength(0)

    sock.ws.close()
    await sleep(50)
  }, 45_000)
})
