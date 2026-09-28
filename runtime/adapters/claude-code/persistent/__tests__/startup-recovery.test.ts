import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { recoverStartupRepl } from '../startup-recovery.ts'
import { resetBootAdoptionForTests } from '../boot-adoption.ts'
import { ReplSession, unlinkSessionConfigs } from '../repl-session.ts'
import { disownPane, type ReplRegistryRecord } from '../repl-registry.ts'
import { sessionJsonlPath } from '../session-size-watchdog.ts'
import { getOrSpawnSession } from '../spawn.ts'
import { childByKey, pool, sink } from '../pool-state.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import type { AdoptableHost, PtyChild } from '../pty-host.ts'
import { FakeAdoptableHost } from './boot-adoption-host.ts'

const dirs: string[] = []
const sinkDir = mkdtempSync(join(tmpdir(), 'neutron-startup-sink-'))
afterAll(() => rmSync(sinkDir, { recursive: true, force: true }))
const key = 'startup-recovery-test'
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  resetBootAdoptionForTests()
  pool.delete(key)
  childByKey.delete(key)
  await sink.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  resetBootAdoptionForTests()
  const dir = mkdtempSync(join(tmpdir(), 'neutron-startup-recovery-')); dirs.push(dir)
  const options: PersistentReplSubstrateOptions = {
    substrate_instance_id: 'startup-recovery-test', cwd: dir, project_id: 'project-a', conversationProjectId: 'project-a',
    replRegistryPath: join(dir, 'registry.json'), projectsDir: join(dir, 'projects'),
    sinkTokenPath: join(sinkDir, 'token'), skipTrustSeed: true,
  }
  const row: ReplRegistryRecord = { sessionKey: key, sessionId: 'aaaa1111-2222-3333-4444-555555555555',
    cwd: dir, channelName: 'neutron-11112222333344445555666677778888', has_session: true, model: 'claude-test-model', effort: 'max',
    conversationProjectId: 'project-a', reuse: { tool_surface: 'Read', tool_bridge: false, auth_fingerprint: '' } }
  const save = (record: ReplRegistryRecord | undefined = row) => writeFileSync(options.replRegistryPath!, JSON.stringify(record ? { [key]: record } : {}))
  save()
  const transcript = sessionJsonlPath(row.sessionId, dir, options.projectsDir)
  mkdirSync(dirname(transcript), { recursive: true }); writeFileSync(transcript, '{"conversation":"retained"}\n')
  const calls: unknown[][] = []
  const spawn: typeof getOrSpawnSession = async (...args) => {
    calls.push(args)
    return new ReplSession(key, 'new-generation', args[3]!.sessionId, 'new-channel', dir)
  }
  const recover = (record = row) => { save(record); return recoverStartupRepl(options, key, [{ name: 'Read' }], {
    adoption: { listProcesses: () => [] }, spawn,
  }) }
  return { dir, row, options, save, transcript, calls, spawn, recover }
}

test('a dead row whose pane was cleared resumes the recorded conversation/model/effort without any prompt', async () => {
  const f = fixture()
  const result = await f.recover(disownPane({ ...f.row, pane_handle: 'dead-pane', adoption_claim_by: 'old-owner' }))
  expect(result).toEqual({ status: 'resumed' })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]![1]).toMatchObject({ project_id: 'project-a', cwd: f.dir, effort: 'max' })
  expect(f.calls[0]![2]).toEqual({ tools: [{ name: 'Read' }], model_preference: ['claude-test-model'] })
  expect(f.calls[0]![3]).toEqual({ sessionId: f.row.sessionId, expectedRecord: f.row })
  expect(readFileSync(f.transcript, 'utf8')).toContain('retained')
})

test('absent/retired authority stays asleep, while a captured active row resumes', async () => {
  const f = fixture(); writeFileSync(f.options.replRegistryPath!, '{}')
  expect(await recoverStartupRepl(f.options, key, [{ name: 'Read' }], { spawn: f.spawn })).toEqual({ status: 'skipped' })
  expect(f.calls).toHaveLength(0)
  expect(await f.recover()).toEqual({ status: 'resumed' })
})

