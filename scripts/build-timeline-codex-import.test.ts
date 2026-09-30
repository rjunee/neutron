import { describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCodexFile, importCodexOperations, type CodexImportOptions } from './build-timeline-codex-import.ts'
import { appendChangedPhaseObservations, readPhaseObservations, validatePhaseObservation } from './build-timeline-sources.ts'
import { combineTimelineSources } from '@neutronai/trident/build-timeline-catalogue.ts'
import { createTimelineHandler } from './build-timeline-server.ts'

const repo = 'example/project'
const options: CodexImportOptions = {
  repositories: [repo], evidenceRef: 'codex:fixture',
  bindings: [{ cwd: '/tmp/fixture-worktree', startedAt: 1000, endedAt: 10000, links: [{ repository: repo, prNumber: 7 }] }],
}
const record = (type: string, payload: object, at = 1000) => JSON.stringify({ type, timestamp: new Date(at).toISOString(), payload })
const meta = record('session_meta', { id: 'thread-1', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } } })
const context = (model = 'model-a', at = 1000, turn = 'turn-1') => record('turn_context', { turn_id: turn, model }, at)
function command(cmd = 'bun test example.test.ts', overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return record('event_msg', { type: 'item_completed', thread_id: 'thread-1', turn_id: 'turn-1', started_at_ms: 2000, completed_at_ms: 4000,
    item: { type: 'CommandExecution', id: 'exec-1', command: ['/bin/bash', '-lc', cmd], cwd: 'file:///tmp/fixture-worktree', status: 'completed', exit_code: 0, stdout: '', ...overrides }, ...payload }, 4000)
}
const run = (events: string[], opts = options) => importCodexOperations([meta, context(), ...events], opts)

