/**
 * pty-host-conformance.test.ts — ONE suite, run against EVERY `PtyHost`.
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
  /** The text the startup screen contains. */
  readonly startup: string
}

const STARTUP = 'Do you trust the files in this folder?'

const herdrBackend: Backend = {
  name: 'HerdrHost (out-of-process pane, polled)',
  startup: STARTUP,
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
}

const bunBackend: Backend = {
  name: 'BunTerminalHost (in-process pty, streamed)',
  startup: STARTUP,
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
