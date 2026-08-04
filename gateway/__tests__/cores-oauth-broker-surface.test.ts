/**
 * The Cores OAuth BROKER — the counterpart that never existed.
 *
 * `cores-oauth-surface.ts` has always POSTed its pending state to
 * `/oauth/cores/pending/register` and then sent the owner to Google. Until now
 * that path was served by nothing in either repo — it appeared only in that
 * caller and in a test stub that faked it. That is why three of the nine bundled
 * Cores failed to install on every boot of every install (ISSUES #448).
 *
 * WHY THESE ASSERTIONS AND NOT A HAPPY-PATH SMOKE TEST. The bug being closed is
 * the eighth instance of "the test stood up the thing whose absence was the bug"
 * (SPEC § Decisions Log 2026-08-02). So this suite is deliberately weighted
 * toward the properties that are load-bearing rather than the flow that is
 * obvious: it drives the REAL broker over real HTTP semantics, and the one thing
 * it stubs — `fetch` to the instance's `/ingest` — it stubs in order to READ what
 * the broker sent, and then verifies that payload's signature with the same
 * verifier `/ingest` itself uses. The stub is the assertion target, not a
 * stand-in for the code under test.
 *
 * INSERT-ONLY / SAME-OWNER REGISTER (SPEC § Decisions Log 2026-08-04). Two of
 * the tests below cover the guard that stops a holder of the shared secret from
 * taking an existing routing row over, and they are written to fail in BOTH
 * directions — a rejection that nevertheless wrote is not a rejection, and a
 * guard that also refuses honest retries has broken the reason the upsert
 * exists. Verified by making each change and re-running:
 *   - restore `project_slug = excluded.project_slug` to the conflict clause →
 *     "a DIFFERENT owner cannot take an existing state over" reds (409 → 200).
 *   - over-tighten to `ON CONFLICT(state) DO NOTHING` → "a SAME-OWNER retry
 *     still succeeds" reds (the stored dispatch_url never refreshes).
 *   - over-tighten further so any conflict is refused → the same retry test reds
 *     (200 → 409).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SQLQueryBindings } from 'bun:sqlite'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  signInternalRequest,
  verifyInternalRequest,
} from '@neutronai/runtime/internal-signature.ts'
import {
  BROKER_CALLBACK_PATH,
  BROKER_REGISTER_PATH,
  createCoresOAuthBroker,
  deriveColocatedBrokerSecret,
} from '../http/cores-oauth-broker-surface.ts'

const SECRET = 'broker-shared-secret-for-tests'
const OWNER = 'owner-slug'
const DISPATCH = 'https://owner.example.com/api/cores/oauth/google/ingest'
const BASE = 'https://broker.example.com'

let tmp: string
let db: ProjectDb
/** Every relay the broker attempted, in order. */
let relays: Array<{ url: string; body: string; sig: string; ts: string }>
let relayStatus: number
let relayThrows: boolean
let clock: number

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-oauth-broker-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  relays = []
  relayStatus = 200
  relayThrows = false
  clock = 1_800_000_000_000
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function broker(): { handler: (req: Request) => Promise<Response | null> } {
  return createCoresOAuthBroker({
    db,
    internalSharedSecret: SECRET,
    now: () => clock,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (relayThrows) throw new Error('connection refused')
      const headers = new Headers(init?.headers ?? {})
      relays.push({
        url: String(url),
        body: String(init?.body ?? ''),
        sig: headers.get('x-internal-signature') ?? '',
        ts: headers.get('x-internal-timestamp') ?? '',
      })
      return new Response('{}', { status: relayStatus })
    }) as unknown as typeof globalThis.fetch,
  })
}

