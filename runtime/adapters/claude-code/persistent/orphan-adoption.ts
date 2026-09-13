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
import type { HandleInspection } from './pty-host.ts'

/** Verdict for one orphan-adoption attempt. */
export type OrphanAdoptionVerdict =
  | 'killed' // pid was verified-ours → terminated before the resume spawns
  | 'not-ours' // pid alive AND its cmdline was read AND it is somebody else's → untouched
  | 'unreadable' // pid alive but its cmdline could NOT be read → nothing established
  | 'dead' // pid not alive → nothing to adopt
  | 'no-pid' // record carried no usable pid → nothing to do

/**
 * WHY `unreadable` IS SEPARATE FROM `not-ours`, added with #539's adopt arm.
 *
 * For the KILL decision the two are identical and always were: neither licenses a
 * SIGTERM, which is why one value served both for as long as killing was the only
 * thing this module decided. They are opposite answers to a DIFFERENT question, and
 * #539 asks it — "may something else now resume this transcript?".
 *
 *   - `not-ours` is a POSITIVE statement: the kernel showed us a command line and it
 *     belongs to somebody else, so our child released that pid and is gone.
 *   - `unreadable` is the ABSENCE of a statement: `ps` failed, or the process is not
 *     ours to look at. Our child may be alive and holding the transcript.
 *
 * Collapsed, the second silently inherits the first's licence and a second `claude`
 * starts on a live transcript — the exact false/unknown conflation this tree keeps
 * paying for. The kill path is unchanged: it treats both as "do not touch".
 */
// ───────────────────────────────────────────────────────────────────────────
// #539 — THE ADOPT ARM.
//
// Everything above this line is adopt-OR-KILL that only ever kills: the module was
// written when a surviving REPL was a hazard to be removed, because nothing could
// re-attach to one. Under the herdr host a REPL is a pane of the herdr SERVER and
// genuinely outlives a gateway restart, so the same identity question now has a
// second useful answer — keep it, and take it back.
//
// THE TWO DIRECTIONS ARE NOT THE SAME CLAIM, and this is why the verdict below is
// not a boolean:
//   - to ADOPT, we must establish that the process under the handle IS the child
//     this row describes. Getting that wrong attaches the pool to a stranger's
//     terminal and types into it.
//   - to CLOSE, we must establish that the process under the handle owns a
//     transcript we are about to give to somebody else. Getting THAT wrong kills a
//     process that was never ours.
//   - and `unknown` establishes NEITHER, so it licenses neither act. It is a verdict
//     of its own, not a quiet member of one of the other two.
// ───────────────────────────────────────────────────────────────────────────

/**
 * What should happen to the pane a registry row names (#539). Derived ONLY from
 * evidence the host reported; this function performs no IO and decides nothing about
 * timing.
 */
export type PaneAdoptionVerdict =
  /** The pane is live and running THE CHILD THIS ROW DESCRIBES — our claude, on our
   *  transcript, wired to our dev-channel. Re-attach to it. */
  | { readonly kind: 'adopt'; readonly pid?: number }
  /**
   * The pane is live and running a `claude` ON OUR TRANSCRIPT that is NOT our child —
   * no `server:<channelName>` for this row's channel, so nothing we spawned. It must
   * be closed before anything resumes that transcript, because the one-owner-per-
   * transcript invariant is enforced ONLY by ending the other owner
   * (`session-respawn.ts`, `spawn.ts`).
   *
   * THE SHAPE THAT PRODUCES IT IS NOT HYPOTHETICAL: herdr's own native agent restore
   * (`[session] resume_agents_on_restore`, which DEFAULTS TO TRUE) relaunches a
   * claude pane as exactly `["claude", "--resume", <id>]` — read in herdr's source,
   * `src/agent_resume.rs` `plan()`, in the 0.9.0 tree available on this box; the
   * installed server is 0.8.2, so the line numbers are not cited as if they were the
   * running binary's. That relaunch carries NONE of our flags: no `--mcp-config`, no
   * dev-channel, no per-child credential. It is on our transcript and it can never
   * answer a turn.
   *
   * WHICH IS WHY THE CHANNEL TOKEN IS THE DISCRIMINATOR AND THE FLAG SPELLING IS NOT.
   * herdr uses the same `--resume <id>` spelling we do, so no amount of parsing the
   * resume flag separates the two; the dev-channel name does, because only a spawn of
   * ours passes it. Turning herdr's native resume OFF makes this arm RARE; this arm is
   * what makes it SAFE, and configuration alone would be a rule living in a file
   * nobody re-reads.
   */
  | { readonly kind: 'close-foreign-owner'; readonly reason: string }
  /** The pane is live and is NOT running a claude on our transcript — a recycled
   *  pane id, or the owner's own work. LEFT UNTOUCHED: the recycled-identifier safety
   *  rule this module exists for, applied to a pane id instead of a pid. */
  | { readonly kind: 'leave-not-ours'; readonly reason: string }
  /** The host positively reports the handle names nothing. Nothing to adopt, nothing
   *  to close, and the row's handle can be cleared. */
  | { readonly kind: 'gone' }
  /** The pane EXISTS but the host could report no argv for it, so neither direction
   *  is established. Distinct from `leave-not-ours`, which is a finding about the
   *  process; this is the absence of one. */
  | { readonly kind: 'unverifiable'; readonly reason: string }
  /** The host could not be asked at all. Says nothing about the pane. */
  | { readonly kind: 'unavailable'; readonly reason: string }

