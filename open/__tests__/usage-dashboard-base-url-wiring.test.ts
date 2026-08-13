/**
 * A MISTYPED `ANTHROPIC_BASE_URL` MUST NOT KILL THE GAUGE — through the production
 * composer.
 *
 * `open/composer.ts` threads the raw environment value straight into the probe's
 * `apiBaseUrl`, so whatever the operator typed is what the probe is handed. The probe
 * used to join it with `new URL('/v1/messages', base)`, which throws `TypeError:
 * Invalid URL` on a base with no scheme — and it threw from OUTSIDE the probe's own
 * `try`, out of a function whose header promises it never throws. The throw landed in
 * `SupervisedLoop`'s catch-all, so nothing crashed and nothing recovered either: EVERY
 * tick failed the same way, the card never got a reading, and five ticks in the loop
 * escalated. A one-character typo took the whole meter out silently.
 *
 * `auth/__tests__/credential-usage-probe.test.ts` pins the join itself. This pins that
 * the COMPOSED path from the environment variable to the tick is the fixed one: the
 * assertion is on the composer's own output and on the loop's own error sink, never on
 * a hand-built config literal.
 *
 * No host is contacted. A scheme-less base cannot be fetched at all, which is the
 * point — the failure has to arrive as the probe's tagged `error` outcome.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { PoolSummary } from '@neutronai/persistence/usage-samples-store.ts'

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

/** THE SCHEME IS MISSING — the ordinary operator typo this test is about. */
const SCHEMELESS_BASE = 'anthropic.example.com'

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb
let cleanup: () => Promise<void> = async () => {}
let fetchPools: () => Promise<PoolSummary[]> = async () => []
let fetchSnapshot: () => Promise<{ available: boolean; reason?: string }> = async () => ({
  available: false,
})
/** Everything the loop's default error sink wrote while the composition ran. */
let consoleErrors: string[] = []
let realConsoleError: typeof console.error
/** The snapshot the boot tick left behind, captured once it had run. */
let settled: { available: boolean; reason?: string } = { available: false }

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-usage-base-url-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  // A subscription token, so the credential resolves `measurable` and the monitor
  // actually ticks — a pool with nothing to probe would pass this test vacuously.
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'sk-ant-oat-test-token-not-a-real-credential'
  process.env['ANTHROPIC_BASE_URL'] = SCHEMELESS_BASE
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['KIMI_API_KEY']
  delete process.env['NOTIFY_SOCKET']

  realConsoleError = console.error
  consoleErrors = []
  console.error = (...args: unknown[]): void => {
    consoleErrors.push(args.map((a) => String(a)).join(' '))
  }

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
  fetchSnapshot = async (): Promise<{ available: boolean; reason?: string }> => {
    const res = await composition.app_usage_surface!.handler(
      new Request('http://127.0.0.1/api/app/usage', {
        headers: { authorization: 'Bearer dev:owner' },
      }),
    )
    expect(res?.status).toBe(200)
    return (await res!.json()) as { available: boolean; reason?: string }
  }
  // WAIT FOR THE BOOT TICK TO REACH AN OUTCOME, which is exactly what the bug
  // prevented: `not_measured_yet` is the monitor's pre-tick state, and a tick that
  // throws never replaces it. Polled to a deadline rather than slept on, so the
  // passing run costs milliseconds and the failing one is a bounded timeout.
  const deadline = Date.now() + 10_000
  for (;;) {
    settled = await fetchSnapshot()
    if (settled.reason !== 'not_measured_yet') break
    if (Date.now() > deadline) break
    await Bun.sleep(25)
  }
}, 30_000)

afterAll(async () => {
  await cleanup()
  console.error = realConsoleError
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

test('the composed gauge tick REACHES an outcome on a scheme-less ANTHROPIC_BASE_URL', () => {
  // THE MUTANT: restore `new URL('/v1/messages', deps.apiBaseUrl)` and both lines go
  // red together. The probe throws past its own `try`, so the tick never reaches its
  // `error` branch — the monitor is stuck on its pre-tick state forever — and the
  // loop's catch-all logs the escape.
  expect(settled.reason).toBe('probe_failed')
  const thrown = consoleErrors.filter((line) =>
    line.includes("[supervised-loop] tick 'credential-usage' threw"),
  )
  expect(thrown).toEqual([])
})

test('and the card stays honest rather than showing a zero', async () => {
  const pools = await fetchPools()
  const anthropic = pools.find((p) => p.pool === 'anthropic')!
  // A transport failure is TRANSIENT: the credential is not accused of being dead
  // (that would fire a "reconnect your account" notice about a working token), and
  // no sample is written, so there is nothing for a fabricated 0% to be drawn from.
  expect(anthropic.connection).toBe('connected')
  expect(anthropic.accounts).toEqual([])
  expect(anthropic.measured_at).toBeNull()
})
