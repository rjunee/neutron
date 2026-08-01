/**
 * @neutronai/gateway/transcription — which ASR backend a box uses.
 *
 * **The owner's SETTING decides. Nothing else does.**
 *
 *   - choice `'local'`  → local whisper.cpp, if it is installed
 *   - choice `'openai'` → the hosted API, if a key is configured
 *   - no choice yet     → the single CONFIGURED backend, if there is exactly one
 *
 * ── What this replaced, and why ─────────────────────────────────────────────
 * This module used to prefer a local install UNCONDITIONALLY, on the reasoning
 * that installing local Whisper was a deliberate act whose point was that the
 * audio never leaves the machine. That reasoning was sound and the rule was
 * still wrong, because it made the two backends unable to coexist: with local
 * installed there was no way to reach an OpenAI key short of deleting the
 * install. The owner's ruling: *"I think it should just be a setting for which
 * transcription tool to use."*
 *
 * So the precedence is DELETED rather than demoted. It is deliberately not kept
 * underneath the setting as a tiebreaker: a hidden rule that reasserts itself
 * the next time a backend is installed or a key is pasted is precisely the
 * surprise being removed. There is no code path here in which one backend wins
 * over another because of what it is.
 *
 * ── The unchosen case ───────────────────────────────────────────────────────
 * A box that has never been told what to use is NOT guessed at. With exactly one
 * backend configured there is nothing to choose between, so it is used — a
 * self-hoster who only ever set `OPENAI_API_KEY`, or only ever installed local
 * Whisper, keeps working untouched and never has to visit this setting. With
 * BOTH configured the question is real and unanswered: this returns `'none'`
 * with `reason: 'unchosen'`, both Settings surfaces ask for the choice, and the
 * composer logs it. That is one un-transcribed voice note in exchange for never
 * silently picking where the audio goes — and it can only happen to someone who
 * has performed BOTH deliberate setup acts.
 *
 * ── Strictly honoured, never quietly substituted ────────────────────────────
 * A chosen backend that cannot run resolves to `'none'` with a reason, NOT to
 * the other backend. Falling back would mean either shipping audio off a box
 * whose owner asked for local, or silently downgrading quality for one who asked
 * for OpenAI — in both directions a decision the owner did not make. The reason
 * is surfaced in Settings and logged at transcribe time.
 */

import { createLocalWhisperClient } from './local-whisper.ts'
import { createOpenAiTranscriptionClient } from './openai-transcription.ts'
import { resolveWhisperInstall, type WhisperInstall } from './whisper-install.ts'
import type { TranscriptionBackendChoice, TranscriptionClient } from './types.ts'

export type TranscriberKind = 'local' | 'openai' | 'none'

/** Why nothing is transcribing, when `kind === 'none'`. */
export type NoTranscriberReason =
  /** Neither backend is configured — no local install, no OpenAI key. */
  | 'unconfigured'
  /** Both are configured and the owner has not said which to use. */
  | 'unchosen'
  /** The owner chose local, but whisper.cpp is not installed. */
  | 'local_not_installed'
  /** The owner chose OpenAI, but no API key is configured. */
  | 'openai_key_missing'

export interface ResolvedTranscriber {
  kind: TranscriberKind
  /** `null` only when `kind === 'none'`. */
  client: TranscriptionClient | null
  /** Which local model is in use — for logs and the Settings status line. */
  model_id?: string
  /** Set when `kind === 'none'`; says which of the four situations this is. */
  reason?: NoTranscriberReason
  /**
   * Set when the local backend is live but cannot handle every container: m4a
   * (iOS Safari's recorder output) needs ffmpeg, and this box has none. The
   * composer logs it once at boot so the gap is visible before a user hits it.
   */
  warning?: string
}

export interface ResolveTranscriberOptions {
  env: Record<string, string | undefined>
  neutron_home: string
  /**
   * The owner's setting (`instance_metadata.transcription_backend`), or `null`
   * when they have never chosen. The caller reads it per request — the choice is
   * a control in the running app, so it must take effect without a restart.
   */
  choice: TranscriptionBackendChoice | null
  /**
   * The configured OpenAI key (stored credential, else `OPENAI_API_KEY`), or
   * `null`. Passed in rather than read from `env` here so that the credential
   * store — which needs a DB handle and the owner boundary — stays out of this
   * pure function. `OpenAiKeyStore.resolve()` is the production source.
   */
  openai_api_key: string | null
  /** Injected in tests — the local-install probe. */
  resolve_local?: (env: Record<string, string | undefined>, home: string) => WhisperInstall | null
  /** Injected in tests — PATH lookup for ffmpeg. */
  which?: (cmd: string) => string | null
}

export function resolveTranscriber(opts: ResolveTranscriberOptions): ResolvedTranscriber {
  const which = opts.which ?? ((c: string) => Bun.which(c))
  const resolveLocal =
    opts.resolve_local ??
    ((env: Record<string, string | undefined>, neutron_home: string) =>
      resolveWhisperInstall({ env, neutron_home }))

  const local = resolveLocal(opts.env, opts.neutron_home)
  const key = (opts.openai_api_key ?? '').trim()
  const localAvailable = local !== null
  const openaiAvailable = key.length > 0

  // Resolve the CHOICE first. An unchosen box only gets an answer when exactly
  // one backend is configured — never by ranking them.
  let target: TranscriptionBackendChoice
  if (opts.choice !== null) {
    target = opts.choice
  } else if (localAvailable && openaiAvailable) {
    return { kind: 'none', client: null, reason: 'unchosen' }
  } else if (localAvailable) {
    target = 'local'
  } else if (openaiAvailable) {
    target = 'openai'
  } else {
    return { kind: 'none', client: null, reason: 'unconfigured' }
  }

  if (target === 'local') {
    if (local === null) return { kind: 'none', client: null, reason: 'local_not_installed' }
    const ffmpeg = which('ffmpeg')
    const client = createLocalWhisperClient({
      binary: local.binary,
      model: local.model,
      lib_dir: local.lib_dir,
      ffmpeg,
    })
    const out: ResolvedTranscriber = { kind: 'local', client, model_id: local.model_id }
    if (ffmpeg === null) {
      out.warning =
        'local transcription is active but ffmpeg is missing — m4a/mp4 voice notes ' +
        '(iOS Safari records these) cannot be decoded; install ffmpeg to cover them'
    }
    return out
  }

  if (!openaiAvailable) return { kind: 'none', client: null, reason: 'openai_key_missing' }
  return { kind: 'openai', client: createOpenAiTranscriptionClient({ api_key: key }) }
}
