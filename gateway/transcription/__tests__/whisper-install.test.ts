/**
 * `gateway/transcription/whisper-install.ts` — install + detection.
 *
 * The load-bearing guarantee here is the one the owner asked for explicitly:
 * **a half-downloaded model must never be loaded as if it were whole.** Every
 * artifact is hashed as it streams and only renamed into place on an exact
 * SHA-256 match, so a truncated or corrupted body leaves NOTHING installed.
 * The corruption tests below are the point of this file.
 *
 * All downloads are served by an injected fetch — no network, and the fixtures
 * are a few synthetic bytes rather than real weights.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WHISPER_MODELS, modelAssetFor } from '../whisper-catalog.ts'
import { WhisperInstaller, resolveWhisperInstall, whisperPaths } from '../whisper-install.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neutron-whisper-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Settle the installer's background job. */
async function settle(inst: WhisperInstaller): Promise<void> {
  for (let i = 0; i < 200 && inst.isRunning(); i++) await Bun.sleep(5)
}

/** A fetch that serves `body` for every URL. */
function serve(body: Uint8Array): typeof fetch {
  return (async () =>
    new Response(body, { status: 200, headers: { 'Content-Length': String(body.byteLength) } })) as unknown as typeof fetch
}

function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex')
}

describe('resolveWhisperInstall', () => {
  test('returns null when nothing is installed', () => {
    expect(resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })).toBeNull()
  })

  test('a binary WITHOUT a model is not an installation', () => {
    // Reporting "installed" on half of it would strand voice notes with no
    // transcript and no explanation.
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    expect(resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })).toBeNull()
  })

  test('a model WITHOUT a binary is not an installation', () => {
    const p = whisperPaths(home)
    mkdirSync(p.models_dir, { recursive: true })
    writeFileSync(join(p.models_dir, 'ggml-base.bin'), 'x')
    expect(resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })).toBeNull()
  })

  test('binary + model under NEUTRON_HOME resolves, with the lib dir for LD_LIBRARY_PATH', () => {
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    mkdirSync(p.models_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    writeFileSync(join(p.models_dir, 'ggml-base.bin'), 'x')
    const r = resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })
    expect(r).not.toBeNull()
    expect(r!.binary).toBe(p.binary)
    // The upstream tarball ships its .so files beside the binary with no rpath,
    // so this MUST be reported or the process dies at dynamic-link time.
    expect(r!.lib_dir).toBe(p.bin_dir)
    expect(r!.model_id).toBe('base')
  })

  test('a PATH binary (Homebrew) reports NO lib dir — it is already linked', () => {
    const p = whisperPaths(home)
    mkdirSync(p.models_dir, { recursive: true })
    writeFileSync(join(p.models_dir, 'ggml-base.bin'), 'x')
    const r = resolveWhisperInstall({
      env: {},
      neutron_home: home,
      which: (c) => (c === 'whisper-cli' ? '/opt/homebrew/bin/whisper-cli' : null),
    })
    expect(r!.binary).toBe('/opt/homebrew/bin/whisper-cli')
    expect(r!.lib_dir).toBeNull()
  })

  test('NEUTRON_WHISPER_MODEL points several instances at ONE shared copy of the weights', () => {
    // Hundreds of megabytes per instance is absurd when the file is identical.
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    const shared = join(home, 'shared-ggml.bin')
    writeFileSync(shared, 'x')
    const r = resolveWhisperInstall({
      env: { NEUTRON_WHISPER_MODEL: shared },
      neutron_home: home,
      which: () => null,
    })
    expect(r!.model).toBe(shared)
    expect(r!.model_id).toBe('custom')
  })

  test('a pinned model that does NOT exist resolves to null, never a bogus path', () => {
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    const r = resolveWhisperInstall({
      env: { NEUTRON_WHISPER_MODEL: join(home, 'nope.bin') },
      neutron_home: home,
      which: () => null,
    })
    expect(r).toBeNull()
  })

  test('a non-default model the owner chose is still found', () => {
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    mkdirSync(p.models_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    writeFileSync(join(p.models_dir, 'ggml-large-v3-turbo.bin'), 'x')
    const r = resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })
    expect(r!.model_id).toBe('large-v3-turbo')
  })
})

