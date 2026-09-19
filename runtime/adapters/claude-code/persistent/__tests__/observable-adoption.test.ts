import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginBootAdoption, resetBootAdoptionForTests, settleBootAdoptionsForShutdown } from '../boot-adoption.ts'
import { childByKey, pool, sink } from '../pool-state.ts'
import { FakeAdoptableHost } from './boot-adoption-host.ts'

const key = 'observable-adoption'
const id = 'bbbbbbbb-1111-2222-3333-444444444444'
const channel = 'neutron-fedcba9876543210fedcba9876543210'
let dir: string
let host: FakeAdoptableHost
let start: ReturnType<typeof spyOn>
let credential: ReturnType<typeof spyOn>
beforeEach(() => {
  resetBootAdoptionForTests()
  dir = mkdtempSync(join(tmpdir(), 'observable-adoption-'))
  host = new FakeAdoptableHost()
  // This suite exercises the real reconciliation/registry/pool path. The HTTP
  // listener and credential derivation are independent transport dependencies.
  start = spyOn(sink, 'ensureStarted').mockResolvedValue(undefined)
  credential = spyOn(sink, 'credentialFor').mockReturnValue('test-credential')
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ [key]: {
    sessionKey: key, sessionId: id, cwd: '/tmp', channelName: channel,
    has_session: true, pid: 5150, devchannel_port: 45999,
    child_generation: 'baseline-generation', pane_handle: 'w9:p9',
    reuse: { tool_surface: '', tool_bridge: false, auth_fingerprint: '' },
  } }))
})
afterEach(async () => {
  for (const child of host.attached) child.kill()
  await Promise.resolve()
  sink.unregister(id)
  pool.clear()
  childByKey.clear()
  resetBootAdoptionForTests()
  start.mockRestore()
  credential.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})
function adopt(screens: string[]) {
  host.addPane('w9:p9', { pid: 5150, screens,
    argv: ['claude', '--resume', id, '--dangerously-load-development-channels', `server:${channel}`] })
  return beginBootAdoption({ substrate_instance_id: 'inst',
    replRegistryPath: join(dir, 'registry.json'), cwd: '/tmp', ptyHost: host,
  }, key, { host, health: async () => true, baselineMs: 10, log: () => {} })
}
test.each([{ screens: [] as string[] }, { screens: ['   '] }])('an unobservable pane is closed and its durable handle cleared: %j', async ({ screens }) => {
  expect((await adopt([...screens])).kind).toBe('closed-unadoptable')
  expect(host.closed).toEqual(['w9:p9'])
  expect(pool.has(key)).toBe(false)
  const row = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'))[key]
  expect(row.pane_handle).toBeUndefined()
})
test('a readable baseline publishes the session', async () => {
  expect((await adopt(['❯ '])).kind).toBe('adopted')
  expect(pool.has(key)).toBe(true)
  expect(host.closed).toEqual([])
})
test('a pane dying while delivering its baseline cannot be published', async () => {
  const attach = host.attach.bind(host)
  host.attach = async (...args) => {
    const child = await attach(...args)
    const begin = child.beginOutput!
    return Object.assign(child, { beginOutput: () => { begin(); child.kill() } })
  }
  expect((await adopt(['❯ '])).kind).toBe('undecided')
  expect(pool.has(key)).toBe(false)
})
test.each([true, false])('shutdown during the baseline wait releases ownership: screen=%s', async (screen) => {
  // Hold only the adoption baseline callback. Polling for the attached child can
  // otherwise let its 10 ms timeout win before shutdown even begins.
  const realSetTimeout = globalThis.setTimeout
  let releaseBaseline: (() => void) | undefined
  const intercepted = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 10) {
      releaseBaseline = () => callback(...args)
      return realSetTimeout(() => {}, delay)
    }
    return realSetTimeout(callback, delay, ...args)
  }) as typeof setTimeout
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(intercepted)
  try {
    const pending = adopt([])
    while (releaseBaseline === undefined || host.attached.length === 0 || !childByKey.has(key)) await Bun.sleep(0)
    await settleBootAdoptionsForShutdown(0, () => {})
    if (screen) host.attached[0]!.push('❯ ')
    releaseBaseline()
    expect((await pending).kind).not.toBe('adopted')
    expect(pool.has(key)).toBe(false)
    expect(host.closed).toEqual([])
  } finally {
    timers.mockRestore()
  }
})
test('a cleared screen after adoption resets the baseline latches', async () => {
  const prompt = 'Do you want to proceed?\n❯ 1. Yes\n  2. No'
  expect((await adopt([prompt])).kind).toBe('adopted')
  const child = host.attached[0]!
  expect(child.keysSent).toEqual([])
  child.push('')
  child.push(prompt)
  expect(child.keysSent).toEqual([['1', 'enter']])
})
test('publication waits for a delayed readable baseline', async () => {
  const pending = adopt([])
  while (host.attached.length === 0 || !childByKey.has(key)) await Bun.sleep(0)
  expect(pool.has(key)).toBe(false)
  host.attached[0]!.push('❯ ')
  expect((await pending).kind).toBe('adopted')
  expect(pool.has(key)).toBe(true)
})
