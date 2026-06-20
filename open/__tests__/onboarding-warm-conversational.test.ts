/**
 * Onboarding warm-conversational session + pre-warm — Step 1 of the
 * single-session onboarding rework (2026-06-17). Pins the behaviour that kills
 * the 90s-per-turn onboarding stall:
 *
 *   1. The Open composer composes the onboarding phase-spec (`cc-llm-*`)
 *      substrate as a WARM, REUSED session — NOT `ephemeral`, NO
 *      `reset_context_per_turn` (no `/clear` on the conversational path). These
 *      are exactly the two `ClaudeCodeSubstrateOptions` flags the persistent
 *      REPL substrate keys its warm-pool reuse on (proven end-to-end by
 *      `runtime/adapters/claude-code/persistent/__tests__/ephemeral-oneshot-isolation.test.ts`:
 *      a non-ephemeral substrate warm-reuses across session-less turns,
 *      `spawnCount === 1`; an ephemeral one spawns fresh per turn). Pre-rework
 *      this substrate was `ephemeral: true` → a fresh heavy `claude` session
 *      cold-spawned EVERY onboarding turn.
 *
 *   2. The composer PRE-WARMS that session at onboarding start: exactly ONE
 *      build-time warm-up dispatch fires (behind the loading indicator), NOT a
 *      per-turn cold spawn.
 *
 *   3. Session-reuse contract (the literal "factory/spawn called once across
 *      turns" assertion): driving `buildLlmCallSubstrate` with the composer's
 *      NON-ephemeral config + a warm-pool-modelling factory spawns ONCE across
 *      three session-less turns; the same wiring WITH `ephemeral: true` spawns
 *      three times — proving the composer's flag choice is what enables reuse.
 *
 * Per CLAUDE.md anti-placeholder rules these assert real wiring (the composed
 * substrate options + spawn behaviour), not phase-machine bookkeeping.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { buildLlmCallSubstrate } from '../../gateway/realmode-composer/build-llm-call-substrate.ts'
import { newCredentialPool } from '../../runtime/credential-pool.ts'
import type { Event } from '../../runtime/events.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '../../runtime/substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '../../runtime/adapters/claude-code/index.ts'
import { buildOpenGraphComposer, awaitPrewarmReady, prewarmSubstrate } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-warm-conv-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  // A credential makes resolveOpenLlmPool return a non-null pool so the
  // phase-spec substrate (and its pre-warm) are actually built.
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-warm-conversational'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

/** A canned-completion fake substrate `start()` so the pre-warm's
 *  `collectTokensToString` resolves immediately. */
function cannedHandle(instanceId: string): SessionHandle {
  const events = (async function* (): AsyncGenerator<Event, void, void> {
    yield { kind: 'token', text: 'ready' }
    yield {
      kind: 'completion',
      usage: { input_tokens: 1, output_tokens: 1 },
      substrate_instance_id: instanceId,
    }
  })()
  return {
    events,
    async respondToTool(): Promise<void> {},
    async cancel(): Promise<void> {},
    tool_resolution: 'internal',
  }
}

/**
 * Boot the REAL Open composition the way `gateway/index.ts:boot` does, with a
 * capturing fake `substrateFactory`, run `assert(capturedOpts)`, then tear the
 * whole graph + sweeper + db down (the open-import-upload-wiring pattern) so no
 * background timer leaks into a sibling test file under happy-dom.
 */
async function bootAndCapture(
  assert: (captured: ClaudeCodeSubstrateOptions[]) => void,
): Promise<void> {
  const captured: ClaudeCodeSubstrateOptions[] = []
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
    captured.push(opts)
    return { start: () => cannedHandle(opts.substrate_instance_id) }
  }
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  try {
    // Let the fire-and-forget pre-warm dispatch flush.
    await Bun.sleep(20)
    assert(captured)
  } finally {
    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
    await graph.shutdown()
    db.close()
  }
}

describe('Open onboarding — warm conversational phase-spec substrate', () => {
  test('the phase-spec (cc-llm-*) substrate is composed NON-ephemeral, with NO per-turn /clear', async () => {
    await bootAndCapture((captured) => {
      // The pre-warm dispatched through the phase-spec substrate at build —
      // exactly the `cc-llm-*` instance, and exactly ONCE (one build-time
      // warm-up spawn, NOT a per-turn cold spawn).
      const phaseSpecOpts = captured.filter((o) =>
        o.substrate_instance_id.startsWith('cc-llm-'),
      )
      expect(phaseSpecOpts.length).toBe(1)
      const opts = phaseSpecOpts[0]!

      // THE fix: not ephemeral → the persistent substrate warm-reuses the
      // session across turns instead of cold-spawning a fresh REPL per turn.
      expect(opts.ephemeral).not.toBe(true)
      // No `/clear` on the conversational path — context is allowed to
      // accumulate across the onboarding conversation (that's desired).
      expect(opts.reset_context_per_turn).not.toBe(true)
      // Headless REPL must skip interactive permission prompts (mirrors the
      // live-agent substrate).
      expect(opts.skip_permissions).toBe(true)
    })
  }, 30_000)

  test('no ephemeral disposable cold-spawn fires at onboarding start (the per-turn path is gone)', async () => {
    await bootAndCapture((captured) => {
      // No substrate was dispatched at build with `ephemeral: true` — the
      // per-turn disposable cold-spawn path that caused the 90s stall is gone
      // from the onboarding conversational path.
      const ephemeralSpawns = captured.filter((o) => o.ephemeral === true)
      expect(ephemeralSpawns.length).toBe(0)
    })
  }, 30_000)
})

