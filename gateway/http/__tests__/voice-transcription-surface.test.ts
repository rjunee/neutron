/**
 * `gateway/http/voice-transcription-surface.ts` — the Settings voice API.
 *
 * Covers the things that make the controls honest:
 *   - the status GET reports which backend is ACTUALLY transcribing right now,
 *     and that answer follows the owner's SETTING rather than any precedence
 *     between the backends;
 *   - a chosen backend that cannot run is reported as such, never swapped for
 *     the other one;
 *   - the API key goes UP and never comes back — in any field, in any form;
 *   - the POST returns immediately (a 600 MB download must never be held open
 *     inside an HTTP request);
 *   - a second click joins the job rather than racing a second download;
 *   - nothing is reachable without the owner bearer.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OpenAiKeyStore } from '../../transcription/openai-key-store.ts'
import type { TranscriptionBackendChoice } from '../../transcription/types.ts'
import { WhisperInstaller, whisperPaths } from '../../transcription/whisper-install.ts'
import { createVoiceTranscriptionSurface } from '../voice-transcription-surface.ts'

const PATH = 'http://x/api/app/voice-transcription'
const BACKEND_PATH = `${PATH}/backend`
const KEY_PATH = `${PATH}/openai-key`

/** Owner bearer accepted; anything else rejected — mirrors the real resolver's shape. */
const auth = {
  resolve: async (token: string) =>
    token === 'good'
      ? { user_id: 'owner', project_slug: 'alice', project_id: 'p1' }
      : { code: 'unauthorized', message: 'bad token' },
} as unknown as Parameters<typeof createVoiceTranscriptionSurface>[0]['auth']

/**
 * An in-memory stand-in for `ProjectCredentialStore` — the four methods
 * `OpenAiKeyStore` uses. Deliberately the REAL `OpenAiKeyStore` on top of it, so
 * the provenance rules (stored beats environment; environment cannot be
 * deleted) are exercised rather than mocked away.
 */
function fakeCredentialStore(seed?: string) {
  let plaintext: string | null = seed ?? null
  let updated_at = '2026-08-01T00:00:00.000Z'
  return {
    rows: () => plaintext,
    store: {
      getMeta: () => (plaintext === null ? null : { updated_at }),
      resolve: () => (plaintext === null ? null : { plaintext, scope: 'global', service: 'x' }),
      set: async (_owner: unknown, input: { plaintext: string }) => {
        plaintext = input.plaintext
        updated_at = '2026-08-02T00:00:00.000Z'
      },
      delete: async () => {
        if (plaintext === null) return false
        plaintext = null
        return true
      },
    } as unknown as ConstructorParameters<typeof OpenAiKeyStore>[0]['store'],
  }
}

function make(
  opts: {
    env?: Record<string, string | undefined>
    installed?: boolean
    choice?: TranscriptionBackendChoice | null
    storedKey?: string
  } = {},
) {
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
  const creds = fakeCredentialStore(opts.storedKey)
  const keys = new OpenAiKeyStore({
    store: creds.store,
    owner_slug: 'alice' as never,
    env: opts.env ?? {},
  })
  let choice: TranscriptionBackendChoice | null = opts.choice ?? null
  const surface = createVoiceTranscriptionSurface({
    auth,
    installer,
    neutron_home: home,
    env: opts.env ?? {},
    readChoice: () => choice,
    writeChoice: async (b) => {
      choice = b
    },
    keys,
    platform: 'linux',
    arch: 'x64',
    which: () => null,
  })
  return { surface, installer, home, creds, chosen: () => choice }
}

/** The choice/key deps for cases that are only probing the platform + installer. */
function noChoiceNoKey(env: Record<string, string | undefined>) {
  return {
    readChoice: () => null,
    writeChoice: async () => {},
    keys: new OpenAiKeyStore({ store: fakeCredentialStore().store, owner_slug: 'alice' as never, env }),
  }
}

function req(method: string, token = 'good', body?: object, url = PATH): Request {
  return new Request(url, {
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
      ...noChoiceNoKey({}),
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
      ...noChoiceNoKey({ NEUTRON_WHISPER_BIN: pinned }),
      platform: 'darwin',
      arch: 'arm64',
      which: () => null,
    })
    const body = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect(body['binary_present']).toBe(true)
  })

  test('GET with only a key set reports backend=openai — nothing to choose between', async () => {
    const { surface } = make({ env: { OPENAI_API_KEY: 'sk-x' } })
    const body = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect(body['backend']).toBe('openai')
    expect(body['choice']).toBeNull()
  })

  test('GET with BOTH available and no choice reports none/unchosen — no precedence', async () => {
    // The rule that used to live here ("local wins, unconditionally") is gone.
    // Reporting `local` in this state would mean the status line is describing a
    // preference the transcriber no longer has.
    const { surface } = make({ env: { OPENAI_API_KEY: 'sk-x' }, installed: true })
    const body = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect(body['backend']).toBe('none')
    expect(body['backend_reason']).toBe('unchosen')
    expect(body['local_available']).toBe(true)
    expect((body['openai_key'] as Record<string, unknown>)['present']).toBe(true)
    expect(body['installed']).toBe(true)
    expect(body['model_id']).toBe('base')
    // The Remove affordance needs a real size to show.
    expect(body['installed_bytes']).toBeGreaterThan(0)
  })

  test('GET honours a choice of openai even with local installed', async () => {
    const { surface } = make({
      env: { OPENAI_API_KEY: 'sk-x' },
      installed: true,
      choice: 'openai',
    })
    const body = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect(body['backend']).toBe('openai')
    expect(body['choice']).toBe('openai')
  })

  test('GET honours a choice of local even with a key set', async () => {
    const { surface } = make({ env: { OPENAI_API_KEY: 'sk-x' }, installed: true, choice: 'local' })
    const body = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect(body['backend']).toBe('local')
    expect(body['choice']).toBe('local')
  })

  test('a chosen backend that cannot run is reported, NEVER swapped for the other', async () => {
    const { surface } = make({ env: { OPENAI_API_KEY: 'sk-x' }, installed: false, choice: 'local' })
    const body = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect(body['backend']).toBe('none')
    expect(body['backend_reason']).toBe('local_not_installed')
    // The choice is still what the owner said, so the UI can show the gap.
    expect(body['choice']).toBe('local')
  })
})

