/**
 * @neutronai/gateway/http — chat-attachment upload surface (P5.1).
 *
 * Per SPEC.md § Phases→Steps / P5.1 (chat surface,
 * image attachments via multipart upload). Closes Argus r1 BLOCKING #1:
 * the Expo client's `app/lib/upload-client.ts` POSTs every image to
 * `${base_url}/api/app/upload`, but the route did not exist — every
 * production attach silently 404'd and the bubble flipped to failed.
 *
 * Surface contract:
 *
 *   - `POST /api/app/upload`
 *       Bearer-authed via the shared `AppWsAuthResolver`.
 *       Body: multipart/form-data with a single `file` part. The part's
 *       declared `Content-Type` is canonicalised and cross-checked
 *       against magic-byte sniffing; spoofed or non-image bytes are
 *       rejected.
 *       Size cap: 10 MiB (configurable via `max_bytes`). The cap is
 *       enforced first via the request's `Content-Length` header so a
 *       hostile client cannot drive the gateway to buffer huge bodies
 *       before the size check fires.
 *       Whitelist: PNG / JPEG / GIF / WEBP only — P5.1 ships image
 *       attachments only per the brief; non-image MIMEs are a P7 docs
 *       routing concern.
 *       Storage: content-addressed under
 *         `<owner_home>/chat-attachments/<user_id>/<hash>.<ext>`
 *       Per-user namespace prevents a cross-user enumeration via the
 *       returned URL, and content-addressing means re-uploading the
 *       same bytes is idempotent — the second upload returns the same
 *       URL without re-writing the blob.
 *       Returns 200 `{ ok: true, url, content_type, size_bytes }` where
 *       `url` is the relative path the matching GET handler serves
 *       (`/api/app/upload/<user_id>/<hash>.<ext>`).
 *
 *   - `GET /api/app/upload/<user_id>/<hash>.<ext>`
 *       Bearer-authed. The bearer's `user_id` MUST match the path
 *       segment so a token leak only reveals attachments uploaded by
 *       the same user; cross-user GETs return 403.
 *       Streams the bytes with the canonical content-type and a
 *       long-lived immutable cache hint (content-addressed → safe to
 *       cache forever per hash).
 *
 * Path safety: the `<hash>` segment is matched against a strict
 * 64-hex-char regex BEFORE any filesystem syscall. `<ext>` is matched
 * against a tight allow-list. There is no user-controlled path
 * component on disk — the storage layout is derived entirely from the
 * sniffed MIME and SHA-256.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { canonicalizeMime, magicByteSniff } from '../storage/binary-types.ts'
import { jsonError, jsonOk, ownerSlugMismatch, resolveBearer } from './surface-kit.ts'

/** P5.1 — 10 MiB cap on chat attachments per Argus r1 BLOCKING #1 brief. */
export const MAX_CHAT_UPLOAD_BYTES = 10 * 1024 * 1024

/** Hard ceiling on multipart wire size — small slack for envelope overhead. */
const MULTIPART_WIRE_SLACK = 64 * 1024

/** Images only at P5.1 (brief — non-image MIMEs are a P7 docs concern). */
const IMAGE_MIME_WHITELIST: ReadonlyArray<string> = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/** Canonical MIME → on-disk extension. SVG omitted at P5.1 (the binary
 *  store does accept it but it carries XSS risk via inline script; the
 *  chat surface restricts to raster image MIMEs for the v1 cut). */
const EXT_FROM_MIME: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
})

const URL_PREFIX = '/api/app/upload'
/** `<user_id>/<hex64>.<ext>` — user_id must match the auth bearer; hash
 *  is a 64-char hex SHA-256; ext is one of the whitelist below.  */
const URL_PATH_RE =
  /^\/api\/app\/upload\/([A-Za-z0-9._:-]+)\/([0-9a-f]{64})\.(png|jpg|gif|webp)$/

