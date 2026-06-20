/**
 * @neutronai/connect — the one-way host→collaborator MEMORY MIRROR
 * (connect-spec §1.8 + §2.4). IMPORT-ON-JOIN milestone.
 *
 * WHAT THIS IS. When a collaborator joins a shared project, a SNAPSHOT of that
 * shared project's GBrain GRAPH layer — entities (pages) + relations (typed
 * edges); embeddings are RE-DERIVED on import, not shipped — is copied
 * ONE-DIRECTIONALLY from the host into the joining collaborator's OWN GBrain,
 * scoped + tagged `source=<project>@<host>` and carrying the §4 `author`
 * attribution. The host's memory stays canonical; the collaborator's copy is a
 * scoped, read-oriented recall replica for cross-project recall.
 *
 * WHAT THIS IS NOT (connect-spec §2.4). This is NOT the deleted content-sync
 * mesh: it is one-directional (host → collaborator, never back), it carries the
 * GRAPH layer (not the raw transcript log), and it has NO quarantine, NO
 * syndication bus, NO `last_seq_seen` cursor-replica, and NO write-back. Do not
 * rebuild syndication-log/-sink/-subscriber to serve it.
 *
 * SCOPING. GBrain is per-instance today (single-source `default`; per-project
 * GBRAIN_SOURCE sub-scoping is future work). The host-side export therefore
 * reads whatever the host's already-instance-scoped `McpClient` exposes —
 * scoping the client to the right instance is the caller's responsibility (the
 * same contract `memory-store.ts` documents). The collaborator-side import
 * re-namespaces every imported slug under the `source` partition so a mirrored
 * page never clobbers the collaborator's own same-named page, and stamps the
 * `source` + `author` into each entry's frontmatter so recall knows WHO
 * authored each fact and WHICH shared project it came from.
 *
 * IDEMPOTENCY / ONE-TIME. The import is gated on the `shared_project_mirrors`
 * ledger (SharedProjectMirrorStore): a (project_id, source) already imported is
 * skipped, so a re-accept / reconnect does not re-import a duplicate snapshot.
 *
 * PHASING. This module is the import-on-join milestone ONLY. The ongoing LIVE
 * fan-out of NEW host activity to active collaborators is a later trident
 * (connect-spec §7 C-E phasing) and is deliberately not built here.
 */

import {
  type McpClient,
  isGbrainBinaryMissingError,
} from '../gbrain-memory/memory-store.ts'

/** A single mirrored entity page — slug + body, optional per-fact author. */
export interface MirrorPage {
  slug: string
  content: string
  /** The §4 author id of the fact on the host, if the host graph recorded it. */
  author?: string | null
}

/** A single mirrored typed relation between two entity slugs. */
export interface MirrorEdge {
  from: string
  to: string
  link_type: string
  context?: string | null
}

/** The graph-layer snapshot shipped host→collaborator (NO raw transcript). */
export interface GraphSnapshot {
  pages: MirrorPage[]
  edges: MirrorEdge[]
}

/** A uniform §4 author reference. */
export interface MirrorAuthor {
  id: string
  display?: string
}

/**
 * The host's §4 author #0 (connect-spec §4 / migration 0071 note: the author id
 * is "the member's collision-free local_slug, or 'owner'"). Used as the
 * fallback per-fact author for snapshot pages that carry no author of their own
 * — host facts are the host OWNER's by default, disambiguated from the
 * collaborator's own `owner` by the `source=<project>@<host>` scope tag. (When
 * GBrain pages later carry per-fact author, the snapshot preserves it and this
 * fallback applies only to legacy/unattributed pages.)
 */
export const OWNER_AUTHOR_ID = 'owner'

/** A host-side graph source the import pulls a snapshot from. In-process today
 *  (InProcessGraphSource over the host's McpClient); the HTTP transport for the
 *  genuinely-distributed case lands with the live fan-out trident. */
export interface SharedProjectGraphSource {
  fetchSnapshot(projectId: string): Promise<GraphSnapshot>
}

export interface MirrorResult {
  /** The scope tag stamped on every imported entry. */
  source: string
  /** True when the snapshot was already imported (one-time skip). */
  reused: boolean
  page_count: number
  edge_count: number
}

/**
 * The scope tag stamped on every mirrored entry: `<projectId>@<host>`. Encodes
 * BOTH which shared project the fact came from AND which host is canonical for
 * it, so the collaborator's recall can attribute + (later) refresh it.
 */
