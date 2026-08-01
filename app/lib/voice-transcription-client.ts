/**
 * @neutronai/app — voice-transcription settings client (Settings screen).
 *
 * Thin fetch wrapper over `gateway/http/voice-transcription-surface.ts`, the
 * same machine-scoped surface the web Settings tab drives:
 *
 *   - `GET    /api/app/voice-transcription`            → status + catalog + progress
 *   - `POST   /api/app/voice-transcription`            → start an install ({ model_id })
 *   - `DELETE /api/app/voice-transcription`            → delete the installed assets
 *   - `PUT    /api/app/voice-transcription/backend`    → choose a backend ({ backend })
 *   - `PUT    /api/app/voice-transcription/openai-key` → store a key ({ api_key })
 *   - `DELETE /api/app/voice-transcription/openai-key` → forget the stored key
 *
 * Every route answers with the same status object, so each method returns the
 * fresh state. The API key travels ONE WAY: up in a PUT body, never back.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE WEB CLIENT. The wire shapes are declared
 * here rather than imported from `landing/chat-react/voice-transcription-client`
 * so the Metro bundle carries no dependency on the browser package — the same
 * rule every other app client follows (`admin-personality-client.ts`,
 * `tabs-client.ts`). The duplication is held honest mechanically by
 * `__tests__/voice-transcription-mirror-parity.test.ts`, which diffs the two
 * type declarations, exactly as `tab-descriptor-mirror-parity.test.ts` does.
 *
 * The POST returns straight away and the download runs SERVER-SIDE, which is
 * what makes this workable from a phone at all: the job is not tied to the
 * app's lifetime. Backgrounding the app pauses the polling, not the download.
 */

export type TranscriptionBackend = 'local' | 'openai' | 'none';

/** The two things the owner can choose between. `null` = not chosen yet. */
export type TranscriptionBackendChoice = 'local' | 'openai';

/** Why nothing is transcribing, when `backend` is `'none'`. */
export type NoTranscriberReason = 'unconfigured' | 'unchosen' | 'local_not_installed' | 'openai_key_missing';

/** Where a configured OpenAI key came from. */
export type OpenAiKeySource = 'stored' | 'environment';

export type WhisperInstallPhase =
  | 'idle'
  | 'checking_disk'
  | 'downloading_binary'
  | 'extracting_binary'
  | 'downloading_model'
  | 'verifying'
  | 'done'
  | 'failed';

export interface WhisperModelOption {
  id: string;
  label: string;
  size_bytes: number;
  /** Measured seconds to transcribe a 30-second note on a reference CPU box. */
  sec_per_30s_note: number;
  peak_rss_mb: number;
  note: string;
}

export interface WhisperJob {
  phase: WhisperInstallPhase;
  received_bytes: number;
  total_bytes: number;
  model_id: string;
  error?: { code: string; message: string };
  started_at: number;
}

/** Presence + provenance of the OpenAI key. NEVER the key, or any part of it. */
export interface OpenAiKeyStatus {
  present: boolean;
  source: OpenAiKeySource | null;
  /** ISO-8601 of the last save. Only set when `source` is `'stored'`. */
  saved_at: string | null;
}

export interface VoiceTranscriptionStatus {
  /** Which backend would transcribe a voice note RIGHT NOW. */
  backend: TranscriptionBackend;
  /** When `backend` is `'none'`, exactly why. */
  backend_reason: NoTranscriberReason | null;
  /** What the owner CHOSE — `null` until they have chosen. Differs from
   *  `backend` when the chosen one cannot run; the UI says so rather than
   *  letting the server quietly use the other. */
  choice: TranscriptionBackendChoice | null;
  /** Whether local whisper.cpp could serve a note right now. */
  local_available: boolean;
  /** Whether an OpenAI key is configured, and where from. */
  openai_key: OpenAiKeyStatus;
  installed: boolean;
  model_id: string | null;
  installed_bytes: number;
  /** False on server platforms with no upstream CLI build (macOS → Homebrew). */
  binary_downloadable: boolean;
  /** True when a runnable `whisper-cli` is already on the server. */
  binary_present: boolean;
  whisper_version: string;
  default_model_id: string;
  models: WhisperModelOption[];
  job: WhisperJob | null;
}

export const VOICE_TRANSCRIPTION_PATH = '/api/app/voice-transcription';

