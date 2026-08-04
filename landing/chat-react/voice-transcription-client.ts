/**
 * landing/chat-react — VOICE TRANSCRIPTION API client (Settings tab).
 *
 * A thin fetch wrapper over `gateway/http/voice-transcription-surface.ts`:
 *
 *   GET    /api/app/voice-transcription             status + catalog + progress
 *   POST   /api/app/voice-transcription             start an install ({ model_id })
 *   DELETE /api/app/voice-transcription             delete the installed assets
 *   PUT    /api/app/voice-transcription/backend     choose a backend ({ backend })
 *   PUT    /api/app/voice-transcription/openai-key  store a key ({ api_key })
 *   DELETE /api/app/voice-transcription/openai-key  forget the stored key
 *
 * Every route answers with the same status object, so each method returns the
 * fresh state and the UI never has to guess what a mutation did.
 *
 * The POST returns straight away; the download runs server-side and the UI
 * polls the GET for `job.received_bytes / job.total_bytes`. Wire shapes are
 * re-declared here rather than imported across the workspace boundary, so the
 * browser bundle stays free of a gateway dependency — same as its siblings.
 *
 * `app/lib/voice-transcription-client.ts` hand-declares the SAME shapes for the
 * mobile client. The two are held in lockstep by
 * `app/__tests__/voice-transcription-mirror-parity.test.ts` — edit a wire type
 * here and the typecheck job reds until the app side matches. That includes
 * `normalizeStatus` below, which exists in both files.
 *
 * The API key travels ONE WAY. It goes up in a PUT body and is never returned:
 * the status object reports only that a key exists, where it came from, and when
 * it was saved.
 */

export type TranscriptionBackend = 'local' | 'openai' | 'none'

/** The two things the owner can choose between. `null` = not chosen yet. */
export type TranscriptionBackendChoice = 'local' | 'openai'

/** Why nothing is transcribing, when `backend` is `'none'`. */
export type NoTranscriberReason = 'unconfigured' | 'unchosen' | 'local_not_installed' | 'openai_key_missing'

/**
 * Where a configured OpenAI key came from. `shared` is the general OpenAI
 * credential saved under Integrations (the semantic-memory key), which
 * transcription falls back to when no dedicated key is saved here.
 */
export type OpenAiKeySource = 'stored' | 'shared' | 'environment'

export type WhisperInstallPhase =
  | 'idle'
  | 'checking_disk'
  | 'downloading_binary'
  | 'extracting_binary'
  | 'downloading_model'
  | 'verifying'
  | 'done'
  | 'failed'

export interface WhisperModelOption {
  id: string
  label: string
  size_bytes: number
  /** Measured seconds to transcribe a 30-second note on a reference CPU box. */
  sec_per_30s_note: number
  peak_rss_mb: number
  note: string
}

export interface WhisperJob {
  phase: WhisperInstallPhase
  received_bytes: number
  total_bytes: number
  model_id: string
  error?: { code: string; message: string }
  started_at: number
}

/** Presence + provenance of the OpenAI key. NEVER the key, or any part of it. */
export interface OpenAiKeyStatus {
  present: boolean
  source: OpenAiKeySource | null
  /** ISO-8601 of the last save. Only set when `source` is `'stored'`. */
  saved_at: string | null
}

export interface VoiceTranscriptionStatus {
  /** Which backend would transcribe a voice note RIGHT NOW. */
  backend: TranscriptionBackend
  /** When `backend` is `'none'`, exactly why. */
  backend_reason: NoTranscriberReason | null
  /** What the owner CHOSE — `null` until they have chosen. Differs from
   *  `backend` when the chosen one cannot run; the UI says so rather than
   *  letting the server quietly use the other. */
  choice: TranscriptionBackendChoice | null
  /** Whether local whisper.cpp could serve a note right now. */
  local_available: boolean
  /** Whether an OpenAI key is configured, and where from. */
  openai_key: OpenAiKeyStatus
  installed: boolean
  model_id: string | null
  installed_bytes: number
  /** False on platforms with no upstream CLI build (macOS → use Homebrew). */
  binary_downloadable: boolean
  /** True when a runnable `whisper-cli` is already on the server (unpacked,
   *  Homebrew, or `NEUTRON_WHISPER_BIN`). With the flag above it decides
   *  whether pressing Install can succeed at all. */
  binary_present: boolean
  whisper_version: string
  default_model_id: string
  models: WhisperModelOption[]
  job: WhisperJob | null
}

interface ErrorBody {
  ok?: boolean
  code?: string
  message?: string
}

