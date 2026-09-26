import { afterEach, expect, spyOn, test } from 'bun:test'
import { buildLlmCallSubstrate } from '../build-llm-call-substrate.ts'
import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import { createPersistentReplSubstrate } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import * as spawning from '@neutronai/runtime/adapters/claude-code/persistent/spawn.ts'
import { HerdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { HERDR_PROTOCOL_VERSION } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-protocol.ts'
import { verifyHerdrProtocol } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-client.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const spec = { prompt: 'fixture', tools: [], model_preference: ['claude-opus-4-7'] }
let restore: (() => void) | undefined
afterEach(() => { restore?.(); restore = undefined })

for (const [name, pong] of [
  ['unsupported version', { protocol: HERDR_PROTOCOL_VERSION + 1, version: 'fixture' }],
  ['missing protocol metadata', { version: 'fixture' }],
] as const) {
  test(`Herdr ${name} reaches the real turn driver without cooling its credential`, async () => {
    const calls: string[] = []
    const host = new HerdrHost({
      workspaceId: 'w9',
      connect: async () => ({
        async call(method) {
          calls.push(method)
          if (method !== 'ping') throw new Error('unexpected pane creation')
          return pong
        },
      }),
    })
    // Substitute only session acquisition: the real host produces the refusal,
    // the real turn driver classifies it, and the real composer accounts for it.
    const spawn = spyOn(spawning, 'getOrSpawnSession').mockImplementation(async () => {
      await host.spawn(['claude'], { cwd: '/tmp', env: {} })
      throw new Error('unsupported protocol unexpectedly admitted')
    })
    restore = () => spawn.mockRestore()
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: [
      { id: 'fixture', kind: 'ambient', secret: '' },
    ] })
    const substrate = buildLlmCallSubstrate({
      pool, cwd: '/tmp', substrate_instance_id: 'protocol-credential-fixture',
      substrateFactory: options => createPersistentReplSubstrate(options),
    })!
    for (let attempt = 0; attempt < 6; attempt++) {
      const events: Event[] = []
      for await (const event of substrate.start(spec).events) events.push(event)
      expect(events).toEqual([expect.objectContaining({
        kind: 'error', code: 'spawn_configuration', retryable: false,
      })])
    }
    expect(spawn).toHaveBeenCalledTimes(6)
    expect(calls).toEqual(Array(6).fill('ping'))
    expect(pool.credentials[0]!.consecutive_failures).toBe(0)
    expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
    expect(pool.credentials[0]!.cooldown_reason).toBeUndefined()
  })
}

test('supported Herdr protocol remains admitted', async () => {
  await expect(verifyHerdrProtocol({
    call: async () => ({ protocol: HERDR_PROTOCOL_VERSION, version: 'fixture' }),
  })).resolves.toMatchObject({ protocol: HERDR_PROTOCOL_VERSION })
})

test('a provider rate limit still cools the selected credential', async () => {
  const pool = newCredentialPool({ strategy: 'fill_first', credentials: [
    { id: 'fixture', kind: 'ambient', secret: '' },
  ] })
  const substrate = buildLlmCallSubstrate({
    pool, cwd: '/tmp', substrate_instance_id: 'provider-limit-fixture',
    substrateFactory: () => ({
      start: () => ({
        events: (async function* (): AsyncGenerator<Event> {
          yield { kind: 'error', code: 'rate_limited', message: 'provider limit', retryable: true }
        })(),
        tool_resolution: 'internal', cancel: async () => {}, respondToTool: async () => {},
      }),
    }),
  })!
  for await (const _event of substrate.start(spec).events) { /* drain */ }
  expect(pool.credentials[0]!.cooldown_reason).toBe('rate_limit_429')
  expect(pool.credentials[0]!.cooldown_until).toBeGreaterThan(Date.now())
})
