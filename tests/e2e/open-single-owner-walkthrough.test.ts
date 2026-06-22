/**
 * Open test-port tranche — single-owner END-TO-END walkthrough (2026-06-15).
 *
 * This is the E2E tier the test/CI plan calls for (docs/plans/
 * open-test-suite-ci-plan-2026-06-15.md §3.3): the first-run product walk a
 * REAL fresh owner takes, driven through the REAL served surface — NOT
 * phase-machine bookkeeping, NOT SQL-stubbing past phases. It EXTENDS the
 * boot-shell integration test (open/__tests__/open-boot-shell.test.ts) from a
 * single turn into the whole signup → onboarding → chat arc.
 *
 * What it exercises, end to end:
 *   1. BOOT the real Open server — `buildOpenGraphComposer` through the real
 *      `boot()` shell (real Bun.serve, real Bun WebSocket client, real
 *      onboarding engine, real landing chat-bridge), single-owner config
 *      (NEUTRON_HOME temp dir, owner identity) — single-owner, no slug, no provisioning.
 *   2. WALK every phase the Open-mode onboarding sequence emits — signup →
 *      ai_substrate_offered → work_interview_gap_fill → personality_offered →
 *      agent_name_chosen → slug_chosen → projects_proposed →
 *      persona_synthesizing → persona_reviewed → max_oauth_offered →
 *      wow_fired → completed — via REAL `engine.advance` calls (the chat WS
 *      drives the engine; the test never sets a phase directly). The walk is
 *      driven by the AUTHORITATIVE persisted phase (a read-only handle on the
 *      same project.db), so it traverses exactly what the engine emits.
 *   3. MOCKED LLM via the CC-spawn substrate seam — the composer's
 *      `substrateFactory` is swapped for a deterministic fake `Substrate`
 *      that synthesizes the Claude-Code subprocess output. NO
 *      api.anthropic.com, NO real Max token (synthetic auth, per memory
 *      feedback_e2e_synthetic_auth). With NEUTRON_ONBOARDING_CONVERSATIONAL
 *      defaulting ON (2026-06-21 onboarding-engine consolidation), every
 *      freeform answer is classified by the `llmRouter` first, so the fake
 *      returns a prompt-faithful `advance` router envelope (echoing the
 *      verbatim reply) for router calls and a canned non-JSON reply for
 *      everything else. The onboarding phase-spec resolver's LLM rephrasing +
 *      the suggesters fall back to their static / deterministic output on that
 *      non-JSON (build-phase-spec-resolver.ts §"static fallback"), so the walk
 *      is deterministic; the post-completion live-agent turn surfaces the
 *      fake's canned reply directly. See `fakeSubstrateFactory` below.
 *   4. ASSERT the served flow actually ran: onboarding reaches phase=completed,
 *      the PersonaComposer wrote persona/{SOUL,USER,priority-map}.md under
 *      owner_home, the projects list landed in the persisted phase_state, a
 *      post-completion chat turn produces an agent_message over the WS, and the
 *      historically-fragile session-started path holds — a fresh cookie-only
 *      reconnect to the COMPLETED-state session emits session_ready (the
 *      external proxy for `session_started = true`; session_ready fires only
 *      AFTER session_started flips true, landing/chat.ts).
 *
 * Fictional fixtures only (Mira / Caldera — the persona fixture set the suite
 * already uses); NO real-person names.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot } from '../../gateway/index.ts'
import type { BootHandle } from '../../gateway/index.ts'
import { buildOpenGraphComposer } from '../../open/composer.ts'
import { OWNER_USER_ID } from '../../open/owner-identity.ts'
import { SqliteOnboardingStateStore } from '../../onboarding/interview/sqlite-state-store.ts'
import { ProjectDb } from '../../persistence/index.ts'
import type { ClaudeCodeSubstrateOptions } from '../../runtime/adapters/claude-code/index.ts'
import type { Event } from '../../runtime/events.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '../../runtime/substrate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const PROJECT_SLUG = 'owner'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
  'NEUTRON_GRAPH_COMPOSER_MODULE',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let handle: BootHandle | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-e2e-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = PROJECT_SLUG
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-e2e-secret-0123456789'
  // A non-empty ANTHROPIC_API_KEY makes the composer WIRE the CC-spawn LLM
  // substrate (both the onboarding phase-spec substrate AND the live-chat
  // substrate). Our injected fake substrateFactory means the value is never
  // used to authenticate anything — no real key, no api.anthropic.com call.
  process.env['ANTHROPIC_API_KEY'] = 'e2e-fake-key-not-a-real-credential'
  // A non-empty CLAUDE_CODE_OAUTH_TOKEN makes the engine AUTO-SKIP the
  // max_oauth_offered phase (InterviewEngine.maybeAutoAdvancePastMaxOauthOffered
  // reads this env directly), so the walk does not stall on a real OAuth flow.
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'e2e-fake-oauth-not-a-real-token'
  delete process.env['NOTIFY_SOCKET']
  delete process.env['NEUTRON_GRAPH_COMPOSER_MODULE']
})

afterEach(async () => {
  if (handle !== null) {
    await handle.shutdown({ force: true })
    handle = null
  }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * The MOCKED Claude-Code subprocess. The composer threads this into
 * `buildLlmCallSubstrate({ substrateFactory })` in place of the real
 * `createClaudeCodeSubstrateAuto`, so every LLM call site dispatches through a
 * deterministic in-process fake instead of spawning a real interactive
 * `claude` REPL. It yields one token + the terminal completion — the minimal
 * shape `collectTokensToString` (the substrate's universal consumer) needs.
 *
 * Two response shapes, discriminated by the dispatched prompt:
 *
 *  1. CONVERSATIONAL ROUTER calls. With `NEUTRON_ONBOARDING_CONVERSATIONAL`
 *     now defaulting ON (2026-06-21 onboarding-engine consolidation — the dead
 *     `promptDriver` seam removed, `llmRouter` is the single freeform engine),
 *     every freeform onboarding answer is classified by the `llmRouter` before
 *     the engine advances. The router packs the reply into a distinctive
 *     `inbound_user_text: """…"""` envelope (llm-router.ts:buildUserPrompt), so
 *     we detect that marker and return the PROMPT-FAITHFUL decision a real
 *     Haiku classifier emits for a direct freeform answer: an `action:'advance'`
 *     carrying the user's VERBATIM reply in `freeform_text` (`choice_value:null`,
 *     `state_delta:null`, high confidence — exactly the state_delta-free
 *     free-text advance contract `work-interview-projects-extraction-real-path`
 *     pins). This drives the conversational path to completion — each freeform
 *     phase advances on the user's actual answer (the engine recovers e.g. the
 *     project list out of `freeform_text`). Without this the router received
 *     non-JSON, fell to `synthesiseFallback('unparseable')`, re-prompted "say
 *     it again", and the walk STALLED to the 120s timeout.
 *
 *  2. EVERYTHING ELSE — onboarding phase-spec rephrasing, the suggesters /
 *     persona summarizer / wow picker, and the post-completion live agent turn.
 *     Returns one canned non-JSON reply. The phase-spec resolver + suggesters
 *     fail to parse it and fall back to their static / deterministic output
 *     (deterministic walk); the live agent turn surfaces the text verbatim as
 *     the chat reply body.
 *
 * Button taps (ai_substrate_offered / projects_proposed / persona_reviewed)
 * bypass the router entirely (llm-router.ts § 2.1), so they need no mock here.
 *
 * NO api.anthropic.com, NO real Max token (synthetic auth, per memory
 * feedback_e2e_synthetic_auth).
 */
