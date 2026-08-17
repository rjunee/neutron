/**
 * ISSUES #494 — a SECOND Google account must not overwrite the first.
 *
 * The grant store already files a grant under `<service>#<account_key>`, and
 * the key is minted from the address the token exchange resolves at Google's
 * userinfo endpoint. But the authorize URL never asked for an identity scope,
 * so userinfo could not answer, every grant was anonymous, every grant for a
 * service landed on the same bare `<service>` label, and connecting a second
 * account REPLACED the first.
 *
 * These tests run the whole causal chain rather than any one link of it:
 *
 *     GET /start  →  the scope on the real authorize URL
 *                 →  what Google's userinfo will answer for that token
 *                 →  POST /ingest  →  how many grants exist
 *
 * The fake Google honours the scope: a token minted from an authorize request
 * that did NOT carry `openid` gets a 401 from userinfo, exactly as the OIDC
 * UserInfo endpoint does. That is what makes this a test of the GUARANTEE and
 * not of its shape — delete `GOOGLE_IDENTITY_SCOPES` from the authorize URL and
 * `two accounts` goes red because the second grant really does clobber the
 * first, not because an assertion happened to name a scope string.
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { installBundledCores } from '../cores/install-bundled.ts'
import { CoresOAuthPendingStore } from '../cores/oauth-pending-store.ts'
import {
  OAuthTokenManager,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  accountKeyFromEmail,
  metaLabel,
  refreshLabel,
  serviceAccountLabel,
} from '../cores/oauth-token-manager.ts'
import {
  createCoresOAuthSurface,
  type CoresOAuthSurface,
} from '../http/cores-oauth-surface.ts'
import { signInternalRequest } from '@neutronai/runtime/internal-signature.ts'
import { openMigratedDatabaseAt } from '../../tests/support/migrated-db.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const OWNER = asOwnerHandle('oauth-identity-test')
const SHARED_SECRET = 'test-shared-secret'
const REDIRECT_URI = 'https://auth.example.test/oauth/cores/google/callback'
const OWNER_BASE_URL = 'https://owner.example.test'
const IDENTITY_BASE_URL = 'https://auth.example.test'
const CALENDAR = 'google_calendar'

const WORK = 'owner-work@example.com'
const PERSONAL = 'owner-personal@example.com'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/**
 * A Google that respects the scope it was asked for.
 *
 * `consent(code, state, email)` is the user picking an account on the consent
 * screen. The token endpoint mints an access token for it and remembers whether
 * the AUTHORIZE request behind that `state` carried the identity scopes; the
 * userinfo endpoint serves the address only when it did, and 401s otherwise —
 * the documented behaviour of the OIDC UserInfo endpoint for a token issued
 * without `openid`.
 */
interface FakeGoogle {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /** Record the scope an authorize URL asked for, keyed by its state. */
  observeAuthorize: (state: string, scope: string) => void
  /** The user picking `email` on the consent screen started by `state`. */
  consent: (code: string, state: string, email: string) => void
  /** Force userinfo to answer 200 with no `email` field (a degraded response). */
  userinfoOmitsEmail: boolean
  identityRegisterCalls: number
}

