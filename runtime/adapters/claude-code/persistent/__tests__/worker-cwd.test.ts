import { afterEach, expect, test, spyOn } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPersistentReplSubstrate, shutdownAllPersistentRepls } from '../persistent-repl-substrate.ts'
import { spawnWithChannelWedgeRespawn } from '../spawn.ts'
import * as spawning from '../spawn.ts'
import { sink } from '../pool-state.ts'
import { makeReplRespawnDeps } from '../supervision.ts'
import type { ReplRegistryRecord } from '../repl-registry.ts'
import type { ReplSession } from '../repl-session.ts'
import { classifyThrownSpawnError } from '../classify-spawn-error.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import type { Event } from '../../../../events.ts'

const dirs: string[] = []
const restores: Array<() => void> = []
const spec = { prompt: 'probe', tools: [], model_preference: ['claude-opus-4-7'] }
afterEach(async () => {
  await shutdownAllPersistentRepls()
  for (const restore of restores.splice(0)) restore()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'worker-cwd-')))
  dirs.push(cwd)
  const observed: string[] = []
  // No listening socket is needed to observe the spawn host boundary. The
  // host below ends the attempt before readiness; lifecycle is tested elsewhere.
  Object.defineProperty(sink, 'port', { configurable: true, value: 47151 })
  restores.push(() => { Reflect.deleteProperty(sink, 'port') })
  const start = spyOn(sink, 'ensureStarted').mockResolvedValue(undefined)
  const credential = spyOn(sink, 'credentialFor').mockReturnValue('probe-credential')
  restores.push(() => start.mockRestore(), () => credential.mockRestore())
  const options: PersistentReplSubstrateOptions = {
    substrate_instance_id: 'cwd-probe', cwd, skipTrustSeed: true,
    ptyHost: {
      async spawn(argv, opts) {
        // Execute a real child in the directory delivered to the host boundary.
        const child = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(process.cwd())'], { cwd: opts.cwd })
        expect(child.exitCode).toBe(0)
        observed.push(child.stdout.toString())
        expect(argv[argv.indexOf('--add-dir') + 1]).toBe(cwd)
        throw new Error('cwd-probe-host-reached')
      },
    },
  }
  return { cwd, observed, options }
}

test('explicit worktree cwd reaches the child and add-dir unchanged', async () => {
  const { cwd, observed, options } = fixture()
  await expect(spawnWithChannelWedgeRespawn('cwd-probe', options, spec)).rejects.toThrow('cwd-probe-host-reached')
  expect(observed).toEqual([cwd])
})

for (const cwd of [undefined, '', '   ']) {
  test(`spawn refuses ${JSON.stringify(cwd)} cwd before reaching the host`, async () => {
    const { options, observed } = fixture()
    delete options.cwd
    if (cwd !== undefined) options.cwd = cwd
    let error: unknown
    try { await spawnWithChannelWedgeRespawn('cwd-probe', options, spec) } catch (e) { error = e }
    expect(classifyThrownSpawnError(error)).toBe('spawn_configuration')
    expect(String(error)).toContain('explicit cwd is required')
    expect(observed).toEqual([])
  })
}

test('start emits a nonretryable local configuration error for missing cwd', async () => {
  const { options, observed } = fixture()
  delete options.cwd
  const lookup = spyOn(spawning, 'getOrSpawnSession').mockRejectedValue(new Error('unexpected pool lookup'))
  restores.push(() => lookup.mockRestore())
  const events: Event[] = []
  for await (const event of createPersistentReplSubstrate(options).start(spec).events) events.push(event)
  expect(lookup).not.toHaveBeenCalled()
  expect(events).toEqual([expect.objectContaining({ kind: 'error', code: 'spawn_configuration', retryable: false })])
  expect(observed).toEqual([])
})

test('resume takes cwd from the record when caller options omit it', () => {
  const { options, cwd } = fixture()
  delete options.cwd
  const call = spyOn(spawning, 'getOrSpawnSession').mockResolvedValue({} as ReplSession)
  restores.push(() => call.mockRestore())
  const record = { sessionKey: 'resume-cwd', sessionId: 'existing-session', cwd, model: 'claude-opus-4-7' } as ReplRegistryRecord
  expect(makeReplRespawnDeps(options).spawnResume(record)).toEqual({ ok: true })
  expect(call).toHaveBeenCalledTimes(1)
  expect(call.mock.calls[0]?.[1].cwd).toBe(cwd)
  expect(call.mock.calls[0]?.[3]).toEqual({ sessionId: record.sessionId })
})
