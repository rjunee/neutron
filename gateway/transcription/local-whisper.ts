/**
 * @neutronai/gateway/transcription — LOCAL whisper.cpp ASR (no key, no network).
 *
 * The keyless half of voice notes. Satisfies the same `TranscriptionClient`
 * contract as `openai-transcription.ts`, so the chat-upload surface is unchanged:
 * it still just calls `transcribeAudio(...)` and gets a string or `null`.
 *
 * WHY THIS EXISTS: transcription used to require the owner to hold an
 * `OPENAI_API_KEY`. Voice notes are a core capability, and a self-hoster —
 * or a Managed tenant — should not need an account with a third party to use
 * one. With whisper.cpp installed, the audio never leaves the machine.
 *
 * HOW IT RUNS
 *
 * `whisper-cli` is a subprocess, not a library. Per note we write the uploaded
 * bytes to a scratch file, run the binary over it, and read the transcript off
 * stdout (`-nt -np`: no timestamps, no progress chatter — every diagnostic line
 * whisper emits goes to stderr, so stdout is the transcript and nothing else).
 * The scratch directory is removed on every exit path.
 *
 * DECODING — whisper's default beam search, deliberately kept. Greedy decode
 * (`-bo 1 -bs 1`) was measured against it on the reference box and IS faster,
 * but only by about 20% (a 30-second note: 2.9 s greedy vs 3.8 s beam), because
 * the encoder — which runs over a fixed 30-second mel window no matter what the
 * decoder does — is the real cost, not the beams. It also visibly drops
 * punctuation. Paying one second for correctly punctuated text that an LLM then
 * has to read is the right trade, so no decode flags are passed at all.
 *
 * THREADS — capped at 4, deliberately. This process competes with the agent
 * runtime on the same box (on a hosted box, with the owner's live instance).
 * Whisper scales poorly past four threads anyway — measured on the reference
 * 8-core box, eight threads was consistently SLOWER than four (memory-bandwidth
 * contention) — so the cap costs nothing and leaves half the machine responsive.
 *
 * CONTAINERS — `whisper-cli` decodes wav/mp3/ogg/flac itself (it links
 * miniaudio). It does NOT decode m4a/mp4, which is exactly what iOS Safari's
 * recorder produces, so those are normalized through `ffmpeg` when it is
 * present and refused with a precise `unsupported_format` when it is not.
 *
 * NEVER THROWS. Every failure maps to a typed `{ ok: false, code }`, because
 * ASR must never fail an upload.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TranscribeInput, TranscribeResult, TranscriptionClient } from './types.ts'

export interface LocalWhisperOptions {
  /** Absolute path to the `whisper-cli` executable. */
  binary: string
  /** Absolute path to the ggml weights. */
  model: string
  /**
   * Directory holding whisper's `.so` files, prepended to `LD_LIBRARY_PATH`.
   * The upstream release tarball ships them beside the binary with NO rpath, so
   * omitting this makes the process die at dynamic-link time. `null` for a
   * package-manager build that is already linked.
   */
  lib_dir?: string | null
  /** Decode threads. Default 4 — see the header note on contention. */
  threads?: number
  /** `auto` (default) detects the language per note; pin e.g. `en` to skip it. */
  language?: string
  /** Kill the child after this long. Default 10 min. */
  timeout_ms?: number
  /** Refuse inputs larger than this. Default 25 MiB, matching the hosted API. */
  max_bytes?: number
  /** `ffmpeg` path for m4a normalization, or null when unavailable. */
  ffmpeg?: string | null
  /** Scratch root, injected in tests. Defaults to the OS temp dir. */
  scratch_dir?: string
  /** Injected in tests — replaces the real subprocess. */
  run_impl?: (argv: string[], opts: { env: Record<string, string>; timeout_ms: number }) => Promise<RunResult>
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** True when the child was killed for exceeding `timeout_ms`. */
  timed_out: boolean
}

const DEFAULT_THREADS = 4
const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

/** Extension whisper needs to route its decoder, by sniffed MIME. */
const EXT_FOR_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
}

/** Containers `whisper-cli` decodes natively (miniaudio) — no ffmpeg needed. */
const NATIVE_MIMES = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac'])

