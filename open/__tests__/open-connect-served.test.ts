/**
 * Neutron Connect on a SELF-HOSTED OPEN INSTALL — the served-end-to-end gate
 * (ISSUES #421).
 *
 * THE BUG. `connect/` shipped in the public Open repo and no composer ever
 * mounted it: `gateway/composition.ts` built the handler only when
 * `composition.connect_api` was set, its own comment called the file
 * "Managed-classified", and the only platform adapter in the repo declared
 * `connect_api: false`. A self-hoster therefore carried the complete source of a
 * cross-instance API they could never serve — the repo's recurring "module
 * exists, its tests pass, the composer never wires it" defect, at the composer.
 *
 * WHY THIS TEST IS SHAPED THIS WAY. A test that constructed the handler, or
 * asserted the module imports, would have passed at every point during that
 * outage — that is exactly the defect. So this boots the REAL Open composition
 * (`buildOpenGraphComposer` → `composeProductionGraph`) over a live `Bun.serve`
 * and drives HTTP against the composed port, the same as the chat-history and
 * activity-inspector wiring locks. Nothing here is constructed by hand.
 *
 * WHAT IT PINS:
 *   1. ZERO invites → the ENTIRE `/connect/v1` prefix is closed, and closed
 *      means 404 — indistinguishable from an install that never had Connect.
 *      Including `/health`, which would otherwise confirm existence + leak the
 *      slug to an unauthenticated caller.
 *   2. The owner issues an invite through the REAL owner surface
 *      (`POST /api/app/projects/<id>/connect-invites`, which answered 501
 *      `connect_not_configured` on Open before this change) and the SAME running
 *      process serves Connect on the very next request — the gate is evaluated
 *      per request, never latched at boot, so opening it needs no restart.
 *   3. FULL END TO END: a guest redeems that invite at the public handshake,
 *      receives a bearer minted by THIS install's own key, and posts a turn to
 *      `POST /connect/v1/messages` which is accepted (202) and lands as an
 *      inbound audit row. That is the whole point of Connect being served.
 *   4. Revoking the collaborator and expiring the invite CLOSES the surface
 *      again — the state gate is a two-way door, not a one-way latch.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { resolveBootConfig } from '@neutronai/config/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const OWNER = 'owner'
const PROJECT_ID = 'proj-connect-1'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'NEUTRON_CONNECT_PUBLIC_BASE_URL',
  'NEUTRON_PORT',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-connect-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = OWNER
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-connect-test-secret-0123456789'
  process.env['NEUTRON_CONNECT_PUBLIC_BASE_URL'] = 'https://neutron.example.com'
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
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

/**
 * Compose Open the way the boot shell does, optionally passing the FROZEN CONFIG.
 *
 * `open/server.ts` always passes one (`buildOpenGraphComposer({ env, config, … })`),
 * so a harness that omits it is testing a shape production never runs. Most tests
 * here do not care; the invite-origin test does, because the port reaches the
 * composer THROUGH that config and nowhere else.
 */
async function startHarness(opts: { withConfig?: boolean } = {}): Promise<Harness> {
  const db = openMigratedDbAt(process.env['NEUTRON_DB_PATH']!)
  const nowIso = new Date().toISOString()
  await db.run(
    `INSERT INTO projects (id, name, description, persona, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, 'Connect Test', NULL, NULL, 'private', 'personal', ?, ?)`,
    [PROJECT_ID, nowIso, nowIso],
  )
  const composer =
    opts.withConfig === true
      ? buildOpenGraphComposer({ env: process.env, config: resolveBootConfig(process.env) })
      : buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: OWNER })
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

