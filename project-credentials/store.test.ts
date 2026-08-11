import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import {
  GLOBAL_PROJECT_ID,
  ProjectCredentialStore,
  ProjectCredentialValidationError,
} from './store.ts'

let tmp: string
let db: ProjectDb
let crypto: SecretsStore
// The owner boundary (server-derived instance handle); two distinct owners
// exercise the leak-gate.
const OWNER = asOwnerHandle('acme')
const OTHER_OWNER = asOwnerHandle('northwind')

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-project-creds-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  // Real AES crypto so ciphertext-at-rest assertions are meaningful.
  crypto = new SecretsStore({ data_dir: tmp, db })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function newStore(): ProjectCredentialStore {
  return new ProjectCredentialStore(db, { crypto })
}

describe('ProjectCredentialStore — migration + basic CRUD', () => {
  test('migration applies — project_credentials table exists', () => {
    const row = db
      .prepare<{ name: string }, [string]>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get('project_credentials')
    expect(row?.name).toBe('project_credentials')
  })

  test('set (project scope) stores + lists metadata only, never the token', async () => {
    const store = newStore()
    const rec = await store.set(OWNER, {
      service: 'meta_ads',
      plaintext: 'tok_secret_123',
      scope: 'project',
      project_id: 'proj-a',
      label: 'prod token',
    })
    expect(rec.scope).toBe('project')
    expect(rec.project_id).toBe('proj-a')
    expect(rec.service).toBe('meta_ads')
    expect(rec.label).toBe('prod token')
    // The record type carries no ciphertext/plaintext field.
    expect((rec as unknown as Record<string, unknown>).ciphertext).toBeUndefined()
    expect((rec as unknown as Record<string, unknown>).plaintext).toBeUndefined()

    const list = store.listForProject(OWNER, 'proj-a')
    expect(list.map((r) => r.service)).toEqual(['meta_ads'])
    expect((list[0] as unknown as Record<string, unknown>).ciphertext).toBeUndefined()
  })

  test('ciphertext at rest — the raw DB row never holds the plaintext', async () => {
    const store = newStore()
    await store.set(OWNER, {
      service: 'apify',
      plaintext: 'PLAINTEXT_NEEDLE',
      scope: 'project',
      project_id: 'proj-a',
    })
    const raw = db
      .prepare<{ ciphertext: string }, [string]>(
        `SELECT ciphertext FROM project_credentials WHERE owner_slug = ?`,
      )
      .get(OWNER)
    expect(raw).not.toBeNull()
    expect(raw?.ciphertext).not.toContain('PLAINTEXT_NEEDLE')
    // It IS a real AES envelope (round-trips through the shared crypto).
    expect(crypto.decryptEnvelope(raw!.ciphertext)).toBe('PLAINTEXT_NEEDLE')
  })

  test('set is an upsert — re-setting the same key overwrites in place', async () => {
    const store = newStore()
    const first = await store.set(OWNER, {
      service: 'google_ads',
      plaintext: 'v1',
      scope: 'project',
      project_id: 'proj-a',
    })
    const second = await store.set(OWNER, {
      service: 'google_ads',
      plaintext: 'v2',
      scope: 'project',
      project_id: 'proj-a',
    })
    // Same identity (id + created_at preserved), one row only.
    expect(second.id).toBe(first.id)
    expect(second.created_at).toBe(first.created_at)
    expect(store.listForProject(OWNER, 'proj-a')).toHaveLength(1)
    expect(store.resolve(OWNER, 'proj-a', 'google_ads')?.plaintext).toBe('v2')
  })

  test('delete removes a credential; returns false when nothing matched', async () => {
    const store = newStore()
    await store.set(OWNER, { service: 'apify', plaintext: 't', scope: 'project', project_id: 'proj-a' })
    expect(await store.delete(OWNER, 'proj-a', 'apify')).toBe(true)
    expect(store.listForProject(OWNER, 'proj-a')).toHaveLength(0)
    expect(await store.delete(OWNER, 'proj-a', 'apify')).toBe(false)
  })
})

