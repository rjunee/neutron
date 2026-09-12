/**
 * herdr-snapshot-ring.test.ts — the polling bridge that stands in for a raw output
 * stream, and the three things it has to get right.
 *
 * THE DEFECT THESE ARE WRITTEN AGAINST. A polling bridge that returns the right
 * text for a steady screen tells you nothing: almost any implementation does that.
 * So every case here VARIES THE PANE — cleared, changing faster than the poll,
 * gone mid-read — and asserts that the result changes with it.
 *
 * Case by case, "what would a wrong implementation get right?":
 *  • Fires on every tick instead of on change: gets the screen TEXT right always,
 *    and breaks the idle gate. Caught by counting deliveries on a steady pane.
 *  • `try { read } catch { deliver('') }`: gets a steady pane and a cleared pane
 *    right, and erases a dead REPL's last output. Caught by the pair of cases that
 *    distinguish a FAILED read from a SUCCESSFUL empty one — either case alone is
 *    satisfied by the wrong implementation.
 *  • Appends instead of replaces: gets a growing pane right and never drops a
 *    detector latch. Caught by the falling-edge case.
 */

import { describe, expect, it } from 'bun:test'
import { HerdrHost } from '../herdr-host.ts'
import { PtyRing } from '../pty-ring.ts'
import { OutputScanner } from '../output-scan.ts'
import { FakeHerdrServer, until } from './herdr-fake-server.ts'
import { terminateChild } from '../repl-session.ts'
import type { PtyChild } from '../pty-host.ts'

/** Spawn against a fake server with a fast poll, collecting delivered screens. */
async function spawnWithFake(
  server: FakeHerdrServer,
  pollIntervalMs = 5,
): Promise<{ child: PtyChild; screens: string[]; exits: (number | null)[] }> {
  const screens: string[] = []
  const exits: (number | null)[] = []
  const host = new HerdrHost({
    connect: async () => server,
    pollIntervalMs,
    sleep: (ms) => Bun.sleep(ms),
    workspaceId: 'w9',
  })
  const child = await host.spawn(['claude', '--session-id', 's1'], {
    cwd: '/tmp',
    env: { PATH: '/usr/bin', DROP_ME: undefined },
    onScreen: (s) => screens.push(s),
    onExit: (c) => exits.push(c),
  })
  // Release the output gate, exactly as the production caller does after wiring its
  // consumer (`spawn.ts`). Until this the host does not poll at all.
  child.beginOutput?.()
  return { child, screens, exits }
}

describe('herdr bridge — deliver only on CHANGE', () => {
  it('a STEADY screen is delivered once, no matter how many times it is polled', async () => {
    const server = new FakeHerdrServer()
    server.screen = 'idle at the prompt'
    const { child, screens } = await spawnWithFake(server)
    await until(() => screens.length >= 1, 'first screen')
    // Let many polls go by with the screen unchanged.
    await until(() => server.callsTo('pane.read').length >= 8, 'several polls')
    child.kill()
    // THE ASSERTION THAT MATTERS: polls ≫ deliveries. If `onScreen` fired per poll,
    // `lastDataAt` would never go stale and `waitForReplIdle`'s 900 ms quiet window
    // could never be satisfied, so every prompt inject would wait out the cap.
    expect(server.callsTo('pane.read').length).toBeGreaterThanOrEqual(8)
    expect(screens).toEqual(['idle at the prompt'])
  })

  it('a pane changing on every poll is delivered on every change', async () => {
    const server = new FakeHerdrServer()
    server.screen = 'tick 0'
    const { child, screens } = await spawnWithFake(server)
    await until(() => screens.length >= 1, 'first screen')
    for (let i = 1; i <= 5; i++) {
      server.screen = `tick ${i}`
      await until(() => screens.includes(`tick ${i}`), `tick ${i}`)
    }
    child.kill()
    expect(screens).toEqual(['tick 0', 'tick 1', 'tick 2', 'tick 3', 'tick 4', 'tick 5'])
  })

  it('a screen that changes and changes BACK is delivered each time', async () => {
    // The change filter compares against the LAST delivered screen, not against a
    // set of everything seen — a spinner alternating between two frames is real
    // activity and must keep the idle clock alive.
    const server = new FakeHerdrServer()
    server.screen = 'A'
    const { child, screens } = await spawnWithFake(server)
    await until(() => screens.length >= 1, 'A')
    server.screen = 'B'
    await until(() => screens.length >= 2, 'B')
    server.screen = 'A'
    await until(() => screens.length >= 3, 'A again')
    child.kill()
    expect(screens.slice(0, 3)).toEqual(['A', 'B', 'A'])
  })
})