export function formatMirrorSource(projectId: string, host: string): string {
  return `${projectId}@${host}`
}

/**
 * Re-namespace a host page slug into the collaborator's mirror partition so a
 * mirrored page never clobbers the collaborator's own same-named page. The
 * source is sanitised to a slug-safe token; the original slug is preserved as
 * the suffix. Deterministic, so edges (which reference slugs) re-point onto the
 * same mirrored pages.
 */
export function mirroredSlug(source: string, slug: string): string {
  const safeSource = source.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `mirror-${safeSource}-${slug}`
}

const FRONTMATTER_FENCE = '---'

/**
 * Inject the `source` + `author` scope tags into a page body's frontmatter so
 * they ride along with the imported entry and are queryable by recall. If the
 * body already opens with a `---` frontmatter block the keys are inserted into
 * it (no double block); otherwise a fresh frontmatter block is prepended.
 */
export function tagPageContent(
  content: string,
  source: string,
  author: string | null,
): string {
  const tags = [`source: ${source}`]
  if (author !== null && author.length > 0) tags.push(`author: ${author}`)
  const tagBlock = tags.join('\n')

  const body = content ?? ''
  if (body.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    // Find the closing fence of the existing frontmatter block.
    const close = body.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length + 1)
    if (close !== -1) {
      const head = body.slice(0, close) // up to (not incl) the closing "\n---"
      const tail = body.slice(close) // from "\n---" onward
      return `${head}\n${tagBlock}${tail}`
    }
  }
  // No parseable frontmatter — prepend a fresh block.
  return `${FRONTMATTER_FENCE}\n${tagBlock}\n${FRONTMATTER_FENCE}\n\n${body}`
}

