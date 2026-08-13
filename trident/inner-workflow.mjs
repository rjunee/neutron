// =============================================================================
// trident-v2 INNER LOOP — a native CC Dynamic Workflow (Phase 2 hard cutover)
// =============================================================================
//
// This file IS the trident inner loop. The durable OUTER loop
// (`trident/tick.ts` + the `code_trident_runs` SQLite table, migration 0077)
// launches it ONCE per run via the `Workflow` tool (see `trident/inner-loop.ts`),
// and it drives:  Forge build (isolated worktree) → parallel adversarial Argus
// review → asymmetric-gated synthesis → bounded fix loop → verdict.
//
// It REPLACES the v1 substrate-per-phase inner dispatch. What it KEEPS untouched:
// the durable OUTER loop, the Ralph spec-drift docs, and merge as the
// outer/human gate (`trident/merge.ts`). The workflow RETURNS {PR#, verdict};
// the OUTER layer does the irreversible merge — defense in depth.
//
// Runtime contract (proto-2, 2026-06-28 — every claim backed by a real run):
//
//   (A) WORKTREE CLEANUP IS EXPLICIT, ON EVERY PATH — AND NEVER DESTRUCTIVE.
//       `isolation:'worktree'` auto-removes a worktree ONLY IF UNCHANGED; a Forge
//       build always commits, so the worktree is left ORPHANED unless trident
//       cleans it up. The `finally{}` block runs the checked-in DETERMINISTIC
//       `trident/worktree-cleanup.sh` against the `trident/<slug>` branch,
//       independent of Forge's return value (so it holds even if Forge threw
//       before returning). This is D-1 — bounded by #541: a DIRTY worktree
//       (including untracked files) is PRESERVED and reported, never
//       force-removed, because this block also fires on throw/abort.
//
//   (B) LONG-COMMAND OUTPUT MUST BE REDIRECTED TO A FILE. A verbose build/test
//       run piped inline can overflow an agent's context. Every agent prompt
//       carries REDIRECT_RULE: redirect to a log, read only the summary tail.
//
//   (C) PER-PHASE SQLITE CHECKPOINTING. A CC Dynamic Workflow is session-bound
//       (`resumeFromRunId` is same-session only), so a control-plane crash loses
//       the in-flight workflow. Crash-recovery = relaunch a FRESH workflow that
//       reads `inner_checkpoint` and idempotently SKIPS finished phases + REUSES
//       the existing PR (never a duplicate). The workflow writes that checkpoint
//       itself, mid-run, via an `agent()` Bash step (proto-2 C1: a workflow Bash
//       step can persist to sqlite mid-run) that invokes the checked-in
//       `trident/checkpoint.sh` (P10: PRAGMA busy_timeout=5000 retry-under-lock,
//       no LLM-transcribed SQL). Date.now()/new Date() are NOT available in a
//       workflow script — timestamps are computed inside that script via
//       `date -u +%FT%TZ`.
//
// HOW TO RUN: invoked by the `Workflow` tool with this file's path as
// `scriptPath` (see `trident/inner-loop.ts`). The globals
// (agent/parallel/pipeline/phase/log/budget/args) are injected by the Workflow
// runtime — this file is NOT runnable with plain `node`/`bun`. `node --check`
// flags the top-level `return` below as an illegal top-level return; that is
// EXPECTED — top-level `return` is the Workflow runtime's documented result API.
// =============================================================================

export const meta = {
  name: 'trident-v2-inner',
  description:
    'trident-v2 inner loop — Forge(worktree) build → parallel adversarial Argus review → asymmetric-gated synthesis → bounded fix loop, with per-phase SQLite checkpointing and mandatory worktree cleanup on every path.',
  phases: [{ title: 'Build' }, { title: 'Review' }, { title: 'Synthesis' }],
}

// `args` is supplied by the OUTER loop's launcher (`trident/inner-loop.ts`),
// which invokes the `Workflow` tool from a spawned substrate claude. The tool
// passes `args` through VERBATIM, and the launcher MODEL sometimes serializes the
// JSON as a STRING rather than a structured object (a real headless launcher run,
// 2026-06-28, did exactly this). Destructuring a raw string yields ALL-undefined:
// slug→default (every run collides on `trident/trident-run`), dbPath/runId→
// undefined (checkpoints silently no-op → crash-resume C1/C2 is dead), mergeMode→
// 'pr' (a local run's Forge gets told to `gh pr create` and FAILS), task→undefined
// (Forge builds the wrong thing). So NORMALIZE the value before destructuring —
// tolerate both the object form and a JSON-string form. CI's unit tests passed
// `args` as an object and never exercised this serialization path.
function normalizeWorkflowArgs(raw) {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return raw || {}
}

const {
  repoPath,
  task,
  baseBranch = 'main',
  slug = 'trident-run',
  // THIS DEFAULT IS A FALLBACK, NOT THE CAP THE FLEET RUNS ON — do not read it as
  // "trident retries ten times". Every real launch goes through
  // `buildWorkflowArgs` (trident/inner-loop.ts), which ALWAYS sets `maxRounds`
  // from the run row's `max_rounds`; that column is `NOT NULL` (migrations/0077)
  // and `createRun` always supplies it. So on the production path this literal is
  // never reached and the effective cap is the one in `trident/store.ts`
  // (`max_rounds: input.max_rounds ?? 10`). Both are 10 deliberately: they must
  // agree, because a reader who finds only one of them will believe it.
  //
  // It is kept at the same value rather than deleted because the one path that
  // DOES reach it is the args-lost path — `normalizeWorkflowArgs` returns `{}`
  // for a non-object/unparseable `args` (the 2026-06-28 stringified-args
  // incident noted above), and every field falls back at once. A fallback that
  // silently disagreed with the real cap would make that already-confusing
  // failure report a round budget the fleet never uses.
  //
  // The cap is a bound, not a target: it exists so a loop that cannot converge
  // STOPS and reports instead of spending forever. Note that hitting it is not
  // loud — the terminal result still carries `ok: true`, which means only "the
  // workflow did not crash". The honest signal is `verdict`, which stays
  // REQUEST_CHANGES, and that is what the outer loop keys on (orchestrator.ts).
  maxRounds = 10,
  laneRetryAttempts = 1,
  ralph = false,
  // Git-mode threaded from the run (`local` | `pr`). Defaults to `pr` for any
  // legacy caller that doesn't thread it; the launcher always sets it.
  mergeMode = 'pr',
  prNumber = null,
  branch = null,
  dbPath,
  runId,
  resumeCheckpoint = null,
  // Per-project Codex credential dir (CODEX_HOME) for the OPTIONAL cross-model
  // review. Threaded from the outer loop (resolved from NEUTRON_CODEX_HOME env /
  // per-project config; Part B populates it via the admin panel). ABSENT (null/'')
  // → codex is "not connected" → the review runs Claude-only + a note, never a
  // blocker. PRESENT → the codex reviewer runs `trident/codex-review.sh` with this
  // CODEX_HOME; an auth/call failure there is DEFERRED (never a silent APPROVE).
  codexHome = null,
  // Is a Kimi API key configured for this deployment? A BOOLEAN, deliberately not
  // the key: the key is read by `trident/kimi-review-cli.ts` in its own process, so
  // it never enters a prompt, a log line, or a chat message. Absent → the Kimi
  // panelist is skipped entirely (no wasted agent) and the panel notes it.
  kimiConfigured: kimiConfiguredArg = false,
  // Checkpoint-writer script path (refactor P10). The sqlite UPDATEs behind
  // checkpoint()/writeTerminalResult() live in the checked-in
  // trident/checkpoint.sh (PRAGMA busy_timeout=5000 on the same connection, so
  // writes retry up to 5s under lock instead of failing instantly) — the agent
  // invokes the script instead of transcribing raw SQL. Threaded from the
  // launcher (buildWorkflowArgs) like dbPath; a legacy caller that doesn't
  // thread it falls back to the repo-of-record copy (same precedent as
  // codex-review.sh below).
  checkpointScript = null,
  // Worktree-cleanup script path (ISSUES #541). Same threading contract as
  // `checkpointScript`: the `finally{}` cleanup is a checked-in DETERMINISTIC
  // script (dirty → preserve, clean → plain remove) rather than an LLM told to
  // force-remove, and this script cannot resolve its own path, so the launcher
  // threads the absolute one. A legacy caller that doesn't thread it falls back
  // to the repo-of-record copy.
  worktreeCleanupScript = null,
  // FABLE-ORCHESTRATOR model routing (model routing per the refactor plan protocol,
  // `docs/plans/2026-07-02-world-class-refactor-plan.md` § 1.5).
  // The per-role model IDS, resolved from the single-source-of-truth registry
  // (runtime/models.ts) in the launcher (`buildWorkflowArgs`) and threaded in
  // here: `{ fable, opus, sonnet, fast }`. This workflow script has NO module
  // resolution, so it CANNOT import the registry — the ids MUST arrive via args,
  // never as hard-pinned literals in this file. Absent (a dry source check) →
  // fall back to the documented agent() symbolic aliases (see MODELS below).
  models = null,
  // RB2 (b) — the owner-corrections GUIDANCE, ALREADY DERIVED (a framed,
  // `<owner_reflection>`-delimited advisory suffix, or '' for a null/whitespace/
  // non-string context) by the launcher's `buildReflectionGuidance` (testable TS —
  // this script can't import it) and threaded READY-TO-APPEND. APPENDED after the
  // FORGE BUILDER contract + task ONLY (forge:build + fix rounds) so owner corrections
  // steer what gets built while staying lower-priority than the fixed contract in a
  // tool-enabled agent — reflection was chat-only before RB2. NEVER given to the
  // independent review gate (argus:*) — see the trust-boundary note below. Absent/''
  // → every prompt is byte-identical to pre-RB2.
  reflectionGuidance = '',
  // OWNER PER-PHASE MODEL OVERRIDES — phase key → {model?, effort?}, ALREADY
  // validated in TypeScript at the settings boundary (`trident/phase-models.ts`
  // `parsePhaseModelConfig`). Absent/null → every phase keeps its default, so an
  // instance that has never touched the setting behaves EXACTLY as before. See
  // `applyPhaseOverride` for why an unusable entry logs rather than throws.
  phaseModels = null,
  // THE MODEL-TIER REGISTRY — tier name → `{model_id, transport, env_var}`, resolved
  // and threaded by the launcher (`trident/model-tiers.ts`; this script cannot import
  // it, same as `models`). It is what lets an owner override name a TIER and this
  // dispatch reach the right model over the right TRANSPORT:
  //
  //   • `transport: 'agent'` — an Anthropic id for `agent({model})`.
  //   • `transport: 'cli'`   — a subprocess model. `agent({model})` resolves against
  //     Claude Code's own endpoint and CANNOT reach it, so the id is passed to the
  //     wrapper through `env_var` (CODEX_REVIEW_MODEL / KIMI_MODEL) instead.
  //
  // Absent (a dry source check / a legacy caller) → the four Claude tiers still
  // resolve through MODELS, and the cross-model wrappers are invoked with NO env
  // override, i.e. exactly the command they were invoked with before this existed.
  modelTiers = null,
  // THE EXECUTOR GROUPS EACH PHASE CAN DISPATCH ON — phase key → ['claude','codex'].
  // Threaded (not hardcoded) for the same reason `modelTiers` is: `trident/
  // phase-models.ts` owns the answer and this script cannot import it. It is what lets
  // the build step accept a codex tier at all: before ISSUES #565 every phase was
  // pinned to its DEFAULT tier's executor, so an owner override naming `sol` on the
  // build row was logged as a transport mismatch and thrown away. Absent → each phase
  // keeps exactly its default tier's executor, i.e. the pre-#565 behaviour.
  phaseExecutors = null,
  // THE TWO CROSS-MODEL REVIEW SLOTS, ALREADY RESOLVED (ISSUES #566/#567). Each entry
  // is `{key,label,title,disposition,tier,model_id,wrapper,env_var,reason}` from
  // `trident/cross-model-slots.ts#resolveCrossModelSlots`. The DISPOSITION is the field
  // this script must never re-derive: `none` means the owner deliberately emptied the
  // seat and it must not block a verdict, while `configured` means a failure MUST bar
  // the APPROVE. Those two are indistinguishable by "did a verdict arrive", which is
  // exactly why the answer is computed in typed, tested code and threaded in.
  // Absent → NO cross-model seats run, and none of them block. That is the safe
  // degradation for a legacy caller: a reduced panel that says it is reduced.
  crossModelSlots = null,
  // Absolute path to `trident/codex-build.sh` (same threading contract as
  // `checkpointScript`: this script cannot resolve its own location).
  codexBuildScript = null,
} = normalizeWorkflowArgs(args)

// Is a per-project codex credential configured for this run? Absent → skip the
// codex panelist entirely (no wasted agent) and synthesise Claude-only.
const codexConfigured = typeof codexHome === 'string' && codexHome.length > 0
const kimiConfigured = kimiConfiguredArg === true

// Resolved checkpoint-writer path (P10). Only ever used when dbPath && runId
// are threaded (checkpoint()/writeTerminalResult() no-op otherwise), and the
// launcher that threads those also threads checkpointScript — the repoPath
// fallback covers only legacy callers.
const checkpointSh = checkpointScript || `${repoPath}/trident/checkpoint.sh`

// Resolved worktree-cleanup script path (#541) — the deterministic replacement
// for the force-removing cleanup agent. Same repoPath fallback as above.
const worktreeCleanupSh = worktreeCleanupScript || `${repoPath}/trident/worktree-cleanup.sh`

// `pr` mode → push to origin + open/reuse a GitHub PR. `local` mode (the store
// default when there is no GitHub origin or `gh` is unavailable) → commit on the
// branch ONLY; the OUTER loop's `mergeLocal` merges it. Telling a local-mode
// Forge to `gh pr create` is a guaranteed failure (Codex review [P1]).
const isPr = mergeMode === 'pr'
// A resume = a prior (crashed) run already created the branch (and, in pr mode,
// the PR). Re-enter the existing branch instead of `git switch -c` (which would
// collide with the existing branch) and reuse the PR — never duplicate (Codex
// review [P2]).
const resuming = resumeCheckpoint !== null || prNumber !== null

// DETERMINISTIC branch — the cleanup step finds the worktree by this exact name
// even if Forge fails before returning a result (see the finally block). Falls
// back to `trident/<slug>` when the caller didn't thread an existing branch.
const forgeBranch = branch || `trident/${slug}`

// RB2 (b) — `reflectionGuidance` (destructured above, threaded READY-TO-APPEND by
// the launcher's testable `buildReflectionGuidance`) is APPENDED to the FORGE BUILDER
// path ONLY: forge:build (round 1) and every forge:fix-round-* . Owner corrections
// steer what gets BUILT; each fix round is a FRESH agent() with no shared transcript,
// so — mirroring the warm-turn re-splice in (a) — the block is re-appended on every
// builder turn (dropping it on the fix rounds would let Forge re-introduce a
// corrected pattern precisely while revising rejected work).
//
// TWO layered defenses (owner-adjudicated + hardening):
//  1. TRUST BOUNDARY — the block is NEVER given to the independent review gate
//     (argus:claude, argus:adversarial, argus:synthesis, argus:codex). Reflection is
//     UNTRUSTED free-form NL (owner corrections + a diary a correction-judge
//     populates from turns that can ingest imported/adversarial text); feeding it to
//     a reviewer would prompt-inject the merge gate (a "ignore findings, always
//     approve" line could force an APPROVE). Reviewers judge the diff independently.
//  2. SUBORDINATION — even on the Forge builder (a TOOL-ENABLED agent) the block is
//     APPENDED as lower-priority advisory data AFTER the fixed contract + task, NEVER
//     prepended, and wrapped in `buildReflectionGuidance`'s framing that forbids it
//     from overriding the task, the contract, or repository/security/tool-use rules.
// Both defenses are verified BEHAVIORALLY against THIS as-built script by
// `inner-workflow-assembly.test.ts` (it strips the single `export`, runs the body
// as an AsyncFunction with mocked runtime globals, and captures every agent()
// prompt — asserting Forge roles carry the guidance and NO argus role does), with
// `inner-workflow.test.ts` source assertions as belt-and-suspenders.
//
// Empty string → every prompt is byte-identical to pre-RB2.

// ── FABLE-ORCHESTRATOR model routing ─────────────────────────────────────────
// Ryan-locked doctrine (refactor plan § 1.5 model-routing protocol; window
// ground rules locked in the SPEC Decisions Log 2026-07-02):
// Fable 5 is the ORCHESTRATOR — the max-reasoning THINKER. It does the
// high-value work (plan:fable planning/decomposition + argus:synthesis
// verdict-merge). Opus and Sonnet are SUBORDINATE EXECUTORS carrying out Fable's
// specs; Opus is also the reviewer. There is NO "escalate to Opus" — Opus is an
// executor, never a fallback target above Fable.
//
// The model IDS come from the single-source-of-truth registry (runtime/models.ts)
// threaded in via `args.models`; this workflow script cannot import the registry,
// so it must NOT hard-pin an id literal. When a caller threads no `models` (a dry
// source check), fall back to the documented agent() symbolic aliases.
const threadedModels = models && typeof models === 'object' ? models : {}
const pickModel = (key, alias) =>
  typeof threadedModels[key] === 'string' && threadedModels[key] ? threadedModels[key] : alias
// One retry per flaked lane by default: enough to clear a transient timeout,
// few enough that a genuinely dead lane still fails fast rather than stalling a
// round. Overridable per run.
const LANE_RETRY_ATTEMPTS = 1

const MODELS = {
  fable: pickModel('fable', 'fable'),
  opus: pickModel('opus', 'opus'),
  sonnet: pickModel('sonnet', 'sonnet'),
  fast: pickModel('fast', 'haiku'),
}

// The threaded tier registry (see the `modelTiers` arg). One lookup, used by both the
// owner-override path and the two cross-model wrappers.
const threadedTiers =
  modelTiers && typeof modelTiers === 'object' && !Array.isArray(modelTiers) ? modelTiers : {}

/**
 * A tier name → `{model_id, transport, env_var}`, or null when nothing knows it.
 *
 * Falls back to MODELS for the four Claude tiers so a caller that threads `models`
 * but no registry (a dry source check, a legacy launcher) keeps working exactly as
 * before. A name in NEITHER is unknown — retired, misspelled, or an old build's
 * literal vendor id — and the caller must fall back to the default rather than
 * dispatch it: a model id nothing can place is one nothing can reach.
 */
const resolveTier = (name) => {
  const entry = threadedTiers[name]
  if (entry && typeof entry === 'object' && typeof entry.model_id === 'string' && entry.model_id) {
    const str = (v) => (typeof v === 'string' && v ? v : null)
    return {
      model_id: entry.model_id,
      transport: entry.transport === 'cli' ? 'cli' : 'agent',
      env_var: str(entry.env_var),
      // The EXECUTOR this tier runs on (`claude` / `codex` / `kimi`). Transport alone
      // cannot answer "may this phase take this tier": codex and kimi are both `cli`
      // and are not interchangeable with each other.
      group: str(entry.group) ?? 'claude',
      // The BUILD role's wrapper + env knob, null for an executor that has none.
      // Kimi's are null, and that is the verified reason the build row refuses `k3`.
      build_wrapper: str(entry.build_wrapper),
      build_env_var: str(entry.build_env_var),
    }
  }
  if (Object.prototype.hasOwnProperty.call(MODELS, name)) {
    return {
      model_id: MODELS[name],
      transport: 'agent',
      env_var: null,
      group: 'claude',
      build_wrapper: null,
      build_env_var: null,
    }
  }
  return null
}

