import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('process deadline exceeded')), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

test('SIGTERM exits naturally, closes the DB, and reattaches the same live PID on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-sigterm-'))
  const survivor = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
  const record = {
    sessionKey: 'shutdown-survivor', sessionId: 'dddddddd-1111-2222-3333-444444444444',
    channelName: 'neutron-aaaabbbbccccddddeeeeffff00001111', cwd: dir, has_session: true,
    child_generation: 'shutdown-generation', pane_handle: 'w9:p42',
  }
  writeFileSync(join(dir, 'repl-registry.json'), JSON.stringify({ 'shutdown-survivor': record }))
  const processes: ReturnType<typeof Bun.spawn>[] = []
  try {
    let firstPort: number | undefined
    for (let boot = 0; boot < 2; boot++) {
      rmSync(join(dir, 'ready'), { force: true })
      rmSync(join(dir, 'closed'), { force: true })
      const gateway = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/sigterm-survivor.ts'), dir, String(survivor.pid)], {
        env: { ...process.env, NODE_ENV: 'production', NEUTRON_HOME: dir, NOTIFY_SOCKET: '', WATCHDOG_USEC: '' },
        stdout: 'ignore', stderr: 'pipe',
      })
      processes.push(gateway)
      const errors = new Response(gateway.stderr).text()
      // The deadline bounds a broken boot, not the assertion of readiness.
      await bounded((async () => {
        while (!existsSync(join(dir, 'ready'))) {
          if (gateway.exitCode !== null) throw new Error(await errors)
          await Bun.sleep(10)
        }
      })(), 10_000)
      const ready = JSON.parse(readFileSync(join(dir, 'ready'), 'utf8'))
      expect(ready.pid).toBe(survivor.pid)
      if (firstPort !== undefined) expect(ready.port).toBe(firstPort)
      firstPort = ready.port
      gateway.kill('SIGTERM')
      // WALL-CLOCK-BOUND-OK: process exit is the property; a live listener cannot
      // be detected by awaiting shutdown alone. No process.exit or forced kill
      // occurs on the successful path. Removing sink.stop must hit this deadline.
      expect(await bounded(gateway.exited, 5_000)).toBe(0)
      expect(await errors).toContain('gateway shutdown LEAVING')
      expect(readFileSync(join(dir, 'closed'), 'utf8')).toBe('closed')
      process.kill(survivor.pid, 0)
      expect(survivor.exitCode).toBeNull()
    }
  } finally {
    for (const gateway of processes) {
      if (gateway.exitCode === null) gateway.kill('SIGKILL')
      await gateway.exited
    }
    survivor.kill()
    await survivor.exited
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
