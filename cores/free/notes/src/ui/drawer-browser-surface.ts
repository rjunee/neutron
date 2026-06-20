/**
 * @neutronai/notes — drawer-browser HTTP surface.
 *
 * Backs the in-app Notes tab (the P5.3 launcher tile opens this).
 * Mirrors P5.4 tasks + P5.5 reminders surface shape (bearer-token +
 * owner scope + JSON envelope, returns `null` for non-owned paths so
 * the gateway compose chain keeps falling through).
 *
 * Per docs/plans/notes-core-tier1-brief.md § 3.3.
 *
 * Routes (all under `/api/cores/notes/...`):
 *   GET  /api/cores/notes/drawers?project_id=<id>
 *   GET  /api/cores/notes/drawers/<drawer_id>?project_id=<id>
 *   POST /api/cores/notes/drawers                  body: {project_id, name, kind?}
 *   GET  /api/cores/notes/notes/<note_id>?project_id=<id>
 *   POST /api/cores/notes/notes                    body: {project_id, drawer_id?, content, tags?}
 *   POST /api/cores/notes/notes/<note_id>/tunnel   body: {project_id, target_id}
 *   GET  /api/cores/notes/search?project_id=<id>&q=<query>&limit=<n>
 *   GET  /api/cores/notes/traverse?project_id=<id>&from=<note_id>&depth=<1..3>
 */

import type { NotesStore } from '../notes-store.ts'
import { NotesStoreError } from '../notes-store.ts'
import type { NotesStoreResolver } from '../store-resolver.ts'
import { search } from '../search.ts'

/**
 * Bearer-token auth resolver. Shape mirrors
 * `gateway/channels/adapters/app-ws/auth.ts:AppWsAuthResolver` so the
 * production composer hands the same resolver instance through.
 */
export interface NotesAuthResolver {
  resolve(
    token: string,
  ): Promise<
    | { project_slug: string; user_id: string }
    | { code: string; message: string }
  >
}

export interface NotesDrawerBrowserSurfaceOptions {
  resolver: NotesStoreResolver
  auth: NotesAuthResolver
}

export interface NotesDrawerBrowserSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route,
   * or `null` to indicate the request belongs to a sibling surface.
   */
  handler: (req: Request) => Promise<Response | null>
}

const PATH_PREFIX = '/api/cores/notes'

const PROJECT_ID_RE = /^[A-Za-z0-9_.\-]{1,128}$/

const MAX_QUERY_LEN = 1024
const MAX_NOTE_BODY_LEN = 64 * 1024
const MAX_DRAWER_NAME_LEN = 120
const MAX_TAGS = 16
const MAX_TAG_LEN = 64

export function createNotesDrawerBrowserSurface(
  opts: NotesDrawerBrowserSurfaceOptions,
): NotesDrawerBrowserSurface {
  const { resolver, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_PREFIX)) return null
      // OAuth-prefixed paths under /api/cores/oauth/... are owned by
      // the OAuth surface; disclaim them by returning null so the
      // compose chain reaches the right handler.
      if (pathname.startsWith('/api/cores/oauth/')) return null

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonResponse(401, {
          ok: false,
          code: resolved.code,
          message: resolved.message,
        })
      }

      const method = req.method
      const rest = pathname.slice(PATH_PREFIX.length)

      try {
        // GET /api/cores/notes/drawers
        if (rest === '/drawers' && method === 'GET') {
          return await handleDrawerList(url, resolver)
        }
        // POST /api/cores/notes/drawers
        if (rest === '/drawers' && method === 'POST') {
          return await handleDrawerCreate(req, resolver)
        }
        // GET /api/cores/notes/drawers/<id>
        const drawerMatch = rest.match(/^\/drawers\/([^/]+)$/)
        if (drawerMatch !== null && method === 'GET') {
          const drawer_id = drawerMatch[1]
          if (drawer_id === undefined) return notFound()
          return await handleDrawerShow(url, resolver, drawer_id)
        }
        // POST /api/cores/notes/notes
        if (rest === '/notes' && method === 'POST') {
          return await handleNoteCreate(req, resolver)
        }
        // GET /api/cores/notes/notes/<id>
        const noteShowMatch = rest.match(/^\/notes\/([^/]+)$/)
        if (noteShowMatch !== null && method === 'GET') {
          const note_id = noteShowMatch[1]
          if (note_id === undefined) return notFound()
          return await handleNoteShow(url, resolver, note_id)
        }
        // POST /api/cores/notes/notes/<id>/tunnel
        const tunnelMatch = rest.match(/^\/notes\/([^/]+)\/tunnel$/)
        if (tunnelMatch !== null && method === 'POST') {
          const note_id = tunnelMatch[1]
          if (note_id === undefined) return notFound()
          return await handleTunnelCreate(req, resolver, note_id)
        }
        // GET /api/cores/notes/search
        if (rest === '/search' && method === 'GET') {
          return await handleSearch(url, resolver)
        }
        // GET /api/cores/notes/traverse
        if (rest === '/traverse' && method === 'GET') {
          return await handleTraverse(url, resolver)
        }
        // The path is under our prefix but no verb matched. 405 with
        // the canonical envelope so clients can render the failure.
        return jsonResponse(405, {
          ok: false,
          code: 'method_not_allowed',
          message: `unknown notes route '${rest}' or method '${method}'`,
        })
      } catch (err) {
        if (err instanceof NotesStoreError) {
          const status = err.code === 'unknown_drawer' || err.code === 'unknown_note' ? 404 : 400
          return jsonResponse(status, { ok: false, code: err.code, message: err.message })
        }
        const message = err instanceof Error ? err.message : 'unknown'
        return jsonResponse(500, { ok: false, code: 'internal_error', message })
      }
    },
  }
}

