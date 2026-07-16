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
 * the exact same dispatch resolves GLOBAL — proving the boundary binding is what
 * makes per-project scoping work.
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

function makeStore(): ProjectCredentialStore {
  const owner_home = mkdtempSync(join(tmpdir(), 'x6-boundary-'))
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
    handler: async () => {
      const token = await resolver.accessorFor(service)()
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
  const store = makeStore()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  await store.set(OWNER, {
    service: 'google_workspace',
    plaintext: 'project-drive',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })
  const server = serverResolving(resolver, 'google_workspace', true)

  // Dispatching for the project → the project's own token.
  expect(await dispatchToken(server, PROJECT)).toBe('project-drive')
  // A different project with no row → the global default.
  expect(await dispatchToken(server, 'proj-beta')).toBe('global-drive')
  // No project (General / system dispatch) → the global default.
  expect(await dispatchToken(server, null)).toBe('global-drive')
})

test('X6 e2e: a static service token (meta_ads) scopes per-project on the native tool path', async () => {
  const store = makeStore()
  await store.set(OWNER, { service: 'meta_ads', plaintext: 'global-meta', scope: 'global' })
  await store.set(OWNER, {
    service: 'meta_ads',
    plaintext: 'project-meta',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })
  const server = serverResolving(resolver, 'meta_ads', true)

  expect(await dispatchToken(server, PROJECT)).toBe('project-meta')
  expect(await dispatchToken(server, null)).toBe('global-meta')
})

test('X6 e2e: GLOBAL-scope services (gmail_compose) ignore the active project — no regression', async () => {
  const store = makeStore()
  // A stray per-project gmail row MUST NOT shadow the shared grant even though the
  // frame IS bound to the project on the native tool path.
  await store.set(OWNER, {
    service: 'gmail_compose',
    plaintext: 'project-should-be-ignored',
    scope: 'project',
    project_id: PROJECT,
  })
  await store.set(OWNER, { service: 'gmail_compose', plaintext: 'global-gmail', scope: 'global' })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })
  const server = serverResolving(resolver, 'gmail_compose', true)

  expect(await dispatchToken(server, PROJECT)).toBe('global-gmail')
})

test('X6 regression guard: WITHOUT the boundary hook the SAME dispatch resolves GLOBAL', async () => {
  const store = makeStore()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  await store.set(OWNER, {
    service: 'google_workspace',
    plaintext: 'project-drive',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })
  // No bindActiveProject wired → the frame is never bound → global scope.
  const server = serverResolving(resolver, 'google_workspace', false)

  expect(await dispatchToken(server, PROJECT)).toBe('global-drive')
})

test('X6 e2e: the bound frame does not leak — a later unbound dispatch resolves GLOBAL', async () => {
  const store = makeStore()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  await store.set(OWNER, {
    service: 'google_workspace',
    plaintext: 'project-drive',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })
  const server = serverResolving(resolver, 'google_workspace', true)

  // First dispatch binds PROJECT for its own lifetime only.
  expect(await dispatchToken(server, PROJECT)).toBe('project-drive')
  // A subsequent dispatch with no project must NOT see a leaked frame.
  expect(await dispatchToken(server, null)).toBe('global-drive')
})
