import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import type { Event } from '../../events.ts'
import { startCodexExec } from './exec.ts'
import type { CodexSpawnLike } from './exec.ts'

async function collect(gen: AsyncGenerator<Event, void, void>): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of gen) out.push(e)
  return out
}

function successfulChild(pid: number): ReturnType<CodexSpawnLike> {
  const emitter = new EventEmitter()
  const child = {
    pid,
    stdout: Readable.from([
      Buffer.from('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n'),
    ]),
    stderr: Readable.from([]),
    exitCode: 0,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
  }
  return child as unknown as ReturnType<CodexSpawnLike>
}

describe('codex-cli exec spawn-error handling (Codex r1 P2 fix)', () => {
  test('missing binary surfaces a clean substrate error event, not an unhandled process error', async () => {
    const events = await collect(
      startCodexExec({
        prompt: 'hi',
        spawn_env: {},
        signal: new AbortController().signal,
        bin: '/this/path/does/not/exist/codex-binary',
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') {
      expect(err.message).toMatch(/codex (spawn failed|child error|exec exited)/)
    }
  })
})

describe('codex-cli invocation process-group reaping', () => {
  test('normal completion isolates the invocation and escalates a surviving group', async () => {
    const spawned: Array<{ detached: true }> = []
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    const waits: number[] = []
    const spawnImpl: CodexSpawnLike = (_cmd, _args, options) => {
      spawned.push({ detached: options.detached })
      return successfulChild(4242)
    }

    await collect(
      startCodexExec({
        prompt: 'hi',
        spawn_env: {},
        signal: new AbortController().signal,
        spawnImpl,
        signalProcess(pid, signal) {
          signals.push([pid, signal])
        },
        wait(ms) {
          waits.push(ms)
          return Promise.resolve()
        },
      }),
    )

    expect(spawned).toEqual([{ detached: true }])
    expect(waits).toEqual([250])
    expect(signals).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 0],
      [-4242, 'SIGKILL'],
    ])
  })

  test('an unknown process-group probe does not authorize SIGKILL', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    const spawnImpl: CodexSpawnLike = () => successfulChild(4343)

    await collect(
      startCodexExec({
        prompt: 'hi',
        spawn_env: {},
        signal: new AbortController().signal,
        spawnImpl,
        signalProcess(pid, signal) {
          signals.push([pid, signal])
          if (signal === 0) {
            const err = new Error('probe denied') as NodeJS.ErrnoException
            err.code = 'EACCES'
            throw err
          }
        },
        wait: () => Promise.resolve(),
      }),
    )

    expect(signals).toEqual([
      [-4343, 'SIGTERM'],
      [-4343, 0],
    ])
  })

  test('an unsafe or unavailable group id is never signalled', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = []

    await collect(
      startCodexExec({
        prompt: 'hi',
        spawn_env: {},
        signal: new AbortController().signal,
        spawnImpl: () => successfulChild(1),
        signalProcess(pid, signal) {
          signals.push([pid, signal])
        },
        wait: () => Promise.resolve(),
      }),
    )

    expect(signals).toEqual([])
  })

  test('a failed TERM is unknown and never authorizes a later signal', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = []

    await collect(
      startCodexExec({
        prompt: 'hi',
        spawn_env: {},
        signal: new AbortController().signal,
        spawnImpl: () => successfulChild(4444),
        signalProcess(pid, signal) {
          signals.push([pid, signal])
          const err = new Error('signal denied') as NodeJS.ErrnoException
          err.code = 'EACCES'
          throw err
        },
        wait: () => Promise.resolve(),
      }),
    )

    expect(signals).toEqual([[-4444, 'SIGTERM']])
  })
})
