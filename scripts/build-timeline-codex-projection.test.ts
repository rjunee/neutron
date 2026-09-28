import { expect, test } from 'bun:test'
import { importCodexOperations, projectCodexReceipt, type CodexImportOptions } from './build-timeline-codex-import.ts'

const row = (type: string, payload: unknown, timestamp = 1000) => JSON.stringify({ type, payload, timestamp: new Date(timestamp).toISOString() })
const options: CodexImportOptions = { repositories: ['example/project'], evidenceRef: 'codex:projection',
  bindings: [{ cwd: '/tmp/receipt-fixture', startedAt: 1000, endedAt: 9000, links: [{ repository: 'example/project', prNumber: 7 }] }],
  turnBindings: [{ sessionId: 'session-1', turnId: 'turn-1', phase: 'build', links: [{ repository: 'example/project', prNumber: 7 }] }] }
const initial = [row('session_meta', { id: 'session-1', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } }, instructions: 'PRIVATE CONTEXT' }),
  row('turn_context', { turn_id: 'turn-1', model: 'model-a', developer_instructions: 'PRIVATE CONTEXT' })]
const project = (lines: string[]) => lines.map(projectCodexReceipt).filter((line): line is string => line !== null)
const command = (argv: unknown, extra: object = {}) => row('event_msg', { type: 'item_completed', thread_id: 'session-1', turn_id: 'turn-1', started_at_ms: 2000, completed_at_ms: 3000,
  item: { type: 'CommandExecution', id: 'command-1', command: argv, cwd: '/tmp/receipt-fixture', status: 'completed', exit_code: 0, stdout: 'PRIVATE OUTPUT', ...extra } })

test('malformed valid JSON roots and payloads preserve coverage, while blank lines stay non-malformed', async () => {
  for (const line of ['null', '[]', row('ignored', null), row('turn_context', null), '', ' \t']) {
    const source = [...initial, line]
    const projected = project(source)
    expect(await importCodexOperations(projected, options)).toEqual(await importCodexOperations(source, options))
    expect(project(projected)).toEqual(projected)
  }
})

test('receipt projection preserves exact observations and coverage for each command grammar, including refusal controls', async () => {
  for (const [argv, extra] of [
    [['bun', 'test', 'private-selector.test.ts'], {}], [['npm', 'test'], {}], [['pnpm', 'test'], {}], [['yarn', 'test'], {}],
    [['bash', 'scripts/run-tests.sh'], {}], [['sh', 'scripts/check-shared-host.sh'], {}],
    [['bash', '-lc', 'MODE=1 bun test private-selector.test.ts'], {}],
    [['gh', 'pr', 'create', '--body', 'PRIVATE BODY'], { stdout: ' https://github.com/example/project/pull/9\n' }],
    [['gh', 'pr', 'create', '--repo', 'example/other'], { stdout: 'https://github.com/example/project/pull/9' }],
    [['gh', 'pr', 'create', '--repo=example/project'], { stdout: 'https://github.com/example/project/pull/9', exit_code: 1 }],
    [['gh', 'pr', 'merge', '7', '-R', 'example/project'], {}],
    [['bash', '-lc', 'MODE=1 gh pr merge 7 -R example/project'], {}],
    [['gh', 'pr', 'merge', '7'], {}], [['gh', 'pr', 'create'], { stdout: 'a mention https://github.com/example/project/pull/9' }],
    [['bash', '-lc', 'bun test; echo PRIVATE'], {}], [['echo', 'PRIVATE BODY'], {}], [null, {}],
    [['bun', 'test'], { id: null }], [['bun', 'test'], { status: 'running' }],
  ] as Array<[unknown, object]>) {
    const source = [...initial, command(argv, extra)]
    const projected = project(source)
    expect(await importCodexOperations(projected, options)).toEqual(await importCodexOperations(source, options))
    expect(project(projected)).toEqual(projected)
    expect(projected.join('\n')).not.toContain('PRIVATE')
    expect(projected.join('\n')).not.toContain('private-selector')
  }
  const known = await importCodexOperations(project([...initial, command(['bun', 'test'])]), options)
  expect(known.observations[0]).toMatchObject({ phase: 'test', startedAt: 2000, endedAt: 3000, model: 'model-a' })
})

test('native turn identities, model history, usage poisoning and malformed evidence survive projection and replay', async () => {
  const usage = (input: unknown = 20, identity: object = {}) => row('token_usage_record', { thread_id: 'session-1', turn_id: 'turn-1', ...identity,
    turn_token_usage: { input_tokens: input, output_tokens: 3, cached_input_tokens: 5, ignored: 'PRIVATE USAGE' }, total_token_usage: 'PRIVATE TOTAL' })
  const complete = row('event_msg', { type: 'task_complete', turn_id: 'turn-1', started_at: 1, completed_at: 9, last_agent_message: 'PRIVATE MESSAGE' })
  for (const receipts of [[usage()], [usage(20), usage(19)], [usage(null)], [usage(20, { thread_id: 'foreign' })],
    [usage(20), row('turn_context', { turn_id: 'turn-1', model: 'model-b', instructions: 'PRIVATE CONTEXT' }, 2000)]]) {
    const source = [...initial, ...receipts, complete, '{malformed', row('event_msg', { type: 'item_completed', item: { type: 'ToolCall', output: 'PRIVATE TOOL' } })]
    const projected = project(source)
    expect(await importCodexOperations(projected, options)).toEqual(await importCodexOperations(source, options))
    expect(project(projected)).toEqual(projected)
    expect(projected.join('\n')).not.toContain('PRIVATE')
    const wrongTurn = { ...options, turnBindings: [{ ...options.turnBindings![0]!, turnId: 'other' }] }
    expect((await importCodexOperations(projected, wrongTurn)).observations).toEqual([])
  }
  const valid = await importCodexOperations(project([...initial, usage(), complete]), options)
  expect(valid.observations[0]).toMatchObject({ inputTokens: 15, outputTokens: 3, cacheReadTokens: 5,
    startedAt: 1000, endedAt: 9000, source: { parentSessionId: 'parent-1' } })
})
