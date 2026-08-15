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
  // THE DURABLE RE-FIRE COUNTER (`code_trident_runs.ralph_round`), threaded by the
  // launcher (`buildWorkflowArgs`). It is 0 on the FIRST iteration of a Ralph card
  // and bumped by one per re-fire (`refireNextRalphTask`), so it is the only input
  // that can tell a continuation apart from the run that started the card.
  //
  // NULL (a legacy caller, or a dry source check that supplies no args) → the FULL
  // planner always runs. Fail-safe by construction: the cheap continuation planner
  // is an optimisation, and an optimisation that cannot prove it applies must not
  // apply.
  ralphRound = null,
  // Git-mode threaded from the run (`local` | `pr`). Defaults to `pr` for any
  // legacy caller that doesn't thread it; the launcher always sets it.
  mergeMode = 'pr',
  prNumber = null,
  branch = null,
  dbPath,
  runId,
  resumeCheckpoint = null,
  // MID-LOOP RESUME — the branch head OID the resumed checkpoint was RECORDED
  // AGAINST (`code_trident_runs.inner_checkpoint_head`, written in the same
  // UPDATE as the checkpoint name), threaded by the launcher. This is the ONLY
  // input that can unlock a resume fast path, and the ONLY source `reviewedHead`
  // may ever be set from on a resume — see `classifyResume`. Null/absent (a
  // checkpoint written before the OID was recorded, or a launcher that does not
  // thread it) → the prior work is treated as being about DIFFERENT code and the
  // run rebuilds + re-reviews, exactly as it did before this existed.
  resumeCheckpointHead = null,
  // MID-LOOP RESUME — the LIVE head of `branch`, READ IN CODE by the launcher at fire
  // time (`resolveResumeLiveHead` in orchestrator.ts) at the credentialed host
  // boundary, rather than reported by a probe AGENT. Tri-state, and the three values
  // are NOT interchangeable:
  //   - a full 40-hex OID → the authority's answer for the branch head.
  //   - 'absent'          → the authority answered SUCCESSFULLY that the branch does
  //                         not exist; the recorded work is gone from it → rebuild.
  //   - ''                → the launcher tried and COULD NOT READ it. Exclusively
  //                         "could not tell", never "not there".
  // Null/absent (an OLD LAUNCHER, or not a resume with a recorded head) → fall back to
  // the `head-probe-round-resume` agent seat, exactly as this ran before.
  resumeLiveHead = null,
  // MID-LOOP RESUME — the synthesised findings the resumed `argus-request-changes`
  // checkpoint was recorded with (`code_trident_runs.inner_checkpoint_findings`,
  // already decoded to an array by the launcher). They are what a resumed fix
  // round fixes; absent/empty → the run re-reviews instead of sending Forge in
  // with nothing to act on. NEVER read for any other checkpoint.
  resumeFindings = null,
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
  // CREDENTIALED-`gh` RUNNER (2026-08-14 card). Same threading contract as
  // `checkpointScript`: a checked-in script this file cannot resolve the path of,
  // so the launcher (`buildWorkflowArgs`) threads the absolute one — plus the
  // `SecretsStore` coordinates it resolves the instance GitHub token from and the
  // absolute bun binary that runs it (a subagent's Bash PATH need not have `bun`).
  //
  // PATHS AND A HANDLE, NEVER A TOKEN. These args are serialised into the fire
  // launcher's PROMPT; the secret is read by `gh-authed.ts` in its own process, on
  // each command, and lives only in the `gh` child's environment.
  //
  // ANY of them absent → `ghReadCommand` returns a bare `gh …`, byte-identical to
  // what this workflow composed before the runner existed (local mode, a legacy
  // caller, a dry source check).
  ghAuthedScript = null,
  ghDataDir = null,
  ghOwnerHandle = null,
  bunBin = null,
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
  // The launcher's fire-time by-path manifest (trident/brief-parts.ts
  // `writeBriefParts`) — {taskFile, taskIntegrity, reflectionFile,
  // reflectionIntegrity}; absent/malformed → the fully-chunked transport,
  // byte-identical to before this arg existed (defect 2026-08-13 run 000cedc8).
  briefParts = null,
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
    return {
      model_id: entry.model_id,
      transport: entry.transport === 'cli' ? 'cli' : 'agent',
      env_var: typeof entry.env_var === 'string' && entry.env_var ? entry.env_var : null,
      // The EXECUTOR (`claude` / `codex` / `kimi`), threaded from the registry. A
      // legacy caller that sends no group is treated as `claude`, which is what the
      // MODELS fallback below is.
      group: typeof entry.group === 'string' && entry.group ? entry.group : 'claude',
    }
  }
  if (Object.prototype.hasOwnProperty.call(MODELS, name)) {
    return { model_id: MODELS[name], transport: 'agent', env_var: null, group: 'claude' }
  }
  return null
}

// A CLI-transport route: the model is not handed to agent(), it is handed to the
// WRAPPER through its env knob. `model: null` (no registry threaded) means "invoke the
// wrapper with no override", which is the wrapper's own pinned default.
const cliRoute = ({ tier, phaseKey, group }) => {
  const resolved = resolveTier(tier)
  return {
    model: resolved !== null && resolved.transport === 'cli' ? resolved.model_id : null,
    effort: null,
    transport: 'cli',
    envVar: resolved !== null ? resolved.env_var : null,
    group,
    phaseKey,
  }
}

// ── THE BUILD'S SECOND EXECUTOR ──────────────────────────────────────────────
// The build is the only phase with two wired dispatches, and this is the one the
// owner reaches by pinning the build to a GPT tier: instead of `agent({model})` the
// assembled brief goes to `trident/codex-build.sh`, which runs `codex exec` and
// measures back the branch/sha/PR the inner loop needs (see `codexBuildPrompt`).
//
// A DIFFERENT ENV KNOB FROM THE REVIEWER'S. The registry names `CODEX_REVIEW_MODEL`
// because that is the knob the REVIEW wrapper reads; the build wrapper reads
// `CODEX_BUILD_MODEL`. One name for both would mean that on a box exporting it for a
// direct review invocation, every codex build silently took the reviewer's model —
// and the reverse. The two wrappers are two consumers, so they get two knobs.
const CODEX_BUILD_MODEL_ENV = 'CODEX_BUILD_MODEL'
const codexBuildRoute = (route, modelId) => ({
  ...route,
  model: modelId,
  // A CLI chooses its own reasoning effort and the wrapper exposes no knob for it, so
  // carrying the Claude route's effort forward would log a number nothing reads. The
  // typed boundary refuses to STORE the pair for the same reason.
  effort: null,
  transport: 'cli',
  group: 'codex',
  envVar: CODEX_BUILD_MODEL_ENV,
})

const codexReviewRoute = (route, modelId) => ({
  ...route,
  model: modelId,
  effort: null,
  transport: 'cli',
  group: 'codex',
  envVar: 'CODEX_REVIEW_MODEL',
})

const kimiReviewRoute = (route, modelId) => ({
  ...route,
  model: modelId,
  effort: null,
  transport: 'cli',
  group: 'kimi',
  envVar: 'KIMI_MODEL',
})

// ── A CLI SEAT MOVED ONTO CLAUDE ─────────────────────────────────────────────
// The owner assigned a Claude tier to a cross-model review seat (the case the whole
// point of a "put any model in any slot" pane): with the BUILD on GPT, Opus on a
// review seat is the cross-family panel, not a violation of it. The route stops being
// a subprocess launcher and becomes an ordinary `agent({model})` dispatch, so it
// carries an EFFORT again and NO env knob — a leftover `envVar` here would put a
// Claude id on a wrapper's command line.
//
// THIS IS NOT THE BANNED FALLBACK. `trident/kimi-review.ts` forbids a seat quietly
// becoming a Claude reviewer when its CLI is unavailable; nothing here is reached by a
// failure — only by the owner's stored choice, which is logged, panel-labelled and
// recorded in the verdict.
//
// The effort is the owner's when a config carries one and the phase's stated default
// otherwise: these two rows have no live effort cell (their DEFAULT executor is a CLI,
// which is what `phaseSupportsEffort` answers), so the common path is the default.
const claudeReviewRoute = (route, modelId, effort) => ({
  ...route,
  model: modelId,
  effort,
  transport: 'agent',
  group: 'claude',
  envVar: null,
})

// forge:* routes BY the planner's complexity tag: '[mechanical]' (boilerplate,
// tests, a single-file edit) → cheap Sonnet executor; '[reasoning]' / missing /
// ambiguous → Opus (bias to Opus — Argus + Codex are the backstop).
//
// `dispatchGroups` mirrors the phase table (`trident/phase-models.ts`): every group this
// route can use under an owner override. Both build phases carry
// it because they are the same dispatch under two complexity tags — but carrying it
// only makes the move POSSIBLE for each key independently, and the owner sets one.
// What actually keeps a `[mechanical]` task off Claude when the build moves to codex
// is `phaseOverrideFor` below, which reads `build`'s setting for `build_mechanical`.
// Do not remove one and keep the other.
const modelForTag = (tag) =>
  tag === 'mechanical'
    ? { model: MODELS.sonnet, effort: 'medium', phaseKey: 'build_mechanical', group: 'claude', dispatchGroups: ['claude', 'codex'] }
    : { model: MODELS.opus, effort: 'high', phaseKey: 'build', group: 'claude', dispatchGroups: ['claude', 'codex'] }

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
const ROLE_MODEL = {
  'plan:fable': { model: MODELS.fable, effort: 'max', phaseKey: 'decomposition', dispatchGroups: ['claude'] },
  // THE CONTINUATION PLANNER IS THE SAME SEAT ON THE SAME TIER, deliberately. What
  // `plan:next` removes is the whole-repo SURVEY, not the thinking: it still picks
  // the next task and writes the execution spec a cheaper executor follows without
  // re-reasoning the design. Routing it below `plan:fable` would make the two
  // iterations of one card plan at different qualities, which is a harder failure
  // to see than a slow build.
  'plan:next': { model: MODELS.fable, effort: 'max', phaseKey: 'decomposition', dispatchGroups: ['claude'] },
  'argus:claude': { model: MODELS.opus, effort: 'high', phaseKey: 'review_rubric', dispatchGroups: ['none', 'claude'] },
  'argus:adversarial': { model: MODELS.opus, effort: 'high', phaseKey: 'review_adversarial', group: 'claude', dispatchGroups: ['none', 'claude', 'codex'], codexWrapper: 'review' },
  'argus:synthesis': { model: MODELS.fable, effort: 'high', phaseKey: 'synthesis', dispatchGroups: ['claude'] },
  // THE TWO CROSS-MODEL LANES ARE ROUTED NOW. They used to be listed as deliberately
  // unconfigurable ("the reviewing model is the CLI's own configuration"), which was
  // true only while nothing threaded a model IN. Both wrappers read an env knob, so
  // the owner picks a tier and the resolved id reaches the subprocess — the model is
  // NOT handed to agent() (that resolves against Claude Code's endpoint and cannot
  // reach a GPT/Kimi model; see the `modelTiers` arg). The thin Claude agent wrapping
  // each still runs on the launcher default WHILE THE SEAT IS ON A CLI TIER: its whole
  // job there is to run one command and map an exit code.
  //
  // …AND A CLAUDE TIER IS ONE OF THE CHOICES. `claude` is in `dispatchGroups` because
  // the dispatch exists: the seat then reviews with a real reviewer prompt on the
  // CHOSEN tier through `agent({model})` (see `claudePeerPrompt` / the panel below),
  // rather than shelling out. That is the owner ASSIGNING a family to a seat, which is
  // a different thing from the banned SILENT fallback to Claude when a CLI fails — the
  // seats never substitute for one another (`routeAvailable`), they only run what was
  // chosen. The list must match `trident/phase-models.ts`; both are walked by
  // `__tests__/cross-model-dispatch.test.ts`.
  'argus:codex': { ...cliRoute({ tier: 'sol', phaseKey: 'review_codex', group: 'codex' }), dispatchGroups: ['none', 'claude', 'codex', 'kimi'] },
  'argus:kimi': { ...cliRoute({ tier: 'k3', phaseKey: 'review_kimi', group: 'kimi' }), dispatchGroups: ['none', 'claude', 'codex', 'kimi'] },
  'checkpoint': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping', dispatchGroups: ['claude'] },
  'terminal-result': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping', dispatchGroups: ['claude'] },
  'cleanup:worktree': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping', dispatchGroups: ['claude'] },
  // HEAD-PROBE WAS MISSING FROM THIS TABLE and therefore fell through to the Opus
  // default at HIGH effort — for a step whose entire job is to run one `git`
  // command and report the sha it printed, interpreting nothing. It had been that
  // way since the step was added, and nothing could have caught it: a missing
  // entry and a deliberate entry are indistinguishable when the fallback is
  // silent. That is the argument for the coverage test, not just for this line.
  'head-probe': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping', dispatchGroups: ['claude'] },
  // The CI probe is the same shape as the head probe: run one command, report the
  // output verbatim, interpret nothing. Routed explicitly rather than left to the
  // fallback, which is how head-probe silently sat on the most expensive tier.
  'ci-probe': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping', dispatchGroups: ['claude'] },
  // The merge probe (#563) is the third of the same shape. It runs once per round,
  // so a fallback to the most expensive tier would be a per-round tax on the step
  // that exists to REMOVE a per-lane tax.
  'merge-probe': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping', dispatchGroups: ['claude'] },
  // The plan probe is the fourth of the same shape: two fixed git commands, a file
  // body and a `grep -c` count back, interpreting nothing (the plan:fable-vs-plan:next
  // selection is made in CODE from those fields). Routed explicitly for the reason
  // head-probe's comment above gives — the silent fallback is the most expensive tier.
  'plan:probe': { model: MODELS.fast, effort: 'low', phaseKey: 'bookkeeping', dispatchGroups: ['claude'] },
}

// Generic seats use the canonical rubric review effort when moved onto Claude;
// deriving it keeps their default aligned with the existing Claude reviewer.
const claudeSeatEffort = () => ROLE_MODEL['argus:claude'].effort

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

// THE BUILD IS ONE STEP WITH TWO COMPLEXITY TAGS, AND THE OWNER SEES ONE ROW.
// `modelForTag` splits the dispatch into `build` and `build_mechanical` by the
// planner's `[mechanical]` tag — an internal cost optimisation, not a setting. The
// pane offers "Build" once, which writes `build`. Without this, every Ralph task the
// planner happens to tag `[mechanical]` kept dispatching on Claude after the owner
// moved the build to codex, and the log line would say so in a phase name the owner
// has never seen.
//
// UNCONDITIONAL: an entry that NAMES the follower key does not win, it is ignored.
// `build_mechanical` is not settable at the boundary (`parsePhaseModelConfig` rejects
// it and the read path drops one stored before that rule existed), so a value arriving
// here can only be a stale or hand-crafted blob — and honouring it would pin the
// mechanical build to a model the pane cannot display and the owner cannot clear,
// which is exactly the invisible Anthropic spend this mirroring exists to stop.
// `trident/__tests__/phase-model-coverage.test.ts` holds the two halves together.
const phaseOverrideFor = (phaseKey) =>
  phaseKey === 'build_mechanical' ? threadedPhaseModels['build'] : threadedPhaseModels[phaseKey]

function applyPhaseOverride(route, phaseKey) {
  if (!phaseKey) return route
  const override = phaseOverrideFor(phaseKey)
  if (!override || typeof override !== 'object' || Array.isArray(override)) return route
  let { model, effort } = route
  const transport = route.transport === 'cli' ? 'cli' : 'agent'
  // The executor this route runs on, and the ones it can be MOVED to. Compared by
  // GROUP rather than by transport+env_var: that pair was a proxy for "the same
  // executor", and it stopped being one the moment a phase had two.
  const group = typeof route.group === 'string' ? route.group : 'claude'
  const dispatchGroups = Array.isArray(route.dispatchGroups) ? route.dispatchGroups : [group]
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
    } else if (tier.group === 'none' && dispatchGroups.includes('none')) {
      return { ...route, disabled: true, model: null, effort: null }
    } else if (tier.group !== group && dispatchGroups.includes(tier.group)) {
      // THE STEP MOVES TO ANOTHER EXECUTOR. The whole route changes, not just the
      // id: the dispatch stops being an `agent()` call and becomes the codex build
      // wrapper, which is the difference between "the build runs on GPT" and "we
      // asked Claude Code's endpoint for a GPT id".
      //
      // The line NAMES THE EXECUTOR IT MOVED TO. It used to say `executor=codex`
      // unconditionally, which was already wrong for a seat moved to Kimi and would
      // read as an outright lie for one moved to Claude.
      log(
        `trident.phase-override phase=${phaseKey} executor=${tier.group} tier=${requested} model=${tier.model_id}`,
      )
      if (tier.group === 'claude') {
        // …AND THE OTHER DIRECTION: a CLI seat moved onto a Claude tier. The effort is
        // live again on this route, so it is honoured rather than logged away — the
        // reverse of the codex case below (see `claudeReviewRoute`).
        if (override.effort !== undefined && !(typeof override.effort === 'string' && VALID_EFFORTS.includes(override.effort))) {
          log(`trident.phase-override IGNORED phase=${phaseKey} reason=effort-not-in(${VALID_EFFORTS.join('|')})`)
        }
        return claudeReviewRoute(
          route,
          tier.model_id,
          typeof override.effort === 'string' && VALID_EFFORTS.includes(override.effort)
            ? override.effort
            : claudeSeatEffort(),
        )
      }
      if (override.effort !== undefined) {
        // The step HAD an effort control while it ran on Claude; on the codex
        // executor it does not. Said out loud rather than dropped, because a stored
        // setting that quietly stopped mattering is one the owner keeps believing
        // in. (The typed boundary refuses to STORE this pair — this is the backstop
        // for a config written before it did.)
        log(
          `trident.phase-override IGNORED phase=${phaseKey} reason=effort-not-settable-on-cli-transport`,
        )
      }
      return tier.group === 'kimi'
        ? kimiReviewRoute(route, tier.model_id)
        : route.codexWrapper === 'review' || route.phaseKey?.startsWith('review_')
          ? codexReviewRoute(route, tier.model_id)
          : codexBuildRoute(route, tier.model_id)
    } else if (tier.group !== group) {
      // The executor is a capability, not a preference: a GPT tier cannot run a
      // Claude agent step that has no codex dispatch, and the codex review wrapper
      // cannot be pointed at a Kimi model.
      log(
        `trident.phase-override IGNORED phase=${phaseKey} reason=executor-mismatch tier=${requested} tier-executor=${tier.group} phase-executor=${group}`,
      )
    } else if (tier.transport !== transport) {
      // Same executor, different transport — nothing in the registry produces this
      // today, and a route that cannot say HOW it reaches a model must not dispatch
      // it. Kept as a backstop rather than an assumption.
      log(
        `trident.phase-override IGNORED phase=${phaseKey} reason=transport-mismatch tier=${requested} tier-transport=${tier.transport} phase-transport=${transport}`,
      )
    } else {
      model = tier.model_id
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
  return { ...route, model, effort }
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
          : label.startsWith('merge-probe-round-')
            ? ROLE_MODEL['merge-probe']
          // A retry lane is the SAME lane. Routing it separately (or letting it fall
          // through to the default) would mean the owner's choice applied to the
          // first attempt and silently not to the second.
          : label === 'argus:codex-retry'
            ? ROLE_MODEL['argus:codex']
          : label === 'argus:kimi-retry'
            ? ROLE_MODEL['argus:kimi']
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
  const overridden = route.phaseKey !== null && phaseOverrideFor(route.phaseKey) !== undefined
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
  const overridden = route.phaseKey !== null && phaseOverrideFor(route.phaseKey) !== undefined
  log(
    `trident.agent label=${label} model=${route.model || fallback} effort=${route.transport === 'cli' ? 'n/a' : route.effort} transport=${route.transport} phase=${route.phaseKey ?? 'unrouted'}${overridden ? ' override=owner' : ''}`,
  )
}

// RESOLVED ONCE PER RUN, not per prompt build. Two reasons beyond the obvious: the
// value cannot change mid-run (the owner's config is threaded in at launch), and a
// prompt builder that reached for it as a free function could no longer be lifted out
// of this file and executed on its own — which is exactly how the codex bridge's
// truncation-readback test proves the SHIPPED command, rather than a retyped copy of
// it (`inner-workflow.test.ts`). A closure value it can pass in keeps that possible.
const ADVERSARIAL_CODEX_ENV_PREFIX = crossModelEnvPrefix('argus:adversarial')

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

// The codex reviewer's verdict carries an extra `codexStatus` so the synthesis
// can distinguish a real cross-model verdict ('connected') from the graceful
// never-set-up path ('not_connected') and the never-silent-downgrade path
// ('deferred' — configured but the codex call failed/timed out), plus
// `codexTruncated` so a verdict formed from PART of the diff can never be
// recorded as one about the whole change.
const CODEX_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'codexStatus', 'codexTruncated'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
    findings: VERDICT_SCHEMA.properties.findings,
    codexStatus: { type: 'string', enum: ['connected', 'not_connected', 'deferred'] },
    codexTruncated: {
      type: 'boolean',
      description:
        'true when the wrapper capped the diff (CODEX_TRUNCATED=1) — codex saw only its first N lines, so its verdict covers only that portion.',
    },
  },
}

// Same shape as the codex peer's, with its own status field so the two can never
// be confused for one another (see the positional-indexing note in the panel).
const KIMI_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'kimiStatus'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
    findings: VERDICT_SCHEMA.properties.findings,
    kimiStatus: { type: 'string', enum: ['connected', 'not_connected', 'deferred'] },
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
    // OPTIONAL — deliberately NOT in `required`. Forge reports true only when it
    // MATERIALLY deviated from the Ralph exec spec, which makes the plan the
    // previous iteration committed a document that no longer describes reality:
    // the next iteration must then pay for the full survey instead of taking the
    // cheap `plan:next` continuation. Absent/null decodes as false everywhere, so
    // an executor that never mentions it keeps today's behaviour exactly.
    deviatedFromSpec: { type: ['boolean', 'null'] },
  },
}

