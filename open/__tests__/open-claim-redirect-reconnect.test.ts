/**
 * Managed post-onboarding claim redirect — RECONNECT recovery.
 *
 * The live `onboarding_completed` frame fanned at finalize is dropped if no
 * app-ws socket was registered at that instant — e.g. a background import-
 * completion watcher finalizes onboarding while the owner's tab is closed or
 * reloading. A plain reconnect then sees an already-`completed` row and nothing
 * re-signals, so the Managed claim redirect would be lost forever.
 *
 * THE FIX (`open/composer.ts` `on_session_open` steady-state branch): when a
 * claim URL is configured AND the owner has completed onboarding, replay the
 * one-shot `onboarding_completed` frame to the connecting topic on every
 * connect. This test boots the REAL Open composition over a live `Bun.serve`,
 * pre-seeds a COMPLETED owner, connects `/ws/app/chat`, and asserts the frame
 * arrives. A companion assertion confirms the strict NO-OP on Open self-host
 * (env unset ⇒ no frame).
 *
 * No ANTHROPIC_API_KEY is set — the recovery emit does not depend on the LLM.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import type { AppWsOutbound } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import { buildOpenGraphComposer } from '../composer.ts'

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
  'NEUTRON_POST_ONBOARDING_CLAIM_URL',
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

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-claim-reconnect-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NEUTRON_POST_ONBOARDING_CLAIM_URL']
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

/** Pre-seed a terminal onboarding row (default `completed`) BEFORE boot so
 *  `on_session_open` reads it and takes the steady-state branch. */
async function preSeedOwner(phase: 'completed' | 'failed' = 'completed'): Promise<void> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  try {
    applyMigrations(db.raw())
    await new SqliteOnboardingStateStore({ db }).upsert({
      owner_slug: 'owner',
      user_id: 'owner',
      phase,
    })
  } finally {
    db.close()
  }
}

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({ env: process.env })
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

/** Connect a web socket for the owner, collect frames until `session_ready`
 *  lands, then give the async `on_session_open` a beat to emit. */
async function connectAndCollect(): Promise<AppWsOutbound[]> {
  const wsUrl = harness!.base.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
  const events: AppWsOutbound[] = []
  ws.onmessage = (ev) => {
    events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as AppWsOutbound)
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
  })
  await waitFor(() => events.some((e) => e.type === 'session_ready'))
  // The claim re-emit runs inside the async on_session_open, after session_ready.
  await sleep(150)
  ws.close()
  await sleep(25)
  return events
}

describe('Open — post-onboarding claim redirect reconnect recovery', () => {
  test('replays onboarding_completed on connect for a completed owner when a claim URL is configured', async () => {
    process.env['NEUTRON_POST_ONBOARDING_CLAIM_URL'] = 'https://claim.example.test'
    await preSeedOwner('completed')
    harness = await startHarness()
    const events = await connectAndCollect()
    expect(events.some((e) => e.type === 'onboarding_completed')).toBe(true)
  }, 30_000)

  test('does NOT replay onboarding_completed when no claim URL is configured (Open self-host)', async () => {
    // env deliberately unset.
    await preSeedOwner('completed')
    harness = await startHarness()
    const events = await connectAndCollect()
    expect(events.some((e) => e.type === 'onboarding_completed')).toBe(false)
    // Sanity: the socket really did open + seed (session_ready present).
    expect(events.some((e) => e.type === 'session_ready')).toBe(true)
  }, 30_000)

  test('does NOT replay for a FAILED onboarding even with a claim URL configured (never completed)', async () => {
    process.env['NEUTRON_POST_ONBOARDING_CLAIM_URL'] = 'https://claim.example.test'
    await preSeedOwner('failed')
    harness = await startHarness()
    const events = await connectAndCollect()
    // `failed` is a terminal phase but the completion transition never happened —
    // it must NOT trigger the claim redirect.
    expect(events.some((e) => e.type === 'onboarding_completed')).toBe(false)
    expect(events.some((e) => e.type === 'session_ready')).toBe(true)
  }, 30_000)
})
