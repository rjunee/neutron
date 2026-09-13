/**
 * child-exit-pool-identity.test.ts — #539, Argus r53: the exit teardown's THREE pool arms are
 * all identity-guarded, including the rejected one.
 *
 * THE DEFECT, and how it was found. The audit table said pool deletion on this path was
 * "guarded on the awaited session being ours"; the reject arm deleted the current entry with no
 * identity check at all. **The gate found it by checking the table against the code** — the
 * first time on this branch that the audit table caught the implementation rather than the
 * reverse, which is the argument for writing cells specific enough to be falsified.
 *
 * Round thirty is where the arm came from, and its reasoning was right about one axis and
 * silent about the other: *a pooled promise that rejects owns no child, so deleting it is
 * right, and dropping the arm would wedge a rejected entry under the key forever.* True of
 * FULFILLED-versus-REJECTED, and nothing about IDENTITY — a rejected STALE promise owning
 * nothing is not a licence to delete a different, CURRENT entry.
 *
 * BOTH SETTLEMENTS, BOTH DIRECTIONS — four cases, because the header used to claim three arms
 * while covering one settlement (r54 caught that too: a file-level claim is the same kind of
 * instrument as a criterion and must not describe coverage the file does not have). A stale
 * entry of either kind must not evict its replacement; a current entry of either kind must still
 * be removed. Without the "still removed" halves the fix would be "never delete", which wedges
 * the key — the exact failure round thirty was protecting against.
 *
 * AND THE FULFILLED ARM HAD THE SAME DEFECT ONE ROUND LATER (r54). It compared the RESOLVED
 * VALUE to our session — true by construction — instead of asking what the map holds now. It is
 * live on main as #679; this file is the extracted copy.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { wireChildExit } from '../child-exit-wiring.ts'
import { childByKey, pool } from '../pool-state.ts'
import { ReplSession } from '../repl-session.ts'
import type { PtyChild } from '../pty-host.ts'

const KEY = 'inst r53 pool identity'
const SESSION_ID = 'r53r53r5-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-53535353535353535353535353535353'

afterEach(() => {
  pool.clear()
  childByKey.clear()
})

/** A child whose exit the case decides, and nothing else. */
function fakeChild(): { child: PtyChild; exit: () => void } {
  let resolveExit: (code: number | null) => void = () => {}
  const exited = new Promise<number | null>((res) => {
    resolveExit = res
  })
  let hasExited = false
  const child: PtyChild = {
    pid: 4242,
    write: () => {},
    kill: () => {},
    exited,
    hasExited: () => hasExited,
    wasKilledByUs: () => false,
  }
  return {
    child,
    exit: () => {
      hasExited = true
      resolveExit(0)
    },
  }
}

function session(): ReplSession {
  return new ReplSession(KEY, 'gen-r53', SESSION_ID, CHANNEL, '/tmp')
}

