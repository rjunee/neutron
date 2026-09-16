import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AdoptableHost,
  HandleInspection,
  PtyChild,
  PtySpawnOpts,
} from '../../claude-code/persistent/pty-host.ts'
import { CodexProjectSessionHost } from './project-session.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

class FakeHost implements AdoptableHost {
  inspection: HandleInspection = { kind: 'gone' }
  spawned: string[][] = []
  attached: string[] = []
  submissions: string[] = []
  active = 0
  maxActive = 0
  kills = 0
  exitedFlag = false
  holds: Array<ReturnType<typeof deferred>> = []
  child = this.makeChild('pane-1')

  private makeChild(handle: string): PtyChild {
    return {
      pid: 123,
      paneHandle: handle,
      write() {},
      submitLine: async (line) => {
        this.active += 1
        this.maxActive = Math.max(this.maxActive, this.active)
        this.submissions.push(line)
        const hold = this.holds.shift()
        if (hold !== undefined) await hold.promise
        this.active -= 1
      },
      kill: () => { this.kills += 1 },
      exited: new Promise(() => {}),
      hasExited: () => this.exitedFlag,
      detach() {},
      beginOutput() {},
    }
  }

  async spawn(argv: string[], _options: PtySpawnOpts): Promise<PtyChild> {
    this.spawned.push(argv)
    return this.child
  }
  async attach(handle: string, _options: PtySpawnOpts): Promise<PtyChild> {
    this.attached.push(handle)
    return this.child
  }
  async inspectHandle(_handle: string): Promise<HandleInspection> { return this.inspection }
  async closeHandle(_handle: string): Promise<void> {}
}

function fixture(host = new FakeHost()) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-project-session-'))
  dirs.push(dir)
  const registryPath = join(dir, 'sessions.json')
  const sessionHost = new CodexProjectSessionHost({ registryPath, host })
  return { host, registryPath, sessionHost }
}

const OPEN = { projectId: 'project-a', cwd: '/project', env: {} }