describe('ProjectCredentialStore — resolver fallback (per-project → global → unset)', () => {
  test('per-project credential wins over the global default', async () => {
    const store = newStore()
    await store.set(OWNER, { service: 'meta_ads', plaintext: 'GLOBAL', scope: 'global' })
    await store.set(OWNER, {
      service: 'meta_ads',
      plaintext: 'PROJECT_A',
      scope: 'project',
      project_id: 'proj-a',
    })
    const resolved = store.resolve(OWNER, 'proj-a', 'meta_ads')
    expect(resolved?.plaintext).toBe('PROJECT_A')
    expect(resolved?.scope).toBe('project')
  })

  test('falls back to the global default when the project has no override', async () => {
    const store = newStore()
    await store.set(OWNER, { service: 'meta_ads', plaintext: 'GLOBAL', scope: 'global' })
    const resolved = store.resolve(OWNER, 'proj-b', 'meta_ads')
    expect(resolved?.plaintext).toBe('GLOBAL')
    expect(resolved?.scope).toBe('global')
  })

  test('resolves to null (unset) when neither project nor global is set', () => {
    const store = newStore()
    expect(store.resolve(OWNER, 'proj-a', 'meta_ads')).toBeNull()
  })

  test('General topic (no project_id) consults only the global default', async () => {
    const store = newStore()
    await store.set(OWNER, { service: 'meta_ads', plaintext: 'GLOBAL', scope: 'global' })
    await store.set(OWNER, {
      service: 'meta_ads',
      plaintext: 'PROJECT_A',
      scope: 'project',
      project_id: 'proj-a',
    })
    expect(store.resolve(OWNER, undefined, 'meta_ads')?.plaintext).toBe('GLOBAL')
    expect(store.resolve(OWNER, '', 'meta_ads')?.plaintext).toBe('GLOBAL')
  })

  test('two projects hold DISTINCT tokens for the same service', async () => {
    const store = newStore()
    await store.set(OWNER, {
      service: 'meta_ads',
      plaintext: 'A_TOKEN',
      scope: 'project',
      project_id: 'proj-a',
    })
    await store.set(OWNER, {
      service: 'meta_ads',
      plaintext: 'B_TOKEN',
      scope: 'project',
      project_id: 'proj-b',
    })
    expect(store.resolve(OWNER, 'proj-a', 'meta_ads')?.plaintext).toBe('A_TOKEN')
    expect(store.resolve(OWNER, 'proj-b', 'meta_ads')?.plaintext).toBe('B_TOKEN')
  })

  test('an expired credential resolves as unset', async () => {
    const store = newStore()
    await store.set(OWNER, {
      service: 'apify',
      plaintext: 'STALE',
      scope: 'project',
      project_id: 'proj-a',
      expires_at: '2000-01-01T00:00:00.000Z',
    })
    expect(store.resolve(OWNER, 'proj-a', 'apify')).toBeNull()
  })

  test('LEAK-GATE — an owner never resolves another owner\'s credential', async () => {
    const store = newStore()
    await store.set(OWNER, {
      service: 'meta_ads',
      plaintext: 'ACME_SECRET',
      scope: 'project',
      project_id: 'proj-a',
    })
    // Same project_id + service, different owner boundary → no read-through.
    expect(store.resolve(OTHER_OWNER, 'proj-a', 'meta_ads')).toBeNull()
    expect(store.listForProject(OTHER_OWNER, 'proj-a')).toHaveLength(0)
  })
})

