/**
 * child-exit-pool-identity.test.ts — #539: **the pool delete is ONE identity guard on the entry this session was published under**.
 *
 * (That sentence is written identically in `child-exit-wiring.ts` and in the as-built, because
 * three artefacts describing one structure in three different ways is how r55 found this file
 * still claiming "three arms" after the implementation had collapsed them to one. A grep for
 * the sentence is the check.)
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

/**
 * PUBLISH a session the way production does: the map entry and the session's record of WHAT IT
 * WAS PUBLISHED AS, together.
 *
 * The r55 control was weak precisely because it skipped the second half — it put a promise in
 * the map and let the teardown find it, so "the current entry" and "the dying session's entry"
 * were the same object by construction and no implementation could fail the case.
 */
function publish(s: ReplSession, p: Promise<ReplSession>): Promise<ReplSession> {
  s.pooledAs = p
  pool.set(KEY, p)
  return p
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
    publish(dying, stale)

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
    publish(dying, current)

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
    publish(dying, stale)

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
    publish(dying, Promise.resolve(dying))

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

  /**
   * THE INTERLEAVING THE SUITE HAD NO SHAPE FOR (r55): the replacement is published BEFORE the
   * exit handler runs at all. Every earlier case installed B after settling until the handler
   * had already captured something, which tests late arrival — the opposite ordering.
   *
   * This is the one that distinguishes "the entry I was published under" from "whatever is in
   * the map when my callback runs", and the three settlements are covered because a respawn
   * publishes its promise BEFORE its child is ready: pending is the likeliest real shape.
   */
  for (const [name, makeReplacement] of [
    ['fulfilled', () => Promise.resolve(session())],
    ['pending', () => new Promise<ReplSession>(() => {})],
    [
      'rejected',
      () => {
        const p = Promise.reject(new Error('the replacement spawn failed'))
        p.catch(() => undefined)
        return p as Promise<ReplSession>
      },
    ],
  ] as Array<[string, () => Promise<ReplSession>]>) {
    it(`a replacement published BEFORE the handler runs survives (${name})`, async () => {
      const dying = session()
      const { child, exit } = fakeChild()
      // The dying session was published, and then superseded — its own entry is gone from the
      // map before its child's exit is even observed.
      publish(dying, Promise.resolve(dying))
      const replacement = makeReplacement()
      pool.set(KEY, replacement)

      wireChildExit({
        session: dying,
        child,
        sessionKey: KEY,
        sessionId: SESSION_ID,
        liveHandle: () => undefined,
        label: `r55.preinstalled-${name}`,
        registryPath: undefined,
      })

      exit()
      await settle()

      // THE REPLACEMENT IS UNTOUCHED. Reading the map inside the callback would have captured
      // IT, found it current, and deleted it — a live REPL orphaned out of the map every turn
      // resolves through, which is what this file's header says must not happen.
      expect(pool.get(KEY)).toBe(replacement)
    })
  }
})
