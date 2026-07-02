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
//   (A) WORKTREE CLEANUP IS EXPLICIT, ON EVERY PATH. `isolation:'worktree'`
//       auto-removes a worktree ONLY IF UNCHANGED; a Forge build always commits,
//       so the worktree is left ORPHANED unless trident removes it. The
//       `finally{}` block scans `git worktree list` for the DETERMINISTIC
//       `trident/<slug>` branch and removes it independent of Forge's return
//       value (so it holds even if Forge threw before returning). This is D-1.
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
//       step can persist to sqlite mid-run). Date.now()/new Date() are NOT
//       available in a workflow script — timestamps are computed inside the Bash
//       step via `date -u +%FT%TZ`.
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
  maxRounds = 3,
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
  // FABLE-ORCHESTRATOR model routing (SPEC § Fable-orchestrator, 2026-07-02).
  // The per-role model IDS, resolved from the single-source-of-truth registry
  // (runtime/models.ts) in the launcher (`buildWorkflowArgs`) and threaded in
  // here: `{ fable, opus, sonnet, fast }`. This workflow script has NO module
  // resolution, so it CANNOT import the registry — the ids MUST arrive via args,
  // never as hard-pinned literals in this file. Absent (a dry source check) →
  // fall back to the documented agent() symbolic aliases (see MODELS below).
  models = null,
} = normalizeWorkflowArgs(args)

// Is a per-project codex credential configured for this run? Absent → skip the
// codex panelist entirely (no wasted agent) and synthesise Claude-only.
const codexConfigured = typeof codexHome === 'string' && codexHome.length > 0

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

// ── FABLE-ORCHESTRATOR model routing ─────────────────────────────────────────
// Ryan-locked doctrine (SPEC § Fable-orchestrator, Decisions Log 2026-07-02):
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
const MODELS = {
  fable: pickModel('fable', 'fable'),
  opus: pickModel('opus', 'opus'),
  sonnet: pickModel('sonnet', 'sonnet'),
  fast: pickModel('fast', 'haiku'),
}

// forge:* routes BY the planner's complexity tag: '[mechanical]' (boilerplate,
// tests, a single-file edit) → cheap Sonnet executor; '[reasoning]' / missing /
// ambiguous → Opus (bias to Opus — Argus + Codex are the backstop).
const modelForTag = (tag) =>
  tag === 'mechanical'
    ? { model: MODELS.sonnet, effort: 'medium' }
    : { model: MODELS.opus, effort: 'high' }

// label → {model, effort}. forge:* is resolved dynamically (modelForTag) since
// its model depends on the task; the rest are static. Fable orchestrates
// (plan:fable + argus:synthesis); Opus reviews (argus:claude/adversarial); the
// cheap sqlite/bash bookkeeping steps use the fast model.
const ROLE_MODEL = {
  'plan:fable': { model: MODELS.fable, effort: 'max' },
  'argus:claude': { model: MODELS.opus, effort: 'high' },
  'argus:adversarial': { model: MODELS.opus, effort: 'high' },
  'argus:synthesis': { model: MODELS.fable, effort: 'high' },
  'checkpoint': { model: MODELS.fast, effort: 'low' },
  'terminal-result': { model: MODELS.fast, effort: 'low' },
  'cleanup:worktree': { model: MODELS.fast, effort: 'low' },
}

// Resolve {model, effort} for a spawn keyed on its label (+ optional complexity
// tag for forge:*). Unknown label → Opus executor (safe default; never Fable).
function routeModel(label, tag) {
  if (label === 'forge:build' || label.startsWith('forge:fix-round-')) return modelForTag(tag)
  if (label.startsWith('checkpoint:')) return ROLE_MODEL['checkpoint']
  return ROLE_MODEL[label] || { model: MODELS.opus, effort: 'high' }
}

// Merge the resolved {model, effort} into an agent() opts object (which carries
// the label) and LOG the spawn so every run is TALLY-ABLE — Ryan tracks subagent
// count + model per run ("N agents, M on Fable, K on Opus, J on Sonnet, C on
// Codex"). Use for EVERY Claude agent() so its model is both routed and observed.
function withModel(opts, tag) {
  const route = routeModel(opts.label, tag)
  log(
    `trident.agent label=${opts.label} model=${route.model} effort=${route.effort}${tag ? ` tag=${tag}` : ''}`,
  )
  return { ...opts, model: route.model, effort: route.effort }
}

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
// ('deferred' — configured but the codex call failed/timed out).
const CODEX_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'codexStatus'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
    findings: VERDICT_SCHEMA.properties.findings,
    codexStatus: { type: 'string', enum: ['connected', 'not_connected', 'deferred'] },
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
const ARGUS_RUBRIC = `You are ARGUS — Neutron's autonomous code-review sub-agent (read-only). ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}
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
function planFablePrompt() {
  return `You are the TRIDENT ORCHESTRATOR / PLANNER (Fable) for a governed, spec-driven Ralph build. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}
