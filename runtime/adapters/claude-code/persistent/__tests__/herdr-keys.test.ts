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
import { encodeKeys, type Key, type NamedKey } from '../keystrokes.ts'
import type { PtyChild } from '../pty-host.ts'

async function spawn(server: FakeHerdrServer): Promise<PtyChild> {
  const host = new HerdrHost({
    connect: async () => server,
    pollIntervalMs: 10_000, // park the poll loop; these tests are about writes
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
    // Order matters: the submit must follow the text.
    const iText = server.calls.findIndex((c) => c.method === 'pane.send_text')
    const iKeys = server.calls.findIndex((c) => c.method === 'pane.send_keys')
    expect(iText).toBeLessThan(iKeys)
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
  /** A child that implements `write` but NOT `writeKey` — a legal `PtyChild`, since
   *  `writeKey` is optional on the interface. */
  function childWithoutWriteKey(): { child: PtyChild; writes: string[] } {
    const writes: string[] = []
    const child: PtyChild = {
      pid: 1,
      write: (d) => void writes.push(typeof d === 'string' ? d : Buffer.from(d).toString('utf8')),
      kill: () => {},
      exited: Promise.resolve(null),
      hasExited: () => false,
    }
    return { child, writes }
  }

  it('THROWS for a child with no writeKey, instead of typing the command and moving on', () => {
    // THE DEFECT THIS REPLACES. `child.writeKey?.('enter')` skipped the submit for
    // exactly this child, and the caller then returned `{status:'reset'}` — a reset
    // that never happened, reported as one. `?.` on a method whose ABSENCE CHANGES
    // THE OUTCOME is a silent skip wearing the clothes of a safe default.
    const { child, writes } = childWithoutWriteKey()
    let err: Error | undefined
    try {
      submitCommand(child, '/clear')
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    expect(err!.message).toContain('writeKey')
    expect(err!.message).toContain('/clear')
    // Nothing was typed either: a refusal, not a half-done actuation that leaves
    // '/clear' sitting at the prompt for the next keystroke to submit by accident.
    expect(writes).toEqual([])
  })

  it('sends text THEN enter for a child that does provide writeKey', () => {
    const order: string[] = []
    const child: PtyChild = {
      pid: 1,
      write: (d) => void order.push(`TEXT:${String(d)}`),
      writeKey: (k) => void order.push(`KEY:${k}`),
      kill: () => {},
      exited: Promise.resolve(null),
      hasExited: () => false,
    }
    submitCommand(child, '/compact')
    expect(order).toEqual(['TEXT:/compact', 'KEY:enter'])
  })

  it('the real herdr child satisfies it — the refusal is unreachable in production', async () => {
    const server = new FakeHerdrServer()
    const child = await spawn(server)
    expect(() => submitCommand(child, '/clear')).not.toThrow()
    await until(() => server.callsTo('pane.send_keys').length >= 1, 'submit')
    expect(server.callsTo('pane.send_text')[0]!.params['text']).toBe('/clear')
    expect(server.callsTo('pane.send_keys')[0]!.params['keys']).toEqual(['enter'])
    child.kill()
  })
})

describe('kill maps onto the only signal herdr has', () => {
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
    const child = await spawn(server)
    child.kill('SIGINT')
    await until(() => server.callsTo('pane.send_keys').length >= 1, 'the interrupt')

    // Now the child dies on its own — no `pane.close`, nothing we asked for.
    server.exitPane()
    const code = await child.exited

    // The exact expression `spawn.ts` evaluates.
    const classify = (exitCode: number | null, killedByUs: boolean): 'crash' | 'clean' =>
      !killedByUs && exitCode !== 0 ? 'crash' : 'clean'
    expect(classify(code, child.wasKilledByUs?.() ?? false)).toBe('crash')
    expect(child.exitCause?.()).toBe('pane-exited')
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