// phase key → the executor groups its dispatch can reach. Threaded; see the arg.
const threadedExecutors =
  phaseExecutors && typeof phaseExecutors === 'object' && !Array.isArray(phaseExecutors)
    ? phaseExecutors
    : {}
const executorsFor = (phaseKey, fallbackTier) => {
  const declared = threadedExecutors[phaseKey]
  if (Array.isArray(declared) && declared.length > 0) return declared.filter((g) => typeof g === 'string')
  const t = fallbackTier ? resolveTier(fallbackTier) : null
  return [t !== null ? t.group : 'claude']
}

// A CLI-transport route: the model is not handed to agent(), it is handed to the
// WRAPPER through its env knob. `model: null` (no registry threaded) means "invoke the
// wrapper with no override", which is the wrapper's own pinned default.
//
// `role` picks WHICH wrapper. A codex tier has two — `codex-review.sh` reads
// CODEX_REVIEW_MODEL and takes a diff, `codex-build.sh` reads CODEX_BUILD_MODEL and
// takes a worktree — and handing a build prompt to the review wrapper would produce a
// review of nothing. One field, decided at the call site that knows the role.
const cliRoute = ({ tier, phaseKey, role = 'review' }) => {
  const resolved = resolveTier(tier)
  const usable = resolved !== null && resolved.transport === 'cli'
  const wrapper = !usable ? null : role === 'build' ? resolved.build_wrapper : resolved.wrapper
  const envVar = !usable ? null : role === 'build' ? resolved.build_env_var : resolved.env_var
  return {
    model: usable ? resolved.model_id : null,
    effort: null,
    transport: 'cli',
    role,
    wrapper,
    envVar,
    phaseKey,
  }
}

// forge:* routes BY the planner's complexity tag: '[mechanical]' (boilerplate,
// tests, a single-file edit) → cheap Sonnet executor; '[reasoning]' / missing /
// ambiguous → Opus (bias to Opus — Argus + the cross-model seats are the backstop).
//
// The route is `role: 'build'` even on the Claude arm, so an owner override that moves
// the phase to a codex tier lands on `codex-build.sh` rather than on the review
// wrapper. `applyPhaseOverride` is what performs that move; this only names the role.
const modelForTag = (tag) =>
  tag === 'mechanical'
    ? { model: MODELS.sonnet, effort: 'medium', phaseKey: 'build_mechanical', role: 'build' }
    : { model: MODELS.opus, effort: 'high', phaseKey: 'build', role: 'build' }

// label → {model, effort, phase}. forge:* is resolved dynamically (modelForTag)
// since its model depends on the task; the rest are static. Fable orchestrates
// (plan:fable + argus:synthesis); Opus reviews (argus:claude/adversarial); the
// cheap sqlite/bash bookkeeping steps use the fast model.
//
// `phaseKey` is the OWNER-FACING key from `trident/phase-models.ts`, carried here so
// an owner override can be looked up without a second label→phase table living in
// this file. NOT named `phase`: `agent()` opts ALREADY carry a `phase` field, which
// is the workflow's PROGRESS group ('Build'/'Review'/'Synthesis') and a different
// concept entirely — two different things under one name in one file is how the
// wrong one gets read. The mapping's completeness is enforced by
// `trident/__tests__/phase-model-coverage.test.ts`, which walks the `label:`
// literals in THIS file — see the head-probe note below for why that matters.
// ── THE RESOLVED CROSS-MODEL SLOTS ──────────────────────────────────────────
// Absent → an EMPTY list, which means no cross-model seat is dispatched and none
// blocks. A legacy caller therefore gets a reduced panel that reports itself as
// reduced, rather than a seat that silently cannot run.
const threadedSlots = Array.isArray(crossModelSlots)
  ? crossModelSlots.filter((s) => s !== null && typeof s === 'object')
  : []

// A slot's DISPOSITION, read as a field and never inferred. See the arg's note: `none`
// and a dead `configured` seat both produce no verdict, and telling them apart by
// emptiness is precisely the collapse that would restore a single-family panel while
// still reporting a cross-model review.
const slotAt = (i) => threadedSlots[i] ?? null
const slotDisposition = (i) => {
  const slot = slotAt(i)
  if (slot === null) return 'none'
  return slot.disposition === 'configured' || slot.disposition === 'not_configured'
    ? slot.disposition
    : 'none'
}
const slotTitle = (i) => {
  const slot = slotAt(i)
  return (slot && typeof slot.title === 'string' && slot.title) || `Cross-model review ${i + 1}`
}
/**
 * THE SEAT LITERALS, WRITTEN OUT.
 *
 * `argus:cross-1` and `review_cross_1` could be computed from the index — and were, in
 * a first cut — but `__tests__/phase-model-coverage.test.ts` walks the `label:` and
 * `phaseKey:` LITERALS in this file to prove every workflow label is claimed by a phase
 * and every phase key is routed. A computed label is invisible to that walk, so the
 * check would go quietly vacuous for exactly the two seats this change touches. Spelled
 * out here, once, and read everywhere else.
 */
const CROSS_SEAT_DEFS = [
  { label: 'argus:cross-1', retryLabel: 'argus:cross-1-retry', phaseKey: 'review_cross_1' },
  { label: 'argus:cross-2', retryLabel: 'argus:cross-2-retry', phaseKey: 'review_cross_2' },
]

const slotRoute = (i) => {
  const slot = slotAt(i)
  const str = (v) => (typeof v === 'string' && v ? v : null)
  return {
    model: slot === null ? null : str(slot.model_id),
    effort: null,
    transport: 'cli',
    role: 'review',
    wrapper: slot === null ? null : str(slot.wrapper),
    envVar: slot === null ? null : str(slot.env_var),
    phaseKey: CROSS_SEAT_DEFS[i].phaseKey,
  }
}

const ROLE_MODEL = {
  'plan:fable': { model: MODELS.fable, effort: 'max', phaseKey: 'decomposition' },
  'argus:claude': { model: MODELS.opus, effort: 'high', phaseKey: 'review_rubric' },
  'argus:adversarial': { model: MODELS.opus, effort: 'high', phaseKey: 'review_adversarial' },
  'argus:synthesis': { model: MODELS.fable, effort: 'high', phaseKey: 'synthesis' },
  // THE TWO CROSS-MODEL SEATS ARE SLOTS, NOT VENDORS (ISSUES #566). They used to be
  // `argus:codex` and `argus:kimi`, which baked the occupant into the label — so
  // "point this seat at a different model" had no expressible form. Each slot's tier,
  // wrapper and env knob now arrive already resolved in `crossModelSlots`, and the
  // route is built from that rather than from a literal here. The model is NOT handed
  // to agent() (that resolves against Claude Code's endpoint and cannot reach a
  // GPT/Kimi model); the thin Claude agent wrapping each still runs on the launcher
  // default, because its whole job is to run one command and map an exit code.
  'argus:cross-1': slotRoute(0),
  'argus:cross-2': slotRoute(1),
  'checkpoint': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping' },
  'terminal-result': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping' },
  'cleanup:worktree': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping' },
  // HEAD-PROBE WAS MISSING FROM THIS TABLE and therefore fell through to the Opus
  // default at HIGH effort — for a step whose entire job is to run one `git`
  // command and report the sha it printed, interpreting nothing. It had been that
  // way since the step was added, and nothing could have caught it: a missing
  // entry and a deliberate entry are indistinguishable when the fallback is
  // silent. That is the argument for the coverage test, not just for this line.
  'head-probe': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping' },
  // The CI probe is the same shape as the head probe: run one command, report the
  // output verbatim, interpret nothing. Routed explicitly rather than left to the
  // fallback, which is how head-probe silently sat on the most expensive tier.
  'ci-probe': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping' },
}

// OWNER PHASE OVERRIDES, threaded in as `args.phaseModels` (phase key →
// {model?, effort?}). `model` is either a TIER name — resolved through the same
// registry-threaded MODELS map, so it follows a model upgrade — or a literal id.
//
// VALIDATION ALREADY HAPPENED, in TypeScript, at the settings boundary
// (`parsePhaseModelConfig`), where a bad entry is an error the owner SEES. Here the
// requirement is the opposite: a malformed entry must never abort a build that is
// otherwise fine. So anything unusable is LOGGED BY NAME and the default is used.
// Silently ignoring it is the one thing not allowed — an owner who set xhigh and
// saw no change would have no way to find out why.
const threadedPhaseModels =
  phaseModels && typeof phaseModels === 'object' && !Array.isArray(phaseModels) ? phaseModels : {}
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function applyPhaseOverride(route, phaseKey) {
  if (!phaseKey) return route
  const override = threadedPhaseModels[phaseKey]
  if (!override || typeof override !== 'object' || Array.isArray(override)) return route
  let { model, effort } = route
  let transport = route.transport === 'cli' ? 'cli' : 'agent'
  let wrapper = route.wrapper ?? null
  let envVar = route.envVar ?? null
  const role = route.role === 'build' ? 'build' : 'review'
  const allowed = executorsFor(phaseKey, null)
  if (typeof override.model === 'string' && override.model.trim()) {
    const requested = override.model.trim()
    const tier = resolveTier(requested)
    if (tier === null) {
      // A RETIRED OR UNKNOWN TIER KEEPS THE DEFAULT. It is not passed through as a
      // literal id: a value the registry cannot place carries no transport, so
      // "dispatch it anyway" means handing an unplaceable id to whichever executor
      // happens to be wired — which is how a build silently runs on the wrong model
      // (or on nothing at all). The typed boundary drops these first; this is the
      // backstop for a config that got past it.
      log(`trident.phase-override IGNORED phase=${phaseKey} reason=unknown-tier tier=${requested}`)
    } else if (!allowed.includes(tier.group)) {
      // THE EXECUTOR IS A CAPABILITY, NOT A PREFERENCE — but it is no longer derived
      // from the phase's own default tier, which is the whole of ISSUES #565. This used
      // to compare the candidate's TRANSPORT and ENV KNOB against the route's, so the
      // build step (a Claude agent route) rejected every codex tier by construction and
      // the owner's choice was logged away as a mismatch. It now asks the threaded
      // executor list — the same list the settings pane greys options from — so a phase
      // whose dispatch was actually built for two executors can take either.
      log(
        `trident.phase-override IGNORED phase=${phaseKey} reason=executor-not-reachable tier=${requested} tier-executor=${tier.group} phase-executors=${allowed.join('|')}`,
      )
    } else if (tier.transport === 'cli' && (role === 'build' ? tier.build_wrapper : tier.wrapper) === null) {
      // Right executor, wrong ROLE. `k3` is a legitimate non-Claude tier and the
      // cross-model slots take it, but nothing in this repo hands Kimi a worktree, so a
      // BUILD that resolved to it would have no command to run. Refusing here keeps the
      // failure at the routing line, where the log names the tier, instead of at a
      // wrapper path that resolves to null.
      log(
        `trident.phase-override IGNORED phase=${phaseKey} reason=no-${role}-wrapper tier=${requested} tier-executor=${tier.group}`,
      )
    } else {
      // THE MOVE ITSELF. A Claude→codex switch changes the TRANSPORT, so the route's
      // wrapper and env knob move with the model — otherwise the build would resolve a
      // GPT id and then hand it to agent(), which is the exact silent-wrong-model
      // failure the transport field exists to prevent.
      model = tier.model_id
      transport = tier.transport
      if (tier.transport === 'cli') {
        wrapper = role === 'build' ? tier.build_wrapper : tier.wrapper
        envVar = role === 'build' ? tier.build_env_var : tier.env_var
        // A CLI chooses its own reasoning effort and no wrapper exposes a knob for it.
        effort = null
      } else {
        wrapper = null
        envVar = null
      }
    }
  } else if (override.model !== undefined) {
    log(`trident.phase-override IGNORED phase=${phaseKey} reason=model-not-a-nonempty-string`)
  }
  if (transport === 'cli' && override.effort !== undefined) {
    // The CLI picks its own reasoning effort and the wrapper exposes no knob for it,
    // so an effort here would be a setting nothing reads.
    log(`trident.phase-override IGNORED phase=${phaseKey} reason=effort-not-settable-on-cli-transport`)
  } else if (typeof override.effort === 'string' && VALID_EFFORTS.includes(override.effort)) {
    effort = override.effort
  } else if (override.effort !== undefined) {
    log(
      `trident.phase-override IGNORED phase=${phaseKey} reason=effort-not-in(${VALID_EFFORTS.join('|')}) got=${JSON.stringify(override.effort)}`,
    )
  }
  return { ...route, model, effort, transport, wrapper, envVar, role }
}

// Resolve {model, effort} for a spawn keyed on its label (+ optional complexity
// tag for forge:*), then apply the owner's override for that phase.
// Unknown label → Opus executor (safe default; never Fable).
function routeModel(label, tag) {
  const base =
    label === 'forge:build' || label.startsWith('forge:fix-round-')
      ? modelForTag(tag)
      : label.startsWith('checkpoint:')
        ? ROLE_MODEL['checkpoint']
        : label.startsWith('head-probe-round-')
          ? ROLE_MODEL['head-probe']
          : label.startsWith('ci-probe-round-')
            ? ROLE_MODEL['ci-probe']
          // A retry lane is the SAME lane. Routing it separately (or letting it fall
          // through to the default) would mean the owner's choice applied to the
          // first attempt and silently not to the second.
          : label === 'argus:cross-1-retry'
            ? ROLE_MODEL['argus:cross-1']
          : label === 'argus:cross-2-retry'
            ? ROLE_MODEL['argus:cross-2']
          : ROLE_MODEL[label] || { model: MODELS.opus, effort: 'high', phaseKey: null }
  return applyPhaseOverride(base, base.phaseKey)
}

// Merge the resolved {model, effort} into an agent() opts object (which carries
// the label) and LOG the spawn so every run is TALLY-ABLE — Ryan tracks subagent
// count + model per run ("N agents, M on Fable, K on Opus, J on Sonnet, C on
// Codex"). Use for EVERY Claude agent() so its model is both routed and observed.
function withModel(opts, tag) {
  const route = routeModel(opts.label, tag)
  // The PHASE KEY and whether it was OVERRIDDEN are logged alongside the model,
  // because "did my setting take effect?" is otherwise unanswerable from a run's
  // output — and an owner who cannot answer it will not trust the setting. Note
  // `route.phaseKey` is the owner-facing config key; `opts.phase` is the workflow's
  // progress group and is deliberately a different field.
  const overridden = route.phaseKey !== null && route.phaseKey in threadedPhaseModels
  log(
    `trident.agent label=${opts.label} model=${route.model} effort=${route.effort} phase=${route.phaseKey ?? 'unrouted'}${overridden ? ' override=owner' : ''}${tag ? ` tag=${tag}` : ''}`,
  )
  // A CLI-TRANSPORT ROUTE NEVER SETS agent() OPTS. Its model belongs to a subprocess
  // (see `crossModelEnvPrefix`); putting it on the spawn would ask Claude Code's
  // endpoint for a GPT/Kimi id, which is the one failure this whole transport field
  // exists to make impossible. The wrapping agent keeps the launcher default.
  if (route.transport === 'cli') return { ...opts }
  // Only model + effort cross into the agent opts. `phaseKey` is routing metadata
  // and must not leak into the spawn.
  return { ...opts, model: route.model, effort: route.effort }
}

/**
 * The env assignment that carries the owner's chosen model INTO a cross-model wrapper.
 *
 * THIS IS THE WHOLE POINT OF THE CLI TRANSPORT. `agent({model})` resolves against
 * Claude Code's own endpoint, so a GPT or Kimi model cannot be selected that way; the
 * wrapper runs in its own process and reads its model from the environment
 * (`CODEX_REVIEW_MODEL`, `KIMI_MODEL`), so the assignment on the command line is the
 * seam that makes the setting real. A pane that saved a choice nothing put here would
 * be a control with no consumer.
 *
 * Returns '' when no registry is threaded, which invokes the wrapper exactly as it was
 * invoked before this existed — the wrapper's own pinned default, including codex's
 * `${CODEX_REVIEW_MODEL-gpt-5.6-sol}` and its deliberate respect for an explicitly
 * EMPTY value.
 */
function crossModelEnvPrefix(label) {
  const route = routeModel(label)
  if (route.transport !== 'cli' || !route.envVar || !route.model) return ''
  return `${route.envVar}=${shSingleQuote(route.model)} `
}

/**
 * Does this label's BUILD dispatch go to a subprocess rather than to agent()?
 *
 * The one question the Forge call sites need answered. Reading the ROUTE (rather than
 * re-checking the owner's config) is what keeps the pane's promise and the run's
 * behaviour the same fact: if `applyPhaseOverride` refused the move for any reason —
 * unknown tier, unreachable executor, no build wrapper — this is false and the build
 * runs on Claude, which is the honest outcome and is logged by name at the refusal.
 */
function buildRunsOnCli(label, tag) {
  const route = routeModel(label, tag)
  return route.transport === 'cli' && typeof route.wrapper === 'string' && route.wrapper.length > 0
}

/**
 * Tally one cross-model spawn, naming the model the SUBPROCESS will actually run.
 *
 * The lane used to log a placeholder (`model=codex-runtime`) because the reviewing
 * model was the CLI's own business. It is the owner's business now, so the line says
 * which id was resolved and whether an override chose it — "did my setting take
 * effect?" has to be answerable from a run's output, or the setting will not be
 * trusted. `fallback` is still logged when nothing resolved, so the tally never
 * silently drops a seat.
 */
function logCrossModelSpawn(label, fallback) {
  const route = routeModel(label)
  const overridden = route.phaseKey !== null && route.phaseKey in threadedPhaseModels
  log(
    `trident.agent label=${label} model=${route.model || fallback} effort=n/a transport=cli phase=${route.phaseKey ?? 'unrouted'}${overridden ? ' override=owner' : ''}`,
  )
}

// RESOLVED ONCE PER RUN, not per prompt build. Two reasons beyond the obvious: the
// value cannot change mid-run (the owner's config is threaded in at launch), and a
// prompt builder that reached for it as a free function could no longer be lifted out
// of this file and executed on its own — which is exactly how the codex bridge's
// truncation-readback test proves the SHIPPED command, rather than a retyped copy of
// it (`inner-workflow.test.ts`). A closure value it can pass in keeps that possible.
const CROSS_ENV_PREFIX = ['argus:cross-1', 'argus:cross-2'].map((l) => crossModelEnvPrefix(l))

// ── Schemas ─────────────────────────────────────────────────────────────────

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'file:line or concrete repro — verify-before-assert' },
        },
      },
    },
  },
}