describe('herdr bridge — a failed read is NOT an empty screen', () => {
  it('a SUCCESSFUL empty read IS delivered — a cleared pane must reach the ring', async () => {
    const server = new FakeHerdrServer()
    server.screen = '❯ 1. Yes\n  2. No'
    const { child, screens } = await spawnWithFake(server)
    await until(() => screens.length >= 1, 'menu')
    server.screen = '' // the pane was cleared; the read still succeeds
    await until(() => screens.includes(''), 'cleared screen delivered')
    child.kill()
    expect(screens).toContain('')
  })

  it('a FAILED read is dropped — the ring keeps a dead REPL\'s last output', async () => {
    // A pane VANISHES on exit, taking its output with it, so the ring is the only
    // record of what the REPL last printed. This is the case that separates a real
    // implementation from `try { read } catch { deliver('') }`, which the case above
    // would also satisfy.
    const server = new FakeHerdrServer()
    const ring = new PtyRing()
    const screens: string[] = []
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })
    server.screen = 'FINAL WORDS before the crash'
    const child = await host.spawn(['claude'], {
      cwd: '/tmp',
      env: {},
      onScreen: (s) => {
        screens.push(s)
        ring.replace(s)
      },
    })
    child.beginOutput?.()
    await until(() => ring.text().includes('FINAL WORDS'), 'last output in the ring')

    // The pane dies. Deliberately WITHOUT a `pane_exited` event: the event would
    // settle the child before the next poll and mask the error path, so the test
    // would then be pinning the event rather than the read handling it claims to.
    // Reads fail and herdr forgets the pane — the shape a vanished pane presents.
    server.readFails = true
    server.paneGone = true
    expect(await child.exited).toBeNull()

    // The record SURVIVED. An implementation that delivered '' on a read error
    // would have wiped it here — and would look correct on every other case.
    expect(ring.text()).toBe('FINAL WORDS before the crash')
    expect(screens.at(-1)).toBe('FINAL WORDS before the crash')
    expect(screens).not.toContain('')
  })

  it('a run of failing reads with the pane still present does NOT deliver anything', async () => {
    const server = new FakeHerdrServer()
    server.screen = 'still here'
    const { child, screens } = await spawnWithFake(server)
    await until(() => screens.length >= 1, 'first screen')
    // Reads fail, but `pane.get` still answers — the pane is alive, just unreadable.
    server.readFails = true
    await until(() => server.callsTo('pane.read').length >= 6, 'several failed reads')
    expect(screens).toEqual(['still here'])
    expect(child.hasExited()).toBe(false)
    child.kill()
  })

  it('failing reads AND a vanished pane settle the child as exited', async () => {
    const server = new FakeHerdrServer()
    server.screen = 'x'
    const { child, exits } = await spawnWithFake(server)
    await until(() => server.callsTo('pane.read').length >= 1, 'first poll')
    // No `pane_exited` event at all — only the pane ceasing to exist. The loop must
    // still conclude, or a dead REPL is supervised forever as if it were alive.
    server.readFails = true
    server.paneGone = true
    expect(await child.exited).toBeNull()
    expect(child.hasExited()).toBe(true)
    expect(exits).toEqual([null])
  })
})

describe('a failed question is not a negative answer', () => {
  it('a TRANSIENT rpc failure does NOT settle the child as vanished', async () => {
    // THE DEFECT. `paneIsGone` returned true for EVERY `pane.get` rejection, so a
    // timeout or a temporary server error was read as proof the pane had gone — a
    // live REPL recycled and stamped `'pane-vanished'`, a claim nothing observed.
    // A rejection measures the CALL, not the pane.
    const server = new FakeHerdrServer()
    server.screen = 'still alive'
    const { child, exits } = await spawnWithFake(server)
    await until(() => server.callsTo('pane.read').length >= 1, 'first poll')

    // Both `pane.read` and `pane.get` now fail — untyped, i.e. the question failed.
    server.transientFailure = true
    await until(() => server.callsTo('pane.get').length >= 2, 'several failed questions')

    expect(child.hasExited()).toBe(false)
    expect(child.exitCause?.()).toBeUndefined()
    expect(exits).toEqual([])
    child.kill()
  })

  it('it RECOVERS when the transient failure clears — nothing was concluded', async () => {
    const server = new FakeHerdrServer()
    server.screen = 'before'
    const { child, screens } = await spawnWithFake(server)
    await until(() => screens.includes('before'), 'before')
    server.transientFailure = true
    await until(() => server.callsTo('pane.get').length >= 2, 'failures')
    server.transientFailure = false
    server.screen = 'after'
    await until(() => screens.includes('after'), 'recovered')
    expect(child.hasExited()).toBe(false)
    child.kill()
  })

  it('CONTROL — a TYPED pane_not_found IS proof, and does settle', async () => {
    // The other direction: strictness must not make the definite case undecidable.
    const server = new FakeHerdrServer()
    server.screen = 'x'
    const { child } = await spawnWithFake(server)
    await until(() => server.callsTo('pane.read').length >= 1, 'first poll')
    server.readFails = true
    server.paneGone = true // now the errors carry `pane_not_found`
    expect(await child.exited).toBeNull()
    expect(child.exitCause?.()).toBe('pane-vanished')
  })
})

