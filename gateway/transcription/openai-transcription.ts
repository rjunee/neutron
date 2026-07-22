/**
 * @neutronai/gateway/transcription — OpenAI-compatible Whisper ASR client
 * (M2 task 5, voice notes).
 *
 * A tiny, dependency-free client for `POST {base}/v1/audio/transcriptions`
 * that speaks the OpenAI audio-transcription contract (also accepted by
 * OpenAI-compatible local servers — LM Studio, faster-whisper-server, etc. —
 * hence the injectable `base_url`). Used by the chat-upload surface to
 * transcribe an uploaded voice note at upload-complete time.
 *
 * Design constraints:
 *   - **NEVER throws.** Every failure (HTTP, network, timeout, malformed body)
 *     maps to a typed `{ ok: false, code, ... }` result so the caller (the
 *     upload surface) can degrade gracefully — ASR must never fail an upload.
 *   - **No logging inside the client** — the caller owns the log line (it has
 *     the hash / request context).
 *   - **No retries** (v1). A failed transcription just yields no sidecar; a
 *     re-upload of the same bytes is idempotent at the surface layer.
 *   - **Credential config, NOT a feature flag.** The key is `OPENAI_API_KEY`
 *     (the SAME single var the conversational OpenAI pool uses); its presence
 *     turns transcription on, its absence degrades to a graceful note.
 *
 * Pure given an injected `fetch_impl` — unit-tests with a fake fetch and no
 * network.
 */

export interface OpenAiTranscriptionOptions {
  /** The API key sent as `Authorization: Bearer <api_key>`. */
  api_key: string
  /** API base, default `https://api.openai.com`. A trailing `/` is trimmed. */
  base_url?: string
  /** Transcription model, default `whisper-1`. */
  model?: string
  /** Injectable fetch (tests). Defaults to `globalThis.fetch`. */
  fetch_impl?: typeof fetch
  /** Abort the request after this many ms, default 60_000. */
  timeout_ms?: number
}

export type TranscribeErrorCode =
  | 'http_error'
  | 'network_error'
  | 'timeout'
  | 'bad_response'

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; code: TranscribeErrorCode; status?: number; message: string }

export interface TranscribeInput {
  bytes: Uint8Array
  content_type: string
}

/**
 * Map a canonical audio MIME to a filename with a recognized extension.
 * Whisper's multipart endpoint routes on the `file` part's FILENAME extension
 * (not the Blob's `type`), so a generic name like `blob` is rejected — every
 * upload MUST carry an audio extension the server recognizes.
 *
 * Exported for unit testing the mapping table.
 */
export function audioFilenameFor(content_type: string): string {
  switch (content_type) {
    case 'audio/mpeg':
      return 'voice.mp3'
    case 'audio/mp4':
      return 'voice.m4a'
    case 'audio/wav':
      return 'voice.wav'
    default:
      return 'voice.bin'
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com'
const DEFAULT_MODEL = 'whisper-1'
const DEFAULT_TIMEOUT_MS = 60_000

export interface OpenAiTranscriptionClient {
  transcribe(input: TranscribeInput): Promise<TranscribeResult>
}

export function createOpenAiTranscriptionClient(
  opts: OpenAiTranscriptionOptions,
): OpenAiTranscriptionClient {
  const base = (opts.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = opts.model ?? DEFAULT_MODEL
  const fetchImpl = opts.fetch_impl ?? globalThis.fetch
  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const endpoint = `${base}/v1/audio/transcriptions`

  return {
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      const form = new FormData()
      form.append('model', model)
      // The DOM `Blob` ctor's BlobPart typing under @types/bun dislikes a bare
      // Uint8Array (SharedArrayBuffer slots in via ArrayBufferLike); round-trip
      // through the underlying ArrayBuffer slice to land on a plain ArrayBuffer.
      const buf = input.bytes.buffer.slice(
        input.bytes.byteOffset,
        input.bytes.byteOffset + input.bytes.byteLength,
      ) as ArrayBuffer
      const blob = new Blob([buf], { type: input.content_type })
      form.append('file', blob, audioFilenameFor(input.content_type))

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout_ms)
      let res: Response
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.api_key}` },
          body: form,
          signal: controller.signal,
        })
      } catch (err) {
        // An abort (our timeout) is distinct from a genuine transport failure.
        if (err instanceof Error && err.name === 'AbortError') {
          return {
            ok: false,
            code: 'timeout',
            message: `transcription timed out after ${timeout_ms}ms`,
          }
        }
        return {
          ok: false,
          code: 'network_error',
          message: err instanceof Error ? err.message : String(err),
        }
      } finally {
        clearTimeout(timer)
      }

      if (!res.ok) {
        let snippet = ''
        try {
          snippet = (await res.text()).slice(0, 200)
        } catch {
          /* body unreadable — status alone carries the signal */
        }
        return {
          ok: false,
          code: 'http_error',
          status: res.status,
          message: `transcription HTTP ${res.status}${snippet.length > 0 ? `: ${snippet}` : ''}`,
        }
      }

      let json: unknown
      try {
        json = await res.json()
      } catch (err) {
        return {
          ok: false,
          code: 'bad_response',
          message: `transcription returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      const text =
        typeof json === 'object' && json !== null
          ? (json as { text?: unknown }).text
          : undefined
      if (typeof text !== 'string') {
        return {
          ok: false,
          code: 'bad_response',
          message: 'transcription response missing a string `text` field',
        }
      }
      return { ok: true, text }
    },
  }
}
