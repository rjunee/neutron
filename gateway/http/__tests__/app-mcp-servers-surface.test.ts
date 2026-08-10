/**
 * `gateway/http/app-mcp-servers-surface.ts` — the Settings MCP-servers API.
 *
 * Covers the things that make the controls honest:
 *   - INSTALLING IS NOT APPROVING: the POST that adds a server leaves it pending, and
 *     the only route that can approve carries an explicit `decision`;
 *   - a missing or garbled `decision` is REFUSED, never defaulted in either direction;
 *   - the env values go UP and never come back, in any field, in any form;
 *   - a rejected install names every problem, so the owner can fix them in one pass;
 *   - nothing is reachable without the owner bearer — including the decision route,
 *     which is the one that actually grants a capability;
 *   - `/api/app/mcp-servers` and `/api/app/mcp-servers/decision` are matched EXACTLY,
 *     pinned in BOTH directions. The collection path is a prefix of the decision path,
 *     and a prefix match would answer one with the other's handler: a 200 carrying the
 *     wrong body, which no client can detect.
 *
 * Driven against the REAL `OwnerMcpServerStore` over a real migrated database rather
 * than a mock, because "did the POST approve anything" is a question about the join
 * between three stores and a stubbed store would answer it by construction.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ApprovalManager } from '@neutronai/tools/approval.ts'
import { OwnerMcpServerStore } from '../../mcp-servers/store.ts'
import { createAppMcpServersSurface } from '../app-mcp-servers-surface.ts'

const BASE = 'http://x/api/app/mcp-servers'
const DECISION = `${BASE}/decision`
const SECRET = 'sk-not-a-real-key'

const auth = {
  resolve: async (token: string) =>
    token === 'good'
      ? { user_id: 'owner', project_slug: 'owner', project_id: 'p1' }
      : { code: 'unauthorized', message: 'bad token' },
} as unknown as Parameters<typeof createAppMcpServersSurface>[0]['auth']

let tmp: string
let db: ProjectDb
let surface: ReturnType<typeof createAppMcpServersSurface>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-surface-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const store = new OwnerMcpServerStore({
    db,
    project_slug: 'owner',
    credentials: new ProjectCredentialStore(db, {
      crypto: new SecretsStore({ data_dir: tmp, db }),
    }),
    owner_slug: asOwnerHandle('owner'),
    approvals: () => new ApprovalManagerSingleton(db).get(),
  })
  surface = createAppMcpServersSurface({ auth, store })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * ONE manager per database, memoised — a second instance would keep its own map of
 * pending decisions and the two would disagree about which are still waiting.
 */
class ApprovalManagerSingleton {
  private static cache = new WeakMap<object, ApprovalManager>()
  constructor(private readonly db: ProjectDb) {}
  get(): ApprovalManager {
    const key = this.db as unknown as object
    const existing = ApprovalManagerSingleton.cache.get(key)
    if (existing !== undefined) return existing
    const made = new ApprovalManager(this.db, { notify: async () => {} })
    ApprovalManagerSingleton.cache.set(key, made)
    return made
  }
}

function req(url: string, method: string, body?: unknown, token = 'good'): Request {
  return new Request(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function json(res: Response | null): Promise<Record<string, unknown>> {
  expect(res).not.toBeNull()
  return (await res!.json()) as Record<string, unknown>
}

const DRAFT = {
  name: 'example-server',
  command: '/usr/local/bin/example-mcp',
  args: ['--stdio'],
  env: { EXAMPLE_API_KEY: SECRET },
}

describe('installing is not approving', () => {
  test('POST adds the server and leaves it PENDING', async () => {
    const body = await json(await surface.handler(req(BASE, 'POST', DRAFT)))
    const servers = body['servers'] as Array<Record<string, unknown>>
    expect(servers).toHaveLength(1)
    expect(servers[0]!['approval']).toBe('pending')
    expect(servers[0]!['active']).toBe(false)
  })

  test('the decision route is what approves, and it takes an explicit verb', async () => {
    await surface.handler(req(BASE, 'POST', DRAFT))
    const body = await json(
      await surface.handler(req(DECISION, 'POST', { name: 'example-server', decision: 'approve' })),
    )
    const servers = body['servers'] as Array<Record<string, unknown>>
    expect(servers[0]!['approval']).toBe('approved')
    expect(servers[0]!['active']).toBe(true)
  })

  test('a MISSING or garbled decision is refused, never defaulted', async () => {
    // Defaulting to approve would grant a capability from a malformed request;
    // defaulting to deny would silently discard an approval the owner did make.
    await surface.handler(req(BASE, 'POST', DRAFT))
    for (const body of [{ name: 'example-server' }, { name: 'example-server', decision: 'yes' }]) {
      const res = await surface.handler(req(DECISION, 'POST', body))
      expect(res!.status).toBe(400)
      expect((await json(res))['code']).toBe('invalid_decision')
    }
    const after = await json(await surface.handler(req(BASE, 'GET')))
    expect((after['servers'] as Array<Record<string, unknown>>)[0]!['approval']).toBe('pending')
  })

  test('deny is recorded, and the server stays listed', async () => {
    await surface.handler(req(BASE, 'POST', DRAFT))
    const body = await json(
      await surface.handler(req(DECISION, 'POST', { name: 'example-server', decision: 'deny' })),
    )
    const servers = body['servers'] as Array<Record<string, unknown>>
    expect(servers).toHaveLength(1)
    expect(servers[0]!['approval']).toBe('denied')
  })

  test('a decision for a server that is not installed is a 409, not a 200', async () => {
    const res = await surface.handler(req(DECISION, 'POST', { name: 'ghost', decision: 'approve' }))
    expect(res!.status).toBe(409)
  })
})

describe('the two paths are matched EXACTLY, in both directions', () => {
  test('the collection path does NOT serve the decision route', async () => {
    // A prefix match here would answer a decision POST with the install handler — the
    // undetectable-200 failure.
    await surface.handler(req(BASE, 'POST', DRAFT))
    const res = await surface.handler(req(BASE, 'POST', { name: 'example-server', decision: 'approve' }))
    // Read as an INSTALL with a missing command, never as an approval.
    expect(res!.status).toBe(400)
    const after = await json(await surface.handler(req(BASE, 'GET')))
    expect((after['servers'] as Array<Record<string, unknown>>)[0]!['approval']).toBe('pending')
  })

  test('the decision path does NOT serve the collection routes', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await surface.handler(req(`${DECISION}?name=example-server`, method))
      expect(res!.status).toBe(405)
    }
  })

  test('a path that merely STARTS WITH the collection path is disclaimed', async () => {
    // Returning `null` is how the chain keeps falling through; a 404 here would
    // swallow a sibling surface mounted below.
    expect(await surface.handler(req('http://x/api/app/mcp-servers-other', 'GET'))).toBeNull()
    expect(await surface.handler(req('http://x/api/app/mcp-servers/decision/extra', 'POST', {}))).toBeNull()
    expect(await surface.handler(req('http://x/api/app/other', 'GET'))).toBeNull()
  })
})