describe('ProjectCredentialStore — available-services view (awareness)', () => {
  test('unions project + global with project overriding global; sorted', async () => {
    const store = newStore()
    await store.set(OWNER, { service: 'google_ads', plaintext: 'g1', scope: 'global' })
    await store.set(OWNER, { service: 'meta_ads', plaintext: 'g2', scope: 'global' })
    await store.set(OWNER, {
      service: 'meta_ads',
      plaintext: 'p1',
      scope: 'project',
      project_id: 'proj-a',
    })
    await store.set(OWNER, {
      service: 'apify',
      plaintext: 'p2',
      scope: 'project',
      project_id: 'proj-a',
    })
    const services = store.listAvailableServices(OWNER, 'proj-a')
    expect(services).toEqual([
      { service: 'apify', scope: 'project' },
      { service: 'google_ads', scope: 'global' },
      { service: 'meta_ads', scope: 'project' },
    ])
  })

  test('General topic shows only global defaults', async () => {
    const store = newStore()
    await store.set(OWNER, { service: 'google_ads', plaintext: 'g1', scope: 'global' })
    await store.set(OWNER, {
      service: 'meta_ads',
      plaintext: 'p1',
      scope: 'project',
      project_id: 'proj-a',
    })
    expect(store.listAvailableServices(OWNER, undefined)).toEqual([
      { service: 'google_ads', scope: 'global' },
    ])
  })

  test('expired credentials are excluded from the available view', async () => {
    const store = newStore()
    await store.set(OWNER, {
      service: 'apify',
      plaintext: 'stale',
      scope: 'global',
      expires_at: '2000-01-01T00:00:00.000Z',
    })
    expect(store.listAvailableServices(OWNER, 'proj-a')).toEqual([])
  })
})

describe('ProjectCredentialStore — validation', () => {
  test('rejects an empty/invalid service', async () => {
    const store = newStore()
    await expect(
      store.set(OWNER, { service: '', plaintext: 't', scope: 'project', project_id: 'p' }),
    ).rejects.toBeInstanceOf(ProjectCredentialValidationError)
    await expect(
      store.set(OWNER, { service: 'bad space', plaintext: 't', scope: 'project', project_id: 'p' }),
    ).rejects.toBeInstanceOf(ProjectCredentialValidationError)
  })

  test('rejects an empty token', async () => {
    const store = newStore()
    await expect(
      store.set(OWNER, { service: 'meta_ads', plaintext: '', scope: 'project', project_id: 'p' }),
    ).rejects.toBeInstanceOf(ProjectCredentialValidationError)
  })

  test('a project-scoped credential requires a non-empty project_id', async () => {
    const store = newStore()
    await expect(
      store.set(OWNER, { service: 'meta_ads', plaintext: 't', scope: 'project', project_id: '' }),
    ).rejects.toBeInstanceOf(ProjectCredentialValidationError)
  })

  test('a global-scoped credential ignores project_id (stored under the sentinel)', async () => {
    const store = newStore()
    const rec = await store.set(OWNER, {
      service: 'meta_ads',
      plaintext: 't',
      scope: 'global',
      project_id: 'ignored',
    })
    expect(rec.project_id).toBe(GLOBAL_PROJECT_ID)
    expect(store.listGlobal(OWNER).map((r) => r.service)).toEqual(['meta_ads'])
  })
})

