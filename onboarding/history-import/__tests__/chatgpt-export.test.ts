/**
 * ChatGPT export parser tests.
 *
 * Asserts:
 *   - small fixture parses with expected conversation count
 *   - mapping graph walk yields chronological messages
 *   - timestamps land in unix-ms (not seconds)
 *   - degenerate entries are skipped
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseChatgptExport } from '../chatgpt-export.ts'
import { writeZip } from './zip-writer.ts'
import { ImportError } from '../types.ts'

const FIXTURES = join(import.meta.dir, '..', '__fixtures__')

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

test('parses synthetic-small-chatgpt.zip and yields 5 conversations', async () => {
  const zip = readFileSync(join(FIXTURES, 'synthetic-small-chatgpt.zip'))
  const records = await collect(parseChatgptExport(zip))
  expect(records.length).toBe(5)
})

test('parses synthetic-medium-chatgpt.zip and yields 50 conversations without OOM', async () => {
  const zip = readFileSync(join(FIXTURES, 'synthetic-medium-chatgpt.zip'))
  const records = await collect(parseChatgptExport(zip))
  expect(records.length).toBe(50)
  for (const r of records) {
    expect(r.messages.length).toBeGreaterThanOrEqual(30)
    // First message should be the user (chronological order — graph walk reverses to root-first).
    expect(r.messages[0]?.role).toBe('user')
  }
})

test('walks the mapping graph in chronological order from current_node', async () => {
  const zip = readFileSync(join(FIXTURES, 'synthetic-small-chatgpt.zip'))
  const records = await collect(parseChatgptExport(zip))
  const first = records[0]
  expect(first).toBeDefined()
  // Roles alternate user/assistant (synthetic generator produces this).
  for (let i = 0; i < first!.messages.length; i++) {
    const expected = i % 2 === 0 ? 'user' : 'assistant'
    expect(first!.messages[i]?.role).toBe(expected)
  }
})

test('timestamps land in unix-ms', async () => {
  const zip = readFileSync(join(FIXTURES, 'synthetic-small-chatgpt.zip'))
  const records = await collect(parseChatgptExport(zip))
  const first = records[0]
  expect(first?.created_at).toBeGreaterThan(1_000_000_000_000) // unix-ms is in the trillions for 2026
})

test('throws ImportError on missing conversations.json', async () => {
  const garbageZip = writeZip([{ name: 'unrelated.txt', data: Buffer.from('hello') }])
  await expect(async () => {
    for await (const _ of parseChatgptExport(garbageZip)) {
      // unreachable
    }
  }).toThrow(ImportError)
})

test('throws ImportError on malformed JSON', async () => {
  const badZip = writeZip([
    { name: 'conversations.json', data: Buffer.from('not valid json') },
  ])
  await expect(async () => {
    for await (const _ of parseChatgptExport(badZip)) {
      // unreachable
    }
  }).toThrow(ImportError)
})

test('throws ImportError on non-array root', async () => {
  const wrongShape = writeZip([
    { name: 'conversations.json', data: Buffer.from('{"oops": 1}') },
  ])
  await expect(async () => {
    for await (const _ of parseChatgptExport(wrongShape)) {
      // unreachable
    }
  }).toThrow(/not an array/)
})

test('skips degenerate entries with no id', async () => {
  const mixed = writeZip([
    {
      name: 'conversations.json',
      data: Buffer.from(
        JSON.stringify([
          { id: 'good', mapping: {}, current_node: null },
          { mapping: {} }, // no id
        ]),
      ),
    },
  ])
  const records = await collect(parseChatgptExport(mixed))
  expect(records.length).toBe(1)
  expect(records[0]?.conversation_id).toBe('good')
})

test('parses sharded conversations-NNN.json layout (OpenAI large-export format ~2026-05)', async () => {
  // Repro: Sam's 1.18 GB ChatGPT export on 2026-05-25 shipped
  // `conversations-000.json` … `conversations-005.json` instead of a
  // single `conversations.json`. Pre-fix the parser bailed with
  // "archive does not contain conversations.json" + the engine fell
  // back to "I couldn't analyze your ChatGPT export."
  const shard = (ids: string[]): Buffer =>
    Buffer.from(
      JSON.stringify(ids.map((id) => ({ id, mapping: {}, current_node: null }))),
    )
  const zip = writeZip([
    { name: 'chat.html', data: Buffer.from('<html/>') },
    { name: 'conversations-005.json', data: shard(['e', 'f']) },
    { name: 'conversations-000.json', data: shard(['a']) },
    { name: 'conversations-002.json', data: shard(['c']) },
    { name: 'conversations-001.json', data: shard(['b']) },
    { name: 'conversations-004.json', data: shard(['d']) },
  ])
  const records = await collect(parseChatgptExport(zip))
  // Shards must be concatenated in numeric-suffix order (000 → 005),
  // NOT alphabetical entry order, NOT zip-write order.
  expect(records.map((r) => r.conversation_id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
})

test('error message names BOTH layouts when neither single nor sharded files are present', async () => {
  const z = writeZip([
    { name: 'unrelated.txt', data: Buffer.from('x') },
    { name: 'chat.html', data: Buffer.from('y') },
  ])
  try {
    for await (const _ of parseChatgptExport(z)) {
      // unreachable
    }
    throw new Error('expected throw')
  } catch (err) {
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).message).toContain('conversations.json')
    expect((err as ImportError).message).toContain('conversations-NNN.json')
  }
})

test('sharded layout: a single bad shard fails the whole parse with the shard name in the error', async () => {
  const z = writeZip([
    { name: 'conversations-000.json', data: Buffer.from(JSON.stringify([{ id: 'a', mapping: {} }])) },
    { name: 'conversations-001.json', data: Buffer.from('not valid json') },
  ])
  try {
    for await (const _ of parseChatgptExport(z)) {
      // unreachable
    }
    throw new Error('expected throw')
  } catch (err) {
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).message).toContain('conversations-001.json')
    expect((err as ImportError).message).toContain('JSON parse failed')
  }
})
