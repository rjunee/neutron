/**
 * pty-host-conformance.test.ts — ONE suite, run against EVERY `PtyHost`.
 *
 * THE RULE FOR EVERY CASE ADDED HERE: **every assertion is unconditional for every host
 * in the table.** A host that legitimately differs declares that difference as its own
 * ASSERTED expectation (see `Backend.alreadyGoneDelivers`), never as a skipped branch.
 * An `if (x.length > 0) expect(...)` cannot fail for the participant that produces
 * nothing, which makes the case two tests wearing one name — and it happened here
 * within two cases of the suite landing. Cheaper to adopt now, at two cases, than later
 * at twenty.
 *
 * WHY THIS FILE EXISTS, stated as the defect that produced it. The readiness gate
 * (`PtyChild.beginOutput`) is part of the SHARED contract: `spawn.ts` cannot assign
 * `scanChild` until `await ptyHost.spawn(...)` returns, and it releases output only
 * after the rest of its wiring completes. `HerdrHost` honoured it. `BunTerminalHost`,
 * restored as a selectable backend, delivered straight from its terminal callback and
 * returned an EMPTY `beginOutput` — so a startup trust or approval prompt could be
 * recorded into a ring with no detector attached, and because the ring is
 * snapshot-replace it is never re-delivered: the keystroke never fires and the REPL
 * waits forever on a dialog nobody saw. That is the wedge class this substrate exists
 * to avoid.
 *
 * NO TEST NOTICED, and the reason is structural rather than an oversight: each backend
 * had its own suite, so a requirement belonging to the INTERFACE was asserted in the
 * place that happened to implement it first. A per-backend suite can only ever prove
 * that one backend does what its own author remembered.
 *
 * SCOPE, deliberately narrow. This is the readiness boundary only — the case the
 * divergence was found on. A full conformance suite over the whole `PtyChild` contract
 * (exit classification, the kill ladder, write ordering, `submitLine`'s acknowledgement)
 * is worth having and is its own item; each of those has backend-specific evidence
 * requirements that would have to be modelled before they could be shared honestly.
 * Adding cases here is the cheap part; agreeing what "the same case" means for two
 * substrates with different observables is not.
 */

import { describe, expect, it } from 'bun:test'
import { HerdrHost } from '../herdr-host.ts'
import { BunTerminalHost } from '../bun-terminal-host.ts'
import { FakeHerdrServer } from './herdr-fake-server.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'

