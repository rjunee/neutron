/**
 * WAVE 2 Track A (P0-4 / gap-audit §(b) cat 2) — per-topic session ISOLATION,
 * asserted at the warm-pool KEY level, end-to-end.
 *
 * The existing `build-live-agent-turn.test.ts` proves a project topic stamps
 * `spec.metering_context.project_id`. That alone does NOT prove two topics get
 * DISTINCT warm CC sessions — `metering_context.project_id` is a no-op on the
 * CC adapter UNLESS `buildLlmCallSubstrate` folds it into the
 * `ClaudeCodeSubstrateOptions.project_id` that `poolKeyFor()` keys the
 * module-level warm-session pool on. THIS test wires the real
 * `buildLlmCallSubstrate` (the production seam the composer builds the live
 * substrate through) under the live-agent runner and asserts the COMPUTED
 * `poolKeyFor` differs across General + two project topics, and is STABLE for
 * the same topic.
 *
 * The spec's hard requirement (CLAUDE.md "REAL verification"): "Assert distinct
 * session keys + per-topic prompt, not just that a session exists."
 *
 * No real `claude` REPL spawns — a fake `substrateFactory` captures the fully
 * composed `ClaudeCodeSubstrateOptions` each dispatch produces, exactly the bag
 * `createClaudeCodeSubstrateAuto` would have keyed the persistent pool on.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { newCredentialPool } from '../../../runtime/credential-pool.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import type { Event } from '../../../runtime/events.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import type { ClaudeCodeSubstrateOptions } from '../../../runtime/adapters/claude-code/index.ts'
import {
  poolKeyFor,
  type PersistentReplSubstrateOptions,
} from '../../../runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { buildLlmCallSubstrate } from '../build-llm-call-substrate.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
const NOW = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-iso-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db, now: () => NOW })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** A canned-reply substrate stub (no real `claude`). */
function stubSubstrate(captured: ClaudeCodeSubstrateOptions[]): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: 'ok' }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'stub',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {
          throw new Error('not used')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

/**
 * Re-derive the warm-pool key for a captured spawn bag EXACTLY as
 * `createClaudeCodeSubstrateAuto` would (identity map for the keying fields),
 * then run it through the real `poolKeyFor`. This is the string the
 * module-level persistent pool would have keyed the warm REPL on.
 */
function poolKeyForCaptured(opts: ClaudeCodeSubstrateOptions): string {
  const p: PersistentReplSubstrateOptions = {
    substrate_instance_id: opts.substrate_instance_id,
  }
  if (opts.cwd !== undefined) p.cwd = opts.cwd
  if (opts.user_id !== undefined) p.user_id = opts.user_id
  if (opts.project_id !== undefined) p.project_id = opts.project_id
  if (opts.credential_identity !== undefined) p.credential_identity = opts.credential_identity
  return poolKeyFor(p)
}

function makeTurn(over: Partial<LiveAgentTurnRequest>): LiveAgentTurnRequest {
  const sent: ChatOutbound[] = []
  return {
    project_slug: 'owner',
    user_id: 'u-1',
    topic_id: 'web:u-1',
    user_text: 'hello',
    send: (e) => sent.push(e),
    observed_at: NOW,
    ...over,
  }
}

describe('build-live-agent-turn — per-topic warm-session isolation (poolKeyFor)', () => {
  test('General + two project topics resolve to THREE DISTINCT warm-session keys', async () => {
    const captured: ClaudeCodeSubstrateOptions[] = []
    // The REAL production substrate seam — same builder the composer wires the
    // live conversational substrate through — with the real
    // createClaudeCodeSubstrateAuto swapped for a capturing fake.
    const substrate = buildLlmCallSubstrate({
      pool: newCredentialPool({
        strategy: 'fill_first',
        credentials: [{ id: 'anthropic:env_api_key', kind: 'api_key', secret: 'sk-test' }],
      }),
      substrate_instance_id: 'cc-agent-owner',
      cwd: tmp,
      user_id: 'owner-user',
      project_slug: 'owner',
      skip_permissions: true,
      substrateFactory: (opts) => {
        captured.push(opts)
        return stubSubstrate(captured)
      },
    })!
    const run = buildLiveAgentTurn({
      substrate,
      personaLoader: { async load(): Promise<string> { return '' } },
      buttonStore: store,
      project_slug: 'owner',
      owner_home: tmp,
      now: () => NOW,
    })

    await run(makeTurn({ topic_id: 'web:u-1' })) // General
    await run(makeTurn({ topic_id: 'web:u-1:gondor', project_id: 'gondor' }))
    await run(makeTurn({ topic_id: 'web:u-1:rohan', project_id: 'rohan' }))

    expect(captured).toHaveLength(3)
    const keys = captured.map(poolKeyForCaptured)
    // All three are distinct → three independent warm CC sessions, NOT one
    // shared substrate. This is the load-bearing isolation assertion.
    expect(new Set(keys).size).toBe(3)
    // And the distinguishing dimension is the project id folded from
    // metering_context (General defaults to 'general', not 'default').
    expect(captured[0]!.project_id).toBe('general')
    expect(captured[1]!.project_id).toBe('gondor')
    expect(captured[2]!.project_id).toBe('rohan')
  })

  test('the SAME project topic resolves to a STABLE key across turns (one warm session reused)', async () => {
    const captured: ClaudeCodeSubstrateOptions[] = []
    const substrate = buildLlmCallSubstrate({
      pool: newCredentialPool({
        strategy: 'fill_first',
        credentials: [{ id: 'anthropic:env_api_key', kind: 'api_key', secret: 'sk-test' }],
      }),
      substrate_instance_id: 'cc-agent-owner',
      cwd: tmp,
      user_id: 'owner-user',
      project_slug: 'owner',
      skip_permissions: true,
      substrateFactory: (opts) => {
        captured.push(opts)
        return stubSubstrate(captured)
      },
    })!
    const run = buildLiveAgentTurn({
      substrate,
      personaLoader: { async load(): Promise<string> { return '' } },
      buttonStore: store,
      project_slug: 'owner',
      owner_home: tmp,
      now: () => NOW,
    })

    await run(makeTurn({ topic_id: 'web:u-1:gondor', project_id: 'gondor' }))
    await run(
      makeTurn({ topic_id: 'web:u-1:gondor', project_id: 'gondor', user_text: 'again' }),
    )
    expect(captured).toHaveLength(2)
    const [k1, k2] = captured.map(poolKeyForCaptured)
    expect(k1).toBe(k2) // same (instance,user,project,cred) ⇒ one warm REPL
  })

  test('the single-topic (General-only) path keeps working — stable key, reply delivered', async () => {
    const captured: ClaudeCodeSubstrateOptions[] = []
    const sent: ChatOutbound[] = []
    const substrate = buildLlmCallSubstrate({
      pool: newCredentialPool({
        strategy: 'fill_first',
        credentials: [{ id: 'anthropic:env_api_key', kind: 'api_key', secret: 'sk-test' }],
      }),
      substrate_instance_id: 'cc-agent-owner',
      cwd: tmp,
      user_id: 'owner-user',
      project_slug: 'owner',
      skip_permissions: true,
      substrateFactory: (opts) => {
        captured.push(opts)
        return stubSubstrate(captured)
      },
    })!
    const run = buildLiveAgentTurn({
      substrate,
      personaLoader: { async load(): Promise<string> { return '' } },
      buttonStore: store,
      project_slug: 'owner',
      owner_home: tmp,
      now: () => NOW,
    })
    await run(makeTurn({ topic_id: 'web:u-1', send: (e) => sent.push(e) }))
    await run(makeTurn({ topic_id: 'web:u-1', send: (e) => sent.push(e), user_text: 'again' }))
    expect(captured).toHaveLength(2)
    const [k1, k2] = captured.map(poolKeyForCaptured)
    expect(k1).toBe(k2)
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(2)
  })
})
