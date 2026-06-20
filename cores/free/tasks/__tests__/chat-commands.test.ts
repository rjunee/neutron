import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  TASK_COMMAND_PREFIX,
  executeTaskCommand,
  parseTaskCommand,
  buildInMemoryTaskStore,
  buildPickNextService,
  buildStubPickNextLlmClient,
  type ExecuteTaskCommandContext,
  type TaskCommand,
  type TaskStore,
} from '../index.ts'

describe('Tasks Core — chat-command parser', () => {
  test('null on non-/task prefixed bodies', () => {
    expect(parseTaskCommand('hello world')).toBeNull()
    expect(parseTaskCommand('  ship the PR')).toBeNull()
    expect(parseTaskCommand('/notes write a fact')).toBeNull()
  })

  test('`/task` alone returns help', () => {
    expect(parseTaskCommand('/task')).toEqual({ kind: 'help' })
    expect(parseTaskCommand('  /task  ')).toEqual({ kind: 'help' })
  })

  test('`/task help` / `--help` / `-h` all map to help', () => {
    expect(parseTaskCommand('/task help')).toEqual({ kind: 'help' })
    expect(parseTaskCommand('/task --help')).toEqual({ kind: 'help' })
    expect(parseTaskCommand('/task -h')).toEqual({ kind: 'help' })
  })

  test('`/task <body>` captures', () => {
    expect(parseTaskCommand('/task ship the cm-engine PR')).toEqual({
      kind: 'capture',
      body: 'ship the cm-engine PR',
    })
  })

  test('`/task done <id>` returns done with the id', () => {
    expect(parseTaskCommand('/task done t-42')).toEqual({
      kind: 'done',
      target: 't-42',
    })
    // `complete` and `finish` are aliases.
    expect(parseTaskCommand('/task complete t-42')).toEqual({
      kind: 'done',
      target: 't-42',
    })
    expect(parseTaskCommand('/task finish ship the PR')).toEqual({
      kind: 'done',
      target: 'ship the PR',
    })
  })

  test('`/task done` (no arg) returns unrecognized', () => {
    const parsed = parseTaskCommand('/task done')
    expect(parsed?.kind).toBe('unrecognized')
  })

  test('`/task list` (no arg) returns list without project_id', () => {
    expect(parseTaskCommand('/task list')).toEqual({ kind: 'list' })
    // Alias.
    expect(parseTaskCommand('/task ls')).toEqual({ kind: 'list' })
  })

  test('`/task list <project_id>` (single token) narrows', () => {
    expect(parseTaskCommand('/task list p_neutron')).toEqual({
      kind: 'list',
      project_id: 'p_neutron',
    })
  })

  test('`/task list of follow-ups for Anna` falls through to capture', () => {
    expect(parseTaskCommand('/task list of follow-ups for Anna')).toEqual({
      kind: 'capture',
      body: 'list of follow-ups for Anna',
    })
  })

  test('`/task focus` (no arg) returns focus without project_id', () => {
    expect(parseTaskCommand('/task focus')).toEqual({ kind: 'focus' })
    // Aliases.
    expect(parseTaskCommand('/task next')).toEqual({ kind: 'focus' })
    expect(parseTaskCommand('/task pick')).toEqual({ kind: 'focus' })
  })

  test('`/task focus <project_id>` (single token) narrows', () => {
    expect(parseTaskCommand('/task focus p_neutron')).toEqual({
      kind: 'focus',
      project_id: 'p_neutron',
    })
  })

  test('`/taskish` (no whitespace after prefix) returns null — not a task command', () => {
    expect(parseTaskCommand('/taskish foo')).toBeNull()
    expect(parseTaskCommand('/tasks list')).toBeNull()
  })

  test('case-insensitive prefix and verb', () => {
    expect(parseTaskCommand('/TASK done t-1')).toEqual({
      kind: 'done',
      target: 't-1',
    })
    expect(parseTaskCommand('/task DONE t-1')).toEqual({
      kind: 'done',
      target: 't-1',
    })
  })

  test('TASK_COMMAND_PREFIX is the literal "/task"', () => {
    expect(TASK_COMMAND_PREFIX).toBe('/task')
  })
})

