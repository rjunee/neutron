/**
 * ND1 — `ensureBrainInitialized` unit tests (injected runner, no real binary).
 *
 * Pins the init-guard policy that fixes the dead-memory bug (prod spawned
 * `gbrain serve` against a brain that was never `gbrain init`'d → "No brain
 * configured" → Connection closed → every memory op silently no-op'd):
 *
 *   - FRESH brain → runs `gbrain init --pglite` exactly once, embeddings-ready.
 *   - IDEMPOTENT → a second call (config.json now present) does NOT re-init.
 *   - NO embedder → still inits an OpenAI-ready column (3072) so a later key
 *     upgrades in place (a 1280-dim `--no-embedding` brain could not).
 *   - WITH embedder → inits against that provider's model + dims, and backfills
 *     pre-existing pages once (marker-gated) when a provider key is present.
 *   - binary-missing / init-failure → returns a status, never throws.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureBrainInitialized, brainConfigPath } from '../ensure-brain-init.ts'
import { buildOpenAiEmbedderConfig } from '../embedder-config.ts'
import type { CommandRunner, CommandResult } from '../gbrain-doctor.ts'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-init-test-'))
}

const silentLogger = { warn: () => {}, info: () => {} }

interface RecordedCall {
  cmd: string
  args: string[]
  env?: Record<string, string>
}

/**
 * A fake `gbrain` that records its invocations. On `init` it writes a
 * config.json under `<GBRAIN_HOME>/.gbrain/` so the idempotency check (which
 * reads that file) behaves exactly as the real binary would.
 */
function fakeRunner(opts?: {
  initCode?: number
  embedCode?: number
  throwOnInit?: Error
}): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const runner: CommandRunner = {
    async run(cmd, args, runOpts): Promise<CommandResult> {
      calls.push({ cmd, args, ...(runOpts?.env ? { env: runOpts.env } : {}) })
      if (args[0] === 'init') {
        if (opts?.throwOnInit) throw opts.throwOnInit
        const code = opts?.initCode ?? 0
        if (code === 0) {
          const home = runOpts?.env?.['GBRAIN_HOME']
          if (home) {
            mkdirSync(join(home, '.gbrain'), { recursive: true })
            writeFileSync(brainConfigPath(home), JSON.stringify({ engine: 'pglite' }))
          }
        }
        return { code, stdout: '', stderr: code === 0 ? '' : 'init boom' }
      }
      if (args[0] === 'embed') {
        return { code: opts?.embedCode ?? 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  return { runner, calls }
}

describe('ensureBrainInitialized', () => {
  test('fresh brain → runs init once, embeddings-ready (3072) when no embedder', async () => {
    const home = tempHome()
    const { runner, calls } = fakeRunner()
    const res = await ensureBrainInitialized({
      gbrainHome: home,
      embedder: null,
      runner,
      logger: silentLogger,
    })
    expect(res.status).toBe('initialized')
    expect(calls).toHaveLength(1)
    const initArgs = calls[0]!.args
    expect(initArgs).toContain('init')
    expect(initArgs).toContain('--pglite')
    expect(initArgs).toContain('--non-interactive')
    // Embeddings-ready column even with no key → a later OpenAI key upgrades in
    // place (OpenAI rejects the 1280-dim `--no-embedding` default column).
    expect(initArgs).toContain('--embedding-model')
    expect(initArgs).toContain('openai:text-embedding-3-large')
    expect(initArgs).toContain('--embedding-dimensions')
    expect(initArgs).toContain('3072')
    expect(initArgs).not.toContain('--no-embedding')
    expect(existsSync(brainConfigPath(home))).toBe(true)
  })

  test('idempotent → already-initialized brain is NOT re-init`d', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), JSON.stringify({ engine: 'pglite' }))
    const { runner, calls } = fakeRunner()
    const res = await ensureBrainInitialized({
      gbrainHome: home,
      embedder: null,
      runner,
      logger: silentLogger,
    })
    expect(res.status).toBe('already-initialized')
    expect(calls).toHaveLength(0)
  })

  test('explicit embedder → inits against that provider model + dims', async () => {
    const home = tempHome()
    const { runner, calls } = fakeRunner()
    const embedder = buildOpenAiEmbedderConfig('sk-test-123')
    await ensureBrainInitialized({ gbrainHome: home, embedder, runner, logger: silentLogger })
    const initArgs = calls[0]!.args
    expect(initArgs).toContain(embedder.model)
    expect(initArgs).toContain(String(embedder.dimensions))
    // Provider auth is forwarded to the child so embed-on-write can reach it.
    expect(calls[0]!.env?.['OPENAI_API_KEY']).toBe('sk-test-123')
  })

  test('already-init + provider key present → one-time embed backfill (marker-gated)', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), JSON.stringify({ engine: 'pglite' }))
    const embedder = buildOpenAiEmbedderConfig('sk-test-123')

    const first = fakeRunner()
    const r1 = await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner: first.runner,
      logger: silentLogger,
    })
    expect(r1.status).toBe('embeddings-backfilled')
    expect(first.calls.map((c) => c.args[0])).toEqual(['embed'])
    expect(first.calls[0]!.args).toContain('--stale')

    // Second call: marker present → no second backfill scan.
    const second = fakeRunner()
    const r2 = await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner: second.runner,
      logger: silentLogger,
    })
    expect(r2.status).toBe('already-initialized')
    expect(second.calls).toHaveLength(0)
  })

  test('init failure → returns init-failed, never throws', async () => {
    const home = tempHome()
    const { runner } = fakeRunner({ initCode: 1 })
    const res = await ensureBrainInitialized({
      gbrainHome: home,
      embedder: null,
      runner,
      logger: silentLogger,
    })
    expect(res.status).toBe('init-failed')
    expect(existsSync(brainConfigPath(home))).toBe(false)
  })

  test('binary missing (spawn throws) → returns binary-missing, never throws', async () => {
    const home = tempHome()
    const { runner } = fakeRunner({
      throwOnInit: new Error('Executable not found in $PATH: gbrain'),
    })
    const res = await ensureBrainInitialized({
      gbrainHome: home,
      embedder: null,
      runner,
      logger: silentLogger,
    })
    expect(res.status).toBe('binary-missing')
  })
})
