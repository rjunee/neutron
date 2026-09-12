/**
 * live-herdr-child.test.ts — the CLEANUP guarantee, tested without a live server.
 *
 * The helper exists because four real `claude` processes were left running in the
 * owner's herdr by suites that all LOOKED like they cleaned up: each had a `finally`
 * calling `kill()`. What they did not have was a way to know the close happened, and
 * that is what these cases pin. None of them needs a server — the property is about
 * what the helper does with a `PtyChild`, not about herdr.
 */

import { describe, expect, it } from 'bun:test'
import { closeLiveChild, paneIdsAdded } from './live-herdr-child.ts'
import { withCapturedStderr } from './capture-stderr.ts'
import type { PtyChild } from '../pty-host.ts'

/**
 * A child whose exit settles only if the fake is told to settle it.
 *
 * `settleOnKill: false` is the arrangement that matters: the REAL host settles
 * `'closed-by-us'` from the `pane.close` REPLY, never from the attempt, so a fake that
 * settles unconditionally cannot reproduce the case this helper exists for.
 */
function fakeChild(opts: { settleOnKill?: boolean; alreadyExited?: boolean } = {}): {
  readonly child: PtyChild
  readonly kills: () => number
} {
  let exited = opts.alreadyExited === true
  let kills = 0
  let resolveExit: (v: number | null) => void = () => {}
  const exitedPromise = new Promise<number | null>((res) => {
    resolveExit = res
  })
  if (exited) resolveExit(null)
  const child: PtyChild = {
    pid: 1234,
    write: () => undefined,
    kill: () => {
      kills += 1
      if (opts.settleOnKill === true) {
        exited = true
        resolveExit(null)
      }
    },
    exited: exitedPromise,
    hasExited: () => exited,
  }
  return { child, kills: () => kills }
}

describe('closeLiveChild waits for the server to CONFIRM, not merely to be asked', () => {
  it('returns once the child settles — the confirmed case', async () => {
    const f = fakeChild({ settleOnKill: true })
    const errs = await withCapturedStderr(async () => {
      await closeLiveChild(f.child, 2000)
    })
    expect(f.kills()).toBe(1)
    // Nothing said: the close was confirmed, so there is nothing for a human to chase.
    expect(errs.filter((e) => e.includes('did NOT confirm'))).toEqual([])
  })

  it('a close that NEVER confirms is bounded and SAID OUT LOUD, with the pid', async () => {
    // The leak's actual shape: `kill()` is void, the close is a background RPC, and a
    // process that exits here has asked without knowing. Waiting forever would turn a
    // leak into a hang — a worse way to find out about the same problem — so the wait
    // is bounded and the failure is reported rather than swallowed.
    const f = fakeChild({ settleOnKill: false })
    const errs = await withCapturedStderr(async () => {
      await closeLiveChild(f.child, 50)
    })
    expect(f.kills()).toBe(1)
    const said = errs.filter((e) => e.includes('did NOT confirm closure'))
    expect(said.length).toBe(1)
    expect(said[0]).toContain('1234') // the pid, so the message names what to chase
    expect(said[0]).toContain('pane.list')
  })

  it('an ALREADY-EXITED child is not killed again', async () => {
    const f = fakeChild({ alreadyExited: true })
    await closeLiveChild(f.child, 50)
    expect(f.kills()).toBe(0)
  })

  it('an undefined child — the spawn that never resolved — is a no-op, not a throw', async () => {
    // The `finally` runs even when the spawn REJECTED, which is half of why the helper
    // owns it. It must not turn a spawn failure into a second, louder failure.
    await closeLiveChild(undefined, 50)
  })
})

describe('the pane-leak measurement', () => {
  it('reports the panes that APPEARED, by id', () => {
    expect(paneIdsAdded(['w6:p1', 'w6:p2'], ['w6:p1', 'w6:p2', 'w6:pX'])).toEqual(['w6:pX'])
  })

  it('a pane that CLOSED is not a leak', () => {
    // The owner closing one of his own panes mid-run must not fail the suite.
    expect(paneIdsAdded(['w6:p1', 'w6:p2'], ['w6:p1'])).toEqual([])
  })

  it('CONTROL — an unchanged server reports nothing', () => {
    expect(paneIdsAdded(['w6:p1', 'w6:p2'], ['w6:p2', 'w6:p1'])).toEqual([])
  })
})
