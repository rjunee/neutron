/**
 * herdr-keys.test.ts — keystrokes and text writes across the herdr wire.
 *
 * TWO MEASURED FACTS DRIVE THIS FILE, and both are the kind that fail silently:
 *
 *  1. KEY NAMES USE `+`, NOT `-`. `pane.send_keys` with `ctrl-c` is REJECTED by the
 *     live server (`invalid_key: unsupported key ctrl-c`). Our own `Key` union
 *     spells that key `'ctrl-c'`, so a host that passed our names straight through
 *     would lose exactly one key — the interrupt — and lose it as a server-side
 *     rejection rather than a crash.
 *  2. `pane.send_text` NEVER SUBMITS. A literal `\r` in the text does not fire at a
 *     prompt. The old `write('/clear\r')` would type `/clear` and leave it sitting
 *     there, with no error anywhere and a turn that hangs forever.
 *
 * Each key is pinned BY VALUE rather than by a "contains no hyphen" property,
 * because a table that had silently lost an entry would pass a property check.
 */

import { describe, expect, it } from 'bun:test'
import { HERDR_KEY_NAMES, herdrKeyName, herdrKeyNames } from '../herdr-protocol.ts'
import { HerdrHost } from '../herdr-host.ts'
import { submitCommand } from '../signatures.ts'
import { FakeHerdrServer, until } from './herdr-fake-server.ts'
import { withCapturedStderr } from './capture-stderr.ts'
import { encodeKeys, type Key, type NamedKey } from '../keystrokes.ts'
import type { PtyChild } from '../pty-host.ts'

/**
 * `pollIntervalMs` is a PARAMETER, not a constant, and the default parks the loop
 * because these tests are about writes. Any test that waits for an EXIT must pass a
 * short one: exit is discovered BY POLLING now, so with the loop parked the only reason
 * such a test ever passed was that `exitPane()` happened to land while the first
 * iteration was still in flight. That is the fixture doing the step under test by
 * accident, and it broke the moment actuations became one microtask slower.
 */
async function spawn(server: FakeHerdrServer, pollIntervalMs = 10_000): Promise<PtyChild> {
  const host = new HerdrHost({
    connect: async () => server,
    pollIntervalMs,
    sleep: (ms) => Bun.sleep(ms),
    workspaceId: 'w9',
  })
  const child = await host.spawn(['claude'], { cwd: '/tmp', env: {} })
  // Release the output gate, as the production caller does after wiring (`spawn.ts`).
  child.beginOutput?.()
  return child
}

describe('the herdr key table', () => {
  it('pins every named key BY VALUE', () => {
    // Verified against the live server by sending each one: all accepted.
    expect(HERDR_KEY_NAMES).toEqual({
      enter: 'enter',
      escape: 'esc',
      'ctrl-c': 'ctrl+c',
      tab: 'tab',
      up: 'up',
      down: 'down',
      left: 'left',
      right: 'right',
    } satisfies Record<NamedKey, string>)
  })

  it('translates the ONE key whose own spelling the server rejects', () => {
    // The single entry that is a translation rather than an identity. `ctrl-c` is
    // rejected on the wire; `ctrl+c` is accepted and delivers a real SIGINT.
    expect(herdrKeyName('ctrl-c')).toBe('ctrl+c')
    expect(herdrKeyName('ctrl-c')).not.toBe('ctrl-c')
    expect(herdrKeyName('ctrl-c')).not.toContain('-')
  })

  it('passes digits through as their own character', () => {
    for (const d of ['0', '1', '5', '9'] as const) expect(herdrKeyName(d)).toBe(d)
  })

  it('maps a sequence in order', () => {
    expect(herdrKeyNames(['down', 'enter'])).toEqual(['down', 'enter'])
    expect(herdrKeyNames(['1', 'enter'])).toEqual(['1', 'enter'])
    expect(herdrKeyNames(['escape', 'ctrl-c'])).toEqual(['esc', 'ctrl+c'])
  })

  it('THROWS on a key it has no name for, rather than sending junk', () => {
    // A typo in a detector's `keys` must surface here, not as a partially-delivered
    // sequence after the server rejects the bad member.
    expect(() => herdrKeyName('meta-x' as Key)).toThrow(/no herdr key name/)
  })

  it('no mapped name uses the hyphen form the server rejects', () => {
    // A property check, kept only as a companion to the by-value pin above — on its
    // own it would pass a table missing an entry entirely.
    for (const name of Object.values(HERDR_KEY_NAMES)) {
      expect(name).not.toMatch(/^ctrl-/)
    }
  })
})

