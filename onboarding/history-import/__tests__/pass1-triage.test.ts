/**
 * Pass-1 triage tests — mocked LLM call asserts shape extraction.
 */

import { expect, test } from 'bun:test'
import { pass1Triage, parsePass1Result, type Pass1LlmCall } from '../pass1-triage.ts'
import type { Chunk } from '../types.ts'

const sampleChunk: Chunk = {
  chunk_hash: 'a'.repeat(64),
  conversation_id: 'c1',
  chunk_index: 0,
  text: 'USER: ping Priya about the invoice',
  byte_length: 100,
  approx_tokens: 25,
}

test('extracts entities/topics/tasks/voice_signals from a JSON string LLM response', async () => {
  const fakeLlm: Pass1LlmCall = async () => ({
    result: JSON.stringify({
      candidate_entities: [
        { name: 'Priya', kind: 'person', mention_count: 2 },
        { name: 'Topline', kind: 'company', mention_count: 4 },
      ],
      candidate_topics: [{ name: 'Q3 invoicing', summary: 'discussion' }],
      candidate_tasks: [{ title: 'Reply to Priya', priority_hint: 'P1' }],
      voice_signals: { tone: 'terse', verbosity: 'low', structure_pref: 'bullets' },
    }),
    dollars_billed: 0.05,
  })
  const result = await pass1Triage(sampleChunk, { llm: fakeLlm, prompt: '' })
  expect(result.candidate_entities.length).toBe(2)
  expect(result.candidate_entities[0]?.name).toBe('Priya')
  expect(result.candidate_topics.length).toBe(1)
  expect(result.candidate_tasks.length).toBe(1)
  expect(result.candidate_tasks[0]?.priority_hint).toBe('P1')
  expect(result.voice_signals.tone).toBe('terse')
  expect(result.dollars_billed).toBe(0.05)
})

test('handles object LLM response (mock pattern)', () => {
  const result = parsePass1Result(
    sampleChunk,
    {
      candidate_entities: [{ name: 'Casey', kind: 'person', mention_count: 3 }],
      candidate_topics: [],
      candidate_tasks: [],
      voice_signals: {},
    },
    0.05,
  )
  expect(result.candidate_entities.length).toBe(1)
  expect(result.dollars_billed).toBe(0.05)
})

test('returns empty result on null LLM response', () => {
  const result = parsePass1Result(sampleChunk, null, 0.04)
  expect(result.candidate_entities).toEqual([])
  expect(result.candidate_topics).toEqual([])
  expect(result.candidate_tasks).toEqual([])
  expect(result.voice_signals).toEqual({})
  expect(result.dollars_billed).toBe(0.04)
})

test('returns empty result on garbage JSON', () => {
  const result = parsePass1Result(sampleChunk, 'not json {{{', 0.03)
  expect(result.candidate_entities).toEqual([])
  expect(result.dollars_billed).toBe(0.03)
})

test('clamps invalid kind values to "concept"', () => {
  const result = parsePass1Result(
    sampleChunk,
    { candidate_entities: [{ name: 'X', kind: 'something_else', mention_count: 1 }] },
    0.01,
  )
  expect(result.candidate_entities[0]?.kind).toBe('concept')
})

test('drops entities without name', () => {
  const result = parsePass1Result(
    sampleChunk,
    { candidate_entities: [{ kind: 'person' }, { name: 'Real', kind: 'person', mention_count: 1 }] },
    0,
  )
  expect(result.candidate_entities.length).toBe(1)
  expect(result.candidate_entities[0]?.name).toBe('Real')
})

test('preserves the chunk_hash from the input chunk', () => {
  const result = parsePass1Result(sampleChunk, null, 0)
  expect(result.chunk_hash).toBe(sampleChunk.chunk_hash)
})
