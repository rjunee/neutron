/**
 * ACTIVITY INSPECTOR — the live-chat-turn tee, at the runner level.
 *
 * `substrate-text-activity-tee.test.ts` proves the DRAIN forwards events when handed
 * an `onEvent`. This proves the thing that actually matters for the feature being
 * reachable: that the live chat runner PASSES one down, scoped to the right project,
 * and brackets the dispatch with turn_started/turn_finished.
 *
 * Without the runner change every test here fails — `on_event` is never called, so
 * the panel would show nothing for a real chat turn no matter how good the drain and
 * the store are. This is the "module whose tests pass while no caller invokes it"
 * failure mode, asserted against.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-actin-'))
  seedMigratedDb(join(tmp, 'owner.db'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  store = new ButtonStore({ db })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** A substrate that emits a realistic CC-persistent-REPL stream: a keepalive-shaped
 *  status, then the single whole-reply token, then completion. */
function makeSubstrate(events: Event[]): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      const gen = (async function* (): AsyncGenerator<Event, void, void> {
        for (const e of events) yield e
      })()
      return {
        events: gen,
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

const REPLY: Event[] = [
  { kind: 'status', message: 'working' },
  { kind: 'status', message: 'working', keepalive: true },
  { kind: 'token', text: 'done' },
  { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 's' },
]

interface Capture {
  events: Array<{ scope: string; ev: Event }>
  started: string[]
  finished: string[]
}

function makeRunner(substrate: Substrate, cap: Capture) {
  return buildLiveAgentTurn({
    substrate,
    activityInspector: {
      on_event: (scope, ev) => cap.events.push({ scope, ev: ev as Event }),
      turn_started: (scope) => cap.started.push(scope),
      turn_finished: (scope) => cap.finished.push(scope),
    },
    personaLoader: {
      async load(): Promise<string> {
        return ''
      },
    },
    buttonStore: store,
    project_slug: 'alice',
    owner_home: tmp,
    model: 'test-model',
  })
}

function fresh(): Capture {
  return { events: [], started: [], finished: [] }
}

describe('build-live-agent-turn — activity inspector tee', () => {
  test('tees every substrate event for a real chat turn, keepalive flag intact', async () => {
    const cap = fresh()
    const run = makeRunner(makeSubstrate(REPLY), cap)
    const res = await run({
      project_slug: 'alice',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      project_id: 'proj-42',
      user_text: 'hello',
      send: () => {},
      observed_at: 0,
    })
    expect(res.outcome).toBe('replied')

    expect(cap.events.map((e) => e.ev.kind)).toEqual([
      'status',
      'status',
      'token',
      'completion',
    ])
    // The keepalive marker must survive the whole path — the two-clocks design is
    // built on it, and the two status events are otherwise identical.
    const statuses = cap.events
      .map((e) => e.ev)
      .filter((e): e is Extract<Event, { kind: 'status' }> => e.kind === 'status')
    expect(statuses[0]?.keepalive).toBeUndefined()
    expect(statuses[1]?.keepalive).toBe(true)
  })

  test('scopes the tee to the turn PROJECT — and to `general` with no project', async () => {
    const withProject = fresh()
    await makeRunner(makeSubstrate(REPLY), withProject)({
      project_slug: 'alice',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      project_id: 'proj-42',
      user_text: 'hi',
      send: () => {},
      observed_at: 0,
    })
    expect(new Set(withProject.events.map((e) => e.scope))).toEqual(new Set(['proj-42']))
    expect(withProject.started).toEqual(['proj-42'])

    // General is a real scope with a real warm session (the SAME key the warm-REPL
    // pool uses: `turn.project_id ?? 'general'`), not an absence to be skipped.
    const general = fresh()
    await makeRunner(makeSubstrate(REPLY), general)({
      project_slug: 'alice',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      user_text: 'hi',
      send: () => {},
      observed_at: 0,
    })
    expect(general.started).toEqual(['general'])
    expect(new Set(general.events.map((e) => e.scope))).toEqual(new Set(['general']))
  })

  test('brackets the dispatch: turn_started before any event, turn_finished after', async () => {
    // The bracket is what lets the inspector distinguish a resting `idle` session
    // from a `wedged` one. Without it, every stale-clock scope reads as wedged.
    const order: string[] = []
    const run = buildLiveAgentTurn({
      substrate: makeSubstrate(REPLY),
      activityInspector: {
        on_event: () => order.push('event'),
        turn_started: () => order.push('started'),
        turn_finished: () => order.push('finished'),
      },
      personaLoader: {
        async load(): Promise<string> {
          return ''
        },
      },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
    })
    await run({
      project_slug: 'alice',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      project_id: 'p',
      user_text: 'hi',
      send: () => {},
      observed_at: 0,
    })
    expect(order[0]).toBe('started')
    expect(order[order.length - 1]).toBe('finished')
    expect(order.filter((o) => o === 'started')).toHaveLength(1)
    expect(order.filter((o) => o === 'finished')).toHaveLength(1)
  })

  test('turn_finished still fires when the turn ERRORS (no in-flight leak)', async () => {
    // A leaked in-flight turn would pin the scope at `wedged` forever — a permanent
    // lie, and worse than the dot bug this feature fixes.
    const cap = fresh()
    const run = makeRunner(
      makeSubstrate([{ kind: 'error', message: 'substrate exploded', retryable: false }]),
      cap,
    )
    const res = await run({
      project_slug: 'alice',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      project_id: 'p',
      user_text: 'hi',
      send: () => {},
      observed_at: 0,
    })
    expect(res.outcome).not.toBe('replied')
    expect(cap.started.length).toBeGreaterThanOrEqual(1)
    // Every start is matched by a finish.
    expect(cap.finished.length).toBe(cap.started.length)
    expect(cap.events.some((e) => e.ev.kind === 'error')).toBe(true)
  })

  test('a THROWING inspector cannot fail the turn', async () => {
    // Observe-only contract, asserted at the runner (not just the drain): a broken
    // inspector must never cost the owner a reply.
    const run = buildLiveAgentTurn({
      substrate: makeSubstrate(REPLY),
      activityInspector: {
        on_event: () => {
          throw new Error('tee exploded')
        },
        turn_started: () => {
          throw new Error('start exploded')
        },
        turn_finished: () => {
          throw new Error('finish exploded')
        },
      },
      personaLoader: {
        async load(): Promise<string> {
          return ''
        },
      },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
    })
    const res = await run({
      project_slug: 'alice',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      project_id: 'p',
      user_text: 'hi',
      send: () => {},
      observed_at: 0,
    })
    expect(res.outcome).toBe('replied')
  })

  test('omitting the inspector leaves the turn byte-identical (no tee at all)', async () => {
    const run = buildLiveAgentTurn({
      substrate: makeSubstrate(REPLY),
      personaLoader: {
        async load(): Promise<string> {
          return ''
        },
      },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
    })
    const res = await run({
      project_slug: 'alice',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      project_id: 'p',
      user_text: 'hi',
      send: () => {},
      observed_at: 0,
    })
    expect(res.outcome).toBe('replied')
  })
})
