/**
 * Managed post-onboarding claim redirect — SERVER bootstrap injection.
 *
 * Verifies the "served" half of the redirect: the composer injects
 * `window.__neutron_post_onboarding_claim_url` into the served `/chat` React
 * shell IFF env `NEUTRON_POST_ONBOARDING_CLAIM_URL` is set. When it is UNSET
 * (the Open self-host default) NOTHING is injected — the client reads
 * `undefined` and the redirect no-ops (no-regression: onboarding renders
 * exactly as before). The client-side redirect behaviour on the injected
 * config is covered by the controller/config unit tests; this file locks the
 * server-to-client passthrough end to end through the real HTTP surface.
 *
 * Drives the composed graph's `fetch` directly (NOT `boot()`) so no cron
 * scheduler / watchdog starts — the page render is fast + deterministic. The
 * React shell only renders when a Claude substrate credential resolves (ISSUES
 * #318 auth gate), so a dummy `ANTHROPIC_API_KEY` is set to reach the shell
 * without ever calling the LLM (the render is credential-gated, not LLM-driven).
 * A pre-seeded COMPLETED owner returns straight to the steady-state shell (no
 * stale-cookie bounce, no onboarding auto-start).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'

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
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NEUTRON_POST_ONBOARDING_CLAIM_URL',
  'NOTIFY_SOCKET',
  'NEUTRON_GRAPH_COMPOSER_MODULE',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

// A minimal Bun.Server stand-in for the composed `fetch` (never upgrades — the
// bootstrap-injection path is plain HTTP).
const fakeServer = () => ({ requestIP: () => null, upgrade: () => false }) as never

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-claim-redirect-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  // Dummy credential → the auth gate resolves a pool and serves the React shell
  // (the page render never calls the LLM).
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NEUTRON_POST_ONBOARDING_CLAIM_URL']
  delete process.env['NOTIFY_SOCKET']
  delete process.env['NEUTRON_GRAPH_COMPOSER_MODULE']
})

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Pre-seed a COMPLETED owner: migrations + a terminal `onboarding_state` row.
 *  A completed owner returns straight to the steady-state React shell (no
 *  stale-cookie bounce) and onboarding never auto-starts. */
async function preSeedCompletedOwner(): Promise<void> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  try {
    applyMigrations(db.raw())
    await new SqliteOnboardingStateStore({ db }).upsert({
      owner_slug: 'owner',
      user_id: 'owner',
      phase: 'completed',
    })
  } finally {
    db.close()
  }
}

/** Pre-seed a completed owner, compose the graph, mint the owner cookie via the
 *  gate, and fetch the served `/chat` React shell HTML — all through the
 *  composed `fetch` (no `boot()`, so no cron/watchdog). Returns the shell HTML +
 *  a cleanup fn. */
async function fetchChatShell(): Promise<{ html: string; cleanup: () => Promise<void> }> {
  await preSeedCompletedOwner()
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  const doFetch = graph.fetch!
  const cleanup = async (): Promise<void> => {
    for (const c of composition.realmode_cleanups ?? []) {
      try {
        c()
      } catch {
        /* best-effort */
      }
    }
    await graph.shutdown()
    db.close()
  }
  try {
    // 1. Fresh GET /chat → mint the owner cookie (302 bounce to /chat?start).
    const gate = await doFetch(new Request('http://127.0.0.1/chat'), fakeServer())
    const cookie = gate.headers.get('set-cookie')!.split(';')[0]!
    // 2. GET /chat with the cookie → completed owner → the steady-state shell.
    const res = await doFetch(
      new Request('http://127.0.0.1/chat', { headers: { cookie } }),
      fakeServer(),
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    // Sanity: this is the React shell (the bootstrap-injection surface).
    expect(html).toContain('/chat-react.js')
    return { html, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

describe('Open — post-onboarding claim redirect bootstrap injection', () => {
  test('injects the claim URL into the served /chat shell when the env is set (Managed)', async () => {
    process.env['NEUTRON_POST_ONBOARDING_CLAIM_URL'] = 'https://claim.example.test'
    const { html, cleanup } = await fetchChatShell()
    try {
      expect(html).toContain(
        'window.__neutron_post_onboarding_claim_url="https://claim.example.test"',
      )
    } finally {
      await cleanup()
    }
  }, 30_000)

  test('injects NOTHING when the env is unset (Open self-host no-regression)', async () => {
    // env deliberately left unset in beforeEach.
    const { html, cleanup } = await fetchChatShell()
    try {
      expect(html).not.toContain('__neutron_post_onboarding_claim_url')
      // The other bootstrap scripts still render — the shell is otherwise unchanged.
      expect(html).toContain('window.__neutron_projects=')
      expect(html).toContain('window.__neutron_onboarding_active=')
    } finally {
      await cleanup()
    }
  }, 30_000)
})