// ── THE CROSS-MODEL SEAT'S VERDICT ──────────────────────────────────────────
// ONE SCHEMA FOR BOTH SLOTS. There used to be two near-identical schemas differing
// only in a status field name (`codexStatus` / `kimiStatus`), which is how the panel
// acquired a latent positional-indexing bug: read the wrong slot and the status field
// comes back `undefined`, defaults to the permissive answer, and the gate silently
// disarms for a reviewer that failed. A seat is a seat; which model sits in it is data.
//
// `crossStatus` carries FOUR states, and the fourth is the point of ISSUES #567:
//   • connected     — the reviewer ran and returned a verdict.
//   • not_connected — no credential on this install. Graceful, never blocking.
//   • deferred      — configured, but the call FAILED or timed out. BLOCKS, and is
//                     worth retrying because it may be transient.
//   • exhausted     — the provider reports NO REMAINING QUOTA. Also BLOCKS, but is
//                     NOT retried and NOT substituted: quota is a spending decision
//                     the owner has to make, and swapping in another model silently
//                     would make that decision invisible. Distinct from `deferred`
//                     precisely so the run can stop paying to rediscover it.
const CROSS_MODEL_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'crossStatus', 'crossTruncated'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
    findings: VERDICT_SCHEMA.properties.findings,
    crossStatus: {
      type: 'string',
      enum: ['connected', 'not_connected', 'deferred', 'exhausted'],
    },
    crossTruncated: {
      type: 'boolean',
      description:
        'true when the wrapper capped the diff — the reviewer saw only its first N lines, so its verdict covers only that portion.',
    },
  },
}

const FORGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['worktreePath', 'branch', 'commitSha', 'prNumber', 'diffFile', 'testsPassed'],
  properties: {
    worktreePath: { type: 'string' },
    branch: { type: 'string' },
    commitSha: { type: 'string' },
    prNumber: { type: ['number', 'null'] },
    diffFile: { type: 'string' },
    testsPassed: { type: 'boolean' },
  },
}

// The Fable orchestrator/planner's structured output: the regenerated
// IMPLEMENTATION_PLAN.md body, the SINGLE top-priority task to build this Ralph
// iteration, its EXECUTION SPEC (target files + acceptance criterion + test
// plan), the complexity TAG that routes the executor (Sonnet vs Opus), and the
// count of tasks still unchecked AFTER this one.
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['implementationPlan', 'topTask', 'executionSpec', 'complexity', 'remainingTasks'],
  properties: {
    implementationPlan: {
      type: 'string',
      description: 'the full regenerated IMPLEMENTATION_PLAN.md body — a prioritized "- [ ]/[x]" checklist',
    },
    topTask: { type: 'string', description: 'the single top-priority UNCHECKED task to build this iteration' },
    executionSpec: {
      type: 'string',
      description: 'structured spec for the top task: TARGET FILES, ACCEPTANCE CRITERION, TEST PLAN',
    },
    complexity: { type: 'string', enum: ['mechanical', 'reasoning'] },
    remainingTasks: { type: 'number', description: 'count of tasks still unchecked AFTER the top task' },
  },
}

// ── Inlined contracts (workflow agents are BARE workers — no CLAUDE.md / persona
//    rides along, proto-2 C6, so the Forge/Argus operating contracts MUST be
//    inlined into every prompt). These are the native, parser-free trident-v2
//    contracts (NOT the legacy `/forge/delivered` model). ────────────────────

const NO_INTERACTIVE_RULE =
  'You run UNATTENDED. NEVER call AskUserQuestion or any interactive prompt — if you would need to ask, ABORT with a clear one-line error instead of hanging. Make the best judgment call and note it.'

const REDIRECT_RULE =
  'For ANY long or verbose command (builds, full test runs), redirect stdout+stderr to a log file and read ONLY the summary tail — never let raw output flood your context.'

// YOU SHARE THIS MACHINE WITH SIBLING LANES, AND A PATTERN-KILL IS FRATRICIDE.
//
// Incident of record, 2026-08-12 06:05:46, diagnosed record-by-record: a fix-round
// agent decided a stale typecheck was holding its worktree and ran
// `pkill -f typecheck-all.sh`. `pkill -f` matches on the FULL COMMAND LINE and is
// scoped to the user, not the worktree — so it SIGTERM'd all ELEVEN lanes running
// on the box, including the lane that issued it, because each lane's launcher
// passed its task brief as an argv and every brief contains the literal string
// `scripts/ci/typecheck-all.sh` (the launchers now pipe the brief on stdin, which
// removes them from that particular blast radius — but not from this one).
//
// EVEN WITH CLEAN ARGV THIS RULE IS LOAD-BEARING: a pattern like
// `-f typecheck-all.sh` still legitimately matches SIBLING LANES' REAL typecheck
// children, so a pattern-kill silently poisons other builds' test runs and they
// fail for reasons invisible in their own logs. The failure is remote, delayed and
// unattributable — the worst shape a build failure can have.
//
// The rule is therefore about PROVENANCE, not about which binary you call: kill
// only what you started and can name by pid. `$!` after a background start, or a
// pid file you wrote yourself, is legitimate. A pattern is never legitimate,
// because the pattern cannot distinguish your process from someone else's.
const NO_PATTERN_KILL_RULE =
  'YOU SHARE THIS MACHINE WITH OTHER BUILD LANES. NEVER kill processes by pattern or by name — no `pkill`, no `killall`, no `kill $(pgrep …)`. Those match the whole machine, not your worktree, and one such command has already SIGTERMed every concurrent lane on this box including the one that issued it. Kill ONLY a pid you started yourself and can name (e.g. captured from `$!`). If a process you did not start seems to be in your way, do NOT kill it — work around it and say so in your report.'

// Forge build contract (from prompts/forge.md): smallest-correct-change,
// push + open-PR, PR_NUMBER/BRANCH/WORKTREE last-lines discipline. With
// `schema: FORGE_SCHEMA` the agent ALSO returns the structured fields, but the
// last-lines discipline is kept verbatim as the durable, parser-friendly fallback.
// Step 1 + step 4 differ on whether the branch/PR ALREADY EXIST (`reenter`):
//   • a FRESH round-1 run (reenter=false) CREATES the branch (`git switch -c`)
//     and, in pr-mode, opens a PR;
//   • a RE-ENTRY (reenter=true) — a crash-resume (`resuming`) OR any bounded
//     fix round after round 1 — re-enters the EXISTING branch WITHOUT `-c`
//     (which would collide: "branch already exists") and REUSES the PR (never a
//     duplicate). Codex review [P1]: the fix loop previously reused the round-1
//     contract, telling the fix agent to `git switch -c` an already-created
//     branch + `gh pr create` a duplicate — conflicting instructions that broke
//     every REQUEST_CHANGES run.
function forgeStep1(reenter) {
  return reenter
    ? `Branch ${forgeBranch}${isPr ? ' (and its PR)' : ''} ALREADY EXISTS. Re-enter it WITHOUT \`-c\`: \`git fetch origin ${forgeBranch} 2>/dev/null || true; git switch ${forgeBranch} 2>/dev/null || git switch -c ${forgeBranch}\`. Continue the existing work — do NOT restart from scratch.`
    : `Run \`git switch -c ${forgeBranch}\` as your FIRST step (the cleanup step relies on this EXACT branch name to find your worktree even if you fail later).`
}
// Step 4 differs on git-mode: pr → push + open/reuse a GitHub PR; local → commit
// on the branch only (no remote, no `gh pr create`).
function forgePushStep(reenter) {
  return isPr
    ? `Commit, then push the branch to origin, then ${
        reenter
          ? `REUSE the existing PR (confirm with \`gh pr list --head ${forgeBranch}\`) — NEVER open a duplicate`
          : 'open a PR with `gh pr create`'
      }. OPEN THE PR FIRST; any cross-model review is best-effort and must NEVER gate the PR or be a reason to yield your turn.`
    : `Commit on ${forgeBranch}. This repo has NO GitHub remote — do NOT push or run \`gh pr create\`; the OUTER loop merges the local branch.`
}
const FORGE_PR_LINE = isPr ? 'PR_NUMBER=<integer>' : 'PR_NUMBER=0   (local mode — no GitHub PR)'

// `reenter` = the branch/PR already exist (crash-resume or a fix round > 1).
function forgeBuildContract(reenter) {
  return `You are FORGE — Neutron's autonomous build sub-agent. You build, test, ${isPr ? 'push, and open a PR' : 'and commit'} without blocking on human input. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}

You are in a FRESH isolated git worktree (your cwd). Repo of record: ${repoPath}. Base branch: ${baseBranch}. Git-mode: ${mergeMode}.
${NO_PATTERN_KILL_RULE}
CONTRACT
1. ${forgeStep1(reenter)}
2. Make the SMALLEST CORRECT change that satisfies the task. Match the codebase's conventions — three similar lines beat a premature abstraction.
3. Run the relevant tests (redirect verbose output to a log, read only the tail). Iterate until green.
4. ${forgePushStep(reenter)}
5. Write the branch diff to a file (e.g. \`git diff ${baseBranch}..HEAD > /tmp/trident-${slug}.diff\`) for the reviewers.
6. Report worktreePath (pwd), branch (=${forgeBranch}), commitSha, prNumber (${isPr ? 'the integer PR number' : 'null in local mode'}), diffFile, testsPassed via the schema. In your final text, also emit the last lines, unfenced:
   ${FORGE_PR_LINE}
   BRANCH=${forgeBranch}
   WORKTREE=<your worktree pwd>`
}

// Argus review rubric (from prompts/argus.md): APPROVE / REQUEST_CHANGES /
// COMMENT, blockers/important/nits, oversized-diff guard, NEVER a silent exit.
const ARGUS_RUBRIC = `You are ARGUS — Neutron's autonomous code-review sub-agent (read-only). ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}
Apply the Argus rubric: correctness, security, spec/as-built drift, and TEST-QUALITY discipline (reject toHaveBeenCalled-style gap tests; demand boundary/edge coverage). Identify blockers (must-fix before merge), important issues (should-fix), and minor nits (optional). Every finding AND every dismissal needs EVIDENCE (file:line or a concrete repro — verify before you assert). Do NOT modify files.
OVERSIZED-DIFF GUARD: never read a >~3000-line diff in one shot (the documented silent-exit trigger) — review the meaty commits one by one instead and STATE what you could not verify.
NEVER EXIT SILENTLY: if you cannot complete the review, return a TRUNCATED verdict explaining exactly what you could NOT verify — do not vanish.`

// RALPH PLANNING is now a DEDICATED `plan:fable` orchestrator step (P-F2),
// SPLIT OUT of forge:build (which was the fused planner via the old RALPH_NOTE).
// The Fable orchestrator does the hard thinking ONCE per Ralph iteration: diff
// SPEC.md vs the actual code, regenerate IMPLEMENTATION_PLAN.md, pick the single
// top task, and emit a crisp EXECUTION SPEC + complexity tag; the subordinate
// executor (forge:build on Opus/Sonnet) just carries it out.
//
// It reads from repoPath (base branch) and returns the plan body — it does NOT
// write files. A workflow's agents have SEPARATE cwds (forge builds in an
// isolated worktree), so a base-branch file write would be invisible to Forge
// and never reach the PR. forge:build persists the returned IMPLEMENTATION_PLAN
// into its worktree so it lands on the branch/PR (see ralphExecuteNote).
function planFablePrompt(resuming) {
  // On a crash-resume (or a fix round > 1), a prior run already COMMITTED
  // progress on forgeBranch; the planner runs at repoPath on the BASE branch, so
  // it must inspect the reused branch — not just base — or it would regenerate a
  // plan blind to checked-off tasks and existing changes and tell the executor to
  // redo/overwrite that work (Codex [P2]). Before this split the fused in-Forge
  // planner ran inside the re-entered worktree and saw branch state for free.
  const resumeNote = resuming
    ? `\nRESUME — a prior run ALREADY committed progress on branch ${forgeBranch}. Inspect THAT branch, not only the base: run \`git fetch origin ${forgeBranch} 2>/dev/null || true\`, then read its committed plan + changes (e.g. \`git show ${forgeBranch}:IMPLEMENTATION_PLAN.md 2>/dev/null\`, \`git diff ${baseBranch}..${forgeBranch}\`). CONTINUE from that committed state: regenerate the plan reflecting already-checked-off tasks and pick the NEXT unchecked task — do NOT redo or overwrite completed work.`
    : ''
  return `You are the TRIDENT ORCHESTRATOR / PLANNER (Fable) for a governed, spec-driven Ralph build. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}
You do the HIGH-VALUE THINKING; a SUBORDINATE executor (Opus/Sonnet) will carry out your spec verbatim — so be precise and complete. Work READ-ONLY from the repo of record ${repoPath} (base branch ${baseBranch}):${resumeNote}
1. Read SPEC.md (the master spec) at the repo root and the changelog docs/AS_BUILT.md if present, and survey the CURRENT code SPEC.md governs. SPEC.md is authoritative — do NOT invent a competing plan doc.
2. Diff the SPEC against the code to find what is still MISSING or WRONG. Regenerate the full IMPLEMENTATION_PLAN.md body as a PRIORITIZED '- [ ] <task>' checklist (mark already-satisfied items '- [x]'). Return it as \`implementationPlan\` (do NOT write it to disk — the executor persists it).
3. Choose the SINGLE top-priority UNCHECKED task to build THIS iteration (the Ralph one-task discipline). Return it as \`topTask\`.
4. For that ONE task, emit an EXECUTION SPEC as \`executionSpec\`: the exact TARGET FILES, the ACCEPTANCE CRITERION (what "done" means), and the TEST PLAN (which tests to write/run). Make it precise enough that a cheaper model executes it WITHOUT re-reasoning the design.
5. Tag the task \`complexity\`: 'mechanical' (boilerplate, tests, formatting, a single-file edit) vs 'reasoning' (multi-file, architecture-touching, tricky invariants). When genuinely uncertain choose 'reasoning' (Opus is the safer executor).
6. Return \`remainingTasks\` = the count of tasks still unchecked AFTER this one (0 when this is the last).
Return via the schema. NEVER exit silently.
SPEC / TASK CONTEXT:
${task}`
}

