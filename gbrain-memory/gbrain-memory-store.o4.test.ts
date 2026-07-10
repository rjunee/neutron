import { afterEach, expect, test } from 'bun:test'
import {
  registerSystemEventSink,
  type SystemEventInput,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
import { GBrainMemoryStore } from './gbrain-memory-store.ts'
import { GBrainUnavailableError } from './memory-store.ts'
import type { McpClient } from './mcp-client.ts'

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

afterEach(() => registerSystemEventSink(null))

test('O4 — gbrain-binary-missing degrade returns [] AND emits ONE gbrain_unavailable row', async () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  const mcp: McpClient = {
    call: () => Promise.reject(new GBrainUnavailableError('binary missing (ENOENT)')),
  }
  const store = new GBrainMemoryStore(mcp)
  const result = await store.query({ query: 'hello' })
  expect(result).toEqual([]) // fail-soft decision UNCHANGED
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ event: 'gbrain_unavailable', module: 'gbrain-memory' })
  expect(rows[0]?.payload).toMatchObject({ op: 'query' })
})

test('O4 — a NON-binary error still propagates (not masked) and emits NOTHING', async () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  const mcp: McpClient = {
    call: () => Promise.reject(new Error('some other real fault')),
  }
  const store = new GBrainMemoryStore(mcp)
  await expect(store.query({ query: 'hello' })).rejects.toThrow('some other real fault')
  expect(rows).toHaveLength(0)
})

test('O4 — the healthy recall path emits NOTHING', async () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  const mcp: McpClient = {
    call: (name) => {
      if (name === 'search') {
        return Promise.resolve([{ slug: 'e1', chunk_text: 'body', score: 0.9 }])
      }
      return Promise.resolve([])
    },
  }
  const store = new GBrainMemoryStore(mcp)
  const result = await store.query({ query: 'hello' })
  expect(result).toHaveLength(1)
  expect(rows).toHaveLength(0)
})

test('O4 — a throwing journal sink does NOT break the fail-soft degrade (still returns [])', async () => {
  registerSystemEventSink({
    record() {
      throw new Error('journal write failed')
    },
  })
  const mcp: McpClient = {
    call: () => Promise.reject(new GBrainUnavailableError('binary missing')),
  }
  const store = new GBrainMemoryStore(mcp)
  const result = await store.query({ query: 'hello' })
  expect(result).toEqual([])
})
