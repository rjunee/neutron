/**
 * landing/chat-react — LOCAL VOICE TRANSCRIPTION API client (Settings tab).
 *
 * A thin fetch wrapper over `gateway/http/voice-transcription-surface.ts`:
 *
 *   GET    /api/app/voice-transcription   status + model catalog + live progress
 *   POST   /api/app/voice-transcription   start an install ({ model_id })
 *   DELETE /api/app/voice-transcription   delete the installed assets
 *
 * The POST returns straight away; the download runs server-side and the UI
 * polls the GET for `job.received_bytes / job.total_bytes`. Wire shapes are
 * re-declared here rather than imported across the workspace boundary, so the
 * browser bundle stays free of a gateway dependency — same as its siblings.
 */

export type TranscriptionBackend = 'local' | 'openai' | 'none'

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

export interface VoiceTranscriptionStatus {
  backend: TranscriptionBackend
  installed: boolean
  model_id: string | null
  installed_bytes: number
  /** False on platforms with no upstream CLI build (macOS → use Homebrew). */
  binary_downloadable: boolean
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

  private async call(method: string, body?: object): Promise<VoiceTranscriptionStatus> {
    const res = await this.fetchImpl(`${this.base_url}${this.path}`, {
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
    return json as VoiceTranscriptionStatus
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