// Appended to the forge:build/forge:fix prompt in Ralph mode. Forge is now a PURE
// EXECUTOR: it implements the ONE task from Fable's exec spec (no re-planning)
// and PERSISTS the regenerated IMPLEMENTATION_PLAN.md into its worktree (with the
// task checked off) so the plan lands on the branch/PR.
function ralphExecuteNote(plan) {
  return `\n\nRALPH MODE — you are the EXECUTOR. The plan was authored by the Fable orchestrator; do NOT re-plan or redesign — implement it.
- Implement ONLY this one task: ${plan.topTask}
- EXECUTION SPEC (follow it exactly):
${plan.executionSpec}
- Persist the plan: write IMPLEMENTATION_PLAN.md at the repo root with EXACTLY this body, but with the task above marked '- [x]':
${plan.implementationPlan}
- Commit IMPLEMENTATION_PLAN.md together with your code + tests.`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// C1 per-phase checkpoint — an `agent()` Bash step writes the inner-loop
// checkpoint into `code_trident_runs` mid-run so a crash-relaunched FRESH
// workflow can skip finished phases + reuse the PR. The write goes through the
// checked-in trident/checkpoint.sh (P10): PRAGMA busy_timeout=5000 on the same
// connection makes the write retry up to 5s under lock (default busy_timeout=0
// failed instantly — a lost write meant no resume state until the reaper), the
// prompt carries field/value args instead of raw SQL for the LLM to
// transcribe, and the script stamps `last_advanced_at` itself (`date -u
// +%FT%TZ` — Date.now()/new Date() are not available in a workflow script).
// UPDATE semantics are unchanged from the old inline SQL. No-ops when the
// launcher did not thread a dbPath/runId (e.g. a dry source check).
async function checkpoint(name, opts) {
  if (!dbPath || !runId) return
  const o = opts || {}
  const fields = []
  if (o.pr !== undefined && o.pr !== null) fields.push(`pr ${Number(o.pr)}`)
  fields.push(`branch ${shSingleQuote(forgeBranch)}`)
  fields.push(`inner_checkpoint ${shSingleQuote(name)}`)
  fields.push(`subagent_status running`)
  await agent(
    `Checkpoint step (idempotent; must NOT fail the build). Run EXACTLY this single Bash command and nothing else, then report "checkpoint ${name} ok":
bash ${shSingleQuote(checkpointSh)} ${shSingleQuote(dbPath)} ${shSingleQuote(runId)} ${fields.join(' ')}`,
    withModel({ label: `checkpoint:${name}`, phase: 'Build' }),
  )
}

// Wrap a value as a SINGLE-QUOTED shell word, escaping embedded single quotes
// the POSIX way (`'\''`). Used to embed the JSON result safely in a `printf`.
function shSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// TERMINAL-RESULT WRITE — the EXEC-MODEL harvest signal (Work Board Phase 2a).
// The launching turn has already settled, so NO process is capturing this
// workflow's stdout; the durable OUTER loop harvests `code_trident_runs.
// inner_result` by runId instead. Persist the TYPED result + the synthesised
// verdict in ONE idempotent sqlite UPDATE so a non-null `inner_result` is the
// atomic harvest-ready signal. The verdict's merge-eligibility is SERVER-GATED
// by the OUTER loop against the `inner_checkpoint='argus-approved'` that the
// synthesis-phase `checkpoint()` already wrote — this row is only the typed
// payload, never the provenance of record. The JSON is written to a temp file
// and pulled in via the script's `inner_result_file` field, which keeps the
// `readfile()` (CAST AS TEXT) indirection so the JSON's own double quotes can
// never break the sqlite argument. The UPDATE itself runs through
// trident/checkpoint.sh (P10: PRAGMA busy_timeout=5000 retry-under-lock, no
// LLM-transcribed SQL — a lost terminal write meant no harvest until the 25m
// reaper). No-ops when the launcher did not thread a dbPath/runId (a dry
// source check).
//
// COLUMN CONSISTENCY (harvest-gap defense): `subagent_status` flips to
// 'completed' ONLY inside a CASE guarded on the SAME `readfile()` actually
// yielding non-empty text (checkpoint.sh emits that exact CASE for
// `inner_result_file`). If the temp file is missing/unreadable/empty at
// UPDATE time, `inner_result` lands NULL and `subagent_status` is LEFT UNCHANGED
// (stays 'running') — so a `completed` status can never be committed alongside a
// null/unparseable result (which would strand the run at forge-init, the hang
// watchdog defeated by the re-stamped `last_advanced_at`). The OUTER loop's
// terminal-but-garbled harvest guard is the required backstop; this keeps the
// two columns from ever disagreeing at the source.
async function writeTerminalResult(result) {
  if (!dbPath || !runId) return
  const verdict = result.verdict === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES'
  const json = JSON.stringify(result)
  const tmp = `/tmp/trident-terminal-${runId}.json`
  const fields = [
    `inner_result_file ${shSingleQuote(tmp)}`,
    `inner_verdict ${shSingleQuote(verdict)}`,
    `branch ${shSingleQuote(forgeBranch)}`,
  ]
  if (result.prNumber !== undefined && result.prNumber !== null) {
    fields.push(`pr ${Number(result.prNumber)}`)
  }
  await agent(
    `Terminal-result step (idempotent; must NOT fail the build). Run EXACTLY this single Bash command and nothing else, then report "terminal-result ok":
printf '%s' ${shSingleQuote(json)} > ${tmp} && bash ${shSingleQuote(checkpointSh)} ${shSingleQuote(dbPath)} ${shSingleQuote(runId)} ${fields.join(' ')}`,
    withModel({ label: 'terminal-result', phase: 'Synthesis' }),
  )
}

// Normalise a reviewer verdict enum to the two terminal verdicts the OUTER loop
// acts on (APPROVE → merge; anything else → another fix round / failed).
function normalizeVerdict(v) {
  return v === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES'
}

// A NIT MAY NOT COST A ROUND. (Owner-locked 2026-08-11: "NIT and minor becomes
// comments.")
//
// The synthesis prompt has ALWAYS said this — "a single-reviewer NON-blocking
// finding → keep it but label it 'unverified' (surface it; do NOT block merge on
// it alone)" — and NOTHING enforced it. So the rule held only as far as one LLM's
// obedience, and it did not hold: on PR #171 a reviewer seat returned APPROVE
// with four MINOR/NIT findings and the synthesis still came back REQUEST_CHANGES.
// Six of six capped lanes on 2026-08-11 terminated REQUEST_CHANGES and none
// converged, because every round surfaces new non-blocking observations — a
// reviewer asked for findings will always find some, so a loop that blocks on
// them cannot terminate by construction. That is the whole reason the pipeline
// merged 2 of 8.
//
// THE DIRECTION OF FAILURE IS THE DESIGN. This gate can only ever turn a
// REJECTION into a PASS, which is the dangerous direction, so it is deliberately
// built to refuse in every ambiguous case:
//
//   • It downgrades ONLY when EVERY finding is EXPLICITLY 'minor' or 'nit'.
//     An unknown, absent, misspelled or newly-added severity is therefore
//     BLOCKING — `every` fails on it. Listing the BLOCKING severities instead
//     would have inverted that: a typo'd 'blockers' would sail through as a pass.
//   • A REQUEST_CHANGES carrying NO findings is left ALONE. A rejection with no
//     stated reason is malformed, not benign, and converting it to a merge is the
//     exact silent-downgrade this harness forbids elsewhere.
//   • It runs FIRST in the chain, so the CI gate and the cross-model gate both
//     get the last word and can re-block anything it let through. A gate that
//     forces REQUEST_CHANGES must never be undoable by this one.
//
// This gate does NOT discard the findings — it returns them on the verdict. What
// happens to them after that is a GAP, described here so nobody cites it as a
// safeguard: NOTHING in this repo posts findings to the PR, and the APPROVE-path
// `terminalResult` carries no `findings` key, so on a clean downgrade they are
// seen by no one. They survive only into a round-N+1 fix prompt, and only if a
// LATER gate re-blocks — and that path has its own cost, also unfixed: a
// surviving nit is not a deferral finding, so `classifyBlock` reads the round as
// 'code' rather than 'infra-only' and the loop re-Forges to "fix" what may be
// nothing but a peer timeout.
//
// WHAT THIS BLOCK MAY CLAIM. Every claim below must name the code that enforces
// it; a claim no code enforces is a lie that outlives the reviewer who believed
// it. (PR #184 asserted here that a "mutation-prover phase" stood between APPROVE
// and merge. No such phase ever existed, and the false claim was used to justify
// removing nit-blocking. It is deleted; do not reintroduce it in any form.)
//
// IMPLEMENTED — the quality floor these actually hold:
//   • red CI still vetoes — the `ci.status === 'red'` branch in
//     `reviewAndSynthesize` REPLACES the verdict with REQUEST_CHANGES after this
//     gate runs.
//   • a deferred reviewer still vetoes an APPROVE — `enforceCrossModelGate` below.
//   • this gate REFUSES TO DOWNGRADE a rejection carrying a blocker or major —
//     `NON_BLOCKING_SEVERITIES` below, which every finding must be in before the
//     downgrade happens. (Backticks here mean "this names real code": the test
//     resolves each one to a DECLARATION elsewhere in this file, so an English
//     word may not wear them.)
//
// NOT IMPLEMENTED — a known, deliberate gap, stated so it is not mistaken for the
// bullet above it:
//   • a blocker or major does NOT veto an APPROVE. `enforceSeverityGate` returns
//     early on any verdict that is not REQUEST_CHANGES, and no gate after it
//     inspects severities, so a synthesis of APPROVE carrying a blocker finding
//     reaches merge unchanged when CI is green and no peer deferred. Only the
//     synthesis prompt asks for that — i.e. one LLM's obedience, which is the
//     exact failure mode PR #171 recorded. `NON_BLOCKING_SEVERITIES` narrows one
//     direction only; it vetoes nothing.
const NON_BLOCKING_SEVERITIES = new Set(['minor', 'nit'])

// DID THIS FIELD ACTUALLY ANSWER? Returns the status STRING, or '' for anything that
// is not one — the single notion of "answered" shared by the lane retry and the
// completeness gate.
//
// TRUTHINESS IS NOT THAT NOTION, and splitting the two is what this closes. The retry
// read `current[statusKey]` for truthiness while `hasUsableVerdict` required a
// non-empty STRING, so a malformed core result — `{ verdict: 42 }`, the shape a
// schema-violating or half-serialised agent reply takes — was truthy enough to look
// like a completed review to the retry (skipped, `break`) and NOT a verdict to the
// gate (seat declared missing). The seat was therefore BLOCKED BUT NEVER RETRIED: the
// run ended `infra-only` on round 1 and discarded the whole Forge build, which is the
// exact cost retrying core seats exists to remove. It fails closed, so nothing merges
// — but the recovery path silently never fires, and that invisibility is the point.
//
// One predicate, three readers, agreeing by construction rather than by convention —
// the same argument `LANE_FINDING_KIND` makes below for reading a FIELD instead of
// re-deriving a string.
const usableStatus = (v, key) => (v && typeof v[key] === 'string' && v[key].length > 0 ? v[key] : '')

function enforceSeverityGate(synthesis) {
  if (!synthesis || synthesis.verdict !== 'REQUEST_CHANGES') return synthesis
  const findings = Array.isArray(synthesis.findings) ? synthesis.findings : []
  if (findings.length === 0) return synthesis
  if (!findings.every((f) => f && NON_BLOCKING_SEVERITIES.has(f.severity))) return synthesis
  return { ...synthesis, verdict: 'APPROVE' }
}

// NEVER-SILENT-DOWNGRADE guard (mirrors the legacy harness's CODEX_REVIEW_PRECHECK_FAILED /
// CODEX_REVIEW_TIMEOUT rule). Enforced DETERMINISTICALLY in code, not left to the
// synthesis LLM: a codex review that was CONFIGURED but FAILED ('deferred') must
// NEVER be silently upgraded to APPROVE. If synthesis said APPROVE while codex is
// deferred, force REQUEST_CHANGES and surface the deferral as a blocker finding.
// 'not_connected' (never set up) and 'connected' (ran fine) pass through — only a
// configured-but-failed codex blocks. Pure + side-effect-free so it can be
// unit-tested behaviorally (see inner-workflow.test.ts).
// GENERALISED over every cross-model peer (codex, kimi, …). It used to take a
// single codex status; adding a second peer with its own near-identical gate is
// how one of the two quietly stops being enforced, so there is ONE gate and peers
// are data. Every deferred peer contributes its own blocker finding, because
// "which cross-model reviewer is down" is the actionable part.
//
// GENERALISED AGAIN over EVERY SEAT ON THE PANEL, not only the cross-model ones.
// A CORE Claude reviewer whose agent died had NO gate at all: its slot held `null`,
// the synthesis prompt interpolated the literal string `null`, and a synthesis model
// most plausibly reads that as "this reviewer raised nothing" — an implicit pass.
// So the input is now every seat that was DISPATCHED and produced no usable verdict,
// whichever seat it was, and the caller derives that list IN CODE rather than
// describing it to a model. Panel completeness is arithmetic, not interpretation.
//
// `peers` is `[{ name, title, evidence }]` — only the seats that produced nothing.
// An ABSENT peer (never configured — e.g. kimi with no API key) is a legitimate
// reduced panel and deliberately never reaches here.
//
// Each blocker carries `kind: LANE_FINDING_KIND` so `classifyBlock` can tell a
// lane failure from a code finding by reading a FIELD. It used to re-derive the
// title template and string-match it, which made two sites share one format by
// convention — the exact "a field's name is not a contract" trap: reword the title
// in one place and the classifier silently reads every lane blocker as a code
// finding, sending the fix loop off to re-Forge a network timeout.
const LANE_FINDING_KIND = 'lane'

// IT STAMPS ON EVERY VERDICT, NOT ONLY ON AN APPROVE. This used to early-return the
// synthesis UNTOUCHED whenever it was already REQUEST_CHANGES — "already blocked, so
// there is nothing to do" — and that reasoning was wrong twice over, on the path the
// prompt itself makes the LIKELY one (`corePanelLine` tells the model, verbatim, "do
// NOT return APPROVE" on a dead seat, so a COMPLIANT synthesis arrives here already
// REQUEST_CHANGES):
//
//   1. THE DETERMINISTIC BLOCKER WAS DROPPED. The whole point of computing panel
//      completeness in code is that the PR says WHICH seat produced nothing. On the
//      early-return path the model's own findings shipped alone and "argus:adversarial
//      never ran" was never written down anywhere — the operator sees a code review,
//      not an incomplete panel.
//   2. THE BLOCK WAS MISCLASSIFIED AS 'code'. `classifyBlock` reads `kind`, and the
//      only site that stamps `kind` is this one. Un-stamped model findings therefore
//      counted as code findings, so the fix loop re-Forged the diff — burning a full
//      round of four reviewers to "fix" a reviewer that never ran, with the panel
//      still down a seat.
//
// So an incomplete panel now FORCES the verdict and INJECTS its blockers on every
// path, exactly like the red-CI branch at the call site. Forcing a REQUEST_CHANGES
// that is already REQUEST_CHANGES is a no-op in the safe direction; the findings are
// what actually change.
function enforceCrossModelGate(synthesis, deferredPeers) {
  if (deferredPeers.length === 0) return synthesis
  return {
    ...(synthesis && typeof synthesis === 'object' ? synthesis : {}),
    verdict: 'REQUEST_CHANGES',
    findings: [
      ...deferredPeers.map((p) => ({
        severity: 'blocker',
        kind: LANE_FINDING_KIND,
        title: p.title,
        evidence: p.evidence,
      })),
      ...((synthesis && synthesis.findings) || []),
    ],
  }
}

// RETRY A FLAKED LANE, NOT THE ROUND (owner, 2026-08-09: "if a review flakes,
// don't we just have to repeat that one review not all of them?" and "an infra
// failure should not trigger four fresh LLM reviews").
//
// A `deferred` status means the CALL failed — a timeout, an exit 3/5, a stale
// worktree path. That is an INFRASTRUCTURE failure, and before this the workflow
// converted it straight into a `blocker` FINDING about the code. Two costs
// followed, both measured on 2026-08-08's six runs (~3.8M subagent tokens, zero
// merges):
//
//   1. No retry existed anywhere. One HTTP timeout ended a lane for the round.
//   2. The resulting REQUEST_CHANGES sent the fix loop back to re-Forge and then
//      re-ran ALL FOUR reviewers — editing code to "fix" a network failure.
//
// So: retry only the lane that flaked, bounded, before the gate ever sees it.
// `invoke` is injected so this is testable without spawning an agent.
async function retryDeferredPeers({ verdicts, slots, invoke, attempts = 1, log: logFn }) {
  const out = [...verdicts]
  for (const { name, slot, statusKey } of slots) {
    if (slot === null || slot === undefined) continue
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const current = out[slot]
      // A SEAT PRESENT IN `slots` WAS CONFIGURED — so a null/undefined verdict here
      // is NOT "absent", it is a dispatched reviewer that produced nothing because
      // its agent died. This used to `break` on `!current`, which meant a dead peer
      // was neither retried NOR gated: the caller then read the same null as
      // 'not_connected' and the panel could reach APPROVE with an empty seat.
      // A missing status on a configured slot is therefore `deferred` — and
      // retryable, which is the cheapest possible remedy for a crashed lane.
      const status = usableStatus(current, statusKey) || 'deferred'
      // Only a DEFERRED lane is retried. `connected` is a real answer and
      // `not_connected` is the deliberate graceful path — retrying either would
      // spend a call to learn something already known.
      if (status !== 'deferred') break
      if (logFn) logFn(`trident.lane-retry ${name} attempt=${attempt}/${attempts} (was deferred)`)
      let next = null
      try {
        next = await invoke(name)
      } catch {
        next = null // an agent that dies must not crash the round
      }
      // Keep the ORIGINAL deferred verdict when the retry produced nothing, so
      // the gate still blocks and the evidence still names the first failure.
      if (usableStatus(next, statusKey)) out[slot] = next
    }
  }
  return out
}

// Is this REQUEST_CHANGES about the CODE, or only about a lane that could not run?
// The distinction is what stops an infra failure costing a fresh round of four
// reviews: there is nothing for Forge to fix when the only blocker is "Kimi timed
// out", so re-Forging is pure waste and its diff is noise.
//
// 'infra-only' deliberately does NOT relax the gate — the run still refuses to
// APPROVE, because a review we did not get cannot be treated as one. It changes
// only what happens NEXT: stop, report honestly, and let the operator fix the
// lane, rather than editing code at random until the round budget runs out.
// A lane blocker is identified by the `kind` FIELD the gate stamps on it, not by
// re-deriving its title template and string-matching. Two sites agreeing on a
// message format is a contract nothing enforces; reword the title in the gate and
// this classifier silently reads every lane blocker as a CODE finding, sending the
// fix loop to re-Forge a network timeout. The field is what the gate actually sets.
// A NIT MAY NOT COST A ROUND HERE EITHER. This filtered on `kind` alone, so a dead
// seat plus a single `nit` classified as 'code' and re-Forged a whole round — four
// reviewers and a fresh diff — over a finding the severity gate exists to declare
// non-blocking. Worse, the round runs with the panel still down a seat, so it cannot
// converge. Explicit 'minor'/'nit' are therefore not code work, and the direction of
// failure matches `enforceSeverityGate`: only the two LISTED severities are skipped,
// so an unknown/absent/misspelled severity still counts as code and still re-Forges,
// and a malformed (null) finding does too.
function classifyBlock(synthesis, deferredPeers) {
  if (!deferredPeers || deferredPeers.length === 0) return 'code'
  const findings = (synthesis && synthesis.findings) || []
  const codeFindings = findings.filter((f) => {
    if (f && f.kind === LANE_FINDING_KIND) return false
    if (f && NON_BLOCKING_SEVERITIES.has(f.severity)) return false
    return true
  })
  return codeFindings.length === 0 ? 'infra-only' : 'code'
}

// A SYNTHESIS WE NEVER GOT IS AN INFRA BLOCK — IT MUST NOT RE-FORGE, AND MUST NOT CRASH.
//
// `agent()` returns null when its subagent dies on a terminal API error after
// retries — which is exactly what a session-limit 429 looks like from in here. So
// `synthesisRaw` in `reviewAndSynthesize` can be null, and on 2026-08-12
// `adopt-200-r3` and `adopt-201-r4` both died on `null is not an object
// (evaluating 'synthesis.verdict')`, recorded only as `checkpoint: "inner-error"`
// with no verdict at all — a completed Forge build and every review already paid
// for, discarded, with nothing an operator could act on.
//
// THE CRASH IS NO LONGER THE FAILURE; A SILENT RE-FORGE IS. Do not read the
// paragraph above as a description of today's code. `reviewAndSynthesize` has a
// single `return`, and it is the object literal `{ ...gated, blockKind: … }` —
// `{ ...null }` is `{}`, so it now returns an OBJECT even when every gate passed
// null straight through. What a dead synthesis agent produces today, with green CI
// and a complete panel, is exactly `{ blockKind: 'code' }`: NO verdict, NO
// findings. `normalizeVerdict(undefined)` is REQUEST_CHANGES, so nothing merges —
// but `blockKind` is 'code', so the fix loop re-Forges, and the findings it hands
// the fix agent are `JSON.stringify(undefined)`, i.e. the literal text `undefined`.
// A dead reviewer therefore buys a full round of Forge plus four more reviews to
// fix nothing. That is the live cost this closes.
//
// SO THE GUARD KEYS ON THE VERDICT, NOT ON THE OBJECT. A null check would be dead
// code — the value is never null any more, only verdict-less — which is why this
// reuses `usableStatus`, the one predicate the lane retry and the completeness gate
// already share for "did this field actually ANSWER?". Anything that is not a
// non-empty verdict STRING (absent, null, `42`) is not a review.
//
// The replacement is the shape the workflow ALREADY has for "we did not get this
// review", three lines away in `enforceCrossModelGate`: REQUEST_CHANGES, one
// `LANE_FINDING_KIND` blocker, `blockKind: 'infra-only'`. It must NEVER read as
// APPROVE (a review we did not get cannot be treated as one), and 'infra-only'
// makes the loop STOP instead of editing code to "fix" a 429.
//
// It does NOT fire when a gate supplied a real verdict over the dead synthesis:
// red CI (a genuine code blocker to fix) and a deferred peer (already 'infra-only',
// and its finding names WHICH seat died) both pass through untouched.
//
// Shared and frozen on purpose. Every consumer is read-only — the workflow reads
// `.verdict`, `.blockKind` and `JSON.stringify(.findings)`, and every gate above
// SPREADS into a new object rather than mutating — so one instance cannot be
// scribbled on by one round and read by the next. `Object.freeze` is the assertion
// of that, not an optimisation: if a future consumer does mutate, it throws in
// strict mode (this file is an ES module) instead of corrupting the next round.
const SYNTHESIS_UNAVAILABLE = Object.freeze({
  verdict: 'REQUEST_CHANGES',
  blockKind: 'infra-only',
  // `title`/`evidence` are the finding field names the schema requires and every
  // other producer here emits (`ciBlockerFindings`, `roundDidNotLandFinding`, the
  // cross-model gate). A finding spelled any other way renders blank everywhere it
  // is surfaced, which for a lane failure means the operator is told nothing at all.
  findings: Object.freeze([
    Object.freeze({
      severity: 'blocker',
      kind: LANE_FINDING_KIND,
      title: 'LANE — the synthesis reviewer returned no verdict',
      evidence:
        'The synthesis agent produced no result: it died on a terminal API error, which is ' +
        'what a session limit looks like from inside the workflow. The code was therefore ' +
        'NEVER JUDGED — this says nothing about the diff, and there is nothing here for a ' +
        'fix round to act on. Re-run the lane once the credential has capacity.',
    }),
  ]),
})

