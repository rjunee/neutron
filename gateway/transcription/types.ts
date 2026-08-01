/**
 * @neutronai/gateway/transcription — the ASR contract shared by every backend.
 *
 * Voice-note transcription has TWO implementations behind ONE shape:
 *
 *   - `local-whisper.ts`        — whisper.cpp on this machine. No key, no
 *                                 network, no per-minute cost.
 *   - `openai-transcription.ts` — the hosted `POST /v1/audio/transcriptions`
 *                                 endpoint. Needs an API key.
 *
 * NEITHER is the default. Which one runs is the owner's SETTING, read by
 * `resolve-transcriber.ts`; `open/composer.ts` injects the chosen one into the
 * chat-upload surface's `transcribeAudio` seam. The surface itself knows nothing
 * about either backend — it only sees a function returning a transcript string
 * or `null`.
 *
 * The contract's hard rule, inherited from the original OpenAI client: a
 * transcriber NEVER throws. Every failure maps to a typed `{ ok: false, code }`
 * result so the caller can degrade gracefully — ASR must never fail an upload.
 */

/**
 * Why a transcription failed.
 *
 * The first four are the original hosted-HTTP codes; the rest were added for the
 * local (subprocess) backend, whose failure modes are about the machine rather
 * than the network. They are deliberately backend-agnostic — a future backend
 * that also shells out reuses them.
 */
export type TranscribeErrorCode =
  /** Hosted backend returned a non-2xx status. */
  | 'http_error'
  /** Transport failure reaching a hosted backend. */
  | 'network_error'
  /** The request/subprocess exceeded its deadline and was aborted/killed. */
  | 'timeout'
  /** The backend returned something we could not parse into a transcript. */
  | 'bad_response'
  /** The audio container is one this backend cannot decode (e.g. m4a with no
   *  `ffmpeg` available to normalize it). */
  | 'unsupported_format'
  /** The audio exceeded the backend's input cap — refused before any work. */
  | 'too_large'
  /** The local backend could not be run at all (binary/model missing at exec
   *  time, spawn refused, non-zero exit). */
  | 'exec_failed'

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; code: TranscribeErrorCode; status?: number; message: string }

export interface TranscribeInput {
  bytes: Uint8Array
  content_type: string
}

/** The ONE shape every transcription backend satisfies. */
export interface TranscriptionClient {
  transcribe(input: TranscribeInput): Promise<TranscribeResult>
}

/**
 * Which transcriber the owner CHOSE, persisted in
 * `instance_metadata.transcription_backend` (migration 0111).
 *
 * `null` (absent) means "never chosen" — deliberately NOT a synonym for either
 * value. The resolver treats it as an open question rather than silently
 * answering it; see `resolve-transcriber.ts`.
 */
export type TranscriptionBackendChoice = 'local' | 'openai'

/** Runtime narrowing for a value off the wire or out of the DB. */
export function isTranscriptionBackendChoice(v: unknown): v is TranscriptionBackendChoice {
  return v === 'local' || v === 'openai'
}