describe('Tasks Core — chat-command dispatcher', () => {
  let store: TaskStore
  let ctx: ExecuteTaskCommandContext
  let nowMs = 1_700_000_000_000
  let nextN = 0

  beforeEach(() => {
    nowMs = 1_700_000_000_000
    nextN = 0
    store = buildInMemoryTaskStore({
      now: () => ++nowMs,
      nextId: () => `t-${nextN++}`,
    })
    ctx = {
      store,
      pickNext: buildPickNextService({
        store,
        llm: buildStubPickNextLlmClient(),
      }),
      project_id: 'p_neutron',
      user_id: 'u_sam',
    }
  })

  afterEach(() => {
    nowMs = 1_700_000_000_000
    nextN = 0
  })

  test('help response lists every verb', async () => {
    const res = await executeTaskCommand({ kind: 'help' }, ctx)
    expect(res.short_circuit_llm).toBe(true)
    expect(res.text).toContain('/task <text>')
    expect(res.text).toContain('/task done')
    expect(res.text).toContain('/task list')
    expect(res.text).toContain('/task focus')
  })

  test('capture creates a task in the current project + returns buttons', async () => {
    const res = await executeTaskCommand(
      { kind: 'capture', body: 'ship the cm-engine PR' },
      ctx,
    )
    expect(res.short_circuit_llm).toBe(true)
    expect(res.text).toContain('Captured')
    expect(res.text).toContain('ship the cm-engine PR')
    const data = res.data as { task: { id: string; title: string; project_id?: string } }
    expect(data.task.title).toBe('ship the cm-engine PR')
    expect(data.task.project_id).toBe('p_neutron')
    expect(res.buttons?.length).toBeGreaterThanOrEqual(1)
    // ISSUE #18 follow-up — capture does NOT set deep_link to avoid
    // auto-navigating away from chat before the user explicitly taps
    // the Open button. Navigation only fires on the `task:open:<id>`
    // postback handled by `openPostbackResponse`.
    expect(res.deep_link).toBeUndefined()
  })

  test('capture with empty body returns malformed', async () => {
    const res = await executeTaskCommand({ kind: 'capture', body: '   ' }, ctx)
    expect(res.error?.code).toBe('malformed')
  })

  test('done <id> completes the matching task', async () => {
    const a = await store.create({ title: 'ship a', project_id: 'p_neutron' })
    const res = await executeTaskCommand({ kind: 'done', target: a.id }, ctx)
    expect(res.text).toContain('Done')
    expect(res.text).toContain('ship a')
    const updated = await store.list({ status: 'done' })
    expect(updated.map((t) => t.id)).toContain(a.id)
  })

  test('done with fuzzy single match completes it', async () => {
    await store.create({ title: 'ship the cm-engine PR', project_id: 'p_neutron' })
    await store.create({ title: 'review onboarding spec', project_id: 'p_neutron' })
    const res = await executeTaskCommand(
      { kind: 'done', target: 'cm-engine' },
      ctx,
    )
    expect(res.text).toContain('Done')
    expect(res.text).toContain('cm-engine')
  })

  test('done with fuzzy multiple matches returns disambiguation', async () => {
    await store.create({ title: 'ship a', project_id: 'p_neutron' })
    await store.create({ title: 'ship b', project_id: 'p_neutron' })
    const res = await executeTaskCommand({ kind: 'done', target: 'ship' }, ctx)
    expect(res.error?.code).toBe('multiple_matches')
    expect(res.buttons?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test('done with no match returns unknown_task', async () => {
    const res = await executeTaskCommand({ kind: 'done', target: 'nomatch' }, ctx)
    expect(res.error?.code).toBe('unknown_task')
  })

  test('list with rows returns focus-ordered preview', async () => {
    await store.create({ title: 'low priority', priority: 0, project_id: 'p_neutron' })
    await store.create({ title: 'high priority', priority: 3, project_id: 'p_neutron' })
    const res = await executeTaskCommand({ kind: 'list' }, ctx)
    expect(res.text).toContain('open task')
    const data = res.data as { results: Array<{ title: string }> }
    // priority 1 sorts before priority 5 under focus_score order.
    expect(data.results[0]?.title).toBe('high priority')
  })

  test('list with no rows returns empty-state', async () => {
    const res = await executeTaskCommand({ kind: 'list' }, ctx)
    expect(res.text).toContain('No open tasks')
  })

  test('focus returns null candidate + rationale when no tasks', async () => {
    const res = await executeTaskCommand({ kind: 'focus' }, ctx)
    expect(res.text).toContain('No open tasks')
    const data = res.data as { candidate: null }
    expect(data.candidate).toBeNull()
  })

  test('focus returns the chosen candidate + rationale', async () => {
    await store.create({ title: 'do this one', priority: 3, project_id: 'p_neutron' })
    await store.create({ title: 'do this later', priority: 0, project_id: 'p_neutron' })
    const res = await executeTaskCommand({ kind: 'focus' }, ctx)
    expect(res.text).toContain('🎯')
    expect(res.text).toContain('do this one')
    expect(res.buttons?.map((b) => b.id).sort()).toEqual(['done', 'open'])
  })

  test('unrecognized command emits a malformed envelope', async () => {
    const res = await executeTaskCommand(
      { kind: 'unrecognized', reason: 'bad shape' } as TaskCommand,
      ctx,
    )
    expect(res.error?.code).toBe('malformed')
    expect(res.short_circuit_llm).toBe(true)
  })
})
