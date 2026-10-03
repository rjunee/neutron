import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as capacity from '@neutronai/runtime/workers/claude-capacity-client.ts'
import * as claude from '@neutronai/runtime/adapters/claude-code/index.ts'
import { authFingerprintFor } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'
import { poolKeyFor } from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import { newCredentialPool, reportFailure } from '@neutronai/runtime/credential-pool.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { buildLlmCallSubstrate, type ConversationOwner } from '../build-llm-call-substrate.ts'

const fingerprint = capacity.nativeRelayRouteFingerprint
const pin: capacity.ClaudeCapacityPin = {
  version: 1, hostId: 'fixture-host', instanceId: 'fixture-instance',
  socketPath: '/synthetic/relay.sock', claudeConfigDir: '/synthetic/claude',
  publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}
let routeLookup: ReturnType<typeof spyOn>
const homes: string[] = []
beforeEach(() => { routeLookup = spyOn(capacity, 'nativeRelayRouteFingerprint').mockImplementation(() => fingerprint(pin)) })
afterEach(() => {
  routeLookup.mockRestore()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fixture(options: { owner?: ConversationOwner; cwd?: string; resumeId?: string | null; poolMode?: 'none' | 'empty' | 'lazy'; result?: Event; extraEnv?: () => Promise<Record<string, string>> } = {}) {
  let cwd = options.cwd ?? '/synthetic/chat'
  if (options.cwd === undefined && options.resumeId !== null) {
    cwd = mkdtempSync(join(tmpdir(), 'registered-chat-owner-'))
    homes.push(cwd)
    const paths = claude.deriveReplSupervisionPaths(cwd)
    mkdirSync(paths.stateDir)
    const key = poolKeyFor({ substrate_instance_id: 'fixture-chat', user_id: 'fixture-owner',
      project_id: 'project-a', conversationProjectId: 'project-a', credential_identity: options.resumeId ?? 'original' })
    writeFileSync(paths.replRegistryPath, JSON.stringify({ [key]: { sessionKey: key, sessionId: 'original-session',
      cwd, channelName: `neutron-${'a'.repeat(32)}`, has_session: true, conversationProjectId: 'project-a' } }))
  }
  const pool = newCredentialPool({ strategy: 'round_robin', credentials: [
    { id: 'sibling', kind: 'api_key', secret: 'synthetic-sibling' },
    { id: 'original', kind: 'oauth', secret: 'synthetic-original' },
  ] })
  reportFailure(pool, 'original', 429)
  const seen: ClaudeCodeSubstrateOptions[] = []
  const handoffs: Array<{ sessionKey: string; credentialId: string }> = []
  let refreshes = 0
  const substrate = buildLlmCallSubstrate({
    ...(options.poolMode === 'none' ? {} : options.poolMode === 'empty' ? { pool: newCredentialPool({ strategy: 'fill_first', credentials: [] }) }
      : options.poolMode === 'lazy' ? { resolvePool: async () => { throw Error('Registered custody cannot query a local account pool') } } : { pool }),
    substrate_instance_id: 'fixture-chat', user_id: 'fixture-owner', cwd,
    ownerConversation: true, conversationProjectId: 'project-a', owner_handle: 'fixture-owner',
    ...(options.extraEnv === undefined ? {} : { extra_env: options.extraEnv }),
    oauthRefresh: { async loadAccessToken() { refreshes++; throw Error('Direct OAuth must not run') } },
    conversationLifecycle: {
      async ownerFor() { return options.owner ?? { kind: 'none' } },
      resumeCredentialFor() { return options.resumeId === null ? undefined : options.resumeId ?? 'original' },
      async handoffChat(_scope, next) { handoffs.push(next); return { status: 'ready' } },
    },
    substrateFactory(opts) {
      seen.push(opts)
      return { start() { return {
        events: (async function* () { yield options.result ?? { kind: 'completion',
          substrate_instance_id: 'fixture-chat', session: { id: 'original-session', last_active_at: 1 },
          usage: { input_tokens: 1, output_tokens: 1 } } as Event })(),
        tool_resolution: 'internal', async cancel() {}, async respondToTool() {},
      } } }
    },
  })!
  return { pool, seen, handoffs, substrate, refreshes: () => refreshes, async run() {
    const events: Event[] = []
    for await (const event of substrate.start({ prompt: 'continue', tools: [], model_preference: ['claude-fable-5-1'] }).events) events.push(event)
    return events
  } }
}

function recordedFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'registered-chat-'))
  homes.push(cwd)
  const paths = claude.deriveReplSupervisionPaths(cwd)
  mkdirSync(paths.stateDir)
  const identity = { substrate_instance_id: 'fixture-chat', user_id: 'fixture-owner',
    project_id: 'project-a', conversationProjectId: 'project-a', credential_identity: 'original' }
  const key = poolKeyFor(identity)
  const row = { sessionKey: key, sessionId: 'original-session', cwd, channelName: `neutron-${'a'.repeat(32)}`,
    has_session: true, conversationProjectId: 'project-a', reuse: { auth_fingerprint: 'stale', tool_surface: '', tool_bridge: false } }
  const save = (rows = { [key]: row }) => writeFileSync(paths.replRegistryPath, JSON.stringify(rows))
  save()
  return { ...fixture({ cwd, resumeId: null, poolMode: 'lazy' }), key, row, save, paths }
}