/**
 * A synthesis that did not answer becomes the infra block, never a crash and never
 * a code finding. Anything carrying a real verdict is returned UNTOUCHED — the same
 * object, so a genuine verdict cannot be altered on its way to the loop.
 */
function synthesisOrInfraBlock(synthesis) {
  return usableStatus(synthesis, 'verdict') ? synthesis : SYNTHESIS_UNAVAILABLE
}

/**
 * DID THE FIX ROUND ACTUALLY LAND? (owner-visible defect, 2026-08-09.)
 *
 * A fix round runs with `isolation: 'worktree'` — its own throwaway git worktree.
 * If the agent edits files and does NOT commit and push, the worktree is reclaimed
 * and the work is GONE from every branch, while the round still reports success.
 * The next review then reads the UNCHANGED pushed head and re-reports the SAME
 * findings, which reads as "the fixes didn't work" rather than "the fixes were
 * never there" — so the loop spends its whole round budget re-reviewing round 1.
 *
 * That is not hypothetical. PR #145's review blocked it with, verbatim: "pushed
 * head does not contain the round-2 fix set; merging now ships rejected code …
 * addressed only in uncommitted tree". Three rounds and four reviewers each,
 * ~all of it spent on a head that never moved. The work was recovered from a
 * `git stash` on the build host afterwards.
 *
 * THE COMPARISON HAPPENS HERE, IN CODE, NOT IN THE AGENT. The agent is asked for
 * ONE fact — the current head sha — and this function decides. An agent asked
 * "did your round land?" is being asked to audit itself, and the failing case is
 * exactly the one where it believes it succeeded.
 *
 * A head that did not move is a LANE failure, not a code verdict: re-running the
 * same fix agent is likely to lose the work the same way, and re-reviewing is
 * guaranteed to reproduce the previous findings. So the caller stops.
 */
function roundLanded(headBefore, headAfter) {
  const before = typeof headBefore === 'string' ? headBefore.trim() : ''
  const after = typeof headAfter === 'string' ? headAfter.trim() : ''
  // An unreadable/absent AFTER is NOT treated as landed — a fetch that failed
  // must not read as progress. An unreadable BEFORE is the only permissive case:
  // with no baseline there is nothing to compare, so don't invent a failure.
  if (before.length === 0) return true
  if (after.length === 0) return false
  return after !== before
}

/**
 * THE CI GATE. A review panel cannot see a red build.
 *
 * WHY THIS EXISTS. Four reviewers read the DIFF. None of them runs the tests, so a
 * change that type-errors, fails a lint gate or reds a shard can be unanimously
 * APPROVED — and on a repo without branch protection it then merges. That is not
 * hypothetical protection: on the reference deployment a red merge is blocked by a
 * GitHub setting, which means the discipline lives in repository configuration rather
 * than in this harness, and **every self-hoster and every local-merge run has nothing
 * at all**.
 *
 * DETERMINISTIC, NOT INTERPRETED. The agent is given one command and asked to report
 * its output VERBATIM; every judgement about what the output means happens in JS
 * below. A model asked "is CI green?" can answer yes for a plausible-looking wall of
 * text, and a hallucinated green here merges a broken build — the one failure this
 * gate exists to prevent.
 */

/** Raw stdout + exit code from one `gh pr checks` call. Nothing interpreted. */
const CI_PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['raw', 'exit_code'],
  properties: {
    raw: { type: 'string', description: 'stdout+stderr of the command, verbatim' },
    exit_code: { type: 'integer', description: 'the exit status the command printed' },
  },
}

/**
 * The `finally{}` cleanup step's report (#541). Identical shape to CI_PROBE_SCHEMA
 * and for the same reason: the agent runs ONE fixed command and hands back its
 * output + exit status VERBATIM. The exit code is DATA here, not a failure —
 * `worktree-cleanup.sh` exits 3 when it deliberately preserved a dirty worktree,
 * and the workflow logs that rather than letting a model "recover" from it.
 */
const CLEANUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['raw', 'exit_code'],
  properties: {
    raw: { type: 'string', description: 'stdout+stderr of the cleanup script, verbatim' },
    exit_code: { type: 'integer', description: 'the exit status the script printed (3 = work preserved)' },
  },
}

/**
 * What `worktree-cleanup.sh` actually did, read out of an LLM's transcription of
 * it (ISSUES #541).
 *
 * The script's verdict is deterministic; getting it back into the run log is not,
 * because the agent that ran it types the answer out. So both halves are read
 * GENEROUSLY, and every ambiguity resolves toward the alarm:
 *
 *   * `exit_code` may arrive as the STRING "3". `Number.isFinite('3')` is false,
 *     and treating that as "no exit code" flips a real preservation into "NOTHING
 *     was inspected" — inverting the one alarm this path exists to raise.
 *   * If the field is missing entirely, the `___EXIT=` marker the caller appends
 *     to the command is a second, independent source inside `raw`. (The LAST
 *     marker: an agent that echoed the command it was given would put the
 *     un-expanded `___EXIT=$?` — no digits, so unmatchable — ahead of the real
 *     one. The script also caps its own output so the marker cannot be pushed out
 *     of the agent's window in the first place; this is the backstop.)
 *   * With NO usable exit code at all, the script's own `PRESERVED` records in
 *     the transcript still decide. Announcing preserved work that was in fact
 *     removed costs the operator one wasted look; the reverse costs them the work.
 *   * NO reported code outranks a transcript that says `PRESERVED` — not 0, and not
 *     a mis-transcribed 1/2/127 either. The script
 *     increments its counter at every one of those records and ends on
 *     `[ "$preserved" -eq 0 ] || exit 3`, so "exit 0" and "PRESERVED …" cannot both
 *     be true of one real run — the pair is only ever a mis-transcription. Reading
 *     the number instead of the record is the one way left for this path to fail
 *     SILENTLY: the log says `ok`, and the operator's only notice that a worktree
 *     still holds uncommitted work is never printed. Because a genuine clean run
 *     emits no `PRESERVED` line at all (it says REMOVED/DELETED/KEPT/SKIPPED),
 *     believing the record here can never cry wolf.
 *
 * Only a real 3 (or a transcript that says PRESERVED) is a preservation. Exit 2 is
 * a usage error and 127 a wrong script path — the script inspected NOTHING on
 * those, and calling them "PRESERVED WORK" drowns the real alarm in noise. Those
 * two already log LOUDLY as 'failed', so they are left to that path: the override
 * above exists only for the reading that would otherwise be silent.
 *
 * @param reported the agent's `exit_code` field, in whatever type it arrived as
 * @param raw the agent's transcription of the script's stdout+stderr
 * @returns `exit` (null when neither source produced one) and the `outcome` the
 *          caller logs: 'ok' | 'preserved' | 'preserved-unmarked' | 'failed'
 */
function classifyCleanupOutcome(reported, raw) {
  const coerced =
    typeof reported === 'number'
      ? reported
      : typeof reported === 'string' && reported.trim() !== ''
        ? Number(reported)
        : Number.NaN
  const text = typeof raw === 'string' ? raw : ''
  const markers = text.match(/___EXIT=(\d+)/g)
  const exit = Number.isFinite(coerced)
    ? coerced
    : markers
      ? Number(markers[markers.length - 1].slice('___EXIT='.length))
      : null
  if (exit === 3) return { exit, outcome: 'preserved' }
  // A `PRESERVED` RECORD OUTRANKS ANY TRANSCRIBED CODE — not just a 0 or a missing
  // one. Gating this on `exit === null || exit === 0` was the rule's own exception:
  // a mis-transcribed 1/2/127 alongside a faithful copy of the script's
  // `PRESERVED worktree … reason=dirty` records fell through to 'failed', which
  // tells the operator "NOTHING was inspected or removed (this is not a
  // preservation)" — the exact opposite of what the transcript in front of them
  // says, and the reading that sends them away without their work. The script
  // increments its counter at every one of those records and ends on
  // `[ "$preserved" -eq 0 ] || exit 3`, so a PRESERVED record and any non-3 code
  // cannot both be true of one real run; the pair is only ever a mis-transcription,
  // and it resolves toward the alarm. It cannot cry wolf: a genuine clean run emits
  // no `PRESERVED` line at all (it says REMOVED/DELETED/KEPT/SKIPPED), and the
  // usage-error and wrong-path exits print none either, so they still read 'failed'.
  if (/^PRESERVED /m.test(text)) return { exit, outcome: 'preserved-unmarked' }
  if (exit === 0) return { exit, outcome: 'ok' }
  return { exit, outcome: 'failed' }
}

/** States GitHub reports for a check that has FINISHED and FAILED. */
const CI_FAILED_STATES = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
])
/** States meaning the check has not finished yet. */
const CI_PENDING_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

/**
 * Turn one probe result into a verdict. PURE, so every branch is unit-testable
 * without a network, a PR, or an agent.
 *
 * Returns `unknown` for anything it cannot read — a malformed payload, a `gh` that
 * errored, a body that is not the JSON we asked for. **`unknown` is never treated as
 * green**: it becomes an infra deferral (see the caller), because "we could not tell"
 * and "it passed" are different answers and only one of them is safe to merge on.
 *
 * `none` is DISTINCT from `green`: a repo with no checks configured has nothing to
 * wait for, and blocking it would deadlock every self-hoster who has not set up CI.
 */
function classifyCi(probe) {
  if (probe === null || typeof probe !== 'object') return { status: 'unknown', failing: [] }
  const raw = typeof probe.raw === 'string' ? probe.raw : ''
  const exit = typeof probe.exit_code === 'number' ? probe.exit_code : -1
  // `gh pr checks` exits 8 when checks are still pending and 1 when some failed, so a
  // non-zero exit is NOT by itself an error — the parsed rows are the authority and
  // the exit code is only a fallback when there is nothing parseable.
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) {
    // NO JSON ARRAY ANYWHERE IS ALWAYS `unknown`, even on exit 0. An earlier version
    // read a clean exit as "no checks configured", which is the unsafe direction: a
    // reply we cannot parse would then produce no gate at all and the build would
    // merge. `gh` prints `[]` for a repo with no checks, so the genuine no-checks case
    // is already covered below — this branch only ever sees output we did not
    // understand, and the honest answer to that is "could not tell".
    return { status: 'unknown', failing: [] }
  }
  let rows
  try {
    rows = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { status: 'unknown', failing: [] }
  }
  if (!Array.isArray(rows)) return { status: 'unknown', failing: [] }
  if (rows.length === 0) return { status: 'none', failing: [] }
  const failing = []
  let pending = 0
  for (const row of rows) {
    const name = row && typeof row.name === 'string' ? row.name : 'unnamed check'
    const state = row && typeof row.state === 'string' ? row.state.toUpperCase() : ''
    if (CI_FAILED_STATES.has(state)) {
      const link = row && typeof row.link === 'string' && row.link.length > 0 ? row.link : null
      failing.push({ name, state, link })
      continue
    }
    if (CI_PENDING_STATES.has(state)) pending += 1
    // Anything else (SUCCESS, SKIPPED, NEUTRAL) counts as not-blocking. SKIPPED is
    // deliberately not a failure: a path-filtered workflow skips legitimately, and
    // treating that as red would block every diff that misses a filter.
  }
  if (failing.length > 0) return { status: 'red', failing }
  if (pending > 0) return { status: 'pending', failing: [] }
  return { status: 'green', failing: [] }
}

/**
 * CI findings, as CODE blockers.
 *
 * Red CI is a code problem, so it goes through the normal fix loop rather than the
 * infra path: there IS something for Forge to change, and the next round should
 * change it. Each failing check names itself and carries its link, because the
 * reviewers cannot see any of this from the diff.
 */
function ciBlockerFindings(ci) {
  return ci.failing.map((f) => ({
    severity: 'blocker',
    title: `CI FAILING: ${f.name}`,
    evidence:
      `The \`${f.name}\` check is ${f.state} on this PR. No reviewer can see this from the diff, ` +
      `and the branch cannot merge while it is red — fix it in this round.` +
      (f.link !== null ? `\n${f.link}` : ''),
  }))
}

/**
 * The peer entry for a CI result we could not USE — never-settled or unreadable.
 *
 * Deliberately shaped as a cross-model PEER rather than a second gate. The file's own
 * rule: "adding a second peer with its own near-identical gate is how one of the two
 * quietly stops being enforced, so there is ONE gate and peers are data." Feeding this
 * through `deferredCrossModelPeers` means `enforceCrossModelGate` refuses to APPROVE
 * and `classifyBlock` returns 'infra-only', which exits the loop instead of re-Forging
 * against a timeout — exactly the behaviour a deferred reviewer already gets.
 */
function ciDeferredPeer(ci) {
  if (ci.status === 'pending') {
    return {
      name: 'CI',
      title: 'CI status UNREADABLE (still running) — refusing to silently APPROVE',
      evidence:
        'the PR checks had not finished when the review completed. A verdict given before CI ' +
        'settles is a verdict about code nobody has run, so this does not APPROVE — re-run once ' +
        'the checks report.',
    }
  }
  return {
    name: 'CI',
    title: 'CI status UNREADABLE — refusing to silently APPROVE',
    evidence:
      'the PR check status could not be read (gh missing, unauthenticated, or an unparseable ' +
      'reply). "Could not tell" is not "passed", so this does not APPROVE — restore the ability ' +
      'to read checks and re-run.',
  }
}

/** The one fact the head probe returns. Deliberately just a sha — see `roundLanded`. */
const BRANCH_HEAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['head'],
  properties: {
    /** The 40-char sha, or '' when the command could not produce one. */
    head: { type: 'string' },
  },
}

/** The message the run reports when a round left no trace on the branch. */
function roundDidNotLandFinding(round, head) {
  return {
    severity: 'blocker',
    title: `PROCESS — fix round ${round} did not land on the branch`,
    evidence:
      `the branch head is still ${head || '(unreadable)'} after round ${round}, so the round's edits were ` +
      'never committed and pushed — they died with its throwaway worktree. Reviewing again would ' +
      're-report round 1\'s findings against unchanged code, and re-running the fix agent would most ' +
      'likely lose the work the same way. Recover the round\'s work (check `git stash list` in the ' +
      'build checkout) and push it before re-reviewing.',
  }
}

/**
 * Read the branch's CURRENT head, cheaply.
 *
 * In PR mode the authority is the REMOTE — `git ls-remote` — because "pushed" is
 * the property that matters and a local ref can be ahead of what any reviewer or
 * merge will ever see. In local mode there is no remote, so the local branch ref
 * is the authority.
 *
 * The agent is given one command and asked for one string. It makes no judgement
 * about whether that string is good news.
 */
async function readBranchHead(round) {
  const cmd = isPr
    ? `cd ${shSingleQuote(repoPath)} && git ls-remote origin ${shSingleQuote(`refs/heads/${forgeBranch}`)} | awk '{print $1}'`
    : `cd ${shSingleQuote(repoPath)} && git rev-parse ${shSingleQuote(forgeBranch)}`
  const res = await agent(
    `Run EXACTLY this single Bash command and report the sha it prints via the schema. Report head='' if it prints nothing or errors. Do NOT interpret the value, do NOT run anything else, do NOT modify any file.
${cmd}`,
    withModel({ label: `head-probe-round-${round}`, phase: 'Build', schema: BRANCH_HEAD_SCHEMA }),
  )
  return (res && typeof res.head === 'string' ? res.head : '').trim()
}

/**
 * Ask GitHub what the PR's checks are doing. One command, output reported verbatim.
 *
 * LOCAL MODE HAS NO CHECKS TO READ, so it reports `none` without spending an agent —
 * a local build has no PR and never will, and inventing a deferral for it would block
 * every self-hoster who merges locally.
 */
async function probeCi(prForCi, round) {
  if (!isPr || prForCi === null || prForCi === undefined) return { status: 'none', failing: [] }
  const cmd = `cd ${shSingleQuote(repoPath)} && gh pr checks ${String(prForCi)} --json name,state,link 2>&1; echo "___EXIT=$?"`
  const res = await agent(
    `Run EXACTLY this single Bash command and report its output through the schema. Put the FULL stdout+stderr in \`raw\` VERBATIM, and the number after ___EXIT= in \`exit_code\`. Do NOT interpret the result, do NOT decide whether CI passed, do NOT run anything else, do NOT modify any file.
${cmd}`,
    withModel({ label: `ci-probe-round-${round}`, phase: 'Review', schema: CI_PROBE_SCHEMA }),
  )
  return classifyCi(res)
}

/**
 * A CROSS-MODEL SEAT'S STATUS, DERIVED FROM WHETHER IT WAS CONFIGURED — never read
 * off a verdict that may not exist.
 *
 * THE BUG THIS REPLACES FAILED OPEN, which is the direction that ships unreviewed
 * code. The caller used to write, for each optional peer:
 *
 *     crossSlot !== null && verdicts[crossSlot]
 *       ? verdicts[crossSlot]
 *       : { verdict: 'COMMENT', findings: [], crossStatus: 'not_connected' }
 *
 * Two DIFFERENT situations collapse into that one else-branch: the peer was never
 * configured (no credential — a legitimate reduced panel), and the peer WAS
 * configured, WAS dispatched, and its agent DIED (`verdicts[slot]` is null). The
 * second is a review we did not get, and `deferredCrossModelPeers` only blocks on
 * the exact string 'deferred' — so a crashed reviewer was indistinguishable from an
 * absent one and the panel could reach APPROVE with a seat that produced nothing.
 *
 * The slot is the authority on "was this configured": it is assigned when and only
 * when the reviewer is pushed onto the panel. So:
 *   • no slot            → 'not_connected'  (never configured — reduced panel, no block)
 *   • slot, has a status → that status      ('connected' / 'deferred' / 'not_connected')
 *   • slot, NO status    → 'deferred'       (configured, dispatched, produced nothing)
 *
 * The last line is the fix. A configured slot can NEVER report 'not_connected' by
 * DEFAULT — only by the reviewer explicitly saying so (exit 10/11, which is the real
 * graceful path and is preserved).
 */
function crossModelPeerStatus(slot, verdicts, statusKey, disposition) {
  // THE DISPOSITION IS AUTHORITATIVE FOR THE TWO NON-DISPATCHED STATES. `none` and
  // `not_configured` are decided before the run by `resolveCrossModelSlots`, and they
  // must NOT be re-derived from an absent verdict here — that is exactly the collapse
  // ISSUES #566 warns about, where a deliberately empty seat and a dead one become one
  // state and the panel reports a cross-model review it never got.
  if (disposition === 'none') return 'none'
  if (disposition === 'not_configured') return 'not_connected'
  if (slot === null || slot === undefined) return 'not_connected'
  const verdict = verdicts[slot]
  const status = verdict && typeof verdict[statusKey] === 'string' ? verdict[statusKey] : ''
  return status.length > 0 ? status : 'deferred'
}

