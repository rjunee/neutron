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
