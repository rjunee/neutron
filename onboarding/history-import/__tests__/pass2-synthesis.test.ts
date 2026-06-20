/**
 * Pass-2 synthesis tests — aggregation correctness + parse + dedupe.
 */

import { expect, test } from 'bun:test'
import {
  aggregatePass1,
  parsePass2Result,
  pass2Synthesize,
  type Pass2LlmCall,
} from '../pass2-synthesis.ts'
import type { Pass1ChunkResult } from '../types.ts'

const baseChunk: Pass1ChunkResult = {
  chunk_hash: 'h',
  candidate_entities: [],
  candidate_topics: [],
  candidate_tasks: [],
  voice_signals: {},
  dollars_billed: 0.05,
}

test('aggregatePass1 dedupes entities by canonical-name (case-insensitive)', () => {
  const r: Pass1ChunkResult[] = [
    {
      ...baseChunk,
      candidate_entities: [{ name: 'Casey', kind: 'person', mention_count: 3 }],
    },
    {
      ...baseChunk,
      candidate_entities: [{ name: 'casey', kind: 'person', mention_count: 4 }],
    },
  ]
  const agg = aggregatePass1(r)
  expect(agg.entities.length).toBe(1)
  expect(agg.entities[0]?.name).toBe('Casey')
  expect(agg.entities[0]?.mention_count).toBe(7)
})

test('aggregatePass1 sums topic recurrence_score on overlap', () => {
  const r: Pass1ChunkResult[] = [
    {
      ...baseChunk,
      candidate_topics: [{ name: 'Topline pipeline', summary: 'first' }],
    },
    {
      ...baseChunk,
      candidate_topics: [{ name: 'topline pipeline', summary: 'second' }],
    },
    {
      ...baseChunk,
      candidate_topics: [{ name: 'Topline Pipeline', summary: 'third' }],
    },
  ]
  const agg = aggregatePass1(r)
  expect(agg.topics.length).toBe(1)
  expect(agg.topics[0]?.recurrence_score).toBe(3)
  expect(agg.topics[0]?.summaries.length).toBe(3)
})

test('aggregatePass1 ranks topics by recurrence then recency', () => {
  const r: Pass1ChunkResult[] = [
    {
      ...baseChunk,
      candidate_topics: [
        { name: 'Old', summary: 's', recency_at: 1_000_000 },
        { name: 'Fresh', summary: 's', recency_at: 100_000_000 },
      ],
    },
    {
      ...baseChunk,
      candidate_topics: [
        { name: 'Old', summary: 's', recency_at: 1_000_000 },
        { name: 'Old', summary: 's', recency_at: 1_000_000 },
      ],
    },
  ]
  const agg = aggregatePass1(r)
  expect(agg.topics[0]?.name).toBe('Old')
  expect(agg.topics[0]?.recurrence_score).toBe(3)
  // recency normalized 0..1 against most-recent
  expect(agg.topics[1]?.recency_score).toBe(1)
})

test('aggregatePass1 dedupes tasks by lowercase title', () => {
  const r: Pass1ChunkResult[] = [
    { ...baseChunk, candidate_tasks: [{ title: 'Reply to Priya' }] },
    { ...baseChunk, candidate_tasks: [{ title: 'reply to priya' }] },
    { ...baseChunk, candidate_tasks: [{ title: 'Different task' }] },
  ]
  const agg = aggregatePass1(r)
  expect(agg.tasks.length).toBe(2)
})

test('aggregatePass1 picks most-frequent voice dimension', () => {
  const r: Pass1ChunkResult[] = [
    { ...baseChunk, voice_signals: { tone: 'terse', verbosity: 'low' } },
    { ...baseChunk, voice_signals: { tone: 'terse', verbosity: 'low' } },
    { ...baseChunk, voice_signals: { tone: 'expansive', verbosity: 'high' } },
  ]
  const agg = aggregatePass1(r)
  expect(agg.voice_signals.tone).toBe('terse')
  expect(agg.voice_signals.verbosity).toBe('low')
})

test('parsePass2Result parses a full LLM response', () => {
  const aggregated = aggregatePass1([baseChunk])
  const raw = JSON.stringify({
    proposed_projects: [
      { name: 'Topline', rationale: 'recurring', suggested_topics: ['sales'] },
    ],
    proposed_tasks: [{ title: 'Do thing', priority_hint: 'P2' }],
    proposed_reminders: [{ pattern: 'every Monday at 09:00', body: 'review' }],
    voice_signals: { tone: 'terse' },
    facts: { user_role: 'CEO', companies: ['Topline'], key_people: ['Casey'] },
  })
  const result = parsePass2Result(raw, aggregated)
  expect(result.proposed_projects.length).toBe(1)
  expect(result.proposed_tasks.length).toBe(1)
  expect(result.proposed_reminders.length).toBe(1)
  expect(result.facts.user_role).toBe('CEO')
})

test('parsePass2Result on null falls back to aggregated-only', () => {
  const aggregated = aggregatePass1([
    {
      ...baseChunk,
      candidate_entities: [{ name: 'X', kind: 'person', mention_count: 1 }],
      candidate_tasks: [{ title: 'Do thing' }],
    },
  ])
  const result = parsePass2Result(null, aggregated)
  expect(result.entities.length).toBe(1)
  expect(result.proposed_tasks.length).toBe(1)
  expect(result.proposed_projects).toEqual([])
})

