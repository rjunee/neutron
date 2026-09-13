/**
 * herdr-poll-bounds.test.ts — the numbers the polling bridge is bounded by, pinned
 * as VALUES and not only as relations.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST (found on #575): a test that asserts a
 * RELATION against a constant is blind to the constant moving. `expect(poll <
 * quiet)` keeps passing if someone raises the poll interval to 800 ms, or drops the
 * quiet window to 300 ms, or both. So every bound here is pinned twice: the value,
 * and the relation that makes the value load-bearing.
 *
 * The relations, and what breaks if each is violated:
 *  • poll < quiet — `waitForReplIdle` calls the REPL idle once `lastDataAt` is
 *    `quiet` old, and `lastDataAt` only advances when a poll OBSERVES a change. If
 *    the poll interval reached the quiet window, a continuously-emitting REPL would
 *    look idle in the gap between two observations and the prompt inject would land
 *    mid-turn and be dropped.
 *  • window >= the widest detector read — a smaller window silently blinds the
 *    widest positional guard.
 *  • viewport + window <= herdr's read cap — past the cap the server truncates and
 *    the window is not what we asked for.
 */

import { describe, expect, it } from 'bun:test'
import {
  herdrReadWindow,
  HERDR_VIEWPORT_REFRESH_MS,
  HERDR_POLL_INTERVAL_MS,
  HERDR_READ_LINE_CAP,
  HERDR_READ_SOURCE,
  HERDR_READ_WINDOW_LINES,
  HERDR_VIEWPORT_ROWS_FALLBACK,
} from '../herdr-protocol.ts'
import { DEFAULT_IDLE_QUIET_MS, DISCLAIMER_BOTTOM_N } from '../signatures.ts'
import { HerdrHost } from '../herdr-host.ts'
import { FakeHerdrServer, until } from './herdr-fake-server.ts'

describe('the poll interval against the idle gate', () => {
  it('pins BOTH values, not just the relation between them', () => {
    // Either assertion alone is satisfied by a wrong pair of numbers.
    expect(HERDR_POLL_INTERVAL_MS).toBe(250)
    expect(DEFAULT_IDLE_QUIET_MS).toBe(900)
  })

  it('the poll interval is strictly inside the quiet window, with real margin', () => {
    expect(HERDR_POLL_INTERVAL_MS).toBeLessThan(DEFAULT_IDLE_QUIET_MS)
    // Not merely "less than": a poll at 899 ms would satisfy `<` and still let a
    // busy REPL read as idle on any scheduling hiccup. Require at least three
    // observations inside the window.
    expect(HERDR_POLL_INTERVAL_MS * 3).toBeLessThanOrEqual(DEFAULT_IDLE_QUIET_MS)
  })
})

describe('the read window', () => {
  it('pins the window value AND ties it to the widest detector read', () => {
    expect(HERDR_READ_WINDOW_LINES).toBe(200)
    // The widest window any detector asks the ring for. If a new detector wants
    // more, this fails and the bridge has to be widened with it — rather than that
    // detector silently seeing a short screen.
    expect(DISCLAIMER_BOTTOM_N).toBe(200)
    expect(HERDR_READ_WINDOW_LINES).toBeGreaterThanOrEqual(DISCLAIMER_BOTTOM_N)
  })

  it('pins herdr\'s measured read cap and proves the request fits under it', () => {
    // MEASURED: `lines=5000` on a pane that had printed 1500 lines returned exactly
    // 999 with `truncated: true`.
    expect(HERDR_READ_LINE_CAP).toBe(999)
    // The worst case we ever ask for: the fallback viewport plus the window.
    expect(HERDR_VIEWPORT_ROWS_FALLBACK + HERDR_READ_WINDOW_LINES).toBeLessThanOrEqual(
      HERDR_READ_LINE_CAP,
    )
  })

  it('asks for viewport_rows + window, because blank rows count BEFORE trimming', async () => {
    // MEASURED: a pane with three content lines under a 62-row viewport returned
    // EMPTY text for `recent_unwrapped lines=10`, and all three lines for
    // `lines=200`. A host that asked for a bare `HERDR_READ_WINDOW_LINES` would
    // return nothing from a cleared pane — and would look perfectly correct against
    // a full one, which is why this asserts the REQUEST and not the response.
    const server = new FakeHerdrServer({ viewportRows: 62 })
    server.screen = 'AAA\nBBB\nCCC'
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {} })
    child.beginOutput?.() // release the gate, as `spawn.ts` does after wiring
    await until(() => server.callsTo('pane.read').length >= 1, 'a read')
    const read = server.callsTo('pane.read')[0]!
    expect(read.params['lines']).toBe(62 + HERDR_READ_WINDOW_LINES)
    // And it reads the source that can see past the viewport into scrollback with
    // soft wraps joined. `visible` cannot reach scrollback at all.
    expect(read.params['source']).toBe(HERDR_READ_SOURCE)
    expect(HERDR_READ_SOURCE).toBe('recent_unwrapped')
    expect(read.params['strip_ansi']).toBe(true)
    child.kill()
  })

  it('a DIFFERENT viewport produces a DIFFERENT request — the allowance is real', async () => {
    // The case that catches a host which hardcoded `62 + 200` or ignored the
    // viewport entirely while still passing the test above.
    const server = new FakeHerdrServer({ viewportRows: 24 })
    server.screen = 'x'
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {} })
    child.beginOutput?.() // release the gate, as `spawn.ts` does after wiring
    await until(() => server.callsTo('pane.read').length >= 1, 'a read')
    expect(server.callsTo('pane.read')[0]!.params['lines']).toBe(24 + HERDR_READ_WINDOW_LINES)
    child.kill()
  })

  it('falls back to a safe allowance when herdr reports no viewport at all', async () => {
    const server = new FakeHerdrServer({ viewportRows: null })
    server.screen = 'x'
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {} })
    child.beginOutput?.() // release the gate, as `spawn.ts` does after wiring
    await until(() => server.callsTo('pane.read').length >= 1, 'a read')
    expect(HERDR_VIEWPORT_ROWS_FALLBACK).toBe(120)
    expect(server.callsTo('pane.read')[0]!.params['lines']).toBe(
      HERDR_VIEWPORT_ROWS_FALLBACK + HERDR_READ_WINDOW_LINES,
    )
    child.kill()
  })
})