/** Settle the fire-and-forget exit handler: it awaits the pooled promise, so a couple of
 *  microtask turns are enough and no timer is involved. Awaited, not slept. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe("the exit teardown's pool arms are all identity-guarded", () => {
  it('a STALE rejected entry does not evict its replacement', async () => {
    const dying = session()
    const { child, exit } = fakeChild()
    let rejectStale: (e: Error) => void = () => {}
    const stale = new Promise<ReplSession>((_res, rej) => {
      rejectStale = rej
    })
    // Not an unhandled rejection: the code under test is the only consumer that matters, and a
    // bare rejected promise in a suite is noise the runner reports.
    stale.catch(() => undefined)
    pool.set(KEY, stale)

    wireChildExit({
      session: dying,
      child,
      sessionKey: KEY,
      sessionId: SESSION_ID,
      liveHandle: () => undefined,
      label: 'r53.stale',
      registryPath: undefined,
    })

    // The child exits, so the handler captures the pooled promise it can see — the stale one,
    // still pending.
    exit()
    await settle()

    // A REPLACEMENT LANDS UNDER THE SAME KEY, which is the race: a respawn or a second
    // gateway's publish between the capture and the rejection.
    const replacement = session()
    pool.set(KEY, Promise.resolve(replacement))

    // NOW the stale promise rejects, and its catch runs.
    rejectStale(new Error('the spawn this entry stood for failed'))
    await settle()

    // THE REPLACEMENT SURVIVES. Before the guard this deleted it, leaving a live session with
    // no pool entry — and `pool` is the map every turn resolves through.
    expect(await pool.get(KEY)).toBe(replacement)
  })

  it('...but a CURRENT rejected entry is still removed', async () => {
    // THE POSITIVE CONTROL, and it is the reason the arm exists at all: without it the fix
    // would be "never delete on rejection", and a rejected entry would wedge the key forever —
    // every later turn resolving through a promise that can only throw.
    const dying = session()
    const { child, exit } = fakeChild()
    let rejectCurrent: (e: Error) => void = () => {}
    const current = new Promise<ReplSession>((_res, rej) => {
      rejectCurrent = rej
    })
    current.catch(() => undefined)
    pool.set(KEY, current)

    wireChildExit({
      session: dying,
      child,
      sessionKey: KEY,
      sessionId: SESSION_ID,
      liveHandle: () => undefined,
      label: 'r53.current',
      registryPath: undefined,
    })

    exit()
    await settle()
    rejectCurrent(new Error('the spawn this entry stood for failed'))
    await settle()

    expect(pool.get(KEY)).toBeUndefined()
  })

  it('and the exit clears BOTH watcher references, not one', async () => {
    // r53's third finding: the audit table said both were stopped and cleared; only
    // `deadTurnWatcher` was. A retained reference on a path that stops owning is the
    // round-thirty-one question, and the cheap answer is to clear it and make the cell true.
    const dying = session()
    const { child, exit } = fakeChild()
    let stopped = 0
    dying.deadTurnWatcher = { stop: () => { stopped += 1 } } as never
    dying.sizeWatchdog = { stop: () => { stopped += 1 } } as never

    wireChildExit({
      session: dying,
      child,
      sessionKey: KEY,
      sessionId: SESSION_ID,
      liveHandle: () => undefined,
      label: 'r53.watchers',
      registryPath: undefined,
    })
    exit()
    await settle()

    expect(stopped).toBe(2)
    expect(dying.deadTurnWatcher).toBeUndefined()
    expect(dying.sizeWatchdog).toBeUndefined()
  })

  it('a STALE fulfilled entry does not evict its replacement', async () => {
    // The r54 defect. `(await pooled) === session` is TRUE for a stale entry — it is our own
    // session's promise — so the delete ran and evicted whatever had replaced it.
    const dying = session()
    const { child, exit } = fakeChild()
    let resolveStale: (s: ReplSession) => void = () => {}
    const stale = new Promise<ReplSession>((res) => {
      resolveStale = res
    })
    pool.set(KEY, stale)

    wireChildExit({
      session: dying,
      child,
      sessionKey: KEY,
      sessionId: SESSION_ID,
      liveHandle: () => undefined,
      label: 'r54.stale-fulfilled',
      registryPath: undefined,
    })

    exit()
    await settle()

    // The replacement lands while the handler is suspended on the stale promise.
    const replacement = session()
    pool.set(KEY, Promise.resolve(replacement))

    // NOW the stale promise fulfils — with our own session, which is exactly why the old
    // value comparison passed.
    resolveStale(dying)
    await settle()

    expect(await pool.get(KEY)).toBe(replacement)
  })

  it('...but a CURRENT fulfilled entry is still removed', async () => {
    // The positive control for the fulfilled arm: without it the fix is "never delete", and a
    // dead child's session stays in the pool for every later turn to resolve through.
    const dying = session()
    const { child, exit } = fakeChild()
    pool.set(KEY, Promise.resolve(dying))

    wireChildExit({
      session: dying,
      child,
      sessionKey: KEY,
      sessionId: SESSION_ID,
      liveHandle: () => undefined,
      label: 'r54.current-fulfilled',
      registryPath: undefined,
    })

    exit()
    await settle()

    expect(pool.get(KEY)).toBeUndefined()
  })
})
