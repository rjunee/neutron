/**
 * @neutronai/google-workspace-core — capability-guarded MCP tool wiring.
 *
 * Nine tools across three Google services:
 *   drive_list / drive_read / drive_upload
 *   sheets_read / sheets_append / sheets_update
 *   docs_read / docs_create / docs_update
 *
 * Each handler is wrapped by the runtime `CapabilityGuard.wrapToolHandler`
 * so every dispatch records an audit row + rejects with
 * `CapabilityDeniedError` when the manifest doesn't declare the matching
 * capability. Capability strings are imported from `manifest.ts` so a
 * stray manifest edit that drifts from the locked per-service
 * `read:/write:google_workspace_core.<svc>` pairs surfaces as a
 * tool-mismatch the guard rejects at the first dispatch.
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  CORE_SLUG,
  DRIVE_READ_CAPABILITY,
  DRIVE_WRITE_CAPABILITY,
  SHEETS_READ_CAPABILITY,
  SHEETS_WRITE_CAPABILITY,
  DOCS_READ_CAPABILITY,
  DOCS_WRITE_CAPABILITY,
} from './manifest.ts'
import {
  type DocsCreateInput,
  type DocsCreateResult,
  type DocsReadInput,
  type DocsReadResult,
  type DocsUpdateInput,
  type DocsUpdateResult,
  type DriveListInput,
  type DriveListResult,
  type DriveReadInput,
  type DriveReadResult,
  type DriveUploadInput,
  type DriveUploadResult,
  type GoogleWorkspaceClient,
  type SheetsReadInput,
  type SheetsReadResult,
  type SheetsWriteInput,
  type SheetsWriteResult,
} from './backend.ts'

export interface DriveListToolInput extends DriveListInput {}
export interface DriveListToolOutput extends DriveListResult {}
export interface DriveReadToolInput extends DriveReadInput {}
export interface DriveReadToolOutput extends DriveReadResult {}
export interface DriveUploadToolInput extends DriveUploadInput {}
export interface DriveUploadToolOutput extends DriveUploadResult {}
export interface SheetsReadToolInput extends SheetsReadInput {}
export interface SheetsReadToolOutput extends SheetsReadResult {}
export interface SheetsAppendToolInput extends SheetsWriteInput {}
export interface SheetsAppendToolOutput extends SheetsWriteResult {}
export interface SheetsUpdateToolInput extends SheetsWriteInput {}
export interface SheetsUpdateToolOutput extends SheetsWriteResult {}
export interface DocsReadToolInput extends DocsReadInput {}
export interface DocsReadToolOutput extends DocsReadResult {}
export interface DocsCreateToolInput extends DocsCreateInput {}
export interface DocsCreateToolOutput extends DocsCreateResult {}
export interface DocsUpdateToolInput extends DocsUpdateInput {}
export interface DocsUpdateToolOutput extends DocsUpdateResult {}

/**
 * Bundle of dependencies the tools dispatch against. The runtime
 * composer constructs this at install time and passes it into
 * `buildTools`; tests pass mocks directly.
 */
export interface ToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  client: GoogleWorkspaceClient
}

export interface BuiltTools {
  drive_list: (input: DriveListToolInput) => Promise<DriveListToolOutput>
  drive_read: (input: DriveReadToolInput) => Promise<DriveReadToolOutput>
  drive_upload: (input: DriveUploadToolInput) => Promise<DriveUploadToolOutput>
  sheets_read: (input: SheetsReadToolInput) => Promise<SheetsReadToolOutput>
  sheets_append: (input: SheetsAppendToolInput) => Promise<SheetsAppendToolOutput>
  sheets_update: (input: SheetsUpdateToolInput) => Promise<SheetsUpdateToolOutput>
  docs_read: (input: DocsReadToolInput) => Promise<DocsReadToolOutput>
  docs_create: (input: DocsCreateToolInput) => Promise<DocsCreateToolOutput>
  docs_update: (input: DocsUpdateToolInput) => Promise<DocsUpdateToolOutput>
}

export function buildTools(deps: ToolDeps): BuiltTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    owner_slug: deps.project_slug,
    audit: deps.audit,
  })

  const drive_list = guard.wrapToolHandler<DriveListToolInput, DriveListToolOutput>({
    tool_name: 'drive_list',
    capability_required: DRIVE_READ_CAPABILITY,
    fn: (input) => deps.client.driveList(input),
  })

  const drive_read = guard.wrapToolHandler<DriveReadToolInput, DriveReadToolOutput>({
    tool_name: 'drive_read',
    capability_required: DRIVE_READ_CAPABILITY,
    fn: (input) => deps.client.driveRead(input),
  })

  const drive_upload = guard.wrapToolHandler<DriveUploadToolInput, DriveUploadToolOutput>({
    tool_name: 'drive_upload',
    capability_required: DRIVE_WRITE_CAPABILITY,
    fn: (input) => deps.client.driveUpload(input),
  })

  const sheets_read = guard.wrapToolHandler<SheetsReadToolInput, SheetsReadToolOutput>({
    tool_name: 'sheets_read',
    capability_required: SHEETS_READ_CAPABILITY,
    fn: (input) => deps.client.sheetsRead(input),
  })

  const sheets_append = guard.wrapToolHandler<SheetsAppendToolInput, SheetsAppendToolOutput>({
    tool_name: 'sheets_append',
    capability_required: SHEETS_WRITE_CAPABILITY,
    fn: (input) => deps.client.sheetsAppend(input),
  })

  const sheets_update = guard.wrapToolHandler<SheetsUpdateToolInput, SheetsUpdateToolOutput>({
    tool_name: 'sheets_update',
    capability_required: SHEETS_WRITE_CAPABILITY,
    fn: (input) => deps.client.sheetsUpdate(input),
  })

  const docs_read = guard.wrapToolHandler<DocsReadToolInput, DocsReadToolOutput>({
    tool_name: 'docs_read',
    capability_required: DOCS_READ_CAPABILITY,
    fn: (input) => deps.client.docsRead(input),
  })

  const docs_create = guard.wrapToolHandler<DocsCreateToolInput, DocsCreateToolOutput>({
    tool_name: 'docs_create',
    capability_required: DOCS_WRITE_CAPABILITY,
    fn: (input) => deps.client.docsCreate(input),
  })

  const docs_update = guard.wrapToolHandler<DocsUpdateToolInput, DocsUpdateToolOutput>({
    tool_name: 'docs_update',
    capability_required: DOCS_WRITE_CAPABILITY,
    fn: (input) => deps.client.docsUpdate(input),
  })

  return {
    drive_list,
    drive_read,
    drive_upload,
    sheets_read,
    sheets_append,
    sheets_update,
    docs_read,
    docs_create,
    docs_update,
  }
}
