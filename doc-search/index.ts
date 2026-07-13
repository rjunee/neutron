/**
 * @neutronai/doc-search — QMD-equivalent local markdown corpus search.
 *
 * A keyword/BM25 search index + query over the owner's project folders
 * (`<owner_home>/Projects/<id>/`), exposed to the live agent as the
 * `doc_search` / `doc_read` tools so it can "research before asking"
 * the way Vajra agents hit QMD. OSS-friendly: pure `bun:sqlite` FTS5
 * keyword/BM25 search, no SaaS dependency and no embedding provider.
 *
 * See docs/SYSTEM-OVERVIEW.md § Doc search for the subsystem overview.
 */

export { chunkMarkdown, deriveTitleFromFilename } from './chunk.ts'
export type { ChunkedDoc, DocChunk, ChunkOptions } from './chunk.ts'

export { sanitizeFtsQuery } from './query.ts'

export { enumerateProjects } from './projects.ts'

export {
  MARKDOWN_EXTENSIONS,
  MAX_DOC_BYTES,
  readProjectDoc,
  walkProjectMarkdown,
} from './walk.ts'
export type { WalkedFile, WalkOptions } from './walk.ts'

export { DocSearchIndex } from './store.ts'
export type {
  ChunkInput,
  DocSearchHit,
  IndexFileInput,
  IndexStats,
  SearchInput,
} from './store.ts'

export { refreshIndex } from './indexer.ts'
export type { RefreshDeps, RefreshStats } from './indexer.ts'

export { DocSearchRuntime } from './runtime.ts'
export type { DocSearchRuntimeOptions } from './runtime.ts'

export {
  DOC_READ_TOOL,
  DOC_SEARCH_TOOL,
  registerDocSearchToolSurface,
} from './tool.ts'
