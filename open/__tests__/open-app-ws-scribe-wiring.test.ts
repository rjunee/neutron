/**
 * Open app-ws entity-scribe prod-boot wiring — the anti-"built-but-not-wired"
 * gate for the chat-time entity scribe on the surface the owner actually uses.
 *
 * THE BUG (fullpipe-e2e 2026-06-28 Stage 2 root-cause): `scribeOnUserTurn`
 * (chat-time fact extraction → GBrain memory) was wired ONLY into the legacy
 * web `chat-bridge.handleInbound` (the old `/ws/chat` path). The React client
 * connects to the UNIFIED `/ws/app/chat` socket, which dispatches through
 * `AppWsAdapter.dispatchInbound` → the composer's `appWsReceiver.receive` →
 * `appWsChatTurn`. That receiver ran the live-agent turn but NEVER called the
 * entity scribe, so NO post-onboarding chat turn extracted facts to gbrain —
 * the store stayed empty and "recall" silently fell back to in-session CC
 * context. (The onboarding seam's `onTurnComplete` extracts the 5 PROFILE
 * fields; the ENTITY scribe — people/companies/concepts — is a distinct layer.)
 *
 * THE FIX: `appWsReceiver.receive` now fans every real user turn into
 * `scribeOnUserTurn` (fire-and-forget + guarded), at parity with the chat-bridge.
 *
 * Per CLAUDE.md (the "built but never invoked" incident class) this boots the
 * REAL Open composition over a live `Bun.serve`, opens the unified
 * `/ws/app/chat` socket, sends ONE user message, and asserts the scribe's
 * extraction substrate is actually dispatched (its prompt — the
 * `SCRIBE_EXTRACTION_PROMPT` persona — reaches the mocked substrate). A
 * synthetic credential makes the scribe live; the substrate is MOCKED (no real
 * `claude`, no api.anthropic.com).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '../../runtime/substrate.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { Event } from '../../runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

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
  base: string
  db: ProjectDb
  prompts: string[]
  close(): Promise<void>
}

let harness: Harness | null = null

/** Mocked substrate that records every dispatched prompt and answers with a
 *  trivial completion. Used for BOTH the live-agent turn and the scribe. */
function recordingSubstrate(prompts: string[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      prompts.push(spec.prompt)
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'ok' }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock-scribe',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {
          throw new Error('mock substrate: no external tools')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-appws-scribe-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

async function startHarness(prompts: string[]): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => recordingSubstrate(prompts)) as any,
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
    base: `http://127.0.0.1:${server.port}`,
    db,
    prompts,
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

describe('Open app-ws entity-scribe wiring', () => {
  test('a user turn over /ws/app/chat dispatches the entity scribe to the substrate', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-appws-scribe-test'
    const prompts: string[] = []
    harness = await startHarness(prompts)
    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    // A real, fact-bearing turn LONG ENOUGH to clear the scribe's 80-char
    // `shouldExtract` floor (a short "hi" would be filtered before dispatch).
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'user_message',
        body:
          'For the record: my co-founder is Alex Petrov and our team ships production deploys every Tuesday.',
        client_msg_id: 'c-scribe-1',
      }),
    )

    // The scribe is fire-and-forget AFTER the live-agent turn returns; wait for
    // its extraction prompt (the SCRIBE_EXTRACTION_PROMPT persona) to reach the
    // mocked substrate. THIS is the wiring the bug had missing.
    await waitFor(() => prompts.some((p) => p.includes('You are the scribe')))
    expect(prompts.some((p) => p.includes('You are the scribe'))).toBe(true)

    ws.close()
    await sleep(50)
  }, 30_000)
})
