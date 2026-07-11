/**
 * ND1 — `ensureBrainInitialized` unit tests (injected runner, no real binary).
 *
 * Pins the init-guard policy that fixes the dead-memory bug (prod spawned
 * `gbrain serve` against a brain that was never `gbrain init`'d → "No brain
 * configured" → Connection closed → every memory op silently no-op'd):
 *
 *   - FRESH brain → runs `gbrain init --pglite` exactly once, embeddings-ready.
 *   - IDEMPOTENT → a second call (config.json now present) does NOT re-init.
 *   - NO embedder (explicit `off`) → still inits an OpenAI-ready column at the
 *     universal 768-dim width so a later key upgrades in place at the SAME
 *     width (a 1280-dim `--no-embedding` brain could not).
 *   - WITH embedder → inits against that provider's model + dims, and backfills
 *     pre-existing pages once (marker-gated) when a provider key is present.
 *   - binary-missing / init-failure → returns a status, never throws.
 *
 * RA3 (2026-07) adds: a fail-soft, advisory-only Ollama reachability probe —
 * NEVER gates the embedder/column choice (already fixed by the caller), only
 * logs a degradation warning (unreachable / model not pulled) or a healthy
 * confirmation. See `probeOllamaHealth` tests below.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureBrainInitialized,
  brainConfigPath,
  readPersistedEmbeddingDims,
  resolveExistingBrainWidth,
} from '../ensure-brain-init.ts'
import { buildOpenAiEmbedderConfig, resolveEmbedderConfig } from '../embedder-config.ts'
import type { OllamaHealthCheck } from '../embedder-config.ts'
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
  /**
   * stdout the fake `gbrain embed --stale` emits. The real binary prints
   * `Embedded N chunks across M pages` (or `Embedded 0 chunks (0 stale found)`);
   * `ensureBrainInitialized` parses the N to label backfill-happened vs no-op.
   * Default: a nonzero count (the common "backfill ran" case). Pass an
   * `Embedded 0` line for the steady-state / no-op assertions.
   */
  embedStdout?: string
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
        const code = opts?.embedCode ?? 0
        const stdout = opts?.embedStdout ?? 'Embedded 2 chunks across 1 pages'
        return { code, stdout: code === 0 ? stdout : '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  return { runner, calls }
}

/** A fake `gbrain embed` that reports a clean no-op stale scan (nothing stale). */
const NOOP_EMBED_STDOUT = 'Embedded 0 chunks (0 stale found)'

