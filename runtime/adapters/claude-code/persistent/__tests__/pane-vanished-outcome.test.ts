import { describe, expect, it } from 'bun:test'
import { EventChannel } from '../event-channel.ts'
import { ReplSession } from '../repl-session.ts'
import { baselineAllowsAdoption } from '../boot-adoption.ts'

describe('adoption baseline decision', () => {
  it('refuses an unobserved pane and accepts an observed one', () => {
    expect(baselineAllowsAdoption(false)).toBe(false)
    expect(baselineAllowsAdoption(true)).toBe(true)
  })
})

describe('in-flight child death outcome', () => {
  it('names a positively vanished pane instead of reporting an unclassified process exit', async () => {
    const session = new ReplSession('key', 'generation', 'session', 'channel', '/tmp')
    const channel = new EventChannel()
    session.activeTurn = {
      channel,
      settled: false,
      settle: () => {},
      substrateInstanceId: 'instance',
      sessionId: 'session',
      turnId: 'turn',
    }

    session.onDeath('pane-vanished')
    const event = await channel[Symbol.asyncIterator]().next()
    expect(event.value).toEqual({
      kind: 'error',
      message: 'persistent-repl: pane vanished during turn',
      retryable: true,
      code: 'pane_vanished',
    })
  })

  it('CONTROL — an exit with no positive pane verdict keeps the generic outcome', async () => {
    const session = new ReplSession('key', 'generation', 'session', 'channel', '/tmp')
    const channel = new EventChannel()
    session.activeTurn = {
      channel,
      settled: false,
      settle: () => {},
      substrateInstanceId: 'instance',
      sessionId: 'session',
      turnId: 'turn',
    }
    session.onDeath()
    const event = await channel[Symbol.asyncIterator]().next()
    expect(event.value).toEqual({
      kind: 'error',
      message: 'persistent-repl: REPL process exited',
      retryable: true,
    })
  })
})
