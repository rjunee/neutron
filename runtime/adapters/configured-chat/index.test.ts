import { expect, test } from 'bun:test'
import { createConfiguredChatSubstrate, type ConfiguredChatOptions } from './index.ts'
import { configuredModels, projectModelTier } from '../../configured-models.ts'
import type { AgentSpec } from '../../substrate.ts'

const row = { tier: 'glm', provider: 'zai', model: 'glm-test', endpoint: 'http://127.0.0.1/chat/completions', credential: 'MODEL_TEST_KEY' }
const env = { NEUTRON_REVIEW_SEATS: JSON.stringify([row]), MODEL_TEST_KEY: 'test-secret' }
const spec: AgentSpec = { prompt: 'hello', tools: [], model_preference: ['claude-unused'] }
function chunk(delta: unknown = { content: 'answer' }, finish: string | null = 'stop') {
  return { model: row.model, choices: [{ index: 0, delta, finish_reason: finish }] }
}
function response(chunks: unknown[] = [chunk()], done = true) {
  const bytes = new TextEncoder().encode(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : ''))
  // Split every byte, including UTF-8 and SSE delimiters.
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
    controller.close()
  } }))
}
function opts(overrides: Partial<ConfiguredChatOptions> = {}): ConfiguredChatOptions {
  return { tier: row.tier, env, substrate_instance_id: 'test', resolver: async () => 'ok',
    fetchImpl: (async () => response()) as unknown as typeof fetch, ...overrides }
}
async function run(options = opts(), input = spec) {
  return Array.fromAsync(createConfiguredChatSubstrate(options).start(input).events)
}
const tool = { name: 'lookup', description: 'lookup', input_schema: {}, output_schema: {}, capability_required: 'fs:project_data' as const }
function toolChunk(name = 'lookup', id = 'call-1', args = '{}', index = 0) {
  return chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] }, 'tool_calls')
}

test('configured row sends exact endpoint, credential, model and history; streams UTF-8', async () => {
  let body: any
  const events = await run(opts({ fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe(row.endpoint)
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer test-secret')
    expect(init!.redirect).toBe('error')
    body = JSON.parse(String(init!.body))
    return response([chunk({ content: '你好' }), { model: row.model, choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }])
  }) as unknown as typeof fetch }), { ...spec, messages: [{ role: 'user', content: 'earlier' }], max_tokens: 42 })
  expect(body).toMatchObject({ model: row.model, stream: true, max_tokens: 42,
    messages: [{ role: 'user', content: 'earlier' }, { role: 'user', content: 'hello' }] })
  expect(events).toEqual([{ kind: 'token', text: '你好' }, { kind: 'completion', substrate_instance_id: 'test', usage: { input_tokens: 4, output_tokens: 2 } }])
})

test('tool execution continues on the same model with assistant calls and tool results', async () => {
  const bodies: any[] = []
  const calls: unknown[] = []
  const events = await run(opts({ resolver: async (call) => { calls.push(call); return { found: 1 } }, fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init!.body)))
    return bodies.length === 1 ? response([toolChunk()]) : response()
  }) as unknown as typeof fetch }), { ...spec, tools: [tool] })
  expect(calls).toEqual([{ call_id: 'call-1', tool_name: 'lookup', args: {} }])
  expect(bodies.map((b) => b.model)).toEqual([row.model, row.model])
  expect(bodies[1].messages.slice(-2)).toEqual([
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '{"found":1}' },
  ])
  expect(events.at(-1)?.kind).toBe('completion')
})

for (const [name, chunks, done] of [
  ['wrong model', [{ ...chunk(), model: 'other' }], true],
  ['missing model', [{ choices: chunk().choices }], true],
  ['missing DONE', [chunk()], false],
  ['missing finish', [chunk({}, null)], true],
  ['length limit', [chunk({}, 'length')], true],
  ['tool calls disguised as stop', [{ ...toolChunk(), choices: [{ ...toolChunk().choices[0], finish_reason: 'stop' }] }], true],
  ['missing choices', [{ model: row.model }], true],
  ['multiple choices', [{ model: row.model, choices: [...chunk().choices, ...chunk().choices] }], true],
  ['bad usage', [chunk(), { model: row.model, choices: [], usage: { prompt_tokens: 'secret', completion_tokens: 2 } }], true],
  ['late delta', [chunk(), chunk()], true],
  ['wrong choice index', [{ model: row.model, choices: [{ ...chunk().choices[0], index: 1 }] }], true],
  ['missing delta', [{ model: row.model, choices: [{ index: 0, finish_reason: 'stop' }] }], true],
  ['invalid content', [chunk({ content: 12 })], true],
  ['invalid call index', [toolChunk('lookup', 'id', '{}', -1)], true],
  ['undeclared tool', [toolChunk('undeclared')], true],
  ['missing call id', [toolChunk('lookup', '')], true],
  ['invalid tool arguments', [toolChunk('lookup', 'id', '{')], true],
  ['empty tool batch', [chunk({}, 'tool_calls')], true],
  ['duplicate call id', [chunk({ tool_calls: [
    { index: 0, id: 'same', function: { name: 'lookup', arguments: '{}' } },
    { index: 1, id: 'same', function: { name: 'lookup', arguments: '{}' } },
  ] }, 'tool_calls')], true],
] as const) {
  test(`refuses ${name} by model name before tools execute`, async () => {
    let calls = 0
    let requests = 0
    const events = await run(opts({ resolver: async () => { calls++; return 'wrong' },
      fetchImpl: (async () => ++requests === 1 ? response([...chunks], done) : response()) as unknown as typeof fetch }), { ...spec, tools: [tool] })
    expect(events.at(-1)).toMatchObject({ kind: 'error', retryable: false, message: expect.stringContaining(row.model) })
    expect(events.some((e) => e.kind === 'completion')).toBe(false)
    expect(calls).toBe(0)
  })
}

