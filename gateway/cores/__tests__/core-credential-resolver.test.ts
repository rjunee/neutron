import { asOwnerHandle } from '@neutronai/persistence/index.ts'
/**
 * D2 (2026-07-01) — CoreCredentialResolver wiring tests.
 *
 * Proves the brief's "done" definition against a REAL `ProjectCredentialStore`
 * (in-memory SQLite + the shared AES crypto) and a fake OAuth manager:
 *   - a per-project cred is USED when set for the active project;
 *   - falls back to the GLOBAL default when no project row;
 *   - Email/Calendar stay GLOBAL scope (a per-project row is IGNORED) —
 *     no regression to the working inbox/calendar;
 *   - the legacy Google OAuthTokenManager is the global fallback for the
 *     three Google labels when `project_credentials` has no row;
 *   - `accessorFor` reads the ACTIVE project from the ambient
 *     `runWithActiveProject` frame at call time.
 */

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import type { OAuthTokenManager } from '../oauth-token-manager.ts'
import { CoreCredentialResolver, scopeForService } from '../core-credential-resolver.ts'
import { runWithActiveProject } from '../active-project-context.ts'

const OWNER = asOwnerHandle('cred-resolver-test')
const PROJECT = 'proj-alpha'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeStore(): ProjectCredentialStore {
  const owner_home = mkdtempSync(join(tmpdir(), 'cred-resolver-'))
  cleanups.push(() => rmSync(owner_home, { recursive: true, force: true }))
  const dbPath = join(owner_home, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secretsStore = new SecretsStore({ data_dir: owner_home, db })
  return new ProjectCredentialStore(db, { crypto: secretsStore })
}

/** A fake OAuthTokenManager that returns a fixed token per label (the global grant). */
function fakeOAuth(byLabel: Record<string, string | null>): OAuthTokenManager {
  return {
    getAccessToken: async (label: string): Promise<string | null> => byLabel[label] ?? null,
  } as unknown as OAuthTokenManager
}

// ── Scope policy ─────────────────────────────────────────────────────────────

test('scope policy: Email/Calendar are GLOBAL, Workspace + static tokens are per-project', () => {
  expect(scopeForService('gmail_compose')).toBe('global')
  expect(scopeForService('google_calendar')).toBe('global')
  expect(scopeForService('google_workspace')).toBe('project')
  expect(scopeForService('meta_ads')).toBe('project') // default for any static service
})

// ── Per-project override ─────────────────────────────────────────────────────

test('per-project override: a project’s own Drive token wins over the global default', async () => {
  const store = makeStore()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  await store.set(OWNER, {
    service: 'google_workspace',
    plaintext: 'project-drive',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })

  expect(await resolver.resolve('google_workspace', { projectId: PROJECT })).toBe('project-drive')
})

test('global fallback: no project row → the global default is used', async () => {
  const store = makeStore()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })

  expect(await resolver.resolve('google_workspace', { projectId: PROJECT })).toBe('global-drive')
})

test('static service token: per-project → global → unset', async () => {
  const store = makeStore()
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })

  // unset
  expect(await resolver.resolve('meta_ads', { projectId: PROJECT })).toBeNull()
  // global fallback
  await store.set(OWNER, { service: 'meta_ads', plaintext: 'global-meta', scope: 'global' })
  expect(await resolver.resolve('meta_ads', { projectId: PROJECT })).toBe('global-meta')
  // per-project override
  await store.set(OWNER, {
    service: 'meta_ads',
    plaintext: 'project-meta',
    scope: 'project',
    project_id: PROJECT,
  })
  expect(await resolver.resolve('meta_ads', { projectId: PROJECT })).toBe('project-meta')
})

// ── Email/Calendar stay GLOBAL (no regression) ───────────────────────────────

test('Email/Calendar no-regression: a per-project row is IGNORED — global scope forced', async () => {
  const store = makeStore()
  // Someone sets a per-project gmail/calendar row; it MUST NOT shadow the grant.
  await store.set(OWNER, {
    service: 'gmail_compose',
    plaintext: 'project-should-be-ignored',
    scope: 'project',
    project_id: PROJECT,
  })
  await store.set(OWNER, {
    service: 'google_calendar',
    plaintext: 'project-should-be-ignored',
    scope: 'project',
    project_id: PROJECT,
  })
  // The live grant lives in the OAuth manager (global).
  const resolver = new CoreCredentialResolver({
    owner_slug: OWNER,
    store,
    oauthTokens: fakeOAuth({ gmail_compose: 'oauth-gmail', google_calendar: 'oauth-cal' }),
  })

  expect(await resolver.resolve('gmail_compose', { projectId: PROJECT })).toBe('oauth-gmail')
  expect(await resolver.resolve('google_calendar', { projectId: PROJECT })).toBe('oauth-cal')
})

