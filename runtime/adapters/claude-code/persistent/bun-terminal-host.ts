/**
 * bun-terminal-host.ts — the DEFAULT `PtyHost` backend: Bun's native PTY.
 *
 * § 2 recommendation. `new Bun.Terminal({ cols, rows, data, exit })` +
 * `Bun.spawn(argv, { terminal })` attaches a real PTY to the child (child sees
 * `process.stdout.isTTY === true`). This replaces BOTH Nova's `pty-spawn.ts`
 * libc-FFI `posix_openpt` hack AND the tmux host with one first-party Bun API:
 * no native module, no `dlopen`, no `tmux -CC` TTY-coercion. POSIX-only today
 * (Linux + macOS), which is exactly the Managed-VPS + Open-Mac/Linux surface
 * Sprint 1 ships on. Windows (Open tier) gets a `node-pty`/ConPTY backend
 * behind this same interface in a later sprint.
 *
 * Verified on Bun 1.3.9: the `data(term, bytes)` callback delivers child
 * output; `terminal.write()` reaches child stdin; the child reports a TTY.
 * Bun floor: ≥ 1.3.5 (when `Bun.Terminal` landed).
 */

import { stripPtyNoise, newDcsStripState, type DcsStripState } from './pty-noise.ts'
import { encodeKey, encodeKeys, type Key } from './keystrokes.ts'
import type { PtyChild, PtyHost, PtySpawnOpts } from './pty-host.ts'

/** Minimal shape of `Bun.Terminal` we consume (kept narrow so the file type-
 *  checks even where the ambient Bun types lag the runtime). */
interface BunTerminalLike {
  write(data: string | ArrayBufferView): number
  resize(cols: number, rows: number): void
  close(): void
}
interface BunTerminalCtor {
  new (opts: {
    cols?: number
    rows?: number
    data?: (term: BunTerminalLike, bytes: Uint8Array) => void
    exit?: (term: BunTerminalLike, code: number, signal: string | null) => void
  }): BunTerminalLike
}
interface BunSpawnedLike {
  readonly pid: number
  readonly exited: Promise<number | null>
  readonly exitCode: number | null
  kill(signal?: NodeJS.Signals | number): void
}

const BunTerminal = (Bun as unknown as { Terminal: BunTerminalCtor }).Terminal
const bunSpawn = (
  Bun as unknown as { spawn: (opts: Record<string, unknown>) => BunSpawnedLike }
).spawn

/** Drop `undefined`-valued keys so the child sees only real env vars (the
 *  auth-scrub contract relies on the caller passing `KEY: undefined` to mean
 *  "unset" — we honour that by not forwarding it). */
function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

export class BunTerminalHost implements PtyHost {
  spawn(argv: string[], opts: PtySpawnOpts): PtyChild {
    if (argv.length === 0) {
      throw new Error('bun-terminal-host: argv must be non-empty')
    }
    const stripState: DcsStripState = newDcsStripState()
    let exited = false
    let exitResolve: (code: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      exitResolve = res
    })

    const terminal = new BunTerminal({
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      data: (_t, bytes) => {
        if (opts.onData === undefined) return
        const clean = stripPtyNoise(bytes, stripState)
        if (clean.length > 0) opts.onData(clean)
      },
    })

    const proc = bunSpawn({
      cmd: argv,
      cwd: opts.cwd,
      env: compactEnv(opts.env),
      terminal,
    })

    // Surface the real subprocess exit (the Terminal `exit` cb reports PTY
    // lifecycle, not the child exit code — per Bun docs we use proc.exited).
    void proc.exited.then((code) => {
      exited = true
      try {
        terminal.close()
      } catch {
        // best-effort
      }
      if (opts.onExit !== undefined) opts.onExit(code)
      exitResolve(code)
    })

    const child: PtyChild = {
      pid: proc.pid,
      write(data) {
        if (exited) return
        terminal.write(data)
      },
      writeKey(key: Key) {
        if (exited) return
        terminal.write(encodeKey(key))
      },
      writeKeys(keys: readonly Key[]) {
        if (exited) return
        if (keys.length === 0) return
        terminal.write(encodeKeys(keys))
      },
      resize(cols, rows) {
        if (exited) return
        try {
          terminal.resize(cols, rows)
        } catch {
          // best-effort; terminal may have closed
        }
      },
      kill(signal) {
        if (exited) return
        try {
          proc.kill(signal)
        } catch {
          // already gone
        }
      },
      exited: exitedPromise,
      hasExited: () => exited,
    }
    return child
  }
}

/** Default singleton — the POSIX Bun-native backend. */
export const bunTerminalHost: PtyHost = new BunTerminalHost()
