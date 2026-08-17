/**
 * REGRESSION — a fired reminder must NEVER disturb the owner's chat session.
 *
 * THE INCIDENT (live instance, 2026-08-17). Three consecutive journal lines:
 *
 *   [reminder-dispatcher] event=nudge_degraded route=compose_failed
 *       reason="SubstrateCallError: cc-llm-call: aborted"
 *   [repl] evicting abandon-poisoned warm session=… key-respawn
 *       (prior turn abandoned before reply; clean respawn for the next turn)
 *   [live-agent-turn] event=turn_failed error="cc-llm-call: persistent-repl: REPL
 *       process exited"
 *
 * …after which the owner could not send a single chat message until the service
 * was restarted. One background compose aborted and took his session with it.
 *
 * THE MECHANISM, and why it could only ever be fixed by separating the sessions:
 *   - the fire-time composer drains with an abort signal, and that drain cancels
 *     the handle when the signal fires (`runtime/collect-tokens.ts`,
 *     `keepAliveExempt: true`);
 *   - cancelling an UNSETTLED turn poisons the warm session
 *     (`runtime/adapters/claude-code/persistent/pool.ts:678`);
 *   - the next dispatch on that pool key evicts and respawns the child
 *     (`runtime/adapters/claude-code/persistent/spawn.ts:862-866`);
 *   - and the pool key STARTS with `substrate_instance_id`
 *     (`persistent/pool.ts` `poolKeyFor`), so composing on `cc-agent-*` meant the
 *     poisoned session WAS the owner's chat session.
 *
 * Matching the live-chat `--tools` surface and the live-chat model (the two
 * earlier patches at that call site) could stop an eviction caused by a MISMATCH.
 * Neither could stop an eviction caused by a FAILURE. Only a distinct pool key
 * can, which is what `cc-nudge-*` is.
 *
 * These tests model the pool with the REAL `poolKeyFor` and the real poison rule,
 * so they fail the moment background composition is pointed back at `cc-agent-*`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ReminderStore } from '@neutronai/reminders/store.ts'
import {
  MAX_CONSECUTIVE_FAILURES,
  hasUsableCredential,
  newCredentialPool,
  type CredentialPool,
} from '@neutronai/runtime/credential-pool.ts'
import { buildSubstrateReminderLlm } from '@neutronai/reminders/dispatcher.ts'
import { poolKeyFor } from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import type { PersistentReplSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { githubSpawnEnvRef } from '@neutronai/gateway/wiring/substrate-profiles.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireSubstrates } from '../wiring/substrates.ts'
import { buildOpenGraphComposer } from '../composer.ts'

/** One warm child per pool key, exactly as the persistent pool holds it. */
interface WarmChild {
  /** Bumped on every respawn — a change means the owner lost his session. */
  generation: number
  poisoned: boolean
}

const keyFor = (opts: ClaudeCodeSubstrateOptions): string =>
  poolKeyFor(opts as unknown as PersistentReplSubstrateOptions)

/**
 * The subset of the persistent REPL pool this regression is about: reuse the warm
 * child for a pool key, evict + respawn it when a prior turn left it poisoned, and
 * poison it when a turn is cancelled before it settles.
 */
function warmPoolModel(): {
  acquire: (opts: ClaudeCodeSubstrateOptions) => WarmChild
  poison: (opts: ClaudeCodeSubstrateOptions) => void
} {
  const children = new Map<string, WarmChild>()
  return {
    acquire: (opts): WarmChild => {
      const key = keyFor(opts)
      const existing = children.get(key)
      if (existing !== undefined && !existing.poisoned) return existing
      const respawned: WarmChild = { generation: (existing?.generation ?? 0) + 1, poisoned: false }
      children.set(key, respawned)
      return respawned
    },
    poison: (opts): void => {
      const child = children.get(keyFor(opts))
      if (child !== undefined) child.poisoned = true
    },
  }
}

