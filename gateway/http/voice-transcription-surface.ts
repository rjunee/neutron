/**
 * @neutronai/gateway/http — the voice-transcription settings surface.
 *
 * Backs the Settings "Voice transcription" section on BOTH clients: which
 * backend is transcribing voice notes right now, WHICH ONE THE OWNER CHOSE,
 * whether an OpenAI key is configured, which local models can be installed, how
 * a running download is progressing, and the buttons that change any of it.
 *
 *   - `GET    /api/app/voice-transcription`            → the whole picture
 *   - `POST   /api/app/voice-transcription`            → start an install ({ model_id })
 *   - `DELETE /api/app/voice-transcription`            → delete the installed assets
 *   - `PUT    /api/app/voice-transcription/backend`    → choose a backend ({ backend })
 *   - `PUT    /api/app/voice-transcription/openai-key` → store a key ({ api_key })
 *   - `DELETE /api/app/voice-transcription/openai-key` → forget the stored key
 *
 * Every route answers with the SAME status object, so a client never has to
 * guess what a mutation did — it re-renders from the reply.
 *
 * MACHINE-SCOPED, not per-project — one whisper.cpp install and one choice serve
 * every project on the box — so the routes carry no project segment, mirroring
 * the global Codex-connect route. Same bearer auth as its siblings
 * (`AppWsAuthResolver`); `owner_slug` is ALWAYS the server-derived
 * `resolved.project_slug`, never client-supplied. No owner-supplied path or URL
 * is ever accepted, so there is nothing here for a caller to point at an
 * arbitrary file: the only inputs are a catalog id, a backend name, and an API
 * key, and every download URL + digest is compiled in.
 *
 * ── The API key is write-only ───────────────────────────────────────────────
 * The status object reports that a key EXISTS, where it came from and when it
 * was saved. It never carries the key, or any slice of it. Nothing here logs it.
 *
 * ── One decision, one place ─────────────────────────────────────────────────
 * `backend` is computed by calling `resolveTranscriber` — the same function the
 * upload path calls — rather than by re-deriving the rule here. This surface
 * previously carried its own copy of the precedence (`installed ? 'local' :
 * key ? 'openai' : 'none'`), which is how a status line drifts from what the box
 * actually does. It now reports the real answer by asking the real resolver.
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
  OpenAiKeyStore,
  validateOpenAiKey,
} from '@neutronai/gateway/transcription/openai-key-store.ts'
import { resolveTranscriber } from '@neutronai/gateway/transcription/resolve-transcriber.ts'
import {
  isTranscriptionBackendChoice,
  type TranscriptionBackendChoice,
} from '@neutronai/gateway/transcription/types.ts'
import {
  installedBytes,
  resolveWhisperInstall,
  whisperBinaryPresent,
  type WhisperInstaller,
} from '@neutronai/gateway/transcription/whisper-install.ts'
import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'

export interface VoiceTranscriptionSurfaceOptions {
  auth: AppWsAuthResolver
  installer: WhisperInstaller
  /** Resolved `NEUTRON_HOME`. */
  neutron_home: string
  env: Record<string, string | undefined>
  /** Reads/writes the owner's chosen backend (`instance_metadata`, migration
   *  0111). Injected as functions rather than a DB handle so this surface stays
   *  testable without a database, exactly as `installer` does for the download. */
  readChoice: () => TranscriptionBackendChoice | null
  writeChoice: (backend: TranscriptionBackendChoice) => Promise<void>
  /** The OpenAI transcription key: presence, provenance, save, forget. */
  keys: OpenAiKeyStore
  /** Injected in tests. Defaults to `process.platform` / `process.arch`. */
  platform?: string
  arch?: string
  /** PATH lookup for the `binary_present` probe. Injected in tests; defaults to
   *  `Bun.which`, so a dev box that happens to have Homebrew's `whisper-cli`
   *  cannot make a test claiming "bare box" pass for the wrong reason. */
  which?: (cmd: string) => string | null
}

export interface VoiceTranscriptionSurface {
  handler: (req: Request) => Promise<Response | null>
}

const PATH = '/api/app/voice-transcription'
const BACKEND_PATH = `${PATH}/backend`
const OPENAI_KEY_PATH = `${PATH}/openai-key`