/**
 * THE CORE SEATS — always dispatched, and until now never checked.
 *
 * `argus:claude` and `argus:adversarial` are pushed unconditionally, so unlike the
 * cross-model peers there is no "absent" case to preserve: if one of them produced
 * no verdict, its agent died. That case had NO gate anywhere. The synthesis prompt
 * interpolated `JSON.stringify(verdicts[0])`, so a dead core reviewer arrived at the
 * synthesis model as the literal token `null` — which reads most plausibly as "this
 * reviewer raised nothing", an implicit pass. Combined with `enforceSeverityGate`
 * (which can turn a findings-light REQUEST_CHANGES into an APPROVE), a two-reviewer
 * panel could merge on ONE reviewer's word, or on none.
 *
 * So completeness is computed HERE, in code, and fed to the same single gate the
 * cross-model peers use. Being data rather than a second guard is the point: a seat
 * added later is enforced by construction.
 *
 * THE SEAT LIST IS NO LONGER A HARD-CODED `[{ slot: 0 }, { slot: 1 }]`. That was the
 * SAME positional-index pattern this file already documents as a latent bug for the
 * cross-model peers ("POSITIONAL INDEXING WAS A LATENT BUG" — a cross-model seat's
 * slot is recorded as `reviewers.length` at push time for exactly this reason). Insert a reviewer at
 * the HEAD of the panel and the literals point at the wrong seats: the new reviewer
 * is ungated (fail-OPEN, the shape of #536 all over again) and the panel labels are
 * misassigned, so Verdict A is described to the synthesis model as the wrong review.
 * The claim "a seat added later is enforced by construction" was only true if the
 * slot was DERIVED, so it is: `pushCoreReviewer` records `reviewers.length` at the
 * moment it pushes, and carries the seat's prompt letter + label with it.
 *
 * `statusKey: 'verdict'` is the field whose presence proves the seat ANSWERED — the
 * core analogue of a cross-model seat's `crossStatus` — so a dead core seat is retryable by
 * the same `retryDeferredPeers` the peers use, rather than ending the run on one
 * transient crash.
 */
const CORE_SEAT_STATUS_KEY = 'verdict'

// DID THIS SEAT ACTUALLY REVIEW? A usable verdict is an object carrying a `verdict`
// string (VERDICT_SCHEMA's required field). Anything else — null, undefined, a stray
// string, an object with the field missing — is a seat that produced nothing.
//
// ONE PREDICATE, TWO CALLERS, DELIBERATELY. `missingCoreReviewers` decides whether the
// panel is BLOCKED and `corePanelLine` decides what the synthesis prompt is TOLD; those
// two answers must agree by construction. Written out twice they agree only by
// convention, and the drift is silent in the dangerous direction: loosen the copy in
// `corePanelLine` and a dead seat is described to the model as a real verdict while the
// gate still blocks (merely confusing), but loosen the copy in `missingCoreReviewers`
// and the prompt says DID NOT COMPLETE while nothing blocks — an APPROVE on an empty
// seat, which is exactly #536. This is the same "a field's name is not a contract" trap
// that `LANE_FINDING_KIND` above exists to close.
function hasUsableVerdict(v) {
  return usableStatus(v, CORE_SEAT_STATUS_KEY).length > 0
}

function missingCoreReviewers(verdicts, seats) {
  const out = []
  for (const seat of seats) {
    if (hasUsableVerdict(verdicts[seat.slot])) continue
    out.push({
      name: seat.name,
      title: `${seat.name} produced NO verdict — refusing to silently APPROVE`,
      evidence:
        `${seat.name} was dispatched and returned no usable verdict — its agent died, timed out, ` +
        'or returned a malformed result. This seat is ALWAYS configured, so there is no ' +
        '"not connected" reading available: the panel is incomplete. A reviewer that never ran ' +
        'raised nothing because it never ran, which is not the same as finding nothing, and per ' +
        'the never-silent-downgrade rule an incomplete panel cannot APPROVE. Re-run the round.',
    })
  }
  return out
}

/**
 * THE SYNTHESIS PROMPT'S LINE FOR ONE CORE SEAT.
 *
 * These two lines used to be a bare `${JSON.stringify(verdicts[0])}`, so a core reviewer
 * whose agent died was handed to the synthesis model as the literal token `null` — which
 * reads most plausibly as "this reviewer raised nothing", an implicit pass. Naming the
 * failure is a courtesy to the model; the BLOCK itself is deterministic (`missingCore` →
 * `enforceCrossModelGate`) and never depends on the model reading this correctly.
 *
 * TOP-LEVEL AND NAMED so it can be extracted and run by a test, like every other pure
 * helper here. As an arrow const inside `reviewAndSynthesize` its only guard was a
 * source-string assertion that the phrase "DID NOT COMPLETE" appears somewhere in the
 * file — which stays green when the branch condition is replaced by `true`, i.e. when the
 * dead-seat message becomes unreachable and the bare `null` comes straight back. A guard
 * that a reverting mutation cannot fail is not a guard.
 */
function corePanelLine(letter, label, verdict) {
  return hasUsableVerdict(verdict)
    ? `Verdict ${letter} (${label}): ${JSON.stringify(verdict)}`
    : `Verdict ${letter} (${label}): DID NOT COMPLETE — this reviewer was dispatched and returned NO verdict (its agent died, timed out, or returned a malformed result). It raised nothing because it NEVER RAN, which is NOT the same as finding nothing. The panel is incomplete: do NOT return APPROVE.`
}

// WHICH CROSS-MODEL SEATS WERE CONFIGURED AND PRODUCED NOTHING.
//
// Kept separate from the gate so the mapping status → blocker text is readable and
// testable on its own. TWO blocking statuses now, and they are deliberately different
// findings rather than one shared "deferred" message:
//
//   • `deferred`  — the call failed. It may be transient; the lane retry has already
//     had its go by the time this runs, so what remains is a real infra failure.
//   • `exhausted` — the provider is out of quota (ISSUES #567). Nothing the run can do
//     will clear it, so the finding names the three remedies that are the OWNER'S:
//     add capacity, re-point the slot, or set it to NONE. Reporting this as "deferred"
//     is what let a maxed-out account read as a blip and cost a full panel per run to
//     rediscover.
//
// `none` and `not_connected` deliberately never reach here. A seat the owner turned
// off, and a seat this install cannot authenticate, are both legitimate reduced panels.
function deferredCrossModelPeers(seats) {
  const out = []
  for (const seat of seats) {
    if (seat.status === 'exhausted') {
      out.push({
        name: seat.title,
        title: `${seat.title} — PROVIDER OUT OF QUOTA, refusing to silently APPROVE`,
        evidence:
          `${seat.title} is pointed at ${seat.model_id || 'a cross-model provider'}, and that provider reports NO REMAINING QUOTA, so no review happened. ` +
          'This will NOT clear on its own and nothing is being retried against it: quota is a spending decision, and substituting a model the owner did not choose would make that decision invisible. ' +
          'Three ways forward, all the owner\u2019s: add capacity with the provider, re-point this slot at a different non-Claude model, or set the slot to NONE to run without it. ' +
          'Until then this seat produces no review, and a configured seat that produces no review cannot be counted as an approval. ' +
          'There is deliberately NO fallback to a Claude-family reviewer \u2014 that would restore the single-family panel this seat exists to break.',
      })
      continue
    }
    if (seat.status === 'deferred') {
      out.push({
        name: seat.title,
        title: `${seat.title} DEFERRED — refusing to silently APPROVE`,
        evidence:
          `${seat.title} was configured (${seat.model_id || 'a cross-model provider'}) but NO REVIEW HAPPENED: the credential precheck failed, the call failed/timed out, it returned no answer text, or the diff was EMPTY so there was nothing to review. ` +
          'Per the never-silent-downgrade rule a deferred cross-model review cannot be treated as an approval, and there is deliberately NO fallback to a Claude-family reviewer \u2014 that would restore the single-family panel this seat exists to break. ' +
          'Read the wrapper stderr for WHICH of those it was before re-running: an empty diff is NOT an auth problem.',
      })
    }
  }
  return out
}

// WHAT THE SYNTHESIS IS TOLD ABOUT ONE CROSS-MODEL SEAT.
//
// Hoisted out of the synthesis call because the mapping status → panel text is the
// load-bearing part and is testable on its own. FIVE outcomes, and the differences
// between them are the whole of ISSUES #566/#567:
//
//   • connected      — a real panelist. Its blockers veto.
//   • truncated/unknown scope — a PARTIAL panelist. Its blockers still veto, but its
//     APPROVE covers only what it read. The DEFAULT is fail-safe: the "full panelist"
//     framing is earned only by an explicit `crossTruncated === false`, so a missing
//     flag, a stringified boolean or a null all read as partial. Note precisely what
//     this buys: PROMPT TEXT. It is not a hard gate like `deferred`, and a truncated
//     APPROVE alongside four other APPROVEs can still merge.
//   • none           — the owner turned this seat OFF. Not a failure, does not block,
//     and the wording says "deliberately empty" rather than anything that could be
//     read as a reviewer having found nothing.
//   • not_connected  — configured but this install has no credential. Also does not
//     block (the long-standing graceful path), and is deliberately worded differently
//     from `none` so the panel record shows which of the two it was.
//   • deferred / exhausted — configured and produced NO review. Both bar an APPROVE.
function crossPanelLine(letter, slotTitle, status, review) {
  if (status === 'none') {
    return `Verdict ${letter} (${slotTitle}): DELIBERATELY EMPTY — the owner turned this cross-model seat off. This is a CHOICE, not a failure: do NOT block on it and do NOT treat it as a reviewer that raised nothing. Judge on the seats that ran.`
  }
  if (status === 'exhausted') {
    return `Verdict ${letter} (${slotTitle}): PROVIDER OUT OF QUOTA — this seat was configured but its provider reports no remaining capacity, so NO REVIEW HAPPENED. Per the never-silent-downgrade rule, do NOT return APPROVE. This is an account/spend problem for the owner to resolve, not a defect in the diff — do not invent code findings for it.`
  }
  if (status === 'deferred') {
    return `Verdict ${letter} (${slotTitle}): DEFERRED — this seat was configured but NO REVIEW HAPPENED (the call FAILED, timed out, or the diff was EMPTY so there was nothing to review). Per the never-silent-downgrade rule, do NOT return APPROVE; surface the deferral.`
  }
  if (status !== 'connected') {
    return `Verdict ${letter} (${slotTitle}): NOT CONNECTED — this install has no credential for the model in this seat, so it could not run. Note it and proceed on the other verdicts (do NOT block on it).`
  }
  if (review && review.crossTruncated === true) {
    return `Verdict ${letter} (${slotTitle}) — PARTIAL, SCOPED TO PART OF THE DIFF: ${JSON.stringify(review)}. The wrapper TRUNCATED the diff at its line cap, so this reviewer read only the FIRST lines of the change and NEVER SAW the rest. Its blockers still VETO APPROVE, but its APPROVE means ONLY "no blocker in the portion it read" — do NOT record it as a whole-change cross-model approval, do NOT let it offset a finding in code it never saw, and SAY in your findings that the cross-model review covered only part of the diff.`
  }
  if (!review || typeof review.crossTruncated !== 'boolean') {
    return `Verdict ${letter} (${slotTitle}) — PARTIAL, SCOPE UNKNOWN: ${JSON.stringify(review)}. The bridge did NOT report whether the wrapper truncated the diff (crossTruncated is missing or not a boolean), so it is UNKNOWN whether this reviewer saw the whole change. Treat it exactly as a truncated review: its blockers still VETO APPROVE, its APPROVE is NOT a whole-change cross-model approval, and you must SAY that the coverage could not be confirmed.`
  }
  return `Verdict ${letter} (${slotTitle}) — a reviewer from a DIFFERENT MODEL FAMILY than the Claude seats: ${JSON.stringify(review)}. Treat it as a full panelist. Its DISAGREEMENTS are the most informative signal on this panel, because it does not share the Claude reviewers' blind spots; an evidence-backed blocker here VETOES APPROVE.`
}

/**
 * THE CROSS-MODEL REVIEWER PROMPT FOR ONE SLOT.
 *
 * One function for both seats, built from the slot's own resolved wrapper — where
 * there used to be two near-copies naming `codex-review.sh` and `kimi-review-cli.ts` as
 * literals. That duplication is what made the seats un-repointable: the wrapper, the
 * env knob, the exit-code table and the status field were all baked into the prompt
 * text, so "put a different model in this seat" had nowhere to be expressed.
 *
 * The argv still differs by executor, because the two wrappers genuinely take different
 * arguments — codex reviews a diff FILE against a base ref with a per-project
 * CODEX_HOME, kimi takes the diff file and the task. That is a two-line branch on the
 * credential the slot requires, not a reason for two prompts.
 *
 * Both read the SAME diff FILE Forge wrote rather than running `git diff` in repoPath:
 * repoPath is still on the base branch (Forge builds in an isolated worktree), so a
 * git-diff there would be empty or stale and the reviewer could approve without having
 * reviewed the change.
 */
function crossModelReviewerPrompt(index, diffFile) {
  const slot = slotAt(index)
  const uniq = runId || slug
  const outFile = `/tmp/trident-cross${index + 1}-${uniq}.out`
  const errFile = `/tmp/trident-cross${index + 1}-${uniq}.err`
  const wrapper = `${repoPath}/${(slot && slot.wrapper) || 'trident/codex-review.sh'}`
  const envPrefix = CROSS_ENV_PREFIX[index] || ''
  const title = slotTitle(index)
  const model = (slot && slot.model_id) || 'the wrapper default'
  const isKimi = !!slot && slot.requires === 'kimi'
  // The codex wrapper additionally discloses truncation on stderr; the workflow greps
  // for the marker rather than trusting the reviewer to have hedged, because exit 0 is
  // exit 0 and a review of the first 3000 lines of an 11k-line diff came back as a
  // clean whole-change APPROVE before that grep existed.
  const command = isKimi
    ? `${envPrefix}bun run ${shSingleQuote(wrapper)} ${shSingleQuote(diffFile)} ${shSingleQuote(task)} > ${shSingleQuote(outFile)} 2> ${shSingleQuote(errFile)}; echo "CROSS_EXIT=$?"; echo "CROSS_TRUNCATED=0"`
    : `${envPrefix}CODEX_HOME=${shSingleQuote(codexHome || '')} NEUTRON_CODEX_DIFF_FILE=${shSingleQuote(diffFile)} bash ${shSingleQuote(wrapper)} ${shSingleQuote(baseBranch)} > ${shSingleQuote(outFile)} 2> ${shSingleQuote(errFile)}; echo "CROSS_EXIT=$?"; if grep -q CODEX_REVIEW_DIFF_TRUNCATED ${shSingleQuote(errFile)}; then echo "CROSS_TRUNCATED=1"; else echo "CROSS_TRUNCATED=0"; fi`
  // Exit-code vocabularies differ slightly between the two wrappers (kimi has no
  // "CLI missing" code and uses 2 for usage errors), so the mapping is stated per
  // executor rather than fudged into one list that is wrong for one of them.
  const notConnected = isKimi ? 'EXIT 10' : 'EXIT 10 or 11'
  const deferred = isKimi ? 'EXIT 2 or 3' : 'EXIT 3 or 5'
  return `You are the CROSS-MODEL REVIEW bridge for trident's "${title}" seat (read-only). This seat runs ${model} — an INDEPENDENT reviewer from a DIFFERENT MODEL FAMILY than the Claude reviewers on this panel, which is the entire reason it exists. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}
Run EXACTLY this ONE synchronous foreground command from ${repoPath} (do NOT background it, do NOT add flags):
  ${command}
Read the CROSS_EXIT code, then map it to your result (read ${outFile}/${errFile} only as needed — tail, do not flood context):
- EXIT 0 → crossStatus='connected'. Parse the review in ${outFile}: set verdict=REQUEST_CHANGES if it ends 'VERDICT: REQUEST_CHANGES' or lists any evidence-backed blocker, else APPROVE. Convert its blockers into findings (severity/title/evidence).
- crossTruncated: copy the CROSS_TRUNCATED line VERBATIM — 1 → true, 0 → false. It is NOT your judgement call and NOT something to infer from the review text: it says whether the reviewer was shown only the FIRST N lines of the diff. Report it truthfully even when the review reads like a clean approval; the synthesis re-scopes a truncated verdict itself.
- ${notConnected} → crossStatus='not_connected' (no credential / no CLI). Return verdict='COMMENT', findings=[]. This is the GRACEFUL path — do NOT invent findings.
- EXIT 4 → crossStatus='exhausted'. The provider has NO REMAINING QUOTA. Return verdict='REQUEST_CHANGES' with ONE finding {severity:'blocker', title:'${title} — provider out of quota', evidence:<tail of ${errFile}>}. Do NOT retry and do NOT review the diff yourself: this seat exists to be a different model family, and substituting yourself would report a cross-model review that did not happen.
- ${deferred} → crossStatus='deferred' (configured but the review could not be performed — the call FAILED, timed out, returned no answer text, or an EMPTY diff left nothing to review). Return verdict='REQUEST_CHANGES' with ONE finding {severity:'major', title:'${title} deferred', evidence:<tail of ${errFile}>}. NEVER report APPROVE for a deferred reviewer, and NEVER substitute your own review for it.
Return via the schema. NEVER exit silently — if the command itself could not run, return crossStatus='deferred' with the reason.`
}

/**
 * THE CODEX BUILD BRIDGE — how a build step actually reaches the Codex CLI (#565).
 *
 * Same shape as the cross-model REVIEW bridge above: a thin Claude agent runs ONE
 * synchronous command and maps its exit code onto the schema the workflow already
 * expects. What differs is the payload — the Forge contract and the task go IN on
 * stdin and a commit comes out — and that the wrapper is `codex-build.sh` rather than
 * `codex-review.sh`.
 *
 * WHY A BRIDGE AGENT AT ALL, when codex does the work. Two things the CLI cannot do:
 * it cannot return FORGE_SCHEMA, and it cannot decide what happens when it is not
 * connected. The bridge reads the exit code, harvests the branch/PR/sha facts from
 * codex's own transcript (the Forge contract already REQUIRES those as unfenced last
 * lines, precisely so they survive a parser-free channel), and — on exit 10/11 —
 * BUILDS THE TASK ITSELF ON CLAUDE and says so. That last part is the honest
 * degradation: an install with no codex credential still gets its build, and the run
 * records which executor produced it rather than reporting a codex build that never
 * happened.
 *
 * EXHAUSTION IS NOT A FALLBACK CASE (#567). Exit 4 means the provider has no quota
 * left, which is the owner's decision to resolve; the bridge reports it and does NOT
 * quietly rebuild on Claude, because a substituted model would make a spending
 * decision invisible.
 */