/** A turn whose prompt asks it to hang: it never settles until someone cancels. */
const HANG = 'HANG'
/**
 * A turn whose prompt asks it to fail with a cooldown the substrate can only
 * INFER — unstamped, retryable, no HTTP status, and matching none of the substrate
 * fast-paths, so `mapStatusForPoolCooldown(null, true)` guesses 429 and the LANE is
 * the only thing deciding whether that guess cools the credential.
 *
 * Deliberately NOT the incident's `persistent-repl: REPL process exited`, which
 * these tests used to carry: `detectReplProcessExited` now suppresses that message's
 * cooldown on BOTH lanes, so it can no longer distinguish them — a lane test driven
 * by it would pass no matter which lane the wiring passed, taking the mutation-kill
 * below with it. That message's own guarantee is covered in
 * `gateway/wiring/__tests__/background-lane-never-locks-out-owner.test.ts`.
 */
const INFERRED_FAIL = 'INFERRED_FAIL'

function makeCtx(): {
  ctx: OpenWiringContext
  credPool: CredentialPool
  spawnedFor: (instance_id: string) => ClaudeCodeSubstrateOptions | undefined
  spawnedForProject: (
    instance_id: string,
    project_id: string,
  ) => ClaudeCodeSubstrateOptions | undefined
} {
  const pool = warmPoolModel()
  const captured: ClaudeCodeSubstrateOptions[] = []
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
    captured.push(opts)
    return {
      start(spec: AgentSpec): SessionHandle {
        const child = pool.acquire(opts)
        let settled = false
        let releaseHang: (() => void) | undefined
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          if (spec.prompt.includes(HANG)) {
            await new Promise<void>((resolve) => {
              releaseHang = resolve
            })
            return
          }
          if (spec.prompt.includes(INFERRED_FAIL)) {
            // Retryable, UNSTAMPED, no HTTP status, no substrate fast-path — so the
            // cooldown mapper can only guess, and it guesses 429.
            yield {
              kind: 'error',
              message: 'cc-llm-call: upstream stream ended unexpectedly',
              retryable: true,
            }
            return
          }
          // The generation that served this turn — a respawn is observable as a bump.
          yield { kind: 'token', text: 'gen' + String(child.generation) }
          settled = true
          yield {
            kind: 'completion',
            usage: { input_tokens: 1, output_tokens: 1 },
            substrate_instance_id: opts.substrate_instance_id,
          }
        })()
        return {
          events,
          async respondToTool(): Promise<void> {},
          async cancel(): Promise<void> {
            // `persistent/pool.ts:678` — cancelling an UNSETTLED turn poisons the
            // warm session; a settled one is a no-op.
            if (!settled) pool.poison(opts)
            releaseHang?.()
          },
          tool_resolution: 'internal',
        }
      },
    }
  }
  // THE SINGLE-CREDENTIAL POOL EVERY OPEN INSTALL RUNS ON — held by reference so a
  // test can read the cooldown state the wired substrates actually write to.
  const credPool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'anthropic:test', kind: 'api_key', secret: 'sk-test' }],
  })
  const ctx: OpenWiringContext = {
    llmPool: credPool,
    owner_handle: 'owner',
    owner_home: '/tmp/owner-home',
    project_slug: 'owner',
    env: {} as NodeJS.ProcessEnv,
    db: {} as OpenWiringContext['db'],
    substrateFactory,
    prewarmSubstrate: async (): Promise<void> => {},
  }
  return {
    ctx,
    credPool,
    spawnedFor: (instance_id) => captured.find((o) => o.substrate_instance_id === instance_id),
    spawnedForProject: (instance_id, project_id) =>
      captured.find(
        (o) => o.substrate_instance_id === instance_id && o.project_id === project_id,
      ),
  }
}

