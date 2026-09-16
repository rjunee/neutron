import { asOwnerHandle } from '@neutronai/persistence/index.ts'
/**
 * X6 (2026-07-15) — per-project credential scoping on the agent's NATIVE TOOL
 * PATH.
 *
 * The flagship "agentic per-project" direction requires that when the agent
 * invokes a Core tool, that tool's credential resolves against the composing
 * turn's project — not the instance-wide global default. The wiring:
 *
 *   warm-REPL /tool-call sink → McpServer.dispatch({ project_id })
 *     → (X6) bindActiveProject: runWithActiveProject binds the frame
 *       → tool handler → CoreCredentialResolver.accessorFor(service)()
 *         → reads the ambient active-project frame → per-project token.
 *
 * These tests exercise that whole chain with NO mocks past the seam: a REAL
 * `McpServer` wired with the REAL `runWithActiveProject`, a REAL
 * `CoreCredentialResolver` over a REAL `ProjectCredentialStore` (in-memory
 * SQLite + the shared AES crypto). The tool handler is exactly what a Core does:
 * it consumes the resolver's lazy accessor closure.
 *
 * The regression guard is the "default pass-through" case: WITHOUT the X6 hook,
 * the exact same dispatch refuses credentials — unknown project cannot fall
 * back to an instance-wide credential.
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ProjectAccountSelectionStore } from '@neutronai/project-credentials/account-selection-store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { McpServer } from '@neutronai/mcp/server.ts'

import { CoreCredentialResolver } from '../core-credential-resolver.ts'
import { runWithActiveProject } from '../active-project-context.ts'

const OWNER = asOwnerHandle('x6-boundary-test')
const PROJECT = 'proj-alpha'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** Both per-project stores over ONE db, as production shares them. */
function makeStores(): { store: ProjectCredentialStore; selection: ProjectAccountSelectionStore; db: ProjectDb; dataDir: string } {
  const owner_home = mkdtempSync(join(tmpdir(), 'x6-boundary-'))
  cleanups.push(() => rmSync(owner_home, { recursive: true, force: true }))
  const dbPath = join(owner_home, 'owner.db')
  seedMigratedDb(dbPath)
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secretsStore = new SecretsStore({ data_dir: owner_home, db })
  return {
    db,
    dataDir: owner_home,
    store: new ProjectCredentialStore(db, { crypto: secretsStore }),
    selection: new ProjectAccountSelectionStore(db),
  }
}

const schema = { type: 'object', properties: {} }

/**
 * Register a tool that behaves like a Core: it resolves `service` through the
 * resolver's lazy accessor (which reads the ambient active-project frame) and
 * returns the token it got. Returns a wired `McpServer`.
 *
 * When `withHook` is false the X6 boundary binding is omitted (default
 * pass-through) — the regression baseline.
 */
function serverResolving(
  resolver: CoreCredentialResolver,
  service: string,
  withHook: boolean,
): McpServer {
  const reg = new ToolRegistry()
  reg.register({
    name: 'read_cred',
    description: 'resolves a credential through the ambient active-project frame',
    input_schema: schema,
    output_schema: schema,
    capability_required: 'read:project_data',
    approval_policy: 'auto',
    handler: async (args) => {
      const requested = (args as { projectId?: string } | undefined)?.projectId
      const token = requested === undefined
        ? await resolver.accessorFor(service)()
        : await resolver.resolve(service, { projectId: requested })
      return { token }
    },
  })
  return new McpServer({
    project_slug: OWNER,
    registry: reg,
    ...(withHook ? { bindActiveProject: runWithActiveProject } : {}),
  })
}

async function dispatchToken(
  server: McpServer,
  project_id: string | null,
): Promise<string | null> {
  const result = (await server.dispatch({
    tool_name: 'read_cred',
    args: {},
    call_id: 'c',
    project_id,
  })) as { token: string | null }
  return result.token
}

