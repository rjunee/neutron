/**
 * orphan-adoption.ts — cross-restart orphan-REPL identity check (ISSUES #105).
 *
 * Closes the gap the substrate-lift S2 supervision brief explicitly scoped OUT.
 *
 * THE BUG. `makeReplRespawnDeps.killChild` only terminates a child the *current*
 * gateway incarnation still holds in the in-memory `childByKey` mirror. After a
 * gateway restart that mirror is empty, but a prior incarnation may have left a
 * `claude --resume` STILL RUNNING — its pid survives only in the persisted
 * registry. `probeReplLiveness` can flag that session as wedged from the recorded
 * pid alone (dead dev-channel), so the watchdog fires a respawn. With the old
 * process invisible to `killChild`, the respawn would launch a SECOND
 * `claude --resume` for the same session UUID while the first keeps running —
 * two processes writing one transcript.
 *
 * WHY NOT A BLIND KILL. A naive `process.kill(record.pid)` is UNSAFE: across a
 * restart the OS may have RECYCLED that pid onto an unrelated process, so killing
 * it blind could SIGTERM something else. The safe fix is an *identity check*:
 * before adopting-or-killing the recorded pid, VERIFY it is actually OUR claude.
 *
 * The check matches the EXACT `claude` REPL invocation shape that
 * `build-repl-argv.ts` emits — NOT loose substrings. A loose "cmdline contains
 * 'claude' AND contains the session uuid" check is too weak: a RECYCLED pid
 * running `tail -f …/.claude/projects/…/<uuid>.jsonl` (or an editor with that
 * transcript open) carries BOTH tokens — the transcript path lives under
 * `.claude/` (so the `claude` substring is present) AND embeds the session uuid
 * (so the uuid substring is present) — yet it is NOT our process. SIGKILLing it
 * would violate the recycled-pid-safety invariant this module exists to provide.
 * So `cmdlineMatchesSession` instead requires ALL of: (a) argv[0]'s basename is a
 * real `claude` invocation (the `claude` wrapper, or a node/bun runtime running a
 * claude script) — NOT `tail`/`vim`/`less`/etc; AND (b) the session UUID appears
 * as the VALUE of `--resume`/`--session-id` (the token immediately after the
 * flag, exactly as `buildReplArgv` pushes it) — NOT merely as a substring
 * anywhere in the cmdline. A dead pid, or a cmdline that does not match
 * (recycled / unrelated), is LEFT UNTOUCHED.
 *
 * PLATFORM. The dev box is darwin (no `/proc`); prod is Linux. `ps -p <pid> -o
 * command=` prints the full argv on BOTH (BSD `command` + GNU `command` columns
 * both expand to the args; the trailing `=` suppresses the header). So this layer
 * reads the cmdline via `ps`, NOT `/proc`, and is correct on macOS and Linux
 * alike. Documented assumption: any platform whose `ps` lacks `-o command=`
 * (none we target) degrades to `readCmdline → undefined → 'not-ours' → no kill`,
 * which is the SAFE direction (never kills an unverified pid).
 */

import { spawnSync } from 'node:child_process'

/** Verdict for one orphan-adoption attempt. */
export type OrphanAdoptionVerdict =
  | 'killed' // pid was verified-ours → terminated before the resume spawns
  | 'not-ours' // pid alive but cmdline does not match → recycled/unrelated → untouched
  | 'dead' // pid not alive → nothing to adopt
  | 'no-pid' // record carried no usable pid → nothing to do

/** Injected side-effect surface so the identity check is fully unit-testable
 *  without touching the real OS / process table. */
export interface OrphanAdoptionDeps {
  /** `kill -0` liveness probe. */
  isPidAlive: (pid: number) => boolean
  /** Full cmdline for `pid`, or undefined if it cannot be read / pid is gone. */
  readCmdline: (pid: number) => string | undefined
  /** Terminate the VERIFIED-ours pid (SIGTERM → SIGKILL on overstay). Async — the
   *  caller awaits it before spawning the `--resume` replacement so exactly one
   *  process owns the session transcript. */
  terminatePid: (pid: number) => Promise<void>
  log?: (msg: string) => void
}

/** Basename of a path-ish argv token (last `/`-delimited segment). Pure string
 *  op — never touches the filesystem. `'/Users/x/.local/bin/claude' → 'claude'`,
 *  `'claude' → 'claude'`. Exported so the `killChild` call site derives the
 *  CONFIGURED binary basename (from `options.claude_bin` / `CLAUDE_BIN`) with the
 *  EXACT same rule the matcher applies to argv[0]. */
export function basenameOf(token: string): string {
  const slash = token.lastIndexOf('/')
  return slash >= 0 ? token.slice(slash + 1) : token
}