/** The row fields the classifier needs. Deliberately narrow so a test supplies a
 *  literal rather than a whole registry record. */
export interface PaneAdoptionRecord {
  /** The session UUID the surviving child is resuming — matched as the VALUE of
   *  `--resume`/`--session-id`. */
  readonly sessionId: string
  /** The dev-channel name this row's child was spawned with — matched as the VALUE
   *  of `--dangerously-load-development-channels`, i.e. `server:<channelName>`. */
  readonly channelName: string
}

/**
 * Does this argv carry OUR dev-channel — `--dangerously-load-development-channels
 * server:<channelName>`, exactly as `buildReplArgv` pushes it?
 *
 * THE VALUE AFTER THE FLAG, NEVER A SUBSTRING, for the same reason
 * {@link cmdlineMatchesSession} insists on it: the channel name also appears in the
 * `--mcp-config` and `--settings` PATHS on the same command line
 * (`neutron-repl-<channel>/session-mcp.json`), so a substring test would be satisfied
 * by a process that merely has our config files open.
 *
 * WHAT IT ADDS OVER THE SESSION MATCH, and why both are required to adopt: the
 * session id says WHICH TRANSCRIPT a process is attached to, and the channel name
 * says WHICH SPAWN it came from. A `claude --resume <our uuid>` that somebody else
 * started is on our transcript and is not our child — it has no dev-channel we can
 * inject into and no credential the sink will authorise, so adopting it would put a
 * REPL in the pool that can never answer a turn. Pure — no IO.
 */
export function argvCarriesChannel(argv: readonly string[], channelName: string): boolean {
  if (channelName === '') return false
  const want = `server:${channelName}`
  for (let i = 0; i + 1 < argv.length; i++) {
    if (argv[i] === '--dangerously-load-development-channels' && argv[i + 1] === want) return true
  }
  return false
}

/**
 * Classify what the host found under a row's pane handle (#539).
 *
 * PURE, and it consumes only what a host can honestly report — which is what makes
 * the adopt verdict falsifiable. Every `adopt` is the conjunction of two positive
 * matches against argv the HOST supplied (`pane.process_info`, measured to carry the
 * child's real argv vector), so a pane running anything else, or a pane the host
 * could not sample, cannot reach it. The caller then adds a THIRD, independent
 * probe before it acts — the dev-channel's `/health` answering with this row's
 * session id — so adoption never rests on one authority.
 */
