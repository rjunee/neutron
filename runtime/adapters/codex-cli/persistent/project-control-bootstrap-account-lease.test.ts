import { expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCodexAccountWriteLease } from '../account-writer-lock.ts'
import { bootstrapCodexOwner } from './project-control-bootstrap.ts'
import * as transport from './project-control-broker-transport.ts'

test('actual bootstrap transfers its exact reservation into the real native transport', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-account-lease-'))
  const home = join(root, 'home'); mkdirSync(home, { mode: 0o700 })
  const binary = join(root, 'codex')
  const compiled = spawnSync('cc', [join(import.meta.dir, '../fixtures/account-writer-native.c'), '-o', binary])
  expect(compiled.status).toBe(0)
  const lease = acquireCodexAccountWriteLease(home)
  const create = transport.createProjectControlStdioTransport
  let native: transport.ProjectControlTransport | undefined
  let ready!: (value: { pid: number }) => void
  const started = new Promise<{ pid: number }>(resolve => { ready = resolve })
  const spy = spyOn(transport, 'createProjectControlStdioTransport').mockImplementation(options => {
    expect(options.accountWriteLease).toBe(lease)
    native = create(options)
    const listen = native.listen
    return { ...native, listen(receive, disconnect) {
      listen(value => {
        const message = value as { method?: string; pid: number }
        if (message.method === 'fixture/ready') ready(message)
        receive(value)
      }, disconnect)
    } }
  })
  let boot: Promise<unknown> | undefined
  try {
    // This fixture announces its native PID but deliberately cannot complete
    // the owner handshake. Starting it proves bootstrap did not reacquire its
    // own already-held reservation or lose the reserved lease in option shaping.
    boot = bootstrapCodexOwner({ binary, cwd: root, codexHome: home,
      socketPath: join(home, 'owner.sock'), env: { PATH: process.env.PATH! },
      accountWriteLease: lease, timeoutMs: 3000 })
    void boot.catch(() => {})
    const announcement = await Promise.race([started, boot.then(() => { throw new Error('Unexpected fixture handshake') })])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(native?.processIdentity).toBeDefined()
    expect(announcement.pid).toBe(native!.processIdentity!.pid)
    native!.close()
    await native!.exited
    await expect(boot).rejects.toThrow()
  } finally {
    native?.close()
    await native?.exited
    await boot?.catch(() => {})
    lease.close()
    spy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
