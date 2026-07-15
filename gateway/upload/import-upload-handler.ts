/**
 * @neutronai/gateway/upload — HTTP upload handler for ChatGPT / Claude
 * export ZIPs, per docs/plans/P2-onboarding-v2.md § 6.1.
 *
 * Route: `POST /api/upload/<source>` where `<source>` ∈ {chatgpt, claude}.
 *
 * Body: multipart-form with field `file` containing the ZIP. Size capped
 * at 500 MB (covers Casey-shape heavy-user ChatGPT exports per § 2.3
 * envelope). Magic-bytes check (PK\x03\x04) rejects non-ZIP uploads
 * before the bytes ever land on disk.
 *
 * Server-side mechanics (per § 6.1 + § 3.5 advance criterion):
 *   1. Validate source enum + ZIP magic bytes.
 *   2. Write the bytes to `<owner_home>/imports/<source>.zip` with
 *      mode 0600. The parent `imports/` dir is created with mode 0700
 *      so the owner POSIX user can list it but nobody else can. Owner
 *      chown is best-effort — fails closed with a 500 if the platform
 *      gateway runs as root (production) and chown fails; succeeds
 *      silently on dev / test where the gateway runs as the calling
 *      user (uid match makes chown a no-op).
 *   3. Notify the `InterviewEngine` via `notifyImportUpload(...)` so
 *      the engine kicks off the ImportJobRunner and advances the user
 *      out of `import_upload_pending` without requiring a follow-up
 *      button tap.
 *   4. Return JSON `{ ok: true, job_id }` (200) so the chat client can
 *      render an "Uploaded chatgpt.zip" user-message bubble.
 *
 * The handler does NOT validate auth itself — the per-instance gateway's
 * routing layer + Caddy front-end already gate the upstream port. The
 * `auth.validate(req)` shim is the seam for a future tightening (HMAC,
 * Bearer JWT for Telegram-relay uploads) without touching this file's
 * shape.
 *
 * Error responses (per § 9.1 contract):
 *   - 400: missing file / invalid source / not a zip
 *   - 401: unauthorized (auth shim opted in)
 *   - 413: file too large
 *   - 500: write failed / chown failed / engine notify failed
 *
 * Validation order: auth → source enum → file presence → size → magic
 * bytes → write → chown → notify runner.
 */

import { join } from 'node:path'
import type * as fs from 'node:fs/promises'

import type { ChannelKindForButton } from '@neutronai/channels/button-primitive.ts'
import { parseAnyTopicId } from '@neutronai/channels/topic-id.ts'
import type { InterviewEngine } from '@neutronai/onboarding/interview/engine.ts'
import { listEntries } from '@neutronai/onboarding/history-import/zip-reader.ts'
import { csrfForbiddenResponse, evaluateCsrfOrigin } from './csrf-origin-guard.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('upload')

/**
 * Upload size cap shared by BOTH the legacy single-shot upload handler
 * (this file) AND the new chunked-upload handler (`chunked-upload-handler.ts`).
 *
 * Default 5 GB — matches the prod hot-patch on 2026-05-24 15:23 UTC after
 * Sam's 1.18 GB ChatGPT export started landing. Operators can override
 * via the `NEUTRON_MAX_UPLOAD_BYTES` env var (positive byte count, e.g.
 * `NEUTRON_MAX_UPLOAD_BYTES=10737418240` for 10 GB) in the per-instance
 * systemd dropin without a code release.
 *
 * Evaluated at module load — tests that need a smaller cap pass an
 * explicit `maxBytes` to the handler factory instead of mutating the env.
 * Per-handler overrides ALWAYS win over the env-derived default.
 */
