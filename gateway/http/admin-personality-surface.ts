/**
 * @neutronai/gateway/http — Admin-tab personality editor surface (2026-05-22).
 *
 * Per docs/plans/2026-05-22-003-feat-admin-personality-editor-plan.md.
 *
 * Owns four routes under `/api/app/persona/*`:
 *
 *   - `GET   /files`                  list the 3 persona files
 *                                     (`{ filename, exists, size_bytes,
 *                                       last_modified_iso }`).
 *   - `GET   /file?name=<name>`       return file body (text/markdown)
 *                                     + `X-Mtime: <ms>` header. Missing
 *                                     file → 200 + empty body + `X-Mtime: 0`
 *                                     so the editor can render a fresh-pane
 *                                     state.
 *   - `PATCH /file?name=<name>`       atomic write
 *                                     (`writeFile(tmp); rename(tmp,target)`).
 *                                     Body `{ content, expected_mtime }`.
 *                                     Stale mtime → 409 + `current_mtime`.
 *                                     `expected_mtime: -1` force-overwrites.
 *                                     Body > `MAX_PERSONA_FILE_BYTES` → 413.
 *                                     Fires the optional `onReload(name)`
 *                                     hook on success.
 *   - `POST  /restart-from-scratch`   `{ confirm: true }` → unlinks the 3
 *                                     files (best-effort, ignores ENOENT)
 *                                     + fires `onReload` per deleted file
 *                                     + delegates phase-reset to the
 *                                     optional `onRestartFromScratch` hook.
 *
 * Allow-list (anything else → 403 `filename_not_allowed`):
 *   - `SOUL.md`
 *   - `USER.md`
 *   - `priority-map.md`
 *
 * Auth: shared `AppWsAuthResolver` (same Bearer flow as
 * launcher / tasks / reminders / admin), with the same per-instance
 * bearer guard at `app-admin-surface.ts:171-177`.
 *
 * Hot-reload:
 *   - `runtime/system-prompt.ts:71-80` reads workspace files fresh on every
 *     `assembleSystemPrompt` call; no in-memory cache exists today.
 *     `assembleSystemPrompt` itself is currently unused by the production
 *     runtime — only the onboarding interview path calls `buildSystemPrompt`.
 *     So "hot-reload" is structurally a no-op today.
 *   - The surface still exposes `onReload?(filename)` so a future composer
 *     can invalidate any cache that lands. The production composer leaves
 *     it unwired in this sprint; tests assert the call-site fires.
 *
 * Restart-from-scratch scope:
 *   - This sprint deletes the three files only.
 *   - Full onboarding state reset (DELETE FROM p2_onboarding_state, restore
 *     phase to `persona_synthesizing`, clear transcript-jsonl, etc.) is
 *     deferred — the surface exposes `onRestartFromScratch?` so the
 *     production composer can wire a phase-reset adapter when that lands.
 *   - Failure of the hook does NOT block the file deletion — files are
 *     deleted first, then the hook is invoked (best-effort with the
 *     `onboarding_reset` field in the response reflecting whether the
 *     hook fired without throwing).
 *
 * Concurrency (ISSUE #33 + ISSUE #35, 2026-05-22):
 *   - GET /file uses a single FD (`open(path, O_RDONLY | O_NOFOLLOW)`)
 *     across `fh.readFile()` + `fh.stat()` so the returned (body, mtime)
 *     pair is always grounded in the same inode even under a concurrent
 *     `rename(target, alt)` / `rename(other, target)` between the read
 *     and the stat — closes ISSUE #35's GET-path TOCTOU completely. Any
 *     post-open I/O error (EISDIR, EACCES, transient read failure, etc.)
 *     falls through to the empty-body branch so a directory or otherwise
 *     unreadable persona path renders a fresh-pane editor instead of a
 *     500. GET routes are NOT serialized by the mutex — they're
 *     read-only and the held FD is the entire correctness story.
 *   - PATCH /file and POST /restart-from-scratch hold a per-instance
 *     mutex around their file-system critical section (mtime check via
 *     held FD + write/rename for PATCH; unlink loop for restart) —
 *     closes ISSUE #33 PATCH-vs-restart and PATCH-vs-PATCH races.
 *     POSIX rename is atomic at the directory-entry level and a held
 *     FD does NOT block a concurrent `rename(other, target)`, so the
 *     dir-entry rename-clobber that the FD alone cannot stop is what
 *     the mutex is for. FD-pinning (ISSUE #35) ties the verified mtime
 *     to a real inode; the mutex (ISSUE #33) ensures no concurrent
 *     rename slips in between the FD's stat and PATCH's rename. Both
 *     layers together close ISSUE #35's PATCH-path completely.
 *   - The lock is NOT held across `req.json()` parsing or field
 *     validation — a slow/never-ending chunked body would otherwise
 *     hold the per-instance lock indefinitely and DoS every subsequent
 *     persona save/restart for that instance (Codex P2 review on PR
 *     #290 — kept the critical section narrow).
 *   - The mutex is keyed by `project_slug` so cross-instance calls run
 *     in parallel.
 */

import { randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync } from 'node:fs'
import { mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { ownerSlugMismatch } from './auth-helpers.ts'
import { createKeyedMutex, type KeyedMutex } from './keyed-mutex.ts'

/** The three persona files committed by `onboarding/persona-gen/compose.ts:commit`. */
export const ALLOWED_PERSONA_FILENAMES = [
  'SOUL.md',
  'USER.md',
  'priority-map.md',
] as const

export type PersonaFilename = (typeof ALLOWED_PERSONA_FILENAMES)[number]

/** Maximum body size accepted by PATCH. Persona files in the wild run
 *  ~3 KB (SOUL.md template). 256 KB is well above that but tight enough
 *  to bound the disk + request shape. Tests pass this exact bound. */
export const MAX_PERSONA_FILE_BYTES = 256 * 1024

const PATH_PREFIX = '/api/app/persona'

export interface AdminPersonalitySurfaceOptions {
  auth: AppWsAuthResolver
  /** Absolute path to the instance home dir — files live at `<owner_home>/persona/<name>`. */
  owner_home: string
  /** Per-instance slug for the bearer guard. */
  project_slug: string
  /**
   * Optional cache-invalidation hook. Fires once per successful PATCH
   * and once per file actually deleted by `restart-from-scratch`. The
   * production composer leaves this unwired in 2026-05-22; future
   * persona-cache wiring binds it to its invalidation entry point.
   */
  onReload?: (filename: PersonaFilename) => void
  /**
   * Optional onboarding phase-reset hook. When wired, the surface
   * delegates the "bounce the user back to `persona_synthesizing`"
   * side of restart-from-scratch to it. When unwired, the surface
   * only deletes files; `onboarding_reset: false` is reported back to
   * the client so the UI can hint at the limitation.
   *
   * Hook errors do NOT propagate — they are logged + result in
   * `onboarding_reset: false` so the user still sees the file
   * deletion succeeded.
   */
  onRestartFromScratch?: () => Promise<void>
  /** `Date.now` override for deterministic tests. */
  now?: () => number
}

export interface AdminPersonalitySurface {
  /** Returns the `Response` for an owned route, or `null` to fall
   *  through to the downstream chain in `compose.ts`. */
  handler: (req: Request) => Promise<Response | null>
}

export function createAdminPersonalitySurface(
  opts: AdminPersonalitySurfaceOptions,
): AdminPersonalitySurface {
  const { auth, owner_home, project_slug } = opts
  const onReload = opts.onReload
  const onRestartFromScratch = opts.onRestartFromScratch
  // Per-instance lock — closes ISSUE #33 PATCH-vs-restart race AND
  // ISSUE #35 PATCH-path dir-entry rename clobber. Acquired INSIDE
  // each mutating handler, scoped to the filesystem critical section
  // only (not request parsing).
  const mutex = createKeyedMutex()
  return {
    handler: async (req): Promise<Response | null> => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_PREFIX)) return null

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }
      if (ownerSlugMismatch(resolved.project_slug, project_slug)) {
        return jsonError(
          403,
          'project_mismatch',
          `bearer project '${resolved.project_slug}' does not match gateway project '${project_slug}'`,
        )
      }

      const route = pathname.slice(PATH_PREFIX.length)
      const method = req.method

      if (route === '/files') {
        if (method === 'GET') return await handleListFiles(owner_home)
        return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /files`)
      }
      if (route === '/file') {
        if (method === 'GET') return await handleGetFile(req, owner_home)
        if (method === 'PATCH') {
          const patchInput: PatchFileInput = { req, owner_home, mutex, project_slug }
          if (onReload !== undefined) patchInput.onReload = onReload
          return await handlePatchFile(patchInput)
        }
        return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /file`)
      }
      if (route === '/restart-from-scratch') {
        if (method === 'POST') {
          const restartInput: RestartInput = { req, owner_home, mutex, project_slug }
          if (onReload !== undefined) restartInput.onReload = onReload
          if (onRestartFromScratch !== undefined) {
            restartInput.onRestartFromScratch = onRestartFromScratch
          }
          return await handleRestart(restartInput)
        }
        return jsonError(
          405,
          'method_not_allowed',
          `method '${method}' not allowed on /restart-from-scratch`,
        )
      }
      return jsonError(404, 'unknown_persona_route', `no persona route at '${pathname}'`)
    },
  }
}

