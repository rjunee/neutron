/**
 * @neutronai/gateway/http — Expo-app project-scoped backups / restore surface (P7.4 restore UI).
 *
 * Per SPEC.md Phases→Steps (was SPEC.md § Phases→Steps P7 + this sprint's brief
 * (`docs/plans/P7.4-restore-ui-sprint-brief.md`). EVERY route this surface owns
 * lives under the ONE `/api/app/projects/<project_id>/backups` prefix:
 *
 *   - GET  .../backups                    list snapshots, newest first
 *   - GET  .../backups/<sha>              snapshot preview (files + diff stat)
 *   - GET  .../backups/<sha>/file?path=X  read one file's body at <sha>
 *   - GET  .../backups/<sha>/diff?path=X  unified diff for one file vs HEAD
 *   - POST .../backups/restore            perform a restore op
 *
 * THE RESTORE ROUTE USED TO BE `POST .../restore`, AND THAT WAS A COLLISION,
 * not a naming preference. `app-projects-surface.ts:560` claims the very same
 * `POST /api/app/projects/<id>/restore` for a completely different operation —
 * un-archiving a project back onto the rail — and its rung sits EARLIER in the
 * ladder (`route-slots.ts`: `app-projects` before `app-backups`), so it won
 * every time. A snapshot restore therefore un-archived the project and answered
 * `200 {restored:true}`: a silent wrong answer, which is worse than the 404 the
 * caller would have got had this surface simply been absent. Nesting under
 * `backups/` makes the two disjoint by SHAPE rather than by ladder order, so no
 * future reordering can bring the collision back. `app-projects-surface.ts`
 * claims only bare single-segment per-project actions (`/archive`, `/restore`,
 * `/settings`, `/invite`, …) and nothing under `/backups`.
 *
 * The four read routes share the per-instance bearer + slug-mismatch
 * gate used elsewhere on the app surface. POST .../backups/restore additionally
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
import { jsonError, jsonOk, ownerSlugMismatch, readJsonBody, resolveBearer } from './surface-kit.ts'

const SNAPSHOT_SHA_RE = /^[0-9a-f]{40}$/

/**
 * One regex that owns every shape the surface routes, and it is anchored on the
 * `backups` segment so the surface can never claim a bare per-project action
 * that `app-projects-surface.ts` owns. Capture groups are
 * (project_id, segment, optional-tail):
 *   segment = 'restore' | a 40-hex sha | absent (the list route)
 *   tail    = 'file' | 'diff' (only meaningful when segment is a sha)
 *
 * `restore` and a sha share the same slot because they are mutually exclusive:
 * `restore` is not 40-hex, so the alternation is unambiguous. The one shape the
 * regex admits but the surface does not serve is `/backups/restore/{file,diff}`,
 * which the handler answers 404 `unknown_backups_route`.
 */
const BACKUPS_PATH_RE =
  /^\/api\/app\/projects\/([^/]+)\/backups(?:\/(restore|[0-9a-f]{40})(?:\/(file|diff))?)?$/

/** The one non-sha `segment` value — a restore is a write on the backups resource. */
const RESTORE_SEGMENT = 'restore'

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
      const segment = match[2] ?? null
      const tail = match[3] ?? null
      const is_restore = segment === RESTORE_SEGMENT
      const sha = is_restore ? null : segment
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
        if (is_restore) {
          // `/backups/restore/file` and `/backups/restore/diff` parse but mean
          // nothing — those tails belong to a sha. Answer the surface's own 404
          // rather than falling through to the ladder's, so the caller can tell
          // "this surface is here and that path is wrong" from "not mounted".
          if (tail !== null) {
            return jsonError(
              404,
              'unknown_backups_route',
              `no backup route at '${pathname}'`,
            )
          }
          if (method !== 'POST') {
            return jsonError(
              405,
              'method_not_allowed',
              `method '${method}' not allowed on /backups/restore`,
            )
          }
          return await handleRestore(req, store, project_id)
        }
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
