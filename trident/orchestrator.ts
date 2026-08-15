/**
 * @neutronai/trident — the orchestration step (Trident v2 · Work Board Phase 2a
 * EXEC-MODEL rearchitecture).
 *
 * The durable OUTER loop (`tick.ts` + the `code_trident_runs` SQLite table)
 * calls `step(run)` for every non-terminal run. As of Phase 2a the INNER
 * Forge→Argus→fix loop is ONE native CC Dynamic Workflow
 * (`trident/inner-workflow.mjs`), FIRED per run via a `TridentWorkflowFirer`
 * (`trident/inner-loop.ts`) on a WARM substrate whose launching turn settles
 * immediately. The workflow then runs DETACHED in the background and persists
 * its TYPED terminal result to the run row (`inner_result`); this step HARVESTS
 * that result from the DB by `runId` — deterministic TS, never an LLM-parsed
 * stdout line, never an in-memory build-result map.
 *
 * What this step owns (the OUTER concerns):
 *
 *   1. LAUNCH-IF-NEEDED. A live run with no in-flight dispatch
 *      (`subagent_run_id === null`) gets the workflow FIRED now: mint a tracking
 *      uuid, FIRE the workflow (the launching turn settles in seconds), and on a
 *      clean fire persist the id + `subagent_status='running'`. Idempotent
 *      crash-resume: before firing, fold any existing PR/branch + the last
 *      `inner_checkpoint` into the args so the workflow REUSES the PR (no
 *      duplicate) and skips finished phases.
 *
 *   2. HARVEST. With a workflow in flight, read the run's `inner_result` each
 *      tick. Once the workflow has written its TYPED terminal result, decode it
 *      (`parseInnerResult`), SERVER-GATE a merge-eligible `APPROVE` against the
 *      Argus-phase-recorded `inner_checkpoint='argus-approved'` (never a
 *      self-asserted result line), then on APPROVE → phase `done`
 *      (persist pr/branch/inner_verdict) + merge (`cleanupAfterMerge`, the
 *      outer/human gate); on REQUEST_CHANGES / failed-provenance → phase `failed`
 *      with a named reason (recoverable: re-run), never a silent success.
 *
 *      RALPH RE-FIRE (#362): a harvested result carrying `remaining_tasks > 0` is
 *      an INTERMEDIATE Ralph iteration — one task built, more remain. Instead of
 *      merging (the bug: multi-task builds shipped after task 1), `applyResult`
 *      RE-FIRES a fresh inner iteration for the next task (`refireNextRalphTask`:
 *      reset the sub-agent slot, keep branch/PR + the 'ralph-task-built' resume
 *      checkpoint, bump `ralph_round`, cap at `max_ralph_rounds`). This — not
 *      `state-machine.ts` — is where the live plan→task→repeat loop is driven in
 *      the exec model.
 *
 *   3. CRASH RECOVERY. The durable row is authoritative; harvest works across a
 *      process restart because the result lives in the DB, not in memory. A
 *      persisted `subagent_run_id` this process did NOT fire (lost on restart)
 *      AND no `inner_result` yet is an ORPHAN — re-fired per
 *      `on_orphaned_session` (a redispatch resumes from `inner_checkpoint`,
 *      bounded to one per process; a workflow that already merged is terminal so
 *      never re-fired → no double-merge). A workflow that fired but goes silent
 *      past `max_inflight_ms` with no checkpoint is reaped as a stalled run.
 *
 * `state-machine.ts` (`computeTransition`/`advanceTridentRun`) is intentionally
 * KEPT intact — for its `stubAdvanceDeps` restart-safe no-op fallback (used when
 * trident isn't wired to the exec-model orchestrator), its unit tests, its
 * one-commit revertibility, AND its role as the executable cross-repo PARITY
 * anchor for the legacy harness's `/trident` skill loop (`legacy-fixes.test.ts`). The exec-model
 * step above no longer drives its per-phase graph for the inner loop; in
 * particular the Ralph plan→task→repeat cycle is now driven HERE via the
 * `remaining_tasks` re-fire (`refireNextRalphTask`, #362), NOT by
 * `computeTransition`'s `ralph-plan`/`ralph-task` branches.
 */

import { writeFileSync } from 'node:fs'
import { cleanupAfterMerge, type MergeCleanupDeps } from './git-mode.ts'
import {
  parseInnerResult,
  type FireOutcome,
  type InnerResult,
  type TridentWorkflowFirer,
} from './inner-loop.ts'
import {
  buildMergeCleanupDeps,
  detectBaseBranch,
  runWorktreePath,
  TridentMergeConflictEscalation,
  type MergeConflictResolver,
  type RunHostCommand,
} from './merge.ts'
import { ARGUS_DIFF_LINE_LIMIT } from './prompts.ts'
import { isTerminalPhase, type AdvanceOutcome } from './state-machine.ts'
import type { TridentRun, TridentRunUpdate } from './store.ts'
import { DEFAULT_MAX_INFLIGHT_MS, NO_ADVANCE_HANG_MS } from './liveness.ts'

export interface TridentStep {
  (run: TridentRun): Promise<AdvanceOutcome>
}

