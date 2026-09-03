/**
 * FIRE SETTLE-TIMEOUT EVIDENCE — the PRODUCTION half. `fire-evidence.ts` holds
 * the pure decision model (and stays I/O-free so the gateway may import it);
 * this file is the seam's real truth: it re-reads the run's own row and then
 * looks at the actual linked worktrees, the actual worktree lock, the actual
 * process behind that lock, and reports in that module's vocabulary.
 *
 * POSITIVE EVIDENCE OR NOTHING — and this is the DELIBERATE INVERSE of
 * `run-evidence-probes.ts`'s rule, so read it once and do not "fix" it later.
 * There, a look that COULD NOT HAPPEN becomes `unknown` and defers a KILL of a
 * run already believed live. Here, sparing a run without evidence holds a lane
 * for the whole stall budget (~90 min) on EVERY genuine fire failure, and the
 * card's must-pass control demands a byte-identical `failed` when nothing was
 * observed. So every failed, blind or timed-out look contributes NOTHING: it
 * lands as `none`, exactly as today's unconditional `failed` does.
 *
 * OBSERVATION ONLY. The single process touch is the reused signal-0
 * `defaultProbePidAlive` — `kill(pid, 0)` delivers no signal, it asks the kernel
 * whether the pid exists. There is no kill by name or by pattern anywhere in
 * this module or its tests, by construction: a pattern kill matches the whole
 * host, not one run.
 *
 * BOUNDED BY CONSTRUCTION. Every host command runs under the reused 15 s
 * `RUN_EVIDENCE_HOST_TIMEOUT_MS`, because this runs inside the orchestrator's
 * fire path: a probe that wedges would stall the lane it is meant to protect.
 * Hitting the bound reports no evidence, never a false positive.
 *
 * DETAILS ARE SHORT AND PORTABLE. Every `detail` quotes BASENAMES, counts and
 * pids — never a full path, and never the raw lock reason (it is free text a
 * substrate wrote). These strings land in stage stamps and run notes, and an
 * absolute host filesystem path does not belong in either.
 *
 * `parseWorktreeList` and `probeBranchHolder` are EXPORTED for the dispatch
 * liveness refusal (`board-dispatch.ts`), which must answer the same question —
 * "is something live holding this branch?" — from a different caller.
 */
import { lstat, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { spawnCapture, type HostCommandResult } from './git-mode.ts'
import { defaultProbePidAlive, RUN_EVIDENCE_HOST_TIMEOUT_MS } from './run-evidence-probes.ts'
import {
  classifyFireTimeoutRow,
  type FireEvidenceGatherer,
  type FireEvidenceInput,
  type FireTimeoutEvidence,
} from './fire-evidence.ts'
import type { TridentRun } from './store.ts'

/**
 * How far BEFORE the fire clock a worktree's root mtime may sit and still count
 * as "created/touched at or after the fire". Filesystem stamp granularity and
 * two independent clock sources (the fire's `Date.now()` vs the fs) disagree by
 * milliseconds; without a small allowance a worktree cut in the same instant as
 * the fire would read as pre-existing.
 */
export const FRESH_WORKTREE_SKEW_MS = 2000

/** One `worktree` record of `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  path: string
  /** The FULL ref (`refs/heads/…`), exactly as git prints it. Null when detached. */
  branch: string | null
  head: string | null
  /** `null` when not locked; `''` when locked with no reason given. */
  lock_reason: string | null
}

/**
 * The lock-reason shape the substrate writes, observed verbatim on this host:
 * `claude agent wf_9d6cb66c-408-2 (pid 2088872 start 122952867)`. The `start`
 * group is optional because not every writer records it.
 *
 * `pid` IS ANCHORED ON A WORD BOUNDARY (Argus r3, minor): unanchored, the reason
 * `stupid 45` parsed as pid 45 and synthesized a holder out of a word. Only a
 * start-of-string or a space/`(` may precede it — the two shapes the substrate
 * actually writes — because a manufactured pid here reads as a LIVE holder, and
 * that is the one direction this module must never invent.
 */
