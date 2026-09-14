/** #622 production-path diagnosis. The trusted registration prerequisite remains
 * blocked; the guest round trip below does not claim to implement federation. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { resolveBootConfig } from '@neutronai/config/index.ts'
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
  fetch(url: string, init?: RequestInit): Promise<Response>
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
  process.env['NEUTRON_CONNECT_PUBLIC_BASE_URL'] = 'http://127.0.0.1'
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

/** Use the frozen boot config and both production composition stages. */
async function startHarness(): Promise<Harness> {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const nowIso = new Date().toISOString()
  await db.run(
    `INSERT INTO projects (id, name, description, persona, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, 'Connect Test', NULL, NULL, 'private', 'personal', ?, ?)`,
    [PROJECT_ID, nowIso, nowIso],
  )
  const composer = buildOpenGraphComposer({ env: process.env, config: resolveBootConfig(process.env) })
  const composition = await composer({ db, project_slug: OWNER })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('Open composition did not expose graph.fetch/websocket')
  }
  const composedFetch = graph.fetch
  // Exercise the production HTTP ladder without a listening socket. Only the
  // transport peer address is fixture-owned; auth and membership are composed.
  const server = { requestIP: () => ({ address: '127.0.0.1', family: 'IPv4', port: 12345 }) } as unknown as Parameters<typeof composedFetch>[1]
  return {
    base: 'http://127.0.0.1',
    fetch: async (url, init) => composedFetch(new Request(url, init), server),
    db,
    close: async () => {
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
  const res = await h.fetch(`${h.base}/api/app/projects/${PROJECT_ID}/connect-invites`, {
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

test('#622 diagnostic: guest membership lists projects; trusted registration stays unmounted', async () => {
  harness = await startHarness()
  const { token } = await issueInvite(harness)
  const joined = await harness.fetch(`${harness.base}/connect/v1/connect/guest-auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      invite_token: token,
      display_name: 'Collaborator',
      guest_handle: 'collaborator',
    }),
  })
  expect(joined.status).toBe(200)
  const member = (await joined.json()) as {
    token: string
    origin_instance_slug: string
    local_slug: string
  }
  const headers = {
    authorization: `Bearer ${member.token}`,
    'x-origin-instance': member.origin_instance_slug,
  }
  const projects = await harness.fetch(`${harness.base}/connect/v1/projects`, { headers })
  expect(projects.status).toBe(200)
  expect(await projects.json()).toEqual({ projects: [{
    project_id: PROJECT_ID,
    display_name: 'Connect Test',
    kind: 'solo',
    owning_instance_slug: OWNER,
  }] })

  // The same valid bearer reaches the route dispatch, past auth and the state
  // gate. This diagnoses the missing trusted mount, not a registration fix.
  const trusted = await harness.fetch(`${harness.base}/connect/v1/connect/trusted-accept`, {
    method: 'POST',
    headers,
    body: '{}',
  })
  expect(trusted.status).toBe(404)
  expect(await trusted.json()).toEqual({ error: 'not_found', path: '/connect/trusted-accept' })

  // Keep the surface open so the state gate cannot mask the membership check.
  await issueInvite(harness)
  const revoked = await harness.fetch(
    `${harness.base}/api/app/projects/${PROJECT_ID}/connect-members/${member.local_slug}/revoke`,
    { method: 'POST', headers: { authorization: 'Bearer dev:owner' } },
  )
  expect(revoked.status).toBe(200)
  expect((await harness.fetch(`${harness.base}/connect/v1/health`)).status).toBe(200)
  const denied = await harness.fetch(`${harness.base}/connect/v1/projects`, { headers })
  expect(denied.status).toBe(200)
  expect(await denied.json()).toEqual({ projects: [] })
})