/**
 * Is argv[0] a genuine `claude` invocation — NOT a recycled `tail`/`vim`/`less`/
 * editor that merely has a transcript path (under `.claude/`, embedding the uuid)
 * in its args? `claudeBasename` is the CONFIGURED binary basename — `'claude'` by
 * default, or the basename of a `CLAUDE_BIN` / `options.claude_bin` override (e.g.
 * `'claude-headless'` for `CLAUDE_BIN=/opt/bin/claude-headless`). It MUST equal the
 * basename of whatever `buildReplArgv` pushed as argv[0], else this gate rejects
 * our OWN orphan on the binary-override surface (Argus r3 BLOCKER). True when
 * EITHER:
 *   - argv[0]'s basename is exactly `claudeBasename` (the prod shape: `buildReplArgv`
 *     pushes `claudeBin` — default `claude`, or a path like `/…/bin/claude-headless`
 *     whose basename is the configured value — as argv[0]); OR
 *   - argv[0] is a node/bun/deno runtime AND the SCRIPT slot — `tokens[1]`, the
 *     FIRST token after the interpreter, exactly where `buildReplArgv` puts the
 *     claude script in a `<interpreter> <claude-script> --flags…` launch — has
 *     BASENAME `claudeBasename` (covers a `#!/usr/bin/env node`-shebang launcher on
 *     platforms where `ps` surfaces the interpreter as argv[0]: `node …/claude
 *     --resume …`). The marker is a PATH-SEGMENT (basename) match, NOT a substring
 *     (Argus r2): a SIGKILL gate must require EXACT shape, so a recycled
 *     `node /opt/claude-tools/runner.js --resume <uuid>` — whose path merely
 *     CONTAINS `/claude` but whose basename is `runner.js` — is REJECTED. We check
 *     ONLY the script slot (`tokens[1]`), NOT every positional arg before the first
 *     flag (Argus r4): a recycled `node /opt/runner.js /tmp/claude --resume <uuid>`
 *     puts an UNRELATED script (`runner.js`) in the slot our binary would occupy and
 *     only carries a `claude`-basename token as a LATER positional APP arg — that is
 *     NOT our launch shape, so it is REJECTED. Our spawn path can only ever produce a
 *     `claudeBasename`-basename script in `tokens[1]` (the file `buildReplArgv` names
 *     IS the configured binary, run directly or via a node shebang), so a `tokens[1]`
 *     basename match is both sufficient (no false-negative) and exact.
 * A `tail`/`vim`/`less`/`cat` argv[0] matches neither arm → false. Pure — no IO.
 */
function argv0IsClaude(tokens: ReadonlyArray<string>, claudeBasename: string): boolean {
  const argv0 = tokens[0]
  if (argv0 === undefined) return false
  const exe = basenameOf(argv0)
  if (exe === claudeBasename) return true
  if (/^(?:node|nodejs|bun|deno)$/.test(exe)) {
    // Our launch is ALWAYS `<interpreter> <claude-script> --flags…`, so the claude
    // identity is the SCRIPT slot (tokens[1]) — NOT any later positional app arg.
    const script = tokens[1]
    if (script !== undefined && !script.startsWith('-') && basenameOf(script) === claudeBasename) {
      return true
    }
  }
  return false
}

/**
 * Does `cmdline` identify OUR `claude --resume`/`--session-id` REPL for
 * `sessionId`? Matches the EXACT invocation shape `buildReplArgv` emits, NOT loose
 * substrings (see the file header for why substring-matching is unsafe).
 * `claudeBasename` is the CONFIGURED binary basename (default `'claude'`; the
 * basename of a `CLAUDE_BIN` / `options.claude_bin` override otherwise) — see
 * `argv0IsClaude`. ALL must hold:
 *   1. argv[0] is a real `claudeBasename` invocation (`argv0IsClaude`) — a recycled
 *      `tail`/editor with the transcript path open FAILS here even though the path
 *      sits under `.claude/` and embeds the uuid; AND
 *   2. the session UUID appears as the VALUE of `--resume` or `--session-id` — the
 *      token IMMEDIATELY after the flag, exactly as `buildReplArgv` pushes the
 *      `['--resume', sessionId]` / `['--session-id', sessionId]` pair — NOT merely
 *      as a substring (a transcript path argument does NOT satisfy this).
 * Pure — no IO.
 */