export function createVoiceTranscriptionSurface(
  opts: VoiceTranscriptionSurfaceOptions,
): VoiceTranscriptionSurface {
  const { auth, installer, neutron_home, env, keys } = opts

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
    // Whether a runnable `whisper-cli` is ALREADY here (unpacked, Homebrew, or
    // operator-pinned). Together with the flag above this is the whole truth
    // about whether pressing Install can work: `!binary_downloadable &&
    // !binary_present` means the owner must install the binary ON THE SERVER
    // first, which no client — least of all a phone — can do for them. The web
    // tab could get away with implying "run brew, then reload"; a mobile client
    // has to disable the control and say why, so the fact is on the wire.
    const binary_present = whisperBinaryPresent({
      env,
      neutron_home,
      ...(opts.which !== undefined ? { which: opts.which } : {}),
    })
    const choice = opts.readChoice()
    const key_status = await keys.status()
    // ASK THE RESOLVER. Never re-derive the rule here.
    //
    // `keys.resolve()` decrypts, so a status poll (1/sec while a model is
    // downloading) briefly holds the plaintext. That is accepted rather than
    // worked around with a presence-only variant: this process owns the AES
    // keyfile and already decrypts the same value on every voice-note upload,
    // so no boundary is crossed — and threading a second "is there a key"
    // parameter purely to avoid it would put a copy of the availability rule
    // back in this file, which is the actual thing that goes wrong here.
    const active = resolveTranscriber({
      env,
      neutron_home,
      choice,
      openai_api_key: await keys.resolve(),
      ...(opts.which !== undefined ? { which: opts.which } : {}),
    })
    return {
      /** Which backend would transcribe a voice note right now. */
      backend: active.kind,
      /** When `backend === 'none'`, exactly why. */
      backend_reason: active.reason ?? null,
      /** What the owner CHOSE — `null` until they have chosen. Distinct from
       *  `backend`: a chosen backend that cannot run reports here but not there. */
      choice,
      /** Whether local whisper.cpp could serve a note right now. */
      local_available: install !== null,
      /** Whether an OpenAI key is configured, and where it came from. Never the key. */
      openai_key: key_status,
      installed: install !== null,
      model_id: install?.model_id ?? null,
      installed_bytes: install !== null ? await installedBytes(neutron_home) : 0,
      binary_downloadable,
      binary_present,
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
      const pathname = url.pathname
      if (pathname !== PATH && pathname !== BACKEND_PATH && pathname !== OPENAI_KEY_PATH) {
        return null
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)

      if (pathname === BACKEND_PATH) {
        if (req.method !== 'PUT') {
          return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on ${BACKEND_PATH}`)
        }
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const backend = body?.['backend']
        if (!isTranscriptionBackendChoice(backend)) {
          return jsonError(400, 'unknown_backend', "backend must be 'local' or 'openai'")
        }
        // Deliberately NOT gated on the backend being usable right now. The
        // owner is allowed to say what they want before it is ready (choose
        // OpenAI, then paste the key; choose local, then install it) — the
        // status object reports the gap, and the resolver refuses to substitute.
        await opts.writeChoice(backend)
        return jsonOk(await buildStatus())
      }

      if (pathname === OPENAI_KEY_PATH) {
        switch (req.method) {
          case 'PUT': {
            const body = (await readJsonBody(req)) as Record<string, unknown> | null
            const raw = body?.['api_key']
            const invalid = validateOpenAiKey(raw)
            // The message describes the SHAPE of the problem and never echoes
            // the value — an error body is a log line waiting to happen.
            if (invalid !== null) return jsonError(400, 'invalid_api_key', invalid)
            await keys.save(raw as string)
            return jsonOk(await buildStatus())
          }
          case 'DELETE': {
            const removed = await keys.remove()
            // `remove()` only ever clears THIS surface's dedicated row. When
            // nothing was removed and a key is still resolving, it belongs to
            // somewhere this endpoint has no authority over — say which, rather
            // than returning a 200 that reads as "deleted" over a box that
            // still transcribes.
            const source = removed ? null : (await keys.status()).source
            if (source === 'environment') {
              return jsonError(
                409,
                'key_from_environment',
                'that key comes from OPENAI_API_KEY in the server environment, not from this app — ' +
                  'remove it from the server\'s .env or unit file to unset it',
              )
            }
            if (source === 'shared') {
              return jsonError(
                409,
                'key_from_shared_credential',
                'that key is your general OpenAI credential from Settings → Integrations, which also ' +
                  'powers semantic memory — remove it there if you want it gone, or save a ' +
                  'transcription-only key here to override it',
              )
            }
            return jsonOk(await buildStatus())
          }
          default:
            return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on ${OPENAI_KEY_PATH}`)
        }
      }

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