async function handleDrawerList(
  url: URL,
  resolver: NotesStoreResolver,
): Promise<Response> {
  const project_id = readProjectId(url)
  if (project_id === null) return invalidProjectId()
  const store = await resolver.resolve(project_id)
  const drawers = store.listDrawers().map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    note_count: d.note_count,
    updated_at: d.updated_at,
  }))
  return jsonResponse(200, { ok: true, drawers, project_id })
}

async function handleDrawerCreate(
  req: Request,
  resolver: NotesStoreResolver,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) return malformedJson()
  const project_id = readBodyProjectId(body)
  if (project_id === null) return invalidProjectId()
  const name = readBodyString(body, 'name', MAX_DRAWER_NAME_LEN)
  if (name === null) return jsonResponse(400, {
    ok: false,
    code: 'missing_name',
    message: 'expected { project_id, name, kind? }',
  })
  const store = await resolver.resolve(project_id)
  const drawer = store.createDrawer({ name })
  return jsonResponse(200, { ok: true, id: drawer.id, drawer, project_id })
}

async function handleDrawerShow(
  url: URL,
  resolver: NotesStoreResolver,
  drawer_id: string,
): Promise<Response> {
  const project_id = readProjectId(url)
  if (project_id === null) return invalidProjectId()
  const store = await resolver.resolve(project_id)
  const drawer = store.getDrawer(drawer_id)
  if (drawer === null) {
    return jsonResponse(404, {
      ok: false,
      code: 'unknown_drawer',
      message: `drawer ${drawer_id} not found`,
    })
  }
  const notes = store.listNotes({ drawer_id, limit: 100 }).map(summariseNote)
  return jsonResponse(200, { ok: true, drawer, notes, project_id })
}

async function handleNoteCreate(
  req: Request,
  resolver: NotesStoreResolver,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) return malformedJson()
  const project_id = readBodyProjectId(body)
  if (project_id === null) return invalidProjectId()
  const content = readBodyString(body, 'content', MAX_NOTE_BODY_LEN)
  if (content === null) return jsonResponse(400, {
    ok: false,
    code: 'missing_content',
    message: 'expected { project_id, content, drawer_id?, tags? }',
  })
  const drawer_id_raw = (body as Record<string, unknown>)['drawer_id']
  const drawer_id = typeof drawer_id_raw === 'string' && drawer_id_raw.length > 0 ? drawer_id_raw : undefined
  const tags_raw = (body as Record<string, unknown>)['tags']
  const tags = Array.isArray(tags_raw)
    ? (tags_raw as unknown[])
        .filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= MAX_TAG_LEN)
        .slice(0, MAX_TAGS)
    : []
  const store = await resolver.resolve(project_id)
  const writeOpts: Parameters<NotesStore['write']>[0] = {
    content,
    source_kind: 'launcher',
  }
  if (drawer_id !== undefined) writeOpts.drawer_id = drawer_id
  if (tags.length > 0) writeOpts.tags = tags
  const result = store.write(writeOpts)
  return jsonResponse(200, {
    ok: true,
    id: result.id,
    drawer_id: result.drawer_id,
    project_id,
  })
}

async function handleNoteShow(
  url: URL,
  resolver: NotesStoreResolver,
  note_id: string,
): Promise<Response> {
  const project_id = readProjectId(url)
  if (project_id === null) return invalidProjectId()
  const store = await resolver.resolve(project_id)
  const note = store.getNote(note_id)
  if (note === null) {
    return jsonResponse(404, {
      ok: false,
      code: 'unknown_note',
      message: `note ${note_id} not found`,
    })
  }
  const tunnels_out = store.outgoingTunnels(note_id).map(summariseEdge)
  const tunnels_in = store.incomingTunnels(note_id).map(summariseEdge)
  return jsonResponse(200, {
    ok: true,
    note: summariseNote(note),
    tunnels_in,
    tunnels_out,
    project_id,
  })
}