/**
 * A spec shaped like the ones production actually dispatches.
 *
 * `metering_context.project_id` is NOT decoration: `poolKeyFor` folds `project_id`
 * into the key, and BOTH real callers set it — `reminders/dispatcher.ts` from the
 * reminder's project, `gateway/proactive/work-wakeup.ts` from the wakeup's chat
 * scope. A spec without it collapses every project onto the `'default'` key, which
 * would make the tests below agree with each other while disagreeing with
 * production on the one dimension the pool actually keys on.
 */
function specFor(prompt: string, project_id = 'project-one'): AgentSpec {
  return { prompt, tools: [], model_preference: ['sonnet'], metering_context: { project_id } }
}

/** Drive one turn to completion and return its accumulated text (`gen<N>`). */
async function turn(sub: Substrate, prompt: string, project_id = 'project-one'): Promise<string> {
  const handle = sub.start(specFor(prompt, project_id))
  let text = ''
  for await (const ev of handle.events) {
    if (ev.kind === 'token') text += ev.text
  }
  return text
}

beforeEach(() => {
  githubSpawnEnvRef.resolve = undefined
})

describe('background composition runs on its own REPL', () => {
  test('the nudge substrate does not share a pool key with the owner chat', async () => {
    const { ctx, spawnedFor } = makeCtx()
    const w = wireSubstrates(ctx)
    expect(w.reminderComposeSubstrate).not.toBeNull()
    await turn(w.liveAgentSubstrate!, 'hello')
    await turn(w.reminderComposeSubstrate!, 'compose a nudge')

    const chat = spawnedFor('cc-agent-owner')
    const nudge = spawnedFor('cc-nudge-owner')
    expect(chat).toBeDefined()
    expect(nudge).toBeDefined()
    expect(keyFor(nudge!)).not.toBe(keyFor(chat!))
    // …but it is the SAME TRUST CLASS. A ritual composes on this lane and ISSUES
    // #504 settled that it must reach Core tools, so tightening the grants here
    // would rebuild the `cc-ritual-*` sandbox that broke the morning brief.
    // The split is the SESSION, not the capability.
    expect(nudge!.enableToolBridge).toBe(true)
    expect(nudge!.skip_permissions).toBe(chat!.skip_permissions)
    expect(nudge!.frontier_model_floor).toBe(chat!.frontier_model_floor)
  })

  test('the split holds PER PROJECT, which is the dimension the pool keys on', async () => {
    // `poolKeyFor` folds `project_id`, and both background callers set it. So the
    // claim under test is not "one nudge child exists" but "for EVERY project, the
    // nudge child and the chat child are different children" — and, because that
    // costs a resident REPL, that two projects do not silently share one either.
    const { ctx, spawnedForProject } = makeCtx()
    const w = wireSubstrates(ctx)
    await turn(w.liveAgentSubstrate!, 'hello', 'project-one')
    await turn(w.reminderComposeSubstrate!, 'compose', 'project-one')
    await turn(w.reminderComposeSubstrate!, 'compose', 'project-two')

    const chatOne = spawnedForProject('cc-agent-owner', 'project-one')!
    const nudgeOne = spawnedForProject('cc-nudge-owner', 'project-one')!
    const nudgeTwo = spawnedForProject('cc-nudge-owner', 'project-two')!
    expect(nudgeOne.project_id).toBe('project-one')
    expect(keyFor(nudgeOne)).not.toBe(keyFor(chatOne))
    expect(keyFor(nudgeTwo)).not.toBe(keyFor(nudgeOne))
  })

  test('an ABORTED reminder compose leaves the warm chat session usable', async () => {
    const { ctx } = makeCtx()
    const w = wireSubstrates(ctx)

    // The owner is mid-conversation on a warm child.
    expect(await turn(w.liveAgentSubstrate!, 'hello')).toBe('gen1')

    // A reminder comes due and its composition times out — the exact shape of the
    // incident: `cc-llm-call: aborted`, produced by the drain's own abort watchdog.
    const llm = buildSubstrateReminderLlm(w.reminderComposeSubstrate!, { timeout_ms: 5 })
    await expect(llm.compose(specFor(HANG))).rejects.toThrow(/aborted/)

    // His NEXT chat turn must land on the SAME warm child. `gen2` here would mean
    // the background failure evicted and respawned the session he is talking to —
    // which is the outage, one turn before the owner sees it.
    expect(await turn(w.liveAgentSubstrate!, 'still there?')).toBe('gen1')
  })

  test('the WIRED nudge substrate is declared a background credential lane', async () => {
    // The other half of the outage, asserted where it is actually configured. The
    // isolation above stops a failed compose from evicting the owner's child; it
    // does nothing about the credential pool, which is shared. Five composes whose
    // failure the substrate can only INFER a status for used to reach
    // `MAX_CONSECUTIVE_FAILURES` and park the box's ONE credential for an hour, after
    // which every owner turn died instantly with "all Anthropic credentials are in
    // cooldown".
    //
    // MUTATION-KILL: delete `credential_failure_lane: 'background'` from the nudge
    // substrate in `open/wiring/substrates.ts` → this goes RED. Nothing else in the
    // suite covers that line: the lane's own unit tests build their substrate
    // directly and pass the lane themselves, so they measure the mechanism and not
    // the wiring.
    const { ctx, credPool } = makeCtx()
    const w = wireSubstrates(ctx)
    const cred = credPool.credentials[0]!
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 2; i++) {
      await turn(w.reminderComposeSubstrate!, INFERRED_FAIL)
      // Wall clock past any short per-status cooldown, exactly as the real timeline
      // does: a fire cools for a minute, the next reminder comes due later.
      if (cred.cooldown_until !== undefined) cred.cooldown_until = Date.now() - 1
    }
    expect(cred.consecutive_failures).toBe(0)
    expect(cred.cooldown_reason).toBeUndefined()
    expect(hasUsableCredential(credPool)).toBe(true)
  })

  test('CONTROL — the owner’s own chat lane still counts its strikes', async () => {
    // The exemption is a LANE distinction. If this ever goes green, it stopped
    // being one and became a hole in the pool's only broken-credential detector.
    const { ctx, credPool } = makeCtx()
    const w = wireSubstrates(ctx)
    const cred = credPool.credentials[0]!
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await turn(w.liveAgentSubstrate!, INFERRED_FAIL)
      if (cred.cooldown_until !== undefined) cred.cooldown_until = Date.now() - 1
    }
    expect(cred.cooldown_reason).toBe('consecutive_failures')
  })

  test('the background lane poisons only ITSELF', async () => {
    const { ctx } = makeCtx()
    const w = wireSubstrates(ctx)
    const llm = buildSubstrateReminderLlm(w.reminderComposeSubstrate!, { timeout_ms: 5 })
    await expect(llm.compose(specFor(HANG))).rejects.toThrow(/aborted/)
    // Its own next turn respawns a clean child (the designed self-heal)…
    expect(await turn(w.reminderComposeSubstrate!, 'compose')).toBe('gen2')
    // …while the owner's chat has never respawned at all.
    expect(await turn(w.liveAgentSubstrate!, 'hello')).toBe('gen1')
  })
})