describe('writeKey / writeKeys over the wire', () => {
  it('sends herdr names, not our own', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    child.writeKey?.('ctrl-c')
    await until(() => server.callsTo('pane.send_keys').length >= 1, 'send_keys')
    expect(server.callsTo('pane.send_keys')[0]!.params['keys']).toEqual(['ctrl+c'])
    child.kill()
  })

  it('sends a multi-key sequence as ONE request, in order', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    child.writeKeys?.(['1', 'enter'])
    await until(() => server.callsTo('pane.send_keys').length >= 1, 'send_keys')
    const calls = server.callsTo('pane.send_keys')
    // One request, not two: a fired detector's keystrokes must not be separable by
    // a transport failure into a half-pressed answer.
    expect(calls.length).toBe(1)
    expect(calls[0]!.params['keys']).toEqual(['1', 'enter'])
    child.kill()
  })

  it('an empty key sequence sends nothing at all', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    child.writeKeys?.([])
    await Bun.sleep(20)
    expect(server.callsTo('pane.send_keys')).toEqual([])
    child.kill()
  })
})

describe('the byte-encoding fallback can never be reached by the real backend', () => {
  it('the real child provides BOTH writeKey and writeKeys', async () => {
    // `sendKey`/`sendKeys` (`signatures.ts`) degrade to `write(encodeKey(...))` when a
    // child omits these. That fallback CANNOT work for herdr: `encodeKey('enter')` is
    // `\r`, and this backend's `write()` refuses `\r` because `pane.send_text` never
    // submits — so a detector firing `['1','enter']` down the fallback would throw on
    // the scan path instead of pressing a key.
    //
    // Nothing in the host asserts this on its own; the two methods are optional on the
    // interface precisely so lightweight fakes may omit them. So it is pinned here,
    // which turns "unreachable in practice" into a checked fact.
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    expect(typeof child.writeKey).toBe('function')
    expect(typeof child.writeKeys).toBe('function')
    child.kill()
  })

  it('the fallback WOULD have thrown — this is why the pin above matters', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    // Exactly what `sendKeys` would do for a child missing `writeKeys`.
    expect(() => child.write(encodeKeys(['1', 'enter']))).toThrow(/refuses a submit character/)
    child.kill()
  })
})