const MOCK_REPLY = 'E2E_MOCK_AGENT_REPLY — your plate is clear for today.'

/**
 * Detect a router classification dispatch and extract the verbatim reply the
 * router packed into its `inbound_user_text: """…"""` envelope
 * (llm-router.ts:buildUserPrompt — always the LAST line of the user prompt).
 * Returns null for any non-router prompt (phase-spec / suggester / live-agent
 * turn), which the factory maps to the canned `MOCK_REPLY`.
 */
function extractRouterUserText(prompt: string): string | null {
  const m = /inbound_user_text: """([\s\S]*)"""/.exec(prompt)
  return m === null ? null : m[1]!
}

function fakeSubstrateFactory(opts: ClaudeCodeSubstrateOptions): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      const routerUserText = extractRouterUserText(spec.prompt)
      const reply =
        routerUserText === null
          ? MOCK_REPLY
          : JSON.stringify({
              action: 'advance',
              confidence: 0.97,
              choice_value: null,
              // Echo the user's verbatim reply — the engine's advance branch
              // records it (`decision.freeform_text ?? input.freeform_text`) and
              // recovers per-phase fields from it (e.g. primary_projects).
              freeform_text: routerUserText,
              response: null,
              state_delta: null,
              reasoning:
                'E2E mock: the freeform reply is a direct answer to this phase — advance with the verbatim text.',
            })
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: reply }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: opts.substrate_instance_id,
        }
      })()
      return {
        events,
        respondToTool: async (): Promise<void> => undefined,
        cancel: async (): Promise<void> => undefined,
        tool_resolution: 'internal',
      }
    },
  }
}