describe('herdr bridge — a pane that ends is discovered by POLLING', () => {
  // THE TRANSPORT-LOSS BRANCH IS GONE, along with the four tests that covered it.
  // They described a long-lived socket that could die mid-session — and the server
  // answers one request per connection, so a connection ending is how EVERY exchange
  // ends, not an event. There is nothing left to lose and nothing to reconnect: each
  // call opens its own connection, and a pane's end arrives as `pane_not_found` on the
  // next poll. The `pane_exited` subscription went with it, for the same reason.

  it('the two routes keep their own causes — a constant would collapse them', async () => {
    // TWO, not four. `pane-exited` (a subscription event) and `transport-lost` (a
    // long-lived socket closing) are deleted: neither mechanism exists on a transport
    // that answers one request per connection. A process that ends on its own is now
    // discovered exactly as a vanished pane is, because it IS one.
    const a = new FakeHerdrServer({ paneId: 'w9:pA' })
    const ca = (await spawnWithFake(a)).child
    a.exitPane() // the process ends; nothing is announced
    await ca.exited
    expect(ca.exitCause?.()).toBe('pane-vanished')

    const b = new FakeHerdrServer({ paneId: 'w9:pB' })
    const cb = (await spawnWithFake(b)).child
    cb.kill()
    await cb.exited
    expect(cb.exitCause?.()).toBe('closed-by-us')

    const c = new FakeHerdrServer({ paneId: 'w9:pC' })
    const cc = (await spawnWithFake(c)).child
    await until(() => c.callsTo('pane.read').length >= 1, 'first poll')
    c.readFails = true
    c.paneGone = true
    await cc.exited
    expect(cc.exitCause?.()).toBe('pane-vanished')

    // The two survivors stay distinct, and the self-exit route agrees with the
    // vanished route because they are the same observation.
    expect(new Set([ca.exitCause?.(), cb.exitCause?.(), cc.exitCause?.()]).size).toBe(2)
  })

  it('a FAILED pane.close settles NOTHING and latches NOTHING — the pane is still there', async () => {
    // THE DEFECT. `kill` settled from `.finally()`, so a REJECTED `pane.close` still
    // resolved `exited`, flipped `hasExited()` and reported `exitCause`
    // 'closed-by-us'. A live REPL, recorded as cleanly terminated.
    //
    // What would a wrong implementation get right? One that settles unconditionally
    // passes every existing kill test, because they all use a fake that cannot
    // refuse. That is why the fake grew `failMethod`.
    const server = new FakeHerdrServer({ paneId: 'w9:pFail' })
    const { child } = await spawnWithFake(server)
    server.failMethod('pane.close', new Error('pane.close refused'))
    child.kill()
    await until(() => server.callsTo('pane.close').length >= 1, 'close attempted')
    // Give the rejection every chance to settle something.
    await Bun.sleep(30)

    const sentinel = Symbol('unsettled')
    const raced = await Promise.race([child.exited, Bun.sleep(30).then(() => sentinel)])
    expect(raced).toBe(sentinel) // `exited` did NOT resolve
    expect(child.hasExited()).toBe(false)
    expect(child.exitCause?.()).toBeUndefined()
    // AND THE FLAG DID NOT LATCH. With no exit codes anywhere in herdr,
    // `wasKilledByUs` is the whole crash-vs-recycle discriminator (`spawn.ts`): a
    // latch here would make every LATER real crash on this still-living child read
    // as an intentional recycle, for the rest of its life.
    expect(child.wasKilledByUs?.()).toBe(false)
  })

  it('the failed close RE-ARMS the escalation — terminateChild retries and the pane really closes', async () => {
    // The consequence the case above only implies. `terminateChild` returns early at
    // BOTH of its `child.hasExited()` guards (`repl-session.ts`), so a false
    // settlement does not merely misreport — it DISARMS the SIGKILL retry and leaks
    // the process. Not settling is what makes the ladder run its second rung, which
    // is the bounded retry.
    const server = new FakeHerdrServer({ paneId: 'w9:pRetry' })
    const { child } = await spawnWithFake(server)
    server.failMethod('pane.close', new Error('pane.close refused'))
    const done = terminateChild(child)
    await until(() => server.callsTo('pane.close').length >= 1, 'first attempt')
    // The transient clears, as a retry presupposes.
    server.clearFailure('pane.close')
    await done
    // TWO attempts, and the pane is gone. Pinning the count is the point: settling on
    // the first (failed) one yields exactly one call and a child that claims to have
    // exited — which is the bug.
    expect(server.callsTo('pane.close').length).toBe(2)
    expect(server.paneClosed).toBe(true)
    expect(child.hasExited()).toBe(true)
    expect(child.wasKilledByUs?.()).toBe(true)
    expect(child.exitCause?.()).toBe('closed-by-us')
  }, 10_000)

  it('CONTROL — a close that SUCCEEDS settles and latches, so the pair is discriminating', async () => {
    const server = new FakeHerdrServer({ paneId: 'w9:pOk' })
    const { child } = await spawnWithFake(server)
    child.kill()
    await child.exited
    expect(child.hasExited()).toBe(true)
    expect(child.exitCause?.()).toBe('closed-by-us')
    expect(child.wasKilledByUs?.()).toBe(true)
    expect(server.paneClosed).toBe(true)
  })

  it('a pane vanishing while OUR close is in flight still reads as intentional', async () => {
    // The window the terminating flag exists for. Between asking for the close and its
    // acknowledgement the pane can disappear — of our own close, or because the process
    // ended at that moment — and the poll discovers it. Classifying that as a crash
    // would respawn-and-report a session we deliberately ended.
    const server = new FakeHerdrServer({ paneId: 'w9:pRace' })
    const { child } = await spawnWithFake(server)
    const releaseClose = server.holdMethod('pane.close') // close genuinely IN FLIGHT
    child.kill()
    await until(() => server.callsTo('pane.close').length >= 1, 'close in flight')
    expect(child.hasExited()).toBe(false) // still unacknowledged
    server.exitPane() // the pane is gone; the next poll will see it
    await child.exited
    expect(child.wasKilledByUs?.()).toBe(true)
    releaseClose()
  })

  it('CONTROL for the race — a pane vanishing with NO kill in flight is a crash', async () => {
    // Without this, the flag could simply be `true` and the case above passes.
    const server = new FakeHerdrServer({ paneId: 'w9:pCrash' })
    const { child } = await spawnWithFake(server)
    server.exitPane()
    await child.exited
    expect(child.wasKilledByUs?.()).toBe(false)
    expect(child.exitCause?.()).toBe('pane-vanished')
  })

  it('an ASSUMED viewport says so — a guess must not look like a measurement', async () => {
    // `viewportRows ?? 120` produces a value indistinguishable from a pane that
    // really is 120 rows, so "could not read the geometry" and "the geometry is 120"
    // were one state. The consequence is silent and positional: on a taller pane
    // every read comes back short and detectors see less than they are written for.
    const errs: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((c: unknown): boolean => {
      errs.push(String(c))
      return true
    }) as typeof process.stderr.write
    try {
      const server = new FakeHerdrServer({ paneId: 'w9:pGuess' })
      server.viewportRows = null // pane.get answers with no scroll geometry
      const { child, screens } = await spawnWithFake(server)
      await until(() => screens.length >= 1, 'first screen')
      await until(() => server.callsTo('pane.read').length >= 3, 'several polls')
      child.kill()
    } finally {
      process.stderr.write = realWrite
    }
    const said = errs.filter((e) => e.includes('ASSUMING'))
    // Said, and said ONCE — a per-poll warning at 5ms would bury the log it is
    // supposed to inform.
    expect(said.length).toBe(1)
    expect(said[0]).toContain('could not read viewport_rows')
  })

  it('CONTROL — a MEASURED viewport says nothing, so the warning carries information', async () => {
    // Without this, the assertion above is satisfied by warning unconditionally,
    // which tells a reader nothing about whether the geometry was read.
    const errs: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((c: unknown): boolean => {
      errs.push(String(c))
      return true
    }) as typeof process.stderr.write
    try {
      const server = new FakeHerdrServer({ paneId: 'w9:pMeasured' })
      server.viewportRows = 120 // the SAME number the fallback would have guessed
      const { child, screens } = await spawnWithFake(server)
      await until(() => screens.length >= 1, 'first screen')
      await until(() => server.callsTo('pane.read').length >= 3, 'several polls')
      child.kill()
    } finally {
      process.stderr.write = realWrite
    }
    // 120 measured must be distinguishable from 120 assumed — that is the entire
    // point, and picking the fallback's own value is what makes the pair sharp.
    expect(errs.filter((e) => e.includes('ASSUMING'))).toEqual([])
  })

  it('a SUCCESSFUL read with an unusable payload delivers nothing, and says so', async () => {
    // Neither an error nor an answer. Leaving the screen undefined is right — an
    // unknown must not be delivered as an empty screen — but doing it silently makes
    // a drifted reply shape look exactly like a permanently idle REPL.
    const errs: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((c: unknown): boolean => {
      errs.push(String(c))
      return true
    }) as typeof process.stderr.write
    let delivered: string[] = []
    try {
      const server = new FakeHerdrServer({ paneId: 'w9:pMalformed' })
      server.malformMethod('pane.read', { read: { pane_id: 'w9:pMalformed', text: 42 } })
      const { child, screens } = await spawnWithFake(server)
      await until(() => server.callsTo('pane.read').length >= 3, 'several polls')
      delivered = screens
      child.kill()
    } finally {
      process.stderr.write = realWrite
    }
    // NOTHING delivered — not an empty screen, which would erase a dead REPL's last
    // output from the ring and drop a detector latch.
    expect(delivered).toEqual([])
    const said = errs.filter((e) => e.includes('no usable text'))
    expect(said.length).toBe(1)
    expect(said[0]).toContain('text:number')
  })

  it('CONTROL — the malformed read RECOVERS when the payload becomes usable', async () => {
    // Proves the malformed branch is a skip and not a latch: a client that gave up
    // after one bad payload would pass the case above and never poll again.
    const server = new FakeHerdrServer({ paneId: 'w9:pRecover' })
    server.malformMethod('pane.read', { read: { pane_id: 'w9:pRecover', text: null } })
    const { child, screens } = await spawnWithFake(server)
    await until(() => server.callsTo('pane.read').length >= 2, 'bad polls')
    expect(screens).toEqual([])
    server.clearMalformed('pane.read')
    server.screen = 'back at the prompt'
    await until(() => screens.length >= 1, 'recovered screen')
    expect(screens.at(-1)).toBe('back at the prompt')
    child.kill()
  })

  it('exitCause is undefined while the child is alive — it never guesses', async () => {
    const server = new FakeHerdrServer()
    server.screen = 'alive'
    const { child } = await spawnWithFake(server)
    expect(child.exitCause?.()).toBeUndefined()
    child.kill()
  })
})