test('Email/Calendar GLOBAL project_credentials row still applies (uniform plumbing)', async () => {
  const store = makeStore()
  await store.set(OWNER, { service: 'gmail_compose', plaintext: 'global-override', scope: 'global' })
  const resolver = new CoreCredentialResolver({
    owner_slug: OWNER,
    store,
    oauthTokens: fakeOAuth({ gmail_compose: 'oauth-gmail' }),
  })
  // A global project_credentials row (step 1) wins over the OAuth fallback (step 2).
  expect(await resolver.resolve('gmail_compose', { projectId: PROJECT })).toBe('global-override')
})

// ── Legacy Google OAuth fallback ─────────────────────────────────────────────

test('legacy fallback: no project_credentials row → OAuthTokenManager supplies the Google token', async () => {
  const store = makeStore()
  const resolver = new CoreCredentialResolver({
    owner_slug: OWNER,
    store,
    oauthTokens: fakeOAuth({ google_workspace: 'oauth-drive' }),
  })
  // Workspace with no pasted token falls through project_credentials to the OAuth grant.
  expect(await resolver.resolve('google_workspace', { projectId: PROJECT })).toBe('oauth-drive')
})

test('unset: no project_credentials row + no OAuth grant → null (Core renders empty state)', async () => {
  const store = makeStore()
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: fakeOAuth({}) })
  expect(await resolver.resolve('google_workspace', { projectId: PROJECT })).toBeNull()
  expect(await resolver.resolve('meta_ads', { projectId: PROJECT })).toBeNull()
})

// ── accessorFor reads ambient active-project context ─────────────────────────

test('accessorFor reads the ACTIVE project from the ambient runWithActiveProject frame', async () => {
  const store = makeStore()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  await store.set(OWNER, {
    service: 'google_workspace',
    plaintext: 'project-drive',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })
  const accessor = resolver.accessorFor('google_workspace')

  // Bound to the project → per-project token.
  const inProject = await runWithActiveProject(PROJECT, () => accessor())
  expect(inProject).toBe('project-drive')

  // No frame (General topic) → global default.
  const noFrame = await accessor()
  expect(noFrame).toBe('global-drive')

  // Bound to a different project with no row → global default.
  const otherProject = await runWithActiveProject('proj-beta', () => accessor())
  expect(otherProject).toBe('global-drive')
})

test('accessorFor fail-soft: a resolver throw becomes null (Core degrades, never crashes)', async () => {
  const store = makeStore()
  const throwingOAuth = {
    getAccessToken: async (): Promise<string | null> => {
      throw new Error('token endpoint down')
    },
  } as unknown as OAuthTokenManager
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: throwingOAuth })
  // google_workspace has no project_credentials row → hits the throwing OAuth fallback.
  expect(await resolver.accessorFor('google_workspace')()).toBeNull()
})

// ── 2026-05-12 rename-regression (behavioral) ────────────────────────────────
// Proves the composition seam keys credentials on the FROZEN owner handle: a
// value written under the frozen handle is invisible when the resolver is keyed
// on the (post-rename) mutable url_slug — the exact silent-credential-loss the
// OwnerHandle brand exists to prevent, demonstrated at runtime (not just types).
test('rename regression: a credential written under the frozen handle is NOT readable under a renamed url_slug', async () => {
  const store = makeStore()
  const FROZEN = asOwnerHandle('acme-frozen-handle')
  const RENAMED_URL_SLUG = asOwnerHandle('acme-renamed') // what a rename would canonicalise the url_slug to

  // Seed a global service token under the FROZEN handle (the provisioning shape).
  await store.set(FROZEN, { service: 'meta_ads', plaintext: 'secret-token', scope: 'global' })

  // The resolver keyed on the FROZEN handle finds it.
  const frozenResolver = new CoreCredentialResolver({ owner_slug: FROZEN, store, oauthTokens: null })
  expect(await frozenResolver.resolve('meta_ads')).toBe('secret-token')

  // The resolver keyed on the RENAMED url_slug misses entirely — the 2026-05-12
  // outage. The brand makes constructing this wrong resolver require an explicit
  // asOwnerHandle of a value known to be the url_slug (a code smell), but if it
  // happens the credential is silently absent, exactly as this test pins.
  const renamedResolver = new CoreCredentialResolver({ owner_slug: RENAMED_URL_SLUG, store, oauthTokens: null })
  expect(await renamedResolver.resolve('meta_ads')).toBeNull()

  // And the store itself keys on the exact handle (direct assertion).
  expect(store.resolve(FROZEN, undefined, 'meta_ads')?.plaintext).toBe('secret-token')
  expect(store.resolve(RENAMED_URL_SLUG, undefined, 'meta_ads')).toBeNull()
})