describe('write() and the fact that send_text never submits', () => {
  it('REFUSES a trailing \\r, naming the sibling that does submit', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    // The shape of the three old call sites. Under herdr this silently typed the
    // command and left it unsubmitted; now it is loud.
    let err: Error | undefined
    try {
      child.write('/clear\r')
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    // A refusal with no writable alternative is a deadlock, not a safeguard — so the
    // message has to name the alternative.
    expect(err!.message).toContain("writeKey('enter')")
    // And nothing was sent: the refusal is not a partial write.
    expect(server.callsTo('pane.send_text')).toEqual([])
    child.kill()
  })

  it('REFUSES an embedded \\n too, not just a trailing \\r', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    expect(() => child.write('line one\nline two')).toThrow(/refuses a submit character/)
    expect(server.callsTo('pane.send_text')).toEqual([])
    child.kill()
  })

  it('THE HONEST SIBLING WORKS: text, then an enter key, both reach the pane', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    child.write('/clear')
    child.writeKey?.('enter')
    await until(
      () => server.callsTo('pane.send_text').length >= 1 && server.callsTo('pane.send_keys').length >= 1,
      'text then enter',
    )
    expect(server.callsTo('pane.send_text')[0]!.params['text']).toBe('/clear')
    expect(server.callsTo('pane.send_keys')[0]!.params['keys']).toEqual(['enter'])
    // Order matters: the submit must follow the text. Taken over DELIVERIES, not
    // invocations — `calls` is pushed when the host hands the request over, which is
    // before either connection has been answered, so an ordering assertion there
    // passes for an implementation with no ordering at all.
    const iText = server.delivered.findIndex((c) => c.method === 'pane.send_text')
    const iKeys = server.delivered.findIndex((c) => c.method === 'pane.send_keys')
    expect(iText).toBeLessThan(iKeys)
    child.kill()
  })

  // THE WHOLE POINT OF THE QUEUE, and it is invisible without a HELD call. One
  // connection per request means two fire-and-forget actuations started in the same
  // tick are two independent connects racing. Hold the FIRST one open while the second
  // would otherwise sail past it: with the queue, the second has not even been asked
  // for; without it, the second reaches the pane first and submits an empty prompt.
  it('a HELD text keeps the Enter behind it — the submit cannot overtake what it submits', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    const release = server.holdMethod('pane.send_text')
    child.write('/clear')
    child.writeKey?.('enter')
    // Give the unserialised implementation every chance: many turns of the loop, which
    // is far more than a second connect would need.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await Bun.sleep(30)
    expect(server.deliveredTo('pane.send_text')).toEqual([])
    expect(server.deliveredTo('pane.send_keys')).toEqual([])
    release()
    await until(
      () => server.deliveredTo('pane.send_keys').length >= 1,
      'the enter, once the text is answered',
    )
    expect(server.delivered.map((c) => c.method).filter((m) => m.startsWith('pane.send'))).toEqual([
      'pane.send_text',
      'pane.send_keys',
    ])
    child.kill()
  })

  // The sequence that made this a defect rather than a theory: the session-size
  // watchdog actuates escape, then the `/compact` text, then enter — three
  // fire-and-forget calls in three consecutive statements (`session-size-watchdog.ts`).
  // Holding the MIDDLE one is the discriminating arrangement: if Enter can overtake the
  // text, it submits whatever was on the line and leaves `/compact` typed and unsent.
  it("the watchdog's escape → /compact → enter reaches the pane in that order, with the text held", async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    const release = server.holdMethod('pane.send_text')
    child.writeKey?.('escape')
    child.write('/compact')
    child.writeKey?.('enter')
    await until(() => server.deliveredTo('pane.send_keys').length >= 1, 'the escape')
    // The escape is through; the text is held; the Enter must NOT be through.
    await Bun.sleep(30)
    expect(server.deliveredTo('pane.send_keys').length).toBe(1)
    expect(server.deliveredTo('pane.send_keys')[0]!.params['keys']).toEqual(['esc'])
    expect(server.deliveredTo('pane.send_text')).toEqual([])
    release()
    await until(() => server.deliveredTo('pane.send_keys').length >= 2, 'the enter')
    expect(
      server.delivered
        .filter((c) => c.method === 'pane.send_text' || c.method === 'pane.send_keys')
        .map((c) => (c.method === 'pane.send_text' ? c.params['text'] : c.params['keys'])),
    ).toEqual([['esc'], '/compact', ['enter']])
    child.kill()
  })

  // A FAILED ACTUATION MUST NOT WEDGE THE QUEUE. Serialising creates a new way to
  // break: if the chain only continues on success, one rejected keystroke stops every
  // later one forever and the REPL is dead with nothing said. The cost of dropping one
  // actuation is one lost key; the cost of a wedged queue is the session.
  it('a FAILED actuation does not wedge the ones behind it', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    server.failMethod('pane.send_text', new Error('server said no'))
    child.write('/clear')
    child.writeKey?.('enter')
    await until(() => server.deliveredTo('pane.send_keys').length >= 1, 'the enter behind the failure')
    // The text never reached the pane; the Enter did, and it did so AFTER.
    expect(server.deliveredTo('pane.send_text')).toEqual([])
    expect(server.callsTo('pane.send_text').length).toBe(1)
    child.kill()
  })

  // A QUEUE ADDS A NEW WINDOW: an actuation can be waiting when the pane goes. The
  // no-op-safe-after-exit contract is checked at the door AND again when the call
  // actually starts, because between those two moments the pane can vanish — and
  // sending a key into a dead pane is exactly the "reporting work that did not happen"
  // failure the rest of this host is built against.
  it('an actuation queued BEFORE the exit is dropped, not delivered to a dead pane', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server, 10)
    const release = server.holdMethod('pane.send_text')
    child.write('/clear')
    child.writeKey?.('enter')
    server.exitPane()
    await until(() => child.hasExited(), 'the exit, discovered by polling')
    release()
    await Bun.sleep(30)
    expect(server.deliveredTo('pane.send_keys')).toEqual([])
    expect(server.callsTo('pane.send_keys')).toEqual([])
  })

  // A QUEUE MOVES THE MOMENT OF EXECUTION AWAY FROM THE MOMENT OF THE CHECK. The
  // fire-and-forget path re-checks `exited` when the queued call actually starts; the
  // ACKNOWLEDGED one did not, so a `submitLine` queued behind a held actuation ran its
  // text and Enter against a pane that had vanished while it waited — and resolved,
  // reporting a context reset that never happened. The case above covers `writeKey`
  // only, which is why this one is separate rather than a parameter of it.
  it('a submitLine queued BEFORE the exit REJECTS rather than actuating a dead pane', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server, 10)
    const release = server.holdMethod('pane.send_keys')
    child.writeKey?.('escape') // occupies the queue
    const submitted = child.submitLine!('/clear').then(
      () => 'resolved',
      (e: unknown) => (e as Error).message,
    )
    server.exitPane()
    await until(() => child.hasExited(), 'the exit, discovered by polling')
    release()
    // IT REACHES THE CALLER. Dropping it quietly is right for `write`/`writeKey`, which
    // are no-op-safe by contract, and WRONG here: this is the seam a caller reports an
    // outcome from.
    expect(await submitted).toContain('after exit')
    // And nothing was actuated on the dead pane.
    expect(server.deliveredTo('pane.send_text')).toEqual([])
    expect(server.callsTo('pane.send_text')).toEqual([])
  })

  // `submitLine` is queued as ONE UNIT, not as two queued calls. If its text and its
  // Enter were enqueued separately, a fire-and-forget actuation from another caller
  // could land between them — submitting the caller's line with somebody else's key.
  it('submitLine is ATOMIC in the queue — nothing lands between its text and its Enter', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    const release = server.holdMethod('pane.send_text')
    const submitted = child.submitLine!('/compact')
    // A DISTINGUISHABLE competing actuation. `enter` would be wrong here: both keys
    // would then arrive as `pane.send_keys` and an assertion on METHOD alone reads the
    // same for both orders — which is how the first version of this test passed against
    // an implementation that enqueued the text and the Enter separately.
    child.writeKey?.('escape')
    await Bun.sleep(20)
    release()
    await submitted
    await until(() => server.deliveredTo('pane.send_keys').length >= 2, 'both keys')
    expect(
      server.delivered
        .filter((c) => c.method === 'pane.send_text' || c.method === 'pane.send_keys')
        .map((c) => (c.method === 'pane.send_text' ? c.params['text'] : c.params['keys'])),
    ).toEqual(['/compact', ['enter'], ['esc']])
    child.kill()
  })

  it('an empty write sends nothing', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    child.write('')
    await Bun.sleep(20)
    expect(server.callsTo('pane.send_text')).toEqual([])
    child.kill()
  })
})