describe('choosing a backend', () => {
  test('PUT /backend records the choice and the status flips with it', async () => {
    const { surface, chosen } = make({ env: { OPENAI_API_KEY: 'sk-x' }, installed: true })
    const res = await surface.handler(req('PUT', 'good', { backend: 'openai' }, BACKEND_PATH))
    expect(res!.status).toBe(200)
    expect(chosen()).toBe('openai')
    expect(((await res!.json()) as Record<string, unknown>)['backend']).toBe('openai')
  })

  test('a choice is allowed BEFORE it can work — you pick, then you set it up', async () => {
    const { surface, chosen } = make()
    const res = await surface.handler(req('PUT', 'good', { backend: 'openai' }, BACKEND_PATH))
    expect(res!.status).toBe(200)
    expect(chosen()).toBe('openai')
    const body = (await res!.json()) as Record<string, unknown>
    expect(body['choice']).toBe('openai')
    expect(body['backend']).toBe('none')
    expect(body['backend_reason']).toBe('openai_key_missing')
  })

  test('an unknown backend is a 400 and does not change the setting', async () => {
    const { surface, chosen } = make({ choice: 'local' })
    const res = await surface.handler(req('PUT', 'good', { backend: 'deepgram' }, BACKEND_PATH))
    expect(res!.status).toBe(400)
    expect(((await res!.json()) as Record<string, unknown>)['code']).toBe('unknown_backend')
    expect(chosen()).toBe('local')
  })

  test('the backend route needs the owner bearer too', async () => {
    const { surface } = make()
    const res = await surface.handler(req('PUT', 'nope', { backend: 'local' }, BACKEND_PATH))
    expect(res!.status).toBe(401)
  })
})

describe('the OpenAI key', () => {
  const SECRET = 'sk-thisisnotarealkey000000'

  test('PUT stores it and the status reports presence + provenance, never the key', async () => {
    const { surface, creds } = make()
    const res = await surface.handler(req('PUT', 'good', { api_key: SECRET }, KEY_PATH))
    expect(res!.status).toBe(200)
    expect(creds.rows()).toBe(SECRET)
    const raw = await res!.text()
    // THE assertion this whole route exists to satisfy: no part of the key is in
    // the response body — not the value, not a prefix, not a last-four.
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain(SECRET.slice(-4))
    const body = JSON.parse(raw) as Record<string, unknown>
    const key = body['openai_key'] as Record<string, unknown>
    expect(key['present']).toBe(true)
    expect(key['source']).toBe('stored')
    expect(typeof key['saved_at']).toBe('string')
  })

  test('a key with whitespace in it is refused, and the error does not echo it', async () => {
    const { surface, creds } = make()
    const res = await surface.handler(
      req('PUT', 'good', { api_key: `${SECRET}\n${SECRET}` }, KEY_PATH),
    )
    expect(res!.status).toBe(400)
    const raw = await res!.text()
    expect(((JSON.parse(raw) as Record<string, unknown>)['code'])).toBe('invalid_api_key')
    expect(raw).not.toContain(SECRET)
    expect(creds.rows()).toBeNull()
  })

  test('an empty key is refused rather than stored as a blank credential', async () => {
    const { surface, creds } = make()
    const res = await surface.handler(req('PUT', 'good', { api_key: '   ' }, KEY_PATH))
    expect(res!.status).toBe(400)
    expect(creds.rows()).toBeNull()
  })

  test('a stored key wins over the environment, and DELETE gives the environment back', async () => {
    const { surface, creds } = make({ env: { OPENAI_API_KEY: 'sk-from-env' }, storedKey: SECRET })
    const before = (await (await surface.handler(req('GET')))!.json()) as Record<string, unknown>
    expect((before['openai_key'] as Record<string, unknown>)['source']).toBe('stored')

    const res = await surface.handler(req('DELETE', 'good', undefined, KEY_PATH))
    expect(res!.status).toBe(200)
    expect(creds.rows()).toBeNull()
    const after = (await res!.json()) as Record<string, unknown>
    const key = after['openai_key'] as Record<string, unknown>
    // Still credentialed — via the environment, and it says so rather than
    // reporting the key as gone when the box can still reach OpenAI.
    expect(key['present']).toBe(true)
    expect(key['source']).toBe('environment')
  })

  test('DELETE of an environment-only key is a 409 that explains where it lives', async () => {
    const { surface } = make({ env: { OPENAI_API_KEY: 'sk-from-env' } })
    const res = await surface.handler(req('DELETE', 'good', undefined, KEY_PATH))
    expect(res!.status).toBe(409)
    const body = (await res!.json()) as Record<string, unknown>
    expect(body['code']).toBe('key_from_environment')
    expect(String(body['message'])).toContain('OPENAI_API_KEY')
  })

  test('the key route needs the owner bearer too', async () => {
    const { surface, creds } = make()
    const res = await surface.handler(req('PUT', 'nope', { api_key: SECRET }, KEY_PATH))
    expect(res!.status).toBe(401)
    expect(creds.rows()).toBeNull()
  })
})

describe('voice-transcription surface (install)', () => {

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
      ...noChoiceNoKey({}),
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
      ...noChoiceNoKey({}),
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