describe('values go up and never come back', () => {
  test('no response field carries a value, in any route', async () => {
    const bodies: string[] = []
    bodies.push(JSON.stringify(await json(await surface.handler(req(BASE, 'POST', DRAFT)))))
    bodies.push(JSON.stringify(await json(await surface.handler(req(BASE, 'GET')))))
    bodies.push(
      JSON.stringify(
        await json(
          await surface.handler(
            req(DECISION, 'POST', { name: 'example-server', decision: 'approve' }),
          ),
        ),
      ),
    )
    for (const body of bodies) {
      expect(body).toContain('EXAMPLE_API_KEY')
      expect(body).not.toContain(SECRET)
    }
  })

  test('the grant prompt is on the wire, and it names the command and the variable', async () => {
    // The clients display it VERBATIM, so it has to be complete HERE.
    const body = await json(await surface.handler(req(BASE, 'POST', DRAFT)))
    const prompt = (body['servers'] as Array<Record<string, unknown>>)[0]!['grant_prompt'] as string
    expect(prompt).toContain('/usr/local/bin/example-mcp')
    expect(prompt).toContain('--stdio')
    expect(prompt).toContain('EXAMPLE_API_KEY')
    expect(prompt).not.toContain(SECRET)
  })
})

describe('the ordinary refusals', () => {
  test('a rejected install names EVERY problem', async () => {
    const res = await surface.handler(req(BASE, 'POST', { name: 'Bad Name', command: '' }))
    expect(res!.status).toBe(400)
    const message = (await json(res))['message'] as string
    expect(message).toContain('name')
    expect(message).toContain('command')
  })

  test('a reserved name is refused with a reason', async () => {
    const res = await surface.handler(req(BASE, 'POST', { ...DRAFT, name: 'neutron' }))
    expect(res!.status).toBe(400)
    expect((await json(res))['message']).toContain('reserved')
  })

  test('DELETE needs a name, and 404s on one that is not installed', async () => {
    expect((await surface.handler(req(BASE, 'DELETE')))!.status).toBe(400)
    expect((await surface.handler(req(`${BASE}?name=ghost`, 'DELETE')))!.status).toBe(404)
  })

  test('DELETE removes an installed server', async () => {
    await surface.handler(req(BASE, 'POST', DRAFT))
    const body = await json(await surface.handler(req(`${BASE}?name=example-server`, 'DELETE')))
    expect(body['servers']).toEqual([])
  })

  test('every route requires the owner bearer — including the decision route', async () => {
    for (const [url, method] of [
      [BASE, 'GET'],
      [BASE, 'POST'],
      [`${BASE}?name=example-server`, 'DELETE'],
      [DECISION, 'POST'],
    ] as const) {
      const res = await surface.handler(req(url, method, method === 'GET' ? undefined : {}, 'bad'))
      expect(res!.status).toBe(401)
    }
  })

  test('an unsupported method on the collection is a 405', async () => {
    expect((await surface.handler(req(BASE, 'PUT', {})))!.status).toBe(405)
  })

  test('the payload tells a client what it cannot use, and how many it may have', async () => {
    const body = await json(await surface.handler(req(BASE, 'GET')))
    expect(body['reserved_names']).toContain('neutron')
    expect(typeof body['max_servers']).toBe('number')
  })
})