function makeFakeGoogle(): FakeGoogle {
  const scopeByState = new Map<string, string>()
  const consents = new Map<string, { state: string; email: string }>()
  /** access_token → the address userinfo may serve, or null if it may not. */
  const identityByToken = new Map<string, string | null>()

  const google: FakeGoogle = {
    userinfoOmitsEmail: false,
    identityRegisterCalls: 0,
    observeAuthorize: (state, scope) => {
      scopeByState.set(state, scope)
    },
    consent: (code, state, email) => {
      consents.set(code, { state, email })
    },
    fetch: async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.endsWith('/oauth/cores/pending/register')) {
        google.identityRegisterCalls += 1
        return new Response('{"ok":true}', { status: 200 })
      }
      if (url === GOOGLE_TOKEN_URL) {
        const form = new URLSearchParams(String(init?.body ?? ''))
        if (form.get('grant_type') === 'refresh_token') {
          // A refresh is bound to ITS OWN grant's refresh_token, which is what
          // lets an un-migrated grant keep resolving to its own account.
          return new Response(
            JSON.stringify({
              access_token: `refreshed-${form.get('refresh_token') ?? ''}`,
              expires_in: 3600,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        const code = form.get('code') ?? ''
        const consent = consents.get(code)
        if (consent === undefined) {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        }
        const requested = (scopeByState.get(consent.state) ?? '').split(/\s+/)
        // GOOGLE's rule, spelled out here literally — NEVER derived from our own
        // `GOOGLE_IDENTITY_SCOPES`. Deriving it would make the fake agree with
        // the source by construction: empty the constant and `every()` goes
        // vacuously true, so the test would keep passing while the product broke.
        // (That mutation was run, and it did not red until this was hardcoded.)
        //
        // The UserInfo endpoint serves a token only if it was issued with
        // `openid`, and serves the `email` claim only if the email scope was
        // granted too. Both conditions, and `email` is Google's accepted alias
        // for the `userinfo.email` URI.
        const identityGranted =
          requested.includes('openid') &&
          (requested.includes('https://www.googleapis.com/auth/userinfo.email') ||
            requested.includes('email'))
        const access = `access-${code}`
        identityByToken.set(access, identityGranted ? consent.email : null)
        return new Response(
          JSON.stringify({
            access_token: access,
            refresh_token: `refresh-${code}`,
            expires_in: 3600,
            scope: requested.join(' '),
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === GOOGLE_USERINFO_URL) {
        const headers = (init?.headers ?? {}) as Record<string, string>
        const bearer = String(headers.authorization ?? headers.Authorization ?? '').replace(
          /^Bearer\s+/,
          '',
        )
        const email = identityByToken.get(bearer) ?? null
        if (email === null) {
          return new Response(
            JSON.stringify({
              error: { code: 401, message: 'Request had insufficient authentication scopes.' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        if (google.userinfoOmitsEmail) {
          return new Response(JSON.stringify({ sub: 'anon-subject' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ sub: 'a-subject', email }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('unexpected', { status: 404 })
    },
  }
  return google
}

interface Bench {
  secretsStore: SecretsStore
  tokens: OAuthTokenManager
  surface: CoresOAuthSurface
  google: FakeGoogle
  base: string
}

async function makeBench(): Promise<Bench> {
  const ownerHome = mkdtempSync(join(tmpdir(), 'neutron-oauth-identity-'))
  cleanups.push(() => rmSync(ownerHome, { recursive: true, force: true }))
  const dbDir = join(ownerHome, 'db')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'owner.db')
  const raw = openMigratedDatabaseAt(dbPath)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())

  const secretsStore = new SecretsStore({ data_dir: ownerHome, db })
  const tools = new ToolRegistry()
  const cores = await installBundledCores({
    project_slug: OWNER,
    projectDb: db,
    dataDir: ownerHome,
    tools,
    secretsStore,
    rootDirs: [REPO_ROOT],
  })
  const google = makeFakeGoogle()
  const tokens = new OAuthTokenManager({
    secretsStore,
    owner_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: google.fetch,
  })
  const surface = createCoresOAuthSurface({
    cores,
    pending: new CoresOAuthPendingStore({ db }),
    tokens,
    secretsStore,
    projectDb: db,
    dataDir: ownerHome,
    tools,
    project_slug: OWNER,
    identityBaseUrl: IDENTITY_BASE_URL,
    ownerBaseUrl: OWNER_BASE_URL,
    redirectUri: REDIRECT_URI,
    clientId: 'cid',
    internalSharedSecret: SHARED_SECRET,
    auth: createAppWsAuthResolver({ project_slug: OWNER, bypass: true }),
    fetch: google.fetch as (input: string, init: RequestInit) => Promise<Response>,
  })
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => (await surface.handler(req)) ?? new Response('nf', { status: 404 }),
  })
  cleanups.push(() => server.stop(true).then(() => undefined))
  return {
    secretsStore,
    tokens,
    surface,
    google,
    base: `http://127.0.0.1:${server.port}`,
  }
}

/**
 * Drive one FULL connect: `/start` (real authorize URL) → the user picks
 * `email` on Google's consent screen → `/ingest` (real code exchange). Returns
 * the ingest response so a test can assert it did not blow up.
 */
async function connectAccount(
  bench: Bench,
  email: string,
  labels: string[] = [CALENDAR],
): Promise<{ status: number; body: unknown; authorizeUrl: URL }> {
  const startRes = await fetch(
    `${bench.base}/api/cores/oauth/google/start?labels=${labels.join(',')}`,
    { headers: { authorization: `Bearer dev:${OWNER}` } },
  )
  const started = (await startRes.json()) as { authorize_url: string; state: string }
  const authorizeUrl = new URL(started.authorize_url)
  bench.google.observeAuthorize(started.state, authorizeUrl.searchParams.get('scope') ?? '')

  const code = `code-${started.state}`
  bench.google.consent(code, started.state, email)

  const body = JSON.stringify({ code, state: started.state })
  const timestamp_ms = Date.now()
  const sig = signInternalRequest({
    method: 'POST',
    path: '/api/cores/oauth/google/ingest',
    body,
    shared_secret: SHARED_SECRET,
    timestamp_ms,
  })
  const ingestRes = await fetch(`${bench.base}/api/cores/oauth/google/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-signature': sig,
      'x-internal-timestamp': String(timestamp_ms),
    },
    body,
  })
  return { status: ingestRes.status, body: await ingestRes.json(), authorizeUrl }
}

// ── the guarantee ────────────────────────────────────────────────────────────

test('TWO ACCOUNTS — connecting a second address ADDS a grant, it does not overwrite the first', async () => {
  const bench = await makeBench()

  await connectAccount(bench, WORK)
  const afterFirst = await bench.tokens.listGrants(CALENDAR)
  expect(afterFirst.map((g) => g.email)).toEqual([WORK])

  await connectAccount(bench, PERSONAL)
  const grants = await bench.tokens.listGrants(CALENDAR)

  // TWO grants — the whole point of #494.
  expect(grants).toHaveLength(2)
  expect(grants.map((g) => g.email).sort()).toEqual([PERSONAL, WORK].sort())
  // Each filed under its OWN account key, and neither anonymous.
  expect(grants.every((g) => g.account_key !== null)).toBe(true)
  expect(new Set(grants.map((g) => g.account_key)).size).toBe(2)
  // And BOTH are independently readable — a grant that is listed but whose
  // token no longer resolves is the same outage wearing a different mask.
  const tokensRead = await Promise.all(
    grants.map((g) => bench.tokens.getAccessToken(g.label)),
  )
  expect(new Set(tokensRead).size).toBe(2)
})

test('IDEMPOTENT — the SAME address re-connecting rotates its grant instead of adding one', async () => {
  const bench = await makeBench()

  await connectAccount(bench, WORK)
  await connectAccount(bench, WORK)

  const grants = await bench.tokens.listGrants(CALENDAR)
  expect(grants).toHaveLength(1)
  expect(grants[0]?.label).toBe(serviceAccountLabel(CALENDAR, accountKeyFromEmail(WORK)))
  expect(grants[0]?.email).toBe(WORK)
})

test('DEGRADES SAFELY — a userinfo response with no email does not throw; the grant lands anonymous and readable', async () => {
  const bench = await makeBench()
  bench.google.userinfoOmitsEmail = true

  const result = await connectAccount(bench, WORK)
  expect(result.status).toBe(200)

  const grants = await bench.tokens.listGrants(CALENDAR)
  expect(grants).toHaveLength(1)
  expect(grants[0]?.account_key).toBeNull()
  expect(grants[0]?.label).toBe(CALENDAR)
  // Readable — a degraded IDENTITY must never become a degraded CREDENTIAL.
  expect(await bench.tokens.getAccessToken(CALENDAR)).toBeTruthy()
})

test('the authorize URL asks for identity on EVERY grant, whichever services are being connected', async () => {
  const bench = await makeBench()
  const result = await connectAccount(bench, WORK, [CALENDAR, 'gmail_compose'])
  const scope = (result.authorizeUrl.searchParams.get('scope') ?? '').split(/\s+/)
  // Spelled out, not looped over `GOOGLE_IDENTITY_SCOPES` — an assertion driven
  // by the constant it is checking is vacuous the moment the constant empties.
  expect(scope).toContain('openid')
  expect(scope).toContain('https://www.googleapis.com/auth/userinfo.email')
  // The Cores' own scopes are still there — identity is additive, not a swap.
  expect(scope).toContain('https://www.googleapis.com/auth/calendar')
  // And the consent screen offers an account choice, or a second account is
  // unreachable for an owner with one signed-in Google session.
  expect(result.authorizeUrl.searchParams.get('prompt')?.split(/\s+/)).toContain(
    'select_account',
  )
})

// ── the migration of the grant the owner already has ─────────────────────────

/** Plant the exact row shape #494 produced: a real grant, but ANONYMOUS. */
async function plantAnonymousBareGrant(bench: Bench): Promise<void> {
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: CALENDAR,
    plaintext: 'legacy-access',
    expires_at: Date.now() + 3_600_000,
  })
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: refreshLabel(CALENDAR),
    plaintext: 'legacy-refresh',
  })
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel(CALENDAR),
    plaintext: JSON.stringify({
      scopes: ['https://www.googleapis.com/auth/calendar'],
      email: null,
      connected_at: 1,
      last_refresh_at: null,
      last_refresh_outcome: null,
    }),
  })
}

test('MIGRATION — the anonymous grant the owner already has stays readable until he re-consents', async () => {
  const bench = await makeBench()
  await plantAnonymousBareGrant(bench)

  // Nothing is rewritten at boot: the grant he has right now is the one account.
  const grants = await bench.tokens.listGrants(CALENDAR)
  expect(grants).toHaveLength(1)
  expect(grants[0]?.label).toBe(CALENDAR)
  expect(grants[0]?.account_key).toBeNull()
  expect(await bench.tokens.getAccessToken(CALENDAR)).toBe('legacy-access')
})

test('MIGRATION — re-consenting retires the anonymous grant instead of shadowing it with a phantom account', async () => {
  const bench = await makeBench()
  await plantAnonymousBareGrant(bench)

  await connectAccount(bench, WORK)

  const grants = await bench.tokens.listGrants(CALENDAR)
  // ONE account, not two. An anonymous row can never be identified after the
  // fact, so leaving it would read the same calendar twice, forever.
  expect(grants).toHaveLength(1)
  expect(grants[0]?.label).toBe(serviceAccountLabel(CALENDAR, accountKeyFromEmail(WORK)))
  expect(grants[0]?.email).toBe(WORK)

  // Its refresh + meta rows are gone from the store too — a retired grant must
  // not leave a live refresh_token behind.
  const rows = await bench.secretsStore.list({ owner_handle: OWNER, kind: 'oauth_token' })
  const labels = rows.map((r) => r.label)
  expect(labels).not.toContain(refreshLabel(CALENDAR))
  expect(labels).not.toContain(metaLabel(CALENDAR))
})

test('MIGRATION — an IDENTIFIED bare grant for a DIFFERENT address is never retired, and still resolves to ITS OWN account', async () => {
  const bench = await makeBench()
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: CALENDAR,
    plaintext: 'other-account-access',
    expires_at: Date.now() + 3_600_000,
  })
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: refreshLabel(CALENDAR),
    plaintext: 'personal-refresh',
  })
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel(CALENDAR),
    plaintext: JSON.stringify({
      scopes: [],
      email: PERSONAL,
      connected_at: 1,
      last_refresh_at: null,
      last_refresh_outcome: null,
    }),
  })

  await connectAccount(bench, WORK)

  const grants = await bench.tokens.listGrants(CALENDAR)
  expect(grants).toHaveLength(2)
  expect(grants.map((g) => g.email).sort()).toEqual([PERSONAL, WORK].sort())

  // The DURABLE half of the credential — the refresh_token — is untouched, so
  // the account is still the owner's to read.
  //
  // Its volatile access row is NOT a safe thing to assert on, and the reason is
  // worth stating: on every ingest the Core install lifecycle echoes the token
  // it was handed back under the bare MANIFEST label
  // (`cores/runtime/lifecycle.ts` persistOrRotate), which for a legacy
  // un-keyed grant is that grant's own access row. So immediately after this
  // ingest the bare row transiently holds the just-connected account's token.
  // That is pre-existing behaviour, unrelated to identity scoping, and it
  // self-heals — once the echoed token expires, the refresh below is what runs.
  // Read through a manager whose clock has advanced past that expiry to prove
  // it (a logical clock, not a slept-through real one).
  const later = new OAuthTokenManager({
    secretsStore: bench.secretsStore,
    owner_handle: OWNER,
    client_id: 'cid',
    client_secret: 'csecret',
    fetch: bench.google.fetch,
    now: () => Date.now() + 7_200_000,
  })
  expect(await later.getAccessToken(CALENDAR)).toBe('refreshed-personal-refresh')
})