export class VoiceTranscriptionClientError extends Error {
  override readonly name = 'VoiceTranscriptionClientError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Just the call shape this client uses — `typeof fetch` drags in runtime-
 *  specific statics (`preconnect`) that a test double has no business faking. */
export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * How long to wait for the server before calling it unreachable.
 *
 * `fetch` has NO default timeout, and a phone reaches its server over networks
 * that accept a connection and then go nowhere (captive portal, dead VPN, a box
 * that stopped answering) — a hung request would leave this card reading
 * "Checking your server…" indefinitely, which is the spinner-that-means-nothing
 * this feature exists to avoid. Observed live: with the local instance stopped
 * mid-session the card sat on the loading line until this landed.
 *
 * Generous, because these calls are cheap but a slow mobile link is real: the
 * three requests do no work beyond a stat of the install directory.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export interface VoiceTranscriptionClientOptions {
  base_url: string;
  token: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Injected in tests. Defaults to `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export class VoiceTranscriptionClient {
  private readonly base_url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

  constructor(opts: VoiceTranscriptionClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  status(): Promise<VoiceTranscriptionStatus> {
    return this.call('GET');
  }

  install(model_id: string): Promise<VoiceTranscriptionStatus> {
    return this.call('POST', { model_id });
  }

  remove(): Promise<VoiceTranscriptionStatus> {
    return this.call('DELETE');
  }

  /** Choose which transcriber to use. Allowed before it is usable. */
  chooseBackend(backend: TranscriptionBackendChoice): Promise<VoiceTranscriptionStatus> {
    return this.call('PUT', { backend }, '/backend');
  }

  /** Store (or replace) the OpenAI key. Write-only — nothing comes back. */
  saveOpenAiKey(api_key: string): Promise<VoiceTranscriptionStatus> {
    return this.call('PUT', { api_key }, '/openai-key');
  }

  /** Forget the stored key. Fails with `key_from_environment` if the key is the
   *  server's `OPENAI_API_KEY`, which only the server operator can unset. */
  removeOpenAiKey(): Promise<VoiceTranscriptionStatus> {
    return this.call('DELETE', undefined, '/openai-key');
  }

  private async call(
    method: string,
    body?: object,
    suffix = '',
  ): Promise<VoiceTranscriptionStatus> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base_url}${VOICE_TRANSCRIPTION_PATH}${suffix}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // An abort is indistinguishable from a network error to the caller unless
      // it is named — and "the server did not answer" is the more useful of the
      // two things a stalled phone connection can mean.
      if (controller.signal.aborted) {
        throw new VoiceTranscriptionClientError(
          0,
          'timeout',
          `the server did not answer within ${Math.round(this.timeoutMs / 1000)}s`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      // A server that predates this surface answers the unmatched path with a
      // non-JSON 404 body. Keep the STATUS — the screen turns 404 into "your
      // server is too old" rather than a raw parse error.
      throw new VoiceTranscriptionClientError(res.status, 'bad_response', `HTTP ${res.status}`);
    }
    if (!res.ok) {
      const err = json as { code?: unknown; message?: unknown };
      throw new VoiceTranscriptionClientError(
        res.status,
        typeof err.code === 'string' ? err.code : `http_${res.status}`,
        typeof err.message === 'string' ? err.message : `HTTP ${res.status}`,
      );
    }
    return normalizeStatus(json);
  }
}

/**
 * Fill in the fields a server older than the backend-choice feature does not
 * send.
 *
 * This app ships through an app store and is routinely NEWER than the server it
 * is pointed at. Reading `status.openai_key.present` off a response that
 * predates the field is a TypeError inside render, which takes the Settings
 * screen down rather than degrading one card.
 *
 * The defaults are the TRUTH about such a server, not a guess: it has no concept
 * of a stored choice (`null`) and no stored key of its own. Its `backend` field
 * is still its own honest answer and is passed through untouched, so the status
 * line stays correct; only the controls read as unset, and using them surfaces
 * the server's 404 as "update your server".
 */
function normalizeStatus(json: unknown): VoiceTranscriptionStatus {
  const raw = (json ?? {}) as Partial<VoiceTranscriptionStatus>;
  return {
    ...(raw as VoiceTranscriptionStatus),
    backend_reason: raw.backend_reason ?? null,
    choice: raw.choice ?? null,
    local_available: raw.local_available ?? raw.installed ?? false,
    openai_key: raw.openai_key ?? { present: false, source: null, saved_at: null },
  };
}