export interface AppUploadSurfaceOptions {
  auth: AppWsAuthResolver
  /** Per-instance slug; bearers with a different slug get a 403. */
  project_slug: string
  /** Resolved `<owner_home>` — chat attachments land under
   *  `<owner_home>/chat-attachments/<user_id>/`. */
  owner_home: string
  /** Override the size cap for tests. */
  max_bytes?: number
}

export interface AppUploadSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route,
   * or `null` to indicate the request belongs to a sibling surface so
   * `compose.ts` falls through to the downstream chain.
   */
  handler: (req: Request) => Promise<Response | null>
}

export function createAppUploadSurface(
  opts: AppUploadSurfaceOptions,
): AppUploadSurface {
  const { auth, project_slug: gateway_project_slug, owner_home } = opts
  const max_bytes = opts.max_bytes ?? MAX_CHAT_UPLOAD_BYTES
  const blobs_root = join(owner_home, 'chat-attachments')

  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(URL_PREFIX)) return null
      const method = req.method
      if (pathname === URL_PREFIX) {
        if (method !== 'POST') {
          return jsonError(
            405,
            'method_not_allowed',
            `method '${method}' not allowed on /api/app/upload`,
          )
        }
        return await handleUpload(req, {
          auth,
          gateway_project_slug,
          blobs_root,
          max_bytes,
        })
      }
      const match = URL_PATH_RE.exec(pathname)
      if (match !== null) {
        if (method !== 'GET') {
          return jsonError(
            405,
            'method_not_allowed',
            `method '${method}' not allowed on /api/app/upload/<...>`,
          )
        }
        return await handleGet(req, {
          auth,
          gateway_project_slug,
          blobs_root,
          user_id: match[1] ?? '',
          hash: match[2] ?? '',
          ext: match[3] ?? '',
        })
      }
      return null
    },
  }
}

interface UploadContext {
  auth: AppWsAuthResolver
  gateway_project_slug: string
  blobs_root: string
  max_bytes: number
}

