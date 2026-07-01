/**
 * @neutronai/notes — Notes Core S1 MCP tools (the four new tools).
 *
 * Adds `notes_create_drawer`, `notes_drawer_list`, `notes_search`,
 * `notes_traverse` on top of the legacy four in `tools.ts`. Each is
 * wrapped by Sprint 31 `CapabilityGuard.wrapToolHandler` so every
 * dispatch is audited.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 6.
 *
 * Project scope: each new tool requires `project_id` explicitly (the
 * brief locks this — legacy 4 tools accept it as optional and fall
 * back to a default; the new 4 require explicit scoping so cross-
 * project leakage is impossible by construction).
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  CORE_SLUG,
  FTS_READ_CAPABILITY,
  READ_CAPABILITY,
  WRITE_CAPABILITY,
} from './manifest.ts'
import type { DrawerKind, DrawerRow } from './notes-store.ts'
import { search, type SearchHit } from './search.ts'
import type { NotesStoreResolver } from './store-resolver.ts'

export interface NotesMcpDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  resolver: NotesStoreResolver
}

export interface NotesCreateDrawerInput {
  project_id: string
  name: string
  kind?: DrawerKind
}

export interface NotesCreateDrawerOutput {
  id: string
}

export interface NotesDrawerListInput {
  project_id: string
}

export interface NotesDrawerListOutput {
  drawers: ReadonlyArray<{
    id: string
    name: string
    kind: DrawerKind
    note_count: number
  }>
}

export interface NotesSearchInput {
  project_id: string
  query: string
  limit?: number
}

export interface NotesSearchOutput {
  results: SearchHit[]
}

export interface NotesTraverseInput {
  project_id: string
  from: string
  depth?: number
}

export interface NotesTraverseOutput {
  nodes: ReadonlyArray<{ id: string; note_id: string | null; label: string | null }>
  edges: ReadonlyArray<{
    id: string
    source_id: string
    target_id: string
    kind: string
    weight: number
  }>
}

export interface NotesMcpTools {
  notes_create_drawer: (input: NotesCreateDrawerInput) => Promise<NotesCreateDrawerOutput>
  notes_drawer_list: (input: NotesDrawerListInput) => Promise<NotesDrawerListOutput>
  notes_search: (input: NotesSearchInput) => Promise<NotesSearchOutput>
  notes_traverse: (input: NotesTraverseInput) => Promise<NotesTraverseOutput>
}

function summariseDrawer(d: DrawerRow): NotesDrawerListOutput['drawers'][number] {
  return { id: d.id, name: d.name, kind: d.kind, note_count: d.note_count }
}

export function buildNotesMcpTools(deps: NotesMcpDeps): NotesMcpTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    project_slug: deps.project_slug,
    audit: deps.audit,
  })

  const notes_create_drawer = guard.wrapToolHandler<NotesCreateDrawerInput, NotesCreateDrawerOutput>({
    tool_name: 'notes_create_drawer',
    capability_required: WRITE_CAPABILITY,
    fn: async (input) => {
      const store = await deps.resolver.resolve(input.project_id)
      const drawerInput: Parameters<typeof store.createDrawer>[0] = {
        name: input.name,
      }
      if (input.kind !== undefined) drawerInput.kind = input.kind
      const drawer = store.createDrawer(drawerInput)
      return { id: drawer.id }
    },
  })

  const notes_drawer_list = guard.wrapToolHandler<NotesDrawerListInput, NotesDrawerListOutput>({
    tool_name: 'notes_drawer_list',
    capability_required: READ_CAPABILITY,
    fn: async (input) => {
      const store = await deps.resolver.resolve(input.project_id)
      const drawers = store.listDrawers().map(summariseDrawer)
      return { drawers }
    },
  })

  const notes_search = guard.wrapToolHandler<NotesSearchInput, NotesSearchOutput>({
    tool_name: 'notes_search',
    capability_required: FTS_READ_CAPABILITY,
    fn: async (input) => {
      const store = await deps.resolver.resolve(input.project_id)
      const searchOpts: Parameters<typeof search>[0] = {
        store,
        project_id: input.project_id,
        query: input.query,
      }
      if (input.limit !== undefined) searchOpts.limit = input.limit
      const results = await search(searchOpts)
      return { results }
    },
  })

  const notes_traverse = guard.wrapToolHandler<NotesTraverseInput, NotesTraverseOutput>({
    tool_name: 'notes_traverse',
    capability_required: READ_CAPABILITY,
    fn: async (input) => {
      const store = await deps.resolver.resolve(input.project_id)
      const traversal = store.traverse(input.from, input.depth ?? 1)
      return {
        nodes: traversal.nodes.map((n) => ({
          id: n.id,
          note_id: n.note_id,
          label: n.label,
        })),
        edges: traversal.edges.map((e) => ({
          id: e.id,
          source_id: e.source_id,
          target_id: e.target_id,
          kind: e.kind,
          weight: e.weight,
        })),
      }
    },
  })

  return { notes_create_drawer, notes_drawer_list, notes_search, notes_traverse }
}

/**
 * Deps bundle the install composer passes to `buildExtraTools`. Same
 * triple every Core carries (manifest / project_slug / audit) plus the
 * per-instance `NotesStoreResolver` the four S1 tools resolve project
 * scope against. The gateway's notes backend factory returns
 * `{ backend, resolver }` so `normalizeBackend` threads BOTH the
 * legacy `backend` (consumed by `buildTools`) and this `resolver`
 * (consumed here) into the single `deps` bundle.
 */
export type NotesExtraToolDeps = NotesMcpDeps

/**
 * Second factory the install pipeline invokes alongside `buildTools`
 * (see gateway/cores/install-bundled.ts — "A Core MAY additionally
 * export `buildExtraTools(deps)`"). Mirrors the Research/Calendar Core
 * split: the legacy four tools (write/recall/list/link) ship in
 * `buildTools`, and these four S1 tools (create_drawer/drawer_list/
 * search/traverse) ship here. Without this export the manifest
 * declares four tools that fall through to `not_implemented` stubs and
 * install logs `manifest_tool_unimplemented core=notes` on every owner
 * boot (ISSUE #330).
 */
export function buildExtraTools(deps: NotesExtraToolDeps): NotesMcpTools {
  return buildNotesMcpTools(deps)
}