/** Issue an invite through the REAL owner HTTP surface. Returns the raw token. */
async function issueInvite(h: Harness): Promise<{ token: string; acceptUrl: string }> {
  const res = await fetch(`${h.base}/api/app/projects/${PROJECT_ID}/connect-invites`, {
    method: 'POST',
    headers: { authorization: 'Bearer dev:owner', 'content-type': 'application/json' },
    body: JSON.stringify({ delivery: 'link', scope: 'write' }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { accept_url?: string }
  const acceptUrl = body.accept_url ?? ''
  // The raw token rides in the URL fragment and is unrecoverable afterwards.
  const token = acceptUrl.slice(acceptUrl.indexOf('#') + 1)
  expect(token.length).toBeGreaterThan(20)
  return { token, acceptUrl }
}

describe('ISSUES #421 — a self-hosted Open install SERVES Connect, gated on its own state', () => {
  test('ZERO invites: the whole /connect/v1 prefix is CLOSED and reveals nothing', async () => {
    harness = await startHarness()

    // `/health` is the unauthenticated liveness probe; on a closed instance it
    // must not confirm the instance exists nor return its slug.
    const health = await fetch(`${harness.base}/connect/v1/health`)
    expect(health.status).toBe(404)
    expect(await health.text()).not.toContain(OWNER)

    // The public handshake + preview are equally invisible.
    const handshake = await fetch(`${harness.base}/connect/v1/connect/guest-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite_token: 'x', display_name: 'x', guest_handle: 'x' }),
    })
    expect(handshake.status).toBe(404)

    const preview = await fetch(
      `${harness.base}/connect/v1/connect/invite-preview?token_hash=${'a'.repeat(64)}`,
    )
    expect(preview.status).toBe(404)

    // …and closed is byte-identical to any other unrouted path.
    const nonsense = await fetch(`${harness.base}/connect/v1/definitely-not-a-route`)
    expect(nonsense.status).toBe(404)
    expect(await nonsense.text()).toBe(await handshake.text())
  })

  test('the owner issues an invite and the SAME process serves Connect — no restart', async () => {
    harness = await startHarness()

    expect((await fetch(`${harness.base}/connect/v1/health`)).status).toBe(404)

    // The owner surface itself was never wired on Open before this change; it
    // answered 501 connect_not_configured, so the gate could never be opened.
    const { acceptUrl } = await issueInvite(harness)
    expect(acceptUrl.startsWith('https://neutron.example.com/connect/accept#')).toBe(true)

    // Same running server, no reboot: the gate is per-request.
    const health = await fetch(`${harness.base}/connect/v1/health`)
    expect(health.status).toBe(200)
    const body = (await health.json()) as { status?: string; receiving_instance_slug?: string }
    expect(body.status).toBe('ok')
    expect(body.receiving_instance_slug).toBe(OWNER)
  })

  // THE FALLBACK ORIGIN — the case every other test in this file skips past by
  // declaring a public base URL. It is also the ONLY origin a LAN collaborator
  // gets, so the port in it has to be the port this process actually bound.
  //
  // The composer used to build it from `options.config?.port ?? Number(env
  // ['NEUTRON_PORT'] ?? 8787)`. Two defects in one expression, and the harness
  // here reaches both because it passes no `config`: (a) `??` does not fall
  // through on `''`, so a BLANK `NEUTRON_PORT` reached `Number('')`, which is 0
  // rather than NaN, and the invite advertised `:0` — a port nothing serves —
  // while the listener bound 7800; (b) with `NEUTRON_PORT` absent it advertised
  // 8787, which nothing in this tree ever listens on either.
  //
  // Asserted on the ACCEPT URL the owner actually hands out, not on the resolver,
  // because the resolver was never the broken part — the LINE THAT CALLS IT was,
  // and a unit test over the resolver is exactly the proof that passed while this
  // was wrong.
  // THE FALLBACK ORIGIN — the case every other test in this file skips past by
  // declaring a public base URL. It is also the ONLY origin a LAN collaborator
  // gets, so the port in it has to be the port this process actually bound.
  //
  // The composer built it from `options.config?.port ?? Number(env['NEUTRON_PORT']
  // ?? 8787)`. Two defects in one expression, and this harness reaches both:
  //   (a) `??` does not fall through on `''`, so a BLANK `NEUTRON_PORT` reached
  //       `Number('')` — which is 0, not NaN — and the invite advertised `:0`, a
  //       port nothing serves, while the listener bound 7800;
  //   (b) with `NEUTRON_PORT` ABSENT it advertised 8787, a port nothing in this
  //       tree ever listens on.
  //
  // Asserted on the ACCEPT URL the owner actually hands out rather than on
  // `resolveConnectBaseUrlWithSource`, because the resolver was never the broken
  // part — the LINE THAT CALLS IT was, and a unit test over the resolver is
  // exactly the proof that stayed green while this was wrong. Composed WITH the
  // frozen config because `open/server.ts` always passes one, so the port travels
  // its real route: `resolveBootConfig` -> `config.port` -> this fallback.
  //
  // ONE HARNESS PER TEST, deliberately: `beforeEach` mints one temp dir and one
  // database, and `startHarness` inserts a fixed project id, so a loop that
  // composes twice inside one test dies on `UNIQUE constraint failed: projects.id`
  // (hit while writing this). Split cases also name which input regressed.
  test('fallback origin: an ABSENT NEUTRON_PORT advertises the bound default, not the phantom 8787', async () => {
    delete process.env['NEUTRON_CONNECT_PUBLIC_BASE_URL']
    delete process.env['NEUTRON_PORT']
    harness = await startHarness({ withConfig: true })
    const { acceptUrl } = await issueInvite(harness)
    expect(new URL(acceptUrl).origin).toBe('http://127.0.0.1:7800')
    expect(acceptUrl).not.toContain('8787')
  })

  test('fallback origin: an EMPTY NEUTRON_PORT does not coerce to :0 — the pre-existing live defect', async () => {
    delete process.env['NEUTRON_CONNECT_PUBLIC_BASE_URL']
    process.env['NEUTRON_PORT'] = ''
    harness = await startHarness({ withConfig: true })
    const { acceptUrl } = await issueInvite(harness)
    expect(new URL(acceptUrl).origin).toBe('http://127.0.0.1:7800')
    // Named rather than left to the equality above: `:0` is the specific wrong
    // value, and it is wrong in a way the owner cannot see from this box — the
    // server is up and only the link they handed out is dead.
    expect(acceptUrl).not.toContain('127.0.0.1:0')
  })

  test('fallback origin: a WHITESPACE-ONLY NEUTRON_PORT reaches the same answer, and does not brick the boot', async () => {
    delete process.env['NEUTRON_CONNECT_PUBLIC_BASE_URL']
    process.env['NEUTRON_PORT'] = '   '
    // This composes at all only because `optionalIntKnob` now reads a blank as
    // unset; before that `resolveBootConfig` threw here. So this case pins BOTH
    // halves — the parse and the origin it feeds.
    harness = await startHarness({ withConfig: true })
    const { acceptUrl } = await issueInvite(harness)
    expect(new URL(acceptUrl).origin).toBe('http://127.0.0.1:7800')
    expect(acceptUrl).not.toContain('127.0.0.1:0')
  })

  test('fallback origin CONTROL: a REAL NEUTRON_PORT still reaches the invite', async () => {
    // Without this, every assertion above would also pass for a composer that
    // hardcoded 7800 and ignored the environment entirely.
    delete process.env['NEUTRON_CONNECT_PUBLIC_BASE_URL']
    process.env['NEUTRON_PORT'] = '9123'
    harness = await startHarness({ withConfig: true })
    expect(new URL((await issueInvite(harness)).acceptUrl).origin).toBe('http://127.0.0.1:9123')
  })

  test('fallback origin CONTROL: a DECLARED public base URL still wins over the derived one', async () => {
    process.env['NEUTRON_CONNECT_PUBLIC_BASE_URL'] = 'https://connect.example.com'
    process.env['NEUTRON_PORT'] = '9123'
    harness = await startHarness({ withConfig: true })
    expect(new URL((await issueInvite(harness)).acceptUrl).origin).toBe(
      'https://connect.example.com',
    )
  })

  test('END TO END: a guest redeems the invite and posts a turn that is accepted', async () => {
    harness = await startHarness()
    const { token } = await issueInvite(harness)

    // The public, non-consuming preview renders before the guest commits.
    const tokenHash = new Bun.CryptoHasher('sha256').update(token, 'utf8').digest('hex')
    const preview = await fetch(
      `${harness.base}/connect/v1/connect/invite-preview?token_hash=${tokenHash}`,
    )
    expect(preview.status).toBe(200)

    // The single-use handshake: claim the invite, create the member, mint a
    // bearer signed by THIS install's own key.
    const authRes = await fetch(`${harness.base}/connect/v1/connect/guest-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invite_token: token,
        display_name: 'Guest Collaborator',
        guest_handle: 'guest.example.com',
      }),
    })
    expect(authRes.status).toBe(200)
    const auth = (await authRes.json()) as {
      token?: string
      origin_instance_slug?: string
      local_slug?: string
      role?: string
    }
    expect(typeof auth.token).toBe('string')
    expect(auth.role).toBe('collaborator')
    const bearer = auth.token!
    const originSlug = auth.origin_instance_slug!

    // Replay is refused — single use.
    const replay = await fetch(`${harness.base}/connect/v1/connect/guest-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invite_token: token,
        display_name: 'Impostor',
        guest_handle: 'evil.example.com',
      }),
    })
    expect(replay.status).toBe(409)

    // The bearer this install minted validates against this install's OWN JWKS.
    const post = await fetch(`${harness.base}/connect/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'x-origin-instance': originSlug,
      },
      body: JSON.stringify({
        origin_instance: originSlug,
        payload: {
          topic_id: 'web:owner',
          speaker_user_id: 'guest-1',
          body: 'hello from a self-hosted collaborator',
        },
      }),
    })
    expect(post.status).toBe(202)
    const ack = (await post.json()) as { ack_id?: string }
    expect(typeof ack.ack_id).toBe('string')

    // The turn is durably recorded, attributed to the member's assigned slug —
    // never the raw caller slug.
    const row = harness.db
      .prepare<{ origin_instance_slug: string; author_display: string }, [string]>(
        `SELECT origin_instance_slug, author_display FROM inbound_messages WHERE ack_id = ?`,
      )
      .get(ack.ack_id!)
    expect(row?.origin_instance_slug).toBe(auth.local_slug)
    expect(row?.author_display).toBe('Guest Collaborator')

    // An unsigned / forged bearer is refused by the same middleware.
    const forged = await fetch(`${harness.base}/connect/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer not.a.jwt',
        'content-type': 'application/json',
        'x-origin-instance': originSlug,
      },
      body: JSON.stringify({ origin_instance: originSlug, payload: {} }),
    })
    expect(forged.status).toBe(401)
  })

  test('revoking the last collaborator and expiring the invite CLOSES the surface again', async () => {
    harness = await startHarness()
    const { token } = await issueInvite(harness)
    const authRes = await fetch(`${harness.base}/connect/v1/connect/guest-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invite_token: token,
        display_name: 'Guest Collaborator',
        guest_handle: 'guest.example.com',
      }),
    })
    expect(authRes.status).toBe(200)
    const { local_slug } = (await authRes.json()) as { local_slug: string }

    // Redeeming consumed the only invite, but the member it admitted keeps the
    // surface open — otherwise the handshake would slam the door on its own guest.
    expect((await fetch(`${harness.base}/connect/v1/health`)).status).toBe(200)

    // Revoke through the REAL owner surface.
    const members = await fetch(
      `${harness.base}/api/app/projects/${PROJECT_ID}/connect-members`,
      { headers: { authorization: 'Bearer dev:owner' } },
    )
    expect(members.status).toBe(200)
    expect(JSON.stringify(await members.json())).toContain(local_slug)

    const revoke = await fetch(
      `${harness.base}/api/app/projects/${PROJECT_ID}/connect-members/${local_slug}/revoke`,
      { method: 'POST', headers: { authorization: 'Bearer dev:owner' } },
    )
    expect(revoke.status).toBe(200)

    // No live invite, no non-revoked member → the surface disappears, same
    // process, no restart.
    expect((await fetch(`${harness.base}/connect/v1/health`)).status).toBe(404)

    // And the revoked collaborator's own bearer no longer reaches anything.
    expect(
      (
        await fetch(`${harness.base}/connect/v1/messages`, {
          method: 'POST',
          headers: { authorization: 'Bearer whatever', 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404)
  })

  test('an EXPIRED invite does not hold the surface open', async () => {
    harness = await startHarness()
    await harness.db.run(
      `INSERT INTO connect_guest_invites
         (token_hash, project_id, display_name_hint, access,
          created_at_ms, expires_at_ms, redeemed_at_ms, redeemed_by_slug)
       VALUES (?, ?, NULL, 'write', ?, ?, NULL, NULL)`,
      ['c'.repeat(64), PROJECT_ID, Date.now() - 10_000, Date.now() - 1_000],
    )
    expect((await fetch(`${harness.base}/connect/v1/health`)).status).toBe(404)
  })
})

/**
 * ISSUES #421 residual — AN INVITE CAN BE REVOKED.
 *
 * THE DEFECT. `ConnectGuestInviteStore` had no revoke method: an invite closed
 * when the guest spent it or when the 7-day TTL elapsed, and by no other means.
 * So an owner who sent a link to the wrong address could not take it back.
 *
 * WHY THAT WAS WORSE THAN ONE UNWANTED GUEST. The surface gate opens the WHOLE
 * `/connect/v1` prefix while a live invite exists. An unwanted outstanding invite
 * therefore held a cross-boundary API reachable from the internet for a week.
 *
 * WHY THESE TESTS ARE SHAPED THIS WAY. A test that called `store.revoke` and
 * then called `connectSurfaceIsOpen` would prove the predicate and nothing else —
 * it would have passed just as happily with the owner route unmounted, which is
 * the "module exists, the composer never wires it" defect this whole issue is
 * about. So every assertion below drives HTTP at the REAL composed Open surface
 * over the live `Bun.serve` harness: the owner revokes through the route the app
 * actually calls, and the surface's closure is observed from outside.
 */
describe('ISSUES #421 residual — the owner can WITHDRAW an invite', () => {
  test('revoking the last live invite CLOSES the composed surface, same process', async () => {
    harness = await startHarness()

    // Closed before, open after — the precondition, so the closure below cannot
    // be a surface that was never open.
    expect((await fetch(`${harness.base}/connect/v1/health`)).status).toBe(404)
    await issueInvite(harness)
    expect((await fetch(`${harness.base}/connect/v1/health`)).status).toBe(200)

    // The owner reads their ledger through the real route. This read is what
    // makes revocation usable at all: the raw token is unrecoverable after
    // issuance, so without it there is no handle to name.
    const ledger = await fetch(
      `${harness.base}/api/app/projects/${PROJECT_ID}/connect-invites`,
      { headers: { authorization: 'Bearer dev:owner' } },
    )
    expect(ledger.status).toBe(200)
    const { invites } = (await ledger.json()) as {
      invites: Array<{ invite_id: string; state: string }>
    }
    expect(invites.length).toBe(1)
    expect(invites[0]!.state).toBe('live')

    const revoke = await fetch(
      `${harness.base}/api/app/projects/${PROJECT_ID}/connect-invites/${invites[0]!.invite_id}/revoke`,
      { method: 'POST', headers: { authorization: 'Bearer dev:owner' } },
    )
    expect(revoke.status).toBe(200)
    expect((await revoke.json()) as { revoked: boolean; state: string }).toMatchObject({
      revoked: true,
      state: 'live',
    })

    // THE POINT: no live invite, no collaborator → the whole prefix disappears
    // on the very next request. No restart, no latch.
    expect((await fetch(`${harness.base}/connect/v1/health`)).status).toBe(404)

    // And closed is still byte-identical to an unrouted path, exactly as it is
    // for an install that never had Connect.
    const closed = await fetch(`${harness.base}/connect/v1/health`)
    const nonsense = await fetch(`${harness.base}/connect/v1/definitely-not-a-route`)
    expect(await closed.text()).toBe(await nonsense.text())
  })

  test('a REVOKED token is refused at the handshake, and looks exactly like an expired one', async () => {
    harness = await startHarness()
    const { token } = await issueInvite(harness)
    const hashOf = (raw: string): string =>
      new Bun.CryptoHasher('sha256').update(raw, 'utf8').digest('hex')

    // A SECOND invite keeps the surface open after the first is withdrawn, so
    // the handshake below is refused on its own merits rather than by a closed
    // gate returning 404 for everything.
    const other = await issueInvite(harness)

    const revoke = await fetch(
      `${harness.base}/api/app/projects/${PROJECT_ID}/connect-invites/${hashOf(token)}/revoke`,
      { method: 'POST', headers: { authorization: 'Bearer dev:owner' } },
    )
    expect(revoke.status).toBe(200)
    expect((await fetch(`${harness.base}/connect/v1/health`)).status).toBe(200)

    // The revoked token no longer redeems.
    const refused = await fetch(`${harness.base}/connect/v1/connect/guest-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invite_token: token,
        display_name: 'Guest Collaborator',
        guest_handle: 'guest.example.com',
      }),
    })
    expect(refused.status).toBe(410)

    // NOT A NEW ORACLE: the response is byte-identical to a genuinely expired
    // invite's. Seed one directly at the DB (there is no way to age the clock on
    // a composed surface) and compare the actual bytes.
    await harness.db.run(
      `INSERT INTO connect_guest_invites
         (token_hash, project_id, display_name_hint, access,
          created_at_ms, expires_at_ms, redeemed_at_ms, redeemed_by_slug)
       VALUES (?, ?, NULL, 'write', ?, ?, NULL, NULL)`,
      [hashOf('aged-out-token'), PROJECT_ID, Date.now() - 10_000, Date.now() - 1_000],
    )
    const aged = await fetch(`${harness.base}/connect/v1/connect/guest-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invite_token: 'aged-out-token',
        display_name: 'Guest Collaborator',
        guest_handle: 'guest.example.com',
      }),
    })
    expect(aged.status).toBe(refused.status)
    expect(await aged.text()).toBe(await refused.text())

    // Same collapse on the read side: the preview a revoked holder gets is the
    // one an already-spent invite gets.
    const revokedPreview = await fetch(
      `${harness.base}/connect/v1/connect/invite-preview?token_hash=${hashOf(token)}`,
    )
    expect(revokedPreview.status).toBe(410)

    // The UNTOUCHED second invite still works — revocation is per-invite, not a
    // switch that kills the feature.
    const ok = await fetch(`${harness.base}/connect/v1/connect/guest-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invite_token: other.token,
        display_name: 'Guest Collaborator',
        guest_handle: 'guest.example.com',
      }),
    })
    expect(ok.status).toBe(200)
  })

  test('revoking is idempotent and cannot reach an invite on a project the caller did not name', async () => {
    harness = await startHarness()
    const { token } = await issueInvite(harness)
    const inviteId = new Bun.CryptoHasher('sha256').update(token, 'utf8').digest('hex')
    const revokeUrl = (project: string): string =>
      `${harness!.base}/api/app/projects/${project}/connect-invites/${inviteId}/revoke`
    const post = (url: string): Promise<Response> =>
      fetch(url, { method: 'POST', headers: { authorization: 'Bearer dev:owner' } })

    const first = await post(revokeUrl(PROJECT_ID))
    expect(((await first.json()) as { revoked: boolean }).revoked).toBe(true)

    // Second call: a no-op that reports it, never an error and never a second
    // timestamp rewrite.
    const second = await post(revokeUrl(PROJECT_ID))
    expect(second.status).toBe(200)
    expect((await second.json()) as { revoked: boolean; state: string }).toMatchObject({
      revoked: false,
      state: 'revoked',
    })

    // The id is a primary key, so naming the wrong project must not find it.
    await harness.db.run(
      `INSERT INTO projects (id, name, description, persona, privacy_mode, billing_mode, created_at, updated_at)
       VALUES ('proj-other', 'Other', NULL, NULL, 'private', 'personal', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()],
    )
    expect((await post(revokeUrl('proj-other'))).status).toBe(404)

    // An unauthenticated caller cannot revoke anything.
    expect(
      (await fetch(revokeUrl(PROJECT_ID), { method: 'POST' })).status,
    ).toBe(401)
  })
})

/**
 * ISSUES #421 residual — the accept page pointed guests at `/terms` and
 * `/privacy`, which no Neutron install serves, under a line asserting agreement
 * to documents that do not exist. Both were live to every guest from the moment
 * the page was mounted.
 */
describe('ISSUES #421 residual — the accept page cites no absent documents', () => {
  test('the SERVED page has no /terms or /privacy link', async () => {
    harness = await startHarness()
    const html = await (
      await fetch(`${harness.base}/connect/accept`, { headers: BROWSER_HEADERS })
    ).text()

    expect(html).not.toContain('href="/terms"')
    expect(html).not.toContain('href="/privacy"')

    // Stronger than the two literals: the page must not link anywhere this
    // server does not serve. Assert every href it renders actually resolves.
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!)
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) {
      if (!href.startsWith('/')) continue
      const res = await fetch(`${harness.base}${href}`, { headers: BROWSER_HEADERS })
      expect({ href, status: res.status }).toEqual({ href, status: 200 })
    }

    // The mandatory, project-specific disclosure is still what gates the join —
    // it was always the real agreement, and it is not being removed with the
    // dead links.
    const js = await (await fetch(`${harness.base}/connect/accept.js`)).text()
    expect(js).toContain('I understand where this project lives')
  })
})

/**
 * ISSUES #421 (residual) — THE PAGE A GUEST ACTUALLY LANDS ON.
 *
 * The API above was proven end to end while the guest-facing surface was
 * unreachable: `landing/connect-accept.ts` + `connect-accept.html` were imported
 * ONLY by their own jsdom test, and no route mounted them. The owner's invite
 * link is `<base>/connect/accept#<token>`, so a guest who clicked it got the
 * default 404 — the same "module exists, its tests pass, the composer never
 * wires it" defect the API half of #421 fixed.
 *
 * A test that imported the module, or asserted a handler was constructed, would
 * have passed throughout that outage. So these drive a browser-shaped GET at the
 * REAL composed Open surface over the live `Bun.serve` harness above, and pass
 * only if a route actually mounts the page.
 */
const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
} as const

describe('ISSUES #421 residual — the guest accept page is SERVED by the composed surface', () => {
  test('a browser-shaped GET of the real invite link returns the accept page', async () => {
    harness = await startHarness()
    const { token, acceptUrl } = await issueInvite(harness)

    // The link the owner sends. Its path is what a browser requests; the token
    // is in the FRAGMENT, which is never transmitted — assert the shape rather
    // than trusting the comment: no query string, token after the `#`.
    const link = new URL(acceptUrl)
    expect(link.pathname).toBe('/connect/accept')
    expect(link.search).toBe('')
    expect(link.hash).toBe(`#${token}`)

    // Drive the SAME path at the composed surface. `fetch` drops the fragment
    // exactly as a browser's request line does, so the server sees a bare
    // `GET /connect/accept`.
    const res = await fetch(`${harness.base}${link.pathname}`, { headers: BROWSER_HEADERS })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const html = await res.text()
    // The real page, not some other surface's shell: its form controls are the
    // ids `connect-accept.ts:bootConnectAcceptFromHash` looks up, and it loads
    // the client bundle.
    for (const id of ['disclosure', 'display-name', 'guest-handle', 'btn-accept', 'status', 'title', 'lede']) {
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).toContain('src="/connect/accept.js"')
    // The page is token-free: nothing server-side ever saw the token, so it
    // cannot have been echoed into the bytes.
    expect(html).not.toContain(token)

    // …and the client bundle it references resolves, or the page is inert.
    const js = await fetch(`${harness.base}/connect/accept.js`, {
      headers: { accept: '*/*', 'user-agent': BROWSER_HEADERS['user-agent'] },
    })
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('javascript')
    const src = await js.text()
    // The bundle carries the flow: the hash-only preview read, the single-use
    // handshake, and the disclosure renderer bundled in from connect-disclosure.
    expect(src).toContain('/connect/v1/connect/invite-preview')
    expect(src).toContain('/connect/v1/connect/guest-auth')
    expect(src).toContain('window.location.hash')
  })

  test('the page is served with the connect surface CLOSED — it is not a state oracle', async () => {
    harness = await startHarness()

    // Zero invites, zero members: the API prefix is invisible.
    expect((await fetch(`${harness.base}/connect/v1/health`)).status).toBe(404)

    // The page is static bytes, so it still serves. Gating it would make
    // `GET /connect/accept` a free, unauthenticated probe of the very state the
    // surface gate exists to conceal.
    const closed = await fetch(`${harness.base}/connect/accept`, { headers: BROWSER_HEADERS })
    expect(closed.status).toBe(200)
    const closedHtml = await closed.text()

    // Open the surface for real, then re-request: BYTE-IDENTICAL. Observing the
    // page tells an outsider nothing about whether an invite is live.
    await issueInvite(harness)
    expect((await fetch(`${harness.base}/connect/v1/health`)).status).toBe(200)
    const open = await fetch(`${harness.base}/connect/accept`, { headers: BROWSER_HEADERS })
    expect(open.status).toBe(200)
    expect(await open.text()).toBe(closedHtml)
  })

  test('a dead token gets a useful message, and only from the gated API', async () => {
    harness = await startHarness()
    const { token } = await issueInvite(harness)
    const hashOf = (raw: string): string =>
      new Bun.CryptoHasher('sha256').update(raw, 'utf8').digest('hex')

    // Redeem it, so the token is now single-use-consumed.
    const redeem = await fetch(`${harness.base}/connect/v1/connect/guest-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invite_token: token,
        display_name: 'Guest Collaborator',
        guest_handle: 'guest.example.com',
      }),
    })
    expect(redeem.status).toBe(200)

    // The page itself is unchanged — it has no idea which token the guest holds.
    expect((await fetch(`${harness.base}/connect/accept`, { headers: BROWSER_HEADERS })).status).toBe(200)

    // The verdict comes from the preview read the page performs client-side.
    // Already-redeemed → 410, which the client renders as "expired or already
    // been used. Ask the inviter for a fresh link."
    const spent = await fetch(
      `${harness.base}/connect/v1/connect/invite-preview?token_hash=${hashOf(token)}`,
    )
    expect(spent.status).toBe(410)

    // A token that never existed → an equally detail-free 404, which the client
    // renders as "This invite link is not valid." Neither response carries a
    // field about the project, the owner, or the invite.
    const bogus = await fetch(
      `${harness.base}/connect/v1/connect/invite-preview?token_hash=${hashOf('no-such-token')}`,
    )
    expect(bogus.status).toBe(404)
    for (const r of [spent, bogus]) {
      const body = await r.text()
      expect(body).not.toContain('Connect Test') // the project name
      expect(body).not.toContain(OWNER)
    }
  })
})
