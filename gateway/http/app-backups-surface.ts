/**
 * @neutronai/gateway/http — Expo-app project-scoped backups / restore surface (P7.4 restore UI).
 *
 * Per SPEC.md Phases→Steps (was SPEC.md § Phases→Steps P7 + this sprint's brief
 * (`docs/plans/P7.4-restore-ui-sprint-brief.md`). Mounts four routes
 * under `/api/app/projects/<project_id>/`:
 *
 *   - GET  .../backups                    list snapshots, newest first
 *   - GET  .../backups/<sha>              snapshot preview (files + diff stat)
 *   - GET  .../backups/<sha>/file?path=X  read one file's body at <sha>
 *   - GET  .../backups/<sha>/diff?path=X  unified diff for one file vs HEAD
 *   - POST .../restore                    perform a restore op
 *
 * The four read routes share the per-instance bearer + slug-mismatch
 * gate used elsewhere on the app surface. POST .../restore additionally
 * requires a JSON body `{ snapshot_sha: string, file_path?: string | null }`.
 *
 * Storage: every route is a thin wrapper over `ProjectBackupStore`.
 * The store owns the underlying git invocations + path / sha
 * validation; this surface only translates errors → HTTP shapes.
 */

import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import {
  InvalidSnapshotPathError,
  InvalidSnapshotShaError,
  ProjectBackupStore,
  RestoreUnavailableError,
  SnapshotNotFoundError,
  SnapshotPathNotFoundError,
} from '../git/project-backup-store.ts'
import { ownerSlugMismatch } from './auth-helpers.ts'

const SNAPSHOT_SHA_RE = /^[0-9a-f]{40}$/

/**
 * One regex that owns every shape the surface routes. Capture groups
 * are (project_id, action, optional-sha, optional-tail):
 *   action = 'backups' | 'restore'
 *   sha    = 40-hex (when action === 'backups')
 *   tail   = 'file' | 'diff' (when action === 'backups' and sha set)
 *
 * `restore` is its own action — no sha, no tail.
 */
const BACKUPS_PATH_RE =
  /^\/api\/app\/projects\/([^/]+)\/(backups|restore)(?:\/([0-9a-f]{40}))?(?:\/(file|diff))?$/

export interface AppBackupsSurfaceOptions {
  auth: AppWsAuthResolver
  /** Per-instance slug — cross-instance probes return 403 with a stable code. */
  project_slug: string
  /** P7.4 Phase 2 project-backup store. Required. */
  store: ProjectBackupStore
}

export interface AppBackupsSurface {
  handler: (req: Request) => Promise<Response | null>
}

export function createAppBackupsSurface(
  opts: AppBackupsSurfaceOptions,
): AppBackupsSurface {
  const { auth, project_slug: gateway_project_slug, store } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith('/api/app/projects/')) return null
      const match = BACKUPS_PATH_RE.exec(pathname)
      if (match === null) return null
      const raw_project_id = match[1] ?? ''
      const action = match[2] ?? ''
      const sha = match[3] ?? null
      const tail = match[4] ?? null
      const project_id = sanitizeProjectId(raw_project_id)
      if (project_id === null) {
        return jsonError(
          400,
          'invalid_project_id',
          'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
        )
      }
      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }
      if (ownerSlugMismatch(resolved.project_slug, gateway_project_slug)) {
        return jsonError(
          403,
          'project_mismatch',
          `bearer project '${resolved.project_slug}' does not match gateway project '${gateway_project_slug}'`,
        )
      }

      const method = req.method
      try {
        if (action === 'backups') {
          if (sha === null) {
            // GET /backups — list snapshots.
            if (method !== 'GET') {
              return jsonError(
                405,
                'method_not_allowed',
                `method '${method}' not allowed on /backups`,
              )
            }
            return await handleListSnapshots(req, store, project_id)
          }
          if (tail === null) {
            // GET /backups/<sha> — preview.
            if (method !== 'GET') {
              return jsonError(
                405,
                'method_not_allowed',
                `method '${method}' not allowed on /backups/<sha>`,
              )
            }
            return await handleSnapshotPreview(store, project_id, sha)
          }
          if (tail === 'file') {
            if (method !== 'GET') {
              return jsonError(
                405,
                'method_not_allowed',
                `method '${method}' not allowed on /backups/<sha>/file`,
              )
            }
            return await handleSnapshotFile(req, store, project_id, sha)
          }
          if (tail === 'diff') {
            if (method !== 'GET') {
              return jsonError(
                405,
                'method_not_allowed',
                `method '${method}' not allowed on /backups/<sha>/diff`,
              )
            }
            return await handleSnapshotDiff(req, store, project_id, sha)
          }
          return jsonError(
            404,
            'unknown_backups_route',
            `no backup route at '${pathname}'`,
          )
        }
        // action === 'restore'
        if (method !== 'POST') {
          return jsonError(
            405,
            'method_not_allowed',
            `method '${method}' not allowed on /restore`,
          )
        }
        return await handleRestore(req, store, project_id)
      } catch (err) {
        return jsonForError(err)
      }
    },
  }
}