/** A correctly-signed register call, as the real instance makes it. */
async function register(
  over: Partial<{ state: string; project_slug: string; dispatch_url: string; expires_at: number }> = {},
  opts: { signature?: string; timestamp?: number } = {},
): Promise<Response> {
  const body = JSON.stringify({
    state: over.state ?? 'state-1',
    project_slug: over.project_slug ?? OWNER,
    dispatch_url: over.dispatch_url ?? DISPATCH,
    expires_at: over.expires_at ?? clock + 600_000,
  })
  const timestamp_ms = opts.timestamp ?? clock
  const sig =
    opts.signature ??
    signInternalRequest({
      method: 'POST',
      path: BROKER_REGISTER_PATH,
      body,
      shared_secret: SECRET,
      timestamp_ms,
    })
  const res = await broker().handler(
    new Request(`${BASE}${BROKER_REGISTER_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': sig,
        'x-internal-timestamp': String(timestamp_ms),
      },
      body,
    }),
  )
  if (res === null) throw new Error('broker did not own the register path')
  return res
}

async function callback(qs: string): Promise<Response> {
  const res = await broker().handler(new Request(`${BASE}${BROKER_CALLBACK_PATH}?${qs}`))
  if (res === null) throw new Error('broker did not own the callback path')
  return res
}

test('the full round trip: register, then Google calls back, and the code reaches the instance', async () => {
  expect((await register()).status).toBe(200)

  const res = await callback('code=auth-code-xyz&state=state-1')
  expect(res.status).toBe(200)

  expect(relays).toHaveLength(1)
  expect(relays[0]!.url).toBe(DISPATCH)
  expect(JSON.parse(relays[0]!.body)).toEqual({ code: 'auth-code-xyz', state: 'state-1' })
})

test('the relay carries a signature the instance ingest will actually accept', async () => {
  await register()
  await callback('code=auth-code-xyz&state=state-1')

  // Verified with the SAME function `/ingest` uses, over the SAME path it
  // verifies against — so a signing-contract drift fails here rather than in
  // production with a 401 nobody can explain.
  const verified = verifyInternalRequest({
    method: 'POST',
    path: '/api/cores/oauth/google/ingest',
    body: relays[0]!.body,
    shared_secret: SECRET,
    supplied_signature: relays[0]!.sig,
    supplied_timestamp_header: relays[0]!.ts,
    now_ms: clock,
  })
  expect(verified.ok).toBe(true)
})

test('an unsigned or wrongly-signed register is refused, and says nothing about why', async () => {
  const res = await register({}, { signature: 'deadbeef' })
  expect(res.status).toBe(401)
  const body = (await res.json()) as { code: string }
  expect(body.code).toBe('unauthorized')

  // And it planted nothing: the callback for that state finds no row.
  const cb = await callback('code=c&state=state-1')
  expect(cb.status).toBe(400)
  expect(relays).toHaveLength(0)
})

test('a state is SINGLE-USE — the second callback relays nothing', async () => {
  await register()
  expect((await callback('code=c1&state=state-1')).status).toBe(200)

  const replay = await callback('code=c1&state=state-1')
  expect(replay.status).toBe(400)
  expect(relays).toHaveLength(1)
})

test('the row is consumed even when the relay fails, so a retry cannot replay it', async () => {
  await register()
  relayThrows = true
  expect((await callback('code=c1&state=state-1')).status).toBe(502)

  // Consume-before-relay is the point: the failed attempt must not leave a
  // usable row behind, or a refused instance becomes a replay window.
  relayThrows = false
  const retry = await callback('code=c1&state=state-1')
  expect(retry.status).toBe(400)
  expect(relays).toHaveLength(0)
})

test('an expired row is refused', async () => {
  await register({ expires_at: clock + 1_000 })
  clock += 60_000
  expect((await callback('code=c1&state=state-1')).status).toBe(400)
  expect(relays).toHaveLength(0)
})

test('the terminal page never echoes the code or the state', async () => {
  await register()
  const html = await (await callback('code=super-secret-code&state=state-1')).text()
  // A grant must not survive a screenshot, a shared URL, or a referrer header.
  expect(html).not.toContain('super-secret-code')
  expect(html).not.toContain('state-1')
})

test('a non-http dispatch_url is refused, so the broker is not an SSRF primitive', async () => {
  const res = await register({ dispatch_url: 'file:///etc/passwd' })
  expect(res.status).toBe(400)
  expect(((await res.json()) as { code: string }).code).toBe('invalid_dispatch_url')
})

test("Google's own error is reported as the owner declining, not as our failure", async () => {
  await register()
  const res = await callback('error=access_denied&state=state-1')
  expect(res.status).toBe(400)
  expect(await res.text()).toContain('access_denied')
  expect(relays).toHaveLength(0)
})

test('paths the broker does not own fall through', async () => {
  expect(await broker().handler(new Request(`${BASE}/oauth/cores/pending/registerX`))).toBeNull()
  expect(await broker().handler(new Request(`${BASE}/api/cores/list`))).toBeNull()
})

test('the broker runs on a RAW bun:sqlite handle too — the cross-deployment claim, asserted', async () => {
  // Managed's central identity host stores state in a raw `bun:sqlite` Database,
  // NOT a ProjectDb. If the broker could only run where a ProjectDb happens to
  // exist, "one flow, two deployments" (SPEC Decisions Log 2026-08-02) would be
  // aspirational and Managed would need a SECOND implementation — the dual code
  // path that decision exists to prevent. So this drives the real broker through
  // the adapter Managed would actually write.
  const raw = db.raw()
  const adapted = {
    get: <R,>(sql: string, params: SQLQueryBindings[]): R | null =>
      (raw.query(sql).get(...(params as never[])) as R | null) ?? null,
    run: async (sql: string, params: SQLQueryBindings[]): Promise<void> => {
      raw.query(sql).run(...(params as never[]))
    },
    runSync: (sql: string, params: SQLQueryBindings[]): unknown =>
      raw.query(sql).run(...(params as never[])),
  }
  const onRaw = createCoresOAuthBroker({
    db: adapted,
    internalSharedSecret: SECRET,
    now: () => clock,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      relays.push({ url: String(url), body: String(init?.body ?? ''), sig: '', ts: '' })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch,
  })

  const body = JSON.stringify({
    state: 'raw-state',
    project_slug: OWNER,
    dispatch_url: DISPATCH,
    expires_at: clock + 600_000,
  })
  const sig = signInternalRequest({
    method: 'POST',
    path: BROKER_REGISTER_PATH,
    body,
    shared_secret: SECRET,
    timestamp_ms: clock,
  })
  const reg = await onRaw.handler(
    new Request(`${BASE}${BROKER_REGISTER_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-signature': sig,
        'x-internal-timestamp': String(clock),
      },
      body,
    }),
  )
  expect(reg?.status).toBe(200)

  const cb = await onRaw.handler(
    new Request(`${BASE}${BROKER_CALLBACK_PATH}?code=raw-code&state=raw-state`),
  )
  expect(cb?.status).toBe(200)
  expect(JSON.parse(relays.at(-1)!.body)).toEqual({ code: 'raw-code', state: 'raw-state' })
})