/**
 * A factory that MODELS the persistent REPL substrate's warm-pool contract so
 * the composer's flag choice can be tied directly to the spawn/reuse outcome:
 *   - non-ephemeral session-less dispatch → spawn ONCE per pool key, reuse after;
 *   - ephemeral session-less dispatch     → a fresh disposable spawn every turn.
 * `buildLlmCallSubstrate` calls `factory(opts)` per `start()`, so the spawn
 * dedup lives in the shared outer state keyed by the same dimensions the real
 * substrate keys on.
 */
function makeWarmPoolModelFactory(): {
  factory: (opts: ClaudeCodeSubstrateOptions) => Substrate
  spawnCount: () => number
} {
  let spawns = 0
  const pool = new Set<string>()
  const factory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start(spec: AgentSpec): SessionHandle {
      const sessionLess = spec.session === undefined
      const key = [
        opts.substrate_instance_id,
        opts.user_id ?? '_platform',
        opts.project_id ?? 'default',
        opts.credential_identity ?? '',
      ].join('|')
      if (opts.ephemeral === true && sessionLess) {
        spawns += 1 // fresh disposable REPL, terminated after this turn
      } else if (!pool.has(key)) {
        pool.add(key)
        spawns += 1 // first turn for this warm pool key
      }
      return cannedHandle(opts.substrate_instance_id)
    },
  })
  return { factory, spawnCount: () => spawns }
}

async function drainSessionLessTurn(substrate: Substrate, prompt: string): Promise<void> {
  const spec: AgentSpec = { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
  const handle = substrate.start(spec)
  for await (const ev of handle.events) {
    if (ev.kind === 'completion' || ev.kind === 'error') break
  }
}

describe('awaitPrewarmReady — bounded first-turn gate (2026-06-18 cold-spawn fix)', () => {
  test('resolves as soon as the pre-warm settles (no needless wait)', async () => {
    const start = Date.now()
    await awaitPrewarmReady(Bun.sleep(10).then(() => undefined), {
      NEUTRON_PREWARM_AWAIT_CAP_MS: '5000',
    } as unknown as NodeJS.ProcessEnv)
    // Returned on the prewarm (~10ms), nowhere near the 5s cap.
    expect(Date.now() - start).toBeLessThan(2000)
  })

  test('a hanging pre-warm resolves at the cap (never blocks forever)', async () => {
    const start = Date.now()
    const neverSettles = new Promise<void>(() => {})
    await awaitPrewarmReady(neverSettles, {
      NEUTRON_PREWARM_AWAIT_CAP_MS: '60',
    } as unknown as NodeJS.ProcessEnv)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(55)
    expect(elapsed).toBeLessThan(2000)
  })

  test('prewarmSubstrate returns a never-rejecting promise even when start() throws', async () => {
    const throwingSubstrate: Substrate = {
      start(): SessionHandle {
        throw new Error('spawn boom')
      },
    }
    // Must resolve (not reject) so the awaiter can rely on it settling.
    await expect(prewarmSubstrate(throwingSubstrate)).resolves.toBeUndefined()
  })
})

describe('phase-spec substrate session reuse contract (warm vs ephemeral)', () => {
  const pool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'cred-1', kind: 'api_key', secret: 'sk-test' }],
  })

  test('WARM (composer config — no ephemeral): one spawn across three session-less turns', async () => {
    const { factory, spawnCount } = makeWarmPoolModelFactory()
    // EXACTLY the options the Open composer now builds the phase-spec substrate
    // with — no `ephemeral`, no `reset_context_per_turn`.
    const substrate = buildLlmCallSubstrate({
      pool,
      substrate_instance_id: 'cc-llm-owner',
      user_id: 'owner',
      project_slug: 'owner',
      skip_permissions: true,
      substrateFactory: factory,
    })!
    await drainSessionLessTurn(substrate, 'turn-1')
    await drainSessionLessTurn(substrate, 'turn-2')
    await drainSessionLessTurn(substrate, 'turn-3')
    // No new spawn on turn 2+ — the conversation rides ONE warm session.
    expect(spawnCount()).toBe(1)
  })

  test('EPHEMERAL (the old onboarding config): a fresh spawn EVERY turn (the 90s-stall cause)', async () => {
    const { factory, spawnCount } = makeWarmPoolModelFactory()
    const substrate = buildLlmCallSubstrate({
      pool,
      substrate_instance_id: 'cc-llm-owner',
      user_id: 'owner',
      project_slug: 'owner',
      skip_permissions: true,
      ephemeral: true,
      substrateFactory: factory,
    })!
    await drainSessionLessTurn(substrate, 'turn-1')
    await drainSessionLessTurn(substrate, 'turn-2')
    await drainSessionLessTurn(substrate, 'turn-3')
    // The pre-rework path: a fresh disposable cold spawn per onboarding turn.
    expect(spawnCount()).toBe(3)
  })
})