test('X6 e2e: a project-scoped credential resolves PER-PROJECT on the native tool path', async () => {
  const { store, selection } = makeStores()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  await store.set(OWNER, {
    service: 'google_workspace',
    plaintext: 'project-drive',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({
    owner_slug: OWNER,
    store,
    oauthTokens: null,
    accountSelection: selection,
  })
  const server = serverResolving(resolver, 'google_workspace', true)

  // Dispatching for the project → the project's own token.
  expect(await dispatchToken(server, PROJECT)).toBe('project-drive')
  // A different project with no row → the global default.
  expect(await dispatchToken(server, 'proj-beta')).toBe('global-drive')
  // No project → refuse, including the global default.
  expect(await dispatchToken(server, null)).toBeNull()
})

test('X6 e2e: a static service token (meta_ads) scopes per-project on the native tool path', async () => {
  const { store, selection } = makeStores()
  await store.set(OWNER, { service: 'meta_ads', plaintext: 'global-meta', scope: 'global' })
  await store.set(OWNER, {
    service: 'meta_ads',
    plaintext: 'project-meta',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({
    owner_slug: OWNER,
    store,
    oauthTokens: null,
    accountSelection: selection,
  })
  const server = serverResolving(resolver, 'meta_ads', true)

  expect(await dispatchToken(server, PROJECT)).toBe('project-meta')
  expect(await dispatchToken(server, null)).toBeNull()
})

test('X6 e2e: GLOBAL-scope services (gmail_compose) ignore the active project — no regression', async () => {
  const { store, selection } = makeStores()
  // A stray per-project gmail row MUST NOT shadow the shared grant even though the
  // frame IS bound to the project on the native tool path.
  await store.set(OWNER, {
    service: 'gmail_compose',
    plaintext: 'project-should-be-ignored',
    scope: 'project',
    project_id: PROJECT,
  })
  await store.set(OWNER, { service: 'gmail_compose', plaintext: 'global-gmail', scope: 'global' })
  const resolver = new CoreCredentialResolver({
    owner_slug: OWNER,
    store,
    oauthTokens: null,
    accountSelection: selection,
  })
  const server = serverResolving(resolver, 'gmail_compose', true)

  expect(await dispatchToken(server, PROJECT)).toBe('global-gmail')
})

test('X6 regression guard: WITHOUT the boundary hook the SAME dispatch refuses credentials', async () => {
  const { store, selection } = makeStores()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  await store.set(OWNER, {
    service: 'google_workspace',
    plaintext: 'project-drive',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({
    owner_slug: OWNER,
    store,
    oauthTokens: null,
    accountSelection: selection,
  })
  // No bindActiveProject wired → unknown project → refuse.
  const server = serverResolving(resolver, 'google_workspace', false)

  expect(await dispatchToken(server, PROJECT)).toBeNull()
})

test('X6 e2e: the bound frame does not leak — a later unbound dispatch refuses credentials', async () => {
  const { store, selection } = makeStores()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  await store.set(OWNER, {
    service: 'google_workspace',
    plaintext: 'project-drive',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({
    owner_slug: OWNER,
    store,
    oauthTokens: null,
    accountSelection: selection,
  })
  const server = serverResolving(resolver, 'google_workspace', true)

  // First dispatch binds PROJECT for its own lifetime only.
  expect(await dispatchToken(server, PROJECT)).toBe('project-drive')
  // A subsequent dispatch with no project must NOT see a leaked frame.
  expect(await dispatchToken(server, null)).toBeNull()
})

// API scoping is NOT key isolation. A same-process build can deliberately read
// the shared key and decrypt B's envelope; the final test demonstrates that reach.
test('#515: a build bound to A reads A, refuses B-only secrets and a request to override A with B', async () => {
  const { store, selection } = makeStores()
  await store.set(OWNER, { service: 'build_token', plaintext: 'project-a-token', scope: 'project', project_id: PROJECT })
  await store.set(OWNER, { service: 'build_token', plaintext: 'project-b-token', scope: 'project', project_id: 'proj-beta' })
  await store.set(OWNER, { service: 'b_only', plaintext: 'project-b-only-token', scope: 'project', project_id: 'proj-beta' })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null, accountSelection: selection })
  const server = serverResolving(resolver, 'build_token', true)
  expect(await dispatchToken(server, PROJECT)).toBe('project-a-token')
  expect(await dispatchToken(server, 'proj-beta')).toBe('project-b-token')
  const refused = await server.dispatch({ tool_name: 'read_cred', call_id: 'override', project_id: PROJECT, args: { projectId: 'proj-beta' } })
  expect(refused).toEqual({ token: null })
  expect(await dispatchToken(serverResolving(resolver, 'b_only', true), PROJECT)).toBeNull()
  expect(await dispatchToken(serverResolving(resolver, 'b_only', true), 'proj-beta')).toBe('project-b-only-token')
  // Matching explicit identity is allowed; refuse-every-override is not the rule.
  expect(await server.dispatch({ tool_name: 'read_cred', call_id: 'same', project_id: PROJECT, args: { projectId: PROJECT } })).toEqual({ token: 'project-a-token' })
})

test('#515: unknown project refuses project rows, explicit global rows and OAuth fallback', async () => {
  const { store, selection } = makeStores()
  await store.set(OWNER, { service: 'build_token', plaintext: 'project-a-token', scope: 'project', project_id: PROJECT })
  await store.set(OWNER, { service: 'build_token', plaintext: 'explicit-global-token', scope: 'global' })
  let oauthReads = 0
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, accountSelection: selection, oauthTokens: {
    listGrants: async () => { oauthReads++; return [{ label: 'gmail_compose', account_key: null, email: null }] },
    getAccessToken: async () => 'shared-mail-token',
  } as unknown as import('../oauth-token-manager.ts').OAuthTokenManager })
  for (const unknown of [null, '', '   ']) {
    const server = serverResolving(resolver, 'build_token', true)
    expect(await dispatchToken(server, unknown)).toBeNull()
    // A request parameter must not supply identity missing from the bound frame.
    expect(await server.dispatch({ tool_name: 'read_cred', call_id: 'unknown', project_id: unknown, args: { projectId: PROJECT } })).toEqual({ token: null })
    expect(await dispatchToken(serverResolving(resolver, 'gmail_compose', true), unknown)).toBeNull()
  }
  expect(await resolver.resolve('build_token')).toBeNull()
  expect(oauthReads).toBe(0)
  expect(await dispatchToken(serverResolving(resolver, 'build_token', true), PROJECT)).toBe('project-a-token')
  expect(await dispatchToken(serverResolving(resolver, 'gmail_compose', true), PROJECT)).toBe('shared-mail-token')
  expect(oauthReads).toBe(1)
})

test('#515 accepted bypass: readable raw key decrypts B despite the API refusing B to A', async () => {
  const { store, selection, db, dataDir } = makeStores()
  await store.set(OWNER, { service: 'b_only', plaintext: 'project-b-bypass-token', scope: 'project', project_id: 'proj-beta' })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null, accountSelection: selection })
  expect(await dispatchToken(serverResolving(resolver, 'b_only', true), PROJECT)).toBeNull()
  const row = db.prepare<{ ciphertext: string }, [string]>(
    'SELECT ciphertext FROM project_credentials WHERE project_id = ?',
  ).get('proj-beta')!
  const envelope = JSON.parse(row.ciphertext)
  const decipher = createDecipheriv('aes-256-gcm', readFileSync(join(dataDir, '.neutron-aes-key')), Buffer.from(envelope.iv_b64, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag_b64, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ct_b64, 'base64')), decipher.final()]).toString('utf8')
  expect(plaintext).toBe('project-b-bypass-token')
})