describe('ensureBrainInitialized', () => {
  test('fresh brain → runs init once, embeddings-ready at the universal 768 width when no embedder', async () => {
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
    // place at the SAME 768 width (the universal fresh-brain width). OpenAI's
    // text-embedding-3-large truncates to 768 via Matryoshka.
    expect(initArgs).toContain('--embedding-model')
    expect(initArgs).toContain('openai:text-embedding-3-large')
    expect(initArgs).toContain('--embedding-dimensions')
    expect(initArgs).toContain('768')
    expect(initArgs).not.toContain('3072')
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
    // `gbrain init` requires a PROVIDER-QUALIFIED model id (it refuses a bare id
    // with "missing a provider prefix"), so init must pass `provider:model`, not
    // the bare `embedder.model`.
    const qualified = 'openai:text-embedding-3-large'
    expect(embedder.childEnv['GBRAIN_EMBEDDING_MODEL']).toBe(qualified)
    expect(initArgs).toContain(qualified) // init passes the QUALIFIED id
    expect(initArgs).not.toContain(embedder.model) // never the bare id
    expect(initArgs).toContain(String(embedder.dimensions))
    // Provider auth is forwarded to the child so embed-on-write can reach it.
    expect(calls[0]!.env?.['OPENAI_API_KEY']).toBe('sk-test-123')
  })

  test('already-init + provider key present → embed --stale runs (backfills, then a cheap no-op)', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), JSON.stringify({ engine: 'pglite' }))
    const embedder = buildOpenAiEmbedderConfig('sk-test-123')

    // First connect: pages are stale → embed --stale backfills them.
    const first = fakeRunner({ embedStdout: 'Embedded 4 chunks across 2 pages' })
    const r1 = await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner: first.runner,
      logger: silentLogger,
    })
    expect(r1.status).toBe('embeddings-backfilled')
    expect(first.calls.map((c) => c.args[0])).toEqual(['embed'])
    expect(first.calls[0]!.args).toContain('--stale')

    // Second connect SAME model, nothing stale now: embed --stale STILL runs
    // (unconditional — it is the safety net for outage orphans) but is a cheap
    // no-op scan, so the status reports steady state.
    const second = fakeRunner({ embedStdout: NOOP_EMBED_STDOUT })
    const r2 = await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner: second.runner,
      logger: silentLogger,
    })
    expect(r2.status).toBe('already-initialized')
    expect(second.calls.map((c) => c.args[0])).toEqual(['embed']) // scan ran…
    expect(second.calls[0]!.args).toContain('--stale') // …and it was a --stale scan
  })

  test('provider SWITCH (openai → ollama → openai) re-embeds each time; steady state is a cheap no-op scan', async () => {
    // RA3: the same 768-dim column can hold BOTH openai and ollama vectors —
    // numerically compatible, semantically distinct. On a provider switch gbrain
    // NULLs the prior-signature vectors (via its OWN per-page embedding_signature)
    // and the unconditional `embed --stale` re-embeds them into the new space —
    // convergence no longer depends on our marker. When nothing changed, the
    // same `--stale` scan runs but finds nothing stale (a cheap no-op).
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), JSON.stringify({ engine: 'pglite' }))
    const openai = buildOpenAiEmbedderConfig('sk-test-123') // openai:text-embedding-3-large
    const ollama = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'ollama' })! // ollama:nomic-embed-text @ 768

    // 1) OpenAI: backfill runs (stale chunks embedded), marker → openai.
    const a = fakeRunner({ embedStdout: 'Embedded 3 chunks across 2 pages' })
    const r1 = await ensureBrainInitialized({ gbrainHome: home, embedder: openai, runner: a.runner, logger: silentLogger })
    expect(r1.status).toBe('embeddings-backfilled')
    expect(a.calls.map((c) => c.args[0])).toEqual(['embed'])

    // 2) Ollama: switch → gbrain invalidates the openai vectors → --stale re-embeds them.
    const b = fakeRunner({ embedStdout: 'Embedded 3 chunks across 2 pages' })
    const r2 = await ensureBrainInitialized({ gbrainHome: home, embedder: ollama, runner: b.runner, logger: silentLogger })
    expect(r2.status).toBe('embeddings-backfilled')
    expect(b.calls.map((c) => c.args[0])).toEqual(['embed'])

    // 3) OpenAI again: switch back → re-embed (ollama vectors → openai space).
    const c = fakeRunner({ embedStdout: 'Embedded 3 chunks across 2 pages' })
    const r3 = await ensureBrainInitialized({ gbrainHome: home, embedder: openai, runner: c.runner, logger: silentLogger })
    expect(r3.status).toBe('embeddings-backfilled')
    expect(c.calls.map((cc) => cc.args[0])).toEqual(['embed'])

    // 4) OpenAI once more, unchanged, nothing stale → --stale STILL runs (it is
    //    unconditional) but is a cheap no-op scan → steady-state status.
    const d = fakeRunner({ embedStdout: NOOP_EMBED_STDOUT })
    const r4 = await ensureBrainInitialized({ gbrainHome: home, embedder: openai, runner: d.runner, logger: silentLogger })
    expect(r4.status).toBe('already-initialized')
    expect(d.calls.map((dd) => dd.args[0])).toEqual(['embed']) // scan ran, but no-op
  })

  test('a fresh init records the model marker; a later same-model boot runs a cheap no-op stale scan', async () => {
    const home = tempHome()
    const embedder = buildOpenAiEmbedderConfig('sk-test-123')
    // Fresh init (no config yet) writes the marker; a fresh brain has no pages,
    // so init runs but NO embed call at init time.
    const first = fakeRunner()
    const r1 = await ensureBrainInitialized({ gbrainHome: home, embedder, runner: first.runner, logger: silentLogger })
    expect(r1.status).toBe('initialized')
    expect(first.calls.map((c) => c.args[0])).toEqual(['init']) // NOT ['init','embed']

    // Next boot, same model, brain now initialized, nothing stale → `embed
    // --stale` runs UNCONDITIONALLY (the outage-orphan safety net) but is a cheap
    // no-op scan.
    const second = fakeRunner({ embedStdout: NOOP_EMBED_STDOUT })
    const r2 = await ensureBrainInitialized({ gbrainHome: home, embedder, runner: second.runner, logger: silentLogger })
    expect(r2.status).toBe('already-initialized')
    expect(second.calls.map((c) => c.args[0])).toEqual(['embed'])
    expect(second.calls[0]!.args).toContain('--stale')
  })

  // The internal marker filename (stable path contract).
  const markerFile = (home: string) => join(home, '.gbrain', '.neutron-embeddings-backfilled')

  test('init-time Ollama OUTAGE → no marker written → healthy reconnect BACKFILLS (auto-upgrade)', async () => {
    // The marker must mean "backfill completed under this model", NOT "init ran".
    // If a local Ollama embedder is down at init, pages written during the outage
    // have no vectors; writing the marker anyway would make the recovery
    // reconnect skip `embed --stale` and orphan them forever.
    const home = tempHome()
    const embedder = resolveEmbedderConfig({})! // RA3 default: local Ollama fallback

    // 1) Fresh init while Ollama is DOWN.
    const down = fakeRunner()
    const r1 = await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner: down.runner,
      logger: silentLogger,
      probeOllamaHealth: async (): Promise<OllamaHealthCheck> => ({ reachable: false, modelPresent: false }),
    })
    expect(r1.status).toBe('initialized')
    expect(down.calls.map((c) => c.args[0])).toEqual(['init'])
    // Crucially: NO marker written during the outage.
    expect(existsSync(markerFile(home))).toBe(false)

    // 2) (Pages get written during the outage — no vectors, Ollama down.)

    // 3) Recovery: Ollama healthy now, SAME embedder, brain already initialized.
    const up = fakeRunner()
    const r2 = await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner: up.runner,
      logger: silentLogger,
      probeOllamaHealth: async (): Promise<OllamaHealthCheck> => ({ reachable: true, modelPresent: true }),
    })
    // `embed --stale` IS invoked (it runs on every reconnect), so the
    // outage-written pages get vectors — the recovery promise holds.
    expect(r2.status).toBe('embeddings-backfilled')
    expect(up.calls.map((c) => c.args[0])).toEqual(['embed'])
    expect(up.calls[0]!.args).toContain('--stale')
    // NOW the marker is recorded (backfill genuinely completed).
    expect(existsSync(markerFile(home))).toBe(true)
  })

  // (d) HEALTHY steady-state reconnect with nothing stale: `embed --stale` STILL
  // runs (it is unconditional — the outage-orphan safety net) but is a cheap
  // no-op scan. The OLD marker-gate skipped this scan entirely; that skip was
  // the bug (it also skipped genuinely-orphaned pages), so the scan running here
  // is the intended, correct behavior.
  test('HEALTHY Ollama fresh init → marker written → same-model reconnect runs a no-op --stale scan', async () => {
    const home = tempHome()
    const embedder = resolveEmbedderConfig({})! // ollama
    const healthy = async (): Promise<OllamaHealthCheck> => ({ reachable: true, modelPresent: true })

    const first = fakeRunner()
    const r1 = await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner: first.runner,
      logger: silentLogger,
      probeOllamaHealth: healthy,
    })
    expect(r1.status).toBe('initialized')
    expect(first.calls.map((c) => c.args[0])).toEqual(['init']) // no embed at fresh init
    expect(existsSync(markerFile(home))).toBe(true) // healthy → marker recorded

    // Steady state: same model, healthy, nothing stale → `--stale` runs but is a no-op.
    const second = fakeRunner({ embedStdout: NOOP_EMBED_STDOUT })
    const r2 = await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner: second.runner,
      logger: silentLogger,
      probeOllamaHealth: healthy,
    })
    expect(r2.status).toBe('already-initialized')
    expect(second.calls.map((c) => c.args[0])).toEqual(['embed']) // scan ran…
    expect(second.calls[0]!.args).toContain('--stale') // …but found nothing stale
  })

  // (a) THE ROOT-CAUSE FIX — healthy init writes the marker, THEN a mid-life
  // outage orphans pages (embedding IS NULL) while the marker still matches the
  // current model. On reconnect the marker MATCHES, yet `embed --stale` MUST
  // still run and backfill those pages. Under the old `markerModel !==
  // currentModel` gate this was SKIPPED → permanent orphans. Mutation guard:
  // re-introducing the marker gate makes this fail (embed would not be called).
  test('healthy init (marker written) → mid-life outage orphans pages → reconnect BACKFILLS despite matching marker', async () => {
    const home = tempHome()
    const embedder = resolveEmbedderConfig({})! // ollama:nomic-embed-text
    const healthy = async (): Promise<OllamaHealthCheck> => ({ reachable: true, modelPresent: true })

    // 1) Healthy fresh init → marker written (== current ollama model).
    const init = fakeRunner()
    await ensureBrainInitialized({
      gbrainHome: home, embedder, runner: init.runner, logger: silentLogger, probeOllamaHealth: healthy,
    })
    expect(existsSync(markerFile(home))).toBe(true)

    // 2) (Ollama briefly went DOWN; pages written meanwhile have NULL embeddings.)

    // 3) Reconnect, Ollama healthy again, SAME model → marker STILL matches. The
    //    stale scan finds the orphaned NULL-embedding chunks and backfills them.
    const recover = fakeRunner({ embedStdout: 'Embedded 5 chunks across 3 pages' })
    const r = await ensureBrainInitialized({
      gbrainHome: home, embedder, runner: recover.runner, logger: silentLogger, skipOllamaProbe: true,
    })
    expect(r.status).toBe('embeddings-backfilled') // NOT skipped despite matching marker
    expect(recover.calls.map((c) => c.args[0])).toEqual(['embed'])
    expect(recover.calls[0]!.args).toContain('--stale')
    // Marker still present (re-stamped under the same model).
    expect(existsSync(markerFile(home))).toBe(true)
  })

  // (b) Same root-cause, OpenAI provider: a transient embed failure after a
  // healthy init leaves some chunks NULL; the next reconnect (same OpenAI model,
  // matching marker) re-runs `--stale` and backfills them.
  test('OpenAI: healthy init → transient outage orphans pages → reconnect BACKFILLS despite matching marker', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), JSON.stringify({ engine: 'pglite' }))
    const embedder = buildOpenAiEmbedderConfig('sk-test-123')

    // 1) First connect: backfill runs, marker → openai.
    const first = fakeRunner({ embedStdout: 'Embedded 2 chunks across 1 pages' })
    await ensureBrainInitialized({ gbrainHome: home, embedder, runner: first.runner, logger: silentLogger })
    expect(existsSync(markerFile(home))).toBe(true)

    // 2) (A transient provider outage left some newly-written chunks NULL.)

    // 3) Reconnect, SAME openai model → marker matches, yet `--stale` re-runs and
    //    backfills the orphaned chunks.
    const recover = fakeRunner({ embedStdout: 'Embedded 4 chunks across 2 pages' })
    const r = await ensureBrainInitialized({ gbrainHome: home, embedder, runner: recover.runner, logger: silentLogger })
    expect(r.status).toBe('embeddings-backfilled')
    expect(recover.calls.map((c) => c.args[0])).toEqual(['embed'])
    expect(recover.calls[0]!.args).toContain('--stale')
  })

  // (c) A genuine model/provider change still triggers a re-embed (openai →
  // ollama): the unconditional `--stale` runs, and gbrain's own per-page
  // signature invalidation converges the vector space.
  test('genuine model change (openai → ollama) triggers a re-embed via unconditional --stale', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), JSON.stringify({ engine: 'pglite' }))
    const openai = buildOpenAiEmbedderConfig('sk-test-123')
    const ollama = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'ollama' })!

    const a = fakeRunner({ embedStdout: 'Embedded 3 chunks across 2 pages' })
    await ensureBrainInitialized({ gbrainHome: home, embedder: openai, runner: a.runner, logger: silentLogger })

    // Switch to ollama → gbrain invalidates the openai-signature vectors, `--stale`
    // re-embeds them into the ollama space.
    const b = fakeRunner({ embedStdout: 'Embedded 3 chunks across 2 pages' })
    const r = await ensureBrainInitialized({ gbrainHome: home, embedder: ollama, runner: b.runner, logger: silentLogger })
    expect(r.status).toBe('embeddings-backfilled')
    expect(b.calls.map((c) => c.args[0])).toEqual(['embed'])
    expect(b.calls[0]!.args).toContain('--stale')
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

