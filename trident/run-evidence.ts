/**
 * RUN-SCOPED LIVENESS EVIDENCE — the pure decision half of the hang watchdog.
 *
 * WHY THIS EXISTS. The watchdog reads `last_advanced_at`, a column stamped on
 * PHASE transitions. A Forge round that runs for two hours doing real work never
 * re-stamps it, so a healthy long build is indistinguishable from a dead one on
 * that field alone — measured, 17 runs terminated in 30 days with
 * "no progress for 90 min — suspected agent hang", including four PRs that were
 * complete and green on GitHub at the moment they were killed. The check was
 * measuring bookkeeping, not liveness.
 *
 * THE THREE PROBES, strongest first (this module models them; the probes
 * themselves live behind the orchestrator's `gather_run_evidence` seam so this
 * file stays pure — no I/O, no clock, no process access, and therefore trivially
 * testable in every branch):
 *
 *   1. a live PROCESS for the run — the ground truth;
 *   2. recent mtime on the run's own ARTIFACTS (streams, journal, worktree);
 *   3. recent local REF movement on the run's branch.
 *
 * EVERY OBSERVATION IS THREE-VALUED, and the third value is the whole point.
 * "I looked and saw no activity" and "I could not look" are different facts, and
 * conflating them is exactly how this watchdog killed live builds: an unreadable
 * artifact directory or an unqueryable process table read as a passing check. So
 * `unknown` is never evidence in either direction — it cannot spare a run and it
 * can never authorise a kill. An EMPTY check must not read as a PASSING check.
 */
import type { TridentRun } from './store.ts'

/**
 * ONE PROBE'S ANSWER.
 *
 *   • `activity` — the probe RAN and found activity whose newest sample was
 *     `age_ms` before the check. Age, never a boolean: the caller compares it
 *     against a window, and the disclosure quotes the number.
 *   • `nothing`  — the probe RAN and POSITIVELY saw no activity. ENOENT, no such
 *     ref, no matching process: each is a real observation, not a failure.
 *   • `unknown`  — the probe COULD NOT observe (EACCES, EIO, spawn failure, an
 *     unreadable process table). Never evidence in either direction.
 *
 * `detail` is carried on all three so the disclosure can quote the reason a probe
 * came back blind rather than asserting an unfalsifiable "no evidence".
 */
export type EvidenceObservation =
  | { observed: 'activity'; age_ms: number; detail: string }
  | { observed: 'nothing'; detail: string }
  | { observed: 'unknown'; detail: string }

/** All three probes' answers for ONE run, gathered at one instant. */
export interface RunHangEvidence {
  process: EvidenceObservation
  artifacts: EvidenceObservation
  ref: EvidenceObservation
}

/**
 * The seam the orchestrator calls. `window_ms` is the hang threshold in force, so
 * a probe MAY early-exit the moment it finds anything inside it (a bounded
 * worktree scan does exactly that) — the caller re-checks the ages regardless.
 */
export interface RunEvidenceGatherer {
  (run: TridentRun, window_ms: number): RunHangEvidence | Promise<RunHangEvidence>
}

/** What the evidence authorises: spare the run, postpone the question, or reap. */
export type HangAction = 'stand-down' | 'defer' | 'reap'

/**
 * A malformed activity age is NOT activity and NOT quiet — it is a broken probe.
 * A NaN or negative age would otherwise sail past `age_ms <= window_ms` (NaN
 * compares false, a negative one compares true) and decide the run's fate on a
 * number nobody can defend. Demote it to `unknown`, where it defers.
 */
function normalise(o: EvidenceObservation): EvidenceObservation {
  if (o.observed === 'activity' && (!Number.isFinite(o.age_ms) || o.age_ms < 0)) {
    return { observed: 'unknown', detail: `malformed activity age (${String(o.age_ms)}): ${o.detail}` }
  }
  return o
}

/**
 * THE DECISION, in strict priority order:
 *
 *   1. ANY probe saw activity inside the window → STAND DOWN. The run is working;
 *      one positive observation outranks two silent ones, because silence is what
 *      a long phase looks like and activity is not.
 *   2. else ANY probe came back `unknown` → DEFER. An unknown check must not
 *      authorise a kill. The run is not spared — it is asked again next tick, and
 *      the inflight ceiling (checked by the caller, ABOVE this) still bounds it,
 *      so a permanently blind probe cannot make a run immortal.
 *   3. else → REAP. Every probe ran, and none of them shows activity inside the
 *      window. Activity OLDER than the window counts as quiet — but its age is
 *      still disclosed, so the record says how quiet, not merely "hung".
 */
export function decideHang(e: RunHangEvidence, window_ms: number): { action: HangAction } {
  const all = [normalise(e.process), normalise(e.artifacts), normalise(e.ref)]
  if (all.some((o) => o.observed === 'activity' && o.age_ms <= window_ms)) return { action: 'stand-down' }
  if (all.some((o) => o.observed === 'unknown')) return { action: 'defer' }
  return { action: 'reap' }
}

/**
 * The age of the NEWEST activity any probe saw, or null when none did. The caller
 * compares it against the narrower dead-launcher override window; a live process
 * is age 0 and is therefore always inside it.
 */
export function freshestActivityAgeMs(e: RunHangEvidence): number | null {
  let best: number | null = null
  for (const raw of [e.process, e.artifacts, e.ref]) {
    const o = normalise(raw)
    if (o.observed !== 'activity') continue
    if (best === null || o.age_ms < best) best = o.age_ms
  }
  return best
}

function mins(age_ms: number): number {
  return Math.round(age_ms / 60_000)
}

/**
 * WHAT WAS CHECKED AND WHAT EACH ONE ANSWERED — three clauses, always all three,
 * in probe order. A reap that says only "suspected agent hang" is unfalsifiable
 * after the fact, which is precisely why this survived 17 kills: nobody could
 * tell a true positive from a false one. Concrete numbers, never booleans.
 */
export function describeRunEvidence(e: RunHangEvidence): string {
  const p = normalise(e.process)
  const a = normalise(e.artifacts)
  const r = normalise(e.ref)
  const process =
    p.observed === 'activity'
      ? 'run process=live'
      : p.observed === 'nothing'
        ? 'run process=none observed'
        : `run process=unknown (${p.detail})`
  const artifacts =
    a.observed === 'activity'
      ? `newest artifact ${mins(a.age_ms)} min old`
      : a.observed === 'nothing'
        ? 'no run artifacts found'
        : `newest artifact unknown (${a.detail})`
  const ref =
    r.observed === 'activity'
      ? `branch ref moved ${mins(r.age_ms)} min ago`
      : r.observed === 'nothing'
        ? 'no branch ref movement recorded'
        : `branch ref unknown (${r.detail})`
  return `${process}; ${artifacts}; ${ref}`
}

/**
 * The whole-gatherer outage: the seam itself threw, so NOTHING was observed. All
 * three probes are `unknown`, which defers — the failure of the evidence gatherer
 * must never present as evidence of death.
 */
export function unknownRunEvidence(detail: string): RunHangEvidence {
  return {
    process: { observed: 'unknown', detail },
    artifacts: { observed: 'unknown', detail },
    ref: { observed: 'unknown', detail },
  }
}
