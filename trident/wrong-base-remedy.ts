/**
 * The wrong-base launch guard's REMEDY, resolved against evidence instead of guessed.
 *
 * Incident 2026-08-31 (run 3e324936): the guard refused correctly, then told the agent to
 * force-delete a branch that was checked out in a LIVE locked worktree — pid alive, a
 * hundred-odd uncommitted lines in the tree — and whose tip was ALREADY on origin. Following
 * the advice would have destroyed another lane's live work, and git would have refused the
 * command anyway because the branch was checked out elsewhere. The message misdirected
 * whichever way it was read.
 *
 * Two contract lines govern what replaces it:
 *   - a refusal names the layer that refused AND the evidence it rests on;
 *   - "UNKNOWN never authorises an irreversible action" (docs/INVARIANTS.md §12 invariant 122).
 *     The card cites that rule as "invariant 121"; it is 122, and the numbers are inside §12, not
 *     section headings — a reviewer looking for a top-level "122" finds sections 1-13 and reads
 *     the citation as dangling. Cited with its section from here on so it can be found.
 *
 * The incident was an agent running the printed text VERBATIM, so every shell argument this
 * module prints is quoted (`sh`): a branch or path name is attacker-shaped data, and
 * `git check-ref-format --branch` accepts `;`, `$` and backticks inside one.
 *
 * This module composes TEXT. It terminates nothing, unlocks nothing, removes nothing. Liveness
 * is probed per-pid through /proc — never by matching process names, never by sending a signal.
 */

import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { RunHostCommand } from './merge.ts'

/**
 * Alive, dead, and "could not tell" are three answers; the third never collapses into either.
 *
 * ZOMBIE is a FOURTH, and it is not a refinement for its own sake. A defunct process still owns
 * its pid, so `/proc/<pid>` exists and every existence-based probe — this one included, before
 * this — answers ALIVE. The arms differ in what they tell the reader to WAIT for: the ALIVE arm
 * is the only one with no by-hand settle, because a live lane releases its own tree when it
 * finishes. A zombie never finishes anything, so that arm wedges the card forever waiting on a
 * release nobody will perform. It is still not DEAD (the pid is taken, and the tree may still
 * hold the exited process's children), so it authorises nothing destructive either.
 */
export type PidLiveness = 'alive' | 'dead' | 'zombie' | 'unknown'

/**
 * Linux PID_MAX_LIMIT, and pid_max is EXCLUSIVE of it: 4194304 is never assignable, so /proc's
 * silence about it proves nothing either. Hence `>=`, not `>`.
 */
const PID_CEILING = 4_194_304

/**
 * This refusal is composed inside `launch()`, on the tick's critical path. The host default is
 * 60s per command, so an unreachable remote used to cost two full minutes of a build loop that
 * is only trying to write a sentence. A fetch that cannot answer in this budget is UNKNOWN,
 * which is a safe answer here — UNKNOWN authorises nothing.
 */
const FETCH_TIMEOUT_MS = 15_000

/**
 * The same argument applied to the LOCAL calls. They are local-only and normally answer in
 * milliseconds, but the reason they carry a budget is the reason the fetch does: this runs on
 * the launch tick, and a `worktree list` blocked on an unresponsive filesystem would otherwise
 * spend the host default (60s) each. A budget that expires here costs nothing but an UNKNOWN,
 * and UNKNOWN authorises nothing.
 */
const LOCAL_TIMEOUT_MS = 15_000

/**
 * Total budget for ONE whole composition (Argus finding 10, decided as ENFORCED rather than
 * merely justified). The per-command budgets above bound each command, but the unheld path
 * runs up to five in sequence — worktree list, fetch, fetch retry, rev-parse, merge-base —
 * so five separately-wedged commands could stack ~75s onto a launch tick that previously
 * composed this string with zero I/O. Half that worst case, twice the worst single command:
 * a healthy host never notices (every call normally answers in milliseconds), and on a
 * wedged one the composition as a whole now costs at most this before degrading to UNKNOWN
 * — which authorises nothing.
 *
 * WHAT IT PRICES IS SPAWNED COMMANDS, and that is the whole claim (Argus nit). `probeTreeOccupancy`
 * reads /proc SYNCHRONOUSLY — a `readdirSync` plus a `readlinkSync` per pid — and is called from
 * inside the composition without passing through `run()`, so its cost sits OUTSIDE this budget.
 * It is bounded by a different thing: /proc is a kernel-backed pseudo-filesystem with no remote
 * or device I/O behind it, the walk is one shallow pass over the pid entries, and every failing
 * read is swallowed rather than retried. It is also reached only from the pid-less-lock and
 * dead-pid arms. Stated rather than folded in, because a budget that reads as covering everything
 * while pricing only the spawns is the overclaiming this module exists to stop.
 */
export const TOTAL_BUDGET_MS = 30_000

/**
 * Probe ONE pid, by number, through the process filesystem. Mirrors the worktree reaper's
 * /proc-based liveness: no `kill(pid, 0)`, no signal of any kind, no name matching. A host
 * without /proc cannot prove death, so it answers 'unknown' rather than reporting 'dead'.
 *
 * `existsSync` is deliberately NOT used: it answers false for an entry that exists but cannot
 * be read (EACCES under a restricted /proc), which would report a live lane's pid as DEAD —
 * and DEAD is the arm that prints `worktree remove`. Only ENOENT proves absence.
 */
export function probePidLiveness(pid: number, procRoot = '/proc'): PidLiveness {
  if (!Number.isInteger(pid) || pid <= 0 || pid >= PID_CEILING) return 'unknown'
  // SELF-PROBE CONTROL. A `procRoot` that exists but is not procfs (an empty directory, a
  // container mount that never got /proc) answers ENOENT for EVERY pid, so the probe would
  // report every live lane as DEAD — the one arm that prints `worktree remove`. THIS process
  // is alive by construction, so a real procfs must carry its entry; one extra syscall buys
  // the whole probe its ground truth.
  try {
    statSync(join(procRoot, String(process.pid)))
  } catch {
    return 'unknown'
  }
  try {
    statSync(join(procRoot, String(pid)))
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'dead' : 'unknown'
  }
  // THE ENTRY EXISTS — now ask what STATE it is in. `/proc/<pid>/stat` is `pid (comm) S …` and
  // `comm` may itself contain spaces and parentheses, so the state is read after the LAST `)`
  // rather than by splitting on spaces. A read that fails leaves the answer at 'alive': the
  // directory exists, which is what this function was measuring before, and downgrading on an
  // unreadable stat file would invent a fact.
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim()
    if (after.startsWith('Z')) return 'zombie'
  } catch {
    /* the entry is there; its state is not readable. 'alive' is the honest floor. */
  }
  return 'alive'
}

/** Occupancy is a VETO on 'dead', never a grant: 'unknown' only when /proc cannot be read. */
export type TreeOccupancy = { kind: 'occupied'; pid: number } | { kind: 'clear' } | { kind: 'unknown' }

/**
 * Is any OTHER process standing INSIDE the worktree? The lock's pid is one witness; the repo's
 * established liveness prior art (`worktree-reaper.ts`, `codex-build.sh:holder_is_live`) is
 * this one — a dead lock pid does not prove the tree unoccupied, and the tree is what the
 * DEAD arm proposes to remove.
 */
export function probeTreeOccupancy(
  worktree: string,
  procRoot = '/proc',
  /**
   * Every OTHER checkout git knows about. A pid standing in one that is STRICTLY INSIDE
   * `worktree` (on this box they are: `<repo>/.claude/worktrees/...`) is standing in ITS tree,
   * not in this one, and "pid N is standing inside that tree, so it is ALIVE" about an
   * unrelated lane is false named evidence — the one thing this module exists to avoid.
   * Entries that are NOT strictly inside — the shared checkout above all, an ancestor of every
   * wf_* worktree — are discarded here rather than trusted; see the filter below.
   */
  nested: string[] = [],
): TreeOccupancy {
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return { kind: 'unknown' }
  }
  // The same self-probe control as `probePidLiveness`, for the same reason: a readable
  // directory that is not procfs enumerates no pids and would answer 'clear', which is the
  // answer that LIFTS the DEAD arm's veto and reaches `worktree remove`.
  const self = String(process.pid)
  if (!entries.includes(self)) return { kind: 'unknown' }
  let resolved: string | null = null
  try {
    resolved = realpathSync(worktree)
  } catch {
    resolved = null
  }
  const within = (cwd: string, root: string): boolean => cwd === root || cwd.startsWith(`${root}/`)
  const realOf = (p: string): string | null => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  // ONLY A STRICTLY DEEPER CHECKOUT MAY TAKE A PID AWAY. The caller hands us
  // every other worktree git knows about, and on this box the shared checkout is an ANCESTOR
  // of every wf_* worktree (`<repo>/.claude/worktrees/<wt>`) — so an unfiltered list matched
  // every pid standing in the held tree as "standing in the repo instead", answered 'clear'
  // for an occupied tree, and let the DEAD arm print `worktree unlock`/`worktree remove` on
  // top of a live lane. A path that CONTAINS this worktree tells us nothing about it; only
  // one nested inside it can take a pid away.
  const inner: string[] = []
  for (const child of nested) {
    if (child === '' || child === worktree || child === resolved) continue
    const real = realOf(child)
    if (real === resolved) continue
    const deeper = (p: string): boolean =>
      (within(p, worktree) && p !== worktree) || (resolved !== null && within(p, resolved) && p !== resolved)
    if (deeper(child)) inner.push(child)
    else if (real !== null && deeper(real)) inner.push(real)
  }
  const insideNested = (cwd: string): boolean =>
    inner.some((child) => {
      if (within(cwd, child)) return true
      const real = realOf(child)
      return real !== null && real !== resolved && within(cwd, real)
    })
  // A pid whose /proc entry EXISTS but cannot be read is a process we cannot place. Only
  // ENOENT/ESRCH proves it is gone; EACCES (hidepid, another uid) proves nothing, and
  // 'clear' is the answer that LIFTS the DEAD arm's veto and reaches `worktree remove`.
  let unreadable = false
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    // Never cite OUR OWN pid as the holder. When the guard runs from inside the repo the
    // caller is standing in the tree, and "pid N is standing inside that tree, so it is ALIVE"
    // would be this module naming itself as another lane — false evidence, in a module whose
    // whole subject is naming true evidence.
    if (entry === self) continue
    let cwd: string
    try {
      cwd = readlinkSync(join(procRoot, entry, 'cwd'))
    } catch (err) {
      // An exit race is a genuine skip: the pid is gone, so it stands nowhere. A PERMISSION
      // failure is not — a process exists whose cwd we could not read, so "nobody is in the
      // tree" is unestablished. Silently skipping it was how occupancy answered 'clear' for
      // an occupied tree and let the composer print `worktree remove`.
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code !== 'ENOENT' && code !== 'ESRCH') unreadable = true
      continue
    }
    if (insideNested(cwd)) continue
    if (within(cwd, worktree) || (resolved !== null && within(cwd, resolved))) {
      return { kind: 'occupied', pid: Number.parseInt(entry, 10) }
    }
  }
  return unreadable ? { kind: 'unknown' } : { kind: 'clear' }
}

