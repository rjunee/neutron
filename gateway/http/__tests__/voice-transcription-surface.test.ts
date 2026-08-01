/**
 * `gateway/http/voice-transcription-surface.ts` — the Settings-tab install API.
 *
 * Covers the four things that make the button honest:
 *   - the status GET reports which backend is ACTUALLY transcribing right now,
 *     including that local WINS over a set OPENAI_API_KEY;
 *   - the POST returns immediately (a 600 MB download must never be held open
 *     inside an HTTP request);
 *   - a second click joins the job rather than racing a second download;
 *   - nothing is reachable without the owner bearer.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WhisperInstaller, whisperPaths } from '../../transcription/whisper-install.ts'
import { createVoiceTranscriptionSurface } from '../voice-transcription-surface.ts'

const PATH = 'http://x/api/app/voice-transcription'

/** Owner bearer accepted; anything else rejected — mirrors the real resolver's shape. */
const auth = {
  resolve: async (token: string) =>
    token === 'good'
      ? { user_id: 'owner', project_slug: 'alice', project_id: 'p1' }
      : { code: 'unauthorized', message: 'bad token' },
} as unknown as Parameters<typeof createVoiceTranscriptionSurface>[0]['auth']

function make(opts: { env?: Record<string, string | undefined>; installed?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'neutron-asr-surface-'))
  if (opts.installed === true) {
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    mkdirSync(p.models_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    writeFileSync(join(p.models_dir, 'ggml-base.bin'), 'weights')
  }
  const installer = new WhisperInstaller({
    neutron_home: home,
    which: () => null,
    fetch_impl: (async () => new Response(new Uint8Array(8))) as unknown as typeof fetch,
    free_bytes: async () => 10 * 1024 ** 3,
  })
  const surface = createVoiceTranscriptionSurface({
    auth,
    installer,
    neutron_home: home,
    env: opts.env ?? {},
    platform: 'linux',
    arch: 'x64',
    which: () => null,
  })
  return { surface, installer, home }
}