export const MAX_UPLOAD_BYTES_DEFAULT: number = (() => {
  const env = process.env['NEUTRON_MAX_UPLOAD_BYTES']
  if (env !== undefined) {
    const parsed = Number(env)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 5 * 1024 * 1024 * 1024 // 5 GB
})()

export type UploadSource = 'chatgpt' | 'claude'

const UPLOAD_SOURCES: ReadonlyArray<UploadSource> = ['chatgpt', 'claude']

export function isUploadSource(value: string): value is UploadSource {
  return (UPLOAD_SOURCES as ReadonlyArray<string>).includes(value)
}

/**
 * Safety cap on the byte buffer the source-sniffer (see {@link sniffZipSource})
 * will materialize. The minimal zip reader (`listEntries`) needs the WHOLE
 * archive in memory because the central directory lives at the end and its
 * entries are addressed by absolute offset. Most Claude exports are small
 * (text-only `conversations.json` + a few sidecar JSONs); a heavy ChatGPT
 * export can be >1 GB, so the chunked path skips the sniff above this cap and
 * keeps the URL source (defensive — a huge export posted to `/chatgpt` is
 * already chatgpt). 256 MiB comfortably covers any realistic Claude export.
 */
export const SNIFF_MAX_BYTES = 256 * 1024 * 1024

/**
 * Sniff the REAL export source from a zip's central-directory entry list so a
 * Claude export mis-posted to `/api/upload/chatgpt` (the web affordance
 * hardcodes `source=chatgpt`) is still routed to the Claude parser. The two
 * exports share `conversations.json`; they diverge on the sidecar files:
 *
 *   - Claude:  `users.json` (PLURAL) and/or `projects.json`.
 *   - ChatGPT: `user.json` (singular) and/or `message_feedback.json` /
 *              `model_comparisons.json`.
 *
 * Returns the confidently-detected source, or `null` when the signals are
 * absent OR contradictory (a mixed bag) — the caller keeps the URL source in
 * that case (back-compat). A malformed / unreadable zip also returns `null`:
 * the sniff must NEVER break an upload, so any failure falls back to the URL
 * source. Entry names are reduced to their basename so a nested layout
 * (`export/conversations.json`) still matches.
 */
export function sniffZipSource(buffer: Buffer): UploadSource | null {
  let basenames: Set<string>
  try {
    basenames = new Set(
      listEntries(buffer).map((e) => {
        const name = e.name
        const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
        return slash >= 0 ? name.slice(slash + 1) : name
      }),
    )
  } catch {
    // Defensive: a corrupt / zip64 / encrypted archive must not break the
    // upload — fall back to the URL source by reporting "no opinion".
    return null
  }
  const claudeSignal = basenames.has('users.json') || basenames.has('projects.json')
  const chatgptSignal =
    basenames.has('user.json') ||
    basenames.has('message_feedback.json') ||
    basenames.has('model_comparisons.json')
  if (claudeSignal && !chatgptSignal) return 'claude'
  if (chatgptSignal && !claudeSignal) return 'chatgpt'
  return null
}

/**
 * Resolve the effective upload source: the sniffed source when the zip's entry
 * list confidently disagrees with the URL source, else the URL source. Logs
 * the override so an operator can see when a `/chatgpt` POST was re-routed to
 * the Claude parser (and vice-versa). Never throws.
 */
export function resolveEffectiveSource(
  urlSource: UploadSource,
  buffer: Buffer,
  log: (msg: string) => void = (msg): void => moduleLog.info(msg),
): UploadSource {
  const sniffed = sniffZipSource(buffer)
  if (sniffed !== null && sniffed !== urlSource) {
    log(
      `[upload] source override: url=${urlSource} sniffed=${sniffed} (zip entry list disagrees; using sniffed)`,
    )
    return sniffed
  }
  return urlSource
}

/**
 * S11 § 6.1 — header carrying the caller's active chat-topic id so the
 * upload handler's `engine.notifyImportUpload` routes the subsequent
 * `sendButtonPrompt` back through the user's live WebSocket. The header
 * value matches the engine's `topic_id` contract:
 *
 *   - `app:<user_id>`               (AppWs / Expo surface — `appWsTopicId(...)`)
 *   - `web:<user_id>`               (web chat surface — `webTopicId(...)`)
 *   - `tg:<chat_id>[:<thread_id>]`  (Telegram surface — engine routing)
 *
 * The handler's resolver delegates topic-id parsing to
 * {@link parseAnyTopicId} (channels/topic-id.ts) so every production
 * shape is recognised the same way and the derived `user_id` (when one
 * is encoded in the topic id) threads through to the engine's
 * `notifyImportUpload` call.
 *
 * Pre-S11 the per-instance gateway hardcoded `'chat'` here, which had no
 * registered sender in the WebChatSenderRegistry and silently dropped
 * the post-upload button emit — `[chat-bridge] event=drop
 * reason=unknown-channel-or-no-sender`. Production clients (landing/
 * chat.ts) AND the synthetic-auth harness now both set this header so
 * the engine's emit lands on the user's actual socket.
 *
 * Argus r1 (PR #258) BLOCKER #1: pre-fix only `app:<user_id>` was parsed
 * for user-id extraction — production web clients send `web:<sub>`,
 * which dropped `user_id` into the engine's empty-string fallback,
 * yielding `outcome=noop_no_state` and stranding the user in
 * `import_upload_pending` after a 200 OK. The new shared parser closes
 * that gap.
 */
export const TOPIC_ID_HEADER = 'x-neutron-topic-id'

/**
 * S11 — fallback when the header is missing. Matches the pre-S11
 * hardcode so any internal caller that never wires the header keeps
 * the prior (broken) behaviour explicitly rather than 400'ing. The
 * resolver logs a once-per-boot deprecation warning so operators can
 * see the gap.
 */
export const TOPIC_ID_FALLBACK = 'chat'

const TOPIC_ID_MAX_LEN = 256
// Allowed characters cover every topic_id shape the engine knows
// (`web:<uuid-or-synthetic>`, `tg:<digits>[:<digits>]`, plus the legacy
// `chat` placeholder). Whitespace / control chars / shell metacharacters
// are rejected so a spoofed header can't smuggle a log-injection
// payload or break grep-ability downstream.
//
// `@` + `+` are included so the alphabet survives a future shape change
// where the JWT `sub` (and therefore the `web:<sub>` topic id) carries
// an email-style identifier. Today production subs are UUIDs from
// `identity/users.ts:65` (`[0-9a-f-]+`), but pinning the alphabet to
// UUID-only would re-introduce the ISSUES #24 stranding bug the moment
// the sub shape changes. The set still excludes whitespace, control
// chars, slashes, and the rest of the shell-metachar / URL-grammar
// space, so the log-injection guard the regex was designed for is
// preserved.
const TOPIC_ID_RE = /^[A-Za-z0-9:_.+@\-]+$/

/**
 * S11 — validate a candidate topic_id. Pure predicate; usable both at
 * the upload-handler boundary and inside the per-instance gateway's
 * resolver closure. Returns false for non-strings, empty strings,
 * strings longer than {@link TOPIC_ID_MAX_LEN}, or strings containing
 * any character outside the documented alphabet.
 */
export function isValidTopicId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > TOPIC_ID_MAX_LEN) return false
  return TOPIC_ID_RE.test(value)
}

