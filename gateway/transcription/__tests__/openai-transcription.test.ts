/**
 * @neutronai/gateway/transcription — OpenAI Whisper client unit tests (M2 task 5).
 *
 * No network anywhere — `fetch_impl` is injected. Plain TS (no component
 * rendering, no process-global module mocks).
 */
import { describe, expect, it } from 'bun:test'

import {
  audioFilenameFor,
  createOpenAiTranscriptionClient,
} from '../openai-transcription.ts'

const AUDIO = new Uint8Array([1, 2, 3, 4])

/** A fetch stub that captures (url, init) and returns a canned Response. */
function captureFetch(response: Response): {
  fetch: typeof fetch
  calls: Array<{ url: string; init: RequestInit | undefined }>
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return response
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

describe('createOpenAiTranscriptionClient', () => {
  it('(a) happy path — posts multipart to the default endpoint with auth + model + file', async () => {
    const { fetch: fetchImpl, calls } = captureFetch(
      new Response('{"text":"hello"}', { status: 200 }),
    )
    const client = createOpenAiTranscriptionClient({ api_key: 'sk-test', fetch_impl: fetchImpl })
    const res = await client.transcribe({ bytes: AUDIO, content_type: 'audio/mp4' })

    expect(res).toEqual({ ok: true, text: 'hello' })
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions')
    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-test')
    const body = calls[0]!.init!.body as FormData
    expect(body.get('model')).toBe('whisper-1')
    const file = body.get('file') as File
    expect(file).toBeInstanceOf(Blob)
    // Whisper routes on the filename extension — audio/mp4 → voice.m4a.
    expect(file.name).toBe('voice.m4a')
  })

  it('(b) honors a custom base_url (trailing slash trimmed) + model override', async () => {
    const { fetch: fetchImpl, calls } = captureFetch(
      new Response('{"text":"local"}', { status: 200 }),
    )
    const client = createOpenAiTranscriptionClient({
      api_key: 'k',
      base_url: 'http://localhost:9000/',
      model: 'whisper-large-v3',
      fetch_impl: fetchImpl,
    })
    const res = await client.transcribe({ bytes: AUDIO, content_type: 'audio/wav' })

    expect(res).toEqual({ ok: true, text: 'local' })
    expect(calls[0]!.url).toBe('http://localhost:9000/v1/audio/transcriptions')
    const body = calls[0]!.init!.body as FormData
    expect(body.get('model')).toBe('whisper-large-v3')
    expect((body.get('file') as File).name).toBe('voice.wav')
  })

  it('(c) maps a 401 to http_error with the status + body snippet', async () => {
    const { fetch: fetchImpl } = captureFetch(
      new Response('invalid api key', { status: 401 }),
    )
    const client = createOpenAiTranscriptionClient({ api_key: 'bad', fetch_impl: fetchImpl })
    const res = await client.transcribe({ bytes: AUDIO, content_type: 'audio/mpeg' })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('http_error')
    expect(res.status).toBe(401)
    expect(res.message).toContain('invalid api key')
  })

  it('(d) maps a fetch rejection to network_error', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const client = createOpenAiTranscriptionClient({ api_key: 'k', fetch_impl: fetchImpl })
    const res = await client.transcribe({ bytes: AUDIO, content_type: 'audio/mpeg' })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('network_error')
    expect(res.message).toContain('connection refused')
  })

  it('(e) aborts on timeout and returns timeout', async () => {
    // A fetch that never resolves except via the abort signal.
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })) as unknown as typeof fetch
    const client = createOpenAiTranscriptionClient({
      api_key: 'k',
      fetch_impl: fetchImpl,
      timeout_ms: 10,
    })
    const res = await client.transcribe({ bytes: AUDIO, content_type: 'audio/mpeg' })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('timeout')
  })

  it('(f) maps a 200 with a missing text field to bad_response', async () => {
    const { fetch: fetchImpl } = captureFetch(new Response('{"nope":1}', { status: 200 }))
    const client = createOpenAiTranscriptionClient({ api_key: 'k', fetch_impl: fetchImpl })
    const res = await client.transcribe({ bytes: AUDIO, content_type: 'audio/wav' })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('bad_response')
  })

  it('(g) audioFilenameFor maps canonical MIMEs to extensions, else voice.bin', () => {
    expect(audioFilenameFor('audio/mpeg')).toBe('voice.mp3')
    expect(audioFilenameFor('audio/mp4')).toBe('voice.m4a')
    expect(audioFilenameFor('audio/wav')).toBe('voice.wav')
    expect(audioFilenameFor('audio/weird')).toBe('voice.bin')
    expect(audioFilenameFor('')).toBe('voice.bin')
  })
})
