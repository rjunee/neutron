/**
 * Recovery and liveness for the outer run step.
 * G111–G115, G118, G120–G123 are keep-in-place inventory rows.
 * Bind the existing launch/harvest capabilities and process-owned state; the
 * G116–G117 fire settlement and G119 shared-launcher policy stay in orchestrator.ts
 * with the mechanisms marked for deletion. Their callbacks retain step ordering.
 */
import type { TridentRun } from './store.ts'
import { isTerminalPhase, type AdvanceOutcome } from './state-machine.ts'
import { parseInnerResult, type InnerResult } from './inner-loop.ts'
import type { RunWorkerObservation } from './worker-observation.ts'
import type { BranchHolderProbe } from './fire-evidence-probes.ts'
import { DEAD_LAUNCHER_OVERRIDE_MS } from './liveness.ts'
import {
  decideHang, describeRunEvidence, freshestActivityAgeMs, unknownRunEvidence,
  type RunEvidenceGatherer, type RunHangEvidence,
} from './run-evidence.ts'
import type { createLogger } from '@neutronai/logger'

export interface SharedLauncherStandDownInput {
  run: TridentRun
  overCeiling: boolean
  probe: 'alive' | 'dead' | 'unknown' | 'not-wired'
  stageBeatsDeath: boolean
  runEvidenceBeatsDeath: boolean
  stageFresh: boolean
  runDecision: ReturnType<typeof decideHang> | null
  stageAgeMs: number | null
  runFreshestMs: number | null
  staleMins: number
  disclosure: string
}

export interface RecoveryLivenessDependencies {
  now: () => string
  log: ReturnType<typeof createLogger>
  fired: Set<string>
  redispatched: Set<string>
  infraRetryNotBefore: Map<string, number>
  launchFaults: Map<string, { count: number; last: string }>
  MAX_LAUNCH_FAULTS: number
  unconfirmedFires: { delete(runId: string): boolean }
  maxInflightMs: number
  noAdvanceHangMs: number
  maxCrashRecoveries: number
  on_orphaned: 'redispatch' | 'wait' | 'fail'
  beginCrashRecovery: ((runId: string) => Promise<TridentRun | null>) | undefined
  latestStageEventAt: ((runId: string) => string | null) | null
  probeRunAlive: ((run: TridentRun) => 'alive' | 'dead' | 'unknown' | Promise<'alive' | 'dead' | 'unknown'>) | null
  gatherRunEvidence: RunEvidenceGatherer | null
  probeBranchHolderFor: ((repoPath: string, branch: string) => Promise<BranchHolderProbe | null>) | null
  detectMergedPr: (run: TridentRun) => Promise<number | null>
  failedRun: (run: TridentRun, reason: string, keepSubagentId: boolean) => TridentRun
  launch: (run: TridentRun) => Promise<AdvanceOutcome>
  applyResult: (run: TridentRun, result: InnerResult) => Promise<AdvanceOutcome>
  handleUnconfirmedFire: (run: TridentRun) => AdvanceOutcome | Promise<AdvanceOutcome> | null
  sharedLauncherStandDown: (input: SharedLauncherStandDownInput) => AdvanceOutcome | null
}

