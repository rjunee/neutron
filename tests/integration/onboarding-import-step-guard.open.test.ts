/**
 * The onboarding history-import decision must be DETERMINISTIC, through the real
 * live-agent seam.
 *
 * THE BUG (live, fresh install 2026-07-18): the assistant asked "what should I
 * call you?", the owner replied only "Ryan", and the assistant answered "Got it,
 * we'll skip the import for now…" and moved on. The owner was never offered the
 * import and never chose to skip it. The DB agreed:
 * `onboarding_state.phase='work_interview_gap_fill'`,
 * `phase_state_json={"user_first_name":"Ryan","signup_via":"web"}` — no import
 * decision anywhere. The offer existed only as PROSE in the first-turn preamble
 * with ZERO capture, so the model narrated a decision the owner never made.
 *
 * THE FIX reuses the mechanism built 2026-06-30 for the IDENTICAL prose-only
 * failure on the personality step: `buildOnboardingStepGuardFragment` (re-injected
 * EVERY turn) + `captureButtonBackedRequiredField` (awaited at turn START, so the
 * guard reads FRESH state). `import_decision` becomes an audited required field
 * and the guard is generalized past its single `agent_personality` check.
 *
 * WHY THIS TEST BOOTS THE WHOLE STACK: this bug class has recurred six times
 * precisely because the tests mocked past the real seam. So there is no stubbed
 * seam and no SQL-seeded precondition for the thing under test here — a real
 * composer + real `onboardingContext` / `captureRequiredAnswer` closures + a real
 * ButtonStore + a real app WebSocket. The ONLY fake is the substrate, which is
 * the model itself; every prompt it receives is the genuine composed prompt, and
 * the import step's `[[OPTIONS]]` block travels the real persistence path
 * (stripped from the body, durable in `options_json`) before coming back as the
 * `prior_agent_options` the capture keys on.
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
import { IMPORT_DECISION_OPTIONS } from '@neutronai/onboarding/interview/onboarding-preamble.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** The guard's import block marker, and the personality one it must not disturb. */
const IMPORT_STEP_MARKER = 'STILL OPEN - HISTORY IMPORT'
const PERSONALITY_STEP_MARKER = 'STILL OPEN - PERSONALITY'
const GUARD_MARKER = '<onboarding_required_steps>'

/** The EXACT phase_state from the reported live failure. */
const NAME_ONLY_PHASE_STATE: Record<string, unknown> = {
  user_first_name: 'Ryan',
  signup_via: 'web',
}

/** The import question the agent is supposed to ask, with the guard's options. */
const IMPORT_QUESTION_REPLY = [
  'Nice to meet you, Ryan. Before we go further, do you want to bring over your',
  'existing chat history?',
  '',
  '[[OPTIONS]]',
  ...IMPORT_DECISION_OPTIONS.map((o) => `- ${o.label}`),
  '[[/OPTIONS]]',
].join('\n')

/**
 * Reply as a compliant agent would: when the guard is actually demanding the
 * import step, ask it with the `[[OPTIONS]]` block; otherwise acknowledge. Keyed
 * off the guard marker in the COMPOSED prompt rather than a call-ordering queue,
 * so unrelated substrate traffic (extractor, warm-pool) can never steal the
 * scripted turn.
 */
const askImportWhenGuardDemandsIt = (spec: AgentSpec): string =>
  typeof spec.prompt === 'string' && spec.prompt.includes(IMPORT_STEP_MARKER)
    ? IMPORT_QUESTION_REPLY
    : 'ok'

let home: IsolatedHome

interface Harness {
  base: string
  db: ProjectDb
  /** Every AgentSpec the composer handed the substrate, in order. */
  specs: AgentSpec[]
  close(): Promise<void>
}
let harness: Harness | null = null

/**
 * Records every composed prompt and answers it with `replyFor(spec)`. This stands
 * in for the MODEL only — every other layer under test is real.
 */