describe('the read cap is enforced AT the boundary, not just for convenient viewports', () => {
  // The boundary is `HERDR_READ_LINE_CAP - HERDR_READ_WINDOW_LINES` = 799. Below it
  // both constraints hold at once (ask for viewport+200, get it). At and above it
  // they cannot, because the server will not return more than 999 however much is
  // asked for. Viewports of 24, 62 and the 120 fallback are all comfortably below
  // the boundary — which is exactly why testing only those proves nothing about it.
  const BOUNDARY = HERDR_READ_LINE_CAP - HERDR_READ_WINDOW_LINES

  it('the boundary is where the two constraints stop both being satisfiable', () => {
    expect(BOUNDARY).toBe(799)
  })

  it('JUST BELOW the boundary the full window is still delivered, unclamped', () => {
    const w = herdrReadWindow(BOUNDARY - 1)
    expect(w.lines).toBe(BOUNDARY - 1 + HERDR_READ_WINDOW_LINES)
    expect(w.lines).toBeLessThan(HERDR_READ_LINE_CAP)
    expect(w.clamped).toBe(false)
    expect(w.contentAllowance).toBe(HERDR_READ_WINDOW_LINES)
    expect(w.belowDetectorWindow).toBe(false)
  })

  it('AT the boundary the request exactly fills the cap, still unclamped', () => {
    const w = herdrReadWindow(BOUNDARY)
    expect(w.lines).toBe(HERDR_READ_LINE_CAP)
    expect(w.clamped).toBe(false)
    expect(w.contentAllowance).toBe(HERDR_READ_WINDOW_LINES)
  })

  it('ONE PAST the boundary it clamps, and says the window shrank', () => {
    // The case an unconditional `viewport + 200` gets wrong: it asks for 1,000, the
    // server truncates to 999, and nothing knows the promised 200 content lines
    // became 199.
    const w = herdrReadWindow(BOUNDARY + 1)
    expect(w.lines).toBe(HERDR_READ_LINE_CAP)
    expect(w.clamped).toBe(true)
    expect(w.contentAllowance).toBe(HERDR_READ_WINDOW_LINES - 1)
    expect(w.belowDetectorWindow).toBe(true)
  })

  it('a viewport AT the cap can carry no content past its own screen, and says so', () => {
    const w = herdrReadWindow(HERDR_READ_LINE_CAP)
    expect(w.lines).toBe(HERDR_READ_LINE_CAP)
    expect(w.contentAllowance).toBe(0)
    expect(w.belowDetectorWindow).toBe(true)
  })

  it('a viewport PAST the cap reports a NEGATIVE allowance rather than pretending', () => {
    // Honest rather than clamped-to-zero: the pane cannot be read past its own
    // screen at all, and that is a different fact from "exactly zero spare lines".
    const w = herdrReadWindow(HERDR_READ_LINE_CAP + 50)
    expect(w.lines).toBe(HERDR_READ_LINE_CAP)
    expect(w.contentAllowance).toBe(-50)
    expect(w.belowDetectorWindow).toBe(true)
  })

  it('the request the HOST actually sends is clamped at 800 and unclamped at 24', async () => {
    // Both directions in one place: the clamp must bite where the invariant breaks
    // and stay out of the way where it does not. A guard that simply capped every
    // request would pass the 800 case and fail this one.
    for (const [viewport, expected] of [
      [800, HERDR_READ_LINE_CAP],
      [24, 24 + HERDR_READ_WINDOW_LINES],
    ] as [number, number][]) {
      const server = new FakeHerdrServer({ viewportRows: viewport })
      server.screen = 'x'
      const host = new HerdrHost({
        connect: async () => server,
        pollIntervalMs: 5,
        sleep: (ms) => Bun.sleep(ms),
        workspaceId: 'w9',
      })
      const child = await host.spawn(['claude'], { cwd: '/tmp', env: {} })
      child.beginOutput?.() // release the gate, as `spawn.ts` does after wiring
      await until(() => server.callsTo('pane.read').length >= 1, `read at viewport ${viewport}`)
      expect(server.callsTo('pane.read')[0]!.params['lines']).toBe(expected)
      // And never above the cap, whatever the viewport.
      expect(server.callsTo('pane.read')[0]!.params['lines']).toBeLessThanOrEqual(HERDR_READ_LINE_CAP)
      child.kill()
    }
  })
})