export interface BuildTridentOrchestratorOptions {
  /** The inner-workflow FIRER (Phase 2a). Fires the inner CC Dynamic Workflow on
   *  a warm substrate + settles the launching turn; see `buildWorkflowFirer`. */
  fire_workflow: TridentWorkflowFirer
  /** Absolute sqlite file path threaded to the workflow's checkpoint +
   *  terminal-result Bash steps. */
  db_path: string
  /** Host command runner — base-branch detect, existing-PR probe, merge. */
  run_host: RunHostCommand
  /** ISO-8601 UTC clock. Defaults to wall-clock. */
  now?: () => string
  /** Injectable wait, used to SPACE the resume head-read retries
   *  (`resolveResumeLiveHead`). Production leaves it unset and really sleeps; the
   *  suite passes a no-op so a retried read still costs nothing. */
  sleep?: SleepMs
  /** Override base-branch resolution (else detected/`main`). */
  base_branch?: string
  /** Static Codex credential dir (CODEX_HOME) threaded into the inner workflow —
   *  the BUILD phase as well as the cross-model review. Resolved from
   *  NEUTRON_CODEX_HOME env / per-project config at wiring time. Undefined/null →
   *  codex "not connected". Used as the FALLBACK when `resolve_codex_home` is
   *  supplied but returns null — see that field. */
  codex_home?: string | null
  /** Per-run CODEX_HOME resolver (preferred over `codex_home`). Called on every
   *  tick with the launching run so the credential resolves through the #149
   *  store resolver (`CodexCredentialService.resolveActiveCodexHome`: project
   *  override → global → unset) with self-healing materialization — never a raw
   *  static path.
   *
   *  A NULL RESULT MEANS "NO PER-RUN ANSWER", NOT "NO CREDENTIAL EXISTS", so it
   *  falls back to `codex_home` rather than shadowing it. It used to win
   *  outright, and that cost the instance every build it tried to run on
   *  2026-08-13: a resolver miswired with the wrong lookup key returned null for
   *  a connected, materialized credential, and the correct static dir sitting
   *  beside it was never consulted. The inner workflow got `CODEX_HOME=''` and
   *  `trident/codex-build.sh` exited 10 NOT_CONNECTED before a line was written.
   *  Two independent sources of the same answer are only worth having if the
   *  second one is allowed to speak.
   *
   *  The fallback CANNOT resurrect a revoked credential:
   *  `CodexCredentialService.disconnect` deletes the store row AND removes the
   *  materialized `auth.json`, so after a disconnect the static dir has no
   *  credential and the wrapper still exits 10 — correctly.
   *
   *  Both null → codex not connected → the review is Claude-only (never a merge
   *  blocker), and a build routed to codex stops and says so. */
  resolve_codex_home?: (run: TridentRun) => string | null
  /**
   * The `SecretsStore` COORDINATES the inner workflow's credentialed-`gh` runner
   * (`trident/gh-authed.ts`) resolves the instance GitHub token from: the owner's
   * data dir (which holds the keyfile) and the frozen `owner_handle`. This is the
   * READ-side sibling of the `run_host` credential — same store, resolved per
   * command, never baked in at boot and never written to disk.
   *
   * COORDINATES, NOT A CREDENTIAL: they are threaded on into the workflow args (a
   * launcher prompt), so only paths/handles may ride here. Both absent → the
   * probes fall back to bare `gh`, i.e. the pre-2026-08-14 behaviour exactly.
   */
  gh_data_dir?: string | null
  /** The frozen `owner_handle` the GitHub token is filed under — see `gh_data_dir`. */
  gh_owner_handle?: string | null
  /**
   * RB2 (b) — resolve the owner's recent reflection corrections/diary block for a
   * launching run, threaded into the inner workflow so the FORGE BUILDER (forge:build
   * + fix rounds) re-grounds on owner corrections (reflection was chat-only before
   * RB2). NOT the independent review gate: the workflow injects it into Forge ONLY,
   * never argus:* (trust boundary — enforced in `inner-workflow.mjs`, verified in `inner-workflow-assembly.test.ts`). The composer wires
   * this to the SAME `reflection` instance the live-agent chat turn reads
   * (`reflection.loadContext()`), so the corrections Forge sees are the same ones
   * chat applies. Returns null
   * when nothing has been learned / the reflection layer is absent → a clean
   * no-op (the workflow splices no block). Reflection is not scope-filtered
   * (owner-wide corrections), so the `run` argument is accepted for parity with
   * the codex resolver but need not be consulted. Invoked BEST-EFFORT: a throwing
   * resolver degrades to no context and never fails the launch (see `launch()`).
   */
  resolve_reflection_context?: (run: TridentRun) => string | null
  /**
   * Is a Kimi K3 key configured? Called PER LAUNCH so a key added after boot is
   * honoured without a restart. Absent → the Kimi panelist never runs, which is
   * the graceful (never-blocking) path.
   */
  resolve_kimi_configured?: () => boolean
  /**
   * The owner's per-phase model/effort overrides for THIS launch.
   *
   * Resolved PER LAUNCH, for the same reason as the two resolvers above: a setting
   * changed after boot must take effect on the next run, not the next restart.
   *
   * THIS RESOLVER IS WHY THE FEATURE WORKS AT ALL. `phase-models.ts`, the workflow
   * argument and the router were all built and correct, and nothing ever produced a
   * value — the orchestrator simply did not pass one, so every run used the defaults
   * no matter what was configured. Absent → the workflow argument is omitted and the
   * defaults apply, which is the pre-existing behaviour exactly.
   */
  resolve_phase_models?: () => Record<string, { model?: string; effort?: string }> | null
  /** Override the merge/cleanup deps (else built from `run_host`). */
  merge_deps?: MergeCleanupDeps
  /**
   * Bounded Forge merge-conflict resolver (#342). Threaded into the default
   * `buildMergeCleanupDeps` so a LOCAL-mode merge that hits a rebase conflict
   * (a 2nd/3rd same-project build replaying onto a sibling's merge) is
   * auto-resolved rather than hard-failing. Ignored when `merge_deps` is
   * supplied (the override owns its own resolver). Absent → a conflict
   * escalates to chat immediately (no auto-resolve).
   */
  resolve_conflict?: MergeConflictResolver
  /** Mint the per-dispatch tracking id (test seam). Defaults to crypto.randomUUID. */
  mint_run_id?: () => string
  /**
   * RALPH RE-FIRE (#362) — persist the re-fire reset patch OUT-OF-BAND in ONE atomic
   * store UPDATE. `save`/`saveIfActive` DELIBERATELY never write `inner_result` (it is
   * workflow-owned, so the launch persist can't clobber a result the detached workflow
   * wrote), so a re-fire — which must null the harvested intermediate result AND reset
   * the sub-agent slot together — cannot go through them. This seam writes the whole
   * reset (`inner_result=null` + the released sub-agent slot + the bumped
   * `ralph_round`) as a SINGLE row UPDATE, so the durable row is never left in the
   * inconsistent `inner_result=null` + stale-terminal-sub-agent state that `step()`
   * would reap as "terminal-but-garbled" if the process crashed between two writes
   * (Codex review [P2]). The patch NEVER includes `phase`, so it cannot resurrect a
   * concurrently force-terminated run (that stays terminal; `saveIfActive` owns the
   * race-guarded phase write). Wired from the store:
   * `(id, patch) => store.update(id, patch).then(() => {})`. Omitted → a no-op default;
   * only Ralph multi-task runs reach the re-fire path, so non-Ralph callers/tests are
   * unaffected. MUST be wired wherever Ralph builds run.
   */
  persist_refire_reset?: (run_id: string, patch: TridentRunUpdate) => Promise<void>
  /**
   * CRASH RECOVERY CLAIM — atomically take ownership of a run whose LAUNCHER died
   * (`subagent_status='crashed'`) so `step()` can RELAUNCH it as a continuation
   * instead of reaping it. Wired to `TridentRunStore.beginCrashRecovery`: one
   * conditional UPDATE that clears the crash latch, releases the sub-agent slot,
   * nulls the tombstoned launcher generation, and spends one unit of the durable
   * `crash_recoveries` budget. Returns the reloaded run, or null when the claim
   * LOST (the row went terminal / was already claimed) — in which case this tick
   * must do nothing and re-read next tick.
   *
   * WHY IT EXISTS. Measured 2026-08-14: three gateway boots (06:19:56, 06:26:51,
   * 07:13:00) each killed a HEALTHY build ~90 s later, because the detached inner
   * workflow lives in a warm `cc-trident-fire-*` REPL that dies with the gateway.
   * Run `8ddca917` had already pushed its branch and opened PR #261 nine minutes
   * before its launcher died, and was reaped `failed` anyway. A dead launcher is
   * NOT a dead build.
   *
   * ABSENT → today's reap behaviour EXACTLY (byte-stable for existing callers and
   * tests): a crashed row with no harvestable result still goes terminal.
   */
  begin_crash_recovery?: (run_id: string) => Promise<TridentRun | null>
  /**
   * How many launcher crashes on ONE run may be recovered by relaunching before
   * the run is failed terminally. Default {@link DEFAULT_MAX_CRASH_RECOVERIES}.
   *
   * DELIBERATELY SEPARATE from `max_rounds`/`max_ralph_rounds`: a launcher crash is
   * not the agent's failure and must not consume its fix rounds. The counter it
   * bounds (`crash_recoveries`) is a DURABLE column rather than in-process state,
   * because the cause being bounded is a gateway deploy loop (three restarts in
   * 53 min) — every boot resets in-memory counters, so only a persisted budget can
   * stop a restart loop from spinning builds forever.
   */
  max_crash_recoveries?: number
  /**
   * How long a FIRED workflow may run with no terminal `inner_result` AND no
   * fresh checkpoint before it is reaped as stalled (the build runs detached, so
   * the tick loop owns build liveness). Measured from `last_advanced_at`, which
   * the workflow re-stamps on every checkpoint — so a healthy, checkpointing
   * build never trips this. Default 2 h.
   */
  max_inflight_ms?: number
  /**
   * PER-AGENT HANG WATCHDOG (M1 trident-UX hardening, item 2). The PRIMARY
   * fail-fast reap: a non-terminal run with an in-flight dispatch whose
   * `last_advanced_at` has not moved for this long — with no harvestable
   * `inner_result` — is treated as a suspected agent hang (the incident: a
   * zero-token model hang stalled a run 30+ min with NO error because nothing
   * detected it) and reaped to `failed`, so it surfaces on the Plan item + the
   * terminal delivery notification fires instead of sitting silent.
   *
   * A HEALTHY build re-stamps `last_advanced_at` on every inner-workflow
   * checkpoint (`forge-done`, `argus-*`, `fix-round-N`), so it never trips this;
   * only a genuinely wedged agent() (or a stalled orphan) does. This is
   * deliberately SHORTER than `max_inflight_ms` (the 2h absolute ceiling, kept
   * as a defense-in-depth backstop). Default `NO_ADVANCE_HANG_MS` (25 min).
   */
  no_advance_hang_ms?: number
  /**
   * What to do with an ORPHANED in-flight run on a tick — one whose
   * `subagent_run_id` is persisted but which THIS process never fired (the
   * restart case: the workflow was fired by a prior control-plane process and
   * died with it) AND which has not yet written an `inner_result`.
   *
   *   • `'redispatch'` (default) — RESUME by re-firing a FRESH workflow that
   *     reads `inner_checkpoint`/`pr`/`branch` and idempotently skips finished
   *     phases + reuses the PR. Bounded to one redispatch per run per process.
   *   • `'wait'` — leave untouched, keep polling (operator can `/trident stop`).
   *   • `'fail'` — reap the orphan loudly to `failed`.
   */
  on_orphaned_session?: 'redispatch' | 'wait' | 'fail'
}

/**
 * Default crash-recovery budget: how many launcher crashes ONE run may recover
 * from by relaunching as a continuation. 3 is sized off the measured cause — a
 * deploy loop of three gateway restarts inside 53 minutes on 2026-08-14 — so a
 * build survives an ordinary deploy burst, while a machine that cannot keep a
 * launcher alive fails the run loudly instead of re-firing detached builds
 * forever. Tune via `max_crash_recoveries` (exists chiefly for tests).
 */
export const DEFAULT_MAX_CRASH_RECOVERIES = 3

/**
 * RC2 — did the OUTER loop genuinely HARVEST a result into this committed
 * terminal transition? Keyed on the DURABLE `harvested_at` marker (migration
 * 0102), which `applyResult` — and ONLY `applyResult` — stamps. This is
 * deliberately NOT inferred from `inner_verdict`/`inner_result`: the DETACHED
 * inner workflow writes both to the row BEFORE the outer harvest, and the
 * out-of-band terminator (`terminate(id, 'failed'|'stopped')`, a board X-cancel
 * / `/code stop`) can flip a LIVE run terminal via `terminalTransition` WITHOUT
 * clearing them and WITHOUT setting `harvested_at`. So a force-terminated /
 * cancelled row — even one carrying a stale parseable `inner_result` + verdict —
 * returns false here, and the RC2 nexus producer fabricates no `handoff` /
 * `decision`; only a real outer-loop harvest emits.
 */
export function isTridentHarvestTerminal(run: TridentRun): boolean {
  return run.harvested_at !== null
}

/**
 * Sum changed lines from `git diff --numstat <base>..HEAD`. RETAINED as an
 * exported helper (its the legacy harness-parity tests + revertibility) though the inner
 * workflow now does its own oversized-diff guard internally. Conservative on
 * failure: returns OVER the ceiling so an unmeasurable diff is treated as large.
 */
export async function computeDiffLineCount(
  run_host: RunHostCommand,
  repo_path: string,
  base_branch: string,
): Promise<number> {
  let res
  try {
    res = await run_host(
      ['git', '-C', repo_path, 'diff', '--numstat', `${base_branch}..HEAD`],
      repo_path,
    )
  } catch {
    return ARGUS_DIFF_LINE_LIMIT + 1
  }
  if (!res.ok) return ARGUS_DIFF_LINE_LIMIT + 1
  let total = 0
  for (const line of res.stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 2) continue
    const added = parseInt(cols[0] ?? '', 10)
    const removed = parseInt(cols[1] ?? '', 10)
    if (Number.isFinite(added)) total += added
    if (Number.isFinite(removed)) total += removed
  }
  return total
}

/**
 * Per-agent hang watchdog default (M1 trident-UX hardening, item 2). A
 * non-terminal run whose `last_advanced_at` has not moved for this long while a
 * dispatch is in flight is reaped as a suspected agent hang.
 *
 * 25 min is a deliberate balance (Codex cross-model review [P1]): the ONLY
 * long no-checkpoint window in a HEALTHY build is a single Forge/fix `agent()`
 * step (checkpoints land between phases, not during one), and a large build can
 * legitimately run 15–20 min in that one step — a 15-min threshold would falsely
 * reap it. 25 min clears a normal large build while still catching the exact
 * 30+ min SILENT wedge that motivated this, FAR faster than the old 2h ceiling.
 * A reaped run is recoverable (re-run resumes from the last checkpoint). Tune via
 * `no_advance_hang_ms`.
 */