test('recorded dead conversation has one identity; two matching durable keys refuse before handoff', async () => {
  const f = recordedFixture()
  expect((await f.run())[0]?.kind).toBe('completion')
  expect(f.seen[0]!.credential_identity).toBe('original')
  f.save({ [f.key]: f.row, [f.key.replace('original', 'another')]: { ...f.row,
    sessionKey: f.key.replace('original', 'another'), sessionId: 'another-session' } })
  await expect(f.run()).rejects.toBeInstanceOf(capacity.NativeRelayUnavailable)
  expect(f.seen).toHaveLength(1)
  expect(f.handoffs).toHaveLength(1)
})

test('a broad foreign sleep pin cannot claim a proven empty exact conversation scope', async () => {
  const f = recordedFixture()
  const foreignKey = f.key.replace('fixture-owner', 'foreign-owner')
  f.save({ [foreignKey]: { ...f.row, sessionKey: foreignKey, sessionId: 'foreign-session' } })
  const dispatch = fixture({ cwd: f.row.cwd, resumeId: 'foreign-asleep', poolMode: 'lazy' })
  expect((await dispatch.run())[0]?.kind).toBe('completion')
  expect(dispatch.seen[0]!.credential_identity).toBe(fingerprint(pin)!)
  expect(dispatch.seen[0]!.credential_identity).not.toBe('foreign-asleep')
})

test('registered boot discovery reaches the original strict fingerprint refusal without reading a local pool', async () => {
  const f = recordedFixture()
  const original = claude.recoverExistingClaudeRepl
  const outcomes: unknown[] = []
  const recover = spyOn(claude, 'recoverExistingClaudeRepl').mockImplementation(async (options, tools) => {
    expect(options.credential_identity).toBe('original')
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined()
    const outcome = await original(options, tools)
    outcomes.push(outcome)
    return outcome
  })
  const before = readFileSync(f.paths.replRegistryPath, 'utf8')
  try {
    await f.substrate.recoverExisting(['project-a'], [])
    expect(outcomes).toEqual([{ status: 'refused', reason: 'startup recovery credential fingerprint is missing or changed' }])
    expect(readFileSync(f.paths.replRegistryPath, 'utf8')).toBe(before)
    expect(f.seen).toHaveLength(0)
    expect(f.refreshes()).toBe(0)
  } finally { recover.mockRestore() }
})

for (const poolMode of ['none', 'empty', 'lazy'] as const) test(`registered first Chat uses only canonical route identity with ${poolMode} local pool`, async () => {
  const f = fixture({ poolMode, resumeId: null })
  expect((await f.run())[0]?.kind).toBe('completion')
  expect(f.seen[0]!.credential_identity).toBe(fingerprint(pin)!)
  expect(f.refreshes()).toBe(0)
})

for (const empty of [false, true]) test(`broken Claude route cannot block Codex construction with empty pool=${empty}`, async () => {
  routeLookup.mockImplementation(() => { throw new capacity.NativeRelayUnavailable('Synthetic unavailable registration') })
  let starts = 0
  const substrate = buildLlmCallSubstrate({ substrate_instance_id: 'fixture-chat', ownerConversation: true,
    ...(empty ? { pool: newCredentialPool({ strategy: 'fill_first', credentials: [] }) } : {}),
    provider: 'openai-codex', startCodexOwner() {
      starts++
      return { events: (async function* () { yield { kind: 'token', text: 'codex' } as Event })(),
        tool_resolution: 'internal', async cancel() {}, async respondToTool() {} }
    },
  })!
  const events: Event[] = []
  for await (const event of substrate.start({ prompt: 'continue', tools: [], model_preference: [] }).events) events.push(event)
  expect(events).toEqual([{ kind: 'token', text: 'codex' }])
  expect(starts).toBe(1)
})