export function classifyPaneForAdoption(
  inspection: HandleInspection,
  record: PaneAdoptionRecord,
  claudeBasename: string = 'claude',
): PaneAdoptionVerdict {
  if (inspection.kind === 'gone') return { kind: 'gone' }
  if (inspection.kind === 'unavailable') {
    return { kind: 'unavailable', reason: inspection.reason }
  }
  if (inspection.argv.length === 0) {
    return {
      kind: 'unverifiable',
      reason: 'the host reported no foreground argv for this pane — nothing identifies what is in it',
    }
  }
  const smuggled = inspection.argv.find(argvElementCarriesWhitespace)
  if (smuggled !== undefined) {
    return {
      kind: 'unverifiable',
      reason:
        `the host reported an argv element containing whitespace (${JSON.stringify(smuggled.slice(0, 40))}) — ` +
        'our spawn cannot produce one, and a vector that has them does not describe a launch this gate ' +
        'can read, so nothing is established about the pane',
    }
  }
  const onOurTranscript = argvMatchesSession(inspection.argv, record.sessionId, claudeBasename)
  if (!onOurTranscript) {
    return {
      kind: 'leave-not-ours',
      reason: `pane runs ${JSON.stringify(inspection.argv[0] ?? '')} which is not a claude on session ${record.sessionId.slice(0, 8)}`,
    }
  }
  if (!argvCarriesChannel(inspection.argv, record.channelName)) {
    return {
      kind: 'close-foreign-owner',
      reason:
        `pane runs a claude on session ${record.sessionId.slice(0, 8)} but WITHOUT this row's dev-channel ` +
        `(server:${record.channelName.slice(0, 16)}…) — it is not the child this row describes, and two ` +
        'processes must never own one transcript',
    }
  }
  return { kind: 'adopt', ...(inspection.pid !== undefined ? { pid: inspection.pid } : {}) }
}


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
  if (!cmdline) return false
  const tokens = cmdline.trim().split(/\s+/).filter((t) => t.length > 0)
  return argvMatchesSession(tokens, sessionId, claudeBasename)
}

/** Does this argv element contain whitespace? A space, tab or newline INSIDE one
 *  element is what makes a vector un-flattenable without loss, so it is the exact
 *  property {@link argvMatchesSession} refuses. Exported for the case that pins it. */
export function argvElementCarriesWhitespace(element: string): boolean {
  return /\s/.test(element)
}

/**
 * The same question as {@link cmdlineMatchesSession}, asked of the STRUCTURED argv —
 * and this is the form to use wherever the vector is in hand (#539, Argus r7 BLOCKER).
 *
 * WHY THE ARRAY IS NOT AN OPTIMISATION. `classifyPaneForAdoption` used to flatten the
 * host's argv with `join(' ')` and hand the string to `cmdlineMatchesSession`, which
 * re-split it on whitespace. Flatten-then-reparse is LOSSY, and the loss lands exactly
 * on this gate's first rule. POSIX lets a process choose any argv[0], so
 *
 *     argv = ['claude --resume', '<uuid>', '--dangerously-load-…', 'server:<chan>']
 *
 * flattens to a string whose `tokens[0]` is `'claude'` — passing the basename gate —
 * while the REAL argv[0] is `'claude --resume'`, which is not a claude binary at all.
 * The consequence is the one this module exists to prevent: the gateway attaches to,
 * or closes, a pane belonging to somebody else. Matching the array element-wise means
 * there is no reparse to fool.
 *
 * AND EMBEDDED WHITESPACE IS REFUSED OUTRIGHT rather than tolerated. `buildReplArgv`
 * pushes a binary path, bare flags, a uuid and `server:<channel>` — not one of which
 * can contain a space, tab or newline. So an element that has one is not our launch
 * shape, and this gate's whole discipline is to require the exact shape rather than to
 * accept anything that resembles it. Refusing is also what keeps the two forms honest
 * with each other: the string form's tokens can never contain whitespace, so the rule
 * is vacuous there and the `ps` kill path is unchanged by it.
 *
 * Pure — no IO. ALL must hold: no element carries whitespace; argv[0] is a genuine
 * `claudeBasename` invocation; and `sessionId` is the element IMMEDIATELY after a
 * `--resume`/`--session-id` element.
 */
