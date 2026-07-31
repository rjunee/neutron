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

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'

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

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const nowIso = new Date().toISOString()
  await db.run(
    `INSERT INTO projects (id, name, description, persona, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, 'Connect Test', NULL, NULL, 'private', 'personal', ?, ?)`,
    [PROJECT_ID, nowIso, nowIso],
  )
  const composer = buildOpenGraphComposer({ env: process.env })
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
