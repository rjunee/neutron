/**
 * RUN-SCOPED LIVENESS EVIDENCE — the PRODUCTION half. `run-evidence.ts` holds the
 * pure decision model; this file is the seam's real truth: it looks at the actual
 * process table, the actual scratch stream files, the actual worktree and the
 * actual branch reflog, and reports what it saw in that module's three-valued
 * vocabulary.
 *
 * WHY EVERY ANSWER IS THREE-VALUED HERE TOO. The watchdog killed 17 runs in 30
 * days on `last_advanced_at` alone. The fix is not "look harder" — it is that a
 * look which COULD NOT HAPPEN must never be recorded as a look that found
 * nothing. So one classification rule governs every sub-source below, without
 * exception:
 *
 *   • POSITIVELY `nothing` — ENOENT, a ref that does not exist, a process table
 *     that was read in full and contains no match, a pid that is positively
 *     dead (ESRCH). Each of these is a real observation.
 *   • `unknown` — EACCES, EIO, a spawn failure, a non-zero or timed-out host
 *     command, output we cannot parse, or a bounded scan that hit its cap before
 *     completing. An incomplete look must not read as a completed quiet one.
 *
 * OBSERVATION ONLY. Nothing in this module signals a process. The single
 * `process.kill(pid, 0)` below delivers NO signal — it is the POSIX existence
 * check — and it is the sole exception. There is no kill by name or pattern
 * anywhere here, by construction: a pattern kill matches the whole host, not one
 * run.
 *
 * BOUNDED BY CONSTRUCTION. Every host command runs under a 15 s watchdog and the
 * worktree walk stops after a fixed entry count, because this runs inside the
 * orchestrator tick: a probe that wedges would stall every lane it is meant to
 * protect. Hitting either bound reports `unknown`, never quiet.
 *
 * DETAILS ARE SHORT AND PORTABLE. Every `detail` string quotes counts, error
 * codes and BASENAMES — never a full path — because these strings land in run
 * failure reasons and disclosures, and absolute host filesystem paths do not
 * belong in either.
 */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { spawnCapture, type HostCommandResult } from './git-mode.ts'
import { runWorktreePath } from './merge.ts'
import type { EvidenceObservation, RunEvidenceGatherer, RunHangEvidence } from './run-evidence.ts'
import type { TridentRun } from './store.ts'

/**
 * Host-command budget for ONE probe command. Deliberately far below the 60 s
 * production default: these run on the orchestrator's tick, and a wedged `ps`
 * must degrade to `unknown` (which defers) long before it delays the tick.
 */
export const RUN_EVIDENCE_HOST_TIMEOUT_MS = 15_000

/** Default cap on the worktree walk — see the capped-is-unknown rule above. */
export const DEFAULT_MAX_WORKTREE_ENTRIES = 4000

/**
 * The filesystem surface these probes need, as a seam. Narrow on purpose: three
 * calls, all injectable, so the EACCES/EIO branches are reachable in a test
 * without asking a test to create an unreadable directory as a privileged user.
 */
export interface RunEvidenceFs {
  readdir(dir: string): Promise<string[]>
  lstat(p: string): Promise<{ mtimeMs: number; isDirectory(): boolean; isSymbolicLink(): boolean }>
  readFile(p: string): Promise<string>
}

export interface BuildRunEvidenceGathererOptions {
  /** Host runner. Default: `spawnCapture` at the 15 s bound above. */
  run_host?: (cmd: string[], cwd?: string) => Promise<HostCommandResult>
  /**
   * Where the wrapper's per-run stream files live. Default covers BOTH forms in
   * the tree: `inner-workflow.mjs` hardcodes `/tmp`, `codex-build.sh` uses
   * `${TMPDIR:-/tmp}` — so a host with TMPDIR set writes to one and not the
   * other, and checking only one would report a live run as artifact-quiet.
   */
  scratch_dirs?: string[]
  now_ms?: () => number
  fs?: RunEvidenceFs
  /** Signal-0 existence check seam. Default below; NEVER delivers a signal. */
  probe_pid_alive?: (pid: number) => 'alive' | 'dead' | 'unknown'
  max_worktree_entries?: number
}

/** The scratch-file prefix the detached build wrapper writes per run. */
function pidFilePrefix(run_id: string): string {
  return `trident-codex-build-${run_id}-`
}