test('explicit sleep preserves its durable row and transcript without a startup wake', async () => {
  const f = fixture()
  const sleeping = { ...f.row, asleep_at: Date.now() }
  expect(await f.recover(sleeping)).toEqual({ status: 'skipped' })
  expect(f.calls).toHaveLength(0)
  expect(JSON.parse(readFileSync(f.options.replRegistryPath!, 'utf8'))[key]).toEqual(sleeping)
  expect(readFileSync(f.transcript, 'utf8')).toContain('retained')
  expect(await f.recover()).toEqual({ status: 'resumed' })
  expect(f.calls).toHaveLength(1)
})

test.each([
  ['changed credential', { reuse: { tool_surface: 'Read', tool_bridge: false, auth_fingerprint: 'changed' } }],
  ['foreign project', { conversationProjectId: 'project-b' }],
  ['wrong cwd', { cwd: '/invalid-project' }],
  ['uncaptured conversation', { has_session: false }],
  ['missing model', { model: '' }],
  ['hard-capped session', { capped_at: 10 }],
  ['changed tools', { reuse: { tool_surface: 'Write', tool_bridge: false, auth_fingerprint: '' } }],
] as const)('%s refuses without a spawn', async (_name, patch) => {
  const f = fixture()
  expect((await f.recover({ ...f.row, ...patch })).status).toBe('refused')
  expect(f.calls).toHaveLength(0)
})

test('an unknown transcript owner refuses; a positive empty process scan permits recovery', async () => {
  const f = fixture()
  expect((await recoverStartupRepl(f.options, key, [{ name: 'Read' }], {
    adoption: { listProcesses: () => undefined }, spawn: f.spawn,
  })).status).toBe('refused')
  expect(f.calls).toHaveLength(0)
  expect(await f.recover()).toEqual({ status: 'resumed' })
})

test('missing transcript never becomes a fresh session', async () => {
  const f = fixture(); rmSync(f.transcript)
  expect((await f.recover()).status).toBe('refused')
  expect(f.calls).toHaveLength(0)
})

test('unreadable durable identity refuses instead of treating it as an asleep row', async () => {
  const f = fixture(); writeFileSync(f.options.replRegistryPath!, 'not-json')
  expect(await recoverStartupRepl(f.options, key, [{ name: 'Read' }], { spawn: f.spawn })).toMatchObject({
    status: 'refused', reason: expect.stringContaining('durable registry identity'),
  })
  expect(f.calls).toHaveLength(0)
  expect(await f.recover()).toEqual({ status: 'resumed' })
})

test('a retained adopted owner is reused, but its later exit invalidates the cached adoption and recovers', async () => {
  const f = fixture()
  const host = new FakeAdoptableHost()
  f.options.ptyHost = host
  const row = { ...f.row, child_generation: 'previous-child', pane_handle: 'previous-pane', pid: 2_147_483_647, devchannel_port: 22222 }
  f.save(row)
  host.addPane('previous-pane', { pid: row.pid, screens: ['❯ '], argv: [
    'claude', '--resume', row.sessionId, '--dangerously-load-development-channels', `server:${row.channelName}`,
  ] })
  const recover = () => recoverStartupRepl(f.options, key, [{ name: 'Read' }], {
    adoption: { host, listProcesses: () => [], health: async () => true }, spawn: f.spawn,
  })
  expect(await recover()).toEqual({ status: 'adopted' })
  const inspected = host.inspections.length
  expect(await recover()).toEqual({ status: 'adopted' })
  expect(host.inspections).toHaveLength(inspected)
  expect(f.calls).toHaveLength(0)
  const session = await pool.get(key)
  expect(session?.childGeneration).toBe('previous-child')
  cleanup.push(() => { session?.sizeWatchdog?.stop(); session?.deadTurnWatcher?.stop(); session?.selfFenceTimer?.cancel() })
  host.attached[0]!.kill()
  await host.attached[0]!.exited
  for (let i = 0; i < 20 && pool.has(key); i++) await Promise.resolve()
  expect(pool.has(key)).toBe(false)
  expect(await recover()).toEqual({ status: 'resumed' })
  expect(f.calls).toHaveLength(1)
  expect((f.calls[0]![3] as { sessionId: string }).sessionId).toBe(row.sessionId)
})

