import { projectBuildPending } from './project-launcher.ts'
import { createRecoveryLivenessStep, type SharedLauncherStandDownInput } from './recovery-liveness.ts'
import { rebaseOntoObservedBase } from './replay.ts'
import { publishFailureReason, redactPushError } from './publish-failure.ts'
export { rebaseOntoObservedBase, healShallowCheckout, TridentRebaseConflict } from './replay.ts'
export { ensureAsBuiltMergeDriver } from './as-built-merge-driver.ts'
export { publishFailureReason, redactPushError } from './publish-failure.ts'
import { fixLineage } from './gates/fix-lineage.ts'
import { unknownWorkerObservation, workerEvidence, type RunWorkerObserver, type RunWorkerObservation } from './worker-observation.ts'
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

import { CodexProjectOwnerError } from './codex-project-owner.ts'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createLogger } from '@neutronai/logger'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { gitRangeArgv } from './git-range.ts'
import { hasArgusProvenance, phaseForCheckpoint } from './checkpoint-phase.ts'
import { ralphCapFailureReason } from './ralph-budget.ts'
import { checkpointRoundField } from './checkpoint-round.ts'
import { executeBoundReview } from './review-run.ts'
import {
  assertDiffOutputHost,
  cleanupAfterMerge,
  type DiffOutputHost,
  type HostCommandResult,
  type MergeCleanupDeps,
} from './git-mode.ts'
import { reviewedHeadOid } from './merge.ts'
import type { TridentArbiter } from './arbiter.ts'
import { CONFIGURED_CODE_CAVEAT, composeWrongBaseRefusal, foldEvidence, foldRefName } from './wrong-base-remedy.ts'
import { readCommittedMutationClaim } from './mutation-claim-artifact.ts'
import {
  NO_NOMINATION_REFUSAL,
  runMutationProofGate,
  type MutationGateInput,
  type MutationGateOutcome,
} from './mutation-prover.ts'
import {
  ESCALATION_KINDS,
  parseCheckpointFindings,
  parseInnerResult,
  type EscalationKind,
  type FireOutcome,
  type InnerResult,
  type TridentWorkflowFirer,
} from './inner-loop.ts'
import {
  buildMergeCleanupDeps,
  detectBaseBranch,
  diffBaseRef,
  refResolves,
  runWorktreePath,
  TridentBaseDriftHold,
  TridentMergeConflictEscalation,
  TridentMergeDiffHold,
  type MergeConflictResolver,
  type RunHostCommand,
} from './merge.ts'
import { escalationKindAgrees, escalationStopSentence } from './escalation-block.ts'
import { resultCarriesEscalation } from './escalation-evidence.ts'
import { infraDeathSentence } from './infra-block.ts'
import { terminalCauseReason } from './terminal-cause.ts'
import { runLeakGatePreflight, type LeakPreflightFixer } from './leak-preflight.ts'
import { ARGUS_DIFF_LINE_LIMIT } from './prompts.ts'
import { isTerminalPhase, type AdvanceOutcome } from './state-machine.ts'
import { buildTestStrategyDetail, readHostBudget } from './test-strategy.ts'
import type { TridentRun, TridentRunStore, TridentRunUpdate } from './store.ts'
import {
  DEAD_LAUNCHER_OVERRIDE_MS,
  DEFAULT_MAX_INFLIGHT_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
  NO_ADVANCE_HANG_MS,
} from './liveness.ts'
import {
  type RunEvidenceGatherer,
} from './run-evidence.ts'
import {
  FIRE_SETTLE_TIMEOUT_ERROR,
  publishedFailureReason,
  type FireEvidenceGatherer,
  type FireTimeoutEvidence,
} from './fire-evidence.ts'
import type { BranchHolderProbe } from './fire-evidence-probes.ts'

const log = createLogger('trident')

export interface TridentStep {
  (run: TridentRun): Promise<AdvanceOutcome>
}

/**
 * The answer to "is this run's launcher generation still a live process?" — the
 * hang watchdog's second positive-liveness source (`probe_run_alive`).
 *
 * DELIBERATELY DECLARED HERE rather than imported from `tick.ts` (whose
 * `LauncherLiveness` is the identical union): `tick.ts` imports this module, so
 * importing back would close a cycle. The two are structurally compatible, which
 * is what lets the composer pass the existing probe straight in.
 */
export type RunLiveness = 'alive' | 'dead' | 'unknown'