export class VoiceTranscriptionClientError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`)
    this.name = 'VoiceTranscriptionClientError'
    this.code = code
    this.status = status
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface VoiceTranscriptionClientOptions {
  base_url: string
  token: string
  fetchImpl?: FetchImpl
}

export class WebVoiceTranscriptionClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl
  private readonly path = '/api/app/voice-transcription'

  constructor(opts: VoiceTranscriptionClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  private async call(
    method: string,
    body?: object,
    suffix = '',
  ): Promise<VoiceTranscriptionStatus> {
    const res = await this.fetchImpl(`${this.base_url}${this.path}${suffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new VoiceTranscriptionClientError('bad_response', `HTTP ${res.status}`, res.status)
    }
    if (!res.ok) {
      const err = json as ErrorBody
      throw new VoiceTranscriptionClientError(
        err.code ?? 'request_failed',
        err.message ?? `HTTP ${res.status}`,
        res.status,
      )
    }
    return normalizeStatus(json)
  }

  status(): Promise<VoiceTranscriptionStatus> {
    return this.call('GET')
  }

  install(model_id: string): Promise<VoiceTranscriptionStatus> {
    return this.call('POST', { model_id })
  }

  remove(): Promise<VoiceTranscriptionStatus> {
    return this.call('DELETE')
  }

  /** Choose which transcriber to use. Allowed before it is usable. */
  chooseBackend(backend: TranscriptionBackendChoice): Promise<VoiceTranscriptionStatus> {
    return this.call('PUT', { backend }, '/backend')
  }

  /** Store (or replace) the OpenAI key. Write-only — nothing comes back. */
  saveOpenAiKey(api_key: string): Promise<VoiceTranscriptionStatus> {
    return this.call('PUT', { api_key }, '/openai-key')
  }

  /** Forget the stored key. Fails with `key_from_environment` if the key is the
   *  server's `OPENAI_API_KEY`, which only the server operator can unset, or
   *  with `key_from_shared_credential` if it is the general OpenAI key from
   *  Integrations — that one is removed there, or overridden by saving a
   *  transcription-only key here. */
  removeOpenAiKey(): Promise<VoiceTranscriptionStatus> {
    return this.call('DELETE', undefined, '/openai-key')
  }
}

/**
 * Fill in the fields a server older than the backend-choice feature does not
 * send.
 *
 * A client is always allowed to be newer than the server it is pointed at — the
 * mobile build especially, since it ships through an app store and outlives any
 * one server version. Reading `status.openai_key.present` off a response that
 * predates the field threw a TypeError mid-render, which in React 19 takes the
 * whole tab down rather than degrading the one section.
 *
 * The defaults are the TRUTH about such a server, not a guess: it has no concept
 * of a stored choice (`null`) and no stored key of its own. Its `backend` field
 * is still its own honest answer and is passed through untouched, so the status
 * line stays correct; only the controls read as unset, and using them surfaces
 * the server's 404 as "update your server".
 */
function normalizeStatus(json: unknown): VoiceTranscriptionStatus {
  const raw = (json ?? {}) as Partial<VoiceTranscriptionStatus>
  return {
    ...(raw as VoiceTranscriptionStatus),
    backend_reason: raw.backend_reason ?? null,
    choice: raw.choice ?? null,
    local_available: raw.local_available ?? raw.installed ?? false,
    openai_key: raw.openai_key ?? { present: false, source: null, saved_at: null },
  }
}

/** Human-readable byte size for progress text (`142 MB`, `1.6 GB`). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** One line describing a running job, for the progress row. */
export function describeJob(job: WhisperJob): string {
  switch (job.phase) {
    case 'checking_disk':
      return 'Checking disk space…'
    case 'downloading_binary':
      return `Downloading whisper.cpp — ${formatBytes(job.received_bytes)} of ${formatBytes(job.total_bytes)}`
    case 'extracting_binary':
      return 'Unpacking whisper.cpp…'
    case 'downloading_model':
      return `Downloading the model — ${formatBytes(job.received_bytes)} of ${formatBytes(job.total_bytes)}`
    case 'verifying':
      return 'Verifying checksum…'
    case 'done':
      return 'Installed.'
    case 'failed':
      return job.error?.message ?? 'Install failed.'
    default:
      return 'Starting…'
  }
}

/** 0-1 completion for the progress bar, or null when it is not yet meaningful. */
export function jobFraction(job: WhisperJob): number | null {
  if (job.phase === 'done') return 1
  if (job.total_bytes <= 0) return null
  return Math.min(1, job.received_bytes / job.total_bytes)
}