/** Bind the unchanged recovery and watchdog step to its outer-loop capabilities. */
export function createRecoveryLivenessStep(deps: RecoveryLivenessDependencies) {
  const {
    now, log, fired, redispatched, infraRetryNotBefore, launchFaults, MAX_LAUNCH_FAULTS,
    unconfirmedFires, maxInflightMs, noAdvanceHangMs, maxCrashRecoveries, on_orphaned,
    beginCrashRecovery, latestStageEventAt, probeRunAlive, gatherRunEvidence,
    probeBranchHolderFor, detectMergedPr, failedRun, launch, applyResult,
    handleUnconfirmedFire, sharedLauncherStandDown,
  } = deps

  /** Elapsed ms since the run last advanced (checkpoint / launch). Conservative
   *  on an unparseable timestamp: returns 0 (never falsely reaps a run). */
  function elapsedSinceAdvance(run: TridentRun): number {
    const t = Date.parse(run.last_advanced_at)
    if (!Number.isFinite(t)) return 0
    const n = Date.parse(now())
    if (!Number.isFinite(n)) return 0
    return Math.max(0, n - t)
  }

  async function stepCore(run: TridentRun, worker: RunWorkerObservation): Promise<AdvanceOutcome> {
    if (isTerminalPhase(run.phase)) {
      fired.delete(run.id)
      redispatched.delete(run.id)
      infraRetryNotBefore.delete(run.id)
      launchFaults.delete(run.id)
      unconfirmedFires.delete(run.id)
      return { run, changed: false, waiting: false, note: `no-op (already ${run.phase})` }
    }

    // (1) HARVEST FIRST — a written terminal result wins over orphan recovery, so
    //     a run whose workflow finished before a restart harvests (never re-fires
    //     → never double-merges). Deterministic TS read of the typed DB column.
    // `subagent_status === 'crashed'` WIDENS this gate, and that widening is the
    // whole fix for the unbounded re-fire.
    //
    // A crash that lands BEFORE the launch save leaves the row with a NULL
    // `subagent_run_id`: `saveIfActive` is vetoed by the crash tombstone, so the
    // dispatch id it was carrying is never written. Every branch below was gated on
    // `subagent_run_id !== null`, so nothing observed the `crashed` status — and
    // (3) then hit `if (run.subagent_run_id === null) return launch(run)` and fired
    // a fresh detached build. Every tick. Forever. Measured on this branch by a
    // reviewer's live probe: `fires=1..6`, `subagent_run_id` still null at the end.
    //
    // A crashed launcher belongs on this side of the gate whether or not we ever
    // learned its subagent id. Ordering is deliberately unchanged: the harvest still
    // runs FIRST, so a workflow that wrote its terminal result and only then lost its
    // launcher still harvests rather than being reaped.
    //
    // A DEAD LAUNCHER IS NOT A DEAD BUILD — the position this code used to state
    // ("a crashed launcher is a DEAD RUN") is the defect, not the fix. The build runs
    // DETACHED; what died is the warm REPL supervising it, and the only thing that
    // makes that fatal is this routing. Measured 2026-08-14: three gateway boots
    // (a deploy loop — 06:19:56, 06:26:51, 07:13:00, three restarts in 53 min) each
    // reaped a healthy build ~90 s later, one of them (`8ddca917`) NINE MINUTES after
    // it had pushed its branch and opened PR #261 (+434/−17). The PUSHED BRANCH, the
    // PR and `inner_checkpoint` are the durable truth and they all survived; so with
    // `begin_crash_recovery` wired, a crashed launcher with nothing harvestable is
    // RELAUNCHED as a continuation from that state (§1a-crash below) rather than
    // reaped. Recovery is budget-bounded precisely BECAUSE the live cause is a deploy
    // loop: it must not spin fresh detached builds forever.
    if (run.subagent_run_id !== null || run.subagent_status === 'crashed') {
      const result = parseInnerResult(run.inner_result)
      if (result !== null) {
        const notBefore = infraRetryNotBefore.get(run.id)
        if (notBefore !== undefined) {
          const remainingMs = notBefore - Date.parse(now())
          if (remainingMs > 0) {
            return {
              run,
              changed: false,
              waiting: true,
              note: `publish-retry backoff (${Math.ceil(remainingMs / 1_000)}s remaining)`,
            }
          }
          infraRetryNotBefore.delete(run.id)
        }
        return applyResult(run, result)
      }
      if (worker.state === 'blocked') {
        return {
          run: failedRun(run, `worker blocked: ${worker.detail}`, false),
          changed: true, waiting: false, note: 'worker reported blocked to orchestrator',
        }
      }
      // A WORKING CONTROL SPARES THE NO-ADVANCE DEADLINE, NOT THE CEILING.
      // `esc to interrupt` establishes that a turn is IN FLIGHT — it does not
      // establish progress, which is the same limitation PTY activity has and the
      // exact reason `maxInflightMs` exists (`substrate.ts`: "a live-but-livelocked
      // child"). Letting this reprieve outrank the ceiling makes a livelocked lane
      // immortal and puts this module at odds with `run-driving.ts`, which still
      // refuses every reprieve past `DEFAULT_MAX_INFLIGHT_MS` on the same clock.
      // So: spare the 90-minute checkpoint-silence gate, fall through at 2 h.
      if (worker.state === 'working' && elapsedSinceAdvance(run) <= maxInflightMs) {
        return { run, changed: true, waiting: true, note: 'worker still working; sparing the no-advance deadline on run-scoped evidence' }
      }
      // (1a-crash) RECOVER, DON'T REAP. The launcher died with no harvestable result,
      //     but the run's continuation state (`branch`, `pr`, `inner_checkpoint`) is on
      //     the row and `launch()` already folds all three, so the build can simply be
      //     re-supervised. CLAIM it atomically first (`beginCrashRecovery` clears the
      //     crash latch, releases the sub-agent slot, nulls the tombstoned launcher
      //     generation and spends one unit of the DURABLE budget) — going through
      //     `update()`/`saveIfActive` is impossible here by design: their crash veto
      //     refuses non-crashed writes onto a latched row, and that veto stays.
      //
      //     `round`/`ralph_round` are untouched: a launcher crash is not the agent's
      //     failure. `harvested_at` is never stamped on any recovery path — nothing was
      //     harvested. Unwired (`begin_crash_recovery` absent) → falls through to the
      //     unchanged reap below, byte-stable for legacy callers.
      if (run.subagent_status === 'crashed' && beginCrashRecovery !== undefined) {
        // MEASURED 2026-08-16 23:21 gateway restart: recovery blindly relaunched
        // finished PRs #336/#337 and the owner hand-cancelled both. A merged PR is
        // terminal and outranks the recovery budget, but the claim MUST precede the
        // return: it clears the crash latch whose save veto would otherwise silently
        // discard done/completed. The claim spending one recovery unit is harmless
        // because the run ends terminal. Nothing was harvested, so do NOT stamp
        // `harvested_at` (applyResult remains its sole writer).
        const mergedPr = await detectMergedPr(run)
        if (mergedPr !== null) {
          const claimed = await beginCrashRecovery(run.id)
          if (claimed === null) {
            return { run, changed: false, waiting: true, note: 'crash-recovery claim lost — re-read next tick' }
          }
          fired.delete(run.id)
          redispatched.delete(run.id)
          const adopted: TridentRun = {
            ...claimed,
            phase: 'done',
            pr: mergedPr,
            branch: claimed.branch ?? run.branch,
            inner_checkpoint: 'pr-merged',
            inner_verdict: 'APPROVE',
            subagent_status: 'completed',
            failure_reason: null,
            last_advanced_at: now(),
          }
          return {
            run: adopted,
            changed: true,
            waiting: false,
            note: `PR #${mergedPr} already merged — adopted after launcher crash → done (no relaunch)`,
          }
        }
        // (1a-crash GATE) A LIVE PROCESS FOR THIS RUN DEFERS THE RELAUNCH. The
        //     crash latch fires on EVERY eviction of the hosting child, but the
        //     codex forge build is DETACHED (`nohup setsid`) and survives that
        //     child: relaunching now puts a second build on the same branch while
        //     the orphan is still writing to it. Same evidence the hang watchdog
        //     consults (§1b-0): a process whose argv carries this run's id is
        //     positive proof the build is alive, so wait for it to exit. Bounded by
        //     the 2 h ceiling below on the SAME clock (`elapsedSinceAdvance`) —
        //     never open-ended — and a DEFER never re-stamps that clock. Absence
        //     or `unknown` is not evidence and falls through to the relaunch.
        if (gatherRunEvidence !== null && elapsedSinceAdvance(run) <= maxInflightMs) {
          let crashEvidence: RunHangEvidence
          try {
            crashEvidence = await gatherRunEvidence(run, noAdvanceHangMs)
          } catch (err) {
            crashEvidence = unknownRunEvidence(err instanceof Error ? err.message : String(err))
            log.error('crash_relaunch_evidence_failed', {
              run: run.id,
              slug: run.slug,
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
            })
          }
          if (crashEvidence.process.observed === 'activity') {
            const leftMin = Math.max(0, Math.round((maxInflightMs - elapsedSinceAdvance(run)) / 60_000))
            return {
              run,
              changed: false,
              waiting: true,
              note:
                `launcher crashed but a process for this run is still alive (${crashEvidence.process.detail}) — ` +
                `deferring the relaunch until it exits (${leftMin} min to the in-flight ceiling)`,
            }
          }
        }
        if (run.crash_recoveries >= maxCrashRecoveries) {
          fired.delete(run.id)
          redispatched.delete(run.id)
          // NOTE THE WORDING: this reason must NOT contain "exhausted" — `delivery.ts`
          // pattern-matches that token into the review-unresolved class ("the reviewer
          // still had blocking findings"), which would be a confident lie about a run
          // whose reviewer may never have run. It carries the LATCHED crash reason too,
          // so the measured cause (T2's gateway boot timestamps) survives onto the row.
          const reaped = failedRun(
            run,
            `launcher crashed ${run.crash_recoveries + 1} time(s); crash-recovery budget ` +
              `(${maxCrashRecoveries}) used up — not relaunching. Last crash: ` +
              `${run.failure_reason ?? 'inner workflow child crashed'}`,
            false,
          )
          reaped.subagent_status = 'crashed'
          reaped.subagent_run_id = run.subagent_run_id
          return {
            run: reaped,
            changed: true,
            waiting: false,
            note: `${run.phase} → failed (crash-recovery budget)`,
          }
        }
        const claimed = await beginCrashRecovery(run.id)
        if (claimed === null) {
          // The claim LOST — the row went terminal (a cancel) or another tick took it.
          // Do nothing: whoever won owns the row now.
          return { run, changed: false, waiting: true, note: 'crash-recovery claim lost — re-read next tick' }
        }
        fired.delete(run.id)
        redispatched.delete(run.id)
        // CONTINUATION, not a restart: `launch()` folds `inner_checkpoint`/`pr`/`branch`
        // so the workflow resumes on the pushed branch and reuses the PR.
        try {
          const out = await launch(claimed)
          launchFaults.delete(run.id)
          return out
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const count = (launchFaults.get(run.id)?.count ?? 0) + 1
          launchFaults.set(run.id, { count, last: msg })
          if (count < MAX_LAUNCH_FAULTS) {
            return {
              run,
              changed: false,
              waiting: true,
              note: `launch threw (attempt ${count} of ${MAX_LAUNCH_FAULTS}): ${msg} — retrying next tick`,
            }
          }
          launchFaults.delete(run.id)
          fired.delete(run.id)
          redispatched.delete(run.id)
          const reason = `launch failed ${MAX_LAUNCH_FAULTS} time(s); not retrying — last error: ${msg}`
          return {
            run: failedRun(run, reason, false),
            changed: true,
            waiting: false,
            note: `${run.phase} → failed (launch kept throwing)`,
          }
        }
      }
      // (1a) TERMINAL-BUT-GARBLED harvest guard. The inner workflow marks
      //     `subagent_status='completed'` in the SAME sqlite UPDATE that writes
      //     `inner_result` (via `readfile()` of a temp file). If that readfile
      //     yields NULL — temp file missing/unreadable at UPDATE time, or a
      //     crash mid-write — the run is left `completed` with a null/unparseable
      //     `inner_result`: `parseInnerResult` returns null so the harvest above
      //     never fires, AND the workflow re-stamped `last_advanced_at` as it
      //     wrote `completed`, so the hang watchdog below is DEFEATED and the run
      //     sticks at `forge-init` forever. Treat a terminal `subagent_status`
      //     with no harvestable result as a TERMINAL FAILURE now (never merge —
      //     there is no verified result to merge on).
      if (run.subagent_status === 'completed' || run.subagent_status === 'failed' || run.subagent_status === 'crashed') {
        fired.delete(run.id)
        redispatched.delete(run.id)
        const reaped = failedRun(
          run,
          `terminal result missing/garbled (inner workflow marked ${run.subagent_status} ` +
            'but wrote no parseable inner_result)',
          false,
        )
        if (run.subagent_status === 'crashed') {
          reaped.subagent_status = 'crashed'
          reaped.subagent_run_id = run.subagent_run_id
          reaped.failure_reason = run.failure_reason ?? 'inner workflow child crashed'
        }
        return {
          run: reaped,
          changed: true,
          waiting: false,
          note: `${run.phase} → failed (terminal result garbled)`,
        }
      }
    }

    const fireDecision = handleUnconfirmedFire(run)
    if (fireDecision !== null) return fireDecision

    // (1b) Deadline policy, after the positive blocked/working observations above.
    // Checkpoints measure phase boundaries, so silence alone cannot identify a
    // hang. The probes below supply evidence and unclassified stops say unknown.
    if (run.subagent_run_id !== null && elapsedSinceAdvance(run) > noAdvanceHangMs) {
      // (1b-0) GATHER THE EVIDENCE BEFORE KILLING ANYTHING. The clock
      //     above measures phase boundaries, not work; a run mid-Forge is stale on
      //     that field however hard it is working. Stage events are written
      //     MID-phase, so one that is NEWER than the hang threshold is proof the run
      //     advanced inside the window the watchdog just called dead.
      //
      //     A RUN-SCOPED SPARE RE-STAMPS THE CLOCK; NOTHING ELSE DOES (T4). The
      //     column is caller-unpassable — `TridentRunUpdate` documents that
      //     `last_advanced_at` "is always re-stamped by `save`/`update` so callers
      //     never pass it" — so the stand-down below never touches it and never
      //     invents a timestamp: it returns the run snapshot UNMODIFIED with
      //     `changed: true`, and the tick's `saveIfActive` stamps `now()` as a
      //     matter of course.
      //
      //     WHY re-stamp at all: display consumers read that column and nothing
      //     else — the `STALLED_WARN_MS` badge computed in `tick.ts`
      //     `progressSignature`, and run-driving — so a run this watchdog has
      //     positively established is alive kept rendering as hours stale. It also
      //     costs: the probes re-fire on EVERY tick of a spared run instead of once
      //     per hang window, and the 2 h `maxInflightMs` ceiling false-kills a
      //     healthy long Forge round that never crosses a phase boundary.
      //
      //     WHAT IS PRESERVED. The watchdog still never READS this column as
      //     evidence (the defect this card names): every window's reprieve is
      //     re-earned from live evidence at decision time, so the re-stamp moves
      //     expiry from next-tick to next-window — exactly the latency the
      //     phase-transition stamp always had. A DEFER never re-stamps (an unknown
      //     check must not manufacture progress), and a spare carried SOLELY by a
      //     live shared launcher never re-stamps either: that answer is
      //     GENERATION-scoped, not run-scoped, which is what keeps the 2 h ceiling
      //     reachable for a forever-alive launcher.
      //
      //     ABSENCE IS NOT EVIDENCE: a null reader (not wired), an unparseable
      //     timestamp, or a run with no events at all falls straight through to the
      //     reap below, byte-identical to the old behaviour.
      const stageAt = latestStageEventAt === null ? null : latestStageEventAt(run.id)
      const stageMs = stageAt === null ? NaN : Date.parse(stageAt)
      const nowMs = Date.parse(now())
      const stageAgeMs =
        Number.isFinite(stageMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - stageMs) : null
      const stageFresh = stageAgeMs !== null && stageAgeMs <= noAdvanceHangMs
      // A SECOND, TIGHTER WINDOW — the only evidence allowed to overturn a POSITIVE
      // launcher death. See `DEAD_LAUNCHER_OVERRIDE_MS`: the probe answers about a
      // SHARED launcher generation, the heartbeat about THIS run's own (detached)
      // wrapper pid, and the ticker cannot outlive that pid by more than one cadence.
      const stageBeatsDeath = stageAgeMs !== null && stageAgeMs <= DEAD_LAUNCHER_OVERRIDE_MS
      const staleMins = Math.round(elapsedSinceAdvance(run) / 60_000)

      // (1b-ii) THE SECOND SOURCE. The stage ledger is silent for up to 72 measured
      //     minutes during one `codex exec`, and emits NOTHING AT ALL during review
      //     — so on its own it cannot answer for the whole window it is meant to
      //     cover. Ask the launcher-liveness probe too.
      //
      //     ASKED ON EVERY PATH, including the one the ledger would already have
      //     saved, because a POSITIVE DEATH must be able to beat positive life and
      //     that comparison cannot be made without the answer. The probe is only
      //     ever reached by a run already past the hang threshold — a handful of
      //     pid checks, at most once per run per tick, on a lane that is about to
      //     be killed.
      //
      //     A PROBE OUTAGE IS NOT A DEATH (`tick.ts` livenessBody makes the same
      //     call): a throw is 'unknown', which neither saves nor kills.
      let probe: SharedLauncherStandDownInput['probe'] = 'not-wired'
      if (probeRunAlive !== null) {
        try {
          probe = await probeRunAlive(run)
        } catch {
          probe = 'unknown'
        }
      }

      // (1b-iv) THE THREE RUN-SCOPED PROBES — the only evidence that answers about
      //     THIS run rather than about a ledger or a shared generation: a live
      //     process (ground truth), fresh mtime on the run's own artifacts, recent
      //     movement on its branch ref. See `gather_run_evidence`.
      //
      //     A GATHERER THAT THROWS OBSERVED NOTHING, and is recorded as such. The
      //     failure of the evidence collector must never present as evidence of
      //     death — `unknownRunEvidence` marks all three probes unknown, which
      //     defers the kill instead of authorising it.
      //
      //     Named `runEvidence`, not `evidence`: the stand-down branch below owns
      //     the sentence it hands the operator, and two things called "evidence"
      //     one screen apart is how the wrong one gets interpolated.
      let runEvidence: RunHangEvidence | null = null
      if (gatherRunEvidence !== null) {
        try {
          runEvidence = await gatherRunEvidence(run, noAdvanceHangMs)
        } catch (err) {
          runEvidence = unknownRunEvidence(err instanceof Error ? err.message : String(err))
        }
      }
      const runDecision = runEvidence === null ? null : decideHang(runEvidence, noAdvanceHangMs)
      const runFreshestMs = runEvidence === null ? null : freshestActivityAgeMs(runEvidence)
      // The same narrow window the stage ledger gets against a POSITIVE launcher
      // death, for the same reason: only evidence young enough that this run's own
      // wrapper must still have been alive may overturn it. A live process is age 0
      // and is therefore always inside it.
      const runEvidenceBeatsDeath = runFreshestMs !== null && runFreshestMs <= DEAD_LAUNCHER_OVERRIDE_MS

      // WHAT WAS CHECKED AND WHAT IT FOUND — carried onto BOTH outcomes, the reap
      // `reason` and the stand-down `note` alike. A reap that says only "suspected
      // agent hang" is unfalsifiable after the fact: the whole reason this watchdog
      // killed healthy builds for weeks is that its terminal record disclosed nothing
      // about the evidence it did or did not have. A STAND-DOWN needs the same
      // treatment for the same reason — an earlier cut of this block used a separate
      // `evidence` string on that branch that never reported what the probe answered,
      // so a run spared on stage evidence left no record of the probe's verdict and
      // the comment claiming "BOTH outcomes" was simply untrue. Concrete numbers,
      // never a boolean.
      //
      // APPEND-ONLY. The two clauses below are pinned by tests and read by
      // operators; the run-scoped clauses are added AFTER them, and when the seam
      // is not wired the string is byte-identical to what it was before it existed.
      const disclosure =
        `liveness checked: newest stage event ` +
        `${stageAgeMs === null ? 'none' : `${Math.round(stageAgeMs / 60_000)} min ago`}` +
        `, launcher probe=${probe === 'not-wired' ? 'not wired' : probe}` +
        (runEvidence === null ? '' : `; ${describeRunEvidence(runEvidence)}`)

      // (1b-iii) THE CEILING OUTRANKS EVERY REPRIEVE, and is checked FIRST so no
      //     evidence path can skip it. `maxInflightMs` (2 h) is the absolute
      //     lifetime bound; the stand-downs below return `waiting` and therefore
      //     never reach the section-(4) ceiling check further down, so without this
      //     an endlessly-heartbeating ticker or a launcher that outlives its build
      //     would hold one of ~6 lanes forever. That is a WORSE failure than the
      //     false kill this card fixes, not a quieter one.
      //
      //     AFTER T4 THE CEILING BOUNDS EXACTLY ONE CLASS OF RUN: the one whose only
      //     reprieve is a shared launcher or a deferral, neither of which re-stamps
      //     the advancement clock. A run spared by RUN-SCOPED evidence renews the
      //     window by design (the card's re-stamp ask), and its expiry is pinned by
      //     the reprieve-EXPIRES test rather than by this bound.
      const overCeiling = elapsedSinceAdvance(run) > maxInflightMs

      const spared = sharedLauncherStandDown({ run, overCeiling, probe, stageBeatsDeath, runEvidenceBeatsDeath, stageFresh, runDecision, stageAgeMs, runFreshestMs, staleMins, disclosure })
      if (spared !== null) return spared

      // (1b-v) DEFER — the branch that exists because "could not check" must never
      //     read as "checked and found nothing". No probe saw activity inside the
      //     window, but at least one COULD NOT LOOK, so the kill is postponed to the
      //     next tick rather than taken on a blind check. The run is NOT spared: it
      //     is re-examined every tick, and `maxInflightMs` (checked above, and which
      //     no reprieve crosses) still bounds it, so a permanently blind probe cannot
      //     make a lane immortal.
      //
      //     SUSPECTED-HANG PATH ONLY. A positive launcher death and the inflight
      //     ceiling are MEASURED causes, not inferences from silence — they keep
      //     today's behaviour and reap through a deferral.
      if (!overCeiling && probe !== 'dead' && runDecision?.action === 'defer') {
        return {
          run,
          changed: false,
          waiting: true,
          note:
            `hang watchdog DEFERRED: no positive liveness evidence inside the window, but a probe could ` +
            `not run and an unknown check must not authorise a kill — ${disclosure}`,
        }
      }
      fired.delete(run.id)
      redispatched.delete(run.id)
      const mins = Math.round(noAdvanceHangMs / 60_000)
      // Unknown terminal state has its own delivery classification; a deadline
      // is a policy stop, not evidence of a prompt or proof that work stopped.
      const reason = overCeiling
        ? `worker state unknown: no terminal result within ${Math.round(maxInflightMs / 60_000)} min` +
          ` — ${disclosure}; the 2 h deadline outranks ledger and process-only reprieves`
        : probe === 'dead'
          ? `no progress for ${mins} min and the inner workflow launcher is positively dead` +
            ` — ${disclosure}`
          : `worker state unknown: no checkpoint advancement for ${mins} min` +
            ` — ${disclosure}`
      const reaped = failedRun(run, reason, false)
      return {
        run: reaped,
        changed: true,
        waiting: false,
        note: `${run.phase} → failed (${overCeiling ? 'inflight ceiling' : probe === 'dead' ? 'launcher dead' : 'worker state unknown'})`,
      }
    }

    // (2) ORPHAN RECOVERY. A persisted dispatch id this process never fired AND no
    //     terminal result yet → the workflow died with a prior process. Recover
    //     per policy.
    if (run.subagent_run_id !== null && !fired.has(run.id)) {
      const orphanId = run.subagent_run_id
      if (on_orphaned === 'fail') {
        // The verdict rule is `failedRun`'s, not a fourth copy of it: this branch
        // used to inline the same conditional, which is exactly how the provenance
        // guard would have been added in two places and missed in the third.
        // `crashed` overrides the `failed` subagent_status because this row died
        // with its process rather than reporting a failure.
        const reaped: TridentRun = {
          ...failedRun(
            run,
            `orphaned inner-loop dispatch ${orphanId} (lost after restart / never wrote a result)`,
            true,
          ),
          subagent_status: 'crashed',
        }
        return { run: reaped, changed: true, waiting: false, note: `${run.phase} → failed (orphaned dispatch reaped)` }
      }
      if (on_orphaned === 'wait' || redispatched.has(run.id)) {
        return { run, changed: false, waiting: true, note: `waiting on orphaned inner-loop dispatch ${orphanId}` }
      }
      // NEVER REDISPATCH OVER A LIVE HOLDER. `fired` is in-memory, so after a
      // restart a lane that is genuinely still building looks exactly like a dead
      // orphan — and redispatching it puts a SECOND workflow on the branch the
      // first one is writing. Ask the filesystem, which survives the restart the
      // set did not. Positive evidence only: anything short of a live lock pid
      // falls through and redispatches exactly as before.
      if (probeBranchHolderFor !== null && run.branch !== null) {
        let holder: BranchHolderProbe | null = null
        try {
          holder = await probeBranchHolderFor(run.repo_path, run.branch)
        } catch (err) {
          holder = null
          log.error('orphan_branch_holder_probe_failed', {
            run: run.id,
            slug: run.slug,
            error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          })
        }
        if (holder !== null && holder.pid_live) {
          // WAIT, do not reap and do not re-fire: the run row stays non-terminal
          // (which also keeps `board-dispatch`'s own branch-liveness refusal
          // armed), and the 90-min reaper above still bounds it.
          return {
            run,
            changed: false,
            waiting: true,
            note:
              `orphaned inner-loop dispatch ${orphanId}, but worktree ${holder.worktree_basename} still holds ` +
              `the branch under a live lock (pid ${holder.pid}) — waiting rather than firing a second lane`,
          }
        }
      }
      // redispatch (default): clear the slot so the launch path re-fires a FRESH
      // workflow that resumes from the persisted checkpoint.
      redispatched.add(run.id)
      run = { ...run, subagent_run_id: null, subagent_status: null }
    }

    // (3) Launch-if-needed — the single fire site (null-guarded).
    if (run.subagent_run_id === null) {
      // The infra-retry backoff is checked BEFORE the launch-fault budget: a run
      // that is deliberately waiting out a backoff has not attempted a launch, so
      // it must not consume a fault from the budget that reaps a THROWING launch.
      const notBefore = infraRetryNotBefore.get(run.id)
      if (notBefore !== undefined) {
        const remainingMs = notBefore - Date.parse(now())
        if (remainingMs > 0) {
          return {
            run,
            changed: false,
            waiting: true,
            note: `infra-retry backoff (${Math.ceil(remainingMs / 1_000)}s remaining)`,
          }
        }
        infraRetryNotBefore.delete(run.id)
      }
      try {
        const out = await launch(run)
        launchFaults.delete(run.id)
        return out
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const count = (launchFaults.get(run.id)?.count ?? 0) + 1
        launchFaults.set(run.id, { count, last: msg })
        if (count < MAX_LAUNCH_FAULTS) {
          return {
            run,
            changed: false,
            waiting: true,
            note: `launch threw (attempt ${count} of ${MAX_LAUNCH_FAULTS}): ${msg} — retrying next tick`,
          }
        }
        launchFaults.delete(run.id)
        fired.delete(run.id)
        redispatched.delete(run.id)
        const reason = `launch failed ${MAX_LAUNCH_FAULTS} time(s); not retrying — last error: ${msg}`
        return {
          run: failedRun(run, reason, false),
          changed: true,
          waiting: false,
          note: `${run.phase} → failed (launch kept throwing)`,
        }
      }
    }

    // (4) In flight (fired by THIS process, no result yet). Reap a stalled
    //     workflow that has gone silent past the budget (no checkpoint refresh);
    //     otherwise keep waiting for it to write its result.
    if (elapsedSinceAdvance(run) > maxInflightMs) {
      fired.delete(run.id)
      const reaped = failedRun(
        run,
        `worker state unknown: no terminal result within ${Math.round(maxInflightMs / 60_000)} min`,
        false,
      )
      return { run: reaped, changed: true, waiting: false, note: `${run.phase} → failed (stalled)` }
    }
    return { run, changed: false, waiting: true, note: `waiting on inner-loop dispatch ${run.subagent_run_id}` }
  }

  return stepCore
}