export function cmdlineMatchesSession(
  cmdline: string | undefined,
  sessionId: string,
  claudeBasename: string = 'claude',
): boolean {
  if (!cmdline || !sessionId) return false
  const tokens = cmdline.trim().split(/\s+/).filter((t) => t.length > 0)
  // Need at least `<claude> --resume <id>` (or `--session-id`): 3 tokens.
  if (tokens.length < 3) return false
  // (1) argv[0] must be a genuine claude invocation — excludes tail/vim/less/etc.
  if (!argv0IsClaude(tokens, claudeBasename)) return false
  // (2) sessionId must be the VALUE immediately following --resume / --session-id.
  for (let i = 1; i + 1 < tokens.length; i++) {
    if (
      (tokens[i] === '--resume' || tokens[i] === '--session-id') &&
      tokens[i + 1] === sessionId
    ) {
      return true
    }
  }
  return false
}

/** Default `readCmdline` for darwin + Linux. `ps -p <pid> -o command=` prints the
 *  full argv with no header on both platforms. Returns undefined on any failure
 *  (missing pid, non-zero exit, empty output) — the SAFE direction. */
export function defaultReadCmdline(pid: number): string | undefined {
  try {
    const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
    })
    if (res.status !== 0) return undefined
    const out = (res.stdout ?? '').trim()
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * Identity-checked adopt-or-kill for a recorded registry pid (ISSUES #105).
 *
 *   - `no-pid`   — `pid` is undefined / not a positive integer.
 *   - `dead`     — `pid` is not alive (the common crash path); nothing to kill.
 *   - `not-ours` — `pid` is alive but its cmdline does NOT match the session
 *                  (recycled / unrelated) → LEFT UNTOUCHED (the safety invariant).
 *   - `killed`   — `pid` is alive AND verified-ours → `terminatePid` awaited.
 *
 * The caller (`makeReplRespawnDeps.killChild`) registers the returned promise so
 * `spawnResume` awaits it before launching the `--resume` replacement — that is
 * what guarantees a verified orphan is dead before a second process could attach
 * to the same transcript.
 *
 * `claudeBasename` is the CONFIGURED binary basename (default `'claude'`; the
 * basename of a `CLAUDE_BIN` / `options.claude_bin` override otherwise), threaded
 * to `cmdlineMatchesSession` so the identity gate recognises OUR orphan even when
 * the deploy renamed the binary (Argus r3 BLOCKER).
 */
export async function adoptOrKillOrphan(
  pid: number | undefined,
  sessionId: string,
  deps: OrphanAdoptionDeps,
  claudeBasename: string = 'claude',
): Promise<OrphanAdoptionVerdict> {
  const log = deps.log ?? (() => {})
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return 'no-pid'

  if (!deps.isPidAlive(pid)) {
    log(`orphan-adoption: pid ${pid} not alive — nothing to adopt (session ${sessionId.slice(0, 8)})`)
    return 'dead'
  }

  const cmdline = deps.readCmdline(pid)
  if (!cmdlineMatchesSession(cmdline, sessionId, claudeBasename)) {
    // Recycled or unrelated process — DO NOT kill. The whole point of #105.
    log(
      `orphan-adoption: pid ${pid} alive but cmdline does NOT match session ` +
        `${sessionId.slice(0, 8)} — leaving untouched (recycled-pid safety)`,
    )
    return 'not-ours'
  }

  log(
    `orphan-adoption: pid ${pid} verified-ours for session ${sessionId.slice(0, 8)} — ` +
      `terminating orphan before resume`,
  )
  await deps.terminatePid(pid)
  return 'killed'
}

/**
 * Wire the orphan-adoption check into a pending-kill registration seam. Called by
 * `makeReplRespawnDeps.killChild` in the cross-restart branch (no in-memory
 * child). Registers the (verify-then-)terminate promise under `sessionKey` via
 * `registerPending`, so `spawnResume`, which awaits any pending kill for the key,
 * does not launch the `--resume` replacement until a verified orphan has exited.
 *
 * Factored out (rather than inlined in `killChild`) so the EXACT prod path is
 * unit-testable with injected deps + a fake `registerPending` — no module-global
 * pool, no real `claude` spawn.
 *
 * `claudeBasename` is the CONFIGURED binary basename (default `'claude'`; the
 * basename of `options.claude_bin` / `CLAUDE_BIN` at the `killChild` call site),
 * threaded to `adoptOrKillOrphan` so the identity gate matches our own orphan
 * under a renamed binary (Argus r3 BLOCKER).
 */
export function registerOrphanKill(
  sessionKey: string,
  record: { pid?: number; sessionId: string } | undefined,
  deps: OrphanAdoptionDeps,
  registerPending: (sessionKey: string, p: Promise<void>) => void,
  claudeBasename: string = 'claude',
): void {
  if (record?.pid === undefined) return
  const p = adoptOrKillOrphan(record.pid, record.sessionId, deps, claudeBasename).then(
    () => undefined,
  )
  registerPending(sessionKey, p)
}