export function createLocalWhisperClient(opts: LocalWhisperOptions): TranscriptionClient {
  const threads = opts.threads ?? DEFAULT_THREADS
  const language = opts.language ?? 'auto'
  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const max_bytes = opts.max_bytes ?? DEFAULT_MAX_BYTES
  const run = opts.run_impl ?? runSubprocess

  return {
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      if (input.bytes.byteLength > max_bytes) {
        return {
          ok: false,
          code: 'too_large',
          message: `audio is ${input.bytes.byteLength} bytes; the local transcriber accepts up to ${max_bytes}`,
        }
      }
      const ext = EXT_FOR_MIME[input.content_type]
      if (ext === undefined) {
        return {
          ok: false,
          code: 'unsupported_format',
          message: `local transcription does not handle ${input.content_type}`,
        }
      }
      const needsTranscode = !NATIVE_MIMES.has(input.content_type)
      if (needsTranscode && (opts.ffmpeg === undefined || opts.ffmpeg === null)) {
        return {
          ok: false,
          code: 'unsupported_format',
          message:
            `${input.content_type} needs ffmpeg to decode and ffmpeg is not installed — ` +
            `install ffmpeg, or record in a format whisper reads directly (mp3/wav/ogg/flac)`,
        }
      }

      let dir: string
      try {
        dir = await mkdtemp(join(opts.scratch_dir ?? tmpdir(), 'neutron-asr-'))
      } catch (err) {
        return {
          ok: false,
          code: 'exec_failed',
          message: `could not create a scratch dir: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      try {
        const raw = join(dir, `note.${ext}`)
        await writeFile(raw, input.bytes)

        // m4a → 16 kHz mono wav, which is also exactly whisper's internal
        // sample format, so this costs nothing beyond the decode itself.
        let audio = raw
        if (needsTranscode) {
          const wav = join(dir, 'note.wav')
          const ff = await run([opts.ffmpeg as string, '-nostdin', '-loglevel', 'error', '-i', raw, '-ac', '1', '-ar', '16000', '-y', wav], {
            env: {},
            timeout_ms,
          })
          if (ff.code !== 0) {
            return {
              ok: false,
              code: ff.timed_out ? 'timeout' : 'unsupported_format',
              message: ff.timed_out
                ? `ffmpeg timed out after ${timeout_ms}ms`
                : `ffmpeg could not decode ${input.content_type}: ${ff.stderr.trim().slice(0, 200)}`,
            }
          }
          audio = wav
        }

        const env: Record<string, string> = {}
        if (opts.lib_dir !== undefined && opts.lib_dir !== null && opts.lib_dir.length > 0) {
          const existing = process.env['LD_LIBRARY_PATH']
          env['LD_LIBRARY_PATH'] =
            existing !== undefined && existing.length > 0 ? `${opts.lib_dir}:${existing}` : opts.lib_dir
        }

        const argv = [
          opts.binary,
          '-m', opts.model,
          '-f', audio,
          '-t', String(threads),
          '-l', language,
          // stdout carries the transcript ONLY.
          '-nt',
          '-np',
        ]
        // NOTE: do NOT pass `-ng`. It looks harmless on a CPU-only server, but
        // it disables Metal on macOS, where whisper.cpp otherwise uses the GPU —
        // measured on an Apple-silicon box, the same 11-second clip took 32.0 s
        // with `-ng` and 3.4 s without it. On a Linux box with no GPU backend
        // compiled in the flag changes nothing, so omitting it is strictly
        // better everywhere.
        const res = await run(argv, { env, timeout_ms })

        if (res.timed_out) {
          return { ok: false, code: 'timeout', message: `transcription timed out after ${timeout_ms}ms` }
        }
        if (res.code !== 0) {
          return {
            ok: false,
            code: 'exec_failed',
            message: `whisper-cli exited ${res.code}: ${res.stderr.trim().slice(0, 300)}`,
          }
        }
        const text = res.stdout.trim()
        if (text.length === 0) {
          return { ok: false, code: 'bad_response', message: 'whisper-cli produced no transcript' }
        }
        return { ok: true, text }
      } catch (err) {
        return {
          ok: false,
          code: 'exec_failed',
          message: err instanceof Error ? err.message : String(err),
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

/** Real subprocess runner with a hard kill deadline. */
async function runSubprocess(
  argv: string[],
  opts: { env: Record<string, string>; timeout_ms: number },
): Promise<RunResult> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env, ...opts.env },
    })
  } catch (err) {
    // Bun.spawn throws synchronously when the executable is absent.
    return { code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err), timed_out: false }
  }
  let timed_out = false
  const timer = setTimeout(() => {
    timed_out = true
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }, opts.timeout_ms)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr, timed_out }
  } finally {
    clearTimeout(timer)
  }
}