async function handleUpload(req: Request, ctx: UploadContext): Promise<Response> {
  const resolved = await resolveBearer(req, ctx.auth)
  if ('code' in resolved) {
    return jsonError(401, resolved.code, resolved.message)
  }
  if (ownerSlugMismatch(resolved.project_slug, ctx.gateway_project_slug)) {
    return jsonError(
      403,
      'project_mismatch',
      `bearer project '${resolved.project_slug}' does not match gateway project '${ctx.gateway_project_slug}'`,
    )
  }
  // Reject early on missing / hostile Content-Length so a chunked PUT
  // with no length cannot drive `req.formData()` to buffer multi-GB
  // bodies. Same belt-and-braces stance the docs binary surface uses.
  const contentLengthHeader = req.headers.get('content-length')
  if (contentLengthHeader === null) {
    return jsonError(
      411,
      'length_required',
      'Content-Length header is required on /api/app/upload (chunked transfer-encoding rejected)',
    )
  }
  const len = Number(contentLengthHeader)
  if (!Number.isFinite(len) || len < 0) {
    return jsonError(
      400,
      'invalid_content_length',
      `Content-Length must be a non-negative integer (got ${contentLengthHeader})`,
    )
  }
  const wireLimit = ctx.max_bytes + MULTIPART_WIRE_SLACK
  if (len > wireLimit) {
    return jsonError(
      413,
      'upload_too_large',
      `multipart body exceeds ${wireLimit} bytes (got ${len})`,
    )
  }
  let form: Awaited<ReturnType<typeof req.formData>>
  try {
    form = await req.formData()
  } catch {
    return jsonError(
      400,
      'malformed_multipart',
      'expected multipart/form-data with a file part',
    )
  }
  const part = form.get('file')
  if (part === null || typeof part === 'string') {
    return jsonError(
      400,
      'missing_file_part',
      "expected a 'file' part in the multipart body",
    )
  }
  const file = part as File
  if (file.size > ctx.max_bytes) {
    return jsonError(
      413,
      'upload_too_large',
      `attachment exceeds ${ctx.max_bytes} bytes (got ${file.size})`,
    )
  }
  const buffer = new Uint8Array(await file.arrayBuffer())
  if (buffer.length > ctx.max_bytes) {
    return jsonError(
      413,
      'upload_too_large',
      `attachment exceeds ${ctx.max_bytes} bytes (got ${buffer.length})`,
    )
  }
  const sniffed = magicByteSniff(buffer)
  if (sniffed === null || !IMAGE_MIME_WHITELIST.includes(sniffed)) {
    return jsonError(
      415,
      'unsupported_type',
      `sniffed type ${sniffed ?? '<unknown>'} not in the image allow-list (${IMAGE_MIME_WHITELIST.join(', ')})`,
    )
  }
  const declared =
    typeof file.type === 'string' && file.type.length > 0
      ? canonicalizeMime(file.type)
      : null
  if (declared !== null && declared !== sniffed) {
    return jsonError(
      400,
      'content_type_spoof',
      `declared content type ${declared} disagrees with sniffed ${sniffed}`,
    )
  }
  const ext = EXT_FROM_MIME[sniffed]
  if (ext === undefined) {
    // Should be unreachable — IMAGE_MIME_WHITELIST keys EXT_FROM_MIME.
    return jsonError(500, 'internal_extension_lookup', `no extension for ${sniffed}`)
  }
  const hash = sha256Hex(buffer)
  const user_dir = join(ctx.blobs_root, resolved.user_id)
  const blob_path = join(user_dir, `${hash}.${ext}`)
  if (!existsSync(blob_path)) {
    await mkdir(user_dir, { recursive: true })
    const tmp = `${blob_path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
    try {
      await writeFile(tmp, buffer)
      await rename(tmp, blob_path)
    } catch (err) {
      try {
        await unlink(tmp)
      } catch {
        /* ignore */
      }
      const message = err instanceof Error ? err.message : String(err)
      return jsonError(500, 'write_failed', `failed to persist attachment: ${message}`)
    }
  }
  const url = `${URL_PREFIX}/${resolved.user_id}/${hash}.${ext}`
  return jsonOk({ url, content_type: sniffed, size_bytes: buffer.length })
}

interface GetContext {
  auth: AppWsAuthResolver
  gateway_project_slug: string
  blobs_root: string
  user_id: string
  hash: string
  ext: string
}

async function handleGet(req: Request, ctx: GetContext): Promise<Response> {
  const resolved = await resolveBearer(req, ctx.auth)
  if ('code' in resolved) {
    return jsonError(401, resolved.code, resolved.message)
  }
  if (ownerSlugMismatch(resolved.project_slug, ctx.gateway_project_slug)) {
    return jsonError(
      403,
      'project_mismatch',
      `bearer project '${resolved.project_slug}' does not match gateway project '${ctx.gateway_project_slug}'`,
    )
  }
  if (resolved.user_id !== ctx.user_id) {
    return jsonError(
      403,
      'user_mismatch',
      `bearer user '${resolved.user_id}' may not read attachments uploaded by '${ctx.user_id}'`,
    )
  }
  const sniffed = mimeFromExt(ctx.ext)
  if (sniffed === null) {
    return jsonError(400, 'invalid_extension', `extension '${ctx.ext}' not allowed`)
  }
  const blob_path = join(ctx.blobs_root, ctx.user_id, `${ctx.hash}.${ctx.ext}`)
  if (!existsSync(blob_path)) {
    return jsonError(404, 'not_found', `no attachment at ${ctx.hash}.${ctx.ext}`)
  }
  const ifNoneMatch = req.headers.get('if-none-match')
  if (ifNoneMatch !== null && ifNoneMatch.replace(/"/g, '') === ctx.hash) {
    return new Response(null, {
      status: 304,
      headers: { ETag: `"${ctx.hash}"` },
    })
  }
  const bytes = await readFile(blob_path)
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': sniffed,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${ctx.hash}"`,
    },
  })
}

function mimeFromExt(ext: string): string | null {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    default:
      return null
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