interface FileSummary {
  filename: PersonaFilename
  exists: boolean
  size_bytes: number
  last_modified_iso: string | null
}

async function handleListFiles(owner_home: string): Promise<Response> {
  const files: FileSummary[] = []
  for (const filename of ALLOWED_PERSONA_FILENAMES) {
    const target = personaPath(owner_home, filename)
    try {
      const st = await stat(target)
      files.push({
        filename,
        exists: true,
        size_bytes: st.size,
        last_modified_iso: new Date(st.mtimeMs).toISOString(),
      })
    } catch {
      files.push({ filename, exists: false, size_bytes: 0, last_modified_iso: null })
    }
  }
  return jsonOk({ files })
}

async function handleGetFile(req: Request, owner_home: string): Promise<Response> {
  const url = new URL(req.url)
  const name = url.searchParams.get('name')
  if (name === null || name.length === 0) {
    return jsonError(400, 'missing_name', 'expected ?name=<filename>')
  }
  const filename = parseFilename(name)
  if (filename === null) {
    return jsonError(
      403,
      'filename_not_allowed',
      `filename '${name}' is not in the allow-list`,
    )
  }
  const target = personaPath(owner_home, filename)
  // ISSUE #35 (Codex P2 cross-model on PR #280): close the file-level
  // TOCTOU between read and stat. `Promise.all([readFile, stat])` does
  // TWO separate path resolves; a concurrent `rename(target, alt)` /
  // `rename(other, target)` between them yields a mismatched
  // body+mtime pair (old body, new mtime; or vice versa). Holding ONE
  // fhandle for the duration ties body + mtime to the same inode even
  // if the path entry is concurrently replaced — `fh.readFile()` and
  // `fh.stat()` both go through the FD, not the path.
  //
  // `O_NOFOLLOW` mirrors the persona-loader fix from ISSUE #37: a
  // owner-writable `persona/SOUL.md -> /etc/passwd` symlink would
  // otherwise let the admin GET splice arbitrary file contents into
  // the editor. Defense-in-depth — admin writes go through `writeFile`
  // to literal paths, but the structural guarantee beats relying on
  // that contract.
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    // Missing file (or symlink rejected by O_NOFOLLOW → ELOOP) → 200 +
    // empty body + X-Mtime: 0. The client renders a fresh "(no file
    // yet)" pane. Symlinks are treated as missing for the editor's
    // purposes — admin writes always replace via atomic rename, so a
    // symlink at this path is anomalous and should not be readable.
    return emptyPersonaResponse()
  }
  try {
    // Argus r1 B1 (2026-05-23): catch post-open I/O errors. POSIX
    // allows `open(O_RDONLY)` on a directory, so if the persona path
    // ever resolved to a directory (corruption / misadministered
    // owner_home), `fh.readFile()` would throw EISDIR and the route
    // would 500. The pre-fix code wrapped `readFile + stat` in a
    // single try/catch that returned 200 + empty body on ANY error;
    // restore that behavior here so the editor renders a fresh-pane
    // state instead of a hard error.
    try {
      const [body, st] = await Promise.all([fh.readFile('utf8'), fh.stat()])
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'x-mtime': String(Math.floor(st.mtimeMs)),
        },
      })
    } catch {
      return emptyPersonaResponse()
    }
  } finally {
    await fh.close()
  }
}

function emptyPersonaResponse(): Response {
  return new Response('', {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'x-mtime': '0',
    },
  })
}

interface PatchFileInput {
  req: Request
  owner_home: string
  mutex: KeyedMutex
  project_slug: string
  onReload?: (filename: PersonaFilename) => void
}

