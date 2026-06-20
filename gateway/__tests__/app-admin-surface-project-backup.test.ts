/**
 * P7.4 Phase 2 — app-admin surface project-backup route tests.
 *
 * Covers:
 *   - GET /api/app/admin/project-backup/projects (list)
 *   - GET .../<project_id>/status
 *   - POST .../<project_id>/configure (Open path A)
 *   - POST .../<project_id>/disconnect-remote
 *   - POST .../<project_id>/run-now
 *   - POST .../<project_id>/generate-keypair
 *   - 405 on Managed-side throws
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { createAppAdminSurface } from '../http/app-admin-surface.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { ProjectBackupStore } from '../git/project-backup-store.ts'
import { buildLocalPlatformAdapter } from '../../runtime/platform-adapter-local.ts'
import {
  PlatformOperationUnsupportedError,
  type PlatformAdapter,
} from '../../runtime/platform-adapter.ts'

const PROJECT_SLUG = 'demo'
const PROJECT_ID = 'demo-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  tmp: string
  owner_home: string
  close(): Promise<void>
}

function startOpenHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-pb-admin-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const projectRoot = join(owner_home, 'Projects', PROJECT_ID)
  mkdirSync(projectRoot, { recursive: true })
  const platform = buildLocalPlatformAdapter({
    selfOwner: {
      internal_handle: 'h_demo',
      url_slug: PROJECT_SLUG,
      owner_home,
      agent_name: null,
      tier: 'open',
      kind: 'user',
    },
    secretsDir: join(owner_home, '.secrets'),
    resolveProjectRoot: (id) => join(owner_home, 'Projects', id),
    sshKeygen: async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      const fIdx = args.indexOf('-f')
      if (args.includes('-y')) return { stdout: 'ok', stderr: '' }
      if (fIdx !== -1) {
        const path = args[fIdx + 1]!
        const fs = require('node:fs/promises')
        await fs.writeFile(
          path,
          '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n',
          { encoding: 'utf8', mode: 0o600 },
        )
        await fs.writeFile(`${path}.pub`, 'ssh-ed25519 fake demo\n', { encoding: 'utf8' })
      }
      return { stdout: '', stderr: '' }
    },
  })
  const store = new ProjectBackupStore({
    platform,
    owner_home,
    project_slug: PROJECT_SLUG,
  })
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const surface = createAppAdminSurface({
    auth,
    owner_home,
    project_slug: PROJECT_SLUG,
    projectBackupStore: store,
    platform,
    enumerateProjects: async () => [PROJECT_ID],
  })
  const handler = composeHttpHandler({
    appAdmin: { handler: surface.handler },
    defaultHandler: () => new Response('nf', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: handler.fetch as unknown as (req: Request) => Response | Promise<Response>,
    websocket: handler.websocket as unknown as Parameters<typeof Bun.serve>[0]['websocket'],
  } as Parameters<typeof Bun.serve>[0])
  const base = `http://localhost:${(server as unknown as { port: number }).port}`
  return {
    server,
    base,
    tmp,
    owner_home,
    async close() {
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function startManagedHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-pb-admin-managed-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(join(owner_home, 'Projects', PROJECT_ID), { recursive: true })
  // ISSUES #219 — `buildManagedPlatformAdapter` lives in a Managed-carved
  // shim that the Open split strips from the public tree. The 405 branch under
  // test fires purely on the adapter's OBSERVABLE Managed semantics: `project_backup`
  // capability true (so we clear the 503 gate) while
  // `set`/`clearProjectBackupRemoteConfig` throw `PlatformOperationUnsupported`
  // (Managed refuses manual remote config — it auto-provisions). We graft
  // exactly those semantics onto a Local adapter base (which already resolves
  // project roots from `owner_home/Projects/<id>` and returns a null remote
  // config), reproducing the same surface code path with no Managed import.
  const baseAdapter = buildLocalPlatformAdapter({
    selfOwner: {
      internal_handle: 'h_demo',
      url_slug: PROJECT_SLUG,
      owner_home,
      agent_name: null,
      tier: 'managed-shared',
      kind: 'user',
    },
    secretsDir: join(owner_home, '.secrets'),
    resolveProjectRoot: (id) => join(owner_home, 'Projects', id),
  })
  const platform: PlatformAdapter = {
    ...baseAdapter,
    setProjectBackupRemoteConfig: async () => {
      throw new PlatformOperationUnsupportedError(
        'setProjectBackupRemoteConfig',
        'Managed remotes are auto-provisioned and are not user-editable',
      )
    },
    clearProjectBackupRemoteConfig: async () => {
      throw new PlatformOperationUnsupportedError(
        'clearProjectBackupRemoteConfig',
        'Managed remotes are auto-provisioned and are not user-editable',
      )
    },
    // Stub provisioning hook (present on the Managed adapter); mirrors the
    // wiring that keeps `project_backup` semantically auto-provisioned.
    autoProvisionProjectBackupRemote: async () => ({
      remote_url: 'git@github.com:org/x.git',
      ssh_key_path: '/tmp/k',
      source: 'managed_provisioned',
      configured_at: new Date().toISOString(),
    }),
  }
  const store = new ProjectBackupStore({
    platform,
    owner_home,
    project_slug: PROJECT_SLUG,
  })
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const surface = createAppAdminSurface({
    auth,
    owner_home,
    project_slug: PROJECT_SLUG,
    tier: 'managed',
    projectBackupStore: store,
    platform,
    enumerateProjects: async () => [PROJECT_ID],
  })
  const handler = composeHttpHandler({
    appAdmin: { handler: surface.handler },
    defaultHandler: () => new Response('nf', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: handler.fetch as unknown as (req: Request) => Response | Promise<Response>,
    websocket: handler.websocket as unknown as Parameters<typeof Bun.serve>[0]['websocket'],
  } as Parameters<typeof Bun.serve>[0])
  const base = `http://localhost:${(server as unknown as { port: number }).port}`
  return {
    server,
    base,
    tmp,
    owner_home,
    async close() {
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function call(
  h: Harness,
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { authorization: 'Bearer dev-bypass' },
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  const res = await fetch(`${h.base}${path}`, init)
  let json: Record<string, unknown> = {}
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    /* ignore */
  }
  return { status: res.status, json }
}