// The SAME six fields, plus whether the codex executor actually ran. The inner loop
// downstream cannot tell "the build ran and produced nothing" from "the build never
// happened" out of the six alone, and those need opposite handling: the first is what
// `roundLanded` and the empty-`reviewedHead` merge refusal are for, the second is a
// lane failure that must stop the run and say so rather than send a panel to review an
// unbuilt branch.
const CODEX_FORGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...FORGE_SCHEMA.required, 'codexStatus', 'trailerComplete', 'wrapperExitCode', 'preservedWork'],
  properties: {
    // `deviatedFromSpec` RIDES ALONG IN THE SPREAD BUT IS INERT ON THIS ROUTE, and
    // that is deliberate rather than an oversight. The agent filling THIS schema is
    // the codex BRIDGE — it launches a subprocess and copies the wrapper's measured
    // trailer; it never sees the build's own reasoning, so it has no honest way to
    // say whether the build deviated from its exec spec, and `codexBuildPrompt`
    // correctly never asks it to. The field therefore stays absent here, which
    // decodes as false: a deviated codex build writes the clean 'ralph-task-built'
    // checkpoint and the NEXT iteration takes the cheap `plan:next`. That is the
    // fail-toward-not-deviated direction on purpose — the periodic full re-plan
    // (`PLAN_REFRESH_EVERY`) is what bounds the drift on this route. Carrying the
    // signal out of a codex build needs a seventh trailer line from the wrapper,
    // which is a change to `trident/codex-build.sh` and its own card.
    ...FORGE_SCHEMA.properties,
    codexStatus: { type: 'string', enum: ['connected', 'not_connected', 'deferred'] },
    trailerComplete: { type: 'boolean' },
    wrapperExitCode: { type: ['number', 'null'] },
    preservedWork: { type: 'boolean' },
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

// HOW OFTEN A CONTINUATION ITERATION STILL PAYS FOR THE FULL RE-DERIVATION.
//
// RE-PLANNING IS NOT PURE WASTE — building task N can legitimately change what
// task N+1 should be. That is why the full `plan:fable` re-derivation still runs
// at iteration 1, on ANY genuine crash-resume, and every PLAN_REFRESH_EVERY'th
// round, so the committed plan cannot drift arbitrarily far from the code it is
// supposed to describe. The claim this constant encodes is NOT "planning is
// unnecessary"; it is "re-deriving the whole checklist from the whole codebase,
// every single task, is the wrong default".
//
// DO NOT REMOVE THE PERIODIC FULL RE-PLAN TO MAKE THE NUMBERS LOOK BETTER.
const PLAN_REFRESH_EVERY = 5

// The one thing the cheap plan probe reports: whether the branch carries a
// committed IMPLEMENTATION_PLAN.md, how many '- [ ]' tasks are still unchecked in
// it, and its VERBATIM body (which `plan:next` returns unchanged as
// `implementationPlan`, so `ralphExecuteNote` keeps working untouched).
//
// `planLines` IS THE TRUNCATION GUARD, and it is why the seat can stay on the
// cheapest tier. This probe is asked to relay an arbitrarily long file byte for
// byte, and its body is what the workflow then treats as the authority for what
// the branch actually committed — so "the model quietly stopped copying" must be
// DETECTABLE, not assumed away. `wc -l` measures the file itself in the same
// pipeline that produced the body; the workflow compares that number against the
// relayed body's own newline count (`checkProbeBody`) and refuses the cheap path
// on any disagreement. A measurement beats a tier.
const PLAN_PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['planFound', 'uncheckedCount', 'planBody'],
  properties: {
    planFound: { type: 'boolean' },
    uncheckedCount: { type: 'number' },
    planBody: { type: 'string' },
    planLines: { type: ['number', 'null'] },
  },
}

// Does the relayed plan body still have every line the probe MEASURED?
//
// `wc -l` counts NEWLINES, and an agent relaying a file's content routinely drops
// (or keeps) the trailing one, so the honest expectation is a two-value window,
// not an equality: for a body of `n` split('\n') pieces, a faithful relay reports
// `n` (trailing newline kept, or the file has none) or `n - 1` (trailing newline
// dropped). Anything below that window means lines went missing between `git show`
// and the schema — the exact failure that would otherwise be COMMITTED back over
// IMPLEMENTATION_PLAN.md. A probe that reported no count at all (older shape,
// absent/null) is not evidence of truncation, so it passes: this guard exists to
// catch a measured contradiction, not to invent one.
function probeBodyIntact(probe) {
  if (probe === null || typeof probe.planBody !== 'string') return false
  const lines = probe.planLines
  if (lines === null || lines === undefined) return true
  if (!Number.isFinite(lines)) return false
  const pieces = probe.planBody.split('\n').length
  return Math.trunc(lines) === pieces || Math.trunc(lines) === pieces - 1
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
    ? `Commit on ${forgeBranch} and stop. Do NOT push and do NOT run \`gh\`; the durable outer loop publishes and confirms the commit before review.`
    : `Commit on ${forgeBranch}. This repo has NO GitHub remote — do NOT push or run \`gh pr create\`; the OUTER loop merges the local branch.`
}
const FORGE_PR_LINE = isPr ? 'PR_NUMBER=0   (the outer loop publishes after this build exits)' : 'PR_NUMBER=0   (local mode — no GitHub PR)'

// `reenter` = the branch/PR already exist (crash-resume or a fix round > 1).
function forgeBuildContract(reenter) {
  return `You are FORGE — Neutron's autonomous build sub-agent. You build, test, and commit without blocking on human input. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}

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

// ── THE BUILD, ON THE CODEX EXECUTOR ─────────────────────────────────────────
// Everything below is the second dispatch for `forge:build` / `forge:fix-round-*`.
// It is reached only when the owner has pinned the build phase to a GPT tier; an
// install that never opens the settings pane goes down the Claude path above,
// byte-identically.

/** The deterministic diff path a codex build writes, so the wrapper can verify it. */
const codexBuildDiffFile = () => `/tmp/trident-codex-build-${runId || slug}.diff`

/**
 * `<bytes>:<fnv32>` for a string, as `trident/codex-build.sh` recomputes it from the
 * brief file before it spends a token.
 *
 * WHY THE BRIEF NEEDS A RECEIPT AT ALL. This script cannot exec anything; it reaches a
 * shell only through a bridge agent that has to reproduce the whole brief inside a
 * heredoc. A model that truncates or paraphrases it hands codex a contract nobody
 * wrote, and every check after that point asks about the REPOSITORY — a real commit,
 * a real diff, a real PR, for the wrong task. The receipt is the only place the text
 * itself can be checked.
 *
 * FNV-1a/32 OVER THE UTF-8 BYTES, hand-rolled, and both halves of that are forced:
 * this file runs with no imports and no host API it is promised (see the header), so
 * the digest must come out of language builtins alone. `Math.imul` is the 32-bit
 * multiply the checksum needs (a plain `*` loses the low bits past 2**53).
 *
 * THE UTF-8 ENCODER IS WRITTEN OUT rather than borrowed from `encodeURIComponent`,
 * and the reason is one input: an UNPAIRED SURROGATE. The brief carries the owner's
 * task text, which arrives length-capped, and a cap that lands mid-emoji leaves half
 * a surrogate pair behind. `encodeURIComponent` THROWS `URIError` on one — from here
 * that is an exception on the codex route BEFORE anything is dispatched, with a
 * message naming neither the brief nor the task, for a build the Claude path would
 * have run without noticing. So the encoder below does what every real UTF-8 encoder
 * does with a lone surrogate — emits U+FFFD (`ef bf bd`) and keeps going — and the
 * receipt stays computable. If the bridge then reproduces the text differently the
 * wrapper refuses it (exit 3, DEFERRED), which is the fail-closed answer this check
 * exists to give; a crash is not.
 *
 * NOT A SIGNATURE, and not claimed as one: the author of the brief and its verifier
 * are the same run, so nothing here has to survive a deliberate collision. It has to
 * catch a bridge that dropped or reworded part of the text, which an exact byte count
 * plus a checksum does.
 */
function briefIntegrity(text) {
  let bytes = 0
  let h = 0x811c9dc5
  const push = (b) => {
    bytes++
    h = Math.imul(h ^ b, 0x01000193) >>> 0
  }
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
        i++
      } else {
        cp = 0xfffd // a high surrogate with nothing after it
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd // a low surrogate with nothing before it
    }
    if (cp < 0x80) {
      push(cp)
    } else if (cp < 0x800) {
      push(0xc0 | (cp >> 6))
      push(0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      push(0xe0 | (cp >> 12))
      push(0x80 | ((cp >> 6) & 0x3f))
      push(0x80 | (cp & 0x3f))
    } else {
      push(0xf0 | (cp >> 18))
      push(0x80 | ((cp >> 12) & 0x3f))
      push(0x80 | ((cp >> 6) & 0x3f))
      push(0x80 | (cp & 0x3f))
    }
  }
  return `${bytes}:${h.toString(16).padStart(8, '0')}`
}

/**
 * The coda appended to the Forge brief when the builder is `codex exec`.
 *
 * APPENDED, never a second contract. The build brief is assembled once and both
 * builders get the same one — the alternative (a codex-flavoured copy of
 * `forgeBuildContract`) is two texts that mean the same thing today and drift apart
 * on the first edit, at which point the two executors quietly build to different
 * rules. Only the REPORTING differs, because `codex exec` has no schema tool: the
 * six fields the inner loop needs are measured by the wrapper instead (see
 * `trident/codex-build.sh`), so the coda's job is to pin the two things the
 * measurement depends on — the branch and the diff path — and to stand down step 6.
 *
 * AND IT STANDS DOWN THE PUBLISH HALF OF STEP 4, which is the newer half of its job.
 * The codex build holds NO GitHub credential and is not going to be given one: the
 * child shell's environment filter strips `*TOKEN*` (see `trident/codex-build.sh`, THE
 * CHILD SHELL'S ENVIRONMENT, for the leak that got the last attempt at widening it
 * reverted), so `gh pr create` inside that sandbox cannot authenticate, ever. A build
 * ordered to push and open a PR anyway did exactly what the order implied: it wrote the
 * whole feature, could not deliver it, and the round came back indistinguishable from
 * one that produced nothing. So the contract is split at the publish boundary — the
 * build commits locally, and the WRAPPER, which runs outside the sandbox where the
 * credential lives, pushes and opens the PR. Telling the build to attempt it anyway
 * would burn tokens on a command that cannot succeed and end in a report of a PR that
 * does not exist.
 */
function codexBuildCoda() {
  const publish = isPr
    ? `
- STEP 4'S PUSH AND PR ARE NOT YOURS, and this REPLACES that step: COMMIT LOCALLY on ${forgeBranch} and stop there. Do NOT run \`git push\` and do NOT run \`gh\` at all. You are running without a GitHub credential — that is deliberate, not an oversight to work around — so a push or a \`gh pr create\` from here cannot authenticate and will fail. The wrapper that launched you does both from OUTSIDE this sandbox after you exit, and then measures what actually landed. Your commit is the deliverable; publishing it is someone else's step.`
    : ''
  return `

HOW TO REPORT (you are running as \`codex exec\` and nothing reads a report from you — this REPLACES steps 5 and 6 above):
- There is nothing to "return via the schema" and no last-lines block to emit. Say what you did in plain prose and stop.
- Your work is read back from the REPOSITORY, not from your report: the wrapper that launched you runs \`git rev-parse\`, \`git ls-remote\` and \`gh pr list\` after you exit and reports what it finds. So a commit you did not make is a commit that did not happen — no summary can substitute for it. Printing a NEUTRON_CODEX_BUILD_* line yourself changes nothing; the wrapper writes its measurements somewhere you are not.${publish}
- Step 5's diff path is an EXAMPLE and this REPLACES it: write the branch diff to EXACTLY ${codexBuildDiffFile()}, which is the only path the wrapper looks at.
- Stay on branch ${forgeBranch}. The wrapper looks for that branch by name; work landed on any other branch is invisible to the rest of the run.`
}

/**
 * The codex BUILD bridge prompt — a thin Claude agent whose only job is to run one
 * command and copy six measured values out of its output.
 *
 * SAME SHAPE AS THE REVIEW BRIDGE (`codexReviewerPrompt`), and for the same reason:
 * the workflow runtime gives this script `agent()` and nothing else, so a subprocess
 * can only be reached through an agent that shells out. The bridge does NOT build, and
 * is told so explicitly — an agent that "helpfully" finished the job itself would put
 * the phase back on Anthropic, which is the one outcome this whole route exists to
 * avoid.
 *
 * THE BRIEF TRAVELS AS A HEREDOC, not as a quoted argv. It is kilobytes of contract
 * text full of backticks and apostrophes; a single-quoted argument would need every
 * quote escaped, and the bridge has to reproduce the command exactly. A quoted
 * heredoc (`<<'MARKER'`) needs no escaping at all, so what codex reads is byte-for-byte
 * what this function composed — and the marker is grown below until it provably does
 * not occur in the brief, which is what keeps that safety from depending on luck.
 *
 * AND IT TRAVELS IN CHUNKS, one Bash call each, because at ~26 KB the copy stopped
 * being a "real, if unmeasured, failure rate" and became a CERTAINTY. Run `000cedc8`
 * (2026-08-13): the workflow composed 26,183 bytes, the bridge wrote 24,524, and the
 * file ended mid-word. The contractual retry produced a BYTE-IDENTICAL wrong copy —
 * same 25,410-char command, same truncation — which is the part that matters. The
 * brief was intact in the bridge's prompt, so nothing upstream lost it; the model
 * simply cannot emit that many bytes verbatim, and it fails the SAME WAY every time.
 * A retry policy assumes independent attempts. These were not independent, so the
 * one-retry contract could never have recovered it and the whole pipeline stopped.
 *
 * So the transport is now sized to what a model can actually reproduce. Each chunk is
 * a separate quoted heredoc appended with `>>`, sent as its own Bash call, and the
 * receipt is UNCHANGED — still one `<bytes>:<fnv32>` over the fully assembled file, so
 * a chunk that is dropped, reordered or reworded is refused exactly as before. This
 * launcher-held segments (the task and reflection guidance — the two large ones) now
 * travel BY PATH via the `briefParts` manifest and
 * `NEUTRON_CODEX_BUILD_BRIEF_PARTS`. Chunked transport remains for the
 * workflow-composed head/coda (mid-workflow content this fs-less script cannot write)
 * and as the whole-brief fallback whenever the manifest is absent.
 *
 * AND IT GETS EXACTLY ONE RETRY. Reproducing several kilobytes verbatim is still a
 * MODEL doing a copy, so `CODEX_BUILD_BRIEF_CORRUPT` (exit 3) is a real, if unmeasured,
 * failure rate — and with no retry it is terminal: `codexStatus='deferred'`, the throw
 * below, and an already-built, already-reviewed branch abandoned over a copying
 * wobble. That exit is also the one failure here that is CHEAP to retry and knowably
 * transient: the wrapper refuses before it spends a token, so the retry costs a copy
 * and nothing else, and the fault is in the copy rather than in the build. One retry,
 * not a loop — a model that produced the same wrong copy twice will produce it a third
 * time, and the fail-closed refusal is the correct end state.
 */
/**
 * The largest number of BYTES put in one heredoc for the bridge to copy.
 *
 * Chosen from the only measurement there is rather than from taste: the bridge on run
 * `000cedc8` reproduced 24,524 of 26,183 bytes, so somewhere under ~24 KB it was still
 * copying correctly and at 26 KB it was not. 3 KB sits an order of magnitude below the
 * observed break and keeps a typical brief to under a dozen calls. It is deliberately
 * NOT tuned to the edge — the failure it prevents is a build against a contract nobody
 * wrote, and the cost of being conservative is a few extra Bash calls.
 */
const CODEX_BRIEF_CHUNK_BYTES = 3072

/**
 * Split text that ALREADY ENDS IN A NEWLINE into segments that concatenate back to it
 * EXACTLY, each within `maxBytes` — including when a single line is longer than the
 * limit.
 *
 * Returns `{ text, mode }`. Two modes, because a heredoc cannot express a partial line:
 *
 *   'heredoc' — whole lines, text ends in '\n'. A quoted heredoc emits each line plus
 *               its terminating newline, so this reassembles by appending, with no
 *               escaping anywhere (the brief is full of backticks and apostrophes).
 *   'raw'     — an arbitrary byte run with NO newline implied. Written with
 *               `printf '%s'`, which adds nothing, so a line can cross segments.
 *
 * WHY 'raw' EXISTS AT ALL — codex review, round 1 of this change. The first cut split
 * only on line boundaries and left an oversized line WHOLE, documenting the overshoot
 * as honest. It is not: the brief carries the owner's free-form task text, and one
 * minified JSON blob, base64 payload or generated source line recreates exactly the
 * deterministic 26 KB truncation this function exists to prevent. A limit a caller can
 * exceed by supplying ordinary input is not a limit. So an oversized line is split by
 * BYTES and carried raw, and its terminating newline is emitted as its own tiny raw
 * segment rather than being implied by anything.
 *
 * SPLITTING IS ON CODE POINTS, never UTF-16 units: cutting between a surrogate pair
 * would hand `printf` half a character and change the bytes. `briefIntegrity` replaces
 * a lone surrogate with U+FFFD, so a mid-pair cut would ALSO make the receipt disagree
 * with the file in a way that reads as corruption rather than as a bug here.
 *
 * `segments.map(s => s.text).join('') === text` is the property everything rests on —
 * asserted in `codex-brief-chunking.test.ts` at limit-1, limit and limit+1, over
 * multi-byte text, and above the 24,524/26,183-byte boundary that was observed failing.
 */
function chunkTextOnLines(text, maxBytes) {
  const enc = (s) => briefIntegrity(s).split(':')[0] | 0
  const segs = []
  let cur = ''
  let curBytes = 0
  const flush = () => {
    if (cur !== '') segs.push({ text: cur, mode: 'heredoc' })
    cur = ''
    curBytes = 0
  }
  /** Byte-bounded pieces of one long line, cut only between code points. */
  const pushRaw = (s) => {
    let piece = ''
    let pieceBytes = 0
    for (const cp of s) {
      const b = enc(cp)
      if (piece !== '' && pieceBytes + b > maxBytes) {
        segs.push({ text: piece, mode: 'raw' })
        piece = ''
        pieceBytes = 0
      }
      piece += cp
      pieceBytes += b
    }
    if (piece !== '') segs.push({ text: piece, mode: 'raw' })
  }
  // `split('\n')` on newline-terminated text leaves a trailing '' — dropped, since each
  // piece below re-attaches the '\n' that terminated it.
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) {
    const piece = `${line}\n`
    const pieceBytes = enc(piece)
    if (pieceBytes > maxBytes) {
      // Too big for any heredoc segment: close the current one and carry this line
      // raw, newline included as its own segment so nothing has to imply it.
      flush()
      pushRaw(line)
      segs.push({ text: '\n', mode: 'raw' })
      continue
    }
    if (cur !== '' && curBytes + pieceBytes > maxBytes) flush()
    cur += piece
    curBytes += pieceBytes
  }
  flush()
  return segs.length > 0 ? segs : [{ text: '', mode: 'heredoc' }]
}

function codexBriefByPath(brief) {
  if (
    briefParts === null ||
    typeof briefParts !== 'object' ||
    Array.isArray(briefParts) ||
    typeof briefParts.taskFile !== 'string' ||
    briefParts.taskFile.length === 0 ||
    typeof briefParts.taskIntegrity !== 'string' ||
    briefParts.taskIntegrity.length === 0
  ) return null

  const full = `${brief}\n`
  const coda = codexBuildCoda()
  const suffix = task + reflectionGuidance + coda + '\n'
  if (!full.endsWith(suffix)) return null

  const taskActual = briefIntegrity(task)
  if (taskActual !== briefParts.taskIntegrity) {
    throw new Error(`CODEX_BUILD_BRIEF_ARGS_CORRUPT: the task text carried in the workflow args measures ${taskActual} but the launcher's receipt over the task it wrote to ${briefParts.taskFile} is ${briefParts.taskIntegrity}. The args crossed an agent and were altered in transit; refusing to compose a build brief from text nobody wrote. No build was attempted.`)
  }
  if (reflectionGuidance !== '') {
    const reflectionActual = briefIntegrity(reflectionGuidance)
    if (
      typeof briefParts.reflectionFile !== 'string' ||
      briefParts.reflectionFile.length === 0 ||
      reflectionActual !== briefParts.reflectionIntegrity
    ) {
      throw new Error(`CODEX_BUILD_BRIEF_ARGS_CORRUPT: the reflection segment carried in the workflow args measures ${reflectionActual} but the launcher's receipt over the reflection segment it wrote to ${briefParts.reflectionFile} is ${briefParts.reflectionIntegrity}. The args crossed an agent and were altered in transit; refusing to compose a build brief from text nobody wrote. No build was attempted.`)
    }
  }
  return {
    head: full.slice(0, full.length - suffix.length),
    tail: `${coda}\n`,
    files: reflectionGuidance !== ''
      ? [briefParts.taskFile, briefParts.reflectionFile]
      : [briefParts.taskFile],
  }
}

