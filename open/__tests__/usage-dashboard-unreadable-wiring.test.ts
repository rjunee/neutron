/**
 * A REFUSED GAUGE READ REACHES THE CARD — through the production composer.
 *
 * `usage-dashboard-wiring.test.ts` boots the composer against a CLOSED port, so its
 * Kimi poller only ever produces a transport error and the card correctly stays
 * `connected`. That leaves the branch that matters unproven: an endpoint that
 * ANSWERS with a payload this build cannot read.
 *
 * The distinction is the whole reason the state exists. Kimi's usages schema is
 * unpublished (`trident/kimi-usage-probe.ts`), so the realistic first-install
 * failure is a 200 carrying fields the parser refuses — and it writes no row, which
 * renders identically to "the first tick has not landed yet". One of those resolves
 * itself and the other never will, and "No readings yet." promises the wrong one.
 *
 * So this boots the REAL composer against a REAL local server that answers with an
 * unmodelled body, and asserts on the payload the composed handler serves. A
 * hand-built `connection: 'unreadable'` literal would prove only that this file can
 * write one — the exact "built but never connected" defect this repo keeps having.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import type { PoolSummary } from '@neutronai/persistence/usage-samples-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { KIMI_CREDENTIAL_SERVICE } from '@neutronai/trident/kimi-key.ts'

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
  'CLAUDE_CODE_OAUTH_TOKEN',
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb
let upstream: ReturnType<typeof Bun.serve>
let usagesRequests = 0
let cleanup: () => Promise<void> = async () => {}
let fetchPools: () => Promise<PoolSummary[]> = async () => []

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-usage-unreadable-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  // A BYO API key keeps the Anthropic probe off the network entirely.
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-usage-unreadable'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']

  // THE UPSTREAM THAT ANSWERS, AND IS NOT UNDERSTOOD. A plausible-looking body
  // whose field names this build does not model — which is precisely the situation
  // the module header describes, since no live response has been printed into this
  // repo. Loopback only; no real host is contacted.
  upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req: Request): Response => {
      if (new URL(req.url).pathname.endsWith('/v1/usages')) usagesRequests += 1
      return Response.json({ quota: [{ bucket: 'five_hour', spent: 12 }] })
    },
  })
  process.env['KIMI_BASE_URL'] = `http://127.0.0.1:${upstream.port}/coding`

  seedMigratedDb(process.env['NEUTRON_DB_PATH'])
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
  const secrets = new SecretsStore({ data_dir: tmpDir, db })
  const credentials = new ProjectCredentialStore(db, { crypto: secrets })
  await credentials.set(asOwnerHandle('owner'), {
    scope: 'global',
    service: KIMI_CREDENTIAL_SERVICE,
    plaintext: 'kimi-test-key',
  })

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

/**
 * The composed payload, once the poller's boot tick has landed.
 *
 * Polled rather than slept on: the tick is armed by the composition and completes
 * on its own schedule, and a fixed sleep is the flakiest thing a test can contain.
 * The bound is generous and the failure is a real failure — if the standing never
 * arrives, the poller is not wired to the card, which is the defect.
 */
async function poolsAfterFirstTick(): Promise<PoolSummary[]> {
  const deadline = Date.now() + 10_000
  let latest: PoolSummary[] = []
  for (;;) {
    latest = await fetchPools()
    const kimi = latest.find((p) => p.pool === 'kimi')!
    if (kimi.connection === 'unreadable') return latest
    if (Date.now() > deadline) return latest
    await Bun.sleep(25)
  }
}

test('a payload the parser refuses makes the composed card say so, not "no readings yet"', async () => {
  const pools = await poolsAfterFirstTick()
  // The poller really did ask — otherwise "unreadable" could come from anywhere.
  expect(usagesRequests).toBeGreaterThan(0)
  const kimi = pools.find((p) => p.pool === 'kimi')!
  expect(kimi.connection).toBe('unreadable')
  // AND STILL EMPTY. Loud is not the same as inventing a reading: a refused payload
  // writes no row, so a fabricated 0% — the render that would tell the owner the
  // whole subscription is free — has nothing to come from.
  expect(kimi.accounts).toEqual([])
  expect(kimi.measured_at).toBeNull()
})

test('the sentence the owner reads comes from the shipped client, not from this file', async () => {
  const pools = await poolsAfterFirstTick()
  const decoded = decodeDashboard({ pools })
  if (!decoded.reachable) throw new Error('unreachable: the composed response is a payload')
  const view = projectPool(decoded.pools.find((p) => p.pool === 'kimi')!, Date.now())
  const note = connectionNote(view)
  // The mutant: folding "asked and refused" into "connected", which renders a
  // sentence promising a first reading that is never coming.
  expect(note).not.toBe('No readings yet.')
  expect(note).toContain("didn't produce a reading")
})

test('a pool nobody asked is NOT unreadable — the state means "asked and refused"', async () => {
  // THE POSITIVE CONTROL. Without it, a composer that returned `unreadable` for
  // every pool would pass both tests above. Anthropic here is a BYO API key: real,
  // working, and billed per token, so it has no window to meter and must not be
  // reported as a broken gauge. Codex has no credential at all.
  const pools = await poolsAfterFirstTick()
  expect(pools.find((p) => p.pool === 'anthropic')!.connection).toBe('no_meter')
  expect(pools.find((p) => p.pool === 'codex')!.connection).toBe('not_connected')
})