test('registered asleep Chat preserves its parked identity without reading secrets, refreshing or clearing cooldown', async () => {
  const f = fixture()
  reportFailure(f.pool, 'sibling', 429)
  const before = JSON.stringify(f.pool)
  for (const credential of f.pool.credentials) Object.defineProperty(credential, 'secret', {
    configurable: true, enumerable: false, get() { throw Error('Host custody cannot read a local secret') },
  })
  expect((await f.run())[0]?.kind).toBe('completion')
  expect(f.seen).toHaveLength(1)
  expect(f.seen[0]!.credential_identity).toBe('original')
  expect(f.seen[0]!.env).toEqual({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined })
  expect(authFingerprintFor(f.seen[0]!.env)).toBe(fingerprint(pin)!)
  expect(f.handoffs).toEqual([{ sessionKey: poolKeyFor(f.seen[0]!), credentialId: 'original' }])
  expect(f.refreshes()).toBe(0)
  expect(f.pool.credentials.map(({ id, cooldown_until, use_count }) => ({ id, cooldown_until, use_count })))
    .toEqual(JSON.parse(before).credentials.map(({ id, cooldown_until, use_count }: { id: string; cooldown_until: number; use_count: number }) => ({ id, cooldown_until, use_count })))
})

test('registered live owner keeps its exact key even when a local sibling is usable', async () => {
  const expectedKey = poolKeyFor({ substrate_instance_id: 'fixture-chat', user_id: 'fixture-owner',
    project_id: 'project-a', credential_identity: 'original' })
  const f = fixture({ owner: { kind: 'owner', credentialId: 'original', sessionKey: expectedKey, sessionId: 'original-session' } })
  await f.run()
  expect(f.handoffs).toEqual([{ sessionKey: expectedKey, credentialId: 'original' }])
  expect(f.refreshes()).toBe(0)
})

test('registered provider rejection is not attributed to an Open conversation key', async () => {
  const result: Event = { kind: 'error', code: 'rate_limited', message: 'HTTP 429: quota', retryable: true }
  const f = fixture({ result })
  const before = JSON.stringify(f.pool)
  expect(await f.run()).toEqual([result])
  expect(JSON.stringify(f.pool)).toBe(before)
})

test('host custody preserves an asleep identity absent from the local account pool', async () => {
  const f = fixture({ resumeId: 'removed' })
  expect((await f.run())[0]?.kind).toBe('completion')
  expect(f.seen[0]!.credential_identity).toBe('removed')
  expect(f.refreshes()).toBe(0)
})

test('ambiguous registered owner permits only an existing survivor key', async () => {
  const expectedKey = poolKeyFor({ substrate_instance_id: 'fixture-chat', user_id: 'fixture-owner',
    project_id: 'project-a', credential_identity: 'original' })
  const yes = fixture({ owner: { kind: 'ambiguous', count: 2, credentialIds: ['original'], sessionKeys: [expectedKey] } })
  expect((await yes.run())[0]?.kind).toBe('completion')
  expect(yes.handoffs).toHaveLength(0)
  const no = fixture({ owner: { kind: 'ambiguous', count: 2, credentialIds: ['original'], sessionKeys: ['foreign-key'] } })
  expect((await no.run())[0]).toMatchObject({ kind: 'error', code: 'chat_handoff_unknown' })
  expect(no.seen).toHaveLength(0)
})

test('invalid or unavailable registered route refuses before handoff and never becomes pool quota', async () => {
  const f = fixture()
  routeLookup.mockImplementation(() => { throw new capacity.NativeRelayUnavailable('Synthetic unavailable route') })
  await expect(f.run()).rejects.toBeInstanceOf(capacity.NativeRelayUnavailable)
  expect(f.handoffs).toHaveLength(0)
  expect(f.seen).toHaveLength(0)
  expect(f.refreshes()).toBe(0)
})

test('route replacement during asynchronous option preparation refuses before handoff', async () => {
  const f = fixture({ extraEnv: async () => {
    routeLookup.mockImplementation(() => fingerprint({ ...pin, hostId: 'replacement-host' }))
    return {}
  } })
  await expect(f.run()).rejects.toBeInstanceOf(capacity.NativeRelayUnavailable)
  expect(f.handoffs).toHaveLength(0)
  expect(f.seen).toHaveLength(0)
})

test('unregistered self-host still rotates from a parked identity and reports its credential use', async () => {
  routeLookup.mockReturnValue(undefined)
  const f = fixture()
  expect((await f.run())[0]?.kind).toBe('completion')
  expect(f.seen[0]!.credential_identity).toBe('sibling')
  expect(f.seen[0]!.env?.ANTHROPIC_API_KEY).toBe('synthetic-sibling')
  expect(f.pool.credentials[0]!.use_count).toBeGreaterThan(0)
})

test('unregistered self-host still refuses an all-cooldown pool', async () => {
  routeLookup.mockReturnValue(undefined)
  const f = fixture()
  reportFailure(f.pool, 'sibling', 429)
  expect((await f.run())[0]).toMatchObject({ kind: 'error', code: 'all_cooldown' })
  expect(f.seen).toHaveLength(0)
})
