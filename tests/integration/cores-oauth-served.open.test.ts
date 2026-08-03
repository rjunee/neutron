/**
 * THE CORES GOOGLE-OAUTH FLOW — served by the REAL composer, both halves.
 *
 * WHAT WAS BROKEN (ISSUES #448). `cores-oauth-surface.ts:359` registered its
 * pending state with `/oauth/cores/pending/register`, a path served by NOTHING in
 * either repo, and `open/composer.ts` never supplied `cores.oauth`, so the
 * instance-side routes never mounted either. Both ends of one flow were missing,
 * so no owner could ever complete a Google grant and three of the nine bundled
 * Cores — calendar, email, google-workspace — failed to install on every boot of
 * every install.
 *
 * WHY THIS TEST IS SHAPED THIS WAY. The defect is the EIGHTH instance of "the
 * test stood up the thing whose absence was the bug", and the first where the
 * missing counterpart was a whole service rather than a composer line — the
 * existing `cores-oauth-surface.test.ts` passes precisely because it fakes the
 * register endpoint. So this suite refuses to supply either half. It boots
 * `buildOpenGraphComposer` with the Google client env pair set, serves whatever
 * that composer produced, and asks the running product whether the two paths
 * answer. Nothing here constructs a surface or a broker.
 *
 * THE UNCONFIGURED CASE IS ASSERTED TOO, and is not an afterthought: the client
 * is per-deployment and must never be baked into Open (SPEC:1000), so "no envs →
 * nothing mounted" is the CORRECT default rather than a second bug. Pinning it
 * stops a future change from mounting a half-configured flow that fails at Google
 * instead of failing honestly at boot.
 *
 * MUTATION TESTS (each verified by making the change and re-running):
 *   - drop `oauth` from the `cores:` block in `open/composer.ts` → the
 *     instance-half test reds (routes 404).
 *   - drop `cores_oauth_broker_surface` from the composition → the broker-half
 *     test reds.
 *   - make the env gate unconditional → the unconfigured test reds.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

type OpenComposition = Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>

let home: IsolatedHome

interface Harness {
  base: string
  composition: OpenComposition
  close(): Promise<void>
}

function stubSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'cores-oauth-served',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

/** `configured` decides ONLY whether the per-deployment Google client env pair is
 *  present — the same switch a real operator flips. */
function bootHome(configured: boolean): void {
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NOTIFY_SOCKET',
      'NEUTRON_CORES_GOOGLE_CLIENT_ID',
      'NEUTRON_CORES_GOOGLE_CLIENT_SECRET',
      'NEUTRON_CONNECT_PUBLIC_BASE_URL',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-cores-oauth',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
      NEUTRON_CORES_GOOGLE_CLIENT_ID: configured ? 'synthetic-client-id.apps.googleusercontent.com' : undefined,
      NEUTRON_CORES_GOOGLE_CLIENT_SECRET: configured ? 'synthetic-client-secret' : undefined,
      NEUTRON_CONNECT_PUBLIC_BASE_URL: 'https://owner.example.com',
    },
  })
}

const openHarnesses: Harness[] = []
afterEach(async () => {
  while (openHarnesses.length > 0) {
    const h = openHarnesses.pop()!
    await h.close()
  }
  home.restore()
})

async function boot(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (() => stubSubstrate()) as never,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('composer produced no fetch/websocket')
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  const h: Harness = {
    base: `http://127.0.0.1:${server.port}`,
    composition,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      db.close()
    },
  }
  openHarnesses.push(h)
  return h
}

test('CONFIGURED — the real composer supplies BOTH halves of the flow', async () => {
  bootHome(true)
  const h = await boot()
  // The instance half: this field having no setter is what 404'd the grant.
  expect(h.composition.cores?.oauth).toBeDefined()
  // The broker half: the counterpart that never existed anywhere.
  expect(h.composition.cores_oauth_broker_surface).toBeDefined()
}, 60_000)

test('CONFIGURED — the broker register path is SERVED, not 404', async () => {
  bootHome(true)
  const h = await boot()

  // Unsigned on purpose: 401 proves the route is MOUNTED and authenticating.
  // A 404 here is the bug. The adjacent near-miss below is the control that
  // stops a catch-all from passing this test.
  const register = await fetch(`${h.base}/oauth/cores/pending/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: 's', project_slug: 'owner', dispatch_url: 'https://x.test/i' }),
  })
  expect(register.status).toBe(401)

  const nearMiss = await fetch(`${h.base}/oauth/cores/pending/registerX`, { method: 'POST' })
  expect(nearMiss.status).toBe(404)
}, 60_000)

test('CONFIGURED — the Google callback path is SERVED and refuses an unknown state', async () => {
  bootHome(true)
  const h = await boot()

  // No pending row was ever registered, so this MUST be refused — but refused by
  // the broker (400), not by the router (404). The distinction is the whole test.
  const cb = await fetch(`${h.base}/oauth/cores/google/callback?code=c&state=never-registered`)
  expect(cb.status).toBe(400)
  const body = await cb.text()
  expect(body).not.toContain('never-registered')
}, 60_000)

test('CONFIGURED — the instance-side grant routes answer instead of 404', async () => {
  bootHome(true)
  const h = await boot()

  // 401 (bearer required) is the mounted-and-gated answer; 404 was the bug.
  const status = await fetch(`${h.base}/api/cores/oauth/google/status`)
  expect(status.status).toBe(401)

  // Control: the sibling under the same prefix, which was ALWAYS mounted. If
  // this ever 404s the test is measuring the wrong thing.
  const siblingAlwaysMounted = await fetch(`${h.base}/api/cores/list`)
  expect(siblingAlwaysMounted.status).not.toBe(404)
}, 60_000)

test('UNCONFIGURED — no client env means nothing is mounted, and that is CORRECT', async () => {
  bootHome(false)
  const h = await boot()

  // The Google client is per-deployment and must never be baked into Open
  // (SPEC:1000), so a zero-creds install serving nothing here is the honest
  // state — not a second defect. Pinned so a future change cannot quietly mount
  // a half-configured flow that fails at Google instead of failing at boot.
  expect(h.composition.cores?.oauth).toBeUndefined()
  expect(h.composition.cores_oauth_broker_surface).toBeUndefined()
  const register = await fetch(`${h.base}/oauth/cores/pending/register`, { method: 'POST' })
  expect(register.status).toBe(404)
}, 60_000)
