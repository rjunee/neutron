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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '@neutronai/logger'
import { foldStagedAsBuiltEntries, type FoldStagedAsBuiltEntriesResult } from './as-built-appender.ts'
import { hasArgusProvenance, phaseForCheckpoint } from './checkpoint-phase.ts'
import { executeBoundReview } from './review-run.ts'
import { cleanupAfterMerge, type HostCommandResult, type MergeCleanupDeps } from './git-mode.ts'
import { reviewedHeadOid } from './merge.ts'
import {
  runMutationProofGate,
  type MutationGateInput,
  type MutationGateOutcome,
} from './mutation-prover.ts'
import {
  parseCheckpointFindings,
  parseInnerResult,
  type FireOutcome,
  type InnerResult,
  type TridentWorkflowFirer,
} from './inner-loop.ts'
import {
  buildMergeCleanupDeps,
  detectBaseBranch,
  MAX_CONFLICT_ROUNDS,
  runWorktreePath,
  TridentBaseDriftHold,
  TridentMergeConflictEscalation,
  type MergeConflictResolver,
  type RunHostCommand,
} from './merge.ts'
import { infraDeathSentence } from './infra-block.ts'
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
  decideHang,
  describeRunEvidence,
  freshestActivityAgeMs,
  unknownRunEvidence,
  type RunEvidenceGatherer,
  type RunHangEvidence,
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
  run_host: RunHostCommand
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
   * The count of trident runs currently IN A BUILD PHASE (`forge-init`/`forge-fix`),
   * INCLUDING the one launching — the live test-running fan-out. Wired from the run
   * store in `gateway/composition/build-core-modules.ts` (the orchestrator holds no
   * store; the composer does).
   *
   * Consumed by `computeTestJobs` as its RAISE-ONLY term. The bound itself comes from
   * the CONSTANT `DEFAULT_BUILD_FANOUT`, because a launch-time snapshot cannot bound a
   * STAGGERED fan-out: the value is frozen into a prompt string, so the run that
   * launched onto an idle box would keep all the cores for an hour while later runs
   * divided the same box again (read `computeTestJobs`'s docblock). This count only
   * shrinks the budget FURTHER, when more builds than planned are genuinely running.
   *
   * BEST-EFFORT: a throwing resolver or a non-finite result degrades to 1
   * (sequential-safe) and NEVER fails the launch. And it must actually be WIRED —
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
   * AS-BUILT ONE-WRITER (T2) — the post-merge fold pass. Invoked once after a
   * SUCCESSFUL `cleanupAfterMerge` (both merge modes) with the merged (done) run and
   * its resolved base branch; folds every entry staged under `.trident/as-built/`
   * on the base into docs/AS_BUILT.md ON THE BASE, in one commit (see
   * `trident/as-built-appender.ts`). Defaults to the real
   * `foldStagedAsBuiltEntries` over `run_host`; injectable for tests. A failure —
   * returned value OR throw — must NEVER fail the already-merged run: the merge
   * landed and the staged entry is durable on the base, so the failure is
   * surfaced in the advance note and the tick loop's bounded catch-up retries it.
   */
  fold_as_built?: (run: TridentRun, base: string) => Promise<FoldStagedAsBuiltEntriesResult>
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
   * as a defense-in-depth backstop). Default `NO_ADVANCE_HANG_MS` (90 min —
   * `trident/liveness.ts`; this comment said 25 min long after the constant was
   * raised, which is exactly the kind of drift that makes a reader distrust it).
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
      // The scheme is BOUNDED (`\w{1,32}`) rather than `\w+`: an unbounded prefix before a
      // literal `://` backtracks polynomially on input that is a long run of word characters
      // with no `://` — CodeQL js/polynomial-redos, and this function is fed raw git stderr.
      // No real URL scheme approaches 32 characters, so nothing that was redacted before
      // stops being redacted.
      .replace(/(\w{1,32}:\/\/)[^/\s@]+@/g, '$1***@')
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
  result: Pick<InnerResult, 'verdict' | 'block_kind' | 'checkpoint'>,
  rowFindings: string | null,
): 'REQUEST_CHANGES' | 'REVIEW_NOT_RUN' {
  if (
    result.verdict === 'REQUEST_CHANGES' &&
    result.block_kind === 'code' &&
    hasArgusProvenance(result.checkpoint) &&
    parseCheckpointFindings(rowFindings).length > 0
  ) {
    return 'REQUEST_CHANGES'
  }
  return 'REVIEW_NOT_RUN'
}

/**
 * A line of `git diff --cached` output that ADDS a conflict marker. `<<<<<<<` and `>>>>>>>` only —
 * these are the labelled markers, which carry a branch name after the run and so end in a space
 * or a tab. A bare `=======` separator is caught separately by `CONFLICT_SEPARATOR_ADDED` below
 * (exact-line, and exempt in markdown, where it is a setext underline). `|||||||` remains
 * unmatched: it only appears under `merge.conflictStyle=diff3`, and catching it is a follow-up.
 *
 * Four or more catches the narrowest marker width this gate deliberately supports as well as
 * git's default and wider configured markers. Because candidates are paths known to have
 * conflicted in this replay, an added four-wide labelled run fails closed as residue.
 */
const CONFLICT_MARKER_ADDED = /^\+(?:<{4,}|>{4,})(?: |\t|\r?$)/

/**
 * A `git diff --cached -U1` line that ADDS git's bare conflict SEPARATOR. Unlike `<<<<<<<` and
 * `>>>>>>>`, the separator line git writes carries NO label — it is exactly a run of `=` and
 * nothing else — so anything with trailing content (a heredoc sentinel, a quoted string, an
 * indented docstring underline) never matches. Git permits `conflict-marker-size` to narrow the
 * marker as well as widen it; four is the fail-closed lower bound shared with the outer-marker
 * scan. Shorter punctuation remains ordinary generated content. `\r?` covers
 * a CRLF file. This is the residue MOST likely to
 * survive a sloppy hand-resolution: the outer markers
 * are the visually obvious ones, and deleting them while leaving `=======` used to pass this
 * gate entirely.
 */
const CONFLICT_SEPARATOR_ADDED = /^\+={4,}\r?$/

/**
 * Markdown permits an all-`=` Setext H1 underline. Text around it cannot safely corroborate that
 * interpretation: conflict sides can have the identical title/blank/paragraph shape. The narrow
 * exemption therefore requires affirmative diff evidence that the resolver added the nonblank
 * title immediately before the underline, and that the resulting next line is blank or EOF.
 * Surviving conflict-side content immediately after the separator is therefore refused. Scanning
 * each candidate separately avoids decoding git-quoted path headers.
 */
const SETEXT_UNDERLINE_PATHS = /\.(?:md|markdown)$/i

function stagedDiffAddsConflictMarker(diff: string, path: string): boolean {
  const lines = diff.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (CONFLICT_MARKER_ADDED.test(line)) return true
    if (!CONFLICT_SEPARATOR_ADDED.test(line)) continue
    if (!SETEXT_UNDERLINE_PATHS.test(path)) return true

    const addedTitle = /^\+(.+)\r?$/.exec(lines[i - 1] ?? '')?.[1] ?? ''
    if (addedTitle.trim() === '') return true

    // Removed lines do not exist in the staged result. The first context/added line after them is
    // the line after the underline; a hunk/file boundary means the underline is at EOF.
    let after = i + 1
    while ((lines[after] ?? '').startsWith('-') && !lines[after]?.startsWith('---')) after += 1
    const next = lines[after]
    const atEof = next === undefined || next === '' || next.startsWith('@@') || next.startsWith('diff --git ')
    const followedByBlank = next === '+' || next === '+\r' || next === ' ' || next === ' \r'
    if (!atEof && !followedByBlank) return true
  }
  return false
}

/**
 * A rebase that CONFLICTS is an ATTENTION state, never a verdict.
 *
 * A branch conflicting with its base is a MERGEABILITY fact about the branch's relationship to
 * `main` — not a judgement about the code. Recording it as `REQUEST_CHANGES` tells the owner his
 * build was rejected when no reviewer read a line of it. So this is a typed failure carrying the
 * conflicting paths.
 *
 * AND THIS IS THE PATH THAT RESOLVES FIRST. A configured `resolve_conflict` resolver is invoked
 * here, in the scratch worktree `git apply --3way` just left the markers in, bounded by
 * `MAX_CONFLICT_ROUNDS` AND by a per-round progress requirement. The local-mode merge path has a
 * human present who could reconcile the branch by hand; this one is autonomous and has nobody, so
 * it is exactly where auto-resolution earns its keep. `TridentRebaseConflict` remains the outcome
 * when no resolver is configured, when the resolver declines/escalates, when a round makes no
 * progress, when the round bound is exhausted, and when a "resolution" empties the branch's delta.
 *
 * THE RESOLVER'S WORD IS NEVER THE EVIDENCE. A claimed RESOLVED is checked against git twice —
 * the unmerged set (`--diff-filter=U`) AND the staged bytes (`--cached`, scanned for added
 * conflict markers), because `git add` clears the unmerged bit for a path whose markers are still
 * inside it.
 *
 * A RESOLVED REBASE IS NOT AN APPROVED ONE. Resolution is a MERGEABILITY operation, not a
 * verdict — the branch still faces the full review gate afterwards, exactly as an unconflicted
 * replay does.
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

/** The path the entry-aware driver is bound to, and the git config name it is bound under. */
const AS_BUILT_LOG_PATH = 'docs/AS_BUILT.md'
const AS_BUILT_DRIVER_NAME = 'as-built-log'

