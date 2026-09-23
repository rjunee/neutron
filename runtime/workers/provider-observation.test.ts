import { expect, test } from 'bun:test'
import { claudeObservation, codexObservation, readProviderObservation } from './provider-observation.ts'

test('Codex cached tokens are a subset, not additional input spend', () => {
  expect(codexObservation({ input_tokens: 17, cached_input_tokens: 11, output_tokens: 3 }, 'thread', 10, 20)).toEqual({
    source: 'codex-cli-jsonl', started_at_ms: 10, finished_at_ms: 20, observed_at_ms: 20,
    model_reported: null, thread_id: 'thread', usage: { input_tokens: 6, output_tokens: 3,
      cache_read_input_tokens: 11, cache_creation_input_tokens: null, cost_usd: null },
  })
  expect(codexObservation({ input_tokens: 17, cached_input_tokens: 18 }, null, 10, 20).usage).toMatchObject({
    input_tokens: null, cache_read_input_tokens: null,
  })
})

test('missing counts remain unknown, explicit zero remains zero, partial output survives', () => {
  expect(codexObservation(undefined, null, 10, 20).usage).toEqual({ input_tokens: null, output_tokens: null,
    cache_read_input_tokens: null, cache_creation_input_tokens: null, cost_usd: null })
  expect(codexObservation({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, null, 10, 20).usage)
    .toMatchObject({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 })
  expect(codexObservation({ input_tokens: 17, output_tokens: 3 }, null, 10, 20).usage)
    .toMatchObject({ input_tokens: null, output_tokens: 3, cache_read_input_tokens: null })
  expect(codexObservation({ cached_input_tokens: 11 }, null, 10, 20).usage)
    .toMatchObject({ input_tokens: null, output_tokens: null, cache_read_input_tokens: 11 })
})

test('Claude native categories are disjoint and provider cost is retained without pricing', () => {
  const observation = claudeObservation(JSON.stringify({ type: 'result', session_id: 'observed',
    modelUsage: { 'reported-model': {} }, total_cost_usd: 0,
    usage: { input_tokens: 17, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 5 } }), 10, 20)
  expect(observation).toMatchObject({ model_reported: 'reported-model', thread_id: 'observed', usage: {
    input_tokens: 17, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 5, cost_usd: 0,
  } })
})

test('result payloads, malformed output and invalid counts cannot invent provider measurements', () => {
  for (const bytes of ['{', JSON.stringify({ usage: { input_tokens: 99 } }),
    JSON.stringify({ type: 'result', structured_output: { usage: { input_tokens: 99 } } }),
    JSON.stringify({ type: 'result', usage: { input_tokens: -1, output_tokens: 1.5 }, total_cost_usd: -1 })]) {
    expect(claudeObservation(bytes, 10, 20).usage).toEqual({ input_tokens: null, output_tokens: null,
      cache_read_input_tokens: null, cache_creation_input_tokens: null, cost_usd: null })
  }
})

test('host observation recovery refuses corruption with a valid persisted positive control', () => {
  const value = codexObservation({ input_tokens: 17, output_tokens: 3, cached_input_tokens: 11 }, 'thread', 10, 20)
  expect(readProviderObservation(JSON.stringify(value), 'codex-cli-jsonl')).toEqual(value)
  for (const corrupt of [{ ...value, started_at_ms: 21 }, { ...value, source: 'claude-cli-json' },
    { ...value, usage: {} }, { ...value, thread_id: 12 }, { ...value, usage: { ...value.usage, input_tokens: -1 } }]) {
    expect(readProviderObservation(JSON.stringify(corrupt), 'codex-cli-jsonl')).toBeUndefined()
  }
})
