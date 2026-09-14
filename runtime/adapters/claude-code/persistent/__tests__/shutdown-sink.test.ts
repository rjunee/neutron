import { expect, spyOn, test } from 'bun:test'
import { sink } from '../pool-state.ts'
import { shutdownAllPersistentRepls } from '../pool.ts'

test('pool shutdown releases the process-wide reply listener even with an empty pool', async () => {
  const stop = spyOn(sink, 'stop')
  try {
    await shutdownAllPersistentRepls()
    expect(stop).toHaveBeenCalledTimes(1)
  } finally {
    stop.mockRestore()
  }
})

// RPC is scripted, but the process and the host's poll loop are real. This is
// deliberately narrower than a live REPL deployment proof.
test('pool shutdown releases host polling and preserves the same process across reattachment', async () => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { HerdrHost } = await import('../herdr-host.ts')
  const { FakeHerdrServer } = await import('./herdr-fake-server.ts')
  const { ReplSession } = await import('../repl-session.ts')
  const { pool, supervisedBySessionKey } = await import('../pool-state.ts')
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-host-'))
  const registryPath = join(dir, 'registry.json')
  const processChild = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
  const server = new FakeHerdrServer({ shellPid: processChild.pid })
  const record = {
    sessionKey: 'shutdown-test', sessionId: 'dddddddd-1111-2222-3333-444444444444',
    channelName: 'neutron-aaaabbbbccccddddeeeeffff00001111', cwd: dir, has_session: true,
    child_generation: 'shutdown-generation', pane_handle: server.paneId,
  }
  writeFileSync(registryPath, JSON.stringify({ [record.sessionKey]: record }))
  const call = server.call.bind(server)
  server.call = async (method, params) => {
    if (method === 'pane.close') processChild.kill()
    return call(method, params)
  }
  const children: import('../pty-host.ts').PtyChild[] = []
  try {
    for (let incarnation = 0; incarnation < 2; incarnation++) {
      let pollStopped!: () => void
      const stopped = new Promise<void>((resolve) => { pollStopped = resolve })
      const host = new HerdrHost({ connect: async () => server, pollIntervalMs: 1, onPollExit: pollStopped })
      const persisted = JSON.parse(readFileSync(registryPath, 'utf8'))[record.sessionKey]
      const child = await host.attach(persisted.pane_handle, { cwd: dir, env: {} })
      children.push(child)
      child.beginOutput?.()
      const session = new ReplSession(record.sessionKey, record.child_generation, record.sessionId, record.channelName, dir)
      session.attachChild(child)
      pool.set(record.sessionKey, Promise.resolve(session))
      supervisedBySessionKey.set(record.sessionKey, {
        replRegistryPath: registryPath,
      } as import('../types.ts').PersistentReplSubstrateOptions)
      await shutdownAllPersistentRepls()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([stopped, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('host polling did not stop')), 1_000)
        })])
      } finally {
        clearTimeout(timer)
      }
      expect(child.pid).toBe(processChild.pid)
      process.kill(processChild.pid, 0)
      expect(processChild.exitCode).toBeNull()
      expect(server.paneClosed).toBe(false)
    }
  } finally {
    for (const child of children) child.detach?.()
    pool.clear()
    supervisedBySessionKey.clear()
    processChild.kill()
    await processChild.exited
    rmSync(dir, { recursive: true, force: true })
  }
})