// RA3 — persisted column-width reader (cross-version reconciliation input).
describe('readPersistedEmbeddingDims', () => {
  test('reads embedding_dimensions from an existing config.json', () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(
      brainConfigPath(home),
      JSON.stringify({ engine: 'pglite', embedding_dimensions: 3072 }),
    )
    expect(readPersistedEmbeddingDims(home)).toBe(3072)
  })

  test('no config.json (fresh brain) → null', () => {
    const home = tempHome()
    expect(readPersistedEmbeddingDims(home)).toBeNull()
  })

  test('config.json without embedding_dimensions → null', () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), JSON.stringify({ engine: 'pglite' }))
    expect(readPersistedEmbeddingDims(home)).toBeNull()
  })

  test('malformed config.json → null (never throws)', () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), 'not json{')
    expect(readPersistedEmbeddingDims(home)).toBeNull()
  })
})

// RA3 — three-state width resolver: FRESH vs KNOWN vs initialized-but-UNKNOWN.
// The distinction is the Codex-flagged guard: an initialized brain whose width
// can't be read must NOT be misclassified as fresh (which would inject 768).
describe('resolveExistingBrainWidth', () => {
  test('no config.json (truly fresh) → null', () => {
    const home = tempHome()
    expect(resolveExistingBrainWidth(home)).toBeNull()
  })

  test('config with a valid embedding_dimensions → that number', () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), JSON.stringify({ embedding_dimensions: 3072 }))
    expect(resolveExistingBrainWidth(home)).toBe(3072)
  })

  test('initialized brain WITHOUT embedding_dimensions → "unknown" (NOT null/fresh)', () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), JSON.stringify({ engine: 'pglite' }))
    expect(resolveExistingBrainWidth(home)).toBe('unknown')
  })

  test('initialized brain with a MALFORMED config → "unknown" (NOT null/fresh)', () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), 'not json{')
    expect(resolveExistingBrainWidth(home)).toBe('unknown')
  })

  test('a --no-embedding brain (embedding_disabled, no dims) → "unknown"', () => {
    const home = tempHome()
    mkdirSync(join(home, '.gbrain'), { recursive: true })
    writeFileSync(brainConfigPath(home), JSON.stringify({ embedding_disabled: true }))
    expect(resolveExistingBrainWidth(home)).toBe('unknown')
  })
})