describe('submitting a slash command REFUSES rather than silently skipping the submit', () => {
  /** A child with `write` AND `writeKey` but NO `submitLine` — a legal `PtyChild`,
   *  since all three are optional. Keeping `writeKey` is the point: a regression
   *  that fell back to `write` + `writeKey` would produce a perfectly ordered
   *  text-then-enter here and still be wrong, because neither call can report a
   *  refusal. What must be refused is the UNACKNOWLEDGED seam, not the keyless one. */
  function childWithoutSubmitLine(): { child: PtyChild; order: string[] } {
    const order: string[] = []
    const child: PtyChild = {
      pid: 1,
      write: (d) => void order.push(`TEXT:${typeof d === 'string' ? d : Buffer.from(d).toString('utf8')}`),
      writeKey: (k) => void order.push(`KEY:${k}`),
      kill: () => {},
      exited: Promise.resolve(null),
      hasExited: () => false,
    }
    return { child, order }
  }

  it('REJECTS for a child with no submitLine, even though it could type and press enter', async () => {
    // THE DEFECT THIS REPLACES, IN ITS SECOND FORM. Round one: `writeKey?.('enter')`
    // skipped the submit outright. Round two: the submit happened, but `write` and
    // `writeKey` are `void` — they hand a frame to the socket and return — so a
    // REFUSED frame and a delivered one were the same observable event, and the
    // caller returned `{status:'reset'}` for both. This child is fully capable of
    // the old path; the refusal is about the claim, not the capability.
    const { child, order } = childWithoutSubmitLine()
    let err: Error | undefined
    await submitCommand(child, '/clear').catch((e: unknown) => {
      err = e as Error
    })
    expect(err).toBeDefined()
    expect(err!.message).toContain('submitLine')
    expect(err!.message).toContain('/clear')
    // Nothing was typed either: a refusal, not a half-done actuation that leaves
    // '/clear' sitting at the prompt for the next keystroke to submit by accident.
    expect(order).toEqual([])
  })

  it('uses submitLine — and ONLY submitLine — for a child that provides it', async () => {
    const order: string[] = []
    const child: PtyChild = {
      pid: 1,
      write: (d) => void order.push(`TEXT:${String(d)}`),
      writeKey: (k) => void order.push(`KEY:${k}`),
      submitLine: async (c) => void order.push(`SUBMIT:${c}`),
      kill: () => {},
      exited: Promise.resolve(null),
      hasExited: () => false,
    }
    await submitCommand(child, '/compact')
    // Exactly one entry, and it is the acknowledged one: pinning the absence of
    // `TEXT:`/`KEY:` is what stops a future version from "helpfully" doing both.
    expect(order).toEqual(['SUBMIT:/compact'])
  })

  it('CONTROL — the real herdr child submits, and RESOLVES only after both halves are acknowledged', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    // Awaiting is the assertion: if `submitLine` resolved before the calls landed,
    // the two `toEqual`s below would read an empty call log. No polling here for
    // exactly that reason — `until()` would hide the difference.
    await submitCommand(child, '/clear')
    expect(server.callsTo('pane.send_text')[0]!.params['text']).toBe('/clear')
    expect(server.callsTo('pane.send_keys')[0]!.params['keys']).toEqual(['enter'])
    child.kill()
  })

  it('a REFUSED text rejects, and never presses enter on whatever was at the prompt', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    server.failMethod('pane.send_text', new Error('send_text refused'))
    let err: Error | undefined
    await submitCommand(child, '/clear').catch((e: unknown) => {
      err = e as Error
    })
    expect(err).toBeDefined()
    expect(err!.message).toContain('send_text refused')
    // AND THE ENTER MUST NOT HAVE HAPPENED. A blind Enter after an unacknowledged
    // text submits whatever the prompt already held — the previous turn's half-typed
    // line, or nothing at all — so the ordering is a correctness property, not a
    // tidiness one.
    expect(server.callsTo('pane.send_keys')).toEqual([])
    child.kill()
  })

  it('a REFUSED enter rejects even though the text landed — partial actuation is not success', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    server.failMethod('pane.send_keys', new Error('send_keys refused'))
    let err: Error | undefined
    await submitCommand(child, '/clear').catch((e: unknown) => {
      err = e as Error
    })
    expect(err).toBeDefined()
    expect(err!.message).toContain('send_keys refused')
    // The text DID land — this is the case the old fire-and-forget pair reported as
    // a completed reset: '/clear' typed at the prompt, never submitted, the context
    // fully intact, and `{status:'reset'}` returned.
    expect(server.callsTo('pane.send_text')[0]!.params['text']).toBe('/clear')
    child.kill()
  })

  it('submitLine after exit rejects rather than no-opping', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server, 10)
    server.exitPane()
    await until(() => child.hasExited(), 'exit')
    const before = server.callsTo('pane.send_text').length
    let err: Error | undefined
    await child.submitLine!('/clear').catch((e: unknown) => {
      err = e as Error
    })
    // `write`/`writeKey` are no-op-safe after exit by contract. An ACKNOWLEDGED
    // operation may not be: silently resolving would tell the caller a dead REPL
    // had accepted the command.
    expect(err).toBeDefined()
    expect(err!.message).toContain('after exit')
    expect(server.callsTo('pane.send_text').length).toBe(before)
  })
})