export interface WrongBaseRefusalArgs {
  repo: string
  branch: string
  base: string
  branch_tip: string
  ahead_count: string
  /** The refusing run's id — the salvage-tag namespace is per-RUN, never per-branch. */
  run_id: string
}

export interface WrongBaseRemedyDeps {
  run_host: RunHostCommand
  /**
   * Clock for the total evidence budget. Tests hand in a clock their fake `run_host`
   * advances, so budget exhaustion is exercised without real waiting. Defaults to Date.now.
   */
  now?: () => number
  probe_pid?: (pid: number) => PidLiveness
  probe_tree?: (worktree: string, nested: string[]) => TreeOccupancy
  /**
   * Process root for the DEFAULT occupancy probe. Substituting `probe_tree` wholesale replaces
   * the thing under test, so every compose-level DEAD case injected a canned `clear` and the
   * suite could not see what the REAL probe answers on a host whose /proc is mostly unreadable
   * — which is the difference between the DEAD arm printing a release and never firing at all.
   * A fixture root lets a test drive the real probe through the real composer.
   */
  proc_root?: string
  /** Reads a DETACHED worktree's rebase state; see `readRebaseHead`. Defaults to that function. */
  rebase_head?: (worktree: string) => RebaseHead
}

interface WorktreeHolder {
  path: string
  branch: string | null
  lock_reason: string | null
  prunable: boolean
}

/**
 * Quote one argument for a POSIX shell. The reader of this message is instructed to RUN it, and
 * a legal branch name may contain `;`, `$` or backticks (measured: `git check-ref-format
 * --branch 'feat;printf-INJECTED'` exits 0). Shell-safe shapes pass through unquoted so the
 * common message stays readable.
 */
/**
 * The codepoints a QUOTED argument still has to encode: ASCII controls plus the line separators
 * and bidi overrides `defang` folds out of the prose. Kept as one source so the two halves of the
 * module cannot drift apart on which characters are forgery vectors.
 */
const SH_ENCODE = /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/

