import { expect, test } from 'bun:test'
import { codexBuildObservation } from './codex-build-observation.ts'

const start = { type: 'thread.started', thread_id: 'owned-thread' }
const done = { type: 'turn.completed', usage: { input_tokens: 13, output_tokens: 2, cached_input_tokens: 9 } }
test('partial failed turns retain deduplicated provider usage without authorizing completion', () => {
  const reader = codexBuildObservation('owned-thread')
  reader.push(JSON.stringify(start) + '\n')
  const failure = { ...done, type: 'turn.failed', model: 'reported' }
  reader.push(JSON.stringify(failure) + '\n' + JSON.stringify(failure))
  expect(reader.finish()).toBeNull()
  expect(reader.snapshot(1, 2)).toMatchObject({ model_reported: 'reported', thread_id: 'owned-thread',
    usage: { input_tokens: 4, cache_read_input_tokens: 9, output_tokens: 2 } })
  expect(reader.snapshot(1, 2)).toEqual(reader.snapshot(1, 2))
})
test('wrong-thread and pre-thread usage is not attributed, legitimate zero remains zero', () => {
  const wrong = codexBuildObservation('expected')
  wrong.push(JSON.stringify(start) + '\n' + JSON.stringify(done) + '\n')
  expect(wrong.snapshot(1, 2).usage.input_tokens).toBeNull()
  const early = codexBuildObservation(null)
  early.push(JSON.stringify(done) + '\n' + JSON.stringify(start) + '\n')
  expect(early.snapshot(1, 2).usage.input_tokens).toBeNull()
  const valid = codexBuildObservation(null)
  valid.push(JSON.stringify(start) + '\n' + JSON.stringify({ type: 'turn.failed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } }) + '\n')
  expect(valid.snapshot(1, 2).usage).toMatchObject({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 })
})
test('duplicate or older usage cannot double-charge or erase earlier accepted-thread spend', () => {
  const reader = codexBuildObservation('owned-thread')
  reader.push(JSON.stringify(start) + '\n' + JSON.stringify(done) + '\n')
  const observed = reader.snapshot(1, 2)
  reader.push(JSON.stringify(done) + '\n' + JSON.stringify({ ...done, usage: { input_tokens: 1, output_tokens: 0, cached_input_tokens: 0 } }) + '\n')
  expect(reader.snapshot(1, 2)).toEqual(observed)
  reader.push(JSON.stringify({ type: 'thread.started', thread_id: 'foreign' }) + '\n' + JSON.stringify({ ...done, usage: { input_tokens: 1000, output_tokens: 1000, cached_input_tokens: 1000 } }) + '\n')
  expect(reader.snapshot(1, 2)).toEqual(observed)
  expect(reader.finish()).toBeNull()
})
function observe(events: unknown[], requested: string | null = null) {
  const reader = codexBuildObservation(requested)
  // Fragmented reads exercise the actual pipe boundary.
  const bytes = events.map(event => JSON.stringify(event) + '\n').join('')
  for (let i = 0; i < bytes.length; i += 7) reader.push(bytes.slice(i, i + 7))
  return reader.finish()
}
test('first call captures provider identity; exact resume accepts the same identity', () => {
  for (const requested of [null, 'owned-thread']) expect(observe([start, done], requested)).toEqual({
    thread_id: 'owned-thread', usage: { input_tokens: 13, output_tokens: 2, cache_read_input_tokens: 9 }, model_reported: null,
  })
})
test('foreign, missing, duplicate and failed observations cannot authorize completion', () => {
  expect(observe([start, done], 'newest-decoy')).toBeNull()
  for (const events of [[done], [start], [done, start], [start, start, done], [start, done, done],
    [start, { type: 'turn.failed' }, done], [start, { type: 'error' }, done],
    [{ type: 'item.completed', item: { text: JSON.stringify(start) } }, done]]) expect(observe(events)).toBeNull()
})
test('missing usage is unknown while measured zero and reported model survive', () => {
  for (const usage of [undefined, { input_tokens: -1, output_tokens: 4 }, { input_tokens: '13', output_tokens: 4 }]) {
    expect(observe([start, { type: 'turn.completed', usage }])?.usage).toBeNull()
  }
  expect(observe([start, { type: 'turn.completed', model: 'reported-model', usage: { input_tokens: 0, output_tokens: 0 } }]))
    .toMatchObject({ usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'reported-model' })
})
test('malformed protocol and unfinished event tails stay unknown', () => {
  for (const tail of ['not json\n', '{"type":', 'null\n']) {
    const reader = codexBuildObservation(null)
    reader.push(JSON.stringify(start) + '\n' + JSON.stringify(done) + '\n' + tail)
    expect(reader.finish()).toBeNull()
  }
})
