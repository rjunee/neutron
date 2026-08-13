/**
 * EVERY CONNECTED ACCOUNT ON ONE SCREEN — asserted against the PRODUCTION
 * composer's own output, never a hand-built payload.
 *
 * This is the test that would have caught every "built but never connected" defect
 * in this repo, so it does the expensive thing: it boots the real Open composer,
 * takes the handler the composition actually carries in its `app_usage_surface`
 * slot, and issues a real request at it. A payload assembled in this file would
 * prove only that this file can assemble a payload.
 *
 * WHAT IT PINS
 *   - the dashboard serves EVERY pool, in the store's order, with Codex present
 *     and honestly empty rather than absent or zeroed;
 *   - each pool's `connection` comes from the SAME resolvers the rest of the
 *     product uses, so "not connected" and "no meter" are distinguishable from
 *     "connected and idle";
 *   - the second gauge is a REGISTERED, RUNNING loop, not a class nobody arms;
 *   - the staleness constants the store renders with are the intervals the
 *     writers actually poll at. Two numbers that must agree, in two packages that
 *     cannot import each other.
 *
 * NO NETWORK. The Anthropic probe resolves an API-key credential (no windows, no
 * request) and the Kimi base URL points at a closed loopback port, so the pollers'
 * boot ticks fail fast and locally. Nothing here asserts on those ticks — the
 * samples below are written into the same database directly, which is what lets
 * the composed handler be exercised against a populated series.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import {
  POOL_CADENCE_MS,
  UsageSamplesStore,
  type PoolSummary,
} from '@neutronai/persistence/usage-samples-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { KIMI_CREDENTIAL_SERVICE } from '@neutronai/trident/kimi-key.ts'
import { USAGE_POLL_INTERVAL_MS } from '../credential-usage-monitor.ts'
import { KIMI_USAGE_POLL_INTERVAL_MS } from '../kimi-usage-monitor.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const MINUTE = 60_000
const HOUR = 60 * MINUTE

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
let pools: PoolSummary[]
let loopNames: string[]
let cleanup: () => Promise<void> = async () => {}

/** The reading a card renders from, written straight into the composed database. */
async function seedSamples(now: number): Promise<void> {
  const store = new UsageSamplesStore({ db, now: () => now })
  await store.record({
    pool: 'anthropic',
    ts: now - 30_000,
    account_label: 'owner-a',
    session: 0.75,
    weekly: 0.5,
    session_reset_at: now + 2.5 * HOUR,
    weekly_reset_at: now + 3.5 * 24 * HOUR,
  })
  await store.record({
    pool: 'kimi',
    ts: now - 2 * MINUTE,
    session: 0.42,
    weekly: 0.64,
    session_reset_at: now + 40 * MINUTE,
    weekly_reset_at: now + 3 * 24 * HOUR,
    session_window_ms: 5 * HOUR,
    weekly_window_ms: 7 * 24 * HOUR,
  })
}

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-usage-dashboard-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  // A BYO API key: connected, billed per token, no subscription window to read.
  // That is the `no_meter` case, and it keeps the credential probe off the network.
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-usage-dashboard'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
  // A closed loopback port: the Kimi poller's boot tick refuses instantly instead
  // of reaching a real host. The composer threads this value into the probe, so it
  // holds regardless of module import order.
  process.env['KIMI_BASE_URL'] = 'http://127.0.0.1:9/coding'

  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
  applyMigrations(db.raw())
  // A stored Kimi key — the same credential the Settings pane writes and the
  // review panel reads. This is what makes the Kimi card `connected`.
  const secrets = new SecretsStore({ data_dir: tmpDir, db })
  const credentials = new ProjectCredentialStore(db, { crypto: secrets })
  await credentials.set(asOwnerHandle('owner'), {
    scope: 'global',
    service: KIMI_CREDENTIAL_SERVICE,
    plaintext: 'kimi-test-key',
  })
  await seedSamples(Date.now())

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
  loopNames = composition.loop_registry?.names() ?? []

  // The handler the composition CARRIES — the one the route ladder serves.
  // Loopback bind ⇒ dev-bypass auth ⇒ the `dev:owner` bearer resolves to the owner.
  const res = await composition.app_usage_surface!.handler(
    new Request('http://127.0.0.1/api/app/usage/dashboard', {
      headers: { authorization: 'Bearer dev:owner' },
    }),
  )
  expect(res?.status).toBe(200)
  pools = ((await res!.json()) as { pools: PoolSummary[] }).pools
}, 30_000)

