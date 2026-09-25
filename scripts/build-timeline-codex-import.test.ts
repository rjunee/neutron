import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCodexFile, importCodexOperations, type CodexImportOptions } from './build-timeline-codex-import.ts'
import { validatePhaseObservation } from './build-timeline-sources.ts'

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
      expect(tail.observations[0]!.source.evidenceRef).toContain(':tail-')
      expect(validatePhaseObservation(tail.observations[0])).toEqual(tail.observations[0]!)
      await expect(importCodexFile(path, options, -1)).rejects.toThrow('tail')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