describe('the producer does not start before its consumer can exist', () => {
  it('NO screen is delivered until beginOutput() releases the gate', async () => {
    // `spawn` is async, so the caller cannot wire the consumer until it resolves. A
    // host that polls before returning can deliver the FIRST screen to a consumer
    // that cannot act on it — and snapshot-replace never re-delivers an unchanged
    // screen, so it is lost for the life of the child.
    const server = new FakeHerdrServer()
    server.screen = 'first screen'
    const screens: string[] = []
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })
    const child = await host.spawn(['claude'], {
      cwd: '/tmp',
      env: {},
      onScreen: (sc) => screens.push(sc),
    })
    // The host has not even READ yet: polling at all would mutate the ring and stamp
    // `lastDataAt` behind a consumer that is not ready.
    await Bun.sleep(40)
    expect(screens).toEqual([])
    expect(server.callsTo('pane.read')).toEqual([])

    child.beginOutput?.()
    await until(() => screens.length >= 1, 'the first screen, after the gate')
    // AND IT IS THE FIRST SCREEN — not a later one that happened to differ.
    expect(screens[0]).toBe('first screen')
    child.kill()
  })

  it('A FIRST SCREEN CARRYING A DETECTOR SIGNATURE IS SCANNED', async () => {
    // The case the old tests could not construct, because they attached the scanner
    // before anything was delivered. Here the scanner is wired AFTER `spawn` resolves
    // — exactly as `spawn.ts` does — and the pane's very first screen already holds a
    // trust prompt. Before the gate this screen arrived unscanned and, being
    // unchanged thereafter, was never delivered again: a REPL alive and polling,
    // waiting forever on a prompt nobody saw.
    const server = new FakeHerdrServer()
    server.screen = 'Do you trust the files in this folder?\n❯ 1. Yes\n  2. No'
    const ring = new PtyRing()
    const scanner = new OutputScanner()
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })
    const fired: string[] = []
    const child = await host.spawn(['claude'], {
      cwd: '/tmp',
      env: {},
      onScreen: (sc) => {
        ring.replace(sc)
        for (const f of scanner.scan(ring.text(), Date.now())) fired.push(f.id)
      },
    })
    // Wiring happens HERE — after the await, which is the only place it can. The
    // deliberate sleep WIDENS the window on purpose: `spawn.ts` wires synchronously
    // after its await, so with an immediately-resolving fake the race is tight enough
    // that a test without this passes even when the gate is removed (mutation M58
    // reddened only one case until this was added). A caller doing any async work
    // before wiring is the realistic worst case, and it is the requirement — not the
    // narrowness of one caller's window — that has to be pinned.
    await Bun.sleep(30)
    scanner.register({ id: 'trust', bottomN: 24, present: (ctx) => /❯1\.Yes/.test(ctx.normalized) })
    child.beginOutput?.()

    await until(() => fired.includes('trust'), 'the first screen was scanned')
    expect(fired).toEqual(['trust'])
    child.kill()
  })

  it('the gate FAILS OPEN, loudly — a forgotten call delivers late, never never', async () => {
    // Withholding output forever is worse than delivering it late: a REPL whose
    // screens never reach the detectors is wedged silently and looks idle. So the
    // gate is an ordering device, not a permission.
    const errs: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((c: unknown): boolean => {
      errs.push(String(c))
      return true
    }) as typeof process.stderr.write
    const server = new FakeHerdrServer()
    server.screen = 'eventually'
    const screens: string[] = []
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
      outputGateMaxMs: 30, // the production bound is 5s
    })
    const child = await host.spawn(['claude'], {
      cwd: '/tmp',
      env: {},
      onScreen: (sc) => screens.push(sc),
    })
    // beginOutput() is DELIBERATELY not called.
    await until(() => screens.includes('eventually'), 'released by the fail-open timer')
    child.kill()
    process.stderr.write = realWrite

    // ...AND *LOUDLY*, WHICH IS HALF THE CRITERION AND WAS THE HALF NOT ASSERTED.
    // "The screen arrived" is IMPLIED BY failing open and says nothing at all about
    // loudly: silence the warning and the old test stayed green, against both its own
    // name and the spec. An assertion that is a PROXY for the criterion is not the
    // criterion — and half a compound criterion asserted is a criterion not asserted.
    const warned = errs.filter((e) => e.includes('beginOutput() was not called'))
    expect(warned.length).toBe(1) // exactly one: a per-poll warning would bury the log
    // Actionable: it must name the caller's bug and the consequence, or it is noise
    // that happens to match a substring.
    expect(warned[0]).toContain('WIRING BUG')
    expect(warned[0]).toContain('snapshot-replace')
  })

  it('CONTROL — a TIMELY beginOutput() warns not at all', async () => {
    // Without this, "warns exactly once" is satisfied by warning on every spawn, which
    // would make the diagnostic worthless precisely when it is true.
    const errs: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((c: unknown): boolean => {
      errs.push(String(c))
      return true
    }) as typeof process.stderr.write
    try {
      const server = new FakeHerdrServer({ paneId: 'w9:pTimely' })
      server.screen = 'promptly'
      const screens: string[] = []
      const host = new HerdrHost({
        connect: async () => server,
        pollIntervalMs: 5,
        sleep: (ms) => Bun.sleep(ms),
        workspaceId: 'w9',
        outputGateMaxMs: 30,
      })
      const child = await host.spawn(['claude'], {
        cwd: '/tmp',
        env: {},
        onScreen: (sc) => screens.push(sc),
      })
      child.beginOutput?.() // the caller does its job
      await until(() => screens.includes('promptly'), 'released by the caller')
      // Outlast the fail-open timer: the warning must not arrive late either.
      await Bun.sleep(60)
      child.kill()
    } finally {
      process.stderr.write = realWrite
    }
    expect(errs.filter((e) => e.includes('beginOutput() was not called'))).toEqual([])
  })

  it('beginOutput() is idempotent', async () => {
    const server = new FakeHerdrServer()
    server.screen = 'x'
    const { child } = await spawnWithFake(server) // already released once
    expect(() => {
      child.beginOutput?.()
      child.beginOutput?.()
    }).not.toThrow()
    child.kill()
  })
})

