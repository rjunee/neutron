/**
 * `gateway/transcription/local-whisper.ts` — the keyless whisper.cpp backend.
 *
 * The subprocess is injected (`run_impl`), so these run offline with no binary,
 * no model, and no audio. Every fixture below is SYNTHETIC — a handful of
 * arbitrary bytes labelled with a MIME type. There is deliberately no real
 * recording and no real transcript anywhere in this repo's test data.
 *
 * What matters here is the contract the upload surface depends on: this client
 * NEVER throws and NEVER returns a partial success. Every failure — a missing
 * binary, a container it cannot decode, a wedged process — comes back as a typed
 * `{ ok: false, code }` so an upload degrades instead of failing.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

import { createLocalWhisperClient, type RunResult } from '../local-whisper.ts'

/** Arbitrary non-audio bytes — nothing here is a real recording. */
const FAKE_AUDIO = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

function ok(stdout: string): RunResult {
  return { code: 0, stdout, stderr: '', timed_out: false }
}

/** A client whose subprocess is a recorded stub. */
function makeClient(
  impl: (argv: string[]) => RunResult | Promise<RunResult>,
  extra: Partial<Parameters<typeof createLocalWhisperClient>[0]> = {},
) {
  const calls: string[][] = []
  const client = createLocalWhisperClient({
    binary: '/opt/whisper/whisper-cli',
    model: '/opt/whisper/ggml-base.bin',
    lib_dir: '/opt/whisper',
    run_impl: async (argv) => {
      calls.push(argv)
      return impl(argv)
    },
    ...extra,
  })
  return { client, calls }
}