describe('kill maps onto the only signal herdr has', () => {
  // A REFUSED SIGINT MUST NOT CLAIM THE INTERRUPT WAS SENT. `send` is fire-and-forget —
  // which is the right shape for a keystroke — and the flag was latched on top of it, so
  // a `pane.send_keys` the server refused left `wasInterruptedByUs()` true against
  // `pty-host.ts`'s "True once WE sent this child an INTERRUPT". Same defect and same
  // direction as the Bun host latching before a `proc.kill` that throws: an operation
  // that failed leaving behind a latch that says it succeeded.
  //
  // THE FILE ALREADY KNEW HOW TO INJECT THIS — `failMethod('pane.send_keys', …)` is used
  // for the refused-submit case — and only the SIGINT row was missing. The asymmetry in
  // the coverage was the asymmetry in the code.
  it('a REFUSED ctrl+c does not latch wasInterruptedByUs', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    server.failMethod('pane.send_keys', new Error('send_keys refused'))
    const errs = await withCapturedStderr(async () => {
      child.kill('SIGINT')
      await until(() => server.callsTo('pane.send_keys').length >= 1, 'the attempt')
      await Bun.sleep(30)
    })
    // It really was attempted, and it really did not land.
    expect(server.deliveredTo('pane.send_keys')).toEqual([])
    expect(child.wasInterruptedByUs?.()).toBe(false)
    // ...and the terminal flag is untouched: the clear is as narrow as the latch.
    expect(child.wasKilledByUs?.()).toBe(false)
    expect(child.hasExited()).toBe(false)
    expect(errs.filter((e) => e.includes('SIGINT actuation was REFUSED')).length).toBe(1)
    child.kill()
  })

  it('SIGINT becomes a ctrl+c keypress, and does NOT latch wasKilledByUs', async () => {
    // THIS TEST USED TO ASSERT THE CONTRADICTION. It checked `hasExited() === false`
    // AND `wasKilledByUs() === true` — alive and intentionally-terminated at the same
    // time — and a comment explained the second as intended. A test whose own
    // assertions describe a state that cannot be coherent is the signal, not the
    // fixture, and this one documented the defect instead of refusing it.
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    child.kill('SIGINT')
    await until(() => server.callsTo('pane.send_keys').length >= 1, 'ctrl+c')
    expect(server.callsTo('pane.send_keys')[0]!.params['keys']).toEqual(['ctrl+c'])
    // An interrupt is not a termination: the child is still alive…
    expect(child.hasExited()).toBe(false)
    // …so nothing may claim it was intentionally terminated. `wasKilledByUs` is the
    // ENTIRE crash-vs-recycle discriminator here (herdr has no exit codes), and
    // latching it on a non-terminal operation destroys it for the child's whole life.
    expect(child.wasKilledByUs?.()).toBe(false)
    // The transient intent has its own representation.
    expect(child.wasInterruptedByUs?.()).toBe(true)
    child.kill()
  })

  it('REGRESSION — an unexpected exit AFTER a SIGINT is still a CRASH', async () => {
    // The consequence, end to end through the real classifier's inputs. Before the
    // fix, `kill('SIGINT')` latched `wasKilledByUs`, and `spawn.ts` treats any
    // `wasKilledByUs()` child as a clean recycle — so a genuine crash following an
    // interrupt was silently unregistered instead of being reported.
    const server = new FakeHerdrServer()
    const child = await spawn(server, 10)
    child.kill('SIGINT')
    await until(() => server.deliveredTo('pane.send_keys').length >= 1, 'the interrupt')

    // Now the child dies on its own — no `pane.close`, nothing we asked for.
    server.exitPane()
    const code = await child.exited

    // The exact expression `spawn.ts` evaluates.
    const classify = (exitCode: number | null, killedByUs: boolean): 'crash' | 'clean' =>
      !killedByUs && exitCode !== 0 ? 'crash' : 'clean'
    expect(classify(code, child.wasKilledByUs?.() ?? false)).toBe('crash')
    expect(child.exitCause?.()).toBe('pane-vanished')
    // The interrupt is still recorded — it just does not license a 'clean' verdict.
    expect(child.wasInterruptedByUs?.()).toBe(true)
  })

  it('CONTROL — a TERMINAL kill does latch wasKilledByUs, and reads as clean', async () => {
    // The other direction: making SIGINT non-latching must not stop a real
    // termination from being recognised as one.
    const server = new FakeHerdrServer({ paneId: 'w9:pTerm' })
    const child = await spawn(server)
    child.kill()
    const code = await child.exited
    const classify = (exitCode: number | null, killedByUs: boolean): 'crash' | 'clean' =>
      !killedByUs && exitCode !== 0 ? 'crash' : 'clean'
    expect(classify(code, child.wasKilledByUs?.() ?? false)).toBe('clean')
    expect(child.wasKilledByUs?.()).toBe(true)
    expect(child.wasInterruptedByUs?.()).toBe(false)
  })

  it('an interrupt followed by a TERMINAL kill latches both, in that order', async () => {
    const server = new FakeHerdrServer({ paneId: 'w9:pBoth' })
    const child = await spawn(server)
    child.kill('SIGINT')
    expect(child.wasKilledByUs?.()).toBe(false)
    child.kill() // now terminal
    expect(child.wasKilledByUs?.()).toBe(true)
    expect(child.wasInterruptedByUs?.()).toBe(true)
    await child.exited
  })

  it('anything else closes the pane and settles the child', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    child.kill()
    expect(await child.exited).toBeNull()
    expect(server.callsTo('pane.close').length).toBe(1)
    expect(child.wasKilledByUs?.()).toBe(true)
  })

  it('a write after exit is a no-op, not a throw', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    child.kill()
    await child.exited
    // Count WRITES, not every call: the poll loop may have a `pane.get`/`pane.read`
    // in flight when the child exits, and that is not what this test claims.
    const writesBefore =
      server.callsTo('pane.send_text').length + server.callsTo('pane.send_keys').length
    child.write('late')
    child.writeKey?.('enter')
    await Bun.sleep(20)
    expect(
      server.callsTo('pane.send_text').length + server.callsTo('pane.send_keys').length,
    ).toBe(writesBefore)
  })
})
