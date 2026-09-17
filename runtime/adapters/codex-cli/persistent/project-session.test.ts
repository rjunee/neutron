import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AdoptableHost,
  HandleInspection,
  PtyChild,
  PtySpawnOpts,
} from '../../claude-code/persistent/pty-host.ts'
import { BunTerminalHost } from '../../claude-code/persistent/bun-terminal-host.ts'
import { HerdrHost } from '../../claude-code/persistent/herdr-host.ts'
import { FakeHerdrServer } from '../../claude-code/persistent/__tests__/herdr-fake-server.ts'
import { CodexProjectSession, CodexProjectSessionHost } from './project-session.ts'

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
  onScreen: ((screen: string) => void) | undefined
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

  async spawn(argv: string[], options: PtySpawnOpts): Promise<PtyChild> {
    this.spawned.push(argv)
    this.onScreen = options.onScreen
    return this.child
  }
  async attach(handle: string, options: PtySpawnOpts): Promise<PtyChild> {
    this.attached.push(handle)
    this.onScreen = options.onScreen
    return this.child
  }
  async inspectHandle(_handle: string): Promise<HandleInspection> { return this.inspection }
  async closeHandle(_handle: string): Promise<void> {}
}

function fixture(host = new FakeHost()) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-project-session-'))
  dirs.push(dir)
  const packageDir = join(dir, 'package', 'bin')
  mkdirSync(packageDir, { recursive: true })
  const script = join(packageDir, 'codex.js')
  writeFileSync(script, '#!/usr/bin/env node\n', { mode: 0o755 })
  symlinkSync(script, join(dir, 'codex'))
  writeFileSync(join(dir, 'custom-codex'), '#!/usr/bin/env node\n', { mode: 0o755 })
  const node = realpathSync(Bun.which('node')!)
  symlinkSync(node, join(dir, 'node'))
  symlinkSync(realpathSync(Bun.which('python3')!), join(dir, 'python'))
  writeFileSync(join(packageDir, 'other.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
  const unrelated = join(dir, 'unrelated')
  mkdirSync(unrelated)
  for (const name of ['codex', 'codex.js']) writeFileSync(join(unrelated, name), '#!/usr/bin/env node\n', { mode: 0o755 })
  const registryPath = join(dir, 'sessions.json')
  const sessionHost = new CodexProjectSessionHost({ registryPath, host })
  return { host, registryPath, sessionHost, script, node, dir, unrelated, open: { projectId: 'project-a', cwd: dir, env: { PATH: dir } } }
}


describe('CodexProjectSessionHost', () => {
  test('starts an interactive Codex pane and records its restart handle', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(f.open)
    expect(session.recovery).toBe('started')
    expect(f.host.spawned).toEqual([[f.node, f.script, '--enable', 'multi_agent_v2']])
    expect(JSON.parse(readFileSync(f.registryPath, 'utf8')).sessions['project-a']).toMatchObject({
      pane_handle: 'pane-1', argv: ['codex', '--enable', 'multi_agent_v2'],
      identity: [f.node, f.script, '--enable', 'multi_agent_v2'],
    })
  })

  test.each(['missing', 'unsupported'])('refuses %s launch identity before spawning', async (kind) => {
    const f = fixture()
    if (kind === 'missing') rmSync(join(f.dir, 'codex'))
    else writeFileSync(f.script, '#!/usr/bin/env node --unexpected\n')
    await expect(f.sessionHost.open(f.open)).rejects.toThrow(/identity/)
    expect(f.host.spawned).toEqual([])
  })

  test('refuses a legacy record without persisted identity', async () => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    const registry = JSON.parse(readFileSync(f.registryPath, 'utf8'))
    delete registry.sessions['project-a'].identity
    writeFileSync(f.registryPath, JSON.stringify(registry))
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: [f.node, f.script, '--enable', 'multi_agent_v2'] }
    await expect(new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost }).open(f.open)).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
  })

  test('refuses launcher retargeting even when the original pane still matches its record', async () => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    rmSync(join(f.dir, 'codex'))
    symlinkSync(join(f.unrelated, 'codex.js'), join(f.dir, 'codex'))
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: [f.node, f.script, '--enable', 'multi_agent_v2'] }
    await expect(new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost }).open(f.open)).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
  })

  test('coalesces concurrent opens for one project into one hosted session', async () => {
    const f = fixture()
    const [first, second] = await Promise.all([f.sessionHost.open(f.open), f.sessionHost.open(f.open)])
    expect(first).toBe(second)
    expect(f.host.spawned).toHaveLength(1)
  })

  test('refuses concurrent opens that bind one project to different directories', async () => {
    const f = fixture()
    const first = f.sessionHost.open(f.open)
    await expect(f.sessionHost.open({ ...f.open, cwd: f.unrelated })).rejects.toThrow(/working directory changed/)
    await first
    expect(f.host.spawned).toHaveLength(1)
  })

  test.each(['changed', 'missing'] as const)('does not adopt a pane with a %s directory binding', async (kind) => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    if (kind === 'missing') {
      const registry = JSON.parse(readFileSync(f.registryPath, 'utf8'))
      delete registry.sessions['project-a'].cwd
      writeFileSync(f.registryPath, JSON.stringify(registry))
    }
    const before = readFileSync(f.registryPath, 'utf8')
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: [f.node, f.script, '--enable', 'multi_agent_v2'] }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    await expect(restarted.open({ ...f.open, cwd: kind === 'changed' ? f.unrelated : f.dir })).rejects.toThrow(
      kind === 'changed' ? /refused: project working directory changed/ : /recovery unknown: recorded working directory is missing/,
    )
    expect(nextHost.attached).toEqual([])
    expect(nextHost.spawned).toEqual([])
    expect(readFileSync(f.registryPath, 'utf8')).toBe(before)
  })

  test('canonical directory aliases reuse and recover the same project binding', async () => {
    const f = fixture()
    const alias = join(f.dir, 'alias')
    symlinkSync(f.unrelated, alias)
    const first = await f.sessionHost.open({ ...f.open, cwd: alias })
    expect(await f.sessionHost.open({ ...f.open, cwd: f.unrelated })).toBe(first)
    expect(JSON.parse(readFileSync(f.registryPath, 'utf8')).sessions['project-a'].cwd).toBe(realpathSync(f.unrelated))
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: [f.node, f.script, '--enable', 'multi_agent_v2'] }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    expect((await restarted.open({ ...f.open, cwd: f.unrelated })).recovery).toBe('adopted')
    expect(nextHost.attached).toEqual(['pane-1'])
  })

  test('adopts the same verified pane after a gateway restart', async () => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: ['codex', '--enable', 'multi_agent_v2'] }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    const session = await restarted.open(f.open)
    expect(session.recovery).toBe('adopted')
    expect(nextHost.attached).toEqual(['pane-1'])
    expect(nextHost.spawned).toEqual([])
  })

  test('adopts a recorded Codex pane when the live process exposes its node shim', async () => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    const nextHost = new FakeHost()
    nextHost.inspection = {
      kind: 'live',
      argv: ['node', join(f.dir, 'codex'), '--enable', 'multi_agent_v2'],
    }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    const session = await restarted.open(f.open)
    expect(session.recovery).toBe('adopted')
    expect(nextHost.attached).toEqual(['pane-1'])
    expect(nextHost.spawned).toEqual([])
  })

  test('adopts the packaged codex.js entry point with the default recorded launcher', async () => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    const nextHost = new FakeHost()
    nextHost.inspection = {
      kind: 'live',
      argv: ['node', f.script, '--enable', 'multi_agent_v2'],
    }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    const session = await restarted.open(f.open)
    expect(session.recovery).toBe('adopted')
    expect(nextHost.attached).toEqual(['pane-1'])
    expect(nextHost.spawned).toEqual([])
  })

  test.each(['codex', 'codex.js'])('refuses unrelated same-name %s', async (name) => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    const before = readFileSync(f.registryPath, 'utf8')
    const nextHost = new FakeHost()
    const target = join(f.unrelated, name)
    nextHost.inspection = { kind: 'live', argv: [
      ...(name === 'codex.js' ? ['node', target] : [target]), '--enable', 'multi_agent_v2',
    ] }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    await expect(restarted.open(f.open)).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
    expect(nextHost.spawned).toEqual([])
    expect(readFileSync(f.registryPath, 'utf8')).toBe(before)
  })

  test.each([
    { label: 'different launcher', bin: 'custom-codex', runtime: 'node', script: 'codex.js', args: ['--enable', 'multi_agent_v2'] },
    { label: 'different runtime', bin: 'codex', runtime: 'python', script: 'codex.js', args: ['--enable', 'multi_agent_v2'] },
    { label: 'different script', bin: 'codex', runtime: 'node', script: 'other.js', args: ['--enable', 'multi_agent_v2'] },
    { label: 'different arguments', bin: 'codex', runtime: 'node', script: 'codex.js', args: ['--enable', 'other_feature'] },
  ])('refuses a packaged entry point with $label', async ({ bin, runtime, script, args }) => {
    const f = fixture()
    await new CodexProjectSessionHost({ registryPath: f.registryPath, host: f.host, bin }).open(f.open)
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: [runtime, join(f.dir, 'package', 'bin', script), ...args] }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost, bin })
    await expect(restarted.open(f.open)).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
    expect(nextHost.spawned).toEqual([])
  })

  test('refuses a node process whose script is not the recorded Codex binary', async () => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    const nextHost = new FakeHost()
    nextHost.inspection = {
      kind: 'live',
      argv: ['node', '/usr/bin/other-program', '--enable', 'multi_agent_v2'],
    }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    await expect(restarted.open(f.open)).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
    expect(nextHost.spawned).toEqual([])
  })

  test('reports positive pane loss when it starts a replacement', async () => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'gone' }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    const session = await restarted.open(f.open)
    expect(session.recovery).toBe('restarted-after-loss')
  })

  test('unknown recovery and wrong pane identity refuse instead of spawning', async () => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    for (const inspection of [
      { kind: 'unavailable', reason: 'socket timed out' } as const,
      { kind: 'live', argv: ['other-program'] } as const,
    ]) {
      const nextHost = new FakeHost()
      nextHost.inspection = inspection
      const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
      await expect(restarted.open(f.open)).rejects.toThrow(/unknown|identity/)
      expect(nextHost.spawned).toEqual([])
    }
  })

  test('a changed launch configuration cannot adopt an older project pane', async () => {
    const f = fixture()
    await f.sessionHost.open(f.open)
    const nextHost = new FakeHost()
    nextHost.inspection = { kind: 'live', argv: ['codex', '--enable', 'multi_agent_v2'] }
    const restarted = new CodexProjectSessionHost({ registryPath: f.registryPath, host: nextHost })
    await expect(restarted.open({ ...f.open, model: 'gpt-new' })).rejects.toThrow(/identity/)
    expect(nextHost.attached).toEqual([])
  })

  test('two concurrent submissions are serialized and each is acknowledged', async () => {
    const f = fixture()
    const first = deferred()
    f.host.holds.push(first)
    const session = await f.sessionHost.open(f.open)
    const a = session.submitLine('first')
    await Bun.sleep(0)
    const b = session.submitLine('second')
    await Bun.sleep(0)
    // The host receives plain text; its terminal boundary owns paste framing.
    expect(f.host.submissions).toEqual(['first'])
    expect(f.host.maxActive).toBe(1)
    first.resolve()
    await Promise.all([a, b])
    expect(f.host.submissions).toEqual(['first', 'second'])
    expect(f.host.maxActive).toBe(1)
  })

  test.each([
    ['allow', '1'],
    ['deny', '3'],
  ] as const)('detects a rendered command approval and answers %s', async (decision, key) => {
    const f = fixture()
    const session = await f.sessionHost.open(f.open)
    f.host.onScreen?.([
      'Would you like to run the following command?',
      '❯ 1. Yes, proceed',
      "  2. Yes, and don't ask again for this command in this session",
      '  3. No, and tell Codex what to do differently',
      'Esc to cancel · Tab to amend',
    ].join('\n'))

    expect(session.screenPrompt()).toEqual({ kind: 'approval', allowKey: '1', denyKey: '3' })
    await session.answerApproval(decision)
    expect(f.host.submissions).toEqual([key])
  })

  test('refuses an approval replaced by trust while its answer waits in the queue', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(f.open)
    const held = deferred()
    f.host.holds.push(held)
    const dispatch = session.submitLine('dispatch')
    await Bun.sleep(0)
    f.host.onScreen?.('Would you like to run the following command?\n1. Yes, proceed\n3. No, stop')
    const answer = session.answerApproval('allow')
    f.host.onScreen?.('Do you trust the contents of this directory?\n1. Yes, continue')
    expect(session.screenPrompt()).toEqual({ kind: 'trust', continueKey: '1' })
    const result = answer.then(() => 'answered', error => (error as Error).message)
    held.resolve()
    await dispatch
    expect(await result).toContain('prompt changed')
    expect(f.host.submissions).toEqual(['dispatch'])
    await session.submitLine('after refusal')
    expect(f.host.submissions).toHaveLength(2)
  })

  test('recognises the first-run trust dialog as distinct from an approval', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(f.open)
    f.host.onScreen?.([
      'Do you trust the contents of this directory?',
      'Working with untrusted contents comes with higher risk of prompt injection.',
      '❯ 1. Yes, continue',
      '  2. No, exit',
      'Press enter to continue',
    ].join('\n'))

    expect(session.screenPrompt()).toEqual({ kind: 'trust', continueKey: '1' })
    await expect(session.answerApproval('allow')).rejects.toThrow(/not an approval/)
    expect(f.host.submissions).toEqual([])
  })

  test('clears a detected approval when a later rendered screen no longer carries it', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(f.open)
    f.host.onScreen?.('Would you like to make the following edits?\n❯ 1. Yes, proceed\n  2. No, continue without it')
    expect(session.screenPrompt()?.kind).toBe('approval')
    f.host.onScreen?.('Working (10s • esc to interrupt)')
    expect(session.screenPrompt()).toBeUndefined()
    await expect(session.answerApproval('deny')).rejects.toThrow(/unknown/)
  })

  test.each([
    ['options without an approval title', '❯ 1. Yes, proceed\n  2. No, continue without it'],
    ['an approval title without a deny choice', 'Would you like to run the following command?\n❯ 1. Yes, proceed'],
  ])('does not classify %s as an actionable approval', async (_label, screen) => {
    const f = fixture()
    const session = await f.sessionHost.open(f.open)
    f.host.onScreen?.(screen)
    expect(session.screenPrompt()).toBeUndefined()
  })

  test('refuses a host that cannot acknowledge a line', async () => {
    const f = fixture()
    const { submitLine: _submitLine, ...unacknowledgedChild } = f.host.child
    f.host.child = unacknowledgedChild
    const session = await f.sessionHost.open(f.open)
    await expect(session.submitLine('hello')).rejects.toThrow(/cannot acknowledge/)
  })

  test('refuses ambiguous multi-line input before it reaches the pane', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(f.open)
    await expect(session.submitLine('one\ntwo')).rejects.toThrow(/line terminators/)
    expect(f.host.submissions).toEqual([])
  })

  test('refuses submission after the hosted process exits', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(f.open)
    f.host.exitedFlag = true
    await expect(session.submitLine('hello')).rejects.toThrow(/not running/)
    expect(f.host.submissions).toEqual([])
  })

  test('reports whether the hosted process is live before dispatch', async () => {
    const f = fixture()
    const session = await f.sessionHost.open(f.open)
    expect(session.isLive()).toBe(true)
    f.host.exitedFlag = true
    expect(session.isLive()).toBe(false)
  })

  test('refuses a non-durable host result and closes its child', async () => {
    const f = fixture()
    const { paneHandle: _paneHandle, ...childWithoutHandle } = f.host.child
    f.host.child = childWithoutHandle
    await expect(f.sessionHost.open(f.open)).rejects.toThrow(/restart-survival handle/)
    expect(f.host.kills).toBe(1)
  })

  test('refuses an empty project identity before spawning', async () => {
    const f = fixture()
    await expect(f.sessionHost.open({ ...f.open, projectId: '' })).rejects.toThrow(/project id/)
    expect(f.host.spawned).toEqual([])
  })
})