describe('createLocalWhisperClient', () => {
  test('a successful run returns the trimmed transcript', async () => {
    const { client } = makeClient(() => ok('\n  the transcript text  \n'))
    const res = await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/mpeg' })
    expect(res).toEqual({ ok: true, text: 'the transcript text' })
  })

  test('the audio is written to a scratch file that is REMOVED afterwards', async () => {
    let audioPath = ''
    let bytesSeenByWhisper: number[] = []
    const { client } = makeClient((argv) => {
      audioPath = argv[argv.indexOf('-f') + 1] ?? ''
      bytesSeenByWhisper = Array.from(new Uint8Array(readFileSync(audioPath)))
      return ok('hello')
    })
    await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/mpeg' })
    // The subprocess saw exactly the uploaded bytes…
    expect(bytesSeenByWhisper).toEqual(Array.from(FAKE_AUDIO))
    // …and nothing was left behind on disk.
    expect(existsSync(audioPath)).toBe(false)
  })

  test('the scratch file carries an extension whisper can route on', async () => {
    for (const [mime, ext] of [
      ['audio/mpeg', '.mp3'],
      ['audio/wav', '.wav'],
      ['audio/ogg', '.ogg'],
      ['audio/flac', '.flac'],
    ] as const) {
      const { client, calls } = makeClient(() => ok('x'))
      await client.transcribe({ bytes: FAKE_AUDIO, content_type: mime })
      const f = calls[0]![calls[0]!.indexOf('-f') + 1] ?? ''
      expect(f.endsWith(ext)).toBe(true)
    }
  })

  test('the model, thread cap and language are passed through', async () => {
    const { client, calls } = makeClient(() => ok('x'), { threads: 2, language: 'de' })
    await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/wav' })
    const argv = calls[0]!
    expect(argv[0]).toBe('/opt/whisper/whisper-cli')
    expect(argv[argv.indexOf('-m') + 1]).toBe('/opt/whisper/ggml-base.bin')
    expect(argv[argv.indexOf('-t') + 1]).toBe('2')
    expect(argv[argv.indexOf('-l') + 1]).toBe('de')
    // stdout must carry the transcript and nothing else.
    expect(argv).toContain('-nt')
    expect(argv).toContain('-np')
  })

  test('NO decode-tuning flags are passed — whisper.cpp defaults win', async () => {
    // Greedy decode was measured as ~20% faster but visibly worse punctuation;
    // the default beam search is the deliberate choice. If someone re-adds
    // `-bs`/`-bo` for speed, this fails and they have to justify it.
    const { client, calls } = makeClient(() => ok('x'))
    await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/wav' })
    expect(calls[0]).not.toContain('-bs')
    expect(calls[0]).not.toContain('-bo')
  })

  test('`-ng` is NEVER passed — it disables Metal on macOS', async () => {
    // Measured on Apple silicon: the same 11-second clip took 32.0 s with `-ng`
    // and 3.4 s without. On a CPU-only Linux box the flag is a no-op, so there
    // is no case where passing it helps and one where it costs 10x.
    const { client, calls } = makeClient(() => ok('x'))
    await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/wav' })
    expect(calls[0]).not.toContain('-ng')
  })

  test('lib_dir is exported as LD_LIBRARY_PATH — without it the binary cannot link', async () => {
    let seen: Record<string, string> = {}
    const client = createLocalWhisperClient({
      binary: '/opt/whisper/whisper-cli',
      model: '/opt/whisper/ggml-base.bin',
      lib_dir: '/opt/whisper/bin',
      run_impl: async (_argv, o) => {
        seen = o.env
        return ok('x')
      },
    })
    await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/wav' })
    expect(seen['LD_LIBRARY_PATH']).toContain('/opt/whisper/bin')
  })

  test('a Homebrew binary (lib_dir null) gets NO forced LD_LIBRARY_PATH', async () => {
    let seen: Record<string, string> = {}
    const client = createLocalWhisperClient({
      binary: '/opt/homebrew/bin/whisper-cli',
      model: '/m.bin',
      lib_dir: null,
      run_impl: async (_argv, o) => {
        seen = o.env
        return ok('x')
      },
    })
    await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/wav' })
    expect(seen['LD_LIBRARY_PATH']).toBeUndefined()
  })

  test('a non-zero exit maps to exec_failed and carries the stderr tail', async () => {
    const { client } = makeClient(() => ({
      code: 3,
      stdout: '',
      stderr: 'error: failed to load model',
      timed_out: false,
    }))
    const res = await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/wav' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('exec_failed')
    expect(res.message).toContain('failed to load model')
  })

  test('a killed (timed-out) run maps to timeout, not exec_failed', async () => {
    const { client } = makeClient(() => ({ code: null, stdout: '', stderr: '', timed_out: true }))
    const res = await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/wav' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('timeout')
  })

  test('an empty transcript is bad_response, never a silent empty success', async () => {
    const { client } = makeClient(() => ok('   \n  '))
    const res = await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/wav' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('bad_response')
  })

  test('oversized audio is refused BEFORE any subprocess runs', async () => {
    const { client, calls } = makeClient(() => ok('x'), { max_bytes: 4 })
    const res = await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/wav' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('too_large')
    expect(calls.length).toBe(0)
  })

  test('an unknown container is unsupported_format, not a crash', async () => {
    const { client, calls } = makeClient(() => ok('x'))
    const res = await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/aiff' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('unsupported_format')
    expect(calls.length).toBe(0)
  })

  describe('m4a — the container whisper.cpp cannot decode itself', () => {
    test('WITHOUT ffmpeg it is refused with actionable guidance', async () => {
      const { client, calls } = makeClient(() => ok('x'), { ffmpeg: null })
      const res = await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/mp4' })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.code).toBe('unsupported_format')
      expect(res.message).toContain('ffmpeg')
      expect(calls.length).toBe(0)
    })

    test('WITH ffmpeg it is normalized to 16 kHz mono wav, then transcribed', async () => {
      const { client, calls } = makeClient(
        (argv) => (argv[0] === '/usr/bin/ffmpeg' ? ok('') : ok('decoded text')),
        { ffmpeg: '/usr/bin/ffmpeg' },
      )
      const res = await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/mp4' })
      expect(res).toEqual({ ok: true, text: 'decoded text' })
      expect(calls.length).toBe(2)
      const ff = calls[0]!
      expect(ff[0]).toBe('/usr/bin/ffmpeg')
      expect(ff[ff.indexOf('-ar') + 1]).toBe('16000')
      expect(ff[ff.indexOf('-ac') + 1]).toBe('1')
      // whisper then reads the WAV ffmpeg produced, not the original m4a.
      const w = calls[1]!
      expect((w[w.indexOf('-f') + 1] ?? '').endsWith('.wav')).toBe(true)
    })

    test('an ffmpeg failure maps to unsupported_format and never runs whisper', async () => {
      const { client, calls } = makeClient(
        (argv) =>
          argv[0] === '/usr/bin/ffmpeg'
            ? { code: 1, stdout: '', stderr: 'Invalid data found', timed_out: false }
            : ok('should not happen'),
        { ffmpeg: '/usr/bin/ffmpeg' },
      )
      const res = await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/mp4' })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.code).toBe('unsupported_format')
      expect(calls.length).toBe(1)
    })
  })

  test('a throwing runner still yields a typed result — the client never throws', async () => {
    const { client } = makeClient(() => {
      throw new Error('spawn EACCES')
    })
    const res = await client.transcribe({ bytes: FAKE_AUDIO, content_type: 'audio/wav' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('exec_failed')
    expect(res.message).toContain('EACCES')
  })
})