/**
 * THE TERMINAL REASON FOR A RUN THAT ENDED WITHOUT AN APPROVE.
 *
 * WHY THIS EXISTS. The branch that calls this is a CATCH-ALL: everything that is not a
 * merge-eligible APPROVE and not the provenance reject lands in it. It used to write one
 * hardcoded sentence — `inner loop exhausted ${run.max_rounds} round(s) without Argus
 * APPROVE` — interpolating the CONFIGURED CEILING, which is not a measurement of anything.
 * On 2026-08-13 four runs with four different causes (ten real review rounds; `CODEX_HOME`
 * unresolved; a truncated build brief; a missing push credential) all reported "exhausted
 * 10 round(s)". Three of them ended at ROUND 1 having never run a reviewer. Each time the
 * sentence read as a diagnosis, so the next person looked at review quality instead of the
 * build — it cost the owner an hour, then another.
 *
 * THE RULE (owner, 2026-08-13, verbatim): *"If it's a generic catchall make the error
 * message generic."* Generalised: A MESSAGE MUST NOT ASSERT A CAUSE IT DID NOT MEASURE.
 * Only ONE shape may claim exhaustion — the rounds actually ran out. Everything else says
 * what IS known (the round reached, the ceiling, the last checkpoint) and claims nothing
 * more. Generic-and-true beats specific-and-wrong; a confidently-worded default is the
 * failure mode, because it stops the reader looking further.
 *
 * `result.round` and `result.checkpoint` were ALWAYS in scope at the call site. Nothing
 * needed to be plumbed; they simply were not read.
 *
 * Exported because the defect was invisible while this was an inline template literal —
 * there was nothing a test could hold. Keep it reachable.
 */
/**
 * A PUBLISH FAILURE MUST CARRY GIT'S OWN WORDS — WITHOUT BECOMING A DISCLOSURE SURFACE.
 *
 * WHY THIS EXISTS. Run `2aacf419` (2026-08-14) was the first build ever to reach the publish
 * step. It failed, and the stored reason was `outer publisher could not push branch <b>` — the
 * branch name and nothing else. git's stderr had ALREADY said, in words,
 * `! [rejected] ... (non-fast-forward)`. It was thrown away.
 *
 * That is the sibling of the defect fixed in #240 and it landed in brand-new code. #240 removed a
 * message that ASSERTED a cause it never measured; this one MEASURED the cause and dropped it.
 * Opposite mistakes, identical cost: the reader cannot act. Recovering that one line cost a DB
 * read, a hand comparison of merge-bases, and a credentialed dry-run push.
 *
 * BUT stderr from a push is exactly where a credential can surface — a remote URL of the form
 * `https://user:token@host/...` is echoed back verbatim by git. So the text is carried THROUGH
 * this function or not at all. Redaction is not decoration here; without it, fixing an
 * observability defect would open a disclosure one.
 */
export function redactPushError(text: string): string {
  return (
    text
      // ANY userinfo before the `@`, not just `user:password` — git echoes the remote back on
      // failure. CODEX REVIEW [P1 Security]: the first cut required a colon, so the extremely
      // common single-value form `https://<token>@host/...` sailed straight through into a
      // PERSISTED failure reason. A token needs no password half to be a token.
      .replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@')
      // Bare GitHub token shapes, in case one reaches stderr by another route.
      .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
      .trim()
      // A reason is read by a human in a chat row; an unbounded paste is its own failure.
      .slice(0, 600)
  )
}

/**
 * The reason for a failed publish step: what we were doing, and what git said about it.
 * Nothing is inferred — the cause is quoted, not deduced.
 */
export function publishFailureReason(step: string, branch: string, stderr: string): string {
  const said = redactPushError(stderr)
  return said === ''
    ? `outer publisher could not ${step} branch ${branch}`
    : `outer publisher could not ${step} branch ${branch}: ${said}`
}

/**
 * A rebase that CONFLICTS is an ATTENTION state, never a verdict.
 *
 * A branch conflicting with its base is a MERGEABILITY fact about the branch's relationship to
 * `main` — not a judgement about the code. Recording it as `REQUEST_CHANGES` tells the owner his
 * build was rejected when no reviewer read a line of it. So this is a typed failure carrying the
 * conflicting paths, and NOTHING on this path invokes the `resolve_conflict` resolver (that
 * belongs to local-mode merges, where a human asked for a merge).
 */
export class TridentRebaseConflict extends Error {
  constructor(
    public branch: string,
    public base: string,
    public paths: string[],
  ) {
    super(
      `REBASE CONFLICT — needs attention: branch ${branch} conflicts with ${base} in: ${paths.length > 0 ? paths.join(', ') : '(paths unreadable)'}. Nothing was auto-resolved and no reviewer judged this code — the branch needs a human (or a fresh build) to reconcile it with ${base}.`,
    )
  }
}

/**
 * Replay `branch` onto the ls-remote-OBSERVED tip of `base`, shallow-safely.
 *
 * ⚠️ THE SHARED BUILD CHECKOUT IS SHALLOW (governance #574/#571). `.git/shallow` is present, so
 * `merge-base` LIES there: a naive `git rebase` replays the entire history and conflicts on every
 * file. Hence NO `git rebase` here, ever, and never in the shared working tree (other lanes share
 * it). Instead: take the branch's own diff from a source that knows the true merge-base — the
 * FORGE (`gh pr diff <n>`, computed server-side against a full history) when a PR exists, or the
 * two-dot `git diff <base>..<branch>` for a first publish — and `git apply --3way` it onto the
 * observed base tip in a THROWAWAY detached worktree. The branch ref then moves by
 * compare-and-swap (`update-ref <new> <old>`): if anything moved the branch underneath us we
 * refuse rather than force.
 *
 * The replay SQUASHES the branch into one commit. Deliberate — the PR merge is `--squash` anyway.
 */
export async function rebaseOntoObservedBase(
  run_host: RunHostCommand,
  repoPath: string,
  branch: string,
  base: string,
  pr: number | null,
  scratchDir: string,
): Promise<{ head: string; rebased: boolean }> {
  // (a) The base tip as OBSERVED on the remote — the same kind of observation the lease uses, and
  //     for the same reason: a remote-tracking ref is whatever the last fetch left behind.
  const observedBase = await run_host(
    ['git', '-C', repoPath, 'ls-remote', '--heads', 'origin', `refs/heads/${base}`],
    repoPath,
  )
  if (!observedBase.ok) {
    throw new Error(publishFailureReason('read the remote base of', branch, observedBase.stderr))
  }
  const readHead = async (): Promise<string> => {
    const head = await run_host(['git', '-C', repoPath, 'rev-parse', `refs/heads/${branch}`], repoPath)
    if (!head.ok) throw new Error(publishFailureReason('read the local tip of', branch, head.stderr))
    return head.stdout.trim()
  }
  let baseSha = observedBase.stdout.trim().split(/\s+/)[0] ?? ''
  // No remote base at all → there is nothing to rebase ONTO. Not an error (a brand-new origin).
  if (baseSha === '') return { head: await readHead(), rebased: false }

  // (b) The branch tip we are about to move, captured BEFORE anything touches it — it is the
  //     compare-and-swap expectation in (h).
  const oldHead = await readHead()

  // (c) Already contains the base tip → nothing to do. On a SHALLOW checkout this check may ERROR
  //     rather than answer (the commit is beyond the shallow boundary); any non-ok is read as
  //     "behind". A redundant replay is safe; a skipped one strands the branch as CONFLICTING.
  const contains = await run_host(
    ['git', '-C', repoPath, 'merge-base', '--is-ancestor', baseSha, `refs/heads/${branch}`],
    repoPath,
  )
  if (contains.ok) return { head: oldHead, rebased: false }

  // (d) Make the base tip a real local object. `--no-tags` and NOT `--unshallow`: deepening the
  //     shared checkout is minutes of network for every lane on this box.
  const fetchBase = async () => run_host(['git', '-C', repoPath, 'fetch', '--no-tags', 'origin', base], repoPath)
  let fetched = await fetchBase()
  let present = await run_host(['git', '-C', repoPath, 'rev-parse', '--verify', `${baseSha}^{commit}`], repoPath)
  if (!present.ok) {
    // The base moved between the observation and the fetch — re-observe ONCE and adopt it.
    const reObserved = await run_host(
      ['git', '-C', repoPath, 'ls-remote', '--heads', 'origin', `refs/heads/${base}`],
      repoPath,
    )
    const reSha = reObserved.ok ? (reObserved.stdout.trim().split(/\s+/)[0] ?? '') : ''
    if (reSha !== '') baseSha = reSha
    fetched = await fetchBase()
    present = await run_host(['git', '-C', repoPath, 'rev-parse', '--verify', `${baseSha}^{commit}`], repoPath)
    if (!present.ok) {
      throw new Error(publishFailureReason('fetch the base tip for', branch, present.stderr || fetched.stderr))
    }
  }

  // (e) The branch's own changes, from a source with an HONEST merge-base. Never a local
  //     three-dot diff — that is exactly the computation the shallow boundary corrupts.
  const diffFile = `/tmp/trident-rebase-${branch.replace(/[^A-Za-z0-9._-]/g, '-')}.diff`
  const patch =
    pr !== null
      ? await run_host(['gh', 'pr', 'diff', String(pr)], repoPath)
      : await run_host(['git', '-C', repoPath, 'diff', `refs/heads/${base}..refs/heads/${branch}`], repoPath)
  if (!patch.ok) throw new Error(publishFailureReason('read the diff of', branch, patch.stderr))
  if (patch.stdout.trim() === '') throw new Error('outer publisher refused to rebase an empty diff')
  // RESTORE THE TRAILING NEWLINE. `spawnCapture` TRIMS command output, which is harmless for every
  // other reader — and fatal here: a patch whose last hunk line lost its newline is not a patch,
  // and `git apply` rejects the whole thing with `corrupt patch at line N` (exit 128). That is
  // indistinguishable, upstream, from a genuine conflict, so EVERY rebase would have been reported
  // as an attention state. Caught by the real-git suite; the stubbed host never wrote a file.
  writeFileSync(diffFile, patch.stdout.endsWith('\n') ? patch.stdout : `${patch.stdout}\n`)

  // (f) Replay in an ISOLATED worktree. NEVER the shared working tree: a failed apply there would
  //     poison every other lane's build.
  const added = await run_host(
    ['git', '-C', repoPath, 'worktree', 'add', '--detach', '--force', scratchDir, baseSha],
    repoPath,
  )
  if (!added.ok) throw new Error(publishFailureReason('provision a rebase worktree for', branch, added.stderr))
  // The scratch worktree is OURS and disposable, so this `--force` removal is safe on every exit.
  const dropScratch = async () => {
    await run_host(['git', '-C', repoPath, 'worktree', 'remove', '--force', scratchDir], repoPath)
  }
  try {
    const applied = await run_host(['git', '-C', scratchDir, 'apply', '--3way', '--index', diffFile], scratchDir)
    if (!applied.ok) {
      // Best-effort: name the files a human has to look at. Failing to read them is not itself
      // a different failure — the conflict is the event.
      let paths: string[] = []
      try {
        const unmerged = await run_host(
          ['git', '-C', scratchDir, 'diff', '--name-only', '--diff-filter=U'],
          scratchDir,
        )
        if (unmerged.ok) paths = unmerged.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
      } catch {
        // paths stay empty; the message says so.
      }
      throw new TridentRebaseConflict(branch, base, paths)
    }
    const committed = await run_host(
      [
        'git',
        '-C',
        scratchDir,
        '-c',
        'user.name=trident',
        '-c',
        'user.email=trident@neutron.local',
        'commit',
        '-m',
        `rebase ${branch} onto ${base} @ ${baseSha.slice(0, 7)} (replayed from ${oldHead.slice(0, 7)})`,
      ],
      scratchDir,
    )
    if (!committed.ok) throw new Error(publishFailureReason('commit the rebase of', branch, committed.stderr))
    const replayed = await run_host(['git', '-C', scratchDir, 'rev-parse', 'HEAD'], scratchDir)
    if (!replayed.ok) throw new Error(publishFailureReason('read the replayed tip of', branch, replayed.stderr))
    const newHead = replayed.stdout.trim()

    // (h) COMPARE-AND-SWAP. `update-ref <ref> <new> <old>` fails if the branch is no longer at
    //     `<old>` — something else moved it, so we refuse instead of overwriting it.
    const swapped = await run_host(
      ['git', '-C', repoPath, 'update-ref', `refs/heads/${branch}`, newHead, oldHead],
      repoPath,
    )
    if (!swapped.ok) throw new Error(publishFailureReason('advance', branch, swapped.stderr))
    return { head: newHead, rebased: true }
  } finally {
    await dropScratch()
  }
}