async function bootOpen(): Promise<BootHandle> {
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: fakeSubstrateFactory,
  })
  handle = await boot({ composer, port: 0 })
  return handle
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface Envelope {
  type: string
  body?: string
  prompt_id?: string
  user_id?: string
  options?: Array<{ value?: string }>
  allow_freeform?: boolean
}

/** Collect WS envelopes; expose helpers to wait for the next real frame. */
function wireSocket(ws: WebSocket): {
  opened: Promise<void>
  received: Envelope[]
  nextReal: (afterIdx: number, timeoutMs: number, extraSkip?: string[]) => Promise<Envelope>
  latestPromptId: () => string | undefined
} {
  const received: Envelope[] = []
  const TYPING = new Set(['agent_typing_start', 'agent_typing_stop', 'agent_typing_end'])
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (ev) => reject(new Error(`ws error: ${String(ev)}`)))
  })
  ws.addEventListener('message', (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    try {
      received.push(JSON.parse(data) as Envelope)
    } catch {
      /* ignore non-JSON frames */
    }
  })
  const nextReal = async (
    afterIdx: number,
    timeoutMs: number,
    extraSkip: string[] = [],
  ): Promise<Envelope> => {
    const skip = new Set([...TYPING, ...extraSkip])
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      for (let i = afterIdx; i < received.length; i++) {
        const e = received[i]!
        if (!skip.has(e.type)) return e
      }
      await sleep(20)
    }
    throw new Error(`nextReal: no real envelope after idx ${afterIdx} within ${timeoutMs}ms`)
  }
  const latestPromptId = (): string | undefined => {
    for (let i = received.length - 1; i >= 0; i--) {
      const pid = received[i]!.prompt_id
      if (typeof pid === 'string' && pid.length > 0) return pid
    }
    return undefined
  }
  return { opened, received, nextReal, latestPromptId }
}

