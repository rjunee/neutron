/**
 * Open SCRIBE wiring — the anti-"built-but-not-wired" gate (gap-audit P0-3).
 *
 * THE BUG: the scribe package (`scribe/`) ships the entire chat-time
 * extract→GBrain path, and the chat-bridge fires `scribeOnUserTurn` after every
 * real `user_message` advance — IF the hook is defined. But it was OPTIONAL and
 * the Open self-host composer NEVER threaded it (`build-landing-stack.ts:649`
 * comment: "tests + Open self-host without scribe omit it"). Result: chat-time
 * entity extraction was DEAD in Open — every person/company mention stayed a
 * manual wiki entry. This is exactly the class of bug the 2026-05-13 incident
 * was about (a module built but never invoked in the live boot path), so per
 * CLAUDE.md this test asserts the path ACTUALLY FIRES end-to-end, not that the
 * composer merely boots.
 *
 * The fix: `open/composer.ts` constructs a dedicated `cc-scribe-*` substrate +
 * GBrain memory wiring + `createScribe(...)` and threads
 * `scribeOnUserTurn: (i) => scribe.handleUserTurn(i)` into `buildLandingStack`.
 *
 * This test boots the REAL Open composition (`buildOpenGraphComposer` →
 * `composeProductionGraph`, the same compose `boot()` runs) over a real
 * `Bun.serve`, with a SYNTHETIC LLM credential so the substrates are built and a
 * MOCKED substrate (no real `claude`, no api.anthropic.com) that returns a
 * deterministic extraction for the scribe prompt. It drives a REAL user turn
 * over a live WebSocket and asserts:
 *
 *   1. The scribe extraction was DISPATCHED — the mocked substrate received the
 *      scribe extraction prompt (proves `scribeOnUserTurn` was threaded by the
 *      composer and the chat-bridge fired it on a real `user_message`).
 *   2. A GBrain WRITE landed — the extracted person entity is PERSISTED to the
 *      owner's `entities/people/<slug>.md` page (the entity-writer artifact that
 *      the GBrain `syncHook` fans out from). This is the "entity persisted"
 *      clause of the spec's VERIFY, observed as a real on-disk artifact.
 *
 * GBrain-unavailable degrade: no `gbrain` binary is required for this test — the
 * composer's `buildGBrainMemory` is lazy + fail-soft (one boot warning, then a
 * latched no-op), so the entity page still lands on disk and the chat turn never
 * crashes whether or not `gbrain` is installed on the host.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { buildLocalStartTokenAuth } from '../local-start-token.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { Substrate, AgentSpec } from '../../runtime/substrate.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { Event } from '../../runtime/events.ts'

const COOKIE_SECRET = 'open-scribe-test-secret-0123456789'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

// >= SCRIBE_MIN_CHARS (80) so the cheap pre-filter passes, and names a real
// person + company so the (mocked) extraction has something durable to write.
const LONG_TURN =
  'Had a productive sync with Dana Reeves at Northstar Robotics about the migration roadmap and Q3 budget.'

// The deterministic extraction the mocked substrate returns for the scribe
// prompt — one person entity + a works_at relation to a company.
const EXTRACTION_JSON = JSON.stringify({
  entities: [
    { name: 'Dana Reeves', kind: 'person', fact: 'Leads the migration roadmap at Northstar Robotics.' },
    { name: 'Northstar Robotics', kind: 'company' },
  ],
  relations: [{ subject: 'Dana Reeves', predicate: 'works_at', object: 'Northstar Robotics' }],
})

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
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness {
  server: import('bun').Server<unknown>
  port: number
  db: ProjectDb
  owner_home: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  /** Every prompt dispatched to the mocked substrate, across all substrates. */
  dispatchedPrompts: string[]
  close(): Promise<void>
}

let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-scribe-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = COOKIE_SECRET
  // SYNTHETIC credential → resolveOpenLlmPool returns a pool → the substrates
  // (incl. the new cc-scribe substrate) are built. No real LLM is hit: the
  // injected substrateFactory replaces the CC subprocess entirely.
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-scribe-test'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  if (harness !== null) {
    await harness.close()
    harness = null
  }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * A mocked Substrate factory shared across every `buildLlmCallSubstrate` the
 * composer builds (phase-spec, prewarm, suggesters, live-agent, synthesis, AND
 * scribe). It records every dispatched prompt and replies:
 *   - the scribe extraction prompt → the deterministic EXTRACTION_JSON, so the
 *     extract→write path produces a real entity page.
 *   - anything else (onboarding rephrasing, prewarm, …) → a benign short reply,
 *     so onboarding still advances and the user turn reaches the scribe fire.
 */
