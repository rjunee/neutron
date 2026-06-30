/**
 * always-latest-model (2026-06-30) — the live-agent / onboarding REPL turn MUST
 * resolve its `--model` through the DYNAMIC `getBestModel()` accessor at TURN
 * time, never a frozen `BEST_MODEL` constant captured when the runner was built
 * once at gateway boot.
 *
 * Regression guard for the opus-4-7 hang: a fresh install spawned the REPL on
 * the retired `claude-opus-4-7` literal → the model call produced zero tokens →
 * the persistent-REPL 180s per-turn timeout → onboarding "Setting things up…"
 * never resolved. The model-update watchdog had ALREADY detected and adopted the
 * newer model (via `setBestModelOverride`), but the spawn read the frozen
 * constant, so the adoption never reached new spawns. These tests pin that the
 * spawn spec tracks the live accessor AND that a post-build watchdog flip
 * reaches the NEXT turn on the SAME runner (proving per-turn, not per-build,
 * resolution).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import type { Event } from '../../../runtime/events.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'
import { BEST_MODEL, getBestModel, setBestModelOverride } from '../../../runtime/models.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
const now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-model-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db, now: () => now })
  // Start each test from a clean runtime override so cross-test leakage can't
  // mask a regression. (`setBestModelOverride(undefined)` ⇒ getBestModel() === BEST_MODEL.)
  setBestModelOverride(undefined)
})

afterEach(() => {
  setBestModelOverride(undefined)
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeStubSubstrate(specs: AgentSpec[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
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

/** A runner that does NOT pin `model`, so the dynamic default governs. */
function makeDefaultModelRunner(substrate: Substrate) {
  return buildLiveAgentTurn({
    substrate,
    personaLoader: { async load(): Promise<string> { return '' } },
    buttonStore: store,
    project_slug: 'alice',
    owner_home: tmp,
    now: () => now,
  })
}

function makeTurn(sent: ChatOutbound[], over?: Partial<LiveAgentTurnRequest>): LiveAgentTurnRequest {
  return {
    project_slug: 'alice',
    user_id: 'u-1',
    topic_id: 'web:u-1',
    user_text: 'hello',
    send: (e) => sent.push(e),
    observed_at: now,
    ...over,
  }
}

describe('build-live-agent-turn — dynamic model resolution (always-latest)', () => {
  test('omitting input.model resolves the spawn spec via getBestModel() (NOT a frozen literal)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeDefaultModelRunner(makeStubSubstrate(specs))
    await run(makeTurn(sent))
    expect(specs).toHaveLength(1)
    // The spawn model equals the live accessor (the env/default seed here).
    expect(specs[0]!.model_preference[0]).toBe(getBestModel())
    expect(specs[0]!.model_preference[0]).toBe(BEST_MODEL)
  })

  test('a watchdog flip AFTER the runner is built reaches the NEXT turn on the SAME runner', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    // Runner built ONCE — mirrors the gateway building the runner at boot.
    const run = makeDefaultModelRunner(makeStubSubstrate(specs))

    // Turn 1 on the boot-default model.
    await run(makeTurn(sent, { topic_id: 'web:u-1:a' }))
    expect(specs[0]!.model_preference[0]).toBe(BEST_MODEL)

    // The model-update watchdog detects + adopts a newer top-tier model.
    const NEWER = 'claude-opus-9-9'
    setBestModelOverride(NEWER)

    // Turn 2 — on the SAME runner — MUST spawn the newly-adopted model. A
    // frozen build-time capture would still show BEST_MODEL here (the bug).
    await run(makeTurn(sent, { topic_id: 'web:u-1:b' }))
    expect(specs[1]!.model_preference[0]).toBe(NEWER)
    expect(specs[1]!.model_preference[0]).not.toBe(BEST_MODEL)
  })

  test('an explicit input.model still wins over the dynamic default', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    setBestModelOverride('claude-opus-9-9')
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load(): Promise<string> { return '' } },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'pinned-model',
      now: () => now,
    })
    await run(makeTurn(sent))
    expect(specs[0]!.model_preference[0]).toBe('pinned-model')
  })
})
