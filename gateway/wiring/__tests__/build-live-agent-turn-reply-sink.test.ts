/**
 * A follow-up joins the topic's active turn (injection) only when both reply to
 * the same surface. A message from another surface (`reply_sink`) queues behind
 * the active turn instead, so its answer goes to its own surface rather than to
 * the surface of the turn it would have joined. Web-chat turns carry no
 * `reply_sink` and keep injecting into each other exactly as before.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ChatOutbound } from '@neutronai/landing/server.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'
import { openAdmission } from './project-admission-fixture.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-sink-'))
  seedMigratedDb(join(tmp, 'owner.db'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  store = new ButtonStore({ db })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((r) => { release = r })
  return { promise, release }
}

function harness(): {
  run: ReturnType<typeof buildLiveAgentTurn>
  started: ReturnType<typeof latch>
  hold: ReturnType<typeof latch>
  starts: string[]
  injected: string[]
} {
  const started = latch()
  const hold = latch()
  const starts: string[] = []
  const injected: string[] = []
  const run = buildLiveAgentTurn({
    admission: openAdmission(),
    substrate: {
      start(spec) {
        const name = spec.prompt.includes('first') ? 'first' : spec.prompt.trim().split('\n').pop() ?? ''
        starts.push(name)
        async function* events(): AsyncGenerator<Event> {
          if (name === 'first') { started.release(); await hold.promise }
          yield { kind: 'token', text: `reply:${name}` }
          yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'chat' }
        }
        return { events: events(), async respondToTool() {}, async cancel() {}, tool_resolution: 'internal' }
      },
    },
    injectActiveTurn: async (_turn, text) => { injected.push(text); return true },
    personaLoader: { async load() { return '' } }, buttonStore: store,
    project_slug: 'owner', owner_home: tmp, ack_delay_ms: 60_000,
  })
  return { run, started, hold, starts, injected }
}

const base = { project_slug: 'owner', user_id: 'u', project_id: 'project-a', topic_id: 'app:u:project-a', observed_at: 0 }

test('a turn from another surface queues behind the active turn and answers on its own surface', async () => {
  const h = harness()
  const webSent: ChatOutbound[] = []
  const chatSent: ChatOutbound[] = []
  const web = h.run({ ...base, user_text: 'first', send: (e) => { webSent.push(e) } })
  await h.started.promise
  const other = h.run({ ...base, user_text: 'from the group', reply_sink: 'telegram:-100', send: (e) => { chatSent.push(e) } })
  await Promise.resolve()
  expect(h.injected).toEqual([])
  h.hold.release()
  await web
  expect((await other).outcome).toBe('replied')
  expect(h.injected).toEqual([])
  expect(chatSent.some((e) => e.type === 'agent_message' && e.body.includes('from the group'))).toBe(true)
  expect(webSent.some((e) => e.type === 'agent_message' && e.body.includes('from the group'))).toBe(false)
}, 30_000)

test('two turns on the same surface still inject, as web-chat turns always have', async () => {
  for (const sink of [undefined, 'telegram:-100']) {
    const h = harness()
    const sinkField = sink === undefined ? {} : { reply_sink: sink }
    const first = h.run({ ...base, ...sinkField, user_text: 'first', send: () => {} })
    await h.started.promise
    const follow = h.run({ ...base, ...sinkField, user_text: 'follow-up', send: () => {} })
    await follow
    expect(h.injected).toEqual(['follow-up'])
    h.hold.release()
    await first
  }
}, 30_000)
