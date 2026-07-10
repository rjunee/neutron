import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, drainRealmodeCleanups } from './index.ts'

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

describe('drainRealmodeCleanups — §F1 shutdown ordering', () => {
  test('awaits an async cleanup before resolving, so db.close() waits for it', async () => {
    let released = false
    let laterRan = false
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const cleanups: Array<() => void | Promise<void>> = [
      async () => {
        await gate
        released = true
      },
      () => {
        laterRan = true
      },
    ]
    // Model shutdown()'s exact sequence: await the drain, THEN "close the db".
    let dbClosed = false
    const done = drainRealmodeCleanups(cleanups).then(() => {
      dbClosed = true
    })
    await new Promise((r) => setTimeout(r, 15))
    // db.close() is NOT reached while the async cleanup is still in flight.
    expect(dbClosed).toBe(false)
    expect(released).toBe(false)
    expect(laterRan).toBe(false)

    release()
    await done
    expect(released).toBe(true)
    expect(laterRan).toBe(true)
    expect(dbClosed).toBe(true)
  })

  test('a rejecting cleanup does not stop later cleanups or db.close()', async () => {
    const order: string[] = []
    const cleanups: Array<() => void | Promise<void>> = [
      async () => {
        order.push('a')
        throw new Error('cleanup boom')
      },
      () => {
        order.push('b')
      },
      async () => {
        order.push('c')
      },
    ]
    let dbClosed = false
    await drainRealmodeCleanups(cleanups).then(() => {
      dbClosed = true
    })
    // All three ran in order despite the first rejecting, and the drain
    // resolved (so shutdown proceeds to db.close()).
    expect(order).toEqual(['a', 'b', 'c'])
    expect(dbClosed).toBe(true)
  })
})