test('pass2Synthesize calls the LLM and returns parsed result + cost', async () => {
  const fakeLlm: Pass2LlmCall = async () => ({
    result: { proposed_projects: [{ name: 'P', rationale: 'r' }], proposed_tasks: [], proposed_reminders: [] },
    dollars_billed: 0.5,
  })
  const aggregated = aggregatePass1([baseChunk])
  const out = await pass2Synthesize(aggregated, { llm: fakeLlm, prompt: '' })
  expect(out.dollars_billed).toBe(0.5)
  expect(out.result.proposed_projects.length).toBe(1)
})

// P2 v2 S5 — Pass-2 now emits two new optional fields per § 2.5: per-
// inference confidence scores + inferred non-work interests. The
// parser MUST accept the new shape AND gracefully handle the legacy
// shape (no new fields → undefined on the result).
test('parsePass2Result extracts confidence_by_inference (flat array)', () => {
  const aggregated = aggregatePass1([baseChunk])
  const raw = JSON.stringify({
    proposed_projects: [{ name: 'Topline', rationale: 'r' }],
    proposed_tasks: [],
    proposed_reminders: [],
    confidence_by_inference: [
      { field: 'project:Topline', score: 0.9, basis: 'many mentions' },
      { field: 'project:Studio Sessions', score: 0.34 },
      { field: 'interest:climbing', score: 0.78 },
    ],
  })
  const result = parsePass2Result(raw, aggregated)
  expect(result.confidence_by_inference).toBeDefined()
  expect(result.confidence_by_inference!.length).toBe(3)
  expect(result.confidence_by_inference![0]).toEqual({
    field: 'project:Topline',
    score: 0.9,
    basis: 'many mentions',
  })
})

test('parsePass2Result accepts grouped confidence shape with name+kind fallback', () => {
  const aggregated = aggregatePass1([baseChunk])
  const raw = JSON.stringify({
    proposed_projects: [{ name: 'Topline', rationale: 'r' }],
    proposed_tasks: [],
    proposed_reminders: [],
    confidence_by_inference: {
      projects: [{ name: 'Topline', score: 0.9, basis: 'x' }],
      interests: [{ name: 'climbing', score: 0.7 }],
    },
  })
  const result = parsePass2Result(raw, aggregated)
  expect(result.confidence_by_inference).toBeDefined()
  expect(result.confidence_by_inference!.length).toBe(2)
  const fields = result.confidence_by_inference!.map((c) => c.field)
  expect(fields).toContain('project:Topline')
  expect(fields).toContain('interest:climbing')
})

test('parsePass2Result extracts inferred_interests (object shape)', () => {
  const aggregated = aggregatePass1([baseChunk])
  const raw = JSON.stringify({
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    inferred_interests: [
      { name: 'climbing', basis: 'weekly mentions', cadence_hint: 'weekly' },
      { name: 'Buddhist study' },
    ],
  })
  const result = parsePass2Result(raw, aggregated)
  expect(result.inferred_interests).toBeDefined()
  expect(result.inferred_interests!.length).toBe(2)
  expect(result.inferred_interests![0]).toEqual({
    name: 'climbing',
    basis: 'weekly mentions',
    cadence_hint: 'weekly',
  })
  expect(result.inferred_interests![1]).toEqual({ name: 'Buddhist study' })
})

test('parsePass2Result accepts inferred_interests as plain strings', () => {
  const aggregated = aggregatePass1([baseChunk])
  const raw = JSON.stringify({
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    inferred_interests: ['climbing', 'wine'],
  })
  const result = parsePass2Result(raw, aggregated)
  expect(result.inferred_interests).toBeDefined()
  expect(result.inferred_interests!.map((i) => i.name)).toEqual(['climbing', 'wine'])
})

test('parsePass2Result drops malformed confidence entries silently (missing field / NaN score)', () => {
  const aggregated = aggregatePass1([baseChunk])
  const raw = JSON.stringify({
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    confidence_by_inference: [
      { field: 'project:Topline', score: 0.9 },
      { score: 0.5 }, // missing field — drop
      { field: 'project:Bad', score: 'not a number' }, // bad score — drop
      { field: 'project:Big', score: 1.5 }, // clamped to 1.0 (kept)
      'not an object', // drop
      { field: 'interest:Tiny', score: -0.5 }, // clamped to 0
    ],
  })
  const result = parsePass2Result(raw, aggregated)
  expect(result.confidence_by_inference!.length).toBe(3)
  const big = result.confidence_by_inference!.find((c) => c.field === 'project:Big')!
  expect(big.score).toBe(1.0)
  const tiny = result.confidence_by_inference!.find((c) => c.field === 'interest:Tiny')!
  expect(tiny.score).toBe(0)
})

test('parsePass2Result on legacy result (no new fields) leaves confidence_by_inference + inferred_interests undefined', () => {
  const aggregated = aggregatePass1([baseChunk])
  const raw = JSON.stringify({
    proposed_projects: [{ name: 'Topline', rationale: 'r' }],
    proposed_tasks: [],
    proposed_reminders: [],
  })
  const result = parsePass2Result(raw, aggregated)
  expect(result.confidence_by_inference).toBeUndefined()
  expect(result.inferred_interests).toBeUndefined()
})
