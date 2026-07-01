/**
 * @neutronai/notes — public barrel (v0.2.0, Notes Core S1).
 *
 * Tier 1 free Second-Brain Core. Self-contained drawers / wings /
 * rooms / notes / KG-nodes / KG-edges over per-project SQLite at
 * `<OWNER_HOME>/Projects/<project_id>/notes/notes.db`.
 *
 * Surfaces:
 *  - 8 MCP tools (4 legacy + 4 new — drawer, search, traverse,
 *    drawer_list)
 *  - chat-command parser + dispatcher (`/note <body>`, `/note find`,
 *    `/note drawer`, `/note tunnel`)
 *  - drawer-browser HTTP surface (mounted under
 *    `/api/cores/notes/...` by the gateway composer)
 *  - P5.3 launcher tile binding (opens the app-tab at
 *    `/projects/<id>/notes`)
 *
 * Per docs/plans/notes-core-tier1-brief.md.
 *
 * Cross-refs:
 * - SPEC.md § Phases→Steps (Tier 1 Cores buildout)
 * - docs/research/neutron-cores-marketplace-split-2026-05-17.md
 * - cores/sdk/SDK-CONTRACT.md (the runtime API surface)
 * - cores/runtime (install / capability gate / audit log)
 */

export const __MODULE__ = '@neutronai/notes' as const

export {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  FTS_READ_CAPABILITY,
  FTS_WRITE_CAPABILITY,
  READ_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
  type NotesToolName,
} from './src/manifest.ts'

export {
  NOTE_KIND_LINK,
  NOTE_KIND_NOTE,
  buildMemoryStoreNotesBackend,
  buildNotesStoreBackend,
  type NoteRow,
  type NotesBackend,
  type NotesLinkInput,
  type NotesLinkResult,
  type NotesListInput,
  type NotesRecallInput,
  type NotesStoreBackendOptions,
  type NotesWriteInput,
} from './src/backend.ts'

export {
  buildTools,
  type BuiltTools,
  type NotesListOutput,
  type NotesRecallOutput,
  type NotesWriteOutput,
  type ToolDeps,
} from './src/tools.ts'

export {
  DEFAULT_INBOX_DRAWER_NAME,
  DRAWER_KIND_ARCHIVE,
  DRAWER_KIND_CUSTOM,
  DRAWER_KIND_INBOX,
  DRAWER_KIND_PINNED,
  KG_EDGE_KIND_AUTO_TUNNEL,
  KG_EDGE_KIND_USER_TUNNEL,
  KG_NODE_KIND_NOTE,
  NOTES_SCHEMA_VERSION,
  NotesSidecarMismatchError,
  NotesStore,
  NotesStoreError,
  sanitizeFtsQuery,
  type DrawerKind,
  type DrawerRow,
  type KgEdgeKind,
  type KgEdgeRow,
  type KgNodeRow,
  type NoteCreateDrawerInput,
  type NoteListOptions,
  type NoteRow as NotesNoteRow,
  type NoteSourceKind,
  type NoteWriteInput as NotesStoreWriteInput,
  type NoteWriteResult,
  type NotesStoreOptions,
} from './src/notes-store.ts'

export {
  DEFAULT_MIGRATIONS_DIR,
  NOTES_SIDECAR_DB,
  NOTES_SIDECAR_DIR,
  NotesStoreResolver,
  type NotesStoreResolverOptions,
} from './src/store-resolver.ts'

export {
  createInMemoryActiveDrawerStore,
  executeNoteCommand,
  parseNoteCommand,
  type ActiveDrawerKey,
  type ActiveDrawerStore,
  type NoteCommand,
  type NoteCommandContext,
  type NoteCommandResponse,
} from './src/chat-commands.ts'

export {
  createNotesChatCommandFilter,
  type CreateNotesChatCommandFilterOptions,
  type NotesChatCommandFilter,
  type NotesChatCommandFilterInput,
  type NotesChatCommandFilterResult,
} from './src/chat-bridge.ts'

export { search, type SearchHit, type SearchOptions } from './src/search.ts'

export {
  buildExtraTools,
  buildNotesMcpTools,
  type NotesCreateDrawerInput,
  type NotesCreateDrawerOutput,
  type NotesDrawerListInput,
  type NotesDrawerListOutput,
  type NotesExtraToolDeps,
  type NotesMcpDeps,
  type NotesMcpTools,
  type NotesSearchInput,
  type NotesSearchOutput,
  type NotesTraverseInput,
  type NotesTraverseOutput,
} from './src/mcp-tools.ts'

export {
  LAUNCHER_ICON,
  type NotesLauncherIcon,
} from './src/ui/launcher-icon.ts'

export {
  createNotesDrawerBrowserSurface,
  type NotesDrawerBrowserSurface,
  type NotesDrawerBrowserSurfaceOptions,
} from './src/ui/drawer-browser-surface.ts'
