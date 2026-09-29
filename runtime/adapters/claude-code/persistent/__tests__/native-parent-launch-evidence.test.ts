import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareNativeParentLaunch, readNativeParentLaunchEvidence } from '../native-parent-launch-evidence.ts'
import { createPersistentReplSubstrate, poolKeyFor, shutdownAllPersistentRepls } from '../persistent-repl-substrate.ts'
import { pool } from '../pool-state.ts'
import { lifecycleReplHost } from './lifecycle-repl-host.ts'
import type { AgentSpec } from '../../../../substrate.ts'
import { classifyPaneForAdoption } from '../orphan-adoption.ts'

let dir: string
const body = '#!/bin/sh\nprintf "2.1.285 (Claude Code)\\n"\n'
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'native-launch-'))
  writeFileSync(join(dir, 'claude'), body, { mode: 0o700 })
})
afterEach(async () => { await shutdownAllPersistentRepls(); rmSync(dir, { recursive: true, force: true }) })
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
  for (const [project, tools] of [[true, ['Agent', 'SendMessage']], [true, ['Agent']], [false, ['Agent', 'SendMessage']]] as const) {
    const fake = lifecycleReplHost()
    const argvs: string[][] = []
    const options = { substrate_instance_id: `launch-${project}-${tools.length}`, user_id: 'owner',
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
})