function codexBuildPrompt(slot, brief, route) {
  const uniq = runId || slug
  const briefFile = `/tmp/trident-codex-build-${uniq}-${slot}.brief`
  const byPath = codexBriefByPath(brief)
  const outFile = `/tmp/trident-codex-build-${uniq}-${slot}.out`
  const errFile = `/tmp/trident-codex-build-${uniq}-${slot}.err`
  // THE TRAILER GETS ITS OWN FILE, and that is the only place the six values are read
  // from. Sharing stdout with the codex transcript put model-controlled text and the
  // wrapper's measurement in the same window: a build that narrates
  // "NEUTRON_CODEX_BUILD_HEAD=<sha>" produced two trailers with no rule saying which
  // one won. A separate file has no ambiguity to resolve.
  const trailerFile = `/tmp/trident-codex-build-${uniq}-${slot}.trailer`
  const exitFile = `/tmp/trident-codex-build-${uniq}-${slot}.exit`
  const script = `${repoPath}/trident/codex-build.sh`
  // THE HEREDOC TERMINATOR MUST NOT OCCUR IN THE BRIEF. A brief line equal to the
  // marker would close the heredoc early and leave the REST OF THE BRIEF sitting in
  // the command as shell — and part of the brief is the owner's task text, which is
  // free-form. The run id already makes an accidental collision implausible; growing
  // the marker until it provably does not appear makes it impossible, which is the
  // difference worth two lines when the failure mode is arbitrary command execution.
  let marker = `NEUTRON_CODEX_BRIEF_EOF_${uniq}`
  while (brief.includes(marker)) marker += '_X'
  // THE RECEIPT FOR WHAT THE HEREDOCS ARE SUPPOSED TO WRITE — measured over exactly the
  // bytes the blocks below produce, which is the brief plus the newline that ends its
  // last line. A bridge that shortens or rewords the text writes a different file and
  // the wrapper refuses it (exit 3, DEFERRED) instead of building the wrong thing.
  //
  // ONE RECEIPT OVER THE WHOLE FILE, not one per chunk, and that is the point: chunking
  // changes only how the bytes travel, never what is checked at the end. A dropped
  // chunk, a duplicated one and a reordered pair all land as a file that is not the
  // brief, and all three are refused by the same measurement that already existed.
  const integrity = briefIntegrity(`${brief}\n`)
  // WHY `${brief}\n` IS SPLIT AND NOT `brief`: the receipt covers the trailing newline,
  // so the chunks must reassemble to the SAME string the receipt was taken over. Chunk
  // 1 truncates the file (`>`), the rest append (`>>`), so a re-run from the top is
  // safe and a half-written file from an interrupted attempt cannot survive into the
  // next one.
  const briefChunks = chunkTextOnLines(`${brief}\n`, CODEX_BRIEF_CHUNK_BYTES)
  const renderChunks = (chunks, file, offset, total) => chunks
    .map((seg, i) => {
      const redirect = i === 0 ? '>' : '>>'
      const call = offset + i + 1
      const head = `CALL ${call} of ${total}:`
      if (seg.mode === 'raw') {
        // A fragment of an over-long line. `printf '%s'` appends the bytes and NOTHING
        // else — no newline, no interpretation of backslashes (which `echo` would
        // mangle). Single-quoted, so the one character needing care is `'` itself and
        // `shSingleQuote` already handles it.
        return `${head}\nprintf '%s' ${shSingleQuote(seg.text)} ${redirect} ${shSingleQuote(file)}`
      }
      // Per-segment marker, still grown until it provably does not occur in THIS segment.
      let m = `${marker}_P${call}`
      while (seg.text.includes(m)) m += '_X'
      return `${head}\ncat ${redirect} ${shSingleQuote(file)} <<'${m}'\n${seg.text}${m}`
    })
    .join('\n\n')
  let chunkBlocks
  let writeBriefInstructions
  let partsEnv = ''
  let runCommandNote = ''
  let corruptInstructions
  let partMissingInstructions = ''
  if (byPath === null) {
    chunkBlocks = renderChunks(briefChunks, briefFile, 0, briefChunks.length)
    writeBriefInstructions = `FIRST write the brief to disk in ${briefChunks.length} SEPARATE Bash call(s), in the order given. Each block below is one call; pass each WHOLE block unchanged. Call 1 uses \`>\` (it truncates any earlier attempt); every later call uses \`>>\` (it appends). Do NOT merge them into one call, do NOT reorder them, do NOT skip one.
THE BRIEF IS CHECKED AS A WHOLE once all the calls are done: the run command below carries the assembled file's byte count and checksum, and the wrapper REFUSES to build (exit 3) if what is on disk is not byte-for-byte what is written here. So copy each block exactly — never summarise, re-wrap, re-indent, or tidy it. It is split into pieces precisely BECAUSE a long copy goes wrong; keep each piece exact and the whole is exact.`
    corruptInstructions = `RE-RUN ALL ${briefChunks.length} CHUNK CALL(S) FROM CALL 1 (it uses \`>\`, so it clears the bad file)`
  } else {
    const a1File = `${briefFile}.a1`
    const a2File = `${briefFile}.a2`
    const headChunks = chunkTextOnLines(byPath.head, CODEX_BRIEF_CHUNK_BYTES)
    const tailChunks = chunkTextOnLines(byPath.tail, CODEX_BRIEF_CHUNK_BYTES)
    const total = headChunks.length + tailChunks.length
    chunkBlocks = `${renderChunks(headChunks, a1File, 0, total)}\n\n${renderChunks(tailChunks, a2File, headChunks.length, total)}`
    writeBriefInstructions = `FIRST write the TWO workflow-composed brief SEGMENTS to disk in ${total} SEPARATE Bash call(s), in the order given; the large task text does NOT travel through you — it is already on disk at the part path(s) listed in the run command, written by the host. Do NOT read, rewrite, recreate or "fix" those part files; never write the task yourself. The wrapper assembles the full brief from the listed part files, in order, and REFUSES to build (exit 3) unless the assembled whole matches the byte count and checksum in the run command.`
    partsEnv = ` NEUTRON_CODEX_BUILD_BRIEF_PARTS=${shSingleQuote([a1File, ...byPath.files, a2File].join('\n'))}`
    runCommandNote = `\nThis command contains quoted newlines inside the PARTS value — pass the WHOLE block as ONE Bash call, unmodified.`
    corruptInstructions = `RE-RUN ALL ${total} SEGMENT CALL(S) FROM CALL 1 (each file's first call uses \`>\`, so re-running clears both segment files)`
    partMissingInstructions = `\n- EXIT 3 with CODEX_BUILD_BRIEF_PART_MISSING in ${errFile} → a HOST-written part file is missing or empty; no retry by you can fix it and you must NOT create the file yourself — report codexStatus='deferred'.`
  }
  const diffFile = codexBuildDiffFile()
  // The model assignment, exactly as the review lane does it: the id belongs to the
  // subprocess, never to the wrapping agent. Empty when no registry was threaded,
  // which invokes the wrapper on its own pinned default.
  const envPrefix =
    route.envVar && route.model ? `${route.envVar}=${shSingleQuote(route.model)} ` : ''
  // THE MERGE MODE IS HANDED TO THE WRAPPER AS ARG 3, not re-derived by it. Three of
  // its checks are pr-only — the remote baseline, the push-credential precheck and the
  // `gh pr list` probe — and before this argument existed it inferred "am I in pr mode"
  // from "does an `origin` exist", which is a question about the CLONE and not about
  // the RUN. A local-mode build in any clone with an unreachable origin (offline, a
  // stale URL, a non-GitHub remote) hard-DEFERRED at the baseline before codex was ever
  // launched, and did it again every round: the run could not progress, and the reason
  // named a remote it was never going to push to. The wrapper defaults an absent arg to
  // `pr`, the strict side, so the two cannot disagree in the dangerous direction.
  //
  // In pr mode the sha that matters is the PUSHED one — it is what a reviewer reads
  // and what `--match-head-commit` pins the merge to. In local mode there is no
  // remote, so the local head is the authority. Same split as `readBranchHead`.
  const shaLine = 'commitSha    = the value after NEUTRON_CODEX_BUILD_HEAD= (the build commit; in pr mode the outer loop independently publishes and confirms it before review)'
  return `You are the CODEX BUILD bridge for trident. The BUILD ITSELF runs in a codex subprocess; YOUR job is to launch it and report the six values its wrapper measures. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}
DO NOT BUILD ANYTHING YOURSELF. Do not edit a file, do not run the tests, do not commit, and do not "finish the job" if the subprocess falls short — this phase was deliberately moved off Claude, and work you do here defeats that. Run the command, read the output, fill the schema.
Work from your CURRENT WORKING DIRECTORY (your isolated worktree — do NOT \`cd\` anywhere).
${writeBriefInstructions}
${chunkBlocks}

THEN run this ONE command: launch the wrapper DETACHED (Claude Code's Bash tool has a 600-second per-call ceiling; the wrapper must not be its child when that unrelated ceiling expires):
rm -f ${shSingleQuote(exitFile)}; nohup setsid sh -c 'status=$1; shift; "$@"; rc=$?; printf "%s\n" "$rc" > "$status"' sh ${shSingleQuote(exitFile)} env ${envPrefix}CODEX_HOME=${shSingleQuote(codexHome || '')} NEUTRON_CODEX_BUILD_BRIEF_FILE=${shSingleQuote(briefFile)}${partsEnv} NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY=${shSingleQuote(integrity)} NEUTRON_CODEX_BUILD_DIFF_FILE=${shSingleQuote(diffFile)} NEUTRON_CODEX_BUILD_TRAILER_FILE=${shSingleQuote(trailerFile)} bash ${shSingleQuote(script)} ${shSingleQuote(forgeBranch)} ${shSingleQuote(baseBranch)} ${shSingleQuote(mergeMode)} > ${shSingleQuote(outFile)} 2> ${shSingleQuote(errFile)} </dev/null &${runCommandNote}

Then WAIT for completion using this command. It waits at most 540 seconds, safely below the Bash tool's 600-second ceiling. If it prints CODEX_BUILD_STILL_RUNNING, run the SAME wait command again; repeat up to five times (45 minutes total, matching the fire session's absolute ceiling):
for i in $(seq 1 108); do if test -s ${shSingleQuote(trailerFile)}; then cat ${shSingleQuote(trailerFile)}; exit 0; fi; if test -s ${shSingleQuote(exitFile)}; then echo CODEX_EXIT=$(cat ${shSingleQuote(exitFile)}); exit 0; fi; sleep 5; done; echo CODEX_BUILD_STILL_RUNNING

THE TRAILER IS THE BUILD completion signal. After waiting, test it directly with \`test -s ${shSingleQuote(trailerFile)}\`. Set trailerComplete=true ONLY when that test succeeds. Copy the integer in ${exitFile} to wrapperExitCode, or null while it is absent. Exit 3/10/11 are pre-build refusals and keep their existing mappings. For every other empty/missing trailer — including a signalled wrapper whose supervisor recorded 128 or greater — set codexStatus='deferred', trailerComplete=false, and run \`git status --porcelain\` in the current worktree; set preservedWork=true when it prints anything. Never describe this case as "produced nothing": report that the build wrapper was killed before it could report, name ${trailerFile}, ${errFile}, and the current worktree, and say explicitly when the preserved worktree holds uncommitted work.
Read the CODEX_EXIT code, then map it to your result (read ${outFile} and ${errFile} only as needed — tail, do not flood context):
- EXIT 0 → codexStatus='connected'. ${trailerFile} holds a six-line NEUTRON_CODEX_BUILD_* trailer the WRAPPER measured with git and gh, after the build exited. COPY THOSE SIX VALUES VERBATIM — they are facts about the repository, not a claim to be checked against the transcript, and they are what the merge gate pins to. The build's own transcript in ${outFile} is NOT a source for any of them: if it contains NEUTRON_CODEX_BUILD_* lines of its own, they are the model talking about itself and you must ignore them entirely.
    branch       = the value after NEUTRON_CODEX_BUILD_BRANCH=
    ${shaLine}
    prNumber     = the value after NEUTRON_CODEX_BUILD_PR= as an integer, or null when it is empty
    diffFile     = the value after NEUTRON_CODEX_BUILD_DIFF=
    worktreePath = the value after NEUTRON_CODEX_BUILD_WORKTREE=
  Report an EMPTY STRING for any trailer value that is empty. NEVER substitute a sha, a branch or a PR number you read anywhere else, and never invent one: an empty value stops the run, a wrong one ships code nobody reviewed.
  testsPassed is the ONE field that is the build's own claim — true only if the transcript states the tests were run and passed; false otherwise, including when they were never run.
- EXIT 10 or 11 → codexStatus='not_connected' (no codex credential, or no codex CLI). NO BUILD HAPPENED.
- EXIT 3 with CODEX_BUILD_BRIEF_CORRUPT in ${errFile} → THE COPY ABOVE, NOT THE BUILD. The assembled brief file did not match the byte count and checksum in the command — a chunk was dropped, duplicated, reordered or reworded on its way to disk; no tokens were spent and nothing was built. ${corruptInstructions}, copying each block character for character this time — do not re-wrap long lines, do not strip trailing spaces, do not "fix" formatting or indentation, and do not try to repair only the piece you think was wrong. Exactly ONE retry: if the second pass reports CODEX_BUILD_BRIEF_CORRUPT again, stop and report codexStatus='deferred'. Say so plainly rather than proceeding — building against an approximation of the brief is the exact outcome this check exists to prevent.${partMissingInstructions}
- EXIT 3 or 5 (any other reason) → codexStatus='deferred' (codex was configured but the build could not run or did not complete — the tail of ${errFile} says which).
For 'not_connected' and 'deferred' alike: report branch, commitSha, diffFile and worktreePath as the empty string, prNumber as null and testsPassed as false, even if the trailer shows values. The run stops on those statuses and says why; do NOT dress a failed lane up as a partial build.
For every completed trailer set trailerComplete=true, copy its wrapperExitCode, and set preservedWork=false. Return via the schema. NEVER exit silently — if the command itself could not run, return codexStatus='deferred', trailerComplete=false, wrapperExitCode=null, and report whether the current worktree has preserved work.`
}

/**
 * Dispatch one Forge turn — on Claude, or on the codex executor.
 *
 * ONE FUNCTION, so round 1 and every fix round cannot end up on different executors.
 * The route decides; both call sites just hand over the brief.
 */
async function forgeAgent(opts, tag, brief, slot) {
  const route = routeModel(opts.label, tag)
  if (route.transport !== 'cli') {
    return await agent(brief, withModel({ ...opts, schema: FORGE_SCHEMA }, tag))
  }
  const res = await agent(
    codexBuildPrompt(slot, `${brief}${codexBuildCoda()}`, route),
    withModel({ ...opts, schema: CODEX_FORGE_SCHEMA }, tag),
  )
  if (!res) return null
  if (res.trailerComplete !== true && ![3, 10, 11].includes(res.wrapperExitCode)) {
    throw new Error(
      `${opts.label} DEFERRED: the build wrapper was killed before it could report; its completion trailer ${`/tmp/trident-codex-build-${runId || slug}-${slot}.trailer`} is empty or missing. Inspect ${`/tmp/trident-codex-build-${runId || slug}-${slot}.err`} and the preserved worktree${res.preservedWork === true ? ', which holds uncommitted work' : ''}.`,
    )
  }
  if (res.codexStatus !== 'connected') {
    // A LANE THAT COULD NOT RUN IS NOT A BUILD, and it must not be reported as one.
    // The alternative is to fall back to Claude, which would spend exactly the quota
    // the owner moved this phase to protect and would do it invisibly. Stop instead:
    // the catch{} persists a terminal failure naming the status, and the operator
    // reconnects codex or moves the phase back themselves.
    throw new Error(
      `${opts.label} was routed to the codex executor and NO BUILD HAPPENED (codexStatus=${res.codexStatus}) — see the codex-build wrapper stderr. Refusing to continue: falling back to Claude would silently spend the quota this route exists to save.`,
    )
  }
  // THE MEASURED BRANCH IS CHECKED, NOT JUST CARRIED. The wrapper reports the branch it
  // was standing on (`git rev-parse --abbrev-ref HEAD`) and already blanks the sha when
  // it is the wrong one — this turns that into a NAMED failure instead of the confusing
  // "produced no commitSha" the empty sha would raise two hundred lines later, and it
  // is the only consumer that makes the reported branch load-bearing. Empty is not a
  // disagreement: a build that established nothing reports nothing, and the sha gate
  // below is what stops that one.
  const reportedBranch = typeof res.branch === 'string' ? res.branch.trim() : ''
  if (reportedBranch !== '' && reportedBranch !== forgeBranch) {
    throw new Error(
      `${opts.label} committed on branch '${reportedBranch}' but the run builds '${forgeBranch}'. Refusing to continue: the reviewers would read a diff that merging '${forgeBranch}' does not land, and in local mode the branch holding that work is deleted after the merge.`,
    )
  }
  return res
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

// THE CHEAP PROBE THAT DECIDES WHETHER THE CONTINUATION PLANNER CAN RUN AT ALL.
//
// The workflow script has NO direct shell — every git fact it uses arrives through
// an `agent()` Bash step (see `readBranchHead`). So "does the branch carry a
// committed plan, and does it still have unchecked tasks?" needs a seat. This is
// the same shape as the head probe: ONE fixed command pair, a verbatim body and a
// count back, no judgement about what any of it means — the selection is made in
// code below, from these three fields.
// THE PROBE READS THE SAME REF THE RESUME GATE JUDGED.
//
// `classifyResume`'s head comparison — the thing that makes 'unknown-checkpoint'
// mean "the branch did not move under this handoff" — is fed by the launcher's
// `resolveResumeLiveHead`, which in `pr` mode asks the REMOTE (`git ls-remote
// origin`) and in `local` mode the local ref. A probe reading the plain local
// branch name in pr mode would therefore read a DIFFERENT commit than the one the
// gate cleared: `git show <branch>:…` resolves `refs/heads/<branch>` ahead of
// `refs/remotes/origin/<branch>`, so a repo of record holding an unpublished local
// commit (Forge commits locally in pr mode and is told not to push) would hand
// `plan:next` a plan whose tasks nobody has published or reviewed. Same authority
// split as `readBranchHead`, for the same reason.
const planProbeRef = isPr ? `origin/${forgeBranch}` : forgeBranch

function planProbePrompt() {
  const planPath = `${planProbeRef}:IMPLEMENTATION_PLAN.md`
  return `Run EXACTLY the commands below from ${repoPath} and report what they print via the schema. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}
Do NOT modify anything. Do NOT read any other file. Do NOT interpret the plan's content.
1. \`cd ${shSingleQuote(repoPath)} && git fetch origin ${shSingleQuote(forgeBranch)} 2>/dev/null || true\`
2. \`cd ${shSingleQuote(repoPath)} && git show ${shSingleQuote(planPath)}\`
If step 2 fails (the file does not exist on that branch, or the branch does not exist), report \`{"planFound": false, "uncheckedCount": 0, "planBody": "", "planLines": 0}\` — that is a normal answer, not an error to retry around.
Otherwise report \`planFound\` = true, \`planBody\` = the file's content VERBATIM (every byte, unedited and untruncated), and \`uncheckedCount\` = the number of still-unchecked task lines, which you MUST measure with \`grep -c\` rather than by eye:
\`cd ${shSingleQuote(repoPath)} && git show ${shSingleQuote(planPath)} | grep -c '^[[:space:]]*- \\[ \\]'\`
(\`grep -c\` exits 1 and prints 0 when nothing matches; that is \`uncheckedCount\` = 0, not a failure.)
3. \`cd ${shSingleQuote(repoPath)} && git show ${shSingleQuote(planPath)} | wc -l\` — report that number as \`planLines\`. It is checked against the \`planBody\` you report, so a body that lost lines on the way into the schema is DETECTED and the whole cheap path is abandoned. Do not compute it from what you copied; report what \`wc -l\` printed.
NEVER EXIT SILENTLY.`
}

// THE CONTINUATION PLANNER (`plan:next`) — the same PLAN_SCHEMA, without the
// whole-repo survey.
//
// The previous iteration's Forge PERSISTED AND COMMITTED the regenerated
// IMPLEMENTATION_PLAN.md with its task checked off (`ralphExecuteNote`), so the
// branch already carries a CURRENT plan. Iteration N+1 re-deriving that document
// from SPEC.md + the whole codebase is the measured 287 s this step removes: the
// saving is the ABSENT SURVEY, not a cheaper model — the routing matches
// `plan:fable` deliberately, because choosing the next task and writing its
// execution spec is still the high-value thinking.
function planNextPrompt(body) {
  return `You are the CONTINUATION PLANNER for a governed, spec-driven Ralph build. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}
A PRIOR ITERATION of this same build regenerated the IMPLEMENTATION_PLAN.md below and committed it to branch ${forgeBranch} with the task it built already marked '- [x]'. That plan is CURRENT. Your job is to pick up where it left off — NOT to re-derive it.
- Do NOT read SPEC.md. Do NOT survey, read, or diff the codebase. Do NOT run any command. Everything you need is in this prompt.
- Do NOT regenerate, re-order, re-word, or re-prioritise the checklist.
1. Return \`implementationPlan\` = EXACTLY the committed plan body below, VERBATIM, byte for byte (the executor persists it again with the task you pick marked '- [x]', so any edit here silently rewrites the card's plan).
2. Return \`topTask\` = the FIRST still-unchecked '- [ ]' item in that body, reading top to bottom (the Ralph one-task discipline: exactly one task per iteration).
3. Return \`executionSpec\` for that ONE task: the exact TARGET FILES, the ACCEPTANCE CRITERION (what "done" means), and the TEST PLAN (which tests to write/run) — derived from that item's own text plus the TASK CONTEXT below. Make it precise enough that a cheaper model executes it WITHOUT re-reasoning the design.
4. Tag \`complexity\`: 'mechanical' (boilerplate, tests, formatting, a single-file edit) vs 'reasoning' (multi-file, architecture-touching, tricky invariants). When genuinely uncertain choose 'reasoning' (Opus is the safer executor).
5. Return \`remainingTasks\` = the count of unchecked items left AFTER the one you picked. A probe counted the unchecked '- [ ]' items in this body already, so this should be that count minus one.
Return via the schema. NEVER exit silently.
COMMITTED IMPLEMENTATION_PLAN.md (verbatim):
${body}
TASK CONTEXT:
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
- Commit IMPLEMENTATION_PLAN.md together with your code + tests.
- Report \`deviatedFromSpec: true\` in your structured result ONLY if you materially deviated from the EXECUTION SPEC above (different target files, a different design, or the task as built is not the task as specced) — a true here forces the next iteration to re-derive the whole plan, so do not set it for cosmetic drift. Otherwise report false or omit it.`
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
// A CHECKPOINT RECORDS WHICH COMMIT IT APPLIED TO, NOT JUST ITS OWN NAME.
//
// `opts.head` is the branch head OID this phase's work produced (Forge's reported
// `commitSha`) or judged (the reviewed head), and it goes into the SAME
// checkpoint.sh invocation as the name, so the pair is written by ONE atomic
// UPDATE and can never drift apart. Without it a resumed run knows only that
// *some* code reached this phase — which is why every resume before this had to
// distrust the checkpoint and rebuild (and why `argus-approved` had to fail closed
// at merge, #545). With it, `classifyResume` can compare the recorded OID to the
// live head and trust the prior work ONLY when they are the same commit.
//
// The head field is written on EVERY checkpoint, INCLUDING as an empty string when
// the phase could not report a sha. Writing it unconditionally is the point: a
// skipped write would leave the PREVIOUS checkpoint's OID sitting next to the new
// name, and a resume would then judge this phase against a commit that belongs to
// an earlier one. Empty simply reads as "no recorded OID" → rebuild.
//
// `opts.findings` (the synthesised findings this checkpoint was recorded with) is
// written the same way and for the same reason — always, so it is never stale —
// through the temp-file + `readfile()` indirection `writeTerminalResult` uses, so
// the JSON's own quotes cannot break the sqlite argument.
async function checkpoint(name, opts) {
  if (!dbPath || !runId) return
  const o = opts || {}
  const fields = []
  if (o.pr !== undefined && o.pr !== null) fields.push(`pr ${Number(o.pr)}`)
  fields.push(`branch ${shSingleQuote(forgeBranch)}`)
  fields.push(`inner_checkpoint ${shSingleQuote(name)}`)
  fields.push(`inner_checkpoint_head ${shSingleQuote(normalizeOid(o.head))}`)
  const findingsTmp = `/tmp/trident-checkpoint-findings-${runId}.json`
  fields.push(`inner_findings_file ${shSingleQuote(findingsTmp)}`)
  fields.push(`subagent_status running`)
  const findingsJson = JSON.stringify(Array.isArray(o.findings) ? o.findings : [])
  await agent(
    `Checkpoint step (idempotent; must NOT fail the build). Run EXACTLY this single Bash command and nothing else, then report "checkpoint ${name} ok":
printf '%s' ${shSingleQuote(findingsJson)} > ${shSingleQuote(findingsTmp)} && bash ${shSingleQuote(checkpointSh)} ${shSingleQuote(dbPath)} ${shSingleQuote(runId)} ${fields.join(' ')}`,
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

/** One short, printable line for anything a `catch` can be handed — including a
 *  rejection that is not an Error at all (a string, `null`, an object). Bounded so a
 *  megabyte of subagent stderr cannot become a finding nobody can read. */
function errText(err) {
  const raw = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err)
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length > 200 ? `${one.slice(0, 200)}…` : one
}

// A SEAT THAT DIES MUST BE INDISTINGUISHABLE, TO THE ROUND, FROM A SEAT THAT
// ANSWERED NOTHING. This is the ONE chokepoint for dispatching a review seat.
//
// WHY IT EXISTS (the recurrence #212 did not close). #212 guarded the VALUE
// `reviewAndSynthesize` hands back, on the premise that a dead subagent makes
// `agent()` RETURN null. That is only one of the two ways it dies: the call can also
// REJECT — an API 529 Overloaded, a timeout, a subprocess that exits non-zero, a
// reply that fails its schema. A rejection is not a return value, so NOTHING
// downstream of the await ever runs: it unwinds straight out of `reviewAndSynthesize`,
// past `synthesisOrInfraBlock` (an argument is only evaluated on a value that
// arrived), out of the loop's `try`, and terminates the whole lane at checkpoint
// `inner-error` with no verdict — a finished Forge build and every review already
// paid for, discarded. That is a REVIEWER'S failure ending the RUN, which is exactly
// what the infra-block shape exists to prevent. `retryDeferredPeers` already assumes
// this ("an agent that dies must not crash the round") and catches around its own
// `invoke`; every OTHER dispatch site was unguarded.
//
// SO EVERY FAILURE MODE COLLAPSES TO ONE VALUE: `null`. Not because null is tidy, but
// because null is the shape the rest of the panel ALREADY handles correctly and is
// tested against — `usableStatus` rejects it, so `retryDeferredPeers` re-dispatches
// the seat (a 529 is transient; the retry is the cheapest possible remedy), and if it
// stays dead `missingCoreReviewers`/`crossModelPeerStatus` declare the seat empty,
// `enforceCrossModelGate` refuses to APPROVE and names WHICH seat, and
// `classifyBlock` returns 'infra-only' so the loop stops instead of re-Forging.
// Adding a second, parallel "the seat threw" path is how one of the two quietly stops
// being enforced; there is one path, and death joins it.
//
// IT CANNOT MANUFACTURE AN APPROVE. The only value it ever invents is `null`, which
// is not a verdict under `usableStatus`, so the failure direction is a BLOCK. The
// cross-model rule (`trident/kimi-review.ts`) — a cross-model review that did not
// happen may never become an APPROVE, and never falls back to a Claude-family model —
// is preserved by construction rather than by a second gate.
async function seatAttempt(seat, run) {
  try {
    return await run()
  } catch (err) {
    // The seat and the reason, on the run's transcript: an infra block that does not
    // say WHICH seat died and WHY leaves the operator with nothing to act on.
    log(`trident.seat-died seat=${seat} reason=${errText(err)}`)
    return null
  }
}

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
// single `codexStatus`; adding a second peer with its own near-identical gate is
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
// AND THE CRASH WAS STILL A FAILURE, one layer up (2026-08-13, `dashboard-p1`, round
// 7 of 10, ~10h). READ THE HEADING ABOVE NARROWLY: everything here is about the VALUE
// the round RETURNS. A seat that dies by REJECTING never returns one, so none of this
// ran — the rejection unwound past the whole guard and ended the lane at
// `inner-error` exactly as before. That half is closed by `seatAttempt` and
// `reviewRoundOrInfraBlock` above, not here. A guard on a return value cannot see a
// throw; both halves are needed and neither substitutes for the other.
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
//
// PARAMETERISED BY THE SEAT AND THE REASON, because "the code was never judged" is
// only half of what an operator needs — the other half is which seat died and why, and
// a lane block that omits it is unactionable. The zero-reason case is the shared
// frozen constant below, so the two rounds of a run still get one instance.
function synthesisUnavailable(seat, reason) {
  return Object.freeze({
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
        title: `LANE — ${seat} returned no verdict`,
        evidence:
          `${seat} produced no result` +
          (reason ? `: ${reason}` : '') +
          '. That is what a terminal API error (a 529 Overloaded, a session limit, a timeout) ' +
          'looks like from inside the workflow. The code was therefore NEVER JUDGED — this says ' +
          'nothing about the diff, and there is nothing here for a fix round to act on. Re-run ' +
          'the lane once the seat has capacity.',
      }),
    ]),
  })
}

