/**
 * pty-host.ts — the host-boundary abstraction for spawning the interactive
 * `claude` REPL on a real PTY.
 *
 * § Sprint-1 deliverable #1 + § 2 (HOST-BOUNDARY decision). The lifted
 * lifecycle/supervision logic (session-capture, post-spawn-assertion, the
 * Sprint-2 watchdogs) talks ONLY to `PtyHost` — never to tmux or a specific
 * PTY library. That keeps the substrate portable: the default backend is
 * Bun-native (`Bun.spawn({ terminal })`, POSIX, see `bun-terminal-host.ts`);
 * a Windows ConPTY backend can later slot behind the same interface for the
 * Open tier without touching any lifted logic.
 *
 * KEY REALISATION (§ 2): tmux was never part of Nova's substrate — it was a
 * PID-keepalive + human-attach convenience. The actual turn I/O (dev-channel
 * MCP in, `reply` tool out) never touches tmux keystrokes. So the lift drops
 * tmux entirely and allocates the PTY directly. The interactive `claude` TUI
 * needs a real TTY (`process.stdout.isTTY` must be true — it's an Ink/React
 * terminal app), so a PTY is required; tmux is not.
 */

import type { Key } from './keystrokes.ts'

/** A spawned child attached to a PTY. The lifecycle/supervision logic
 *  consumes exactly this shape regardless of the underlying PTY backend. */
export interface PtyChild {
  /** OS process id of the spawned child. */
  readonly pid: number
  /** Write bytes to the PTY master → the child's stdin. The fundamental write
   *  seam; every backend implements it, and `writeKey`/`writeKeys` are sugar
   *  over it (the substrate degrades to `write(encodeKeys(...))` when a backend
   *  predates them — see `sendKeys` in `persistent-repl-substrate.ts`). */
  write(data: string | Uint8Array): void
  /** Send one structured key (F2): encodes the correct terminal bytes for
   *  enter/escape/ctrl-c/up/down/left/right/digit. Lets recovery detectors
   *  navigate Ink arrow-pickers + send Escape/Ctrl-C, which raw `write('\r')`
   *  cannot. No-op-safe after exit. OPTIONAL: a backward-compatible extension —
   *  every real PTY backend (`bun-terminal-host.ts`) provides it; lightweight
   *  test fakes that never receive keystrokes may omit it. */
  writeKey?(key: Key): void
  /** Send a multi-key sequence as one write (e.g. `['down','enter']` to pick the
   *  second option of an arrow-driven picker). No-op-safe after exit. OPTIONAL
   *  (see `writeKey`). */
  writeKeys?(keys: readonly Key[]): void
  /** Resize the PTY (cols × rows). No-op-safe after exit. */
  resize(cols: number, rows: number): void
  /** Send a signal to the child (default SIGTERM). Idempotent after exit. */
  kill(signal?: NodeJS.Signals | number): void
  /** Resolves with the child's exit code (or null on signal) when it exits. */
  readonly exited: Promise<number | null>
  /** True once the child has exited. */
  readonly hasExited: () => boolean
}

/** Options for spawning a PTY-hosted child. */
export interface PtySpawnOpts {
  /** Working directory for the child. */
  cwd: string
  /**
   * Environment for the child. Passed verbatim — the caller is responsible
   * for the auth scrub (unset `ANTHROPIC_API_KEY` / set
   * `CLAUDE_CODE_OAUTH_TOKEN`). `undefined` values are dropped.
   */
  env: Record<string, string | undefined>
  /**
   * Callback for every chunk the PTY master emits (child stdout/stderr,
   * already running through `stripPtyNoise`). Used for the liveness ring
   * buffer + Sprint-2 login/banner watchdogs. The substrate does NOT parse
   * this for the turn answer — that flows via the dev-channel `reply` tool.
   */
  onData?: (chunk: Uint8Array) => void
  /** Callback when the PTY stream closes (EOF / read error). */
  onExit?: (code: number | null) => void
  /** Initial terminal size. Default 120×40. */
  cols?: number
  rows?: number
}

/** The host-boundary interface. One method: spawn an argv on a PTY. */
export interface PtyHost {
  spawn(argv: string[], opts: PtySpawnOpts): PtyChild
}