// RA3 — Ollama reachability probe (advisory-only, fail-soft).
describe('ensureBrainInitialized — Ollama reachability probe (RA3)', () => {
  function capturingLogger(): {
    logger: { warn: (m: string) => void; info: (m: string) => void }
    warnings: string[]
    infos: string[]
  } {
    const warnings: string[] = []
    const infos: string[] = []
    return {
      logger: {
        warn: (m: string) => warnings.push(m),
        info: (m: string) => infos.push(m),
      },
      warnings,
      infos,
    }
  }

  test('fresh install, no key → the DEFAULT embedder is the local Ollama fallback', () => {
    // Pins the RA3 default end-to-end: resolveEmbedderConfig({}) (a fresh
    // install with no env at all) is exactly the embedder ensureBrainInitialized
    // gets handed in production.
    const embedder = resolveEmbedderConfig({})
    expect(embedder?.provider).toBe('ollama')
  })

  test('Ollama unreachable → init still succeeds, but a degradation warning fires', async () => {
    const home = tempHome()
    const { runner, calls } = fakeRunner()
    const embedder = resolveEmbedderConfig({})! // the RA3 default: local Ollama fallback
    const { logger, warnings } = capturingLogger()
    const probe = async (): Promise<OllamaHealthCheck> => ({ reachable: false, modelPresent: false })

    const res = await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner,
      logger,
      probeOllamaHealth: probe,
    })

    // Fail-soft: init still succeeds (column created at Ollama's dims) even
    // though Ollama itself isn't reachable right now — GBrain's own
    // hybridSearch degrades a failed per-query embed to keyword-only.
    expect(res.status).toBe('initialized')
    expect(calls).toHaveLength(1)
    const initArgs = calls[0]!.args
    // Provider-qualified model id (gbrain init refuses a bare `nomic-embed-text`).
    expect(initArgs).toContain('ollama:nomic-embed-text')
    expect(initArgs).toContain('768')
    // The degradation is SURFACED, not silent.
    expect(warnings.some((w) => w.includes('not reachable'))).toBe(true)
    expect(warnings.some((w) => w.includes('keyword+graph'))).toBe(true)
    // ...and it is HONEST about the per-spawn cadence: outage-written pages
    // backfill on the next reconnect/restart, NOT mid-session. The warning must
    // NOT overpromise a mid-session auto-upgrade ("no restart needed").
    const joined = warnings.join('\n')
    expect(joined).toContain('reconnect/restart')
    expect(joined).not.toContain('no restart needed')
  })

  test('Ollama reachable but nomic-embed-text not pulled → a different, specific warning', async () => {
    const home = tempHome()
    const { runner } = fakeRunner()
    const embedder = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'ollama' })!
    const { logger, warnings } = capturingLogger()
    const probe = async (): Promise<OllamaHealthCheck> => ({ reachable: true, modelPresent: false })

    await ensureBrainInitialized({ gbrainHome: home, embedder, runner, logger, probeOllamaHealth: probe })

    expect(warnings.some((w) => w.includes('is not pulled'))).toBe(true)
    expect(warnings.some((w) => w.includes('ollama pull nomic-embed-text'))).toBe(true)
  })

  test('Ollama healthy (reachable + model present) → an info confirmation, no warning', async () => {
    const home = tempHome()
    const { runner } = fakeRunner()
    const embedder = resolveEmbedderConfig({})!
    const { logger, warnings, infos } = capturingLogger()
    const probe = async (): Promise<OllamaHealthCheck> => ({ reachable: true, modelPresent: true })

    await ensureBrainInitialized({ gbrainHome: home, embedder, runner, logger, probeOllamaHealth: probe })

    expect(warnings).toHaveLength(0)
    expect(infos.some((m) => m.includes('healthy') && m.includes('semantic recall active'))).toBe(true)
  })

  test('no embedder (explicit off) → the probe is never consulted', async () => {
    const home = tempHome()
    const { runner } = fakeRunner()
    let probeCalls = 0
    const probe = async (): Promise<OllamaHealthCheck> => {
      probeCalls += 1
      return { reachable: true, modelPresent: true }
    }

    await ensureBrainInitialized({
      gbrainHome: home,
      embedder: null,
      runner,
      logger: silentLogger,
      probeOllamaHealth: probe,
    })

    expect(probeCalls).toBe(0)
  })

  test('openai embedder → the Ollama probe is never consulted', async () => {
    const home = tempHome()
    const { runner } = fakeRunner()
    const embedder = buildOpenAiEmbedderConfig('sk-test-123', 3072)
    let probeCalls = 0
    const probe = async (): Promise<OllamaHealthCheck> => {
      probeCalls += 1
      return { reachable: true, modelPresent: true }
    }

    await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner,
      logger: silentLogger,
      probeOllamaHealth: probe,
    })

    expect(probeCalls).toBe(0)
  })

  test('skipOllamaProbe → the probe (and its log) is suppressed (once-per-client boot cadence)', async () => {
    const home = tempHome()
    const { runner } = fakeRunner()
    const embedder = resolveEmbedderConfig({})! // ollama fallback
    const { logger, warnings } = capturingLogger()
    let probeCalls = 0
    const probe = async (): Promise<OllamaHealthCheck> => {
      probeCalls += 1
      return { reachable: false, modelPresent: false }
    }

    // First run: probe fires (boot signal).
    await ensureBrainInitialized({ gbrainHome: home, embedder, runner, logger, probeOllamaHealth: probe })
    expect(probeCalls).toBe(1)
    expect(warnings.some((w) => w.includes('not reachable'))).toBe(true)

    // Subsequent reconnect run with skipOllamaProbe: no probe, no extra timeout,
    // no repeated log — but the init/backfill work still runs.
    const warnings2 = capturingLogger()
    await ensureBrainInitialized({
      gbrainHome: home,
      embedder,
      runner,
      logger: warnings2.logger,
      probeOllamaHealth: probe,
      skipOllamaProbe: true,
    })
    expect(probeCalls).toBe(1) // NOT re-probed
    expect(warnings2.warnings).toHaveLength(0)
  })

  test('OLLAMA_BASE_URL credentials are REDACTED from the degradation warning', async () => {
    const home = tempHome()
    const { runner } = fakeRunner()
    // Operator put credentials in the base url.
    const embedder = resolveEmbedderConfig({
      NEUTRON_EMBEDDINGS: 'ollama',
      OLLAMA_BASE_URL: 'http://alice:secret@ollama.internal:11434/v1',
    })!
    const { logger, warnings } = capturingLogger()
    const probe = async (): Promise<OllamaHealthCheck> => ({ reachable: false, modelPresent: false })

    await ensureBrainInitialized({ gbrainHome: home, embedder, runner, logger, probeOllamaHealth: probe })

    const joined = warnings.join('\n')
    expect(joined).toContain('not reachable') // it did warn
    expect(joined).not.toContain('secret') // but NEVER logs the credential
    expect(joined).not.toContain('alice')
    expect(joined).toContain('ollama.internal') // host is still shown for diagnosis
  })
})