async function handleTunnelCreate(
  req: Request,
  resolver: NotesStoreResolver,
  from_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) return malformedJson()
  const project_id = readBodyProjectId(body)
  if (project_id === null) return invalidProjectId()
  const target_id_raw = (body as Record<string, unknown>)['target_id']
  if (typeof target_id_raw !== 'string' || target_id_raw.length === 0) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_target_id',
      message: 'expected { project_id, target_id }',
    })
  }
  const store = await resolver.resolve(project_id)
  const edge = store.tunnel(from_id, target_id_raw)
  return jsonResponse(200, {
    ok: true,
    edge_id: edge.id,
    source_id: edge.source_id,
    target_id: edge.target_id,
    project_id,
  })
}

async function handleSearch(
  url: URL,
  resolver: NotesStoreResolver,
): Promise<Response> {
  const project_id = readProjectId(url)
  if (project_id === null) return invalidProjectId()
  const query = (url.searchParams.get('q') ?? '').slice(0, MAX_QUERY_LEN)
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw !== null ? Number.parseInt(limitRaw, 10) : 10
  const store = await resolver.resolve(project_id)
  const searchOpts: Parameters<typeof search>[0] = {
    store,
    project_id,
    query,
  }
  if (Number.isFinite(limit) && limit > 0) searchOpts.limit = limit
  const results = await search(searchOpts)
  return jsonResponse(200, { ok: true, results, project_id, query })
}

async function handleTraverse(
  url: URL,
  resolver: NotesStoreResolver,
): Promise<Response> {
  const project_id = readProjectId(url)
  if (project_id === null) return invalidProjectId()
  const from = url.searchParams.get('from') ?? ''
  if (from.length === 0) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_from',
      message: 'expected ?from=<note_id>',
    })
  }
  const depthRaw = url.searchParams.get('depth')
  const depth = depthRaw !== null ? Number.parseInt(depthRaw, 10) : 1
  const store = await resolver.resolve(project_id)
  const traversal = store.traverse(from, Number.isFinite(depth) && depth > 0 ? depth : 1)
  return jsonResponse(200, {
    ok: true,
    nodes: traversal.nodes,
    edges: traversal.edges,
    project_id,
  })
}

function summariseNote(note: {
  id: string
  drawer_id: string
  content: string
  tags: readonly string[]
  updated_at: number
  created_at: number
}) {
  return {
    id: note.id,
    drawer_id: note.drawer_id,
    snippet: note.content.length > 240 ? note.content.slice(0, 240) : note.content,
    tags: [...note.tags],
    created_at: note.created_at,
    updated_at: note.updated_at,
    tag_count: note.tags.length,
  }
}

function summariseEdge(edge: {
  id: string
  source_id: string
  target_id: string
  kind: string
  weight: number
  created_at: number
}) {
  return {
    id: edge.id,
    source_id: edge.source_id,
    target_id: edge.target_id,
    kind: edge.kind,
    weight: edge.weight,
    created_at: edge.created_at,
  }
}

async function resolveBearer(
  req: Request,
  auth: NotesAuthResolver,
): Promise<{ project_slug: string; user_id: string } | { code: string; message: string }> {
  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    return { code: 'missing_bearer', message: 'expected Authorization: Bearer <token>' }
  }
  const token = header.slice('bearer '.length).trim()
  return auth.resolve(token)
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

function readProjectId(url: URL): string | null {
  const raw = url.searchParams.get('project_id')
  if (raw === null) return null
  return PROJECT_ID_RE.test(raw) ? raw : null
}

function readBodyProjectId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const raw = (body as Record<string, unknown>)['project_id']
  if (typeof raw !== 'string') return null
  return PROJECT_ID_RE.test(raw) ? raw : null
}

function readBodyString(body: unknown, key: string, maxLen: number): string | null {
  if (typeof body !== 'object' || body === null) return null
  const v = (body as Record<string, unknown>)[key]
  if (typeof v !== 'string') return null
  const trimmed = v.length > maxLen ? v.slice(0, maxLen) : v
  return trimmed.length > 0 ? trimmed : null
}

function invalidProjectId(): Response {
  return jsonResponse(400, {
    ok: false,
    code: 'invalid_project_id',
    message: 'project_id must match /^[A-Za-z0-9_.-]{1,128}$/',
  })
}

function malformedJson(): Response {
  return jsonResponse(400, { ok: false, code: 'malformed_json', message: 'invalid json' })
}

function notFound(): Response {
  return jsonResponse(404, { ok: false, code: 'not_found', message: 'unknown route' })
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