describe('herdr bridge — the detector falling edge', () => {
  it('a cleared pane drops a latched detector, which diff-append could not do', async () => {
    // The invariant snapshot-replace was chosen FOR. `OutputScanner` clears a
    // detector's latch when `present` goes false; a cleared menu appends nothing, so
    // under diff-append `present` would stay true forever and the detector would be
    // a one-shot for the life of the session.
    const server = new FakeHerdrServer()
    const ring = new PtyRing()
    const scanner = new OutputScanner()
    // `ctx.normalized` has ALL whitespace stripped (`normalizePtyText`), so the
    // signature is contiguous — the same shape the real detectors use
    // (`TOOL_USE_SELECTOR_RE` is `/❯1\.yes/i`).
    scanner.register({ id: 'menu', bottomN: 24, present: (ctx) => /❯1\.Yes/.test(ctx.normalized) })

    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })
    server.screen = 'doing work'
    const child = await host.spawn(['claude'], {
      cwd: '/tmp',
      env: {},
      onScreen: (s) => ring.replace(s),
    })
    child.beginOutput?.()
    await until(() => ring.text() === 'doing work', 'initial screen')
    expect(scanner.scan(ring.text(), 1000).map((f) => f.id)).toEqual([])

    // The menu renders → rising edge fires.
    server.screen = 'Do you want to proceed?\n❯ 1. Yes\n  2. No'
    await until(() => ring.text().includes('1. Yes'), 'menu on screen')
    expect(scanner.scan(ring.text(), 2000).map((f) => f.id)).toEqual(['menu'])
    // Still present → latched, does not re-fire.
    expect(scanner.scan(ring.text(), 3000).map((f) => f.id)).toEqual([])

    // The menu is dismissed and the pane repaints WITHOUT it.
    server.screen = 'proceeding with the work'
    await until(() => !ring.text().includes('1. Yes'), 'menu cleared')
    // The falling edge: `present` is false, so the latch drops.
    expect(scanner.scan(ring.text(), 4000).map((f) => f.id)).toEqual([])

    // A SECOND menu can therefore fire again — the whole point.
    server.screen = 'Another question?\n❯ 1. Yes\n  2. No'
    await until(() => ring.text().includes('1. Yes'), 'second menu')
    expect(scanner.scan(ring.text(), 5000).map((f) => f.id)).toEqual(['menu'])

    child.kill()
  })
})