async function handleListSnapshots(
  req: Request,
  store: ProjectBackupStore,
  project_id: string,
): Promise<Response> {
  const url = new URL(req.url)
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw === null ? undefined : Number(limitRaw)
  if (
    limitRaw !== null &&
    (!Number.isFinite(limit as number) || (limit as number) <= 0)
  ) {
    return jsonError(400, 'invalid_limit', 'limit must be a positive number')
  }
  const cursor = url.searchParams.get('cursor')
  if (cursor !== null && !SNAPSHOT_SHA_RE.test(cursor)) {
    return jsonError(400, 'invalid_cursor', 'cursor must be a 40-char hex sha')
  }
  const opts: { limit?: number; before_sha?: string } = {}
  if (limit !== undefined) opts.limit = limit
  if (cursor !== null) opts.before_sha = cursor
  const result = await store.listSnapshots(project_id, opts)
  return jsonOk({
    snapshots: result.snapshots,
    next_cursor: result.next_cursor,
  })
}

async function handleSnapshotPreview(
  store: ProjectBackupStore,
  project_id: string,
  sha: string,
): Promise<Response> {
  const preview = await store.previewSnapshot(project_id, sha)
  return jsonOk({ preview })
}

async function handleSnapshotFile(
  req: Request,
  store: ProjectBackupStore,
  project_id: string,
  sha: string,
): Promise<Response> {
  const path = new URL(req.url).searchParams.get('path')
  if (path === null || path.length === 0) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  const content = await store.getSnapshotFileContent(project_id, sha, path)
  return jsonOk({ file: content })
}

async function handleSnapshotDiff(
  req: Request,
  store: ProjectBackupStore,
  project_id: string,
  sha: string,
): Promise<Response> {
  const path = new URL(req.url).searchParams.get('path')
  if (path === null || path.length === 0) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  const diff = await store.getSnapshotFileDiff(project_id, sha, path)
  return jsonOk({ diff })
}

async function handleRestore(
  req: Request,
  store: ProjectBackupStore,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body')
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(
      400,
      'malformed_json',
      'expected a JSON object body',
    )
  }
  const fields = body as Record<string, unknown>
  const snapshot_sha = readStringField(fields['snapshot_sha'])
  if (snapshot_sha === null) {
    return jsonError(
      400,
      'missing_snapshot_sha',
      'expected { snapshot_sha: string, file_path?: string | null }',
    )
  }
  let file_path: string | null = null
  const rawFile = fields['file_path']
  if (rawFile !== undefined && rawFile !== null) {
    if (typeof rawFile !== 'string' || rawFile.length === 0) {
      return jsonError(
        400,
        'invalid_file_path',
        'file_path must be a non-empty string or null',
      )
    }
    file_path = rawFile
  }
  const result = await store.restore(project_id, snapshot_sha, file_path)
  return jsonOk({ restore: result })
}

interface ResolvedAuth {
  user_id: string
  project_slug: string
}

interface AuthFailure {
  code: string
  message: string
}

async function resolveBearer(
  req: Request,
  auth: AppWsAuthResolver,
): Promise<ResolvedAuth | AuthFailure> {
  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    return {
      code: 'missing_bearer',
      message: 'expected Authorization: Bearer <token>',
    }
  }
  const token = header.slice('bearer '.length).trim()
  const resolved = await auth.resolve(token)
  if ('code' in resolved) {
    return { code: resolved.code, message: resolved.message }
  }
  return { user_id: resolved.user_id, project_slug: resolved.project_slug }
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

function readStringField(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  return raw
}

function jsonForError(err: unknown): Response {
  if (err instanceof SnapshotNotFoundError) {
    return jsonError(404, err.code, err.message)
  }
  if (err instanceof SnapshotPathNotFoundError) {
    return jsonError(404, err.code, err.message)
  }
  if (err instanceof InvalidSnapshotShaError) {
    return jsonError(400, err.code, err.message)
  }
  if (err instanceof InvalidSnapshotPathError) {
    return jsonError(400, err.code, err.message)
  }
  if (err instanceof RestoreUnavailableError) {
    return jsonError(503, err.code, err.message)
  }
  throw err
}

function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