// #978. Exercise session-to-host composition: a fake child alone cannot detect
// duplicated paste framing at the actual terminal boundary.
describe('Codex TUI regression controls', () => {
  test('passes plain text to the host that owns framing and Enter', async () => {
    const f = await fixture()
    const session = await f.sessionHost.open(f.open)
    await session.submitLine('hello')
    expect(f.host.submissions).toEqual(['hello'])
  })

  test.each(['bun', 'herdr'] as const)('frames exactly once through the %s host', async (backend) => {
    const writes: string[] = []
    const exit = Promise.withResolvers<number>()
    const server = new FakeHerdrServer()
    const host = backend === 'herdr'
      ? new HerdrHost({ connect: async () => server, workspaceId: 'w9', pollIntervalMs: 10_000 })
      : new BunTerminalHost({
        createTerminal: () => ({
          write(data) {
            const bytes = typeof data === 'string' ? new TextEncoder().encode(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            writes.push(new TextDecoder().decode(bytes))
            return bytes.byteLength
          },
          resize: () => undefined,
          close: () => undefined,
        }),
        spawn: () => ({ pid: 77, exited: exit.promise, exitCode: null, kill: () => exit.resolve(0) }),
      })
    const child = await host.spawn(['codex'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    const session = new CodexProjectSession('project-a', 'pane', 'started', child)
    try {
      await session.submitLine('hello')
      if (backend === 'herdr') {
        expect(server.callsTo('pane.send_text').map(call => call.params['text']))
          .toEqual(['\x1b[200~hello\x1b[201~'])
        expect(server.callsTo('pane.send_keys').map(call => call.params['keys'])).toEqual([['enter']])
      } else {
        expect(writes.join('')).toBe('\x1b[200~hello\x1b[201~\r')
      }
    } finally {
      child.kill()
      child.detach?.()
    }
  })

  test('refuses an escape that could end the paste early', async () => {
    const f = await fixture()
    const session = await f.sessionHost.open(f.open)
    // A payload carrying the paste terminator would close the bracket early and
    // leave the remainder to be read as keystrokes. Refuse rather than frame it.
    await expect(session.submitLine('hello\x1b[201~injected')).rejects.toThrow(/escape/)
    expect(f.host.submissions).toEqual([])
  })
})