test('unknown model refuses without contacting a provider', async () => {
  let count = 0
  const events = await run(opts({ tier: 'unknown', fetchImpl: (async () => { count++; return response() }) as unknown as typeof fetch }))
  expect(events).toEqual([{ kind: 'error', code: 'spawn_configuration', retryable: false, message: 'configured model unknown: unknown configured model' }])
  expect(count).toBe(0)
})
test('missing credential refuses without contacting a provider', async () => {
  let count = 0
  const events = await run(opts({ env: { ...env, MODEL_TEST_KEY: '' }, fetchImpl: (async () => { count++; return response() }) as unknown as typeof fetch }))
  expect(events[0]).toMatchObject({ kind: 'error', code: 'no_credentials', message: expect.stringContaining(row.model) })
  expect(count).toBe(0)
})
test('HTTP error cannot turn a valid completion body into success', async () => {
  const events = await run(opts({ fetchImpl: (async () => new Response(await response().text(), { status: 401 })) as unknown as typeof fetch }))
  expect(events).toEqual([{ kind: 'error', code: 'http_status', retryable: false, message: `configured model ${row.model}: HTTP 401` }])
})
test('tool round limit stops requests without model fallback', async () => {
  let requests = 0
  const events = await run(opts({ maxToolRounds: 0, fetchImpl: (async () => { requests++; return requests === 1 ? response([toolChunk()]) : response() }) as unknown as typeof fetch }), { ...spec, tools: [tool] })
  expect(events.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('tool round limit') })
  expect(requests).toBe(1)
})
test('cancellation before tool dispatch prevents side effects', async () => {
  let calls = 0
  const handle = createConfiguredChatSubstrate(opts({ resolver: async () => { calls++; return 'bad' },
    fetchImpl: (async () => response([toolChunk()])) as unknown as typeof fetch })).start({ ...spec, tools: [tool] })
  await handle.cancel()
  expect((await Array.fromAsync(handle.events)).at(-1)).toMatchObject({ kind: 'error', code: 'aborted' })
  expect(calls).toBe(0)
})
test('transport and tool exceptions never echo secrets', async () => {
  const events = await run(opts({ fetchImpl: (async () => { throw new Error('test-secret') }) as unknown as typeof fetch }))
  expect(events[0]?.kind).toBe('error')
  expect(JSON.stringify(events)).not.toContain('test-secret')
})
test('oversized unfinished SSE line refuses', async () => {
  const events = await run(opts({ fetchImpl: (async () => new Response(':' + 'x'.repeat(1_048_577) + '\n\n' + await response().text())) as unknown as typeof fetch }))
  expect(events.at(-1)?.kind).toBe('error')
})
test('project routes are scoped, live and keep an unknown tier selected for refusal', () => {
  const config = { NEUTRON_PROJECT_MODELS: '{"one":"glm","two":"unknown"}' }
  expect(projectModelTier(config, 'one')).toBe('glm')
  expect(projectModelTier(config, 'two')).toBe('unknown')
  expect(projectModelTier(config, 'toString')).toBeUndefined()
  expect(projectModelTier(config)).toBeUndefined()
  config.NEUTRON_PROJECT_MODELS = '{"one":"deepseek"}'
  expect(projectModelTier(config, 'one')).toBe('deepseek')
  expect(projectModelTier({}, 'one')).toBeUndefined()
  expect(configuredModels(env)[0]).toEqual(row)
})
for (const raw of ['null', '[]', '{"one":""}', '{"one":7}', 'broken']) {
  test(`invalid project mapping ${raw} refuses`, () => expect(() => projectModelTier({ NEUTRON_PROJECT_MODELS: raw }, 'one')).toThrow())
}

for (const [provider, model] of [['moonshot', 'kimi-test'], ['zai', 'glm-test'], ['deepseek', 'deepseek-test']]) {
  test(`configuration alone reaches ${provider} chat`, async () => {
    const configured = { ...row, provider, model }
    const events = await run(opts({ env: { ...env, NEUTRON_REVIEW_SEATS: JSON.stringify([configured]) },
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init!.body)).model).toBe(model)
        return response([{ ...chunk(), model }])
      }) as unknown as typeof fetch,
    }))
    expect(events.at(-1)?.kind).toBe('completion')
  })
}