function scriptedSubstrate(specs: AgentSpec[], replyFor: (spec: AgentSpec) => string): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const text = replyFor(spec)
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
      // A synthetic key is what makes the LLM pool non-null, which is what builds
      // the import substrate (→ the import IS offered on this box) and the whole
      // onboarding seam. Without it there is no seam to test.
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-import-step-guard',
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

async function startHarness(
  phase_state: Record<string, unknown>,
  replyFor: (spec: AgentSpec) => string = () => 'ok',
): Promise<Harness> {
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
    substrateFactory: (() => scriptedSubstrate(specs, replyFor)) as any,
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

function phaseState(db: ProjectDb): Record<string, unknown> {
  const row = db
    .raw()
    .query(
      "SELECT phase_state_json FROM onboarding_state WHERE project_slug = 'owner' AND user_id = 'owner'",
    )
    .get() as { phase_state_json: string } | null
  return row === null ? {} : (JSON.parse(row.phase_state_json) as Record<string, unknown>)
}

/** Durable option VALUES persisted for the owner's app topic (`options_json` —
 *  the body has the `[[OPTIONS]]` block stripped, which is exactly why the
 *  capture reads this and not the body). */
function persistedOptionValues(db: ProjectDb): string[] {
  const rows = db
    .raw()
    .query("SELECT options_json FROM button_prompts WHERE topic_id = 'app:owner'")
    .all() as Array<{ options_json: string | null }>
  const out: string[] = []
  for (const r of rows) {
    if (r.options_json === null) continue
    try {
      for (const o of JSON.parse(r.options_json) as Array<{ value?: unknown }>) {
        if (typeof o.value === 'string') out.push(o.value)
      }
    } catch {
      /* malformed row — ignore */
    }
  }
  return out
}

const promptsContaining = (specs: AgentSpec[], needle: string, from = 0): AgentSpec[] =>
  specs.slice(from).filter((s) => typeof s.prompt === 'string' && s.prompt.includes(needle))

describe('Open onboarding — deterministic import step guard (live seam)', () => {
  test('REGRESSION: a name-only turn does NOT produce an assumed import decision — the guard offers the step', async () => {
    // The reported row verbatim: the owner has given their name and NOTHING else.
    harness = await startHarness({ ...NAME_ONLY_PHASE_STATE })
    const sock = await openSocket(harness.base)

    send(sock, 'Ryan', 'c-1')
    await waitFor(() => harness!.specs.length > 0)
    // Let any follow-on (extractor) traffic settle so the assertions below see
    // the whole picture rather than a half-composed turn.
    await sleep(300)

    // The guard rode this turn's prompt, through the composer's REAL
    // `onboardingContext` closure — not a probe, not a stub.
    const guarded = promptsContaining(harness.specs, GUARD_MARKER)
    expect(guarded.length).toBeGreaterThan(0)
    const prompt = guarded[0]!.prompt as string
    expect(prompt).toContain(IMPORT_STEP_MARKER)
    // The three locked choices are named verbatim, so the agent cannot improvise
    // a different menu (and the capture's anchor cannot drift from what is asked).
    for (const o of IMPORT_DECISION_OPTIONS) expect(prompt).toContain(o.label)
    // And it is explicitly forbidden from narrating the skip the live bug produced.
    expect(prompt).toContain('MUST NOT say you are skipping it')

    // Nothing invented a decision on the owner's behalf: the durable row still
    // shows the step as OPEN (pre-fix there was simply nowhere for it to land).
    expect(phaseState(harness.db)['import_decision']).toBeUndefined()

    sock.ws.close()
    await sleep(50)
  }, 45_000)

  test('CAPTURE: a tapped import option is durably persisted and the guard stops asking', async () => {
    harness = await startHarness({ ...NAME_ONLY_PHASE_STATE }, askImportWhenGuardDemandsIt)
    const sock = await openSocket(harness.base)

    // Turn 1: the agent asks the import question and the `[[OPTIONS]]` block goes
    // through the REAL button persistence (body stripped, options durable).
    send(sock, 'Ryan', 'c-1')
    await waitFor(() => persistedOptionValues(harness!.db).includes(IMPORT_DECISION_OPTIONS[1]!.label))

    // Turn 2: the owner TAPS "Import my Claude history" (a tap sends the option
    // text back verbatim, which is what this body is).
    const before = harness.specs.length
    send(sock, IMPORT_DECISION_OPTIONS[1]!.label, 'c-2')
    await waitFor(() => phaseState(harness!.db)['import_decision'] !== undefined)
    await sleep(300)

    // Captured, normalized to the locked vocabulary.
    expect(phaseState(harness.db)['import_decision']).toBe('claude')
    // …and because the capture is awaited at turn START, the guard that composed
    // THIS turn already saw it settled: no prompt from turn 2 onward re-asks.
    expect(promptsContaining(harness.specs, IMPORT_STEP_MARKER, before)).toHaveLength(0)

    sock.ws.close()
    await sleep(50)
  }, 45_000)

  test('CAPTURE: a FREE-TEXT answer counts too (the owner need not tap)', async () => {
    harness = await startHarness({ ...NAME_ONLY_PHASE_STATE }, askImportWhenGuardDemandsIt)
    const sock = await openSocket(harness.base)

    send(sock, 'Ryan', 'c-1')
    await waitFor(() => persistedOptionValues(harness!.db).includes(IMPORT_DECISION_OPTIONS[1]!.label))

    const before = harness.specs.length
    send(sock, 'I have claude history', 'c-2')
    await waitFor(() => phaseState(harness!.db)['import_decision'] !== undefined)
    await sleep(300)

    expect(phaseState(harness.db)['import_decision']).toBe('claude')
    expect(promptsContaining(harness.specs, IMPORT_STEP_MARKER, before)).toHaveLength(0)

    sock.ws.close()
    await sleep(50)
  }, 45_000)

  test('CAPTURE: a free-text "skip" is a REAL answer, recorded as neither', async () => {
    harness = await startHarness({ ...NAME_ONLY_PHASE_STATE }, askImportWhenGuardDemandsIt)
    const sock = await openSocket(harness.base)

    send(sock, 'Ryan', 'c-1')
    await waitFor(() => persistedOptionValues(harness!.db).includes(IMPORT_DECISION_OPTIONS[1]!.label))

    const before = harness.specs.length
    send(sock, 'skip', 'c-2')
    await waitFor(() => phaseState(harness!.db)['import_decision'] !== undefined)
    await sleep(300)

    // The owner genuinely declining is fine — what the guard forbids is the AGENT
    // deciding that for them. Once they say it, it is captured and never re-asked.
    expect(phaseState(harness.db)['import_decision']).toBe('neither')
    expect(promptsContaining(harness.specs, IMPORT_STEP_MARKER, before)).toHaveLength(0)

    sock.ws.close()
    await sleep(50)
  }, 45_000)

  test('NON-REGRESSION: the personality step is still forced, on the same live path', async () => {
    // Import already settled; personality still open → the guard must be alive
    // with exactly its pre-existing personality behavior and no import block.
    harness = await startHarness({
      ...NAME_ONLY_PHASE_STATE,
      import_decision: 'neither',
      primary_projects: ['Acme', 'Infra', 'Site'],
      non_work_interests: ['climbing'],
    })
    const sock = await openSocket(harness.base)

    send(sock, 'that is everything', 'c-1')
    await waitFor(() => harness!.specs.length > 0)
    await sleep(300)

    const guarded = promptsContaining(harness.specs, GUARD_MARKER)
    expect(guarded.length).toBeGreaterThan(0)
    const prompt = guarded[0]!.prompt as string
    expect(prompt).toContain(PERSONALITY_STEP_MARKER)
    expect(prompt).toContain('Sherlock')
    expect(prompt).not.toContain(IMPORT_STEP_MARKER)

    sock.ws.close()
    await sleep(50)
  }, 45_000)
})