describe('CodexProjectSessionHost', () => {
  test('starts an interactive Codex pane and records its restart handle', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(OPEN)
    expect(session.recovery).toBe('started')
    expect(f.host.spawned).toEqual([['codex', '--enable', 'multi_agent_v2']])
    expect(JSON.parse(readFileSync(f.registryPath, 'utf8')).sessions['project-a'].pane_handle).toBe('pane-1')
  })

  test('coalesces concurrent opens for one project into one hosted session', async () => {
    const f = fixture()
    const [first, second] = await Promise.all([f.sessionHost.open(OPEN), f.sessionHost.open(OPEN)])
    expect(first).toBe(second)
    expect(f.host.spawned).toHaveLength(1)
  })

  test('adopts the same verified pane after a gateway restart', async () => {
    const f = fixture()
    await f.sessionHost.open(OPEN)
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: ['codex', '--enable', 'multi_agent_v2'] }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    const session = await restarted.open(OPEN)
    expect(session.recovery).toBe('adopted')
    expect(nextHost.attached).toEqual(['pane-1'])
    expect(nextHost.spawned).toEqual([])
  })

  test('adopts a recorded Codex pane when the live process exposes its node shim', async () => {
    const f = fixture()
    await f.sessionHost.open(OPEN)
    const nextHost = new FakeHost()
    nextHost.inspection = {
      kind: 'live',
      argv: ['node', '/usr/bin/codex', '--enable', 'multi_agent_v2'],
    }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    const session = await restarted.open(OPEN)
    expect(session.recovery).toBe('adopted')
    expect(nextHost.attached).toEqual(['pane-1'])
    expect(nextHost.spawned).toEqual([])
  })

  test('adopts the packaged codex.js entry point with the default recorded launcher', async () => {
    const f = fixture()
    await f.sessionHost.open(OPEN)
    const nextHost = new FakeHost()
    nextHost.inspection = {
      kind: 'live',
      argv: ['node', '/usr/lib/node_modules/@openai/codex/bin/codex.js', '--enable', 'multi_agent_v2'],
    }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    const session = await restarted.open(OPEN)
    expect(session.recovery).toBe('adopted')
    expect(nextHost.attached).toEqual(['pane-1'])
    expect(nextHost.spawned).toEqual([])
  })

  test.each([
    { label: 'different launcher', bin: 'custom-codex', runtime: 'node', script: 'codex.js', args: ['--enable', 'multi_agent_v2'] },
    { label: 'different runtime', bin: 'codex', runtime: 'python', script: 'codex.js', args: ['--enable', 'multi_agent_v2'] },
    { label: 'different script', bin: 'codex', runtime: 'node', script: 'other.js', args: ['--enable', 'multi_agent_v2'] },
    { label: 'different arguments', bin: 'codex', runtime: 'node', script: 'codex.js', args: ['--enable', 'other_feature'] },
  ])('refuses a packaged entry point with $label', async ({ bin, runtime, script, args }) => {
    const f = fixture()
    await new CodexProjectSessionHost({ registryPath: f.registryPath, host: f.host, bin }).open(OPEN)
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: [runtime, `/package/bin/${script}`, ...args] }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost, bin })
    await expect(restarted.open(OPEN)).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
    expect(nextHost.spawned).toEqual([])
  })

  test('refuses a node process whose script is not the recorded Codex binary', async () => {
    const f = fixture()
    await f.sessionHost.open(OPEN)
    const nextHost = new FakeHost()
    nextHost.inspection = {
      kind: 'live',
      argv: ['node', '/usr/bin/other-program', '--enable', 'multi_agent_v2'],
    }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    await expect(restarted.open(OPEN)).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
    expect(nextHost.spawned).toEqual([])
  })

  test('reports positive pane loss when it starts a replacement', async () => {
    const f = fixture()
    await f.sessionHost.open(OPEN)
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'gone' }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    const session = await restarted.open(OPEN)
    expect(session.recovery).toBe('restarted-after-loss')
  })

  test('unknown recovery and wrong pane identity refuse instead of spawning', async () => {
    const f = fixture()
    await f.sessionHost.open(OPEN)
    for (const inspection of [
      { kind: 'unavailable', reason: 'socket timed out' } as const,
      { kind: 'live', argv: ['other-program'] } as const,
    ]) {
      const nextHost = new FakeHost()
      nextHost.inspection = inspection
      const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
      await expect(restarted.open(OPEN)).rejects.toThrow(/unknown|identity/)
      expect(nextHost.spawned).toEqual([])
    }
  })

  test('a changed launch configuration cannot adopt an older project pane', async () => {
    const f = fixture()
    await f.sessionHost.open(OPEN)
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: ['codex', '--enable', 'multi_agent_v2'] }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    await expect(restarted.open({ ...OPEN, model: 'gpt-new' })).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
  })

  test('two concurrent submissions are serialized and each is acknowledged', async () => {
    const f = fixture()
    const first = deferred()
    f.host.holds.push(first)
    const session = await f.sessionHost.open(OPEN)
    const a = session.submitLine('first')
    await Bun.sleep(0)
    const b = session.submitLine('second')
    await Bun.sleep(0)
    expect(f.host.submissions).toEqual(['first'])
    expect(f.host.maxActive).toBe(1)
    first.resolve()
    await Promise.all([a, b])
    expect(f.host.submissions).toEqual(['first', 'second'])
    expect(f.host.maxActive).toBe(1)
  })

  test('refuses a host that cannot acknowledge a line', async () => {
    const f = fixture()
    const { submitLine: _submitLine, ...unacknowledgedChild } = f.host.child
    f.host.child = unacknowledgedChild
    const session = await f.sessionHost.open(OPEN)
    await expect(session.submitLine('hello')).rejects.toThrow(/cannot acknowledge/)
  })

  test('refuses ambiguous multi-line input before it reaches the pane', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(OPEN)
    await expect(session.submitLine('one\ntwo')).rejects.toThrow(/line terminators/)
    expect(f.host.submissions).toEqual([])
  })

  test('refuses submission after the hosted process exits', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(OPEN)
    f.host.exitedFlag = true
    await expect(session.submitLine('hello')).rejects.toThrow(/not running/)
    expect(f.host.submissions).toEqual([])
  })

  test('reports whether the hosted process is live before dispatch', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(OPEN)
    expect(session.isLive()).toBe(true)
    f.host.exitedFlag = true
    expect(session.isLive()).toBe(false)
  })

  test('refuses a non-durable host result and closes its child', async () => {
    const f = fixture()
    const { paneHandle: _paneHandle, ...childWithoutHandle } = f.host.child
    f.host.child = childWithoutHandle
    await expect(f.sessionHost.open(OPEN)).rejects.toThrow(/restart-survival handle/)
    expect(f.host.kills).toBe(1)
  })

  test('refuses an empty project identity before spawning', async () => {
    const f = fixture()
    await expect(f.sessionHost.open({ ...OPEN, projectId: '' })).rejects.toThrow(/project id/)
    expect(f.host.spawned).toEqual([])
  })
})
