import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Event } from '../../../events.ts'
import { createCodexConversationalSubstrate, type CodexConversationLease } from './conversational-substrate.ts'
import { CodexRolloutObserver, type CodexRolloutIdentity } from './rollout-observer.ts'

// Anonymized native TUI 0.154.0 schema: the UserMessage item carries the
// authoritative thread/turn pair; task_complete carries the final reply.
const line = (type: string, payload: unknown): string => JSON.stringify({ timestamp: '2026-09-19T00:00:00Z', type, payload }) + '\n'
const event = (payload: unknown): string => line('event_msg', payload)
const start = (turn = 'turn-one'): string => event({ type: 'task_started', turn_id: turn })
const user = (prompt = 'Hello', turn = 'turn-one', thread = 'thread-one'): string => event({
  type: 'item_completed', thread_id: thread, turn_id: turn,
  item: { type: 'UserMessage', id: 'item-one', content: [{ type: 'text', text: prompt, text_elements: [] }] },
})
const complete = (turn = 'turn-one', reply = 'Hi'): string => event({ type: 'task_complete', turn_id: turn, last_agent_message: reply })
// Native child completion retains its dispatching parent turn even after that
// parent completes and a subsequent owner turn starts.
const childActivity = (kind: string, turn = 'parent-turn', child = 'child-thread', path = '/root/child', thread = 'thread-one'): string => event({
  type: 'item_completed', thread_id: thread, turn_id: turn,
  item: { type: 'SubAgentActivity', id: kind === 'started' ? 'spawn' : 'subagent-completed-child-turn',
    kind, agent_thread_id: child, agent_path: path },
})
const parentHistory = (): string => start('parent-turn') + user('Dispatch child', 'parent-turn')
  + childActivity('started') + complete('parent-turn', 'Dispatched')