/**
 * MID-LOOP RESUME — read the LIVE head of `run.branch` IN CODE, at the credentialed
 * host boundary, so the fact the resume decision turns on is never relayed by a model.
 * Same rule as the publisher's `rev-parse` (Part 1 of this card): a commit OID is not
 * something to be *reported*, it is something to be *read*. Before this, the live head
 * came from a haiku probe agent (`head-probe-round-resume`) whose failed read was
 * classified `head-unreadable` → a full rebuild of already-committed work.
 *
 * TRI-STATE RETURN — each value means exactly one thing, and they are NOT
 * interchangeable (the workflow's `classifyResume` gives them different consequences):
 *   - a 40-hex lowercase OID → the authority answered; this IS the live head.
 *   - `'absent'`             → the authority answered SUCCESSFULLY that the branch does
 *                              not exist. A real fact, not a failure: the recorded work
 *                              is gone from the authority, so a rebuild is correct and
 *                              can be named truthfully (`head-branch-absent`).
 *   - `''`                   → the read FAILED after 3 attempts. Reserved exclusively
 *                              for "could not read", never for "not there" — and
 *                              `classifyResume` now GIVES it a bounded STOP
 *                              (`{ mode: 'stop', reason: 'head-unreadable' }`): the run
 *                              ends naming the branch and the recorded OID instead of
 *                              rebuilding work that is already committed.
 *
 * The authority split mirrors the workflow's own `readBranchHead`: in `pr` mode the
 * REMOTE is the authority (an unpushed local branch is not the shared truth); in
 * `local` mode the local ref is.
 *
 * THE RETRIES ARE SPACED, AND THE SPACING IS AN INJECTED SEAM. In `pr` mode the read is
 * `git ls-remote` — a NETWORK call — and the consequence of `''` is a terminal, non-
 * self-healing run failure at the fast-exit in `launch()`. Three attempts fired back to
 * back complete inside a few milliseconds, which is short enough that a DNS blip or a
 * momentary GitHub 5xx fails all three and kills a run whose work is intact. So the
 * attempts are separated by `RESUME_HEAD_RETRY_DELAYS_MS`, through an injected `sleep`
 * the tests replace with a no-op — the delay is real in production and free in the
 * suite. `run_host` remains the seam for the READ; this is the seam for the WAIT.
 */
export const RESUME_HEAD_RETRY_DELAYS_MS = [250, 1000] as const

/** Injectable wait. Production sleeps; the suite passes a no-op so 3 attempts still
 *  cost nothing. */
export type SleepMs = (ms: number) => Promise<void>

const realSleep: SleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function resolveResumeLiveHead(
  run_host: RunHostCommand,
  run: { repo_path: string; branch: string; merge_mode: 'local' | 'pr' },
  sleep: SleepMs = realSleep,
): Promise<string> {
  const ref = `refs/heads/${run.branch}`
  const attempts = RESUME_HEAD_RETRY_DELAYS_MS.length + 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Between attempts only — never before the first read, and never after the last
    // (a run that is about to be failed must not also be made to wait for it).
    if (attempt > 0) await sleep(RESUME_HEAD_RETRY_DELAYS_MS[attempt - 1] ?? 0)
    if (run.merge_mode === 'pr') {
      const res = await run_host(
        ['git', '-C', run.repo_path, 'ls-remote', '--heads', 'origin', ref],
        run.repo_path,
      )
      if (res.ok) {
        // An OK ls-remote with no output is the remote SAYING the branch is gone.
        if (res.stdout.trim() === '') return 'absent'
        const token = res.stdout.trim().split('\n')[0]?.trim().split(/\s+/)[0] ?? ''
        if (/^[0-9a-f]{40}$/i.test(token)) return token.toLowerCase()
        // Malformed output is not an answer — retry rather than believe it.
      }
    } else {
      const res = await run_host(
        ['git', '-C', run.repo_path, 'rev-parse', '--verify', `${ref}^{commit}`],
        run.repo_path,
      )
      if (res.ok) {
        const oid = res.stdout.trim()
        if (/^[0-9a-f]{40}$/i.test(oid)) return oid.toLowerCase()
      } else {
        // A failed rev-parse is ambiguous: a missing branch and a broken/absent repo
        // both fail. Ask git whether it is healthy — if it is, the branch is genuinely
        // gone (a real answer); if it is not, this was a failed READ.
        const health = await run_host(
          ['git', '-C', run.repo_path, 'rev-parse', '--git-dir'],
          run.repo_path,
        )
        if (health.ok) return 'absent'
      }
    }
  }
  return ''
}

export function innerTerminalFailureReason(
  run: Pick<TridentRun, 'max_rounds' | 'round' | 'inner_checkpoint'>,
  result: Pick<InnerResult, 'round' | 'checkpoint' | 'block_kind' | 'terminal_cause'>,
): string {
  // Prefer the round the INNER workflow reports (what actually happened) over the row's
  // copy, which a crash can leave behind at its launch value.
  const reported = Number.isFinite(result.round) && result.round > 0 ? result.round : run.round
  const ceiling = run.max_rounds
  const checkpoint = result.checkpoint ?? run.inner_checkpoint ?? null
  // NO CAUSE IS INFERRED HERE — and that is the whole design, arrived at by being wrong
  // twice. Two Codex review rounds killed two attempts to deduce one:
  //
  //  R1: `reported >= ceiling` was read as "the budget ran out". It is not — the catch
  //      path writes the round it was ON, so a throw DURING round 10 arrives as
  //      `{ round: 10, checkpoint: 'inner-error' }`.
  //  R2: adding "…and the checkpoint is not `inner-error`" was ALSO not enough.
  //      `argus-request-changes` is written for SEVERAL distinct exits — genuine
  //      exhaustion, a round-lost fix (`inner-workflow.mjs` ~3174), a fix that left no
  //      diff (~3197), an `infra-only` synthesis stop (~3134). The checkpoint records the
  //      PHASE, never the TERMINAL CAUSE.
  //
  // The signal that would make a specific message honest — an explicit terminal cause
  // emitted by the inner workflow — DOES NOT EXIST. Inventing it here by inference is how
  // this line became wrong for four different failures in one night. So this reports only
  // what was measured: how far it got, and the last phase it recorded. Nothing about why.
  //
  // THE OWNER'S RULE, VERBATIM: *"If it's a generic catchall make the error message
  // generic."* This is a catch-all. This is the generic message. Making it specific again
  // is a change that must come WITH the missing signal, not before it — see the SPEC entry.
  //
  // 2026-08-14 — THE MISSING SIGNAL NOW EXISTS, on exactly ONE path. The inner workflow
  // emits an explicit `terminalCause` for infra-only stops: the probe's/lane's own words
  // (`inner-workflow.mjs` `infraTerminalCause`, already redacted + capped), measured at the
  // point where it was known rather than deduced here. Run 8417b277 is the case — an
  // unauthenticated `gh` made the readiness probe say `gh auth login`, no review seat ever
  // ran, and this function reported ten rounds' worth of review that never happened. So the
  // specific message ships WITH that measured signal, and ONLY with it: the branch below is
  // the one permitted specific message, gated on BOTH the block kind and a non-null cause.
  // Everything else — every inferred cause, every result carrying no measurement — still
  // gets the generic sentence above, for all the reasons R1/R2 record.
  // …and ONLY when the cause survives redaction with something left to read. An
  // over-redacted (or whitespace-only) cause is not a measurement, and appending a
  // dangling colon to the sentence would report one where none exists.
  if (result.block_kind === 'infra-only' && result.terminal_cause !== null) {
    const cause = redactPushError(result.terminal_cause).trim()
    if (cause !== '') return `review never ran (infra-only) at round ${reported} of ${ceiling}: ${cause}`
  }
  const at = checkpoint === null ? '' : ` at checkpoint '${checkpoint}'`
  return `inner workflow ended at round ${reported} of ${ceiling}${at} without Argus APPROVE`
}