const SYNTHESIS_UNAVAILABLE = synthesisUnavailable('The synthesis reviewer (argus:synthesis)', '')

/**
 * A synthesis that did not answer becomes the infra block, never a crash and never
 * a code finding. Anything carrying a real verdict is returned UNTOUCHED — the same
 * object, so a genuine verdict cannot be altered on its way to the loop.
 */
function synthesisOrInfraBlock(synthesis) {
  return usableStatus(synthesis, 'verdict') ? synthesis : SYNTHESIS_UNAVAILABLE
}

/**
 * ONE ROUND OF REVIEW, WHICH MAY NOT THROW — the outer half of the same chokepoint
 * `seatAttempt` is the inner half of.
 *
 * `seatAttempt` stops every DISPATCH from rejecting; this stops the round itself from
 * rejecting for any other reason (the injected `parallel`, a checkpoint step, a
 * serialisation of a reply we did not expect). Both call sites go through here, so
 * `synthesis` is a usable object on EVERY path and the two `synthesis.verdict` reads
 * cannot be reached with anything else.
 *
 * A round that died is the same infra block a synthesis that did not answer produces —
 * REQUEST_CHANGES, `infra-only`, one `lane` blocker naming the failure — so it can
 * never become an APPROVE and never buys a fix round against nothing. It takes a THUNK
 * rather than the arguments so the reviewAndSynthesize CALL
 * (deliberately NOT written with its argument list here: `inner-workflow.test.ts`
 * locates that call with a bare `SRC.indexOf`, so any prose repeating the exact
 * literal is found FIRST and silently becomes the anchor, breaking an ordering
 * assertion about code this comment only describes)
 * stays at its own call site, where the ordering assertions in `round-landed.test.ts`
 * and `inner-workflow.test.ts` pin it (repinning those has broken correct code three
 * times already).
 */