/**
 * S11 — read `X-Neutron-Topic-Id` from an inbound upload request and
 * return it iff it passes {@link isValidTopicId}. Returns null when the
 * header is missing OR present-but-invalid; callers decide whether
 * null means "fall back" or "reject". The gateway closure today falls
 * back to {@link TOPIC_ID_FALLBACK} and logs a deprecation warning so
 * unwired callers stay observable without breaking ingest.
 *
 * Header lookup is case-insensitive (the Fetch API normalises header
 * names internally, but we route through the lowercase constant
 * defensively).
 */
export function extractTopicIdFromRequest(req: Request): string | null {
  const raw = req.headers.get(TOPIC_ID_HEADER)
  if (raw === null) return null
  return isValidTopicId(raw) ? raw : null
}

export interface ImportUploadAuthResult {
  ok: boolean
  user_id?: string
}

export interface ImportUploadInstanceContext {
  owner_home: string
  uid: number
  gid: number
  /** Public-facing slug for engine.notifyImportUpload — matches the
   *  per-instance subdomain the request landed on. */
  project_slug: string
  /** Used by `engine.notifyImportUpload` to thread the prompt back
   *  through the right channel. The web upload path lives on the same
   *  `chat` topic as the interview. */
  topic_id: string
  /** Channel kind so the engine's button-emit shapes match the WS
   *  surface the user is interacting with. Web uploads use
   *  `'app-socket'` to mirror the chat-bridge channel kind. */
  channel_kind: ChannelKindForButton
  /** Onboarding user_id — used to thread (project_slug, user_id) into
   *  the engine state lookup post-instance-isolation (migration 0034).
   *  Optional for back-compat with pre-isolation callers; missing →
   *  the engine falls back to '' and (correctly) misses. */
  user_id?: string
}

