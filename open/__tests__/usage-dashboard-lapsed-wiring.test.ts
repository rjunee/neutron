/**
 * A REVOKED ANTHROPIC CREDENTIAL REACHES THE CARD — through the production composer.
 *
 * THE POOL WITH THE ONLY SHIPPING WRITER WAS THE ONE THAT COULD NOT SAY "REFUSED".
 * The composer used to answer "is this pool connected" for Anthropic by resolving
 * the credential FILE — and `open/active-credential.ts` performs no validity check,
 * so a revoked token resolves `measurable` forever. The probe's 401 drops the cached
 * reading and writes no sample, which renders exactly like a box whose first tick
 * has not landed: "No readings yet.", a sentence promising a reading that can never
 * come. Two notions of "connected", which is the defect the composer's own comment
 * warns about.
 *
 * So this boots the REAL composer against a REAL local server that answers 401, and
 * asserts on the payload the composed handler serves. A hand-built
 * `connection: 'unreadable'` literal would prove only that this file can write one.
 *
 * The probe is pointed at loopback through `ANTHROPIC_BASE_URL` — the variable the
 * Anthropic SDK itself reads — so no real host is contacted.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { PoolSummary } from '@neutronai/persistence/usage-samples-store.ts'

import {
  connectionNote,
  decodeDashboard,
  projectPool,
} from '@neutronai/landing/chat-react/usage-dashboard-client.ts'

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
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb
let upstream: ReturnType<typeof Bun.serve>
let probeRequests = 0
let cleanup: () => Promise<void> = async () => {}
let fetchPools: () => Promise<PoolSummary[]> = async () => []

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-usage-lapsed-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  // A SUBSCRIPTION TOKEN, so the credential resolves `measurable` — which is the
  // whole point: on disk it is indistinguishable from a live one.
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'sk-ant-oat-revoked-test-token'
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['KIMI_API_KEY']
  delete process.env['NOTIFY_SOCKET']

  // THE UPSTREAM THAT REJECTS THE TOKEN. Loopback only; no real host is contacted.
  upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req: Request): Response => {
      if (new URL(req.url).pathname.endsWith('/v1/messages')) probeRequests += 1
      return Response.json({ error: { type: 'authentication_error' } }, { status: 401 })
    },
  })
  process.env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${upstream.port}`

  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
  applyMigrations(db.raw())

  const { buildOpenGraphComposer } = await import('../composer.ts')
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  cleanup = async (): Promise<void> => {
    for (const c of composition.realmode_cleanups ?? []) {
      try {
        await c()
      } catch {
        /* best-effort */
      }
    }
  }
  fetchPools = async (): Promise<PoolSummary[]> => {
    const res = await composition.app_usage_surface!.handler(
      new Request('http://127.0.0.1/api/app/usage/dashboard', {
        headers: { authorization: 'Bearer dev:owner' },
      }),
    )
    expect(res?.status).toBe(200)
    return ((await res!.json()) as { pools: PoolSummary[] }).pools
  }
}, 30_000)

afterAll(async () => {
  await cleanup()
  upstream.stop(true)
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

/** The composed payload, once the boot tick has landed. Polled, never slept on. */
async function poolsAfterFirstTick(): Promise<PoolSummary[]> {
  const deadline = Date.now() + 10_000
  let latest: PoolSummary[] = []
  for (;;) {
    latest = await fetchPools()
    const anthropic = latest.find((p) => p.pool === 'anthropic')!
    if (anthropic.connection === 'unreadable') return latest
    if (Date.now() > deadline) return latest
    await Bun.sleep(25)
  }
}

test('a rejected credential makes the composed card say so, not "no readings yet"', async () => {
  const pools = await poolsAfterFirstTick()
  // The probe really did ask — otherwise "unreadable" could come from anywhere.
  expect(probeRequests).toBeGreaterThan(0)
  const anthropic = pools.find((p) => p.pool === 'anthropic')!
  expect(anthropic.connection).toBe('unreadable')
  // AND STILL EMPTY. A 401 writes no sample, so there is nothing for a fabricated
  // 0% — the render that would say the whole subscription is free — to come from.
  expect(anthropic.accounts).toEqual([])
  expect(anthropic.measured_at).toBeNull()
})

test('the sentence the owner reads comes from the shipped client, not from this file', async () => {
  const pools = await poolsAfterFirstTick()
  const decoded = decodeDashboard({ pools })
  if (!decoded.reachable) throw new Error('unreachable: the composed response is a payload')
  const view = projectPool(decoded.pools.find((p) => p.pool === 'anthropic')!, Date.now())
  const note = connectionNote(view)
  // The mutant: deriving "connected" from the credential FILE, which renders a
  // sentence promising a first reading that is never coming.
  expect(note).not.toBe('No readings yet.')
  expect(note).toContain("didn't produce a reading")
})

test('a pool nobody rejected is NOT unreadable — the state means "asked and refused"', async () => {
  // THE POSITIVE CONTROL. Without it a composer that returned `unreadable` for every
  // pool would pass both tests above. Neither of the other two has a credential.
  const pools = await poolsAfterFirstTick()
  expect(pools.find((p) => p.pool === 'kimi')!.connection).toBe('not_connected')
  expect(pools.find((p) => p.pool === 'codex')!.connection).toBe('not_connected')
})