test('the real spawn reservation refuses retirement during preparation; unchanged authority reaches the fake host', async () => {
  const f = fixture()
  let spawns = 0
  const host: AdoptableHost = {
    async spawn() { spawns++; throw new Error('contained spawn boundary') },
    async inspectHandle() { return { kind: 'gone' } },
    async attach() { throw new Error('unexpected attach') }, async closeHandle() { throw new Error('unexpected close') },
  }
  f.options.ptyHost = host
  f.options.admissionGeneration = async () => { writeFileSync(f.options.replRegistryPath!, '{}'); return 0 }
  const run = () => recoverStartupRepl(f.options, key, [{ name: 'Read' }], { adoption: { listProcesses: () => [] } })
  expect(await run()).toMatchObject({ status: 'refused', reason: expect.stringContaining('RESERVED') })
  expect(spawns).toBe(0)
  expect(JSON.parse(readFileSync(f.options.replRegistryPath!, 'utf8'))).toEqual({})
  delete f.options.admissionGeneration
  f.save()
  expect(await run()).toMatchObject({ status: 'refused', reason: 'contained spawn boundary' })
  expect(spawns).toBe(1)
})

test.each([false, true])('native startup boundary preserves the transcript and submits zero turns (picker rejected: %s)', async picker => {
  const f = fixture()
  let spawns = 0
  let writes = 0
  let exited = false
  let exit!: () => void
  const done = new Promise<null>(resolve => { exit = () => { exited = true; resolve(null) } })
  const health = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => Response.json({ ok: true, session_id: f.row.sessionId }) })
  cleanup.push(() => { exit(); health.stop(true) })
  let argvSeen: string[] = []
  const host: AdoptableHost = {
    async spawn(argv, opts) {
      spawns++; argvSeen = [...argv]
      const config = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1]!, 'utf8'))
      const channel = Object.values(config.mcpServers)[0] as { env: Record<string, string> }
      for (const path of ['/channel-ready', '/channel-bound']) {
        const response = await fetch(`http://127.0.0.1:${sink.port}${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sink-Token': channel.env.SINK_TOKEN! },
          body: JSON.stringify({ session_id: f.row.sessionId, channel_port: health.port }),
        })
        expect(response.status).toBe(200)
      }
      const child: PtyChild = { pid: 2_147_483_647, paneHandle: 'contained-pane', exited: done,
        hasExited: () => exited, kill: () => { exit() }, write: () => { writes++ },
        writeKey: () => { writes++ }, submitLine: async () => { writes++ },
        beginOutput: () => opts.onScreen?.(picker ? 'Resume Session\nChoose a conversation\nEsc to clear' : '❯ '),
      }
      return child
    },
    async inspectHandle() { return { kind: 'gone' } },
    async attach() { throw new Error('unexpected attach') }, async closeHandle() { throw new Error('unexpected close') },
  }
  f.options.ptyHost = host
  const recover = () => recoverStartupRepl(f.options, key, [{ name: 'Read' }], { adoption: { listProcesses: () => [] } })
  const outcomes = await Promise.all(picker ? [recover()] : [recover(), recover()])
  const outcome = outcomes[0]!
  if (picker) {
    expect(outcome).toMatchObject({ status: 'refused', reason: expect.stringContaining('rejected the recorded transcript') })
    expect(exited).toBe(true)
  } else {
    expect(outcome).toEqual({ status: 'resumed' })
    expect(outcomes[1]).toEqual({ status: 'resumed' })
    const session = await pool.get(key)
    expect(session?.sessionId).toBe(f.row.sessionId)
    expect(session?.projectId).toBe('project-a')
    cleanup.push(() => { session?.sizeWatchdog?.stop(); session?.deadTurnWatcher?.stop();
      if (session) { sink.unregister(session.sessionId); unlinkSessionConfigs(session); session.paneClaimBy = undefined } })
    expect(await recover()).toEqual({ status: 'adopted' })
    const row = JSON.parse(readFileSync(f.options.replRegistryPath!, 'utf8'))[key]
    expect(row).toMatchObject({ sessionId: f.row.sessionId, model: f.row.model, effort: 'max', pane_handle: 'contained-pane' })
  }
  expect(spawns).toBe(1)
  expect(writes).toBe(0)
  expect(argvSeen[argvSeen.indexOf('--resume') + 1]).toBe(f.row.sessionId)
  expect(argvSeen).not.toContain('--session-id')
  expect(readFileSync(f.transcript, 'utf8')).toContain('retained')
})