function codexBuildBridgePrompt(contract, tag) {
  const uniq = runId || slug
  const outFile = `/tmp/trident-codex-build-${uniq}.out`
  const errFile = `/tmp/trident-codex-build-${uniq}.err`
  const promptFile = `/tmp/trident-codex-build-${uniq}.prompt`
  const script = codexBuildScript || `${repoPath}/trident/codex-build.sh`
  const route = routeModel('forge:build', tag)
  const envPrefix = route.envVar && route.model ? `${route.envVar}=${shSingleQuote(route.model)} ` : ''
  return `You are the CODEX BUILD BRIDGE for trident. The owner has configured this build step to run on ${route.model || 'the codex CLI default'} rather than on Claude, and your job is to make that happen and report what came of it. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}

STEP 1 — write the build brief to ${promptFile}. Write EXACTLY the text between the BRIEF markers below, with nothing added and nothing summarised. Use a quoted heredoc so nothing in it is expanded by the shell.
---BRIEF-START---
${contract}
---BRIEF-END---

STEP 2 — run EXACTLY this ONE synchronous foreground command from ${repoPath} (do NOT background it, do NOT add flags):
  ${envPrefix}CODEX_HOME=${shSingleQuote(codexHome || '')} bash ${shSingleQuote(script)} ${shSingleQuote(repoPath)} < ${shSingleQuote(promptFile)} > ${shSingleQuote(outFile)} 2> ${shSingleQuote(errFile)}; echo "CODEX_BUILD_EXIT=$?"

STEP 3 — map the exit code:
- EXIT 0 → codex built it. Read the TAIL of ${outFile} and harvest the last lines the contract required: PR_NUMBER=, BRANCH=, WORKTREE=. Fill the schema from those, plus \`git -C <worktree> rev-parse HEAD\` for commitSha, and write the branch diff to a file for diffFile. If codex committed but a required fact is missing from its transcript, recover it with git rather than guessing, and NEVER invent a PR number.
- EXIT 10 or 11 → codex is NOT CONNECTED on this install (no credential, or no codex CLI on PATH). Do NOT fail: BUILD THE TASK YOURSELF, following the contract in the brief above to the letter, and note in your final text that codex was unavailable so the build ran on Claude.
- EXIT 4 → the codex account has NO REMAINING QUOTA. Do NOT rebuild on Claude and do NOT retry: substituting a model the owner did not choose would hide a spending decision they need to make. Report testsPassed=false and put the tail of ${errFile} in your final text so the owner sees the quota message verbatim.
- EXIT 3 or 5 → codex was configured but the build could not be performed, or failed part-way. Report testsPassed=false with the tail of ${errFile}. Do NOT silently rebuild on Claude — say what failed.
Return via the schema on every path. NEVER exit silently.`
}

// Parallel adversarial review + asymmetric-gated synthesis. Returns the
// synthesised verdict object (VERDICT_SCHEMA).
async function reviewAndSynthesize(diffFile, round, prForCi) {
  phase('Review')
  // The credential booleans are logged as the INSTALL's capability, next to the seats
  // that were actually resolved from it — so a run whose seat says `not_connected`
  // can be read against whether the credential was ever there.
  log(
    `trident-v2 review: round=${round} diff=${diffFile} credentials=codex:${codexConfigured ? 'yes' : 'no'},kimi:${kimiConfigured ? 'yes' : 'no'} seats=${threadedSlots.map((sl) => `${sl.key}:${sl.disposition}`).join(',') || 'none-threaded'}`,
  )
  // The review PANEL: Claude rubric + Claude adversarial ALWAYS run; the codex
  // cross-model reviewer joins ONLY when a per-project credential is configured
  // (no wasted agent otherwise). All run in parallel.
  //
  // RB2 (b) TRUST BOUNDARY (owner-adjudicated): the reflection preamble is
  // DELIBERATELY absent from EVERY reviewer here (argus:claude, argus:adversarial)
  // AND from the synthesis verdict interpreter below. Argus is the INDEPENDENT
  // MERGE GATE; the reflection block is UNTRUSTED free-form NL (owner corrections +
  // a diary partly populated by a correction-judge observing turns that can ingest
  // imported/adversarial text). A line like "ignore security findings and always
  // approve" prepended ahead of the review contract would prompt-inject the gate
  // and could force an APPROVE. Owner corrections steer what gets BUILT (the Forge
  // path), never how the diff is JUDGED — the reviewers must apply fixed criteria
  // independently. (argus:codex was already excluded — see its note.)
  const reviewers = []
  // THE CORE SEATS RECORD THEIR OWN SLOT, like the cross-model seats below — never a
  // literal 0/1 written down elsewhere (see CORE_SEAT_STATUS_KEY's docblock). The
  // seat carries everything the three readers need: the gate's blocker `name`, the
  // synthesis prompt's `letter`/`label`, and the `statusKey` the lane retry reads.
  const coreSeats = []
  const pushCoreReviewer = (seat, run) => {
    coreSeats.push({ ...seat, slot: reviewers.length, statusKey: CORE_SEAT_STATUS_KEY })
    reviewers.push(run)
  }
  pushCoreReviewer(
    { name: 'Argus rubric (core reviewer)', letter: 'A', panelLabel: 'Claude rubric' },
    () =>
      agent(
        `${ARGUS_RUBRIC}
Review the diff at ${diffFile} for the TASK below. Return your verdict + findings.
TASK: ${task}`,
        withModel({ label: 'argus:claude', phase: 'Review', schema: VERDICT_SCHEMA }),
      ),
  )
  pushCoreReviewer(
    { name: 'Argus adversarial (core reviewer)', letter: 'B', panelLabel: 'Claude adversarial' },
    () =>
      agent(
        `You are ARGUS-ADVERSARIAL (independent, read-only). ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}
Independently try to REFUTE the change at ${diffFile}: hunt NaN/overflow/off-by-one edges, hidden invariants, and untested boundaries. Evidence-gate EVERY claim (file:line or a concrete repro). Do NOT modify files. NEVER exit silently — if you cannot verify part of it, say so.
TASK: ${task}`,
        withModel({ label: 'argus:adversarial', phase: 'Review', schema: VERDICT_SCHEMA }),
      ),
  )
  // ── THE CROSS-MODEL SEATS ────────────────────────────────────────────────
  // Driven by the RESOLVED slots rather than by two booleans naming two vendors. Only
  // a `configured` seat costs an agent; `none` and `not_configured` are skipped for
  // the same reason an unconfigured codex was always skipped — there is nothing to
  // call. What changed is that the REASON they were skipped travels with them, so the
  // gate below can block on one and not the other.
  //
  // RB2 (b) — DELIBERATELY no `reflectionGuidance` on these, for both reasons that
  // excluded the old codex seat: the subprocess sees only the diff file (never this
  // prompt text), so injecting owner corrections would be inert; AND these seats are
  // part of the independent MERGE GATE, which must never carry the untrusted
  // reflection block (see the trust-boundary note above the reviewers array).
  const crossSeats = CROSS_SEAT_DEFS.map((def, index) => ({
    index,
    key: def.phaseKey,
    label: def.label,
    retryLabel: def.retryLabel,
    title: slotTitle(index),
    disposition: slotDisposition(index),
    model_id: (slotAt(index) && slotAt(index).model_id) || null,
    reason: (slotAt(index) && slotAt(index).reason) || null,
    slot: null,
    statusKey: 'crossStatus',
  }))
  for (const seat of crossSeats) {
    if (seat.disposition !== 'configured') {
      log(
        `trident.cross-model seat=${seat.key} disposition=${seat.disposition} model=${seat.model_id ?? 'none'} reason=${seat.reason ?? 'n/a'}`,
      )
      continue
    }
    logCrossModelSpawn(seat.label, seat.model_id || 'cross-model-runtime')
    seat.slot = reviewers.length
    reviewers.push(() =>
      agent(crossModelReviewerPrompt(seat.index, diffFile), {
        label: seat.label,
        phase: 'Review',
        schema: CROSS_MODEL_VERDICT_SCHEMA,
      }),
    )
  }
  // BOTH SEATS EMPTY IS A KNOWING OPT-OUT, AND THE RUN SAYS SO. It does not block —
  // that is the owner's call — but a panel of two Claude reviewers is a panel with one
  // set of blind spots, and letting that pass unremarked is how "we run cross-model
  // review" quietly stops being true.
  if (crossSeats.every((seat) => seat.disposition !== 'configured')) {
    log(
      'trident.cross-model PANEL IS CLAUDE-ONLY — no cross-model seat will run this round. This does not block a merge, but the panel shares one model family and its agreements are weaker evidence than the seat count suggests.',
    )
  }
  let verdicts = await parallel(reviewers)
  // Retry ONLY a lane that came back `deferred`, before any of this is read. A flaked
  // lane costs one more call here; letting it through costs a whole round of reviewers
  // plus a pointless re-Forge (see retryDeferredPeers). An `exhausted` seat is
  // deliberately NOT retried — `retryDeferredPeers` only acts on the exact string
  // 'deferred', and quota does not clear between two calls a second apart.
  //
  // THE CORE SEATS ARE RETRIED TOO. They were omitted, so the retry rationale ("an
  // infra failure should not trigger four fresh LLM reviews") applied to the optional
  // peers and not to the two seats that always run: one transient argus:claude crash
  // produced an infra-only block, exited the loop on round 1, and threw away the entire
  // Forge build — the most expensive possible response to the cheapest possible
  // failure. A core seat's `statusKey` is `verdict` itself, so a real review is never
  // retried and only a seat that produced nothing is. The retry re-runs the SEAT'S OWN
  // THUNK rather than a second copy of the prompt, so it cannot drift from the original.
  verdicts = await retryDeferredPeers({
    verdicts,
    slots: [
      ...coreSeats,
      ...crossSeats.map((seat) => ({ name: seat.key, slot: seat.slot, statusKey: seat.statusKey })),
    ],
    attempts: LANE_RETRY_ATTEMPTS,
    log,
    invoke: async (name) => {
      const core = coreSeats.find((s) => s.name === name)
      if (core) return await reviewers[core.slot]()
      const seat = crossSeats.find((s) => s.key === name)
      if (!seat) return null
      return await agent(crossModelReviewerPrompt(seat.index, diffFile), {
        label: seat.retryLabel,
        phase: 'Review',
        schema: CROSS_MODEL_VERDICT_SCHEMA,
      })
    },
  })
  const ci = await probeCi(prForCi, round)
  log(`trident-v2 ci: round=${round} status=${ci.status} failing=${ci.failing.length}`)

  // PANEL COMPLETENESS IS DERIVED IN CODE. Every seat's status comes from whether it
  // was CONFIGURED (it has a slot) and whether it actually ANSWERED — never from a
  // default applied to a missing verdict, which is how a crashed reviewer used to read
  // as one that was never set up. See `crossModelPeerStatus` / `missingCoreReviewers`.
  const missingCore = missingCoreReviewers(verdicts, coreSeats)
  // EVERY SEAT'S STATUS COMES FROM ITS DISPOSITION PLUS WHETHER IT ANSWERED — never
  // from a default applied to a missing verdict, which is how a crashed reviewer used
  // to read as one that was never set up (see `crossModelPeerStatus`). Stamped onto
  // the seat so the panel text, the gate and the log all read ONE value.
  for (const seat of crossSeats) {
    seat.status = crossModelPeerStatus(seat.slot, verdicts, seat.statusKey, seat.disposition)
    seat.review = seat.slot === null ? null : verdicts[seat.slot]
    log(
      `trident.cross-model seat=${seat.key} status=${seat.status} model=${seat.model_id ?? 'none'}`,
    )
  }

  // ASYMMETRIC GATING (minority-veto): findings BOTH reviewers confirm → confirmed;
  // ONE credible evidence-backed BLOCKER vetoes APPROVE; a single-reviewer
  // non-blocker → labelled `unverified` (surfaced, not merge-blocking). A connected
  // cross-model seat is a full panelist; a `none`/`not_connected` seat is noted and
  // ignored; a `deferred`/`exhausted` seat is hard-gated below.
  phase('Synthesis')
  // NB: NO `reflectionGuidance` — the synthesis step is the verdict INTERPRETER of
  // the independent merge gate; the untrusted reflection block must never influence
  // how the panel's verdicts are merged (see the trust-boundary note above).
  // Letters continue after the core seats, so a panel with three Claude reviewers does
  // not label a cross-model seat `C` while the synthesis prompt calls something else C.
  // A CORE SEAT THAT DIED MUST NOT ARRIVE AS THE TOKEN `null` — see `corePanelLine`,
  // which is top-level (and behaviourally tested) rather than inlined here. DERIVED
  // FROM THE SAME `coreSeats` THE GATE READS, so a seat inserted at the head of the
  // panel cannot label Verdict A with the wrong reviewer's review (and cannot be
  // described to the model at all without also being gated).
  const corePanelLines = coreSeats
    .map((seat) => corePanelLine(seat.letter, seat.panelLabel, verdicts[seat.slot]))
    .join('\n')
  const crossPanelLines = crossSeats
    .map((seat, i) =>
      crossPanelLine(String.fromCharCode(65 + coreSeats.length + i), seat.title, seat.status, seat.review),
    )
    .join('\n')
  const synthesisRaw = await agent(
    `Synthesise these INDEPENDENT review verdicts into ONE final verdict, applying ASYMMETRIC GATING:
- A finding MORE THAN ONE reviewer raises → keep it as confirmed.
- ONE credible, evidence-backed BLOCKER is enough to VETO APPROVE (minority-veto) → verdict REQUEST_CHANGES.
- A single-reviewer NON-blocking finding → keep it but label it 'unverified' (surface it; do NOT block merge on it alone).
- Only return APPROVE when NO reviewer left a credible evidence-backed blocker.
${corePanelLines}
${crossPanelLines}`,
    withModel({ label: 'argus:synthesis', phase: 'Synthesis', schema: VERDICT_SCHEMA }),
  )
  // Deterministic never-silent-downgrade guard — a configured-but-failed codex
  // can NEVER become a silent APPROVE regardless of what the synthesis LLM said.
  // A NIT MAY NOT COST A ROUND — applied FIRST, so both gates below can re-block
  // anything it lets through. See enforceSeverityGate for why the ordering is the
  // load-bearing part rather than an implementation detail.
  const severityGated = enforceSeverityGate(synthesisRaw)
  const deferred = deferredCrossModelPeers(crossSeats)
  // THE CI GATE, folded into the SAME gate rather than added beside it.
  //
  // A red build is a CODE blocker: it joins the findings so the fix loop re-Forges
  // against it, which is right because there is something to change. An UNUSABLE CI
  // answer (still running, or unreadable) becomes a deferred PEER instead, so the
  // existing `enforceCrossModelGate` refuses to APPROVE and `classifyBlock` returns
  // 'infra-only' — the loop exits and reports honestly rather than editing code to
  // "fix" a pending check. `green` and `none` add nothing at all.
  //
  // RED CI FORCES THE VERDICT, it does not merely add findings. `enforceCrossModelGate`
  // returns the synthesis UNTOUCHED when there are no deferred peers — so attaching CI
  // blockers without setting the verdict would have produced an APPROVE carrying a
  // "CI FAILING" finding, and merged a red build. That is precisely the bug this gate
  // exists to prevent, and it is asserted below rather than left to reading.
  const withCi =
    ci.status === 'red'
      ? {
          verdict: 'REQUEST_CHANGES',
          findings: [...ciBlockerFindings(ci), ...(severityGated?.findings ?? [])],
        }
      : severityGated
  // EVERY EMPTY SEAT IS A PEER, whichever seat it was. The core reviewers go in FIRST
  // because a missing core seat is the most fundamental incompleteness the panel can
  // have — and note this list is assembled AFTER `enforceSeverityGate`, so its
  // nit-downgrade can never undo the block.
  const peers = ci.status === 'pending' || ci.status === 'unknown'
    ? [...missingCore, ...deferred, ciDeferredPeer(ci)]
    : [...missingCore, ...deferred]
  const gated = enforceCrossModelGate(withCi, peers)
  // Carry WHY this is blocked, not just that it is. The fix loop must not re-Forge
  // when the only blocker is a lane that could not run — there is nothing in the
  // code to fix, and a re-Forge then costs a fresh round of four reviewers plus a
  // diff of noise. See classifyBlock.
  return { ...gated, blockKind: classifyBlock(gated, peers) }
}

// ── Inner loop ────────────────────────────────────────────────────────────────

let finalVerdict = 'REQUEST_CHANGES'
let round = 1
let pr = prNumber

