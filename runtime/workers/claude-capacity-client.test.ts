import { afterEach, expect, test } from 'bun:test'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { connectClaudeCapacity, type ClaudeCapacityInput } from './claude-capacity-client.ts'
import { capacityFixture } from './claude-capacity-client.test-support.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(mode = 'available') {
  const server = await capacityFixture(mode); cleanup.push(server.close)
  const input: ClaudeCapacityInput = { request: { model_id: 'claude-fable-5-1' } as BoundedWorkRequest,
    leaseId: 'original-lease', childId: 'original-child', eventDigest: 'b'.repeat(64),
    configDir: server.configDir, env: {}, signal: new AbortController().signal, deadline: Date.now() + 1000 }
  return { ...server, input, run: () => server.acquire(input) }
}

test('exact signed model/child response holds the socket until explicit release', async () => {
  const f = await fixture(), result = await f.run()
  expect(result.kind).toBe('available')
  if (result.kind !== 'available') throw Error('Missing positive control')
  expect(result.current()).toBe(true)
  expect(f.requests[0]).toMatchObject({ modelId: f.input.request.model_id, leaseId: f.input.leaseId,
    childId: f.input.childId, eventDigest: f.input.eventDigest })
  expect(result.receipt.body.accountGeneration).toBe('a'.repeat(64))
  expect(f.sockets.size).toBe(1)
  result.release(); expect(result.current()).toBe(false)
})

test('all-full is waiting, while uncertainty never means all-full', async () => {
  const full = await fixture('all-full'), unsure = await fixture('unknown')
  expect(await full.run()).toMatchObject({ kind: 'waiting', receipt: { body: { status: 'all-full', accountGeneration: null } } })
  expect(await unsure.run()).toEqual({ kind: 'unknown' })
})

test.each(['forged', 'wrong-hostId', 'wrong-instanceId', 'wrong-bootId', 'wrong-challenge', 'wrong-modelId',
  'wrong-requestDigest', 'wrong-leaseId', 'wrong-childId', 'wrong-eventDigest', 'wrong-accountGeneration',
  'stale', 'future', 'extra-frame', 'disconnect'])('refuses %s signed or transport evidence', async mode => {
  const f = await fixture(mode)
  expect(await f.run()).toEqual({ kind: 'unknown' })
})

test.each(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CCR_OAUTH_TOKEN_FILE',
  'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_API_KEY_HELPER', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])('competing %s refuses before contacting selector', async key => {
  const f = await fixture(); f.input.env[key] = 'present'
  expect(await f.run()).toEqual({ kind: 'unknown' }); expect(f.requests).toHaveLength(0)
})

test('display alias, another config and a symlinked config refuse before selector input', async () => {
  const f = await fixture()
  const alias = join(f.configDir, '..', 'alias'); await symlink(f.configDir, alias)
  for (const input of [{ ...f.input, request: { ...f.input.request, model_id: 'fable' } },
    { ...f.input, configDir: alias }, { ...f.input, env: { CLAUDE_CONFIG_DIR: '/foreign' } }]) {
    expect(await connectClaudeCapacity(f.pin, input)).toEqual({ kind: 'unknown' })
  }
  expect(f.requests).toHaveLength(0)
})

test('deadline and abort release a waiting socket; post-response disconnect revokes eligibility', async () => {
  const f = await fixture('timeout'); f.input.deadline = Date.now() + 20
  expect(await f.run()).toEqual({ kind: 'unknown' })
  const g = await fixture(), controller = new AbortController(); g.input.signal = controller.signal
  const result = await g.run(); expect(result.kind).toBe('available')
  if (result.kind !== 'available') throw Error('Missing positive control')
  controller.abort(); expect(result.current()).toBe(false)
  const h = await fixture(), held = await h.run()
  if (held.kind !== 'available') throw Error('Missing positive control')
  for (const socket of h.sockets) socket.destroy()
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(held.current()).toBe(false)
})