const directories: string[] = []
const observers: CodexRolloutObserver[] = []
afterEach(() => {
  for (const observer of observers.splice(0)) observer.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(history = ''): { identity: CodexRolloutIdentity; append: (text: string) => void; observe: (prompt?: string) => CodexRolloutObserver } {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-rollout-test-'))
  directories.push(cwd)
  const rolloutPath = join(cwd, 'rollout.jsonl')
  const identity = { projectId: 'project-one', paneHandle: 'pane-one', threadId: 'thread-one', rolloutPath, cwd,
    bindingRevision: 'binding-one', nativeMetadata: { sessionId: 'session-one', source: 'vscode', originator: 'owner-bootstrap-probe' } }
  writeFileSync(rolloutPath, metadata(identity) + history)
  return { identity, append: (text) => appendFileSync(rolloutPath, text), observe: (prompt = 'Hello') => {
    const observer = new CodexRolloutObserver(identity, prompt)
    observers.push(observer)
    return observer
  } }
}

function metadata(identity: CodexRolloutIdentity): string {
  return line('session_meta', { id: identity.threadId, cwd: identity.cwd,
    source: identity.nativeMetadata?.source ?? 'cli', originator: identity.nativeMetadata?.originator ?? 'codex-tui',
    session_id: identity.nativeMetadata?.sessionId })
}

describe('native Codex rollout observation', () => {
  test.each([false, true])('exact inter-agent scheduling marker trigger_turn=%s cannot complete or change a turn', trigger_turn => {
    const f = fixture(line('inter_agent_communication_metadata', { trigger_turn }))
    const observer = f.observe()
    f.append(start() + user() + line('inter_agent_communication_metadata', { trigger_turn }))
    expect(observer.read().some(event => event.kind === 'completion')).toBe(false)
    f.append(complete())
    expect(observer.read().at(-1)?.kind).toBe('completion')
  })
  test.each([{}, { trigger_turn: 'false' }, { trigger_turn: false, turn_id: 'turn-one' }, { trigger_turn: false, thread_id: 'thread-one' }])(
    'unrecognized inter-agent metadata shape refuses', payload => {
      const f = fixture(), observer = f.observe()
      f.append(start() + user() + line('inter_agent_communication_metadata', payload))
      expect(() => observer.read()).toThrow('malformed inter-agent metadata')
    })
  test('arbitrary unknown top-level record still refuses with a valid marker as positive control', () => {
    const f = fixture(), observer = f.observe()
    f.append(start() + user() + line('inter_agent_communication_metadata', { trigger_turn: false }))
    expect(() => observer.read()).not.toThrow()
    f.append(line('future_unknown_native_record', { trigger_turn: false }))
    expect(() => observer.read()).toThrow('unknown native record')
  })
  test('preserves materialized local TUI attachment without remote metadata', () => {
    const f = fixture()
    const { nativeMetadata: _metadata, bindingRevision: _revision, ...identity } = f.identity
    writeFileSync(identity.rolloutPath, metadata(identity))
    const observer = new CodexRolloutObserver(identity, 'Hello')
    observers.push(observer)
    f.append(start() + user() + complete())
    expect(observer.read().at(-1)?.kind).toBe('completion')
  })

  test.each(['sessionId', 'source', 'originator'] as const)('refuses incorrect attested native metadata %s', field => {
    const f = fixture()
    expect(() => new CodexRolloutObserver({ ...f.identity,
      nativeMetadata: { ...f.identity.nativeMetadata!, [field]: 'different' } }, 'Hello')).toThrow('identity mismatch')
  })

  test('deferred materialization requires a receipt even when a matching turn appears', () => {
    const f = fixture()
    rmSync(f.identity.rolloutPath)
    const observer = f.observe()
    expect(() => observer.bindReceipt()).toThrow('unknown delivery')
    expect(() => observer.read()).toThrow('unknown delivery')
  })

  test('deferred construction requires attested metadata and binding revision', () => {
    const f = fixture()
    rmSync(f.identity.rolloutPath)
    const { nativeMetadata: _metadata, ...withoutMetadata } = f.identity
    const { bindingRevision: _revision, ...withoutRevision } = f.identity
    expect(() => new CodexRolloutObserver(withoutMetadata, 'Hello')).toThrow('attested native metadata')
    expect(() => new CodexRolloutObserver(withoutRevision, 'Hello')).toThrow('attested native metadata')
  })

  test.each(['threadId', 'rolloutPath', 'turnId', 'bindingRevision'] as const)('deferred observation refuses a mismatched receipt %s', field => {
    const f = fixture()
    rmSync(f.identity.rolloutPath)
    const observer = f.observe()
    const receipt = { threadId: f.identity.threadId, rolloutPath: f.identity.rolloutPath, turnId: 'turn-one', bindingRevision: 'binding-one', [field]: 'other' }
    if (field !== 'turnId') {
      expect(() => observer.bindReceipt(receipt)).toThrow('receipt identity')
    } else {
      observer.bindReceipt(receipt)
      writeFileSync(f.identity.rolloutPath,
        metadata(f.identity)
        + start() + user() + complete())
      expect(() => observer.read()).toThrow('stale or concurrent')
    }
  })

  test('accepts a correlated reply and a follow-up in the same thread', () => {
    const f = fixture()
    const first = f.observe()
    f.append(start() + user())
    expect(first.read()).toEqual([])
    f.append(line('token_usage_record', { thread_id: 'thread-one', turn_id: 'turn-one',
      turn_token_usage: { input_tokens: 25, output_tokens: 2, cached_input_tokens: 5 } }) + complete())
    const result = first.read()
    expect(result[0]).toEqual({ kind: 'token', text: 'Hi' })
    expect(result[1]).toMatchObject({ kind: 'completion', substrate_instance_id: 'thread-one',
      session: { id: 'thread-one' }, usage: { input_tokens: 25, output_tokens: 2, cache_read_input_tokens: 5 } })
    expect(first.read()).toEqual([])
    const second = f.observe('Again')
    f.append(start('turn-two') + user('Again', 'turn-two') + complete('turn-two', 'Still here'))
    expect(second.read()[0]).toEqual({ kind: 'token', text: 'Still here' })
  })

  test('does not replay an old completion or finish an incomplete JSON line', () => {
    const f = fixture(start('old') + user('Old', 'old') + complete('old'))
    const observer = f.observe()
    expect(observer.read()).toEqual([])
    f.append(start() + user() + complete().trimEnd())
    expect(observer.read()).toEqual([])
    f.append('\n')
    expect(observer.read().at(-1)?.kind).toBe('completion')
  })

  test.each(['before start', 'before echo', 'after echo', 'after completion', 'baseline'])(
    'correlates late child completion %s without completing or changing the owner turn', placement => {
      const f = fixture(parentHistory() + (placement === 'baseline' ? childActivity('completed') : ''))
      const observer = f.observe()
      observer.bindReceipt({ ...f.identity, turnId: 'turn-one' })
      if (placement === 'before start') {
        f.append(childActivity('completed'))
        expect(observer.read()).toEqual([])
        expect(observer.turnId).toBeUndefined()
      }
      f.append(start() + (placement === 'before echo' ? childActivity('completed') : ''))
      expect(observer.read()).toEqual([])
      expect(observer.turnId).toBeUndefined()
      f.append(user() + (placement === 'after echo' ? childActivity('completed') : ''))
      expect(observer.read()).toEqual([])
      expect(observer.turnId).toBe('turn-one')
      expect(observer.completed).toBe(false)
      f.append(complete() + (placement === 'after completion' ? childActivity('completed') : ''))
      expect(observer.read()).toEqual([
        { kind: 'token', text: 'Hi' },
        expect.objectContaining({ kind: 'completion', substrate_instance_id: 'thread-one' }),
      ])
      expect(observer.turnId).toBeUndefined()
    },
  )

  test('tracks a native child started and completed in the current append', () => {
    const f = fixture()
    const observer = f.observe()
    f.append(start() + user() + childActivity('started', 'turn-one')
      + childActivity('completed', 'turn-one') + complete())
    expect(observer.read().at(-1)?.kind).toBe('completion')
  })

  test.each([
    ['foreign owner thread', childActivity('completed', 'parent-turn', 'child-thread', '/root/child', 'foreign')],
    ['wrong parent turn', childActivity('completed', 'foreign-turn')],
    ['wrong child thread', childActivity('completed', 'parent-turn', 'foreign-child')],
    ['wrong child path', childActivity('completed', 'parent-turn', 'child-thread', '/root/foreign')],
    ['missing child identity', childActivity('completed', 'parent-turn', '')],
    ['unknown child status', childActivity('future-status')],
    ['late start', childActivity('started')],
    ['stale user item', user('Hello', 'parent-turn')],
    ['stale assistant item', event({ type: 'item_completed', thread_id: 'thread-one', turn_id: 'parent-turn', item: { type: 'AgentMessage' } })],
    ['duplicate child completion', childActivity('completed') + childActivity('completed')],
  ])('refuses %s amid a current owner turn', (_name, notification) => {
    const f = fixture(parentHistory())
    const observer = f.observe()
    f.append(start() + notification + user() + complete())
    expect(() => observer.read()).toThrow('codex rollout refused')
  })

  test('refuses a child completion without its observed dispatch', () => {
    const f = fixture(start('parent-turn') + user('Earlier', 'parent-turn') + complete('parent-turn'))
    const observer = f.observe()
    f.append(start() + childActivity('completed') + user() + complete())
    expect(() => observer.read()).toThrow('codex rollout refused')
  })

  test('does not reuse a child completion already settled in the baseline', () => {
    const f = fixture(parentHistory() + childActivity('completed'))
    const observer = f.observe()
    f.append(start() + childActivity('completed') + user() + complete())
    expect(() => observer.read()).toThrow('unmatched native child completion')
  })

  test.each([
    ['start outside a parent turn', childActivity('started')],
    ['foreign start', start('parent-turn') + childActivity('started', 'parent-turn', 'child-thread', '/root/child', 'foreign')],
    ['unmatched completion', start('parent-turn') + complete('parent-turn') + childActivity('completed')],
  ])('refuses baseline child evidence with %s', (_name, history) => {
    expect(() => fixture(history).observe()).toThrow('codex rollout refused')
  })

  test.each([
    ['wrong thread', start() + user('Hello', 'turn-one', 'other') + complete()],
    ['wrong turn', start() + user('Hello', 'other') + complete()],
    ['wrong prompt', start() + user('Unrelated') + complete()],
    ['no prompt echo', start() + complete()],
    ['no start', complete()],
    ['wrong completion', start() + user() + complete('other')],
    ['concurrent turn', start() + start('other')],
    ['duplicate prompt', start() + user() + user() + complete()],
    ['duplicate completion', start() + user() + complete() + complete()],
    ['success then concurrent turn', start() + user() + complete() + start('other')],
    ['native abort', start() + user() + event({ type: 'turn_aborted', turn_id: 'turn-one', reason: 'interrupted' })],
    ['native error', start() + event({ type: 'error', message: 'failed' })],
    ['unknown native event', start() + event({ type: 'future_completion' })],
    ['wrong usage turn', start() + line('token_usage_record', { turn_id: 'other' })],
    ['wrong turn context', start() + line('turn_context', { turn_id: 'other' })],
  ])('refuses %s', (_name, append) => {
    const f = fixture()
    const observer = f.observe()
    f.append(append)
    expect(() => observer.read()).toThrow('codex rollout refused')
    expect(() => observer.read()).toThrow('observer closed')
  })

  test('refuses a reused old turn id', () => {
    const f = fixture(start() + user() + complete())
    const observer = f.observe()
    f.append(start() + user() + complete())
    expect(() => observer.read()).toThrow('stale or concurrent')
  })

  test('never exposes an unrelated or unacknowledged turn for cancellation', () => {
    const f = fixture()
    const observer = f.observe()
    f.append(start())
    observer.read()
    expect(observer.turnId).toBeUndefined()
    f.append(user('Unrelated'))
    expect(() => observer.read()).toThrow('submitted prompt')
    expect(observer.turnId).toBeUndefined()
  })

  test('refuses active or partial baseline before submission', () => {
    expect(() => fixture(start()).observe()).toThrow('already active')
    expect(() => fixture('{').observe()).toThrow('incomplete baseline')
  })

  test.each(['threadId', 'cwd'] as const)('refuses wrong metadata %s', (field) => {
    const f = fixture()
    expect(() => new CodexRolloutObserver({ ...f.identity, [field]: 'other' }, 'Hello')).toThrow('identity mismatch')
  })

  test('refuses truncation and replacement', () => {
    const f = fixture()
    const observer = f.observe()
    writeFileSync(f.identity.rolloutPath, '')
    expect(() => observer.read()).toThrow('truncated')
    const g = fixture()
    const other = g.observe()
    renameSync(g.identity.rolloutPath, g.identity.rolloutPath + '.old')
    writeFileSync(g.identity.rolloutPath, start() + user() + complete())
    expect(() => other.read()).toThrow('replaced')
  })
})

function bridge(f: ReturnType<typeof fixture>, submit: () => Promise<void>, identity = f.identity) {
  const releases: string[] = []
  const interrupts: string[] = []
  const lease: CodexConversationLease = {
    identity, submitLine: submit, isLive: () => true,
    interrupt: async (id) => { interrupts.push(id) },
    release: async (outcome) => { releases.push(outcome) },
  }
  const substrate = createCodexConversationalSubstrate({
    host: { acquireTurn: async () => lease }, projectId: f.identity.projectId,
    cwd: f.identity.cwd, env: {}, pollMs: 1, timeoutMs: 10,
  })
  const handle = substrate.start({ prompt: 'Hello', tools: [], model_preference: [] })
  return { handle, releases, interrupts }
}

describe('hosted conversational SessionHandle bridge', () => {
  test('deferred delivery without a native receipt is unknown and releases refused', async () => {
    const f = fixture()
    rmSync(f.identity.rolloutPath)
    let submitted = false
    const b = bridge(f, async () => { submitted = true })
    const events = await Array.fromAsync(b.handle.events)
    expect(submitted).toBe(true)
    expect(events).toEqual([{ kind: 'error', retryable: false,
      message: expect.stringContaining('unknown delivery') }])
    expect(b.releases).toEqual(['refused'])
  })

  test('first real multiline turn binds its deferred rollout from the native receipt', async () => {
    const f = fixture()
    rmSync(f.identity.rolloutPath)
    const prompt = 'Hello\nKeep this second line'
    const releases: string[] = []
    const substrate = createCodexConversationalSubstrate({ projectId: f.identity.projectId, cwd: f.identity.cwd,
      env: {}, pollMs: 1, timeoutMs: 50, host: { acquireTurn: async () => ({
        identity: f.identity, isLive: () => true,
        submitLine: async (text: string) => {
          expect(text).toBe(prompt)
          setTimeout(() => writeFileSync(f.identity.rolloutPath,
            metadata(f.identity)
            + start() + user(prompt) + complete()), 2)
          return { threadId: f.identity.threadId, turnId: 'turn-one', rolloutPath: f.identity.rolloutPath, bindingRevision: 'binding-one' }
        }, interrupt: async () => {}, release: async (outcome: string) => { releases.push(outcome) },
      }) } })
    const events = await Array.fromAsync(substrate.start({ prompt, tools: [], model_preference: [] }).events)
    expect(events.map(e => e.kind)).toEqual(['status', 'token', 'completion'])
    expect(releases).toEqual(['completed'])
  })

  test('bridges native completion, preserving identity and releasing the lease', async () => {
    const f = fixture()
    const b = bridge(f, async () => { f.append(start() + user() + complete()) })
    const events = await Array.fromAsync(b.handle.events)
    expect(events.map((e) => e.kind)).toEqual(['status', 'token', 'completion'])
    expect(b.releases).toEqual(['completed'])
    expect(b.interrupts).toEqual([])
    await b.handle.cancel()
    expect(b.interrupts).toEqual([])
    await expect(b.handle.respondToTool('call', {})).rejects.toThrow('internally')
  })

  test('acknowledged submission alone times out without success and quarantines reuse', async () => {
    const b = bridge(fixture(), async () => {})
    const events = await Array.fromAsync(b.handle.events)
    expect(events.some((e) => e.kind === 'completion')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'error', retryable: false, message: expect.stringContaining('timeout') })
    expect(b.releases).toEqual(['refused'])
  })

  test('hung submission has a bounded unknown outcome', async () => {
    const b = bridge(fixture(), () => new Promise<void>(() => {}))
    const events = await Array.fromAsync(b.handle.events)
    expect(events).toEqual([{ kind: 'error', code: 'turn_timeout', retryable: false,
      message: 'codex conversation refused: native completion timeout' }])
    expect(b.releases).toEqual(['refused'])
  })

  test('hung acquisition times out and a late lease is refused without submission', async () => {
    const f = fixture()
    let resolveLease!: (lease: CodexConversationLease) => void
    let submitted = false
    const released: string[] = []
    const substrate = createCodexConversationalSubstrate({ projectId: f.identity.projectId, cwd: f.identity.cwd,
      env: {}, pollMs: 1, timeoutMs: 2, host: { acquireTurn: () => new Promise((resolve) => { resolveLease = resolve }) } })
    const events = await Array.fromAsync(substrate.start({ prompt: 'Hello', tools: [], model_preference: [] }).events)
    expect(events[0]).toMatchObject({ kind: 'error', code: 'turn_timeout' })
    resolveLease({ identity: f.identity, isLive: () => true, submitLine: async () => { submitted = true },
      interrupt: async () => {}, release: async (outcome) => { released.push(outcome) } })
    await Bun.sleep(1)
    expect(submitted).toBe(false)
    expect(released).toEqual(['refused'])
  })

  test('host identity mismatch blocks submission', async () => {
    const f = fixture()
    let submitted = false
    const b = bridge(f, async () => { submitted = true }, { ...f.identity, projectId: 'other' })
    expect((await Array.fromAsync(b.handle.events))[0]?.kind).toBe('error')
    expect(submitted).toBe(false)
    expect(b.releases).toEqual(['refused'])
  })

  test('cancel interrupts only the observed native turn, once', async () => {
    const f = fixture()
    const b = bridge(f, async () => { f.append(start() + user()) })
    const iterator = b.handle.events[Symbol.asyncIterator]()
    await iterator.next()
    const pending = iterator.next()
    await Bun.sleep(2)
    await b.handle.cancel()
    expect((await pending).value).toMatchObject({ kind: 'error', code: 'aborted' })
    await iterator.return?.()
    expect(b.interrupts).toEqual(['turn-one'])
    expect(b.releases).toEqual(['refused'])
  })

  test('iterator.return before observation quarantines the unknown turn', async () => {
    const f = fixture()
    const b = bridge(f, async () => { f.append(start() + user()) })
    const iterator = b.handle.events[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    expect(b.interrupts).toEqual([])
    expect(b.releases).toEqual(['refused'])
  })

  test('cancelling before consumption never acquires or submits', async () => {
    let called = false
    const b = bridge(fixture(), async () => { called = true })
    await b.handle.cancel()
    const events: Event[] = await Array.fromAsync(b.handle.events)
    expect(events[0]).toMatchObject({ kind: 'error', code: 'aborted' })
    expect(called).toBe(false)
    expect(b.releases).toEqual([])
  })

  test('a refused project cannot be reused through another wrapper on the shared host', async () => {
    const f = fixture()
    let acquisitions = 0
    const host = { acquireTurn: async (): Promise<CodexConversationLease> => {
      acquisitions++
      return { identity: f.identity, isLive: () => true, submitLine: async () => {},
        interrupt: async () => {}, release: async () => {} }
    } }
    const options = { host, projectId: f.identity.projectId, cwd: f.identity.cwd, env: {}, pollMs: 1, timeoutMs: 2 }
    const spec = { prompt: 'Hello', tools: [], model_preference: [] }
    await Array.fromAsync(createCodexConversationalSubstrate(options).start(spec).events)
    const second = await Array.fromAsync(createCodexConversationalSubstrate(options).start(spec).events)
    expect(second[0]).toMatchObject({ kind: 'error', message: expect.stringContaining('reconciliation') })
    expect(acquisitions).toBe(1)
  })
})
