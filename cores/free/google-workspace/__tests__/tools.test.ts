import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { CapabilityDeniedError, SecretAuditLog } from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'

import {
  buildInMemoryGoogleWorkspaceClient,
  buildTools,
  loadManifest,
} from '../index.ts'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog
const OWNER = 'gws1'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gws-core-tools-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeTools() {
  const manifest = loadManifest()
  const client = buildInMemoryGoogleWorkspaceClient()
  const tools = buildTools({ manifest, project_slug: OWNER, audit, client })
  return { tools, client }
}

describe('buildTools — capability-gated dispatch', () => {
  test('drive_upload then drive_list + drive_read round-trip', async () => {
    const { tools } = makeTools()
    const up = await tools.drive_upload({ name: 'memo.txt', mime_type: 'text/plain', content: 'hello drive' })
    expect(up.file.id.length).toBeGreaterThan(0)
    const list = await tools.drive_list({})
    expect(list.files.some((f) => f.id === up.file.id)).toBe(true)
    const read = await tools.drive_read({ file_id: up.file.id })
    expect(read.file.content_text).toBe('hello drive')
  })

  test('sheets_read / sheets_append / sheets_update', async () => {
    const { tools, client } = makeTools()
    client.seedSheet('sid', [['h1', 'h2']])
    const appended = await tools.sheets_append({ spreadsheet_id: 'sid', range: 'A1', values: [['r1c1', 'r1c2']] })
    expect(appended.updated_rows).toBe(1)
    const read = await tools.sheets_read({ spreadsheet_id: 'sid', range: 'A1' })
    expect(read.values).toEqual([['h1', 'h2'], ['r1c1', 'r1c2']])
    await tools.sheets_update({ spreadsheet_id: 'sid', range: 'A1', values: [['H1']] })
    const afterUpdate = await tools.sheets_read({ spreadsheet_id: 'sid', range: 'A1' })
    expect(afterUpdate.values[0]![0]).toBe('H1')
  })

  test('docs_create / docs_read / docs_update', async () => {
    const { tools } = makeTools()
    const created = await tools.docs_create({ title: 'Plan', body: 'Section 1' })
    const read = await tools.docs_read({ document_id: created.document_id })
    expect(read.document.title).toBe('Plan')
    expect(read.document.body_text).toBe('Section 1')
    const updated = await tools.docs_update({ document_id: created.document_id, text: '\nSection 2' })
    expect(updated.replies_count).toBe(1)
    const reread = await tools.docs_read({ document_id: created.document_id })
    expect(reread.document.body_text).toBe('Section 1\nSection 2')
  })

  test('every dispatch records an ok audit row', async () => {
    const { tools } = makeTools()
    await tools.drive_upload({ name: 'a.txt', mime_type: 'text/plain', content: 'x' })
    await tools.docs_create({ title: 'D' })
    const rows = await audit.list({ project_slug: OWNER, core_slug: 'google_workspace_core' })
    const ok = rows.filter((r) => r.outcome === 'ok')
    const toolNames = new Set(ok.map((r) => r.label))
    expect(toolNames.has('drive_upload')).toBe(true)
    expect(toolNames.has('docs_create')).toBe(true)
  })

  test('a manifest missing the capability rejects with CapabilityDeniedError', async () => {
    // Strip the drive write capability so drive_upload's required
    // capability is no longer declared — the guard must deny.
    const base = loadManifest()
    const manifest: NeutronManifest = {
      ...base,
      capabilities: base.capabilities.filter((c) => c !== 'write:google_workspace_core.drive'),
    }
    const client = buildInMemoryGoogleWorkspaceClient()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, client })
    await expect(
      tools.drive_upload({ name: 'a.txt', mime_type: 'text/plain', content: 'x' }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError)
  })
})
