/**
 * herdr-no-exit-codes.test.ts — pins the fact that NO EXIT CODES EXIST IN HERDR, so
 * the exit-code half of the crash classification stops carrying information.
 *
 * WHY THIS NEEDS A TEST AT ALL. This is a place where information silently stops
 * existing. `pane.exited` carries exactly `{pane_id, workspace_id}` — verified
 * against the live schema — so there is no exit status to report, and `exited`
 * resolves `null` for every death. Nothing about that is visible at the call site
 * in `spawn.ts`, which still reads `!killedByUs && exitCode !== 0` and still looks
 * like a two-factor test. Without a test, the next reader infers a meaning from the
 * exit-code half that has not been there since this change.
 *
 * THE CLAIM, stated so it can fail: a CRASH and a RECYCLE produce the SAME exit
 * value, and are told apart ONLY by `wasKilledByUs`.
 *
 * "What would a wrong implementation get right?" — One that resolved `0` on a clean
 * pane close and `null` on a crash would pass any test that only checked the
 * recycle path, and would route every real crash to `unregister()` in production
 * (see `spawn.ts`: `!killedByUs && exitCode !== 0`). So the load-bearing assertion
 * is that the two values are EQUAL and that neither is a number. The end-to-end
 * consequence is pinned separately, through the real spawn exit handler, in
 * `crashed-agent-real-exit.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { HerdrHost } from '../herdr-host.ts'
import { FakeHerdrServer, until } from './herdr-fake-server.ts'
import type { PtyChild } from '../pty-host.ts'

async function spawn(server: FakeHerdrServer): Promise<PtyChild> {
  const host = new HerdrHost({
    connect: async () => server,
    pollIntervalMs: 10_000,
    sleep: (ms) => Bun.sleep(ms),
    workspaceId: 'w9',
  })
  const child = await host.spawn(['claude'], { cwd: '/tmp', env: {} })
  child.beginOutput?.()
  return child
}

describe('no exit codes exist in herdr', () => {
  it('a CRASH resolves `exited` with null, never a number', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    // herdr's `pane_exited` carries no status. The fake sends exactly what the real
    // server sends — pane_id and workspace_id, nothing else.
    server.exitPane()
    const code = await child.exited
    expect(code).toBeNull()
    expect(typeof code).not.toBe('number')
    expect(child.wasKilledByUs?.()).toBe(false)
  })

  it('a RECYCLE resolves `exited` with the SAME null', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    child.kill()
    const code = await child.exited
    expect(code).toBeNull()
    expect(child.wasKilledByUs?.()).toBe(true)
  })

  it('THE CLAIM: crash and recycle are indistinguishable by exit value', async () => {
    const crashServer = new FakeHerdrServer({ paneId: 'w9:pC' })
    const crashed = await spawn(crashServer)
    crashServer.exitPane()
    const crashCode = await crashed.exited

    const recycleServer = new FakeHerdrServer({ paneId: 'w9:pR' })
    const recycled = await spawn(recycleServer)
    recycled.kill()
    const recycleCode = await recycled.exited

    // The exit value carries NOTHING. A classifier reading only this cannot tell a
    // crashed REPL from a recycled one — which is why the exit-code half of
    // `spawn.ts`'s condition is now inert, and why nobody may read a meaning into it.
    expect(crashCode).toBe(recycleCode)
    expect(crashCode).toBeNull()

    // `wasKilledByUs` is the WHOLE signal, and it does distinguish them.
    expect(crashed.wasKilledByUs?.()).toBe(false)
    expect(recycled.wasKilledByUs?.()).toBe(true)
  })

  it('the classification `spawn.ts` computes lands on crash vs recycle correctly', async () => {
    // Evaluate the real condition from `spawn.ts` against the real values the host
    // produces. With `exitCode === null`, `exitCode !== 0` is always true, so the
    // verdict is `!killedByUs` alone — stated here explicitly so a future change
    // that made `exited` resolve `0` would flip this and be caught.
    const classify = (exitCode: number | null, killedByUs: boolean): 'crash' | 'clean' =>
      !killedByUs && exitCode !== 0 ? 'crash' : 'clean'

    const crashServer = new FakeHerdrServer({ paneId: 'w9:pC2' })
    const crashed = await spawn(crashServer)
    crashServer.exitPane()
    expect(classify(await crashed.exited, crashed.wasKilledByUs?.() ?? false)).toBe('crash')

    const recycleServer = new FakeHerdrServer({ paneId: 'w9:pR2' })
    const recycled = await spawn(recycleServer)
    recycled.kill()
    expect(classify(await recycled.exited, recycled.wasKilledByUs?.() ?? false)).toBe('clean')

    // And the counterfactual that shows the exit-code half is inert: had the host
    // resolved 0 instead of null, the crash above would have classified 'clean'.
    expect(classify(0, false)).toBe('clean')
  })

  it('onExit is called with null, and exactly once', async () => {
    const server = new FakeHerdrServer()
    const seen: (number | null)[] = []
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 10_000,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {}, onExit: (c) => seen.push(c) })
    child.beginOutput?.()
    server.exitPane()
    await child.exited
    // A close racing the discovery must not double-report a death.
    child.kill()
    await Bun.sleep(20)
    expect(seen).toEqual([null])
  })

  // DELETED: 'an exit for a DIFFERENT pane is ignored'. It guarded a server-wide
  // subscription, where every pane's exit arrived on our socket and had to be filtered
  // by `pane_id`. There is no subscription: each poll asks about OUR pane by id, so a
  // neighbour's exit is not something this host can be told about. The hazard is gone
  // rather than handled — which is also why a fresh subscriber being delivered another
  // pane's recent exit (MEASURED) can no longer reach us.

  it('kill() records intent BEFORE the close lands, so a race cannot read as a crash', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    child.kill()
    // Synchronously after the call, before any await — the flag is already set. If it
    // were set in the close's callback, a `pane_exited` arriving first would classify
    // an intentional recycle as a crash.
    expect(child.wasKilledByUs?.()).toBe(true)
    await child.exited
  })

  it('hasExited flips, and the connection is released on exit', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    expect(child.hasExited()).toBe(false)
    server.exitPane()
    await child.exited
    expect(child.hasExited()).toBe(true)
    // NOTHING TO CLOSE. The old assertion required the REPL's long-lived socket to die
    // with it, or a gateway would accumulate one per respawn. With a connection per
    // call there is no socket outliving a request, so the leak it guarded cannot
    // exist — the guarantee is now structural rather than asserted.
  })
})
