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

/** A spawned child attached to a PTY. The lifecycle/supervision logic
 *  consumes exactly this shape regardless of the underlying PTY backend. */
export interface PtyChild {
  /** OS process id of the spawned child. */
  readonly pid: number
  /** Write bytes to the PTY master → the child's stdin. */
  write(data: string | Uint8Array): void
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