/**
 * A run id shorter than this refuses the process-table scan. A 2-char needle
 * matches unrelated argv on a busy host and would FABRICATE liveness — the
 * mirror image of the bug this module exists to fix, and the more dangerous
 * direction, because it makes a genuinely hung lane immortal.
 */
const MIN_SCANNABLE_RUN_ID = 8

function errCode(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return ''
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function firstLine(s: string): string {
  const line = s.split('\n')[0]?.trim() ?? ''
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

/** How a failed host command is quoted: exit code + first stderr line, no more. */
function hostFailureDetail(res: HostCommandResult): string {
  const parts = [`exit ${res.exit_code}`]
  if (res.timed_out === true) parts.push('timed out')
  const line = firstLine(res.stderr)
  if (line !== '') parts.push(line)
  return parts.join(', ')
}

/**
 * COMBINE SUB-SOURCES INTO ONE PROBE ANSWER, in the same priority order
 * `decideHang` uses, so a probe made of two looks behaves like a probe made of
 * one: any activity wins (the FRESHEST one, keeping its detail), else any
 * unknown makes the whole probe unknown (a half-blind probe is a blind probe —
 * the half that saw nothing cannot speak for the half that could not look), else
 * the probe is positively quiet.
 */
export function combine(parts: EvidenceObservation[], quiet_detail: string): EvidenceObservation {
  let best: { age_ms: number; detail: string } | null = null
  for (const part of parts) {
    if (part.observed !== 'activity') continue
    if (best === null || part.age_ms < best.age_ms) best = { age_ms: part.age_ms, detail: part.detail }
  }
  if (best !== null) return { observed: 'activity', age_ms: best.age_ms, detail: best.detail }
  const blind = parts.filter((p) => p.observed === 'unknown').map((p) => p.detail)
  if (blind.length > 0) return { observed: 'unknown', detail: blind.join('; ') }
  return { observed: 'nothing', detail: quiet_detail }
}

/**
 * The DEFAULT existence check. `kill(pid, 0)` delivers no signal; it asks the
 * kernel whether the pid exists and whether we could signal it.
 *
 *   • ESRCH → positively DEAD. A real observation, so it may contribute `nothing`.
 *   • EPERM → the process EXISTS under another owner. Alive, not dead.
 *   • anything else → unknown; we did not establish either.
 */
export function defaultProbePidAlive(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (err) {
    const code = errCode(err)
    if (code === 'ESRCH') return 'dead'
    if (code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

const defaultFs: RunEvidenceFs = {
  readdir: (dir) => readdir(dir),
  lstat: (p) => lstat(p),
  readFile: (p) => readFile(p, 'utf8'),
}

function defaultScratchDirs(): string[] {
  const dirs = [process.env.TMPDIR ?? '/tmp', '/tmp']
  return dirs.filter((d, i) => d !== '' && dirs.indexOf(d) === i)
}

/**
 * Build the production gatherer for the orchestrator's `gather_run_evidence`
 * seam. Every I/O surface is injectable; the defaults are the real host.
 */
export function buildRunEvidenceGatherer(opts: BuildRunEvidenceGathererOptions = {}): RunEvidenceGatherer {
  const run_host =
    opts.run_host ?? ((cmd: string[], cwd?: string) => spawnCapture(cmd, cwd, undefined, RUN_EVIDENCE_HOST_TIMEOUT_MS))
  const scratch_dirs = opts.scratch_dirs ?? defaultScratchDirs()
  const now_ms = opts.now_ms ?? Date.now
  const fs = opts.fs ?? defaultFs
  const probe_pid_alive = opts.probe_pid_alive ?? defaultProbePidAlive
  const max_worktree_entries = opts.max_worktree_entries ?? DEFAULT_MAX_WORKTREE_ENTRIES

  /**
   * Age of an observed timestamp, CLAMPED AT ZERO. Clock skew (a file stamped a
   * second in the future by another host, a stepped clock) would otherwise yield
   * a negative age, which the pure module demotes to `unknown` — turning a
   * perfectly good sighting of activity into a deferral. Skew must not defer.
   */
  function ageOf(at_ms: number): number {
    return Math.max(0, now_ms() - at_ms)
  }

  // ---- PROBE 1: PROCESS -----------------------------------------------------

  /**
   * (1a) THE PROCESS TABLE — the ground truth. The detached supervisor's argv
   * carries the run id, because the wrapper is invoked with the run-scoped exit
   * and pid file paths (`trident-codex-build-<run id>-<slot>.exit` /`.pid`,
   * `inner-workflow.mjs:1796`). So an exact substring search for the run id over
   * full argv is a RUN-SCOPED liveness test, not a generation-scoped one.
   */
  async function probeProcessTable(run: TridentRun): Promise<EvidenceObservation> {
    if (run.id.length < MIN_SCANNABLE_RUN_ID) {
      return { observed: 'unknown', detail: 'run id too short to scan the process table safely' }
    }
    const res = await run_host(['ps', '-ww', '-eo', 'pid=,args='])
    if (!res.ok || res.timed_out === true) {
      return { observed: 'unknown', detail: `process table unreadable (${hostFailureDetail(res)})` }
    }
    const matches = res.stdout.split('\n').filter((line) => line.includes(run.id)).length
    if (matches > 0) {
      return { observed: 'activity', age_ms: 0, detail: `${matches} live process(es) carry the run id in argv` }
    }
    return { observed: 'nothing', detail: 'no argv carries the run id' }
  }

  /**
   * (1b) THE PID-FILE FALLBACK. The wrapper writes the supervisor's pid to a
   * run-scoped file; when the process table cannot be read (a container without
   * `ps`, a timeout) this is a second, independent way to reach the same fact.
   *
   * A pid <= 1 is NEVER passed to the existence check: pid 0 means "the whole
   * process group" and pid 1 is init. Both are wrong answers dressed as facts,
   * so an unparseable or out-of-range pid file is `unknown`.
   */
  async function probePidFiles(run: TridentRun): Promise<{ parts: EvidenceObservation[]; checked: number }> {
    const parts: EvidenceObservation[] = []
    let checked = 0
    const prefix = pidFilePrefix(run.id)
    for (const dir of scratch_dirs) {
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch (err) {
        const code = errCode(err)
        if (code === 'ENOENT') {
          parts.push({ observed: 'nothing', detail: 'scratch dir absent' })
          continue
        }
        parts.push({ observed: 'unknown', detail: `scratch dir unreadable (${code || errMessage(err)})` })
        continue
      }
      for (const name of names) {
        if (!name.startsWith(prefix) || !name.endsWith('.pid')) continue
        let text: string
        try {
          text = await fs.readFile(join(dir, name))
        } catch (err) {
          const code = errCode(err)
          // A vanished file is a RACE, not a fact about the run: the wrapper
          // removes its pid file on exit while we are mid-scan. Skip it.
          if (code === 'ENOENT') continue
          parts.push({ observed: 'unknown', detail: `pid file ${name} unreadable (${code || errMessage(err)})` })
          continue
        }
        const pid = Number(text.trim())
        if (!Number.isInteger(pid) || pid <= 1) {
          parts.push({ observed: 'unknown', detail: `unparseable pid file ${name}` })
          continue
        }
        checked += 1
        const state = probe_pid_alive(pid)
        if (state === 'alive') {
          parts.push({ observed: 'activity', age_ms: 0, detail: `pid file ${name} names a live process` })
        } else if (state === 'dead') {
          parts.push({ observed: 'nothing', detail: `pid file ${name} names a dead process` })
        } else {
          parts.push({ observed: 'unknown', detail: `pid file ${name} liveness could not be established` })
        }
      }
    }
    return { parts, checked }
  }

  async function probeProcess(run: TridentRun): Promise<EvidenceObservation> {
    const [table, pids] = await Promise.all([probeProcessTable(run), probePidFiles(run)])
    return combine(
      [table, ...pids.parts],
      `process table scanned; no argv carries the run id; ${pids.checked} pid file(s) checked, none alive`,
    )
  }

  // ---- PROBE 2: ARTIFACTS ---------------------------------------------------

  /**
   * (2a) SCRATCH STREAMS. `trident-*<run id>*` covers every per-run file the
   * wrapper writes — `.brief`, `.out`, `.err`, `.trailer`, `.exit`, `.pid`, and
   * the brief `.part` files. A build writing log output THIS SECOND is exactly
   * the case that was reported 57-85 minutes "stale", so this probe is the
   * cheapest true positive available.
   */
  async function probeScratchArtifacts(run: TridentRun): Promise<EvidenceObservation[]> {
    const parts: EvidenceObservation[] = []
    for (const dir of scratch_dirs) {
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch (err) {
        const code = errCode(err)
        if (code === 'ENOENT') {
          parts.push({ observed: 'nothing', detail: 'scratch dir absent' })
          continue
        }
        parts.push({ observed: 'unknown', detail: `scratch dir unreadable (${code || errMessage(err)})` })
        continue
      }
      const matched = names.filter((name) => name.startsWith('trident-') && name.includes(run.id))
      if (matched.length === 0) {
        parts.push({ observed: 'nothing', detail: 'no scratch artifact carries the run id' })
        continue
      }
      let newest: { age_ms: number; name: string } | null = null
      let blind = ''
      for (const name of matched) {
        let stat: { mtimeMs: number }
        try {
          stat = await fs.lstat(join(dir, name))
        } catch (err) {
          const code = errCode(err)
          if (code === 'ENOENT') continue
          blind = `scratch artifact ${name} unreadable (${code || errMessage(err)})`
          continue
        }
        const age_ms = ageOf(stat.mtimeMs)
        if (newest === null || age_ms < newest.age_ms) newest = { age_ms, name }
      }
      if (newest !== null) {
        parts.push({
          observed: 'activity',
          age_ms: newest.age_ms,
          detail: `newest scratch artifact ${newest.name}, ${matched.length} matched`,
        })
      } else if (blind !== '') {
        parts.push({ observed: 'unknown', detail: blind })
      } else {
        parts.push({ observed: 'nothing', detail: 'no scratch artifact carries the run id' })
      }
    }
    return parts
  }

  /**
   * (2b) THE WORKTREE. A Forge round that has written no log line for a minute is
   * still alive if it just wrote a source file. Bounded, and never following a
   * symlink out of the tree.
   *
   * `node_modules` and `.git` are skipped WHOLESALE — not descended into and not
   * counted — because both churn for reasons that are not this run's work
   * (an install, a background gc) and both are large enough to eat the entry cap
   * before the walk reaches a single source file.
   */
  async function probeWorktree(run: TridentRun, window_ms: number): Promise<EvidenceObservation> {
    const root = run.worktree ?? runWorktreePath(run.repo_path, run)
    let rootStat: { mtimeMs: number; isDirectory(): boolean; isSymbolicLink(): boolean }
    try {
      rootStat = await fs.lstat(root)
    } catch (err) {
      const code = errCode(err)
      if (code === 'ENOENT') return { observed: 'nothing', detail: 'worktree absent' }
      return { observed: 'unknown', detail: `worktree unreadable (${code || errMessage(err)})` }
    }
    let visited = 1
    let newest = ageOf(rootStat.mtimeMs)
    let newest_name = basename(root)
    if (newest <= window_ms) {
      return { observed: 'activity', age_ms: newest, detail: `worktree root ${newest_name} touched in window` }
    }
    let capped = false
    const stack: string[] = rootStat.isDirectory() && !rootStat.isSymbolicLink() ? [root] : []
    while (stack.length > 0 && !capped) {
      const dir = stack.pop() as string
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch (err) {
        const code = errCode(err)
        if (code === 'ENOENT') continue
        return { observed: 'unknown', detail: `worktree scan blocked (${code || errMessage(err)})` }
      }
      for (const name of names) {
        if (name === 'node_modules' || name === '.git') continue
        if (visited >= max_worktree_entries) {
          capped = true
          break
        }
        const path = join(dir, name)
        let stat: { mtimeMs: number; isDirectory(): boolean; isSymbolicLink(): boolean }
        try {
          stat = await fs.lstat(path)
        } catch (err) {
          const code = errCode(err)
          if (code === 'ENOENT') continue
          return { observed: 'unknown', detail: `worktree entry ${name} unreadable (${code || errMessage(err)})` }
        }
        visited += 1
        const age_ms = ageOf(stat.mtimeMs)
        // EARLY EXIT: one in-window mtime settles the question. The seam contract
        // in run-evidence.ts allows this explicitly — the caller only needs to
        // know that SOMETHING moved inside the window, not what the newest is.
        if (age_ms <= window_ms) {
          return { observed: 'activity', age_ms, detail: `worktree entry ${name} touched in window` }
        }
        if (age_ms < newest) {
          newest = age_ms
          newest_name = name
        }
        if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path)
      }
    }
    if (capped) {
      // AN INCOMPLETE LOOK IS NOT A QUIET ONE. We stopped early without finding
      // in-window activity, so we did not establish that there is none.
      return {
        observed: 'unknown',
        detail: `worktree scan capped at ${max_worktree_entries} entries before completing — completeness not established`,
      }
    }
    return { observed: 'activity', age_ms: newest, detail: `newest worktree entry ${newest_name}` }
  }

  async function probeArtifacts(run: TridentRun, window_ms: number): Promise<EvidenceObservation> {
    const [scratch, worktree] = await Promise.all([probeScratchArtifacts(run), probeWorktree(run, window_ms)])
    return combine([...scratch, worktree], 'no run artifacts with a recorded mtime')
  }

  // ---- PROBE 3: BRANCH REF --------------------------------------------------

  /**
   * A ref that DOES NOT EXIST is a real observation (`nothing`). A repository we
   * cannot read — wrong path, not a repository, timed out, spawn failure — is
   * NOT evidence of death, and this distinction is why the regex below is narrow:
   * it matches only git's own "this ref is not there" wordings.
   */
  function refIsPositivelyMissing(res: HostCommandResult): boolean {
    if (res.timed_out === true) return false
    return /unknown revision|bad revision|does not have any commits|unborn/i.test(res.stderr)
  }

  async function probeRef(run: TridentRun): Promise<EvidenceObservation> {
    const branch = run.branch
    if (branch === null || branch === '') return { observed: 'nothing', detail: 'run has no branch' }
    const ref = `refs/heads/${branch}`
    const res = await run_host(['git', '-C', run.repo_path, 'log', '-g', '-1', '--date=unix', '--format=%gd', ref])
    if (res.ok) {
      // Verified format on this host: `main@{1788188785}`.
      const stamped = res.stdout.match(/@\{(\d+)\}/)
      if (stamped?.[1] !== undefined) {
        return { observed: 'activity', age_ms: ageOf(Number(stamped[1]) * 1000), detail: 'branch reflog' }
      }
      if (res.stdout.trim() !== '') {
        return { observed: 'unknown', detail: 'branch reflog output unparseable' }
      }
      // EMPTY stdout with exit 0: the ref exists but its reflog was pruned or
      // never written (a fresh clone, a `gc`). Fall back to the tip's committer
      // date — older evidence than a reflog entry, but real evidence.
      const tip = await run_host(['git', '-C', run.repo_path, 'log', '-1', '--format=%ct', ref])
      const seconds = tip.stdout.trim()
      if (tip.ok && /^\d+$/.test(seconds)) {
        return {
          observed: 'activity',
          age_ms: ageOf(Number(seconds) * 1000),
          detail: 'branch tip committer date (no reflog)',
        }
      }
      if (!tip.ok && refIsPositivelyMissing(tip)) {
        return { observed: 'nothing', detail: 'branch ref does not exist' }
      }
      return { observed: 'unknown', detail: `branch tip unreadable (${hostFailureDetail(tip)})` }
    }
    if (refIsPositivelyMissing(res)) return { observed: 'nothing', detail: 'branch ref does not exist' }
    return { observed: 'unknown', detail: `branch ref unreadable (${hostFailureDetail(res)})` }
  }

  // ---- THE GATHERER ---------------------------------------------------------

  /**
   * A probe that THROWS is a probe that could not observe. It becomes `unknown`
   * — never quiet — and never propagates: the gatherer must not reject, because
   * the orchestrator's fallback for a rejecting seam is all-unknown anyway, and
   * losing the two probes that DID answer would throw away real evidence.
   */
  async function guard(label: string, probe: () => Promise<EvidenceObservation>): Promise<EvidenceObservation> {
    try {
      return await probe()
    } catch (err) {
      return { observed: 'unknown', detail: `${label} probe failed: ${firstLine(errMessage(err))}` }
    }
  }

  return async (run: TridentRun, window_ms: number): Promise<RunHangEvidence> => {
    const [process_o, artifacts_o, ref_o] = await Promise.all([
      guard('process', () => probeProcess(run)),
      guard('artifacts', () => probeArtifacts(run, window_ms)),
      guard('ref', () => probeRef(run)),
    ])
    return { process: process_o, artifacts: artifacts_o, ref: ref_o }
  }
}