afterAll(async () => {
  await cleanup()
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

test('the composed dashboard serves EVERY pool, in the store order', () => {
  // A provider disappears from the screen only by leaving `USAGE_POOLS`. Before
  // this the composer hardcoded a one-element array, which is how "one pool" became
  // "the only pool the product can ever show".
  expect(pools.map((p) => p.pool)).toEqual(['anthropic', 'kimi', 'codex'])
})

test('two cards carry real windows: fraction, pace, projection, countdown and age', () => {
  for (const name of ['anthropic', 'kimi'] as const) {
    const pool = pools.find((p) => p.pool === name)!
    const account = pool.accounts[0]!
    expect(account.session!.fraction).toBeGreaterThan(0)
    expect(account.weekly!.fraction).toBeGreaterThan(0)
    // Pace is the "will it run out" half, and it is computable for both pools
    // here: Anthropic's from its documented default regime, Kimi's from the
    // window lengths its own sample carries.
    expect(account.session!.pace).not.toBeNull()
    expect(account.weekly!.pace).not.toBeNull()
    // The reset INSTANT is the "when does capacity come back" half. The
    // instant, not a duration: a stored countdown is wrong one millisecond later.
    expect(account.session!.reset_at).toBeGreaterThan(Date.now())
    expect(account.weekly!.reset_at).toBeGreaterThan(Date.now())
    // The age chip's input, present on every card.
    expect(pool.age_ms).toBeGreaterThanOrEqual(0)
    expect(account.age_ms).toBeGreaterThanOrEqual(0)
  }
})

test('a window burning faster than it refills carries its projected cap-out', () => {
  // 75% consumed with half the 5-hour window elapsed is 1.5×, and a pace over 1 is
  // the only case with an exhaustion to project. Null is the common GOOD case, so
  // this asserts the populated side rather than the absence.
  const account = pools.find((p) => p.pool === 'anthropic')!.accounts[0]!
  expect(account.session!.pace!).toBeGreaterThan(1)
  expect(account.session!.exhausts_at).not.toBeNull()
})

test('the pool line answers "how hard can I push" per provider', () => {
  const anthropic = pools.find((p) => p.pool === 'anthropic')!
  // 75% of the session window and 50% of the weekly one is room in both, so the
  // account is available — and the headline names it.
  expect(anthropic.capacity.available_now).toBe(1)
  expect(anthropic.capacity.next).toEqual({ state: 'available' })
  expect(anthropic.capacity.next_account_label).toBe('owner-a')
})

test('the Codex card is honestly empty — no accounts, no zeros, and a reason', () => {
  const codex = pools.find((p) => p.pool === 'codex')!
  expect(codex.accounts).toEqual([])
  expect(codex.measured_at).toBeNull()
  expect(codex.connection).toBe('not_connected')
  // NEVER a zero standing. The card says "not connected"; it does not draw a bar.
  expect(codex.capacity.available_now).toBe(0)
  expect(codex.capacity.next).toEqual({ state: 'unknown' })
})

test('each pool reports its connection from the SAME resolver the product uses', () => {
  const byPool = new Map(pools.map((p) => [p.pool, p.connection]))
  // An API-key install: connected and metered by spend, so there is no window to
  // read — and telling the owner to "connect" an account that is working would send
  // them to fix the wrong thing.
  expect(byPool.get('anthropic')).toBe('no_meter')
  // The key really is in the credential store this boot wrote to.
  expect(byPool.get('kimi')).toBe('connected')
  expect(byPool.get('codex')).toBe('not_connected')
})

test('the Kimi gauge is a REGISTERED, RUNNING loop — not a class nobody arms', () => {
  // The failure this repo keeps having: the poller exists, the store is perfect,
  // and nothing ever ticks. `credential-usage` is the positive control — if the
  // registry could not report loops at all, this assertion would pass vacuously.
  expect(loopNames).toContain('credential-usage')
  expect(loopNames).toContain('kimi-usage')
})

test('the staleness constants ARE the writers’ poll intervals', () => {
  // `persistence` cannot import `open`, so the cadence that decides when a card
  // renders as stale is declared twice. Pinned here, where both are importable: a
  // poller slowed down without moving its cadence would silently mark every reading
  // stale, and a cadence relaxed without the poller would hide a dead writer.
  expect(POOL_CADENCE_MS.anthropic).toBe(USAGE_POLL_INTERVAL_MS)
  expect(POOL_CADENCE_MS.kimi).toBe(KIMI_USAGE_POLL_INTERVAL_MS)
  // Codex's gauge is harvested from real runs rather than polled, so it has no
  // cadence to violate — its age is still rendered.
  expect(POOL_CADENCE_MS.codex).toBeNull()
})