describe('herdr bridge — spawn refuses what it cannot supervise', () => {
  it('spawns via layout.apply with the argv as `command`, and reads the pane id BACK', async () => {
    const server = new FakeHerdrServer({ paneId: 'w9:pZZ' })
    const { child } = await spawnWithFake(server)
    const apply = server.callsTo('layout.apply')[0]!
    const root = apply.params['root'] as Record<string, unknown>
    expect(root['type']).toBe('pane')
    // The argv is EXEC'd as a command, not shell-quoted and typed into a shell,
    // which is what `agent.start` would have done.
    expect(root['command']).toEqual(['claude', '--session-id', 's1'])
    expect(root['cwd']).toBe('/tmp')
    // `undefined` env values are DROPPED (the auth-scrub contract).
    expect(root['env']).toEqual({ PATH: '/usr/bin' })
    expect(apply.params['focus']).toBe(false) // never steal the owner's focus
    // The id came from the REPLY. `layout.apply` mints new ids, so a host that
    // assumed the tab/pane it asked for would be driving the wrong pane. The read is
    // awaited rather than assumed: polling starts only once the output gate opens.
    await until(() => server.callsTo('pane.read').length >= 1, 'a read')
    expect(server.callsTo('pane.read')[0]!.params['pane_id']).toBe('w9:pZZ')
    child.kill()
  })

  it('REFUSES the spawn when herdr never reports a pid, rather than inventing one', async () => {
    // `pid` is load-bearing above the host: supervision probes it with
    // `process.kill(pid, 0)` and the crashed-agent registry keys on `(name, pid)`.
    // A placeholder would make every liveness probe answer about the wrong process.
    const server = new FakeHerdrServer({ shellPid: null })
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      // Collapse the pid wait so the test does not sit out the real 5 s bound. A
      // 1 ms sleep rather than a no-op: a zero-cost `await` never yields to a
      // macrotask, so a no-op would starve the event loop instead of running fast.
      sleep: (ms) => Bun.sleep(Math.min(ms, 1)),
      pidWaitMs: 20,
      workspaceId: 'w9',
    })
    const err = await host
      .spawn(['claude'], { cwd: '/tmp', env: {} })
      .then(() => undefined, (e: unknown) => e as Error)
    expect(err).toBeDefined()
    expect(err!.message).toContain('never reported a pid')
    // And it hung up rather than leaking the connection.
    // NO CONNECTION TO CLOSE. The old assertion required the spawn's long-lived socket
    // to be closed on the failure path; with a connection per call there is none to
    // leak, so what remains to assert is the pane cleanup above.
  })

  it('reports the pid herdr gave, which for a layout.apply pane is the argv\'s own', async () => {
    const server = new FakeHerdrServer({ shellPid: 90210 })
    const { child } = await spawnWithFake(server)
    expect(child.pid).toBe(90210)
    child.kill()
  })

  it('CLOSES THE PANE when the pid never arrives — no orphan left running', async () => {
    // THE OBLIGATION STARTS AT `layout.apply`, NOT AT A SUCCESSFUL SPAWN. The pane,
    // and the `claude` process inside it, exists the moment that call returns. An
    // init failure after that point used to close only the CONNECTION, so the caller
    // got a rejected spawn while the process kept running unmanaged — and nothing
    // held a record of it, because the pool never learned about a spawn that failed.
    const server = new FakeHerdrServer({ shellPid: null })
    const host = new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 5,
      sleep: (ms) => Bun.sleep(Math.min(ms, 1)),
      pidWaitMs: 20,
      workspaceId: 'w9',
    })
    await host.spawn(['claude'], { cwd: '/tmp', env: {} }).then(
      () => undefined,
      () => undefined,
    )
    const closes = server.callsTo('pane.close')
    expect(closes.length).toBe(1)
    expect(closes[0]!.params['pane_id']).toBe(server.paneId)
    // NO CONNECTION TO CLOSE. The old assertion required the spawn's long-lived socket
    // to be closed on the failure path; with a connection per call there is none to
    // leak, so what remains to assert is the pane cleanup above.
  })

  // DELETED: 'CLOSES THE PANE when the exit subscription fails'. It covered the second
  // init failure after pane creation — a `events.subscribe` that rejected once the pane
  // already existed. There is no subscription step: exit is discovered by polling, so
  // that failure mode does not exist and its cleanup obligation has nothing to guard.
  // The pid-refusal case above still covers the post-creation failure class.

  it('does NOT close a pane when layout.apply itself failed — there is none', async () => {
    // The other direction: no pane was created, so there is no obligation. A cleanup
    // that fired unconditionally would call `pane.close` on an id it never got.
    const server = new FakeHerdrServer()
    const original = server.call.bind(server)
    server.call = async (m, pr) => {
      if (m === 'layout.apply') throw new Error('fake-herdr: layout refused')
      return original(m, pr)
    }
    const host = new HerdrHost({ connect: async () => server, workspaceId: 'w9' })
    await host.spawn(['claude'], { cwd: '/tmp', env: {} }).then(
      () => undefined,
      () => undefined,
    )
    expect(server.callsTo('pane.close')).toEqual([])
    // NO CONNECTION TO CLOSE. The old assertion required the spawn's long-lived socket
    // to be closed on the failure path; with a connection per call there is none to
    // leak, so what remains to assert is the pane cleanup above.
  })

  it('a SUCCESSFUL spawn closes nothing — cleanup fires only on failure', async () => {
    const server = new FakeHerdrServer()
    server.screen = 'ok'
    const { child } = await spawnWithFake(server)
    expect(server.callsTo('pane.close')).toEqual([])
    child.kill()
  })

  it('an empty argv is refused before any server call', async () => {
    const server = new FakeHerdrServer()
    const host = new HerdrHost({ connect: async () => server, workspaceId: 'w9' })
    await expect(host.spawn([], { cwd: '/tmp', env: {} })).rejects.toThrow(/argv must be non-empty/)
    expect(server.calls).toEqual([])
  })
})