/** Tag an edge's context with the source scope (append, preserving any host context). */
function tagEdgeContext(context: string | null | undefined, source: string): string {
  const base = context !== null && context !== undefined && context.length > 0 ? `${context} ` : ''
  return `${base}[mirror:${source}]`
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function asRows(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.map(asRecord)
  const o = asRecord(v)
  for (const key of ['results', 'rows', 'result', 'data', 'pages', 'links', 'hits']) {
    const inner = o[key]
    if (Array.isArray(inner)) return inner.map(asRecord)
  }
  return []
}

/**
 * Field delimiter for the edge-dedupe key. A PRINTABLE-TEXT escape (the ASCII
 * unit separator, 0x1F) written as `\x1f` so the SOURCE FILE stays plain text —
 * the previous implementation embedded a RAW NUL byte, which made `grep` treat
 * this whole module as binary and SILENTLY skip it in leak-gate / review greps
 * (Argus r3 IMPORTANT). The runtime value is a single control char that cannot
 * occur inside a slug or link_type, so the dedupe key never collides.
 */
const EDGE_DEDUPE_DELIM = '\x1f'

/**
 * gbrain `list_pages` caps `limit` at 100 (operations.ts: `clampSearchLimit(.,50,100)`)
 * and the MCP op exposes NO offset/cursor — only `updated_after` (a STRICT
 * `updated_at > value` filter). The batch size we page with; defaults to the cap.
 */
const LIST_PAGES_BATCH = 100

function pageSlug(row: Record<string, unknown>): string {
  return String(row['slug'] ?? row['id'] ?? row['page_id'] ?? '')
}

function pageUpdatedAt(row: Record<string, unknown>): string {
  return typeof row['updated_at'] === 'string' ? (row['updated_at'] as string) : ''
}

/**
 * Enumerate EVERY page row from the host GBrain, keyset-paging `list_pages` over
 * `updated_at` ascending. A single `list_pages` call caps at 100 rows and the
 * MCP op exposes no offset/cursor, so a one-shot call SILENTLY truncates any
 * shared project with >100 GBrain pages — the mirror would then record a PARTIAL
 * snapshot as COMPLETE in the one-time ledger and never retry (Argus r3 BLOCKING).
 * We loop until a batch comes back short of `batchSize`.
 *
 * Tie-safety: `updated_after` is a STRICT `>`, so a timestamp group straddling a
 * full-batch boundary would be lost. On a FULL batch we therefore HOLD BACK the
 * rows sharing the batch's max `updated_at` and rewind the cursor to the previous
 * distinct timestamp; the held-back group then returns IN FULL on the next round
 * (a `seen` slug set drops the re-fetched overlap). A short (tail) batch, or a
 * full batch that shares a single identical timestamp (which cannot be rewound
 * without a skip), is taken as-is to guarantee forward progress.
 */
async function listAllPages(
  mcp: McpClient,
  batchSize: number = LIST_PAGES_BATCH,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let updatedAfter: string | undefined

  for (;;) {
    const batch = asRows(
      await mcp.call('list_pages', {
        sort: 'updated_asc',
        limit: batchSize,
        ...(updatedAfter !== undefined ? { updated_after: updatedAfter } : {}),
      }),
    )
    if (batch.length === 0) break

    const full = batch.length >= batchSize
    let maxTs = ''
    for (const row of batch) {
      const ts = pageUpdatedAt(row)
      if (ts > maxTs) maxTs = ts
    }
    // Largest timestamp STRICTLY below maxTs in this batch — the cursor we rewind
    // to when holding back the maxTs group. '' ⇒ the whole batch shares one ts.
    let belowMax = ''
    for (const row of batch) {
      const ts = pageUpdatedAt(row)
      if (ts !== maxTs && ts > belowMax) belowMax = ts
    }
    // Hold the (possibly truncated) maxTs group back for a full re-fetch ONLY when
    // the batch is full AND there is a lower timestamp to rewind to.
    const holdBackMaxTs = full && belowMax !== '' && maxTs !== ''

    for (const row of batch) {
      if (holdBackMaxTs && pageUpdatedAt(row) === maxTs) continue
      const slug = pageSlug(row)
      if (slug.length === 0 || seen.has(slug)) continue
      seen.add(slug)
      out.push(row)
    }

    if (!full) break

    const nextCursor = holdBackMaxTs ? belowMax : maxTs
    // No forward progress possible (no usable timestamp, or the cursor didn't
    // advance): stop rather than loop forever.
    if (nextCursor === '' || nextCursor === updatedAfter) break
    updatedAfter = nextCursor
  }

  return out
}

/**
 * Host side: export the shared project's graph layer (entities + relations)
 * from the host's GBrain over MCP. list_pages → per page get_page (body) +
 * get_links (typed edges). Embeddings are intentionally NOT exported — the
 * collaborator's GBrain re-derives them on put_page import.
 *
 * Best-effort against GBrain shape drift (defensive row extraction); raises
 * only on a hard MCP failure the caller wants surfaced.
 */
export async function exportProjectGraphSnapshot(mcp: McpClient): Promise<GraphSnapshot> {
  // Page through ALL host pages (NOT just the first list_pages batch of 100) so a
  // >100-page shared project is mirrored in full, not silently truncated.
  const pageRows = await listAllPages(mcp)
  const pages: MirrorPage[] = []
  const edges: MirrorEdge[] = []
  const seenEdge = new Set<string>()

  for (const row of pageRows) {
    const slug = pageSlug(row)
    if (slug.length === 0) continue

    // Body: list_pages carries no body, so read the page itself.
    const pageRec = asRecord(await mcp.call('get_page', { slug }))
    const content = String(
      pageRec['content'] ?? pageRec['body'] ?? pageRec['compiled_truth'] ?? pageRec['text'] ?? '',
    )
    const author =
      typeof pageRec['author'] === 'string'
        ? (pageRec['author'] as string)
        : typeof pageRec['author_id'] === 'string'
          ? (pageRec['author_id'] as string)
          : null
    pages.push({ slug, content, author })

    // Typed edges out of this page.
    for (const edgeRow of asRows(await mcp.call('get_links', { slug }))) {
      const from = String(edgeRow['from_slug'] ?? edgeRow['from'] ?? slug)
      const to = String(edgeRow['to_slug'] ?? edgeRow['to'] ?? edgeRow['object'] ?? '')
      const linkType = String(edgeRow['link_type'] ?? edgeRow['predicate'] ?? '')
      if (to.length === 0 || linkType.length === 0) continue
      const dedupe = `${from}${EDGE_DEDUPE_DELIM}${to}${EDGE_DEDUPE_DELIM}${linkType}`
      if (seenEdge.has(dedupe)) continue
      seenEdge.add(dedupe)
      const context =
        typeof edgeRow['context'] === 'string' ? (edgeRow['context'] as string) : null
      edges.push({ from, to, link_type: linkType, context })
    }
  }

  return { pages, edges }
}

/** An in-process graph source: reads the snapshot straight from a host McpClient. */
export class InProcessGraphSource implements SharedProjectGraphSource {
  constructor(private readonly hostMcp: McpClient) {}
  async fetchSnapshot(_projectId: string): Promise<GraphSnapshot> {
    return exportProjectGraphSnapshot(this.hostMcp)
  }
}

/**
 * Collaborator side: write a snapshot into the collaborator's own GBrain,
 * scoped under `source` and §4-author-tagged. Pages → put_page (re-embeds);
 * typed edges → add_link, re-pointed onto the mirrored slugs. Returns the
 * counts actually written.
 */
export async function importGraphSnapshot(
  mcp: McpClient,
  snapshot: GraphSnapshot,
  source: string,
  factAuthorFallback: string,
): Promise<{ page_count: number; edge_count: number }> {
  let pageCount = 0
  for (const page of snapshot.pages) {
    const factAuthor =
      page.author !== null && page.author !== undefined && page.author.length > 0
        ? page.author
        : factAuthorFallback
    await mcp.call('put_page', {
      slug: mirroredSlug(source, page.slug),
      content: tagPageContent(page.content, source, factAuthor),
    })
    pageCount++
  }

  let edgeCount = 0
  for (const edge of snapshot.edges) {
    await mcp.call('add_link', {
      from: mirroredSlug(source, edge.from),
      to: mirroredSlug(source, edge.to),
      link_type: edge.link_type,
      context: tagEdgeContext(edge.context, source),
    })
    edgeCount++
  }

  return { page_count: pageCount, edge_count: edgeCount }
}

export interface ImportSharedProjectMemoryInput {
  /** The shared project the snapshot comes from (host-side id). */
  projectId: string
  /** The host instance slug / home authority (display + audit + scope tag). */
  host: string
  /** The §4 author the JOIN is attributed to (the joining collaborator). Used
   *  for the ledger audit ("which join triggered this import"); NOT the per-fact
   *  author of the host's snapshot (those default to the host owner — see
   *  OWNER_AUTHOR_ID). */
  author: MirrorAuthor
}

export interface ImportSharedProjectMemoryDeps {
  /** Where the host snapshot is fetched from (in-process today). */
  source: SharedProjectGraphSource
  /** The COLLABORATOR's own GBrain MCP client (the import target). */
  memory: McpClient
  /** The collaborator-side one-time-import ledger (idempotency + audit). */
  store: import('./shared-project-mirror-store.ts').SharedProjectMirrorStore
  now?: () => number
}

/**
 * The import-on-join orchestrator (connect-spec §1.8(a)). One-time, scoped,
 * author-tagged. Skips (reused) if the (projectId, source) snapshot was already
 * imported. Read-only collaborators get the mirror too — read gates *posting*
 * (§1.4), never recall (§1.8) — so this function does NOT branch on access.
 *
 * Best-effort against a missing GBrain binary: if the collaborator's GBrain is
 * unreachable the join must still succeed, so a binary-missing failure is
 * swallowed (the snapshot can be re-imported once GBrain is present, since the
 * ledger is only written on a successful import). Any other error propagates.
 */
export async function importSharedProjectMemoryOnJoin(
  deps: ImportSharedProjectMemoryDeps,
  input: ImportSharedProjectMemoryInput,
): Promise<MirrorResult> {
  const source = formatMirrorSource(input.projectId, input.host)

  if (deps.store.has(input.projectId, source)) {
    const existing = deps.store.get(input.projectId, source)
    return {
      source,
      reused: true,
      page_count: existing?.page_count ?? 0,
      edge_count: existing?.edge_count ?? 0,
    }
  }

  let counts: { page_count: number; edge_count: number }
  try {
    const snapshot = await deps.source.fetchSnapshot(input.projectId)
    // Host snapshot facts default to the host OWNER (§4 author #0); the source
    // tag disambiguates them from the collaborator's own `owner`.
    counts = await importGraphSnapshot(deps.memory, snapshot, source, OWNER_AUTHOR_ID)
  } catch (err) {
    if (isGbrainBinaryMissingError(err)) {
      // GBrain absent on this host — degrade gracefully, do NOT write the
      // ledger (so a retry once GBrain is installed re-imports cleanly), and do
      // NOT fail the join.
      return { source, reused: false, page_count: 0, edge_count: 0 }
    }
    throw err
  }

  const now = deps.now ?? ((): number => Date.now())
  await deps.store.record({
    project_id: input.projectId,
    source,
    host: input.host,
    author_id: input.author.id,
    page_count: counts.page_count,
    edge_count: counts.edge_count,
    imported_at: new Date(now()).toISOString(),
  })

  return { source, reused: false, page_count: counts.page_count, edge_count: counts.edge_count }
}