function req(method: string, token = 'good', body?: object): Request {
  return new Request(PATH, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

describe('voice-transcription surface', () => {
  test('an unrelated path falls through to the sibling chain (null, not 404)', async () => {
    const { surface } = make()
    expect(await surface.handler(new Request('http://x/api/app/other'))).toBeNull()
  })

  test('every method requires the owner bearer', async () => {
    const { surface } = make()
    for (const m of ['GET', 'POST', 'DELETE']) {
      const res = await surface.handler(req(m, 'nope'))
      expect(res!.status).toBe(401)
    }
  })

  test('GET on a bare box reports backend=none and offers the catalog', async () => {
    const { surface } = make()
    const res = await surface.handler(req('GET'))
    const body = (await res!.json()) as Record<string, unknown>
    expect(body['backend']).toBe('none')
    expect(body['installed']).toBe(false)
    expect(body['default_model_id']).toBe('base')
    expect(Array.isArray(body['models'])).toBe(true)
    expect((body['models'] as unknown[]).length).toBeGreaterThan(0)
    expect(body['binary_downloadable']).toBe(true)
    // Nothing unpacked and nothing on PATH (`which: () => null` in `make`).
    expect(body['binary_present']).toBe(false)
  })

  test('binary_present is TRUE when whisper-cli is already on PATH (Homebrew)', async () => {
    // The pair (`binary_downloadable`, `binary_present`) is the whole truth about
    // whether pressing Install can work. A mobile client cannot run `brew` for
    // the owner, so it disables the control on false/false — which is only
    // correct if this field reports a Homebrew install honestly.
    const home = mkdtempSync(join(tmpdir(), 'neutron-asr-brew-'))
    const installer = new WhisperInstaller({ neutron_home: home, which: () => null })
    const surface = createVoiceTranscriptionSurface({
      auth,
      installer,
      neutron_home: home,
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      which: (cmd) => (cmd === 'whisper-cli' ? '/opt/homebrew/bin/whisper-cli' : null),
    })
    const body = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect(body['binary_present']).toBe(true)
    // macOS publishes no CLI tarball — the flag pair's blocking case.
    expect(body['binary_downloadable']).toBe(false)
  })

  test('binary_present honours the NEUTRON_WHISPER_BIN operator pin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'neutron-asr-pin-'))
    const pinned = join(home, 'whisper-cli')
    writeFileSync(pinned, 'x')
    const installer = new WhisperInstaller({ neutron_home: home, which: () => null })
    const surface = createVoiceTranscriptionSurface({
      auth,
      installer,
      neutron_home: home,
      env: { NEUTRON_WHISPER_BIN: pinned },
      platform: 'darwin',
      arch: 'arm64',
      which: () => null,
    })
    const body = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect(body['binary_present']).toBe(true)
  })

  test('GET with only a key set reports backend=openai', async () => {
    const { surface } = make({ env: { OPENAI_API_KEY: 'sk-x' } })
    const body = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect(body['backend']).toBe('openai')
  })

  test('GET with local installed AND a key set reports backend=local — local wins', async () => {
    const { surface } = make({ env: { OPENAI_API_KEY: 'sk-x' }, installed: true })
    const body = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect(body['backend']).toBe('local')
    expect(body['installed']).toBe(true)
    expect(body['model_id']).toBe('base')
    // The Remove affordance needs a real size to show.
    expect(body['installed_bytes']).toBeGreaterThan(0)
  })

  test('POST returns 202 IMMEDIATELY — the download is never held open in the request', async () => {
    const { surface } = make()
    const t0 = Date.now()
    const res = await surface.handler(req('POST', 'good', { model_id: 'base' }))
    expect(res!.status).toBe(202)
    // Not a timing assertion of the download itself — just that the handler did
    // not await it. A real model fetch is minutes.
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  test('POST with an unknown model is a 400, not a started job', async () => {
    const { surface, installer } = make()
    const res = await surface.handler(req('POST', 'good', { model_id: 'gpt-9' }))
    expect(res!.status).toBe(400)
    expect(((await res!.json()) as Record<string, unknown>)['code']).toBe('unknown_model')
    expect(installer.status()).toBeNull()
  })

  test('POST while a job runs reports the SAME job instead of racing a second one', async () => {
    let fetches = 0
    const home = mkdtempSync(join(tmpdir(), 'neutron-asr-race-'))
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    const installer = new WhisperInstaller({
      neutron_home: home,
      which: () => null,
      free_bytes: async () => 10 * 1024 ** 3,
      resolve_binary: () => null,
      fetch_impl: (async () => {
        fetches++
        await Bun.sleep(60)
        return new Response(new Uint8Array(8))
      }) as unknown as typeof fetch,
    })
    const surface = createVoiceTranscriptionSurface({
      auth,
      installer,
      neutron_home: home,
      env: {},
      platform: 'linux',
      arch: 'x64',
    })
    await surface.handler(req('POST', 'good', { model_id: 'base' }))
    const second = await surface.handler(req('POST', 'good', { model_id: 'large-v3-turbo' }))
    expect(second!.status).toBe(202)
    for (let i = 0; i < 100 && installer.isRunning(); i++) await Bun.sleep(5)
    // The second click did NOT kick off a competing large-v3-turbo download.
    expect(fetches).toBe(1)
  })

  test('DELETE removes the install and the status flips back', async () => {
    const { surface } = make({ installed: true })
    expect(((await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>)['installed']).toBe(true)
    const res = await surface.handler(req('DELETE'))
    expect(res!.status).toBe(200)
    expect(((await res!.json()) as Record<string, unknown>)['installed']).toBe(false)
  })

  test('DELETE during a running install is refused rather than half-deleting', async () => {
    const home = mkdtempSync(join(tmpdir(), 'neutron-asr-del-'))
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    const installer = new WhisperInstaller({
      neutron_home: home,
      which: () => null,
      free_bytes: async () => 10 * 1024 ** 3,
      resolve_binary: () => null,
      // Slow enough that the DELETE genuinely lands mid-download.
      fetch_impl: (async () => {
        await Bun.sleep(120)
        return new Response(new Uint8Array(8))
      }) as unknown as typeof fetch,
    })
    const surface = createVoiceTranscriptionSurface({
      auth,
      installer,
      neutron_home: home,
      env: {},
      platform: 'linux',
      arch: 'x64',
    })
    installer.start('base')
    expect(installer.isRunning()).toBe(true)
    const res = await surface.handler(req('DELETE'))
    expect(res!.status).toBe(409)
    expect(((await res!.json()) as Record<string, unknown>)['code']).toBe('install_running')
    for (let i = 0; i < 100 && installer.isRunning(); i++) await Bun.sleep(5)
  })

  test('an unsupported method is 405', async () => {
    const { surface } = make()
    expect((await surface.handler(req('PUT')))!.status).toBe(405)
  })
})