export function argvMatchesSession(
  argv: readonly string[],
  sessionId: string,
  claudeBasename: string = 'claude',
): boolean {
  if (!sessionId) return false
  // Need at least `<claude> --resume <id>` (or `--session-id`): 3 elements.
  if (argv.length < 3) return false
  // (0) No element may carry whitespace — see the docblock. This is what makes the
  // element-wise match unspoofable rather than merely different from the string one.
  if (argv.some(argvElementCarriesWhitespace)) return false
  // (1) argv[0] must be a genuine claude invocation — excludes tail/vim/less/etc.
  if (!argv0IsClaude(argv, claudeBasename)) return false
  // (2) sessionId must be the VALUE immediately following --resume / --session-id.
  for (let i = 1; i + 1 < argv.length; i++) {
    if ((argv[i] === '--resume' || argv[i] === '--session-id') && argv[i + 1] === sessionId) {
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
 * WHO, IF ANYONE, IS RUNNING A `claude` ON THIS TRANSCRIPT — asked of every process,
 * not of one remembered pid (#539).
 *
 * THE QUESTION A SPAWN ACTUALLY NEEDS. "Is the recorded pid still ours?" answers
 * something narrower, and an earlier revision of the boot-adoption fallback read a
 * `dead` answer to THAT question as permission to resume the transcript. The gap is
 * real and this tree's own spec item names it: a pane can be relaunched under a NEW
 * pid — herdr's native restore does exactly that, `claude --resume <id>` — leaving the
 * RECORDED pid genuinely dead while a live process owns the transcript. Authorising a
 * second `--resume` there produces the two-owner corruption the whole item exists to
 * prevent, and it does so via a guard that looked correct.
 *
 * So the instrument is scoped to the TRANSCRIPT: every live process, filtered by the
 * same exact-shape matcher the kill gate uses ({@link cmdlineMatchesSession}), so a
 * `tail -f …/<uuid>.jsonl` or an editor with it open is not mistaken for an owner.
 *
 * THREE ANSWERS, AND THE THIRD IS NOT THE FIRST. `none` means the scan RAN and found
 * nobody; `unknown` means it could not be performed and establishes nothing. A caller
 * that treats `unknown` as `none` has rebuilt the bug above in a new place.
 *
 * WHAT THE INSTRUMENT CAN SEE, measured rather than assumed (2026-09-13, this box):
 * `ps -eo pid=,command=` piped (not a tty) emits FULL command lines — the live REPL
 * children's 603-character argv arrives whole, and the longest line in a full listing
 * was 1,368 characters. A truncating `ps` would silently answer `none` for a process
 * whose `--resume <uuid>` fell off the end, which is why this is recorded here.
 */
export type TranscriptOwnerScan =
  /** The scan ran and no live process is a `claude` on this transcript. */
  | { readonly kind: 'none' }
  /** At least one live process is. Their pids, for the message a caller writes. */
  | { readonly kind: 'owners'; readonly pids: readonly number[] }
  /** The scan could not be performed. Establishes NOTHING — never read as `none`. */
  | { readonly kind: 'unknown'; readonly reason: string }

/** One live process, as {@link scanTranscriptOwners} needs it. */
export interface ProcessListing {
  readonly pid: number
  readonly cmdline: string
}

/**
 * Every process on this machine, as `pid` + full command line — or `undefined` when the
 * listing could not be taken, which is a different thing from an empty machine.
 *
 * `ps -eo pid=,command=` on darwin and Linux alike (the same portability argument
 * {@link defaultReadCmdline} makes for the single-pid form). A non-zero exit, a throw,
 * or empty output all answer `undefined`: the SAFE direction, because the caller's rule
 * for "I could not look" is to establish nothing.
 */
export function defaultListProcesses(): ProcessListing[] | undefined {
  try {
    const res = spawnSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 })
    if (res.status !== 0) return undefined
    const out = (res.stdout ?? '').trim()
    if (out.length === 0) return undefined
    const rows: ProcessListing[] = []
    for (const line of out.split('\n')) {
      const trimmed = line.trim()
      const sep = trimmed.indexOf(' ')
      if (sep <= 0) continue
      const pid = Number(trimmed.slice(0, sep))
      if (!Number.isInteger(pid) || pid <= 0) continue
      rows.push({ pid, cmdline: trimmed.slice(sep + 1) })
    }
    return rows.length > 0 ? rows : undefined
  } catch {
    return undefined
  }
}

/** See {@link TranscriptOwnerScan}. Pure given the listing; the IO is the injected
 *  `listProcesses`. */
export function scanTranscriptOwners(
  sessionId: string,
  listProcesses: () => ProcessListing[] | undefined,
  claudeBasename: string = 'claude',
): TranscriptOwnerScan {
  if (sessionId === '') {
    return { kind: 'unknown', reason: 'no session id to look for' }
  }
  let listing: ProcessListing[] | undefined
  try {
    listing = listProcesses()
  } catch (e) {
    return { kind: 'unknown', reason: `the process listing threw: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (listing === undefined) {
    return { kind: 'unknown', reason: 'the process listing could not be taken' }
  }
  const pids = listing
    .filter((row) => cmdlineMatchesSession(row.cmdline, sessionId, claudeBasename))
    .map((row) => row.pid)
  return pids.length === 0 ? { kind: 'none' } : { kind: 'owners', pids }
}

/**
 * Identity-checked adopt-or-kill for a recorded registry pid (ISSUES #105).
 *
 *   - `no-pid`   — `pid` is undefined / not a positive integer.
 *   - `dead`     — `pid` is not alive (the common crash path); nothing to kill.
 *   - `not-ours` — `pid` is alive, its cmdline WAS read, and it does not match the
 *                  session (recycled / unrelated) → LEFT UNTOUCHED (the safety
 *                  invariant).
 *   - `unreadable` — `pid` is alive and its cmdline could not be read at all → LEFT
 *                  UNTOUCHED, and nothing is established either way.
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
  const identity = identifyOrphanPid(pid, sessionId, deps, claudeBasename)
  if (identity !== 'ours') return identity

  log(
    `orphan-adoption: pid ${String(pid)} verified-ours for session ${sessionId.slice(0, 8)} — ` +
      `terminating orphan before resume`,
  )
  await deps.terminatePid(pid as number)
  return 'killed'
}

/**
 * WHAT THE PROCESS TABLE SAYS ABOUT A RECORDED PID — with NO side effect.
 *
 * SPLIT OUT BECAUSE THE IDENTITY QUESTION AND THE KILL DECISION ARE NOT THE SAME
 * QUESTION, and #539 asks the first without wanting the second. The boot-adoption pass
 * uses this to answer "does something still own this transcript?" in situations where
 * killing would be WRONG — a herdr that did not answer one probe says nothing about the
 * REPL behind it, and terminating a healthy REPL because a socket blinked destroys
 * exactly what the adoption feature exists to preserve. The kill path is this plus one
 * more step, which is how the two cannot drift: one matcher, one liveness probe, one
 * set of rules about recycled pids.
 *
 * Pure with respect to the PROCESS: it only probes and reads. `'ours'` means the pid is
 * alive and is our `claude` for this session; every other value is exactly what
 * {@link OrphanAdoptionVerdict} documents.
 */
export function identifyOrphanPid(
  pid: number | undefined,
  sessionId: string,
  deps: Pick<OrphanAdoptionDeps, 'isPidAlive' | 'readCmdline' | 'log'>,
  claudeBasename: string = 'claude',
): 'ours' | 'not-ours' | 'unreadable' | 'dead' | 'no-pid' {
  const log = deps.log ?? (() => {})
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return 'no-pid'

  if (!deps.isPidAlive(pid)) {
    log(`orphan-adoption: pid ${pid} not alive — nothing to adopt (session ${sessionId.slice(0, 8)})`)
    return 'dead'
  }

  const cmdline = deps.readCmdline(pid)
  if (cmdline === undefined) {
    // ALIVE, AND WE COULD NOT LOOK. Not a finding about the process — a failure to
    // make one. Never killed, and never reported as absence.
    log(
      `orphan-adoption: pid ${pid} is alive but its cmdline could not be read — nothing is ` +
        `established about it (session ${sessionId.slice(0, 8)})`,
    )
    return 'unreadable'
  }
  if (!cmdlineMatchesSession(cmdline, sessionId, claudeBasename)) {
    // Recycled or unrelated process — DO NOT kill. The whole point of #105.
    log(
      `orphan-adoption: pid ${pid} alive but cmdline does NOT match session ` +
        `${sessionId.slice(0, 8)} — leaving untouched (recycled-pid safety)`,
    )
    return 'not-ours'
  }
  return 'ours'
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
