/**
 * THE BROKER CAN BE SOMEWHERE ELSE (SPEC § Decisions Log 2026-08-04).
 *
 * WHAT WAS MISSING. `cores-oauth-broker-surface.ts` was written to run either
 * co-located or centrally, and `gateway/composition/input/cores-input.ts:111-113`
 * states that in the central deployment "its instances leave this unset". The
 * composer gave them no way to. It derived the HMAC secret from this instance's
 * own random AES keyfile — a value no other host can know — pinned all three
 * origins to `NEUTRON_CONNECT_PUBLIC_BASE_URL`, and mounted the local broker
 * surface unconditionally. The remote half of a documented two-deployment flow
 * was unreachable by configuration.
 *
 * WHY THE TEST BOOTS THE REAL COMPOSER. A wiring test that constructs its own
 * config object proves only that an object can be built; it would have passed
 * throughout the outage above. So every assertion here reads
 * `composition.cores.oauth` and `composition.cores_oauth_broker_surface` off the
 * value `buildOpenGraphComposer` actually produced, the same way its sibling
 * `cores-oauth-base-url-guard.open.test.ts` does.
 *
 * THE ASSERTION THAT MATTERS MOST is `ownerBaseUrl`. Only `identityBaseUrl` and
 * `redirectUri` follow the broker; `ownerBaseUrl` stays THIS instance, because
 * it becomes the `dispatch_url` the broker relays the code back to
 * (`gateway/http/cores-oauth-surface.ts:381`). Moving it with the other two is
 * the plausible mistake, and it makes the callback undeliverable: the broker
 * would relay to itself, and the grant would die one hop from completion.
 *
 * MUTATION TESTS (each verified by making the change and re-running):
 *   - set `ownerBaseUrl: coresBroker.origin` → the remote test reds on the
 *     dispatch origin, which is the undeliverable-callback regression.
 *   - drop `&& coresBroker.serve_locally` from the broker mount → the remote
 *     test reds on the surface still being mounted.
 *   - ignore the binding's secret and keep deriving the co-located one → the
 *     remote test reds on `internalSharedSecret`.
 *   - treat a partial declaration as co-located instead of refusing → the
 *     half-declared test reds.
 */

import { afterEach, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import {
  CORES_BROKER_BASE_URL_ENV,
  CORES_BROKER_SECRET_ENV,
} from '@neutronai/open/cores-broker-binding.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const OWN_ORIGIN = 'https://owner.example.com'
const BROKER_ORIGIN = 'https://identity.example.com'
const BROKER_SECRET = 'deployment-wide-broker-secret-for-tests'

type OpenComposition = Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>

let home: IsolatedHome

function stubSubstrate(): Substrate {
  return {
    start(): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'cores-remote-broker',
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

function bootHome(broker: { origin?: string; secret?: string }): void {
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
      CORES_BROKER_BASE_URL_ENV,
      CORES_BROKER_SECRET_ENV,
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-remote-broker',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
      NEUTRON_CORES_GOOGLE_CLIENT_ID: 'remote-broker-test.apps.googleusercontent.com',
      NEUTRON_CORES_GOOGLE_CLIENT_SECRET: 'remote-broker-test-secret',
      NEUTRON_CONNECT_PUBLIC_BASE_URL: OWN_ORIGIN,
      [CORES_BROKER_BASE_URL_ENV]: broker.origin,
      [CORES_BROKER_SECRET_ENV]: broker.secret,
    },
  })
}

afterEach(() => {
  home.restore()
})

async function compose(): Promise<OpenComposition> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (() => stubSubstrate()) as never,
  })
  return composer({ db, project_slug: 'owner' })
}

test('NEITHER broker env declared → co-located, byte-identical to before the seam', async () => {
  bootHome({})
  const composition = await compose()
  const oauth = composition.cores?.oauth
  expect(oauth).toBeDefined()

  // All three origins are this instance, as they always were.
  expect(oauth?.identityBaseUrl).toBe(OWN_ORIGIN)
  expect(oauth?.ownerBaseUrl).toBe(OWN_ORIGIN)
  expect(oauth?.redirectUri).toBe(`${OWN_ORIGIN}/oauth/cores/google/callback`)
  // And the local broker is SERVED — a self-host is its own broker, which is the
  // only reason a Google grant can complete on an install with no other host.
  expect(composition.cores_oauth_broker_surface).toBeDefined()

  // The secret is the keyfile-derived one: 64 hex chars, and never the declared
  // value (nothing was declared). Asserted by SHAPE, not by value — the test has
  // no business reproducing the derivation, and a secret does not belong in an
  // assertion message.
  expect(oauth?.internalSharedSecret).toMatch(/^[0-9a-f]{64}$/)
}, 60_000)

test('BOTH declared → origins split, secret external, local broker NOT mounted', async () => {
  bootHome({ origin: BROKER_ORIGIN, secret: BROKER_SECRET })
  const composition = await compose()
  const oauth = composition.cores?.oauth
  expect(oauth).toBeDefined()

  // Register goes to the broker, and Google redirects to the broker's one
  // registered URI — the whole reason a central broker exists.
  expect(oauth?.identityBaseUrl).toBe(BROKER_ORIGIN)
  expect(oauth?.redirectUri).toBe(`${BROKER_ORIGIN}/oauth/cores/google/callback`)

  // THE LOAD-BEARING ASSERTION. `ownerBaseUrl` becomes the dispatch_url the
  // broker relays the code back to. Follow the broker here and the callback is
  // undeliverable.
  expect(oauth?.ownerBaseUrl).toBe(OWN_ORIGIN)

  // The secret is the configured, deployment-wide one — not the keyfile
  // derivation, which no other host could possibly reproduce.
  expect(oauth?.internalSharedSecret).toBe(BROKER_SECRET)

  // And this process does NOT stand up a broker surface: it is not the address
  // Google was told to redirect to, so serving one would only be a second
  // register endpoint nobody calls.
  expect(composition.cores_oauth_broker_surface).toBeUndefined()
}, 60_000)

test('a trailing slash or stray path on the broker origin cannot double into the redirect', async () => {
  // The operator has to register the redirect_uri on the OAuth client by hand,
  // so an origin that normalizes differently here than in their console is a
  // redirect_uri_mismatch nobody can trace.
  bootHome({ origin: `${BROKER_ORIGIN}/`, secret: BROKER_SECRET })
  const composition = await compose()
  expect(composition.cores?.oauth?.redirectUri).toBe(
    `${BROKER_ORIGIN}/oauth/cores/google/callback`,
  )
}, 60_000)

test('HALF a declaration refuses to arm rather than silently falling back', async () => {
  // Falling back to co-located would arm this instance as its own broker while
  // the operator believes the central one is in use — and Google would report
  // the mismatch on its own error page, naming nothing on this box.
  bootHome({ origin: BROKER_ORIGIN })
  const composition = await compose()
  expect(composition.cores?.oauth).toBeUndefined()
  expect(composition.cores_oauth_broker_surface).toBeUndefined()
}, 60_000)

test('a broker secret with no origin refuses too — the mirror of the case above', async () => {
  bootHome({ secret: BROKER_SECRET })
  const composition = await compose()
  expect(composition.cores?.oauth).toBeUndefined()
  expect(composition.cores_oauth_broker_surface).toBeUndefined()
}, 60_000)

test('a MALFORMED broker origin refuses — the operator believes it is set', async () => {
  bootHome({ origin: 'identity.example.com', secret: BROKER_SECRET })
  const composition = await compose()
  expect(composition.cores?.oauth).toBeUndefined()
}, 60_000)
