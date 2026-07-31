/**
 * @neutronai/gateway/http — local voice-transcription install surface.
 *
 * Backs the Settings tab's "Local voice transcription" section: what backend is
 * transcribing voice notes right now, which models can be installed, how a
 * running download is progressing, and the button that starts or removes one.
 *
 *   - `GET    /api/app/voice-transcription` → status + catalog + live progress
 *   - `POST   /api/app/voice-transcription` → start an install ({ model_id })
 *   - `DELETE /api/app/voice-transcription` → delete the installed assets
 *
 * MACHINE-SCOPED, not per-project — one whisper.cpp install serves every
 * project on the box — so the route carries no project segment, mirroring the
 * global Codex-connect route. Same bearer auth as its siblings
 * (`AppWsAuthResolver`); no owner-supplied path or URL is ever accepted, so
 * there is nothing here for a caller to point at an arbitrary file: the only
 * inputs are catalog ids, and every download URL + digest is compiled in.
 *
 * The POST returns IMMEDIATELY with the job's initial progress. The download is
 * hundreds of megabytes; holding an HTTP request open for it would guarantee
 * the exact silent-hang this surface exists to avoid. The client polls the GET.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import {
  DEFAULT_WHISPER_MODEL_ID,
  WHISPER_CPP_VERSION,
  WHISPER_MODELS,
  binaryAssetFor,
  modelAssetFor,
} from '@neutronai/gateway/transcription/whisper-catalog.ts'
import {
  installedBytes,
  resolveWhisperInstall,
  type WhisperInstaller,
} from '@neutronai/gateway/transcription/whisper-install.ts'
import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'

const PATH = '/api/app/voice-transcription'

export interface VoiceTranscriptionSurfaceOptions {
  auth: AppWsAuthResolver
  installer: WhisperInstaller
  /** Resolved `NEUTRON_HOME`. */
  neutron_home: string
  env: Record<string, string | undefined>
  /** Injected in tests. Defaults to `process.platform` / `process.arch`. */
  platform?: string
  arch?: string
}

export interface VoiceTranscriptionSurface {
  handler: (req: Request) => Promise<Response | null>
}

export function createVoiceTranscriptionSurface(
  opts: VoiceTranscriptionSurfaceOptions,
): VoiceTranscriptionSurface {
  const { auth, installer, neutron_home, env } = opts

  const buildStatus = async (): Promise<object> => {
    const install = resolveWhisperInstall({ env, neutron_home })
    const job = installer.status()
    const platform = opts.platform ?? process.platform
    const arch = opts.arch ?? process.arch
    // Whether this box can install the binary ITSELF. macOS has no upstream CLI
    // build, so the owner installs whisper-cpp via Homebrew and Neutron finds it
    // on PATH — the model download still works, hence a distinct field rather
    // than a flat "unsupported".
    const binary_downloadable = binaryAssetFor(platform, arch) !== null
    return {
      /** Which backend would transcribe a voice note right now. */
      backend: install !== null ? 'local' : (env['OPENAI_API_KEY'] ?? '').trim().length > 0 ? 'openai' : 'none',
      installed: install !== null,
      model_id: install?.model_id ?? null,
      installed_bytes: install !== null ? await installedBytes(neutron_home) : 0,
      binary_downloadable,
      whisper_version: WHISPER_CPP_VERSION,
      default_model_id: DEFAULT_WHISPER_MODEL_ID,
      models: WHISPER_MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        size_bytes: m.size_bytes,
        sec_per_30s_note: m.sec_per_30s_note,
        peak_rss_mb: m.peak_rss_mb,
        note: m.note,
      })),
      job,
    }
  }

  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== PATH) return null

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)

      switch (req.method) {
        case 'GET':
          return jsonOk(await buildStatus())

        case 'POST': {
          if (installer.isRunning()) {
            // Not an error — the owner double-clicked, or two tabs are open.
            // Report the job in flight rather than starting a second download.
            return jsonOk(await buildStatus(), 202)
          }
          const body = (await readJsonBody(req)) as Record<string, unknown> | null
          const requested = typeof body?.['model_id'] === 'string' ? body['model_id'] : DEFAULT_WHISPER_MODEL_ID
          if (modelAssetFor(requested) === null) {
            return jsonError(400, 'unknown_model', `no such model '${requested}'`)
          }
          installer.start(requested)
          return jsonOk(await buildStatus(), 202)
        }

        case 'DELETE': {
          if (installer.isRunning()) {
            return jsonError(409, 'install_running', 'an install is in progress — wait for it to finish first')
          }
          await installer.remove()
          return jsonOk(await buildStatus())
        }

        default:
          return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on ${PATH}`)
      }
    },
  }
}