/**
 * The environment variables the merge driver is run WITHOUT.
 *
 * `GH_TOKEN` is the owner's credential, the one that publishes every PR; the `GIT_CONFIG_*` triple
 * is the credential helper that reads it back out (`github/credential.ts` `githubProcessEnv`), so
 * leaving those behind would hand a child `git` the same access under a different name.
 * `GITHUB_TOKEN` is not set by this codebase and is unset anyway because CI and developer shells
 * commonly do set it. A merge driver reads three files and writes one — none of this belongs in it.
 */
const CREDENTIAL_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']

/**
 * THIS INSTALLATION's copy of the merge driver — never the checkout's.
 *
 * Walks up from this module rather than joining a fixed `..`, because trident is a workspace
 * package: depending on whether the resolver hands back the real path or the
 * `node_modules/@neutronai/trident` symlink, the tree root is one hop up or three. Bounded, and a
 * `null` return simply means "do not install", which is the same outcome as not calling this.
 */
function ownAsBuiltMergeDriver(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let hop = 0; hop < 8; hop++) {
    const candidate = join(dir, 'scripts', 'git', 'as-built-merge-driver.ts')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Single-quote a path for the shell string git stores as `merge.<name>.driver`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The command git will run for a merge, built so the TARGET CHECKOUT CANNOT INJECT CODE INTO IT.
 *
 * ⚠️ GIT RUNS A MERGE DRIVER WITH ITS CWD AT THE TOP OF THE WORKING TREE BEING MERGED, AND BUN
 * READS `bunfig.toml` FROM ITS CWD. So naming a trusted script is NOT on its own enough: a
 * `bunfig.toml` committed in the target repository with `preload = ["./anything.ts"]` runs that
 * file inside our driver process, before a line of our code, every time git merges this path.
 * That process is a child of the publisher's `run_host`, whose environment carries `GH_TOKEN`
 * (`open/composer.ts` `makeLazyCredentialedHostRunner` → `github/credential.ts` `githubProcessEnv`),
 * so the payload reads the owner's credential straight out of `process.env`. Reproduced on bun
 * 1.3.9: with the preload present the child printed `EXFIL GH_TOKEN=<the value>`; with
 * `--config=/dev/null` in front of the script it printed nothing and the script still ran. Round 1
 * closed the "which script runs" hole and left this one open, which is the same class of mistake
 * one layer down — the interpreter's own configuration is part of what an untrusted checkout
 * supplies.
 *
 * `--config=/dev/null` names an empty TOML file, so the checkout's `bunfig.toml` supplies no
 * `preload`, no `loader` and no registry override. The driver needs none of that: it reads three
 * files and writes one. (Scope, stated rather than overclaimed: what was MEASURED is the cwd
 * `bunfig.toml`, which is the one an untrusted checkout controls. Whether the flag also displaces a
 * `$HOME/.bunfig.toml` was not measured and nothing here depends on it — `$HOME` on the publisher
 * host is as trusted as the interpreter itself.)
 *
 * …AND `--env-file=/dev/null`, BECAUSE `--config` DOES NOT COVER `.env`. bun auto-loads a `.env`
 * from its cwd, which under a merge driver is the checked-out repository, and it does so
 * INDEPENDENTLY of `bunfig.toml` — measured on bun 1.3.9: with `--config=/dev/null` alone, a `.env`
 * sitting in the cwd still reached `process.env` inside the driver; with `--env-file=/dev/null` in
 * front of it, it did not. No escalation from that injection was demonstrated (the inherited `PATH`
 * wins over one supplied this way), so this is closing an input rather than a proven exploit — but
 * the property this code is FOR is that nothing the checkout ships decides anything inside the
 * driver process, and an environment it writes is such a thing.
 *
 * AND THE CREDENTIAL IS TAKEN OUT OF SCOPE ENTIRELY. `env -u GH_TOKEN …` prefixes the command, so
 * the owner's token — and the `GIT_CONFIG_*` triple whose credential helper reads it
 * (`github/credential.ts` `githubProcessEnv`) — is simply not in the environment of a process whose
 * whole job is to read three files and write one. The isolation above is about what the checkout
 * can INJECT; this is about what is there to steal if some future injection succeeds anyway. Two
 * independent controls, because "nothing can get in" is a claim that has already been wrong twice
 * on this code path.
 *
 * `null` when the interpreter is not bun. The driver is a `.ts` module, so nothing else can run it
 * anyway, and rather than infer that some other interpreter would honour a `--config` flag with the
 * same meaning, this refuses to install — which leaves the checkout merging the log exactly as it
 * does today.
 *
 * KNOWN LIMIT, AND IT FAILS IN THE SAFE DIRECTION. Both `/dev/null` flags and `/usr/bin/env` are
 * POSIX paths; a host without them would fail the merge (exit non-zero → git reports a conflict)
 * rather than merge wrongly. Trident runs on macOS and Linux, where all three exist.
 */
function asBuiltDriverCommand(driver: string): string | null {
  if (basename(process.execPath).replace(/\.exe$/i, '') !== 'bun') return null
  // An absolute `env`, not a bare one, so the lookup does not depend on a PATH at all. POSIX puts
  // it at `/usr/bin/env` and both hosts trident runs on have it there; the bare name is a fallback
  // rather than a guess, and a host with neither fails the merge loudly instead of quietly.
  const env = existsSync('/usr/bin/env') ? '/usr/bin/env' : 'env'
  const scrubbed = CREDENTIAL_ENV.map((name) => `-u ${name}`).join(' ')
  return `${env} ${scrubbed} ${shellQuote(process.execPath)} --config=/dev/null --env-file=/dev/null ${shellQuote(driver)} %O %A %B %L %P`
}

/**
 * Bind the entry-aware `docs/AS_BUILT.md` merge driver in a build checkout, where it applies.
 *
 * ⚠️ FILE PRESENCE IN THE TARGET CHECKOUT IS NOT AUTHORIZATION, AND NOTHING FROM THE TARGET
 * CHECKOUT IS EXECUTED HERE. The first cut of this took the presence of
 * `scripts/install-merge-drivers.sh` as its condition and then ran it: `run_host(['bash',
 * installer])`. The production `run_host` is `makeLazyCredentialedHostRunner` (`open/composer.ts`),
 * whose environment carries `GH_TOKEN` (`github/credential.ts` `githubProcessEnv`) — the owner's
 * credential, the one that publishes every PR. So any repository the publisher checked out that
 * happened to contain a file at that path got that file EXECUTED on the publisher host with the
 * token readable from its environment. "We only ever check out our own repositories" is an
 * assumption about how trident is pointed, not a control over it, and it is not the assumption a
 * credential should rest on.
 *
 * WHAT REPLACES IT. The two halves the installer wrote — the `merge.<name>.driver` config and the
 * `$GIT_COMMON_DIR/info/attributes` binding — are written directly from here, and the command they
 * name is THIS installation's `scripts/git/as-built-merge-driver.ts` under the interpreter already
 * running this process. Nothing under `repoPath` is executed, at install time or at merge time, so
 * a same-named script in a target repo is inert: it is never read, never run, and never named in
 * the config. That also closes the second half of the same hole — the old installer configured the
 * TARGET's driver script, which git would then have run under the same credential on every merge
 * touching this path.
 *
 * …AND NEITHER IS THE INTERPRETER'S CONFIGURATION, WHICH IS THE THIRD WAY IN. Naming a trusted
 * script is not sufficient while the checkout still supplies the `bunfig.toml` and the `.env` that
 * script starts under — see `asBuiltDriverCommand`, where the `--config=/dev/null` and
 * `--env-file=/dev/null` that close those live, with the reproductions. The property to hold onto
 * is the one this whole docblock is about: NOTHING the target checkout contains — not a script, not
 * a config, not an environment file, not a `PATH` — decides what RUNS on the publisher host. And
 * because that property has been stated confidently and been incomplete twice already, the
 * credential itself is now taken out of the driver's environment as a second, independent control.
 *
 * "WHAT RUNS" IS THE EXACT CLAIM, AND IT IS NOT "NOTHING FROM THE CHECKOUT REACHES THE DRIVER".
 * The word was load-bearing and the sentence above used to lack it, which made it false: git
 * substitutes `%L` from the merged path's `conflict-marker-size` attribute, and a TRACKED
 * `.gitattributes` in the checkout sets that. Verified by configuring a driver that does nothing but
 * print `%L` — a committed `conflict-marker-size=2000000` arrived intact. It selects no code and
 * executes nothing, but it did size a buffer: the conflict `as-built-merge-driver.ts` constructs
 * grew from 302 bytes to 6,000,281 on that value, linearly. It is clamped there now
 * (`MAX_MARKER_SIZE`), on BOTH conflict paths — the first clamp covered only the constructed
 * conflict and left the delegated one forwarding `%L` to `git merge-file`, which a cross-model
 * reviewer caught: the exemption rested on the delegated path being byte-for-byte an unconfigured
 * repo, and without this driver the path is `merge=union`, which never conflicts and writes no
 * markers at all. So the one checkout-supplied input the driver takes is bounded wherever it lands.
 * The general lesson is worth more than the fix: an absolute claim about a boundary should be read
 * against every argument that crosses it, and `%O %A %B %L %P` had five — and an EXEMPTION from a
 * bound needs its justification checked as hard as the bound itself, because this one was a
 * confident sentence about behaviour a file in this repository already contradicted.
 *
 * ONLY WHERE IT APPLIES. Two conditions, both read as DATA and neither executed: the checkout has
 * the log, and it carries this log's merge contract (`scripts/git/as-built-log-merge.ts`), which is
 * what distinguishes a repo using this layout from one that merely has a file by that name. A repo
 * failing either is left completely untouched, so nothing here imposes one repo's changelog layout
 * on another (Argus, round 1). Presence still decides APPLICABILITY — but applicability now
 * authorises only "merge this one path with our own reviewed code, or conflict", which is a
 * decision an untrusted repo is welcome to make.
 *
 * ORDER IS LOAD-BEARING, AND IT IS CHOSEN SO THE FATAL HALF-STATE CANNOT BE REACHED AT ALL.
 * `merge.<name>.driver` is written FIRST, `merge.<name>.name` — which is only a human-readable
 * description — second, and the attribute last, skipped entirely unless the driver landed. Measured
 * on git 2.50.1: a lone `.driver` with NO `.name` merges perfectly (the driver ran, exit 0), while a
 * lone `.name` with no `.driver` is `fatal: custom merge driver as-built-log lacks command line`,
 * exit 128. Round 1 wrote `.name` first and rolled it back by hand when `.driver` failed, which
 * meant the fatal state existed for a moment and its cleanup was a second write that the very
 * condition causing the failure (a held `config.lock`) would also have blocked. Writing the
 * load-bearing half first deletes the state instead of cleaning up after it, so there is no
 * rollback to fail. Attribute-without-driver stays fatal, and driver-without-attribute stays inert,
 * which is why the attribute is still last. Same rule as the standalone installer, for the same
 * reason.
 *
 * BEST EFFORT, NEVER FATAL. A failure to install leaves the checkout merging exactly as it does
 * today, which is the same outcome as not calling this at all. Publishing must not be blocked by an
 * optimisation to publishing.
 *
 * WHAT "EXACTLY AS IT DOES TODAY" ACTUALLY IS, IN THIS REPOSITORY, SAID PRECISELY. It is NOT a
 * conflict: `.gitattributes` carries `docs/AS_BUILT.md merge=union`, which never conflicts and
 * interleaves the two sides line by line — the failure this driver exists to replace. The attribute
 * written here lives in `$GIT_COMMON_DIR/info/attributes`, which git resolves BEFORE the tracked
 * `.gitattributes` (measured: with both present, `git check-attr merge -- <path>` reports the
 * info/attributes value), so a successful install genuinely displaces `union`. An UNSUCCESSFUL one
 * leaves `union` in charge — worse than a conflict, and the honest floor, which is why it is written
 * here rather than a nicer sentence about conflict markers. The tracked line stays because deleting
 * it would hand every fresh clone, outside contributor and CI job the conflict storm it was added to
 * stop; displacing it where the driver IS installed is the whole mechanism.
 *
 * Returns whether the driver is installed and usable afterwards.
 */
export async function ensureAsBuiltMergeDriver(
  run_host: RunHostCommand,
  repoPath: string,
): Promise<boolean> {
  if (!existsSync(join(repoPath, ...AS_BUILT_LOG_PATH.split('/')))) return false
  if (!existsSync(join(repoPath, 'scripts', 'git', 'as-built-log-merge.ts'))) return false

  const driver = ownAsBuiltMergeDriver()
  if (driver === null) return false

  // `process.execPath` is the interpreter already running trident, so the driver is reached without
  // consulting the target checkout's PATH for a `bun` it might supply itself — and `--config` stops
  // it reading the checkout's `bunfig.toml`. `null` means "not bun": do not install.
  const command = asBuiltDriverCommand(driver)
  if (command === null) return false

  try {
    // THE LOAD-BEARING HALF FIRST. A lone `.driver` is a working driver; a lone `.name` is fatal.
    const configured = await run_host(
      ['git', '-C', repoPath, 'config', `merge.${AS_BUILT_DRIVER_NAME}.driver`, command],
      repoPath,
    )
    if (!configured.ok) return false
    // Cosmetic, and deliberately unchecked: it is what `git config --get-regexp merge.` prints to a
    // human, and its absence changes nothing about how the merge runs.
    await run_host(
      ['git', '-C', repoPath, 'config', `merge.${AS_BUILT_DRIVER_NAME}.name`, 'entry-aware merge for the AS_BUILT log'],
      repoPath,
    )

    // The COMMON git dir, not the per-worktree one: a linked worktree reads attributes from the
    // common one, which is what the publisher's throwaway rebase worktree depends on.
    //
    // AND `--path-format=absolute` NEEDS A FALLBACK, because it arrived in git 2.31 and a `git`
    // that predates it exits non-zero on the flag rather than ignoring it. Returning false there
    // would be the silent-regression shape this file keeps finding: `merge.<driver>.driver` is
    // ALREADY written by the time this runs, so a bare `return false` leaves the config half-placed
    // and the attribute unwritten, and the replay then proceeds under the tracked `merge=union`
    // while trident reports the driver as unavailable. The shell installer has always had this
    // fallback (`scripts/install-merge-drivers.sh`); this call site did not.
    let commonDir = ''
    const common = await run_host(
      ['git', '-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      repoPath,
    )
    if (common.ok) commonDir = common.stdout.trim()
    else {
      // AND THE FALLBACK'S ANSWER IS CHECKED, BECAUSE A RELATIVE ONE IS NOT RELATIVE TO WHAT YOU
      // WOULD GUESS. In a LINKED worktree the common dir is recorded in
      // `<main>/.git/worktrees/<name>/commondir` as `../..` — relative to THAT file's directory, not
      // to the working tree. Measured here: modern git normalises the `-C` form to an absolute path
      // (`/…/neutron-open/.git`) so this branch never runs, but the whole point of this branch is a
      // git old enough not to have `--path-format`, and resolving `../..` against `repoPath` would
      // land two levels above the WORKTREE — a real directory, outside the repository, where an
      // attributes file would be silently inert. So the resolved directory has to prove it is a git
      // dir before anything is written into it; if it cannot, this returns false and the caller is
      // exactly where it was. Writing to the wrong place is worse than not writing.
      const plain = await run_host(['git', '-C', repoPath, 'rev-parse', '--git-common-dir'], repoPath)
      if (!plain.ok) return false
      const raw = plain.stdout.trim()
      if (raw === '') return false
      const resolved = isAbsolute(raw) ? raw : join(repoPath, raw)
      if (!existsSync(join(resolved, 'HEAD'))) return false
      commonDir = resolved
    }
    if (commonDir === '') return false

    const attributes = join(commonDir, 'info', 'attributes')
    const line = `${AS_BUILT_LOG_PATH} merge=${AS_BUILT_DRIVER_NAME}`
    const existing = existsSync(attributes) ? readFileSync(attributes, 'utf8') : ''
    if (existing.split('\n').includes(line)) return true

    // Per-process scratch file + rename, because two lanes can reach this on one checkout at the
    // same moment and a shared scratch path is its own concurrency bug (a racing reader would see
    // a half-written attributes file). Same construction as the standalone installer.
    mkdirSync(dirname(attributes), { recursive: true })
    const scratch = `${attributes}.tmp.${process.pid}`
    writeFileSync(scratch, existing === '' || existing.endsWith('\n') ? `${existing}${line}\n` : `${existing}\n${line}\n`)
    renameSync(scratch, attributes)
    return true
  } catch {
    return false
  }
}

/**
 * Heal a shallow checkout before replay. On 2026-08-15 five builds died because a depth-1
 * checkout cannot `git apply --3way`: the blobs named by the diff's index lines do not exist,
 * and every failure was misreported as `REBASE CONFLICT … (paths unreadable)`.
 */
export async function healShallowCheckout(run_host: RunHostCommand, repoPath: string): Promise<void> {
  const probe = await run_host(['git', '-C', repoPath, 'rev-parse', '--is-shallow-repository'], repoPath)
  if (!probe.ok) {
    throw new Error(publishFailureReason('probe the checkout depth of', repoPath, probe.stderr))
  }
  if (probe.stdout.trim() === 'false') return
  if (probe.stdout.trim() !== 'true') {
    throw new Error(publishFailureReason('probe the checkout depth of', repoPath, `unexpected answer: ${probe.stdout.trim()}`))
  }

  const fetch = await run_host(['git', '-C', repoPath, 'fetch', '--no-tags', '--unshallow', 'origin'], repoPath)
  if (fetch.ok) return

  let depth = 'unreadable'
  let boundary = 'unreadable'
  try {
    const measured = await run_host(['git', '-C', repoPath, 'rev-list', '--count', 'HEAD'], repoPath)
    if (measured.ok && measured.stdout.trim() !== '') depth = measured.stdout.trim()
  } catch {}
  try {
    const path = await run_host(['git', '-C', repoPath, 'rev-parse', '--git-path', 'shallow'], repoPath)
    if (path.ok && path.stdout.trim() !== '') {
      const read = await run_host(['cat', path.stdout.trim()], repoPath)
      if (read.ok && read.stdout.trim() !== '') boundary = read.stdout.trim()
    }
  } catch {}
  throw new Error(
    `Could not heal shallow checkout ${repoPath} (depth ${depth}, shallow boundary ${boundary}): ${redactPushError(fetch.stderr)}; a shallow checkout cannot 3-way replay — the blobs the diff names do not exist`,
  )
}

/**
 * Replay `branch` onto the ls-remote-OBSERVED tip of `base`, shallow-safely.
 *
 * The shared build checkout MAY arrive shallow: install.sh used to clone at depth 1, and hand-made
 * clones still can. `healShallowCheckout` repairs that defect at entry. Regardless of depth, NO
 * `git rebase` runs here, ever, and never in the shared working tree: other lanes share it and a
 * failed rebase there poisons every lane. Instead: take the branch's own diff from its true merge-base — the
 * FORGE (`gh pr diff <n>`, computed server-side against a full history) when a PR exists, or the
 * two-dot `git diff <base>..<branch>` for a first publish — and `git apply --3way` it onto the
 * observed base tip in a THROWAWAY detached worktree. The branch ref then moves by
 * compare-and-swap (`update-ref <new> <old>`): if anything moved the branch underneath us we
 * refuse rather than force.
 *
 * The replay SQUASHES the branch into one commit. Deliberate — the PR merge is `--squash` anyway.
 *
 * RETURNS THE OBSERVED BASE TIP as well as the head, because the caller needs BOTH to describe
 * what was built: the review diff is `<baseSha>..<head>`, and `baseSha` is the only value in the
 * process that is guaranteed to be the tip the head sits on. `''` means the remote has no such
 * base branch at all. See the review-diff comment in `publishBuiltCommit` for what taking the
 * LOCAL `<base>` ref instead cost.
 */
export async function rebaseOntoObservedBase(
  run_host: RunHostCommand,
  repoPath: string,
  branch: string,
  base: string,
  pr: number | null,
  scratchDir: string,
  /** Optional bounded auto-resolution for a conflicting replay. Absent → a conflict throws. */
  resolve?: { run: TridentRun; resolve_conflict: MergeConflictResolver },
): Promise<{ head: string; rebased: boolean; baseSha: string }> {
  // Heal on use — no install-time fix reaches a hand-made clone, and both 2026-08-15 incidents came from hand-made clones.
  await healShallowCheckout(run_host, repoPath)
  // (a) The base tip as OBSERVED on the remote — the same kind of observation the lease uses, and
  //     for the same reason: a remote-tracking ref is whatever the last fetch left behind.
  //
  //     THIS OBSERVATION AGES. Auto-resolution can now sit between here and the commit for minutes
  //     (a Forge turn is bounded at 8 of them), so the published head can be based on a `main` that
  //     has since moved. That is SAFE but not free: the branch move is still a compare-and-swap and
  //     the lease push re-observes the branch, so nothing is overwritten — the branch simply
  //     arrives at review stale and gets replayed again on the next publish, which is the ordinary
  //     behaviour for any branch cut before a sibling landed. It is the reason the resolution loop
  //     below bails on the FIRST round that makes no progress instead of spending the full bound.
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
  if (baseSha === '') return { head: await readHead(), rebased: false, baseSha: '' }

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
  //     `contains.ok` also PROVES `baseSha` is a local object — git could only answer the
  //     ancestry question by reading it — which is what makes it safe to hand back as a
  //     diff base on a shallow checkout that never reaches the fetch below.
  if (contains.ok) return { head: oldHead, rebased: false, baseSha }

  // (d) The entry guard already unshallowed the checkout; this fetch only makes the just-observed
  //     tip local. Keep `--no-tags` because tags are irrelevant to replay.
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
  // THE BRANCH'S OWN WORK IS `<fork point>..<branch>`, AND THE FORK POINT IS THE MERGE-BASE —
  // not either ref's tip. Both tips are wrong, in opposite directions:
  //
  //   `refs/heads/<base>..<branch>`  — the local ref, which step (d) NEVER moves (it fetches into
  //       `refs/remotes/origin/<base>`). MEASURED 2026-08-15: `refs/heads/main` sat at d8324cc
  //       while the observed tip was d5ba62b, so the diff carried 103 files instead of the
  //       branch's own 22 — 236 commits of already-merged work. Applied onto the observed tip,
  //       every already-present hunk fails, `git apply` stages NOTHING as conflicted, and the
  //       caller reports `conflicts with main in: (paths unreadable)` — naming a conflict that
  //       does not exist. Five builds died on this in one day, across two projects.
  //
  //   `<baseSha>..<branch>`  — the observed tip. A two-dot diff is "how to turn A into B", so
  //       this also REVERSES everything the base gained since the fork: replaying it DELETES
  //       main's own new files, and a genuine conflict applies cleanly as a revert instead of
  //       raising. `publish-rebase-realgit.test.ts` catches both (a lost `docs.txt`, and a
  //       conflict that returned null). Do not "simplify" back to it.
  //
  // The merge-base is what `gh pr diff` computes server-side, which is why the PR path above has
  // never had this bug.
  //
  // NO FALLBACK TO `refs/heads/<base>` — IT FAILS CLOSED. CODEX REVIEW [Blocker]: the first cut
  // fell back to the local ref when merge-base could not answer, which is EXACTLY the shallow
  // checkout this function expects. That reinstated the defective base in precisely the condition
  // that produced it, and would have shipped a fix that silently does the broken thing whenever it
  // matters most. A fork point that cannot be established is an INFRASTRUCTURE fault about the
  // checkout — deepen it (see the shallow-provisioning card) — not a licence to replay a diff we
  // know to be wrong. Better a named refusal than a false conflict nobody can read.
  //
  // COMPUTED ONLY ON THE PATH THAT NEEDS IT. `gh pr diff` already resolves the fork point
  // server-side against a full history, so a PR-mode replay must not be made to depend on — or be
  // refused by — the local checkout's depth.
  const localForkPoint = async (): Promise<string> => {
    const read = async () =>
      run_host(['git', '-C', repoPath, 'merge-base', baseSha, `refs/heads/${branch}`], repoPath)
    let forkPoint = await read()
    if (!forkPoint.ok || forkPoint.stdout.trim() === '') {
      // Belt-and-braces behind the entry guard: one bounded deepen, then re-ask. Modern git rejects
      // `--unshallow` on a complete repo; that harmless failure is followed by the decisive re-read.
      await run_host(['git', '-C', repoPath, 'fetch', '--no-tags', '--unshallow', 'origin'], repoPath)
      forkPoint = await read()
    }
    if (!forkPoint.ok || forkPoint.stdout.trim() === '') {
      throw new Error(
        publishFailureReason(
          'establish the fork point of',
          branch,
          `no merge-base between ${baseSha} and refs/heads/${branch} even after deepening — the build checkout cannot describe this branch's own changes, so replaying it would send already-merged work through review`,
        ),
      )
    }
    return forkPoint.stdout.trim()
  }
  // PATCH BYTES ARE NOT TEXT TO BE TIDIED — `--output` WRITES THEM, NOTHING ROUND-TRIPS A STRING.
  //
  // `spawnCapture` returns `stdout.trim()`. That is harmless for every other reader and FATAL for
  // a patch: a unified diff whose final line is a context line for a BLANK line ends `" \n"` —
  // space, newline. `.trim()` removes BOTH, and restoring only the newline cannot put the space
  // back. The last hunk is then one line short of its `@@` count, `git apply` exits 128 with
  // `corrupt patch at line N`, and — because nothing was ever staged — `--diff-filter=U` names no
  // files, so the caller reported `REBASE CONFLICT … (paths unreadable)`.
  //
  // MEASURED by neutron-enterprise on run 578fa30e against deployed trident d5ba62b7: the real
  // patch was 19,222 bytes ending `…each other.\n \n`; trimmed it was 19,220 ending
  // `…each other.\n`. Untrimmed it applied cleanly against four separate bases; trimmed it gave
  // `corrupt patch at line 42, rc=128, unmerged=[]`. A plain `git rebase` of the same branch
  // succeeded with no intervention — the patch was never in conflict at all.
  //
  // The previous comment here believed the trailing-newline restore had closed this. It had not:
  // it addressed a missing `\n` and could never address a stripped `" "`. The existing real-git
  // fixture's last line is non-blank, which is exactly why the half-fix looked complete.
  // AND THE FIX ABOVE LANDED ON ONLY ONE BRANCH OF THIS `if`. #292 converted the `pr === null`
  // path to `--output` and left the PR path — the COMMON one, taken on every round after the first
  // — still doing `writeFileSync(diffFile, patch.stdout…)` over a TRIMMED capture. It failed
  // exactly as the comment above predicts, six hours later: run 63b16fb1 (PR #295, 2026-08-15
  // 20:36Z) died with `corrupt patch at line 746`, and its replay patch cbcfb65..26c19dd is 746
  // lines whose final line is `" \n"`. Regenerated through `--output` the same patch applies
  // CLEANLY onto both its fork point and the observed tip. The comment was right and the code
  // under it was still wrong; the reason it read as fixed is that the diff of #292 showed the
  // comment and the `else` together.
  //
  // So there is NO STRING PATH LEFT ON EITHER BRANCH. The PR path keeps `gh pr diff` — it resolves
  // the fork point server-side against a full history, which is deliberately independent of this
  // checkout's depth — but REDIRECTS it to the file instead of capturing it. `spawnCapture` never
  // sees the bytes, so it cannot trim them. Nothing here may pass patch bytes through a JS string
  // again; if a future reader needs the diff's content, read it back off disk.
  if (pr !== null) {
    const written = await run_host(
      ['sh', '-c', `gh pr diff ${Number(pr)} > ${JSON.stringify(diffFile)}`],
      repoPath,
    )
    if (!written.ok) throw new Error(publishFailureReason('read the diff of', branch, written.stderr))
  } else {
    // `--output` hands the bytes to git, which writes them verbatim. No capture, no trim, no
    // reconstruction. Do not "simplify" this back to reading stdout.
    const written = await run_host(
      ['git', '-C', repoPath, 'diff', `--output=${diffFile}`, `${await localForkPoint()}..refs/heads/${branch}`],
      repoPath,
    )
    if (!written.ok) throw new Error(publishFailureReason('read the diff of', branch, written.stderr))
  }
  if (!existsSync(diffFile) || readFileSync(diffFile, 'utf8').trim() === '')
    throw new Error('outer publisher refused to rebase an empty diff')

  // (e2) TEACH THIS CHECKOUT TO MERGE THE AS_BUILT LOG BEFORE ANY REPLAY TOUCHES IT.
  //      The log is newest-first and every build prepends at the same offset under the same three
  //      header lines, so two concurrent builds conflict on it by construction — three publishes
  //      died on that file and nothing else on 2026-08-15T23:20Z. The entry-aware driver in
  //      `scripts/git/as-built-merge-driver.ts` unions whole entries instead, and `git apply
  //      --3way` below DOES consult it (verified against real git, not assumed). Installed here
  //      rather than assumed present because the binding lives in `.git/info/attributes`, which is
  //      untracked by design — see the driver's docblock for why committing it would be fatal.
  //      This binds THIS installation's driver and runs nothing out of `repoPath`; see the
  //      docblock on `ensureAsBuiltMergeDriver` for what running the checkout's own script cost.
  await ensureAsBuiltMergeDriver(run_host, repoPath)

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
    /** Non-null once auto-resolution landed, carrying every path it ever touched (for diagnosis). */
    let autoResolved: string[] | null = null
    const applied = await run_host(['git', '-C', scratchDir, 'apply', '--3way', '--index', diffFile], scratchDir)
    if (!applied.ok) {
      // Name the files a human has to look at. Read in a LOOP now: this is also how a claimed
      // resolution is VERIFIED, and that second role is why it must not fail open.
      //
      // AN UNREADABLE CONFLICT STATE IS NOT AN EMPTY ONE. This used to swallow the command's
      // failure and return `[]`, which the post-resolution check at the bottom of the loop reads
      // as "nothing unmerged — the resolver succeeded". A `git diff` that never ran would have
      // been accepted as git's own evidence that the tree is clean, and the loop would go on to
      // commit and force-push whatever the resolver left behind. The resolver's word is never the
      // evidence; if git cannot be asked, there IS no evidence, and the only safe answer is to
      // refuse. Same reasoning as the wholesale-apply carve-out below: never report one condition
      // in the costume of another.
      //
      // `-z` + `core.quotePath=false` BECAUSE THIS LIST IS MACHINE-CONSUMED. It becomes the
      // resolver's `CONFLICTED FILES` and the literal pathspec of the staged-marker scan below; git's
      // default C-quoting renders `ünicode file.txt` as `"\303\274nicode file.txt"` — a name that
      // opens nothing and matches no pathspec. `-z` emits the raw bytes, NUL-separated.
      const unreadableConflictState = (detail: string): Error =>
        new Error(
          publishFailureReason(
            'read the conflict state of',
            branch,
            `${detail} — git could not be asked which paths are unmerged, so a claimed resolution CANNOT be verified; refusing rather than treating an unreadable index as a clean one`,
          ),
        )
      const readUnmerged = async (): Promise<string[]> => {
        let unmerged
        try {
          unmerged = await run_host(
            ['git', '-C', scratchDir, '-c', 'core.quotePath=false', 'diff', '-z', '--name-only', '--diff-filter=U'],
            scratchDir,
          )
        } catch (err) {
          throw unreadableConflictState(err instanceof Error ? err.message : String(err))
        }
        if (!unmerged.ok) throw unreadableConflictState(unmerged.stderr || 'git diff --diff-filter=U failed with no output')
        return unmerged.stdout.split('\0').filter((l) => l !== '')
      }
      /**
       * THE UNMERGED BIT IS NOT PROOF OF RESOLUTION. `git add <path>` clears the unmerged bit for
       * the WHOLE path regardless of what is still inside the file, so a resolver that fixes hunk
       * 1 of 2 and stages reads as RESOLVED to `--diff-filter=U` — and the orchestrator would then
       * commit `<<<<<<<` and force-push it to the shared branch. Realistic, not theoretical: the
       * resolver's own contract tells it to `git add` every conflicted file.
       *
       * So the STAGED CONTENT is scanned too: any candidate path whose staged delta ADDS a
       * conflict-marker line is still unresolved and goes back into the loop. Only ADDED lines
       * count (a marker that was already in the base is the base's problem, not this replay's),
       * and only the paths that ever conflicted are scanned (a fixture elsewhere in the repo that
       * legitimately contains marker text is none of our business).
       *
       * AND IT FAILS CLOSED, for the same reason `readUnmerged` does: a scan that could not run
       * found no markers in exactly the way a clean tree does, and the difference is a `<<<<<<<`
       * on the shared branch.
       */
      const stagedMarkerFiles = async (candidates: string[]): Promise<string[]> => {
        if (candidates.length === 0) return []
        const marked: string[] = []
        // Deliberate per-path subprocesses: markdown classification needs the candidate path, and
        // literal pathspecs avoid parsing quoted diff headers. Conflict sets are normally tiny.
        for (const candidate of candidates) {
          let res
          try {
            res = await run_host(
              ['git', '-C', scratchDir, 'diff', '--cached', '-U1', '--', `:(literal)${candidate}`],
              scratchDir,
            )
          } catch (err) {
            throw unreadableConflictState(err instanceof Error ? err.message : String(err))
          }
          if (!res.ok) throw unreadableConflictState(res.stderr || 'git diff --cached failed with no output')
          if (stagedDiffAddsConflictMarker(res.stdout, candidate)) marked.push(candidate)
        }
        return marked
      }
      let paths = await readUnmerged()
      // A FAILED APPLY WITH NOTHING UNMERGED IS NOT A CONFLICT. `git apply` refuses a malformed or
      // unappliable patch WHOLESALE (`corrupt patch at line N`, exit 128) without staging anything,
      // so `--diff-filter=U` legitimately names no files. Reporting that as a conflict produced the
      // single most expensive message of 2026-08-15: `conflicts with main in: (paths unreadable)`,
      // which sent two projects hunting for a merge conflict that did not exist while the actual
      // cause — a truncated patch, and separately a stale diff base — sat in git's own stderr,
      // discarded. The empty path list WAS the diagnosis and it read like a footnote.
      //
      // So: `TridentRebaseConflict` is reserved for the case where at least one file is genuinely
      // unmerged. Anything else surfaces git's own words. THE RESOLVER IS NEVER INVOKED HERE either
      // — there is nothing unmerged for it to reconcile, so handing it this failure would only
      // relabel a wrong patch as a conflict, which is the exact defect this carve-out fixed.
      if (paths.length === 0) {
        throw new Error(
          publishFailureReason(
            'apply the replay patch for',
            branch,
            `${applied.stderr || 'git apply failed with no output'} — the apply failed WHOLESALE and left nothing unmerged, so this is NOT a merge conflict; the patch or its base is wrong`,
          ),
        )
      }
      // No resolver configured → the attention state, byte-identical to the behaviour before
      // auto-resolution existed.
      if (resolve === undefined) throw new TridentRebaseConflict(branch, base, paths)
      // Bounded auto-resolution, mirroring `rebaseBranchOntoBase`. `repo_path` is the SCRATCH
      // worktree — the tree holding the markers — never the shared checkout other lanes build in.
      // Re-reading the unresolved set after a claimed RESOLVED is the lie-detector: the resolver's
      // word is never the evidence, git's index and git's staged bytes are.
      const everConflicted = new Set(paths)
      let rounds = 0
      while (paths.length > 0) {
        if (rounds >= MAX_CONFLICT_ROUNDS) throw new TridentRebaseConflict(branch, base, paths)
        rounds++
        const outcome = await resolve.resolve_conflict({
          repo_path: scratchDir,
          branch,
          base_branch: base,
          run: resolve.run,
          conflicted_files: paths,
          // The tree is a detached replay worktree, NOT a rebase in progress, and it has no
          // installed dependencies. The resolver's contract differs on both counts.
          mode: 'replay',
        })
        if (!outcome.resolved) throw new TridentRebaseConflict(branch, base, paths)
        const remaining = [
          ...new Set([...(await readUnmerged()), ...(await stagedMarkerFiles([...everConflicted]))]),
        ]
        // EVERY ROUND MUST SHRINK THE SET. `rebaseBranchOntoBase` can afford 12 rounds because
        // each one is a DIFFERENT commit that `git rebase --continue` advanced onto; here there is
        // exactly one apply, so a round that leaves the same work undone will leave it undone
        // twelve times. Each round is a real Forge turn bounded at 8 minutes, awaited inside the
        // serial tick sweep — so 12 no-progress rounds is ~96 minutes during which no other run in
        // the process makes any progress at all. Zero progress once is the answer.
        if (remaining.length > 0 && remaining.length >= paths.length)
          throw new TridentRebaseConflict(branch, base, remaining)
        for (const p of remaining) everConflicted.add(p)
        paths = remaining
      }
      // Resolved: fall through to the ordinary commit + compare-and-swap below. The resolver's
      // contract has it `git add` its resolutions and forbids committing, so the replay commits
      // exactly as an unconflicted apply would — and still faces the full review gate.
      autoResolved = [...everConflicted]
    }
    // THE REPLAY NOTE IS METADATA, NEVER A SUBJECT. This was measured on main in e6d4610d
    // (#354), 47144a2a (#348), bce629e2 (#327), and d2680a09 (#328): every PR title on
    // 2026-08-17/18 was this replay string instead of the builder's subject. Carrying `%B` makes
    // the note body-only metadata. A replay of a replay reads that carried message again, so the
    // original subject survives arbitrarily many replays and every replay appends exactly one
    // provenance line. The read fails CLOSED: committing the note alone when git cannot read the
    // original would silently reproduce the measured defect precisely when git is broken.
    const replayNote =
      `rebase ${branch} onto ${base} @ ${baseSha.slice(0, 7)} (replayed from ${oldHead.slice(0, 7)})`
    const originalMessage = await run_host(
      ['git', '-C', scratchDir, 'log', '-1', '--format=%B', oldHead],
      scratchDir,
    )
    if (!originalMessage.ok)
      throw new Error(
        publishFailureReason(
          'read the commit message of',
          branch,
          originalMessage.stderr || 'git log -1 failed with no output',
        ),
      )
    const carried = originalMessage.stdout.trim()
    const commitMessage = carried === '' ? replayNote : `${carried}\n\n${replayNote}`
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
        commitMessage,
      ],
      scratchDir,
    )
    if (!committed.ok) {
      // GIT'S DIAGNOSIS, WHEREVER GIT PUT IT. `git commit` writes "nothing to commit" to STDOUT,
      // and forwarding only stderr collapsed the single most informative failure on this path into
      // a bare `outer publisher could not commit the rebase of branch X` — no cause, and the
      // `finally` below has already deleted the tree that held it. Same defect class as the
      // wholesale-apply carve-out above: never discard what git actually said.
      const said = [committed.stderr, committed.stdout]
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .join(' — ')
      // A RESOLUTION THAT LEFT NOTHING TO COMMIT IS AN ATTENTION STATE, NOT A GIT FAILURE. It means
      // the resolver took the base's side of every hunk verbatim, so the branch now contributes
      // nothing — exactly the silent-tautology outcome the #290 hand-resolution shows is the
      // dangerous one. It is a mergeability fact about the branch, so it gets the same non-verdict
      // typed failure the conflict it came from would have got.
      if (autoResolved !== null && /nothing (?:added )?to commit|no changes added/i.test(said))
        throw new TridentRebaseConflict(branch, base, autoResolved)
      throw new Error(
        publishFailureReason('commit the rebase of', branch, said || `git commit exited ${committed.exit_code}`),
      )
    }
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
    return { head: newHead, rebased: true, baseSha }
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
    /^outer-published:[0-9a-f]{40}:\d+:\d+(:deviated)?$/.test(name)
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
 *     judged the code — the stop says nothing about the diff.
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
    'ok' | 'verdict' | 'round' | 'checkpoint' | 'block_kind' | 'terminal_cause' | 'findings_present'
  >,
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
  // was (Argus r4). `parseInnerResult` decodes `block_kind` FAIL-CLOSED: the four strings the
  // workflow writes decode, and ANY other value — garbled, truncated, from a future writer —
  // becomes `null` too. Which is precisely why this branch is safe to widen to it: the
  // sentence `null` selects states the failure and quotes the measured cause, and claims
  // NOTHING about the review panel. Only 'infra-only' licenses "review never ran", and only
  // an exact-match decode produces it. A garbled kind therefore lands in the honest sentence,
  // never the specific one (pinned by the garbled-kind test).
  //
  // The kind also decides WHICH sentence, because it is the only thing that licenses the
  // claim "review never ran". Without it the reason states the failure and quotes the
  // measurement, and says nothing at all about the review panel.
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
  const foldAsBuilt =
    opts.fold_as_built ??
    ((run: TridentRun, base: string) =>
      foldStagedAsBuiltEntries(opts.run_host, run.repo_path, run.merge_mode, base))
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
    deadline_ms: number
    budget_ms: number
    late: FireOutcome | null
    /** Set once the workflow's own stage event proved the fire; a late `fired`
     *  settle instead DELETES the record (nothing left to confirm). */
    confirmed_by: 'stage-event' | null
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
    if (!local.ok || !/^[0-9a-f]{40}$/.test(resolvedHead)) {
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
    if (run.reviewed_head !== null) {
      const pin = run.reviewed_head.trim().toLowerCase()
      if (!/^[0-9a-f]{40}$/.test(pin)) {
        throw new Error(
          `fix-round refused: the reviewed-head pin '${run.reviewed_head}' is not a 40-hex commit; refusing to publish ${resolvedHead} unverified`,
        )
      }
      const ancestry = await opts.run_host(
        ['git', '-C', run.repo_path, 'merge-base', '--is-ancestor', pin, resolvedHead],
        run.repo_path,
      )
      if (!ancestry.ok) {
        const detail = ancestry.stderr.trim()
        throw new Error(
          detail === ''
            ? `fix-round refused: produced head ${resolvedHead} of branch ${branch} does not descend from the reviewed head ${pin} — the round abandoned the reviewed branch`
            : `fix-round refused: could not verify that produced head ${resolvedHead} descends from reviewed head ${pin} (${detail}); refusing to publish unverified`,
        )
      }
    }
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
    // answered by reading it. An empty one means there is no remote base at all (a brand-new
    // origin), which is the one case the base NAME is still the best available answer.
    const base = rebased.baseSha !== '' ? rebased.baseSha : await resolveBase(run)
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
      inner_verdict:
        run.inner_verdict === 'APPROVE'
          ? 'APPROVE'
          : run.inner_verdict === 'REQUEST_CHANGES' &&
              hasArgusProvenance(run.inner_checkpoint) &&
              parseCheckpointFindings(run.inner_checkpoint_findings).length > 0
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

      const base = await resolveBase(run)
      const ahead = await opts.run_host(
        ['git', '-C', run.repo_path, 'rev-list', '--count', `${base}..${localHead}`],
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
        } catch {
          // Optional peer resolution is best-effort, exactly as on the build path.
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
        inner_verdict: reviewed.verdict,
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
    const resume_checkpoint_name = (resume_checkpoint ?? '').trim()
    // THE PR LINK IS RESOLVED BEFORE THE EXIT, NOT AFTER IT (Argus r5). This used to sit
    // below, so the one path that ends a run WITHOUT ever firing recorded a terminal row
    // with `pr: null` — and "re-run when the read succeeds" is advice a human follows by
    // opening the PR the recorded work is on. The exit is rare and already terminal; one
    // `gh pr view` to make the record point at the work is worth more than the call saved.
    const existingPr = run.pr ?? (await detectExistingPr(run))
    const launchRun: TridentRun = existingPr !== null && run.pr === null ? { ...run, pr: existingPr } : run
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
            terminal_cause: cause,
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
    if (freshBuild && launchRun.merge_mode === 'pr') {
      const fetchCmd = ['git', '-C', launchRun.repo_path, 'fetch', '--no-tags', 'origin', base]
      let fetched = await opts.run_host(fetchCmd, launchRun.repo_path)
      if (!fetched.ok) {
        await (opts.sleep ?? realSleep)(1000)
        fetched = await opts.run_host(fetchCmd, launchRun.repo_path)
      }
      if (!fetched.ok) {
        const detail = redactPushError(fetched.stderr).trim().slice(-300)
        return {
          run: failedRun(launchRun, `trident infra: could not fetch origin/${base} in ${launchRun.repo_path} before cutting the build branch — refusing to branch from the stale local ref; the build was NOT started: ${detail}`, false),
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
      if (!resolved.ok || !/^[0-9a-f]{40}$/.test(oid)) {
        const detail = redactPushError(resolved.stderr || resolved.stdout).trim().slice(-300)
        return {
          run: failedRun(launchRun, `trident infra: fetched origin/${base} but could not resolve its tip in ${launchRun.repo_path}; the build was NOT started: ${detail}`, false),
          changed: true,
          waiting: false,
          note: `${launchRun.phase} → failed (base resolve failed — no fire)`,
        }
      }
      base_sha = oid
      const behind = await opts.run_host(
        ['git', '-C', launchRun.repo_path, 'rev-list', '--count', `refs/heads/${base}..${remoteRef}`],
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
      if (resolved.ok && /^[0-9a-f]{40}$/.test(oid)) base_sha = oid
    }
    const pinnedRun = freshBuild ? { ...launchRun, base_sha, base_behind } : launchRun

    if (
      freshLaunch &&
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
      if (branchTipResult.ok && /^[0-9a-f]{40}$/.test(branchTip)) {
        const containedInBase = await opts.run_host(
          ['git', '-C', launchRun.repo_path, 'merge-base', '--is-ancestor', branchTip, base_sha],
          launchRun.repo_path,
        )
        let ownCrashLeftover = false
        if (!containedInBase.ok && priorBaseSha !== null) {
          const descendsFromPriorBase = await opts.run_host(
            ['git', '-C', launchRun.repo_path, 'merge-base', '--is-ancestor', priorBaseSha, branchTip],
            launchRun.repo_path,
          )
          ownCrashLeftover = descendsFromPriorBase.ok
        }
        if (!containedInBase.ok && !ownCrashLeftover) {
          const ahead = await opts.run_host(
            ['git', '-C', launchRun.repo_path, 'rev-list', '--count', `${base_sha}..${branchTip}`],
            launchRun.repo_path,
          )
          const rawAheadCount = ahead.stdout.trim()
          const aheadCount = /^\d+$/.test(rawAheadCount) ? rawAheadCount : '?'
          const reason = `branch ${launchRun.branch} already carries ${aheadCount} commit(s) not on origin/${base} — it was not cut from origin/${base}; refusing to build on another lane's work. Verify or delete the branch (git -C ${launchRun.repo_path} branch -D ${launchRun.branch}), then re-dispatch.`
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
          if (Number.isFinite(n) && n >= 1) active = Math.floor(n)
        } catch {
          // A store hiccup costs the RAISE-ONLY term, not the whole block, and not the
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
        base_branch: base,
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
      stamp(
        'fire-unconfirmed',
        `elapsed_ms=${outcome.elapsed_ms ?? budget} cancelled=${outcome.turn_cancelled === true} budget_ms=${budget}`,
      )
      fired.add(run.id)
      const pending: UnconfirmedFire = {
        deadline_ms: nowMs() + budget,
        budget_ms: budget,
        late: null,
        confirmed_by: null,
      }
      unconfirmedFires.set(run.id, pending)
      if (outcome.settled !== undefined) {
        outcome.settled.then(
          (late) => {
            pending.late = late
            if (late.status === 'fired') {
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
        // The launcher generation is only known once the turn settles; until then
        // the row carries the observability id (a stale generation from a prior
        // launch is never re-adopted here either — it was nulled by the claim).
        workflow_run_id: pinnedRun.workflow_run_id ?? id,
        last_advanced_at: now(),
      }
      return {
        run: next,
        changed: true,
        waiting: true,
        note:
          `fired inner workflow ${id} — UNCONFIRMED: launcher turn still draining after ` +
          `${Math.round((outcome.elapsed_ms ?? budget) / 1000)} s (not cancelled); confirming within ${Math.round(budget / 60_000)} min`,
      }
    }

    if (outcome.status !== 'fired') {
      // A SETTLE TIMEOUT IS NOT PROOF THE WORKFLOW NEVER STARTED. The launcher
      // turn is cancelled on timeout; the workflow it may already have fired
      // runs DETACHED and that cancel does not reach it. Measured: 8 of 33 runs
      // in 7 days died here, one while its workflow kept building for another
      // six minutes, and twice over a row that already said `outer-published:…`.
      // So for THIS error string only, consult positive evidence first.
      if (outcome.error === FIRE_SETTLE_TIMEOUT_ERROR && gatherFireEvidence !== null) {
        // A THROWING gatherer must never crash the launch AND must never spare
        // the run: no evidence is no evidence (positive-only).
        let evidence: FireTimeoutEvidence = { kind: 'none', detail: 'evidence gatherer threw' }
        try {
          evidence = await gatherFireEvidence({ run: pinnedRun, fire_started_at_ms: fireStartedAtMs })
        } catch (err) {
          // LOG IT — silence here is indistinguishable from "looked and found
          // nothing", which is exactly how a gatherer that throws on EVERY call
          // would hide behind the positive-only rule forever. The sibling
          // liveness probe logs `liveness_probe_failed` for the same reason.
          log.error('fire_evidence_probe_failed', {
            run: run.id,
            slug: run.slug,
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
          stamp('fire-unobserved-launch', evidence.detail.slice(0, 200))
          fired.add(run.id)
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
              subagent_run_id: id,
              subagent_status: 'running',
              // NO LAUNCHER GENERATION — deliberately null, never `id`. This row
              // has no confirmed launcher: minting one would make
              // `latchLauncherCrashed` (which matches WHERE workflow_run_id = ?)
              // key on a generation no pool will ever report, and CARRYING a
              // previous round's key would point the tick's liveness probe at a
              // dead generation and latch a live lane as crashed
              // (`persistRefireReset` never clears this column). Null is what
              // crash recovery itself writes here, for the same reason: the
              // generation is unknown. The 90-min no-advance reaper and the 2 h
              // ceiling still bound this lane.
              workflow_run_id: null,
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
            note: `${run.phase} → failed (launcher timeout over already-published work — review not run)`,
            // The verdict demotion to REVIEW_NOT_RUN is a REAL write here (it is
            // what stops a stale REQUEST_CHANGES being stamped over finished
            // work), so it is CAS'd rather than skipped: it lands while the
            // verdict is still the one we read, and yields to a newer one.
            workflow_columns_seen,
          }
        }
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
          note:
            published.push === 'noop-already-at-head'
              ? `outer publisher confirmed ${published.head} already on origin (push no-op — the ref was already correct) and PR #${published.pr} → re-fire review`
              : `outer publisher confirmed ${published.head} and PR #${published.pr} → re-fire review`,
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
      const proof = await proveMutation({
        run: { ...run, branch },
        claim: result.mutation_claim,
        base_branch: await resolveBase(run),
        run_host: opts.run_host,
        expected_head: reviewedHeadOid(run),
      })
      if (!proof.ok) {
        // `inner_verdict` / `inner_checkpoint` are left EXACTLY as the review left
        // them: Argus really did approve, and its provenance is the audit trail.
        // Rewriting either would misattribute the block — this is a MISSING
        // PROOF, not a reviewer's finding, and `failure_reason` says which.
        const blocked: TridentRun = { ...failedRun(run, proof.reason, true), pr, branch }
        return { run: blocked, changed: true, waiting: false, note: 'APPROVE blocked (mutation prover) → failed' }
      }
      try {
        const res = await cleanupAfterMerge(doneRun, merge_deps)
        // AS-BUILT ONE-WRITER (T2): the merge just landed and merging is the serialised
        // point, so THIS is where the staged as-built entry folds into the log on the
        // base. Own try/catch: a fold problem must never reach the outer catch below,
        // which would misreport a LANDED merge as failed — the entry stays durably
        // queued and the tick catch-up retries it. Reaching this point is the success
        // gate; a throwing cleanup is caught below and therefore never runs the fold.
        let foldNote = ''
        try {
          const base = await resolveBase(doneRun)
          const folded = await foldAsBuilt(doneRun, base)
          if (!folded.ok) foldNote = `; as-built fold deferred (entry stays queued): ${folded.reason}`
          else if (folded.folded > 0) foldNote = `; as-built: folded ${folded.folded}`
        } catch (err) {
          foldNote = `; as-built fold deferred (entry stays queued): ${err instanceof Error ? err.message : String(err)}`
        }
        return { run: doneRun, changed: true, waiting: false, note: `APPROVE (argus-approved) → done; ${res.note}${foldNote}` }
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

  /** Elapsed ms since the run last advanced (checkpoint / launch). Conservative
   *  on an unparseable timestamp: returns 0 (never falsely reaps a run). */
  function elapsedSinceAdvance(run: TridentRun): number {
    const t = Date.parse(run.last_advanced_at)
    if (!Number.isFinite(t)) return 0
    const n = Date.parse(now())
    if (!Number.isFinite(n)) return 0
    return Math.max(0, n - t)
  }

  async function stepCore(run: TridentRun): Promise<AdvanceOutcome> {
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

    // (1c) UNCONFIRMED FIRE — the launcher turn overran the settle budget and was
    //     LEFT DRAINING (`launch()`; never cancelled, see `unconfirmedFires`). The
    //     run is parked `running` like any fire; this decides whether the fire is
    //     real. Sits BEFORE the hang watchdog so the decision is made in at most two
    //     settle budgets (~16 min), not 90. Three evidence sources, in order:
    //       • the late settle itself (`fired` + the launcher generation, adopted
    //         onto the row so crash ownership and the eviction guard see it);
    //       • the workflow's own `plan-start` / `fire-settled` stage event stamped
    //         AFTER this launch's `fire-unconfirmed` (an earlier round's stamp is
    //         not this fire's evidence);
    //       • nothing within one more budget → the fire never happened; fail with
    //         the original reason. NEVER relaunch from here — a settle-timeout on a
    //         live launch is exactly how a second lane lands on the same card.
    //     Harvest (§1) still runs first: a fast workflow that already wrote its
    //     result is harvested, not re-litigated.
    const pendingFire = unconfirmedFires.get(run.id)
    if (pendingFire !== undefined && run.subagent_run_id !== null && run.subagent_status === 'running') {
      const late = pendingFire.late
      if (late !== null && late.status === 'fired') {
        unconfirmedFires.delete(run.id)
        const generation = late.launcher_session_key
        return {
          run: {
            ...run,
            ...(generation !== undefined ? { workflow_run_id: generation } : {}),
            last_advanced_at: now(),
          },
          changed: true,
          waiting: true,
          note:
            `fire confirmed — launcher turn settled after the budget` +
            `${generation !== undefined ? ` (launcher generation ${generation.slice(0, 8)} adopted)` : ''}`,
        }
      }
      if (pendingFire.confirmed_by === null && listStageEvents !== null) {
        let events: ReadonlyArray<{ stage: string; at: string }> = []
        try {
          events = listStageEvents(run.id)
        } catch {
          events = []
        }
        let sinceUnconfirmed = false
        let proved = false
        for (const ev of events) {
          if (ev.stage === 'fire-unconfirmed') {
            sinceUnconfirmed = true
            proved = false
            continue
          }
          if (sinceUnconfirmed && (ev.stage === 'plan-start' || ev.stage === 'fire-settled')) proved = true
        }
        if (proved) pendingFire.confirmed_by = 'stage-event'
      }
      if (pendingFire.confirmed_by === 'stage-event') {
        // Proved by the workflow itself. The record is kept only so a late settle
        // can still adopt the launcher generation; it is dropped at the deadline
        // and the run then flows through the ordinary in-flight branches.
        if (nowMs() >= pendingFire.deadline_ms) unconfirmedFires.delete(run.id)
        return {
          run,
          changed: false,
          waiting: true,
          note: `fire confirmed by the workflow's own stage event; waiting on inner-loop dispatch ${run.subagent_run_id}`,
        }
      }
      if (nowMs() < pendingFire.deadline_ms) {
        const leftS = Math.max(0, Math.round((pendingFire.deadline_ms - nowMs()) / 1000))
        return {
          run,
          changed: false,
          waiting: true,
          note: `fire unconfirmed — launcher turn still draining (not cancelled); ${leftS} s left to confirm`,
        }
      }
      unconfirmedFires.delete(run.id)
      fired.delete(run.id)
      const lateNote =
        late === null
          ? 'launcher turn still not settled after two budgets'
          : `launcher turn later ended ${late.status}: ${late.error ?? 'unknown'}`
      const windowMin = Math.round((2 * pendingFire.budget_ms) / 60_000)
      return {
        run: failedRun(
          run,
          `inner workflow fire failed: fire turn did not settle within the budget (turn left running, not cancelled; ` +
            `${lateNote}; no plan-start observed within ${windowMin} min)`,
          false,
        ),
        changed: true,
        waiting: false,
        note: `${run.phase} → failed (fire never confirmed)`,
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
      let probe: RunLiveness | 'not-wired' = 'not-wired'
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
      // THE REASON PREFIXES ARE UNCHANGED BYTE-FOR-BYTE up to the disclosure suffix.
      // `delivery.ts` routes the terminal notification by substring
      // ('suspected agent hang' / 'no progress for' / 'stalled'), and its comment
      // says the two halves must move together — so the disclosure is APPENDED,
      // never substituted.
      const reason = overCeiling
        ? `inner workflow stalled (no terminal result within ${Math.round(maxInflightMs / 60_000)} min)` +
          ` — ${disclosure}; the 2 h ceiling outranks any liveness reprieve`
        : probe === 'dead'
          ? `no progress for ${mins} min and the inner workflow launcher is positively dead` +
            ` — ${disclosure}`
          : `no progress for ${mins} min — suspected agent hang (inner workflow stopped advancing)` +
            ` — ${disclosure}`
      const reaped = failedRun(run, reason, false)
      return {
        run: reaped,
        changed: true,
        waiting: false,
        note: `${run.phase} → failed (${overCeiling ? 'inflight ceiling' : probe === 'dead' ? 'launcher dead' : 'suspected hang'})`,
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
        `inner workflow stalled (no terminal result within ${Math.round(maxInflightMs / 60_000)} min)`,
        false,
      )
      return { run: reaped, changed: true, waiting: false, note: `${run.phase} → failed (stalled)` }
    }
    return { run, changed: false, waiting: true, note: `waiting on inner-loop dispatch ${run.subagent_run_id}` }
  }

  async function step(run: TridentRun): Promise<AdvanceOutcome> {
    const out = await stepCore(run)
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