describe('app-admin project-backup routes — Open tier', () => {
  let h: Harness
  beforeEach(() => {
    h = startOpenHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('GET /project-backup/projects lists the available projects', async () => {
    const { status, json } = await call(h, 'GET', '/api/app/admin/project-backup/projects')
    expect(status).toBe(200)
    expect(json['configured']).toBe(true)
    expect(Array.isArray(json['projects'])).toBe(true)
    expect(json['projects']).toEqual([{ project_id: PROJECT_ID }])
  })

  it('GET /project-backup/<id>/status returns the per-project status surface', async () => {
    const { status, json } = await call(
      h,
      'GET',
      `/api/app/admin/project-backup/${PROJECT_ID}/status`,
    )
    expect(status).toBe(200)
    const s = json['status'] as Record<string, unknown>
    expect(['not_configured', 'configured', 'ok']).toContain(s['state'] as string)
  })

  it('POST /project-backup/<id>/run-now returns a backup result', async () => {
    const { status, json } = await call(
      h,
      'POST',
      `/api/app/admin/project-backup/${PROJECT_ID}/run-now`,
    )
    expect(status).toBe(200)
    expect(json['ok']).toBe(true)
    const b = json['backup'] as Record<string, unknown>
    expect(b).toHaveProperty('commit_sha')
    expect(b).toHaveProperty('pushed')
  })

  it('POST /project-backup/<id>/generate-keypair returns a request_id + public key', async () => {
    const { status, json } = await call(
      h,
      'POST',
      `/api/app/admin/project-backup/${PROJECT_ID}/generate-keypair`,
    )
    expect(status).toBe(200)
    expect(typeof json['request_id']).toBe('string')
    expect(typeof json['public_key']).toBe('string')
  })

  it('POST /project-backup/<id>/configure (path A) wires the remote + runs a validation backup', async () => {
    const { status, json } = await call(
      h,
      'POST',
      `/api/app/admin/project-backup/${PROJECT_ID}/configure`,
      {
        remote_url: 'git@github.com:example/demo.git',
        ssh_key_pem:
          '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n',
      },
    )
    expect(status).toBe(200)
    expect(json['ok']).toBe(true)
    expect(json['remote']).toBeDefined()
    expect(json['backup']).toBeDefined()
  })

  it('POST /project-backup/<id>/disconnect-remote clears the config', async () => {
    // Configure first.
    await call(h, 'POST', `/api/app/admin/project-backup/${PROJECT_ID}/configure`, {
      remote_url: 'git@github.com:example/demo.git',
      ssh_key_pem:
        '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n',
    })
    const { status, json } = await call(
      h,
      'POST',
      `/api/app/admin/project-backup/${PROJECT_ID}/disconnect-remote`,
    )
    expect(status).toBe(200)
    expect(json['disconnected']).toBe(true)
  })

  it('POST /project-backup/<id>/configure rejects HTTPS URLs with code=configure_failed', async () => {
    const { status, json } = await call(
      h,
      'POST',
      `/api/app/admin/project-backup/${PROJECT_ID}/configure`,
      {
        remote_url: 'https://github.com/example/demo.git',
        ssh_key_pem: '...',
      },
    )
    expect(status).toBe(400)
    expect(json['code']).toBe('configure_failed')
  })

  it('returns 404 for unknown subroutes', async () => {
    const { status } = await call(
      h,
      'GET',
      `/api/app/admin/project-backup/${PROJECT_ID}/bogus`,
    )
    expect(status).toBe(404)
  })
})

describe('app-admin project-backup routes — Managed tier', () => {
  let h: Harness
  beforeEach(() => {
    h = startManagedHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('POST /configure returns 405 with code=managed_auto_provisioned', async () => {
    const { status, json } = await call(
      h,
      'POST',
      `/api/app/admin/project-backup/${PROJECT_ID}/configure`,
      {
        remote_url: 'git@github.com:example/demo.git',
        ssh_key_pem: '...',
      },
    )
    expect(status).toBe(405)
    expect(json['code']).toBe('managed_auto_provisioned')
  })

  it('POST /disconnect-remote returns 405 with code=managed_auto_provisioned', async () => {
    const { status, json } = await call(
      h,
      'POST',
      `/api/app/admin/project-backup/${PROJECT_ID}/disconnect-remote`,
    )
    expect(status).toBe(405)
    expect(json['code']).toBe('managed_auto_provisioned')
  })

  it('GET /status still works on Managed even without a provisioned remote', async () => {
    const { status, json } = await call(
      h,
      'GET',
      `/api/app/admin/project-backup/${PROJECT_ID}/status`,
    )
    expect(status).toBe(200)
    const s = json['status'] as Record<string, unknown>
    expect(s).toHaveProperty('state')
  })
})