describe('the viewport is re-read, not cached for the life of the pane', () => {
  /** Spawn with a fast viewport refresh and return the `lines` of the latest read. */
  async function spawnWatchingReads(server: FakeHerdrServer) {
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      viewportRefreshMs: 10,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {} })
    child.beginOutput?.() // release the gate, as `spawn.ts` does after wiring
    const lastLines = (): number | undefined => {
      const reads = server.callsTo('pane.read')
      return reads.length === 0 ? undefined : (reads[reads.length - 1]!.params['lines'] as number)
    }
    return { child, lastLines }
  }

  it('a pane that GROWS gets a bigger request — the stale height is not kept', async () => {
    // THE DEFECT. `viewportRows` was populated only while undefined, so a pane that
    // started at 62 and was resized to 300 went on asking for 262. Blank viewport
    // rows count toward `lines` BEFORE trimming, so that request can come back with
    // NO CONTENT AT ALL — every positional detector silently blind, nothing failing.
    const server = new FakeHerdrServer({ viewportRows: 62 })
    server.screen = 'x'
    const { child, lastLines } = await spawnWatchingReads(server)
    await until(() => lastLines() === 62 + HERDR_READ_WINDOW_LINES, 'initial 62-row request')

    server.viewportRows = 300 // the owner drags the split
    await until(() => lastLines() === 300 + HERDR_READ_WINDOW_LINES, 'request follows the growth')
    child.kill()
  })

  it('a pane that SHRINKS also gets a corrected request', async () => {
    // Shrinkage is the BENIGN direction — an over-large request still returns the
    // content — so a broken refresh hides here. Testing only growth would let a
    // refresh that fires once, or only upward, pass.
    const server = new FakeHerdrServer({ viewportRows: 300 })
    server.screen = 'x'
    const { child, lastLines } = await spawnWatchingReads(server)
    await until(() => lastLines() === 300 + HERDR_READ_WINDOW_LINES, 'initial 300-row request')

    server.viewportRows = 62
    await until(() => lastLines() === 62 + HERDR_READ_WINDOW_LINES, 'request follows the shrink')
    child.kill()
  })

  it('a viewport that stops being readable KEEPS the last known height', async () => {
    // The refresh must not turn a transient `pane.get` failure into a fallback-sized
    // request: the last MEASURED height is better evidence than the constant.
    const server = new FakeHerdrServer({ viewportRows: 300 })
    server.screen = 'x'
    const { child, lastLines } = await spawnWatchingReads(server)
    await until(() => lastLines() === 300 + HERDR_READ_WINDOW_LINES, 'initial')
    server.viewportRows = null // pane.get answers, but reports no scroll info
    await Bun.sleep(60)
    expect(lastLines()).toBe(300 + HERDR_READ_WINDOW_LINES)
    child.kill()
  })

  it('the refresh cadence is pinned, and is well inside a human resize', () => {
    expect(HERDR_VIEWPORT_REFRESH_MS).toBe(5000)
    // ~20 polls per refresh: cheap next to `pane.read`, tight enough that a resize
    // is corrected long before it matters.
    expect(HERDR_VIEWPORT_REFRESH_MS / HERDR_POLL_INTERVAL_MS).toBe(20)
  })
})

describe('herdr\'s revision field is not used as a change signal', () => {
  it('the bridge mints its own sequence — `revision` is inert (hardcoded 0 on reads)', async () => {
    // MEASURED: every `pane.read` reply carries `revision: 0`, and on `pane.list` it
    // ticks ~3.3 Hz on an idle agent pane while staying frozen on a shell pane
    // emitting 300 lines. A bridge that keyed change detection off it would deliver
    // nothing at all here — the fake reports 0 forever, exactly like the real one.
    const server = new FakeHerdrServer()
    server.screen = 'first'
    const screens: string[] = []
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {}, onScreen: (s) => screens.push(s) })
    child.beginOutput?.() // release the gate, as `spawn.ts` does after wiring
    await until(() => screens.includes('first'), 'first')
    server.screen = 'second'
    await until(() => screens.includes('second'), 'second despite revision staying 0')
    expect(screens).toEqual(['first', 'second'])
    child.kill()
  })
})