describe('THE RESERVED NAMESPACE IS NOT REACHABLE FROM THE GENERIC CRUD', () => {
  // `gateway/mcp-servers/store.ts` keeps each installed MCP server's env VALUES in this
  // table under `mcp_env.<server>`, because it wanted this store's AES envelope rather
  // than a fourth one. `sanitizeService` accepts `.`, so that namespace was a perfectly
  // legal generic service name and the owner-facing CRUD could write and delete inside
  // it — skipping the owning store's validation and, the part that matters, its
  // `onRevoked` announcement. A generic overwrite rotated a secret while leaving the warm
  // `claude` child that holds the PREVIOUS one alive and unreaped; a generic delete left
  // the server installed and approved with its secret gone and that same child running.
  //
  // These are the mutation tests for that fix: remove the `isReservedService` guard from
  // `set`, `delete` or `resolve` and the corresponding case below fails.

  test('a generic set into `mcp_env.*` is REFUSED', async () => {
    const store = newStore()
    await expect(
      store.set(OWNER, { service: 'mcp_env.example-server', plaintext: '{}', scope: 'global' }),
    ).rejects.toBeInstanceOf(ProjectCredentialValidationError)
    // And nothing landed — a refusal that still wrote would be the worse outcome.
    expect(store.resolveReserved(OWNER, undefined, 'mcp_env.example-server')).toBeNull()
  })

  test('a generic delete of `mcp_env.*` is REFUSED, and the row survives', async () => {
    const store = newStore()
    await store.setReserved(OWNER, {
      service: 'mcp_env.example-server',
      plaintext: '{"EXAMPLE_API_KEY":"v"}',
      scope: 'global',
    })
    await expect(
      store.delete(OWNER, GLOBAL_PROJECT_ID, 'mcp_env.example-server'),
    ).rejects.toBeInstanceOf(ProjectCredentialValidationError)
    expect(store.resolveReserved(OWNER, undefined, 'mcp_env.example-server')?.plaintext).toBe(
      '{"EXAMPLE_API_KEY":"v"}',
    )
  })

  test('the refusal survives a case-shifted service name', async () => {
    // The DELETE route's path segment allows uppercase (`sanitizeServiceSegment` accepts
    // `A-Za-z0-9_.-`) and the store lowercases afterwards, so a case-sensitive guard
    // would have been walked straight past.
    const store = newStore()
    await expect(
      store.set(OWNER, { service: 'MCP_ENV.example-server', plaintext: '{}', scope: 'global' }),
    ).rejects.toBeInstanceOf(ProjectCredentialValidationError)
    await expect(
      store.delete(OWNER, GLOBAL_PROJECT_ID, 'MCP_ENV.example-server'),
    ).rejects.toBeInstanceOf(ProjectCredentialValidationError)
  })

  test('the generic resolve answers UNSET for a reserved service', async () => {
    // The read direction, closed against a future caller that resolves an owner-supplied
    // service name. Answered as unset rather than thrown: an unset service is a state
    // every consumer already handles, and the turn path must not gain a new throw.
    const store = newStore()
    await store.setReserved(OWNER, {
      service: 'mcp_env.example-server',
      plaintext: '{"EXAMPLE_API_KEY":"v"}',
      scope: 'global',
    })
    expect(store.resolve(OWNER, undefined, 'mcp_env.example-server')).toBeNull()
    // The owning module's read still works — otherwise this "fix" would just break MCP.
    expect(store.resolveReserved(OWNER, undefined, 'mcp_env.example-server')).not.toBeNull()
  })

  test('the enumerations omit reserved rows, so no surface renders one', async () => {
    const store = newStore()
    await store.setReserved(OWNER, {
      service: 'mcp_env.example-server',
      plaintext: '{}',
      scope: 'global',
    })
    await store.set(OWNER, { service: 'meta_ads', plaintext: 't', scope: 'global' })
    await store.set(OWNER, {
      service: 'apify',
      plaintext: 't',
      scope: 'project',
      project_id: 'proj-a',
    })
    expect(store.listGlobal(OWNER).map((r) => r.service)).toEqual(['meta_ads'])
    expect(store.listForProject(OWNER, 'proj-a').map((r) => r.service)).toEqual(['apify'])
    // And the agent's awareness block does not advertise an MCP server's secret blob as
    // an external service it can use.
    expect(store.listAvailableServices(OWNER, 'proj-a').map((s) => s.service)).toEqual([
      'apify',
      'meta_ads',
    ])
  })

  test('a NEIGHBOURING service name is still writable — the prefix ends at the dot', async () => {
    // The reservation must not quietly swallow real service names. `mcp_envelope` shares
    // the first seven characters and is not in the namespace.
    const store = newStore()
    const rec = await store.set(OWNER, {
      service: 'mcp_envelope',
      plaintext: 't',
      scope: 'global',
    })
    expect(rec.service).toBe('mcp_envelope')
    expect(await store.delete(OWNER, GLOBAL_PROJECT_ID, 'mcp_envelope')).toBe(true)
  })

  test('the privileged writes are the ones the owning module uses, and they work', async () => {
    const store = newStore()
    await store.setReserved(OWNER, {
      service: 'mcp_env.example-server',
      plaintext: '{"EXAMPLE_API_KEY":"v"}',
      scope: 'global',
    })
    expect(await store.deleteReserved(OWNER, GLOBAL_PROJECT_ID, 'mcp_env.example-server')).toBe(
      true,
    )
    expect(store.resolveReserved(OWNER, undefined, 'mcp_env.example-server')).toBeNull()
  })
})
