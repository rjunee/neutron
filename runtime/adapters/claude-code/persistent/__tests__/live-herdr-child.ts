/**
 * live-herdr-child.ts — the ONE way a live E2E may spawn a herdr pane.
 *
 * WHY IT EXISTS, stated as the incident. This branch's subject is making herdr the REPL
 * container, and its own live suites leaked REPL containers into the owner's herdr: four
 * orphaned tabs in his workspace, each a real `claude` parented straight to the herdr
 * server, ages spanning the hours these proofs had been running. He noticed them on his
 * own screen and asked whether they were us. They were.
 *
 * TWO DEFECTS, and both are shapes this branch had already fixed elsewhere:
 *
 *  1. THE CLOSE WAS NEVER CONFIRMED. `PtyChild.kill()` is `void` by contract, and under
 *     herdr it issues `pane.close` as a background RPC. A test process that returns from
 *     its `finally` and exits has ASKED for the close without knowing it happened — and
 *     a request still in the socket buffer when the process dies was never sent at all.
 *     Settlement is not confirmation, one layer further out than the first time this
 *     branch learned it.
 *  2. THE SPAWN SAT OUTSIDE THE `try`. Two suites assigned the child above their
 *     `try`/`finally`, so a spawn that rejected — or anything that threw between the
 *     spawn and the `try` — skipped the cleanup entirely while the pane already existed.
 *     The obligation starts when the resource exists, not when the function succeeds;
 *     the same correction `abandonPane` made inside the host, escaping through the suite.
 *
 * WHY NO GATE CAUGHT IT. The panes are created THROUGH A SOCKET by a process the test
 * does not own, so nothing in the test's own process shows a leak — no fd, no child, no
 * handle. And CI never runs these: the live proofs are opt-in and skipped there, which
 * is the same property that let the one-request-per-connection transport defect survive
 * eight green rounds. Twice now on this lane the only instrument that could observe a
 * real defect was a human looking at a screen or a hand-written probe, which is why
 * {@link expectNoPaneLeak} exists: it turns "we remembered to clean up" into a
 * measurement that survives someone adding a fifth live test.
 */

import { afterAll, beforeAll } from 'bun:test'
import { HerdrHost } from '../herdr-host.ts'
import { herdrCall } from '../herdr-client.ts'
import type { PtyChild, PtySpawnOpts } from '../pty-host.ts'

/**
 * How long to wait for the server to CONFIRM the pane is gone.
 *
 * Bounded rather than unbounded: a close that cannot be confirmed must be reported, not
 * waited on forever — a hung teardown would turn a leak into a hang, which is a worse
 * way to find out about the same problem.
 */
const CLOSE_CONFIRM_MS = 10_000

/** A slot the `onScreen` closure can read before `spawn()` has returned. These suites
 *  press keys from inside `onScreen`, which can fire before the spawn resolves. */
export interface LiveChildRef {
  child?: PtyChild | undefined
}

/** Every pane the live server currently holds. Read-only. */
export async function livePaneIds(): Promise<string[]> {
  const r = (await herdrCall('pane.list', {})) as unknown as {
    panes?: readonly { pane_id?: unknown }[]
  }
  return (r.panes ?? [])
    .map((p) => p.pane_id)
    .filter((id): id is string => typeof id === 'string')
    .sort()
}

/**
 * Close `child`'s pane and WAIT FOR THE SERVER TO SAY SO.
 *
 * `child.exited` resolves only on a CONFIRMED closure (`herdr-host.ts` settles
 * `'closed-by-us'` from the `pane.close` reply, never from the attempt), so awaiting it
 * is the difference between asking and knowing. A close that does not confirm is said
 * out loud with the pane id, because the next reader of that message is whoever is
 * looking at an unexplained tab.
 */
export async function closeLiveChild(
  child: PtyChild | undefined,
  confirmMs: number = CLOSE_CONFIRM_MS,
): Promise<void> {
  if (child === undefined || child.hasExited()) return
  child.kill() // no signal → terminal → `pane.close`
  const confirmed = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(confirmMs).then(() => false),
  ])
  if (!confirmed) {
    process.stderr.write(
      `[live-herdr-child] pid ${child.pid}: the pane did NOT confirm closure within ` +
        `${confirmMs}ms. It may still be running in the owner's herdr — check with ` +
        `pane.list and close it by id.\n`,
    )
  }
}

/**
 * Pane IDs present in `after` that were not in `before`.
 *
 * Pure, and separated for that reason: the rest of the measurement needs a live server,
 * and the part that decides what counts as a leak does not. IDs rather than a count —
 * a count says something escaped, an id says what.
 */
export function paneIdsAdded(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const seen = new Set(before)
  return after.filter((id) => !seen.has(id))
}

/**
 * Spawn a live herdr child, run `body`, and ALWAYS close the pane.
 *
 * The spawn is INSIDE the `try`, so a rejecting spawn, a failing assertion and a normal
 * return all reach the same cleanup. `beginOutput()` is called here rather than by each
 * caller, because every one of them needs it and forgetting it silently takes the
 * fail-open path — which is how these proofs ran for weeks before anyone noticed.
 */
export async function withLiveHerdrChild<T>(
  ref: LiveChildRef,
  argv: string[],
  opts: PtySpawnOpts,
  body: (child: PtyChild) => Promise<T>,
): Promise<T> {
  const host = new HerdrHost()
  try {
    const child = await host.spawn(argv, opts)
    ref.child = child
    // The readiness handshake the production caller performs once its consumers are
    // wired (`spawn.ts`). Its consumers here are the `onScreen` closure, which is built
    // before the spawn, so this is the earliest honest moment.
    child.beginOutput?.()
    return await body(child)
  } finally {
    await closeLiveChild(ref.child)
    ref.child = undefined
  }
}

/**
 * Fail if the live server is holding panes it was not holding before.
 *
 * A MEASUREMENT, NOT A HABIT. "Every suite remembers to clean up" is a claim about
 * people; this is a claim about the server, and it is the only version that survives a
 * fifth live test being added by someone who has not read this file. Reported by pane
 * ID, because a count tells you something leaked and an id tells you what.
 */
export async function expectNoPaneLeak(before: readonly string[]): Promise<string[]> {
  return paneIdsAdded(before, await livePaneIds())
}

/**
 * Register a suite-level assertion that the live server holds no pane it did not hold
 * before — the measurement that replaces trusting the cleanup.
 *
 * CALL IT INSIDE THE OPT-IN `describe`, so it never runs where there is no server. It
 * reports the leaked pane IDs rather than a count, because a count tells you something
 * escaped and an id tells you WHAT — which is the difference between this message and
 * the afternoon that produced this file.
 */
export function registerPaneLeakGuard(label: string): void {
  let before: readonly string[] = []
  beforeAll(async () => {
    before = await livePaneIds()
  })
  afterAll(async () => {
    const leaked = await expectNoPaneLeak(before)
    if (leaked.length > 0) {
      throw new Error(
        `${label}: this suite LEAKED ${leaked.length} herdr pane(s) into the live server — ` +
          `${leaked.join(', ')}. Each is a real process still running in the owner's session. ` +
          `Close them by id with pane.close, then find the spawn that did not go through ` +
          `withLiveHerdrChild().`,
      )
    }
  })
}
