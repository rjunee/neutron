/**
 * THE SHUTDOWN MUST GET PAST ITS FIRST LINE.
 *
 * `shutdown()` began with `await boundServer.stop(opts)` — a GRACEFUL
 * `Bun.serve().stop(false)`, which waits for open connections. The gateway
 * serves its app WebSocket from that same listener, and a WebSocket is not an
 * in-flight request that completes: it is open until the client leaves, and the
 * owner's web app and phone hold one continuously.
 *
 * Measured on the instance 2026-09-14 across EIGHT deploys: every shutdown took
 * exactly 30.0 s — systemd's `TimeoutStopSec` — and emitted no shutdown log line
 * at all, because that await never returned. Everything after it (the module
 * graph's shutdown, the REPL pool teardown, `drainRealmodeCleanups`,
 * `db.close()`) had never run in production, and the database was SIGKILLed open
 * on every deploy.
 *
 * WHY NO EXISTING TEST COULD SEE IT: the bound server's `stop` auto-forces under
 * `NODE_ENV='test'` (`gateway/index.ts`), which `bun test` sets. Every test in
 * this repo therefore exercises the forced branch, and production is the only
 * caller of the branch that hangs. So these cases drive a REAL `Bun.serve` with
 * a REAL client socket held open, and never go through that auto-force.
 */
import { afterEach, expect, test } from 'bun:test'
import { LISTENER_DRAIN_BUDGET_MS, stopListenerWithinBudget } from '../index.ts'

const noopLog = { info: () => {}, error: () => {} }

/**
 * A controllable budget timer, so the cases below assert the BRANCH TAKEN rather
 * than an elapsed duration. A wall-clock assertion here would redden when the
 * runner is loaded instead of when the code is wrong, and the thing actually
 * under test is "which path did it choose", which is a discriminant, not a time.
 */
function fakeTimer(): {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (h: unknown) => void
  /** The budgets asked for, in order — empty means the budget was never armed. */
  requested: number[]
  /** Fire the pending budget, as if it had elapsed. */
  elapse: () => void
} {
  const requested: number[] = []
  let pending: (() => void) | null = null
  return {
    requested,
    setTimer: (fn, ms) => { requested.push(ms); pending = fn; return 'h' },
    clearTimer: () => { pending = null },
    elapse: () => { const fn = pending; pending = null; fn?.() },
  }
}

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) {
    try { fn() } catch { /* best-effort */ }
  }
})

/** A real listener with a real WebSocket route, plus one connected client. */
async function serverWithLiveSocket(): Promise<{
  stop: (opts?: { force?: boolean }) => Promise<void>
}> {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined
      return new Response('ok')
    },
    websocket: { message() {}, open() {} },
  })
  cleanup.push(() => { void server.stop(true) })
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
  cleanup.push(() => ws.close())
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('client could not connect')), { once: true })
  })
  // The force flag is resolved HERE, not by NODE_ENV, so the case measures the
  // production branch even under `bun test`.
  return { stop: async (opts) => { await server.stop(opts?.force === true) } }
}

test('a graceful stop does NOT return while a websocket client is connected — the live defect', async () => {
  const server = await serverWithLiveSocket()
  let returned = false
  const graceful = server.stop().then(() => { returned = true })
  graceful.catch(() => {})
  // WALL-CLOCK-BOUND-OK: this case observes an EXTERNAL library behaviour — that
  // `Bun.serve().stop(false)` does not resolve while a socket is open — and there
  // is no deterministic assertion that can stand in for it, because the whole
  // point is that no event ever arrives. The margin is generous in the direction
  // that matters: a loaded runner makes the stop LESS likely to return, so load
  // cannot turn this red, only the library changing can. 1.5 s against a defect
  // that cost 30 s on every deploy.
  await Bun.sleep(1_500)
  expect(
    returned,
    'the graceful stop returned — if this ever passes, Bun changed and the budget below may be removable',
  ).toBe(false)
})

test('the bounded stop returns anyway — the whole point, since everything that matters runs after it', async () => {
  const server = await serverWithLiveSocket()
  const timer = fakeTimer()
  const stopped = stopListenerWithinBudget(
    server, undefined, LISTENER_DRAIN_BUDGET_MS, noopLog, timer.setTimer, timer.clearTimer,
  )
  // It armed the budget with the value it was given — the seam is real, not decorative.
  expect(timer.requested).toEqual([LISTENER_DRAIN_BUDGET_MS])
  timer.elapse()
  // Resolving at all IS the assertion: before this change the same call never
  // returned, and systemd killed the process 30 s later with the DB still open.
  await stopped
})

test('it says which branch it took, so this path can never be silent again', async () => {
  const server = await serverWithLiveSocket()
  const lines: string[] = []
  const timer = fakeTimer()
  const stopped = stopListenerWithinBudget(
    server, undefined, LISTENER_DRAIN_BUDGET_MS,
    { info: (e) => lines.push(e), error: (e) => lines.push(e) },
    timer.setTimer, timer.clearTimer,
  )
  timer.elapse()
  await stopped
  expect(lines).toContain('http_listener_drain_timed_out')
  expect(lines).toContain('http_listener_stopped')
})

test('a listener with NOTHING holding it open still drains gracefully, and says so', async () => {
  // The non-vacuity control: if the bounded stop always forced, it would pass
  // every case above while destroying the graceful behaviour the comment at the
  // call site promises. It must still prefer the drain when the drain works.
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  cleanup.push(() => { void server.stop(true) })
  const seen: Array<{ event: string; fields?: Record<string, unknown> }> = []
  const timer = fakeTimer()
  // The budget is NEVER elapsed here. If the implementation could only finish by
  // forcing, this await would hang — so resolving is itself the proof it drained.
  await stopListenerWithinBudget(
    { stop: async (opts) => { await server.stop(opts?.force === true) } },
    undefined,
    LISTENER_DRAIN_BUDGET_MS,
    { info: (event, fields) => seen.push({ event, ...(fields ? { fields } : {}) }),
      error: (event, fields) => seen.push({ event, ...(fields ? { fields } : {}) }) },
    timer.setTimer, timer.clearTimer,
  )
  expect(seen.map((l) => l.event)).not.toContain('http_listener_drain_timed_out')
  // THE ASSERTION THAT MAKES THIS A CONTROL: it must report the GRACEFUL drain,
  // not merely finish quickly. An implementation that always forced would also
  // finish quickly and log no timeout, and would pass every other case here
  // while silently discarding in-flight requests on every deploy.
  expect(seen.find((l) => l.event === 'http_listener_stopped')?.fields?.['drain']).toBe('graceful')
})

test('an explicit force does not spend the budget first', async () => {
  const server = await serverWithLiveSocket()
  const timer = fakeTimer()
  await stopListenerWithinBudget(
    server, { force: true }, LISTENER_DRAIN_BUDGET_MS, noopLog, timer.setTimer, timer.clearTimer,
  )
  // The discriminant, not a duration: the budget was never armed at all.
  expect(timer.requested).toEqual([])
})