/** Give the event loop several real turns, so an UNGATED implementation has had every
 *  chance to deliver. Without this the "nothing yet" assertion is vacuous for a host
 *  whose producer is asynchronous — it would pass against no gate at all. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Bun.sleep(10)
}

/** Wait until `cond()` holds, or throw. */
async function until(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`until: timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

interface Spawned {
  readonly child: PtyChild
  /** End the child the way its own substrate does — the pane vanishing under herdr, the
   *  process exiting under a pty. Each backend arranges it in its own terms; what the
   *  shared case asserts is what the CONTRACT says afterwards. */
  endChild(): void
}

interface Backend {
  readonly name: string
  /** Spawn a child whose substrate is ALREADY producing the startup screen, so the
   *  window between `spawn()` returning and `beginOutput()` is real on both. */
  spawn(onScreen: (s: string) => void): Promise<Spawned>
  /**
   * Spawn a child that is dead AS EARLY AS THIS SUBSTRATE ALLOWS.
   *
   * ADDED BECAUSE THE FIRST FIXTURE COULD NOT SEE A REAL DIVERGENCE. Both backends
   * above keep the child alive for the whole case, and `BunTerminalHost` released its
   * held screen from the exit handler — so with an ALREADY-RESOLVED `exited`, that
   * callback is queued as a microtask BEFORE the caller's continuation from
   * `await spawn(...)` and `onScreen` fired before the caller held the child. **A shared
   * suite inherits the blind spots of its shared fixture**, which is the same lesson as
   * the pty's non-deterministic buffer, one level up — at the thing meant to catch those.
   *
   * "As early as allowed" differs by substrate and cannot be made identical: a pty can
   * hand back a process that has already exited, while herdr can only discover a
   * vanished pane on a later poll. The shared assertion is therefore about the CONTRACT
   * — nothing is delivered before `beginOutput()` — with a control that the arrangement
   * really did settle the exit, so neither arm passes vacuously.
   */
  spawnAlreadyExiting(onScreen: (s: string) => void): Promise<Spawned>
  /**
   * What THIS substrate must hand over at release, after dying as early as it can.
   *
   * EVERY CONFORMANCE ASSERTION IS UNCONDITIONAL FOR EVERY HOST. A host that
   * legitimately differs declares that difference here as its own asserted expectation,
   * never as a skipped branch — an `if (screens.length > 0)` cannot fail for the host
   * that produces nothing, so a case written that way is two tests wearing one name.
   * This field exists to make the difference a claim rather than an escape.
   */
  readonly alreadyGoneDelivers: {
    /** Exactly this many `onScreen` calls after `beginOutput()`. */
    readonly count: number
    /** Substring the last one must contain, when there is one. */
    readonly contains?: string
    /** Why this substrate delivers that, in its own terms. */
    readonly why: string
  }
  /** The text the startup screen contains. */
  readonly startup: string
}

const STARTUP = 'Do you trust the files in this folder?'

const herdrBackend: Backend = {
  name: 'HerdrHost (out-of-process pane, polled)',
  startup: STARTUP,
  alreadyGoneDelivers: {
    count: 0,
    why:
      'the pane VANISHES taking its output with it. herdr has no raw stream and no ' +
      'retained buffer of its own: the poll loop reads the pane, and a pane that is gone ' +
      'answers pane_not_found. A FAILED read is never delivered as a screen — that is the ' +
      '"a failed read is not an empty screen" rule — so there is genuinely nothing to hand ' +
      'over, and ZERO is the correct asserted outcome rather than an absent one.',
  },
  async spawn(onScreen) {
    const server = new FakeHerdrServer()
    server.screen = STARTUP // on screen BEFORE we spawn — the startup-prompt case
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
      outputGateMaxMs: 60_000, // long, so the FAIL-OPEN timer cannot be what delivers
    })
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {}, onScreen })
    // The pane vanishes; the host learns of it on the next poll.
    return { child, endChild: () => server.exitPane() }
  },
  async spawnAlreadyExiting(onScreen) {
    const server = new FakeHerdrServer()
    server.screen = STARTUP
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
      outputGateMaxMs: 60_000,
    })
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {}, onScreen })
    // The earliest herdr can be dead: the pane is gone before the poll loop's first
    // read, so the very first thing that loop learns is that the child is over.
    server.exitPane()
    return { child, endChild: () => server.exitPane() }
  },
}

const bunBackend: Backend = {
  name: 'BunTerminalHost (in-process pty, streamed)',
  startup: STARTUP,
  alreadyGoneDelivers: {
    count: 1,
    contains: STARTUP,
    why:
      'the pty ACCUMULATED the screen before the process died, and it is the only record ' +
      'of what the child printed — a snapshot-replace ring never re-delivers it. Holding ' +
      'it past the exit is right; losing it would be the other failure.',
  },
  async spawn(onScreen) {
    let endProcess: (code: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      endProcess = res
    })
    const host = new BunTerminalHost({
      // THE PRODUCER FIRES SYNCHRONOUSLY, INSIDE `spawn()`. That is the sharpest form
      // of the window: a pty can deliver bytes before the caller's `await` has even
      // resolved, so a host that forwards straight through cannot be gated by anything
      // the caller does afterwards.
      createTerminal: (o) => {
        const term = {
          write: () => 0,
          resize: () => undefined,
          close: () => undefined,
        }
        o.data?.(term, new TextEncoder().encode(`${STARTUP}\n`))
        return term
      },
      spawn: () => ({
        pid: 4242,
        exited: exitedPromise, // stays alive until the case ends it
        exitCode: null,
        kill: () => undefined,
      }),
      outputGateMaxMs: 60_000,
    })
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {}, onScreen })
    // The process exits; the host is TOLD, rather than discovering it by polling.
    return { child, endChild: () => endProcess(0) }
  },
  async spawnAlreadyExiting(onScreen) {
    const host = new BunTerminalHost({
      createTerminal: (o) => {
        const term = { write: () => 0, resize: () => undefined, close: () => undefined }
        o.data?.(term, new TextEncoder().encode(`${STARTUP}\n`))
        return term
      },
      // ALREADY RESOLVED. This is the arrangement the first fixture refused to model,
      // and it is the one that exposes an exit handler queued ahead of the caller's own
      // continuation from `await spawn(...)`.
      spawn: () => ({ pid: 4243, exited: Promise.resolve(0), exitCode: 0, kill: () => undefined }),
      outputGateMaxMs: 60_000,
    })
    const child = await host.spawn(['claude'], { cwd: '/tmp', env: {}, onScreen })
    return { child, endChild: () => undefined }
  },
}

const BACKENDS: readonly Backend[] = [herdrBackend, bunBackend]

describe('PtyHost conformance — the readiness gate', () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it('delivers NO screen before beginOutput(), and then delivers the one it held', async () => {
        const screens: string[] = []
        const { child } = await backend.spawn((s) => screens.push(s))
        // The window the contract is about: `spawn()` has returned and the caller has
        // not finished wiring. An ungated host has already called `onScreen` by now.
        await settle()
        expect(screens).toEqual([])

        child.beginOutput?.()

        // NOT LOST, ONLY HELD. The startup screen was produced before the gate opened,
        // and a snapshot-replace ring never re-delivers an unchanged screen — so a host
        // that DROPS what it held is as broken as one that delivers too early, just
        // silently instead of racily.
        await settle()
        expect(screens.length).toBeGreaterThan(0)
        expect(screens.some((s) => s.includes(backend.startup))).toBe(true)
        child.kill()
      })

      it('beginOutput() is idempotent — a second call delivers nothing extra', async () => {
        const screens: string[] = []
        const { child } = await backend.spawn((s) => screens.push(s))
        child.beginOutput?.()
        await settle()
        const afterFirst = screens.length
        child.beginOutput?.()
        child.beginOutput?.()
        await settle()
        // A second release that re-delivered the held screen would re-arm a detector on
        // a screen the consumer has already seen.
        expect(screens.length).toBe(afterFirst)
        child.kill()
      })
    })
  }

  for (const backend of BACKENDS) {
    describe(`${backend.name} — submitLine after exit`, () => {
      it('REJECTS rather than resolving, so no caller can report a command it did not send', async () => {
        // THE ACKNOWLEDGED SEAM'S WHOLE POINT, and it belongs to the INTERFACE rather
        // than to either substrate: `submitCommand` refuses a child without
        // `submitLine` precisely because a caller REPORTS an outcome from it. "The
        // child is already gone" is a way the command was not submitted, so it has to
        // reach that caller — resolving quietly records a context reset that never
        // happened, which is the defect the method exists for.
        //
        // NON-VACUOUS ON BOTH, by different mechanisms: herdr learns of the exit by
        // POLLING a vanished pane, the pty is TOLD by its process. The case asserts
        // what the contract says afterwards, not how each found out.
        const { child, endChild } = await backend.spawn(() => undefined)
        child.beginOutput?.()
        endChild()
        await until(() => child.hasExited(), `${backend.name}: the exit`)
        const outcome = await child.submitLine!('/clear').then(
          () => 'RESOLVED — a command that was never sent, reported as sent',
          (e: unknown) => (e as Error).message,
        )
        expect(outcome).toContain('after exit')
      })
    })
  }

  for (const backend of BACKENDS) {
    describe(`${backend.name} — a child that is already gone`, () => {
      it('still delivers NOTHING before beginOutput(), and its last screen after', async () => {
        const screens: string[] = []
        const { child } = await backend.spawnAlreadyExiting((s) => screens.push(s))
        await settle()
        // THE CONTRACT. Recording that the child is gone is not the same act as
        // delivering its screen, and a host that conflates them delivers to a consumer
        // the caller has not wired yet — worst in exactly this case, since a child that
        // dies instantly is the one whose output most needs a detector already attached.
        expect(screens).toEqual([])

        child.beginOutput?.()
        await settle()
        // POSITIVE CONTROL, AND IT HAS TO BE TAKEN HERE RATHER THAN ABOVE. The two
        // substrates reach "already gone" at genuinely different moments and the
        // difference is the gate doing its job: the pty hands back a process that has
        // ALREADY exited, so its child is settled before this line; herdr discovers a
        // vanished pane only by POLLING, and the poll loop is itself held behind the
        // gate — so it cannot know the child is gone until the gate opens. Asserting
        // before the release would have been asserting that herdr breaks its own gate.
        expect(`${backend.name} exited: ${String(child.hasExited())}`).toBe(
          `${backend.name} exited: true`,
        )
        // UNCONDITIONAL, INCLUDING THE ZERO. This assertion was written
        // `if (screens.length > 0) …`, which cannot fail for the host that produces
        // nothing — so herdr had no asserted post-release outcome at all and a case
        // meant to hold both hosts to one contract held one. Each host now DECLARES
        // what it must hand over and is held to exactly that; the reason is carried in
        // the failure message, because the interesting half of a conformance failure is
        // which participant broke which promise.
        const expected = backend.alreadyGoneDelivers
        expect(`${backend.name}: ${screens.length} screen(s) — ${expected.why}`).toBe(
          `${backend.name}: ${expected.count} screen(s) — ${expected.why}`,
        )
        if (expected.contains !== undefined) {
          expect(screens[screens.length - 1]).toContain(expected.contains)
        }
      })
    })
  }

  it('CONTROL — the suite really runs against BOTH hosts, not one twice', () => {
    // Without this, a mistake in the table (the same backend listed twice, or one
    // silently dropped) would leave a "conformance" suite conforming one implementation
    // to itself — which is exactly the shape that let the gate diverge in the first place.
    expect(BACKENDS.length).toBe(2)
    expect(new Set(BACKENDS.map((b) => b.name)).size).toBe(2)
    const hosts: PtyHost[] = [new HerdrHost({}), new BunTerminalHost()]
    expect(hosts.every((h) => typeof h.spawn === 'function')).toBe(true)
  })
})