export function buildTridentOrchestrator(
  opts: BuildTridentOrchestratorOptions,
): { step: TridentStep; drain: () => Promise<void> } {
  const now = opts.now ?? (() => new Date().toISOString())
  /** ms-epoch derived from the (injectable) ISO clock — the `harvested_at`
   *  stamp. Falls back to wall-clock ms if the ISO clock is unparseable. */
  const nowMs = (): number => {
    const t = Date.parse(now())
    return Number.isFinite(t) ? t : Date.now()
  }
  const fireWorkflow = opts.fire_workflow
  const db_path = opts.db_path
  const merge_deps =
    opts.merge_deps ??
    buildMergeCleanupDeps(
      opts.run_host,
      opts.resolve_conflict !== undefined ? { resolve_conflict: opts.resolve_conflict } : {},
    )
  const on_orphaned = opts.on_orphaned_session ?? 'redispatch'
  const mint = opts.mint_run_id ?? (() => crypto.randomUUID())
  const persistRefireReset = opts.persist_refire_reset ?? (async () => {})
  const maxInflightMs = opts.max_inflight_ms ?? DEFAULT_MAX_INFLIGHT_MS
  const noAdvanceHangMs = opts.no_advance_hang_ms ?? NO_ADVANCE_HANG_MS
  const beginCrashRecovery = opts.begin_crash_recovery
  const maxCrashRecoveries = opts.max_crash_recoveries ?? DEFAULT_MAX_CRASH_RECOVERIES

  // This-process liveness: run ids whose workflow THIS process fired (and whose
  // launching turn settled). A persisted `subagent_run_id` whose run.id is NOT
  // in this set is an orphan from a prior process. Crash-safe: lost on restart
  // (so all prior-process dispatches become orphans + re-fire idempotently).
  const fired = new Set<string>()
  // Run ids redispatched in THIS process — the per-process bound on orphan
  // recovery so a crash-restart loop can't spin forever.
  const redispatched = new Set<string>()
  // In-flight FIRE turns (tests + graceful shutdown drain). Each settles in
  // seconds; the build itself runs detached and is NOT tracked here.
  const inflight = new Set<Promise<void>>()

  async function resolveBase(run: TridentRun): Promise<string> {
    if (opts.base_branch !== undefined) return opts.base_branch
    return detectBaseBranch(opts.run_host, run.repo_path)
  }

  /** Best-effort probe for an existing PR on the run's branch (idempotent resume
   *  — never open a duplicate). Only meaningful in `pr` mode; never throws. */
  async function detectExistingPr(run: TridentRun): Promise<number | null> {
    if (run.merge_mode !== 'pr') return null
    const branch = run.branch ?? `trident/${run.slug}`
    try {
      const res = await opts.run_host(
        ['gh', 'pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number // empty'],
        run.repo_path,
      )
      if (res.ok) {
        const n = parseInt(res.stdout.trim(), 10)
        if (Number.isFinite(n) && n > 0) return n
      }
    } catch {
      // probe failure → treat as no existing PR (the workflow opens one).
    }
    return null
  }

  /**
   * A COMMIT OID IS READ, NOT REPORTED. `claimedHead` is whatever the build SAID it
   * committed — possibly abbreviated, possibly absent. The head that actually gets
   * published is the one git resolves for the branch the inner loop named (a name a
   * model cannot plausibly mangle). A claim is only ever a CHECK against that.
   */
  async function publishBuiltCommit(run: TridentRun, claimedHead: string | null): Promise<{ pr: number; head: string }> {
    if (run.merge_mode !== 'pr') throw new Error('outer publish requested outside pr mode')
    const branch = run.branch ?? `trident/${run.slug}`
    // `--verify` so a missing/ambiguous ref is an ERROR rather than an echoed argument.
    const local = await opts.run_host(
      ['git', '-C', run.repo_path, 'rev-parse', '--verify', `refs/heads/${branch}`],
      run.repo_path,
    )
    const resolvedHead = local.stdout.trim()
    if (!local.ok || !/^[0-9a-f]{40}$/.test(resolvedHead)) {
      const detail = local.stderr.trim()
      throw new Error(
        `outer publisher could not resolve branch ${branch} locally${detail === '' ? '' : `: ${detail}`}`,
      )
    }
    // THE CLAIM IS A CHECK, NEVER THE SOURCE. `startsWith` makes a full 40-char claim an
    // equality test and a 7-char one a prefix test. A disagreement is a real signal (wrong
    // branch, wrong worktree) and names BOTH values — neither is silently preferred.
    if (claimedHead !== null && !resolvedHead.startsWith(claimedHead.toLowerCase())) {
      throw new Error(
        `outer publisher refused: the build reported commit '${claimedHead}' but branch ${branch} resolves to '${resolvedHead}'`,
      )
    }
    const runWithRetries = async (command: string[], attempts = 3) => {
      let result = await opts.run_host(command, run.repo_path)
      for (let attempt = 1; !result.ok && attempt < attempts; attempt++) {
        result = await opts.run_host(command, run.repo_path)
      }
      return result
    }
    // THE REBASE ONTO CURRENT `main` HAPPENS HERE, BEFORE THE REVIEW IS RE-FIRED.
    //
    // WHEN. In the OUTER publisher, between the local-tip verification above and the lease
    // observation below. Only the outer loop holds a push credential (the Forge sandbox strips
    // `*TOKEN*`), so "rebase and re-push before the readiness probe" can only happen here. And
    // because this publisher fires after EVERY build/fix round and before EVERY review re-fire,
    // every fix round re-enters a branch already based on current `main` — post-round-1 code IS
    // written against the tree it merges into. That is the closest to "before build" the
    // credential boundary allows.
    //
    // ON CONFLICT. An ATTENTION state (`TridentRebaseConflict`), never `REQUEST_CHANGES` and never
    // auto-resolved. The failure names the conflicting paths and says plainly that no reviewer
    // judged the code; the `resolve_conflict` resolver is NEVER invoked on this path.
    //
    // SHALLOW (governance #574). The shared build checkout has a `.git/shallow` boundary, where
    // `merge-base` lies and a naive `git rebase` conflicts on every file. So this is a diff-replay
    // in a throwaway worktree — never `git rebase`, never the shared working tree.
    //
    // The PR probe moves UP so the replay can use `gh pr diff` (a server-side, shallow-immune
    // merge-base); its result is reused by the "open a PR if none" step below, unchanged.
    const prBefore = await detectExistingPr({ ...run, branch })
    const rebased = await rebaseOntoObservedBase(
      opts.run_host,
      run.repo_path,
      branch,
      await resolveBase(run),
      prBefore,
      `${run.repo_path}/.trident-worktrees/rebase-${run.id}`,
    )
    // Everything downstream publishes the REBASED head: the post-push confirm, the review diff,
    // and the `outer-published:<head>` checkpoint the re-fired workflow reads back.
    const headToPublish = rebased.head
    // THE BUILD REBASES ONTO CURRENT `main`, SO THE PUSH IS NOT A FAST-FORWARD.
    //
    // Measured on run `2aacf419` (2026-08-14): the build SUCCEEDED and the plain push here was
    // refused `! [rejected] ... (non-fast-forward)`. Verified NOT a credential failure — a dry-run
    // push with the real credential authenticated and got the same server-side refusal. A rebased
    // branch is by definition not a fast-forward, so an ordinary push can never publish one; this
    // stranded every card whose remote branch predated its rebase, which is most fix rounds.
    //
    // A LEASE, NOT A FORCE, AND THAT DISTINCTION IS THE WHOLE SAFETY PROPERTY. `--force-with-lease`
    // pinned to the sha we OBSERVED means: replace the remote branch, but only if it still holds
    // what we saw. A branch someone else genuinely advanced is refused rather than destroyed.
    // A bare `--force` would publish the rebase and silently discard their commits.
    //
    // PINNED TO AN OBSERVATION, NOT TO THE REMOTE-TRACKING REF. The bare `--force-with-lease` form
    // trusts `refs/remotes/origin/<b>`, which any concurrent `git fetch` can advance — at which
    // point the lease certifies a state nobody ever looked at, and quietly degrades to `--force`.
    // The explicit `<ref>:<sha>` form cannot be undermined that way.
    const observed = await runWithRetries(
      ['git', '-C', run.repo_path, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    )
    if (!observed.ok) {
      throw new Error(publishFailureReason('read the remote state of', branch, observed.stderr))
    }
    // Empty is MEANINGFUL, not a missing value: to git an empty expectation asserts the ref does
    // not exist, so a first push of a new card stays correct — and is still refused if the branch
    // appeared underneath us between this read and the push.
    const expected = observed.stdout.trim().split(/\s+/)[0] ?? ''
    // NOTHING BUILT IS A REAL OUTCOME. With the head read from git rather than relayed by a
    // model, a run that committed nothing would otherwise publish its own remote back to
    // itself and read as a success. `resolvedHead` is the PRE-rebase local tip, read before
    // the replay above could move the branch ref, so this compares exactly "commits ahead of
    // the remote". Zero ahead fails; an EMPTY `expected` means the remote branch does not
    // exist yet (first push) and stays publishable.
    if (expected === resolvedHead) {
      throw new Error(
        `outer publisher refused: branch ${branch} is already at ${resolvedHead} on origin — the build left no new commits to publish`,
      )
    }
    const pushed = await runWithRetries([
      'git',
      '-C',
      run.repo_path,
      'push',
      `--force-with-lease=refs/heads/${branch}:${expected}`,
      'origin',
      `refs/heads/${branch}:refs/heads/${branch}`,
    ])
    // NOTE the lease is deliberately NOT re-observed between retries. Re-reading it would adopt
    // whatever moved and turn the retry into the force this code exists to avoid.
    if (!pushed.ok) throw new Error(publishFailureReason('push', branch, pushed.stderr))

    const witnessed = await runWithRetries(
      ['git', '-C', run.repo_path, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    )
    const remoteHead = witnessed.ok ? witnessed.stdout.trim().split(/\s+/)[0] : ''
    if (remoteHead !== headToPublish) {
      throw new Error(`outer publisher could not confirm commit ${headToPublish} on origin`)
    }

    let pr = prBefore
    if (pr === null) {
      const base = await resolveBase(run)
      const created = await runWithRetries(
        ['gh', 'pr', 'create', '--head', branch, '--base', base, '--fill'],
      )
      if (!created.ok) throw new Error(`outer publisher could not open a PR for branch ${branch}`)
      pr = await detectExistingPr({ ...run, branch })
    }
    if (pr === null) throw new Error(`outer publisher could not confirm an open PR for branch ${branch}`)

    const diffFile = `/tmp/trident-outer-published-${run.id}.diff`
    const base = await resolveBase(run)
    const changed = await opts.run_host(
      ['git', '-C', run.repo_path, 'diff', '--name-only', `${base}..${headToPublish}`],
      run.repo_path,
    )
    if (!changed.ok || changed.stdout.trim() === '') {
      throw new Error('outer publisher refused to dispatch reviewers for an empty diff')
    }
    const diff = await opts.run_host(
      ['git', '-C', run.repo_path, 'diff', `--output=${diffFile}`, `${base}..${headToPublish}`],
      run.repo_path,
    )
    if (!diff.ok) throw new Error('outer publisher could not materialize the review diff')
    return { pr, head: headToPublish }
  }

  function failedRun(run: TridentRun, reason: string, keepSubagentId: boolean): TridentRun {
    return {
      ...run,
      phase: 'failed',
      subagent_status: 'failed',
      subagent_run_id: keepSubagentId ? run.subagent_run_id : null,
      failure_reason: reason,
      last_advanced_at: now(),
    }
  }

  /** Fire the inner workflow on the warm substrate; the launching turn settles
   *  immediately and the workflow runs detached. Persists the tracking id on a
   *  clean fire. Folds any existing PR + the last checkpoint into the args for
   *  idempotent resume. */
  async function launch(run: TridentRun): Promise<AdvanceOutcome> {
    const base = await resolveBase(run)
    const resume_checkpoint = run.inner_checkpoint
    // MID-LOOP RESUME — the checkpoint travels WITH the commit it was recorded
    // against (and, for a REQUEST_CHANGES checkpoint, the findings recorded with
    // it). Threading the name alone is what forced every relaunch to rebuild: a
    // verdict is about a COMMIT, and without the OID the workflow cannot tell
    // whether the branch still holds the code that verdict was about.
    const resume_checkpoint_head = run.inner_checkpoint_head
    const resume_findings = run.inner_checkpoint_findings
    // MID-LOOP RESUME — READ the live branch head HERE, in the outer loop, because
    // THIS is the credentialed host boundary: `opts.run_host` already runs every other
    // git command for this run. The workflow's `head-probe-round-resume` agent seat
    // survives only as a fallback for launchers that predate this arg. Derive the
    // recorded OID EXACTLY as the workflow does (inner-workflow.mjs, resume site): the
    // `outer-published:<oid>:r:t` capture takes precedence over the checkpoint column.
    const published =
      typeof resume_checkpoint === 'string'
        ? resume_checkpoint.match(/^outer-published:([0-9a-f]{40}):(\d+):(\d+)(:deviated)?$/)
        : null
    const recorded = (published?.[1] ?? resume_checkpoint_head ?? '').trim().toLowerCase()
    // Only read when the answer can change a decision: no checkpoint, no recorded OID
    // to compare against, or no branch → the workflow rebuilds regardless, and a fresh
    // launch must stay byte-identical (no extra git command, no extra arg).
    const resume_live_head =
      resume_checkpoint !== null &&
      /^[0-9a-f]{40}$/.test(recorded) &&
      typeof run.branch === 'string' &&
      run.branch.length > 0
        ? await resolveResumeLiveHead(
            opts.run_host,
            {
              repo_path: run.repo_path,
              branch: run.branch,
              merge_mode: run.merge_mode,
            },
            // The RETRY SPACING seam (see `resolveResumeLiveHead`): a `pr`-mode read is a
            // network call and the consequence of `''` is terminal, so the attempts are
            // spread over real time in production and collapsed to nothing in the suite.
            opts.sleep,
          )
        : undefined
    // PART 2b, OUTER FAST-EXIT — the launcher itself just failed 3 code reads of the
    // head. Firing the workflow now would spend a fire only to have `classifyResume`
    // return the bounded stop ({ mode: 'stop', reason: 'head-unreadable' }) for every
    // checkpoint except 'pr-merged' (resolved to `merged` BEFORE the head check —
    // exempted here for exactly that reason). classifyResume stays the single semantic
    // decider; this is only the cheap exit for the one case whose outcome is already
    // known at this boundary. `failedRun` spreads `run`, so inner_checkpoint /
    // inner_checkpoint_head / inner_checkpoint_findings survive untouched — a re-run
    // after the read recovers resumes at exactly this point.
    //
    // TWO CHECKPOINT NAMES ARE EXEMPT, each because classifyResume answers them BEFORE
    // it looks at the head, so this exit would pre-empt a decision it does not share:
    // 'pr-merged' (resolved to `merged`) and the empty name (resolved to `rebuild`,
    // reason 'no-checkpoint' — there is nothing recorded to preserve).
    const resume_checkpoint_name = (resume_checkpoint ?? '').trim()
    if (
      resume_live_head === '' &&
      resume_checkpoint_name !== 'pr-merged' &&
      resume_checkpoint_name !== ''
    ) {
      const cause = `could not read the head of ${run.branch}; the recorded work is at ${recorded}; re-run when the read succeeds`
      return {
        run: failedRun(
          run,
          innerTerminalFailureReason(run, {
            round: run.round,
            checkpoint: resume_checkpoint,
            block_kind: 'infra-only',
            terminal_cause: cause,
          }),
          false,
        ),
        changed: true,
        waiting: false,
        note: `${run.phase} → failed (resume head unreadable — bounded stop, no fire)`,
      }
    }
    const existingPr = run.pr ?? (await detectExistingPr(run))
    const launchRun: TridentRun = existingPr !== null && run.pr === null ? { ...run, pr: existingPr } : run

    const id = mint()
    if (typeof id !== 'string' || id.length === 0) {
      return {
        run: failedRun(run, 'trident: mint_run_id produced an empty id', false),
        changed: true,
        waiting: false,
        note: `${run.phase} → failed (empty dispatch id)`,
      }
    }

    // RB2 (b) — resolve the owner's reflection corrections/diary block BEST-EFFORT
    // before the fire. A reflection-store read must NEVER break a build launch: this
    // resolver is invoked OUTSIDE the `firePromise` error handling, so an
    // uncaught throw would escape `launch()` to the tick loop's log-only catch,
    // leaving the run stuck non-terminal with no dispatch id and retrying every tick
    // (Codex r4 [P1]). Mirror the chat path (`build-live-agent-turn.ts`), which
    // catches `loadContext()` and degrades to no context. Silent degrade to null —
    // the orchestrator has no logger and surfaces faults via its AdvanceOutcome.
    let reflection_context: string | null = null
    if (opts.resolve_reflection_context) {
      try {
        reflection_context = opts.resolve_reflection_context(launchRun)
      } catch {
        reflection_context = null
      }
    }

    // FIRE the workflow. The launching turn settles in seconds; the build runs
    // detached in the background and persists its own result to the DB. Tracked
    // in `inflight` only so tests/shutdown can drain the (fast) fire turn.
    const firePromise = fireWorkflow({
      run: launchRun,
      base_branch: base,
      db_path,
      max_rounds: run.max_rounds,
      resume_checkpoint,
      resume_checkpoint_head,
      // OMITTED entirely on a non-resume launch — the workflow then probes exactly as
      // it always did, so nothing about a fresh run changes.
      ...(resume_live_head !== undefined ? { resume_live_head } : {}),
      resume_findings,
      // Prefer the per-run resolver (store-backed, self-healing), and FALL BACK to
      // the static dir when it has no answer — null from the resolver is "nothing
      // per-run", not "nothing anywhere". See `resolve_codex_home` for what
      // shadowing cost on 2026-08-13 and why the fallback cannot resurrect a
      // revoked credential.
      codex_home:
        (opts.resolve_codex_home ? opts.resolve_codex_home(launchRun) : null) ??
        opts.codex_home ??
        null,
      // The credentialed-`gh` runner's store coordinates, so the inner loop's
      // GitHub READS carry the instance token the same way its writes do. Paths
      // and a handle only; `gh-authed.ts` resolves the token itself, per command.
      gh_data_dir: opts.gh_data_dir ?? null,
      gh_owner_handle: opts.gh_owner_handle ?? null,
      // Whether the KIMI K3 cross-model panelist runs this launch. Resolved PER
      // LAUNCH (not captured at composition) for the same reason the codex home
      // is: a key added after boot must take effect on the next run, not the next
      // restart (Decisions Log 2026-08-07). Default false → the panelist is
      // skipped and the review notes it, never blocks.
      kimi_configured: opts.resolve_kimi_configured ? opts.resolve_kimi_configured() : false,
      // RB2 (b) — the owner's recent reflection corrections/diary block (resolved
      // best-effort above), threaded into the inner workflow so the FORGE BUILDER
      // (not the argus review gate) re-grounds on owner corrections. Null when no
      // resolver / nothing learned / a
      // read failed.
      reflection_context,
      // The owner's per-phase model/effort choices. `buildWorkflowArgs` re-validates
      // and OMITS the argument when nothing valid is configured, so an untouched
      // instance produces byte-identical workflow args.
      ...(opts.resolve_phase_models
        ? { phase_models: opts.resolve_phase_models() }
        : {}),
    })
    const tracked = firePromise.then(
      () => undefined,
      () => undefined,
    )
    inflight.add(tracked)
    let outcome: FireOutcome
    try {
      outcome = await firePromise
    } catch (e) {
      // `buildWorkflowFirer` already converts throws to a `failed` outcome, but
      // stay defensive: a rejecting firer is a crashed launcher, never a success.
      outcome = { status: 'failed', error: e instanceof Error ? e.message : String(e) }
    } finally {
      inflight.delete(tracked)
    }

    if (outcome.status !== 'fired') {
      // The launching turn never settled cleanly — the workflow was NOT fired.
      // Fail loudly (recoverable: a re-run re-fires). paused ≠ finished.
      return {
        run: failedRun(run, `inner workflow fire failed: ${outcome.error ?? 'unknown'}`, false),
        changed: true,
        waiting: false,
        note: `${run.phase} → failed (fire did not settle)`,
      }
    }

    fired.add(run.id)
    const next: TridentRun = {
      ...launchRun,
      subagent_run_id: id,
      subagent_status: 'running',
      // The exact pooled launcher generation is the crash-ownership token. A
      // legacy/test fire seam without one retains the old observability id.
      workflow_run_id: outcome.launcher_session_key ?? launchRun.workflow_run_id ?? id,
      last_advanced_at: now(),
    }
    return {
      run: next,
      changed: true,
      waiting: true,
      note: `fired inner workflow ${id}${resume_checkpoint !== null ? ` (resume ${resume_checkpoint})` : ''}`,
    }
  }

  /** Apply a harvested, decoded inner result to the run (merge on a SERVER-GATED
   *  APPROVE, else fail). */
  /**
   * RALPH RE-FIRE (#362) — the harvested inner iteration built ONE task but MORE
   * remain (`remaining_tasks > 0`). Per the Ralph one-task-per-fresh-context
   * discipline the build is NOT done: reset the run to a launchable state so the
   * NEXT tick fires a FRESH inner iteration (re-plan against the committed
   * IMPLEMENTATION_PLAN.md + build the next top task, reusing the branch/PR), rather
   * than merging after task 1 (the bug #362 fixes). Bounded by `max_ralph_rounds`
   * (via the run's `ralph_round` counter) so a non-converging planner fails loudly
   * instead of re-firing forever.
   *
   * The reset is persisted OUT-OF-BAND in ONE atomic UPDATE (`persistRefireReset`)
   * because `saveIfActive` never writes `inner_result` (workflow-owned). Bundling the
   * `inner_result=null` clear WITH the sub-agent-slot release + `ralph_round` bump in a
   * single row write means a crash can never strand the row in the inconsistent
   * (inner_result=null, stale terminal sub-agent) state `step()` would reap as
   * "terminal-but-garbled" (Codex review [P2]). It never writes `phase`, so it can't
   * resurrect a concurrently force-terminated run; `saveIfActive` still commits the
   * (unchanged, non-terminal) phase under its race guard.
   */
  async function refireNextRalphTask(run: TridentRun, result: InnerResult): Promise<AdvanceOutcome> {
    fired.delete(run.id)
    redispatched.delete(run.id)
    const pr = result.pr_number ?? run.pr
    const branch = result.branch ?? run.branch
    const remaining = result.remaining_tasks ?? 0
    const nextRalphRound = run.ralph_round + 1

    if (nextRalphRound > run.max_ralph_rounds) {
      // Non-convergence cap: fail loudly. No out-of-band clear needed — the run goes
      // TERMINAL (`saveIfActive` commits `phase='failed'`), and `listNonTerminal`
      // never reloads a terminal row, so the stale `inner_result` is inert. (If a
      // crash beats that commit, the next tick re-harvests, re-enters here, and fails
      // again — idempotent.)
      const failed: TridentRun = {
        ...failedRun(
          run,
          `Ralph loop hit max_ralph_rounds (${run.max_ralph_rounds}) without converging ` +
            `(${remaining} task(s) still unbuilt)`,
          false,
        ),
        pr,
        branch,
        harvested_at: nowMs(),
        inner_verdict: 'REQUEST_CHANGES',
      }
      return { run: failed, changed: true, waiting: false, note: 'ralph loop → failed (max ralph rounds)' }
    }

    // ATOMIC reset to launchable: null the harvested `inner_result`, release the
    // sub-agent slot (so `step()` re-fires next tick), and bump `ralph_round` — all in
    // ONE store UPDATE, so any crash leaves a coherent, re-fireable row. Branch/PR and
    // the workflow-written 'ralph-task-built' `inner_checkpoint` (non-null, NOT
    // 'argus-approved') are preserved so the next fire resumes onto the branch and
    // re-plans the next task without the approved short-circuit. `phase` is
    // deliberately excluded (see the seam doc): it stays whatever it is, so a
    // concurrently cancelled run is never resurrected.
    const resetPatch: TridentRunUpdate = {
      inner_result: null,
      subagent_run_id: null,
      subagent_status: null,
      ralph_round: nextRalphRound,
      inner_verdict: null,
      pr,
      branch,
    }
    await persistRefireReset(run.id, resetPatch)

    // The returned run mirrors the atomic patch (+ the unchanged non-terminal phase)
    // so the tick's race-guarded `saveIfActive` idempotently re-commits it — and, if a
    // force-terminate won the row meanwhile, is skipped (the atomic patch above never
    // moved `phase`, so nothing resurrects the cancelled run). `harvested_at` is left
    // unstamped — this is a NON-terminal continuation, not a terminal outer-harvest.
    const next: TridentRun = {
      ...run,
      ralph_round: nextRalphRound,
      pr,
      branch,
      subagent_run_id: null,
      subagent_status: null,
      inner_result: null,
      inner_verdict: null,
      last_advanced_at: now(),
    }
    return {
      run: next,
      changed: true,
      waiting: false,
      note: `ralph task built (${remaining} remain) → re-fire iteration ${nextRalphRound}/${run.max_ralph_rounds}`,
    }
  }

  async function applyResult(run: TridentRun, result: InnerResult): Promise<AdvanceOutcome> {
    fired.delete(run.id)
    redispatched.delete(run.id)

    // A merged PR is terminal even if the inner process was about to request a
    // publish. Do not recreate its deleted branch or open a replacement PR.
    if (result.pr_merged) {
      const mergedRun: TridentRun = {
        ...run,
        harvested_at: nowMs(),
        phase: 'done',
        pr: result.pr_number ?? run.pr,
        branch: result.branch ?? run.branch,
        inner_checkpoint: result.checkpoint ?? 'pr-merged',
        inner_verdict: 'APPROVE',
        subagent_status: 'completed',
        failure_reason: null,
        last_advanced_at: now(),
      }
      return { run: mergedRun, changed: true, waiting: false, note: `PR #${mergedRun.pr ?? '?'} already merged → done (no publish)` }
    }

    if (result.publish_requested) {
      try {
        // The handoff is the BRANCH NAME; a relayed sha is only a check. A build that
        // reported no OID is still published — `publishBuiltCommit` reads the head from git.
        const published = await publishBuiltCommit(run, result.publish_head ?? null)
        // FORMAT OWNED IN LOCKSTEP by this builder and three readers — the
        // resume-launch regex below, `inner-workflow.mjs`'s resume parse, and its
        // `classifyResume`. The optional `:deviated` suffix carries the previous
        // Forge's deviation across the process boundary so the resumed invocation
        // writes the `ralph-task-built-deviated` checkpoint and the NEXT iteration
        // full-plans; without it the string is byte-identical to the old format.
        const checkpoint = `outer-published:${published.head}:${result.remaining_tasks ?? 0}:${result.round}${result.deviated_from_spec ? ':deviated' : ''}`
        const resetPatch: TridentRunUpdate = {
          inner_result: null,
          subagent_run_id: null,
          subagent_status: null,
          inner_checkpoint: checkpoint,
          inner_verdict: null,
          pr: published.pr,
          branch: result.branch ?? run.branch,
        }
        await persistRefireReset(run.id, resetPatch)
        return {
          run: { ...run, ...resetPatch, last_advanced_at: now() },
          changed: true,
          waiting: false,
          note: `outer publisher confirmed ${published.head} and PR #${published.pr} → re-fire review`,
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        return {
          run: failedRun(run, `publish failed: ${reason}`, true),
          changed: true,
          waiting: false,
          note: `publish handoff → failed (${reason})`,
        }
      }
    }

    // A MERGE IS TERMINAL (ISSUES #563) — checked before EVERY other branch,
    // including the Ralph re-fire, because a merged PR outranks every other reading
    // of this result: the change has shipped, its head branch is gone, and there is
    // nothing left to build onto, review, or merge.
    //
    // THE RUN IS RECORDED AS A SUCCESS AND NO MERGE IS ATTEMPTED. Both halves
    // matter. Falling through to the APPROVE path would run `gh pr merge` against
    // an already-merged PR, which fails and would record this successful run as
    // `merge failed` — a merged run reported as broken, which is worse than the
    // waste this fix removes. Falling through to the REQUEST_CHANGES path would
    // record it as `round-lost`/exhausted for the same reason.
    //
    // The provenance gate is not consulted, and does not need to be: it exists to
    // stop an unreviewed APPROVE from CAUSING a merge, and nothing here merges.
    if (result.pr_merged) {
      const mergedRun: TridentRun = {
        ...run,
        harvested_at: nowMs(),
        phase: 'done',
        pr: result.pr_number ?? run.pr,
        branch: result.branch ?? run.branch,
        inner_checkpoint: result.checkpoint ?? 'pr-merged',
        inner_verdict: 'APPROVE',
        subagent_status: 'completed',
        failure_reason: null,
        last_advanced_at: now(),
      }
      return {
        run: mergedRun,
        changed: true,
        waiting: false,
        note: `PR #${mergedRun.pr ?? '?'} already merged → done (no second merge)`,
      }
    }

    // RALPH RE-FIRE (#362) — checked FIRST, before the terminal-harvest stamp: an
    // intermediate iteration with tasks still remaining is NOT a merge/fail, so it
    // must not stamp `harvested_at` (the terminal-harvest marker) nor run the merge
    // provenance gate. Re-fire a fresh iteration for the next task instead.
    if (result.remaining_tasks !== null && result.remaining_tasks > 0) {
      return refireNextRalphTask(run, result)
    }

    // RC2 — STAMP the durable outer-harvest marker up front, so EVERY outcome
    // this function returns (done / provenance-reject / exhausted / merge-fail)
    // carries it (they all spread `run`). `applyResult` is reached ONLY on a
    // genuine harvest (a decoded `inner_result`), and NOTHING else writes
    // `harvested_at` — not the inner workflow, not the out-of-band
    // `terminalTransition` — so `harvested_at !== null` on the committed row is
    // the force-terminate-proof "the outer loop harvested" signal the RC2 nexus
    // producer keys on (`isTridentHarvestTerminal`).
    run = { ...run, harvested_at: nowMs() }

    const pr = result.pr_number ?? run.pr
    const branch = result.branch ?? run.branch

    // SERVER-GATED verdict provenance: a merge-eligible APPROVE must be backed by
    // the Argus phase's OWN recorded checkpoint (`inner_checkpoint='argus-approved'`,
    // written by the workflow's synthesis-phase Bash step), NEVER just the
    // self-asserted verdict in the harvested result line. A result claiming
    // APPROVE without that recorded provenance is rejected — failed, not merged.
    const argusApproved = run.inner_checkpoint === 'argus-approved'

    if (result.verdict === 'APPROVE' && argusApproved) {
      // FIX 1 (#351) — record this run's DEDICATED merge worktree on the row BEFORE
      // the merge, so `code_trident_runs.worktree` is populated (was always empty)
      // and the isolated path is durable for cleanup even if the merge escalates or
      // crashes. Local mode only — pr mode merges the remote (`gh pr merge`) and
      // never provisions a local worktree.
      const worktree = run.merge_mode === 'local' ? runWorktreePath(run.repo_path, run) : run.worktree
      const doneRun: TridentRun = {
        ...run,
        phase: 'done',
        pr,
        branch,
        worktree,
        inner_checkpoint: result.checkpoint ?? 'argus-approved',
        inner_verdict: 'APPROVE',
        subagent_status: 'completed',
        failure_reason: null,
        last_advanced_at: now(),
      }
      try {
        const res = await cleanupAfterMerge(doneRun, merge_deps)
        return { run: doneRun, changed: true, waiting: false, note: `APPROVE (argus-approved) → done; ${res.note}` }
      } catch (err) {
        // #342 — a genuinely ambiguous merge conflict escalates a SPECIFIC
        // question to chat (not a raw "merge failed"): fail the run with the
        // question AS the reason so the terminal delivery posts exactly it.
        if (err instanceof TridentMergeConflictEscalation) {
          return {
            run: { ...failedRun(doneRun, err.question, true), inner_verdict: 'APPROVE' },
            changed: true,
            waiting: false,
            note: 'done → failed (merge conflict escalated to chat)',
          }
        }
        const reason = err instanceof Error ? err.message : 'merge failed'
        return {
          run: { ...failedRun(doneRun, `merge failed: ${reason}`, true), inner_verdict: 'APPROVE' },
          changed: true,
          waiting: false,
          note: `done → failed (${reason})`,
        }
      }
    }

    if (result.verdict === 'APPROVE' && !argusApproved) {
      // Provenance gate tripped — a self-asserted APPROVE with no recorded
      // argus-approved checkpoint. Never merge on an unverified verdict.
      const failed: TridentRun = {
        ...failedRun(
          run,
          'inner workflow reported APPROVE but no recorded argus-approved checkpoint (provenance gate)',
          true,
        ),
        pr,
        branch,
        inner_verdict: 'REQUEST_CHANGES',
      }
      return { run: failed, changed: true, waiting: false, note: 'APPROVE rejected (provenance gate) → failed' }
    }

    // REQUEST_CHANGES / null — the inner loop ended without an APPROVE. This is a
    // CATCH-ALL over several distinct causes, so the reason is MEASURED rather than
    // assumed; see `innerTerminalFailureReason` for what that cost when it was not.
    const failed: TridentRun = {
      ...failedRun(run, innerTerminalFailureReason(run, result), true),
      pr,
      branch,
      // CODEX REVIEW, ROUND 3 [P2] — the row must not contradict its own reason. This used
      // to prefer `run.inner_checkpoint` (the row's, possibly STALE, copy) while the reason
      // prefers `result.checkpoint` (what the terminal result actually reported), so a run
      // with `inner_checkpoint='forge-built'` and a result of `inner-error` produced a reason
      // naming `inner-error` beside a structured field saying `forge-built`. Two answers to
      // one question is the shape of this whole defect; the terminal result is authoritative
      // on how it ended, so BOTH read it the same way and in the same order.
      inner_checkpoint: result.checkpoint ?? run.inner_checkpoint ?? 'argus-request-changes',
      inner_verdict: 'REQUEST_CHANGES',
    }
    return { run: failed, changed: true, waiting: false, note: 'inner loop ended without APPROVE → failed' }
  }

  /** Elapsed ms since the run last advanced (checkpoint / launch). Conservative
   *  on an unparseable timestamp: returns 0 (never falsely reaps a run). */
  function elapsedSinceAdvance(run: TridentRun): number {
    const t = Date.parse(run.last_advanced_at)
    if (!Number.isFinite(t)) return 0
    const n = Date.parse(now())
    if (!Number.isFinite(n)) return 0
    return Math.max(0, n - t)
  }

  async function step(run: TridentRun): Promise<AdvanceOutcome> {
    if (isTerminalPhase(run.phase)) {
      fired.delete(run.id)
      redispatched.delete(run.id)
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
        return applyResult(run, result)
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
        return launch(claimed)
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

    // (1b) HANG WATCHDOG (M1 trident-UX hardening, item 2) — the PRIMARY
    //     fail-fast detector. A dispatch is in flight (subagent_run_id set) with
    //     NO harvestable result (the harvest above already returned otherwise),
    //     and `last_advanced_at` has not moved for `noAdvanceHangMs`. A healthy
    //     build re-stamps that timestamp on every inner-workflow checkpoint, so
    //     only a genuinely wedged agent() (the zero-token model hang that stalled
    //     a run 30+ min with no error) — or a stalled orphan that hasn't been
    //     redispatched — sits here. Reap it to `failed` NOW so the Plan item
    //     flips to "failed" + the terminal delivery notification fires, rather
    //     than waiting on the 2h `maxInflightMs` ceiling below. Checked BEFORE
    //     orphan recovery so a wedged orphan is reaped instead of redispatched.
    if (run.subagent_run_id !== null && elapsedSinceAdvance(run) > noAdvanceHangMs) {
      fired.delete(run.id)
      redispatched.delete(run.id)
      const mins = Math.round(noAdvanceHangMs / 60_000)
      const reaped = failedRun(
        run,
        `no progress for ${mins} min — suspected agent hang (inner workflow stopped advancing)`,
        false,
      )
      return { run: reaped, changed: true, waiting: false, note: `${run.phase} → failed (suspected hang)` }
    }

    // (2) ORPHAN RECOVERY. A persisted dispatch id this process never fired AND no
    //     terminal result yet → the workflow died with a prior process. Recover
    //     per policy.
    if (run.subagent_run_id !== null && !fired.has(run.id)) {
      const orphanId = run.subagent_run_id
      if (on_orphaned === 'fail') {
        const reaped: TridentRun = {
          ...run,
          phase: 'failed',
          subagent_status: 'crashed',
          failure_reason: `orphaned inner-loop dispatch ${orphanId} (lost after restart / never wrote a result)`,
          last_advanced_at: now(),
        }
        return { run: reaped, changed: true, waiting: false, note: `${run.phase} → failed (orphaned dispatch reaped)` }
      }
      if (on_orphaned === 'wait' || redispatched.has(run.id)) {
        return { run, changed: false, waiting: true, note: `waiting on orphaned inner-loop dispatch ${orphanId}` }
      }
      // redispatch (default): clear the slot so the launch path re-fires a FRESH
      // workflow that resumes from the persisted checkpoint.
      redispatched.add(run.id)
      run = { ...run, subagent_run_id: null, subagent_status: null }
    }

    // (3) Launch-if-needed — the single fire site (null-guarded).
    if (run.subagent_run_id === null) {
      return launch(run)
    }

    // (4) In flight (fired by THIS process, no result yet). Reap a stalled
    //     workflow that has gone silent past the budget (no checkpoint refresh);
    //     otherwise keep waiting for it to write its result.
    if (elapsedSinceAdvance(run) > maxInflightMs) {
      fired.delete(run.id)
      const reaped = failedRun(
        run,
        `inner workflow stalled (no terminal result within ${Math.round(maxInflightMs / 60_000)} min)`,
        false,
      )
      return { run: reaped, changed: true, waiting: false, note: `${run.phase} → failed (stalled)` }
    }
    return { run, changed: false, waiting: true, note: `waiting on inner-loop dispatch ${run.subagent_run_id}` }
  }

  /** Resolve once every in-flight FIRE turn has settled (tests + graceful
   *  shutdown). The detached builds are NOT awaited here — the tick loop harvests
   *  their results from the DB. */
  async function drain(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.all([...inflight])
    }
  }

  return { step, drain }
}
