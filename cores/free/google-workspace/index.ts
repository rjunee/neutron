/**
 * @neutronai/google-workspace-core — public barrel.
 *
 * Tier 1 free Google Workspace Core. Surfaces nine MCP tools to the
 * launcher across three Google services:
 *
 *   Drive  — drive_list / drive_read / drive_upload
 *   Sheets — sheets_read / sheets_append / sheets_update
 *   Docs   — docs_read / docs_create / docs_update
 *
 * Per the gap-audit external-tool floor (P0-6,
 * `docs/research/vajra-neutron-daily-driver-gap-audit-2026-06-20.md`):
 * Drive/Sheets/Docs were MISSING entirely from Neutron; this Core
 * closes that gap. It reuses the SAME per-Core Google OAuth plumbing
 * the Calendar + Email Cores already depend on (the runtime composer
 * drives the install-time prompt + resolves a live access token via
 * the per-Core SecretsAccessor through the shared OAuthTokenManager) —
 * NOT a global token registry. The grant is stored under the distinct
 * `google_workspace` label so it can be connected/disconnected
 * independently of the Calendar/Email grants.
 *
 * SEND/SHARE/DELETE are NOT in scope. The Core reads + creates Drive
 * files, reads/writes Sheet ranges, and reads/creates/edits Docs. It
 * does not delete files, change ACLs/sharing, or move files between
 * folders — those land in a follow-up sprint if the daily-driver
 * surface needs them.
 */

export const __MODULE__ = '@neutronai/google-workspace-core' as const

export {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  DOCS_READ_CAPABILITY,
  DOCS_WRITE_CAPABILITY,
  DRIVE_READ_CAPABILITY,
  DRIVE_WRITE_CAPABILITY,
  OAUTH_SECRET_LABEL,
  SHEETS_READ_CAPABILITY,
  SHEETS_WRITE_CAPABILITY,
  TOOL_NAMES,
  loadManifest,
  type GoogleWorkspaceToolName,
} from './src/manifest.ts'

export {
  DEFAULT_DRIVE_PAGE_SIZE,
  DocNotFoundError,
  DriveFileNotFoundError,
  GOOGLE_EXPORT_DEFAULTS,
  GoogleWorkspaceApiError,
  OAuthMissingError,
  buildGoogleWorkspaceClient,
  buildInMemoryGoogleWorkspaceClient,
  flattenDocBody,
  parseA1Range,
  type DocsCreateInput,
  type DocsCreateResult,
  type DocsDocument,
  type DocsReadInput,
  type DocsReadResult,
  type DocsUpdateInput,
  type DocsUpdateResult,
  type DriveFileContent,
  type DriveFileMeta,
  type DriveListInput,
  type DriveListResult,
  type DriveReadInput,
  type DriveReadResult,
  type DriveUploadInput,
  type DriveUploadResult,
  type FetchLike,
  type GoogleWorkspaceClient,
  type GoogleWorkspaceClientOptions,
  type SheetsReadInput,
  type SheetsReadResult,
  type SheetsWriteInput,
  type SheetsWriteResult,
} from './src/backend.ts'

export {
  buildTools,
  type BuiltTools,
  type DocsCreateToolInput,
  type DocsCreateToolOutput,
  type DocsReadToolInput,
  type DocsReadToolOutput,
  type DocsUpdateToolInput,
  type DocsUpdateToolOutput,
  type DriveListToolInput,
  type DriveListToolOutput,
  type DriveReadToolInput,
  type DriveReadToolOutput,
  type DriveUploadToolInput,
  type DriveUploadToolOutput,
  type SheetsAppendToolInput,
  type SheetsAppendToolOutput,
  type SheetsReadToolInput,
  type SheetsReadToolOutput,
  type SheetsUpdateToolInput,
  type SheetsUpdateToolOutput,
  type ToolDeps,
} from './src/tools.ts'