export const WORKTREE_LOCK_PID = /(?:^|[\s(])pid (\d+)(?: start (\d+))?/

/**
 * Strip git's C-quoting when a porcelain value is wrapped in double quotes (git
 * quotes unusual paths and lock reasons). Only `\"` and `\\` are unescaped: FULL
 * C-unquoting is deliberately NOT attempted, because under the positive-only
 * rule a reason we mangle simply yields no pid match — i.e. no evidence, which
 * is the safe direction — and a path we mangle simply fails to match a branch.
 */
function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  return value.slice(1, -1).replace(/\\(["\\])/g, '$1')
}

/**
 * Parse `git worktree list --porcelain` into one entry per `worktree` record.
 * `bare`, `detached` and `prunable …` lines are ignored: nothing downstream asks
 * about them, and a detached tree is already expressed by `branch: null`.
 */
export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = []
  for (const raw of porcelain.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('worktree ')) {
      entries.push({
        path: unquote(line.slice('worktree '.length).trim()),
        branch: null,
        head: null,
        lock_reason: null,
      })
      continue
    }
    const current = entries[entries.length - 1]
    if (current === undefined) continue
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim()
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim()
    } else if (line === 'locked') {
      current.lock_reason = ''
    } else if (line.startsWith('locked ')) {
      current.lock_reason = unquote(line.slice('locked '.length).trim())
    }
  }
  return entries
}

/**
 * `/proc/<pid>/stat` field 22 — `starttime`, in clock ticks since boot. The comm
 * field (2) is parenthesised and may itself contain spaces AND parens, so the
 * only safe split point is the LAST `)`. After it, index 0 is the state (field
 * 3), so field 22 is index 19.
 *
 * Returns null on anything we cannot read as a finite non-negative integer — the
 * caller then keeps the signal-0 answer rather than inventing a mismatch.
 */
