import { expect, test } from 'bun:test'
import { prepareAdoptedNativeParentLaunch, type AdoptedNativeLaunchDeps } from '../adopted-native-parent-launch.ts'
import { readNativeParentLaunchEvidence } from '../native-parent-launch-evidence.ts'
import type { HandleInspection } from '../pty-host.ts'

function fixture() {
  const argv = ['claude', '--resume', 'session', '--tools', 'Agent,SendMessage',
    '--dangerously-load-development-channels', 'server:channel']
  const state = { identity: { boot_id: 'boot', start_ticks: 10 }, argv: [...argv], current: true,
    host: { kind: 'live', pid: 42, argv: [...argv] } as HandleInspection }
  const input = { pid: 42, sessionId: 'session', childGeneration: 'generation', projectId: 'project',
    channelName: 'channel', cwd: '/tmp', claudeBasename: 'claude', argv,
    inspect: async () => state.host }
  const deps: AdoptedNativeLaunchDeps = {
    readIdentity: () => state.identity, readArgv: () => state.argv,
    observeExecutable: async (path, _cwd, env) => {
      expect(path).toBe('/proc/42/exe')
      expect(env).toEqual({})
      return { executable: { realPath: '/opt/claude.exe', version: '2.1.285', sha256: 'measured' }, isCurrent: () => state.current }
    },
  }
  return { input, deps, state }
}

test('remeasures exact live parent and binds only when adoption publishes', async () => {
  const f = fixture(), session = {}
  const prepared = await prepareAdoptedNativeParentLaunch(f.input, f.deps)
  expect(prepared).toBeDefined()
  expect(readNativeParentLaunchEvidence(session)).toBeUndefined()
  prepared!.record(session)
  expect(readNativeParentLaunchEvidence(session)).toMatchObject({ sessionId: 'session', childGeneration: 'generation',
    projectId: 'project', argv: f.input.argv, tools: ['Agent', 'SendMessage'], executable: { sha256: 'measured' } })
})

test('missing identity, foreign host/PID/argv/session/channel and ambiguous grants refuse evidence', async () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.deps.readIdentity = () => undefined },
    f => { f.deps.readArgv = () => undefined },
    f => { f.state.host = { kind: 'unavailable', reason: 'unreadable' } },
    f => { f.state.host = { kind: 'live', pid: 43, argv: f.input.argv } },
    f => { f.state.argv[0] = 'other' },
    f => { f.input.sessionId = 'foreign' },
    f => { f.input.channelName = 'foreign' },
    f => { f.input.projectId = '' },
    f => { f.input.childGeneration = '' },
    f => { f.input.argv.push('--tools', 'Agent'); f.state.argv = [...f.input.argv] },
    f => { f.input.argv.push('--session-id', 'session'); f.state.argv = [...f.input.argv] },
    f => { f.input.argv[4] = 'Agent'; f.state.argv = [...f.input.argv] },
    f => { f.deps.observeExecutable = async () => undefined },
  ]
  for (const change of cases) {
    const f = fixture(); change(f)
    expect(await prepareAdoptedNativeParentLaunch(f.input, f.deps)).toBeUndefined()
  }
})

test('recycled PID, changed boot, argv or executable before publication never stamp', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.identity = { ...f.state.identity, start_ticks: 11 } },
    (f: ReturnType<typeof fixture>) => { f.state.identity = { ...f.state.identity, boot_id: 'other-boot' } },
    (f: ReturnType<typeof fixture>) => { f.state.argv[4] = 'Agent' },
    (f: ReturnType<typeof fixture>) => { f.state.current = false },
  ]) {
    const f = fixture(), session = {}
    const prepared = await prepareAdoptedNativeParentLaunch(f.input, f.deps)
    expect(prepared).toBeDefined()
    change(f)
    prepared!.record(session)
    expect(readNativeParentLaunchEvidence(session)).toBeUndefined()
  }
})

test('identity change inside image measurement refuses preparation', async () => {
  const f = fixture(), observe = f.deps.observeExecutable!
  f.deps.observeExecutable = async (...args) => {
    const result = await observe(...args)
    f.state.identity = { ...f.state.identity, start_ticks: 12 }
    return result
  }
  expect(await prepareAdoptedNativeParentLaunch(f.input, f.deps)).toBeUndefined()
})