async function reviewRoundOrInfraBlock(runRound) {
  try {
    return synthesisOrInfraBlock(await runRound())
  } catch (err) {
    const reason = errText(err)
    log(`trident.review-round-died reason=${reason}`)
    return synthesisUnavailable('The review round (argus)', reason)
  }
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

/** A FULL 40-hex OID, or ''. Anything shorter is refused rather than tolerated:
 *  the outer merge pins on this value through `reviewedHeadOid` (merge.ts), which
 *  applies the SAME `^[0-9a-f]{40}$` test and refuses an abbreviated sha, so a
 *  resume that accepted one would unlock a fast path whose result cannot merge. */
const FULL_OID = /^[0-9a-f]{40}$/
function normalizeOid(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return FULL_OID.test(s) ? s : ''
}

/** A plausible OID CLAIM from the build agent (7–40 hex, either case), trimmed —
 *  else null. The outer publisher resolves the REAL head with `rev-parse --verify`
 *  on the branch this workflow NAMES; this value is only a cross-check there, so an
 *  abbreviated sha is carried verbatim and a missing one is NOT an error — a thrown
 *  handoff here is how run 3d2696c3 discarded a finished, committed build
 *  (defect 2026-08-14). Mirrors the `publish_head` decode in inner-loop.ts. */
const OID_CLAIM = /^[0-9a-fA-F]{7,40}$/
function oidClaim(value) {
  const s = typeof value === 'string' ? value.trim() : ''
  return OID_CLAIM.test(s) ? s : null
}

/**
 * WHAT A RESUMED CHECKPOINT MAY UNLOCK — decided from the COMMIT it was recorded
 * against, never from its name.
 *
 * THE PROBLEM. A lane's host process dies mid-loop (the shared account hits its
 * session limit, the 429 ends the session). The branch and its pushed commits
 * survive, so no code is lost — but the relaunched run rebuilt and re-reviewed
 * from zero, re-paying for every review round already bought. Fifteen lanes died
 * that way in three waves on 2026-08-12; several had completed round-1 review and
 * one was at fix round 7.
 *
 * WHY THE CHECKPOINT NAME ALONE IS NOT ENOUGH, AND WHY DISTRUSTING IT WAS RIGHT.
 * A verdict is about a COMMIT. Reviewers approved commit A; if anything pushed B
 * into the crash window, "the last checkpoint said approved" is a claim about code
 * no reviewer ever saw. Until `inner_checkpoint_head` existed the row recorded no
 * OID at all, so a resumed run could not tell A from B — which is exactly why the
 * only safe resume was to rebuild, and why the `argus-approved` shortcut recorded
 * NO reviewed head and let the merge fail closed (#545).
 *
 * SO THE COMPARISON, NOT THE NAME, IS THE GATE:
 *   • recorded OID == live head → the prior verdict is about EXACTLY this code;
 *     skip forward to the next step and (only here) carry the RECORDED reviewed
 *     OID as `reviewedHead`.
 *   • recorded OID != live head → the verdict is about different code. RE-REVIEW.
 *   • no recorded OID (a checkpoint written before it was recorded), a
 *     not-full-OID value, or an unreadable live head → treated as MOVED. Old data
 *     must not unlock the new fast path, and "could not tell" is never "unchanged".
 *   • an UNKNOWN checkpoint name → rebuild. `ralph-task-built` lands here on
 *     purpose: that iteration deliberately built one task and handed back for a
 *     re-fire, so the next iteration must PLAN and BUILD the next task, not review.
 *
 * THE COMPARISON HAPPENS HERE, IN CODE, exactly like `roundLanded`: the agent is
 * asked for one fact (the head sha) and this function decides what it means. And
 * the live head is only ever an INPUT to the comparison — the value a fast path
 * goes on to call `reviewedHead` is the RECORDED one, never the probe's answer.
 * That distinction is the whole of #545: a probe can return a commit that was
 * pushed after the review, and pinning the merge to it would certify unreviewed
 * code with a safety label on it.
 */
function classifyResume(input) {
  const name = typeof input.checkpoint === 'string' ? input.checkpoint.trim() : ''
  if (name.length === 0) return { mode: 'rebuild', reason: 'no-checkpoint' }
  // A merge is terminal even though its head branch may already be deleted and
  // therefore cannot participate in the OID comparison used by other modes.
  if (name === 'pr-merged') return { mode: 'merged', reason: 'already-merged' }
  const recorded = normalizeOid(input.recordedHead)
  if (recorded.length === 0) return { mode: 'rebuild', reason: 'no-recorded-head' }
  // The launcher's tri-state: a branch the AUTHORITY says does not exist is a real
  // READ, not a failed one — the recorded work is gone from the authority, so a
  // rebuild is correct here and can be named truthfully. Checked BEFORE normalizeOid,
  // which would flatten this to '' — and '' is reserved exclusively for "could not
  // read the head", the case Part 2b of this card gives a bounded-STOP consequence.
  if (input.currentHead === 'absent') return { mode: 'rebuild', reason: 'head-branch-absent' }
  const current = normalizeOid(input.currentHead)
  if (current.length === 0) return { mode: 'rebuild', reason: 'head-unreadable' }
  if (current !== recorded) return { mode: 'rebuild', reason: 'head-moved' }
  // From here the recorded OID and the live head are the SAME commit, so the
  // prior phase's outcome is about exactly the code this run is looking at.
  if (name === 'argus-approved') return { mode: 'approved', reason: 'head-unchanged' }
  // The optional `:deviated` suffix is about the NEXT iteration's PLANNER, not
  // about whether THIS invocation may skip its own re-build — so a deviated
  // publish checkpoint classifies exactly as a clean one does.
  if (/^outer-published:[0-9a-f]{40}:\d+:\d+(:deviated)?$/.test(name)) {
    return { mode: 'review', reason: 'outer-published-head-unchanged' }
  }
  if (name === 'argus-request-changes' || /^argus-request-changes-round-\d+$/.test(name)) {
    // A fix round with no findings is a Forge agent told to fix nothing, which is
    // worse than paying for the review again — so missing findings re-review.
    return input.hasFindings
      ? { mode: 'fix', reason: 'head-unchanged' }
      : { mode: 'review', reason: 'head-unchanged-no-findings' }
  }
  // `forge-done` = built but never judged; `fix-round-N` = fixed but never
  // re-judged. Both mean the head in front of us has NO verdict → review it.
  if (name === 'forge-done' && input.ralph === true) {
    return { mode: 'rebuild', reason: 'ralph-progress-unknown' }
  }
  if (name === 'forge-done' || /^fix-round-\d+$/.test(name)) {
    return { mode: 'review', reason: 'head-unchanged' }
  }
  return { mode: 'rebuild', reason: 'unknown-checkpoint' }
}

/**
 * The round number a `fix-round-N` checkpoint encodes (0 for any other name).
 *
 * A resume that skips forward must also inherit the ROUND BUDGET already spent,
 * or the cap stops bounding anything: a lane that crashed at fix round 7 would
 * restart its counter at 1 and be handed a fresh `maxRounds` rounds, which is how
 * a bounded loop becomes an unbounded one across crashes.
 */
function parseResumeRound(name, roundCap) {
  const m = /^(?:fix-round-|argus-request-changes-round-)(\d+)$/.exec(
    typeof name === 'string' ? name.trim() : '',
  )
  if (m === null) return 0
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 && n <= roundCap ? n : 0
}

/**
 * A MERGE IS TERMINAL (ISSUES #563).
 *
 * WHAT WENT WRONG. A lane approved and MERGED its PR, the merge deleted the head
 * branch, and the workflow then entered `forge:fix-round-2` and ran ~19 more
 * minutes — a live executor plus an 18-minute cross-model reviewer — generating
 * fixes for a branch with nowhere to push. Nothing downstream complains about
 * that: the PR is green and merged, so from outside the lane merely looks slow.
 *
 * WHY THE LOOP COULD NOT KNOW. The merge decision and the loop-continuation
 * decision are made by two different components with NO channel between them.
 * The continuation is decided ENTIRELY by the `while` condition below
 * (`finalVerdict` / `round` / `blockKind`) — three facts computed from the review
 * synthesis, none of them a fact about the PR. The merge is performed either by
 * the OUTER driver (`trident/orchestrator.ts` `applyResult` → `cleanupAfterMerge`
 * → `trident/merge.ts` `mergePr`), which only runs AFTER this workflow's terminal
 * result is harvested, or by an agent INSIDE the run (a task whose whole job is to
 * sign off on a PR merges it during its Forge round) — and this script never
 * re-reads its own run row (`trident/checkpoint.sh` only ever WRITES), so a merge
 * that happens mid-run is invisible to every subsequent decision here.
 *
 * SO THE MERGE ITSELF IS PROBED, at the earliest instant it can have happened —
 * the moment a Forge round returns — and BEFORE anything else is dispatched. A
 * check at the top of the NEXT round has already paid for the round that is being
 * removed.
 *
 * FAIL-CLOSED IN THE DIRECTION THAT MATTERS. Only an explicit merge marker from
 * GitHub counts as merged; an unreadable answer is 'unknown' and the run carries
 * on exactly as before, because terminating a LIVE run as "merged" would abandon
 * real work. `mergedAt` is accepted as well as `state` because either one is
 * GitHub stating the fact, and the pair is printed to the run log before anything
 * is keyed off it.
 */
function classifyPrMerged(res) {
  const raw = res && typeof res.raw === 'string' ? res.raw : ''
  const exit = res && typeof res.exit_code === 'number' ? res.exit_code : null
  // A non-zero (or unreported) exit is `gh` failing, not a PR that is open: the
  // command could not answer, so neither can we.
  if (exit !== 0) return 'unknown'
  const open = raw.indexOf('{')
  const close = raw.lastIndexOf('}')
  if (open === -1 || close <= open) return 'unknown'
  let parsed = null
  try {
    parsed = JSON.parse(raw.slice(open, close + 1))
  } catch {
    return 'unknown'
  }
  if (parsed === null || typeof parsed !== 'object') return 'unknown'
  const state = typeof parsed.state === 'string' ? parsed.state.trim().toUpperCase() : ''
  const mergedAt = typeof parsed.mergedAt === 'string' ? parsed.mergedAt.trim() : ''
  if (state === 'MERGED' || mergedAt.length > 0) return 'merged'
  // OPEN and CLOSED are GitHub saying "not merged" — a CLOSED PR was abandoned,
  // which is NOT a merge and must not end the run as a success.
  if (state === 'OPEN' || state === 'CLOSED') return 'not-merged'
  return 'unknown'
}

/**
 * WHAT A FIX ROUND'S OUTCOME MEANS ONCE THE MERGE STATE IS KNOWN — and the ONE
 * place the two guards are ordered against each other (ISSUES #563, Open #148).
 *
 * THE ROUND-LOST GUARD AND THIS ONE LOOK AT THE SAME EVIDENCE AND MEAN OPPOSITE
 * THINGS. `roundLanded` decides by reading the branch head, and a merge DELETES
 * that branch — so a run that landed everything and got merged presents to it as
 * an UNREADABLE head, i.e. as the failure it exists to catch. Recording a merged
 * run as `round-lost` would replace a wasteful defect with a worse one: successful
 * work reported as broken, and an operator sent to `git stash list` to recover
 * work that is already on the base branch.
 *
 * So the merge question is asked FIRST and its answer WINS. Only when GitHub did
 * not say "merged" does the head comparison get to speak, and its behaviour for
 * the case it was built for — a fix round that genuinely never pushed — is
 * untouched.
 */
function roundOutcome(mergeStatus, headBefore, headAfter) {
  if (mergeStatus === 'merged') return 'merged'
  return roundLanded(headBefore, headAfter) ? 'landed' : 'round-lost'
}

/**
 * THE TERMINAL RESULT OF A RUN WHOSE PR IS ALREADY MERGED (ISSUES #563).
 *
 * A SUCCESS, EXPLICITLY. `ok`/`verdict: 'APPROVE'`/`blockKind: 'none'` because the
 * change shipped — the thing every other terminal path is trying to reach.
 *
 * `prMerged: true` IS THE FIELD THE OUTER LOOP KEYS ON, and it exists because
 * "APPROVE" alone would send `applyResult` down the merge path and run a SECOND
 * `gh pr merge` against an already-merged PR — which fails, and would record this
 * successful run as `merge failed`. The outer reads this flag BEFORE the verdict
 * branches and finishes the run without touching the remote.
 *
 * NO `reviewedHead`, deliberately: that field exists only to pin a merge with
 * `--match-head-commit`, and there is no merge left to pin. Recording one here
 * could only invite the second merge this flag exists to prevent.
 *
 * `remainingTasks: 0` so a Ralph run does NOT re-fire the next task: the PR it
 * would build onto is merged and its branch is gone.
 */
function mergedTerminalResult(prNumber, branch, round) {
  return {
    ok: true,
    prNumber: prNumber === undefined ? null : prNumber,
    branch,
    verdict: 'APPROVE',
    round,
    checkpoint: 'pr-merged',
    prMerged: true,
    remainingTasks: 0,
    blockKind: 'none',
  }
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
 * The merge probe's report (#563). Identical shape to CI_PROBE_SCHEMA and for the
 * same reason: the agent runs ONE fixed command and hands back its output + exit
 * status VERBATIM, and `classifyPrMerged` — not a model — decides what it means.
 */
const PR_MERGE_PROBE_SCHEMA = {
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

// These are the repository jobs that establish that the change was actually
// exercised. Reading names is intentional: counting successful rows made a PR
// with only CodeQL look healthy when the conflicting branch had prevented the
// workflow containing these jobs from starting at all.
const REVIEW_REQUIRED_CHECKS = Object.freeze(['test', 'lint', 'typecheck'])

// HOW LONG THE GATE WAITS FOR A REQUIRED CHECK — A MEASURED BUDGET, NOT A GUESS.
//
// MEASURED 2026-08-15 on rjunee/neutron PR #275, commit 6ba7500:
//     pushed                00:55:56Z
//     check `test` STARTED  01:01:24Z   (+328 s — GitHub Actions QUEUE time)
//     check `test` finished 01:01:28Z   (+332 s — the job itself runs in 4 s)
//
// Essentially the whole delay is queueing. Until the workflow is created the check
// is not merely unfinished, it is ABSENT from `statusCheckRollup` — so the gate is
// asking about a row that does not exist yet, which is why waiting (not failing) is
// the only correct response.
//
// THE OLD BUDGET WAS 3 x 15 s = 30 SECONDS, against a check that takes five and a
// half minutes to appear. It could not win, and it did not: FOUR consecutive builds
// of one card (051bcf1f, b122ce3d, 45400961, 0d54d2a3) died with
// `REVIEW DEFERRED — required check test has not run`. Each threw away a COMPLETE
// build — Forge, plan, publish — to avoid a wait of a few minutes, and each was
// reported to the owner as REQUEST_CHANGES on work no reviewer had read.
//
// It is deterministic rather than unlucky, and the reason is worth stating: a build's
// LAST act before this gate is pushing its closing commit, so it invalidates the CI
// it was green on and then asks about the new head seconds later. Any budget shorter
// than the queue time fails EVERY time, on EVERY build.
//
// 15 minutes is ~3x the measured 328 s. Deliberately generous rather than finely
// tuned — a tuned number is what failed, and the same lesson is written into
// `trident/liveness.ts` after a 25-minute reaper killed a healthy build. The cost of
// being generous is a probe on the Bookkeeping tier every 30 s; the cost of being
// tight is an entire build.
//
// A check still absent after the budget IS a real stop with a real reason: the
// workflow genuinely never started, and that needs a human, not another wait.
const REVIEW_READINESS_BUDGET_MS = 900000
const REVIEW_READINESS_RETRY_MS = 30000
// Derived, never hand-written — a count and a duration that can disagree is how the
// doc comment above comes to describe a budget the loop does not actually have. The
// +1 is the FIRST probe, which happens before any wait.
const REVIEW_READINESS_ATTEMPTS = Math.ceil(REVIEW_READINESS_BUDGET_MS / REVIEW_READINESS_RETRY_MS) + 1

// The budget as a human duration, derived from the same constant the loop spends —
// so the sentence the owner reads cannot claim a wait the gate did not perform.
//
// A LINE COMMENT ON PURPOSE. `__tests__/ci-gate.test.ts` extracts the classifyCi
// closure by slicing from `const CI_FAILED_STATES` to the next JSDoc opener, so
// starting a doc block here silently truncates that slice and `probeCause` vanishes
// from the evaluated environment — four unrelated tests go red with a bare
// ReferenceError, and nothing points at the comment that caused it. (Writing the
// opener sequence inside a line comment does it too; that is not hypothetical
// either.) Both loaders now assert what they captured, and keeping this a `//` keeps
// the boundary where every reader expects it.
function readinessBudgetLabel() {
  const minutes = REVIEW_READINESS_BUDGET_MS / 60000
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minutes`
}

// MEASURE THE CAUSE, AND HAVING MEASURED IT, DO NOT THROW IT AWAY (#240). Run
// 8417b277 held `To get started with GitHub CLI, please run: gh auth login` in the
// probe's `raw` and discarded it, so the stored reason blamed the review rounds for a
// build no review seat ever judged.
//
// Mirror redactPushError's two patterns (trident/orchestrator.ts:358) locally — this
// file cannot import TS. A probe's raw output is where an echoed remote URL or token
// would surface; the text is carried through this or not at all.
function redactProbeText(text) {
  return String(text)
    .replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@')
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
}
// The first non-empty line(s) of what the probe actually said, redacted + capped.
// '' when there is nothing usable (caller then keeps its bare generic reason).
function probeCause(raw) {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return ''
  return redactProbeText(lines.slice(0, 2).join(' ')).slice(0, 200)
}

/** Classify the fixed `gh pr view` readiness probe before any review seat runs. */
function classifyReviewReadiness(probe) {
  // No probe object at all → there is no `raw` to quote, so the bare sentence stands.
  if (probe === null || typeof probe !== 'object') return { status: 'unknown', reason: 'PR readiness could not be read' }
  const raw = typeof probe.raw === 'string' ? probe.raw : ''
  const exit = typeof probe.exit_code === 'number' ? probe.exit_code : -1
  // Every unreadable branch below QUOTES the probe instead of summarising it: the
  // difference between "could not be read" and "run: gh auth login" is the difference
  // between a mystery and a repair. Redacted + capped at the source.
  const unreadable = () => {
    const cause = probeCause(raw)
    return {
      status: 'unknown',
      reason: cause === '' ? 'PR readiness could not be read' : 'PR readiness could not be read: ' + cause,
    }
  }
  if (exit !== 0) return unreadable()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return unreadable()
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return unreadable()
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.statusCheckRollup)) {
    return unreadable()
  }
  const mergeable = typeof parsed.mergeable === 'string' ? parsed.mergeable.toUpperCase() : ''
  if (mergeable === 'CONFLICTING') {
    return { status: 'conflicting', reason: 'PR is conflicting with base' }
  }
  if (mergeable !== 'MERGEABLE') {
    return { status: 'pending', reason: 'PR mergeability is still being calculated' }
  }
  const byName = new Map()
  for (const row of parsed.statusCheckRollup) {
    const name = row && typeof row.name === 'string' ? row.name : ''
    if (REVIEW_REQUIRED_CHECKS.includes(name)) byName.set(name, row)
  }
  for (const name of REVIEW_REQUIRED_CHECKS) {
    if (!byName.has(name)) return { status: 'absent', reason: `required check ${name} has not run` }
  }
  for (const name of REVIEW_REQUIRED_CHECKS) {
    const row = byName.get(name)
    const status = row && typeof row.status === 'string' ? row.status.toUpperCase() : ''
    const conclusion = row && typeof row.conclusion === 'string' ? row.conclusion.toUpperCase() : ''
    if (conclusion === 'SKIPPED') {
      return { status: 'absent', reason: `required check ${name} has not run (reported SKIPPED)` }
    }
    if (status !== 'COMPLETED' || conclusion === '') {
      return { status: 'pending', reason: `required check ${name} is still running` }
    }
  }
  const failed = REVIEW_REQUIRED_CHECKS.filter((name) => {
    const conclusion = String(byName.get(name)?.conclusion || '').toUpperCase()
    return conclusion !== 'SUCCESS' && conclusion !== 'NEUTRAL'
  })
  return { status: failed.length > 0 ? 'failed' : 'passed', reason: '', failed }
}

/**
 * Retry only readiness, never the review round. `spend` is unreachable until the
 * PR is mergeable and every named check has produced a terminal result.
 */
async function reviewWithPreconditions({ probe, spend, wait, attempts = REVIEW_READINESS_ATTEMPTS }) {
  let readiness = { status: 'unknown', reason: 'PR readiness could not be read' }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    readiness = await probe(attempt)
    if (readiness.status === 'passed' || readiness.status === 'failed') {
      return { deferred: false, readiness, value: await spend() }
    }
    if (readiness.status === 'conflicting' || readiness.status === 'unknown') break
    if (attempt < attempts) await wait()
  }
  return { deferred: true, readiness, value: null }
}

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
  // `cause` on the unknown branches is the probe's OWN words (redacted + capped) —
  // `ciDeferredPeer` quotes it so "could not tell" names what it could not tell.
  if (probe === null || typeof probe !== 'object') return { status: 'unknown', failing: [], cause: '' }
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
    return { status: 'unknown', failing: [], cause: probeCause(raw) }
  }
  let rows
  try {
    rows = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { status: 'unknown', failing: [], cause: probeCause(raw) }
  }
  if (!Array.isArray(rows)) return { status: 'unknown', failing: [], cause: probeCause(raw) }
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
  const said = typeof ci.cause === 'string' && ci.cause !== '' ? `the probe said: "${ci.cause}". ` : ''
  return {
    name: 'CI',
    title: 'CI status UNREADABLE — refusing to silently APPROVE',
    evidence:
      said +
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
 * The message the run reports when a fix round LANDED but produced no diff.
 *
 * A different fault from the one above and a different recovery, which is why it is a
 * different finding rather than a reworded one: the round's work is committed and on
 * the branch — `roundLanded` just confirmed it — so there is nothing to recover. What
 * is missing is the artefact the review panel reads. Round 1 refuses to open a panel
 * on an empty diff because five reviewers paid to APPROVE nothing is the worst outcome
 * available; this applies the same refusal to every later round.
 */
function roundLeftNoDiffFinding(round) {
  return {
    severity: 'blocker',
    title: `PROCESS — fix round ${round} landed on the branch but produced no diff`,
    evidence:
      `round ${round}'s commit IS on the branch, so its work is not lost — but the round reported no ` +
      'diff file, and the review panel reads the diff and nothing else. Opening it would pay five ' +
      'reviewers to read an empty or missing file and report that they found nothing wrong with it, ' +
      'which is an APPROVE of a diff no one saw rather than of a change no one made. Regenerate the ' +
      'branch diff (`git diff <base>..HEAD`) and re-review; no work needs recovering.',
  }
}

// The one-line measured cause of an infra-only stop — the LANE finding's own title,
// which quotes the probe (reviewPreconditionDeferred / synthesisUnavailable / the
// cross-model gate all stamp kind: LANE_FINDING_KIND). '' when none exists.
//
// This is the signal `innerTerminalFailureReason` (trident/orchestrator.ts) has been
// waiting for: it has always refused to INFER a cause from (round, checkpoint), and
// rightly — so the cause must be measured HERE, where it is known, or nowhere.
function infraTerminalCause(synthesis) {
  const findings = synthesis && Array.isArray(synthesis.findings) ? synthesis.findings : []
  const lane = findings.find((f) => f && f.kind === LANE_FINDING_KIND && typeof f.title === 'string' && f.title !== '')
  const any = lane || findings.find((f) => f && typeof f.title === 'string' && f.title !== '')
  return any ? redactProbeText(any.title).slice(0, 300) : ''
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
  // Through `seatAttempt` for the same reason the review seats are: a probe agent that
  // DIES must not end the lane. This probe's own contract already says what an error
  // means — "report head='' if it prints nothing or errors" — and a `null` reads as
  // exactly that '' below, so the round stops as one that did not land (fail-closed,
  // and the operator is told which round to recover) instead of crashing with no
  // verdict at all.
  const res = await seatAttempt(`head-probe-round-${round}`, () =>
    agent(
      `Run EXACTLY this single Bash command and report the sha it prints via the schema. Report head='' if it prints nothing or errors. Do NOT interpret the value, do NOT run anything else, do NOT modify any file.
${cmd}`,
      withModel({ label: `head-probe-round-${round}`, phase: 'Build', schema: BRANCH_HEAD_SCHEMA }),
    ),
  )
  return (res && typeof res.head === 'string' ? res.head : '').trim()
}

/** The one fact the resume-diff step returns: how big the diff it wrote is. */
const RESUME_DIFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bytes'],
  properties: {
    /** Size of the written diff in bytes, or 0 when the command produced none. */
    bytes: { type: 'number' },
  },
}

/**
 * Regenerate the review diff for a resumed run, FROM THE RECORDED OID.
 *
 * A resume that skips the build has no Forge result, so it has no `diffFile`
 * either — and the reviewers need one. The diff is therefore taken against the
 * recorded commit BY OID (`git diff <base>..<oid>`), never against the branch
 * NAME: the branch is a moving target, and a push landing between the head
 * comparison and this command would silently swap the code under review while the
 * run went on believing it had verified the head. Naming the OID makes those two
 * steps talk about the same commit by construction — the same property
 * `forge.commitSha` + `forge.diffFile` have because one agent reports both.
 *
 * An empty/failed diff returns '' and the caller falls back to a full rebuild: a
 * resume that cannot show the reviewers the code must not pretend to review it.
 */
async function writeResumeDiff(headOid) {
  const out = `/tmp/trident-${slug}-resume-${headOid.slice(0, 12)}.diff`
  // In pr mode the recorded OID may not be in the local object store yet (the run
  // that pushed it died on another process); fetch first, tolerating failure so
  // local mode and an already-present object both still work.
  const fetchStep = isPr
    ? `(git fetch origin ${shSingleQuote(forgeBranch)} 2>/dev/null || true) && `
    : ''
  const cmd = `cd ${shSingleQuote(repoPath)} && ${fetchStep}git diff ${shSingleQuote(baseBranch)}..${shSingleQuote(headOid)} > ${shSingleQuote(out)} && wc -c < ${shSingleQuote(out)}`
  const res = await agent(
    `Run EXACTLY this single Bash command and report the number it prints (the diff's size in bytes) via the schema. Report bytes=0 if it prints nothing or errors. Do NOT interpret the value, do NOT run anything else, do NOT modify any other file.
${cmd}`,
    withModel({ label: 'resume-diff', phase: 'Build', schema: RESUME_DIFF_SCHEMA }),
  )
  const bytes = res && typeof res.bytes === 'number' && Number.isFinite(res.bytes) ? res.bytes : 0
  return bytes > 0 ? out : ''
}

/**
 * COMPOSE A GITHUB READ SO IT CARRIES THE INSTANCE CREDENTIAL.
 *
 * Every `gh` read in this file goes through here. `ghArgs` is the already-composed
 * tail (e.g. `pr view 261 --json mergeable,statusCheckRollup`); the result is a
 * shell command the subagent's Bash tool runs.
 *
 * WHY. These probes are executed by an `agent(...)`'s Bash tool, which inherits the
 * warm trident-fire REPL's environment — and that REPL has no `GH_TOKEN`. The
 * WRITES (the outer publisher's push) carry the credential through `run_host`; the
 * READS carried nothing. Measured 2026-08-14 on run `8417b277`: the readiness probe
 * answered "To get started with GitHub CLI, please run: gh auth login", the round
 * deferred, and the build was recorded as REQUEST_CHANGES for code no review seat
 * ever opened. `trident/gh-authed.ts` resolves the token from the SecretsStore per
 * command and puts it in the `gh` child's environment only — never on disk, never
 * in argv, never in a line this workflow logs.
 *
 * FALLS BACK TO BARE `gh` when any coordinate is missing (local mode, a legacy
 * caller, a dry source check), so behaviour without the new args is unchanged.
 */
function ghReadCommand(ghArgs) {
  const threaded =
    typeof ghAuthedScript === 'string' &&
    ghAuthedScript.length > 0 &&
    typeof ghDataDir === 'string' &&
    ghDataDir.length > 0 &&
    typeof ghOwnerHandle === 'string' &&
    ghOwnerHandle.length > 0 &&
    typeof dbPath === 'string' &&
    dbPath.length > 0 &&
    typeof bunBin === 'string' &&
    bunBin.length > 0
  if (!threaded) return `gh ${ghArgs}`
  return `${shSingleQuote(bunBin)} ${shSingleQuote(ghAuthedScript)} --db ${shSingleQuote(dbPath)} --data-dir ${shSingleQuote(ghDataDir)} --owner ${shSingleQuote(ghOwnerHandle)} -- ${ghArgs}`
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
  const cmd = `cd ${shSingleQuote(repoPath)} && ${ghReadCommand(`pr checks ${String(prForCi)} --json name,state,link`)} 2>&1; echo "___EXIT=$?"`
  // THE PROBE IS A SEAT TOO — its agent can die exactly as a reviewer's can, and an
  // unguarded rejection here ended the whole lane. Through `seatAttempt` it becomes
  // `null`, which `classifyCi` already reads as 'unknown': a deferred CI peer, so the
  // round blocks and reports "we could not tell" instead of crashing (and never
  // merges on a build nobody read).
  const res = await seatAttempt(`ci-probe-round-${round}`, () =>
    agent(
      `Run EXACTLY this single Bash command and report its output through the schema. Put the FULL stdout+stderr in \`raw\` VERBATIM, and the number after ___EXIT= in \`exit_code\`. Do NOT interpret the result, do NOT decide whether CI passed, do NOT run anything else, do NOT modify any file.
${cmd}`,
      withModel({ label: `ci-probe-round-${round}`, phase: 'Review', schema: CI_PROBE_SCHEMA }),
    ),
  )
  return classifyCi(res)
}

/** Read mergeability and the NAMES of checks that ran, before dispatching review. */
async function probeReviewReadiness(prForReview, round, attempt) {
  if (!isPr || prForReview === null || prForReview === undefined) {
    return { status: 'passed', reason: '', failed: [] }
  }
  const cmd = `cd ${shSingleQuote(repoPath)} && ${ghReadCommand(`pr view ${String(prForReview)} --json mergeable,statusCheckRollup`)} 2>&1; echo "___EXIT=$?"`
  const res = await seatAttempt(`review-readiness-r${round}-attempt-${attempt}`, () =>
    agent(
      `Run EXACTLY this single Bash command and report its output through the schema. Put the FULL stdout+stderr in \`raw\` VERBATIM, and the number after ___EXIT= in \`exit_code\`. Do NOT interpret mergeability or checks, do NOT run anything else, do NOT modify any file.\n${cmd}`,
      withModel({ label: `review-readiness-r${round}-${attempt}`, phase: 'Review', schema: CI_PROBE_SCHEMA }),
    ),
  )
  return classifyReviewReadiness(res)
}

function reviewPreconditionDeferred(readiness) {
  return {
    verdict: 'REQUEST_CHANGES',
    blockKind: 'infra-only',
    findings: [
      {
        severity: 'blocker',
        kind: LANE_FINDING_KIND,
        title: `REVIEW DEFERRED — ${readiness.reason}`,
        evidence:
          `${readiness.reason}. No review seat was dispatched and no review round was consumed. ` +
          (readiness.status === 'conflicting'
            ? 'Update the branch against its base and resolve the conflict, then re-run.'
            : // SAY HOW LONG IT WAITED. Without the duration these two read exactly
              // like the 30-second version that gave up before GitHub had queued the
              // job, so the owner cannot tell "we did not wait" from "we waited and it
              // never came" — and only the second one is his problem to act on.
              readiness.status === 'absent'
              ? `The readiness gate waited ${readinessBudgetLabel()} and the check never appeared, so the workflow did not start. Restore or re-trigger that workflow job, then re-run.`
              : readiness.status === 'pending'
                ? `The readiness gate waited ${readinessBudgetLabel()} without incrementing the round and the check was still running; re-run once it completes.`
                : 'Restore access to the PR readiness data, then re-run.'),
      },
    ],
  }
}

async function runReviewRound(diffFile, round, prForReview, paidReview = null) {
  // A matching recorded REQUEST_CHANGES checkpoint already paid for this panel.
  // Its findings are the input to the next fix, so neither readiness nor review
  // is dispatched again.
  if (paidReview !== null) return paidReview
  const gated = await reviewWithPreconditions({
    probe: (attempt) => probeReviewReadiness(prForReview, round, attempt),
    spend: () => reviewRoundOrInfraBlock(() => reviewAndSynthesize(diffFile, round, prForReview)),
    wait: () => new Promise((resolve) => setTimeout(resolve, REVIEW_READINESS_RETRY_MS)),
  })
  if (!gated.deferred) return gated.value
  log(`trident-v2 review deferred: round=${round} reason=${gated.readiness.reason}`)
  return reviewPreconditionDeferred(gated.readiness)
}

/**
 * ASK GITHUB WHETHER THIS PR IS MERGED (ISSUES #563). One command, output reported
 * verbatim, every judgement made in JS by `classifyPrMerged`.
 *
 * Same shape and same reasoning as the head and CI probes: the agent is told to run
 * one thing and transcribe it, never to decide what it means. "Is the PR merged?"
 * asked of a model is a question it can answer plausibly and wrongly, and a wrong
 * "yes" ends a live run.
 *
 * LOCAL MODE AND A PR-LESS BUILD REPORT 'not-merged' WITHOUT SPENDING AN AGENT.
 * There is no PR to read, and in local mode the only merge is the outer loop's
 * `mergeLocal`, which runs strictly AFTER this workflow's terminal result is
 * harvested — so it cannot race the loop the way a PR merge can.
 */
async function probePrMerged(prForProbe, roundTag) {
  if (!isPr || prForProbe === null || prForProbe === undefined) return 'not-merged'
  const cmd = `cd ${shSingleQuote(repoPath)} && ${ghReadCommand(`pr view ${String(prForProbe)} --json state,mergedAt`)} 2>&1; echo "___EXIT=$?"`
  const res = await agent(
    `Run EXACTLY this single Bash command and report its output through the schema. Put the FULL stdout+stderr in \`raw\` VERBATIM, and the number after ___EXIT= in \`exit_code\`. Do NOT interpret the result, do NOT decide whether the PR is merged, do NOT run anything else, do NOT modify any file.
${cmd}`,
    withModel({ label: `merge-probe-round-${roundTag}`, phase: 'Build', schema: PR_MERGE_PROBE_SCHEMA }),
  )
  const status = classifyPrMerged(res)
  // PRINT THE FIELDS BEFORE ANYTHING IS KEYED ON THEM — the classification and the
  // raw line it came from, so a run that terminated (or did not) can be audited
  // from the log alone rather than from a re-run.
  const first = (res && typeof res.raw === 'string' ? res.raw : '').trim().split('\n')[0] || '(no output)'
  log(`trident-v2 merge-probe (${roundTag}): pr=#${String(prForProbe)} status=${status} raw[0]=${first}`)
  return status
}

/**
 * A CROSS-MODEL SEAT'S STATUS, DERIVED FROM WHETHER IT WAS CONFIGURED — never read
 * off a verdict that may not exist.
 *
 * THE BUG THIS REPLACES FAILED OPEN, which is the direction that ships unreviewed
 * code. The caller used to write, for each optional peer:
 *
 *     codexSlot !== null && verdicts[codexSlot]
 *       ? verdicts[codexSlot]
 *       : { verdict: 'COMMENT', findings: [], codexStatus: 'not_connected' }
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
function crossModelPeerStatus(slot, verdicts, statusKey) {
  if (slot === null || slot === undefined) return 'not_connected'
  const verdict = verdicts[slot]
  const status = verdict && typeof verdict[statusKey] === 'string' ? verdict[statusKey] : ''
  if (statusKey === CORE_SEAT_STATUS_KEY) return status.length > 0 ? 'connected' : 'deferred'
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
 * cross-model peers ("POSITIONAL INDEXING WAS A LATENT BUG" — codexSlot is recorded
 * as `reviewers.length` at push time for exactly this reason). Insert a reviewer at
 * the HEAD of the panel and the literals point at the wrong seats: the new reviewer
 * is ungated (fail-OPEN, the shape of #536 all over again) and the panel labels are
 * misassigned, so Verdict A is described to the synthesis model as the wrong review.
 * The claim "a seat added later is enforced by construction" was only true if the
 * slot was DERIVED, so it is: `pushCoreReviewer` records `reviewers.length` at the
 * moment it pushes, and carries the seat's prompt letter + label with it.
 *
 * `statusKey: 'verdict'` is the field whose presence proves the seat ANSWERED — the
 * core analogue of `codexStatus`/`kimiStatus` — so a dead core seat is retryable by
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
    const verdict = verdicts[seat.slot]
    const completed = seat.statusKey === 'codexStatus'
      ? verdict && verdict.codexStatus === 'connected' && hasUsableVerdict(verdict)
      : hasUsableVerdict(verdict)
    if (completed) continue
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

// Which cross-model peers were configured but failed. Kept separate from the gate
// so the mapping status → blocker text is readable and testable on its own.
function deferredCrossModelPeers(statuses, routes) {
  routes = routes || {}
  const out = []
  if (statuses.codex === 'deferred') {
    const family = routes.codex?.group || 'codex'
    out.push(family === 'codex' ? {
      name: 'Codex', title: 'Codex cross-model review DEFERRED — refusing to silently APPROVE',
      evidence: 'codex was configured (CODEX_HOME set) but NO REVIEW HAPPENED: the auth precheck failed, the call failed/timed out, or the diff was EMPTY so there was nothing to review (CODEX_REVIEW_EMPTY_DIFF — the diff file failed to write or the base ref resolved wrong). Per the never-silent-downgrade rule a deferred cross-model review cannot be treated as an approval. Read the wrapper stderr for WHICH of those it was before re-running — an empty diff is NOT an auth problem.',
    } : {
      name: `Cross-model review 1 (${family === 'claude' ? 'Claude' : 'Kimi K3'})`,
      title: `Cross-model review 1 (${family === 'claude' ? 'Claude' : 'Kimi K3'}) DEFERRED — refusing to silently APPROVE`,
      evidence: `The explicitly selected ${family} reviewer was dispatched but failed or returned no usable verdict. It was not replaced by another model family; the incomplete panel cannot APPROVE.`,
    })
  }
  if (statuses.kimi === 'deferred') {
    const family = routes.kimi?.group || 'kimi'
    out.push(family === 'kimi' ? {
      name: 'Kimi K3',
      title: 'Kimi K3 cross-model review DEFERRED — refusing to silently APPROVE',
      evidence:
        'a Kimi API key was configured but the review call failed, timed out, or returned no answer text (the thinking-budget case). A deferred cross-model review cannot be treated as an approval, and there is deliberately NO fallback to a Claude-family reviewer — that would restore the single-family panel this peer exists to break.',
    } : {
      name: `Cross-model review 2 (${family === 'claude' ? 'Claude' : 'Codex'})`,
      title: `Cross-model review 2 (${family === 'claude' ? 'Claude' : 'Codex'}) DEFERRED — refusing to silently APPROVE`,
      evidence: `The explicitly selected ${family} reviewer was dispatched but failed or returned no usable verdict. It was not replaced by another model family; the incomplete panel cannot APPROVE.`,
    })
  }
  return out
}

// What the synthesis is TOLD about Verdict C. Hoisted out of the synthesis call for
// the same reason `deferredCrossModelPeers` is: the mapping status → panel text is
// the load-bearing part, and it is testable on its own.
//
// THE TRUNCATED CASE IS WHY THIS IS A FUNCTION. The wrapper caps the diff at its
// line limit and tells the MODEL so; but the model's answer still arrives as a
// verdict with no scope attached, and the synthesis then read "codex APPROVE" as a
// cross-model approval of the whole change when codex had seen its first 3000 lines.
// The FACT itself is decided by a grep the bridge command runs (see
// codexReviewerPrompt), not by GPT-5 judging its own coverage — so the re-scoping
// stops depending on the reviewer having remembered to hedge.
//
// WHAT THIS IS AND IS NOT. Be precise about the strength of this guard, because the
// comment that used to sit here ("deterministic") overstated it: the flag still
// TRAVELS through the codex agent copying the CODEX_TRUNCATED line into a schema
// field, and what it buys is PROMPT TEXT for the synthesis model. It is NOT a hard
// gate like 'deferred' (enforceCrossModelGate / deferredCrossModelPeers), and a
// truncated codex APPROVE with every other seat APPROVE can still merge.
//
// Which is exactly why the DEFAULT is fail-safe. The "full third panelist" framing
// — the one that lets a codex APPROVE offset another reviewer's doubt — is earned
// ONLY by an explicit boolean `false`. A missing field, a stringified 'true'/'false',
// null: every one of those is a flag that did not arrive, and an unknown scope is
// read as a PARTIAL one. This mirrors crossModelPeerStatus, where a configured seat
// with no status defaults to 'deferred' rather than to the permissive answer.
function codexPanelLine(status, review) {
  if (status === 'deferred') {
    return `Verdict C (codex cross-model): DEFERRED — codex was configured but NO REVIEW HAPPENED (auth precheck failed, the call FAILED/timed out, or the diff was EMPTY so there was nothing to review). Per the never-silent-downgrade rule, do NOT return APPROVE; surface the deferral.`
  }
  if (status !== 'connected') {
    return `Verdict C (codex cross-model): NOT CONNECTED — no codex credential for this project, so this is a Claude-only review. Note "codex not connected" and proceed on Verdicts A+B (do NOT block on codex).`
  }
  if (review && review.codexTruncated === true) {
    return `Verdict C (codex cross-model, GPT-5) — PARTIAL, SCOPED TO PART OF THE DIFF: ${JSON.stringify(review)}. The wrapper TRUNCATED the diff at its line cap (CODEX_REVIEW_DIFF_TRUNCATED), so codex read only the FIRST lines of this change and NEVER SAW the rest. Its blockers still VETO APPROVE, but a codex APPROVE here means ONLY "no blocker in the portion codex read" — do NOT record it as a whole-change cross-model approval, do NOT let it offset a finding in code codex never saw, and SAY in your findings that the cross-model review covered only part of the diff.`
  }
  if (!review || typeof review.codexTruncated !== 'boolean') {
    return `Verdict C (codex cross-model, GPT-5) — PARTIAL, SCOPE UNKNOWN: ${JSON.stringify(review)}. The bridge did NOT report whether the wrapper truncated the diff (codexTruncated is missing or not a boolean), so it is UNKNOWN whether codex saw the whole change. Treat it exactly as a truncated review: its blockers still VETO APPROVE, but its APPROVE is NOT a whole-change cross-model approval, must not offset a finding elsewhere in the diff, and you must SAY in your findings that the cross-model review's coverage could not be confirmed.`
  }
  return `Verdict C (codex cross-model, GPT-5): ${JSON.stringify(review)} — treat as a full third panelist; an evidence-backed codex blocker VETOES APPROVE.`
}


// The codex cross-model reviewer prompt. It shells out to the wrapper
// (trident/codex-review.sh) SYNCHRONOUSLY in the foreground (never backgrounded)
// with the per-project CODEX_HOME, then maps the wrapper's EXIT CODE to a
// CODEX_VERDICT_SCHEMA result. Only built when a codex credential is configured.
function codexReviewerPrompt(diffFile) {
  const opts = arguments[1] || {}
  // GLOBALLY-UNIQUE temp files: trident runs detached workflows concurrently and
  // slugs are only unique WITHIN a project, so two same-slug runs in different
  // projects would collide on /tmp and cross-read each other's verdict. Key on
  // runId (uuid) — matching writeTerminalResult's /tmp/trident-terminal-${runId}
  // — falling back to slug only for a dry source check with no runId (Codex [P2]).
  const uniq = runId || slug
  const lane = opts.adversarial === true ? 'adversarial' : opts.lane || 'cross-model'
  const outFile = opts.adversarial === true || opts.lane
    ? `/tmp/trident-codex-${lane}-${uniq}.out`
    : `/tmp/trident-codex-${uniq}.out`
  const errFile = opts.adversarial === true || opts.lane
    ? `/tmp/trident-codex-${lane}-${uniq}.err`
    : `/tmp/trident-codex-${uniq}.err`
  const script = `${repoPath}/trident/codex-review.sh`
  const envPrefix = opts.adversarial === true
    ? `${ADVERSARIAL_CODEX_ENV_PREFIX}NEUTRON_CODEX_REVIEW_RUBRIC=${shSingleQuote(`You are ARGUS-ADVERSARIAL (independent, read-only). Independently try to REFUTE the change: hunt NaN/overflow/off-by-one edges, hidden invariants, and untested boundaries. Evidence-gate EVERY claim (file:line or a concrete repro). Do not substitute the generic second-opinion rubric.`)} `
    : opts.envPrefix || ''
  // Codex reviews the SAME diff FILE Forge wrote (as the other reviewers do), NOT
  // `git diff` in repoPath — repoPath is still on the base branch (Forge builds in
  // an isolated worktree), so a git-diff there would be empty/stale and codex
  // could approve without reviewing the change (Codex review [P2]).
  //
  // The command also GREPS the wrapper's stderr for the truncation marker and echoes
  // CODEX_TRUNCATED=0/1. The wrapper caps the diff at its line limit and discloses
  // that IN THE PROMPT, but a disclosure only the model sees is a disclosure the
  // WORKFLOW cannot act on: exit 0 is exit 0, so a review of the first 3000 lines of
  // an 11k-line diff came back as a clean whole-change APPROVE. The grep is what
  // makes it a FACT the synthesis is handed (see codexPanelLine), not a hope about
  // how GPT-5 worded its answer.
  return `You are the CODEX ${opts.adversarial === true ? 'ADVERSARIAL' : 'CROSS-MODEL'} REVIEW bridge for trident (read-only). ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}
Run EXACTLY this ONE synchronous foreground command from ${repoPath} (do NOT background it, do NOT add flags):
  ${envPrefix}CODEX_HOME=${shSingleQuote(codexHome || '')} NEUTRON_CODEX_DIFF_FILE=${shSingleQuote(diffFile)} bash ${shSingleQuote(script)} ${shSingleQuote(baseBranch)} > ${shSingleQuote(outFile)} 2> ${shSingleQuote(errFile)}; echo "CODEX_EXIT=$?"; if grep -q CODEX_REVIEW_DIFF_TRUNCATED ${shSingleQuote(errFile)}; then echo "CODEX_TRUNCATED=1"; else echo "CODEX_TRUNCATED=0"; fi
Read the CODEX_EXIT code, then map it to your result (read ${outFile}/${errFile} only as needed — tail, do not flood context):
- EXIT 0  → codexStatus='connected'. Parse the review in ${outFile}: set verdict=REQUEST_CHANGES if it ends 'VERDICT: REQUEST_CHANGES' or lists any evidence-backed blocker, else APPROVE. Convert its blockers into findings (severity/title/evidence).
- codexTruncated: copy the CODEX_TRUNCATED line VERBATIM — 1 → true, 0 → false. It is NOT your judgement call and NOT something to infer from the review text: it says whether codex was shown only the FIRST N lines of the diff. Report it truthfully even when the review reads like a clean approval; the synthesis re-scopes a truncated verdict itself.
- EXIT 10 or 11 → codexStatus='not_connected' (no credential / CLI). ${opts.adversarial === true ? "Return verdict='REQUEST_CHANGES' with one infrastructure finding: this configured core seat did not review." : "Return verdict='COMMENT', findings=[]. This is the GRACEFUL optional-peer path."}
- EXIT 3 or 5  → codexStatus='deferred' (codex was configured but the review could not be performed — auth precheck failed, an EMPTY diff left nothing to review, or the call FAILED/timed out). Return verdict='REQUEST_CHANGES' with ONE finding {severity:'major', title:'Codex review deferred', evidence:<tail of ${errFile}>}. NEVER report APPROVE for a deferred codex.
Return via the schema. NEVER exit silently — if the command itself could not run, return codexStatus='deferred' with the reason.`
}

// The Kimi K3 cross-model reviewer prompt. Mirrors the codex bridge: shell out
// SYNCHRONOUSLY to a CLI, map its EXIT CODE to a schema result. The CLI reads
// KIMI_API_KEY from its OWN environment, so the credential never appears here.
function kimiReviewerPrompt(diffFile) {
  const opts = arguments[1] || {}
  const uniq = runId || slug
  const lane = opts.lane || 'cross-model'
  const outFile = `/tmp/trident-kimi-${lane}-${uniq}.out`
  const errFile = `/tmp/trident-kimi-${lane}-${uniq}.err`
  const cli = `${repoPath}/trident/kimi-review-cli.ts`
  // Reviews the SAME diff FILE Forge wrote, for the same reason codex does:
  // repoPath is still on the base branch, so a `git diff` there would be empty
  // and the reviewer could approve without having reviewed the change.
  return `You are the KIMI K3 CROSS-MODEL REVIEW bridge for trident (read-only, an INDEPENDENT reviewer from a DIFFERENT MODEL FAMILY than Claude). ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}
Run EXACTLY this ONE synchronous foreground command from ${repoPath} (do NOT background it, do NOT add flags):
  ${opts.envPrefix || ''}bun run ${shSingleQuote(cli)} ${shSingleQuote(diffFile)} ${shSingleQuote(task)} > ${shSingleQuote(outFile)} 2> ${shSingleQuote(errFile)}; echo "KIMI_EXIT=$?"
Read the KIMI_EXIT code, then map it to your result (read ${outFile}/${errFile} only as needed — tail, do not flood context):
- EXIT 0  → kimiStatus='connected'. Parse the review in ${outFile}: set verdict=REQUEST_CHANGES if it ends 'VERDICT: REQUEST_CHANGES' or lists any evidence-backed blocker, else APPROVE. Convert its blockers into findings (severity/title/evidence).
- EXIT 10 → kimiStatus='not_connected' (no API key configured). Return verdict='COMMENT', findings=[]. This is the GRACEFUL path — do NOT invent findings.
- EXIT 2 or 3 → kimiStatus='deferred' (configured but the call FAILED, timed out, or returned no answer text). Return verdict='REQUEST_CHANGES' with ONE finding {severity:'major', title:'Kimi review deferred', evidence:<tail of ${errFile}>}. NEVER report APPROVE for a deferred reviewer, and NEVER substitute your own review for it.
Return via the schema. NEVER exit silently — if the command itself could not run, return kimiStatus='deferred' with the reason.`
}

// Parallel adversarial review + asymmetric-gated synthesis. Returns the
// synthesised verdict object (VERDICT_SCHEMA).
async function reviewAndSynthesize(diffFile, round, prForCi) {
  phase('Review')
  log(
    `trident-v2 review: round=${round} diff=${diffFile} codex=${codexConfigured ? 'configured' : 'not-connected'}`,
  )
  // The review PANEL: rubric + adversarial ALWAYS run; the codex
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
  // THE CORE SEATS RECORD THEIR OWN SLOT, like codexSlot/kimiSlot below — never a
  // literal 0/1 written down elsewhere (see CORE_SEAT_STATUS_KEY's docblock). The
  // seat carries everything the three readers need: the gate's blocker `name`, the
  // synthesis prompt's `letter`/`label`, and the `statusKey` the lane retry reads.
  const coreSeats = []
  const offSeats = []
  // EVERY seat is dispatched through `seatAttempt`, at the ONE place seats are
  // registered — so a seat added later cannot forget it, and a dying seat arrives as
  // the `null` the retry and the completeness gate already handle. `retryDeferredPeers`
  // re-invokes this very thunk, so the retry is guarded by the same wrapper.
  const pushCoreReviewer = (seat, run) => {
    coreSeats.push({ ...seat, slot: reviewers.length, statusKey: CORE_SEAT_STATUS_KEY })
    if (seat.statusKey) coreSeats[coreSeats.length - 1].statusKey = seat.statusKey
    reviewers.push(() => seatAttempt(seat.name, run))
  }
  const rubricRoute = routeModel('argus:claude')
  if (rubricRoute.disabled) offSeats.push('Rubric review')
  else pushCoreReviewer(
    { name: 'Argus rubric (core reviewer)', letter: 'A', panelLabel: 'Claude rubric' },
    () =>
      agent(
        `${ARGUS_RUBRIC}
Review the diff at ${diffFile} for the TASK below. Return your verdict + findings.
TASK: ${task}`,
        withModel({ label: 'argus:claude', phase: 'Review', schema: VERDICT_SCHEMA }),
      ),
  )
  const adversarialRoute = routeModel('argus:adversarial')
  if (adversarialRoute.disabled) offSeats.push('Adversarial review')
  else pushCoreReviewer(
    {
      name: 'Argus adversarial (core reviewer)',
      letter: 'B',
      panelLabel: 'Argus adversarial',
      statusKey: adversarialRoute.transport === 'cli' ? 'codexStatus' : CORE_SEAT_STATUS_KEY,
    },
    () => {
      if (adversarialRoute.transport === 'cli') {
        logCrossModelSpawn('argus:adversarial', 'codex-runtime')
        return agent(codexReviewerPrompt(diffFile, { adversarial: true }), {
          label: 'argus:adversarial',
          phase: 'Review',
          schema: CODEX_VERDICT_SCHEMA,
        })
      }
      return agent(
        `You are ARGUS-ADVERSARIAL (independent, read-only). ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE} ${NO_PATTERN_KILL_RULE}
Independently try to REFUTE the change at ${diffFile}: hunt NaN/overflow/off-by-one edges, hidden invariants, and untested boundaries. Evidence-gate EVERY claim (file:line or a concrete repro). Do NOT modify files. NEVER exit silently — if you cannot verify part of it, say so.
TASK: ${task}`,
        withModel({ label: 'argus:adversarial', phase: 'Review', schema: VERDICT_SCHEMA }),
      )
    },
  )
  let codexSlot = null
  let kimiSlot = null
  const slotOneRoute = routeModel('argus:codex')
  const slotTwoRoute = routeModel('argus:kimi')
  const routeAvailable = (route) => !route.group || route.group === 'claude' || (route.group === 'codex' ? codexConfigured : route.group === 'kimi' ? kimiConfigured : false)
  const claudePeerPrompt = (slot) => `${ARGUS_RUBRIC}
You are Cross-model review ${slot}, an independent, read-only reviewer. Review the diff at ${diffFile} for the TASK below. Apply the rubric adversarially, evidence-gate every claim with file:line or a concrete reproduction, and return your verdict + findings. Do NOT modify files.
TASK: ${task}`
  const peerPrompt = (label, route, slot) => {
    if (route.group === 'claude') return claudePeerPrompt(slot)
    const cliOpts = { lane: `seat-${slot}`, envPrefix: crossModelEnvPrefix(label) }
    return route.group === 'kimi' ? kimiReviewerPrompt(diffFile, cliOpts) : codexReviewerPrompt(diffFile, cliOpts)
  }
  const peerSchema = (route) => route.group === 'claude' ? VERDICT_SCHEMA : route.group === 'kimi' ? KIMI_VERDICT_SCHEMA : CODEX_VERDICT_SCHEMA
  const peerAgentOpts = (opts, route) => {
    return route.group === 'claude' ? withModel(opts) : opts
  }
  if (slotOneRoute.disabled) offSeats.push('Cross-model review 1')
  if (slotTwoRoute.disabled) offSeats.push('Cross-model review 2')
  if (!slotOneRoute.disabled && routeAvailable(slotOneRoute)) {
    // On a CLI route the thin Claude agent only shells out, so it keeps the launcher
    // default. On an explicitly selected Claude route, the seat itself reviews and
    // `withModel` applies the chosen tier below.
    // RB2 (b) — DELIBERATELY no `reflectionGuidance` here (two reasons): this thin
    // launcher only invokes the external codex CLI, whose GPT-5 review sees ONLY the
    // raw git diff (never this claude prompt text), so injecting owner corrections
    // would be inert; AND argus:codex is part of the independent MERGE GATE, which
    // must never carry the untrusted reflection block (see the trust-boundary note
    // above the reviewers array).
    if (slotOneRoute.group !== 'claude') logCrossModelSpawn('argus:codex', 'codex-runtime')
    codexSlot = reviewers.length
    reviewers.push(() =>
      seatAttempt('argus:codex', () =>
        agent(peerPrompt('argus:codex', slotOneRoute, 1), peerAgentOpts({ label: 'argus:codex', phase: 'Review', schema: peerSchema(slotOneRoute) }, slotOneRoute)),
      ),
    )
  }
  // The same route-dependent dispatch applies to seat 2: Kimi/Codex choices use the
  // corresponding CLI bridge, while an explicit Claude choice reviews in the agent.
  // RB2 (b) — DELIBERATELY no `reflectionGuidance`, for both reasons that exclude
  // argus:codex: K3 sees only the diff file (never this prompt text), so injecting
  // owner corrections would be inert; and this is part of the independent MERGE
  // GATE, which must never carry the untrusted reflection block.
  if (!slotTwoRoute.disabled && routeAvailable(slotTwoRoute)) {
    if (slotTwoRoute.group !== 'claude') logCrossModelSpawn('argus:kimi', 'kimi-runtime')
    kimiSlot = reviewers.length
    reviewers.push(() =>
      seatAttempt('argus:kimi', () =>
        agent(peerPrompt('argus:kimi', slotTwoRoute, 2), peerAgentOpts({ label: 'argus:kimi', phase: 'Review', schema: peerSchema(slotTwoRoute) }, slotTwoRoute)),
      ),
    )
  }
  // THE BUILD COUNTS AS A FAMILY. It is not a review seat, but the property this
  // warning protects is "the reviewer is not the same family as what produced the
  // code" — build on GPT with Opus reviewing IS the cross-family panel the design
  // wants (SPEC Decisions Log 2026-08-14, "any tier in any slot"). Excluding the
  // build would warn about a panel that is genuinely cross-family, and stay silent
  // when a Claude build is reviewed only by Claude.
  const enabledPanelFamilies = [routeModel('forge:build', 'reasoning'), rubricRoute, adversarialRoute, slotOneRoute, slotTwoRoute]
    .filter((route) => !route.disabled && routeAvailable(route))
    .map((route) => route.group || 'claude')
  if (enabledPanelFamilies.length > 1 && new Set(enabledPanelFamilies).size === 1) {
    log(`trident.panel-single-family WARNING family=${enabledPanelFamilies[0]} seats=${enabledPanelFamilies.length} configuration-accepted=true`)
  }
  let verdicts = await parallel(reviewers)
  // Retry ONLY a cross-model lane that came back `deferred`, before any of this is
  // read. A flaked lane costs one more call here; letting it through costs a whole
  // round of four reviewers plus a pointless re-Forge (see retryDeferredPeers).
  //
  // THE CORE SEATS ARE RETRIED TOO. They were omitted, so the retry rationale above
  // ("an infra failure should not trigger four fresh LLM reviews") applied to the two
  // OPTIONAL peers and not to the two seats that always run: one transient
  // argus:claude crash produced an infra-only block, exited the loop on round 1, and
  // threw away the entire Forge build — the most expensive possible response to the
  // cheapest possible failure. A core seat's `statusKey` is `verdict` itself, so a
  // real review ('APPROVE'/'REQUEST_CHANGES') is never retried and only a seat that
  // produced nothing is. The retry re-runs the SEAT'S OWN THUNK rather than a second
  // copy of the prompt, so the retried review cannot drift from the original.
  verdicts = await retryDeferredPeers({
    verdicts,
    slots: [
      ...coreSeats,
      { name: 'argus:codex', slot: codexSlot, statusKey: slotOneRoute.group === 'claude' ? CORE_SEAT_STATUS_KEY : slotOneRoute.group === 'kimi' ? 'kimiStatus' : 'codexStatus' },
      { name: 'argus:kimi', slot: kimiSlot, statusKey: slotTwoRoute.group === 'claude' ? CORE_SEAT_STATUS_KEY : slotTwoRoute.group === 'kimi' ? 'kimiStatus' : 'codexStatus' },
    ],
    attempts: LANE_RETRY_ATTEMPTS,
    log,
    invoke: async (name) => {
      const core = coreSeats.find((s) => s.name === name)
      if (core) return await reviewers[core.slot]()
      const first = name === 'argus:codex'
      const label = first ? 'argus:codex-retry' : 'argus:kimi-retry'
      const route = first ? slotOneRoute : slotTwoRoute
      return await agent(peerPrompt(label, route, first ? 1 : 2), peerAgentOpts({ label, phase: 'Review', schema: peerSchema(route) }, route))
    },
  })
  // POSITIONAL INDEXING WAS A LATENT BUG. This read `verdicts[2]` for codex,
  // which held only while codex was the sole CONDITIONAL panelist. With a second
  // optional peer, a run with kimi configured and codex NOT would have read the
  // kimi verdict as the codex one — and since the shapes differ only by a status
  // field name, `codexStatus` would come back undefined and default to
  // 'not_connected', silently disarming the gate for a DEFERRED reviewer. So the
  // panel now records the slot each optional peer occupies as it is pushed.
  // CI is probed CONCURRENTLY with the reviewers: the push already happened, so the
  // checks are running while the panel reads the diff and the probe costs no extra
  // wall-clock.
  const ci = await probeCi(prForCi, round)
  log(`trident-v2 ci: round=${round} status=${ci.status} failing=${ci.failing.length}`)

  // PANEL COMPLETENESS IS DERIVED IN CODE. Every seat's status comes from whether it
  // was CONFIGURED (it has a slot) and whether it actually ANSWERED — never from a
  // default applied to a missing verdict, which is how a crashed reviewer used to read
  // as one that was never set up. See `crossModelPeerStatus` / `missingCoreReviewers`.
  const missingCore = missingCoreReviewers(verdicts, coreSeats)
  const codexStatus = crossModelPeerStatus(codexSlot, verdicts, slotOneRoute.group === 'claude' ? CORE_SEAT_STATUS_KEY : slotOneRoute.group === 'kimi' ? 'kimiStatus' : 'codexStatus')
  const kimiStatus = crossModelPeerStatus(kimiSlot, verdicts, slotTwoRoute.group === 'claude' ? CORE_SEAT_STATUS_KEY : slotTwoRoute.group === 'kimi' ? 'kimiStatus' : 'codexStatus')
  // Only read for the 'connected' panel line, where the verdict is present by
  // definition — a status of 'connected' can only come off a real verdict object.
  const codexReview = codexSlot === null ? null : verdicts[codexSlot]
  const kimiReview = kimiSlot === null ? null : verdicts[kimiSlot]

  // ASYMMETRIC GATING (minority-veto): findings BOTH reviewers confirm → confirmed;
  // ONE credible evidence-backed BLOCKER vetoes APPROVE; a single-reviewer
  // non-blocker → labelled `unverified` (surfaced, not merge-blocking). The codex
  // cross-model verdict is a full panelist when connected; a 'not_connected' codex
  // is noted + ignored; a 'deferred' codex is hard-gated below.
  phase('Synthesis')
  const peerRouteLabel = (route) => route.group === 'claude' ? `${route.group}/${route.model}` : route.group
  const peerPanelLine = (letter, slot, status, review, route, off) =>
    off
      ? `Verdict ${letter} (Cross-model review ${slot}): OFF — deliberately set to NONE; no reviewer was dispatched.`
      : status === 'connected'
        ? `Verdict ${letter} (Cross-model review ${slot}, ${peerRouteLabel(route)}): ${JSON.stringify(review)} — treat as a full panelist; an evidence-backed blocker VETOES APPROVE.`
        : status === 'deferred'
          ? `Verdict ${letter} (Cross-model review ${slot}, ${peerRouteLabel(route)}): DEFERRED — configured but the review failed or returned no usable verdict. Do NOT return APPROVE.`
          : `Verdict ${letter} (Cross-model review ${slot}, ${peerRouteLabel(route)}): NOT CONNECTED — its required credential is unavailable; note it and proceed.`
  const codexPanel = peerPanelLine('C', 1, codexStatus, codexReview, slotOneRoute, slotOneRoute.disabled)
  // NB: NO `reflectionGuidance` — the synthesis step is the verdict INTERPRETER of
  // the independent merge gate; the untrusted reflection block must never influence
  // how the panel's verdicts are merged (see the trust-boundary note above).
  const kimiPanelLine = peerPanelLine('D', 2, kimiStatus, kimiReview, slotTwoRoute, slotTwoRoute.disabled)
  // A CORE SEAT THAT DIED MUST NOT ARRIVE AS THE TOKEN `null` — see `corePanelLine`,
  // which is top-level (and behaviourally tested) rather than inlined here.
  // DERIVED FROM THE SAME `coreSeats` THE GATE READS, so a seat inserted at the head
  // of the panel cannot label Verdict A with the wrong reviewer's review (and cannot
  // be described to the model at all without also being gated).
  const corePanelLines = coreSeats
    .map((seat) => corePanelLine(seat.letter, seat.panelLabel, verdicts[seat.slot]))
    .join('\n')
  const offPanelLines = offSeats.map((seat) => `${seat}: OFF — deliberately set to NONE; no reviewer was dispatched and this seat does not block.`).join('\n')
  const runSynthesis = () =>
    agent(
      `Synthesise these INDEPENDENT review verdicts into ONE final verdict, applying ASYMMETRIC GATING:
- A finding MORE THAN ONE reviewer raises → keep it as confirmed.
- ONE credible, evidence-backed BLOCKER is enough to VETO APPROVE (minority-veto) → verdict REQUEST_CHANGES.
- A single-reviewer NON-blocking finding → keep it but label it 'unverified' (surface it; do NOT block merge on it alone).
- Only return APPROVE when NO reviewer left a credible evidence-backed blocker.
${corePanelLines}
${offPanelLines}
${codexPanel}
${kimiPanelLine}`,
      withModel({ label: 'argus:synthesis', phase: 'Synthesis', schema: VERDICT_SCHEMA }),
    )
  // THE SYNTHESIS SEAT IS RETRIED LIKE ANY OTHER, through the SAME bounded retry —
  // it is the one seat whose loss costs the whole round, and a 529 is transient. It is
  // dispatched as a one-slot panel whose `statusKey` is `verdict` itself (exactly as a
  // core seat's is), so a real verdict is never re-run and only a seat that produced
  // nothing is. An exhausted retry still yields no verdict, and `synthesisOrInfraBlock`
  // at the call site turns that into the infra block — a retry never turns into an
  // APPROVE, and never into a throw.
  const synthesisRaw = (
    await retryDeferredPeers({
      verdicts: [await seatAttempt('argus:synthesis', runSynthesis)],
      slots: [{ name: 'argus:synthesis', slot: 0, statusKey: 'verdict' }],
      attempts: LANE_RETRY_ATTEMPTS,
      log,
      invoke: runSynthesis,
    })
  )[0]
  // Deterministic never-silent-downgrade guard — a configured-but-failed codex
  // can NEVER become a silent APPROVE regardless of what the synthesis LLM said.
  // A NIT MAY NOT COST A ROUND — applied FIRST, so both gates below can re-block
  // anything it lets through. See enforceSeverityGate for why the ordering is the
  // load-bearing part rather than an implementation detail.
  const severityGated = enforceSeverityGate(synthesisRaw)
  const deferred = deferredCrossModelPeers({ codex: codexStatus, kimi: kimiStatus }, {
    codex: slotOneRoute,
    kimi: slotTwoRoute,
  })
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
  const reviewRecord = offSeats.length === 4
    ? 'NO REVIEW RAN — all four review seats were deliberately set to NONE; merge relied on build and CI gates alone.'
    : `Review panel: ${4 - offSeats.length} seat(s) ran; off: ${offSeats.length === 0 ? 'none' : offSeats.join(', ')}.`
  return { ...gated, blockKind: classifyBlock(gated, peers), reviewRecord }
}

// ── Inner loop ────────────────────────────────────────────────────────────────

let finalVerdict = 'REQUEST_CHANGES'
let round = 1
let pr = prNumber
let lastReviewRecord = 'No review round completed.'

try {
  phase('Build')
  log(`trident-v2 inner: slug=${slug} ralph=${ralph} maxRounds=${maxRounds} resume=${resumeCheckpoint} budget.total=${String(budget.total)} spent=${budget.spent()}`)

  // ── MID-LOOP RESUME ─────────────────────────────────────────────────────────
  // A relaunched run may skip forward past work a dead process already paid for —
  // but ONLY over code the prior phase's outcome is actually about. The decision
  // is `classifyResume`'s (read its docblock: the comparison, not the checkpoint
  // name, is the gate); everything here is the plumbing that gives it the two
  // facts it compares.
  const checkpointText = resumeCheckpoint
  const publishedResume = typeof checkpointText === 'string'
    ? checkpointText.match(/^outer-published:([0-9a-f]{40}):(\d+):(\d+)(:deviated)?$/)
    : null
  // The outer publisher's encoded OID is the newer, independently witnessed
  // record and takes precedence over the companion checkpoint column. It still
  // must equal the live head in classifyResume before any fast path opens.
  const recordedResumeHead = normalizeOid(publishedResume?.[1] ?? resumeCheckpointHead)
  const resumeFindingsList = Array.isArray(resumeFindings) ? resumeFindings : []
  // The head probe is skipped entirely when there is no recorded OID to compare
  // it against — with nothing to compare, the answer is 'rebuild' whatever the
  // branch head says, and the probe would only cost an agent.
  //
  // AND it is skipped when the LAUNCHER already read the head from git. Whenever
  // `resumeLiveHead` is a string — INCLUDING '' and 'absent' — the
  // `head-probe-round-resume` agent seat is NOT dispatched: a git fact is read at the
  // credentialed boundary, not relayed by a model. The probe survives only as the
  // fallback for launchers that predate this arg. No normalisation happens here
  // ('absent' is passed through verbatim); `classifyResume` owns interpretation.
  const launcherLiveHead = typeof resumeLiveHead === 'string' ? resumeLiveHead.trim() : null
  const currentHeadAtResume =
    resumeCheckpoint !== null && recordedResumeHead.length > 0
      ? (launcherLiveHead !== null ? launcherLiveHead : await readBranchHead('resume'))
      : ''
  const resumePlan = classifyResume({
    checkpoint: resumeCheckpoint,
    recordedHead: recordedResumeHead,
    currentHead: currentHeadAtResume,
    hasFindings: resumeFindingsList.length > 0,
    ralph,
  })
  let resumeMode = resumePlan.mode
  if (resumeCheckpoint !== null) {
    log(
      `trident-v2 resume: checkpoint=${resumeCheckpoint} recorded=${recordedResumeHead || '(none)'} head=${currentHeadAtResume || '(unread)'} src=${launcherLiveHead !== null ? 'launcher' : 'probe'} → ${resumeMode} (${resumePlan.reason})`,
    )
  }

  if (resumeMode === 'merged') {
    log(`trident-v2 resume: prior run recorded 'pr-merged' for ${forgeBranch} — the change already shipped; nothing to build, review or merge`)
    finalVerdict = 'APPROVE'
    const resumeMerged = mergedTerminalResult(pr, forgeBranch, 0)
    await writeTerminalResult(resumeMerged)
    return resumeMerged
  }

  // A prior run reached argus-approved AND the branch head is still the very
  // commit that verdict was recorded against — the PR is built, reviewed and
  // approved; skip build+review entirely and let the OUTER loop merge. (Cleanup
  // still runs in finally — idempotent.)
  if (resumeMode === 'approved') {
    log(`trident-v2 resume: prior run reached 'argus-approved' for ${forgeBranch} at ${recordedResumeHead} (head unchanged) — skipping build+review`)
    finalVerdict = 'APPROVE'
    // `reviewedHead` HERE IS THE RECORDED OID, AND IT MAY ONLY EVER BE THAT (#545).
    //
    // This shortcut used to record NOTHING, so the merge failed closed — correctly,
    // because the row carried no OID at all and the shortcut could therefore not
    // tell whether the head in front of it was the approved commit. Probing the
    // head and calling the answer `reviewedHead` would have been a lie with a
    // safety label on it: reviewers approve commit A, someone pushes B into the
    // crash window, resume reads B, and the outer merge pins to B and SUCCEEDS —
    // shipping a commit no reviewer saw while `--match-head-commit` certifies it as
    // reviewed. A pinned merge of an unreviewed commit is WORSE than an unpinned
    // one, because the pin manufactures confidence nobody earned.
    //
    // What changed is NOT that rule — it is that the approving checkpoint now
    // RECORDS the OID it approved (`inner_checkpoint_head`, written in the same
    // atomic UPDATE as the checkpoint name). So this path can pin to a commit some
    // reviewer demonstrably read. The value below comes from that record; the live
    // probe only decided whether this branch was allowed to run at all, and if the
    // head had moved `classifyResume` would have sent the run to rebuild +
    // re-review instead. A resume can therefore still never produce an APPROVE for
    // code that was not reviewed under that verdict — and `--match-head-commit`
    // re-checks the same equality at merge time, so a push landing after this point
    // still fails the merge LOUDLY rather than shipping.
    const resumeResult = {
      ok: true,
      prNumber: pr,
      branch: forgeBranch,
      verdict: 'APPROVE',
      round: 0,
      checkpoint: 'argus-approved',
      reviewedHead: recordedResumeHead,
      remainingTasks: 0,
      blockKind: 'none',
    }
    // Re-write the terminal result so a re-fired run whose prior process crashed
    // BEFORE harvesting still surfaces a harvest-ready `inner_result` (idempotent
    // — the merge gate downstream is a no-op once the run is already terminal).
    await writeTerminalResult(resumeResult)
    return resumeResult
  }

  // A resume that skips the build has no Forge result and therefore no diff file;
  // regenerate one from the RECORDED OID (never from the branch name — see
  // `writeResumeDiff`). If that cannot be produced there is nothing to show the
  // reviewers, so the run falls back to a full rebuild rather than reviewing air.
  let resumeDiff = ''
  if (resumeMode === 'review' || resumeMode === 'fix') {
    resumeDiff = publishedResume !== null
      ? `/tmp/trident-outer-published-${runId}.diff`
      : await writeResumeDiff(recordedResumeHead)
    if (resumeDiff.length === 0) {
      log(`trident-v2 resume: could not regenerate a diff for ${recordedResumeHead} — falling back to a full rebuild`)
      resumeMode = 'rebuild'
    }
  }

  // P-F2 — the Fable ORCHESTRATOR plans FIRST (once per Ralph iteration): it
  // regenerates the plan, picks the single top task, and emits its execution spec
  // + a complexity tag that ROUTES the executor (mechanical→Sonnet, reasoning→
  // Opus). Only in Ralph mode; a plain (non-ralph) task has no plan doc and
  // forge:build executes it directly (routed to Opus by the missing-tag default).
  let complexityTag = null
  // Did THIS iteration's Forge materially deviate from the exec spec it was given?
  // If so the IMPLEMENTATION_PLAN.md it committed may no longer describe reality,
  // so the NEXT iteration must re-derive the whole plan from the code instead of
  // reading the committed one. Declared here (ahead of the outer-published resume
  // parse below) because both the resume path and the build path set it.
  let taskDeviated = false
  // RALPH RE-FIRE (#362) — the count of tasks still UNCHECKED after the one this
  // iteration builds. >0 means the outer loop must re-fire a FRESH inner iteration
  // for the next task instead of merging after task 1 (the bug this fixes). Stays 0
  // for non-Ralph (single-task) runs, which never re-fire.
  let ralphRemaining = 0
  if (publishedResume !== null) {
    round = Number(publishedResume[3])
    ralphRemaining = Number(publishedResume[2])
    // The publish handoff carried the previous invocation's deviation fact across
    // the process boundary (see the checkpoint format below).
    if (publishedResume[4] !== undefined) taskDeviated = true
  }
  // The diff the reviewers read, the branch head the did-this-round-land check
  // baselines against, and the commit the merge is pinned to. Filled in by the
  // build below, or by the resume that skipped it.
  let diffFile = ''
  let branchHead = ''
  let reviewedHead = ''
  let roundLostItsWork = null
  let roundLostItsDiff = null

  if (resumeMode === 'review' || resumeMode === 'fix') {
    // ── SKIP THE BUILD ────────────────────────────────────────────────────────
    // The recorded OID and the live branch head are the same commit, so the code
    // a prior process built (`forge-done`) or fixed (`fix-round-N`) is exactly the
    // code in front of this run. Re-Forging it would spend a whole build to
    // re-derive a diff that already exists — the waste this resume exists to stop.
    //
    // In Ralph mode this ALSO skips `plan:fable`: the plan step exists to choose
    // the next task to BUILD, and no build runs here. (A Ralph iteration that
    // still owes tasks checkpoints `ralph-task-built`, which `classifyResume`
    // deliberately sends to rebuild, so this path only ever picks up an iteration
    // whose building was already done.)
    diffFile = resumeDiff
    branchHead = recordedResumeHead
    // A RECORDED OID — the same rule as the build path: the commit named here is
    // the one whose code was written out for the reviewers to read (the diff above
    // was generated FROM this OID), never whatever a live probe happened to see.
    reviewedHead = recordedResumeHead
    // Inherit the round budget already spent, so a lane resumed at fix round 7
    // gets the rounds it has left rather than a fresh allowance — a bounded loop
    // must not become unbounded by crashing. Only `fix-round-N` carries a round in
    // its name; `forge-done` starts at round 1, while a recorded
    // `argus-request-changes-round-N` verdict retains the round that bought it.
    round = Math.max(round, parseResumeRound(resumeCheckpoint, maxRounds))
    log(`trident-v2 resume: skipping forge:build — reviewing recorded head ${recordedResumeHead} from round ${round} (diff ${diffFile})`)
  } else {
    // REUSE an existing PR/branch from a prior crashed run — NEVER open a duplicate.
    // (Step 1 + step 4 of the contract already encode the re-entry; this is the
    // explicit reminder. Only meaningful in pr-mode — local mode has no PR.)
    const reuseNote =
      isPr && (pr !== null || resumeCheckpoint !== null)
        ? `\n\nRESUME: the durable outer loop already owns PR #${pr ?? '?'} and branch ${forgeBranch}. Commit to that SAME local branch. Do NOT push and do NOT run \`gh\`; the outer loop reuses the PR.`
        : ''
    let ralphNote = ''
    if (ralph === true) {
      // ── WHICH PLANNER RUNS THIS ITERATION ─────────────────────────────────
      // A PLANNED RALPH HANDOFF WHOSE BRANCH DID NOT MOVE IN THE CRASH WINDOW is
      // the ONLY shape that may skip the survey, and this predicate is exactly
      // that — read it against `classifyResume`, which is where it gets its
      // force. For the checkpoint name 'ralph-task-built', reason
      // 'unknown-checkpoint' is reachable ONLY after the recorded head was
      // compared against the live head and MATCHED: every other outcome
      // (head-moved / head-unreadable / head-branch-absent / no-recorded-head /
      // no-checkpoint) returns earlier with its own reason. So this is not a
      // name check with a comparison bolted on; the comparison already happened.
      //
      // Every other resume shape — 'forge-done', 'fix-round-N', 'argus-*', an
      // outer-published resume, no checkpoint at all — is a GENUINE crash-resume
      // (or the first iteration) and keeps the full planner and its verbatim
      // `resumeNote` path, unchanged.
      //
      // `ralphRound` IS ZERO-BASED — read it as "how many re-fires have happened",
      // not "which iteration is this". `createRun` writes `ralph_round: 0`
      // (trident/store.ts) and `refireNextRalphTask` bumps it by one per handoff
      // (trident/orchestrator.ts), so ITERATION N ARRIVES HERE AS ralphRound N-1:
      // iteration 1 → 0, iteration 2 → 1, iteration 6 → 5. Hence `>= 1` (not
      // `>= 2`): iteration 2 is the FIRST continuation and the whole point of this
      // card — gating on `>= 2` silently made iteration 2 pay the full 287 s
      // survey. `% PLAN_REFRESH_EVERY !== 0` then lands the periodic full re-plan
      // on iteration K+1 = 6 (ralphRound 5), 11 (10), … and also excludes
      // ralphRound 0 a second time, which is iteration 1 and must always
      // full-plan.
      const cleanContinuation =
        resumePlan.reason === 'unknown-checkpoint' &&
        typeof resumeCheckpoint === 'string' &&
        resumeCheckpoint.trim() === 'ralph-task-built' &&
        Number.isSafeInteger(ralphRound) &&
        ralphRound >= 1 &&
        ralphRound % PLAN_REFRESH_EVERY !== 0
      // The committed plan, read by the cheap probe seat — but ONLY when the cheap
      // planner could actually be used. On every other path this costs nothing,
      // because it is not dispatched.
      //
      // Through `seatAttempt`, for the same reason `head-probe`/`ci-probe` are: A
      // PROBE AGENT THAT DIES MUST NOT END THE LANE. This seat is a pure
      // OPTIMISATION — all it decides is whether the CHEAPER planner may run — so
      // a transient dispatch failure (a 529, a killed session) crashing the whole
      // workflow would make having the fast path strictly WORSE than not having
      // it. Death collapses to `null`, which is already the "no usable probe"
      // value the `usePlanNext` predicate below rejects, so the lane falls through
      // to the full `plan:fable` exactly as it does for a branch that carries no
      // committed plan at all.
      const planProbe = cleanContinuation
        ? await seatAttempt(`plan-probe-round-${ralphRound}`, () =>
            agent(
              planProbePrompt(),
              withModel({ label: 'plan:probe', phase: 'Build', schema: PLAN_PROBE_SCHEMA }),
            ),
          )
        : null
      // THE DECISION IS MADE HERE, IN CODE, from the probe's three facts — the
      // probe itself judges nothing. A dead probe, a branch with no committed
      // plan, an empty body, or a plan with ZERO unchecked tasks all FALL THROUGH
      // to the full planner: a branch whose plan is exhausted must ESCALATE to the
      // planner that can decide the card is done, never silently build nothing.
      const usePlanNext =
        cleanContinuation &&
        planProbe !== null &&
        planProbe.planFound === true &&
        Number.isSafeInteger(planProbe.uncheckedCount) &&
        planProbe.uncheckedCount >= 1 &&
        typeof planProbe.planBody === 'string' &&
        planProbe.planBody.trim().length > 0 &&
        probeBodyIntact(planProbe)
      if (cleanContinuation && !usePlanNext) {
        log(
          `trident-v2 plan:next SKIPPED (round ${ralphRound}) — ${
            planProbe === null
              ? 'the plan probe returned nothing'
              : planProbe.planFound !== true
                ? `no committed IMPLEMENTATION_PLAN.md on ${planProbeRef}`
                : typeof planProbe.planBody !== 'string' || planProbe.planBody.trim().length === 0
                  ? 'the committed plan is empty'
                  : planProbe.uncheckedCount < 1 || !Number.isSafeInteger(planProbe.uncheckedCount)
                    ? `the committed plan has ${JSON.stringify(planProbe.uncheckedCount)} unchecked task(s)`
                    : `the relayed plan body does not match the ${JSON.stringify(planProbe.planLines)} line(s) the probe measured — treating it as truncated`
          } → falling through to the full plan:fable`,
        )
      }
      const plannerLabel = usePlanNext ? 'plan:next' : 'plan:fable'
      const plan = usePlanNext
        ? await agent(
            planNextPrompt(planProbe.planBody),
            withModel({ label: 'plan:next', phase: 'Build', schema: PLAN_SCHEMA }),
          )
        : await agent(
            planFablePrompt(resuming),
            withModel({ label: 'plan:fable', phase: 'Build', schema: PLAN_SCHEMA }),
          )
      // NEVER continue Ralph without a plan (Codex [P2]). The old in-Forge
      // RALPH_NOTE is gone, so a null plan (planner terminal error) would run
      // forge:build with NO plan + NO one-task discipline — an unplanned build.
      // Fail loudly; the catch{} persists a terminal failure result promptly.
      // IDENTICAL FOR BOTH PLANNERS — the cheap path is allowed to be cheaper, not
      // to be less safe.
      if (!plan) {
        throw new Error(
          usePlanNext
            ? 'plan:next returned null (planner terminal error) — refusing to run Forge without a plan in Ralph mode'
            : 'plan:fable returned null (planner terminal error) — refusing to run Forge without a plan in Ralph mode',
        )
      }
      // ── THE RELAYED PLAN IS VERIFIED, NOT TRUSTED ───────────────────────────
      // `plan:next` is asked to do exactly two mechanical things — echo the
      // committed body byte for byte, and report the probe's count minus one — and
      // the probe ALREADY MEASURED BOTH (a verbatim `git show`, a `grep -c`). So
      // neither is taken on the model's word, because both failure modes are
      // silent and expensive: `ralphExecuteNote` tells Forge to write "EXACTLY
      // this body" and COMMIT it, so a shortened echo rewrites the card's own plan
      // and deletes tasks nobody decided to drop; and `remainingTasks` is the
      // re-fire gate, so a hallucinated 0 declares a half-built card finished.
      // The measurement wins over the relay, every time, and says so on the
      // transcript. (Same discipline as `briefIntegrity()`: compare against what
      // was measured, prefer the measurement, log the divergence.)
      if (usePlanNext) {
        if (plan.implementationPlan !== planProbe.planBody) {
          const relayed = typeof plan.implementationPlan === 'string' ? plan.implementationPlan.length : -1
          log(
            `trident-v2 plan:next INTEGRITY — the relayed implementationPlan (${relayed} chars) is not the committed body ` +
              `(${planProbe.planBody.length} chars); persisting the COMMITTED body instead`,
          )
          plan.implementationPlan = planProbe.planBody
        }
        // The probe counted the unchecked tasks INCLUDING the one being built now,
        // so the truth after this iteration is exactly one fewer.
        const measuredRemaining = planProbe.uncheckedCount - 1
        const claimed = Number.isFinite(plan.remainingTasks) ? Math.trunc(plan.remainingTasks) : null
        if (claimed !== measuredRemaining) {
          log(
            `trident-v2 plan:next INTEGRITY — remainingTasks=${JSON.stringify(plan.remainingTasks)} contradicts the probe's ` +
              `grep -c count (${planProbe.uncheckedCount} unchecked − 1 = ${measuredRemaining}); using the measured count`,
          )
          plan.remainingTasks = measuredRemaining
        }
      }
      complexityTag = plan.complexity
      ralphNote = ralphExecuteNote(plan)
      ralphRemaining = Number.isFinite(plan.remainingTasks) ? Math.max(0, Math.trunc(plan.remainingTasks)) : 0
      log(`trident-v2 ${plannerLabel} → topTask="${plan.topTask}" complexity=${plan.complexity} remaining=${ralphRemaining}`)
    }

    // Round 1: re-enter only on a genuine crash-resume (`resuming`); otherwise
    // CREATE the branch fresh. forge:build is now a PURE EXECUTOR routed by the
    // planner's complexity tag.
    const forge = await forgeAgent(
      { label: 'forge:build', phase: 'Build', isolation: 'worktree' },
      complexityTag,
      `${forgeBuildContract(resuming)}${ralphNote}${reuseNote}

TASK:
${task}${reflectionGuidance}`,
      'r1',
    )

    if (!forge) throw new Error('forge agent returned null (terminal error before returning a result)')
    if (forge.prNumber !== null && forge.prNumber !== undefined) pr = forge.prNumber

    const forgeSha = typeof forge.commitSha === 'string' ? forge.commitSha.trim() : ''
    const forgeDiff = typeof forge.diffFile === 'string' ? forge.diffFile.trim() : ''
    diffFile = forgeDiff
    // The baseline for the did-this-round-land check below. Round 1's own commit is
    // the starting point; every fix round must move the branch past it.
    branchHead = forgeSha
    // THE EXACT BOOLEAN ONLY (fail-closed, as `pr_merged` is decoded): a string
    // 'true', a 1, or any other truthy stand-in is a field that did not arrive in
    // the shape the schema asks for, and reading one as a deviation would spend the
    // full 287 s survey on the next iteration for nothing.
    if (ralph === true && forge.deviatedFromSpec === true) taskDeviated = true

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
    reviewedHead = branchHead

    // C1 checkpoint — Forge done (PR + branch persisted), recorded against the
    // commit Forge reported so a resume can tell whether this build is still the
    // code on the branch.
    await checkpoint('forge-done', { pr, head: branchHead })
    if (isPr) {
      // NO THROW ON SHA SHAPE. What this handoff actually carries is the BRANCH
      // NAME (`branch: forgeBranch`) — a value no model can plausibly mangle —
      // which the outer publisher `rev-parse --verify`s to get the real head.
      // `publishHead` is a best-effort CROSS-CHECK only, so a missing or
      // abbreviated claim must never discard a build that is already committed.
      const publishResult = { ok: true, prNumber: null, branch: forgeBranch, verdict: 'REQUEST_CHANGES', round, checkpoint: 'forge-done', publishRequested: true, publishHead: oidClaim(branchHead), remainingTasks: ralphRemaining, deviatedFromSpec: taskDeviated }
      await writeTerminalResult(publishResult)
      return publishResult
    }
  }

  // ── A MERGE IS TERMINAL (ISSUES #563) ────────────────────────────────────────
  // ASKED HERE, THE INSTANT THE BUILD RETURNS, because this is the first moment a
  // merge performed BY this run can exist and the last moment before it starts
  // spending: everything below — the review panel, the Ralph re-fire, every fix
  // round — is downstream of this line. That ordering IS the fix. A lane that
  // merged its PR during forge:build and only noticed at the top of the next round
  // has already bought the round being removed.
  //
  // A merged PR ends the run as a SUCCESS. There is nothing left to review (the
  // change is on the base branch), nothing left to fix (the head branch is
  // deleted), and nothing left for the outer loop to merge.
  if ((await probePrMerged(pr, 'r1')) === 'merged') {
    log(`trident-v2 MERGED: PR #${String(pr)} is merged — the run is DONE (no review, no fix round, no round increment)`)
    await checkpoint('pr-merged', { pr })
    const mergedResult = mergedTerminalResult(pr, forgeBranch, round)
    await writeTerminalResult(mergedResult)
    return mergedResult
  }


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
  // and a resume re-enters the branch to PLAN + BUILD the next task
  // (`classifyResume` sends this checkpoint name to rebuild however the head
  // compares, because the next task is still unbuilt).
  if (ralph === true && ralphRemaining > 0) {
    // A DEVIATED HANDOFF IS A DIFFERENT CHECKPOINT NAME, and that is the whole
    // mechanism: the cheap `plan:next` selection requires the EXACT name
    // 'ralph-task-built', so 'ralph-task-built-deviated' fails that check and falls
    // into `classifyResume`'s unknown-checkpoint → rebuild. The next iteration
    // therefore runs the full `plan:fable` and re-derives the plan from the code,
    // which is the correct price when the committed plan may no longer be true.
    const builtCheckpoint = taskDeviated ? 'ralph-task-built-deviated' : 'ralph-task-built'
    log(`trident-v2 ralph: task built, ${ralphRemaining} task(s) remain → hand back to outer loop for re-fire`)
    await checkpoint(builtCheckpoint, { pr, head: branchHead })
    const refireResult = {
      ok: true,
      prNumber: pr,
      branch: forgeBranch,
      // Unreviewed intermediate — no Argus verdict yet (the outer re-fires, never
      // merges, on remainingTasks>0). Kept non-APPROVE as belt-and-suspenders.
      verdict: 'REQUEST_CHANGES',
      round,
      checkpoint: builtCheckpoint,
      remainingTasks: ralphRemaining,
    }
    await writeTerminalResult(refireResult)
    return refireResult
  }

  // A completed final build must have both a commit to pin and a diff to review.
  // Merge and Ralph re-fire are settled first: either can legitimately finish a
  // build invocation without producing a reviewable diff.
  if (resumeMode === 'rebuild') {
    if (branchHead === '' || diffFile === '') {
      const missing = [branchHead === '' ? 'commitSha' : null, diffFile === '' ? 'diffFile' : null]
        .filter((m) => m !== null)
        .join(' and ')
      throw new Error(
        `forge:build completed but produced no ${missing} — nothing was built${pr === null || pr === undefined ? '' : ` (PR #${pr})`}. Refusing to open the review panel: an empty diff is not a change, and a panel that reviews one spends the review budget to APPROVE nothing.`,
      )
    }
    await checkpoint('forge-done', { pr, head: branchHead })
  }

  // First review + synthesis — UNLESS this is a resume whose recorded
  // REQUEST_CHANGES verdict is about exactly the commit in front of us. Then the
  // panel has already judged this code and said what is wrong with it; re-running
  // it would buy the same four verdicts a second time, which is precisely the
  // waste a mid-loop resume exists to stop. Seed the loop with the RECORDED
  // findings instead and go straight to the fix round.
  //
  // This shortcut can only ever produce REQUEST_CHANGES, so it cannot ship
  // anything: the fix round that follows re-reviews its own new head before any
  // APPROVE is possible.
  let synthesis
  if (resumeMode === 'fix') {
    log(`trident-v2 resume: recorded REQUEST_CHANGES applies to ${recordedResumeHead} (head unchanged) — skipping the re-review, straight to the fix round with ${resumeFindingsList.length} recorded finding(s)`)
    const paidReview = { verdict: 'REQUEST_CHANGES', findings: resumeFindingsList, blockKind: 'code' }
    synthesis = await runReviewRound(diffFile, round, pr, paidReview)
    finalVerdict = 'REQUEST_CHANGES'
  } else {
    synthesis = await runReviewRound(diffFile, round, pr)
    if (typeof synthesis?.reviewRecord === 'string') lastReviewRecord = synthesis.reviewRecord
    finalVerdict = normalizeVerdict(synthesis.verdict)
    // The verdict is recorded against the commit the panel judged, and carries the
    // findings a resumed fix round would act on.
    await checkpoint(finalVerdict === 'APPROVE' ? 'argus-approved' : `argus-request-changes-round-${round}`, {
      pr,
      head: reviewedHead,
      findings: synthesis.findings,
    })
  }

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
    const fix = await forgeAgent(
      { label: `forge:fix-round-${round}`, phase: 'Build', isolation: 'worktree' },
      complexityTag,
      `${forgeBuildContract(true)}

You are FIXING Argus's findings on the EXISTING branch ${forgeBranch} (round ${round}). Commit on the SAME local branch; ${isPr ? 'the durable outer loop publishes after you exit, so do not push or run `gh`.' : 'there is no remote and no PR.'} Address every BLOCKER + important finding, run tests until green, commit locally, and re-write the diff file.
ARGUS FINDINGS (round ${round - 1}):
${JSON.stringify(synthesis.findings)}

TASK:
${task}${reflectionGuidance}`,
      `r${round}`,
    )
    await checkpoint(`fix-round-${round}`, {
      pr,
      head: typeof fix?.commitSha === 'string' ? fix.commitSha.trim() : '',
    })
    if (isPr) {
      // Best-effort claim, same as the build handoff: the branch name is the
      // handoff, `publishHead` is only a cross-check for the publisher.
      const publishHead = oidClaim(fix?.commitSha)
      const publishResult = { ok: true, prNumber: pr, branch: forgeBranch, verdict: 'REQUEST_CHANGES', round, checkpoint: `fix-round-${round}`, publishRequested: true, publishHead, remainingTasks: ralphRemaining }
      await writeTerminalResult(publishResult)
      return publishResult
    }
    // DID IT LAND — OR DID THE PR MERGE? A fix round runs in a throwaway worktree,
    // so edits that were never committed+pushed are already gone, and reviewing
    // again would re-report the previous round's findings against unchanged code.
    // But a MERGE deletes the branch, which reads through the same head probe as
    // exactly that failure — so both facts are gathered and `roundOutcome` orders
    // them: GitHub is asked whether the PR merged BEFORE any `round-lost` verdict
    // is written (ISSUES #563), and the round-lost path is otherwise untouched.
    const headAfter = await readBranchHead(round)
    const outcome = roundOutcome(await probePrMerged(pr, `r${round}`), branchHead, headAfter)
    if (outcome === 'merged') {
      log(`trident-v2 MERGED: PR #${String(pr)} is merged — the run is DONE at round ${round} (no re-review, no further round)`)
      await checkpoint('pr-merged', { pr })
      const mergedResult = mergedTerminalResult(pr, forgeBranch, round)
      await writeTerminalResult(mergedResult)
      return mergedResult
    }
    if (outcome === 'round-lost') {
      log(`trident-v2 fix loop: round=${round} DID NOT LAND (head still ${headAfter || 'unreadable'}) — stopping`)
      roundLostItsWork = { round, head: headAfter || branchHead }
      finalVerdict = 'REQUEST_CHANGES'
      break
    }
    branchHead = headAfter
    // AND DID IT LEAVE A DIFF? Round 1 refuses to open the panel on an empty
    // `diffFile` (the gate above); a fix round had no such check, and the two
    // rounds are not symmetric in a way that made that safe. The codex wrapper
    // DELETES the diff path before every launch so a stale diff can never be
    // reported as this round's, and it only regenerates one when the build
    // committed — so a fix round whose regeneration produced nothing leaves the
    // path this loop captured in round 1 absent or empty, and the five reviewers
    // are dispatched at it with no gate at all. That is round 1's "APPROVE
    // nothing" failure, one round later and costing a full panel.
    //
    // The round's OWN reported path is what is checked and what is reviewed, not
    // the round-1 variable: it is the only value that is a measurement of THIS
    // round (for a codex build the wrapper measured it after the build exited and
    // reports it empty when the file is missing or empty), and reusing round 1's
    // path is precisely how an absent file goes unnoticed.
    const fixDiff = typeof fix?.diffFile === 'string' ? fix.diffFile.trim() : ''
    if (fixDiff === '') {
      log(`trident-v2 fix loop: round=${round} LEFT NO DIFF — stopping`)
      roundLostItsDiff = round
      finalVerdict = 'REQUEST_CHANGES'
      break
    }
    diffFile = fixDiff
    // …and the commit THIS round's review judges is, exactly as in round 1, the
    // one the fix agent reported committing — NOT `headAfter` (#545). The remote
    // probe above answers a different question ("did the branch move?"), and a
    // third party's push satisfies it just as well as the fix agent's own commit;
    // recording that push as `reviewedHead` would pin the merge to code the
    // upcoming review never sees. Empty → fail-closed, same as round 1.
    reviewedHead = typeof fix?.commitSha === 'string' ? fix.commitSha.trim() : ''
    synthesis = await runReviewRound(diffFile, round, pr)
    if (typeof synthesis?.reviewRecord === 'string') lastReviewRecord = synthesis.reviewRecord
    finalVerdict = normalizeVerdict(synthesis.verdict)
    await checkpoint(finalVerdict === 'APPROVE' ? 'argus-approved' : `argus-request-changes-round-${round}`, {
      pr,
      head: reviewedHead,
      findings: synthesis.findings,
    })
  }

  // The MEASURED cause of an infra-only stop, computed once: it goes into the audit
  // log AND the terminal result, and the two must not be able to disagree. Already
  // redacted by `infraTerminalCause`, so it is safe to print.
  const terminalCause = infraTerminalCause(synthesis)
  const isInfraOnlyStop =
    roundLostItsWork === null &&
    roundLostItsDiff === null &&
    finalVerdict !== 'APPROVE' &&
    synthesis.blockKind === 'infra-only' &&
    terminalCause !== ''
  log(
    `trident-v2 inner DONE: verdict=${finalVerdict} round=${round} pr=${pr}` +
      (isInfraOnlyStop ? ` cause=${terminalCause}` : ''),
  )
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
    reviewRecord: lastReviewRecord,
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
    // A round that COMMITTED but produced no diff is 'round-lost' too: in both
    // cases the code was not re-judged, which is the distinction this field
    // exists to draw. The FINDING below is what tells the two apart, because the
    // recovery differs — one needs the work recovered, the other needs a diff
    // regenerated against work that is already safely on the branch.
    blockKind:
      roundLostItsWork !== null || roundLostItsDiff !== null
        ? 'round-lost'
        : finalVerdict === 'APPROVE'
          ? 'none'
          : synthesis.blockKind || 'code',
    // THE MEASURED CAUSE, present ONLY for an infra-only stop that actually measured
    // one. `blockKind` says the code was never judged; this says WHY, in the probe's
    // own words (redacted + capped). The outer loop's failure reason has been generic
    // for want of exactly this field — and it stays generic wherever it is absent,
    // because a specific message must ship WITH the measured signal, never before it.
    ...(isInfraOnlyStop ? { terminalCause } : {}),
    // Present ONLY when a fix round left no trace on the branch, so the operator
    // is told which round to recover rather than being handed stale findings.
    ...(roundLostItsWork !== null
      ? { findings: [roundDidNotLandFinding(roundLostItsWork.round, roundLostItsWork.head)] }
      : roundLostItsDiff !== null
        ? { findings: [roundLeftNoDiffFinding(roundLostItsDiff)] }
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
