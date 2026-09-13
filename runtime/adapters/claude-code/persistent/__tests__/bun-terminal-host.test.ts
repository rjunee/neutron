/**
 * bun-terminal-host.test.ts — the in-process backend is KEPT AS AN OPTION, so it has
 * to be kept WORKING. An option nobody exercises is the "supported-looking dead
 * export" this branch has removed twice; what makes this one live is not that it is
 * exported, it is that the contract it claims is asserted here.
 *
 * These spawn REAL processes on a REAL pty — there is no seam to fake, because the
 * host reaches `Bun.Terminal` and `Bun.spawn` directly, and faking them would test the
 * fake. They use `/bin/echo` and `/bin/cat`: no network, no credentials, milliseconds.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: parity with `HerdrHost`. The two backends are not
 * interchangeable — exit codes, exit detection and the origin of `onScreen` all differ
 * — and a test that pinned them as equal would be documenting a falsehood. Each
 * difference is stated in `bun-terminal-host.ts` and in the spec item.
 */

import { describe, expect, it } from 'bun:test'
import {
  BunTerminalHost,
  bunTerminalHost,
  newScreenAccumulator,
  writeAllOrThrow,
} from '../bun-terminal-host.ts'
import type { PtyChild } from '../pty-host.ts'
import { withCapturedStderr } from './capture-stderr.ts'

