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
  // Generous relative to the 3 s budget under test, and still trivial next to
  // the 30 s this cost on every deploy.
  await Bun.sleep(1_500)
  expect(
    returned,
    'the graceful stop returned — if this ever passes, Bun changed and the budget below may be removable',
  ).toBe(false)
})

test('the bounded stop returns anyway, well inside the systemd stop timeout', async () => {
  const server = await serverWithLiveSocket()
  const started = Date.now()
  await stopListenerWithinBudget(server, undefined, LISTENER_DRAIN_BUDGET_MS, noopLog)
  const elapsed = Date.now() - started
  expect(elapsed).toBeGreaterThanOrEqual(LISTENER_DRAIN_BUDGET_MS - 250)
  // The whole point: it comes back. systemd allows 30 s for the ENTIRE
  // shutdown, and everything that actually matters runs after this call.
  expect(elapsed).toBeLessThan(LISTENER_DRAIN_BUDGET_MS + 5_000)
})

test('it says which branch it took, so this path can never be silent again', async () => {
  const server = await serverWithLiveSocket()
  const lines: string[] = []
  await stopListenerWithinBudget(server, undefined, 200, {
    info: (e) => lines.push(e),
    error: (e) => lines.push(e),
  })
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
  const started = Date.now()
  await stopListenerWithinBudget(
    { stop: async (opts) => { await server.stop(opts?.force === true) } },
    undefined,
    LISTENER_DRAIN_BUDGET_MS,
    { info: (event, fields) => seen.push({ event, ...(fields ? { fields } : {}) }),
      error: (event, fields) => seen.push({ event, ...(fields ? { fields } : {}) }) },
  )
  expect(seen.map((l) => l.event)).not.toContain('http_listener_drain_timed_out')
  // THE ASSERTION THAT MAKES THIS A CONTROL: it must report the GRACEFUL drain,
  // not merely finish quickly. An implementation that always forced would also
  // finish quickly and log no timeout, and would pass every other case here
  // while silently discarding in-flight requests on every deploy.
  expect(seen.find((l) => l.event === 'http_listener_stopped')?.fields?.['drain']).toBe('graceful')
  expect(Date.now() - started).toBeLessThan(LISTENER_DRAIN_BUDGET_MS)
})

test('an explicit force does not spend the budget first', async () => {
  const server = await serverWithLiveSocket()
  const started = Date.now()
  await stopListenerWithinBudget(server, { force: true }, LISTENER_DRAIN_BUDGET_MS, noopLog)
  expect(Date.now() - started).toBeLessThan(LISTENER_DRAIN_BUDGET_MS)
})
