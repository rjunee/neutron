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
import { bunTerminalHost } from '../bun-terminal-host.ts'
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