/** Wait until `cond()` holds, or throw. */
async function until(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`until: timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

describe('the in-process Bun PTY backend is kept as a working option', () => {
  it('spawns on a real pty, reports a real pid, and resolves a REAL exit code', async () => {
    const screens: string[] = []
    const child = await bunTerminalHost.spawn(['/bin/echo', 'hello-from-the-pty'], {
      cwd: '/tmp',
      env: {},
      onScreen: (s) => screens.push(s),
    })
    // AS PRODUCTION DOES. `spawn.ts` calls this once its consumers are wired; without
    // it the host holds screens for the fail-open window. These tests used to pass
    // without it because this backend had no gate — which was the defect.
    child.beginOutput?.()
    // `spawn` is async for herdr's sake; here the pid exists immediately and must be
    // real — `supervision.ts` liveness-probes it.
    expect(child.pid).toBeGreaterThan(0)
    const code = await child.exited
    // THE DIVERGENCE, ASSERTED RATHER THAN DESCRIBED. Under herdr this is always
    // `null` and crash-vs-recycle rests entirely on `wasKilledByUs`. Here it is a real
    // kernel status, and that is the whole reason the option is worth keeping.
    expect(code).toBe(0)
    expect(child.hasExited()).toBe(true)
    await until(() => screens.length > 0, 'a screen')
    expect(screens.join('')).toContain('hello-from-the-pty')
  })

  it('onScreen delivers an ACCUMULATION, not one chunk — the ring replaces what it gets', async () => {
    // If the host forwarded each chunk, `PtyRing.replace` would erase all previous
    // output on every delivery and the ring would silently hold only the last bytes.
    // Two writes, and the LAST screen must carry both.
    const screens: string[] = []
    const child = await bunTerminalHost.spawn(['/bin/cat'], {
      cwd: '/tmp',
      env: {},
      onScreen: (s) => screens.push(s),
    })
    // AS PRODUCTION DOES. `spawn.ts` calls this once its consumers are wired; without
    // it the host holds screens for the fail-open window. These tests used to pass
    // without it because this backend had no gate — which was the defect.
    child.beginOutput?.()
    await child.submitLine!('first-line')
    await until(() => screens.some((s) => s.includes('first-line')), 'the first line')
    await child.submitLine!('second-line')
    await until(() => screens.some((s) => s.includes('second-line')), 'the second line')
    const last = screens[screens.length - 1]!
    expect(last).toContain('first-line')
    expect(last).toContain('second-line')
    child.kill()
    await child.exited
  })

  it('the accumulation keeps its LINE STRUCTURE across chunks', async () => {
    // Everything positional downstream depends on this: `textSince` is an
    // order-preserving multiset difference of LINES, and `getRecentOutput({bottomN})`
    // and the doc-quote guard in `output-scan.ts` slice by line. The trim uses
    // `bottomNLines`, which deliberately drops a trailing newline — right for a
    // finished capture, WRONG for a running accumulation, where it would join the last
    // line to whatever the next chunk brings. Two lines arriving in two deliveries must
    // stay two lines.
    const screens: string[] = []
    const child = await bunTerminalHost.spawn(
      ['/bin/sh', '-c', 'while IFS= read -r line; do echo "GOT:$line"; done'],
      { cwd: '/tmp', env: {}, onScreen: (s) => screens.push(s) },
    )
    child.beginOutput?.() // as production does, once its consumers are wired
    await child.submitLine!('alpha')
    await until(() => screens.some((s) => s.includes('GOT:alpha')), 'the first line')
    await child.submitLine!('beta')
    await until(() => screens.some((s) => s.includes('GOT:beta')), 'the second line')
    const last = screens[screens.length - 1]!
    const lines = last.split('\n').map((l) => l.trim())
    expect(lines).toContain('GOT:alpha')
    expect(lines).toContain('GOT:beta')
    child.kill()
    await child.exited
  })

  it('submitLine SUBMITS — the Enter is load-bearing, not decorative', async () => {
    // `cat` would be the wrong reader here: a pty ECHOES what is typed, so the text
    // appears on screen whether or not it was ever submitted, and a test against the
    // echo passes for an implementation that sends no Enter at all (verified: that
    // mutation survived until this case existed). This reader emits `GOT:` only after
    // a COMPLETE LINE arrives, so the marker can only appear if the submit fired.
    const screens: string[] = []
    const child = await bunTerminalHost.spawn(
      ['/bin/sh', '-c', 'while IFS= read -r line; do echo "GOT:$line"; done'],
      { cwd: '/tmp', env: {}, onScreen: (s) => screens.push(s) },
    )
    child.beginOutput?.() // as production does, once its consumers are wired
    await child.submitLine!('acknowledged-line')
    await until(
      () => screens.some((s) => s.includes('GOT:acknowledged-line')),
      'the reader seeing a COMPLETE line',
    )
    child.kill()
    await child.exited
    // AND IT IS NOT NO-OP-SAFE. `write`/`writeKey` are fire-and-forget by interface;
    // this is the variant a caller reports an outcome from, so "the child is already
    // gone" has to reach the caller rather than resolve as a completed submit.
    await expect(child.submitLine!('too-late')).rejects.toThrow(/after exit/)
  })

  it('a SIGINT does not latch wasKilledByUs — a later crash must still read as a crash', async () => {
    // The same defect the herdr backend was fixed for, and it is the same defect here
    // even though this backend HAS exit codes: `spawn.ts` evaluates
    // `!killedByUs && exitCode !== 0`, so a true flag short-circuits the code entirely.
    const child = await bunTerminalHost.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    child.kill('SIGINT')
    await child.exited
    expect(child.wasKilledByUs?.()).toBe(false)
    expect(child.wasInterruptedByUs?.()).toBe(true)
  })

  it('CONTROL — a TERMINAL kill DOES latch, so the flag discriminates', async () => {
    const child = await bunTerminalHost.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    child.kill()
    await child.exited
    expect(child.wasKilledByUs?.()).toBe(true)
    expect(child.wasInterruptedByUs?.()).toBe(false)
  })

  it('refuses an empty argv before spawning anything', async () => {
    await expect(bunTerminalHost.spawn([], { cwd: '/tmp', env: {} })).rejects.toThrow(
      /argv must be non-empty/,
    )
  })

  it('satisfies the PtyChild shape the substrate consumes', async () => {
    const child: PtyChild = await bunTerminalHost.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    // `beginOutput` exists so a caller can call it unconditionally on either backend;
    // here there is no gate to release.
    expect(typeof child.beginOutput).toBe('function')
    child.beginOutput?.()
    expect(typeof child.writeKey).toBe('function')
    expect(typeof child.writeKeys).toBe('function')
    expect(typeof child.resize).toBe('function')
    // `exitCause` is deliberately ABSENT: its values name herdr's routes, and
    // "the pane does not exist" is not a thing that can happen to an in-process pty.
    expect(child.exitCause).toBeUndefined()
    child.kill()
    await child.exited
  })
})

/**
 * THE BOUND IS TESTED WITHOUT A PTY, ON PURPOSE.
 *
 * A pty has a fixed kernel buffer and no flow control: when the reader is slower than
 * the writer the kernel DROPS output, silently and by a varying amount. Measured on
 * this host with a 3 MB newline-free child: 490,432 bytes delivered on one run and
 * 316,608 on the next. A bound asserted through that fixture can pass because the
 * output never reached the cap — which is exactly what happened when the mutation that
 * cuts UTF-16 units instead of a character-safe byte tail SURVIVED. A fixture does not
 * have to be permissive to hide a defect; it only has to be unrepresentative.
 *
 * The accumulator is a pure function of the chunk sequence, so driven directly the
 * bound is decidable.
 */
describe('the screen accumulator is bounded in BYTES', () => {
  const CAP = 64 * 1024
  const TRIM_TO = 48 * 1024

  // A DEFAULT THAT IGNORES ITS SIBLING ARGUMENT. `trimToBytes` defaulted to the
  // production-wide 384 KiB regardless of the `maxBytes` it was meant to sit under, so
  // `newScreenAccumulator(64)` trimmed to 393216 — i.e. never — and kept everything.
  // Every other case here supplies BOTH values, which is exactly why the one-argument
  // boundary went uncovered: this kind of default is only wrong when someone passes one
  // of them, and a fixture that always passes both can never be that someone.
  it('ONE-ARGUMENT construction still bounds — the trim follows the cap it was given', () => {
    const acc = newScreenAccumulator(64) // no trim target supplied
    let screen = ''
    for (let i = 0; i < 50; i++) screen = acc.push('x'.repeat(65))
    expect(Buffer.byteLength(screen, 'utf8')).toBeLessThanOrEqual(64)
    expect(screen.length).toBeGreaterThan(0)
  })

  it('CONTROL — the ZERO-argument default is the production pair, not a shrunken one', () => {
    // Deriving the trim target from `maxBytes` must not change what production uses.
    const acc = newScreenAccumulator()
    let screen = ''
    for (let i = 0; i < 40; i++) screen = acc.push('y'.repeat(16 * 1024))
    // 640 KiB pushed through the 512 KiB production cap: bounded, and NOT trimmed to
    // something tiny by a ratio applied to the wrong number.
    expect(Buffer.byteLength(screen, 'utf8')).toBeLessThanOrEqual(512 * 1024)
    expect(Buffer.byteLength(screen, 'utf8')).toBeGreaterThan(256 * 1024)
  })

  it('output with NO NEWLINES is still bounded — a line count cannot bound memory', () => {
    // A LINE IS UNBOUNDED, so a line count is not a bound. The first version of this
    // host kept "the last 2000 lines"; a child whose output contains no newline is ONE
    // line forever, so every trim retained everything. `yes x | tr -d '\n'` is the
    // one-command repro, and every other test here uses newline-terminated output.
    const acc = newScreenAccumulator(CAP, TRIM_TO)
    let screen = ''
    for (let i = 0; i < 3000; i++) screen = acc.push('x'.repeat(1024)) // 3 MB, no newline
    expect(Buffer.byteLength(screen, 'utf8')).toBeLessThanOrEqual(CAP)
    // ...and it kept the TAIL, which is the direction every detector read is anchored.
    expect(screen.endsWith('x'.repeat(16))).toBe(true)
    expect(screen.length).toBeGreaterThan(0)
  })

  it('a newline-free MULTIBYTE stream is cut on a CHARACTER boundary', () => {
    // The only arrangement that can tell a byte-safe cut from a UTF-16 slice: an
    // all-ASCII cap test passes for an implementation that slices code units, and a
    // newline-terminated one never reaches the single-over-long-line path at all.
    const acc = newScreenAccumulator(CAP, TRIM_TO)
    let screen = ''
    for (let i = 0; i < 3000; i++) screen = acc.push('é'.repeat(512)) // 1 KiB per chunk
    expect(Buffer.byteLength(screen, 'utf8')).toBeLessThanOrEqual(CAP)
    expect(screen).not.toContain('�')
    // Every character is intact — a mid-character cut would leave a replacement char
    // or a lone surrogate at the front.
    expect([...screen].every((c) => c === 'é')).toBe(true)
  })

  it('an ASTRAL character is never split — the surrogate pair survives the cut', () => {
    // `.slice()` counts UTF-16 units, so a cut can land BETWEEN the two halves of a
    // surrogate pair and produce a lone surrogate, which is not a character at all.
    const acc = newScreenAccumulator(CAP, TRIM_TO)
    let screen = ''
    for (let i = 0; i < 2000; i++) screen = acc.push('😀'.repeat(256)) // 4 bytes each
    expect(Buffer.byteLength(screen, 'utf8')).toBeLessThanOrEqual(CAP)
    expect(screen).not.toContain('�')
    expect([...screen].every((c) => c === '😀')).toBe(true)
  })

  it('keeps line structure and the TRAILING NEWLINE when it trims', () => {
    // `bottomNLines` drops a trailing newline (right for a finished capture, wrong for
    // a running accumulation) — this is why the clamp is `clampLeadingLines`, which
    // preserves it. Without that, the last line joins the next chunk.
    const acc = newScreenAccumulator(CAP, TRIM_TO)
    let screen = ''
    for (let i = 0; i < 20_000; i++) screen = acc.push(`line-${i}\n`)
    expect(Buffer.byteLength(screen, 'utf8')).toBeLessThanOrEqual(CAP)
    expect(screen.endsWith('\n')).toBe(true)
    const lines = screen.split('\n').filter((l) => l !== '')
    expect(lines[lines.length - 1]).toBe('line-19999')
    // No line was joined to its neighbour by the trim.
    expect(lines.every((l) => /^line-\d+$/.test(l))).toBe(true)
  })

  it('CLAMPS AMORTISED, not on every chunk — the low-water mark is load-bearing', () => {
    // Trimming back to exactly the cap means the next chunk is over it again and the
    // O(screen) clamp runs per chunk, which is the quadratic shape this branch already
    // removed from the herdr client. Cutting to a low-water mark buys a quarter of the
    // budget between clamps. Counted through the one observable a pure accumulator has:
    // the screen SHRINKING.
    const acc = newScreenAccumulator(CAP, TRIM_TO)
    let prev = 0
    let clamps = 0
    // Measured over the SECOND HALF, once the accumulator is saturated. The first
    // half contains the one-off climb from empty to the cap, and a peak recorded there
    // is not evidence the budget is still being used later — which is exactly how a
    // stale byte counter hid (it clamps on every chunk forever AFTER that first peak).
    let maxWhenSaturated = 0
    for (let i = 0; i < 3000; i++) {
      const size = Buffer.byteLength(acc.push('x'.repeat(1024)), 'utf8')
      if (size < prev) clamps += 1
      if (i >= 1500) maxWhenSaturated = Math.max(maxWhenSaturated, size)
      prev = size
    }
    // 3 MB through a 64 KiB cap with a 16 KiB gap is ~187 clamps, not ~3000. This is
    // what reddens a clamp that trims back to the CAP instead of the low-water mark.
    expect(clamps).toBeGreaterThan(0)
    expect(clamps).toBeLessThan(300)
    // AND the accumulation is allowed to USE its budget between clamps. Needed as its
    // own assertion: a counter that is never refreshed after a clamp stays permanently
    // over the cap, so the clamp runs on every chunk and the screen is pinned at the
    // low-water mark — which produces no strict SHRINKS at all and is therefore
    // invisible to the count above (verified: that mutation survived until this line).
    expect(maxWhenSaturated).toBeGreaterThan(CAP - 2048)
    expect(maxWhenSaturated).toBeLessThanOrEqual(CAP)
  })
})

/**
 * THE SHORT-WRITE GUARD, TESTED THROUGH THE SEAM — because it cannot be tested through
 * a pty. A real pty does not short-write the small payloads `submitLine` sends, so a
 * mutation deleting the check survived every end-to-end case here. That was recorded as
 * an uncovered boundary rather than papered over, and this is the fix: the write
 * function is an argument, so zero and partial acceptance are ordinary inputs.
 */
describe('a short pty write is a failed submit, not a silent partial one', () => {
  it('a write the kernel REFUSES ENTIRELY is reported', () => {
    expect(() => writeAllOrThrow(() => 0, '/compact', "'/compact'")).toThrow(
      /short write of '\/compact' — the pty accepted 0 of 8 bytes/,
    )
  })

  it('a PARTIAL write is reported — a half-delivered command is not a delivered one', () => {
    expect(() => writeAllOrThrow(() => 3, '/compact', "'/compact'")).toThrow(
      /accepted 3 of 8 bytes/,
    )
  })

  it('CONTROL — a write the kernel takes in full raises nothing', () => {
    let sent: string | Uint8Array | undefined
    expect(() =>
      writeAllOrThrow((d) => {
        sent = d
        return Buffer.byteLength(d as string, 'utf8')
      }, '/compact', "'/compact'"),
    ).not.toThrow()
    expect(sent).toBe('/compact')
  })

  // BYTES, NOT UTF-16 UNITS, and only a multibyte payload can tell them apart. `é` is
  // one code unit and two bytes, so a write that accepted exactly the code-unit count
  // delivered HALF the payload — and a `.length` comparison calls that complete. The
  // same confusion was fixed three times on the herdr side of this branch.
  it('measures BYTES — a write accepting the UTF-16 unit count is still short', () => {
    const text = 'éé' // 2 code units, 4 bytes
    expect(() => writeAllOrThrow(() => text.length, text, 'the text')).toThrow(
      /accepted 2 of 4 bytes/,
    )
  })

  it('CONTROL — a multibyte write accepting all its BYTES is accepted', () => {
    const text = 'éé'
    expect(() =>
      writeAllOrThrow(() => Buffer.byteLength(text, 'utf8'), text, 'the text'),
    ).not.toThrow()
  })

  it('a Uint8Array payload is measured by its own length, not re-encoded', () => {
    const bytes = new Uint8Array([0x0d])
    expect(() => writeAllOrThrow(() => 0, bytes, "the 'enter' key")).toThrow(
      /accepted 0 of 1 bytes/,
    )
    expect(() => writeAllOrThrow(() => 1, bytes, "the 'enter' key")).not.toThrow()
  })
})

/**
 * THE GUARD'S WIRING, which a pure helper could not reach.
 *
 * Extracting `writeAllOrThrow` made the CHECK assertable; it did not make it assertable
 * that `submitLine` still calls it. The mutation that replaces both calls with bare
 * `terminal.write` survived every test above, because no real pty will short-write an
 * eight-byte payload. So the terminal is injectable — the same seam `HerdrHost` has for
 * its socket, for the same reason.
 */
describe('submitLine is WIRED to the short-write guard, not merely accompanied by it', () => {
  /** A host whose pty accepts `accept(data)` bytes of each write. */
  function hostWithPty(accept: (data: string | Uint8Array) => number): {
    host: BunTerminalHost
    writes: (string | Uint8Array)[]
  } {
    const writes: (string | Uint8Array)[] = []
    const host = new BunTerminalHost({
      createTerminal: () => ({
        // `Bun.Terminal.write` is typed `string | ArrayBufferView`; this host only ever
        // hands it the narrower `string | Uint8Array`, which is what the guard measures.
        write: (d: string | ArrayBufferView) => {
          const payload = typeof d === 'string' ? d : new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
          writes.push(payload)
          return accept(payload)
        },
        resize: () => undefined,
        close: () => undefined,
      }),
      spawn: () => ({
        pid: 4242,
        exited: new Promise<number | null>(() => {}), // never exits during the test
        exitCode: null,
        kill: () => undefined,
      }),
    })
    return { host, writes }
  }

  const full = (d: string | Uint8Array): number =>
    typeof d === 'string' ? Buffer.byteLength(d, 'utf8') : d.length

  it('a pty that REFUSES the text makes submitLine reject — and the Enter is not sent', async () => {
    const { host, writes } = hostWithPty(() => 0)
    const child = await host.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    await expect(child.submitLine!('/compact')).rejects.toThrow(/short write of "\/compact"/)
    // A REFUSED TEXT MUST LEAVE THE ENTER UNSENT. A blind Enter after a text that did
    // not land submits whatever was already on the line — the exact failure the
    // acknowledged seam exists to prevent, and it is only visible here because the
    // refusal can be arranged at all.
    expect(writes).toEqual(['/compact'])
  })

  it('a pty that takes the text but REFUSES the Enter also rejects', async () => {
    let n = 0
    const { host } = hostWithPty((d) => (n++ === 0 ? full(d) : 0))
    const child = await host.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    await expect(child.submitLine!('/compact')).rejects.toThrow(/short write of the 'enter' key/)
  })

  it('CONTROL — a pty that takes everything resolves, and sends text THEN enter', async () => {
    const { host, writes } = hostWithPty(full)
    const child = await host.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    await child.submitLine!('/compact')
    expect(writes.length).toBe(2)
    expect(writes[0]).toBe('/compact')
    expect(String(writes[1])).toBe('\r')
  })
})

/**
 * A FAILED SPAWN LEAVES NOTHING ALLOCATED — the third appearance of one rule on this
 * branch, and the first two are why these cases exist. The host learned it as
 * `abandonPane`; the live E2E suites learned it again by leaking four real panes into
 * the owner's herdr because their spawn sat outside the `try`. It was still here: by the
 * time `Bun.spawn` runs, the readiness timer is armed and the pty is allocated, so an
 * executable that does not exist rejects out of `spawn()` with an open terminal and, five
 * seconds later, a `beginOutput()` wiring warning about a child that was never created.
 */
describe('a failed spawn leaves no terminal open and no timer armed', () => {
  it('a SPAWN that throws closes the terminal that was already allocated', async () => {
    let closes = 0
    const host = new BunTerminalHost({
      createTerminal: () => ({
        write: () => 0,
        resize: () => undefined,
        close: () => {
          closes += 1
        },
      }),
      spawn: () => {
        throw new Error('ENOENT: no such file or directory')
      },
    })
    await expect(host.spawn(['/nope'], { cwd: '/tmp', env: {} })).rejects.toThrow(/ENOENT/)
    // The pty existed before the failure, so the failure owns it.
    expect(closes).toBe(1)
  })

  it('a CREATE that throws is also handled — nothing to close, but the timer is armed', async () => {
    const host = new BunTerminalHost({
      createTerminal: () => {
        throw new Error('pty allocation refused')
      },
      spawn: () => {
        throw new Error('must not be reached')
      },
    })
    await expect(host.spawn(['/nope'], { cwd: '/tmp', env: {} })).rejects.toThrow(
      /pty allocation refused/,
    )
  })

  it('the readiness timer is DISARMED — no wiring warning about a child that never existed', async () => {
    // The warning is the visible half: a caller that never called `beginOutput()` on a
    // child it never received would be told it had a WIRING BUG. Short gate so the
    // timer would have fired well inside this case.
    let closes = 0
    const host = new BunTerminalHost({
      createTerminal: () => ({
        write: () => 0,
        resize: () => undefined,
        close: () => {
          closes += 1
        },
      }),
      spawn: () => {
        throw new Error('ENOENT')
      },
      outputGateMaxMs: 20,
    })
    const errs = await withCapturedStderr(async () => {
      await host.spawn(['/nope'], { cwd: '/tmp', env: {} }).catch(() => undefined)
      await Bun.sleep(120) // well past the gate
    })
    expect(closes).toBe(1)
    expect(errs.filter((e) => e.includes('beginOutput() was not called'))).toEqual([])
  })

  it('CONTROL — a SUCCESSFUL spawn closes nothing and still arms the gate', async () => {
    // Or "closes on failure" is satisfied by a host that closes unconditionally, and
    // "disarms on failure" by one that never arms at all.
    let closes = 0
    const host = new BunTerminalHost({
      createTerminal: () => ({
        write: () => 0,
        resize: () => undefined,
        close: () => {
          closes += 1
        },
      }),
      spawn: () => ({
        pid: 77,
        exited: new Promise<number | null>(() => {}),
        exitCode: null,
        kill: () => undefined,
      }),
      outputGateMaxMs: 20,
    })
    const errs = await withCapturedStderr(async () => {
      const child = await host.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
      expect(child.pid).toBe(77)
      await Bun.sleep(120) // the caller never releases the gate
    })
    expect(closes).toBe(0)
    // The gate WAS armed, so the fail-open warning is the proof it is still doing its job.
    expect(errs.filter((e) => e.includes('beginOutput() was not called')).length).toBe(1)
  })
})

/**
 * The other half of "the exit settles, it does not release": what the pty held must
 * still ARRIVE. The conformance case asserts the contract both backends share — nothing
 * before `beginOutput()` — and can only assert delivery conditionally, because herdr's
 * pane vanishes taking its output with it and has nothing to hand over. This host DOES,
 * and that is the reason the release-on-exit version was written in the first place: a
 * dead child's last screen is the only record of what it printed.
 */
describe('a child that has ALREADY exited still hands over what it printed', () => {
  function immediatelyDeadHost(screenText: string): BunTerminalHost {
    return new BunTerminalHost({
      createTerminal: (o) => {
        const term = { write: () => 0, resize: () => undefined, close: () => undefined }
        o.data?.(term, new TextEncoder().encode(screenText))
        return term
      },
      spawn: () => ({
        pid: 909,
        exited: Promise.resolve(0), // already resolved when `spawn()` returns
        exitCode: 0,
        kill: () => undefined,
      }),
      outputGateMaxMs: 60_000,
    })
  }

  it('holds it past the exit, then delivers it at beginOutput()', async () => {
    const screens: string[] = []
    const child = await immediatelyDeadHost('FATAL: could not start\n').spawn(['/bin/false'], {
      cwd: '/tmp',
      env: {},
      onScreen: (s) => screens.push(s),
    })
    await Bun.sleep(30)
    expect(screens).toEqual([]) // the exit did not release it
    expect(child.hasExited()).toBe(true) // ...and the exit DID settle, independently
    child.beginOutput?.()
    await Bun.sleep(30)
    expect(screens.length).toBe(1)
    expect(screens[0]).toContain('FATAL: could not start')
  })

  it('the fail-open timer still delivers it to a caller that never releases', async () => {
    // Withholding forever is the other failure. A caller with a wiring bug gets the
    // dead child's last screen late and loudly, rather than never.
    const screens: string[] = []
    const host = new BunTerminalHost({
      createTerminal: (o) => {
        const term = { write: () => 0, resize: () => undefined, close: () => undefined }
        o.data?.(term, new TextEncoder().encode('last words\n'))
        return term
      },
      spawn: () => ({
        pid: 910,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => undefined,
      }),
      outputGateMaxMs: 20,
    })
    const errs = await withCapturedStderr(async () => {
      await host.spawn(['/bin/false'], { cwd: '/tmp', env: {}, onScreen: (s) => screens.push(s) })
      await Bun.sleep(120) // `beginOutput()` is DELIBERATELY never called
    })
    expect(screens.some((s) => s.includes('last words'))).toBe(true)
    expect(errs.filter((e) => e.includes('beginOutput() was not called')).length).toBe(1)
  })
})

/**
 * A SIGNAL THAT THREW WAS NEVER DELIVERED — the row missing from a table built entirely
 * from operations that work.
 *
 * Every other kill case here uses a `proc.kill` that succeeds, and **a host whose signal
 * cannot fail cannot test what a failed signal leaves behind.** The flag asserting the
 * termination survived the failure, and `spawn.ts` evaluates
 * `!killedByUs && exitCode !== 0` — so the child's later NONZERO exit, a real crash since
 * nothing killed it, classified as a clean recycle.
 *
 * TWO FACTS, TWO CASES. Clearing the flag is one; guarding that clear on liveness is the
 * other, and dropping either must redden a different test — otherwise the pair is one
 * test written twice.
 */
describe('a kill that could not be delivered leaves no claim that it was', () => {
  /** A host whose `proc.kill` throws, and whose exit is resolved on demand. */
  function hostWithFailingSignal(): {
    host: BunTerminalHost
    endWith: (code: number) => void
    killAttempts: () => number
  } {
    let endWith: (code: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      endWith = res
    })
    let attempts = 0
    const host = new BunTerminalHost({
      createTerminal: () => ({ write: () => 0, resize: () => undefined, close: () => undefined }),
      spawn: () => ({
        pid: 5150,
        exited: exitedPromise,
        exitCode: null,
        kill: () => {
          attempts += 1
          throw new Error('EPERM: operation not permitted')
        },
      }),
      outputGateMaxMs: 60_000,
    })
    return { host, endWith: (c) => endWith(c), killAttempts: () => attempts }
  }

  /** The exact expression `spawn.ts` evaluates. */
  const classify = (exitCode: number | null, killedByUs: boolean): 'crash' | 'clean' =>
    !killedByUs && exitCode !== 0 ? 'crash' : 'clean'

  it('a TERMINAL kill that throws leaves wasKilledByUs FALSE, so a later crash reads as a crash', async () => {
    const f = hostWithFailingSignal()
    const child = await f.host.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    const errs = await withCapturedStderr(async () => {
      child.kill()
    })
    expect(f.killAttempts()).toBe(1) // it really was attempted
    expect(child.wasKilledByUs?.()).toBe(false)
    // ...and the failure is said out loud, naming the consequence rather than the errno.
    expect(errs.filter((e) => e.includes('was NOT delivered')).length).toBe(1)
    // THE CONSEQUENCE, through the expression that actually decides it.
    f.endWith(1)
    const code = await child.exited
    expect(classify(code, child.wasKilledByUs?.() ?? false)).toBe('crash')
  })

  it('a SIGINT that throws clears its own flag, not the terminal one', async () => {
    const f = hostWithFailingSignal()
    const child = await f.host.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    await withCapturedStderr(async () => {
      child.kill('SIGINT')
    })
    expect(child.wasInterruptedByUs?.()).toBe(false)
    expect(child.wasKilledByUs?.()).toBe(false)
  })

  it('a signal that throws AFTER the exit has settled does NOT clear the flag', async () => {
    // THE OPPOSITE DIRECTION, and the same defect: a cleanup path that never asked
    // whether the question was still open. `proc.kill` can throw precisely BECAUSE the
    // child has already gone — and clearing then would rewrite a deliberate recycle into
    // an apparent crash, after it had settled.
    let endWith: (code: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      endWith = res
    })
    let killThrows = false
    const host = new BunTerminalHost({
      createTerminal: () => ({ write: () => 0, resize: () => undefined, close: () => undefined }),
      spawn: () => ({
        pid: 5151,
        exited: exitedPromise,
        exitCode: null,
        kill: () => {
          if (killThrows) throw new Error('ESRCH: no such process')
        },
      }),
      outputGateMaxMs: 60_000,
    })
    const child = await host.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    child.kill() // succeeds: the flag latches, legitimately
    expect(child.wasKilledByUs?.()).toBe(true)
    endWith(0)
    await child.exited
    // A SECOND attempt — the escalation ladder's SIGKILL rung — now throws because the
    // process is gone. The flag must survive it.
    killThrows = true
    await withCapturedStderr(async () => {
      child.kill('SIGKILL')
    })
    expect(child.wasKilledByUs?.()).toBe(true)
    expect(classify(0, child.wasKilledByUs?.() ?? false)).toBe('clean')
  })

  it('an already-exited child is not signalled AT ALL — the guard that actually runs', async () => {
    // The entry guard's own observable. Without it, `kill()` after the exit still
    // attempts the signal, and the two liveness guards stop being a redundant pair with
    // one of them load-bearing for the flag: this is what makes dropping the TOP one
    // visible on its own rather than only in combination.
    let endWith: (code: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      endWith = res
    })
    let attempts = 0
    const host = new BunTerminalHost({
      createTerminal: () => ({ write: () => 0, resize: () => undefined, close: () => undefined }),
      spawn: () => ({
        pid: 5154,
        exited: exitedPromise,
        exitCode: null,
        kill: () => {
          attempts += 1
        },
      }),
      outputGateMaxMs: 60_000,
    })
    const child = await host.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    endWith(0)
    await child.exited
    child.kill()
    child.kill('SIGINT')
    expect(attempts).toBe(0)
  })

  it('a failing SIGINT does NOT erase a termination that was already recorded', async () => {
    // The clear must be as narrow as the latch. A widened clear — a failing interrupt
    // resetting BOTH flags — would erase a real, delivered termination and turn the
    // recycle that followed it into an apparent crash. The SIGINT-only case above
    // cannot see that: both flags are false there either way.
    let endWith: (code: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      endWith = res
    })
    let killThrows = false
    const host = new BunTerminalHost({
      createTerminal: () => ({ write: () => 0, resize: () => undefined, close: () => undefined }),
      spawn: () => ({
        pid: 5153,
        exited: exitedPromise,
        exitCode: null,
        kill: () => {
          if (killThrows) throw new Error('EPERM')
        },
      }),
      outputGateMaxMs: 60_000,
    })
    const child = await host.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    child.kill() // delivered: the terminal flag latches legitimately
    expect(child.wasKilledByUs?.()).toBe(true)
    killThrows = true
    await withCapturedStderr(async () => {
      child.kill('SIGINT') // an interrupt that could not be delivered
    })
    expect(child.wasKilledByUs?.()).toBe(true) // untouched
    expect(child.wasInterruptedByUs?.()).toBe(false) // its own flag cleared
    endWith(0)
    await child.exited
  })

  it('CONTROL — a kill that SUCCEEDS still latches, and says nothing', async () => {
    // Or "clear on failure" is satisfied by a host that never latches at all, and the
    // whole discriminator is gone in the other direction.
    let endWith: (code: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      endWith = res
    })
    const host = new BunTerminalHost({
      createTerminal: () => ({ write: () => 0, resize: () => undefined, close: () => undefined }),
      spawn: () => ({ pid: 5152, exited: exitedPromise, exitCode: null, kill: () => undefined }),
      outputGateMaxMs: 60_000,
    })
    const child = await host.spawn(['/bin/cat'], { cwd: '/tmp', env: {} })
    child.beginOutput?.()
    const errs = await withCapturedStderr(async () => {
      child.kill()
    })
    expect(child.wasKilledByUs?.()).toBe(true)
    expect(errs.filter((e) => e.includes('was NOT delivered'))).toEqual([])
    endWith(1)
    expect(classify(await child.exited, child.wasKilledByUs?.() ?? false)).toBe('clean')
  })
})
