import { afterEach, expect, test } from 'bun:test'
import {
  registerSystemEventSink,
  type SystemEventInput,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { prewarmSubstrate } from '../composer.ts'

function fakeSink(): { rows: SystemEventInput[]; sink: SystemEventSink } {
  const rows: SystemEventInput[] = []
  return {
    rows,
    sink: {
      record(input: SystemEventInput) {
        rows.push(input)
        return { id: String(rows.length) }
      },
    },
  }
}

function healthyHandle(): SessionHandle {
  return {
    events: (async function* () {
      // empty stream → drains to '' with no error
    })(),
    respondToTool: async () => {},
    cancel: async () => {},
    tool_resolution: 'internal',
  }
}

afterEach(() => registerSystemEventSink(null))

test('O4 — a prewarm spawn failure emits ONE prewarm_failed row; the promise still resolves (never rejects)', async () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  const substrate: Substrate = {
    start() {
      throw new Error('spawn ENOENT')
    },
  }
  // Contract: prewarmSubstrate NEVER rejects even on failure.
  await expect(prewarmSubstrate(substrate)).resolves.toBeUndefined()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ event: 'prewarm_failed', module: 'open' })
  expect(rows[0]?.payload).toMatchObject({ error: 'spawn ENOENT' })
})

test('O4 — a successful prewarm emits NOTHING', async () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  const substrate: Substrate = {
    start() {
      return healthyHandle()
    },
  }
  await prewarmSubstrate(substrate)
  expect(rows).toHaveLength(0)
})

test('O4 — a throwing journal sink does NOT break the never-reject prewarm contract', async () => {
  registerSystemEventSink({
    record() {
      throw new Error('journal write failed')
    },
  })
  const substrate: Substrate = {
    start() {
      throw new Error('spawn boom')
    },
  }
  await expect(prewarmSubstrate(substrate)).resolves.toBeUndefined()
})

test('O4 — with NO sink registered the prewarm failure is a byte-identical no-op', async () => {
  registerSystemEventSink(null)
  const substrate: Substrate = {
    start() {
      throw new Error('spawn boom')
    },
  }
  await expect(prewarmSubstrate(substrate)).resolves.toBeUndefined()
})
