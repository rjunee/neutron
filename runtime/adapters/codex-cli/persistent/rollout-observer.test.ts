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
  const identity = { projectId: 'project-one', paneHandle: 'pane-one', threadId: 'thread-one', rolloutPath, cwd }
  writeFileSync(rolloutPath, line('session_meta', { id: identity.threadId, cwd, source: 'cli', originator: 'codex-tui' }) + history)
  return { identity, append: (text) => appendFileSync(rolloutPath, text), observe: (prompt = 'Hello') => {
    const observer = new CodexRolloutObserver(identity, prompt)
    observers.push(observer)
    return observer
  } }
}

describe('native Codex rollout observation', () => {
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