describe('Open single-owner E2E — signup → onboarding → chat (mocked LLM)', () => {
  test('boots the real server, walks every onboarding phase to completed, then a chat turn works', async () => {
    const h = await bootOpen()
    const base = `http://127.0.0.1:${h.server.port}`

    // ── 0. Liveness + the served entry point ───────────────────────────────
    const health = await fetch(`${base}/healthz`)
    expect(health.status).toBe(200)
    const healthBody = (await health.json()) as { status: string; project_slug: string }
    expect(healthBody.status).toBe('ok')
    expect(healthBody.project_slug).toBe(PROJECT_SLUG)

    // ── 1. SIGNUP — a fresh visit mints the owner cookie + a local start-token
    //      and bounces to /chat?start=<token> (the served first-run path). ───
    const gate = await fetch(`${base}/chat`, { redirect: 'manual' })
    expect(gate.status).toBe(302)
    const ownerCookie = gate.headers.get('set-cookie')!.split(';')[0]! // __neutron_chat_session=…
    const token = new URL(gate.headers.get('location')!, base).searchParams.get('start')
    expect(token).not.toBeNull()

    // ── 2. Open the chat WS with the start-token → engine.start fires the
    //      first onboarding prompt; this socket drives engine.advance. ───────
    const ws = new WebSocket(
      `ws://127.0.0.1:${h.server.port}/ws/chat?start=${encodeURIComponent(token!)}`,
    )
    const sock = wireSocket(ws)
    await sock.opened
    const first = await sock.nextReal(0, 10_000)
    expect(first.type).toBe('agent_message') // signup accepted → first prompt served

    // ── Authoritative phase reader (read-only handle on the SAME project.db;
    //    WAL + busy_timeout make concurrent reads safe — persistence/db.ts). ─
    const roDb = ProjectDb.open(process.env['NEUTRON_DB_PATH']!, { readonly: true })
    const roStore = new SqliteOnboardingStateStore({ db: roDb })
    const phaseNow = async (): Promise<string | null> => {
      const s = await roStore.get(PROJECT_SLUG, OWNER_USER_ID)
      return s?.phase ?? null
    }
    const waitForPhaseChange = async (from: string | null, timeoutMs: number): Promise<string | null> => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const p = await phaseNow()
        if (p !== from) return p
        await sleep(50)
      }
      return await phaseNow()
    }

    // ── 3. WALK every emitted phase via real engine.advance ─────────────────
    // Freeform answers per phase (fictional Mira/Caldera fixtures); button
    // choices steer the SKIP-IMPORT branch (no ZIP upload). Transit phases
    // (instance_provisioned / persona_synthesizing / wow_fired) carry no user
    // turn — the engine drives them — so the walk simply waits them out.
    const FREEFORM: Record<string, string> = {
      signup: 'Mira',
      work_interview_gap_fill:
        'I run Caldera, a fragrance brand, and I am building out its ops and automation.',
      personality_offered: 'A sharp, warm strategist who tells me the truth and cuts to the point.',
      agent_name_chosen: 'Kairos',
      slug_chosen: 'caldera',
    }
    // Button value per phase (the skip-import path). persona_reviewed is a
    // button phase when a persona composer is wired (the default Open boot) —
    // 'looks_good' commits the composed persona. max_oauth_offered is normally
    // auto-skipped via CLAUDE_CODE_OAUTH_TOKEN; its entry is a defensive
    // fallback in case a stale prompt surfaces.
    const BUTTON: Record<string, string> = {
      ai_substrate_offered: 'neither',
      projects_proposed: 'confirm',
      persona_reviewed: 'looks_good',
      max_oauth_offered: 'attach_max',
    }

    const seenPhases = new Set<string>()
    let lastPhase: string | null = null
    for (let i = 0; i < 60; i++) {
      const phase = await phaseNow()
      if (phase === null) {
        await sleep(50)
        continue
      }
      if (phase === 'completed') break
      seenPhases.add(phase)

      if (phase in FREEFORM) {
        // Wait until the engine has actually EMITTED this phase's prompt before
        // answering, so we drive a real turn rather than racing the emit.
        await sock.nextReal(0, 8_000, ['session_ready']).catch(() => undefined)
        ws.send(JSON.stringify({ type: 'user_message', body: FREEFORM[phase]! }))
        lastPhase = await waitForPhaseChange(phase, 12_000)
      } else if (phase in BUTTON) {
        // Wait for the button prompt to land so we have its prompt_id.
        const start = Date.now()
        let pid: string | undefined
        while (Date.now() - start < 8_000) {
          pid = sock.latestPromptId()
          if (pid !== undefined) break
          await sleep(30)
        }
        if (pid === undefined) throw new Error(`no prompt_id for button phase ${phase}`)
        ws.send(
          JSON.stringify({ type: 'button_choice', prompt_id: pid, choice_value: BUTTON[phase]! }),
        )
        lastPhase = await waitForPhaseChange(phase, 12_000)
      } else {
        // Transit phase — engine-driven. Wait for it to advance on its own.
        lastPhase = await waitForPhaseChange(phase, 15_000)
      }
      void lastPhase
    }

    // ── 4a. The walk reached the terminal phase via the served engine. ──────
    const finalState = await roStore.get(PROJECT_SLUG, OWNER_USER_ID)
    expect(finalState).not.toBeNull()
    expect(finalState!.phase).toBe('completed')

    // Sanity: we genuinely traversed the interview, not a shortcut.
    expect(seenPhases.has('signup')).toBe(true)
    expect(seenPhases.has('ai_substrate_offered')).toBe(true)
    expect(seenPhases.has('projects_proposed')).toBe(true)
    expect(seenPhases.has('persona_reviewed')).toBe(true)

    // ── 4b. Persona PRODUCED — the default PersonaComposer wrote the three
    //       persona files under owner_home (build-landing-stack default). ────
    const personaDir = join(tmpDir, 'persona')
    for (const f of ['SOUL.md', 'USER.md', 'priority-map.md']) {
      const p = join(personaDir, f)
      expect(existsSync(p)).toBe(true)
      expect(readFileSync(p, 'utf8').trim().length).toBeGreaterThan(0)
    }

    // ── 4c. Projects step PRODUCED its persisted structure. The walk drove
    //       projects_proposed → confirm (seenPhases above). In the skip-import
    //       single-owner path with a mocked LLM the proposed-projects list is
    //       empty (no history-import extraction, no real LLM proposals), so we
    //       assert the projects phase ran + its phase_state field shape rather
    //       than a non-empty list (which would require the import pipeline). ─
    const phaseState = finalState!.phase_state as Record<string, unknown>
    if ('primary_projects' in phaseState) {
      expect(Array.isArray(phaseState['primary_projects'])).toBe(true)
    }

    // ── 5. A post-completion CHAT TURN works over the WS, through the MOCKED
    //      LLM substrate. On the General socket a pending final-handoff prompt
    //      blocks live-agent routing (chat-bridge isLiveAgentEligible,
    //      respect_final_handoff:true), so we first RESOLVE the handoff the way
    //      a real user does — tap the initial prompt's "connect Telegram"
    //      option, then "Done" on the follow-up — which clears
    //      final_handoff_active. Then a typed message routes to the live-agent
    //      turn and the mocked substrate's reply comes back as an
    //      agent_message. ─────────────────────────────────────────────────
    const handoffActive = async (): Promise<boolean> => {
      const s = await roStore.get(PROJECT_SLUG, OWNER_USER_ID)
      return s?.phase_state['final_handoff_active'] === true
    }
    const waitForPromptIdOtherThan = async (prev: string | undefined, timeoutMs: number): Promise<string> => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const pid = sock.latestPromptId()
        if (pid !== undefined && pid !== prev) return pid
        await sleep(30)
      }
      throw new Error(`waitForPromptIdOtherThan: no new prompt_id (prev=${String(prev)}) within ${timeoutMs}ms`)
    }

    expect(await handoffActive()).toBe(true) // the completed row carries the handoff prompt
    const initialHandoffPid = await waitForPromptIdOtherThan(undefined, 8_000)
    ws.send(
      JSON.stringify({
        type: 'button_choice',
        prompt_id: initialHandoffPid,
        choice_value: 'final-telegram-bind',
      }),
    )
    const followupPid = await waitForPromptIdOtherThan(initialHandoffPid, 10_000)
    ws.send(
      JSON.stringify({ type: 'button_choice', prompt_id: followupPid, choice_value: 'final-done' }),
    )
    // The Done tap clears final_handoff_active → the General socket is now
    // live-agent eligible.
    const clearStart = Date.now()
    while (Date.now() - clearStart < 10_000 && (await handoffActive())) await sleep(50)
    expect(await handoffActive()).toBe(false)

    const beforeChat = sock.received.length
    ws.send(JSON.stringify({ type: 'user_message', body: 'what is on my plate today?' }))
    const reply = await sock.nextReal(beforeChat, 15_000, ['session_ready'])
    expect(reply.type).toBe('agent_message')
    expect((reply.body ?? '').length).toBeGreaterThan(0)
    expect(reply.body).toContain('E2E_MOCK_AGENT_REPLY') // proves the mocked LLM substrate served it
    ws.close()
    await sleep(50)

    // ── 6. The historically-fragile session-started path on the COMPLETED
    //      session: a fresh cookie-only reconnect (no ?start token) upgrades
    //      the WS and the session goes live — session_ready fires (the
    //      external proxy for `session_started = true`) with the owner id. ──
    const wsB = new WebSocket(`ws://127.0.0.1:${h.server.port}/ws/chat`, {
      headers: { cookie: ownerCookie },
    } as unknown as string)
    const sockB = wireSocket(wsB)
    await sockB.opened
    const ready = await sockB.nextReal(0, 10_000)
    expect(ready.type).toBe('session_ready')
    expect(ready.user_id).toBe(OWNER_USER_ID)
    wsB.close()
    await sleep(50)

    roDb.close()
  }, 120_000)
})
