/**
 * THE OAUTH ORIGIN MUST BE DECLARED, NOT GUESSED (ISSUES #448 follow-up 1).
 *
 * WHAT THIS PREVENTS. The Cores OAuth redirect URI is derived from the instance's
 * public origin. That origin resolves from `NEUTRON_CONNECT_PUBLIC_BASE_URL`, and
 * when the env is unset it falls back to one derived from the BIND ADDRESS. The
 * deploy on 2026-08-03 found a real install's env file holds only a cookie
 * secret, so a configured Google client there would have sent Google
 * `http://127.0.0.1:<port>/oauth/cores/google/callback` — an origin Google cannot
 * reach.
 *
 * That failure lands about as far from its cause as a failure can: Google rejects
 * it on Google's own error page, minutes later, naming nothing on this box. The
 * guard converts it into a line in this instance's boot log that says exactly
 * which env to set.
 *
 * WHY IT KEYS ON "DECLARED", NOT ON "LOOKS LIKE LOCALHOST" — and this is the
 * whole reason the test exists rather than just the guard. My first framing was
 * "refuse a loopback origin", which would have been WRONG: Google permits loopback
 * redirect URIs for desktop-style clients, so a self-hoster who deliberately
 * declares `http://localhost:8787` is legitimate and must keep working. The
 * hazard is not loopback-ness; it is that nobody CHOSE the value. The
 * declared-loopback case below is therefore the load-bearing test — it is the one
 * a careless implementation breaks.
 *
 * A MALFORMED value counts as undeclared on purpose: the owner believes they set
 * it, which makes silently substituting a guess the worse of the two failures.
 *
 * MUTATION TESTS (each verified by making the change and re-running):
 *   - drop `&& coresOAuthOriginDeclared` from the gate in `open/composer.ts` →
 *     the undeclared + malformed tests red.
 *   - key the guard on loopback instead of on source → the declared-loopback
 *     test reds, which is the regression this file exists to catch.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { seedMigratedDb } from '../support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

type OpenComposition = Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>

let home: IsolatedHome

function stubSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'oauth-base-url-guard',
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

/** `baseUrl: undefined` models a real install: client set, origin never declared. */
function bootHome(baseUrl: string | undefined): void {
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
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-oauth-guard',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
      NEUTRON_CORES_GOOGLE_CLIENT_ID: 'guard-test.apps.googleusercontent.com',
      NEUTRON_CORES_GOOGLE_CLIENT_SECRET: 'guard-test-secret',
      NEUTRON_CONNECT_PUBLIC_BASE_URL: baseUrl,
    },
  })
}

afterEach(() => {
  home.restore()
})

async function compose(): Promise<OpenComposition> {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (() => stubSubstrate()) as never,
  })
  return composer({ db, project_slug: 'owner' })
}

test('client configured but origin UNDECLARED → OAuth refuses to arm', async () => {
  bootHome(undefined)
  const composition = await compose()
  // Refusing is the point: an armed surface here would hand Google a bind-derived
  // origin it cannot reach, and the owner would debug it on Google's error page.
  expect(composition.cores?.oauth).toBeUndefined()
  expect(composition.cores_oauth_broker_surface).toBeUndefined()
}, 60_000)

test('a MALFORMED origin counts as undeclared — the owner thinks it is set', async () => {
  bootHome('not-a-url')
  const composition = await compose()
  expect(composition.cores?.oauth).toBeUndefined()
}, 60_000)

test('a DECLARED LOOPBACK origin is honoured — Google allows it for desktop clients', async () => {
  // THE LOAD-BEARING CASE. A guard keyed on "looks like localhost" would break
  // this legitimate local self-host. The hazard is an UNCHOSEN value, not a
  // loopback one.
  bootHome('http://localhost:8787')
  const composition = await compose()
  expect(composition.cores?.oauth).toBeDefined()
  expect(composition.cores?.oauth?.redirectUri).toBe(
    'http://localhost:8787/oauth/cores/google/callback',
  )
}, 60_000)

test('a declared public origin arms both halves and builds the right redirect', async () => {
  bootHome('https://owner.example.com')
  const composition = await compose()
  expect(composition.cores?.oauth).toBeDefined()
  expect(composition.cores_oauth_broker_surface).toBeDefined()
  // The exact string the owner must register on the OAuth client. Pinned because
  // a silent change here is another redirect_uri_mismatch nobody can trace.
  expect(composition.cores?.oauth?.redirectUri).toBe(
    'https://owner.example.com/oauth/cores/google/callback',
  )
  expect(composition.cores?.oauth?.identityBaseUrl).toBe('https://owner.example.com')
}, 60_000)
