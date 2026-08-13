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
 *   - the staleness constants the store SENDS are the intervals the writers
 *     actually poll at. Two numbers that must agree, in two packages that cannot
 *     import each other;
 *   - the payload carries NO DELTA — no age, no staleness verdict, no floor, no
 *     capacity standing. Those are functions of the render clock, so a card that
 *     took the server's word for them would paint a dead poller as fresh for as
 *     long as the tab stayed open. Pinned here, on the real composed response,
 *     because "the store does not compute it" is not the same claim as "the wire
 *     does not carry it".
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
  CLIENT_POLL_BUDGET_MS,
  POOL_CADENCE_MS,
  POOL_STALE_AFTER_MS,
  UsageSamplesStore,
  type PoolSummary,
} from '@neutronai/persistence/usage-samples-store.ts'
import { GLOBAL_PROJECT_ID, ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { KIMI_CREDENTIAL_SERVICE } from '@neutronai/trident/kimi-key.ts'
import { CODEX_CREDENTIAL_SERVICE } from '@neutronai/trident/codex-credential.ts'
import { USAGE_POLL_INTERVAL_MS } from '../credential-usage-monitor.ts'
import { KIMI_USAGE_POLL_INTERVAL_MS } from '../kimi-usage-monitor.ts'

import {
  USAGE_POLL_MS,
  capacityLine,
  connectionNote,
  decodeDashboard,
  projectPool,
} from '@neutronai/landing/chat-react/usage-dashboard-client.ts'

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
/** Re-issued against the SAME composition, so a per-request resolver can be seen. */
let fetchPools: () => Promise<PoolSummary[]> = async () => []
let credentials: ProjectCredentialStore

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
  credentials = new ProjectCredentialStore(db, { crypto: secrets })
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
  fetchPools = async (): Promise<PoolSummary[]> => {
    const res = await composition.app_usage_surface!.handler(
      new Request('http://127.0.0.1/api/app/usage/dashboard', {
        headers: { authorization: 'Bearer dev:owner' },
      }),
    )
    expect(res?.status).toBe(200)
    return ((await res!.json()) as { pools: PoolSummary[] }).pools
  }
  pools = await fetchPools()
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
    // The age chip's input, present on every card: the measurement INSTANT, and
    // the deadline the client measures it against. Never the age itself.
    expect(pool.measured_at).toBeGreaterThan(0)
    expect(account.measured_at).toBeGreaterThan(0)
    expect(pool.stale_after_ms).toBe(POOL_STALE_AFTER_MS[name])
  }
})