describe('the PRODUCTION dispatcher composes on the background REPL', () => {
  // The tests above prove the substrates are separable. This one proves the real
  // composition uses the separation — the defect was never that a separate
  // substrate could not exist, it was that the timer-driven callers were handed
  // the chat one. So it walks `buildOpenGraphComposer`, fires a real row through
  // `composition.reminder_dispatcher.dispatch()`, and reads which
  // `substrate_instance_id` the turn actually landed on.
  //
  // MUTATION-KILL: point the dispatcher's `llm` back at
  // `buildSubstrateReminderLlm(liveAgentSubstrate)` in `open/composer.ts` → the
  // captured instance is `cc-agent-owner` and this goes RED.

  const SAVED_ENV_KEYS = [
    'NEUTRON_HOME',
    'OWNER_HOME',
    'NEUTRON_DB_PATH',
    'NEUTRON_INSTANCE_SLUG',
    'NEUTRON_LANDING_STATIC_DIR',
    'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
    'NOTIFY_SOCKET',
  ] as const

  let savedEnv: Record<string, string | undefined> = {}
  let tmpDir: string
  let db: ProjectDb

  beforeEach(() => {
    savedEnv = {}
    for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
    tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-background-compose-'))
    process.env['NEUTRON_HOME'] = tmpDir
    process.env['OWNER_HOME'] = tmpDir
    process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
    process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
    process.env['NEUTRON_LANDING_STATIC_DIR'] = join(import.meta.dir, '..', '..', 'landing')
    process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] =
      'background-compose-isolation-secret-0123456789'
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-background-compose-test'
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
    process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
    delete process.env['NOTIFY_SOCKET']
    db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
    applyMigrations(db.raw())
  })

  afterEach(() => {
    db.close()
    for (const k of SAVED_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('a fired reminder dispatches on cc-nudge-*, never on cc-agent-*', async () => {
    const turns: Array<{ instance: string }> = []
    const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
      start(): SessionHandle {
        turns.push({ instance: opts.substrate_instance_id })
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          yield { kind: 'token', text: 'composed body' }
          yield {
            kind: 'completion',
            usage: { input_tokens: 1, output_tokens: 1 },
            substrate_instance_id: opts.substrate_instance_id,
          }
        })()
        return {
          events,
          async respondToTool(): Promise<void> {},
          async cancel(): Promise<void> {},
          tool_resolution: 'internal',
        }
      },
    })

    const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
    const composition = await composer({ db, project_slug: 'owner' })
    try {
      const store = new ReminderStore(db)
      const row = await store.create({
        owner_slug: 'owner',
        topic_id: null,
        fire_at: 1,
        message: 'take a walk',
      })

      // Boot itself starts turns (pre-warm, phase-spec) through this same factory.
      // Drop them so the assertion can only see the REMINDER's turn.
      turns.length = 0
      await composition.reminder_dispatcher.dispatch(row)

      expect(turns.length).toBeGreaterThanOrEqual(1)
      const instances = new Set(turns.map((t) => t.instance))
      expect([...instances]).toEqual(['cc-nudge-owner'])
      expect(instances.has('cc-agent-owner')).toBe(false)
    } finally {
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
    }
  })
})

