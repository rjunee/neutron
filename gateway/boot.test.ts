import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from './index.ts'

afterEach(() => {
  delete process.env['NOTIFY_SOCKET']
})

describe('gateway boot/shutdown', () => {
  // Argus r2 IMPORTANT #1 regression: shutdown() must guard the
  // `sdNotify('STOPPING=1')` call so a transient sd_notify failure does NOT
  // skip the cleanup that follows. Without the try/catch a throw exits before
  // clearInterval + db.close run, leaving the watchdog timer alive and the
  // DB open until systemd force-kills the process. Mirrors the equivalent
  // guard on the watchdog-tick body (gateway/index.ts:61-65).
  test('shutdown() completes cleanup even when sdNotify(STOPPING=1) throws', async () => {
    const ownerDir = mkdtempSync(join(tmpdir(), 'neutron-shutdown-guard-'))
    const dbPath = join(ownerDir, 'owner.db')
    try {
      // Boot with NOTIFY_SOCKET cleared so READY=1 / setInterval install
      // succeed (sdNotify is a no-op in this state). `port: 0` requests an
      // ephemeral OS-assigned port so concurrent test workers — or an
      // unrelated dev-mode gateway already bound to the default 7800 — do not
      // collide with this listener. Mirrors the convention in
      // `gateway/listener.test.ts` and the managed-harness composition tests.
      delete process.env['NOTIFY_SOCKET']
      const handle = await boot({ port: 0 })

      // Force the next sdNotify call to throw by pointing NOTIFY_SOCKET at a
      // path that doesn't exist — the libc sendto() returns ENOENT and
      // sdNotify re-throws as `sd_notify ... failed` per gateway/sd-notify.ts.
      process.env['NOTIFY_SOCKET'] = join(ownerDir, 'nonexistent-notify.sock')

      // Without the guard, shutdown() would reject here. With the guard, the
      // throw is caught, logged to stderr, and cleanup proceeds.
      await expect(handle.shutdown()).resolves.toBeUndefined()

      // db.close() ran → any subsequent query on the underlying connection
      // throws "Database is closed". This is the load-bearing assertion: it
      // proves the line *after* the sdNotify call also executed.
      expect(() => handle.db.raw().query('SELECT 1').get()).toThrow()

      // Re-entry guard works: a second shutdown is a no-op (does NOT
      // double-close) — same `if (shuttingDown) return` line that guards
      // SIGTERM + SIGINT racing.
      await expect(handle.shutdown()).resolves.toBeUndefined()
    } finally {
      rmSync(ownerDir, { recursive: true, force: true })
    }
  })
})