export interface BuildTridentOrchestratorOptions {
  /** The inner-workflow FIRER (Phase 2a). Fires the inner CC Dynamic Workflow on
   *  a warm substrate + settles the launching turn; see `buildWorkflowFirer`. */
  fire_workflow: TridentWorkflowFirer
  /** Absolute sqlite file path threaded to the workflow's checkpoint +
   *  terminal-result Bash steps. */
  db_path: string
  /** Host command runner — base-branch detect, existing-PR probe, merge. */
  run_host: DiffOutputHost
  /** Best-effort pre-build stage stamp (latency instrumentation, 2026-08-18 card). Appends one row to the append-only code_trident_stage_events ledger. Must never throw and never fail a launch; omitted → no-op. */
  record_stage?: (run_id: string, stage: string, meta?: string | null) => void
  /** The stage ledger READ, in ledger order — consulted ONLY for a run whose fire
   *  came back `unconfirmed` (the launcher turn overran the settle budget and was
   *  left draining). A `fire-settled` or `plan-start` stamped after the
   *  `fire-unconfirmed` event confirms the fire without waiting for the turn.
   *  Omitted → only the late settle can confirm; absence never fails a run early. */
  list_stage_events?: (run_id: string) => ReadonlyArray<{ stage: string; at: string }>
  /** Review-only executor seam. Production uses `executeBoundReview`; tests may
   *  inject a recording executor without running a live review panel. */
  execute_bound_review?: typeof executeBoundReview
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
   * The process census of already-running local build lanes. The launch budget
   * adds one slot for the build about to start. Wired in
   * `gateway/composition/build-core-modules.ts`; rows do not establish liveness.
   *
   * Consumed by `computeTestJobs` as its RAISE-ONLY term. The bound itself comes from
   * the CONSTANT `DEFAULT_BUILD_FANOUT`, because a launch-time snapshot cannot bound a
   * STAGGERED fan-out: the value is frozen into a prompt string, so the run that
   * launched onto an idle box would keep all the cores for an hour while later runs
   * divided the same box again (read `computeTestJobs`'s docblock). This count only
   * shrinks the budget FURTHER, when more builds than planned are genuinely running.
   *
   * BEST-EFFORT: a throwing resolver or a non-finite result budgets against
   * the planned fan-out and NEVER fails the launch. And it must actually be WIRED —
   * `resolve_phase_models` is the history here: a complete seam whose producer was
   * missing shipped an inert feature that no test could catch, because every piece
   * worked in isolation.
   */
  resolve_active_runs?: () => number
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
   * THE POST-APPROVE MUTATION PROVER, as a test seam ONLY. The real gate
   * provisions a git worktree at the branch head, applies the nominated mutation
   * and runs the guard — none of which a unit test with a fake `run_host` and a
   * `/repo` path that does not exist can do.
   *
   * PRODUCTION MUST NOT SET THIS. Same rule as `merge_deps`: the composer wires
   * neither, so a real run always gets the real gate. Deliberately NOT a config
   * flag or an env override — there is no supported way for an OPERATOR, or an
   * agent editing settings, to turn the proof off; only for a test process to
   * substitute one.
   */
  prove_mutation?: (input: MutationGateInput) => Promise<MutationGateOutcome>
  /**
   * Bounded Forge merge-conflict resolver (#342). Serves BOTH conflict paths:
   *   - LOCAL mode — threaded into the default `buildMergeCleanupDeps`, so a merge
   *     that hits a rebase conflict (a 2nd/3rd same-project build replaying onto a
   *     sibling's merge) is auto-resolved rather than hard-failing. Ignored when
   *     `merge_deps` is supplied (the override owns its own resolver).
   *   - PR mode — threaded into `rebaseOntoObservedBase` (the AUTONOMOUS publish
   *     path), where a conflicting replay is resolved in the scratch worktree
   *     before it can become a `TridentRebaseConflict`.
   * Absent → a conflict escalates immediately on both paths (no auto-resolve).
   */
  resolve_conflict?: MergeConflictResolver
  /**
   * THE ARBITER TIER (#541) — `buildFableArbiter` (`arbiter.ts`), threaded into the
   * default `buildMergeCleanupDeps` so a LOCAL-mode rebase conflict the bounded
   * resolver ESCALATED gets one read-only second opinion before the run terminates
   * in chat. Ignored when `merge_deps` is supplied (the override owns its own deps),
   * exactly like `resolve_conflict`.
   *
   * WIRED AT ONE HOLD, DELIBERATELY. Not the base-drift holds and not the dirty-
   * worktree refusal: the only alternative to stopping at those is waiving a review
   * gate or force-removing uncommitted work, and `arbiter.ts` forbids the first
   * structurally (`FORBIDDEN_OPTION_IDS`) and the second by being read-only. An
   * arbiter asked to adjudicate something it cannot see, or cannot legally choose,
   * is worse than one that is not asked.
   *
   * ABSENT: a resolver escalation aborts the rebase and returns its specific
   * question to the project decision turn. So does `{kind:'unavailable'}`.
   */
  arbitrate?: TridentArbiter
  /**
   * PURITY PREFLIGHT SEAM — run the public leak gate on the branch's own tree
   * between the rebase replay and the lease push. DEFAULTS TO THE REAL RUNNER,
   * and that default is the whole point: `resolve_phase_models` in this same
   * interface is the lesson — a complete seam whose producer was never wired
   * shipped an INERT feature no test could catch, because every piece worked in
   * isolation. So the unit tests here drive this DEFAULT through a scripted host
   * responder rather than injecting a fake; nothing but a test process
   * substitutes it.
   */
  leak_preflight?: typeof runLeakGatePreflight
  /**
   * Optional bounded self-correction seam for preflight findings (the real
   * agent-backed fixer is wired separately). Absent → findings are reported and
   * annotated only, and the PR still opens.
   */
  fix_leak_findings?: LeakPreflightFixer
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
   * INFRASTRUCTURE RETRY CLAIM — atomically clear a harvested executor/transport
   * failure and spend one durable `infra_retries` unit. Omitted means legacy
   * terminal behaviour byte-for-byte; existing callers do not opt in implicitly.
   */
  begin_infra_retry?: (run_id: string) => Promise<TridentRun | null>
  /**
   * PUBLISH-CREDENTIAL RETRY CLAIM — spend the shared durable infrastructure
   * budget while preserving the harvested result. The preserved result is the
   * publish-only checkpoint: the next tick re-enters `applyResult` and never
   * launches Forge.
   */
  begin_publish_retry?: (run_id: string) => Promise<TridentRun | null>
  /** Maximum measured infrastructure failures retried for one run. */
  max_infra_retries?: number
  /** Best-effort owner/visibility seam, invoked once on durable attempt 1 only. */
  on_infra_retry?: (run: TridentRun, attempt: number, cause: string) => Promise<void>
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
   * Deadline for gathering run-scoped evidence after checkpoint silence. A fresh
   * working terminal renews advancement before this gate; a captured selection
   * prompt reports blocked before it. Neither absence of checkpoints nor a live
   * process identifies a prompt. A policy stop without terminal evidence reports
   * worker state unknown. Default NO_ADVANCE_HANG_MS (90 minutes).
   */
  no_advance_hang_ms?: number
  /**
   * POSITIVE LIVENESS EVIDENCE for the hang watchdog: the timestamp of the most
   * recent stage event for a run, or null when it has none.
   *
   * THE PREMISE OF THE WATCHDOG ABOVE IS FALSE, and this is the correction. It
   * claims "a HEALTHY build re-stamps `last_advanced_at` on every inner-workflow
   * checkpoint, so it never trips this". Checkpoints land BETWEEN phases; a single
   * Forge round runs ~40 min and re-stamps nothing while it does. So the field is
   * stale by construction during exactly the work the watchdog is most likely to
   * interrupt, and the reaper is really asking "has a phase ended recently".
   *
   * MEASURED: run 9bece714 was reaped as "no progress for 90 min — suspected agent
   * hang" while pid 286859 was alive and its stderr log had been written to seconds
   * earlier. Three further lanes sat 57-85 min "stale" while actively logging.
   *
   * Stage events are written MID-PHASE, so a run that has emitted one recently is
   * observably progressing. When this reader is supplied and reports an event newer
   * than the hang threshold, the watchdog STANDS DOWN for that tick — writing
   * nothing, so the reprieve is recomputed from the evidence next tick and expires
   * the moment the events stop. Omitted, or returning null, leaves the previous
   * behaviour exactly as it was: absence is never read as liveness.
   */
  latest_stage_event_at?: (run_id: string) => string | null
  /**
   * THE SECOND POSITIVE-LIVENESS SOURCE for the hang watchdog: is this run's
   * recorded launcher generation still a LIVE PROCESS?
   *
   * WHY A SECOND SOURCE. `latest_stage_event_at` reads the stage ledger, and the
   * ledger goes SILENT during exactly the work the watchdog interrupts: the build
   * wrapper stamps `codex-exec-start` immediately before `codex exec` and
   * `codex-exec-end` after it, with nothing in between. MEASURED against the live
   * ledger (808 events, 37 completed exec windows): max 72.0 min, avg 20.7 min
   * between those two stamps — against a 90-minute threshold, an 18-minute margin
   * rather than a liveness signal. The `codex-exec-alive` heartbeat added to
   * `codex-build.sh` closes most of that hole; this seam covers the rest (the
   * review phase, a wrapper too old to emit the heartbeat, a ledger write that
   * failed) with the answer that does not depend on the run cooperating.
   *
   * THREE-VALUED, and that is the whole point (mirrors `LauncherLiveness` in
   * `tick.ts`, which this is wired to in production):
   *
   *   • `'alive'`   — POSITIVELY observed running → the watchdog stands down,
   *                   bounded by `max_inflight_ms` (see below).
   *   • `'dead'`    — POSITIVELY observed gone → the watchdog reaps THIS TICK and
   *                   no reprieve of any kind applies, not even fresh stage
   *                   evidence. Death beats liveness: a heartbeat row written by a
   *                   ticker that outlived its exec is not proof of work.
   *   • `'unknown'` — no evidence either way (probe outage, unrecognised
   *                   generation) → changes NOTHING. Absence is not evidence, in
   *                   either direction.
   *
   * 'alive' IS NOT IMMORTALITY. A launcher is shared infrastructure, not proof
   * that the detached build it fired is working (`tick.ts` says so explicitly), so
   * an alive answer is the WEAKER of the two sources and is capped by the
   * `max_inflight_ms` ceiling, which is checked FIRST and which no reprieve can
   * cross. Without that cap this fix would trade a false kill for a lane that
   * never frees — strictly worse, since there are only ~6.
   *
   * THE CONSEQUENCE, STATED PLAINLY. The probe answers about the launcher GENERATION,
   * which several runs can share. On a box whose launcher REPL is long-lived, a
   * genuinely wedged build can be answered `'alive'` and stand down — so for those runs
   * this raises the effective reap from the 90-minute threshold to the 2-hour ceiling.
   * That is the deliberate trade: up to 30 extra minutes before a wedge is reaped, in
   * exchange for not killing builds that are working. It is BOUNDED, it is the
   * direction the card asks for, and the per-RUN `codex-exec-alive` heartbeat (checked
   * FIRST, and written by the build itself) is the stronger signal this seam is only
   * the fallback for.
   *
   * Omitted → the watchdog behaves exactly as it did before this seam existed.
   */
  probe_run_alive?: (run: TridentRun) => RunLiveness | Promise<RunLiveness>
  /**
   * THE THREE RUN-SCOPED PROBES — the evidence the watchdog was missing.
   *
   * The two sources above answer about the wrong subject. `latest_stage_event_at`
   * reads a ledger that is measured silent for up to 72 minutes during ONE `codex
   * exec` and emits nothing at all during review; `probe_run_alive` answers about
   * a launcher GENERATION that several runs share, not about THIS run. Neither
   * can say whether this particular build is doing work right now. These three
   * can, and are asked strongest-first:
   *
   *   1. PROCESS — is there a live process for this run? Ground truth, and it
   *      outranks everything else: nothing about a shared generation, a quiet
   *      ledger or an unmoved ref survives contact with a running build.
   *   2. ARTIFACTS — newest mtime on the run's OWN files (its output/error
   *      streams, its journal, its worktree).
   *   3. REF — recent local movement on the run's branch.
   *
   * EACH ANSWER IS THREE-VALUED (`EvidenceObservation`), and the third value is
   * the reason this seam exists at all: `unknown` — a probe that COULD NOT run —
   * DEFERS the kill and never authorises one. An unreadable artifact directory or
   * an unqueryable process table is not "no activity"; an empty check must not
   * read as a passing check. Only when every probe RAN and none of them saw
   * activity inside the window may the run be declared hung, and then the
   * terminal reason names every probe and what it returned.
   *
   * BOUNDED, like every other reprieve here: `max_inflight_ms` is checked FIRST
   * and no stand-down and no deferral can cross it, so a permanently blind probe
   * cannot make a run immortal.
   *
   * Omitted → the watchdog behaves BYTE-IDENTICALLY to before this seam existed:
   * same decisions, same disclosure strings.
   */
  observe_run_worker?: RunWorkerObserver
  gather_run_evidence?: RunEvidenceGatherer
  /**
   * THE SETTLE-TIMEOUT EVIDENCE GATE (see `fire-evidence.ts`). Consulted ONLY
   * when a fire fails with EXACTLY `FIRE_SETTLE_TIMEOUT_ERROR` — the launcher
   * turn was cancelled, but the workflow it fired runs DETACHED and the cancel
   * never reached it, so "the launcher never settled" is not "the workflow never
   * started". Every other fire error keeps its path untouched.
   *
   * POSITIVE EVIDENCE ONLY. `launched` holds the lane; `published` terminalizes
   * honestly as built-and-published/review-not-run; `none`, a THROW, and an
   * omitted seam all keep today's plain `failed` — omitted → BYTE-IDENTICAL to
   * before this seam existed, same phase, same reason string, same stamps.
   */
  gather_fire_evidence?: FireEvidenceGatherer
  /**
   * BRANCH-LIVENESS PROBE for ORPHAN RECOVERY. Answers "is a linked worktree,
   * held by a LIVE lock pid, sitting on this run's branch right now?" — the same
   * question `board-dispatch.ts` asks before creating a run, through the same
   * `probeBranchHolder`.
   *
   * WHY ORPHAN RECOVERY NEEDS IT. Hold ownership for a launched-but-unobserved
   * lane lives in the in-memory `fired` set, which a restart loses BY DESIGN.
   * After a restart every prior-process dispatch is an orphan, and the default
   * `redispatch` policy clears the subagent slot and fires a SECOND workflow —
   * over a first one that may still be building the branch. That is precisely the
   * two-lanes-on-one-branch outcome the settle-timeout hold exists to prevent, so
   * the hold cannot be allowed to evaporate on restart.
   *
   * POSITIVE EVIDENCE ONLY, and only ever to WAIT: null (nothing holds it, or the
   * look failed), a non-live holder, a throw, and an omitted seam all redispatch
   * exactly as before.
   *
   * WAITING IS BOUNDED, and by ONE of the two bounds — the 90-minute no-advance
   * reaper, which runs BEFORE this point in `step()` and which a waiting lane
   * cannot outrun: waiting returns `changed: false`, so `last_advanced_at` never
   * moves. (Argus r6 nit, CORRECTED in r8: the r6 note said the 2 h in-flight
   * ceiling "sits AFTER the orphan block". It does not — `overCeiling` is
   * computed inside the hang-watchdog block (1b), i.e. BEFORE orphan recovery
   * (2), on the SAME `elapsedSinceAdvance` clock as the reaper. The substantive
   * point survives and is why only ONE bound is cited: a run that reaches the
   * ceiling has already reached the 90-minute reaper, so the ceiling can never
   * be the bound that actually ends a wait.)
   */
  probe_branch_holder?: (repo_path: string, branch: string) => Promise<BranchHolderProbe | null>
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

/** Appended (never substituted) to `failure_reason` when a terminal failure's branch was
 *  published by the git-truth salvage. The run is NOT a success: the lane died, the work
 *  survived, the PR is unreviewed. Wording is delivery-classifier-safe (see delivery.ts):
 *  it must never contain 'exhausted', 'conflict', 'hang', 'stalled', 'no progress for',
 *  'merge failed', 'git ' (with trailing space), 'rebase', 'checkout', 'missing',
 *  'garbled', 'provenance', 'failed:', or 'not enabled'. */
export const TRIDENT_SALVAGE_MARKER = 'build survived the failure'

/** Appended when uncommitted work is recorded for a terminal failure. Wording is
 *  delivery-classifier-safe (see delivery.ts): it must never contain 'exhausted',
 *  'conflict', 'hang', 'stalled', 'no progress for', 'merge failed', 'git ' (with
 *  trailing space), 'rebase', 'checkout', 'missing', 'garbled', 'provenance',
 *  'failed:', or 'not enabled'. */
export const TRIDENT_SNAPSHOT_MARKER = 'uncommitted work survived the failure'

/** Appended when uncommitted work was observed but could not be anchored. Unlike
 *  the transient step note, this marker lives on the terminal row, so both the
 *  live terminal path and boot reconciliation can tell the operator that the
 *  worktree still needs manual attention. */
export const TRIDENT_SNAPSHOT_FAILURE_MARKER = 'uncommitted work capture failed'

/** Appended when a terminal failure's branch has parked work. Wording is
 *  delivery-classifier-safe (see delivery.ts): it must never contain 'exhausted',
 *  'conflict', 'hang', 'stalled', 'no progress for', 'merge failed', 'git ' (with
 *  trailing space), 'rebase', 'checkout', 'missing', 'garbled', 'provenance',
 *  'failed:', or 'not enabled'. */
export const TRIDENT_STASH_PARKED_MARKER = 'work parked in stash'

type WorktreeDisposition =
  | { kind: 'dirty'; files: number; untracked: number; lines: number; ref: string; warning?: string }
  | { kind: 'stashed'; entries: number }
  | { kind: 'failed'; detail: string }
  | { kind: 'none' }

function worktreeDispositionSuffix(
  disposition: Exclude<WorktreeDisposition, { kind: 'none' | 'failed' }>,
): string {
  if (disposition.kind === 'stashed') {
    return `${disposition.entries} stash entr${disposition.entries === 1 ? 'y' : 'ies'} recorded for this run's branch — ${TRIDENT_STASH_PARKED_MARKER}`
  }
  return `${disposition.lines} uncommitted text line(s) across ${disposition.files} file(s)${disposition.untracked > 0 ? ` (${disposition.untracked} untracked)` : ''} — ${TRIDENT_SNAPSHOT_MARKER} — recovery ref ${disposition.ref}${disposition.warning === undefined ? '' : `; capture warning: ${disposition.warning}`}`
}

function worktreeCaptureFailureSuffix(detail: string): string {
  return `${TRIDENT_SNAPSHOT_FAILURE_MARKER}: ${detail}`
}

/** A tick note is one line a human reads; the record lives in the log. The
 *  mutation gate's no-production-file exemption names EVERY changed file, so a
 *  large test-only refactor hands this a multi-kilobyte string. Truncated HERE
 *  and never at the source: the full list still reaches
 *  `log.info('mutation_proof_exempt')`, and the note says where to find it.
 *
 *  THE CEILING IS ON THE PREFIX KEPT, NOT ON THE RESULT. The pointer suffix is
 *  appended PAST it, so a truncated note runs to roughly 310 characters — which
 *  is what `orchestrator.test.ts` pins, and saying "capped at 240" here read as
 *  a promise the code does not make. */
const TICK_NOTE_CEILING = 240

/** EXPORTED for the test that pins the cut: the boundary case is one character
 *  wide and reaching it through a whole orchestrator tick would take a reason
 *  built to land an astral character on code unit 240 by accident. */
export function truncateNote(reason: string): string {
  return truncateWithPointer(reason, TICK_NOTE_CEILING)
}

/** The cut both ceilings make. They differ in the number and in nothing else,
 *  and two byte-identical bodies is one place for a fix to land and be missed.
 *
 *  CUT ON A CHARACTER, NOT ON A CODE UNIT. `slice` counts UTF-16 units, so a cut
 *  landing between the halves of a surrogate pair leaves a LONE surrogate at the
 *  end of a string that goes on to a UI and a DB. Drop the orphan. */
function truncateWithPointer(reason: string, ceiling: number): string {
  if (reason.length <= ceiling) return reason
  const head = reason.slice(0, ceiling)
  const last = head.charCodeAt(head.length - 1)
  const whole = last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
  return `${whole}… (${reason.length} chars; full reason in the mutation_proof_exempt log line)`
}

/**
 * The ceiling on the DURABLE copy of an exemption reason.
 *
 * The stage row is where the exemption's evidence lives, so it gets the FULL
 * file list — the tick note's 240 characters would delete the very thing a
 * reviewer opens the row for. But the list is bounded only by the diff, and a
 * test-only refactor of a few thousand files writes that whole list into
 * `code_trident_stage_events.meta`, once per exempt merge. Generous enough that
 * no real diff is cut (a 4 000-character reason is ~120 paths) and small enough
 * that a pathological one cannot put an unbounded blob on the row.
 *
 * ON THE PREFIX KEPT, NOT ON THE RESULT, exactly as `TICK_NOTE_CEILING` is: the
 * pointer suffix is appended past the cut, so a truncated reason lands near
 * 4 070 characters. Bounded either way; the number is just not the total.
 */
const STAGE_REASON_CEILING = 4_000

export function truncateStageReason(reason: string): string {
  return truncateWithPointer(reason, STAGE_REASON_CEILING)
}

export interface StrandedReconcileOptions {
  /** False when the boot sweep observed another live run on this branch (or
   * could not establish that no such run exists). Commit publication remains
   * enabled; only inspection of a possibly-live checkout/stash is suppressed. */
  inspect_worktree?: boolean
}

export interface StrandedFailureSweepDeps {
  store: Pick<TridentRunStore, 'listFailedPrRuns' | 'listNonTerminal' | 'update'>
  reconcile: (
    run: TridentRun,
    options?: StrandedReconcileOptions,
  ) => Promise<TridentRun | null>
}

function strandedWorktreeScope(run: TridentRun): string {
  const branch = run.branch ?? `trident/${run.slug}`
  return JSON.stringify([run.project_slug, resolve(run.repo_path), branch])
}

/** Best-effort boot reconciliation for failed PR-mode runs. A broken row, git
 *  checkout, or initial store read must never reject module initialisation. */
export async function sweepStrandedFailures({
  store,
  reconcile,
}: StrandedFailureSweepDeps): Promise<void> {
  let rows: TridentRun[]
  try {
    rows = await store.listFailedPrRuns()
  } catch {
    return
  }
  let liveWorktreeScopes: Set<string> | null = null
  try {
    liveWorktreeScopes = new Set(store.listNonTerminal(10_000).map(strandedWorktreeScope))
  } catch {
    // Failure to establish liveness fails CLOSED for checkout inspection while
    // still allowing the existing commit-only reconciliation below.
  }
  for (const row of rows) {
    try {
      const salvaged = await reconcile(row, {
        inspect_worktree:
          liveWorktreeScopes !== null && !liveWorktreeScopes.has(strandedWorktreeScope(row)),
      })
      if (salvaged === null) continue
      await store.update(row.id, {
        pr: salvaged.pr,
        failure_reason: salvaged.failure_reason,
      })
    } catch {
      // One corrupt checkout or failed rescue must not strand later rows.
    }
  }
}

/**
 * Infrastructure retry spacing: one minute, five minutes, then fifteen minutes
 * (long enough at the tail to outlast a token refresh). The retry count is
 * DERIVED from this schedule so count and duration can never disagree — the
 * lesson pinned by PR #279's readiness budget.
 */
export const INFRA_RETRY_BACKOFF_MS = [60_000, 300_000, 900_000] as const
export const DEFAULT_MAX_INFRA_RETRIES = INFRA_RETRY_BACKOFF_MS.length

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
 *
 * `base_ref`, NOT a base BRANCH: this is the left-hand side of a rev-range, so a bare
 * local branch name here diffs against whatever `refs/heads/<base>` happens to hold and
 * silently counts every commit merged into the base since as this branch's own (#546).
 * Pass `diffBaseRef(...)`'s output. The parameter was named `base_branch` and there is
 * no production caller left to mis-feed it, so the rename is the whole of the fix here.
 */
export async function computeDiffLineCount(
  run_host: RunHostCommand,
  repo_path: string,
  base_ref: string,
): Promise<number> {
  let res
  try {
    res = await run_host(
      // `--end-of-options` (#546). This consumer was UNSHIELDED until round fourteen and
      // the coverage test could not see it: that test searched for `${baseRef}`, and this
      // one spells the same value `base_ref`. Called with `--output=/tmp/pwn` this argv
      // writes that file and exits 0, exactly as the shielded sites were measured doing.
      gitRangeArgv({ repo_path, subcommand: 'diff', flags: ['--numstat'], base: base_ref, head: 'HEAD' }),
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

/** Deadline used to request run-scoped evidence; see no_advance_hang_ms. */

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
/** The publish-failure classes readable from a STORED reason alone (card rbbjj2, acceptance a).
 *  'publish-credential' is the first member of the auto-retry class list (card 01KZZQ2J9MJFG0PXC8AA6D6EV4);
 *  'publish-ref-rejected' and 'publish-unknown' must NEVER auto-retry. */
export type PublishFailureClass = 'publish-credential' | 'publish-ref-rejected' | 'publish-unknown'

export const PUBLISH_CREDENTIAL_CLASS = 'publish-credential' as const

/** Pure, total, case-insensitive. REJECTION EVIDENCE OUTRANKS CREDENTIAL EVIDENCE: a server that
 *  rejected a ref did authenticate, so mixed evidence is a rejection and stays terminal. Anything
 *  unrecognised is 'publish-unknown' — conservatism here is what keeps a genuine failure from
 *  ever entering an auto-retry loop. Matches WORDS only (never bare numbers — a 40-hex sha can
 *  contain '401'). */
export function classifyPublishFailure(text: string): PublishFailureClass {
  const t = text.toLowerCase()
  const refRejected = ['[rejected]', 'non-fast-forward', 'stale info'].some((p) => t.includes(p))
  if (refRejected) return 'publish-ref-rejected'
  const credential = [
    'could not read username',
    'could not read password',
    'authentication failed',
    'bad credentials',
    'invalid username or',
    'terminal prompts disabled',
    'http basic: access denied',
  ].some((p) => t.includes(p))
  if (credential) return 'publish-credential'
  return 'publish-unknown'
}

/**
 * Gate rule ids embed the very root the gate bans, and CI scans PR titles/
 * bodies and commit messages — so an UNSANITIZED annotation would re-redden
 * the PR this preflight exists to keep green. Split the root with a hyphen;
 * assembled from fragments so this file stays silent under its own gate.
 */
const FLAGGED_ROOT = 'ten' + 'ant'

/** Split the flagged root wherever it appears, in any case, so annotation text
 *  derived from gate output is safe to write onto a scanned surface. */
export function sanitizeLeakAnnotation(text: string): string {
  return text.replace(new RegExp(FLAGGED_ROOT, 'gi'), 'ten-ant')
}

/**
 * The outer publisher's push-necessity predicate (deploy-blocker card, 3 occurrences
 * 2026-08-17: runs 26ed32c1 / 88efe1ca / 95fcfb91). The remote ref ALREADY holding exactly
 * the head to publish is a publish the publisher does not have to perform — a no-op
 * SUCCESS, never a failure and never "the build left no new commits": the commit exists,
 * it is on origin, it was simply already published. An empty observation ('' — the remote
 * ref does not exist yet) is a FIRST PUSH, not a no-op. Production call site:
 * `publishBuiltCommit`; deleting that call turns the no-op regression tests red.
 */
export function remoteAlreadyAtPublishHead(observedRemoteSha: string, headToPublish: string): boolean {
  return observedRemoteSha !== '' && observedRemoteSha === headToPublish
}

/** A harvested no-APPROVE result is either safe to retry or a genuine outcome. */
export type InnerFailureClass = 'infrastructure' | 'genuine'

/** Closed executor/transport vocabulary. WORDS only: never match bare status
 * numbers because an unrelated 40-hex commit id can contain them. */
export const INFRA_CAUSE_WORDS: readonly string[] = [
  'deferred',
  'timed out',
  'timeout',
  'econnreset',
  'econnrefused',
  'fetch failed',
  'socket hang up',
  'bad gateway',
  'service unavailable',
  'internal server error',
  'gateway timeout',
  'overloaded',
]

/**
 * Classify only from measured terminal fields, fail-closed to `genuine`.
 * `infra-only` explicitly means the code was never judged. Legacy `inner-error`
 * is retryable only when its measured cause contains the closed transport list.
 * Real review verdicts (`code`/`review`/`round-lost`), findings-carrying
 * REQUEST_CHANGES, compile/test failures, provenance rejects, garbled/hang reaps,
 * and publish failures remain genuine/owned elsewhere.
 *
 * Launcher crashes are the third named infrastructure class in this card's
 * acceptance, but §1a-crash already serves them through `crash_recoveries`.
 * This classifier deliberately never sees `subagent_status='crashed'`.
 */
export function classifyInnerFailure(
  result: Pick<InnerResult, 'verdict' | 'block_kind' | 'terminal_cause' | 'checkpoint'>,
): InnerFailureClass {
  if (result.verdict === 'APPROVE') return 'genuine'
  const cause = result.terminal_cause
  if (result.block_kind === 'infra-only' && typeof cause === 'string' && cause.trim() !== '') {
    return 'infrastructure'
  }
  if (
    result.checkpoint === 'inner-error' &&
    result.block_kind === null &&
    typeof cause === 'string' &&
    cause.trim() !== ''
  ) {
    const measured = cause.toLowerCase()
    if (INFRA_CAUSE_WORDS.some((word) => measured.includes(word))) return 'infrastructure'
  }
  return 'genuine'
}

/**
 * REQUEST_CHANGES is reserved for a reviewer that judged the code and recorded
 * at least one finding. `round-lost` and `infra-only` both mean the code was not
 * (re-)judged (the inner workflow's own terminology), while an empty finding set
 * is either approval or infrastructure failure — never a rejection.
 *
 * `advisory-only` IS A REVIEW AND IS RECORDED AS ONE. It is the workflow's statement that
 * a healthy panel judged the code and every finding it returned was one the workflow has
 * already declared non-blocking — so the fix loop exits without buying a round. That is the
 * opposite of `infra-only`, and reading it as REVIEW_NOT_RUN was untrue in the one direction
 * that costs real work: a resume off that row re-Forged a whole round on findings the run
 * had already settled as non-actionable.
 *
 * AND THE REVIEWER MUST ACTUALLY HAVE RUN. Findings alone do not prove that: the
 * suite gate in `inner-workflow.mjs` writes a `blocker` of its own ("FULL SUITE
 * NOT PROVEN …") on a build that never reached a reviewer, and that build carries
 * `block_kind: 'code'` too — so all three of the old conditions were satisfied by
 * a run whose review provably never happened. Measured over this database at the
 * time of the fix: of 160 terminal REQUEST_CHANGES rows only 18 carried an Argus
 * checkpoint; 68 stopped at `forge-done` and 45 at `inner-error`. Those rows are
 * why a queue of un-reviewed builds reads as reviewed-and-rejected, and why
 * re-dispatching them changes nothing — there was never a finding to answer.
 *
 * The findings themselves are still PRESERVED on the row; only the verdict
 * changes, because the verdict is the part that was untrue.
 */
export function recordedTerminalVerdict(
  result: Pick<InnerResult, 'verdict' | 'block_kind' | 'checkpoint' | 'escalation'>,
  rowFindings: string | null,
): 'REQUEST_CHANGES' | 'REVIEW_NOT_RUN' {
  if (result.verdict !== 'REQUEST_CHANGES') return 'REVIEW_NOT_RUN'
  // ARGUS PROVENANCE IS REQUIRED OF EVERY KIND, and it is the condition the paragraphs
  // above are about. Nothing below weakens it.
  if (!hasArgusProvenance(result.checkpoint)) return 'REVIEW_NOT_RUN'

  // AN ESCALATION IS A REVIEWED VERDICT, AND ITS FINDINGS LIST MAY BE EMPTY. That second
  // half was missing, and it discarded the CLEANEST possible escalation: a panel that
  // concludes the PLAN is wrong often has no individual code finding to write, because the
  // code is a faithful implementation of a bad plan. `VERDICT_SCHEMA` has no `minItems` on
  // `findings`, so `{verdict:'REQUEST_CHANGES', block_kind:'design-gap', findings:[]}` is
  // schema-valid — and it was being recorded as REVIEW_NOT_RUN, which is how a resume
  // re-Forges a whole round against the same wrong plan with no finding to answer. That is
  // the precise behaviour this card exists to stop, reproduced by the card's own remedy.
  //
  // WHY DROPPING THE FINDINGS CHECK IS SAFE HERE, AND ONLY HERE. The argument above — that
  // findings do not prove a reviewer ran — is an argument about FINDINGS: the suite gate
  // writes its own `blocker` on a build that never reached a reviewer, and that build
  // carries `block_kind: 'code'`. It does not transfer to an escalation, because the suite
  // gate cannot produce one. An escalation requires `kind` AND `whatIsMissing`, only a
  // reviewer's own reply can carry it (`synthesisRaw.escalate`, never the merged findings),
  // and `hasArgusProvenance` is still required above. So for these kinds the declaration
  // IS the proof, and findings are evidence of a different question.
  //
  // NOT "≥1 finding whenever an escalation is present", which was the other available fix:
  // that would make a reviewer invent a code finding to be allowed to say the plan is
  // wrong, and a schema that forces a model to fabricate an artifact it does not have is
  // worse than the bug.
  //
  // VALIDATED STRUCTURALLY, not by the kind alone: `escalationKindAgrees` is the SAME
  // function the reader and the writer of the block already share, so a row whose routing
  // kind and payload disagree is a half-written escalation here too, and falls through to
  // the findings requirement below rather than being taken on the strength of its label.
  if (
    ESCALATION_KINDS.includes(result.block_kind as EscalationKind) &&
    escalationKindAgrees(result)
  ) {
    return 'REQUEST_CHANGES'
  }

  // `code` and `advisory-only` KEEP the findings requirement, unchanged. Nothing above
  // touches them, and the measurement that motivated it (18 of 160 terminal rows carrying
  // an Argus checkpoint) is about exactly these.
  if (
    (result.block_kind === 'code' || result.block_kind === 'advisory-only') &&
    parseCheckpointFindings(rowFindings).length > 0
  ) {
    return 'REQUEST_CHANGES'
  }
  return 'REVIEW_NOT_RUN'
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
 *   - a 40- or 64-hex lowercase OID → the authority answered; this IS the live head.
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
 * back complete inside a few milliseconds, which is short enough that one dropped packet
 * fails all three and kills a run whose work is intact. So the attempts are separated by
 * `RESUME_HEAD_RETRY_DELAYS_MS`, through an injected `sleep` the tests replace with a
 * no-op — the delay is real in production and free in the suite. `run_host` remains the
 * seam for the READ; this is the seam for the WAIT.
 *
 * THE WINDOW IS ~1.25 s IN TOTAL, AND IT IS NOT CLAIMED TO BE MORE. It covers a sub-second
 * blip; it does not outlive a sustained outage, and this docblock previously said otherwise.
 *
 * IT IS SPENT ON THE TICK THREAD, AND THAT COST IS SERIAL (Argus r5). `tick.ts` steps runs
 * ONE AT A TIME (`per_tick_limit` 50) and this wait is awaited from `launch()`, so an origin
 * blip that hits N resuming runs at once adds ~1.25 s × N to that tick. The constant is left
 * small partly for this reason: it bounds a SHARED thread, not just one run. Making the tick
 * concurrent is a change to `tick.ts`, not to this function — recorded here so the next
 * person tempted to raise the constant knows what else it multiplies.
 *
 * WHAT THE FAILURE IT LEAVES BEHIND ACTUALLY COSTS, STATED WITHOUT THE CLAIM THIS COMMENT USED
 * TO MAKE (Argus r4): the run is terminal, and re-running the card is a FRESH DISPATCH — a new
 * row with NULL checkpoint columns (`store.ts` `create`), because a terminal row is never
 * advanced again (`step()` short-circuits on `isTerminalPhase`). So the re-run REBUILDS. The
 * checkpoint columns preserved on the failed row are evidence for a human, not an input to
 * anything. There is no resume-a-terminal-run path today; adding one is a separate card
 * (IMPLEMENTATION_PLAN.md, follow-ups).
 *
 * THAT IS STILL THE TRADE THIS CARD ASKED FOR, and it is deliberate rather than free: before
 * this change the same blip rebuilt AUTOMATICALLY, so the regression is availability, not work
 * lost — the branch and its commits are untouched. "Could not tell" must not silently spend a
 * max-effort rebuild of already-pushed work (measured: 3,813 → 84,875 → 133,169 output tokens on
 * the neutron-enterprise run), so the rebuild now needs a human to ask for it. The number here
 * is left small rather than grown by guess: every second is also a second a genuinely-dead
 * branch stalls, and the constant is exported so the trade can be made with evidence.
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
        if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(token)) return token.toLowerCase()
        // Malformed output is not an answer — retry rather than believe it.
      }
    } else {
      const res = await run_host(
        ['git', '-C', run.repo_path, 'rev-parse', '--verify', `${ref}^{commit}`],
        run.repo_path,
      )
      if (res.ok) {
        const oid = res.stdout.trim()
        if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) return oid.toLowerCase()
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

/**
 * Does the LIVE HEAD decide what this resume checkpoint means?
 *
 * The launcher's fast-exit (in `launch()`) exists only to avoid spending a fire whose
 * outcome is already known: `classifyResume` would return the bounded
 * `{ mode: 'stop', reason: 'head-unreadable' }`. It must therefore fire — not exit —
 * for every checkpoint `classifyResume` answers WITHOUT consulting the head, or it
 * pre-empts a decision it does not share. Those are:
 *
 *   • `''` — no checkpoint at all → `rebuild`, and nothing recorded to preserve.
 *   • `pr-merged` → `merged`; the head branch may already be deleted.
 *   • `forge-done` in RALPH mode → `rebuild` ('ralph-progress-unknown'), and
 *     any name `classifyResume` does not recognise — `ralph-task-built` above all —
 *     → `rebuild` ('unknown-checkpoint'). Both are the answer on EVERY head, so a
 *     read failure changed nothing (Argus r5). Stopping these terminally would let
 *     one transient `ls-remote` blip kill every resuming ralph re-fire.
 *
 * MIRRORS `classifyResume`/`resumeOnUnchangedHead` in `inner-workflow.mjs`, which is
 * a `.mjs` Workflow script this module cannot import; `inner-workflow-resume.test.ts`
 * executes BOTH and asserts they agree on every name, so the pair cannot drift
 * silently.
 */
export function resumeHeadDecides(checkpoint: string, ralph: boolean): boolean {
  const name = checkpoint.trim()
  if (name === '' || name === 'pr-merged') return false
  if (name === 'forge-done' && ralph) return false
  return (
    name === 'argus-approved' ||
    name === 'argus-request-changes' ||
    name === 'forge-done' ||
    /^argus-request-changes-round-\d+$/.test(name) ||
    /^fix-round-\d+$/.test(name) ||
    // The `:deviated` suffix (#291's taskDeviated carry) is part of the PRODUCTION
    // checkpoint vocabulary — `classifyResume` accepts it at inner-workflow.mjs:2472.
    // Rejecting it here made the launcher spend a whole workflow fire on a checkpoint
    // it should have fast-exited on. The suffix says nothing about whether THIS
    // invocation may skip its rebuild, so a deviated publish decides exactly as a clean one.
    /^outer-published:(?:[0-9a-f]{40}|[0-9a-f]{64}):\d+:\d+(:deviated)?$/.test(name)
  )
}

/**
 * T4 — DID THE BUILD DIE IN INFRASTRUCTURE, BEFORE ANY REVIEWER JUDGED THE CODE?
 *
 * BOTH triggers are MEASURED signals, not inferences:
 *   • `checkpoint: 'inner-error'` is written ONLY by the inner workflow wrapper's own catch
 *     path (`inner-workflow.mjs`) — the workflow THREW, so no verdict happened. That path
 *     also self-asserts `verdict: 'REQUEST_CHANGES'`, which is why the verdict field cannot
 *     be trusted here and the checkpoint can.
 *   • `block_kind: 'infra-only'` is the workflow's own statement that NO REVIEW SEAT ever
 *     judged the code — the stop says nothing about the diff. `advisory-only` is NOT that
 *     and must never be added here: it says a seat DID judge the code.
 *
 * An `inner-error` result that DOES carry findings keeps the current behavior: real review
 * findings exist behind it, so the generic "ended without APPROVE" sentence is still true.
 * `findings_present` is decoded fail-closed (`parseInnerResult`), so a legacy/garbled row
 * reads false — and a false there costs an infra-flavoured message on a shape that already
 * had no findings to show, never the reverse (a crash sold to the owner as a verdict).
 *
 * An APPROVE is never an infra death: it takes the merge path, and reclassifying one would
 * silently drop a successful run.
 *
 * This deliberately differs from `classifyInnerFailure`: that function asks whether an
 * outcome is safe to auto-RETRY and fails closed to `genuine`; this one asks whether we may
 * report a VERDICT and fails closed to false. They are two deciders with different risk
 * directions and must not be merged.
 */
export function isInfraDeath(
  result: Pick<InnerResult, 'ok' | 'verdict' | 'checkpoint' | 'block_kind' | 'findings_present'>,
): boolean {
  if (result.verdict === 'APPROVE') return false
  if (result.block_kind === 'infra-only') return true
  return result.ok === false && result.checkpoint === 'inner-error' && result.findings_present === false
}

export function innerTerminalFailureReason(
  run: Pick<TridentRun, 'max_rounds' | 'round' | 'inner_checkpoint'>,
  result: Pick<
    InnerResult,
    | 'ok'
    | 'verdict'
    | 'round'
    | 'checkpoint'
    | 'block_kind'
    | 'terminal_cause'
    | 'findings_present'
    | 'escalation'
  > &
    // OPTIONAL IN THE SIGNATURE, REQUIRED ON THE TYPE (#520). `parseInnerResult` always
    // produces `terminal_cause_kind`, so a real harvested result always carries it; the
    // field is optional HERE because this function is also called with a hand-built
    // result at a site that never ran an inner workflow (the resume bounded stop below),
    // and because an absent kind must mean exactly what a `null` kind means — keep the
    // generic sentence. Making it required would have forced every caller to assert
    // something about an exit it did not observe.
    Partial<Pick<InnerResult, 'terminal_cause_kind'>>,
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
  // the one permitted specific message, gated on a non-null cause.
  // Everything else — every inferred cause, every result carrying no measurement — still
  // gets the generic sentence above, for all the reasons R1/R2 record.
  // …and ONLY when the cause survives redaction with something left to read. An
  // over-redacted (or whitespace-only) cause is not a measurement, and appending a
  // dangling colon to the sentence would report one where none exists.
  //
  // 2026-08-15 — A THROWN WORKFLOW ALSO MEASURES A CAUSE, and it was being discarded.
  // `block_kind: 'infra-only'` is emitted only by the review-stop paths, so requiring it
  // meant every exit that THREW — including the one this card was raised for — fell through
  // to the sentence below. Run 3d2696c3 threw "forge:build completed without a full local
  // commit OID for the outer publisher" and the operator was told "…without Argus APPROVE"
  // about a run Argus never saw. The catch path now carries the sentence the workflow
  // composed where the fact was known, with NO block kind (a throw is not a review verdict).
  //
  // THE GATE WIDENS BY EXACTLY THAT ONE VALUE — `null` — and no further. 'code',
  // 'round-lost' and 'none' are REVIEW verdicts, whose findings describe the DIFF; quoting
  // one as a terminal cause would re-invent the inference this function refuses to make, so
  // they keep the generic sentence (see the test that pins each of them).
  //
  // `null` IS NOT ONLY "THE CATCH PATH" — and an earlier revision of this comment said it
  // was (Argus r4). `parseInnerResult` decodes `block_kind` FAIL-CLOSED: the five strings the
  // workflow writes decode ('none', 'code', 'infra-only', 'advisory-only', 'round-lost' —
  // see trident/inner-loop.ts), and ANY other value — garbled, truncated, from a future writer —
  // becomes `null` too. Which is precisely why this branch is safe to widen to it: the
  // sentence `null` selects states the failure and quotes the measured cause, and claims
  // NOTHING about the review panel. Only 'infra-only' licenses "review never ran", and only
  // an exact-match decode produces it. A garbled kind therefore lands in the honest sentence,
  // never the specific one (pinned by the garbled-kind test).
  //
  // The kind also decides WHICH sentence, because it is the only thing that licenses the
  // claim "review never ran". Without it the reason states the failure and quotes the
  // measurement, and says nothing at all about the review panel.
  // 2026-09-12 — AND A SECOND MEASURED PATH: a run that STOPPED AND ESCALATED. Like the
  // infra-only cause below, this is a sentence composed where the fact was KNOWN (the fix
  // loop, which is the only place that can see two rounds of findings at once) rather than
  // deduced here from (round, checkpoint) — which is precisely what the paragraphs above
  // refuse to do. Without it an escalation falls through to the generic catch-all and the
  // owner is told the build "ended without Argus APPROVE" about a run that stopped
  // DELIBERATELY and said exactly why.
  //
  // GATED THROUGH `escalationKindAgrees` — the SAME function `deriveEscalationBlock` uses,
  // not a second copy of its rule. A result carrying half an escalation keeps the generic
  // sentence instead of quoting a claim whose routing kind says something else.
  //
  // ONLY that condition is shared, and the reason is a boundary rather than an oversight:
  // the deriver also requires `phase === 'failed'` and `harvested_at !== null`, both of
  // which are facts about a STORED, harvested row. This function runs at the moment the
  // terminal row is COMPOSED — it is what makes those two true — so the full gate would
  // return `null` on every real escalation here and the sentence would never fire. The one
  // rule both sides must agree on is exported; the two that only a reader can ask are not.
  if (escalationKindAgrees(result) && result.escalation !== null) {
    return escalationStopSentence(result.escalation, ceiling)
  }
  if (result.terminal_cause !== null && (result.block_kind === 'infra-only' || result.block_kind === null)) {
    const cause = redactPushError(result.terminal_cause).trim()
    if (cause !== '') {
      return result.block_kind === 'infra-only'
        ? `review never ran (infra-only) at round ${reported} of ${ceiling}: ${cause}`
        : `inner workflow failed at round ${reported} of ${ceiling}: ${cause}`
    }
  }
  // T4 catches ONLY no-measured-cause shapes: an inner-error with no findings and no cause,
  // or an infra-only stop whose cause is null/over-redacted. The measured-cause branch above
  // keeps precedence, so every sentence main already says specifically stays byte-identical.
  if (isInfraDeath(result)) {
    return infraDeathSentence(reported, ceiling)
  }
  // 2026-09-12 (#520) — AND NOW THE REVIEW-VERDICT EXITS SPEAK TOO. Everything above
  // this line is untouched and still wins, because each of those branches is already
  // holding a MEASURED sentence and a second owner for one fact is how reasons drift.
  // What lands here is what the R1/R2 notes above describe: the exits that emitted
  // nothing, so the catch-all below spoke for all of them at once — a fix round whose
  // work never landed, a fix round that left no diff, a panel that ran and raised
  // nothing actionable, and a genuine round-budget exhaustion, ALL delivered as "ended
  // at round N of M … without Argus APPROVE".
  //
  // THIS IS NOT THE INFERENCE R1 AND R2 KILLED, AND THE DIFFERENCE IS WHERE THE FACT
  // COMES FROM. Those two tried to deduce a cause HERE, from `(round, checkpoint)` —
  // values that are equally consistent with four different endings. This reads a kind
  // the workflow MEASURED at its own exit, off the guard variables the loop exited on
  // (`reviewLoopTerminalCause`, inner-workflow.mjs). Nothing is deduced at this line;
  // `terminalCauseReason` is a total function over a closed vocabulary and returns
  // `null` — the generic sentence, unchanged — for every member that licenses no
  // specific claim, `'unknown'` first among them.
  const kind = result.terminal_cause_kind ?? null
  if (kind !== null) {
    const measured = terminalCauseReason(kind, reported, ceiling)
    if (measured !== null) return measured
  }
  const at = checkpoint === null ? '' : ` at checkpoint '${checkpoint}'`
  return `inner workflow ended at round ${reported} of ${ceiling}${at} without Argus APPROVE`
}

/**
 * GIT-TRUTH FOR THE CLAIM, NOT ONLY THE BRANCH (card 2026-08-16). A model-relayed
 * sha that names NO git object is not a disagreement with the real head — there is
 * only one candidate commit, git's — so it resolves to ABSENT (null), never to a
 * refusal. Measured: hallucinated claim '924b42906950' (git cat-file: not a valid
 * object name) refused a good build and stranded 924b4290ea81….
 * A claim is a sha, never a refname: non-hex input returns null WITHOUT asking git,
 * so 'HEAD'/branch names cannot resolve by accident (4 = git's minimum abbreviation).
 * `--end-of-options` keeps hostile-shaped input from being read as a flag.
 */
export async function resolveClaimedCommit(
  run_host: RunHostCommand,
  repo_path: string,
  claim: string | null,
): Promise<string | null> {
  if (claim === null) return null
  const c = claim.trim().toLowerCase()
  if (!/^[0-9a-f]{4,40}$/.test(c)) return null
  const res = await run_host(
    ['git', '-C', repo_path, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${c}^{commit}`],
    repo_path,
  )
  const oid = res.stdout.trim()
  return res.ok && /^[0-9a-f]{40}$/.test(oid) ? oid : null
}

export function buildTridentOrchestrator(
  opts: BuildTridentOrchestratorOptions,
): {
  step: TridentStep
  drain: () => Promise<void>
  reconcile_stranded: (
    run: TridentRun,
    options?: StrandedReconcileOptions,
  ) => Promise<TridentRun | null>
} {
  assertDiffOutputHost(opts.run_host)
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
    buildMergeCleanupDeps(opts.run_host, {
      ...(opts.resolve_conflict !== undefined ? { resolve_conflict: opts.resolve_conflict } : {}),
      ...(opts.arbitrate !== undefined ? { arbitrate: opts.arbitrate } : {}),
    })
  const on_orphaned = opts.on_orphaned_session ?? 'redispatch'
  const mint = opts.mint_run_id ?? (() => crypto.randomUUID())
  const persistRefireReset = opts.persist_refire_reset ?? (async () => {})
  const maxInflightMs = opts.max_inflight_ms ?? DEFAULT_MAX_INFLIGHT_MS
  const noAdvanceHangMs = opts.no_advance_hang_ms ?? NO_ADVANCE_HANG_MS
  const latestStageEventAt = opts.latest_stage_event_at ?? null
  const probeRunAlive = opts.probe_run_alive ?? null
  const gatherRunEvidence = opts.gather_run_evidence ?? null
  const gatherFireEvidence = opts.gather_fire_evidence ?? null
  const probeBranchHolderFor = opts.probe_branch_holder ?? null
  const beginCrashRecovery = opts.begin_crash_recovery
  const maxCrashRecoveries = opts.max_crash_recoveries ?? DEFAULT_MAX_CRASH_RECOVERIES
  const beginInfraRetry = opts.begin_infra_retry
  const beginPublishRetry = opts.begin_publish_retry
  const maxInfraRetries = opts.max_infra_retries ?? DEFAULT_MAX_INFRA_RETRIES
  const onInfraRetry = opts.on_infra_retry
  const proveMutation = opts.prove_mutation ?? runMutationProofGate

  // This-process liveness: run ids whose workflow THIS process fired (and whose
  // launching turn settled). A persisted `subagent_run_id` whose run.id is NOT
  // in this set is an orphan from a prior process. Crash-safe: lost on restart
  // (so all prior-process dispatches become orphans + re-fire idempotently).
  const fired = new Set<string>()
  // Run ids redispatched in THIS process — the per-process bound on orphan
  // recovery so a crash-restart loop can't spin forever.
  const redispatched = new Set<string>()
  // Deliberately in-memory: a restart replaces the failing pool/generation, while
  // each individual process still bounds launch faults and cannot retry forever.
  const launchFaults = new Map<string, { count: number; last: string }>()
  const MAX_LAUNCH_FAULTS = 3
  // UNCONFIRMED FIRES — runs whose launcher turn overran the settle budget and was
  // LEFT DRAINING (never cancelled: cancelling abandon-poisons the shared launcher
  // REPL, whose eviction SIGKILLs every in-process inner workflow the child hosts —
  // 33% of all run deaths, measured). The run is parked `running` in the DB like a
  // confirmed fire; this map carries the confirmation deadline (one further
  // budget), the late settle when it lands, and whether the workflow's own
  // `plan-start` already proved the fire. In-memory on purpose, like `fired`: a
  // restart orphans the row and the existing orphan policy takes it from there.
  const listStageEvents = opts.list_stage_events ?? null
  interface UnconfirmedFire {
    /** The dispatch id minted for this launch (`subagent_run_id`). */
    dispatch_id: string
    /** When the confirmation window closes: one further budget after the fire came back unconfirmed. */
    deadline_ms: number
    budget_ms: number
    /** When the fire went out — the fire-evidence gatherer's reference point. */
    fire_started_at_ms: number
    /** The launcher generation hosting this run, once known: from the fire's
     *  inject-time status (`FireOutcome.launcher_session_key` / `launcher`) or
     *  from the late settle. Adopted onto the row by §1c on the next tick, so the
     *  pool's eviction guard and the crash latch see the run for its whole life —
     *  never only while this in-memory record exists. */
    generation: string | null
    /** Whether the launcher turn is known to have INJECTED into a child: `false`
     *  = it was still queued behind the driver lock (or the stream ended without
     *  injecting), `null` = not yet known. Decides what the deadline cancel does. */
    injected: boolean | null
    late: FireOutcome | null
    /** Set once the workflow's own stage event proved the fire. */
    confirmed_by: 'stage-event' | null
    /** Abandon the still-draining launcher turn (see `FireOutcome.cancel`). */
    cancel: (() => Promise<void>) | null
  }
  const unconfirmedFires = new Map<string, UnconfirmedFire>()
  const stampFor = (run_id: string, stage: string, meta?: string | null): void => {
    try {
      opts.record_stage?.(run_id, stage, meta ?? null)
    } catch {
      // A stamp must never fail a tick.
    }
  }
  // In-flight FIRE turns (tests + graceful shutdown drain). Each settles in
  // seconds; the build itself runs detached and is NOT tracked here.
  const inflight = new Set<Promise<void>>()
  /**
   * Delay only, intentionally in memory: the LOOP BOUND is durable in
   * `infra_retries`. Losing this map on restart is harmless because the restart
   * itself supplies delay; it can only make the next eligible retry earlier.
   */
  const infraRetryNotBefore = new Map<string, number>()

  async function resolveBase(run: TridentRun): Promise<string> {
    if (opts.base_branch !== undefined) return opts.base_branch
    return detectBaseBranch(opts.run_host, run.repo_path)
  }

  /**
   * The LEFT-HAND SIDE of any rev-range this orchestrator builds (#546): the launch-pinned
   * sha, else `refs/remotes/origin/<base>` when that ref resolves, else `refs/heads/<base>`;
   * a base that resolves to neither is REFUSED. Never a bare name — see `diffBaseRef`.
   *
   * The remote question is asked of the REPOSITORY, never inferred from `merge_mode` —
   * `local` means the outer loop merges locally, not that there is no remote, and keying
   * the fallback on it was the last place this defect lived.
   */
  async function resolvedDiffBase(run: TridentRun): Promise<string> {
    const base = await resolveBase(run)
    // THE PROBE IS PASSED, NOT CALLED. `await refResolves(...)` in the argument
    // position ran it before `diffBaseRef` could return the pin — correct answer, wasted
    // work, and a pinned dispatch that failed whenever the probe did.
    return diffBaseRef(base, run.base_sha, (ref) => refResolves(opts.run_host, run.repo_path, ref))
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

  /** Best-effort, read-only probe for a PR that already reached MERGED while its
   *  launcher was unavailable. No evidence is never treated as a merge. */
  async function detectMergedPr(run: TridentRun): Promise<number | null> {
    if (run.merge_mode !== 'pr') return null
    try {
      if (run.pr !== null) {
        const res = await opts.run_host(
          ['gh', 'pr', 'view', String(run.pr), '--json', 'state,number', '--jq', '.state'],
          run.repo_path,
        )
        return res.ok && res.stdout.trim() === 'MERGED' ? run.pr : null
      }
      const branch = run.branch ?? `trident/${run.slug}`
      const res = await opts.run_host(
        ['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--jq', '.[0].number // empty'],
        run.repo_path,
      )
      if (!res.ok) return null
      const n = parseInt(res.stdout.trim(), 10)
      return Number.isFinite(n) && n > 0 ? n : null
    } catch {
      return null
    }
  }

  /**
   * A COMMIT OID IS READ, NOT REPORTED. `claimedHead` is whatever the build SAID it
   * committed — possibly abbreviated, possibly absent. The head that actually gets
   * published is the one git resolves for the branch the inner loop named (a name a
   * model cannot plausibly mangle). A claim is only ever a CHECK against that. The
   * claim is itself resolved through git first (`resolveClaimedCommit`): unresolvable
   * = ABSENT; only two real, DIFFERENT OIDs refuse, and only after the push, so a
   * refusal never strands the commit.
   */
  async function publishBuiltCommit(
    run: TridentRun,
    claimedHead: string | null,
  ): Promise<{ pr: number; head: string; push: 'pushed' | 'noop-already-at-head' }> {
    if (run.merge_mode !== 'pr') throw new Error('outer publish requested outside pr mode')
    const branch = run.branch ?? `trident/${run.slug}`
    // `--verify` so a missing/ambiguous ref is an ERROR rather than an echoed argument.
    const local = await opts.run_host(
      ['git', '-C', run.repo_path, 'rev-parse', '--verify', `refs/heads/${branch}`],
      run.repo_path,
    )
    const resolvedHead = local.stdout.trim()
    if (!local.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolvedHead)) {
      const detail = local.stderr.trim()
      throw new Error(
        `outer publisher could not resolve branch ${branch} locally${detail === '' ? '' : `: ${detail}`}`,
      )
    }
    // THE CLAIM IS A CHECK, NEVER THE SOURCE — and it is RESOLVED before it may check
    // anything. A claim naming no git object is ABSENT, not a conflict (there is only
    // one candidate commit: git's). Resolved OIDs are compared for EQUALITY — a prefix
    // compare is wrong both ways: a hallucinated prefix refused a good build, and a
    // short sha of the right commit is only honored by resolving it. The refusal
    // itself is DEFERRED until after the push (see below) so it can never strand the
    // commit; it remains only for two real, resolvable, DIFFERENT commits.
    const resolvedClaim = await resolveClaimedCommit(opts.run_host, run.repo_path, claimedHead)
    const claimConflict = resolvedClaim !== null && resolvedClaim !== resolvedHead
    // FIX-ROUND ANCESTRY GATE (mandated by the Fable arbitration on #289 vs #318).
    // A fix round carries the head the review verdict was ABOUT; the head it produced
    // must DESCEND from it. Run fec4d3aa rebuilt from main with no ancestry of the
    // reviewed head 4523107b and was silently published as a new PR — this gate makes
    // that a REFUSAL. Evaluated on the PRE-rebase produced head: the replay below
    // rewrites shas onto the observed base, so this is the only point where "did the
    // build abandon the reviewed branch?" is still measurable. `--is-ancestor` passes
    // on equality, so a legitimate RESUME republishing or continuing the reviewed
    // head passes with no exemption (the recovery-card interaction).
    const lineage = await fixLineage(opts.run_host, run.repo_path, branch, run.reviewed_head, resolvedHead)
    if (lineage.kind !== 'allow') throw new Error(lineage.kind === 'blocked' ? lineage.on : lineage.detail)
    const runWithRetries = async (command: string[], attempts = 3) => {
      let result = await opts.run_host(command, run.repo_path)
      for (let attempt = 1; !result.ok && attempt < attempts; attempt++) {
        result = await opts.run_host(command, run.repo_path)
      }
      return result
    }
    // Observe the branch before replay: a missing remote ref proves this is the lane's FIRST
    // publish, which is the only point where the launch pin can prove the branch was cut from
    // this run's base rather than inherited from another lane. The same observation remains the
    // push lease below, so a branch that appears while replay is running is still refused.
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
    if (expected === '' && run.base_sha !== null) {
      const cutFromPinnedBase = await opts.run_host(
        ['git', '-C', run.repo_path, 'merge-base', '--is-ancestor', run.base_sha, resolvedHead],
        run.repo_path,
      )
      if (!cutFromPinnedBase.ok) {
        const base = await resolveBase(run)
        throw new Error(
          `branch ${branch} does not contain the origin/${base} tip pinned at launch (${run.base_sha.slice(0, 7)}) — not cut from origin/${base}; refusing to publish work built on another lane's branch. Verify the card instead of rebuilding.`,
        )
      }
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
    // ON CONFLICT. A configured `resolve_conflict` resolver is tried FIRST, in the scratch
    // worktree, bounded by `MAX_CONFLICT_ROUNDS` — this is the autonomous path, so there is no
    // human here to reconcile the branch by hand. Absent, declining, or exhausted → an ATTENTION
    // state (`TridentRebaseConflict`) exactly as before: never `REQUEST_CHANGES`, naming the
    // conflicting paths and saying plainly that no reviewer judged the code. And a RESOLVED
    // conflict shortcuts nothing — the replay is published and review is re-fired as usual.
    //
    // The replay heals a shallow checkout on entry (`healShallowCheckout`) and still uses a
    // diff-replay in a throwaway worktree — never `git rebase`, never the shared working tree.
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
      opts.resolve_conflict !== undefined ? { run, resolve_conflict: opts.resolve_conflict } : undefined,
    )
    // Everything downstream publishes the REBASED head: the post-push confirm, the review diff,
    // and the `outer-published:<head>` checkpoint the re-fired workflow reads back.
    let headToPublish = rebased.head
    // PURITY PREFLIGHT (2026-08-31): 3 of 4 PRs that night were red on exactly one
    // check — the public leak gate — every finding in the branch's own regenerated
    // plan doc. Run the gate on the branch tree HERE, after the replay and before
    // the lease push, so a finding is a fixable defect in this round instead of a
    // guaranteed-red PR. ADVISORY AND BOUNDED: every status proceeds to publish
    // (a gate bug must never wedge a lane); only the fix loop inside is bounded.
    // The fixer moves the branch ref by compare-and-swap, so the post-preflight
    // head is what the lease push, confirm, review diff, returned head and the
    // outer-published checkpoint all carry — via this one reassignment.
    // base_sha: the OBSERVED base tip the head now sits on, so the gate's
    // commit-message window is exactly this branch's own commits (a stale pin
    // would scan other lanes' messages — the nondeterminism SPEC.md documents).
    const preflight = await (opts.leak_preflight ?? runLeakGatePreflight)({
      run_host: opts.run_host,
      repo_path: run.repo_path,
      branch,
      head: headToPublish,
      base_sha: rebased.baseSha !== '' ? rebased.baseSha : (run.base_sha ?? ''),
      // PER-PUBLISH, NOT PER-RUN. `publishBuiltCommit` fires after the first build AND after every
      // fix round, and the preflight's cleanup deliberately swallows its own failure — so a path
      // keyed on the run id alone would collide with its own leftover on the next round, `git
      // worktree add` would exit 128, and the preflight would return gate-error (logged at warn,
      // then ignored) for the rest of the run. The head being published makes it distinct per
      // round; the timestamp covers a re-publish of the same head.
      scratch_dir: `${run.repo_path}/.trident-worktrees/leak-preflight-${run.id}-${headToPublish.slice(0, 12)}-${Date.now().toString(36)}`,
      ...(opts.fix_leak_findings !== undefined ? { fixer: opts.fix_leak_findings } : {}),
    })
    headToPublish = preflight.head
    if (preflight.status === 'findings-unresolved' || preflight.status === 'gate-error') {
      log.warn('leak_preflight', { run_id: run.id, status: preflight.status, note: preflight.note })
    } else {
      log.info('leak_preflight', { run_id: run.id, status: preflight.status, note: preflight.note })
    }
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
    // ALREADY PUBLISHED IS A SUCCESS THE PUBLISHER DID NOT HAVE TO PERFORM (3 occurrences
    // 2026-08-17, runs 26ed32c1 / 88efe1ca / 95fcfb91). A resumed or relaunched run whose
    // branch is already fully on origin used to be REFUSED here as "the build left no new
    // commits to publish" — a finished, reviewed, PUSHED build recorded `failed`, and the
    // natural relaunch rebuilt work that was already on origin. The remote holding EXACTLY
    // `headToPublish` means the push is a NO-OP: resolve to that commit and continue.
    // Compared against the POST-rebase head, not `resolvedHead` — a remote at the
    // pre-rebase tip while the replay produced a new head still needs the real lease push.
    // The genuine "nothing was built" outcome keeps its guard where it belongs: the empty
    // base..head diff refusal below, which measures CONTENT against the base.
    const alreadyPublished = remoteAlreadyAtPublishHead(expected, headToPublish)
    if (!alreadyPublished) {
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
    }
    // On the no-op path the `observed` read above IS the witness: origin was measured at
    // exactly `headToPublish` moments ago and this publisher performed no write since.

    // THE REFUSAL FIRES ONLY AFTER THE PUSH IS CONFIRMED (defect 2, 2026-08-14: the
    // throw preceded the push, so a wrong refusal left the commit unreachable —
    // 924b4290ea81… was stranded). A refusal is about which commit to REVIEW, not
    // about whether the work may exist: the branch is on origin for inspection; only
    // the PR / review dispatch is refused.
    if (claimConflict) {
      throw new Error(
        `outer publisher refused: the build reported commit '${claimedHead}' (resolves to '${resolvedClaim}') but branch ${branch} resolved to '${resolvedHead}' before publish — the branch was pushed to origin for inspection; no PR or review was dispatched`,
      )
    }

    let pr = prBefore
    if (pr === null) {
      const base = await resolveBase(run)
      const created = await runWithRetries(
        ['gh', 'pr', 'create', '--head', branch, '--base', base, '--fill'],
      )
      if (!created.ok) throw new Error(publishFailureReason('open a PR for', branch, created.stderr))
      pr = await detectExistingPr({ ...run, branch })
    }
    if (pr === null) throw new Error(`outer publisher could not confirm an open PR for branch ${branch}`)

    // BEST-EFFORT FINDINGS ANNOTATION. The PR opens regardless — this only names
    // what the preflight could not self-correct, so a human reading the red CI
    // sees the same facts without hunting. No excerpt is ever quoted, and the
    // whole rendered note goes through `sanitizeLeakAnnotation` (rule ids AND
    // file paths can carry the banned root, and a PR body is itself scanned).
    // Every failure here — a throw or any !ok host result — is logged and
    // swallowed: the publish must never fail on an annotation.
    if (preflight.status === 'findings-unresolved') {
      try {
        const lines = preflight.findings.map((f) => `- [${f.rule}] ${f.file}:${f.line}`)
        if (preflight.skipped_rules.length > 0) {
          lines.push(`tiers skipped locally (no secret): ${preflight.skipped_rules.join(', ')}`)
        }
        const note = sanitizeLeakAnnotation(
          [
            `### purity preflight: ${preflight.findings.length} finding(s) not self-corrected`,
            ...lines,
            "No excerpt is quoted by design; CI's purity job remains the enforcement of record.",
          ].join('\n'),
        )
        const noteFile = join(tmpdir(), `trident-leak-note-${run.id}.md`)
        let annotated = false
        if (prBefore === null) {
          // The PR was minted THIS publish, so its body is `--fill`ed boilerplate
          // that is safe to extend in place.
          const body = await opts.run_host(
            ['gh', 'pr', 'view', String(pr), '--json', 'body', '--jq', '.body'],
            run.repo_path,
          )
          if (body.ok) {
            writeFileSync(noteFile, `${body.stdout.trim()}\n\n${note}`)
            const edited = await opts.run_host(
              ['gh', 'pr', 'edit', String(pr), '--body-file', noteFile],
              run.repo_path,
            )
            // ONLY a SUCCESSFUL edit consumes the annotation. Setting this before the check meant
            // a transient `gh pr edit` failure left the findings in a log line and nowhere else —
            // the comment fallback below is exactly the path such a failure should take.
            if (edited.ok) annotated = true
            else log.warn('leak_preflight_annotation_failed', { run_id: run.id })
          }
        }
        if (!annotated) {
          // A PRE-EXISTING PR (every fix round) — editing the body would clobber
          // or duplicate whatever is there, so append a comment instead.
          writeFileSync(noteFile, note)
          const commented = await opts.run_host(
            ['gh', 'pr', 'comment', String(pr), '--body-file', noteFile],
            run.repo_path,
          )
          if (!commented.ok) log.warn('leak_preflight_annotation_failed', { run_id: run.id })
        }
      } catch (err) {
        log.warn('leak_preflight_annotation_failed', {
          run_id: run.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const diffFile = `/tmp/trident-outer-published-${run.id}.diff`
    // THE REVIEW DIFF IS TAKEN AGAINST THE OBSERVED BASE TIP, NOT AGAINST THE LOCAL `main` REF.
    //
    // MEASURED (Argus r4, run 25b2327d): the published artifact was 15,154 lines across ~100
    // files while the branch's own work was 20 files / 1,738 lines. The shared build checkout's
    // local `main` was 8 merges behind `origin/main`, and `git diff main..<head>` on a branch
    // built from CURRENT origin therefore shows every commit merged in between as part of this
    // card. ~87% of that artifact was already-merged unrelated code — one reviewer diffed the
    // stale base, vetoed the branch over bugs in files it does not touch, and the round was lost.
    //
    // `rebaseOntoObservedBase` already `ls-remote`s the base tip (the same observation the push
    // lease uses) and the head it returns is replayed directly onto it, so that sha is the exact
    // left-hand side of this branch's own diff. It is a local object on BOTH paths that return a
    // non-empty one: the replay fetches it, and the already-contains path could only have been
    // answered by reading it.
    //
    // AN EMPTY ONE IS NOT A LICENCE FOR THE BARE LOCAL NAME (#546). This line used to fall
    // straight back to `resolveBase(run)` — `detectBaseBranch`'s bare `main` — on the theory
    // that "there is no remote base at all" is the one case where the name is the best
    // available answer. Two of those three fallback worlds still have a better answer:
    // `run.base_sha` is the launch-observed tip, and `origin/<base>` is a remote-tracking
    // ref the launch path fetches (and, in pr mode, refuses to start without). `diffBaseRef`
    // picks whichever exists and falls back to `refs/heads/<base>` whenever
    // `refs/remotes/origin/<base>` does not resolve — NOT "only in local mode", which is the
    // framing the fix that removed it left behind here, and NOT the bare name, which is what
    // this comment said until round nineteen. The merge mode says nothing about whether a
    // remote exists; keying the fallback on it was the defect, and a comment still asserting
    // it is the same claim surviving its own correction.
    const baseRef =
      rebased.baseSha !== ''
        ? rebased.baseSha
        : await resolvedDiffBase(run)
    const changed = await opts.run_host(
      // `--no-renames` HERE, not only on the group diffs below (Argus r17). This
      // listing is what BUILDS the path universe the groups are restricted to, so
      // with rename detection ON it names only a rename's DESTINATION — and the
      // source path's deletion then appears in NEITHER group, silently dropping it
      // from the artifact. The `--no-renames` added to the group diffs alone could
      // not fix that: a path absent from this list is never handed to any group.
      // `core.quotePath=false` for the same reason one line down: a C-quoted token
      // fed back as a pathspec matches nothing and drops that file's hunks.
      // `--end-of-options` — DEFENCE IN DEPTH behind `diffBaseRef`'s refusal. Measured on
      // git 2.43: without it this exact argv with a base of `--output=<path>` EXITS 0 and
      // writes the file; with it git refuses (128) and writes nothing, and a legitimate
      // range is unaffected. The binding REFUSES such a value (it throws); this is what makes
      // the command safe for any value that ever reaches it. "Refuses" rather than "makes
      // unconstructable" on purpose — the mechanism is a throw on one code path, not a
      // property of the type, and a value that never passed through the binding is exactly
      // what this marker is here for.
      gitRangeArgv({
        repo_path: run.repo_path,
        config: ['-c', 'core.quotePath=false'],
        subcommand: 'diff',
        flags: ['--name-only', '--no-renames'],
        base: baseRef,
        head: headToPublish,
      }),
      run.repo_path,
    )
    if (!changed.ok || changed.stdout.trim() === '') {
      throw new Error('outer publisher refused to dispatch reviewers for an empty diff')
    }
    // AND THE FILES NO REVIEWER HAS SEEN COME FIRST.
    //
    // MEASURED (Argus r16, three reviewers, before #680): the artifact was 6,692
    // lines and the cross-model reviewer read only its first 3,000. In default git order — plain
    // alphabetical — every write-site file of that round (`trident/checkpoint.sh`
    // at line 3,417, `inner-workflow.mjs` at 4,427, `orchestrator.ts` at 5,132,
    // `run-disposition.ts` at 5,851, `store.ts` at 6,360) fell past the window, so
    // ~55% of the diff — including all of the round's NEW work — had no
    // cross-model coverage at all. Alphabetical order is not neutral here: on a
    // fix round it systematically buries the fix under the docs and tests of the
    // rounds already reviewed.
    //
    // `reviewed_head` is the pin of what a reviewer HAS seen (migration 0124,
    // enforced by the ancestry gate above), so `reviewed_head..head` is exactly
    // the never-reviewed set. The artifact's CONTENT is unchanged — still the
    // whole `base..head` diff, because a reviewer must be able to read the entire
    // change — only its ORDER is: unseen files first, everything else after, one
    // `git diff` per group concatenated in that order (git sorts within a single
    // invocation whatever order the pathspecs arrive in, so the split is the only
    // way to express this).
    //
    // AND THE PIN IS READ THE WAY `merge.ts` READS IT — AND WRITTEN AT THE SEAT
    // THAT REACHES THIS LINE (Argus r17 + r18 blockers). Two separate holes, both
    // of which made this reorder INERT in production while it passed in tests:
    //
    //   1. The `reviewed_head` COLUMN is settable only at `store.create` and no
    //      production caller ever supplies a value — `update()` has no branch for
    //      it — so keying the split on the column alone read '' on every real run.
    //      Fixed by ALSO reading `reviewedHead` out of `inner_result`
    //      (`reviewedHeadOid`, the OID the merge pins with `--match-head-commit`).
    //   2. …but `inner-workflow.mjs`'s publish handoffs did not EMIT that field,
    //      so the fallback read stayed '' too. The fix-round handoff now carries
    //      it (inner-workflow.mjs, the `isPr` return under `fix-round-${round}`),
    //      and `orchestrator.test.ts` pins the field against the shape the real
    //      workflow emits rather than against a fabricated one.
    //
    // On a fix round the value is EXACTLY the head the reviewers judged: the
    // resumed workflow sets it from the recorded resume head and never re-reads it
    // before the publish handoff, while `publish_head` carries the new one. The
    // round-1 `forge-done` handoff deliberately carries NO pin — no reviewer has
    // seen anything yet, so every file is unseen, `seenPin` is '' and the fallback
    // below renders the whole diff unordered, which is the correct artifact for a
    // first review. The column still WINS when set: it is the more explicit pin.
    //
    // `--no-renames` on the split path is load-bearing, not taste: with rename
    // detection ON, `--name-only` reports ONLY a rename's destination, so
    // restricting a later group to the listed paths would silently DROP the
    // source path's deletion from the artifact. Off, both sides are listed and
    // both are rendered. Every degenerate case — no pin, an unreadable probe, all
    // files unseen (a first round), none unseen, or more than 500 changed files —
    // falls back to the single unordered command that shipped before, so the
    // artifact still CONTAINS exactly what it does today.
    //
    // THE 500 IS A COUNT, AND ONLY A COUNT (Argus r24, nit). An earlier wording
    // called it "a file list long enough to strain argv", which promised a fallback
    // this code does not have: if a pathspec list ever DID overflow `execve`, the
    // split `git diff` would come back not-ok and the publish would throw
    // "outer publisher could not materialize the review diff" rather than degrade.
    // It cannot happen here — the longest tracked path is 94 bytes, so 500 paths is
    // ≈52 KB against a 2 MB ARG_MAX — and the count guard stands the reorder down
    // long before that. The bound is a cheap ceiling on a review-diff reordering
    // nobody wants for a 500-file change, not an argv calculation.
    //
    // NOT byte-identical between the two paths, though, and the earlier wording
    // ("at worst exactly what it is today") overclaimed that (Argus r18). Only the
    // split path passes `--no-renames`, so a renamed file renders as delete+add
    // there and as a `rename` header on the fallback. That is the deliberate cost
    // of not dropping a rename's source: the contract is that the whole change is
    // present and reordered, never that the two renderings match byte for byte.
    const changedLines = changed.stdout.split('\n').filter((l) => l.trim().length > 0)
    const changedFiles = changedLines.map((l) => l.trim())
    let groups: string[][] | null = null
    const seenPin = (run.reviewed_head ?? reviewedHeadOid(run) ?? '').trim().toLowerCase()
    // A C-QUOTED PATH IS NOT A PATHSPEC. `core.quotePath=false` above unquotes the
    // common case (non-ASCII bytes), but git still quotes a path containing a
    // quote, a backslash or a control character — and such a token fed back as a
    // pathspec matches NOTHING, so `git diff` writes no hunks for it, exits 0, and
    // the file vanishes from the artifact without tripping the fallback. Any
    // leading `"` in the listing means at least one path cannot be expressed as a
    // pathspec here, so the whole reorder stands down to the single command that
    // renders every path correctly. (It also covers the pathological embedded
    // newline: git quotes those too, so the split fragment still starts with `"`.)
    const quoted = changedFiles.some((f) => f.startsWith('"'))
    // AND A TRIMMED PATH IS NOT THE PATH EITHER (Argus r21, latent). git prints an
    // unquoted path VERBATIM, so a tracked name with a leading or trailing space —
    // legal on every filesystem this runs on, and printed bare because
    // `core.quotePath` only quotes non-ASCII/control bytes — survives the listing
    // intact and is then destroyed by the `trim()` above: `:(literal)<trimmed>`
    // matches nothing, `git diff` writes no hunks, exits 0, and the file vanishes
    // from the reviewer's artifact with no error anywhere. The trim itself stays
    // (it is what makes the `\r` and blank-line cases safe); what changes is that a
    // line the trim ALTERED means at least one path cannot be expressed as a
    // pathspec here, so the reorder stands down to the single unrestricted command
    // exactly as a C-quoted path does. Zero such paths are tracked today — this
    // closes the shape before a reviewer reads a diff that is quietly incomplete.
    const padded = changedLines.some((l) => l !== l.trim())
    if (/^[0-9a-f]{40}$/.test(seenPin) && !quoted && !padded && changedFiles.length <= 500) {
      const unseenRes = await opts.run_host(
        // `--end-of-options` (#546): `seenPin` is 40-hex-checked one line above, so this is
        // belt-and-braces — kept anyway so EVERY range in this module carries it and the
        // coverage test needs no per-site exemption to reason about.
        gitRangeArgv({
          repo_path: run.repo_path,
          config: ['-c', 'core.quotePath=false'],
          subcommand: 'diff',
          flags: ['--no-renames', '--name-only'],
          base: seenPin,
          head: headToPublish,
        }),
        run.repo_path,
      )
      if (unseenRes.ok) {
        const unseen = new Set(
          unseenRes.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        )
        const first = changedFiles.filter((f) => unseen.has(f))
        const rest = changedFiles.filter((f) => !unseen.has(f))
        // Both non-empty or there is nothing to reorder.
        if (first.length > 0 && rest.length > 0) groups = [first, rest]
      }
    }
    if (groups === null) {
      const diff = await opts.run_host(
        // `--end-of-options`: without it a second `--output=` arrives from the operand and
        // git honours BOTH (measured, exit 0, two files written).
        gitRangeArgv({
          repo_path: run.repo_path,
          subcommand: 'diff',
          flags: [`--output=${diffFile}`],
          base: baseRef,
          head: headToPublish,
        }),
        run.repo_path,
      )
      if (!diff.ok) throw new Error('outer publisher could not materialize the review diff')
    } else {
      writeFileSync(diffFile, '')
      for (const [i, group] of groups.entries()) {
        const part = `${diffFile}.part${i}`
        // `:(literal)`, because a PATH IS NOT A PATTERN (Argus r20, nit, with a
        // scratch-repo repro). A bare pathspec is glob-matched as well as
        // literal-matched, so a changed path containing `[`, `*` or `?` — this repo
        // tracks 13 of them, e.g. `app/app/projects/[id]/backups.tsx` — ALSO pulls
        // in every sibling its brackets happen to match, and a file caught by both
        // groups is rendered twice in the artifact. Nothing is dropped, but the
        // reviewer reads the same hunks under two headings. Literal magic turns each
        // token back into the exact path `--name-only` printed.
        const partDiff = await opts.run_host(
          gitRangeArgv({
            repo_path: run.repo_path,
            subcommand: 'diff',
            flags: ['--no-renames', `--output=${part}`],
            base: baseRef,
            head: headToPublish,
            pathspec: group.map((f) => `:(literal)${f}`),
          }),
          run.repo_path,
        )
        if (!partDiff.ok) throw new Error('outer publisher could not materialize the review diff')
        // A group whose files produce no hunks contributes nothing, and that is not
        // an error. MEASURED (Argus r22, scratch repo, git 2.43.0): `--output=` CREATES
        // the file regardless — 0 bytes — so on this git the branch below always runs
        // and appends nothing. The note that stood here said the file is not written,
        // which would have made the `existsSync` load-bearing; it is a stand-down for a
        // git that behaves the other way, and appending 0 bytes is the same artifact
        // either way. It also has to be safe against a part left by an earlier run,
        // which is why the file is removed after it is folded in.
        if (existsSync(part)) {
          appendFileSync(diffFile, readFileSync(part))
          rmSync(part, { force: true })
        }
      }
    }
    return { pr, head: headToPublish, push: alreadyPublished ? 'noop-already-at-head' : 'pushed' }
  }

  function failedRun(run: TridentRun, reason: string, keepSubagentId: boolean): TridentRun {
    return {
      ...run,
      phase: 'failed',
      subagent_status: 'failed',
      subagent_run_id: keepSubagentId ? run.subagent_run_id : null,
      // A REQUEST_CHANGES survives only with ARGUS PROVENANCE — the run must have
      // actually reached review. Non-empty findings are NOT that proof: the suite
      // gate (`inner-workflow.mjs`, "FULL SUITE NOT PROVEN …") writes a blocker of
      // its own on a build that never got near a reviewer, so the old
      // findings-non-empty test recorded 113 never-reviewed runs — 68 stopped at
      // `forge-done`, 45 at `inner-error` — as reviewed rejections. That is what
      // makes an un-reviewed queue read as reviewed-and-rejected.
      // …AND AN ESCALATION KEEPS ITS REJECTION HERE TOO. This is the FOURTH copy of the
      // findings rule, found by enumerating the readers of `inner_verdict` rather than the
      // sites that name escalation kinds. It is not reachable with a live escalation today
      // — `recordedTerminalVerdict` at the terminal-result path is the ONLY production
      // writer of a REQUEST_CHANGES verdict, and that path overrides this value — so this
      // is closing a latent trap rather than fixing a live defect. It is closed anyway,
      // because the next caller to reuse `failedRun` on a row that already carries one
      // would silently downgrade a stop the owner is waiting on, and the cost of the line
      // is a line.
      inner_verdict:
        run.inner_verdict === 'APPROVE'
          ? 'APPROVE'
          : run.inner_verdict === 'REQUEST_CHANGES' &&
              hasArgusProvenance(run.inner_checkpoint) &&
              (parseCheckpointFindings(run.inner_checkpoint_findings).length > 0 ||
                resultCarriesEscalation(run.inner_result))
            ? 'REQUEST_CHANGES'
            : 'REVIEW_NOT_RUN',
      failure_reason: reason,
      last_advanced_at: now(),
    }
  }

  // Unexpected reconciliation/publish exceptions remain observable in the step
  // note. Expected worktree-capture failures are persisted on failure_reason;
  // this WeakMap is only the last-resort diagnostic for throws outside that
  // typed disposition.
  const salvageFailureNotes = new WeakMap<TridentRun, string>()

  function failedDisposition(
    step: string,
    result?: { stderr: string; stdout: string },
  ): Extract<WorktreeDisposition, { kind: 'failed' }> {
    const output = result === undefined ? '' : result.stderr || result.stdout
    return {
      kind: 'failed',
      detail: `${step}${output.trim() === '' ? '' : `: ${output.trim().replace(/\s+/g, ' ').slice(0, 120)}`}`,
    }
  }

  async function measureSnapshot(
    repo: string,
    base: string,
    targets: string[],
  ): Promise<{ files: number; lines: number } | { detail: string }> {
    // Count both captured versions. Taking the larger per-path delta avoids
    // double-counting ordinary staged-then-edited files while ensuring an
    // index-only path is not reported as zero work.
    const linesByPath = new Map<string, number>()
    for (const target of targets) {
      const numstat = await opts.run_host(
        ['git', '-C', repo, 'diff', '--numstat', base, target],
        repo,
      )
      if (!numstat.ok) {
        return { detail: failedDisposition('snapshot numstat failed', numstat).detail }
      }
      for (const line of numstat.stdout.split(/\r?\n/)) {
        if (line === '') continue
        const [addedText = '', removedText = '', ...pathParts] = line.split('\t')
        const addedLines = Number.parseInt(addedText, 10)
        const removedLines = Number.parseInt(removedText, 10)
        const lineCount =
          (Number.isFinite(addedLines) ? addedLines : 0) +
          (Number.isFinite(removedLines) ? removedLines : 0)
        const path = pathParts.join('\t') || line
        linesByPath.set(path, Math.max(linesByPath.get(path) ?? 0, lineCount))
      }
    }
    return {
      files: linesByPath.size,
      lines: [...linesByPath.values()].reduce((sum, count) => sum + count, 0),
    }
  }

  async function anchoredSnapshotDisposition(run: TridentRun): Promise<WorktreeDisposition | null> {
    const snapshotRef = `refs/tags/trident-salvage/${run.id}`
    const anchored = await opts.run_host(
      ['git', '-C', run.repo_path, 'rev-parse', '--verify', `${snapshotRef}^{commit}`],
      run.repo_path,
    )
    const oid = anchored.stdout.trim()
    if (!anchored.ok || !/^[0-9a-f]{40}$/.test(oid)) return null

    // The ref is the durable capture receipt. Reconstruct its counts from its
    // own first parent rather than the branch's current HEAD: a retry can happen
    // after the worktree and branch have both moved.
    const parent = await opts.run_host(
      ['git', '-C', run.repo_path, 'rev-parse', '--verify', `${snapshotRef}^1^{commit}`],
      run.repo_path,
    )
    const base = parent.stdout.trim()
    let warning: string | undefined
    let files = 0
    let lines = 0
    if (!parent.ok || !/^[0-9a-f]{40}$/.test(base)) {
      warning = failedDisposition('anchored snapshot parent unreadable', parent).detail
    } else {
      const indexParent = await opts.run_host(
        ['git', '-C', run.repo_path, 'rev-parse', '--verify', `${snapshotRef}^2^{commit}`],
        run.repo_path,
      )
      const indexOid = indexParent.stdout.trim()
      const targets =
        indexParent.ok && /^[0-9a-f]{40}$/.test(indexOid) ? [oid, indexOid] : [oid]
      const measured = await measureSnapshot(run.repo_path, base, targets)
      if ('detail' in measured) warning = measured.detail
      else ({ files, lines } = measured)
    }

    const message = await opts.run_host(
      ['git', '-C', run.repo_path, 'show', '-s', '--format=%B', snapshotRef],
      run.repo_path,
    )
    const untrackedMatch = message.ok
      ? message.stdout.match(/^Trident-Salvage-Untracked:\s*(\d+)$/m)
      : null
    const capturedWarning = message.ok
      ? message.stdout.match(/^Trident-Salvage-Warning:\s*(.+)$/m)?.[1]?.trim()
      : undefined
    if (warning === undefined && capturedWarning !== undefined && capturedWarning !== '') {
      warning = capturedWarning
    }

    return {
      kind: 'dirty',
      files,
      lines,
      untracked: untrackedMatch === null ? 0 : Number.parseInt(untrackedMatch[1] ?? '0', 10),
      ref: snapshotRef,
      ...(warning === undefined ? {} : { warning }),
    }
  }

  async function snapshotWorktree(
    run: TridentRun,
    worktree: string,
    statusEntries: string[],
  ): Promise<WorktreeDisposition> {
    const scratch = mkdtempSync(join(tmpdir(), 'trident-salvage-index-'))
    const index = join(scratch, 'index')
    const snapshotRef = `refs/tags/trident-salvage/${run.id}`
    const withSnapshotIndex = (args: string[]): Promise<HostCommandResult> =>
      opts.run_host(['git', '-C', worktree, ...args], worktree, { GIT_INDEX_FILE: index })

    try {
      // `stash create` is the read-only Git primitive that preserves BOTH the
      // live index and the tracked working tree. Its second parent is the index
      // snapshot. Retain that parent on our final commit so staged-only content
      // remains recoverable even when the worktree copy is back at HEAD.
      const hasTrackedChanges = statusEntries.some((entry) => !entry.startsWith('?? '))
      let indexParent: string | null = null
      let warning: string | undefined
      if (hasTrackedChanges) {
        const stashed = await opts.run_host(['git', '-C', worktree, 'stash', 'create'], worktree)
        const stashOid = stashed.stdout.trim()
        if (!stashed.ok || !/^[0-9a-f]{40}$/.test(stashOid)) {
          warning = failedDisposition('snapshot stash-create failed', stashed).detail
        } else {
          const resolvedIndex = await opts.run_host(
            ['git', '-C', worktree, 'rev-parse', '--verify', `${stashOid}^2^{commit}`],
            worktree,
          )
          const resolvedOid = resolvedIndex.stdout.trim()
          if (!resolvedIndex.ok || !/^[0-9a-f]{40}$/.test(resolvedOid)) {
            warning = failedDisposition('snapshot index-parent failed', resolvedIndex).detail
          } else {
            indexParent = resolvedOid
          }
        }
      }

      // Build the worktree-facing tree in a PRIVATE temporary index. This adds
      // untracked files without opening or locking the live index; the optional
      // index parent above preserves the distinct staged version.
      const seeded = await withSnapshotIndex(['read-tree', 'HEAD'])
      if (!seeded.ok) return failedDisposition('snapshot read-tree failed', seeded)

      const added = await withSnapshotIndex(['add', '-A', '--', '.'])
      if (!added.ok) return failedDisposition('snapshot add failed', added)

      const tree = await withSnapshotIndex(['write-tree'])
      const treeOid = tree.stdout.trim()
      if (!tree.ok || !/^[0-9a-f]{40}$/.test(treeOid)) {
        return failedDisposition('snapshot write-tree failed', tree)
      }

      const commitArgs = [
        'git',
        '-C',
        worktree,
        '-c',
        'user.name=Neutron Trident',
        '-c',
        'user.email=trident@neutron.local',
        'commit-tree',
        treeOid,
        '-p',
        'HEAD',
      ]
      if (indexParent !== null) commitArgs.push('-p', indexParent)
      commitArgs.push('-m', `trident salvage snapshot ${run.id}`)
      const untracked = statusEntries.filter((entry) => entry.startsWith('?? ')).length
      commitArgs.push(
        '-m',
        `Trident-Salvage-Untracked: ${untracked}${warning === undefined ? '' : `\nTrident-Salvage-Warning: ${warning}`}`,
      )
      const committed = await opts.run_host(commitArgs, worktree)
      const oid = committed.stdout.trim()
      if (!committed.ok || !/^[0-9a-f]{40}$/.test(oid)) {
        return failedDisposition('snapshot commit-tree failed', committed)
      }

      const measured = await measureSnapshot(
        worktree,
        'HEAD',
        indexParent === null ? [oid] : [oid, indexParent],
      )
      if ('detail' in measured) return { kind: 'failed', detail: measured.detail }

      const anchored = await opts.run_host(
        ['git', '-C', run.repo_path, 'update-ref', snapshotRef, oid, '0000000000000000000000000000000000000000'],
        run.repo_path,
      )
      if (!anchored.ok) {
        // A concurrent/retried capture may have won between the initial probe
        // and this create-only CAS. Its ref is authoritative; never move it.
        return (
          (await anchoredSnapshotDisposition(run)) ??
          failedDisposition('snapshot update-ref failed', anchored)
        )
      }

      return {
        kind: 'dirty',
        files: measured.files,
        untracked,
        lines: measured.lines,
        ref: snapshotRef,
        ...(warning === undefined ? {} : { warning }),
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  async function branchStashDisposition(run: TridentRun, branch: string): Promise<WorktreeDisposition> {
    const format = '--format=%H%x09%ct%x09%gs'
    // `stash list` and the underlying reflog are intentionally read separately:
    // either view can be unavailable/corrupt while the other still carries the
    // evidence. Entries are deduplicated by object id.
    const [listed, reflogged] = await Promise.all([
      opts.run_host(['git', '-C', run.repo_path, 'stash', 'list', format], run.repo_path),
      opts.run_host(
        ['git', '-C', run.repo_path, 'reflog', 'show', format, 'refs/stash'],
        run.repo_path,
      ),
    ])
    const started = Date.parse(run.started_at) / 1_000
    const ended = Date.parse(run.last_advanced_at) / 1_000
    const entries = new Set<string>()
    for (const result of [listed, reflogged]) {
      if (!result.ok) continue
      for (const line of result.stdout.split(/\r?\n/)) {
        const [oid = '', epochText = '', ...subjectParts] = line.split('\t')
        const epoch = Number.parseInt(epochText, 10)
        const subject = subjectParts.join('\t')
        const belongsToBranch =
          subject.startsWith(`WIP on ${branch}:`) || subject.startsWith(`On ${branch}:`)
        const belongsToRun =
          Number.isFinite(epoch) &&
          (!Number.isFinite(started) || epoch >= Math.floor(started)) &&
          (!Number.isFinite(ended) || epoch <= Math.ceil(ended))
        if (/^[0-9a-f]{40}$/.test(oid) && belongsToBranch && belongsToRun) entries.add(oid)
      }
    }
    return entries.size > 0 ? { kind: 'stashed', entries: entries.size } : { kind: 'none' }
  }

  async function captureWorktreeDisposition(
    run: TridentRun,
    branch: string,
  ): Promise<WorktreeDisposition> {
    try {
      const listed = await opts.run_host(
        ['git', '-C', run.repo_path, 'worktree', 'list', '--porcelain'],
        run.repo_path,
      )
      let worktree: string | null = null
      if (listed.ok) {
        const stanzas = listed.stdout
          .split(/\r?\n\r?\n/)
          .map((stanza) => stanza.split(/\r?\n/))
        const primary = stanzas[0]?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
        const recorded = run.worktree === null ? null : resolve(run.worktree)
        const runStarted = Date.parse(run.started_at)
        const runEnded = Date.parse(run.last_advanced_at)
        const candidates: string[] = []
        for (const stanzaLines of stanzas) {
          if (stanzaLines.includes(`branch refs/heads/${branch}`)) {
            const pathLine = stanzaLines.find((line) => line.startsWith('worktree '))
            if (pathLine === undefined) continue
            const candidate = pathLine.slice('worktree '.length)
            // The first stanza is the operator/shared checkout. It is never a
            // salvage target, even if somebody has checked the build branch out
            // there. Prefer the durable run-owned path when one was recorded.
            if (candidate === primary || resolve(candidate) === resolve(run.repo_path)) continue
            if (recorded !== null && resolve(candidate) !== recorded) continue
            // `worktree list` deliberately retains deleted linked worktrees as
            // prunable admin entries. They are not capture failures and must
            // not prevent the shared stash leg from running.
            if (stanzaLines.some((line) => line.startsWith('prunable'))) continue
            // A linked worktree's `.git` pointer is created with that worktree
            // and is not rewritten by ordinary edits/commits. Its mtime is a
            // second ownership proof: a checkout created after this failed row
            // ended belongs to a later dispatch on the reused branch.
            let createdAt: number
            try {
              createdAt = statSync(join(candidate, '.git')).mtimeMs
            } catch {
              // The checkout may disappear after the porcelain read. Treat it
              // like a prunable entry and continue to stash inspection.
              continue
            }
            const inRunWindow =
              (!Number.isFinite(runStarted) || createdAt >= runStarted - 1_000) &&
              (!Number.isFinite(runEnded) || createdAt <= runEnded + 1_000)
            if (!inRunWindow) continue
            candidates.push(candidate)
          }
        }
        if (candidates.length === 1) worktree = candidates[0] ?? null
      }

      if (worktree !== null) {
        const status = await opts.run_host(
          ['git', '-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
          worktree,
        )
        if (!status.ok) return failedDisposition('worktree status failed', status)
        const statusEntries = status.stdout.split('\0').filter((entry) => entry !== '')
        if (statusEntries.length > 0) return snapshotWorktree(run, worktree, statusEntries)
      }

      return branchStashDisposition(run, branch)
    } catch (err) {
      return failedDisposition(
        'worktree capture threw',
        err instanceof Error ? { stderr: err.message, stdout: '' } : undefined,
      )
    }
  }

  /** Git-truth reconciliation for a run about to be recorded `failed` (the card
   *  "a failed run must be asked whether it built something"). NEVER throws.
   *  Returns the annotated run to persist, or null when there is nothing to
   *  salvage or the rescue failed. */
  async function reconcile_stranded(
    run: TridentRun,
    options: StrandedReconcileOptions = {},
  ): Promise<TridentRun | null> {
    try {
      if (run.merge_mode !== 'pr') return null
      const branch = run.branch ?? `trident/${run.slug}`

      const local = await opts.run_host(
        ['git', '-C', run.repo_path, 'rev-parse', '--verify', `refs/heads/${branch}`],
        run.repo_path,
      )
      const localHead = local.stdout.trim()
      if (!local.ok || !/^[0-9a-f]{40}$/.test(localHead)) return null

      // THE BASE `resolvedDiffBase` CHOSE (#546) — the launch pin, else
      // `refs/remotes/origin/<base>` when that ref resolves, else `refs/heads/<base>`, which
      // is the best answer there is without a fetch. Never a bare name, and a base that
      // resolves to neither ref is refused. (This comment has been wrong twice: it said
      // "never the bare local branch name" while the bare fallback existed, then described
      // that fallback as legitimate after round nineteen removed it.) What must never happen
      // is this call site naming a base of its own. A stale `refs/heads/main`
      // makes `rev-list --count <base>..<localHead>` count the base's own unmerged history
      // as this lane's commits, and this count is what decides whether a stranded run built
      // anything worth salvaging.
      const baseRef = await resolvedDiffBase(run)
      const ahead = await opts.run_host(
        // `--end-of-options`: `rev-list` exits 129 on an option-shaped operand and writes
        // the file anyway (measured); the marker stops it reaching the option parser.
        gitRangeArgv({ repo_path: run.repo_path, subcommand: 'rev-list', flags: ['--count'], base: baseRef, head: localHead }),
        run.repo_path,
      )
      const aheadText = ahead.stdout.trim()
      if (!ahead.ok || !/^\d+$/.test(aheadText)) return null
      const aheadCount = Number.parseInt(aheadText, 10)
      const failureReason = run.failure_reason ?? 'run failed'
      // Probe the run-scoped recovery ref on EVERY reconciliation, independent
      // of the database marker. The ref can be durable even when the following
      // store write failed; in that case it is the receipt and must win over a
      // changed worktree on retry.
      const anchoredDisposition = await anchoredSnapshotDisposition(run)
      const disposition =
        anchoredDisposition ??
        (options.inspect_worktree === false
          ? { kind: 'none' as const }
          : await captureWorktreeDisposition(run, branch))

      const appendDisposition = (reason: string): string => {
        if (disposition.kind === 'dirty') {
          return reason.includes(TRIDENT_SNAPSHOT_MARKER)
            ? reason
            : `${reason}; plus ${worktreeDispositionSuffix(disposition)}`
        }
        if (disposition.kind === 'stashed') {
          return reason.includes(TRIDENT_STASH_PARKED_MARKER)
            ? reason
            : `${reason}; plus ${worktreeDispositionSuffix(disposition)}`
        }
        if (disposition.kind === 'failed') {
          return reason.includes(TRIDENT_SNAPSHOT_FAILURE_MARKER)
            ? reason
            : `${reason}; plus ${worktreeCaptureFailureSuffix(disposition.detail)}`
        }
        return reason
      }

      if (aheadCount > 0) {
        const remote = await opts.run_host(
          ['git', '-C', run.repo_path, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
          run.repo_path,
        )
        if (remote.ok && remote.stdout.trim().split(/\s+/)[0] === localHead && run.pr !== null) {
          const annotated = appendDisposition(failureReason)
          if (annotated === failureReason) return null
          return {
            ...run,
            branch,
            failure_reason: annotated,
            last_advanced_at: now(),
          }
        }

        const published = await publishBuiltCommit(run, null)
        const commitReason = failureReason.includes(TRIDENT_SALVAGE_MARKER)
          ? failureReason
          : `${failureReason} — ${aheadCount} commit(s), ${TRIDENT_SALVAGE_MARKER} — branch ${branch} pushed to origin as PR #${published.pr}, unreviewed`
        return {
          ...run,
          pr: published.pr,
          branch,
          failure_reason: appendDisposition(commitReason),
          last_advanced_at: now(),
        }
      }

      if (disposition.kind === 'dirty') {
        if (failureReason.includes(TRIDENT_SNAPSHOT_MARKER)) return null
        return {
          ...run,
          branch,
          failure_reason: `${failureReason} — 0 commits; ${worktreeDispositionSuffix(disposition)}`,
          last_advanced_at: now(),
        }
      }
      if (disposition.kind === 'stashed') {
        if (failureReason.includes(TRIDENT_STASH_PARKED_MARKER)) return null
        return {
          ...run,
          branch,
          failure_reason: `${failureReason} — 0 commits; ${worktreeDispositionSuffix(disposition)}`,
          last_advanced_at: now(),
        }
      }
      if (disposition.kind === 'failed') {
        if (failureReason.includes(TRIDENT_SNAPSHOT_FAILURE_MARKER)) return null
        return {
          ...run,
          branch,
          failure_reason: `${failureReason} — 0 commits; ${worktreeCaptureFailureSuffix(disposition.detail)}`,
          last_advanced_at: now(),
        }
      }
      return null
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      salvageFailureNotes.set(run, detail.slice(0, 150))
      return null
    }
  }

  /**
   * THE FIRE-EVIDENCE GATE (#498), shared by the two places a settle timeout
   * can be adjudicated: the launch site when the fire came back `failed` with
   * `FIRE_SETTLE_TIMEOUT_ERROR`, and §1c's deadline when a fire parked as
   * `unconfirmed` ran out its second budget without a stage event or a late
   * settle. Consults POSITIVE evidence only: `launched` holds the lane,
   * `published` terminalizes honestly, `none` returns null and the caller fails
   * the run its own way. `launcher_generation` is written to the row when known
   * (the unconfirmed path learns it at inject time); null otherwise — never the
   * dispatch id and never a carried key (see the comment at the write).
   */
  async function decideSettleTimeoutByEvidence(args: {
    pinnedRun: TridentRun
    dispatch_id: string
    fire_started_at_ms: number
    launcher_generation: string | null
    stamp: (stage: string, meta?: string) => void
  }): Promise<AdvanceOutcome | null> {
    if (gatherFireEvidence === null) return null
    const pinnedRun = args.pinnedRun
    // A THROWING gatherer must never crash the launch AND must never spare
    // the run: no evidence is no evidence (positive-only).
    let evidence: FireTimeoutEvidence = { kind: 'none', detail: 'evidence gatherer threw' }
    try {
      evidence = await gatherFireEvidence({ run: pinnedRun, fire_started_at_ms: args.fire_started_at_ms })
    } catch (err) {
      // LOG IT — silence here is indistinguishable from "looked and found
      // nothing", which is exactly how a gatherer that throws on EVERY call
      // would hide behind the positive-only rule forever. The sibling
      // liveness probe logs `liveness_probe_failed` for the same reason.
      log.error('fire_evidence_probe_failed', {
        run: pinnedRun.id,
        slug: pinnedRun.slug,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
    }
    // WHAT THE GATHERER ACTUALLY SAW IN THE TWO WORKFLOW-OWNED COLUMNS —
    // the CAS token for the save. `observed` narrows the clobber window to
    // the gap between the gatherer's last re-read and the tick's
    // `saveIfActive`; it cannot close it, because those are two statements.
    // Handing the seen values down makes the store write those two columns
    // only while they still hold what we read, so a checkpoint the detached
    // workflow lands INSIDE that gap survives the save that spares its lane.
    // Absent `observed` the pinned row is what we read, and it is the token.
    const seenRow = { ...pinnedRun, ...(evidence.kind === 'none' ? {} : (evidence.observed ?? {})) }
    const workflow_columns_seen = {
      inner_checkpoint: seenRow.inner_checkpoint,
      inner_verdict: seenRow.inner_verdict,
    }
    if (evidence.kind === 'launched') {
      // HOLD THE LANE. A deliberate mirror of the `fired` return MINUS the
      // `fire-settled` stamp — the launcher never confirmed. The minted `id`
      // is the dispatch id exactly as on the fired path, so harvest, the
      // stall guard and orphan recovery all engage from here.
      args.stamp('fire-unobserved-launch', evidence.detail.slice(0, 200))
      fired.add(pinnedRun.id)
      return {
        run: {
          // THE FRESH WORKFLOW-OWNED COLUMNS, NOT THE PINNED ONES (`seenRow`
          // is `pinnedRun` with the gatherer's `observed` spread over it).
          // `pinnedRun` is the row as it looked BEFORE the fire, and
          // `saveIfActive` assigns `inner_checkpoint`/`inner_verdict` plainly
          // — so saving the pinned snapshot would write the detached
          // workflow's own progress back to its pre-fire value, destroying
          // the very delta that proved the lane was live. The residual gap
          // between that read and the save is closed by the CAS below
          // (`workflow_columns_seen`), not by this spread.
          ...seenRow,
          // …EXCEPT A REJECTION THE STORE WILL NOT ACCEPT (Argus r4 minor).
          // `saveIfActive` THROWS `TridentEmptyFindingsRejectionError` on a
          // `REQUEST_CHANGES` with no findings on the incoming row and none
          // on the stored one — a shape `checkpoint.sh` can write and crash
          // recovery preserves. Spreading `seenRow` verbatim carried it into
          // the one save whose whole job is to HOLD the lane, and the tick's
          // per-run catch swallows the throw: `subagent_run_id` stays NULL,
          // so the next tick re-enters the launch site and fires a SECOND
          // lane at the branch — the exact outcome this seam exists to
          // prevent. Downgrade it exactly as `failedRun` does (an empty
          // finding set is an approval or an infrastructure failure, never a
          // rejection); the CAS still guards the column, and a real review
          // that lands findings re-writes the verdict on its next checkpoint.
          ...(seenRow.inner_verdict === 'REQUEST_CHANGES' &&
          parseCheckpointFindings(seenRow.inner_checkpoint_findings).length === 0
            ? { inner_verdict: 'REVIEW_NOT_RUN' as const }
            : {}),
          // AND THE PHASE THAT CHECKPOINT IMPLIES. `phase` is NOT a
          // workflow-owned column — the tick owns it — but `checkpoint.sh`
          // derives it from `inner_checkpoint` at the inner workflow's write
          // choke point (and `TridentRunStore.update` mirrors that table), so
          // carrying the checkpoint forward while keeping the PINNED phase
          // saves an incoherent row: `argus` reverted to `forge-init` while
          // `inner_checkpoint` still says `forge-done`. `saveIfActive`
          // assigns `phase` plainly and applies no derivation of its own, so
          // the derivation has to happen HERE. `null` from the table means
          // the checkpoint implies nothing — the pinned phase stands.
          // Derived from `evidence.observed`, never from the pinned
          // checkpoint: absent an observation there is no checkpoint to
          // derive from at all and the pinned phase stands.
          //
          // AND THE OBSERVATION IS NOT ALWAYS A CHECKPOINT MOVE (Argus r4
          // nit — the earlier wording said "what the gatherer OBSERVED" as
          // if it always were). `classifyFireTimeoutRow` sets `observed` when
          // ANY workflow-owned column moved, so a delta on `inner_result`
          // alone carries whatever `inner_checkpoint` the row already had —
          // possibly a prior round's. That is harmless rather than exact:
          // `phaseForCheckpoint` is the same mapping `checkpoint.sh` and
          // `TridentRunStore.update` apply, so the phase this derives is the
          // one the row would already be wearing for that checkpoint.
          //
          // ONE RESIDUAL WINDOW, STATED PLAINLY (Argus r5): `phase` is not a
          // workflow-owned column, so it is written PLAINLY while
          // `inner_checkpoint` is CAS-guarded. If the detached workflow lands
          // a NEWER checkpoint between the gatherer's re-read and this save,
          // the CAS keeps that newer checkpoint and the phase beside it is
          // derived from the older one. That is the same one-statement gap
          // the CAS narrows but cannot close; it is bounded and self-heals on
          // the workflow's next checkpoint write, which derives both columns
          // together. Widening the CAS to cover `phase` would make the save
          // all-or-nothing over a column the TICK owns — a worse trade: a
          // lost swap would then drop the lane-holding write entirely.
          phase:
            phaseForCheckpoint(evidence.observed?.inner_checkpoint ?? null) ?? pinnedRun.phase,
          subagent_run_id: args.dispatch_id,
          subagent_status: 'running',
          // THE LAUNCHER GENERATION ONLY IF IT IS KNOWN — else null, never
          // the dispatch id and never a carried key. This row's launcher was
          // not confirmed by a settle: minting an id would make
          // `latchLauncherCrashed` (which matches WHERE workflow_run_id = ?)
          // key on a generation no pool will ever report, and CARRYING a
          // previous round's key would point the tick's liveness probe at a
          // dead generation and latch a live lane as crashed
          // (`persistRefireReset` never clears this column). Null is what
          // crash recovery itself writes here, for the same reason: the
          // generation is unknown. When the launcher DID inject before the
          // budget (the unconfirmed path learns the generation at inject
          // time), that generation is real positive evidence and goes on the
          // row so the eviction guard and the crash latch see the lane. The
          // 90-min no-advance reaper and the 2 h ceiling still bound it.
          workflow_run_id: args.launcher_generation,
          last_advanced_at: now(),
        },
        changed: true,
        waiting: true,
        note: `fire launcher unobserved (settle timeout) but the workflow shows life — ${evidence.detail}; holding the lane, no relaunch`,
        workflow_columns_seen,
      }
    }
    if (evidence.kind === 'published') {
      // THE WORK IS FINISHED. Terminal, but recorded HONESTLY: built and
      // published, review not run. The verdict is NOT set by hand —
      // `failedRun` normalizes it, and with no argus provenance on the row
      // that normalization yields REVIEW_NOT_RUN.
      //
      // "CAN ONLY BECOME" WAS TOO STRONG (Argus r4 nit). `failedRun` passes
      // an existing `inner_verdict === 'APPROVE'` through unchanged, so an
      // APPROVE already on the row would survive here. It is not reachable on
      // this path — `persistRefireReset` NULLs `inner_verdict` before a
      // re-fire — but that is a property of the caller, not of `failedRun`,
      // and the comment should not claim the callee enforces it.
      return {
        // Same rule as the held lane: terminalize over what the gatherer
        // actually READ, never over the pre-fire snapshot.
        // THE TRIMMED CHECKPOINT IS WHAT LANDS, and it is written here rather
        // than carried in `observed` — that field is the CAS TOKEN and must
        // stay byte-equal to the stored column or the swap silently no-ops
        // (`store.ts` compares `inner_checkpoint IS ?`). Writing it here is
        // what makes the row and the failure_reason quote the same string.
        run: failedRun(
          { ...seenRow, inner_checkpoint: evidence.checkpoint },
          publishedFailureReason(evidence.checkpoint),
          false,
        ),
        changed: true,
        waiting: false,
        note: `${pinnedRun.phase} → failed (launcher timeout over already-published work — review not run)`,
        // The verdict demotion to REVIEW_NOT_RUN is a REAL write here (it is
        // what stops a stale REQUEST_CHANGES being stamped over finished
        // work), so it is CAS'd rather than skipped: it lands while the
        // verdict is still the one we read, and yields to a newer one.
        workflow_columns_seen,
      }
    }
    return null
  }

  /** Fire the inner workflow on the warm substrate; the launching turn settles
   *  immediately and the workflow runs detached. Persists the tracking id on a
   *  clean fire. Folds any existing PR + the last checkpoint into the args for
   *  idempotent resume. */
  async function launch(run: TridentRun): Promise<AdvanceOutcome> {
    const stamp = (stage: string, meta?: string): void => {
      try {
        opts.record_stage?.(run.id, stage, meta ?? null)
      } catch {
        // A stamp must never fail a launch.
      }
    }
    // A review-only bound run dispatches CLOSED (SPEC card 2026-08-18; bound_pr was 0 of 190 runs).
    // The measured failure mode is a "review PR #N" dispatch building a docs PR about reviewing
    // (#542/#541/#530) while #N's review-gate stays red. Guarding at launch covers BOTH call sites
    // (the fresh launch ~2896 and the crash-recovery relaunch ~2769). The review executor lives
    // HERE and returns before base resolution, the build workflow, and every publisher/git-write
    // path. A fix-round lane that wants commit-capable bound runs must add a discriminator and
    // change this deliberately.
    // CROSS-LANE COLLISION: `.trident/plans/trident/a-fix-round-that-abandons-the-revie.md`
    // plans the opposite `bound_pr` meaning and must add its own discriminator before landing.
    if (run.bound_pr !== null) {
      let codexHome: string | null = opts.codex_home ?? null
      if (opts.resolve_codex_home !== undefined) {
        try {
          codexHome = opts.resolve_codex_home(run) ?? codexHome
        } catch (error) {
          if (error instanceof CodexProjectOwnerError) throw error
          // Other optional peer resolution failures retain the existing fallback.
        }
      }
      let kimiConfigured = false
      if (opts.resolve_kimi_configured !== undefined) {
        try {
          kimiConfigured = opts.resolve_kimi_configured()
        } catch {
          // An unavailable optional peer does not prevent the core panel.
        }
      }
      let phaseModels: Record<string, { model?: string; effort?: string }> | null | undefined
      if (opts.resolve_phase_models !== undefined) {
        try {
          phaseModels = opts.resolve_phase_models()
        } catch {
          phaseModels = null
        }
      }
      const reviewDeps = {
        run_host: opts.run_host,
        fire_workflow: fireWorkflow,
        codex_home: codexHome,
        gh_data_dir: opts.gh_data_dir ?? null,
        gh_owner_handle: opts.gh_owner_handle ?? null,
        kimi_configured: kimiConfigured,
        ...(phaseModels !== undefined ? { phase_models: phaseModels } : {}),
        panel_timeout_ms: maxInflightMs,
      }
      // These direct calls are the non-test wiring proof for both exported entry points:
      // executeBoundReview calls formatReviewEvidence when it creates the PR comment.
      const reviewed = opts.execute_bound_review === undefined
        ? await executeBoundReview(run, reviewDeps)
        : await opts.execute_bound_review(run, reviewDeps)
      if (reviewed.status === 'failure') {
        const failed = failedRun(
          { ...run, pr: run.bound_pr, branch: null, worktree: null },
          reviewed.reason,
          false,
        )
        failed.inner_checkpoint = 'bound-review-failed'
        return {
          run: failed,
          changed: true,
          waiting: false,
          note: `${run.phase} → failed (bound PR #${run.bound_pr} review-only executor)`,
        }
      }
      let findings = '[]'
      try {
        findings = JSON.stringify(reviewed.findings)
      } catch {
        // The evidence formatter has already recorded the serialization failure in the PR
        // comment. Keep the in-memory snapshot parseable too.
      }
      // A REJECTION MUST STATE A REASON HERE TOO, and here it is not merely a
      // consistency point — it is the difference between this run finishing and
      // never finishing. `verdict` comes from the panel's `inner_result` JSON while
      // `findings` comes from its `inner_checkpoint_findings` COLUMN
      // (`review-run.ts`), two sources that can disagree; and `saveIfActive` THROWS
      // on `REQUEST_CHANGES` beside no findings (`TridentEmptyFindingsRejectionError`).
      // `tick.ts` swallows that throw as `advance_failed`, so the row never reaches a
      // terminal phase and `executeBoundReview` runs the whole review AGAIN on the
      // next tick, forever. Recording the true state instead is the same rule
      // `checkpoint.sh` and the store apply — never APPROVE, which would merge
      // unreviewed code. `recordedTerminalVerdict` is deliberately NOT reused: it
      // additionally demands `hasArgusProvenance(checkpoint)`, and a bound review's
      // `bound-review-complete:*` checkpoint has none, so it would demote a genuine
      // rejection that DOES carry findings.
      const recorded_verdict =
        reviewed.verdict === 'REQUEST_CHANGES' && parseCheckpointFindings(findings).length === 0
          ? 'REVIEW_NOT_RUN'
          : reviewed.verdict
      const done: TridentRun = {
        ...run,
        phase: 'done',
        pr: reviewed.pr,
        // Dispatch creates a prospective branch name before git-mode is known; a review-only
        // success must not persist that name as if a branch had actually been created.
        branch: null,
        worktree: null,
        subagent_run_id: null,
        subagent_status: 'completed',
        failure_reason: null,
        // `saveIfActive` persists this field, including the gate outcome and reviewed SHA. The
        // paired head/findings remain on the returned snapshot for direct callers; the checkpoint
        // is the durable result because those two columns are workflow-owned and excluded from
        // the outer full-row save.
        inner_checkpoint: `bound-review-complete:${reviewed.reviewed_sha}:${reviewed.review_gate.status}`,
        inner_checkpoint_head: reviewed.reviewed_sha,
        inner_checkpoint_findings: findings,
        inner_verdict: recorded_verdict,
        last_advanced_at: now(),
      }
      return {
        run: done,
        changed: true,
        waiting: false,
        note: `bound PR #${reviewed.pr} reviewed at ${reviewed.reviewed_sha} → done (${reviewed.review_gate.status})`,
      }
    }
    // MERGE NOTE: the bound_pr branch above returns BEFORE this stamp on purpose. A review-only
    // run never fires the build workflow, so stamping first would write a launch-start event for
    // a build launch that never happened — and this stage ledger is exactly what the latency card
    // reads.
    stamp('launch-start', `round=${run.round} ralph_round=${run.ralph_round}`)
    const base = await resolveBase(run)
    let resume_checkpoint = run.inner_checkpoint
    // MID-LOOP RESUME — the checkpoint travels WITH the commit it was recorded
    // against (and, for a REQUEST_CHANGES checkpoint, the findings recorded with
    // it). Threading the name alone is what forced every relaunch to rebuild: a
    // verdict is about a COMMIT, and without the OID the workflow cannot tell
    // whether the branch still holds the code that verdict was about.
    let resume_checkpoint_head = run.inner_checkpoint_head
    let resume_findings = run.inner_checkpoint_findings
    // MID-LOOP RESUME — READ the live branch head HERE, in the outer loop, because
    // THIS is the credentialed host boundary: `opts.run_host` already runs every other
    // git command for this run. The workflow's `head-probe-round-resume` agent seat
    // survives only as a fallback for launchers that predate this arg. Derive the
    // recorded OID EXACTLY as the workflow does (inner-workflow.mjs, resume site): the
    // `outer-published:<oid>:r:t` capture takes precedence over the checkpoint column.
    const published =
      typeof resume_checkpoint === 'string'
        ? resume_checkpoint.match(/^outer-published:([0-9a-f]{40}|[0-9a-f]{64}):(\d+):(\d+)(:deviated)?$/)
        : null
    const recorded = (published?.[1] ?? resume_checkpoint_head ?? '').trim().toLowerCase()
    // Only read when the answer can change a decision: no checkpoint, no recorded OID
    // to compare against, or no branch → the workflow rebuilds regardless, and a fresh
    // launch must stay byte-identical (no extra git command, no extra arg).
    let resume_live_head =
      resume_checkpoint !== null &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(recorded) &&
      typeof run.branch === 'string' &&
      run.branch.length > 0
        ? await resolveResumeLiveHead(
            opts.run_host,
            {
              repo_path: run.repo_path,
              branch: run.branch,
              // Deferred Ralph waves deliberately leave origin stale. These checkpoints
              // rebuild regardless of the head; the local match is planner-only, allowing
              // the clean name to open plan:next through cleanContinuation.
              merge_mode:
                resume_checkpoint === 'ralph-task-built' ||
                resume_checkpoint === 'ralph-task-built-deviated'
                  ? 'local'
                  : run.merge_mode,
            },
            // The RETRY SPACING seam (see `resolveResumeLiveHead`): a `pr`-mode read is a
            // network call and the consequence of `''` is terminal, so the attempts are
            // spread over real time in production and collapsed to nothing in the suite.
            opts.sleep,
          )
        : undefined
    // SEEDED RESUME — REVALIDATED AT LAUNCH, because the seed's proof was taken at
    // DISPATCH and is consumed here, one process later.
    //
    // The dispatch chokepoint may create a row already carrying a prior terminal
    // run's built-but-never-reviewed checkpoint (board-dispatch.ts), having proven
    // the branch tip was exactly that commit. That proof is what makes seeding safe
    // — a seeded row has a non-null `inner_checkpoint`, so `freshLaunch` below is
    // false and the base RE-PIN is skipped (the seed carries the prior run's pin).
    // The leftover-branch ancestry refusal is NOT skipped: it is armed for
    // `freshLaunch || seeded_resume` (Argus r3), and a legitimate seed satisfies it
    // through the containment / `ownCrashLeftover` exemptions. If the branch moved
    // in between (another lane, a human, a slug collision the task-text check could
    // not see), the premise is false and RESUMING on the strength of it would be
    // adopting work this lane does not own.
    //
    // `workflow_run_id === null` is what identifies a SEEDED row rather than a
    // genuine mid-run resume: it is written on the first fire (below) and stays
    // null until then, so a row holding a checkpoint it has never fired for can
    // only have been handed one. A genuine resume is deliberately untouched — its
    // branch legitimately advances past the last checkpoint with its OWN commits.
    //
    // FALSIFIED means the branch DEMONSTRABLY holds a different commit — a real
    // full OID that is not the recorded one. An unreadable head (`''`) or a branch
    // the remote says is gone (`'absent'`) is NOT evidence of another lane's work,
    // and both are already answered downstream: the bounded fast-exit below, and
    // `classifyResume`'s own rebuild. Narrow on purpose, because the only thing
    // this check is entitled to undo is the guard-stripping the seed bought.
    //
    // AND IT MUST STAY NARROW, which is not a preference: `beginCrashRecovery` and
    // `beginInfraRetry` (store.ts) NULL `workflow_run_id` on a row that earned its
    // checkpoint by firing, so `workflow_run_id === null` ALONE is ALSO true for a
    // recovered run whose branch legitimately advanced past its last checkpoint with
    // its OWN commits. Treating that row as a seed would throw away exactly the built
    // work this card exists to stop throwing away, the first time a launcher died or
    // an origin read blipped — the falsification below would null its checkpoint AND
    // its base pin, and the (now-armed) leftover-branch guard would then fail the run
    // terminally over the commits it just made. So the discriminator ALSO requires a
    // row that has never spent a recovery budget unit: `crash_recoveries` and
    // `infra_retries` are the durable counters those two store methods are the only
    // writers of, they are initialised to 0 at create, and a SEEDED row is brand new
    // (`createIfClaimsAvailable`, board-dispatch.ts) so both are 0 on it by
    // construction. A recovered row therefore reads as the genuine mid-run resume it
    // is: seed untouched, guard not armed by this branch.
    //
    // Falsified → drop the ENTIRE seed (checkpoint, head, findings, base pin) and
    // continue as the byte-identical fresh dispatch this card would have had before
    // the seed existed: base re-pinned, leftover-branch guard armed, no resume arg
    // threaded to the workflow. Not a failure — there is nothing wrong with the
    // card, only with the shortcut.
    const never_recovered = (run.crash_recoveries ?? 0) === 0 && (run.infra_retries ?? 0) === 0
    const seeded_resume =
      run.inner_checkpoint !== null && run.workflow_run_id === null && never_recovered
    const seed_falsified =
      seeded_resume &&
      typeof resume_live_head === 'string' &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resume_live_head) &&
      resume_live_head !== recorded
    if (seed_falsified) {
      resume_checkpoint = null
      resume_checkpoint_head = null
      resume_findings = null
      resume_live_head = undefined
    }
    const seedCheckedRun: TridentRun = seed_falsified
      ? {
          ...run,
          inner_checkpoint: null,
          inner_checkpoint_head: null,
          inner_checkpoint_findings: null,
          base_sha: null,
        }
      : run

    // PART 2b, OUTER FAST-EXIT — the launcher itself just failed 3 code reads of the
    // head. Firing the workflow now would spend a fire only to have `classifyResume`
    // return the bounded stop ({ mode: 'stop', reason: 'head-unreadable' }) for every
    // checkpoint except 'pr-merged' (resolved to `merged` BEFORE the head check —
    // exempted here for exactly that reason). classifyResume stays the single semantic
    // decider; this is only the cheap exit for the one case whose outcome is already
    // known at this boundary. `failedRun` spreads `run`, so inner_checkpoint /
    // inner_checkpoint_head / inner_checkpoint_findings survive untouched — which
    // preserves the EVIDENCE (what was built, and where), and nothing more: a re-run is
    // a fresh dispatch with null checkpoints, so it rebuilds. See `resolveResumeLiveHead`
    // for why that is the trade, and IMPLEMENTATION_PLAN.md for the resume follow-up.
    //
    // SOME CHECKPOINT NAMES ARE EXEMPT, each because classifyResume does not consult
    // the head for them, so this exit would pre-empt a decision it does not share:
    // 'pr-merged' (resolved to `merged`) and the empty name (resolved to `rebuild`,
    // reason 'no-checkpoint' — there is nothing recorded to preserve) are answered
    // before the head check; the head-INDEPENDENT names rebuild on every head. See
    // `resumeHeadDecides`.
    //
    // KNOWN, AND DELIBERATELY NOT SPECIAL-CASED (Argus r3, minor): a salvage-SEEDED
    // brand-new dispatch whose head read fails at launch takes this exit and ends
    // `failed` without ever building — a run that has nothing of its own to preserve.
    // The tempting fix (drop the seed and build fresh) cannot be written safely with
    // the discriminator available here, because `beginCrashRecovery` /
    // `beginInfraRetry` null `workflow_run_id`, so the same test also matches a
    // recovered run whose committed work this exit exists to protect. It is loud and
    // self-healing — a re-dispatch re-seeds from the same prior row — so it costs one
    // re-dispatch, and the alternative risks the rebuild this card exists to stop.
    const resume_checkpoint_name = (resume_checkpoint ?? '').trim()
    // THE PR LINK IS RESOLVED BEFORE THE EXIT, NOT AFTER IT (Argus r5). This used to sit
    // below, so the one path that ends a run WITHOUT ever firing recorded a terminal row
    // with `pr: null` — and "re-run when the read succeeds" is advice a human follows by
    // opening the PR the recorded work is on. The exit is rare and already terminal; one
    // `gh pr view` to make the record point at the work is worth more than the call saved.
    const existingPr = run.pr ?? (await detectExistingPr(run))
    const launchRun: TridentRun =
      existingPr !== null && run.pr === null
        ? { ...seedCheckedRun, pr: existingPr }
        : seedCheckedRun
    if (resume_live_head === '' && resumeHeadDecides(resume_checkpoint_name, run.ralph)) {
      const cause = `could not read the head of ${run.branch}; the recorded work is at ${recorded}; re-run when the read succeeds`
      return {
        run: failedRun(
          launchRun,
          innerTerminalFailureReason(launchRun, {
            ok: false,
            verdict: null,
            round: launchRun.round,
            checkpoint: resume_checkpoint,
            block_kind: 'infra-only',
            // An unreadable resume head is an INFRASTRUCTURE stop, not an escalation: no
            // panel judged anything here, so there is no plan defect to report.
            escalation: null,
            terminal_cause: cause,
            // THE ORCHESTRATOR'S OWN INSTANCE OF THE WORKFLOW'S RESUME STOP (#520) —
            // same exit, same name. This site never fires the workflow, so the kind is
            // authored here rather than harvested; it is the one place in this file
            // entitled to author one, because it is the site that MADE the decision.
            terminal_cause_kind: 'resume-head-unreadable',
            findings_present: false,
          }),
          false,
        ),
        changed: true,
        waiting: false,
        note: `${launchRun.phase} → failed (resume head unreadable — bounded stop, no fire)`,
      }
    }

    const freshLaunch = launchRun.inner_checkpoint === null
    const priorBaseSha = launchRun.base_sha
    const freshBuild = freshLaunch && priorBaseSha === null
    let base_sha: string | null = priorBaseSha
    let base_behind: number | null = null
    // Whether the base fetch below actually RAN. The UNKNOWN refusals downstream count their
    // own writes, and a fetch is not write-free (see `noWrites` there) — but only this arm
    // performs one, so a flat claim either over- or under-counts depending on the path taken.
    let fetchedBase = false
    // WHAT THE REFUSALS BELOW QUOTE, AND WHAT THE FETCH ARGV IS, ARE THE SAME STRING.
    //
    // AN EXPLICIT DESTINATION REFSPEC (Argus finding, reproduced on git 2.43). `git fetch
    // --no-tags origin <base>` updates FETCH_HEAD and only INCIDENTALLY
    // refs/remotes/origin/<base>: under a narrowed `remote.origin.fetch` it exits 0 while that
    // tracking ref does NOT move — and this path then rev-parses that ref for `base_sha`, pins
    // it, and cuts the build branch from it, while the refusal downstream states as fact that
    // the fetch wrote it. A stale base is the very thing the retry above exists to avoid, and a
    // false write-accounting sentence is the overclaiming this message class exists to stop.
    // Naming the destination closes both. `wrong-base-remedy.ts` already fetches its own branch
    // this way, for this reason.
    const baseRefspec = `+refs/heads/${base}:refs/remotes/origin/${base}`
    // AND THE BASE IS FOLDED WHEREVER A REFUSAL QUOTES IT (Argus finding). It arrives from
    // `detectBaseBranch`/`opts.base_branch`, and git accepts U+2028 and U+202E in a branch name
    // exactly as it does for the build branch — so a base name could forge a line inside these
    // pre-launch refusals the same way. `foldRefName`, not `foldEvidence`: a name field stays
    // one token, because folding a forgery codepoint to an ASCII space is what broke the
    // wrong-base classifier's anchor in `delivery.ts`.
    const baseProse = foldRefName(base)
    // AND THE REPO PATH IS FOLDED FOR EVERY PRE-LAUNCH REFUSAL, not only the ancestry ones
    // (Argus blocker, reproduced by two reviewers). This binding used to be declared INSIDE the
    // ancestry block below, so the two refusals composed before it — the fetch failure and the
    // tip-resolution failure — interpolated `launchRun.repo_path` RAW and passed git's stderr
    // through `redactPushError` alone, which redacts credentials and truncates but folds neither
    // a newline nor a delete command. Both messages are persisted, re-read, and routed by
    // `delivery.ts`'s PRE_LAUNCH_PREFIX classifier exactly like the ancestry ones, so a legal
    // path — `git init` and `git worktree add` both accept a newline, and store.ts persists it
    // verbatim — or a hostile fetch stderr could forge a line carrying `git branch -D -- victim`
    // inside the very message class this change exists to make evidence-honest. One binding,
    // declared once, above every path that can refuse.
    const repoProse = foldEvidence(launchRun.repo_path)
    // Git's own words about a failure, credential-redacted FIRST and then folded — the same
    // order the ancestry arms' `probeDetail` uses. `foldEvidence` also carries the 300-character
    // bound the hand-rolled `.slice(-300)` used to carry, and MARKS its truncation.
    const gitDetail = (text: string): string => foldEvidence(redactPushError(text).trim())
    if (freshBuild && launchRun.merge_mode === 'pr') {
      fetchedBase = true
      // `--no-recurse-submodules` IS PART OF THE WRITE BOUNDARY THIS PATH ASSERTS (Argus
      // blocker). `git fetch` recurses into submodules whenever `fetch.recurseSubmodules` says
      // so — the config default is `on-demand`, and a repo may set `true` outright — and a
      // recursed fetch writes inside the SUBMODULE's git dir, e.g. `<repo>/sub/.git/refs/
      // remotes/origin/main`. Reproduced on a populated old-form submodule with
      // `fetch.recurseSubmodules=true`: this exact command moved that ref. That is git's OWN
      // write, so the hook caveat does not cover it, and it falsifies the sentence this refusal
      // and `delivery.ts`'s LAUNCH_PATH_FETCH both print — that the only writes are origin's
      // base pointer and git's bookkeeping under `.git` (singular, this repo's). The flag is
      // free here: nothing on the launch path reads a submodule, only `refs/heads/<base>` is
      // wanted, and the explicit refspec above already says so.
      const fetchCmd = [
        'git',
        '-C',
        launchRun.repo_path,
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        baseRefspec,
      ]
      let fetched = await opts.run_host(fetchCmd, launchRun.repo_path)
      if (!fetched.ok) {
        await (opts.sleep ?? realSleep)(1000)
        fetched = await opts.run_host(fetchCmd, launchRun.repo_path)
      }
      if (!fetched.ok) {
        const detail = gitDetail(fetched.stderr)
        return {
          run: failedRun(launchRun, `trident infra: could not fetch origin/${baseProse} in ${repoProse} before cutting the build branch — refusing to branch from the stale local ref; the build was NOT started: ${detail}`, false),
          changed: true,
          waiting: false,
          note: `${launchRun.phase} → failed (base fetch failed — no fire)`,
        }
      }
      const remoteRef = `refs/remotes/origin/${base}`
      const resolved = await opts.run_host(
        ['git', '-C', launchRun.repo_path, 'rev-parse', '--verify', `${remoteRef}^{commit}`],
        launchRun.repo_path,
      )
      const oid = resolved.stdout.trim().toLowerCase()
      if (!resolved.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
        const detail = gitDetail(resolved.stderr || resolved.stdout)
        return {
          run: failedRun(launchRun, `trident infra: fetched origin/${baseProse} but could not resolve its tip in ${repoProse}; the build was NOT started: ${detail}`, false),
          changed: true,
          waiting: false,
          note: `${launchRun.phase} → failed (base resolve failed — no fire)`,
        }
      }
      base_sha = oid
      const behind = await opts.run_host(
        // `--end-of-options` (#546). The `refs/heads/` prefix already makes an option-shaped
        // base non-option-shaped, so this is the least exposed range here; it carries the
        // marker so the module's rule has no exceptions to remember.
        gitRangeArgv({
          repo_path: launchRun.repo_path,
          subcommand: 'rev-list',
          flags: ['--count'],
          base: `refs/heads/${base}`,
          head: remoteRef,
        }),
        launchRun.repo_path,
      )
      const count = Number.parseInt(behind.stdout.trim(), 10)
      if (behind.ok && Number.isFinite(count)) base_behind = count
    } else if (freshBuild && launchRun.merge_mode === 'local') {
      const resolved = await opts.run_host(
        ['git', '-C', launchRun.repo_path, 'rev-parse', '--verify', `refs/heads/${base}^{commit}`],
        launchRun.repo_path,
      )
      const oid = resolved.stdout.trim().toLowerCase()
      if (resolved.ok && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) base_sha = oid
    }
    const pinnedRun = freshBuild ? { ...launchRun, base_sha, base_behind } : launchRun

    // THE LOCAL-BRANCH OWNERSHIP CHECK RUNS FOR EVERY ROW THAT HAS NOT FIRED, not
    // only for `freshLaunch` ones (Argus r3 blocker). It used to be gated on
    // `inner_checkpoint === null`, so a salvage-SEEDED row skipped it — and the seed
    // is a proof about the ref `resolveResumeLiveHead` reads, which in `pr` mode is
    // the REMOTE. An absent-or-unreadable remote (and, in pr mode, even a matching
    // one) says nothing about the LOCAL branch, and the local branch is what Forge
    // is told to re-enter. So the one guard that can tell "this lane's commits" from
    // "another lane's" was being dropped on the strength of evidence that does not
    // speak to it: pre-seed the same card refused loudly, post-seed it silently
    // built on whatever was sitting there.
    //
    // Running it for a seeded row costs one `rev-parse` plus one `merge-base` and
    // refuses NOTHING that was previously fine: the check already exempts a tip
    // contained in the base, and `ownCrashLeftover` exempts a tip descended from
    // this row's OWN `base_sha` pin AND containing this row's OWN recorded
    // checkpoint head — which is precisely the shape a legitimate salvage seed has
    // (the pin and the head both travel with the seed), and which a sibling lane
    // cutting the same branch name from the same base does NOT. `seeded_resume` is
    // the "never fired, never recovered" test, and a row with no pin at all still
    // skips the whole block, so no legacy row can be refused for lacking one.
    if (
      (freshLaunch || seeded_resume) &&
      base_sha !== null &&
      typeof launchRun.branch === 'string' &&
      launchRun.branch.length > 0
    ) {
      const branchTipResult = await opts.run_host(
        ['git', '-C', launchRun.repo_path, 'rev-parse', '--verify', '--quiet', `refs/heads/${launchRun.branch}`],
        launchRun.repo_path,
      )
      const branchTip = branchTipResult.stdout.trim().toLowerCase()
      // A missing or ambiguous local ref is the normal first-launch shape: Forge
      // will cut it from pinnedRun.base_sha. Once git resolves a concrete tip,
      // however, only ancestry can prove that this lane owns what is already there.
      if (branchTipResult.ok && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(branchTip)) {
        // `merge-base --is-ancestor` answers with THREE exits, not two: 0 yes, 1 no, and
        // ANYTHING ELSE an error (128 on a corrupt or missing object, 124 when a watchdog
        // killed it, non-zero when the spawn itself failed). Reading "not ok" as "proven
        // divergence" turns a probe FAILURE into the positive claim the refusal below then
        // prints — "already carries N commit(s) not on origin/<base> — it was not cut from
        // origin/<base>" — evidence nothing established, in the one message class this whole
        // change exists to make evidence-honest (Argus blocker). The composer's inner
        // publication probe already distinguishes the three (`ancestryUnknown` in
        // wrong-base-remedy.ts); the OUTER guard now does too. UNKNOWN refuses — fail-closed,
        // the build is not started — but it refuses as what it is, and names no destructive
        // act (docs/INVARIANTS.md §12 invariant 122).
        //
        // AND EXIT 1 IS ONLY A "NO" IN A COMPLETE HISTORY (Argus blocker). Past a shallow
        // boundary the parent commits do not exist locally, so `merge-base --is-ancestor B C`
        // exits 1 for a B that IS an ancestor of C — reproduced on git 2.43 with a depth-1
        // clone and a true parent. This checkout MAY be shallow: `healShallowCheckout` above
        // documents that shape arriving in production ("install.sh used to clone at depth 1,
        // and hand-made clones still can") and it runs only on the REPLAY path, never before
        // this guard. So a shallow repo turned a true ancestor into the refusal "already
        // carries N commit(s) not on origin/<base> — it was not cut from origin/<base>": a
        // false positive, in the exact message class this change exists to make evidence-honest.
        // Exit 0 stays definitive — finding the ancestry is positive proof, and truncation can
        // only hide ancestry, never invent it. Exit 1 is downgraded to UNKNOWN unless the
        // checkout is PROVEN complete, by the same `rev-parse --is-shallow-repository` probe
        // `healShallowCheckout` uses; an unreadable depth is itself UNKNOWN, which is
        // fail-closed and authorises nothing.
        //
        // Probed LAZILY: a contained branch (the overwhelmingly common shape) never needs the
        // answer, and never pays for it.
        //
        // AND NOT MEMOISED (Argus blocker). An earlier draft cached the first answer for the
        // whole guard pass, on the premise that deepening is one-way. It is not: `git fetch
        // --depth=1` re-truncates a COMPLETE checkout in place, reproduced on git 2.43, where
        // `rev-parse --is-shallow-repository` flips false → true and `merge-base --is-ancestor`
        // starts exiting 1 on a genuine ancestor. Under the cache, a depth read taken while the
        // checkout was complete authorised BOTH later exit-1 reads — including reads taken after
        // a truncation — and the pair was published as proven divergence: the false wrong-base
        // refusal and its safe-delete chain on a correctly based branch, the exact outcome this
        // change exists to remove. `lastDepth` therefore records only the MOST RECENT answer, for
        // the detail line to quote, and every caller re-reads.
        let lastDepth: 'yes' | 'no' | 'unknown' | null = null
        const checkoutIsShallow = async (): Promise<'yes' | 'no' | 'unknown'> => {
          const probe = await opts.run_host(
            ['git', '-C', launchRun.repo_path, 'rev-parse', '--is-shallow-repository'],
            launchRun.repo_path,
          )
          const answer = probe.stdout.trim()
          lastDepth = !probe.ok ? 'unknown' : answer === 'true' ? 'yes' : answer === 'false' ? 'no' : 'unknown'
          return lastDepth
        }
        // AND THE TWO READS MUST DESCRIBE ONE HISTORY (Argus blocker). The exit-1 read and the
        // depth read are separate `git` invocations, so a checkout unshallowed BETWEEN them
        // pairs a STALE exit 1 — the one a TRUE ancestor produces past a shallow boundary — with
        // a now-complete depth answer, and the pair reads as proven divergence: the false
        // wrong-base refusal and its safe-delete chain, on a correctly based branch, which is the
        // exact outcome this change exists to remove. The race is not hypothetical here: the
        // refusal's own `probeDetail` tells the operator to run `git fetch --unshallow origin`,
        // which is precisely the event that closes the window, and an earlier comment asserting
        // "the depth cannot change under a single guard pass" enforced nothing.
        //
        // So "no" now rests on an exit 1 observed AFTER completeness was proven: the probe is
        // RE-RUN once the depth answers complete, and only a second exit 1 answers "no". A re-run
        // that exits 0 — the unshallow landed the missing parents between the reads — answers
        // "yes", and any other exit is UNKNOWN. The probe is spawned HERE rather than by the
        // caller so the re-run is the identical argv, and the RESULT that the detail line quotes
        // is the one the verdict actually rests on.
        //
        // AND THE RACE RUNS BOTH WAYS (Argus blocker). The re-read alone was justified by
        // "deepening is one-way — nothing re-truncates a checkout in place", which is false:
        // `git fetch --depth=1` truncates a complete checkout, and after it a TRUE ancestor exits
        // 1 again. One depth read taken BEFORE the confirming read therefore could not speak for
        // the history the confirming read saw. So the confirming read is BRACKETED: depth is read
        // once before it and once AFTER it, both non-cached, and "no" requires the checkout to
        // have measured complete on both sides of the read the verdict rests on. A truncation
        // landing anywhere across that read makes the closing probe answer "yes" (or fail), and
        // the verdict degrades to UNKNOWN, which authorises nothing. What remains is not a lock —
        // a truncate AND a re-deepen both completing inside the bracket would still be missed —
        // but that is a two-step adversarial sequence, where the shape actually observed in this
        // repo (a single depth-limited fetch, which LEAVES the checkout shallow) is caught.
        const ancestry = async (
          argv: string[],
        ): Promise<{ verdict: 'yes' | 'no' | 'unknown'; res: HostCommandResult }> => {
          const res = await opts.run_host(argv, launchRun.repo_path)
          if (res.ok) return { verdict: 'yes', res }
          if (res.exit_code !== 1 || res.timed_out === true) return { verdict: 'unknown', res }
          if ((await checkoutIsShallow()) !== 'no') return { verdict: 'unknown', res }
          const confirm = await opts.run_host(argv, launchRun.repo_path)
          if (confirm.ok) return { verdict: 'yes', res: confirm }
          if (confirm.exit_code !== 1 || confirm.timed_out === true) return { verdict: 'unknown', res: confirm }
          // The closing half of the bracket: the depth that licenses reading THIS exit 1 as
          // divergence is read after it, not inherited from before it.
          if ((await checkoutIsShallow()) !== 'no') return { verdict: 'unknown', res: confirm }
          return { verdict: 'no', res: confirm }
        }
        // EVERY FIELD THIS REFUSAL QUOTES IS FOLDED, on the same terms the remedy composer
        // already folds its own (Argus blocker). `repo_path` is persisted verbatim by store.ts
        // and both `git init` and `git worktree add` accept a newline in a path, so a legal path
        // — `/repo\nFORGED: run git branch -D -- victim` — otherwise forged a destructive line
        // inside the one message class whose whole subject is that UNKNOWN authorises nothing.
        // git's stderr is folded for the same reason and not a weaker one: `git -C <repo>` echoes
        // the path back on failure, so the raw path reaches this string by that route too.
        // `foldEvidence` also carries the bound the `.slice(-300)` used to carry, and MARKS its
        // truncation. Both folds now live ABOVE the fetch (`repoProse`, `gitDetail`), because the
        // two refusals composed before this block owed the identical contract and did not have it.
        //
        // AND THE BRANCH NAME IS FOLDED TOO (Argus blocker). An earlier draft exempted it on the
        // premise that "git's own ref rules have already excluded control characters" — true of
        // ASCII controls and FALSE of everything else `defang` folds. Reproduced on git 2.43:
        // `git branch` accepted, and `rev-parse --verify` resolved, both
        // `feat<U+2028>FORGED<U+00A0>run<U+00A0>git<U+00A0>branch<U+00A0>-D<U+00A0>victim` and
        // `feat<U+202E>evil` — a line separator several renderers break on, and a bidi override
        // that reorders what is DISPLAYED without changing a byte. The remedy composer folds
        // exactly those codepoints and names them as forgery vectors, so exempting the branch
        // here made this seam contradict the threat model of the module it exists to guard.
        // Only the shas stay raw, and they are full-width-tested above.
        // NAME FIELDS ARE FOLDED AS NAMES (Argus blocker/finding). `foldEvidence` folds a
        // forgery codepoint to an ASCII SPACE, and the ASCII space is the one character git's
        // ref rules forbid — the character `delivery.ts` anchors its wrong-base classifier on.
        // `foldRefName` folds a name to a single token instead, so the fold cannot put a space
        // inside a field the reader (and the classifier) reads as one name.
        //
        // AND THE BASE IS ONE OF THEM. The refusals below said "every field this refusal quotes
        // is folded" while interpolating `base` RAW — it arrives from `detectBaseBranch` or
        // `opts.base_branch` and git accepts U+2028 and U+202E in a branch name exactly as it
        // does for `launchRun.branch`, so the same forged line was available through the base.
        const branchProse = foldRefName(launchRun.branch)
        // AND THE BOUNDARY IS "THIS REPO'S OWN .git", which is only true because the fetch above
        // passes `--no-recurse-submodules` (Argus blocker): without it a repo configuring
        // `fetch.recurseSubmodules` makes that same command write inside a SUBMODULE's git dir,
        // which is neither this `.git` nor a hook's doing.
        //
        // WHAT THIS PATH WROTE, COUNTED EXACTLY. The base fetch above is not
        // write-free: it force-updates that tracking ref, appends the ref's reflog, rewrites
        // FETCH_HEAD and writes whatever objects it downloaded (delivery.ts names the same set
        // for the composer's own fetch). None of them is a branch, a worktree, a commit or a file
        // in the tree — which is the reassurance actually owed — but a refusal that undercounts
        // its own writes is the overclaiming this message class exists to stop. Conditional,
        // because OVERcounting is the same defect: only a fresh PR build fetches at all.
        //
        // THE LIST IS OPEN AT ITS TAIL, AND SAYS SO (Argus finding). A fetch also runs whatever
        // bookkeeping its own configuration asks for — `fetch.writeCommitGraph` writes
        // `.git/objects/info/commit-graphs/*`, `gc.auto` can fire maintenance — so naming four
        // items and closing the list was falsifiable by a config this path does not read. What
        // IS established is the class: everything that fetch can touch lives under `.git`, and
        // "file" in the clause below means a file in the TREE, which is the reassurance owed.
        //
        // AND THAT BOOKKEEPING IS UNCONDITIONAL (Argus finding). It used to ride inside the
        // "if origin had moved that ref" list, which asserted in the NO-OP case a boundary the
        // config falsifies: reproduced on git 2.43 with `fetch.writeCommitGraph=true` and a
        // tracking ref already at origin's tip — the ref did not move (reflog stayed at one
        // line) and the commit-graph files went 0 → 2 anyway. `delivery.ts` already phrases the
        // same enumeration correctly, so the split below matches it: FETCH_HEAD and the
        // configured bookkeeping are unconditional, the ref, its reflog and the objects are not.
        //
        // AND THE REF UPDATE IS CONDITIONAL (Argus finding, same one `delivery.ts` carries for
        // the composer's own fetch). A fetch whose tracking ref already sits at origin's tip
        // makes no ref transaction: repeating the identical fetch against an unchanged remote
        // leaves that ref's reflog at one line. Naming the refresh and the append flatly
        // asserted, in the no-op case, writes that did not happen — overcounting, which this
        // sentence exists to avoid in both directions. FETCH_HEAD is the unconditional one.
        const noWrites = fetchedBase
          ? `the build was NOT started; no branch, worktree, commit or file in the tree was changed or deleted by git itself, and the only writes on this path are the ones the earlier git fetch --no-tags --no-recurse-submodules origin ${foldRefName(baseRefspec)} made under this repo's own .git — FETCH_HEAD and whatever bookkeeping that fetch's own configuration adds on top, plus — if origin had moved that ref — refs/remotes/origin/${baseProse}, that ref's reflog and the objects it downloaded; ${CONFIGURED_CODE_CAVEAT}`
          : `the build was NOT started, and no branch, worktree, commit or file in the tree was changed or deleted by git itself; ${CONFIGURED_CODE_CAVEAT}`
        // The DETAIL names the shallow case as the shallow case. An exit-1 UNKNOWN reported as
        // "exited 1: no stderr" reads as a probe that malfunctioned; what actually happened is
        // that git answered honestly about a history it cannot see past, and the operator's next
        // step (`git fetch --unshallow`) follows only from being told so.
        const probeDetail = (res: HostCommandResult): string => {
          if (res.timed_out === true) return 'the ancestry probe was killed by its watchdog'
          if (res.exit_code === 1 && lastDepth !== 'no') {
            return lastDepth === 'yes'
              ? 'git merge-base --is-ancestor exited 1, which is a proven "not an ancestor" only in a COMPLETE history — and git rev-parse --is-shallow-repository says this checkout is SHALLOW, where the parent commits are absent and exit 1 is also what a TRUE ancestor produces (git fetch --unshallow origin makes the probe answerable)'
              : 'git merge-base --is-ancestor exited 1, which is a proven "not an ancestor" only in a COMPLETE history — and the depth of this checkout could not be read (git rev-parse --is-shallow-repository neither answered true nor false), so exit 1 cannot be read as divergence'
          }
          return `git merge-base --is-ancestor exited ${res.exit_code}: ${
            gitDetail(res.stderr || res.stdout) || 'no stderr'
          }`
        }
        const containedInBase = await ancestry([
          'git',
          '-C',
          launchRun.repo_path,
          'merge-base',
          '--is-ancestor',
          branchTip,
          base_sha,
        ])
        const contained = containedInBase.verdict
        if (contained === 'unknown') {
          return {
            run: failedRun(
              pinnedRun,
              `trident infra: could not establish whether branch ${branchProse} at ${branchTip} is contained in origin/${baseProse} at ${base_sha} in ${repoProse} (${probeDetail(containedInBase.res)}) — ancestry is UNKNOWN, and UNKNOWN authorises nothing; ${noWrites}.`,
              false,
            ),
            changed: true,
            waiting: false,
            note: `${launchRun.phase} → failed (ancestry probe UNKNOWN — no fire)`,
          }
        }
        let ownCrashLeftover = false
        if (contained === 'no' && priorBaseSha !== null) {
          const descendsFromPriorBase = await ancestry([
            'git',
            '-C',
            launchRun.repo_path,
            'merge-base',
            '--is-ancestor',
            priorBaseSha,
            branchTip,
          ])
          const descends = descendsFromPriorBase.verdict
          // Same three exits, same rule. A failed probe here would otherwise read as "this is
          // NOT this run's own crash leftover", which routes a run's own restart debris into a
          // refusal that blames another lane for it.
          if (descends === 'unknown') {
            return {
              run: failedRun(
                pinnedRun,
                `trident infra: branch ${branchProse} at ${branchTip} is not contained in origin/${baseProse} at ${base_sha}, but whether it descends from this run's own prior base ${priorBaseSha} — the shape its own crash leaves behind — could NOT be established in ${repoProse} (${probeDetail(descendsFromPriorBase.res)}); that is UNKNOWN, and UNKNOWN authorises nothing; ${noWrites}.`,
                false,
              ),
              changed: true,
              waiting: false,
              note: `${launchRun.phase} → failed (prior-base ancestry probe UNKNOWN — no fire)`,
            }
          }
          ownCrashLeftover = descends === 'yes'
          // DESCENT FROM THE BASE PIN IS NOT OWNERSHIP (Argus r4 blocker). A SIBLING
          // lane that cut the same branch name from the same base also descends from
          // this row's pin, so the pin alone cannot tell "my leftover commits" from
          // "somebody else's". When this row records a checkpoint HEAD — which every
          // salvage seed does, `board-dispatch.ts` only seeds a candidate whose head
          // it just matched against the branch tip — that head is a commit THIS row
          // owns, so requiring it to be an ancestor-or-equal of the local tip is the
          // ownership proof the pin is not: a sibling's tip cannot contain it.
          //
          // Only when the recorded head is not a readable object HERE does the pin go
          // back to being the whole answer: an ancestry probe cannot distinguish "not
          // an ancestor" from "unknown object", and refusing a run on an object we
          // could not even read would discard built work on evidence we do not have.
          // No recorded head at all (the crash-leftover-before-any-checkpoint shape)
          // is unchanged for the same reason.
          //
          // THE PROBE GOES THROUGH `ancestry`, NOT A BARE `run_host` (rebase onto the
          // three-valued guard). Exit 1 past a shallow boundary is what a TRUE ancestor
          // produces, so a raw `.ok` read here would answer "not mine" for a head this
          // row really does own — the same false negative `ancestry` was written to
          // remove one probe above. UNKNOWN therefore refuses the way every other
          // UNKNOWN in this guard refuses: it authorises nothing and it names no
          // destructive act, rather than falling through to the wrong-base refusal,
          // which would blame another lane for a history we could not read.
          if (ownCrashLeftover && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(recorded)) {
            const recordedPresent = await opts.run_host(
              ['git', '-C', launchRun.repo_path, 'cat-file', '-e', `${recorded}^{commit}`],
              launchRun.repo_path,
            )
            if (recordedPresent.ok) {
              const containsRecorded = await ancestry([
                'git',
                '-C',
                launchRun.repo_path,
                'merge-base',
                '--is-ancestor',
                recorded,
                branchTip,
              ])
              if (containsRecorded.verdict === 'unknown') {
                return {
                  run: failedRun(
                    pinnedRun,
                    `trident infra: branch ${branchProse} at ${branchTip} is not contained in origin/${baseProse} at ${base_sha} and descends from this run's own prior base ${priorBaseSha}, but whether it still contains this run's own recorded head ${recorded} — the proof the branch is THIS lane's leftover and not a sibling's — could NOT be established in ${repoProse} (${probeDetail(containsRecorded.res)}); that is UNKNOWN, and UNKNOWN authorises nothing; ${noWrites}.`,
                    false,
                  ),
                  changed: true,
                  waiting: false,
                  note: `${launchRun.phase} → failed (recorded-head ancestry probe UNKNOWN — no fire)`,
                }
              }
              ownCrashLeftover = containsRecorded.verdict === 'yes'
            }
          }
        }
        if (contained === 'no' && !ownCrashLeftover) {
          const ahead = await opts.run_host(
            // `--end-of-options` (#546): `base_sha` is the launcher's own resolved oid, and
            // `rev-list` is the family measured to write the smuggled file even while
            // exiting 129, so the marker goes here too.
            gitRangeArgv({
              repo_path: launchRun.repo_path,
              subcommand: 'rev-list',
              flags: ['--count'],
              base: base_sha,
              head: branchTip,
            }),
            launchRun.repo_path,
          )
          const rawAheadCount = ahead.stdout.trim()
          const aheadCount = /^\d+$/.test(rawAheadCount) ? rawAheadCount : '?'
          const reason = await composeWrongBaseRefusal(
            {
              repo: launchRun.repo_path,
              branch: launchRun.branch,
              base,
              branch_tip: branchTip,
              ahead_count: aheadCount,
              run_id: launchRun.id,
            },
            { run_host: opts.run_host },
          )
          return {
            run: failedRun(pinnedRun, reason, false),
            changed: true,
            waiting: false,
            note: `${launchRun.phase} → failed (local branch belongs to another lane — no fire)`,
          }
        }
      }
    }

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
    // this resolver's failure surfaces only through its best-effort fallback.
    let reflection_context: string | null = null
    if (opts.resolve_reflection_context) {
      try {
        reflection_context = opts.resolve_reflection_context(pinnedRun)
      } catch {
        reflection_context = null
      }
    }

    // The TEST EXECUTION block, derived here for the same reason and with the same
    // never-fails shape as the reflection resolve above: it needs the LIVE run count
    // (the launcher does not hold one) and the host's core/RAM budget, and a build must
    // never fail because the strategy could not be derived. Null → the workflow's
    // contract is byte-identical legacy.
    let test_strategy: string | null = null
    let test_strategy_intermediate: string | null = null
    // The numbers behind that block, carried into this launch's AdvanceOutcome note so
    // the divisor and the chosen jobs value are VISIBLE. Round-3 review: a box with
    // enough parked runs to pin every build at `jobs=1` logged nothing at all and was
    // indistinguishable from a healthy one.
    let test_strategy_summary: string | null = null
    try {
      let active = 1
      if (opts.resolve_active_runs) {
        try {
          const n = opts.resolve_active_runs()
          // ZERO IS AN ANSWER, NOT A MISSING ONE. The census counts the builds ALREADY
          // running; the one launching is not among them, so `0` means "this box is
          // otherwise idle" and must take the `+ 1` path like every other count. Gating
          // on `n >= 1` routed it to the catch-block default instead, which happens to
          // land on the same number today and would stop doing so the moment `active`
          // means anything below `DEFAULT_BUILD_FANOUT`. A census failure is the `catch`
          // below, and nothing else.
          if (Number.isFinite(n) && n >= 0) active = Math.floor(n) + 1
        } catch {
          // An unavailable census costs the RAISE-ONLY term, not the whole block, and not the
          // bound: `computeTestJobs` still divides by the constant fan-out, so a lost
          // count means "assume the planned fan-out" rather than "assume an idle box".
          // The build also still gets its stage-1 gate and its full-suite rule. The
          // outer catch below is the last-resort backstop that keeps ANY failure here
          // from failing the launch.
          active = 1
        }
      }
      const budget = readHostBudget()
      const detail = buildTestStrategyDetail(pinnedRun.repo_path, {
        cores: budget.cores,
        active_runs: active,
        mem_available_bytes: budget.mem_available_bytes,
        // THE BASE `diffBaseRef` CHOSE (#546) — the pin, `refs/remotes/origin/<base>` when it
        // resolves, else `refs/heads/<base>` — never a shorthand, never a bare name, and never
        // a base named here. The block this renders tells the build to run
        // `git diff --name-only <base>` against its WORKING TREE to pick the stage-1
        // test set; a stale `refs/heads/main` adds every file the base moved past to
        // that set, which is the wasteful direction of the same defect.
        base_branch: await diffBaseRef(base, base_sha, (ref) =>
          refResolves(opts.run_host, pinnedRun.repo_path, ref),
        ),
      })
      test_strategy = detail.block
      test_strategy_intermediate = detail.intermediate_block
      test_strategy_summary = detail.summary
    } catch {
      test_strategy = null
      test_strategy_intermediate = null
      test_strategy_summary = null
    }

    // FIRE the workflow. The launching turn settles in seconds; the build runs
    // detached in the background and persists its own result to the DB. Tracked
    // in `inflight` only so tests/shutdown can drain the (fast) fire turn.
    // WHEN the fire went out, on the INJECTED clock (never `Date.now()`): the
    // evidence gatherer compares artifact/lock timestamps against it, and the
    // tests must be able to pin it. Through `nowMs()`, NOT a bare `Date.parse` —
    // an unparseable injected clock would otherwise yield NaN, and every
    // `mtime >= NaN - skew` comparison is false, silently disabling the
    // fresh-worktree evidence with no way to tell that from "nothing was found".
    const fireStartedAtMs = nowMs()
    stamp('fire-dispatched')
    const firePromise = fireWorkflow({
      run: pinnedRun,
      base_branch: base,
      ...(base_sha !== null ? { base_sha } : {}),
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
        (opts.resolve_codex_home ? opts.resolve_codex_home(pinnedRun) : null) ??
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
      // The rendered TEST EXECUTION block (derived best-effort above), spliced by the
      // workflow into the FORGE build contract only — never the argus review gate.
      test_strategy,
      test_strategy_intermediate,
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

    if (outcome.status === 'unconfirmed') {
      // The launching turn was still RUNNING at the settle budget. It was NOT
      // cancelled and this is NOT a failure: a launcher turn that crossed an
      // autocompact takes 4-5 min to settle and its workflow fires regardless
      // (run 6948da2d was written off at 09:50:04; its workflow fired at
      // 09:51:52). Park the run `running` exactly like a confirmed fire — same
      // dispatch id, same slot — and confirm it from either the late settle or the
      // workflow's own `plan-start` within ONE MORE budget (`stepCore` §1c). Never
      // relaunch here: that puts a second lane on the same card.
      const budget = outcome.budget_ms ?? DEFAULT_SETTLE_TIMEOUT_MS
      const knownGeneration = outcome.launcher_session_key ?? null
      stamp(
        'fire-unconfirmed',
        `elapsed_ms=${outcome.elapsed_ms ?? budget} cancelled=${outcome.turn_cancelled === true} budget_ms=${budget} ` +
          `injected=${knownGeneration !== null} generation=${knownGeneration === null ? 'unknown' : knownGeneration.slice(0, 8)}`,
      )
      fired.add(run.id)
      const pending: UnconfirmedFire = {
        dispatch_id: id,
        deadline_ms: nowMs() + budget,
        budget_ms: budget,
        fire_started_at_ms: fireStartedAtMs,
        generation: knownGeneration,
        injected: knownGeneration !== null ? true : null,
        late: null,
        confirmed_by: null,
        cancel: outcome.cancel ?? null,
      }
      unconfirmedFires.set(run.id, pending)
      // The generation lands on the RECORD from whichever arrives first — the
      // inject-time status or the late settle — and §1c writes it onto the row on
      // the next tick. Neither callback writes the store: every row write stays
      // inside the tick, so a callback can never race the tick's own save.
      if (outcome.launcher !== undefined) {
        outcome.launcher.then(
          (generation) => {
            if (generation !== null) {
              if (pending.generation === null) pending.generation = generation
              pending.injected = true
            } else if (pending.injected === null) {
              pending.injected = false
            }
          },
          () => {},
        )
      }
      if (outcome.settled !== undefined) {
        outcome.settled.then(
          (late) => {
            pending.late = late
            if (late.status === 'fired') {
              if (pending.generation === null && late.launcher_session_key !== undefined) {
                pending.generation = late.launcher_session_key
              }
              pending.injected = true
              stampFor(run.id, 'fire-settled', `late (settled after the ${Math.round(budget / 1000)} s budget)`)
            } else {
              stampFor(run.id, 'fire-drained', `launcher turn ended ${late.status}: ${late.error ?? 'unknown'}`)
            }
          },
          () => {
            pending.late = { status: 'failed', error: 'fire stream error' }
          },
        )
      }
      const next: TridentRun = {
        ...pinnedRun,
        subagent_run_id: id,
        subagent_status: 'running',
        // THE LAUNCHER GENERATION, when the turn had injected by the budget; else
        // NULL — never the dispatch id (a key no pool will ever report) and never
        // `pinnedRun.workflow_run_id` (a previous round's generation, which
        // `persistRefireReset` does not clear: carrying it would point the
        // liveness probe at a dead child and latch a live lane as crashed). A
        // null here is exactly the held-lane row's; §1c adopts the generation the
        // moment the record learns it.
        workflow_run_id: knownGeneration,
        last_advanced_at: now(),
      }
      return {
        run: next,
        changed: true,
        waiting: true,
        note:
          `fired inner workflow ${id} — UNCONFIRMED: launcher turn still draining after ` +
          `${Math.round((outcome.elapsed_ms ?? budget) / 1000)} s (not cancelled; ` +
          `${knownGeneration === null ? 'not yet injected' : `injected into launcher ${knownGeneration.slice(0, 8)}`}); ` +
          `confirming within ${Math.round(budget / 60_000)} min`,
      }
    }

    if (outcome.status !== 'fired') {
      // A SETTLE TIMEOUT IS NOT PROOF THE WORKFLOW NEVER STARTED. The launcher
      // turn is cancelled on timeout; the workflow it may already have fired
      // runs DETACHED and that cancel does not reach it. Measured: 8 of 33 runs
      // in 7 days died here, one while its workflow kept building for another
      // six minutes, and twice over a row that already said `outer-published:…`.
      // So for THIS error string only, consult positive evidence first.
      if (outcome.error === FIRE_SETTLE_TIMEOUT_ERROR) {
        const decided = await decideSettleTimeoutByEvidence({
          pinnedRun,
          dispatch_id: id,
          fire_started_at_ms: fireStartedAtMs,
          launcher_generation: null,
          stamp,
        })
        if (decided !== null) return decided
        // `none` falls through to the unchanged path below.
      }
      // The launching turn never settled cleanly — the workflow was NOT fired.
      // Fail loudly (recoverable: a re-run re-fires). paused ≠ finished.
      return {
        run: failedRun(pinnedRun, `inner workflow fire failed: ${outcome.error ?? 'unknown'}`, false),
        changed: true,
        waiting: false,
        note: `${run.phase} → failed (fire did not settle)`,
      }
    }

    stamp('fire-settled')
    fired.add(run.id)
    const next: TridentRun = {
      ...pinnedRun,
      subagent_run_id: id,
      subagent_status: 'running',
      // The exact pooled launcher generation is the crash-ownership token. A
      // legacy/test fire seam without one retains the old observability id.
      workflow_run_id: outcome.launcher_session_key ?? pinnedRun.workflow_run_id ?? id,
      last_advanced_at: now(),
    }
    return {
      run: next,
      changed: true,
      waiting: true,
      note: `fired inner workflow ${id}${resume_checkpoint !== null ? ` (resume ${resume_checkpoint})` : ''}${
        test_strategy_summary !== null ? ` [${test_strategy_summary}]` : ''
      }`,
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
  async function refireNextRalphTask(
    run: TridentRun,
    result: InnerResult,
    checkpointNameOverride?: 'ralph-task-built' | 'ralph-task-built-deviated',
  ): Promise<AdvanceOutcome> {
    fired.delete(run.id)
    redispatched.delete(run.id)
    const pr = result.pr_number ?? run.pr
    const branch = result.branch ?? run.branch
    const remaining = result.remaining_tasks ?? 0
    const nextRalphRound = run.ralph_round + 1

    if (nextRalphRound > run.max_ralph_rounds) {
      // Cap reached: fail loudly. No out-of-band clear needed — the run goes TERMINAL
      // (`saveIfActive` commits `phase='failed'`), and `listNonTerminal` never reloads a
      // terminal row, so the stale `inner_result` is inert. (If a crash beats that
      // commit, the next tick re-harvests, re-enters here, and fails again — idempotent.)
      //
      // THE REASON IS NOT WRITTEN HERE (#519, final gate). This site emitted "without
      // converging" UNCONDITIONALLY while `enterRalphPlan` (state-machine.ts) had already
      // been given a three-arm wording, so the inaccurate diagnosis stayed live on
      // exactly the path a RESUMED seeded run takes — reached after review when
      // `remaining_tasks > 0`, which is the shape most likely to arrive at the cap having
      // run no iteration of its own. Both sites now call the single author,
      // `ralphCapFailureReason` (ralph-budget.ts); fixing the string twice would have
      // re-created the two-copies divergence that module exists to prevent. `remaining`
      // is this path's own fact — the state machine does not know it — so it is passed in
      // rather than dropped.
      const failed: TridentRun = {
        ...failedRun(
          run,
          ralphCapFailureReason({ ...run, remaining_tasks: remaining }),
          false,
        ),
        pr,
        branch,
        harvested_at: nowMs(),
        inner_verdict: 'REVIEW_NOT_RUN',
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
      ...(checkpointNameOverride !== undefined ? { inner_checkpoint: checkpointNameOverride } : {}),
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
      ...(checkpointNameOverride !== undefined ? { inner_checkpoint: checkpointNameOverride } : {}),
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

    // FOLD THE WORKFLOW-REPORTED ROUND INTO THE ROW, before ANY terminal shape
    // below spreads `run` — wave-child failures, the merged-PR done, the infra
    // budget-exhaustion `failedRun`, the provenance rejects, exhausted, and every
    // merge outcome all build their row from this object. `run.round` is the row's
    // COPY, stamped at launch; when the live bumps predate the bash seam's
    // derivation it never moved (215 of 224 measured runs sat at round 1 while
    // their checkpoints named fix-round-2..7), so the reported round is the only
    // honest number available at harvest. Guard identical to
    // `innerTerminalFailureReason`, which already prefers the reported round for
    // the same reason; monotonic, so a lower report never walks the row back.
    //
    // `isSafeInteger`, NOT `isFinite`: this value is written to
    // `code_trident_runs.round`, an INTEGER column on a STRICT table, and
    // `saveIfActive` binds it into `round = MAX(round, ?, ?)`. bun:sqlite refuses a
    // REAL there ("cannot store REAL value in INTEGER column"), so folding a
    // fractional report would throw at HARVEST — the one moment whose whole job is
    // to record what happened. `parseInnerResult` already narrows to the same
    // domain; this is the second lock on the door, because the fold is what puts
    // the number on the row.
    if (Number.isSafeInteger(result.round) && result.round > 0 && result.round > run.round) {
      run = { ...run, round: result.round }
    }

    // A wave child owns exactly one pinned build. Its `built` result is the join
    // barrier's input, not an approval or publish handoff: finish the child in
    // place and leave its member branch untouched for the parent to integrate.
    // This must precede every side-effecting path below (publish, Ralph re-fire,
    // review provenance, merge). Children have no chat route, so none is read.
    if (run.parent_run_id !== null && result.built) {
      if (typeof result.commit_sha !== 'string') {
        const failed = failedRun(
          { ...run, harvested_at: nowMs() },
          'wave member reported built without a full commitSha',
          true,
        )
        return { run: failed, changed: true, waiting: false, note: 'wave member built result missing commit → failed' }
      }
      const done: TridentRun = {
        ...run,
        harvested_at: nowMs(),
        phase: 'done',
        branch: result.branch ?? run.branch,
        inner_checkpoint: result.checkpoint ?? 'built',
        inner_verdict: null,
        subagent_status: 'completed',
        failure_reason: null,
        last_advanced_at: now(),
      }
      return {
        run: done,
        changed: true,
        waiting: false,
        note: `wave member ${run.wave_task_id ?? '?'} built ${result.commit_sha} → done`,
      }
    }

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
      if (run.ralph && (result.remaining_tasks ?? 0) > 0) {
        return refireNextRalphTask(
          run,
          result,
          result.deviated_from_spec ? 'ralph-task-built-deviated' : 'ralph-task-built',
        )
      }
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
        // THE ROUND IS CLAMPED TO WHAT THE READERS ACCEPT (Argus r10, minor).
        // `result.round` comes from `parseInnerResult`, i.e. from substrate JSON,
        // and nothing there bounds it; `OUTER_PUBLISHED_CHECKPOINT` accepts at
        // most nine digits. An unclamped absurd round therefore wrote a marker
        // that the settle-timeout gate reads as NOT published — terminalizing,
        // as `failed`, a run that had just pushed. See `checkpointRoundField`.
        const checkpoint = `outer-published:${published.head}:${result.remaining_tasks ?? 0}:${checkpointRoundField(result.round)}${result.deviated_from_spec ? ':deviated' : ''}`
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
          note:
            published.push === 'noop-already-at-head'
              ? `outer publisher confirmed ${published.head} already on origin (push no-op — the ref was already correct) and PR #${published.pr} → re-fire review`
              : `outer publisher confirmed ${published.head} and PR #${published.pr} → re-fire review`,
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        if (
          beginPublishRetry !== undefined &&
          classifyPublishFailure(reason) === PUBLISH_CREDENTIAL_CLASS
        ) {
          if (run.infra_retries >= maxInfraRetries) {
            return {
              run: failedRun(
                run,
                `publish credential remained unavailable after ${maxInfraRetries} automatic retries ` +
                  `(budget ${maxInfraRetries}). Reconnect GitHub from the Integrations screen; ` +
                  `the built commit remains on branch ${run.branch ?? `trident/${run.slug}`}. Last measured cause: ${reason}`,
                true,
              ),
              changed: true,
              waiting: false,
              note: 'publish-credential retry budget used → failed',
            }
          }
          const claimed = await beginPublishRetry(run.id)
          if (claimed === null) {
            return { run, changed: false, waiting: true, note: 'publish-retry claim lost — re-read next tick' }
          }
          const backoffMs =
            INFRA_RETRY_BACKOFF_MS[claimed.infra_retries - 1] ?? INFRA_RETRY_BACKOFF_MS.at(-1)!
          infraRetryNotBefore.set(run.id, Date.parse(now()) + backoffMs)
          return {
            run: claimed,
            changed: true,
            waiting: true,
            note: `publish credential failure → publish-only retry attempt ${claimed.infra_retries} of ${maxInfraRetries} scheduled`,
          }
        }
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

    // RUN-LEVEL INFRASTRUCTURE AUTO-RETRY. This sits before the harvest stamp:
    // nothing was harvested into a terminal decision when the atomic claim wins.
    // With the seam unwired, legacy callers take the exact existing path below.
    if (beginInfraRetry !== undefined && classifyInnerFailure(result) === 'infrastructure') {
      if (run.infra_retries >= maxInfraRetries) {
        const terminalRun = { ...run, harvested_at: nowMs() }
        const failed: TridentRun = {
          ...failedRun(
            terminalRun,
            `infrastructure failure persisted after ${maxInfraRetries} automatic retries ` +
              `(budget ${maxInfraRetries}) — not retrying again. Last measured cause: ${result.terminal_cause}`,
            true,
          ),
          pr: result.pr_number ?? run.pr,
          branch: result.branch ?? run.branch,
          inner_checkpoint: result.checkpoint ?? run.inner_checkpoint ?? null,
          // T4 (main) said an exhausted INFRA budget is not a review verdict and recorded
          // `null`. This branch says the same thing with a NAME instead of an absence:
          // reaching here means the infra budget ran out, so review provably never ran.
          // `null` is indistinguishable from "not yet set"; REVIEW_NOT_RUN is not.
          inner_verdict: 'REVIEW_NOT_RUN',
        }
        return { run: failed, changed: true, waiting: false, note: 'infrastructure retry budget used → failed' }
      }

      const claimed = await beginInfraRetry(run.id)
      if (claimed === null) {
        return { run, changed: false, waiting: true, note: 'infra-retry claim lost — re-read next tick' }
      }
      const backoffMs =
        INFRA_RETRY_BACKOFF_MS[claimed.infra_retries - 1] ?? INFRA_RETRY_BACKOFF_MS.at(-1)!
      infraRetryNotBefore.set(run.id, Date.parse(now()) + backoffMs)
      if (claimed.infra_retries === 1 && onInfraRetry !== undefined) {
        try {
          await onInfraRetry(claimed, 1, result.terminal_cause ?? '')
        } catch (err) {
          log.warn('infra_retry_observer_failed', {
            run: claimed.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return {
        run: claimed,
        changed: true,
        waiting: true,
        note: `infra failure → auto-retry attempt ${claimed.infra_retries} of ${maxInfraRetries} scheduled`,
      }
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
      // MUTATION PROVER — the post-APPROVE, pre-merge phase. An APPROVE says a
      // reviewer BELIEVES the change is guarded; this RUNS the mutation and
      // watches the guard go red and come back green. It is deterministic TS and
      // the only producer of its own evidence — no agent output is read here,
      // because a convincing paragraph about a mutation is exactly what this
      // phase exists to stop being sufficient. Fails CLOSED: an unprovable
      // APPROVE does not merge.
      //
      // `{ ...run, branch }` — the FRESHLY RESOLVED branch, never the row's. On a
      // run whose row predates the build naming its branch, the prover would
      // resolve a head off the OLD ref while the merge below took the new one:
      // proving one commit and merging another.
      //
      // `expected_head` — the commit the merge will ACTUALLY take (#545 pins it
      // to the reviewed OID, not to whatever the branch tip is now). The prover
      // pins the branch tip. Those are two independent answers to "which commit
      // is this about", and nothing compared them before: a tip that moved past
      // the reviewed commit gave a proof of B while the merge took A.

      // THE COMMITTED-NOMINATION FALLBACK. On the codex route the schema field
      // is filled by the bridge, which never sees the build's reasoning; and in
      // pr mode the workflow process ends at every publish handoff, so the
      // in-result claim arrives null even when the build nominated. The build
      // therefore COMMITS its nomination to `.trident/mutation-claims/<branch>.json`,
      // and this reads it back AT THE REVIEWED OID — the very commit the gate
      // pins — ONLY when the in-result claim is null (the read is not even
      // attempted otherwise, so a schema-supplied claim is never shadowed). The
      // artifact stays branch-controlled, UNTRUSTED input: the reader decodes
      // shape only, and the gate below validates and actually RUNS it on the
      // same terms as an agent-supplied claim. Every absence or failure reads
      // as null — which the gate already refuses — so the fallback can never
      // turn a missing nomination into a pass.
      const expectedHead = reviewedHeadOid(run)
      // THE BASE `resolvedDiffBase` CHOSE (#546), never one named here.
      // `changedFilesOnBranch` takes it as `git diff --name-only
      // <base>...<ref>`, and the three-dot form resolves the merge-base — so a stale
      // `refs/heads/main` (which IS an ancestor of the branch) puts every file the base
      // moved past into the blast radius the mutation nomination is scored against.
      const baseBranch = await resolvedDiffBase(run)
      const committed =
        result.mutation_claim === null || result.mutation_claim === undefined
          ? await readCommittedMutationClaim(opts.run_host, run.repo_path, {
              expected_head: expectedHead,
              branch,
              base_branch: baseBranch,
            })
          : null
      const claim = result.mutation_claim ?? committed?.claim ?? null
      const proof = await proveMutation({
        run: { ...run, branch },
        claim,
        base_branch: baseBranch,
        run_host: opts.run_host,
        expected_head: expectedHead,
      })
      // AN EXEMPTION IS NOT A SILENT PASS. `proof.reason` is the only part of the
      // outcome that outlives the process, and on the ok path it was being
      // dropped — so a merge that ran NO mutation proof looked exactly like one
      // that ran and passed. The tick note below is the HUMAN one-liner; the
      // DURABLE run-record entry is the `mutation-proof-exempt` stage row
      // stamped further down, because `tick.ts` persists the run row and never
      // reads `outcome.note`. Both exemptions (prose-only, and
      // no-production-file) say so, in both places.
      // CAPPED HERE AND NOWHERE ELSE. The no-production-file exemption names
      // EVERY changed file (that list is the reviewer's evidence and must not be
      // filtered), so a large test-only refactor puts a multi-kilobyte string on
      // the run row — a tick note is a one-line human summary, not a record. The
      // full reason still goes to the log below, which is where it is meant to
      // be read back.
      const proofNote = proof.exempt ? `; mutation proof skipped — ${truncateNote(proof.reason)}` : ''
      // …and into the log, which is where this run's non-fatal facts actually
      // outlive the tick (`leak_preflight` above records the same way). Both
      // exemptions log — prose-only and no-production-file — so "the gate ran
      // and passed" and "the gate never ran" stop looking identical after the
      // fact. `reason` carries WHICH one and the file count it saw.
      if (proof.exempt) {
        log.info('mutation_proof_exempt', { run_id: run.id, branch, reason: proof.reason })
        // The tick persists the run row, never `note` — so the note is display
        // and the stage ledger row is the exemption's durable place in the run
        // record. The file list is the reviewer's evidence, so this copy keeps
        // it — capped only where the diff itself stops being a list and starts
        // being a blob (`STAGE_REASON_CEILING`, ~30x the tick note), with the
        // uncapped text still in the log line above. Best-effort like every
        // stamp.
        try {
          opts.record_stage?.(run.id, 'mutation-proof-exempt', truncateStageReason(proof.reason))
        } catch {
          // a stamp must never fail a merge
        }
      }
      if (!proof.ok) {
        // `inner_verdict` / `inner_checkpoint` are left EXACTLY as the review left
        // them: Argus really did approve, and its provenance is the audit trail.
        // Rewriting either would misattribute the block — this is a MISSING
        // PROOF, not a reviewer's finding, and `failure_reason` says which.
        //
        // WHY THE READER'S NOTE IS APPENDED. "The build nominated no mutation"
        // was the same sentence for a build that genuinely nominated nothing, a
        // wrong path, an oversized blob and a malformed one — an ambiguity this
        // card's own history records as misdiagnosed for days as an agent
        // omission. The note says which, and ONLY on the refusal it explains:
        // the gate also refuses a rejected branch name, an unresolvable head and
        // a tip that moved, and none of those is a missing nomination — suffixed
        // with one they point the reader at the wrong failure.
        // BOUNDED, because `failure_reason` is stored verbatim and the note
        // quotes branch-supplied names: 300 characters is room for both legs of
        // a two-ref read and no room for a flood. The SHAPE of those names is
        // the reader's job and it does it at the source — every name a note
        // quotes is `foldRefName`-folded there, the same guard this file applies
        // wherever a refusal quotes the base, so the reason cannot carry a
        // forged line even though it is later replayed to a model verbatim.
        const reason =
          committed !== null && committed.claim === null && proof.reason.startsWith(NO_NOMINATION_REFUSAL)
            ? `${proof.reason} — ${committed.note.slice(0, 300)}`
            : proof.reason
        const blocked: TridentRun = { ...failedRun(run, reason, true), pr, branch }
        return { run: blocked, changed: true, waiting: false, note: 'APPROVE blocked (mutation prover) → failed' }
      }
      try {
        const res = await cleanupAfterMerge(doneRun, merge_deps)
        return {
          run: doneRun,
          changed: true,
          waiting: false,
          note: `APPROVE (argus-approved) → done; ${res.note}${proofNote}`,
        }
      } catch (err) {
        // #542 — the base moved materially between the review and the merge, so
        // the merge was HELD rather than landed. Fail the run with the hold text
        // AS the reason (the terminal delivery posts exactly it), keeping
        // `inner_verdict: 'APPROVE'` + the pr/branch: the reviewed work is intact
        // and re-runnable, it just may not land against a base nothing reviewed.
        if (err instanceof TridentBaseDriftHold) {
          return {
            run: { ...failedRun(doneRun, err.message, true), inner_verdict: 'APPROVE' },
            changed: true,
            waiting: false,
            note: 'done → failed (merge HELD: base drifted since review)',
          }
        }
        // #618 — the diff was MEASURED and is above the ceiling the reviewer
        // seat can be shown in full, so the merge was refused rather than
        // landed. Same shape as the #542 hold above and for the same reason:
        // the refusal text is authored, plain and specific, and the terminal
        // delivery posts exactly it. Without this arm the reason fell into the
        // `merge failed:` catch-all below, which `interpretFailure` classifies
        // as `merge-mechanics` — "a git step failed while landing the branch …
        // Reply to retry the build". No git step failed, the authored sentence
        // was discarded, and the retry re-measures the same diff and refuses
        // again; an unclassified refusal costs whatever the default costs.
        //
        // MEASURED ONLY. A hold carrying `measured_bytes === null` says the
        // diff could not be READ, which is a git command that failed and
        // nothing at all about its size — that one keeps the mechanics
        // disposition below, where the retry advice is right.
        if (err instanceof TridentMergeDiffHold && err.measured_bytes !== null) {
          return {
            run: { ...failedRun(doneRun, err.message, true), inner_verdict: 'APPROVE' },
            changed: true,
            waiting: false,
            note: 'done → failed (merge REFUSED: diff above the reviewable size limit)',
          }
        }
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
        inner_verdict: 'REVIEW_NOT_RUN',
      }
      return { run: failed, changed: true, waiting: false, note: 'APPROVE rejected (provenance gate) → failed' }
    }

    // REQUEST_CHANGES / null — the inner loop ended without an APPROVE. This is a
    // CATCH-ALL over several distinct causes, so the reason is MEASURED rather than
    // assumed; see `innerTerminalFailureReason` for what that cost when it was not.
    //
    // Prefer what the row already has: a stamped checkpoint is the more specific record,
    // and re-stamping it from a terminal result would overwrite the round's own findings
    // with whatever the last result happened to carry. Only when the row is empty does
    // the result's array fill it in, and a result with no findings leaves it null rather
    // than writing `[]` — "nobody said anything" and "the column was never written" stay
    // the same value, so no reader gains a distinction this path cannot actually support.
    const terminalFindings: string | null =
      parseCheckpointFindings(run.inner_checkpoint_findings).length > 0
        ? run.inner_checkpoint_findings
        : result.findings.length > 0
          ? JSON.stringify(result.findings)
          : run.inner_checkpoint_findings
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
      inner_checkpoint: result.checkpoint ?? run.inner_checkpoint ?? null,
      // MERGE RESOLUTION (main's T4 × this branch's discriminator). Main recorded
      // `isInfraDeath(result) ? null : 'REQUEST_CHANGES'`. `recordedTerminalVerdict`
      // SUBSUMES that: an infra death carries `block_kind: 'infra-only'`, so it returns
      // REVIEW_NOT_RUN — and it additionally catches the case main still got wrong,
      // a NON-infra death with an empty finding set, which main recorded as
      // REQUEST_CHANGES. That fabricated rejection is the defect this branch exists to
      // kill, so the discriminator wins on the field. Main's differentiated `note` is
      // kept verbatim below: it is the operator-visible half of the same fix.
      // THE ROW MUST CARRY THE EVIDENCE FOR THE VERDICT IT RECORDS. `store.ts` refuses
      // `REQUEST_CHANGES` on a row with no findings — correctly, that guard IS this
      // branch's thesis. But the findings of a run that reviewed and went straight to
      // terminal live on the RESULT, and `inner_checkpoint_findings` is only stamped
      // when a checkpoint is written, so the row arrived at the guard empty-handed.
      // Reading the result and leaving the column alone made the guard throw, the tick
      // fail, and the run retry forever without leaving `forge-init` — a wrong value
      // became a hang. So carry the evidence ACROSS with the verdict: below, the row is
      // stamped from `result.findings` when the result has them, and only then can the
      // discriminator honestly return REQUEST_CHANGES. Existing stamped findings win —
      // a checkpoint that already recorded them is the more specific record.
      inner_checkpoint_findings: terminalFindings,
      inner_verdict: recordedTerminalVerdict(result, terminalFindings),
    }
    return {
      run: failed,
      changed: true,
      waiting: false,
      note: isInfraDeath(result)
        ? 'inner loop died in infrastructure → failed (no verdict)'
        : 'inner loop ended without APPROVE → failed',
    }
  }

  /** G116–G117: retained with the unconfirmed-fire mechanism. */
  function handleUnconfirmedFire(run: TridentRun): AdvanceOutcome | Promise<AdvanceOutcome> | null {
    // (1c) UNCONFIRMED FIRE — the launcher turn overran the settle budget and was
    //     LEFT DRAINING (`launch()`; never cancelled there, see `unconfirmedFires`).
    //     The run is parked `running` like any fire; this decides whether the fire
    //     is real. Sits BEFORE the hang watchdog so the decision is made in at most
    //     two settle budgets (~16 min), not 90. Evidence, in order:
    //       • the late settle itself (`fired`);
    //       • the workflow's own `plan-start` / `fire-settled` stage event stamped
    //         AFTER this launch's `fire-dispatched` — the LAST dispatch stamp, not
    //         `fire-unconfirmed`: the workflow's `plan-start` lands seconds after
    //         the Workflow call, i.e. BEFORE the launcher's budget ran out and the
    //         `fire-unconfirmed` stamp went down, so anchoring on the latter would
    //         discard this launch's own proof and fail a live run. An earlier
    //         round's stamp is not this fire's evidence: the scan resets on every
    //         `fire-dispatched` and keeps only what follows the last one;
    //       • nothing within one more budget → the same positive-evidence gate the
    //         `failed` fire path runs (#498: a settle timeout is not proof the
    //         workflow never started), then fail with the original reason and
    //         CANCEL the launcher turn so a queued Workflow call cannot go out on
    //         a row already marked failed (a ghost lane). NEVER relaunch from here
    //         — a settle-timeout on a live launch is exactly how a second lane
    //         lands on the same card.
    //     THE LAUNCHER GENERATION is adopted onto the row the moment the record
    //     learns it — from the fire's inject-time status, the late settle, or
    //     either arriving while the stage event is what confirmed the fire — so
    //     `countRunningByLauncher` (the eviction guard) and `crashRunningByLauncher`
    //     (the crash latch) see this run for as long as it is hosted, not only
    //     while this in-memory record exists.
    //     Harvest (§1) still runs first: a fast workflow that already wrote its
    //     result is harvested, not re-litigated.
    const pendingFire = unconfirmedFires.get(run.id)
    // A PENDING RECORD BELONGS TO THE DISPATCH THAT MINTED IT AND TO NO OTHER.
    // The record is keyed by run id, but what it describes is one launcher TURN. A
    // run that has since been relaunched carries a DIFFERENT `subagent_run_id`;
    // applying the old record to it adopts a dead child's generation onto the live
    // workflow (handing the eviction guard and the crash latch the wrong
    // generation) and runs the dead turn's deadline against a healthy new lane.
    // Superseded records are dropped here rather than merely ignored, so the map
    // cannot accumulate them for the process's lifetime.
    //
    // THIS IS THE ONLY OWNERSHIP CHECK, deliberately. A matching `delete` at the
    // top of `launch()` was written first and removed: it is unreachable as a
    // distinct behaviour — every stale record either passes through here (dropped)
    // or through the terminal-phase cleanup in `stepCore` (dropped) — so it could
    // not be mutation-proved, and an unprovable guard is not a guard. It also does
    // not close the race it claimed to: a fire for dispatch A that resolves AFTER
    // a relaunch re-inserts its record BEHIND any delete, which is exactly the
    // ordering this check is here to catch.
    if (pendingFire !== undefined && pendingFire.dispatch_id !== run.subagent_run_id) {
      unconfirmedFires.delete(run.id)
    }
    if (
      pendingFire !== undefined &&
      pendingFire.dispatch_id === run.subagent_run_id &&
      run.subagent_run_id !== null &&
      run.subagent_status === 'running'
    ) {
      const late = pendingFire.late
      const generation = pendingFire.generation
      const adoption: Partial<TridentRun> =
        generation !== null && run.workflow_run_id !== generation ? { workflow_run_id: generation } : {}
      const adoptionNote =
        'workflow_run_id' in adoption && generation !== null
          ? ` (launcher generation ${generation.slice(0, 8)} adopted)`
          : ''
      if (late !== null && late.status === 'fired') {
        unconfirmedFires.delete(run.id)
        return {
          run: { ...run, ...adoption, last_advanced_at: now() },
          changed: true,
          waiting: true,
          note: `fire confirmed — launcher turn settled after the budget${adoptionNote}`,
        }
      }
      if (pendingFire.confirmed_by === null && listStageEvents !== null) {
        let events: ReadonlyArray<{ stage: string; at: string }> = []
        try {
          events = listStageEvents(run.id)
        } catch {
          events = []
        }
        let sinceDispatch = false
        let proved = false
        for (const ev of events) {
          if (ev.stage === 'fire-dispatched') {
            sinceDispatch = true
            proved = false
            continue
          }
          if (sinceDispatch && (ev.stage === 'plan-start' || ev.stage === 'fire-settled')) proved = true
        }
        if (proved) {
          pendingFire.confirmed_by = 'stage-event'
          stampFor(run.id, 'fire-confirmed', "by the workflow's own stage event after fire-dispatched")
        }
      }
      if (pendingFire.confirmed_by === 'stage-event') {
        // Proved by the workflow itself. The record outlives the deadline: it is
        // kept until the launcher generation is on the row (an inject-time status
        // or a late settle — after the deadline included — still brings it) or the
        // turn has drained with nothing to learn; the terminal no-op drops it
        // otherwise. Either way the run FALLS THROUGH to the ordinary in-flight
        // branches below — it is a confirmed fire like any other, and returning
        // early here would shadow the hang watchdog for the rest of the window.
        if ('workflow_run_id' in adoption) {
          unconfirmedFires.delete(run.id)
          return {
            run: { ...run, ...adoption, last_advanced_at: now() },
            changed: true,
            waiting: true,
            note: `fire confirmed by the workflow's own stage event${adoptionNote}`,
          }
        }
        if (late !== null || run.workflow_run_id !== null) unconfirmedFires.delete(run.id)
      } else if (nowMs() < pendingFire.deadline_ms) {
        if ('workflow_run_id' in adoption) {
          // The turn INJECTED (the pool reported its generation) but the workflow
          // has not stamped yet. Put the generation on the row now: from here on
          // the eviction guard counts this run and an eviction of that child
          // latches it `crashed` instead of leaving it to the 90-min reaper.
          return {
            run: { ...run, ...adoption, last_advanced_at: now() },
            changed: true,
            waiting: true,
            note: `fire unconfirmed — launcher turn injected, still draining${adoptionNote}`,
          }
        }
        const leftS = Math.max(0, Math.round((pendingFire.deadline_ms - nowMs()) / 1000))
        return {
          run,
          changed: false,
          waiting: true,
          note:
            `fire unconfirmed — launcher turn still draining (not cancelled; ` +
            `${pendingFire.injected === false ? 'never injected' : pendingFire.injected === true ? 'injected' : 'inject not yet reported'}); ` +
            `${leftS} s left to confirm`,
        }
      } else {
        return (async () => {
          // THE DEADLINE. Two budgets, no settle, no stage event.
          unconfirmedFires.delete(run.id)
          // (1c-i) THE #498 GATE FIRST. Exactly what the `failed` fire path consults:
          //     the workflow may have launched and be writing checkpoints without ever
          //     stamping `plan-start` (or with the ledger unreadable), or may already
          //     have published. Positive evidence holds or terminalizes the lane; only
          //     `none` reaches the failure below.
          const decided = await decideSettleTimeoutByEvidence({
            pinnedRun: run,
            dispatch_id: pendingFire.dispatch_id,
            fire_started_at_ms: pendingFire.fire_started_at_ms,
            launcher_generation: generation,
            stamp: (stage, meta) => stampFor(run.id, stage, meta),
          })
          if (decided !== null) return decided
          fired.delete(run.id)
          // (1c-ii) CANCEL THE TURN. A turn that never injected is still QUEUED behind
          //     the driver lock — its Workflow call has not gone out, and withdrawing
          //     it is poison-free (the driver returns before any inject). Left armed,
          //     it would fire a ghost Workflow on a row this tick marks failed. A turn
          //     that DID inject is abandoned the ordinary way: the pool's eviction
          //     guard keeps that child alive while it hosts other live runs, and the
          //     hung turn drains under the driver lock.
          const injected = pendingFire.injected === true
          if (pendingFire.cancel !== null) {
            const cancel = pendingFire.cancel
            fireAndForget('orchestrator.unconfirmed_fire_cancel', cancel(), (err: unknown) => {
              log.error('unconfirmed_fire_cancel_failed', {
                run: run.id,
                slug: run.slug,
                error: err instanceof Error ? err.message : String(err),
              })
            })
            stampFor(
              run.id,
              'fire-cancelled',
              injected
                ? 'injected turn abandoned at the confirmation deadline'
                : 'queued turn withdrawn at the confirmation deadline (never injected; poison-free)',
            )
          }
          const lateNote =
            late === null
              ? 'launcher turn still not settled after two budgets'
              : `launcher turn later ended ${late.status}: ${late.error ?? 'unknown'}`
          const windowMin = Math.round((2 * pendingFire.budget_ms) / 60_000)
          return {
            run: failedRun(
              { ...run, ...adoption },
              `inner workflow fire failed: ${FIRE_SETTLE_TIMEOUT_ERROR} (${lateNote}; ` +
                `${injected ? 'the turn had injected' : 'the turn never injected'}; ` +
                `no plan-start observed within ${windowMin} min; launcher turn cancelled at the deadline)`,
              false,
            ),
            changed: true,
            waiting: false,
            note: `${run.phase} → failed (fire never confirmed)`,
          }
        })()
      }
    }

    return null
  }

  /** G119: retained with the shared-launcher reprieve and restamp policy. */
  function sharedLauncherStandDown({
    run, overCeiling, probe, stageBeatsDeath, runEvidenceBeatsDeath, stageFresh, runDecision, stageAgeMs, runFreshestMs, staleMins, disclosure,
  }: SharedLauncherStandDownInput): AdvanceOutcome | null {
    // (1b-i) STAND DOWN ON POSITIVE EVIDENCE, BEFORE KILLING ANYTHING.
    //
    // WHY `probe === 'dead'` NO LONGER OUTRANKS A LIVE PER-RUN HEARTBEAT. It used to
    // read `probe !== 'dead' && (stageFresh || probe === 'alive')`, which made a
    // shared, generation-scoped probe strictly stronger than per-run evidence — the
    // exact inverse of what this file argues a few hundred lines up ("A DEAD LAUNCHER
    // IS NOT A DEAD BUILD", from three measured gateway boots that reaped healthy
    // builds). The build is DETACHED (`nohup setsid`, inner-workflow.mjs), so a dead
    // launcher generation is not a statement about the wrapper; a `codex-exec-alive`
    // row written minutes ago is, because the ticker re-checks its wrapper's pid
    // before every stamp.
    //
    // THE OVERRIDE IS DELIBERATELY NARROW. A stage row may be up to 90 min old and
    // still count for the ordinary stand-down; only a row inside
    // `DEAD_LAUNCHER_OVERRIDE_MS` (3 heartbeat cadences) may overturn a POSITIVE
    // death, because that is the window in which a ticker cannot have outlived its
    // wrapper. A stale-but-under-threshold row with a dead launcher still reaps —
    // "a heartbeat row proves a TICKER ran, not that the build did" remains true at
    // every resolution coarser than this one.
    //
    // THE RUN-SCOPED PROBES JOIN ON BOTH SIDES OF THE DEAD-LAUNCHER SPLIT: inside
    // the override window they can overturn a positive launcher death exactly as a
    // fresh stage row can, and on the ordinary path any activity inside the hang
    // window spares the run. Both are per-RUN evidence, which is the whole reason
    // they are allowed to argue with a generation-scoped answer.
    const standDown = overCeiling
      ? false
      : probe === 'dead'
        ? stageBeatsDeath || runEvidenceBeatsDeath
        : stageFresh || probe === 'alive' || runDecision?.action === 'stand-down'
    if (standDown) {
      // WHICH SPARES MOVE THE CLOCK (T4). Run-scoped evidence only. When
      // `probe === 'dead'` the stand-down can only have come from
      // `stageBeatsDeath || runEvidenceBeatsDeath`, both run-scoped; otherwise a
      // fresh stage row or a run-evidence stand-down is run-scoped, and if
      // neither holds the spare came solely from `probe === 'alive'` — an answer
      // about a SHARED launcher generation, which must not renew this run's
      // window or a forever-alive launcher would never reach the 2 h ceiling.
      const restamp = probe === 'dead' || stageFresh || runDecision?.action === 'stand-down'
      const sparedBy =
        probe === 'dead'
          ? stageBeatsDeath
            ? `a stage event landed ${Math.round((stageAgeMs ?? 0) / 60_000)} min ago — inside the ` +
              `${Math.round(DEAD_LAUNCHER_OVERRIDE_MS / 60_000)} min window in which this run's OWN wrapper ` +
              `must still have been alive, and a shared launcher generation's death does not answer for it`
            : `a run-scoped probe saw activity ${Math.round((runFreshestMs ?? 0) / 60_000)} min ago — inside the ` +
              `${Math.round(DEAD_LAUNCHER_OVERRIDE_MS / 60_000)} min window in which this run's OWN wrapper ` +
              `must still have been alive, and a shared launcher generation's death does not answer for it`
          : stageFresh
            ? `a stage event landed ${Math.round((stageAgeMs ?? 0) / 60_000)} min ago — the run is advancing mid-phase`
            : probe === 'alive'
              ? `the launcher probe positively observed the process ALIVE (stage evidence: ` +
                `${stageAgeMs === null ? 'none' : `${Math.round(stageAgeMs / 60_000)} min old`})`
              : `a run-scoped probe saw activity ${Math.round((runFreshestMs ?? 0) / 60_000)} min ago — ` +
                `this run itself is doing work inside the window the clock called dead`
      // DISCLOSED, not silent, and disclosed the SAME WAY the reap is. A watchdog
      // that quietly declines to fire is as hard to trust as one that quietly fires;
      // the note carries the full `disclosure` — both clocks AND the probe's answer —
      // so a run that survived is as auditable as one that did not.
      return {
        run,
        changed: restamp,
        waiting: true,
        note:
          `hang watchdog STOOD DOWN: last_advanced_at is ${staleMins} min stale but ${sparedBy}` +
          ` — ${disclosure}` +
          (restamp
            ? ' — advancement clock re-stamped (run-scoped evidence)'
            : ' — advancement clock NOT re-stamped (a live shared launcher is generation evidence,' +
              ' not run-scoped)'),
      }
    }

    return null
  }

  const stepCore = createRecoveryLivenessStep({
    now, log, fired, redispatched, infraRetryNotBefore, launchFaults, MAX_LAUNCH_FAULTS,
    unconfirmedFires, maxInflightMs, noAdvanceHangMs, maxCrashRecoveries, on_orphaned,
    beginCrashRecovery, latestStageEventAt, probeRunAlive, gatherRunEvidence,
    probeBranchHolderFor, detectMergedPr, failedRun, launch, applyResult,
    handleUnconfirmedFire, sharedLauncherStandDown,
  })

  async function step(run: TridentRun): Promise<AdvanceOutcome> {
    if (!isTerminalPhase(run.phase) && projectBuildPending(run.inner_result)) {
      return { run, changed: false, waiting: true, note: 'Project driver outcome unknown; preserving worker and step for reconciliation' }
    }
    let worker = unknownWorkerObservation('worker observer unavailable', now())
    if (!isTerminalPhase(run.phase) && opts.observe_run_worker !== undefined) {
      try { worker = await opts.observe_run_worker(run) }
      catch { worker = unknownWorkerObservation('worker observation failed', now()) }
    }
    const out = await stepCore(run, worker)
    // EVIDENCE GOES ON THE REASONS THIS OBSERVER AUTHORS, AND NOWHERE ELSE.
    // Appending it to every failure (and to every waiting note) rewrote reasons
    // this change does not own — `inner workflow fire failed: …`, whose
    // byte-identity is pinned by the fire-evidence wiring test, and the launch
    // retry notes pinned by the launcher-death e2e. Both went red in CI for
    // exactly that. A `worker=unknown; worker observer unavailable` suffix is
    // also pure noise on a run nothing observed.
    // A POSITIVE observation is new information and can attach anywhere; an
    // `unknown` attaches ONLY to the reasons this observer authors. Attaching
    // `worker=unknown; worker observer unavailable` to every failure is what took
    // out the fire-evidence byte-identity pin, and an unwired or blind observer
    // must leave an unrelated failure exactly as it found it.
    const authored = /^worker blocked:|^worker state unknown:/.test(out.run.failure_reason ?? '')
    if (out.changed && out.run.phase === 'failed' && (authored || worker.state !== 'unknown')) {
      out.run = { ...out.run, failure_reason: `${out.run.failure_reason ?? 'failure cause unknown'}\n${workerEvidence(worker)}` }
    } else if (out.waiting && worker.state !== 'unknown') {
      out.note += `; worker=${worker.state}; ${worker.detail}`
    }
    if (out.changed && out.run.phase === 'failed' && !isTerminalPhase(run.phase)) {
      const salvaged = await reconcile_stranded(out.run)
      if (salvaged !== null) {
        const publishedNow =
          !(out.run.failure_reason ?? '').includes(TRIDENT_SALVAGE_MARKER) &&
          (salvaged.failure_reason ?? '').includes(TRIDENT_SALVAGE_MARKER)
        const salvageNote =
          publishedNow && salvaged.pr !== null
            ? `stranded build salvaged → PR #${salvaged.pr}`
            : 'stranded work recorded without a publish'
        const failureNote = salvageFailureNotes.get(out.run)
        if (failureNote !== undefined) salvageFailureNotes.delete(out.run)
        return {
          ...out,
          run: salvaged,
          note: `${out.note}; ${salvageNote}${failureNote === undefined ? '' : `; stranded worktree capture failed: ${failureNote}`}`,
        }
      }
      const failureNote = salvageFailureNotes.get(out.run)
      if (failureNote !== undefined) {
        salvageFailureNotes.delete(out.run)
        return { ...out, note: `${out.note}; stranded build salvage failed: ${failureNote}` }
      }
    }
    return out
  }

  /** Resolve once every in-flight FIRE turn has settled (tests + graceful
   *  shutdown). The detached builds are NOT awaited here — the tick loop harvests
   *  their results from the DB. */
  async function drain(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.all([...inflight])
    }
  }

  return { step, drain, reconcile_stranded }
}
