import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import * as capacity from '../../../../workers/claude-capacity-client.ts'
import { createHash } from 'node:crypto'
import { mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareNativeParentLaunch, readNativeParentLaunchEvidence } from '../native-parent-launch-evidence.ts'
import { createPersistentReplSubstrate, poolKeyFor, shutdownAllPersistentRepls } from '../persistent-repl-substrate.ts'
import { pool } from '../pool-state.ts'
import { lifecycleReplHost } from './lifecycle-repl-host.ts'
import type { AgentSpec } from '../../../../substrate.ts'
import { capacityFixture } from '../../../../workers/claude-capacity-client.test-support.ts'
import { getRecord } from '../repl-registry.ts'
import { classifyPaneForAdoption } from '../orphan-adoption.ts'
import { setNativeChildLiveness } from '../native-child-liveness.ts'

let dir: string
const launchOwner = 'native-launch-evidence-owner'
const body = '#!/bin/sh\nprintf "2.1.285 (Claude Code)\\n"\n'
let pinLookup: ReturnType<typeof spyOn<typeof capacity, 'loadClaudeCapacityPin'>>
let routeLookup: ReturnType<typeof spyOn<typeof capacity, 'nativeRelayRouteFingerprint'>>
const realRouteFingerprint = capacity.nativeRelayRouteFingerprint
beforeEach(() => {
  // The synthetic executable and lifecycle PTY model an UNREGISTERED self-host.
  pinLookup = spyOn(capacity, 'loadClaudeCapacityPin').mockReturnValue(undefined)
  routeLookup = spyOn(capacity, 'nativeRelayRouteFingerprint').mockReturnValue(undefined)
  dir = mkdtempSync(join(tmpdir(), 'native-launch-'))
  writeFileSync(join(dir, 'claude'), body, { mode: 0o700 })
})
afterEach(async () => {
  try {
    setNativeChildLiveness(launchOwner, undefined)
    await shutdownAllPersistentRepls()
    rmSync(dir, { recursive: true, force: true })
  } finally { pinLookup.mockRestore(); routeLookup.mockRestore() }
})
const input = () => ({ sessionId: 'session', childGeneration: 'generation', projectId: 'project',
  argv: ['claude', '--session-id', 'session', '--tools', 'Agent,SendMessage'],
  tools: ['Agent', 'SendMessage'], cwd: dir, env: { PATH: dir } })

test('observes actual executable bytes/version and binds only the successful host session', async () => {
  const launch = await prepareNativeParentLaunch(input())
  expect(launch).toBeDefined()
  expect(launch!.argv[0]).toBe('claude')
  const session = {}
  expect(readNativeParentLaunchEvidence(session)).toBeUndefined()
  launch!.record(session)
  const evidence = readNativeParentLaunchEvidence(session)!
  expect(evidence).toMatchObject({ sessionId: 'session', childGeneration: 'generation', projectId: 'project',
    executable: { version: '2.1.285', sha256: createHash('sha256').update(body).digest('hex') },
    tools: ['Agent', 'SendMessage'] })
  expect(Object.isFrozen(evidence.argv)).toBe(true)
  expect(Object.isFrozen(evidence.executable)).toBe(true)
  expect(readNativeParentLaunchEvidence({})).toBeUndefined()
})

