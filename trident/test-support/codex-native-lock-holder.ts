import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A non-Codex process holds only the steady-state native record lock. The
 * real shell consumer cannot rely on either the reservation or native census. */
export function holdCodexNativeLock(home: string): { close(): void } {
  const ready = join(home, 'native-lock-fixture-ready')
  const child = spawn('python3', ['-c', `import fcntl, os, signal, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
ready = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.close(ready)
signal.pause()
`, join(home, '.neutron-account-native.lock'), ready], { stdio: 'ignore' })
  const tick = new Int32Array(new SharedArrayBuffer(4))
  const pause = () => Atomics.wait(tick, 0, 0, 5)
  const close = () => {
    child.kill('SIGTERM')
    const deadline = Date.now() + 3000
    while (child.pid !== undefined) {
      try {
        const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8')
        if (['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!)) return
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      if (Date.now() >= deadline) throw new Error('Native lock fixture did not exit')
      pause()
    }
  }
  try {
    const deadline = Date.now() + 3000
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error('Native lock fixture did not become ready')
      pause()
    }
    const reservation = spawnSync('python3', ['-c', `import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
`, join(home, '.neutron-account-writer.lock')])
    if (reservation.status !== 0) throw new Error('Fixture unexpectedly held the startup reservation')
    return { close }
  } catch (error) { close(); throw error }
}