You do the HIGH-VALUE THINKING; a SUBORDINATE executor (Opus/Sonnet) will carry out your spec verbatim — so be precise and complete. Work READ-ONLY from the repo of record ${repoPath} (base branch ${baseBranch}):
1. Read SPEC.md (the master spec) and AS-BUILT.md if present at the repo root, and survey the CURRENT code SPEC.md governs. SPEC.md is authoritative — do NOT invent a competing plan doc.
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
// workflow can skip finished phases + reuse the PR. Timestamps are computed IN
// the Bash step (`date -u +%FT%TZ`) because Date.now()/new Date() are not
// available in a workflow script. No-ops when the launcher did not thread a
// dbPath/runId (e.g. a dry source check).
async function checkpoint(name, opts) {
  if (!dbPath || !runId) return
  const o = opts || {}
  const sets = []
  if (o.pr !== undefined && o.pr !== null) sets.push(`pr=${Number(o.pr)}`)
  sets.push(`branch='${forgeBranch}'`)
  sets.push(`inner_checkpoint='${name}'`)
  sets.push(`subagent_status='running'`)
  sets.push(`last_advanced_at='$(date -u +%FT%TZ)'`)
  await agent(
    `Checkpoint step (idempotent; must NOT fail the build). Run EXACTLY this single Bash command and nothing else, then report "checkpoint ${name} ok":
sqlite3 "${dbPath}" "UPDATE code_trident_runs SET ${sets.join(', ')} WHERE id='${runId}'"`,
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
// and pulled in via `readfile()` (CAST AS TEXT) so the JSON's own double quotes
// can never break the double-quoted sqlite shell argument. No-ops when the
// launcher did not thread a dbPath/runId (a dry source check).
async function writeTerminalResult(result) {
  if (!dbPath || !runId) return
  const verdict = result.verdict === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES'
  const json = JSON.stringify(result)
  const tmp = `/tmp/trident-terminal-${runId}.json`
  const sets = [
    `inner_result=CAST(readfile('${tmp}') AS TEXT)`,
    `inner_verdict='${verdict}'`,
    `subagent_status='completed'`,
    `branch='${forgeBranch}'`,
  ]
  if (result.prNumber !== undefined && result.prNumber !== null) {
    sets.push(`pr=${Number(result.prNumber)}`)
  }
  sets.push(`last_advanced_at='$(date -u +%FT%TZ)'`)
  await agent(
    `Terminal-result step (idempotent; must NOT fail the build). Run EXACTLY this single Bash command and nothing else, then report "terminal-result ok":
printf '%s' ${shSingleQuote(json)} > ${tmp} && sqlite3 "${dbPath}" "UPDATE code_trident_runs SET ${sets.join(', ')} WHERE id='${runId}'"`,
    withModel({ label: 'terminal-result', phase: 'Synthesis' }),
  )
}

// Normalise a reviewer verdict enum to the two terminal verdicts the OUTER loop
// acts on (APPROVE → merge; anything else → another fix round / failed).
function normalizeVerdict(v) {
  return v === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES'
}

// NEVER-SILENT-DOWNGRADE guard (mirrors Vajra's CODEX_REVIEW_PRECHECK_FAILED /
// CODEX_REVIEW_TIMEOUT rule). Enforced DETERMINISTICALLY in code, not left to the
// synthesis LLM: a codex review that was CONFIGURED but FAILED ('deferred') must
// NEVER be silently upgraded to APPROVE. If synthesis said APPROVE while codex is
// deferred, force REQUEST_CHANGES and surface the deferral as a blocker finding.
// 'not_connected' (never set up) and 'connected' (ran fine) pass through — only a
// configured-but-failed codex blocks. Pure + side-effect-free so it can be
// unit-tested behaviorally (see inner-workflow.test.ts).
function enforceCodexGate(synthesis, codexStatus) {
  if (codexStatus === 'deferred' && synthesis && synthesis.verdict === 'APPROVE') {
    return {
      verdict: 'REQUEST_CHANGES',
      findings: [
        {
          severity: 'blocker',
          title: 'Codex cross-model review DEFERRED — refusing to silently APPROVE',
          evidence:
            'codex was configured (CODEX_HOME set) but the review call failed/timed out; per the never-silent-downgrade rule a deferred cross-model review cannot be treated as an approval. Re-run once codex auth is restored.',
        },
        ...((synthesis && synthesis.findings) || []),
      ],
    }
  }
  return synthesis
}

// The codex cross-model reviewer prompt. It shells out to the wrapper
// (trident/codex-review.sh) SYNCHRONOUSLY in the foreground (never backgrounded)
// with the per-project CODEX_HOME, then maps the wrapper's EXIT CODE to a
// CODEX_VERDICT_SCHEMA result. Only built when a codex credential is configured.
function codexReviewerPrompt(diffFile) {
  // GLOBALLY-UNIQUE temp files: trident runs detached workflows concurrently and
  // slugs are only unique WITHIN a project, so two same-slug runs in different
  // projects would collide on /tmp and cross-read each other's verdict. Key on
  // runId (uuid) — matching writeTerminalResult's /tmp/trident-terminal-${runId}
  // — falling back to slug only for a dry source check with no runId (Codex [P2]).
  const uniq = runId || slug
  const outFile = `/tmp/trident-codex-${uniq}.out`
  const errFile = `/tmp/trident-codex-${uniq}.err`
  const script = `${repoPath}/trident/codex-review.sh`
  // Codex reviews the SAME diff FILE Forge wrote (as the other reviewers do), NOT
  // `git diff` in repoPath — repoPath is still on the base branch (Forge builds in
  // an isolated worktree), so a git-diff there would be empty/stale and codex
  // could approve without reviewing the change (Codex review [P2]).
  return `You are the CODEX CROSS-MODEL REVIEW bridge for trident (read-only, an INDEPENDENT GPT-5 second opinion alongside Claude/Argus). ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}
Run EXACTLY this ONE synchronous foreground command from ${repoPath} (do NOT background it, do NOT add flags):
  CODEX_HOME=${shSingleQuote(codexHome || '')} NEUTRON_CODEX_DIFF_FILE=${shSingleQuote(diffFile)} bash ${shSingleQuote(script)} ${shSingleQuote(baseBranch)} > ${shSingleQuote(outFile)} 2> ${shSingleQuote(errFile)}; echo "CODEX_EXIT=$?"
Read the CODEX_EXIT code, then map it to your result (read ${outFile}/${errFile} only as needed — tail, do not flood context):
- EXIT 0  → codexStatus='connected'. Parse the review in ${outFile}: set verdict=REQUEST_CHANGES if it ends 'VERDICT: REQUEST_CHANGES' or lists any evidence-backed blocker, else APPROVE. Convert its blockers into findings (severity/title/evidence).
- EXIT 10 or 11 → codexStatus='not_connected' (no credential / CLI). Return verdict='COMMENT', findings=[]. This is the GRACEFUL path — do NOT invent findings; the synthesis notes "codex not connected" and proceeds Claude-only.
- EXIT 3 or 5  → codexStatus='deferred' (codex was configured but the call FAILED/timed out). Return verdict='REQUEST_CHANGES' with ONE finding {severity:'major', title:'Codex review deferred', evidence:<tail of ${errFile}>}. NEVER report APPROVE for a deferred codex.
Return via the schema. NEVER exit silently — if the command itself could not run, return codexStatus='deferred' with the reason.`
}

// Parallel adversarial review + asymmetric-gated synthesis. Returns the
// synthesised verdict object (VERDICT_SCHEMA).
async function reviewAndSynthesize(diffFile, round) {
  phase('Review')
  log(
    `trident-v2 review: round=${round} diff=${diffFile} codex=${codexConfigured ? 'configured' : 'not-connected'}`,
  )
  // The review PANEL: Claude rubric + Claude adversarial ALWAYS run; the codex
  // cross-model reviewer joins ONLY when a per-project credential is configured
  // (no wasted agent otherwise). All run in parallel.
  const reviewers = [
    () =>
      agent(
        `${ARGUS_RUBRIC}
Review the diff at ${diffFile} for the TASK below. Return your verdict + findings.
TASK: ${task}`,
        withModel({ label: 'argus:claude', phase: 'Review', schema: VERDICT_SCHEMA }),
      ),
    () =>
      agent(
        `You are ARGUS-ADVERSARIAL (independent, read-only). ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}
Independently try to REFUTE the change at ${diffFile}: hunt NaN/overflow/off-by-one edges, hidden invariants, and untested boundaries. Evidence-gate EVERY claim (file:line or a concrete repro). Do NOT modify files. NEVER exit silently — if you cannot verify part of it, say so.
TASK: ${task}`,
        withModel({ label: 'argus:adversarial', phase: 'Review', schema: VERDICT_SCHEMA }),
      ),
  ]
  if (codexConfigured) {
    // argus:codex runs on the CODEX runtime (an independent GPT-5 peer), not a
    // Claude model — the thin claude agent just shells out to codex-review.sh, so
    // it keeps the launcher-default model. Log it as `model=codex-runtime` so the
    // per-run tally still counts the cross-model reviewer ("C on Codex").
    log('trident.agent label=argus:codex model=codex-runtime effort=n/a')
    reviewers.push(() =>
      agent(codexReviewerPrompt(diffFile), {
        label: 'argus:codex',
        phase: 'Review',
        schema: CODEX_VERDICT_SCHEMA,
      }),
    )
  }
  const verdicts = await parallel(reviewers)
  // Codex verdict: the real result when configured, else a synthetic
  // not_connected marker (so the synthesis prompt is uniform + the never-silent
  // gate has a status to act on).
  const codexReview =
    codexConfigured && verdicts[2]
      ? verdicts[2]
      : { verdict: 'COMMENT', findings: [], codexStatus: 'not_connected' }
  const codexStatus = codexReview.codexStatus || 'not_connected'

  // ASYMMETRIC GATING (minority-veto): findings BOTH reviewers confirm → confirmed;
  // ONE credible evidence-backed BLOCKER vetoes APPROVE; a single-reviewer
  // non-blocker → labelled `unverified` (surfaced, not merge-blocking). The codex
  // cross-model verdict is a full panelist when connected; a 'not_connected' codex
  // is noted + ignored; a 'deferred' codex is hard-gated below.
  phase('Synthesis')
  const codexPanelLine =
    codexStatus === 'connected'
      ? `Verdict C (codex cross-model, GPT-5): ${JSON.stringify(codexReview)} — treat as a full third panelist; an evidence-backed codex blocker VETOES APPROVE.`
      : codexStatus === 'deferred'
        ? `Verdict C (codex cross-model): DEFERRED — codex was configured but the review call FAILED/timed out. Per the never-silent-downgrade rule, do NOT return APPROVE; surface the deferral.`
        : `Verdict C (codex cross-model): NOT CONNECTED — no codex credential for this project, so this is a Claude-only review. Note "codex not connected" and proceed on Verdicts A+B (do NOT block on codex).`
  const synthesisRaw = await agent(
    `Synthesise these INDEPENDENT review verdicts into ONE final verdict, applying ASYMMETRIC GATING:
- A finding MORE THAN ONE reviewer raises → keep it as confirmed.
- ONE credible, evidence-backed BLOCKER is enough to VETO APPROVE (minority-veto) → verdict REQUEST_CHANGES.
- A single-reviewer NON-blocking finding → keep it but label it 'unverified' (surface it; do NOT block merge on it alone).
- Only return APPROVE when NO reviewer left a credible evidence-backed blocker.
Verdict A (Claude rubric): ${JSON.stringify(verdicts[0])}
Verdict B (Claude adversarial): ${JSON.stringify(verdicts[1])}
${codexPanelLine}`,
    withModel({ label: 'argus:synthesis', phase: 'Synthesis', schema: VERDICT_SCHEMA }),
  )
  // Deterministic never-silent-downgrade guard — a configured-but-failed codex
  // can NEVER become a silent APPROVE regardless of what the synthesis LLM said.
  return enforceCodexGate(synthesisRaw, codexStatus)
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
  if (ralph === true) {
    const plan = await agent(
      planFablePrompt(),
      withModel({ label: 'plan:fable', phase: 'Build', schema: PLAN_SCHEMA }),
    )
    if (plan) {
      complexityTag = plan.complexity
      ralphNote = ralphExecuteNote(plan)
      log(`trident-v2 plan:fable → topTask="${plan.topTask}" complexity=${plan.complexity} remaining=${plan.remainingTasks}`)
    }
  }

  // Round 1: re-enter only on a genuine crash-resume (`resuming`); otherwise
  // CREATE the branch fresh. forge:build is now a PURE EXECUTOR routed by the
  // planner's complexity tag.
  const forge = await agent(
    `${forgeBuildContract(resuming)}${ralphNote}${reuseNote}

TASK:
${task}`,
    withModel({ label: 'forge:build', phase: 'Build', isolation: 'worktree', schema: FORGE_SCHEMA }, complexityTag),
  )

  if (!forge) throw new Error('forge agent returned null (terminal error before returning a result)')
  if (forge.prNumber !== null && forge.prNumber !== undefined) pr = forge.prNumber

  // C1 checkpoint — Forge done (PR + branch persisted).
  await checkpoint('forge-done', { pr })

  const diffFile = forge.diffFile

  // First review + synthesis.
  let synthesis = await reviewAndSynthesize(diffFile, round)
  finalVerdict = normalizeVerdict(synthesis.verdict)
  await checkpoint(finalVerdict === 'APPROVE' ? 'argus-approved' : 'argus-request-changes', { pr })

  // BOUNDED fix loop — re-Forge against the findings, re-review, re-synthesize,
  // until APPROVE or maxRounds.
  while (finalVerdict === 'REQUEST_CHANGES' && round < maxRounds) {
    round++
    log(`trident-v2 fix loop: round=${round}/${maxRounds} — re-Forge against findings`)
    // Fix round (> 1): the branch/PR were created in round 1, so ALWAYS re-enter
    // (`reenter=true`) — step 1 switches to the existing branch (no `-c`), step 4
    // reuses the PR (no duplicate). Codex [P1] fix.
    await agent(
      `${forgeBuildContract(true)}

You are FIXING Argus's findings on the EXISTING branch ${forgeBranch} (round ${round}). ${isPr ? `Do NOT open a new PR — push the SAME branch (\`gh pr list --head ${forgeBranch}\` to confirm it exists).` : `Commit on the SAME local branch ${forgeBranch} — no remote, no PR.`} Address every BLOCKER + important finding, run tests until green, commit${isPr ? ' + push' : ' locally'}, and re-write the diff file.
ARGUS FINDINGS (round ${round - 1}):
${JSON.stringify(synthesis.findings)}

TASK:
${task}`,
      withModel(
        { label: `forge:fix-round-${round}`, phase: 'Build', isolation: 'worktree', schema: FORGE_SCHEMA },
        complexityTag,
      ),
    )
    await checkpoint(`fix-round-${round}`, { pr })
    synthesis = await reviewAndSynthesize(diffFile, round)
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
  }
  try {
    await writeTerminalResult(failureResult)
  } catch (e2) {
    log(`trident-v2 terminal-failure write ALSO failed (stall guard is the backstop): ${e2 && e2.message ? e2.message : String(e2)}`)
  }
  return failureResult
} finally {
  // (A) MANDATORY WORKTREE CLEANUP — runs on success, REQUEST_CHANGES, throw, or
  // abort. The harness removes a worktree ONLY IF UNCHANGED, and a Forge build
  // always changes its worktree, so trident MUST remove it explicitly.
  //
  // CRITICAL: cleanup CANNOT depend on a valid `forge` result. If Forge mutated
  // its worktree then FAILED before returning JSON (tests fail, `gh pr create`
  // fails, the agent throws → agent() returns null), the changed worktree still
  // exists. So we clean up by SCANNING git state for ANY worktree on the
  // DETERMINISTIC '${forgeBranch}' branch — independent of Forge's return value.
  // The branch is pushed on the success path, so removing the local worktree +
  // branch loses nothing. This is what makes the guarantee hold on ALL paths.
  // BRANCH TEARDOWN IS MODE-AWARE — D-1 (never orphan a CHANGED worktree) is
  // UNCONDITIONAL, but the branch must NOT be deleted here in LOCAL mode: the
  // branch holds the ONLY copy of the un-merged commits, and the OUTER loop's
  // `mergeLocal` (merge.ts) merges that exact branch THEN deletes it post-merge.
  // Deleting it in this finally stranded every local-mode merge ("not something
  // we can merge"). In PR mode the work is already pushed to origin and the
  // OUTER `mergePr` merges the REMOTE PR, so the local branch is disposable here.
  const branchTeardownStep = isPr
    ? `3. git branch -D ${forgeBranch}   (ignore "not found" — the work is pushed to origin/the PR, so the local branch is disposable)`
    : `3. KEEP the branch '${forgeBranch}' — do NOT delete it. This is LOCAL mode: the OUTER loop merges this branch and deletes it post-merge. Deleting it here would lose the build.`
  await agent(
    `Cleanup step (MUST succeed on every path; ignore individual command failures). From ${repoPath}:
1. Find the worktree for branch '${forgeBranch}':  git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{ if ($2=="refs/heads/${forgeBranch}") print w }'
2. For that path (if any):  git worktree remove --force <path>
${branchTeardownStep}
4. git worktree prune
5. Verify with \`git worktree list\` that NO worktree remains on '${forgeBranch}'. Report the final worktree count and whether any orphan remained.`,
    withModel({ label: 'cleanup:worktree', phase: 'Synthesis' }),
  )
}