function sh(arg: string): string {
  if (arg !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  // A CONTROL CHARACTER SURVIVES SINGLE QUOTES. `'a<newline>b'` is a CORRECT quoting of a path
  // containing a newline — and it puts a LITERAL newline into a refusal whose whole threat
  // model is that an agent reads it as evidence and runs what it reads, so the quoted argument
  // itself can draw what looks like a new line of the guard's own message. A worktree path may
  // legally contain one (git's `-z` porcelain exists for exactly that case), so the quoted form
  // has to ENCODE it rather than carry it. ANSI-C quoting does that; it is bash/zsh rather than
  // strict POSIX sh, which is what every command in this repo is run under, and it is reached
  // only for the pathological shapes — ordinary paths keep the readable `'…'` form below.
  //
  // AND ASCII IS NOT THE WHOLE SET (Argus blocker, generalised). `defang` folds U+2028/U+2029 and
  // the bidi overrides out of the PROSE because they draw a line, or reorder one, without being
  // control characters — and a ref name carrying them is legal (measured on git 2.43: `git
  // branch` accepts `feat<U+202E>evil` and `rev-parse --verify` resolves it). The quoted ARGUMENT
  // cannot be folded, because a command naming a different ref than the one on disk cannot be
  // run, so it is ENCODED by the same rule instead: bash and zsh expand a `\\uHHHH` escape inside
  // ANSI-C quoting back to the real byte sequence, so the command still runs and the line still
  // renders in the order it was written. The two halves of this module now agree on one set of
  // codepoints — `SH_ENCODE` and `defang`'s first rule are that set.
  if (SH_ENCODE.test(arg)) {
    const escaped = arg.replace(/[\\']/g, '\\$&').replace(new RegExp(SH_ENCODE.source, 'g'), (c) => {
      const code = c.charCodeAt(0)
      if (code === 9) return '\\t'
      if (code === 10) return '\\n'
      if (code === 13) return '\\r'
      return code < 0x100
        ? `\\x${code.toString(16).padStart(2, '0')}`
        : `\\u${code.toString(16).padStart(4, '0')}`
    })
    return `$'${escaped}'`
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Two paths naming one directory: git prints resolved worktree paths, callers may not. */
function samePath(a: string, b: string): boolean {
  if (a === b) return true
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  return real(a) === real(b)
}

/**
 * NEUTRALISE THE THREE THINGS ATTACKER-SHAPED EVIDENCE CAN DRAW IN A REFUSAL AN AGENT EXECUTES.
 *
 * Every piece of evidence this module quotes back — a forged `git worktree lock --reason`, a
 * hostile remote's fetch stderr, a worktree PATH (git's `-z` porcelain exists precisely because
 * a path may contain a newline) — is attacker-influenced text interpolated into a one-sentence
 * refusal that an agent reads as the guard's own voice. Three shapes turn that into forgery:
 *
 *   1. LINE BREAKS AND OTHER CONTROL CHARACTERS. A newline inside the quotation draws what looks
 *      like a NEW line of the guard's own evidence. U+2028/U+2029 are line separators in several
 *      renderers and the bidi overrides (U+202A-E, U+2066-9) reorder what is DISPLAYED without
 *      changing the bytes, so the same rule folds them. Folded to ONE SPACE rather than dropped,
 *      so the surrounding words keep their `\b` boundaries and the credential-token rules in
 *      `scrub` still see them as separate tokens.
 *   2. THE DOUBLE QUOTE. Two call sites render evidence as `its lock reads "…"`, so a `"` inside
 *      it CLOSES that quotation early and everything after reads as the guard's own prose. Folded
 *      to an apostrophe: the quotation stays closed and the text stays readable.
 *   3. THE DESTRUCTIVE COMMANDS THIS CLASS OF MESSAGE FORBIDS. The live-holder arm's contract is
 *      that `branch -D` appears NOWHERE in it, and evidence carrying that literal defeats the
 *      contract from outside this module. Only the irreversible deletes are neutralised — the
 *      remedies the guard itself prints (`worktree unlock`/`remove`, `worktree prune`) are its
 *      own prose, never evidence, and stay readable.
 *
 *      AND THE SHORT SPELLING IS NOT THE ONLY ONE (Argus finding). Neutralising the literal
 *      `-D`/`-d` alone left `branch --delete --force`, `update-ref --delete`, `push origin
 *      :branch` and `worktree remove --force` rendering VERBATIM inside a refusal whose whole
 *      contract is that it prints no such instruction — the same irreversible acts, spelled
 *      the way git's own long options spell them. The VERB is what is neutralised, so every
 *      option ORDER collapses to one replacement, and the rules stay LINEAR (at most one
 *      bounded token of lookahead, no unbounded repetition): this composes on the launch tick,
 *      so a quadratic rule here is the wedge `scrub`'s own input bound exists to stop.
 *
 *      AND SHORT OPTIONS COMBINE (Argus finding). The rule used to require a word boundary
 *      immediately after the `D`/`d`, which is exactly what git's own combined spellings do
 *      not have: `branch -Dr`, `branch -fd` and `branch -dr` are real, runnable deletes on
 *      git 2.43 (measured) and every one of them passed through VERBATIM — and `-Dr` put the
 *      literal `branch -D` back into the live-holder arm whose pinned contract is that the
 *      string appears nowhere in it, falsifying that contract from outside this module.
 *
 *      AND THE OPTION RUN IS NOT ONE TOKEN LONG (Argus finding, both reviewers, measured
 *      through this composer). Spelling the run inside the regex — one optional preceding
 *      option token, a cluster bounded at four letters per side — was a claim about SHAPE that
 *      git does not share: `branch -v -q -D feat`, `branch -Dvvvvv feat`, `branch -vvvvvD feat`,
 *      `push -f origin :feat`, `push --force origin :feat`, `push origin -d feat` and
 *      `push -d origin feat` all rendered verbatim (the three `branch` spellings were verified
 *      to really delete on git 2.43; `-d` is a real `push` delete per `git push -h`). The verb's
 *      arguments are therefore read as TOKENS and each token tested on its own, so option order,
 *      count and clustering stop mattering — the earlier docblock claimed "every option ORDER
 *      collapses to one replacement", which was stronger than the regex and is only now true of
 *      the code.
 *
 *      AND EVERY BOUNDED WINDOW IS FALSIFIED BY ONE MORE TOKEN (Argus finding, reproduced).
 *      Two bounds fell in turn. A four-token window read `branch --verbose --quiet --color
 *      --no-column --delete --force victim` as if no delete were in it, because the option RUN
 *      alone is six tokens long. Widening the window to "the leading option run plus four
 *      tokens" assumed git's documented grammar — options, then the ref — and git does not
 *      hold to it: `git branch w x y z -D victim` DELETES victim on git 2.43 (measured in a
 *      scratch repo), because git permutes its argv, and four positionals in front of the
 *      option put the delete outside that window too. There is no token count that closes a
 *      class whose next member is the same string with one more word in it. So the window is
 *      now the REST OF THE EVIDENCE: a delete verb is rewritten when a delete option appears
 *      anywhere after it in the same (bounded) string. That over-folds — evidence that says
 *      `branch` in one sentence and `-d` three sentences later loses the verb — and over-folding
 *      EVIDENCE is the safe direction, because the guard's own remedies are its own prose and
 *      never pass through here (the DEAD arm's `worktree remove` and the safe arm's
 *      `branch -D` are both asserted to survive).
 *
 *      STILL LINEAR, AND WITH NO NESTED QUANTIFIER LEFT (Argus blocker: CodeQL
 *      js/polynomial-redos, high severity, on the `(?:\s+-\S+)*(?:\s+\S+){0,4}` window). The
 *      rule is no longer a regex over the whole string at all: it is one split on whitespace,
 *      one right-to-left pass recording the nearest delete option at or after each index, and
 *      one left-to-right pass rewriting. Every token is examined a constant number of times,
 *      each token test is anchored at both ends and free of the `[A-Za-z]*[Dd][A-Za-z]*`
 *      ambiguity CodeQL reads as polynomial (the cluster test is a `startsWith` plus one
 *      unambiguous `^[A-Za-z]+$`). MEASURED ON THIS HOST WITH THE CURRENT CODE, through
 *      `foldEvidence` and therefore through its 64k input cap, over 1M characters of each
 *      adversarial shape — bare verbs, verb-plus-option pairs, 200-character option clusters,
 *      `push origin +:x` runs, and one single unbroken 1M-character token: 8.1ms was the worst
 *      of them and most were under 6ms. The figure the previous docblock carried — "200k of
 *      adversarial input, 2ms" — belonged to a superseded regex and is replaced rather than
 *      kept (Argus minor), because this module's thesis is that it asserts nothing it has not
 *      measured.
 *
 *      AND THE RULE IS GIT-VERB-SCOPED, WHICH IS A BOUNDARY AND NOT A GAP THIS PRETENDS TO
 *      COVER (Argus nit, both reviewers). It enumerates git's own delete verbs and nothing else,
 *      so `rm -rf <path>` and `git reflog expire --expire=now --all && git gc --prune=now` in
 *      forged evidence render VERBATIM. That is stated rather than implied because the earlier
 *      docblock's "the destructive commands this class of message forbids" reads as a general
 *      claim. What the arms' pinned contracts actually forbid is the guard appearing to
 *      instruct a REF DELETE, and arranging any of this needs local `git worktree lock --reason`
 *      write access — the same access every other forgery here needs.
 *
 *      AND THE VERB IS NO LONGER ANCHORED ON `\b` (Argus finding, reproduced through the real
 *      composer). A word boundary needs a NON-word character before the verb, so one word
 *      character in front of it defeated the whole rule: `foldEvidence('Xbranch -D victim')`
 *      returned it UNCHANGED, and a lock reason spelling it that way put the literal
 *      `branch -D` back inside the ALIVE arm whose pinned contract is that the string does not
 *      contain it. The anchor is dropped rather than widened, because there is no benign
 *      spelling to protect: the verbs are only rewritten when a DELETE OPTION is found in the
 *      bounded window after them, so prose that merely contains the letters (`rebranch`,
 *      `advantage`) is untouched, and over-folding evidence is the safe direction anyway. The
 *      cost is one substring in an unrunnable position; the alternative is a runnable-looking
 *      one in a message that promises none.
 */
/**
 * A COMBINED SHORT-OPTION CLUSTER CARRYING d/D — `-D`, `-Dr`, `-fd`, `-vvvvvD`. Written as a
 * prefix test plus one unambiguous anchored regex rather than `^-[A-Za-z]*[Dd][A-Za-z]*$`: that
 * spelling puts two `*` quantifiers over the SAME character class either side of one optional
 * letter, which backtracks quadratically on a long letter run that fails the anchor and is the
 * shape CodeQL's js/polynomial-redos flags. This runs on the launch tick over attacker-shaped
 * evidence, so it is kept free of that shape by construction rather than by measurement.
 */
function isDeleteCluster(t: string): boolean {
  if (!t.startsWith('-') || t.startsWith('--')) return false
  const body = t.slice(1)
  return /^[A-Za-z]+$/.test(body) && (body.includes('d') || body.includes('D'))
}
/** One option token that spells an irreversible ref delete: `--delete`, or a short cluster with d/D. */
function isRefDelete(t: string): boolean {
  return t === '--delete' || isDeleteCluster(t)
}
/** The same for `push`, which ALSO deletes by REFSPEC (`:feat`, `+:feat`) and by `--mirror`. */
function isPushDelete(t: string): boolean {
  return t === '--delete' || t === '--mirror' || t.startsWith(':') || t.startsWith('+:') || isDeleteCluster(t)
}
/** The delete VERBS, found ANYWHERE inside a token — one word character in front used to defeat the rule. */
const REF_DELETE_VERB = /(branch|update-ref|tag)/

/**
 * Rewrite every git delete VERB whose arguments carry a delete option, reading the arguments as
 * whitespace-delimited TOKENS and the window as the REST OF THE STRING. The docblock above says
 * why the window is unbounded (every bounded one was falsified by adding one more token, and
 * `git branch w x y z -D victim` — a real delete on git 2.43 — was the last of them) and why
 * over-folding EVIDENCE is the safe direction.
 *
 * Linear, with no nested quantifier anywhere in it: one split, one right-to-left pass recording
 * the nearest delete option at or after each index, one left-to-right pass rewriting. Every
 * token is examined a constant number of times.
 */
function defangCommands(s: string): string {
  // The capture keeps the separators, so everything NOT rewritten is rebuilt character for character.
  const parts = s.split(/(\s+)/)
  const n = parts.length
  // `[i]` = the nearest index >= i whose token is a delete option, or -1. The extra slot at `n`
  // is the "nothing follows the last token" answer, so the forward pass can always read `i + 1`.
  const nextRefDelete = new Int32Array(n + 1).fill(-1)
  const nextPushDelete = new Int32Array(n + 1).fill(-1)
  let ref = -1
  let push = -1
  for (let i = n - 1; i >= 0; i--) {
    const tok = parts[i] as string
    if (isRefDelete(tok)) ref = i
    if (isPushDelete(tok)) push = i
    nextRefDelete[i] = ref
    nextPushDelete[i] = push
  }
  const out: string[] = []
  let i = 0
  while (i < n) {
    const tok = parts[i] as string
    // The delete has to come AFTER the verb, hence `i + 1`: a token is never its own argument.
    const refVerb = REF_DELETE_VERB.exec(tok)
    const refAt = nextRefDelete[i + 1] as number
    if (refVerb !== null && refAt >= 0) {
      out.push(`${tok.slice(0, refVerb.index)}${refVerb[1] as string} <command removed>`)
      i = refAt + 1
      continue
    }
    // `push` deletes three ways: by option (`-d`, `--delete`), by wiping the remote (`--mirror`),
    // and by REFSPEC with no option at all (`push origin :feat`, `push origin +:feat`).
    const pushAt = tok.indexOf('push')
    const pushDeleteAt = nextPushDelete[i + 1] as number
    if (pushAt >= 0 && pushDeleteAt >= 0) {
      out.push(`${tok.slice(0, pushAt)}push <command removed>`)
      i = pushDeleteAt + 1
      continue
    }
    out.push(tok)
    i++
  }
  return out.join('')
}

function defang(s: string): string {
  return defangCommands(
    s
      .replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
      .replace(/"/g, "'")
      .replace(/(worktree)(\s+)remove\b/g, '$1$2<command removed>'),
  )
}

/**
 * ATTACKER-SHAPED EVIDENCE, rendered as PROSE — a worktree path, a repo path, or a fragment of
 * git's own stderr, any of which can carry a newline. The COMMANDS still carry `sh(path)` — the
 * real path, quoted, because a remedy has to be runnable — but the sentences around them carry
 * this, so a path cannot forge a line of the guard's own evidence. A path is attacker-shaped by the same
 * standard as a lock reason: `git worktree add` accepts a newline in one, and this module's own
 * `-z` parser exists because of it. Bounded for the reason a scrubbed lock reason is bounded —
 * a refusal is a sentence and PATH_MAX is 4096 — and the truncation is MARKED.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied (Argus nit): the COMMANDS in the
 * treat-as-live arms (`settleByHand`, `occupancyScan`) carry `sh(path)`, the real path, because
 * a remedy that names a different path than the one on disk cannot be run. So a worktree whose
 * PATH literally contains `branch -D` puts that text back into those arms, inside single quotes,
 * as an ARGUMENT to a read-only command rather than as an instruction. Defanging it there would
 * trade a quoted string for a settle nobody can execute, which is the worse of the two — and it
 * costs local `git worktree add` access to arrange, the same write access every other forgery
 * here needs.
 *
 * EXPORTED, because the OUTER guard owes the same contract (Argus blocker). `orchestrator.ts`
 * composes its own pre-launch UNKNOWN refusals and used to interpolate `run.repo_path` RAW into
 * them, so a legal path — `git worktree add` and `git init` both accept a newline, and
 * `store.ts` persists the path verbatim — could forge a line inside a message whose entire
 * subject is that UNKNOWN authorises no destructive act:
 *
 *     /repo\nFORGED: run `git branch -D -- victim` to clear this
 *
 * One folding function, used on both sides of the seam, is what keeps that impossible; two
 * would drift.
 */
const EVIDENCE_PROSE_MAX = 300
/**
 * The same INPUT cap `scrub` applies before its own passes (Argus nit). Every current caller's
 * input is already bounded — a path by PATH_MAX, git stderr by the orchestrator's own slice —
 * so this changes no output that exists today; the asymmetry was the thing worth removing,
 * because "unbounded attacker-controlled string into a rewrite loop" is the premise the CodeQL
 * alert on this file rested on, and a cap states the bound in the code instead of in a comment
 * about the callers. Only the TAIL is kept, matching `scrub`, and the OUTPUT truncation below
 * is what a reader actually sees.
 */
const EVIDENCE_SCAN_MAX = 64_000
export function foldEvidence(s: string): string {
  const folded = defang(s.length > EVIDENCE_SCAN_MAX ? s.slice(-EVIDENCE_SCAN_MAX) : s)
  return folded.length > EVIDENCE_PROSE_MAX ? `…${folded.slice(-EVIDENCE_PROSE_MAX)}` : folded
}

/**
 * A REF NAME rendered as prose — the branch and the base. Not the same job as `foldEvidence`,
 * and the difference is what a downstream ANCHOR rests on (Argus blocker).
 *
 * `foldEvidence` folds every forgery codepoint to an ASCII SPACE, which is right for a path or
 * a fragment of stderr — free prose, where a space separates nothing that matters. It is wrong
 * for a name field: `delivery.ts`'s `WRONG_BASE_PREFIX` spells the branch and base fields
 * `[^ \n]+`, deliberately, because the ASCII space is exactly what git's ref rules forbid and
 * therefore the one character that cannot appear inside a legal name. Fold a LEGAL name
 * containing U+2028 (git 2.43: `check-ref-format --branch` exits 0 on it, 128 on an ASCII
 * space) to `feat x` and the composed prefix carries a space where the classifier promised
 * none — the anchor misses, and the refusal falls through to the substring classifiers that
 * answer "Reply to retry the build", the one advice this whole class exists to forbid. The
 * fold, not the anchor, reopened the hole delivery.ts's docblock says is closed.
 *
 * So a name field is folded to ONE TOKEN: every whitespace and every forgery codepoint becomes
 * `?` — a character git's ref rules also forbid, so it cannot be mistaken for part of a real
 * name — BEFORE `foldEvidence` runs. That is also why no `<command removed>` appears here and
 * none is needed: the substitution happens first, so a forged `branch -D -- victim` inside a
 * name arrives at the message as `branch?-D?--?victim`, which is not a command anybody can run
 * and not a string any classifier reads, and `defang` (which needs whitespace between a verb
 * and its options) can no longer re-introduce a space by rewriting one.
 */
export function foldRefName(s: string): string {
  const named = s.replace(/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, '?')
  // AND A LEADING DASH IS MARKED (Argus finding, reproduced through the real composer). The arms
  // render a name field as `branch <name> already carries…`, so the git-legal name `-D-victim`
  // put the literal `branch -D` back into the live-holder arm whose pinned contract is that the
  // string appears nowhere in it — falsified by the REF NAME this time rather than by the
  // evidence, and `defang` cannot reach it: a name has no whitespace left by the line above, so
  // there is no verb-plus-option shape in it to rewrite. The `?` is PREPENDED rather than
  // substituted so the name still reads in full (a reader has to be able to look it up), it is
  // the same character this function already folds to, and no name git's own CLI accepts without
  // a `--` starts with a dash.
  return foldEvidence(named.startsWith('-') ? `?${named}` : named)
}

/**
 * Fetch stderr can carry a credentialed remote URL; the refusal is persisted and re-read, so
 * never echo one raw. Mirrors `redactPushError` in orchestrator.ts (importing it from there
 * would cycle): userinfo before an `@`, bare token shapes, then whole URLs. Bound the length
 * too — a refusal is a sentence, not a transcript.
 *
 * THE PASSES ARE ORDERED BY WHAT THEY COST, AND THE BOUND SITS BETWEEN THEM. The `\b`-anchored
 * token rules are quadratic in the length of ONE token (measured with these exact regexes: 8k
 * costs 87ms, 64k costs 5.1s, 1MB does not finish) and this composes on the launch tick,
 * synchronously, outside the evidence budget — so they only ever see the last SCRUB_INPUT_MAX
 * characters.
 *
 * The URL rules are LINEAR and run BEFORE that slice, which is a FIX and not a rearrangement
 * (Argus blocker): slicing first cut the `https://` off a long credentialed URL, so neither URL
 * rule matched what remained, punctuation in the password defeated the `\b` token rules, and the
 * TAIL OF THE CREDENTIAL was printed into a persisted, re-read refusal. The claim this replaces
 * — "anything a credential could hide in is still whole inside the last 2000 characters" — is
 * false for any credential longer than that bound. The linear passes are still bounded, by a scan
 * cap wide enough that a real remote URL cannot straddle it and cheap enough that one
 * left-to-right pass over it is unmeasurable (measured: 64k of adversarial input, under 2ms).
 */
const SCRUB_SCAN_MAX = 64_000
const SCRUB_INPUT_MAX = 2_000
const SCRUB_OUTPUT_MAX = 200
function scrub(s: string): string {
  const scanned = s.length > SCRUB_SCAN_MAX ? s.slice(-SCRUB_SCAN_MAX) : s
  // The linear passes see the WHOLE (scan-capped) input: forgery first, then the credentials
  // that live in a URL. Both are found by a left-to-right scan, so neither pays for the length.
  const cleaned = (defang(scanned)
      .replace(/(\w{1,32}:\/\/)[^/\s@]+@/g, '$1***@')
      .replace(/https?:\/\/\S+/g, '<url>')
      .slice(-SCRUB_INPUT_MAX))
      // PREFIXED CREDENTIALS, by SHAPE and not by vendor. The GitHub-only rule this replaces
      // let `glpat-…`, `xoxb-…`, `dop_v1_…` and every other forge's token through verbatim
      // into a persisted refusal — this repo talks to more than one remote, and a scrubber
      // that only knows one vendor's prefix is a scrubber that leaks. Keep the prefix (it
      // names WHICH credential leaked, which is the actionable half) and drop the secret.
      // The suffix must carry BOTH a letter and a digit, so ordinary hyphenated prose and
      // branch names ("wrong-base-guard-prints-a-remedy") are left readable.
      //
      // A LANE ID IS EXEMPT, for the same reason a 40-hex sha is below. `wf_<uuid>` is the
      // worktree/lane name a lock reason is BUILT from, and it is exactly the datum a reader
      // uses to tell the original lock owner from a recycled pid — redacting it to `wf_***`
      // hollows out the one quoted piece of evidence this arm exists to hand over, and buys
      // nothing, because a lane id is not a secret. Matched narrowly: `wf_` followed only by
      // hex digits and hyphens, which no credential body looks like.
      .replace(
        /\b([A-Za-z][A-Za-z0-9]*[-_])(?=[A-Za-z0-9_-]{16,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g,
        (match, prefix: string) => (/^wf_[0-9a-fA-F-]+$/.test(match) ? match : `${prefix}***`),
      )
      // UNPREFIXED ones (an AWS key id, a bare 32-char API key). A 40-hex object name is
      // EXEMPT: shas are the evidence this module exists to name, and redacting them would
      // hollow out the message to buy nothing — a hex sha is not a secret.
      .replace(/\b(?![0-9a-fA-F]{40}\b)(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}\b/g, '***')
      .trim()
  // TRUNCATION IS MARKED. The result is interpolated as a verbatim-looking quotation (`its
  // lock reads "…"`), and a lock reason over the bound lost its HEAD silently — the `claude
  // agent wf_x (pid N` prefix a reader needs to tell the original owner from a recycled pid.
  // A quotation that dropped something must say so.
  return cleaned.length > SCRUB_OUTPUT_MAX ? `…${cleaned.slice(-SCRUB_OUTPUT_MAX)}` : cleaned
}

/**
 * Reimplements the reaper's porcelain shape (~20 lines) on purpose: `parseWorktrees` there is
 * module-private and DISCARDS the lock reason, which is exactly the datum this guard needs.
 *
 * Reads the `-z` form: each attribute is NUL-terminated and an EMPTY attribute (a second NUL)
 * ends the record. The newline form cannot be parsed safely — a worktree path may legally
 * contain a newline, and such a path splits its own record, so the branch reads as UNHELD and
 * the safe-delete arm prints a delete for a branch a live lane is standing on.
 */
function parseHolders(stdout: string): WorktreeHolder[] {
  const holders: WorktreeHolder[] = []
  let holder: WorktreeHolder | null = null
  const close = (): void => {
    if (holder !== null && holder.path !== '') holders.push(holder)
    holder = null
  }
  for (const field of stdout.split('\0')) {
    if (field === '') {
      close()
      continue
    }
    holder ??= { path: '', branch: null, lock_reason: null, prunable: false }
    if (field.startsWith('worktree ')) holder.path = field.slice('worktree '.length)
    else if (field.startsWith('branch ')) holder.branch = field.slice('branch '.length)
    else if (field === 'locked') holder.lock_reason = ''
    else if (field.startsWith('locked ')) holder.lock_reason = field.slice('locked '.length)
    else if (field === 'prunable' || field.startsWith('prunable ')) holder.prunable = true
  }
  close()
  return holders
}

/**
 * WHAT A WORKTREE'S IN-PROGRESS REBASE IS REBASING — the branch git leaves OUT of its listing.
 *
 * `git worktree list --porcelain` reports a worktree with a rebase in progress as DETACHED: it
 * prints no `branch` attribute at all, so a branch a rebase is standing on reads as UNHELD, and
 * the composer walks past the holder arms to the publication comparison and its delete. The
 * delete then fails closed (git refuses to delete a branch a rebase holds), but the refusal
 * would have ASSERTED "found no worktree holding the branch" and printed the one instruction
 * that class of message forbids — a false statement of evidence, which is this module's subject.
 *
 * Git records the name in the rebase state directory (`rebase-merge/head-name` for the
 * interactive/merge backend, `rebase-apply/head-name` for the am backend), and that directory
 * lives in the worktree's ADMINISTRATIVE dir — which the worktree's own `.git` FILE names. That
 * indirection is READ rather than assumed: the admin directory is usually the tree's basename,
 * but a renamed directory breaks that guess, and guessing here would put the answer back where
 * it started.
 *
 * A REBASE IS NOT THE ONLY OPERATION GIT OMITS THE BRANCH FOR (Argus finding). `git bisect`
 * detaches HEAD the same way and records the branch it started from in `BISECT_START` — so a
 * worktree mid-bisect ALSO reads as detached in the listing while genuinely holding the branch.
 * Measured on git 2.43 in a scratch repo: `worktree list --porcelain -z` prints `detached` and
 * no `branch` attribute, `BISECT_START` contains the bare name `feat`, and `git branch -D feat`
 * exits 1 with "cannot delete branch 'feat' used by worktree at ...". The delete therefore fails
 * closed either way; what does NOT fail closed is the sentence in front of it, which asserted
 * the guard "found no worktree holding the branch" — a false statement of evidence, which is
 * this module's whole subject. `BISECT_START` may also hold a 40-hex object name (a bisect
 * started from an already-detached HEAD), and that case holds no branch at all.
 *
 * The three answers are kept apart for the reason every other probe here keeps them apart:
 * 'none' is a measurement (git says there is no rebase or bisect state), 'unknown' is the
 * absence of one. `state` names WHICH operation is holding it, so the refusal can describe the
 * one it found rather than the one it assumed.
 */
export type RebaseHead =
  | { kind: 'branch'; ref: string; state?: 'rebase' | 'bisect' }
  | { kind: 'none' }
  | { kind: 'unknown' }

export function readRebaseHead(worktree: string): RebaseHead {
  let gitDir: string
  try {
    const dotGit = join(worktree, '.git')
    if (statSync(dotGit).isDirectory()) gitDir = dotGit
    else {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
      if (pointer === null) return { kind: 'unknown' }
      gitDir = pointer[1]!
    }
  } catch {
    // Unreadable, or gone. Either way this is the ABSENCE of a measurement, not the measurement
    // that there is no rebase — and the caller treats it as such.
    return { kind: 'unknown' }
  }
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      const ref = readFileSync(join(gitDir, dir, 'head-name'), 'utf8').trim()
      if (ref !== '') return { kind: 'branch', ref, state: 'rebase' }
    } catch (err) {
      // ENOENT is the measurement "no rebase of that kind is in progress"; anything else is not.
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return { kind: 'unknown' }
    }
  }
  try {
    // `BISECT_START` carries the BARE branch name git left, so it is qualified here; a bisect
    // begun from a detached HEAD records a 40-hex object name instead, which holds no branch.
    const start = readFileSync(join(gitDir, 'BISECT_START'), 'utf8').trim()
    if (start !== '' && !/^[0-9a-f]{40}$/i.test(start)) {
      return { kind: 'branch', ref: start.startsWith('refs/') ? start : `refs/heads/${start}`, state: 'bisect' }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return { kind: 'unknown' }
  }
  return { kind: 'none' }
}

/**
 * Every UNKNOWN exit shares one tail: name what could not be established, authorise nothing.
 * `branchProse` is the FOLDED branch name — this renders prose, never a runnable command.
 *
 * AND EVERY CALL SITE PASSES THE FOLDED ONE (Argus finding). Three of the six passed the RAW
 * `branch`, so the enumeration-failed arm, the not-NUL-listing arm and the outer catch rendered
 * a legal branch name's U+2028 and its verbatim `branch -D` inside a refusal contracted to
 * authorise nothing — the exact forgery the other three arms fold out. The parameter is named
 * for the folded value and the type system cannot tell two strings apart, so the rule lives
 * here: nothing but `branchProse` may reach this argument.
 */
function unknownHolder(prefix: string, branchProse: string, what: string, detail: string): string {
  return `${prefix}The wrong-base launch guard ${what} (${detail}) — the holder is UNKNOWN, and UNKNOWN does not authorise anything destructive. Determine by hand which worktree holds ${branchProse} before touching it, then re-dispatch only once it is free.`
}

/**
 * The live / treat-as-live arms differ only in the evidence sentence they open with — and in
 * whether "until that worktree releases it" names a release anybody will actually perform.
 *
 * WHO RELEASES IT. A lane that is genuinely ALIVE releases its own tree when it finishes, so
 * for that arm the wait terminates. For the arms that only TREAT the holder as live — an
 * unreadable /proc, a lock naming no pid — the wait may never terminate, so they get `settle`
 * instead: a NON-destructive way to settle the question by hand, because "wait for a release
 * that never comes" is advice that wedges the card forever, and this module's whole subject is
 * not printing advice it has not established.
 *
 * AND THE SENTENCE THAT SAYS WHY DEPENDS ON THE LOCK — AND ON THE TREE'S NAME.
 * `worktree-reaper.ts` skips LOCKED trees by design (:222-227), so for those nothing in this
 * system ever performs the release. An UNLOCKED tree may be the exact shape the reaper DOES
 * release on its own — but only if its basename begins `wf_`, which is the first clause of the
 * reaper's own candidate filter (:221-227). A hand-made worktree that happens to be unlocked
 * is never swept, so telling its operator "this may clear without you" states a premise this
 * repo's own code disproves — the same defect, in the other direction, as telling the operator
 * of a `wf_*` tree that nothing will ever release it. Measured on this checkout: 0 of 23 live
 * worktree entries are locked, so the unlocked-and-reapable shape is the one that fires in
 * production.
 */
type ReleaseKind = 'locked' | 'reaper' | 'manual'
function standDown(prefix: string, evidence: string, settle?: string, release: ReleaseKind = 'locked'): string {
  const releases =
    release === 'locked'
      ? 'nothing releases a LOCKED worktree automatically (the reaper skips locked trees), so settle it by hand before re-dispatching'
      : release === 'reaper'
        ? 'git reports this tree UNLOCKED, which is the shape the worktree reaper releases on its own once nothing is standing in it and it is past its retention — so this may clear without you; if it has not, settle it by hand before re-dispatching'
        : 'git reports this tree UNLOCKED, but the worktree reaper only sweeps trees whose directory name begins wf_ and this one\'s does not, so nothing in this system releases it on its own: settle it by hand before re-dispatching'
  const tail =
    settle === undefined
      ? ' do not re-dispatch this card until that worktree releases it.'
      : ` ${releases}: ${settle}`
  return `${prefix}${evidence} Stand down: do not delete the branch, and${tail}`
}

/**
 * The by-hand settle for every treat-as-live arm: look at the tree, and read the lock back
 * from git. Both are READS. Neither unlocks, removes, signals or deletes anything — an
 * UNKNOWN holder authorises no irreversible act (docs/INVARIANTS.md §12 invariant 122).
 *
 * AND IT SAYS WHAT ITS OWN FAILURE MEANS. Git does NOT mark a LOCKED entry prunable, so a
 * locked worktree whose DIRECTORY was deleted never reaches the prunable short-circuit above
 * and lands here — where `git -C <missing dir> status` exits 128 and the reader is left with a
 * settle that cannot run and no idea why. Naming that exit and what it proves costs one
 * sentence. It stops there: this is a TREAT-AS-LIVE arm, so it names no release, not even the
 * bookkeeping one, because the release is exactly what has not been established.
 */
function settleByHand(repo: string, wt: string): string {
  return `git -C ${sh(wt)} status --porcelain --ignored shows what is in it and git -C ${sh(repo)} worktree list --porcelain shows whether it is still locked; only once a person has established the tree is abandoned should it be released. Should that first command exit 128, the tree's DIRECTORY is already gone — and since git never marks a LOCKED entry prunable, it will keep appearing in the listing until a person clears the administrative entry by hand, which is a call for someone with the whole picture and not one this refusal makes.`
}

/**
 * The occupancy RE-CHECK, printed for the reader to run at the moment they act.
 *
 * `git status --porcelain --ignored` was the only preflight this module used to print, and it
 * answers a DIFFERENT question — what is in the tree, not who is standing in it. A tree that
 * was empty and unoccupied when this refusal was composed can be entered before it is read,
 * and `worktree remove` then succeeds underneath the occupant (measured: its `/proc/<pid>/cwd`
 * becomes `<worktree> (deleted)`). This is the same read the composer performs, expressed as a
 * shell one-liner so the reader can repeat it — a `readlink` per pid, no signal, no name match.
 * It exits 1 and prints nothing when the tree is clear.
 */
function occupancyScan(wt: string): string {
  return `ls -l /proc/[0-9]*/cwd 2>/dev/null | grep -F -- ${sh(wt)}`
}

/**
 * Compose the wrong-base refusal's remedy. NEVER throws: `launch()` invokes this outside the
 * fire's own error handling (see the RB2 note there), so an escape would leave the run stuck
 * non-terminal with no dispatch id, retrying every tick.
 */
export async function composeWrongBaseRefusal(
  args: WrongBaseRefusalArgs,
  deps: WrongBaseRemedyDeps,
): Promise<string> {
  const { repo, branch, base, branch_tip, ahead_count } = args
  // THE BRANCH NAME IS EVIDENCE LIKE ANY OTHER, so it is folded for PROSE and left raw for the
  // refs and the `sh()`-quoted arguments (a remedy that names a different branch than the one on
  // disk cannot be run). git's ref rules exclude ASCII control characters and NOTHING ELSE this
  // module folds: reproduced on git 2.43, `git branch` accepted and `rev-parse --verify` resolved
  // both `feat<U+2028>FORGED<U+00A0>run<U+00A0>git<U+00A0>branch<U+00A0>-D<U+00A0>victim` — a line
  // separator several renderers break on — and `feat<U+202E>evil`, a bidi override that reorders
  // what is DISPLAYED without changing a byte. A legal branch name could therefore draw a line of
  // this guard's own message, carrying the instruction the live-holder arm's contract forbids.
  //
  // AND IT IS FOLDED AS A NAME, NOT AS FREE PROSE (Argus blocker). `foldEvidence` folds those
  // codepoints to an ASCII SPACE, and the ASCII space is the one character git's ref rules
  // forbid — which is precisely what `delivery.ts`'s `WRONG_BASE_PREFIX` anchors on when it
  // spells these two fields `[^ \n]+`. So the fold itself put a space inside a name field, the
  // anchor missed, and this refusal fell through to the classifiers that answer "Reply to
  // retry the build". `foldRefName` keeps every name field a single token; see its docblock.
  // THE BASE IS A NAME FIELD TOO: it reaches here from `detectBaseBranch`/`opts.base_branch`
  // and can carry the same codepoints for the same reason.
  const branchProse = foldRefName(branch)
  const baseProse = foldRefName(base)
  const prefix = `branch ${branchProse} already carries ${ahead_count} commit(s) not on origin/${baseProse} — it was not cut from origin/${baseProse}; refusing to build on another lane's work. `
  try {
    // PER-RUN, not per-branch (orchestrator.ts:2608 is the same namespace). A stable
    // `trident-salvage/<branch>` tag would MOVE on the next salvage of the same branch and
    // make the previous receipt's commit unreachable; a receipt the next receipt can destroy
    // is not one. Computed INSIDE the try because this function's contract is that it never
    // throws — `launch()` calls it outside the fire's own error handling.
    //
    // Named WITHOUT the `refs/tags/` prefix on purpose: `delivery.ts:171` treats that literal
    // token in a failure_reason as a RECEIPT and renders "Recovery snapshot: <ref>." So
    // spelling the fully-qualified ref here would tell the operator a snapshot exists that
    // this module never created — the module would be manufacturing the false evidence it
    // exists to prevent. `git tag` also refuses an existing tag without `-f`, so the
    // create-only property survives the shorter form.
    const salvageTag = `trident-salvage/${args.run_id.trim() !== '' ? args.run_id.trim() : branch_tip}`
    const salvage = (): string => `git -C ${sh(repo)} tag ${sh(salvageTag)} ${sh(branch_tip)}`
    // TOTAL evidence budget (Argus finding 10): priced at each spawn, so whatever one command
    // consumed is gone for the next.
    //
    // AND ENFORCED HERE, BY THE COMPOSER. The clamp used to floor at 1ms and spawn anyway,
    // which made the guarantee "a spent budget degrades to UNKNOWN" a property of the RUNNER:
    // true for the shipped `spawnCapture` (it kills the child at the timeout it is given, so
    // every path lands on !ok/timed_out → UNKNOWN), false for any injected run_host that
    // ignores `timeoutMs` — and a plan-level guarantee must not rest on a dependency's
    // goodwill. A spent budget now returns the killed-child shape WITHOUT spawning, so the
    // existing UNKNOWN handling at every call site answers, and `exhausted` lets the evidence
    // say what actually happened rather than blaming a watchdog that never ran.
    const now = deps.now ?? Date.now
    const t0 = now()
    let exhausted = false
    /** The budget ran out with a command STILL RUNNING — a different fact from `exhausted`. */
    let deadlined = false
    const run = async (
      argv: string[],
      env: Record<string, string> | undefined,
      perCall: number,
    ): Promise<Awaited<ReturnType<RunHostCommand>>> => {
      const left = TOTAL_BUDGET_MS - (now() - t0)
      if (left <= 0) {
        exhausted = true
        // 124 is the shell's timeout convention; `timed_out` is what the call sites read.
        return { ok: false, stdout: '', stderr: '', exit_code: 124, timed_out: true }
      }
      // AND THE DEADLINE IS ENFORCED ON THE IN-FLIGHT CALL TOO. The check above only refuses to
      // START a command once the budget is gone, which leaves the runner holding the guarantee
      // for every command that IS started — the same dependency's-goodwill argument the
      // paragraph above rejects, one step further in. Racing each call against what remains of
      // the budget makes the bound the COMPOSER's whatever the runner does. The losing promise
      // is ABANDONED, never killed: this module signals nothing, and a runner that eventually
      // answers is answering into a result nobody reads.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          deps.run_host(argv, repo, env, Math.min(perCall, left)),
          new Promise<Awaited<ReturnType<RunHostCommand>>>((resolve) => {
            timer = setTimeout(() => {
              deadlined = true
              resolve({ ok: false, stdout: '', stderr: '', exit_code: 124, timed_out: true })
            }, left)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    /** Every "the watchdog killed it" detail has a second shape: the budget was already gone. */
    const killedDetail = (watchdog: string): string =>
      exhausted
        ? `the composition's whole ${TOTAL_BUDGET_MS}ms evidence budget was already spent, so this command was never run`
        : deadlined
          ? `the composition's whole ${TOTAL_BUDGET_MS}ms evidence budget ran out while this command was still running, so the composer stopped waiting for it`
          : watchdog
    const occupancy = (wt: string, nested: string[]): TreeOccupancy => {
      try {
        const probe = deps.probe_tree
        return probe ? probe(wt, nested) : probeTreeOccupancy(wt, deps.proc_root ?? '/proc', nested)
      } catch {
        return { kind: 'unknown' }
      }
    }
    const listed = await run(['git', '-C', repo, 'worktree', 'list', '--porcelain', '-z'], undefined, LOCAL_TIMEOUT_MS)
    if (!listed.ok) {
      return unknownHolder(
        prefix,
        branchProse,
        "could not enumerate worktrees to find the branch's holder",
        // A killed child writes no stderr; without this the detail renders empty.
        listed.timed_out === true
          ? killedDetail('the enumeration was killed by its watchdog')
          : scrub(listed.stderr),
      )
    }

    // THE FORM THIS PARSER WAS ASKED FOR IS THE FORM IT MUST GET. `parseHolders` splits on NUL
    // only, so a newline-delimited listing (a stub runner, a git too old for `-z`) parses as
    // ONE branchless record — non-empty, so the empty-listing guard above passes it — and the
    // branch reads as UNHELD, which is the walk to `branch -D` on a tree a lane is standing
    // in. Every real `-z` listing ends its first record with a NUL, so its absence is decisive.
    //
    // THE STREAM MUST ALSO BE WHOLE, not merely NUL-bearing. A "no NUL at all" test was here
    // and it is necessary but not sufficient: a stream CUT MID-RECORD still carries the NULs of
    // every complete record before the cut, so `worktree /repo\0HEAD <sha>\0branch
    // refs/heads/main\0\0worktree /repo/wt\0HEAD <sha>\0` — the holder's record truncated
    // before its `branch` attribute — passed, parsed the holder with branch:null, missed the
    // find below, and walked to the publication comparison and its delete. Every complete `-z`
    // listing ends with the empty attribute that terminates its LAST record (measured on git
    // 2.43: the stream ends `\0\0`), so the terminator's absence is decisive about truncation
    // the way a missing NUL is decisive about the wrong form. An EMPTY stdout is excluded
    // because it has its own, more accurate arm below.
    if (listed.stdout !== '' && !listed.stdout.endsWith('\0\0')) {
      return unknownHolder(
        prefix,
        branchProse,
        'got a worktree listing that is not the NUL-delimited form it asked for',
        listed.stdout.includes('\0')
          ? 'git worktree list --porcelain -z exited 0 but its output does not end in the empty attribute that terminates a record, so the stream was cut mid-record and a holder may have lost the branch attribute that names it'
          : 'git worktree list --porcelain -z exited 0 and wrote no NUL at all, a form in which a path containing a newline splits its own record',
      )
    }

    const all = parseHolders(listed.stdout)
    // AN EMPTY LISTING IS NOT "NOBODY HOLDS IT". Real git always lists the shared checkout
    // first, so zero records means the enumeration told us nothing — a stub, a truncated
    // stream, a git that wrote its answer somewhere we did not read. Reading that silence as
    // "unheld" walks straight into the publication comparison and can end at `branch -D` for a
    // branch a live lane is standing on, which is this card's own incident.
    if (all.length === 0) {
      return unknownHolder(
        prefix,
        branchProse,
        'got an EMPTY worktree listing, which real git never produces',
        "git worktree list exited 0 and named no worktree at all, not even the repo's own checkout",
      )
    }
    // WHO, IF ANYBODY, RELEASES A TREE THIS GUARD IS NOT ALLOWED TO TOUCH. Derived from the
    // FIRST clause of the worktree reaper's own candidate filter (worktree-reaper.ts:221): it
    // sweeps only UNLOCKED trees whose directory name begins `wf_`. Hoisted here because the
    // rebase/bisect arm needs the same answer the holder arms need, and it used to take
    // `standDown`'s DEFAULT — 'locked' — which asserts a lock the guard never established
    // (Argus finding: an unlocked, reapable `wf_*` tree mid-rebase was told "nothing releases a
    // LOCKED worktree automatically", contradicting worktree-reaper.ts:221-227).
    const releaseKind = (w: WorktreeHolder): ReleaseKind =>
      w.lock_reason !== null ? 'locked' : basename(w.path).startsWith('wf_') ? 'reaper' : 'manual'
    const holder = all.find((w) => w.branch === `refs/heads/${branch}`)
    if (!holder) {
      // A REBASE HOLDS A BRANCH WITHOUT APPEARING TO. Git prints no `branch` attribute for a
      // worktree mid-rebase — it reports detached — so the match above misses it and every arm
      // below this point is an UNHELD arm, one of which prints a delete. The delete fails
      // closed, but the sentence in front of it says the guard "found no worktree holding the
      // branch", which is false, and this module exists because a remedy resting on a fact
      // nobody established is worse than no remedy. Reachable in this repo's own flow:
      // `merge.ts` rebases in the shared checkout.
      //
      // AND A BISECT IS THE SAME FAMILY (Argus finding), which is why the probe reads both:
      // `git bisect` detaches HEAD too and names the branch it left in `BISECT_START`, so a
      // tree mid-bisect held the branch while this arm reported nobody did.
      let unreadable: string | null = null
      const readHead = deps.rebase_head ?? readRebaseHead
      for (const w of all) {
        // Only DETACHED entries can be hiding one, and a PRUNABLE entry's directory is already
        // gone — it has its own arm above and nothing to read.
        if (w.branch !== null || w.prunable || w.path === '') continue
        let head: RebaseHead
        try {
          head = readHead(w.path)
        } catch {
          head = { kind: 'unknown' }
        }
        if (head.kind === 'branch' && head.ref === `refs/heads/${branch}`) {
          // The operation is NAMED from what was read, never assumed: `BISECT_START` and a
          // rebase `head-name` are different measurements, and telling the reader to finish or
          // abort a rebase that is actually a bisect is the same defect as any other unfounded
          // sentence here — `git rebase --abort` exits 1 in a bisecting tree.
          const bisecting = head.state === 'bisect'
          const found = bisecting
            ? `has a BISECT in progress that was started from ${branchProse}`
            : `has a REBASE in progress whose head-name is ${branchProse}`
          // `git bisect reset` IS A CHECKOUT, AND IT HAS THE SAME IGNORED-FILE BLIND SPOT AS
          // EVERY OTHER ONE IN THIS MODULE (Argus blocker). An earlier draft printed it as
          // bookkeeping — "returns the branch to that worktree" — with no caveat, while the
          // DEAD-holder arm below discloses the identical data-loss class for `worktree remove`
          // and the shared-checkout arm above prints a preflight for it. Reproduced on git 2.43
          // in a scratch repo: mid-bisect, `git status --porcelain --ignored` showed
          // `!! local.env` holding local-only content; `git bisect reset` exited 0, restored the
          // starting branch, and silently replaced that file with the branch's tracked copy. So
          // the same read this arm already prints is named as the preflight, and the order is
          // stated — moved aside BEFORE the reset, because after it there is nothing left to
          // move. The rebase spelling gets it too: `git rebase --abort` restores the head-name
          // branch by the same checkout.
          const ends = bisecting
            ? 'That bisect is ended by whoever started it — but git bisect reset is a CHECKOUT and not bookkeeping: it restores the branch in that worktree, and a file that is IGNORED in the bisected state but TRACKED on the branch it returns to is silently replaced with that branch\'s copy, exit 0, no refusal (measured on git 2.43 with a gitignored local .env — the same blind spot disclosed for worktree remove elsewhere in this guard). The --ignored read above is what names such a file; move it aside BEFORE the reset, not after'
            : 'That rebase is finished or aborted by whoever started it, and the branch returns to that worktree when it is — but the abort restores that branch by CHECKOUT, so a file IGNORED mid-rebase and TRACKED on the branch it returns to is silently replaced with that branch\'s copy, exit 0, no refusal; the --ignored read above is what names such a file, and it is moved aside BEFORE the abort'
          return standDown(
            prefix,
            `The wrong-base launch guard found no worktree with ${branchProse} CHECKED OUT, but worktree ${foldEvidence(w.path)} ${found} — git omits the branch attribute for a worktree in that state, so a listing alone reads the branch as unheld while that operation is standing on it.`,
            `${settleByHand(repo, w.path)} ${ends}; nothing here authorises deleting it in the meantime.`,
            releaseKind(w),
          )
        }
        if (head.kind === 'unknown') unreadable ??= w.path
      }
      if (unreadable !== null) {
        return unknownHolder(
          prefix,
          branchProse,
          'found a DETACHED worktree whose rebase or bisect state it could not read',
          `worktree ${foldEvidence(unreadable)} reports no branch, and a rebase or bisect in progress there would hold ${branchProse} without saying so in the listing — that state could not be read, so whether it holds the branch is UNKNOWN`,
        )
      }
    }
    if (holder) {
      // HELD: no network call in this arm. Whoever holds the branch settles the question, and
      // publication cannot make deleting a checked-out branch safe.
      const wt = holder.path
      // THE PROSE CARRIES A DEFANGED RENDERING OF THE PATH; THE COMMANDS CARRY THE REAL ONE.
      // A worktree path is attacker-shaped data by the same standard as a lock reason — `git
      // worktree add` accepts a newline in one, and this module's whole `-z` parser exists
      // because of it — and every sentence below interpolates it RAW into text an agent reads
      // as the guard's own evidence. Reproduced: a holder path containing a newline followed by
      // `…git -C /repo branch -D -- feat-x` forged a whole extra LINE of the live-holder
      // refusal, carrying the one instruction that arm's contract forbids. The commands keep
      // `sh(wt)` — a remedy has to be runnable, and `sh` now encodes control characters rather
      // than quoting them through.
      const wtProse = foldEvidence(wt)
      // Every OTHER checkout git knows about. The probe keeps only those STRICTLY INSIDE `wt`
      // — on this box worktrees live under `<repo>/.claude/worktrees/`, so the shared checkout
      // in this list is an ANCESTOR of `wt` and must not take pids away from it.
      const nested = all.map((w) => w.path).filter((p) => p !== wt && p !== '')
      const seenIn = (tree: string): TreeOccupancy => occupancy(tree, nested)
      const settle = (): string => settleByHand(repo, wt)
      // The second clause of the reaper's candidate filter, used on its own by the message that
      // asks whether UNLOCKING this tree exposes it to a sweep (there the lock is the thing
      // being removed, so `releaseKind`'s lock test would answer the wrong question).
      const reapable = basename(wt).startsWith('wf_')
      if (samePath(wt, repo)) {
        // The holder is the repo's OWN shared checkout — the shape a crash mid-merge leaves
        // (merge.ts checks the shared checkout onto the run branch and restores the base
        // afterwards). There is no other lane to wait for, so "stand down until that worktree
        // releases it" would name a release nobody can ever perform.
        // THE PRINTED SWITCH IS NOT THE REFUSAL-FREE OPERATION IT LOOKS LIKE. This message used
        // to say the guard "did not measure whether that checkout is clean, and it does not
        // need to — checkout REFUSES rather than overwriting a modified file". The literal
        // clause is true and the conclusion drawn from it is not: a file that is IGNORED on
        // this branch but TRACKED on the base is replaced with the base's content silently,
        // exit 0, no refusal (reproduced on git 2.43: a gitignored `local.env`, untracked
        // here, tracked on main, was overwritten by `git checkout main`). That is the same
        // ignored-file blind spot already disclosed for `worktree remove` two arms down, and
        // advertising a safety property the command does not have is exactly the defect this
        // module exists to remove. So: print the preflight, and name what it is for.
        //
        // `switch -- <base>` rather than `checkout <base>`: `--` before the argument is what
        // stops an option-shaped base rendering as a flag in text a reader is told to RUN,
        // and `git checkout <base> --` does not give that (the name is still parsed as an
        // option). Measured on git 2.43: `git switch -- <branch>` switches exactly like
        // `git checkout <branch>`.
        return `${prefix}The wrong-base launch guard found the branch checked out in the repo's OWN shared checkout at ${wtProse} — no separate worktree holds it, so there is no other lane to wait for; this is the shape a run that crashed mid-merge leaves behind. Restore the shared checkout to the base once no merge is in flight, and preflight it FIRST, because this guard did not measure that checkout and the switch is not the refusal-free operation it looks like: git -C ${sh(repo)} status --porcelain --ignored lists what is there. Switching REFUSES a tracked modification, and such a refusal is work to look at rather than force past — but a file ignored here and TRACKED on ${baseProse} (a local-only .env is the measured case) is silently replaced with the base's copy and nothing is said, so move any such file aside before you switch. Only then: git -C ${sh(repo)} switch -- ${sh(base)}. Then re-resolve the branch. Nothing here authorises deleting it.`
      }
      if (holder.prunable) {
        // The directory is gone; git still lists the administrative entry, so the branch reads
        // as checked out and no lane can ever release it. Pruning is the derivable remedy.
        // Repo-wide `worktree prune` is deliberate (Argus nit 12): git has no path-scoped prune,
        // and prune clears only administrative entries whose directories are already GONE, so
        // its breadth cannot take a live tree away from anyone.
        return `${prefix}The wrong-base launch guard found the branch checked out in worktree ${wtProse}, which git reports PRUNABLE — its directory is gone, so no lane can ever release it. Clear the stale administrative entry first: git -C ${sh(repo)} worktree prune. Then re-resolve the branch; nothing here authorises deleting it yet.`
      }
      // The lock reason reads `claude agent wf_x (pid N start M)`; git prints it verbatim, so
      // match the pid rather than parsing the whole reason. The reason is quoted back whole
      // because the `start` field this guard does not interpret is exactly what a reader needs
      // to tell a recycled pid from the original owner.
      const pidMatch = holder.lock_reason ? /\bpid\s+(\d+)/.exec(holder.lock_reason) : null
      if (!pidMatch) {
        // Distinguish the two shapes that reach here: real git prints NO `locked` line for an
        // unlocked worktree, so claiming its lock was unreadable would name absent evidence.
        //
        // AND AN EMPTY REASON IS ITS OWN SHAPE: `git worktree lock` with no `--reason` prints a
        // bare `locked` line, which rendered as `whose lock ("") names no pid` — a quotation of
        // nothing, offered as evidence.
        const lockState =
          holder.lock_reason === null
            ? 'and git reports no lock on it at all, so no owning pid is recorded anywhere'
            : holder.lock_reason === ''
              ? 'which git reports LOCKED with no reason recorded at all, so no owning pid is named'
              : `whose lock ("${scrub(holder.lock_reason)}") names no pid`
        const seen = seenIn(wt)
        if (seen.kind === 'occupied') {
          return standDown(
            prefix,
            `The wrong-base launch guard found the branch checked out in worktree ${wtProse} ${lockState} — but pid ${seen.pid} is standing inside that tree, so it is ALIVE.`,
          )
        }
        return standDown(
          prefix,
          `The wrong-base launch guard found the branch checked out in worktree ${wtProse} ${lockState}, so the holder's liveness is UNKNOWN — treat it as live.`,
          settle(),
          releaseKind(holder),
        )
      }
      const lockQuote = ` (its lock reads "${scrub(holder.lock_reason ?? '')}")`
      // Rendered from the RAW digits, never from the parsed number: an oversized lock pid
      // (`pid 1000000000000000000000000`) stringifies as "1e+24", which names no process a
      // reader can look up. The parsed value is only for the probe, which answers 'unknown'
      // for anything at or above PID_MAX_LIMIT.
      const pidText = pidMatch[1]!
      const pid = Number.parseInt(pidText, 10)
      // ...AND WHEN THE TWO DISAGREE, BOTH ARE NAMED (Argus finding). Rendering the raw digits
      // alone made the arm name a pid it had not measured: a lock reason spelling `pid 0000123`
      // probes 123 and printed `0000123`, so a reader looking that number up finds nothing while
      // the liveness verdict beside it rests on a different process entirely. This arm's whole
      // contract is naming the evidence it measured, so the probed value is stated whenever the
      // canonical decimal differs from what the lock wrote. The repo's own lock writer emits
      // plain decimal, so this renders identically for every lock trident itself takes.
      const pidShown = Number.isSafeInteger(pid) && String(pid) !== pidText ? `${pidText} (probed as ${pid})` : pidText
      let liveness: PidLiveness
      try {
        liveness = (deps.probe_pid ?? probePidLiveness)(pid)
      } catch {
        liveness = 'unknown'
      }
      if (liveness === 'alive') {
        return standDown(
          prefix,
          // "another lane owns this branch" was an attribution this guard never established:
          // the args carry the refusing run's id but not its own worktree path, and the card's
          // second measured instance (run ef81d378, PR #497) was held by THIS card's own
          // relocked tree. The refusal and the remedy are identical either way; only the claim
          // about whose lane it is was unevidenced, so it is stated as the open question it is.
          `The wrong-base launch guard found the branch checked out in worktree ${wtProse}, whose lock names pid ${pidShown}${lockQuote}, and that process is ALIVE — a live holder owns this branch. Whose lane it is was not established here: it may be another lane, or this card's own earlier attempt that crashed and relocked.`,
        )
      }
      if (liveness === 'zombie') {
        // A DEFUNCT PROCESS IS NOT A LANE THAT WILL FINISH. Its pid is still taken, so the tree
        // is not releasable on the DEAD arm's evidence; but it will never release the tree
        // itself either, so the ALIVE arm's "wait for that worktree to release it" names a
        // release nobody will perform. Treat-as-live WITH a by-hand settle is the only honest
        // answer, and it authorises nothing.
        return standDown(
          prefix,
          `The wrong-base launch guard found the branch checked out in worktree ${wtProse}, whose lock names pid ${pidShown}${lockQuote}; that process is a ZOMBIE — it has exited and has not been reaped, so it still holds its pid but will never release this tree of its own accord.`,
          settle(),
        )
      }
      if (liveness === 'dead') {
        // A dead lock pid does not prove the TREE unoccupied, and this is the only arm that
        // proposes removing it, so cross-check occupancy the way the reaper does.
        const seen = seenIn(wt)
        if (seen.kind === 'occupied') {
          return standDown(
            prefix,
            `The wrong-base launch guard found the branch checked out in worktree ${wtProse}, whose lock names pid ${pidShown}${lockQuote}; that pid is gone, but pid ${seen.pid} is standing inside that tree, so it is still occupied.`,
            settle(),
          )
        }
        if (seen.kind === 'unknown') {
          // MEASURED, and the number is the point: on this host ~360 of ~445 /proc entries are
          // unreadable to this uid (281 of them root-owned), and ONE unreadable entry anywhere
          // on the box is enough — the probe's veto is global, not per-tree. So off euid 0 this
          // arm is not "the one that usually fires": it is the one that ALWAYS fires, and the
          // DEAD arm below is deterministically unreachable, not merely unlikely. Stating that
          // precisely is the point of this comment; an earlier draft said "close to
          // unreachable", which understates a certainty.
          //
          // It is not fixable from here without giving up the veto: a process whose cwd cannot
          // be read may be standing in this tree, and 'clear' is the answer that reaches
          // `worktree remove`. So the degradation stays, in the SAFE direction (it authorises
          // nothing) — and what this arm owes the reader instead is the read that CONVERTS the
          // unknown into an answer, plus what answer would make the tree releasable. Naming the
          // conclusion is not printing the command: an unresolved occupancy still authorises
          // no irreversible act (docs/INVARIANTS.md §12 invariant 122).
          return standDown(
            prefix,
            `The wrong-base launch guard found the branch checked out in worktree ${wtProse}, whose lock names pid ${pidShown}${lockQuote}; that pid is gone, but /proc could not be read in full to confirm the tree is unoccupied (the usual cause is processes owned by another uid, whose cwd this guard may not read), so occupancy is UNKNOWN — treat it as live.`,
            `${settle()} ${occupancyScan(wt)} answers the part this guard could not, if run where those entries are readable; only once it names nothing, with the lock still the dead pid's, is the tree releasable.`,
          )
        }
        // THE ORDER IS THE POINT. This procedure used to print unlock, then remove, then "run
        // BOTH preflights immediately before the remove" — and the preflights do not need the
        // tree unlocked, while the unlock has a cost of its own: `worktree-reaper.ts:221-227`
        // sweeps `wf_*` trees that are NOT locked, and its dirt check deliberately ignores
        // ignored files, so between the operator's unlock and their preflight a background
        // sweep can remove the tree and everything ignored in it. Preflights first, then the
        // unlock/remove pair back to back, and the exposure is named where it is real.
        const reaperWindow = reapable
          ? ' The unlock is itself an exposure, and this tree is named wf_*: the worktree reaper sweeps exactly those when they are NOT locked, and its dirt check ignores ignored files, so run the pair back to back — any gap is a window in which the reaper, not you, removes this tree.'
          : ''
        return `${prefix}The wrong-base launch guard found the branch checked out in worktree ${wtProse}, whose lock names pid ${pidShown}${lockQuote}; that process is DEAD and no process is standing inside the tree. Release the stale worktree, and run BOTH preflights FIRST — neither needs the lock off, and that occupancy was SAMPLED when this refusal was composed and is read minutes to hours later. git -C ${sh(wt)} status --porcelain --ignored lists what is in the tree — remove DELETES ignored local-only files (build output, .env, logs) without refusing, and only refuses tracked modifications and untracked non-ignored files, a refusal that is unpushed work to salvage rather than force past. status does NOT re-check occupancy, and NEITHER DOES remove — it refuses on tracked modifications and untracked non-ignored files and never on a process standing in the tree (measured on git 2.43: a non-force remove exited 0 under a live cwd and left that process in a deleted directory), so re-check it directly: ${occupancyScan(wt)} names any process standing in the tree right now, and it can only see processes this user may read. If either preflight names anything, stop. Only once both are clean: git -C ${sh(repo)} worktree unlock ${sh(wt)}, then git -C ${sh(repo)} worktree remove ${sh(wt)}.${reaperWindow} Only then reconsider the branch.`
      }
      return standDown(
        prefix,
        `The wrong-base launch guard found the branch checked out in worktree ${wtProse}; its lock names pid ${pidShown}${lockQuote} but liveness could not be determined — treat it as live.`,
        settle(),
      )
    }

    // NOT HELD: the only thing that can make the local ref disposable is that origin already
    // carries it. Establish publication before saying anything irreversible.
    let originSha: string | null = null
    let absent = false
    let unknownDetail: string | null = null
    let noOrigin = false
    // EXPLICIT destination refspec. `fetch origin <branch>` updates FETCH_HEAD and only
    // INCIDENTALLY refs/remotes/origin/<branch> — under a narrowed remote.origin.fetch it
    // exits 0 while the tracking ref stays STALE, and the comparison below would then rest on
    // a sha origin no longer carries and print a delete. Naming the destination closes that.
    const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`
    // Each attempt prices its budget at spawn time, so a retry can only spend what the total leaves.
    const fetchOnce = () =>
      run(
        ['git', '-C', repo, 'fetch', '--no-tags', 'origin', refspec],
        // The ONE marker this module reads out of git's own prose is matched below, and git
        // translates its messages. Pinning the child's locale is what makes that match a
        // measurement rather than a guess about the host's environment.
        //
        // GIT_TERMINAL_PROMPT=0 for the reason every other network git call in this repo sets
        // it (trident/codex-build.sh, worktree-cleanup.sh): this is the only child here that
        // touches a remote, it runs on the launch tick, and a remote that asks for credentials
        // would otherwise block on a terminal nobody is watching until the watchdog kills it —
        // spending the whole evidence budget to reach the same UNKNOWN a refusal reaches
        // immediately.
        { LC_ALL: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0' },
        FETCH_TIMEOUT_MS,
      )
    // Matched on RAW stderr, exactly once per attempt: `scrub()` keeps only the last 200
    // characters, so a verbose transport error would hide the marker and silently downgrade
    // the distinguishable "origin has no <branch> at all" arm into a generic UNKNOWN.
    const ABSENT_REF = /couldn'?t find remote ref/i
    let fetched = await fetchOnce()
    let absentRef = ABSENT_REF.test(fetched.stderr)
    // One retry, as the neighbouring base fetch in orchestrator.ts does: a transient network
    // failure should not cost the run its evidence. An absent ref is not transient, and a
    // watchdog kill is not either — retrying that one just spends the budget twice.
    if (!fetched.ok && !absentRef && fetched.timed_out !== true) {
      fetched = await fetchOnce()
      absentRef = ABSENT_REF.test(fetched.stderr)
    }
    if (!fetched.ok) {
      if (absentRef) absent = true
      else if (fetched.timed_out === true) {
        // Without this the message read "could not read origin/<b> ()" — an empty parenthesis
        // where the evidence should be, because a killed child writes no stderr.
        // No number: the total budget may have clamped this attempt below FETCH_TIMEOUT_MS, and evidence must not name a budget the child was never given.
        unknownDetail = killedDetail('the fetch exceeded its watchdog budget and was killed')
      } else {
        // Local-mode repos have no `origin` at all, and telling one to `git push origin` is
        // advice that cannot run. Ask before asserting.
        const remote = await run(['git', '-C', repo, 'remote', 'get-url', 'origin'], undefined, LOCAL_TIMEOUT_MS)
        if (remote.timed_out === true) {
          // A wedged probe proves nothing about the remote's existence. Before this branch, a
          // killed get-url fell into `noOrigin` and the message asserted "no reachable
          // 'origin' remote" — a positive claim derived from UNKNOWN.
          unknownDetail = `could not determine whether an 'origin' remote exists — ${killedDetail('the probe was killed by its watchdog')}`
        } else if (!remote.ok || remote.stdout.trim() === '') noOrigin = true
        // `scrub('')` is '' (not null), and an empty detail rendered the "could not read
        // origin/<b> ()" empty-parenthesis this module was built to avoid. A child killed by
        // something other than its OWN watchdog exits !ok with no stderr and no timed_out.
        else unknownDetail = scrub(fetched.stderr) || `the fetch failed with exit ${fetched.exit_code} and wrote no stderr`
      }
    } else {
      // NO `^{commit}` suffix: the orchestrator's test harness intercepts peeled refs with a
      // canned sha, and this comparison must read the ref git actually updated.
      const resolved = await run(
        ['git', '-C', repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
        undefined,
        LOCAL_TIMEOUT_MS,
      )
      const oid = resolved.stdout.trim().toLowerCase()
      if (resolved.ok && /^[0-9a-f]{40}$/.test(oid)) originSha = oid
      else unknownDetail = `fetched origin/${branchProse} but could not resolve refs/remotes/origin/${branchProse}`
    }

    // THE PRINTED PUSHES SPELL `refs/heads/<branch>`, never the bare name — the same argument
    // that put `--` in the printed delete, applied to the one command `--` cannot protect.
    // `git check-ref-format refs/heads/--mirror` exits 0, so a legal branch name renders
    // `git push origin --mirror` in text a reader is told to RUN. The qualified form is
    // preferred over a `--` separator (which git push does accept) because it fixes the
    // DESTINATION too: `push origin refs/heads/<b>` cannot be resolved against a tag or a
    // remote-tracking ref of the same name, so the command means one thing. Not reachable
    // from board-dispatch's `trident/<slug>` names, and neither was the delete's leading dash.
    if (noOrigin) {
      return `${prefix}The wrong-base launch guard found no worktree holding the branch, but this repo has no reachable 'origin' remote, so publication cannot be established at all — it is UNKNOWN, and UNKNOWN does not authorise deletion. Snapshot the commits locally first, in the namespace the stranded-run salvage already uses: ${salvage()} — a plain git tag is CREATE-ONLY, so it refuses rather than overwriting an earlier salvage receipt. Never delete work no remote has seen.`
    }
    if (unknownDetail !== null) {
      return `${prefix}The wrong-base launch guard found no worktree holding the branch, but could not read origin/${branchProse} (${unknownDetail}) — publication is UNKNOWN, and UNKNOWN does not authorise deletion. Salvage the branch first — ${salvage()}, which is create-only and refuses to overwrite an earlier receipt (or publish it with git -C ${sh(repo)} push origin ${sh(`refs/heads/${branch}`)} if this lane has push rights) — before considering anything destructive.`
    }
    if (originSha !== null) {
      // Equality is not the only way origin can carry the local work: when origin/<branch> is
      // a DESCENDANT of the local tip the shas differ yet every local commit is published, and
      // "these commits exist nowhere else" would be a false statement of evidence.
      const identical = originSha === branch_tip.toLowerCase()
      let contained = identical
      let ancestryUnknown: string | null = null
      if (!identical) {
        const ancestry = await run(
          ['git', '-C', repo, 'merge-base', '--is-ancestor', branch_tip, `refs/remotes/origin/${branch}`],
          undefined,
          LOCAL_TIMEOUT_MS,
        )
        // `--is-ancestor` answers with THREE exits: 0 yes, 1 no, anything else an ERROR (a
        // corrupt object database exits 128). Reading "not ok" as "proven divergence" turns an
        // error into a positive claim about unpublished commits — a derivation from UNKNOWN.
        if (ancestry.ok) contained = true
        else if (ancestry.exit_code !== 1) {
          ancestryUnknown =
            ancestry.timed_out === true
              ? killedDetail('the ancestry probe was killed by its watchdog')
              : `git merge-base --is-ancestor exited ${ancestry.exit_code}: ${scrub(ancestry.stderr) || 'no stderr'}`
        }
      }
      if (ancestryUnknown !== null) {
        return `${prefix}The wrong-base launch guard found no worktree holding the branch and origin/${branchProse} at ${originSha}, but whether it contains the local tip ${branch_tip} could NOT be established (${ancestryUnknown}) — publication is UNKNOWN, and UNKNOWN does not authorise deletion. Salvage the branch first — ${salvage()}, create-only so it cannot overwrite an earlier receipt (or publish it with git -C ${sh(repo)} push origin ${sh(`refs/heads/${branch}`)} if this lane has push rights) — then re-resolve it by hand.`
      }
      if (contained) {
        const relation = identical
          ? `is at the identical commit (local ${branch_tip}, origin ${originSha})`
          : `is ahead of the local tip and already contains it (local ${branch_tip}, origin ${originSha})`
        // EVERY PREMISE IS RE-ESTABLISHED BY THE COMMAND ITSELF. This message is composed at
        // refusal time and read minutes to hours later, and BOTH facts it rests on can rot in
        // between: the local ref can move (an unpublished commit pushed onto it), and origin
        // can be force-pushed so it no longer carries the tip. So the printed chain re-fetches
        // origin, re-compares the local ref against the evidenced sha, and re-proves
        // containment before it deletes anything.
        //
        // AND THE PRINTED TEXT SAYS EXACTLY THAT — no more. It used to claim "each link fails
        // closed" and that "the test is compare-and-delete, so a branch that MOVED since keeps
        // its unpublished commit". That is FALSE, and this comment already admitted why one
        // line further down: `test … && branch -D` is compare-THEN-delete, so a ref that moves
        // in the gap between the two is deleted at its NEW tip. A message that asserts a
        // guarantee the code does not provide is the same defect as the remedy this whole
        // module replaced — advice trusted for a property nobody established.
        //
        // The window is not closable here. `branch -D` is still the right delete because it
        // re-checks HOLDERS as it runs, while `update-ref -d` deletes regardless and leaves a
        // lane that took the branch on a dangling HEAD — the exact incident this guard exists
        // to prevent, reintroduced by the remedy. And no single git command both
        // compare-and-swaps a ref and refuses a checked-out branch. So the window is NAMED
        // rather than papered over, and the reader is told what actually bounds it.
        //
        // THE ORIGIN PREMISE HAS THE SAME WINDOW, AND IT USED TO BE CLAIMED AWAY (Argus
        // blocker). The ancestry link compares against `refs/remotes/origin/<b>` — a TRACKING
        // ref, refreshed only by this chain's OWN first command — so a force-push landing
        // between that fetch and the delete is invisible to every link that follows, and the
        // chain deletes commits that are by then published nowhere. The printed text claimed
        // each link "stops the delete when its premise has rotted", which is false for exactly
        // that ordering; the existing race test only force-pushed BEFORE the chain ran, so the
        // gap was never exercised.
        //
        // So the chain SNAPSHOTS before it deletes, with the same create-only salvage tag every
        // other arm here names, and the disclosure names the window instead of denying it. The
        // tag makes the loss recoverable rather than the race impossible: after the delete the
        // commits are still reachable from a ref, which is the property that mattered. It is
        // create-only, so an existing receipt of the same name STOPS the chain short of the
        // delete — fail-closed, and said out loud, because a link that can stop the delete is
        // exactly what a reader needs to know before running the line.
        //
        // `-- <branch>` and not a bare argument: `git check-ref-format 'refs/heads/-foo'`
        // exits 0, so a legal leading-dash branch name parses as OPTIONS in the printed
        // command. It fails closed today (git errors) but the reader is told to RUN this text.
        const verify = `git -C ${sh(repo)} fetch --no-tags origin ${sh(refspec)} && test "$(git -C ${sh(repo)} rev-parse --verify ${sh(`refs/heads/${branch}`)})" = ${sh(branch_tip)} && git -C ${sh(repo)} merge-base --is-ancestor ${sh(branch_tip)} ${sh(`refs/remotes/origin/${branch}`)} && ${salvage()} && git -C ${sh(repo)} branch -D -- ${sh(branch)}`
        return `${prefix}The wrong-base launch guard found no worktree holding the branch, and origin/${branchProse} ${relation} — every commit on the local branch is already on origin, so dropping the local ref loses nothing. Delete it ONLY through the chain that re-establishes both of those facts at the moment it runs: ${verify}. The fetch re-reads origin, so a force-push that dropped these commits before you run this stops the delete; the test re-compares the local ref against the evidenced tip, so a branch that moved stops it too; the ancestry check re-proves origin contained that tip as of that fetch; the tag takes a local snapshot of the evidenced commit IMMEDIATELY before the delete, and being create-only it stops the chain rather than overwriting an earlier receipt; and branch -D is the delete git RE-CHECKS holders for — it refuses ("used by worktree at ...") if a lane has taken the branch since, and that refusal is a stand-down signal, never something to route around with a low-level ref delete. What the chain does NOT close, and you should know before running it: it is compare-THEN-delete, so a commit landing on the ref in the gap between the test and the delete would be deleted with it, and the ancestry link reads a TRACKING ref that is only as fresh as this chain's own fetch, so a force-push landing after that fetch is not seen at all. Nothing in git closes either gap for a branch delete; what bounds them is that each gap is one command wide, that branch -D still refuses a branch a lane has checked out, and that the snapshot tag is taken inside the window — so if origin has since dropped these commits they are still reachable here by that tag rather than by nothing. Then re-dispatch.`
      }
    }
    const evidence = absent
      ? `origin has no ${branchProse} at all`
      : `origin/${branchProse} is at ${originSha} and does not contain the local tip ${branch_tip}`
    return `${prefix}The wrong-base launch guard found no worktree holding the branch, and ${evidence} — these commits are unpublished. Salvage first: snapshot them the way the stranded-run salvage does — ${salvage()}, create-only so it cannot overwrite an earlier receipt — or, if this lane has push rights, publish them with git -C ${sh(repo)} push origin ${sh(`refs/heads/${branch}`)}; never delete unpublished work.`
  } catch (err) {
    return unknownHolder(
      prefix,
      branchProse,
      "could not resolve the branch's holder or its publication because remedy resolution threw",
      scrub(err instanceof Error ? err.message : String(err)),
    )
  }
}
