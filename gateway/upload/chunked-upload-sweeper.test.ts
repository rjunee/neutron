import { describe, expect, test } from 'bun:test'

import { ChunkedUploadSweeper } from './chunked-upload-sweeper.ts'
import type { UploadSessionRow, UploadSessionStore } from './upload-session-store.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Minimal store whose `listExpiredUploading` blocks until released, so a tick
 *  can be held in flight to exercise the quiescing `stop()`. */
function gatedStore(): {
  store: UploadSessionStore
  entered: () => boolean
  release: (rows: UploadSessionRow[]) => void
} {
  let entered = false
  let release!: (rows: UploadSessionRow[]) => void
  const gate = new Promise<UploadSessionRow[]>((r) => {
    release = r
  })
  const store = {
    async listExpiredUploading(): Promise<UploadSessionRow[]> {
      entered = true
      return await gate
    },
    async markExpired(): Promise<boolean> {
      return true
    },
  } as unknown as UploadSessionStore
  return { store, entered: () => entered, release }
}

describe('ChunkedUploadSweeper — §F1 quiescing stop()', () => {
  test('stop() awaits an in-flight sweep before resolving', async () => {
    const g = gatedStore()
    let capturedFn: (() => void) | null = null
    const sweeper = new ChunkedUploadSweeper({
      store: g.store,
      owner_home: '/tmp/nope',
      project_slug: 'p',
      intervalMs: 60_000,
      // Capture the loop's interval callback so we can drive a tick without a
      // real timer, then hold it in flight on the store gate.
      setTimer: (fn) => {
        capturedFn = fn
        return 1
      },
      clearTimer: () => {},
    })
    sweeper.start()
    expect(capturedFn).not.toBeNull()
    capturedFn!() // fires one loop tick → runOnceInner → listExpiredUploading (blocks)
    for (let i = 0; i < 50 && !g.entered(); i++) await sleep(2)
    expect(g.entered()).toBe(true)

    let stopped = false
    const stopP = sweeper.stop().then(() => {
      stopped = true
    })
    await sleep(10)
    expect(stopped).toBe(false) // must not resolve while the sweep is in flight

    g.release([]) // sweep finds nothing pending, returns
    await stopP
    expect(stopped).toBe(true)
  })

  test('stop() awaits a sweep started directly via runOnce() (not just loop-driven)', async () => {
    const g = gatedStore()
    const sweeper = new ChunkedUploadSweeper({
      store: g.store,
      owner_home: '/tmp/nope',
      project_slug: 'p',
      intervalMs: 60_000,
      setTimer: () => 1,
      clearTimer: () => {},
    })
    // Drive a sweep directly through the PUBLIC api — this tracks on
    // `this.inflight`, which the loop does not know about.
    const sweep = sweeper.runOnce()
    for (let i = 0; i < 50 && !g.entered(); i++) await sleep(2)
    expect(g.entered()).toBe(true)

    let stopped = false
    const stopP = sweeper.stop().then(() => {
      stopped = true
    })
    await sleep(10)
    expect(stopped).toBe(false) // must wait for the manually-triggered sweep

    g.release([])
    await stopP
    await sweep
    expect(stopped).toBe(true)
  })

  test('start()/stop() are idempotent and safe with no in-flight sweep', async () => {
    const g = gatedStore()
    const sweeper = new ChunkedUploadSweeper({
      store: g.store,
      owner_home: '/tmp/nope',
      project_slug: 'p',
      setTimer: () => 1,
      clearTimer: () => {},
    })
    sweeper.start()
    sweeper.start() // idempotent
    await sweeper.stop()
    await sweeper.stop() // safe twice, nothing in flight
    expect(g.entered()).toBe(false)
  })
})