function makeRecordingSubstrate(prompts: string[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      const prompt = spec.prompt
      prompts.push(prompt)
      const isScribe = prompt.includes('You are the scribe')
      const body = isScribe ? EXTRACTION_JSON : 'ok'
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: body }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock-scribe',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {
          throw new Error('mock substrate: no tools')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const dispatchedPrompts: string[] = []
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => makeRecordingSubstrate(dispatchedPrompts)) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('Open composition did not expose graph.fetch/websocket')
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  return {
    server,
    port: server.port ?? 0,
    db,
    owner_home: tmpDir,
    graph,
    dispatchedPrompts,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

function mintOwnerStartToken(): string {
  const auth = buildLocalStartTokenAuth(COOKIE_SECRET)
  return auth.mint({ project_slug: 'owner', user_id: 'owner' })
}

/** Open a live WS to the composed Open server as the owner; returns a sender. */
async function openOwnerSocket(port: number): Promise<{ send(body: string): void; close(): void }> {
  const token = mintOwnerStartToken()
  const url = `ws://127.0.0.1:${port}/ws/chat?start=${encodeURIComponent(token)}`
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS did not open in 5s')), 5_000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WS upgrade failed (401 / handshake error)'))
    })
  })
  return {
    send: (body: string) => ws.send(body),
    close: () => {
      try {
        ws.close()
      } catch {
        /* best-effort */
      }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const peopleDir = (): string => join(tmpDir, 'entities', 'people')

/** Poll the owner's entities/people dir until a `.md` page lands (or timeout). */
async function awaitPersonPage(): Promise<string[]> {
  for (let i = 0; i < 60; i++) {
    if (existsSync(peopleDir())) {
      const files = readdirSync(peopleDir()).filter((f) => f.endsWith('.md'))
      if (files.length > 0) return files
    }
    await sleep(100)
  }
  return existsSync(peopleDir())
    ? readdirSync(peopleDir()).filter((f) => f.endsWith('.md'))
    : []
}

describe('Open scribe wiring — chat-time extraction is ON in the boot path', () => {
  test('a real user turn through the Open composer fires scribe AND persists the extracted entity', async () => {
    harness = await startHarness()

    // Live WS → engine.start emits the first onboarding prompt. Then send a
    // real user_message: the chat-bridge runs engine.advance and fires the
    // composer-threaded scribeOnUserTurn with the turn text.
    const sock = await openOwnerSocket(harness.port)
    // Let startSession register the sender + emit the first prompt.
    await sleep(300)
    sock.send(JSON.stringify({ type: 'user_message', body: LONG_TURN }))

    // 1) The scribe extraction was dispatched to the substrate (handleUserTurn
    //    is fire-and-forget; give the microtask + extract a moment to settle).
    let scribeDispatched = false
    for (let i = 0; i < 60 && !scribeDispatched; i++) {
      scribeDispatched = harness.dispatchedPrompts.some((p) => p.includes('You are the scribe'))
      if (!scribeDispatched) await sleep(100)
    }
    expect(scribeDispatched).toBe(true)
    // The extraction prompt must carry the user's actual turn text — proof the
    // bridge handed scribe THIS turn, not a stray dispatch.
    const scribePrompt = harness.dispatchedPrompts.find((p) => p.includes('You are the scribe'))!
    expect(scribePrompt).toContain('Dana Reeves')

    // 2) The extracted person entity is PERSISTED to the owner's entities wiki
    //    (the GBrain write target's on-disk source of truth). This is the
    //    end-to-end proof the wired path ran: bridge → scribe.handleUserTurn →
    //    extract → writeExtractionToGBrain → entity page.
    const pages = await awaitPersonPage()
    sock.close()
    expect(pages.length).toBeGreaterThan(0)
    const page = readFileSync(join(peopleDir(), pages[0]!), 'utf8')
    expect(page).toContain('Dana Reeves')
  }, 30_000)
})