async function handlePatchFile(input: PatchFileInput): Promise<Response> {
  const url = new URL(input.req.url)
  const name = url.searchParams.get('name')
  if (name === null || name.length === 0) {
    return jsonError(400, 'missing_name', 'expected ?name=<filename>')
  }
  const filename = parseFilename(name)
  if (filename === null) {
    return jsonError(
      403,
      'filename_not_allowed',
      `filename '${name}' is not in the allow-list`,
    )
  }
  // Security P1-1 (Argus r1 2026-05-22): content-length preflight to
  // bound the body BEFORE `req.json()` reads + parses it. Otherwise a
  // malicious client could ship a 128 MiB JSON document (Bun's default
  // body cap) and OOM the per-instance gateway. The cap is the same as
  // the post-parse check (256 KB) plus a small allowance for JSON
  // encoding overhead (4 KB). Chunked requests bypass content-length;
  // those still hit the post-parse cap below as a defense-in-depth.
  const declared_len = parseInt(input.req.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declared_len) && declared_len > MAX_PERSONA_FILE_BYTES + 4096) {
    return jsonError(
      413,
      'payload_too_large',
      `declared content-length ${declared_len} exceeds ${MAX_PERSONA_FILE_BYTES} bytes`,
    )
  }
  const body = await readJsonBody(input.req)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    // Security P2-2 (Argus r1 2026-05-22): reject JSON primitives /
    // arrays / null so downstream `as Record<string, unknown>` doesn't
    // index-access a non-object and silently return undefined for
    // every field check.
    return jsonError(400, 'malformed_json', 'expected a JSON object body')
  }
  const fields = body as Record<string, unknown>
  const content = fields['content']
  if (typeof content !== 'string') {
    return jsonError(400, 'invalid_content', 'content must be a string')
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_PERSONA_FILE_BYTES) {
    return jsonError(
      413,
      'payload_too_large',
      `content exceeds ${MAX_PERSONA_FILE_BYTES} bytes`,
    )
  }
  const raw_mtime = fields['expected_mtime']
  if (typeof raw_mtime !== 'number' || !Number.isFinite(raw_mtime)) {
    return jsonError(
      400,
      'missing_expected_mtime',
      'expected_mtime must be a finite number (use 0 for new files, -1 to force-overwrite)',
    )
  }
  const expected_mtime = Math.floor(raw_mtime)
  // Argus r1 TS-8 (2026-05-22): negative values other than -1 are
  // nonsense — they would always 409 with a confusing "expected_mtime
  // -7 does not match on-disk 0" message. Reject up-front.
  if (expected_mtime < -1) {
    return jsonError(
      400,
      'invalid_expected_mtime',
      'expected_mtime must be >= 0 (or exactly -1 to force-overwrite)',
    )
  }

  const target = personaPath(input.owner_home, filename)
  // ISSUE #33 + ISSUE #35: hold the per-instance lock around the
  // mtime check (via held FD) + write/rename ONLY. Request parsing +
  // content-length preflight + JSON body parse happened above without
  // the lock so a slow / never-ending body cannot DoS the instance by
  // holding the mutex indefinitely.
  //
  // FD pinning (ISSUE #35) ties the mtime guard to the INODE we're
  // about to replace, not the path. The mutex (ISSUE #33) serializes
  // sibling PATCH calls + restart so no concurrent rename lands
  // between the FD's stat and PATCH's rename(tmp, target). The held
  // FD does NOT block a concurrent dir-entry swap — POSIX rename is
  // entry-level atomic and operates on the path, not the FD — so the
  // mutex is the second layer that closes that gap.
  //
  // O_NOFOLLOW: mirrors the persona-loader ISSUE #37 fix —
  // verify-target should never resolve through an owner-writable
  // symlink. Defense-in-depth; admin writes go through this surface
  // via atomic rename, so no symlink should exist here in practice.
  return input.mutex.withLock(input.project_slug, async () => {
    let fh: Awaited<ReturnType<typeof open>> | null = null
    try {
      if (expected_mtime !== -1) {
        let current_mtime = 0
        try {
          fh = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
          const st = await fh.stat()
          current_mtime = Math.floor(st.mtimeMs)
        } catch {
          // ENOENT (missing) or ELOOP (symlink rejected) →
          // current_mtime stays 0 so a fresh PATCH (expected_mtime: 0)
          // still creates the file.
        }
        if (current_mtime !== expected_mtime) {
          return jsonResponse(409, {
            ok: false,
            code: 'mtime_conflict',
            current_mtime,
            message: `expected_mtime ${expected_mtime} does not match on-disk ${current_mtime}`,
          })
        }
      }

      await ensureDir(dirname(target))
      const tmp = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(tmp, content, 'utf8')
        await rename(tmp, target)
      } catch (err) {
        // Best-effort cleanup of the temp file on failure.
        try {
          await unlink(tmp)
        } catch {
          // ignored
        }
        return jsonError(
          500,
          'write_failed',
          `failed to write ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      const final_st = await stat(target)
      const new_mtime = Math.floor(final_st.mtimeMs)
      try {
        input.onReload?.(filename)
      } catch (err) {
        console.warn(`[admin-personality] onReload(${filename}) hook threw`, err)
      }
      return jsonOk({ mtime: new_mtime })
    } finally {
      if (fh !== null) await fh.close()
    }
  })
}

interface RestartInput {
  req: Request
  owner_home: string
  mutex: KeyedMutex
  project_slug: string
  onReload?: (filename: PersonaFilename) => void
  onRestartFromScratch?: () => Promise<void>
}

async function handleRestart(input: RestartInput): Promise<Response> {
  const body = await readJsonBody(input.req)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'malformed_json', 'expected a JSON object body')
  }
  const fields = body as Record<string, unknown>
  // Strict literal-true check (NOT truthy) — keeps `confirm: "true"` /
  // `confirm: 1` / `confirm: []` from accidentally triggering the
  // destructive operation. Security P3-3 follow-up gate.
  if (fields['confirm'] !== true) {
    return jsonError(
      400,
      'confirm_required',
      'pass { confirm: true } to acknowledge the destructive operation',
    )
  }
  // ISSUE #33: hold the per-instance lock around the unlink loop ONLY so
  // a PATCH cannot land between two unlinks and be silently deleted by
  // the next iteration. Body parse + confirm validation happened above
  // without the lock.
  return input.mutex.withLock(input.project_slug, async () => {
    return runRestartCriticalSection(input)
  })
}

async function runRestartCriticalSection(input: RestartInput): Promise<Response> {
  const files_deleted: PersonaFilename[] = []
  // Codex r1 P2 fix (2026-05-22): surface partial-deletion failures so
  // the client doesn't show a green "Restart succeeded" banner when
  // permissions / locks / type-mismatch left a persona file on disk.
  const files_failed: Array<{ filename: PersonaFilename; code: string; message: string }> = []
  for (const filename of ALLOWED_PERSONA_FILENAMES) {
    const target = personaPath(input.owner_home, filename)
    try {
      await unlink(target)
      files_deleted.push(filename)
      try {
        input.onReload?.(filename)
      } catch (err) {
        console.warn(`[admin-personality] onReload(${filename}) hook threw during restart`, err)
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'
      if (code === 'ENOENT') continue // best-effort: missing file is fine
      console.warn(`[admin-personality] unlink(${filename}) failed`, err)
      files_failed.push({
        filename,
        code,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  let onboarding_reset = false
  if (input.onRestartFromScratch !== undefined) {
    try {
      await input.onRestartFromScratch()
      onboarding_reset = true
    } catch (err) {
      console.warn(`[admin-personality] onRestartFromScratch hook threw`, err)
    }
  }
  // If any file failed to delete, return 207 (partial success) so the
  // client can distinguish "complete" from "some files survived".
  const status = files_failed.length === 0 ? 200 : 207
  return jsonOk({ files_deleted, files_failed, onboarding_reset }, status)
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
    return { code: 'missing_bearer', message: 'expected Authorization: Bearer <token>' }
  }
  const token = header.slice('bearer '.length).trim()
  const resolved = await auth.resolve(token)
  if ('code' in resolved) return { code: resolved.code, message: resolved.message }
  return { user_id: resolved.user_id, project_slug: resolved.project_slug }
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

function parseFilename(raw: string): PersonaFilename | null {
  // Argus r1 TS-6 (2026-05-22): runtime check first via the wider
  // string view, narrow via cast AFTER the membership check is true.
  return (ALLOWED_PERSONA_FILENAMES as readonly string[]).includes(raw)
    ? (raw as PersonaFilename)
    : null
}

function personaPath(owner_home: string, filename: PersonaFilename): string {
  return join(owner_home, 'persona', filename)
}

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true })
  }
}

function jsonOk(body: object, status = 200): Response {
  return jsonResponse(status, { ok: true, ...(body as Record<string, unknown>) })
}

function jsonError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { ok: false, code, message })
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