test('the composed payload carries NO DELTA — every one of them is the client\'s job', () => {
  // THE ROUND-1 BLOCKER, pinned on the real response. `age_ms`, `stale`, `floor`
  // and `capacity` are all functions of "now": baked here they would be frozen at
  // response time, and both clients hold a payload between fetches while their own
  // countdowns tick. A card would then insist "just now, available" about a poller
  // that died hours ago.
  //
  // Asserted on the SERIALISED body rather than on the typed value, because a field
  // that TypeScript no longer knows about can still ride the wire.
  const serialised = JSON.stringify(pools)
  for (const forbidden of ['age_ms', '"stale"', 'floor', 'capacity', 'resets_in_ms', 'binding']) {
    expect(serialised).not.toContain(forbidden)
  }
  // A positive control on the search: the fields that SHOULD be there are, so a
  // typo'd needle cannot make this pass over an empty haystack.
  for (const present of ['measured_at', 'stale_after_ms', 'reset_at', 'fraction']) {
    expect(serialised).toContain(present)
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

test('the composed payload is what the real card reads, and the card says "1 available now"', () => {
  // END TO END through the CLIENT'S OWN projection, not a restatement of it: the
  // bytes the composed handler served are decoded and projected by the shipped web
  // client, at the clock the owner would be looking at. 75% of the session window
  // and 50% of the weekly one is room in both, so the account is available and the
  // headline says so.
  //
  // This is also the seam that would catch a rename: a server field the client does
  // not read makes the line fall to "unknown" here rather than passing a
  // hand-written expectation about a shape nobody renders.
  const decoded = decodeDashboard({ pools })
  expect(decoded.reachable).toBe(true)
  if (!decoded.reachable) return
  const anthropic = projectPool(
    decoded.pools.find((p) => p.pool === 'anthropic')!,
    Date.now(),
  )
  expect(anthropic.accounts[0]!.account_label).toBe('owner-a')
  expect(anthropic.capacity.available_now).toBe(1)
  expect(anthropic.capacity.next).toEqual({ state: 'available' })
  // AND HOW MUCH ROOM, on the window closest to taking it away: 'available' is a
  // boolean, and the decision it feeds is not. 75% of the 5-hour window leaves less
  // headroom than 50% of the weekly one, so the 5-hour window is the one quoted.
  expect(capacityLine(anthropic)).toBe('1 available now (5h window 75% used)')
  // And the age chip is a real, growing number rather than a frozen zero.
  expect(anthropic.age_ms).toBeGreaterThan(0)
})

test('the Codex card is honestly empty — no accounts, no zeros, and a reason', () => {
  const codex = pools.find((p) => p.pool === 'codex')!
  expect(codex.accounts).toEqual([])
  expect(codex.measured_at).toBeNull()
  expect(codex.connection).toBe('not_connected')
  // NEVER a zero standing, and never an unbounded one either: Codex has no cadence,
  // but it still carries a finite deadline, so a harvested reading cannot claim
  // freshness for three weeks once the Phase 3 writer lands.
  expect(codex.stale_after_ms).toBe(POOL_STALE_AFTER_MS.codex)
  expect(Number.isFinite(codex.stale_after_ms)).toBe(true)
  // The card says "not connected"; it does not draw a bar.
  const decoded = decodeDashboard({ pools })
  if (!decoded.reachable) throw new Error('unreachable: the composed response is a payload')
  const view = projectPool(decoded.pools.find((p) => p.pool === 'codex')!, Date.now())
  expect(connectionNote(view)).toBe('Not connected.')
  expect(capacityLine(view)).toBeNull()
})

/**
 * A CONNECTED CODEX CREDENTIAL MUST NOT SAY "No readings yet."
 *
 * `connected` means "empty because the first reading has not landed YET", and the
 * card renders it as a sentence promising that reading. No writer records
 * `pool: 'codex'` in this build — the positive controls `pool: 'anthropic'` and
 * `pool: 'kimi'` both appear in `open/composer.ts` and `'codex'` does not — so the
 * promise is one nothing in the binary can keep, and the owner would wait forever on
 * a poller that is not there.
 *
 * The credential is stored through the SAME store the Settings pane writes to, and
 * the dashboard is re-fetched from the SAME composition: the connection is resolved
 * PER REQUEST, so this also pins that the card follows the credential without a
 * restart. It reads a real value out of the composed response before asserting on
 * it, rather than trusting the field name.
 */
test('a Codex credential renders "no gauge", not a promise of a first reading', async () => {
  const before = (await fetchPools()).find((p) => p.pool === 'codex')!
  expect(before.connection).toBe('not_connected')

  await credentials.set(asOwnerHandle('owner'), {
    scope: 'global',
    service: CODEX_CREDENTIAL_SERVICE,
    // The subscription bundle shape `validateCodexSubscriptionAuth` accepts. No real
    // token: every value here is a placeholder.
    plaintext: JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: 'id', access_token: 'acc', refresh_token: 'ref', account_id: 'a' },
      last_refresh: '2026-06-30T00:00:00.000Z',
    }),
  })

  const after = (await fetchPools()).find((p) => p.pool === 'codex')!
  // THE MUTANT: return `'connected'` from the composer's codex arm and this flips to
  // "No readings yet." — the sentence with no writer behind it.
  expect(after.connection).toBe('no_gauge')
  // STILL no zeros. A pool nobody measured has no row to draw a bar from.
  expect(after.accounts).toEqual([])
  expect(after.measured_at).toBeNull()

  const decoded = decodeDashboard({ pools: [after] })
  if (!decoded.reachable) throw new Error('unreachable: the composed response is a payload')
  const view = projectPool(decoded.pools[0]!, Date.now())
  const note = connectionNote(view)
  expect(note).not.toBe('No readings yet.')
  expect(note).toBe(
    "Connected. This build doesn't meter this provider yet, so there is nothing to read.",
  )
  expect(capacityLine(view)).toBeNull()

  // Put the composition back the way the other tests found it — they share one boot.
  await credentials.delete(asOwnerHandle('owner'), GLOBAL_PROJECT_ID, CODEX_CREDENTIAL_SERVICE)
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

test('the staleness constants ARE the writers’ poll intervals, plus one missed probe', () => {
  // `persistence` cannot import `open`, so the cadence that decides when a card
  // renders as stale is declared twice. Pinned here, where both are importable: a
  // poller slowed down without moving its cadence would silently mark every reading
  // stale, and a cadence relaxed without the poller would hide a dead writer.
  expect(POOL_CADENCE_MS.anthropic).toBe(USAGE_POLL_INTERVAL_MS)
  expect(POOL_CADENCE_MS.kimi).toBe(KIMI_USAGE_POLL_INTERVAL_MS)
  // And the deadline the wire carries is that cadence with ONE missed probe of
  // grace. Zero grace blanks an account with headroom over a single flaky request,
  // which writes no row and would leave the card "unknown" for a full cadence.
  // ...PLUS the client's poll hold. The deadline is checked on the client against a
  // payload refetched every `USAGE_POLL_MS`, so a written row can be one poll away
  // from being on screen; budgeting the grace alone spends it twice and paints a
  // recovered install stale for the length of that hold.
  expect(POOL_STALE_AFTER_MS.anthropic).toBe(
    USAGE_POLL_INTERVAL_MS * 2 + CLIENT_POLL_BUDGET_MS,
  )
  expect(POOL_STALE_AFTER_MS.kimi).toBe(
    KIMI_USAGE_POLL_INTERVAL_MS * 2 + CLIENT_POLL_BUDGET_MS,
  )
  // The budget is the clients' OWN poll interval, imported rather than restated —
  // `persistence` cannot import a client, so this is where the two are held equal.
  expect(CLIENT_POLL_BUDGET_MS).toBe(USAGE_POLL_MS)
  // Codex's gauge is harvested from real runs rather than polled, so it has no
  // cadence to violate — but it still gets a finite MAX AGE, because "no cadence"
  // must never become "never stale".
  expect(POOL_CADENCE_MS.codex).toBeNull()
  expect(POOL_STALE_AFTER_MS.codex).toBe(30 * MINUTE)
})