export interface ImportUploadDeps {
  /** Optional auth gate. Defaults to "allow all" so the per-instance
   *  port's existing Caddy + subdomain isolation remains the boundary.
   *  Wire a real validator when adding cross-instance write protection. */
  auth?: (req: Request) => Promise<ImportUploadAuthResult>
  /**
   * Resolve the per-instance disk context from the inbound `Request`.
   * Production wires this against the per-instance boot's known
   * project_slug + owner_home + posix uid/gid. Returning null indicates
   * the request is not for a known instance; the handler 404s.
   */
  resolveInstanceContext: (req: Request) => Promise<ImportUploadInstanceContext | null>
  /**
   * Engine reference for the per-instance InterviewEngine. The handler
   * calls `notifyImportUpload(...)` after the bytes land on disk so the
   * engine starts the runner + advances to `import_running`.
   */
  engine: Pick<InterviewEngine, 'notifyImportUpload'>
  /** Filesystem shim — defaulted to `node:fs/promises`. Test seam. */
  fs?: Pick<typeof fs, 'mkdir' | 'writeFile' | 'chown'>
  /** Override the 500 MB ceiling for testing. */
  maxBytes?: number
}

export async function handleImportUpload(
  req: Request,
  deps: ImportUploadDeps,
): Promise<Response> {
  // 0. CSRF / Origin guard. Reject positively-detected cross-site requests
  //    before any body parse or disk write — the upload surface is cookie-
  //    authed once publicly exposed, so a cross-site POST would otherwise
  //    ride the user's ambient session.
  const csrf = evaluateCsrfOrigin(req)
  if (!csrf.allowed) {
    moduleLog.warn('csrf_rejected', { reason: csrf.reason, detail: csrf.detail })
    return csrfForbiddenResponse(csrf)
  }

  // 1. Parse the source out of the URL path.
  const url = new URL(req.url)
  const sourceFromPath = url.pathname.replace(/^.*\/api\/upload\//, '')
  if (!isUploadSource(sourceFromPath)) {
    return jsonError(400, `invalid source: expected chatgpt or claude, got ${JSON.stringify(sourceFromPath)}`)
  }
  // The URL source is the client's CLAIM; the real source is sniffed from the
  // zip's entry list after the bytes land (see step 6.5). The web onboarding
  // affordance hardcodes `/api/upload/chatgpt`, so a Claude export would
  // otherwise be parsed by the ChatGPT parser and fail.
  const urlSource: UploadSource = sourceFromPath

  // 2. Auth.
  if (deps.auth !== undefined) {
    const authResult = await deps.auth(req)
    if (!authResult.ok) return jsonError(401, 'unauthorized')
  }

  // 3. Resolve instance context.
  const ctx = await deps.resolveInstanceContext(req)
  if (ctx === null) return jsonError(404, 'project not found')

  // 4. Read multipart body.
  let form: Awaited<ReturnType<typeof req.formData>>
  try {
    form = await req.formData()
  } catch (err) {
    return jsonError(400, `could not parse multipart form: ${err instanceof Error ? err.message : 'unknown'}`)
  }
  const file = form.get('file')
  if (file === null) return jsonError(400, 'missing file field')
  if (!isFileLike(file)) return jsonError(400, 'file field is not a file')

  // 5. Size cap.
  const maxBytes = deps.maxBytes ?? MAX_UPLOAD_BYTES_DEFAULT
  if (file.size > maxBytes) {
    return jsonError(413, `file too large: ${file.size} bytes exceeds cap ${maxBytes}`)
  }

  // 6. Magic-bytes check. ZIPs start with `PK\x03\x04` (local file
  //    header) or `PK\x05\x06` (empty archive) or `PK\x07\x08` (spanned).
  //    We accept any `PK` opener — the parser owns deeper validation.
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  if (head.length < 2 || head[0] !== 0x50 || head[1] !== 0x4b) {
    return jsonError(400, 'not a zip file (magic bytes mismatch)')
  }

  // 6.5. Sniff the REAL source from the zip's entry list. The web affordance
  //      always posts onboarding history zips to `/chatgpt`, so a Claude
  //      export needs to be re-routed to the Claude parser. Read the full bytes
  //      once here (also reused for the disk write below). A sniff failure
  //      keeps the URL source — it must never break the upload.
  const bytes = new Uint8Array(await file.arrayBuffer())
  const source: UploadSource = resolveEffectiveSource(urlSource, Buffer.from(bytes))

  // 7. Write to <owner_home>/imports/<source>.zip.
  const fsImpl = deps.fs ?? (await import('node:fs/promises'))
  const importDir = join(ctx.owner_home, 'imports')
  const destPath = join(importDir, `${source}.zip`)
  try {
    await fsImpl.mkdir(importDir, { recursive: true, mode: 0o700 })
  } catch (err) {
    moduleLog.error('mkdir_failed', { project: ctx.project_slug, source, error: err instanceof Error ? err.message : String(err) })
    return jsonError(500, 'could not create imports directory')
  }
  try {
    await fsImpl.writeFile(destPath, bytes, { mode: 0o600 })
  } catch (err) {
    moduleLog.error('write_failed', { project: ctx.project_slug, source, error: err instanceof Error ? err.message : String(err) })
    return jsonError(500, 'could not write upload to disk')
  }
  try {
    await fsImpl.chown(destPath, ctx.uid, ctx.gid)
  } catch (err) {
    // chown failures are typically EPERM when the gateway process does
    // not have CAP_CHOWN (dev / single-user runs). Log + continue — the
    // file is still mode 0600 so the only access path is the gateway
    // process's own uid which is what we want anyway.
    moduleLog.warn('chown_failed', { project: ctx.project_slug, source, uid: ctx.uid, gid: ctx.gid, error: err instanceof Error ? err.message : String(err) })
  }
  moduleLog.info('written', { project: ctx.project_slug, source, bytes: bytes.length, destination: destPath })

  // 8. Notify the engine. The result feeds back into the WebSocket
  //    bridge via the engine's own state-store + button emit path.
  try {
    const advance = await deps.engine.notifyImportUpload({
      project_slug: ctx.project_slug,
      topic_id: ctx.topic_id,
      user_id: ctx.user_id ?? '',
      channel_kind: ctx.channel_kind,
      source,
    })
    const job_id =
      (advance.state?.phase_state as Record<string, unknown> | undefined)?.[
        'import_job_id'
      ] ?? null
    return Response.json({
      ok: true,
      source,
      bytes: bytes.length,
      destination: destPath,
      outcome: advance.outcome,
      job_id: typeof job_id === 'string' ? job_id : null,
    })
  } catch (err) {
    moduleLog.error('engine_notify_failed', { project: ctx.project_slug, source, error: err instanceof Error ? err.message : String(err) })
    return jsonError(500, `engine notify failed: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

function jsonError(status: number, message: string): Response {
  return Response.json({ ok: false, error: message }, { status })
}

interface FileLike {
  size: number
  slice: (start?: number, end?: number) => Blob
  arrayBuffer: () => Promise<ArrayBuffer>
}

function isFileLike(value: unknown): value is FileLike {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['size'] === 'number' &&
    typeof v['slice'] === 'function' &&
    typeof v['arrayBuffer'] === 'function'
  )
}

/**
 * Inputs to {@link buildImportUploadHandler}. Mirrors the per-instance
 * boot's known data: the on-disk owner_home + slug + POSIX uid/gid the
 * unit booted as, plus the InterviewEngine the handler bridges into via
 * `notifyImportUpload`.
 */
export interface BuildImportUploadHandlerInput {
  owner_home: string
  uid: number
  gid: number
  project_slug: string
  engine: Pick<InterviewEngine, 'notifyImportUpload'>
  /**
   * Optional sink for the once-per-process deprecation log fired when the
   * inbound `X-Neutron-Topic-Id` header is missing. The per-instance
   * gateway wires this to a one-shot `console.warn`; tests pass a recorder.
   */
  onTopicIdMissing?: () => void
  /** Filesystem shim — defaulted to `node:fs/promises`. Test seam. */
  fs?: ImportUploadDeps['fs']
  /** Override the 500 MB ceiling for testing. */
  maxBytes?: number
}

/**
 * Build the production import-upload handler closure. Encapsulates the
 * resolver contract Argus r1 BLOCKING #2 pinned down:
 *
 *   1. Read `X-Neutron-Topic-Id` from the inbound request.
 *   2. If absent / invalid → fall back to {@link TOPIC_ID_FALLBACK} and
 *      log the missing-header notice (once).
 *   3. If the header is the AppWs synthetic topic shape (`app:<user_id>`)
 *      → parse the suffix and thread it into the engine's
 *      `notifyImportUpload(...)` call as `user_id`, so the engine's
 *      instance-isolated state lookup (migration 0034) finds the right
 *      `(project_slug, user_id)` row instead of falling back to '' and
 *      missing — the latter is the pre-Argus-r1 silent-stall path that
 *      left the user stuck in `import_upload_pending` after a 200 OK.
 *
 * Extracted out of the per-instance boot closure so the production composer
 * reachability test can exercise the same code path the real gateway
 * runs (CLAUDE.md "spec is the source of truth" + the persona-gen-style
 * incident guard: unit coverage on the resolver alone never caught the
 * missing `user_id` thread-through).
 */
export function buildImportUploadHandler(
  input: BuildImportUploadHandlerInput,
): (req: Request) => Promise<Response> {
  let warned = false
  return async (req: Request): Promise<Response> => {
    const deps: ImportUploadDeps = {
      resolveInstanceContext: async (innerReq: Request) => {
        const headerTopicId = extractTopicIdFromRequest(innerReq)
        const topic_id = headerTopicId ?? TOPIC_ID_FALLBACK
        if (headerTopicId === null && !warned) {
          warned = true
          if (input.onTopicIdMissing !== undefined) {
            try {
              input.onTopicIdMissing()
            } catch {
              // swallow — the once-per-process notice is best-effort
            }
          }
        }
        // Argus r1 BLOCKING #2 + PR #258 r1 BLOCKER #1 — parse the
        // inbound `topic_id` so the engine's instance-isolated state
        // lookup (migration 0034) hits the right `(project_slug, user_id)`
        // row instead of falling back to the empty-string default. Two
        // production shapes encode a user_id:
        //
        //   - `app:<user_id>`  (AppWs / Expo)
        //   - `web:<user_id>`  (web chat — the actual prod client)
        //
        // Telegram (`tg:<chat_id>[:<thread_id>]` or bare `<chat_id>`)
        // does NOT encode a user_id — `notifyImportUpload` is unreached
        // from a Telegram upload today (no TG upload UX), but the
        // shared parser still recognises the shape so a future TG
        // upload caller can extend without re-touching this file.
        const parsed = parseAnyTopicId(topic_id)
        const ctx: ImportUploadInstanceContext = {
          owner_home: input.owner_home,
          uid: input.uid,
          gid: input.gid,
          project_slug: input.project_slug,
          topic_id,
          channel_kind: 'app-socket',
        }
        if (parsed?.user_id !== undefined) ctx.user_id = parsed.user_id
        return ctx
      },
      engine: input.engine,
    }
    if (input.fs !== undefined) deps.fs = input.fs
    if (input.maxBytes !== undefined) deps.maxBytes = input.maxBytes
    return handleImportUpload(req, deps)
  }
}