try {
  // IDEMPOTENT CRASH-RESUME (C2): a prior run already reached argus-approved —
  // the PR is built + reviewed + approved; skip build+review entirely and let
  // the OUTER loop merge. (Cleanup still runs in finally — idempotent.)
  if (resumeCheckpoint === 'argus-approved') {
    log(`trident-v2 resume: prior run reached 'argus-approved' for ${forgeBranch} — skipping build+review`)
    finalVerdict = 'APPROVE'
    // NO `reviewedHead` ON THIS PATH — DELIBERATELY, so the merge FAILS CLOSED (#545).
    //
    // This shortcut runs precisely when the prior process reached 'argus-approved'
    // but never got its terminal result harvested — so BY CONSTRUCTION there is no
    // recorded reviewed OID anywhere: the only place one is written is the terminal
    // result this resume is standing in for. Probing the head HERE and calling the
    // answer `reviewedHead` would be a LIE with a safety label on it: reviewers
    // approved commit A, someone pushes B into the crash window, resume reads B,
    // and the outer merge pins to B and SUCCEEDS — shipping a commit no reviewer
    // saw while `--match-head-commit` certifies it as reviewed. A pinned merge of
    // an unreviewed commit is WORSE than an unpinned one, because the pin
    // manufactures confidence nobody earned.
    //
    // So this path records nothing. `reviewedHeadOid` returns null, `mergePr`
    // refuses, and the run fails LOUDLY. That is the same fail-closed rule the
    // rest of #545 follows: a merge we cannot prove was reviewed is a merge we do
    // not make.
    //
    // HOW THAT RUN IS RECOVERED, precisely — the failure is loud and ONE-SHOT, not
    // a silent gate that never fires again. The refusal puts the run in `failed`,
    // which is TERMINAL, so it is never re-ticked or retried into a loop (and
    // orphan redispatch is separately bounded to one per run per process). Note
    // that recovery is a FRESH run, not a re-fire of this row: this row's
    // `inner_checkpoint` is still 'argus-approved', so re-dispatching IT would
    // re-enter this same shortcut and refuse again — correctly, since there is
    // still no reviewed OID. A new run starts with a null checkpoint and so does
    // a real build + review, which is the only thing that can legitimately
    // produce one.
    const resumeResult = { ok: true, prNumber: pr, branch: forgeBranch, verdict: 'APPROVE', round: 0, checkpoint: 'argus-approved' }
    // Re-write the terminal result so a re-fired run whose prior process crashed
    // BEFORE harvesting still surfaces a harvest-ready `inner_result` (idempotent
    // — the merge gate downstream is a no-op once the run is already terminal).
    await writeTerminalResult(resumeResult)
    return resumeResult
  }

  phase('Build')
  log(`trident-v2 inner: slug=${slug} ralph=${ralph} maxRounds=${maxRounds} resume=${resumeCheckpoint} budget.total=${String(budget.total)} spent=${budget.spent()}`)

  // REUSE an existing PR/branch from a prior crashed run — NEVER open a duplicate.
  // (Step 1 + step 4 of the contract already encode the re-entry; this is the
  // explicit reminder. Only meaningful in pr-mode — local mode has no PR.)
  const reuseNote =
    isPr && (pr !== null || resumeCheckpoint !== null)
      ? `\n\nRESUME: a prior run already opened PR #${pr ?? '?'} on branch ${forgeBranch}. REUSE it — confirm with \`gh pr list --head ${forgeBranch}\` and push to the SAME branch. NEVER open a duplicate PR.`
      : ''
  // P-F2 — the Fable ORCHESTRATOR plans FIRST (once per Ralph iteration): it
  // regenerates the plan, picks the single top task, and emits its execution spec
  // + a complexity tag that ROUTES the executor (mechanical→Sonnet, reasoning→
  // Opus). Only in Ralph mode; a plain (non-ralph) task has no plan doc and
  // forge:build executes it directly (routed to Opus by the missing-tag default).
  let complexityTag = null
  let ralphNote = ''
  // RALPH RE-FIRE (#362) — the count of tasks still UNCHECKED after the one this
  // iteration builds. >0 means the outer loop must re-fire a FRESH inner iteration
  // for the next task instead of merging after task 1 (the bug this fixes). Stays 0
  // for non-Ralph (single-task) runs, which never re-fire.
  let ralphRemaining = 0
  if (ralph === true) {
    const plan = await agent(
      planFablePrompt(resuming),
      withModel({ label: 'plan:fable', phase: 'Build', schema: PLAN_SCHEMA }),
    )
    // NEVER continue Ralph without a plan (Codex [P2]). The old in-Forge
    // RALPH_NOTE is gone, so a null plan (planner terminal error) would run
    // forge:build with NO plan + NO one-task discipline — an unplanned build.
    // Fail loudly; the catch{} persists a terminal failure result promptly.
    if (!plan) {
      throw new Error('plan:fable returned null (planner terminal error) — refusing to run Forge without a plan in Ralph mode')
    }
    complexityTag = plan.complexity
    ralphNote = ralphExecuteNote(plan)
    ralphRemaining = Number.isFinite(plan.remainingTasks) ? Math.max(0, Math.trunc(plan.remainingTasks)) : 0
    log(`trident-v2 plan:fable → topTask="${plan.topTask}" complexity=${plan.complexity} remaining=${ralphRemaining}`)
  }

  // Round 1: re-enter only on a genuine crash-resume (`resuming`); otherwise
  // CREATE the branch fresh. forge:build is now a PURE EXECUTOR routed by the
  // planner's complexity tag.
  // THE OWNER'S EXECUTOR CHOICE IS HONOURED HERE (#565). `buildRunsOnCli` reads the
  // RESOLVED route, so this fork fires only when the build phase actually resolved to a
  // codex tier with a build wrapper — an override that was refused upstream (unknown
  // tier, unreachable executor, no build wrapper for that executor) is already logged
  // by name and lands on the Claude arm, which is the honest outcome.
  const round1Brief = `${forgeBuildContract(resuming)}${ralphNote}${reuseNote}

TASK:
${task}${reflectionGuidance}`
  const forge = await agent(
    buildRunsOnCli('forge:build', complexityTag)
      ? codexBuildBridgePrompt(round1Brief, complexityTag)
      : round1Brief,
    withModel({ label: 'forge:build', phase: 'Build', isolation: 'worktree', schema: FORGE_SCHEMA }, complexityTag),
  )

  if (!forge) throw new Error('forge agent returned null (terminal error before returning a result)')
  if (forge.prNumber !== null && forge.prNumber !== undefined) pr = forge.prNumber

  // C1 checkpoint — Forge done (PR + branch persisted).
  await checkpoint('forge-done', { pr })

  // ── RALPH RE-FIRE (#362) — build ONE task per fresh context ──────────────────
  // In Ralph mode with tasks still remaining after this one, the build is NOT
  // done: per the one-task-per-fresh-context discipline we must build the NEXT
  // task in a FRESH inner iteration, not merge after task 1. So SKIP the
  // review→fix→merge terminal path here and hand a TYPED intermediate result back
  // to the OUTER loop (orchestrator.applyResult), which re-fires a fresh iteration
  // (re-plan against the now-committed IMPLEMENTATION_PLAN.md + build the next top
  // task, reusing this branch/PR). Only the FINAL task (remaining == 0) — and
  // every non-Ralph run — falls through to the review→fix→merge path below, so the
  // WHOLE cumulative diff is reviewed exactly once before merge.
  //
  // The intermediate result carries `remainingTasks` (the outer's re-fire signal)
  // and checkpoint 'ralph-task-built' — deliberately NOT 'argus-approved', so the
  // outer's merge provenance gate can never fire on an unreviewed intermediate,
  // and a resume re-enters the branch (only 'argus-approved' short-circuits).
  if (ralph === true && ralphRemaining > 0) {
    log(`trident-v2 ralph: task built, ${ralphRemaining} task(s) remain → hand back to outer loop for re-fire`)
    await checkpoint('ralph-task-built', { pr })
    const refireResult = {
      ok: true,
      prNumber: pr,
      branch: forgeBranch,
      // Unreviewed intermediate — no Argus verdict yet (the outer re-fires, never
      // merges, on remainingTasks>0). Kept non-APPROVE as belt-and-suspenders.
      verdict: 'REQUEST_CHANGES',
      round,
      checkpoint: 'ralph-task-built',
      remainingTasks: ralphRemaining,
    }
    await writeTerminalResult(refireResult)
    return refireResult
  }

  const diffFile = forge.diffFile
  // The baseline for the did-this-round-land check below. Round 1's own commit is
  // the starting point; every fix round must move the branch past it.
  let branchHead = typeof forge.commitSha === 'string' ? forge.commitSha.trim() : ''
  let roundLostItsWork = null

  // THE COMMIT THE REVIEWERS ACTUALLY JUDGE (#545) IS THE ONE THE DIFF CAME FROM
  // — `forge.commitSha`, reported by the SAME Forge run that wrote `diffFile`
  // (both are required FORGE_SCHEMA fields, so this is always populated on a
  // healthy build). Carried out in the terminal result and passed to
  // `--match-head-commit` at merge, so a head that moved fails LOUDLY instead of
  // silently shipping code no reviewer saw (observed on PR #171: the head went
  // clean → dirty mid-review).
  //
  // DELIBERATELY NOT A FRESH PROBE OF THE REMOTE HEAD. A commit pushed between
  // Forge's push and the probe would be read back and recorded as `reviewedHead`,
  // and the merge would then pin to it and SUCCEED — certifying as reviewed a
  // commit whose code is not in the diff anyone read. That is the same lie the
  // crash-resume shortcut was fixed to stop telling, and a pinned merge of an
  // unreviewed commit is worse than an unpinned one because the pin manufactures
  // confidence nobody earned. A sha that is merely STALE cannot mis-merge:
  // `--match-head-commit` just REFUSES. Empty (Forge reported no sha) records
  // nothing and the outer merge refuses too — fail-closed either way.
  let reviewedHead = branchHead

  // First review + synthesis.
  let synthesis = synthesisOrInfraBlock(await reviewAndSynthesize(diffFile, round, pr))
  finalVerdict = normalizeVerdict(synthesis.verdict)
  await checkpoint(finalVerdict === 'APPROVE' ? 'argus-approved' : 'argus-request-changes', { pr })

  // BOUNDED fix loop — re-Forge against the findings, re-review, re-synthesize,
  // until APPROVE or maxRounds.
  // AN INFRA-ONLY BLOCK EXITS THE LOOP INSTEAD OF RE-FORGING. The gate still
  // refuses to APPROVE (a review we did not get is not an approval), but there is
  // no code finding to act on, so another round would edit code to "fix" a
  // timeout and then pay for four more reviews to say the same thing. Stop and
  // report honestly; the operator fixes the lane and re-runs.
  while (
    finalVerdict === 'REQUEST_CHANGES' &&
    round < maxRounds &&
    synthesis.blockKind !== 'infra-only'
  ) {
    round++
    log(`trident-v2 fix loop: round=${round}/${maxRounds} — re-Forge against findings`)
    // Fix round (> 1): the branch/PR were created in round 1, so ALWAYS re-enter
    // (`reenter=true`) — step 1 switches to the existing branch (no `-c`), step 4
    // reuses the PR (no duplicate). Codex [P1] fix.
    // A FIX ROUND IS THE SAME PHASE AS THE BUILD, so it takes the same executor. Routing
    // only round 1 to codex would mean the owner's choice applied to the first attempt
    // and silently not to the revisions — the same asymmetry the retry lanes exist to
    // avoid on the review side.
    const fixBrief = `${forgeBuildContract(true)}

You are FIXING Argus's findings on the EXISTING branch ${forgeBranch} (round ${round}). ${isPr ? `Do NOT open a new PR — push the SAME branch (\`gh pr list --head ${forgeBranch}\` to confirm it exists).` : `Commit on the SAME local branch ${forgeBranch} — no remote, no PR.`} Address every BLOCKER + important finding, run tests until green, commit${isPr ? ' + push' : ' locally'}, and re-write the diff file.
ARGUS FINDINGS (round ${round - 1}):
${JSON.stringify(synthesis.findings)}

TASK:
${task}${reflectionGuidance}`
    const fix = await agent(
      buildRunsOnCli(`forge:fix-round-${round}`, complexityTag)
        ? codexBuildBridgePrompt(fixBrief, complexityTag)
        : fixBrief,
      withModel(
        { label: `forge:fix-round-${round}`, phase: 'Build', isolation: 'worktree', schema: FORGE_SCHEMA },
        complexityTag,
      ),
    )
    await checkpoint(`fix-round-${round}`, { pr })
    // DID IT LAND? A fix round runs in a throwaway worktree, so edits that were
    // never committed+pushed are already gone — and reviewing again would
    // re-report the previous round's findings against unchanged code. Stop
    // instead, and say which round lost its work.
    const headAfter = await readBranchHead(round)
    if (!roundLanded(branchHead, headAfter)) {
      log(`trident-v2 fix loop: round=${round} DID NOT LAND (head still ${headAfter || 'unreadable'}) — stopping`)
      roundLostItsWork = { round, head: headAfter || branchHead }
      finalVerdict = 'REQUEST_CHANGES'
      break
    }
    branchHead = headAfter
    // …and the commit THIS round's review judges is, exactly as in round 1, the
    // one the fix agent reported committing — NOT `headAfter` (#545). The remote
    // probe above answers a different question ("did the branch move?"), and a
    // third party's push satisfies it just as well as the fix agent's own commit;
    // recording that push as `reviewedHead` would pin the merge to code the
    // upcoming review never sees. Empty → fail-closed, same as round 1.
    reviewedHead = typeof fix?.commitSha === 'string' ? fix.commitSha.trim() : ''
    synthesis = synthesisOrInfraBlock(await reviewAndSynthesize(diffFile, round, pr))
    finalVerdict = normalizeVerdict(synthesis.verdict)
    await checkpoint(finalVerdict === 'APPROVE' ? 'argus-approved' : 'argus-request-changes', { pr })
  }

  log(`trident-v2 inner DONE: verdict=${finalVerdict} round=${round} pr=${pr}`)
  // The inner workflow RETURNS {PR#, verdict}; the OUTER/human layer does the
  // irreversible merge (merge.ts stays outer — defense in depth). In the Phase-2a
  // EXEC model the launching turn has already settled, so the return value is NOT
  // captured by any process — the OUTER loop harvests `inner_result` from the DB.
  // Persist the TYPED terminal result HERE (the harvest-ready signal) BEFORE
  // returning. This top-level `return` is the Workflow runtime's result API (it
  // wraps the body in an async context). `node --check` flags it as an illegal
  // top-level return — EXPECTED.
  const terminalResult = {
    ok: true,
    prNumber: pr,
    branch: forgeBranch,
    verdict: finalVerdict,
    round,
    checkpoint: finalVerdict === 'APPROVE' ? 'argus-approved' : 'argus-request-changes',
    // THE REVIEWED COMMIT (#545) — the OUTER merge pins to exactly this OID
    // (`gh pr merge --match-head-commit`), so anything pushed after the review
    // makes the merge fail loudly rather than ship unreviewed. Empty means the
    // probe read nothing: the outer loop then REFUSES to merge (fail-closed).
    reviewedHead,
    // 0 here (the FINAL Ralph task, or a non-Ralph run) → the outer loop does NOT
    // re-fire; it runs the normal merge (APPROVE) / fail (REQUEST_CHANGES) path.
    remainingTasks: ralphRemaining,
    // WHY it is blocked, surfaced to the operator and the outer loop. 'infra-only'
    // means the CODE WAS NEVER JUDGED — a lane could not run, so this verdict says
    // nothing about the diff. Reporting that as an ordinary REQUEST_CHANGES is what
    // made 2026-08-08's summaries misleading: three runs read as code rejections
    // when at least two were lane failures.
    // A round whose work never reached the branch is its OWN kind of block, and
    // it must not read as a code rejection: the code was not re-judged at all.
    blockKind:
      roundLostItsWork !== null
        ? 'round-lost'
        : finalVerdict === 'APPROVE'
          ? 'none'
          : synthesis.blockKind || 'code',
    // Present ONLY when a fix round left no trace on the branch, so the operator
    // is told which round to recover rather than being handed stale findings.
    ...(roundLostItsWork !== null
      ? { findings: [roundDidNotLandFinding(roundLostItsWork.round, roundLostItsWork.head)] }
      : {}),
  }
  await writeTerminalResult(terminalResult)
  return terminalResult
} catch (err) {
  // EXEC-MODEL FAILURE HARVEST (Codex review [P2]). A thrown workflow (Forge
  // returns null, an Argus agent errors, a checkpoint Bash step fails, …) has NO
  // process/stdout left to report failure — the OUTER loop harvests `inner_result`
  // from the DB. Without a terminal write here, a crashed build would sit
  // `running` until the 2 h stall guard instead of failing PROMPTLY. So persist a
  // terminal FAILURE result (verdict REQUEST_CHANGES → the harvest fails the run
  // on the next tick). Best-effort: if THIS write also throws, the stall guard is
  // the backstop. The `finally` cleanup still runs. We RETURN the failure object
  // (the detached workflow's result API) rather than re-throwing, so the result is
  // a clean terminal value, not an error.
  log(`trident-v2 inner THREW: ${err && err.message ? err.message : String(err)}`)
  const failureResult = {
    ok: false,
    prNumber: pr,
    branch: forgeBranch,
    verdict: 'REQUEST_CHANGES',
    round,
    checkpoint: 'inner-error',
    // A THROWN iteration NEVER re-fires (a failure is a failure — recoverable via a
    // fresh /code run, same as before #362). 0 keeps the outer off the re-fire path.
    remainingTasks: 0,
  }
  try {
    await writeTerminalResult(failureResult)
  } catch (e2) {
    log(`trident-v2 terminal-failure write ALSO failed (stall guard is the backstop): ${e2 && e2.message ? e2.message : String(e2)}`)
  }
  return failureResult
} finally {
  // (A) WORKTREE CLEANUP — runs on success, REQUEST_CHANGES, throw, or abort.
  // The harness removes a worktree ONLY IF UNCHANGED, and a Forge build always
  // changes its worktree, so trident MUST clean it up explicitly.
  //
  // CRITICAL: cleanup CANNOT depend on a valid `forge` result. If Forge mutated
  // its worktree then FAILED before returning JSON (tests fail, `gh pr create`
  // fails, the agent throws → agent() returns null), the changed worktree still
  // exists. So we clean up by SCANNING git state for ANY worktree on the
  // DETERMINISTIC '${forgeBranch}' branch — independent of Forge's return value.
  //
  // A DIRTY WORKTREE IS PRESERVED, NOT DESTROYED (ISSUES #541). This block used
  // to be a cheap-model agent told to "ignore individual command failures" while
  // running `git worktree remove --force` + `git branch -D` — and it fires on
  // THROW and ABORT, i.e. exactly when Forge died mid-edit and the worktree holds
  // the only copy of the work. On PR #171 it destroyed 197 insertions across 7
  // files. The whole decision now lives in the checked-in, deterministic
  // `trident/worktree-cleanup.sh`: dirty (INCLUDING untracked) or unverifiable →
  // preserve + exit 3; clean → plain `git worktree remove`, never `--force`.
  // There is no LLM judgement left in the destructive path — the agent runs ONE
  // fixed command and reports its output, the same shape as the head/CI probes.
  //
  // BRANCH TEARDOWN IS MODE-AWARE and is passed to the script as a flag: in LOCAL
  // mode the branch holds the ONLY copy of the un-merged commits and the OUTER
  // loop's `mergeLocal` (merge.ts) merges that exact branch THEN deletes it
  // post-merge — deleting it here stranded every local-mode merge ("not something
  // we can merge"). In PR mode the local branch is disposable ONLY once the
  // script has proved origin holds the same sha (see the script's branch gate).
  const cleanupMode = isPr ? 'delete-branch' : 'keep-branch'
  const cleanupCmd = `bash ${shSingleQuote(worktreeCleanupSh)} ${shSingleQuote(repoPath)} ${shSingleQuote(forgeBranch)} ${cleanupMode} 2>&1; echo "___EXIT=$?"`
  const cleanup = await agent(
    `Run EXACTLY this single Bash command and report its output through the schema. Put the FULL stdout+stderr in \`raw\` VERBATIM, and the number after ___EXIT= in \`exit_code\`. Do NOT interpret the result, do NOT run any other command, do NOT remove or modify any worktree, branch or file yourself, and do NOT re-run or "fix" a non-zero exit — exit 3 means the script PRESERVED work ON PURPOSE.
${cleanupCmd}`,
    withModel({ label: 'cleanup:worktree', phase: 'Synthesis', schema: CLEANUP_SCHEMA }),
  )
  // Surface the outcome in the run log — a preservation is the operator's ONLY
  // notice that a worktree still holds uncommitted work, so it is logged in full.
  const cleanupRaw = cleanup && typeof cleanup.raw === 'string' ? cleanup.raw.trim() : ''
  // See `classifyCleanupOutcome` for why the agent's answer is read from two
  // sources and why every ambiguity resolves toward the alarm.
  const { exit: cleanupExit, outcome: cleanupOutcome } = classifyCleanupOutcome(
    cleanup == null ? null : cleanup.exit_code,
    cleanupRaw,
  )
  if (cleanupOutcome === 'ok') {
    log(`trident-v2 cleanup:worktree ok — ${cleanupRaw.split('\n').pop() || 'no output'}`)
  } else if (cleanupOutcome === 'preserved') {
    log(`trident-v2 cleanup:worktree PRESERVED WORK (exit=3) — nothing was force-removed:\n${cleanupRaw}`)
  } else if (cleanupOutcome === 'preserved-unmarked') {
    log(
      `trident-v2 cleanup:worktree PRESERVED WORK (exit code ${cleanupExit === null ? 'unreported' : `mis-reported as ${cleanupExit}`} — read from the output instead) — nothing was force-removed:\n${cleanupRaw}`,
    )
  } else {
    log(`trident-v2 cleanup:worktree FAILED (exit=${cleanupExit === null ? 'unknown' : cleanupExit}) — the cleanup script did not run to completion, so NOTHING was inspected or removed (this is not a preservation):\n${cleanupRaw}`)
  }
}
