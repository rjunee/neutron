import { afterEach, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ReplSession, unlinkSessionConfigs } from '../repl-session.ts'
import { classifyThrownSpawnError } from '../classify-spawn-error.ts'
import { pool, sink } from '../pool-state.ts'
import { shutdownAllPersistentRepls } from '../pool.ts'
import { wireChildExit } from '../child-exit-wiring.ts'
import { createPersistentReplSubstrate } from '../persistent-repl-substrate.ts'

const dirs: string[] = []
afterEach(async () => {
  await shutdownAllPersistentRepls()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-repl-cleanup-'))
  dirs.push(dir)
  const path = join(dir, 'session-mcp.json')
  writeFileSync(path, JSON.stringify({ env: { EXAMPLE_API_KEY: 'fixture-secret' } }), { mode: 0o600 })
  const session = new ReplSession(dir, 'cleanup-generation', dir, 'cleanup-channel', '/tmp')
  session.configPaths = [path]
  const exit = Promise.withResolvers<number | null>()
  let dead = false
  const child = {
    pid: 987654321, write() {},
    kill() { dead = true; exit.resolve(0) },
    hasExited: () => dead, wasKilledByUs: () => dead, exited: exit.promise,
  }
  session.attachChild(child)
  expect(readFileSync(path, 'utf8')).toContain('fixture-secret')
  return { session, child, path }
}

function assertRemoved(path: string, owner: string) {
  console.info(JSON.stringify({ owner, config: path, exists: existsSync(path), directoryExists: existsSync(dirname(path)) }))
  expect(existsSync(path), `stranded config: ${path}; owner: ${owner}`).toBe(false)
  expect(existsSync(dirname(path)), `stranded config directory: ${dirname(path)}; owner: ${owner}`).toBe(false)
}

it('clean shutdown removes the secret config and directory', async () => {
  const { session, path } = fixture()
  pool.set(session.sessionKey, Promise.resolve(session))
  await shutdownAllPersistentRepls()
  assertRemoved(path, 'shutdownAllPersistentRepls -> unlinkSessionConfigs')
})

it('child teardown removes the secret config and directory', async () => {
  const { session, child, path } = fixture()
  wireChildExit({ session, child, sessionKey: session.sessionKey, sessionId: session.sessionId,
    liveHandle: () => undefined, label: 'cleanup-test', registryPath: undefined })
  child.kill()
  await child.exited
  // Drain the exit callback's microtasks, without a readiness timer or listening socket.
  await Promise.resolve()
  assertRemoved(path, 'wireChildExit -> unlinkSessionConfigs')
})

it.each(['host', 'settings serialization'])('failed spawn at %s removes its real secret config without a child exit', async (stage) => {
  // Replace only listener startup. Real config creation, host failure and cleanup run.
  const state = sink as unknown as { server: unknown; boundPort: number | undefined; tokenValue: string | undefined }
  const saved = { server: state.server, boundPort: state.boundPort, tokenValue: state.tokenValue }
  Object.assign(state, { server: { stop() {} }, boundPort: 40000, tokenValue: 'fixture-root' })
  const start = spyOn(sink, 'ensureStarted').mockResolvedValue(undefined)
  let path: string | undefined
  const before = new Set(readdirSync(tmpdir()))
  const permissions = { get deny(): string[] {
    const created = readdirSync(tmpdir()).filter((name) => name.startsWith('neutron-repl-') && !before.has(name))
    expect(created).toHaveLength(1)
    path = join(tmpdir(), created[0]!, 'session-mcp.json')
    dirs.push(dirname(path))
    expect(readFileSync(path, 'utf8')).toContain('fixture-secret')
    throw new Error('fixture settings serialization refused')
  } }
  try {
    const sub = createPersistentReplSubstrate({
      substrate_instance_id: 'cc-agent-cleanup', cwd: '/tmp', skipTrustSeed: true, enableToolBridge: true,
      ...(stage === 'settings serialization' ? { permissions } : {}),
      resolveExtraMcpServers: async () => [{ name: 'example', command: 'example', args: [], env_names: ['EXAMPLE_API_KEY'], env: { EXAMPLE_API_KEY: 'fixture-secret' } }],
      ptyHost: { async spawn(argv) {
        path = argv[argv.indexOf('--mcp-config') + 1]!
        dirs.push(dirname(path))
        expect(readFileSync(path, 'utf8')).toContain('fixture-secret')
        throw new Error('fixture host refused spawn')
      } },
    })
    const errors: string[] = []
    for await (const event of sub.start({ prompt: 'hello', tools: [], model_preference: ['claude-opus-4-7'] }).events) {
      if (event.kind === 'error') errors.push(event.message)
    }
    expect(errors.join(' ')).toContain(stage === 'host' ? 'fixture host refused spawn' : 'fixture settings serialization refused')
    expect(path).toBeDefined()
    assertRemoved(path!, 'spawn failure -> unlinkSessionConfigs')
  } finally {
    start.mockRestore()
    Object.assign(state, saved)
  }
})

it('removal failure is visible and does not prevent other configs being removed', () => {
  const { session, path } = fixture()
  const blocked = join(dirname(path), 'session-settings.json')
  mkdirSync(blocked)
  session.configPaths = [blocked, path]
  const stderr = spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    let failure: unknown
    try { unlinkSessionConfigs(session) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(classifyThrownSpawnError(failure)).toBe('spawn_configuration')
    expect(stderr.mock.calls.flat().join(' ')).toContain(blocked)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(blocked)).toBe(true)
  } finally { stderr.mockRestore() }
})

it('directory resolution errors are visible instead of treated as absence', () => {
  const { session, path } = fixture()
  session.configPaths = [join(path, 'not-a-directory', 'session-mcp.json')]
  expect(() => realpathSync(dirname(session.configPaths[0]!))).toThrow()
  const stderr = spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    expect(() => unlinkSessionConfigs(session)).toThrow('config cleanup failed')
    expect(stderr.mock.calls.flat().join(' ')).toContain(path)
    expect(readFileSync(path, 'utf8')).toContain('fixture-secret')
  } finally { stderr.mockRestore() }
})

it('a nonempty config directory is reported and unrelated files survive', () => {
  const { session, path } = fixture()
  const unrelated = join(dirname(path), 'unrelated')
  writeFileSync(unrelated, 'keep')
  const stderr = spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    expect(() => unlinkSessionConfigs(session)).toThrow('config cleanup failed')
    expect(stderr.mock.calls.flat().join(' ')).toContain(dirname(path))
    expect(readFileSync(unrelated, 'utf8')).toBe('keep')
    expect(existsSync(path)).toBe(false)
  } finally { stderr.mockRestore() }
})

it('missing optional configs and repeated cleanup are successful', () => {
  const { session, path } = fixture()
  session.configPaths = [join(dirname(path), 'session-tools.json'), path]
  unlinkSessionConfigs(session)
  unlinkSessionConfigs(session)
  assertRemoved(path, 'idempotent unlinkSessionConfigs')
})
