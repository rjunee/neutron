/**
 * `trident/codex-credential-tool.ts` — the `codex_connect` / `codex_status`
 * agent tools (agent-native parity with the admin-panel Connect Codex flow).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { codexAuthPath } from './codex-auth.ts'
import { CodexCredentialService } from './codex-credential.ts'
import {
  CODEX_CONNECT_TOOL,
  CODEX_STATUS_TOOL,
  registerCodexCredentialToolSurface,
} from './codex-credential-tool.ts'

const SLUG = 'owner'
const CTX = { project_slug: SLUG, project_id: null, topic_id: 't', call_id: 'c', speaker_user_id: null }

let tmp: string
let db: ProjectDb
let codexHome: string
let registry: ToolRegistry
let service: CodexCredentialService

function subscriptionAuth(): string {
  return JSON.stringify({
    tokens: { access_token: 'acc', refresh_token: 'ref' },
    last_refresh: '2026-06-30T00:00:00.000Z',
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codex-tool-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const crypto = new SecretsStore({ data_dir: tmp, db })
  const store = new ProjectCredentialStore(db, { crypto })
  codexHome = join(tmp, '.codex')
  service = new CodexCredentialService({ store, codexHome })
  registry = new ToolRegistry()
  registerCodexCredentialToolSurface(registry, { service })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('codex credential agent tools', () => {
  test('registers codex_status (read/auto) + codex_connect (write/prompt-user)', () => {
    const status = registry.get(CODEX_STATUS_TOOL)
    const connect = registry.get(CODEX_CONNECT_TOOL)
    expect(status?.capability_required).toBe('read:project_data')
    expect(status?.approval_policy).toBe('auto')
    expect(connect?.capability_required).toBe('write:project_data')
    expect(connect?.approval_policy).toBe('prompt-user')
    expect(connect?.input_schema.required).toEqual(['auth'])
    // Both advertised to the agent (not hidden).
    expect(status?.agent_hidden ?? false).toBe(false)
    expect(connect?.agent_hidden ?? false).toBe(false)
  })

  test('codex_status → not_connected before, connected after codex_connect', async () => {
    const statusTool = registry.get(CODEX_STATUS_TOOL)!
    const connectTool = registry.get(CODEX_CONNECT_TOOL)!

    const before = (await statusTool.handler({}, CTX)) as { status: string }
    expect(before.status).toBe('not_connected')

    const connected = (await connectTool.handler({ auth: subscriptionAuth() }, CTX)) as {
      ok: boolean
      status: string
    }
    expect(connected.ok).toBe(true)
    expect(connected.status).toBe('connected')
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)

    const after = (await statusTool.handler({}, CTX)) as { status: string }
    expect(after.status).toBe('connected')
  })

  test('codex_connect rejects a metered key with ok:false + guidance', async () => {
    const connectTool = registry.get(CODEX_CONNECT_TOOL)!
    const res = (await connectTool.handler({ auth: 'sk-live-abc123456789' }, CTX)) as {
      ok: boolean
      error: string
    }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('subscription')
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
  })
})
