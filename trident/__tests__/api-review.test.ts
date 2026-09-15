import { afterEach, expect, test } from 'bun:test'
import { reviewConfiguredSeat } from '../api-review.ts'
import { configuredReviewSeats, modelTierRegistry } from '../model-tiers.ts'

const previous = process.env['NEUTRON_REVIEW_SEATS']
const previousKey = process.env['REVIEW_TEST_KEY']
afterEach(() => {
  if (previous === undefined) delete process.env['NEUTRON_REVIEW_SEATS']
  else process.env['NEUTRON_REVIEW_SEATS'] = previous
  if (previousKey === undefined) delete process.env['REVIEW_TEST_KEY']
  else process.env['REVIEW_TEST_KEY'] = previousKey
})
const row = { tier: 'glm-review', provider: 'zai', model: 'glm-review-model',
  endpoint: 'http://127.0.0.1/completions', credential: 'REVIEW_TEST_KEY' }
function setup(rows: unknown = [row]) {
  process.env['NEUTRON_REVIEW_SEATS'] = JSON.stringify(rows)
  process.env['REVIEW_TEST_KEY'] = 'test-secret'
}
type ReviewFetch = NonNullable<Parameters<typeof reviewConfiguredSeat>[3]>
function reply(body: unknown, status = 200): ReviewFetch {
  return (async () => new Response(JSON.stringify(body), { status })) as ReviewFetch
}
const answer = { model: row.model, choices: [{ message: { content: 'VERDICT: APPROVE' } }] }

test('configuration alone routes a new provider and preserves the Kimi row', async () => {
  setup()
  const seats = modelTierRegistry()
  expect(seats.find((seat) => seat.tier === row.tier)).toMatchObject({ provider: 'zai', group: 'api', model_id: row.model })
  expect(seats.find((seat) => seat.tier === 'k3')?.wrapper).toBe('trident/kimi-review-cli.ts')
  let calls = 0
  const result = await reviewConfiguredSeat(row.tier, '+changed', 'review', (async (url, init) => {
    calls++
    expect(url).toBe(row.endpoint)
    expect(JSON.parse(String(init?.body)).model).toBe(row.model)
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-secret')
    expect(init?.redirect).toBe('error')
    return new Response(JSON.stringify(answer))
  }) as ReviewFetch)
  expect(calls).toBe(1)
  expect(result).toEqual({ status: 'connected', text: 'VERDICT: APPROVE' })
})

test('missing credentials refuse the requested model by name without a request', async () => {
  setup()
  delete process.env['REVIEW_TEST_KEY']
  let calls = 0
  const result = await reviewConfiguredSeat(row.tier, '+changed', 'review', (async () => {
    calls++
    return new Response(JSON.stringify(answer))
  }) as ReviewFetch)
  expect(result.status).toBe('deferred')
  expect(result.reason).toContain(row.model)
  expect(result.reason).toContain('missing credential')
  expect(calls).toBe(0)
})

test('unknown tier refuses by name', async () => {
  setup()
  expect(await reviewConfiguredSeat('unknown-review', '+changed', 'review', reply(answer))).toMatchObject({
    status: 'deferred', reason: 'review seat unknown-review: unknown configured model',
  })
})

test('empty diff refuses even when the provider would return approval', async () => {
  setup()
  expect((await reviewConfiguredSeat(row.tier, ' ', 'review', reply(answer))).status).toBe('deferred')
})

for (const [name, body, status] of [
  ['HTTP failure', answer, 401],
  ['different response model', { ...answer, model: 'another-model' }, 200],
  ['missing response model', { choices: answer.choices }, 200],
  ['empty answer', { model: row.model, choices: [{ message: { content: ' ' } }] }, 200],
  ['missing answer', { model: row.model }, 200],
] as const) {
  test(`${name} refuses by model name`, async () => {
    setup()
    const result = await reviewConfiguredSeat(row.tier, '+changed', 'review', reply(body, status))
    expect(result.status).toBe('deferred')
    expect(result.reason).toContain(row.model)
    expect(result.text).toBe('')
  })
}

test('network exceptions refuse without echoing key material', async () => {
  setup()
  const result = await reviewConfiguredSeat(row.tier, '+changed', 'review', (async () => {
    throw new Error('test-secret')
  }) as ReviewFetch)
  expect(result.status).toBe('deferred')
  expect(result.reason).toContain(row.model)
  expect(JSON.stringify(result)).not.toContain('test-secret')
})

for (const [name, rows] of [
  ['non-array', {}], ['null row', [null]], ['missing model', [{ ...row, model: undefined }]],
  ['empty provider', [{ ...row, provider: ' ' }]], ['control character', [{ ...row, model: 'bad\nmodel' }]],
  ['duplicate tier', [row, row]], ['built-in tier', [{ ...row, tier: 'k3' }]],
  ['invalid credential reference', [{ ...row, credential: 'key value' }]],
  ['invalid endpoint', [{ ...row, endpoint: 'broken' }]],
  ['unsafe endpoint protocol', [{ ...row, endpoint: 'file:///review' }]],
  ['endpoint query', [{ ...row, endpoint: row.endpoint + '?key=value' }]],
] as const) {
  test(`configuration refuses ${name}`, () => {
    setup(rows)
    expect(() => configuredReviewSeats()).toThrow('review seat')
  })
}

test('invalid JSON refuses configuration', () => {
  process.env['NEUTRON_REVIEW_SEATS'] = '{'
  expect(() => configuredReviewSeats()).toThrow('invalid NEUTRON_REVIEW_SEATS JSON')
})

test('CLI emits named refusal with blocking exit 3 for a missing credential', async () => {
  setup()
  delete process.env['REVIEW_TEST_KEY']
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const dir = mkdtempSync('/tmp/review-seat-test-')
  try {
    writeFileSync(`${dir}/change.diff`, '+changed')
    const child = Bun.spawnSync([process.execPath, 'trident/api-review-cli.ts', row.tier, `${dir}/change.diff`], { env: process.env })
    expect(child.exitCode).toBe(3)
    expect(child.stderr.toString()).toContain(row.model)
    expect(child.stdout.toString()).toBe('')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('CLI executes a configured endpoint and emits the provider review', async () => {
  setup()
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const dir = mkdtempSync('/tmp/review-seat-test-')
  try {
    // Subprocess transport fixture: the sandbox cannot bind a listening socket.
    writeFileSync(`${dir}/transport.ts`, `globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body)
      if (url !== ${JSON.stringify(row.endpoint)} || body.model !== ${JSON.stringify(row.model)}) {
        return new Response('', { status: 400 })
      }
      return Response.json(${JSON.stringify(answer)})
    }`)
    writeFileSync(`${dir}/change.diff`, '+changed')
    const child = Bun.spawn([process.execPath, '--preload', `${dir}/transport.ts`, 'trident/api-review-cli.ts', row.tier, `${dir}/change.diff`], {
      env: process.env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe('VERDICT: APPROVE')
    expect(await new Response(child.stderr).text()).toBe('')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('CLI invocation errors retain the named blocking exit', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const dir = mkdtempSync('/tmp/review-seat-test-')
  try {
    const child = Bun.spawnSync([process.execPath, 'trident/api-review-cli.ts', 'missing-model', `${dir}/unwritten.diff`])
    expect(child.exitCode).toBe(3)
    expect(child.stderr.toString()).toContain('review seat missing-model: configuration or invocation failed')
    expect(child.stdout.toString()).toBe('')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
