import { asOwnerHandle } from '@neutronai/persistence/index.ts'
/**
 * X6 (2026-07-15) — the PRODUCTION WIRING guard for per-project credential
 * scoping on the agent's native tool path.
 *
 * The sibling `gateway/cores/__tests__/x6-tool-boundary-credential-scope.test.ts`
 * proves the MECHANISM (a REAL `McpServer` + REAL resolver resolve per-project
 * when the boundary hook is bound), but it hand-constructs the `McpServer` with
 * `bindActiveProject: runWithActiveProject` injected directly. That has NO
 * mutation-kill power over the real composition: deleting the
 * `bindActiveProject: runWithActiveProject` line from `build-core-modules.ts`
 * would leave every one of those tests green.
 *
 * THIS test closes that gap. It obtains the `McpServer` THROUGH the real
 * composition path — `buildCoreModules(input).mcpModule.init(ctx)` — the exact
 * factory the production graph registers. So the ONLY thing that makes the
 * dispatched Core tool resolve per-project is the production `bindActiveProject:
 * runWithActiveProject` wiring inside `mcpModule.init`.
 *
 * MUTATION-KILL: remove `bindActiveProject: runWithActiveProject` from
 * `build-core-modules.ts`'s `mcpModule` and this test goes RED — the
 * production-built server falls back to the pass-through, the ambient frame is
 * never bound, and the project-scoped dispatch resolves GLOBAL instead.
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
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import type { McpServer } from '@neutronai/mcp/server.ts'

import { CoreCredentialResolver } from '../cores/core-credential-resolver.ts'
import { buildCoreModules } from './build-core-modules.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'

const OWNER = asOwnerHandle('x6-composition-test')
const PROJECT = 'proj-alpha'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** A REAL owner-scoped ProjectCredentialStore (in-memory SQLite + AES crypto). */
function makeCredentialStore(): ProjectCredentialStore {
  const owner_home = mkdtempSync(join(tmpdir(), 'x6-composition-'))
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

/** A minimal ProjectDb for the CompositionInput (the gateway's own instance db). */
function makeProjectDb(): ProjectDb {
  const tmp = mkdtempSync(join(tmpdir(), 'x6-composition-instance-'))
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  cleanups.push(() => db.close())
  applyMigrations(db.raw())
  return db
}

function baseInput(db: ProjectDb): CompositionInput {
  return {
    db,
    project_slug: OWNER,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
  }
}

const schema = { type: 'object', properties: {} }

/**
 * A `ToolRegistry` carrying one Core-like tool: it resolves `service` through the
 * resolver's lazy accessor closure (which reads the ambient active-project frame
 * at call time) and returns the token it got — exactly what a real Core does.
 */
function registryResolving(resolver: CoreCredentialResolver, service: string): ToolRegistry {
  const reg = new ToolRegistry()
  reg.register({
    name: 'read_cred',
    description: 'resolves a credential through the ambient active-project frame',
    input_schema: schema,
    output_schema: schema,
    capability_required: 'read:project_data',
    approval_policy: 'auto',
    handler: async () => ({ token: await resolver.accessorFor(service)() }),
  })
  return reg
}

/**
 * Build the McpServer THROUGH the production composition path
 * (`buildCoreModules(...).mcpModule.init`) — NOT by hand — so the ONLY source of
 * the boundary binding is the production wiring under test. The `tools` module is
 * substituted with the caller's registry via the ctx (the real graph would return
 * the composed ToolRegistry the same way).
 */
function productionMcpServer(db: ProjectDb, registry: ToolRegistry): McpServer {
  const mods = buildCoreModules(baseInput(db))
  const ctx: ModuleContext = {
    graph: {
      get: ((name: string) => (name === 'tools' ? registry : undefined)) as never,
      names: () => ['tools'],
    },
    config: {},
  }
  return mods.mcpModule.init(ctx) as McpServer
}

async function dispatchToken(server: McpServer, project_id: string | null): Promise<string | null> {
  const result = (await server.dispatch({
    tool_name: 'read_cred',
    args: {},
    call_id: 'c',
    project_id,
  })) as { token: string | null }
  return result.token
}

test('X6 production wiring: a McpServer built by buildCoreModules scopes credentials PER-PROJECT', async () => {
  const store = makeCredentialStore()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  await store.set(OWNER, {
    service: 'google_workspace',
    plaintext: 'project-drive',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })

  const db = makeProjectDb()
  const server = productionMcpServer(db, registryResolving(resolver, 'google_workspace'))

  // Dispatching for the project → the project's own token. This ONLY resolves
  // per-project because mcpModule.init wired `bindActiveProject: runWithActiveProject`.
  // Deleting that line makes this line resolve 'global-drive' → RED (mutation-kill).
  expect(await dispatchToken(server, PROJECT)).toBe('project-drive')
  // A different project with no row → the global default.
  expect(await dispatchToken(server, 'proj-beta')).toBe('global-drive')
  // No project (General / system dispatch) → the global default.
  expect(await dispatchToken(server, null)).toBe('global-drive')
})

test('X6 production wiring: the frame bound at the boundary does not leak across dispatches', async () => {
  const store = makeCredentialStore()
  await store.set(OWNER, { service: 'google_workspace', plaintext: 'global-drive', scope: 'global' })
  await store.set(OWNER, {
    service: 'google_workspace',
    plaintext: 'project-drive',
    scope: 'project',
    project_id: PROJECT,
  })
  const resolver = new CoreCredentialResolver({ owner_slug: OWNER, store, oauthTokens: null })

  const db = makeProjectDb()
  const server = productionMcpServer(db, registryResolving(resolver, 'google_workspace'))

  // First dispatch binds PROJECT for its own lifetime only; a later unbound
  // dispatch must NOT see a leaked frame.
  expect(await dispatchToken(server, PROJECT)).toBe('project-drive')
  expect(await dispatchToken(server, null)).toBe('global-drive')
})
