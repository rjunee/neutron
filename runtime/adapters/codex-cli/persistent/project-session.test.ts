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

function fixture(host = new FakeHost(), bin = 'codex') {
  const dir = mkdtempSync(join(tmpdir(), 'codex-project-session-'))
  dirs.push(dir)
  const registryPath = join(dir, 'sessions.json')
  const sessionHost = new CodexProjectSessionHost({ registryPath, host, bin })
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

  test.each([
    ['codex'], ['/usr/bin/codex'], ['node', '/usr/bin/codex'],
    ['/usr/bin/node', '/usr/bin/codex'], ['nodejs', '/usr/bin/codex'],
    ['bun', '/usr/bin/codex'], ['deno', '/usr/bin/codex'],
  ].map((prefix) => ({ prefix })))('adopts a verified launcher shape %j', async ({ prefix }) => {
    const f = fixture()
    await f.sessionHost.open(OPEN)
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: [...prefix, '--enable', 'multi_agent_v2'] }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    expect((await restarted.open(OPEN)).recovery).toBe('adopted')
    expect(nextHost.attached).toEqual(['pane-1'])
    expect(nextHost.spawned).toEqual([])
  })

  test.each([
    ['node', '/opt/runner.js', '/usr/bin/codex', '--enable', 'multi_agent_v2'],
    ['python', '/usr/bin/codex', '--enable', 'multi_agent_v2'],
    ['node', '/opt/codex-tools/runner.js', '--enable', 'multi_agent_v2'],
    ['node', '/usr/bin/codex', '--enable', 'different'],
    ['node', '/usr/bin/codex', '--enable', 'multi_agent_v2', 'extra'],
    ['node', '/usr/bin/codex'],
    [],
  ].map((argv) => ({ argv })))('refuses an unrelated launcher or changed flags %j', async ({ argv }) => {
    const f = fixture()
    await f.sessionHost.open(OPEN)
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    await expect(restarted.open(OPEN)).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
    expect(nextHost.spawned).toEqual([])
  })

  test('a configured executable path remains exact through the interpreter', async () => {
    const f = fixture(new FakeHost(), '/opt/pinned/codex')
    await f.sessionHost.open(OPEN)
    const nextHost = new FakeHost()
    const restart = () => new CodexProjectSessionHost({
      registryPath: f.registryPath, host: nextHost, bin: '/opt/pinned/codex',
    }).open(OPEN)
    nextHost.inspection = { kind: 'live', argv: ['node', '/other/codex', '--enable', 'multi_agent_v2'] }
    await expect(restart()).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
    nextHost.inspection = { kind: 'live', argv: ['node', '/opt/pinned/codex', '--enable', 'multi_agent_v2'] }
    expect((await restart()).recovery).toBe('adopted')
    expect(nextHost.attached).toEqual(['pane-1'])
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
    expect(f.host.submissions).toEqual(['\x1b[200~first\x1b[201~'])
    expect(f.host.maxActive).toBe(1)
    first.resolve()
    await Promise.all([a, b])
    expect(f.host.submissions).toEqual(['\x1b[200~first\x1b[201~', '\x1b[200~second\x1b[201~'])
    expect(f.host.maxActive).toBe(1)
  })

  test('frames a paste before the acknowledged Enter, including empty and Unicode input', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(OPEN)
    await session.submitLine('hello 世界')
    await session.submitLine('')
    expect(f.host.submissions).toEqual(['\x1b[200~hello 世界\x1b[201~', '\x1b[200~\x1b[201~'])
  })

  test('escape input cannot terminate the paste frame', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(OPEN)
    await expect(session.submitLine('one\x1b[201~two')).rejects.toThrow(/terminal escape/)
    expect(f.host.submissions).toEqual([])
  })

  test('a failed acknowledgement rejects its caller and releases the next submission', async () => {
    const f = fixture()
    const failure = deferred()
    let calls = 0
    f.host.child.submitLine = async () => {
      calls += 1
      if (calls === 1) {
        await failure.promise
        throw new Error('Enter refused')
      }
    }
    const session = await f.sessionHost.open(OPEN)
    const first = session.submitLine('first')
    const rejected = first.catch((error: unknown) => error)
    const second = session.submitLine('second')
    await Bun.sleep(0)
    expect(calls).toBe(1)
    failure.resolve()
    expect(await rejected).toEqual(new Error('Enter refused'))
    await second
    expect(calls).toBe(2)
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
