/**
 * Claude.ai export parser tests.
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseClaudeExport } from '../claude-export.ts'
import { writeZip } from './zip-writer.ts'
import { ImportError } from '../types.ts'

const FIXTURES = join(import.meta.dir, '..', '__fixtures__')

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

test('parses synthetic-claude-export.zip and yields 8 conversations', async () => {
  const zip = readFileSync(join(FIXTURES, 'synthetic-claude-export.zip'))
  const records = await collect(parseClaudeExport(zip))
  expect(records.length).toBe(8)
})

test('maps human/assistant senders to user/assistant roles', async () => {
  const zip = readFileSync(join(FIXTURES, 'synthetic-claude-export.zip'))
  const records = await collect(parseClaudeExport(zip))
  const first = records[0]
  expect(first?.messages[0]?.role).toBe('user')
  expect(first?.messages[1]?.role).toBe('assistant')
})

test('ISO timestamps parse to unix-ms', async () => {
  const zip = readFileSync(join(FIXTURES, 'synthetic-claude-export.zip'))
  const records = await collect(parseClaudeExport(zip))
  const first = records[0]
  expect(first?.created_at).toBeGreaterThan(1_000_000_000_000)
  expect(first?.messages[0]?.created_at).toBeGreaterThan(1_000_000_000_000)
})

test('handles content[].text shape (alternate Claude export format)', async () => {
  const zip = writeZip([
    {
      name: 'conversations.json',
      data: Buffer.from(
        JSON.stringify([
          {
            uuid: 'c1',
            name: 'test',
            chat_messages: [
              {
                uuid: 'm1',
                sender: 'human',
                content: [{ type: 'text', text: 'hello there' }],
                created_at: '2026-01-01T00:00:00Z',
              },
            ],
          },
        ]),
      ),
    },
  ])
  const records = await collect(parseClaudeExport(zip))
  expect(records[0]?.messages[0]?.text).toBe('hello there')
})

test('throws ImportError on missing conversations.json', async () => {
  const garbageZip = writeZip([{ name: 'unrelated.txt', data: Buffer.from('hello') }])
  await expect(async () => {
    for await (const _ of parseClaudeExport(garbageZip)) {
      // unreachable
    }
  }).toThrow(ImportError)
})