describe('bounded native Codex operation reconstruction', () => {
  const task = (overrides: Record<string, unknown> = {}) => record('event_msg', {
    type: 'task_complete', turn_id: 'turn-1', started_at: 1, completed_at: 9, ...overrides,
  }, 9999)
  const turnOptions: CodexImportOptions = { ...options, turnBindings: [{
    sessionId: 'thread-1', turnId: 'turn-1', phase: 'build', links: [{ repository: repo, prNumber: 7 }],
  }] }
  const usage = (totals: Record<string, unknown> = { input_tokens: 25, output_tokens: 2, cached_input_tokens: 5 },
    identity: Record<string, unknown> = {}) => record('token_usage_record', {
      thread_id: 'thread-1', turn_id: 'turn-1', turn_token_usage: totals, ...identity,
    }, 8000)
  test('exact task registration also serves nested tests without a checkout binding or duplicate usage', async () => {
    const result = await run([command(), usage(), task()], { ...turnOptions, bindings: [] })
    expect(result.coverage.unbound).toBe(0)
    const snapshot = combineTimelineSources({ observedAt: 10000, repositories: [] }, result.observations, [], 10000)
    const handler = createTimelineHandler({ username: 'viewer', password: 'fixture', read: () => snapshot })
    const response = await handler(new Request('http://localhost/api/timeline', {
      headers: { authorization: `Basic ${Buffer.from('viewer:fixture').toString('base64')}` },
    }))
    expect(response.status).toBe(200)
    const data = await response.json() as typeof snapshot
    expect(data.cards).toHaveLength(1)
    expect(data.cards[0]!.pr).toBe(7)
    expect(data.cards[0]!.segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'test', start: 2000, end: 4000, model: 'model-a',
        usage: expect.objectContaining({ tokens: null, input: null, output: null }) }),
      expect.objectContaining({ phase: 'build', start: 1000, end: 9000,
        usage: expect.objectContaining({ tokens: 27, input: 20, output: 2, cacheRead: 5 }) }),
    ]))
    expect(data.cards[0]!.segments).toHaveLength(2)
  })
  test('nested test ownership refuses foreign turns and conflicting or ambiguous checkout evidence', async () => {
    const binding = turnOptions.turnBindings![0]!
    for (const opts of [
      { ...turnOptions, bindings: [], turnBindings: [{ ...binding, sessionId: 'foreign' }] },
      { ...turnOptions, bindings: [], turnBindings: [{ ...binding, turnId: 'foreign' }] },
      { ...turnOptions, bindings: [{ ...options.bindings![0]!, links: [{ repository: repo, prNumber: 8 }] }] },
      { ...turnOptions, bindings: [options.bindings![0]!, options.bindings![0]!] },
    ]) {
      const result = await run([command()], opts)
      expect(result.observations).toEqual([])
      expect(result.coverage.unbound).toBe(1)
    }
    expect((await run([command()], turnOptions)).observations[0]!.links).toEqual(binding.links)
    const shared = await run([command()], { ...turnOptions, bindings: [], turnBindings: [{
      ...binding, links: [...binding.links, { repository: repo, prNumber: 8 }],
    }] })
    expect(shared.observations).toHaveLength(1)
    expect(shared.observations[0]!.links).toHaveLength(2)
  })
  test('an exact native turn receipt supplies disjoint token fields and leaves unreported metrics unknown', async () => {
    const result = await run([command(), usage(), task()], turnOptions)
    expect(result.observations).toHaveLength(2)
    expect(result.observations[0]).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null })
    const turn = result.observations[1]!
    expect(validatePhaseObservation(turn)).toMatchObject({ model: 'model-a', inputTokens: 20, outputTokens: 2,
      cacheReadTokens: 5, cacheCreationTokens: null, costUsd: null })
    expect(result.coverage.tokenCoverage).toBe('partial')
    const snapshot = combineTimelineSources({ observedAt: 10000, repositories: [] }, [turn], [], 10000)
    expect(snapshot.cards[0]!.segments[0]!.usage).toMatchObject({ tokens: 27, coverage: 'partial', input: 20,
      output: 2, cacheRead: 5, cacheCreation: null, costUsd: null })
    const zero = (await run([usage({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }), task()], turnOptions)).observations[0]!
    expect(zero).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
  })
  test('missing, foreign, malformed and regressing usage never charge an attested task', async () => {
    const variants = [[], [usage(undefined, { thread_id: 'foreign' })], [usage(undefined, { turn_id: 'other' })],
      [usage(undefined, { thread_id: undefined })],
      [usage({ input_tokens: 4, output_tokens: 1, cached_input_tokens: 5 })],
      [usage({ input_tokens: 2.5, output_tokens: 1, cached_input_tokens: 0 })],
      [usage(), usage({ input_tokens: 24, output_tokens: 2, cached_input_tokens: 5 })],
      [usage(), usage({ input_tokens: 25, output_tokens: 2, cached_input_tokens: -1 })]]
    for (const receipts of variants) {
      const result = await run([...receipts, task()], turnOptions)
      expect(result.observations[0]).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null })
      expect(result.coverage.tokenCoverage).toBe('unknown')
    }
    const repeated = await run([usage(), usage(), task()], turnOptions)
    expect(repeated.observations[0]).toMatchObject({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 5 })
    const progress = await run([usage({ input_tokens: 10, output_tokens: 1, cached_input_tokens: 3 }), usage(), task()], turnOptions)
    expect(progress.observations[0]).toMatchObject({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 5 })
    const afterCompletion = await run([task(), usage()], turnOptions)
    expect(afterCompletion.observations[0]).toMatchObject({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 5 })
    const unbound = await run([usage(), task()])
    expect(unbound.observations).toEqual([])
    const noCompletion = await run([usage()], turnOptions)
    expect(noCompletion.observations).toEqual([])
  })
  test('explicit native task envelopes reach authenticated dashboard phases with recorded boundaries and model', async () => {
    for (const phase of ['build', 'review', 'fix'] as const) {
      const result = await run([command(), task()], { ...turnOptions, turnBindings: [{ ...turnOptions.turnBindings![0]!, phase }] })
      expect(result.coverage.emittedTurns).toBe(1)
      const observation = result.observations[1]!
      expect(validatePhaseObservation(observation)).toMatchObject({ phase, model: 'model-a', startedAt: 1000, endedAt: 9000,
        inputTokens: null, outputTokens: null, costUsd: null, source: { turnId: 'turn-1' } })
      const snapshot = combineTimelineSources({ observedAt: 10000, repositories: [{ repository: repo, error: null,
        prs: [{ number: 7, title: 'Scoped work', url: 'https://github.com/example/project/pull/7',
          createdAt: new Date(5000).toISOString(), closedAt: null, mergedAt: null, state: 'open' }] }] }, result.observations, [], 10000)
      const handler = createTimelineHandler({ username: 'viewer', password: 'fixture', read: () => snapshot })
      const response = await handler(new Request('http://localhost/timeline', {
        headers: { authorization: `Basic ${Buffer.from('viewer:fixture').toString('base64')}` },
      }))
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain(`Native ${phase} task`)
      expect(html).toContain('model-a')
      expect(html).toContain('Local test command')
      expect(snapshot.cards[0]!.start).toBe(1000)
      expect(snapshot.cards[0]!.segments.find(segment => segment.phase === phase)).toMatchObject({ start: 1000, end: 9000 })
    }
  })
  test('turn ownership never follows cwd, mentioned PR, another session or another turn', async () => {
    for (const turnBindings of [[], [{ ...turnOptions.turnBindings![0]!, sessionId: 'other-session' }],
      [{ ...turnOptions.turnBindings![0]!, turnId: 'other-turn' }]]) {
      const result = await run([task({ last_agent_message: 'Built PR #7' })], { ...turnOptions, turnBindings })
      expect(result.observations).toEqual([])
      expect(result.coverage.unbound).toBe(1)
    }
    await expect(run([task()], { ...turnOptions, turnBindings: [...turnOptions.turnBindings!, ...turnOptions.turnBindings!] })).rejects.toThrow('turn binding')
    await expect(run([task()], { ...turnOptions, turnBindings: [{ ...turnOptions.turnBindings![0]!, links: [{ repository: 'other/project', prNumber: 7 }] }] })).rejects.toThrow('turn binding')
  })
  test('native task requires recorded completion; contexts and task-start alone never invent elapsed phases', async () => {
    for (const event of [task({ started_at: undefined }), task({ completed_at: undefined }), task({ completed_at: 0 }),
      record('event_msg', { type: 'task_started', turn_id: 'turn-1', started_at: 1 }, 1000)]) {
      expect((await run([event], turnOptions)).observations).toEqual([])
    }
    const result = await run([task(), task()], turnOptions)
    expect(result.observations).toHaveLength(1)
    expect(result.coverage.duplicate).toBe(1)
  })
  test('missing or mixed task model stays unknown; unrelated turn models do not contaminate it', async () => {
    expect((await importCodexOperations([meta, task()], turnOptions)).observations[0]!.model).toBeNull()
    expect((await run([context('model-b', 4000), task()], turnOptions)).observations[0]!.model).toBeNull()
    expect((await run([context('foreign', 4000, 'other-turn'), task()], turnOptions)).observations[0]!.model).toBe('model-a')
  })
  test('moving bounded tails replay native task and command receipts into one consumed phase each', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-turn-replay-'))
    try {
      const path = join(directory, 'rollout.jsonl'), journal = join(directory, 'phases.jsonl')
      const body = [context(), command(), usage(), task()].join('\n') + '\n'
      await writeFile(path, [meta, record('response_item', { text: 'padding'.repeat(1000) })].join('\n') + '\n' + body)
      const tailBytes = Buffer.byteLength(body) + 500
      const first = await importCodexFile(path, turnOptions, tailBytes)
      expect(first.scan.partial).toBe(true)
      expect(first.observations).toHaveLength(2)
      expect(first.observations.find(o => o.phase === 'test')!.model).toBe('model-a')
      expect(first.observations.find(o => o.phase === 'build')!.model).toBeNull()
      expect(first.observations.find(o => o.phase === 'build')).toMatchObject({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 5 })
      expect(await appendChangedPhaseObservations(journal, first.observations)).toBe(2)
      await appendFile(path, record('response_item', { text: 'new unrelated data' }) + '\n')
      const second = await importCodexFile(path, turnOptions, tailBytes)
      expect(second.scan.startByte).toBeGreaterThan(first.scan.startByte)
      expect(second.observations).toEqual(first.observations)
      expect(await appendChangedPhaseObservations(journal, second.observations)).toBe(0)
      const full = await importCodexFile(path, turnOptions)
      // Native receipts are immutable events. Retain an existing eventId before
      // using the append-only writer; later context may differ across scans.
      const recordedIds = new Set((await readPhaseObservations(journal)).map(o => o.eventId))
      expect(await appendChangedPhaseObservations(journal, full.observations.filter(o => !recordedIds.has(o.eventId)))).toBe(0)
      const observations = await readPhaseObservations(journal)
      expect(observations).toHaveLength(2)
      const native = observations.find(o => o.phase === 'build')!
      expect(native.source).toMatchObject({ evidenceRef: 'codex:fixture:turn:turn-1',
        sessionId: 'thread-1', turnId: 'turn-1', sourceEventId: 'turn-1' })
      const snapshot = combineTimelineSources({ observedAt: 10000, repositories: [] }, observations, [], 10000)
      const handler = createTimelineHandler({ username: 'viewer', password: 'fixture', read: () => snapshot })
      const response = await handler(new Request('http://localhost/api/timeline', {
        headers: { authorization: `Basic ${Buffer.from('viewer:fixture').toString('base64')}` },
      }))
      expect(response.status).toBe(200)
      const consumed = await response.json() as { cards: Array<{ segments: Array<{ phase: string }> }> }
      expect(consumed.cards[0]!.segments.map(s => s.phase).sort()).toEqual(['build', 'test'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test('partial native task without usage is deferred before journal write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-turn-model-replay-'))
    try {
      for (const mixed of [false, true]) {
        const path = join(directory, `rollout-${mixed}.jsonl`), journal = join(directory, `phases-${mixed}.jsonl`)
        const tailBody = [context('model-b', 4000), task()].join('\n') + '\n'
        await writeFile(path, [meta, ...(mixed ? [context('model-a')] : []),
          record('response_item', { text: 'padding'.repeat(1000) })].join('\n') + '\n' + tailBody)
        const full = await importCodexFile(path, turnOptions)
        const tail = await importCodexFile(path, turnOptions, Buffer.byteLength(tailBody) + 25)
        expect(tail.scan.partial).toBe(true)
        expect(full.observations[0]!.model).toBe(mixed ? null : 'model-b')
        expect(tail.observations).toEqual([])
        expect(tail.coverage.deferredTurns).toBe(1)
        // Once a full scan establishes the receipt, a later bounded tail may
        // omit it without overwriting the immutable journal row.
        const retained = new Map(full.observations.map(o => [o.eventId, o]))
        for (const incoming of tail.observations) {
          const prior = retained.get(incoming.eventId)
          if (!prior || (prior.model === null && typeof incoming.model === 'string')) retained.set(incoming.eventId, incoming)
        }
        expect(await appendChangedPhaseObservations(journal, [...retained.values()])).toBe(1)
        const recordedIds = new Set((await readPhaseObservations(journal)).map(o => o.eventId))
        expect(await appendChangedPhaseObservations(journal, tail.observations.filter(o => !recordedIds.has(o.eventId)))).toBe(0)
        const observations = await readPhaseObservations(journal)
        const snapshot = combineTimelineSources({ observedAt: 10000, repositories: [] }, observations, [], 10000)
        const handler = createTimelineHandler({ username: 'viewer', password: 'fixture', read: () => snapshot })
        const response = await handler(new Request('http://localhost/api/timeline', {
          headers: { authorization: `Basic ${Buffer.from('viewer:fixture').toString('base64')}` },
        }))
        const consumed = await response.json() as { cards: Array<{ segments: Array<{ model: string | null }> }> }
        expect(consumed.cards[0]!.segments).toHaveLength(1)
        expect(consumed.cards[0]!.segments[0]!.model).toBe(mixed ? null : 'model-b')
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test('a bounded-tail task before its usage receipt cannot freeze unknown tokens in the journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-turn-usage-tail-'))
    try {
      const path = join(directory, 'rollout.jsonl'), journal = join(directory, 'phases.jsonl')
      const completion = task() + '\n'
      await writeFile(path, [meta, record('response_item', { text: 'padding'.repeat(1000) }), context(), completion.trimEnd()].join('\n') + '\n')
      const early = await importCodexFile(path, turnOptions, Buffer.byteLength(completion) + 25)
      expect(early.scan.partial).toBe(true)
      expect(early.observations).toEqual([])
      expect(early.coverage.deferredTurns).toBe(1)
      expect(await appendChangedPhaseObservations(journal, early.observations)).toBe(0)
      await appendFile(path, usage() + '\n')
      const complete = await importCodexFile(path, turnOptions)
      expect(complete.observations[0]).toMatchObject({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 5 })
      expect(await appendChangedPhaseObservations(journal, complete.observations)).toBe(1)
      expect((await readPhaseObservations(journal))[0]).toMatchObject({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 5 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test('uses exact operation envelope, invoking model and explicit binding without charging tokens', async () => {
    const { observations, coverage } = await run([command()])
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ phase: 'test', model: 'model-a', startedAt: 2000, endedAt: 4000, inputTokens: null,
      links: [{ repository: repo, prNumber: 7 }], source: { parentSessionId: 'parent-1', turnId: 'turn-1', sourceEventId: 'exec-1', attribution: 'reconstructed' } })
    expect(coverage.tokenCoverage).toBe('unknown')
    expect(validatePhaseObservation(observations[0])).toEqual(observations[0]!)
  })
  test('does not mistake searched, printed, compound or substituted commands for tests', async () => {
    for (const cmd of ["rg 'bun test' .", "echo 'bun test'", 'bun test x; echo done', 'bun test $(touch /tmp/nope)', 'bash -c "bun test"', 'bun test > test.log', 'bun test\nother']) {
      expect((await run([command(cmd)])).observations).toEqual([])
    }
    expect((await run([command("bun test x --test-name-pattern 'one | two'")])).observations).toHaveLength(1)
    expect((await run([command(undefined, { command: ['/bin/bash', '-nc', 'bun test x'] })])).observations).toEqual([])
  })
  test('recognizes the complete host suite and preserves overlapping envelopes', async () => {
    const result = await run([command('bash scripts/run-tests.sh'), command('bun test x', { id: 'exec-2', exit_code: 1, status: 'failed' }, { started_at_ms: 3000, completed_at_ms: 5000 })])
    expect(result.observations.map(o => [o.label, o.startedAt, o.endedAt])).toEqual([['Host test suite', 2000, 4000], ['Local test command', 3000, 5000]])
    expect(result.observations[1]!.source.basis).toContain('exit 1')
    expect((await run([command('bash scripts/check-shared-host.sh')])).observations[0]!.label).toBe('Shared-host validation')
  })
  test('rejects missing, expired, ambiguous and wrong-cwd bindings', async () => {
    for (const bindings of [[], [{ ...options.bindings![0]!, endedAt: 3000 }], [options.bindings![0]!, options.bindings![0]!], [{ ...options.bindings![0]!, cwd: '/tmp/other' }]]) {
      const result = await run([command()], { ...options, bindings })
      expect(result.observations).toEqual([])
      expect(result.coverage.unbound).toBe(1)
    }
  })
  test('takes model at operation start, not later context or another turn', async () => {
    const result = await run([context('later-model', 3000), context('foreign-model', 1500, 'other-turn'), command()])
    expect(result.observations[0]!.model).toBe('model-a')
    expect((await importCodexOperations([meta, command()], options)).observations[0]!.model).toBeNull()
  })
  test('requires native complete timestamps, terminal status and session identity', async () => {
    for (const event of [command(undefined, {}, { started_at_ms: undefined }), command(undefined, {}, { completed_at_ms: 1500 }), command(undefined, { status: 'in_progress', exit_code: null }), command(undefined, {}, { thread_id: 'foreign' })]) {
      expect((await run([event])).observations).toEqual([])
    }
  })
  test('deduplicates receipts, including native repeated completion', async () => {
    const result = await run([command(), command()])
    expect(result.observations).toHaveLength(1)
    expect(result.coverage.duplicate).toBe(1)
  })
  test('successfully created PR URL provides exact link; mentions and failed creates do not', async () => {
    const cmd = 'gh pr create --repo example/project --title "Change"'
    const noBindings = { ...options, bindings: [] }
    expect((await run([command(cmd, { stdout: 'https://github.com/example/project/pull/12\n' })], noBindings)).observations[0]!.links[0]!.prNumber).toBe(12)
    for (const item of [{ stdout: 'Mention https://github.com/example/project/pull/12' }, { stdout: 'https://github.com/example/foreign/pull/12' }, { stdout: 'https://github.com/example/project/pull/12', exit_code: 1 }]) {
      expect((await run([command(cmd, item)], noBindings)).observations).toEqual([])
    }
  })
  test('successful merge command requires explicit repository and PR number', async () => {
    const noBindings = { ...options, bindings: [] }
    expect((await run([command('gh pr merge 12 --repo example/project --squash')], noBindings)).observations[0]!.phase).toBe('merge')
    for (const cmd of ['gh pr merge 12', 'gh pr merge 12 --repo example/foreign', 'gh pr view 12 --repo example/project']) {
      expect((await run([command(cmd)], noBindings)).observations).toEqual([])
    }
  })
  test('never exports command content, cwd, output, or arbitrary metadata', async () => {
    const result = await run([command('bun test secret.test.ts', { stdout: 'PRIVATE OUTPUT', stderr: 'PRIVATE STDERR' })])
    const text = JSON.stringify(result.observations)
    for (const secret of ['secret.test.ts', 'PRIVATE', '/tmp/fixture-worktree']) expect(text).not.toContain(secret)
  })
  test('bounds work and refuses repeated session metadata', async () => {
    await expect(run([command()], { ...options, maxLines: 2 })).rejects.toThrow('bounded')
    await expect(run([command()], { ...options, maxBytes: 10 })).rejects.toThrow('bounded')
    await expect(run([meta])).rejects.toThrow('Repeated')
    await expect(run([command()], { ...options, evidenceRef: '/absolute/path' })).rejects.toThrow('scope')
  })
  test('bounded tail retains native identity, declares missing history, and leaves absent model unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-import-fixture-'))
    try {
      const path = join(directory, 'rollout.jsonl')
      const operation = command() + '\n'
      await writeFile(path, [meta, context(), record('response_item', { text: 'padding'.repeat(1000) })].join('\n') + '\n' + operation)
      const full = await importCodexFile(path, options)
      const tail = await importCodexFile(path, options, Buffer.byteLength(operation) + 25)
      expect(full.scan.partial).toBe(false)
      expect(tail.scan.partial).toBe(true)
      expect(tail.scan.startByte).toBeGreaterThan(0)
      expect(tail.observations).toHaveLength(1)
      expect(tail.observations[0]!.eventId).toBe(full.observations[0]!.eventId)
      expect(tail.observations[0]!.model).toBeNull()
      expect(tail.observations[0]!.source.parentSessionId).toBe('parent-1')
      expect(tail.observations[0]!.source.evidenceRef).toBe(full.observations[0]!.source.evidenceRef)
      expect(tail.observations[0]!.source.evidenceRef).toBe('codex:fixture:command:exec-1')
      expect(validatePhaseObservation(tail.observations[0])).toEqual(tail.observations[0]!)
      await expect(importCodexFile(path, options, -1)).rejects.toThrow('tail')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