/** Read the stored routing row straight out of the table, bypassing the broker
 *  — a rejection that nevertheless WROTE must fail these tests, and only the row
 *  itself can prove it did not. */
function storedRow(state: string): { project_slug: string; dispatch_url: string } | null {
  return db.get<{ project_slug: string; dispatch_url: string }>(
    'SELECT project_slug, dispatch_url FROM cores_oauth_broker_pending WHERE state = ?',
    [state],
  )
}

test('a SAME-OWNER retry still succeeds and refreshes the row — idempotency is why the upsert exists', async () => {
  expect((await register()).status).toBe(200)

  // The legitimate retry: same state, same slug, a dispatch_url that moved (the
  // instance's declared origin changed between attempts) and a later expiry.
  const retry = await register({
    dispatch_url: 'https://owner.example.com/api/cores/oauth/google/ingest?v=2',
    expires_at: clock + 900_000,
  })
  expect(retry.status).toBe(200)
  expect(((await retry.json()) as { ok: boolean }).ok).toBe(true)
  expect(storedRow('state-1')).toEqual({
    project_slug: OWNER,
    dispatch_url: 'https://owner.example.com/api/cores/oauth/google/ingest?v=2',
  })

  // And the refreshed row still routes: over-tightening the guard so a
  // legitimate retry stops registering shows up here as a dead callback.
  expect((await callback('code=c-retry&state=state-1')).status).toBe(200)
  expect(relays).toHaveLength(1)
  expect(relays[0]!.url).toBe('https://owner.example.com/api/cores/oauth/google/ingest?v=2')
})

test('a DIFFERENT owner cannot take an existing state over — the row is not mutated at all', async () => {
  expect((await register()).status).toBe(200)

  // The attack the insert-only guard exists to kill: a holder of the shared
  // secret who has learned somebody else's `state` re-registers it under their
  // own slug, pointing the callback at a host they control.
  const stolen = await register({
    project_slug: 'other-owner',
    dispatch_url: 'https://attacker.example.com/api/cores/oauth/google/ingest',
  })
  expect(stolen.status).toBe(409)
  expect((await stolen.json()) as { ok: boolean; code: string }).toEqual({
    ok: false,
    code: 'state_owner_mismatch',
  })

  // THE LOAD-BEARING ASSERTION. A 409 that still wrote is not a rejection — it
  // is the same takeover with a worse status code. Both columns must be
  // untouched, which is what restoring the blind upsert breaks.
  expect(storedRow('state-1')).toEqual({ project_slug: OWNER, dispatch_url: DISPATCH })

  // And the original owner's grant still completes, to its OWN ingest.
  expect((await callback('code=c1&state=state-1')).status).toBe(200)
  expect(relays).toHaveLength(1)
  expect(relays[0]!.url).toBe(DISPATCH)
})

test('an EXPIRED row does not block a later registration of the same state', async () => {
  // The sweep runs before the insert, so a dead row is gone rather than standing
  // as a permanent tombstone that would refuse every future state collision.
  await register({ project_slug: 'first-owner', expires_at: clock + 1_000 })
  clock += 60_000
  const later = await register({ project_slug: 'second-owner' })
  expect(later.status).toBe(200)
  expect(storedRow('state-1')?.project_slug).toBe('second-owner')
})

test('the co-located secret is stable, unguessable, and not the key itself', () => {
  const a = deriveColocatedBrokerSecret('instance-key-material')
  expect(deriveColocatedBrokerSecret('instance-key-material')).toBe(a)
  expect(deriveColocatedBrokerSecret('other-key-material')).not.toBe(a)
  // Never hand the instance's own key material to the signing layer.
  expect(a).not.toContain('instance-key-material')
  expect(a).toHaveLength(64)
})
