/**
 * @neutronai/notes — capability-guarded MCP tool wiring (legacy four).
 *
 * Four legacy tools the manifest declares (notes_write / notes_recall /
 * notes_list / notes_link). Each is wrapped by the Sprint 31
 * `CapabilityGuard.wrapToolHandler` so every dispatch:
 *   - records `op='tool_call' outcome='ok'` on success
 *   - records `op='tool_call' outcome='capability_denied'` + throws
 *     `CapabilityDeniedError` when the manifest's tool/capability
 *     declarations don't match
 *   - records `op='tool_call' outcome='error'` if the inner handler
 *     throws (and re-throws the error)
 *
 * The four new MCP tools (Notes Core S1, 2026-05-20) live in
 * `mcp-tools.ts`. The legacy four kept here preserve their v0.1.0
 * wire shape — the IMPLEMENTATION delegates through
 * `buildNotesStoreBackend(resolver, default_project_id)` so the
 * underlying storage is the per-project SQLite sidecar.
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  CORE_SLUG,
  READ_CAPABILITY,
  WRITE_CAPABILITY,
} from './manifest.ts'
import type {
  NoteRow,
  NotesBackend,
  NotesLinkInput,
  NotesLinkResult,
  NotesListInput,
  NotesRecallInput,
  NotesWriteInput,
} from './backend.ts'

export interface NotesWriteOutput {
  id: string
}

export interface NotesRecallOutput {
  results: NoteRow[]
}

export interface NotesListOutput {
  results: NoteRow[]
}

export type { NotesLinkInput, NotesLinkResult } from './backend.ts'
export type {
  NoteRow,
  NotesRecallInput,
  NotesListInput,
  NotesWriteInput,
} from './backend.ts'

/**
 * Bundle of dependencies the tools dispatch against. The runtime
 * composer (P3+) constructs this at install time and passes it into
 * `buildTools` — tests pass mocks directly.
 */
export interface ToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  backend: NotesBackend
}

export interface BuiltTools {
  notes_write: (input: NotesWriteInput) => Promise<NotesWriteOutput>
  notes_recall: (input: NotesRecallInput) => Promise<NotesRecallOutput>
  notes_list: (input: NotesListInput) => Promise<NotesListOutput>
  notes_link: (input: NotesLinkInput) => Promise<NotesLinkResult>
}

/**
 * Construct the four tool handlers, each wrapped by the Sprint 31
 * `CapabilityGuard.wrapToolHandler` so every dispatch is audited.
 *
 * The capability strings match the manifest's `tools[]` declarations
 * exactly — wrapping with a different `capability_required` value
 * trips the guard's `capability_mismatch` check at the FIRST call.
 */
export function buildTools(deps: ToolDeps): BuiltTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    project_slug: deps.project_slug,
    audit: deps.audit,
  })

  const notes_write = guard.wrapToolHandler<NotesWriteInput, NotesWriteOutput>({
    tool_name: 'notes_write',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: NotesWriteInput): Promise<NotesWriteOutput> => {
      const { id } = await deps.backend.write(input)
      return { id }
    },
  })

  const notes_recall = guard.wrapToolHandler<NotesRecallInput, NotesRecallOutput>({
    tool_name: 'notes_recall',
    capability_required: READ_CAPABILITY,
    fn: async (input: NotesRecallInput): Promise<NotesRecallOutput> => {
      const results = await deps.backend.recall(input)
      return { results }
    },
  })

  const notes_list = guard.wrapToolHandler<NotesListInput, NotesListOutput>({
    tool_name: 'notes_list',
    capability_required: READ_CAPABILITY,
    fn: async (input: NotesListInput): Promise<NotesListOutput> => {
      const results = await deps.backend.list(input)
      return { results }
    },
  })

  const notes_link = guard.wrapToolHandler<NotesLinkInput, NotesLinkResult>({
    tool_name: 'notes_link',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: NotesLinkInput): Promise<NotesLinkResult> => {
      return deps.backend.link(input)
    },
  })

  return { notes_write, notes_recall, notes_list, notes_link }
}