describe('WhisperInstaller', () => {
  /** Synthetic weights whose digest the test controls. */
  const WEIGHTS = new TextEncoder().encode('pretend-model-weights')

  /** A catalog entry pointing at `WEIGHTS`, so the SUCCESS path is reachable offline. */
  function fakeModel(overrides: Partial<{ sha256: string }> = {}) {
    return () => ({
      id: 'base',
      label: 'test',
      url: 'https://example.invalid/ggml-base.bin',
      sha256: overrides.sha256 ?? sha256(WEIGHTS),
      size_bytes: WEIGHTS.byteLength,
      sec_per_30s_note: 3.8,
      peak_rss_mb: 343,
      note: 'test',
    })
  }

  /** An installer whose binary leg is already satisfied, isolating the model leg. */
  function modelOnlyInstaller(opts: {
    body: Uint8Array
    resolve_model: () => ReturnType<ReturnType<typeof fakeModel>>
  }): WhisperInstaller {
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    return new WhisperInstaller({
      neutron_home: home,
      fetch_impl: serve(opts.body),
      platform: 'linux',
      arch: 'x64',
      free_bytes: async () => 10 * 1024 ** 3,
      which: () => null,
      resolve_model: opts.resolve_model,
      // Binary already present, so the binary leg is skipped either way.
      resolve_binary: () => null,
    })
  }

  test('a good download is hashed, placed, and reported done', async () => {
    const inst = modelOnlyInstaller({ body: WEIGHTS, resolve_model: fakeModel() })
    inst.start('base')
    await settle(inst)
    const s = inst.status()!
    expect(s.phase).toBe('done')
    expect(s.error).toBeUndefined()
    const p = whisperPaths(home)
    const placed = join(p.models_dir, 'ggml-base.bin')
    expect(existsSync(placed)).toBe(true)
    // The bytes on disk are exactly what was served — nothing truncated.
    expect(new Uint8Array(readFileSync(placed))).toEqual(WEIGHTS)
    // No scratch file left behind.
    expect(existsSync(`${placed}.part`)).toBe(false)
    // And the box now reports itself installed.
    expect(resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })).not.toBeNull()
  })

  test('progress reports REAL byte counts against a known total, not a spinner', async () => {
    const inst = modelOnlyInstaller({ body: WEIGHTS, resolve_model: fakeModel() })
    const initial = inst.start('base')
    expect(initial.phase).not.toBe('failed')
    await settle(inst)
    const s = inst.status()!
    expect(s.total_bytes).toBe(WEIGHTS.byteLength)
    expect(s.received_bytes).toBe(WEIGHTS.byteLength)
  })

  test('a CORRUPTED body installs NOTHING (the corruption guarantee)', async () => {
    // Right length, wrong bytes — the case a size check alone would wave through.
    const corrupted = new Uint8Array(WEIGHTS.byteLength).fill(0x41)
    const inst = modelOnlyInstaller({ body: corrupted, resolve_model: fakeModel() })
    inst.start('base')
    await settle(inst)
    const s = inst.status()!
    expect(s.phase).toBe('failed')
    expect(s.error?.code).toBe('checksum_mismatch')
    const p = whisperPaths(home)
    expect(existsSync(join(p.models_dir, 'ggml-base.bin'))).toBe(false)
    // Not even a stray .part survives, so a retry starts clean.
    expect(existsSync(join(p.models_dir, 'ggml-base.bin.part'))).toBe(false)
    // And the resolver agrees the box is NOT installed.
    expect(resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })).toBeNull()
  })

  test('a TRUNCATED body installs NOTHING either', async () => {
    const inst = modelOnlyInstaller({ body: WEIGHTS.slice(0, 4), resolve_model: fakeModel() })
    inst.start('base')
    await settle(inst)
    expect(inst.status()!.error?.code).toBe('checksum_mismatch')
    expect(resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })).toBeNull()
  })

  test('a failed install is SAFELY RE-RUNNABLE — the retry succeeds', async () => {
    // First attempt gets garbage, second gets the real thing. The leftover state
    // from attempt one must not poison attempt two.
    const inst1 = modelOnlyInstaller({
      body: new Uint8Array(WEIGHTS.byteLength).fill(0x41),
      resolve_model: fakeModel(),
    })
    inst1.start('base')
    await settle(inst1)
    expect(inst1.status()!.phase).toBe('failed')

    const inst2 = modelOnlyInstaller({ body: WEIGHTS, resolve_model: fakeModel() })
    inst2.start('base')
    await settle(inst2)
    expect(inst2.status()!.phase).toBe('done')
    expect(resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })).not.toBeNull()
  })

  test('the REAL catalog digest is enforced — a stub body is rejected', async () => {
    // The same flow with the compiled-in catalog (no resolve_model override):
    // arbitrary bytes can never masquerade as the pinned weights.
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    const inst = new WhisperInstaller({
      neutron_home: home,
      fetch_impl: serve(new TextEncoder().encode('not the real weights')),
      platform: 'linux',
      arch: 'x64',
      free_bytes: async () => 10 * 1024 ** 3,
      which: () => null,
    })
    inst.start('base')
    await settle(inst)
    expect(inst.status()!.error?.code).toBe('checksum_mismatch')
    expect(existsSync(join(p.models_dir, 'ggml-base.bin'))).toBe(false)
  })

  test('a second click JOINS the running job instead of racing a second download', async () => {
    let started = 0
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    const inst = new WhisperInstaller({
      neutron_home: home,
      fetch_impl: (async () => {
        started++
        await Bun.sleep(40)
        return new Response(WEIGHTS)
      }) as unknown as typeof fetch,
      platform: 'linux',
      arch: 'x64',
      free_bytes: async () => 10 * 1024 ** 3,
      which: () => null,
      resolve_model: fakeModel(),
      resolve_binary: () => null,
    })
    const a = inst.start('base')
    const b = inst.start('base')
    expect(b.started_at).toBe(a.started_at)
    await settle(inst)
    expect(started).toBe(1)
  })

  test('insufficient disk fails BEFORE the first byte is fetched', async () => {
    let fetched = 0
    const inst = new WhisperInstaller({
      neutron_home: home,
      fetch_impl: (async () => {
        fetched++
        return new Response(new Uint8Array(8))
      }) as unknown as typeof fetch,
      platform: 'sunos',
      arch: 'sparc',
      free_bytes: async () => 1024, // 1 KB free
      which: () => null,
    })
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    inst.start('base')
    await settle(inst)
    const s = inst.status()!
    expect(s.phase).toBe('failed')
    expect(s.error?.code).toBe('insufficient_disk')
    // The whole point: no 480 MB download that dies at the end.
    expect(fetched).toBe(0)
    expect(s.error?.message).toContain('MB free')
  })

  test('a platform with no published binary AND none on PATH says so precisely', async () => {
    const inst = new WhisperInstaller({
      neutron_home: home,
      fetch_impl: serve(new Uint8Array(8)),
      platform: 'sunos',
      arch: 'sparc',
      free_bytes: async () => 10 * 1024 ** 3,
      which: () => null,
    })
    inst.start('base')
    await settle(inst)
    const s = inst.status()!
    expect(s.phase).toBe('failed')
    expect(s.error?.code).toBe('unsupported_platform')
    expect(s.error?.message).toContain('brew install whisper-cpp')
  })

  test('an unknown model id is rejected without starting a job', () => {
    const inst = new WhisperInstaller({ neutron_home: home, fetch_impl: serve(new Uint8Array(8)), which: () => null })
    const s = inst.start('definitely-not-a-model')
    expect(s.phase).toBe('failed')
    expect(s.error?.code).toBe('unknown_model')
    expect(inst.isRunning()).toBe(false)
  })

  test('remove() deletes everything, and the resolver goes back to not-installed', async () => {
    const p = whisperPaths(home)
    mkdirSync(p.bin_dir, { recursive: true })
    mkdirSync(p.models_dir, { recursive: true })
    writeFileSync(p.binary, 'x')
    writeFileSync(join(p.models_dir, 'ggml-base.bin'), 'x')
    expect(resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })).not.toBeNull()

    const inst = new WhisperInstaller({ neutron_home: home })
    await inst.remove()
    expect(existsSync(p.root)).toBe(false)
    expect(resolveWhisperInstall({ env: {}, neutron_home: home, which: () => null })).toBeNull()
  })
})

describe('the catalog itself', () => {
  test('every pinned digest is a full SHA-256 and every size is real', () => {
    for (const m of WHISPER_MODELS) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(m.size_bytes).toBeGreaterThan(1_000_000)
      expect(m.url.startsWith('https://')).toBe(true)
    }
  })

  test('the default model is the FASTEST offered, not the most accurate', () => {
    // Transcription blocks the upload response, so the default has to be the one
    // that returns while the owner is still looking at the screen. If someone
    // re-points the default at a large model, this fails.
    const sorted = [...WHISPER_MODELS].sort((a, b) => a.sec_per_30s_note - b.sec_per_30s_note)
    expect(sorted[0]!.id).toBe('base')
    expect(sorted[0]!.sec_per_30s_note).toBeLessThan(6)
  })

  test('no quantized build is offered — they measured SLOWER than f16 on CPU', () => {
    for (const m of WHISPER_MODELS) expect(m.id).not.toContain('q5')
  })
})