test('a genuine registered launch captures the current Unix protocol and route fingerprint', async () => {
  const authority = await capacityFixture()
  const fake = lifecycleReplHost()
  const route = realRouteFingerprint(authority.pin)!
  pinLookup.mockReturnValue(authority.pin); routeLookup.mockReturnValue(route)
  const launches: Array<Record<string, string | undefined>> = []
  setNativeChildLiveness(launchOwner, () => false)
  const options = { substrate_instance_id: 'native-wire-launch', user_id: launchOwner, project_id: 'project',
    conversationProjectId: 'project', cwd: dir, claude_bin: join(dir, 'claude'), skipTrustSeed: true,
    replRegistryPath: join(dir, 'registry.json'), idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ptyHost: { async spawn(argv: string[], opts: Parameters<typeof fake.host.spawn>[1]) {
      launches.push(opts.env ?? {})
      const child = await fake.host.spawn(argv, opts)
      // The fake PTY owns no OS process; this live fixture identity lets the
      // real signed registration transport attest the synthetic parent.
      Object.defineProperty(child, 'pid', { value: process.pid })
      return child
    } },
  }
  try {
    const substrate = createPersistentReplSubstrate(options)
    for await (const event of substrate.start({ prompt: 'ready', model_preference: ['claude-opus-4-7'],
      tools: [{ name: 'Read' }] as AgentSpec['tools'] }).events) {
      if (event.kind === 'error') throw new Error(event.message)
    }
    expect(launches).toHaveLength(1)
    expect(launches[0]!.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:0')
    expect(launches[0]!.ANTHROPIC_UNIX_SOCKET).toBe(authority.pin.socketPath)
    const session = await pool.get(poolKeyFor(options))
    expect(session?.authFingerprint).toBe(route)
    expect(getRecord(options.replRegistryPath, poolKeyFor(options))?.reuse?.auth_fingerprint).toBe(route)
    expect(authority.requests.some(request => request.kind === 'claude-native-register')).toBe(true)
  } finally { await shutdownAllPersistentRepls(); await authority.close() }
})

test('Agent-only, General, missing executable and failed version probe supply no evidence', async () => {
  expect(await prepareNativeParentLaunch({ ...input(), tools: ['Agent'] })).toBeUndefined()
  expect(await prepareNativeParentLaunch({ ...input(), projectId: '' })).toBeUndefined()
  expect(await prepareNativeParentLaunch({ ...input(), argv: ['absent'] })).toBeUndefined()
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  expect(await prepareNativeParentLaunch(input())).toBeUndefined()
})

test('configured symlink launcher stays adoptable while resolved executable evidence stays exact', async () => {
  renameSync(join(dir, 'claude'), join(dir, 'claude.exe'))
  symlinkSync(join(dir, 'claude.exe'), join(dir, 'claude'))
  const requested = input()
  requested.argv.push('--dangerously-load-development-channels', 'server:channel')
  const launch = (await prepareNativeParentLaunch(requested))!
  const session = {}
  launch.record(session)
  const evidence = readNativeParentLaunchEvidence(session)!
  expect(evidence.executable.realPath).toBe(join(dir, 'claude.exe'))
  expect(launch.argv).toEqual(requested.argv)
  expect(classifyPaneForAdoption({ kind: 'live', argv: launch.argv },
    { sessionId: 'session', channelName: 'channel' }).kind).toBe('adopt')
  expect(classifyPaneForAdoption({ kind: 'live', argv: [evidence.executable.realPath, ...launch.argv.slice(1)] },
    { sessionId: 'session', channelName: 'channel' }).kind).toBe('leave-not-ours')
  writeFileSync(join(dir, 'replacement.exe'), body, { mode: 0o700 })
  unlinkSync(join(dir, 'claude'))
  symlinkSync(join(dir, 'replacement.exe'), join(dir, 'claude'))
  const replaced = {}
  launch.record(replaced)
  expect(readNativeParentLaunchEvidence(replaced)).toBeUndefined()
})

test('executable replacement during spawn invalidates observation; next launch remeasures', async () => {
  const launch = await prepareNativeParentLaunch(input())
  const changed = '#!/bin/sh\nprintf "2.1.286 (Claude Code)\\n"\n'
  writeFileSync(join(dir, 'claude'), changed, { mode: 0o700 })
  const session = {}
  launch!.record(session)
  expect(readNativeParentLaunchEvidence(session)).toBeUndefined()
  const next = await prepareNativeParentLaunch(input())
  next!.record(session)
  expect(readNativeParentLaunchEvidence(session)!.executable).toMatchObject({ version: '2.1.286',
    sha256: createHash('sha256').update(changed).digest('hex') })
})

test('production spawn records only explicitly granted project launches after the host accepts argv', async () => {
  // Composition fixtures can leave a census over a closed database for `owner`.
  // This launch fixture owns its empty census and checks the scope actually read.
  const scopes: Array<string | null> = []
  setNativeChildLiveness(launchOwner, scope => { scopes.push(scope); return false })
  for (const [project, tools] of [[true, ['Agent', 'SendMessage']], [true, ['Agent']], [false, ['Agent', 'SendMessage']]] as const) {
    const fake = lifecycleReplHost()
    const argvs: string[][] = []
    const options = { substrate_instance_id: `launch-${project}-${tools.length}`, user_id: launchOwner,
      project_id: project ? 'project' : 'general', conversationProjectId: project ? 'project' : null,
      cwd: dir, claude_bin: join(dir, 'claude'), skipTrustSeed: true, idleQuietMs: 0,
      captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
      assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
      ptyHost: { async spawn(argv: string[], opts: Parameters<typeof fake.host.spawn>[1]) {
        argvs.push(argv)
        return fake.host.spawn(argv, opts)
      } },
    }
    const substrate = createPersistentReplSubstrate(options)
    for await (const event of substrate.start({ prompt: 'hello', model_preference: ['claude-opus-4-7'],
      tools: tools.map(name => ({ name })) as AgentSpec['tools'] }).events) {
      if (event.kind === 'error') throw new Error(event.message)
    }
    const session = await pool.get(poolKeyFor(options))
    expect(session).toBeDefined()
    const evidence = readNativeParentLaunchEvidence(session!)
    if (project && (tools as readonly string[]).includes('SendMessage')) {
      expect(evidence).toMatchObject({ sessionId: session!.sessionId, childGeneration: session!.childGeneration, projectId: 'project' })
      expect(evidence!.argv).toEqual(argvs[0]!)
      expect(evidence!.tools).toEqual(tools)
    } else expect(evidence).toBeUndefined()
  }
  expect(scopes).toEqual(['project', 'project', null])
})