describe('the work-board wakeup shares that background substrate', () => {
  // STRUCTURAL, and deliberately so: the wakeup loop is constructed inside the
  // composer and registered by DESCRIPTOR only, so no test can reach its tick the
  // way the test above reaches `reminder_dispatcher.dispatch()`. Rather than
  // pretend otherwise with a hand-built stand-in, this reads the composer source —
  // with the limits of that stated honestly:
  //   - COMMENTS ARE STRIPPED FIRST, so prose mentioning the old wrapper (this
  //     change's own comments do) can neither satisfy nor break the assertion;
  //   - ONE LEVEL OF LOCAL ALIAS is resolved, so a legitimate
  //     `const bg = reminderComposeSubstrate` refactor still passes.
  // A deeper refactor will fail it, and that failure is a prompt to re-point this
  // guard, not evidence of a defect.
  const composerSrc = readFileSync(join(import.meta.dir, '..', 'composer.ts'), 'utf8')
  const code = composerSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')

  test('every timer-driven compose wrapper resolves to the background substrate', () => {
    const wraps = [...code.matchAll(/buildSubstrateReminderLlm\(([A-Za-z_$][\w$]*)\)/g)].map(
      (m) => m[1]!,
    )
    // The fired-reminder dispatcher, work-board wakeup, and terminal-build wake.
    expect(wraps.length).toBe(3)
    for (const name of wraps) {
      const resolved =
        name === 'reminderComposeSubstrate' ||
        new RegExp(`\\b(?:const|let)\\s+${name}\\s*=\\s*reminderComposeSubstrate\\b`).test(code)
      expect(resolved, `buildSubstrateReminderLlm(${name})`).toBe(true)
    }
  })
})
