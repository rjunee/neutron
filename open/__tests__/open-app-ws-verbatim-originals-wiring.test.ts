/**
 * VERBATIM originals — PROD-BOOT WIRING gate.
 *
 * This repo's single most recurring defect is "the module exists, its tests
 * pass, and the composer never wires it" (persona-gen, idle-nudge, /code, the
 * Tasks prioritiser, and `scribeOnUserTurn` itself — see
 * `open-app-ws-scribe-wiring.test.ts`). A verbatim-capture path that only ever
 * runs in a unit test would leave Ryan's `entities/originals/` corpus exactly
 * as dead as it is today, which is the whole thing this work exists to prevent.
 *
 * So this boots the REAL Open composition over a live `Bun.serve`, opens the
 * unified `/ws/app/chat` socket the React client actually uses, sends ONE
 * reflective user message, and asserts a real `entities/originals/<slug>.md`
 * page appears on disk with the owner's words BYTE-IDENTICAL. The substrate is
 * mocked (no real `claude`); everything between the socket and the file — the
 * app-ws receiver, `scribeOnUserTurn`, `createScribe`, the verbatim guard, the
 * entity-writer — is the production wiring.
 *
 * FAILS IF: the app-ws receiver stops fanning turns into the scribe, the scribe
 * stops threading the source turn into the guard, or
 * `writeExtractionToGBrain` stops calling `writeOriginalPages`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { extractCompiledTruth } from '@neutronai/runtime/entity-format.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** The owner's own words — a reflective first-person passage, comfortably over
 *  the scribe's 80-char `shouldExtract` floor. */
const PASSAGE =
  "The thing I keep relearning is that I don't actually want more leverage, I want fewer things I've agreed to care about."

const TITLE = 'On leverage versus fewer commitments'
const SLUG = 'on-leverage-versus-fewer-commitments'

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
  close(): Promise<void>
}

let harness: Harness | null = null

/**
 * Mocked substrate. For the SCRIBE prompt it answers with an extraction
 * document whose `originals[0].passage` is the owner's passage as an LLM
 * typically "copies" it — smart apostrophes, collapsed whitespace. The guard
 * must accept it AND store the owner's original bytes. Every other dispatch
 * (the live-agent turn) gets a trivial completion.
 */
function scribeAwareSubstrate(prompts: string[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      prompts.push(spec.prompt)
      const isScribe = spec.prompt.includes('You are the scribe')
      const text = isScribe
        ? JSON.stringify({
            entities: [],
            relations: [],
            originals: [
              {
                title: TITLE,
                // NOT byte-equal to the source: curly apostrophes.
                passage: PASSAGE.replace(/'/g, '’'),
              },
            ],
          })
        : 'ok'
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text }
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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-verbatim-'))
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
  const db = openMigratedDbAt(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => scribeAwareSubstrate(prompts)) as any,
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

describe('Open app-ws verbatim-originals wiring', () => {
  test('a reflective turn over /ws/app/chat lands a byte-identical originals page', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-verbatim-wiring-test'
    const prompts: string[] = []
    harness = await startHarness(prompts)
    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'user_message',
        body: PASSAGE,
        client_msg_id: 'c-verbatim-1',
      }),
    )

    // 1. The scribe prompt reaches the substrate AND carries the ORIGINALS
    //    instruction — proving the extended prompt is the one in production.
    await waitFor(() => prompts.some((p) => p.includes('You are the scribe')))
    const scribePrompt = prompts.find((p) => p.includes('You are the scribe'))!
    expect(scribePrompt).toContain('COPIED CHARACTER-FOR-CHARACTER')
    expect(scribePrompt).toContain('"originals"')

    // 2. THE WIRING ASSERTION: a real `original`-kind page appears on disk.
    const path = join(tmpDir, 'entities', 'originals', `${SLUG}.md`)
    await waitFor(() => existsSync(path))

    // 3. The owner's words are there BYTE-IDENTICAL — not the model's
    //    smart-quoted transcription of them.
    const page = readFileSync(path, 'utf8')
    expect(page.includes(PASSAGE)).toBe(true)
    expect(extractCompiledTruth(page).includes(PASSAGE)).toBe(true)
    expect(page).not.toContain('’') // the model's curly apostrophes never landed
    expect(page).toContain('type: original')

    ws.close()
    await sleep(50)
  }, 30_000)
})
