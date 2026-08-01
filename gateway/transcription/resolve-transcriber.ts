/**
 * @neutronai/gateway/transcription — which ASR backend a box uses.
 *
 * ONE decision, made once at composer boot:
 *
 *   1. LOCAL whisper.cpp, if it is installed        → `{ kind: 'local' }`
 *   2. else the hosted API, if `OPENAI_API_KEY` set → `{ kind: 'openai' }`
 *   3. else nothing                                  → `{ kind: 'none' }`
 *
 * **Local wins over the hosted API, unconditionally.** Installing local Whisper
 * is a deliberate act — the owner clicked a button in Settings and waited for a
 * download — and the thing they were choosing is that their voice never leaves
 * the machine. Silently preferring a remote service afterwards, merely because
 * some unrelated key happens to be in the environment (`OPENAI_API_KEY` is the
 * SAME variable the conversational adapter and the embeddings backfill read),
 * would quietly undo that choice and bill them for it. The hosted client is the
 * fallback for a box that has not installed local Whisper.
 *
 * There is NO on/off flag here. Which backend runs is determined by what is
 * installed and what credentials exist — the same "credential config, not a
 * feature flag" rule the hosted client was built under.
 */

import { createLocalWhisperClient } from './local-whisper.ts'
import { createOpenAiTranscriptionClient } from './openai-transcription.ts'
import { resolveWhisperInstall, type WhisperInstall } from './whisper-install.ts'
import type { TranscriptionClient } from './types.ts'

export type TranscriberKind = 'local' | 'openai' | 'none'

export interface ResolvedTranscriber {
  kind: TranscriberKind
  /** `null` only when `kind === 'none'`. */
  client: TranscriptionClient | null
  /** Which local model is in use — for logs and the Settings status line. */
  model_id?: string
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
  if (local !== null) {
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

  const key = (opts.env['OPENAI_API_KEY'] ?? '').trim()
  if (key.length > 0) {
    return { kind: 'openai', client: createOpenAiTranscriptionClient({ api_key: key }) }
  }
  return { kind: 'none', client: null }
}
