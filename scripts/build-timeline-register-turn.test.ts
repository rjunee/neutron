import { afterEach, expect, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerNativeTurn } from './build-timeline-register-turn.ts'
import { importCodexFile } from './build-timeline-codex-import.ts'
import { appendChangedPhaseObservations } from './build-timeline-sources.ts'
import { createTimelineHandler, timelineSourceReader } from './build-timeline-server.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const row = (type: string, payload: object) => JSON.stringify({ type, timestamp: '2026-09-28T00:00:00Z', payload }) + '\n'
const start = Date.parse('2026-09-28T00:00:00Z') / 1000
async function fixture(child = false) {
  const dir = await mkdtemp(join(tmpdir(), 'native-register-')); dirs.push(dir)
  const options = { config: join(dir, 'config.json'), rollout: join(dir, 'private-transcript.jsonl'), observations: join(dir, 'phases.jsonl'),
    binding: { sessionId: 'session-1', turnId: 'turn-1', phase: 'build' as const, links: [{ repository: 'example/project', prNumber: 7 }] } }
  await writeFile(options.config, JSON.stringify({ repositories: ['example/project'], evidenceRef: 'codex:fixture' }))
  await writeFile(options.rollout, row('session_meta', { id: 'session-1', ...(child ? { source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } } } : {}) }) +
    row('turn_context', { turn_id: 'turn-1', model: 'model-a' }) + row('response_item', { text: 'private transcript marker' }))
  return options
}
async function complete(options: Awaited<ReturnType<typeof fixture>>, tokens = true) {
  await appendFile(options.rollout, (tokens ? row('token_usage_record', { thread_id: 'session-1', turn_id: 'turn-1',
    turn_token_usage: { input_tokens: 20, output_tokens: 3, cached_input_tokens: 5 } }) : '') +
    row('event_msg', { type: 'task_complete', turn_id: 'turn-1', started_at: start, completed_at: start + 9 }))
}

test('manual active registration reaches the actual authenticated dashboard only upon native completion, for root and child tasks', async () => {
  for (const child of [false, true]) for (const phase of ['build', 'fix', 'review', 'test'] as const) {
    const options = await fixture(child)
    const binding = { ...options.binding, phase }
    expect(await registerNativeTurn({ ...options, binding })).toBe('registered')
    expect((await stat(options.config)).mode & 0o777).toBe(0o600)
    const config = JSON.parse(await readFile(options.config, 'utf8'))
    expect((await importCodexFile(options.rollout, config)).observations).toEqual([])
    await complete(options)
    const imported = await importCodexFile(options.rollout, config)
    expect(imported.observations).toHaveLength(1)
    expect(imported.observations[0]!.source.parentSessionId).toBe(child ? 'parent-1' : undefined)
    await appendChangedPhaseObservations(options.observations, imported.observations)
    const handler = createTimelineHandler({ username: 'viewer', password: 'fixture', read: timelineSourceReader({ observations: options.observations, databases: [] }) })
    const response = await handler(new Request('http://localhost/api/timeline', { headers: { authorization: `Basic ${Buffer.from('viewer:fixture').toString('base64')}` } }))
    expect(response.status).toBe(200)
    const text = await response.text(), data = JSON.parse(text)
    expect(data.cards[0].pr).toBe(7)
    expect(data.cards[0].segments[0]).toMatchObject({ phase, model: 'model-a', start: start * 1000, end: (start + 9) * 1000,
      usage: { input: 15, output: 3, cacheRead: 5, costUsd: null, tokens: 23, coverage: 'partial' } })
    expect(text).not.toContain('private transcript marker')
    expect(text).not.toContain(options.rollout)
  }
})

test('wrong session, wrong turn, wrong repository and duplicate links refuse without changing configuration; positive control succeeds', async () => {
  const options = await fixture()
  const before = await readFile(options.config, 'utf8')
  for (const binding of [ { ...options.binding, sessionId: 'other' }, { ...options.binding, turnId: 'other' },
    { ...options.binding, links: [{ repository: 'example/foreign', prNumber: 7 }] },
    { ...options.binding, links: [...options.binding.links, ...options.binding.links] } ]) {
    await expect(registerNativeTurn({ ...options, binding })).rejects.toThrow()
    expect(await readFile(options.config, 'utf8')).toBe(before)
  }
  await complete(options)
  expect((await importCodexFile(options.rollout, JSON.parse(before))).observations).toEqual([])
  expect(await registerNativeTurn(options)).toBe('registered')
  expect((await importCodexFile(options.rollout, JSON.parse(await readFile(options.config, 'utf8')))).observations).toHaveLength(1)
})

test('repeated registration is idempotent; reassignment refuses and journal bytes remain immutable', async () => {
  const options = await fixture()
  await writeFile(options.observations, 'existing private journal bytes\n')
  await registerNativeTurn(options)
  const before = await readFile(options.config, 'utf8')
  expect(await registerNativeTurn(options)).toBe('already-registered')
  for (const binding of [{ ...options.binding, phase: 'fix' as const }, { ...options.binding, links: [{ repository: 'example/project', prNumber: 8 }] }]) {
    await expect(registerNativeTurn({ ...options, binding })).rejects.toThrow('immutable')
  }
  expect(await readFile(options.config, 'utf8')).toBe(before)
  expect(await readFile(options.observations, 'utf8')).toBe('existing private journal bytes\n')
})

test('refresh lock refuses registration and cannot be removed by the rejected caller; missing usage remains unknown', async () => {
  const options = await fixture()
  const before = await readFile(options.config, 'utf8')
  await writeFile(options.observations + '.lock', 'refresh holds lock')
  await expect(registerNativeTurn(options)).rejects.toThrow()
  expect(await readFile(options.config, 'utf8')).toBe(before)
  expect(await readFile(options.observations + '.lock', 'utf8')).toBe('refresh holds lock')
  await rm(options.observations + '.lock')
  await registerNativeTurn(options)
  await complete(options, false)
  expect((await importCodexFile(options.rollout, JSON.parse(await readFile(options.config, 'utf8')))).observations[0]).toMatchObject({ inputTokens: null, outputTokens: null })
})

test('CLI refuses malformed source with generic diagnostics that do not expose private paths', async () => {
  const options = await fixture()
  await appendFile(options.rollout, 'unfinished native record')
  const bindingFile = options.config + '.binding'
  await writeFile(bindingFile, JSON.stringify(options.binding))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'build-timeline-register-turn.ts'), options.config, options.rollout, options.observations, bindingFile], { stdout: 'pipe', stderr: 'pipe' })
  expect(await child.exited).toBe(1)
  const stderr = await new Response(child.stderr).text()
  expect(stderr).toContain('registration refused')
  expect(stderr).not.toContain(options.rollout)
  expect(JSON.parse(await readFile(options.config, 'utf8')).turnBindings).toBeUndefined()
})