export function parseProcStartTime(stat_text: string): number | null {
  const close = stat_text.lastIndexOf(')')
  if (close < 0) return null
  const fields = stat_text.slice(close + 1).trim().split(/\s+/)
  const token = fields[19]
  if (token === undefined) return null
  const value = Number(token)
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

/**
 * The filesystem surface these probes need, as a seam. NARROW ON PURPOSE — this
 * module never lists a directory and never asks whether an entry is a symlink,
 * so it does NOT reuse `RunEvidenceFs`, which drags `readdir` and the directory
 * predicates a caller would then have to stub for nothing.
 */
export interface FireProbeFs {
  lstat(p: string): Promise<{ mtimeMs: number }>
  readFile(p: string): Promise<string>
}

/** What a linked worktree holding the branch looks like, once probed. */
export interface BranchHolderProbe {
  worktree_basename: string
  lock_reason: string | null
  pid: number | null
  pid_live: boolean
  mtime_ms: number | null
}

const defaultFs: FireProbeFs = {
  lstat: (p) => lstat(p),
  readFile: (p) => readFile(p, 'utf8'),
}

/**
 * Find the LINKED worktree that has `branch` checked out and say what it looks
 * like. Returns null when we could not look, AND when nothing holds the branch —
 * the caller must not be able to tell those apart, because under the
 * positive-only rule neither one is evidence.
 *
 * THE SHARED CHECKOUT IS NEVER A CANDIDATE. git documents the main working tree
 * as the FIRST `worktree` record (git-worktree(1): "The main worktree is listed
 * first"), so it is skipped POSITIONALLY — the same rule
 * `freeBranchFromWorktrees` (`merge.ts`) applies, for the same reason: the
 * shared checkout sitting on a branch is housekeeping, never a live lane.
 */
export async function probeBranchHolder(
  deps: {
    run_host: (cmd: string[], cwd?: string) => Promise<HostCommandResult>
    fs: FireProbeFs
    probe_pid_alive: (pid: number) => 'alive' | 'dead' | 'unknown'
  },
  repo_path: string,
  branch: string,
): Promise<BranchHolderProbe | null> {
  return (await probeBranchHolderOutcome(deps, repo_path, branch)).holder
}

/**
 * The same look, with the ONE fact `probeBranchHolder` deliberately hides: did
 * the look happen at all (Argus r3, minor).
 *
 * For the VERDICT the distinction is worthless — an unreadable `git worktree
 * list` is not a holder, and this module reports evidence or silence — so no
 * arm branches on it. It exists for the SENTENCE: "no linked worktree holds the
 * branch" and "the probe could not run" are the same null and were the same
 * words, and only the second means the question was never asked. An operator
 * reading a terminal detail should be able to tell those apart.
 */
export async function probeBranchHolderOutcome(
  deps: {
    run_host: (cmd: string[], cwd?: string) => Promise<HostCommandResult>
    fs: FireProbeFs
    probe_pid_alive: (pid: number) => 'alive' | 'dead' | 'unknown'
  },
  repo_path: string,
  branch: string,
): Promise<{ looked: boolean; holder: BranchHolderProbe | null }> {
  let res: HostCommandResult
  try {
    res = await deps.run_host(['git', '-C', repo_path, 'worktree', 'list', '--porcelain'], repo_path)
  } catch {
    return { looked: false, holder: null }
  }
  // A FAILED LOOK IS NOT A HOLDER. There is no `unknown` to escalate into here:
  // this whole module reports evidence or silence.
  if (!res.ok || res.timed_out === true) return { looked: false, holder: null }

  const entries = parseWorktreeList(res.stdout)
  const wantRef = `refs/heads/${branch}`
  // EVERY matching entry, not just the first. `git worktree add --force --force`
  // permits two linked trees on one branch, and a STALE entry can be listed
  // ahead of the live one; examining only the first would report `pid_live:
  // false` while a live lane holds the branch — a false negative in the exact
  // direction this probe exists to prevent. So probe them all and prefer any
  // live holder; with the common single match the behaviour is unchanged.
  const candidates = entries.slice(1).filter((e) => e.branch === wantRef)
  if (candidates.length === 0) return { looked: true, holder: null }

  // WITH NO LIVE HOLDER, THE FRESHEST ONE WINS — not the first one listed. The
  // caller's OTHER liveness signal is the tree's own mtime against the fire
  // clock, and it can only ask that question of the ONE probe returned here.
  // Returning the first non-live candidate therefore let a stale dead-pid entry
  // MASK a same-branch tree that was cut after the fire: `kind: 'none'`, and the
  // run terminalized under a lane that had just started — the same false
  // negative the live-holder preference above exists to prevent, one signal
  // over. A null mtime never displaces a readable one (an unreadable stat is not
  // evidence), and with the common single match nothing changes.
  let best: BranchHolderProbe | null = null
  for (const entry of candidates) {
    const probe = await probeWorktreeEntry(deps, entry)
    if (probe.pid_live) return { looked: true, holder: probe }
    if (best === null || (probe.mtime_ms !== null && (best.mtime_ms === null || probe.mtime_ms > best.mtime_ms))) {
      best = probe
    }
  }
  return { looked: true, holder: best }
}

/**
 * One candidate worktree, read as a holder: the pid its lock names (when it
 * names one), whether that pid is really alive, and the tree's own mtime.
 * Split out of `probeBranchHolder` so EVERY same-branch entry gets the same
 * look — see the loop above.
 */
async function probeWorktreeEntry(
  deps: {
    fs: FireProbeFs
    probe_pid_alive: (pid: number) => 'alive' | 'dead' | 'unknown'
  },
  entry: WorktreeListEntry,
): Promise<BranchHolderProbe> {
  const match = entry.lock_reason === null ? null : entry.lock_reason.match(WORKTREE_LOCK_PID)
  let pid: number | null = null
  if (match?.[1] !== undefined) {
    const parsed = Number(match[1])
    // pid 0 means "the whole process group" and pid 1 is init. Both are wrong
    // answers dressed as facts — the same rule `run-evidence-probes.ts` applies.
    if (Number.isInteger(parsed) && parsed > 1) pid = parsed
  }

  let pid_live = false
  if (pid !== null && deps.probe_pid_alive(pid) === 'alive') {
    // 'dead' AND 'unknown' both leave this false: unknown is NOT evidence here,
    // which is the documented inversion of the run-evidence rule.
    pid_live = true
    const recorded = match?.[2]
    if (recorded !== undefined) {
      // THE RECYCLED-PID CHECK. A pid the kernel still knows may be a DIFFERENT
      // process that inherited the number. When the lock recorded a starttime we
      // can settle it; a mismatch means the recorded holder is gone.
      try {
        const parsed = parseProcStartTime(await deps.fs.readFile(`/proc/${pid}/stat`))
        if (parsed !== null) pid_live = parsed === Number(recorded)
      } catch {
        // BEST-EFFORT, AND SAY SO. /proc may be unreadable (container, hardened
        // mount) or unparsable. The recycled-pid refinement is then simply
        // UNAVAILABLE and `pid_live` keeps the signal-0 answer — this probe does
        // not manufacture a mismatch it did not measure. THE HONEST CLAIM is
        // therefore "starttime settles recycling WHEN /proc can be read", not
        // "recycled pids can never read as live"; the as-built entry says the
        // same, and the fallback is deliberate, not an oversight.
      }
    }
  }

  let mtime_ms: number | null = null
  try {
    mtime_ms = (await deps.fs.lstat(entry.path)).mtimeMs
  } catch {
    mtime_ms = null
  }

  return { worktree_basename: basename(entry.path), lock_reason: entry.lock_reason, pid, pid_live, mtime_ms }
}
/**
 * The DISPATCH-SIDE entry to the branch-holder probe: `probeBranchHolder`
 * over this module's own production defaults (spawnCapture at the reused
 * 15 s bound, real fs, signal-0 pid probe). `board-dispatch.ts` uses it to
 * answer "is something ALIVE holding this card's branch?" before creating a
 * run — same evidence, same bounds, same observation-only discipline.
 */
export function defaultBranchHolderProbe(repo_path: string, branch: string): Promise<BranchHolderProbe | null> {
  return probeBranchHolder(
    {
      run_host: (cmd, cwd) => spawnCapture(cmd, cwd, undefined, RUN_EVIDENCE_HOST_TIMEOUT_MS),
      fs: defaultFs,
      probe_pid_alive: defaultProbePidAlive,
    },
    repo_path,
    branch,
  )
}

export interface BuildFireEvidenceGathererOptions {
  /**
   * Re-read the run's CURRENT row. REQUIRED: it is the cheapest evidence there
   * is and the only one that needs no filesystem at all. The composition root
   * passes `(id) => store.get(id)`.
   */
  read_run: (id: string) => Promise<TridentRun | null> | TridentRun | null
  /** Host runner. Default: `spawnCapture` at the reused 15 s bound. */
  run_host?: (cmd: string[], cwd?: string) => Promise<HostCommandResult>
  fs?: FireProbeFs
  /** Signal-0 existence check seam. Default below; NEVER delivers a signal. */
  probe_pid_alive?: (pid: number) => 'alive' | 'dead' | 'unknown'
}

/**
 * Build the production gatherer for the orchestrator's `gather_fire_evidence`
 * seam. Evidence is gathered CHEAPEST FIRST:
 *
 *   1. THE ROW, NO FILESYSTEM. Re-read the run and classify it against the row
 *      pinned at fire time. A moved workflow-owned column proves a live lane and
 *      returns IMMEDIATELY — no git is run at all. A re-read that throws still
 *      classifies the PINNED row, so the published case (the SECOND SHAPE)
 *      survives an unreadable store.
 *   2. THE BRANCH HOLDER. A linked worktree with the run's branch checked out,
 *      held either by a LIVE lock pid or by a root mtime at/after the fire.
 *
 * AN `outer-published:…` CHECKPOINT IS *NOT* A SHORT CIRCUIT. It is carried
 * forward by every re-fired round, so on its own it cannot tell "the work is
 * finished" from "the previous round finished and THIS one is live" — and inside
 * the settle window the row cannot yet have moved. Step 2 therefore runs anyway
 * and a LIVE holder overrides it, which is exactly `fire-evidence.ts`'s "a live
 * delta OUTRANKS outer-published" rule applied to the filesystem.
 *
 * THE ROW IS RE-READ AFTER THE PROBE, and that second read is not belt-and-braces.
 * The branch-holder probe may take up to the full 15 s host bound, and the
 * caller does not merely READ this evidence — it SPREADS `observed` over the
 * pinned row and saves it. A checkpoint the detached workflow lands DURING the
 * probe would therefore be written back to its pre-probe value by the very save
 * that spares the lane: progress destroyed by the gate that exists to protect
 * it. So the freshest row wins, and a row that moved during the probe is itself
 * `launched` evidence.
 *
 * Neither step may throw: each I/O is caught where it happens. The orchestrator
 * also treats a throw as `none`, but a gatherer that leaned on its caller's
 * catch would silently discard evidence the OTHER step had already found.
 */
export function buildFireEvidenceGatherer(opts: BuildFireEvidenceGathererOptions): FireEvidenceGatherer {
  const run_host =
    opts.run_host ?? ((cmd: string[], cwd?: string) => spawnCapture(cmd, cwd, undefined, RUN_EVIDENCE_HOST_TIMEOUT_MS))
  const fs = opts.fs ?? defaultFs
  const probe_pid_alive = opts.probe_pid_alive ?? defaultProbePidAlive

  // A re-read that throws is not evidence and must not crash the gate: it simply
  // yields no fresh row, exactly as a run that has vanished would.
  const readRun = async (id: string): Promise<TridentRun | null> => {
    try {
      return (await opts.read_run(id)) ?? null
    } catch {
      return null
    }
  }

  return async (input: FireEvidenceInput): Promise<FireTimeoutEvidence> => {
    const fresh = await readRun(input.run.id)
    // `TridentRun` structurally satisfies `WorkflowOwnedColumns`, so the rows go
    // in as they are.
    const rowEvidence = classifyFireTimeoutRow(input.run, fresh)
    // A ROW DELTA IS THE ONLY SHORT CIRCUIT. `launched` is already the strongest
    // answer this gate can give, so nothing the worktrees could add would change
    // it — return before spending a `git worktree list`.
    if (rowEvidence.kind === 'launched') return rowEvidence

    const branch = input.run.branch
    if (branch === null) {
      return rowEvidence.kind === 'published'
        ? rowEvidence
        : { kind: 'none', detail: 'row unchanged and the run has no branch to probe' }
    }

    // `published` DOES NOT SHORT-CIRCUIT THIS PROBE, and that is the whole point
    // of `fire-evidence.ts`'s "a live delta OUTRANKS outer-published" rule. Every
    // RE-FIRED round carries the PREVIOUS round's `outer-published:…` checkpoint
    // (publish writes it; `persistRefireReset` clears only the subagent slot and
    // `inner_result`), and a re-fired round is the majority observed shape of
    // this defect. Terminalizing one of those on the stale checkpoint alone would
    // abandon the live lane the round just started — inside the settle window the
    // row cannot yet have moved, because the earliest workflow-owned write is at
    // `forge-done`, minutes later. So ASK THE WORKTREES FIRST: a live holder wins.
    const probe = await probeBranchHolderOutcome({ run_host, fs, probe_pid_alive }, input.run.repo_path, branch)
    const holder = probe.holder

    // CLOSE THE PROBE WINDOW. The `git worktree list` above may have taken the
    // whole 15 s bound, and `observed` is not a report — the caller SPREADS it
    // over the pinned row and saves it. Re-classify against the row as it is
    // NOW, so a checkpoint that landed during the probe is carried forward
    // rather than overwritten by the pre-probe snapshot. A row that moved in
    // that window is also, by this module's first rule, `launched` evidence in
    // its own right.
    const settled = classifyFireTimeoutRow(input.run, (await readRun(input.run.id)) ?? fresh)
    if (settled.kind === 'launched') return settled
    const observed = settled.kind === 'published' ? settled.observed : undefined

    if (holder === null) {
      // A LOOK THAT COULD NOT HAPPEN SAYS SO — and changes nothing else (Argus
      // r3, minor, DECLINED IN PART and written down here). `null` collapses "no
      // holder" and "could not ask"; the review asked that the `published` arm
      // require a look that RAN before terminalizing. It deliberately does not.
      // The published checkpoint is this card's OWN cheapest-and-strongest
      // evidence — a row that says `outer-published:<sha>:0:<round>` was written
      // by the outer loop after it pushed — and downgrading it to `failed`
      // because `git worktree list` could not run re-creates the SECOND SHAPE
      // this card exists to delete: a finished, pushed build recorded as a
      // failure, whose wake then invites a rebuild. A probe that cannot run is
      // not counter-evidence; it is silence, and silence does not outrank a
      // written checkpoint. (`build-core-modules-trident-fire-evidence-wiring`
      // pins exactly this over a repo_path that does not exist.) What the
      // distinction IS worth is the operator's sentence, so the `none` detail
      // now names which silence it was.
      return settled.kind === 'published'
        ? settled
        : {
            kind: 'none',
            detail: probe.looked
              ? 'row unchanged; no linked worktree holds the branch'
              : 'row unchanged; the worktree probe could not run, so no holder question was answered',
          }
    }

    // MTIME, NOT CTIME — DELIBERATE, and it is a WIDENING (Argus r8 minor). The
    // card asks for a worktree CREATED at/after the fire; `lstat` gives no
    // portable creation time (`birthtime` is 0 on the ext4/overlayfs this runs
    // on), so the directory's MODIFICATION time stands in. The substitution can
    // only over-report: a pre-existing worktree merely TOUCHED after the fire
    // reads as a fresh launch. That direction is the safe one here — this arm
    // returns `launched`, which HOLDS the lane rather than terminalizing it, and
    // the hold is itself bounded by the 90-minute no-advance reaper. Under-
    // reporting would put a second lane on a live branch, which is the whole
    // defect this seam exists to close.
    const fresh_worktree =
      holder.mtime_ms !== null && holder.mtime_ms >= input.fire_started_at_ms - FRESH_WORKTREE_SKEW_MS

    if (holder.pid_live || fresh_worktree) {
      // BASENAME + PID DIGITS ONLY — never the path, never the raw lock reason.
      let detail = `worktree ${holder.worktree_basename} holds the branch`
      if (holder.pid_live) detail += ` under a live lock (pid ${holder.pid})`
      if (fresh_worktree) detail += ', touched at/after the fire'
      if (settled.kind === 'published') detail += ' — a live lane outranks the published checkpoint'
      return {
        kind: 'launched',
        detail,
        ...(observed !== undefined ? { observed } : {}),
      }
    }

    if (settled.kind === 'published') return settled
    return {
      kind: 'none',
      detail: `worktree ${holder.worktree_basename} holds the branch but shows no life (no live lock pid, pre-fire mtime)`,
    }
  }
}
