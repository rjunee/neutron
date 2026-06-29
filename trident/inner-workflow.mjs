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
} = normalizeWorkflowArgs(args)

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
// Step 1 differs on a resume: a fresh run creates the branch; a resume re-enters
// the EXISTING branch a prior crashed run left behind (no `-c` — that collides).
const FORGE_STEP1 = resuming
  ? `A prior run already created branch ${forgeBranch}${isPr ? ' (and its PR)' : ''}. Re-enter it WITHOUT \`-c\`: \`git fetch origin ${forgeBranch} 2>/dev/null || true; git switch ${forgeBranch} 2>/dev/null || git switch -c ${forgeBranch}\`. Continue/verify the existing work — do NOT restart from scratch.`
  : `Run \`git switch -c ${forgeBranch}\` as your FIRST step (the cleanup step relies on this EXACT branch name to find your worktree even if you fail later).`
// Step 4 differs on git-mode: pr → push + open/reuse a GitHub PR; local → commit
// on the branch only (no remote, no `gh pr create`).
const FORGE_PUSH_STEP = isPr
  ? `Commit, then push the branch to origin, then ${
      resuming
        ? `REUSE the existing PR (confirm with \`gh pr list --head ${forgeBranch}\`) — NEVER open a duplicate`
        : 'open a PR with `gh pr create`'
    }. OPEN THE PR FIRST; any cross-model review is best-effort and must NEVER gate the PR or be a reason to yield your turn.`
  : `Commit on ${forgeBranch}. This repo has NO GitHub remote — do NOT push or run \`gh pr create\`; the OUTER loop merges the local branch.`
const FORGE_PR_LINE = isPr ? 'PR_NUMBER=<integer>' : 'PR_NUMBER=0   (local mode — no GitHub PR)'

const FORGE_BUILD_CONTRACT = `You are FORGE — Neutron's autonomous build sub-agent. You build, test, ${isPr ? 'push, and open a PR' : 'and commit'} without blocking on human input. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}

You are in a FRESH isolated git worktree (your cwd). Repo of record: ${repoPath}. Base branch: ${baseBranch}. Git-mode: ${mergeMode}.
CONTRACT
1. ${FORGE_STEP1}
2. Make the SMALLEST CORRECT change that satisfies the task. Match the codebase's conventions — three similar lines beat a premature abstraction.
3. Run the relevant tests (redirect verbose output to a log, read only the tail). Iterate until green.
4. ${FORGE_PUSH_STEP}
5. Write the branch diff to a file (e.g. \`git diff ${baseBranch}..HEAD > /tmp/trident-${slug}.diff\`) for the reviewers.
6. Report worktreePath (pwd), branch (=${forgeBranch}), commitSha, prNumber (${isPr ? 'the integer PR number' : 'null in local mode'}), diffFile, testsPassed via the schema. In your final text, also emit the last lines, unfenced:
   ${FORGE_PR_LINE}
   BRANCH=${forgeBranch}
   WORKTREE=<your worktree pwd>`

// Argus review rubric (from prompts/argus.md): APPROVE / REQUEST_CHANGES /
// COMMENT, blockers/important/nits, oversized-diff guard, NEVER a silent exit.
const ARGUS_RUBRIC = `You are ARGUS — Neutron's autonomous code-review sub-agent (read-only). ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}
Apply the Argus rubric: correctness, security, spec/as-built drift, and TEST-QUALITY discipline (reject toHaveBeenCalled-style gap tests; demand boundary/edge coverage). Identify blockers (must-fix before merge), important issues (should-fix), and minor nits (optional). Every finding AND every dismissal needs EVIDENCE (file:line or a concrete repro — verify before you assert). Do NOT modify files.
OVERSIZED-DIFF GUARD: never read a >~3000-line diff in one shot (the documented silent-exit trigger) — review the meaty commits one by one instead and STATE what you could not verify.
NEVER EXIT SILENTLY: if you cannot complete the review, return a TRUNCATED verdict explaining exactly what you could NOT verify — do not vanish.`

// RALPH bootstrap note (from prompts.ts RALPH_BOOTSTRAP_NOTE) — appended to the
// Forge build prompt when `ralph === true`: read SPEC.md, write
// IMPLEMENTATION_PLAN.md, build ONLY the top task this iteration.
const RALPH_NOTE = `\n\nRALPH MODE — this is a governed, spec-driven build:
- Read SPEC.md (and AS-BUILT.md if present) at the repo root — SPEC.md is the master spec; do NOT invent a competing plan doc.
- Write IMPLEMENTATION_PLAN.md at the repo root: a prioritized '- [ ] <task>' checklist of the discrete tasks needed to make the code match SPEC.md.
- Implement ONLY the single top-priority unchecked task this iteration; check it off ('- [x]') and commit everything.`

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
    { label: `checkpoint:${name}`, phase: 'Build' },
  )
}

// Normalise a reviewer verdict enum to the two terminal verdicts the OUTER loop
// acts on (APPROVE → merge; anything else → another fix round / failed).
function normalizeVerdict(v) {
  return v === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES'
}

// Parallel adversarial review + asymmetric-gated synthesis. Returns the
// synthesised verdict object (VERDICT_SCHEMA).
async function reviewAndSynthesize(diffFile, round) {
  phase('Review')
  log(`trident-v2 review: round=${round} diff=${diffFile}`)
  const verdicts = await parallel([
    () =>
      agent(
        `${ARGUS_RUBRIC}
Review the diff at ${diffFile} for the TASK below. Return your verdict + findings.
TASK: ${task}`,
        { label: 'argus:claude', phase: 'Review', schema: VERDICT_SCHEMA },
      ),
    () =>
      agent(
        `You are ARGUS-ADVERSARIAL (independent, read-only). ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}
Independently try to REFUTE the change at ${diffFile}: hunt NaN/overflow/off-by-one edges, hidden invariants, and untested boundaries. Evidence-gate EVERY claim (file:line or a concrete repro). Do NOT modify files. NEVER exit silently — if you cannot verify part of it, say so.
TASK: ${task}`,
        { label: 'argus:adversarial', phase: 'Review', schema: VERDICT_SCHEMA },
      ),
  ])

  // ASYMMETRIC GATING (minority-veto): findings BOTH reviewers confirm → confirmed;
  // ONE credible evidence-backed BLOCKER vetoes APPROVE; a single-reviewer
  // non-blocker → labelled `unverified` (surfaced, not merge-blocking).
  phase('Synthesis')
  const synthesis = await agent(
    `Synthesise these two INDEPENDENT review verdicts into ONE final verdict, applying ASYMMETRIC GATING:
- A finding BOTH reviewers raise → keep it as confirmed.
- ONE credible, evidence-backed BLOCKER is enough to VETO APPROVE (minority-veto) → verdict REQUEST_CHANGES.
- A single-reviewer NON-blocking finding → keep it but label it 'unverified' (surface it; do NOT block merge on it alone).
- Only return APPROVE when neither reviewer left a credible evidence-backed blocker.
Verdict A (rubric): ${JSON.stringify(verdicts[0])}
Verdict B (adversarial): ${JSON.stringify(verdicts[1])}`,
    { label: 'argus:synthesis', phase: 'Synthesis', schema: VERDICT_SCHEMA },
  )
  return synthesis
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
    return { ok: true, prNumber: pr, branch: forgeBranch, verdict: 'APPROVE', round: 0, checkpoint: 'argus-approved' }
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
  const ralphNote = ralph === true ? RALPH_NOTE : ''

  const forge = await agent(
    `${FORGE_BUILD_CONTRACT}${ralphNote}${reuseNote}

TASK:
${task}`,
    { label: 'forge:build', phase: 'Build', isolation: 'worktree', schema: FORGE_SCHEMA },
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
    await agent(
      `${FORGE_BUILD_CONTRACT}

You are FIXING Argus's findings on branch ${forgeBranch} (round ${round}). ${isPr ? `Do NOT open a new PR — push the SAME branch (\`gh pr list --head ${forgeBranch}\` to confirm it exists).` : `Commit on the SAME local branch ${forgeBranch} — no remote, no PR.`} Address every BLOCKER + important finding, run tests until green, commit${isPr ? ' + push' : ' locally'}, and re-write the diff file.
ARGUS FINDINGS (round ${round - 1}):
${JSON.stringify(synthesis.findings)}

TASK:
${task}`,
      { label: `forge:fix-round-${round}`, phase: 'Build', isolation: 'worktree', schema: FORGE_SCHEMA },
    )
    await checkpoint(`fix-round-${round}`, { pr })
    synthesis = await reviewAndSynthesize(diffFile, round)
    finalVerdict = normalizeVerdict(synthesis.verdict)
    await checkpoint(finalVerdict === 'APPROVE' ? 'argus-approved' : 'argus-request-changes', { pr })
  }

  log(`trident-v2 inner DONE: verdict=${finalVerdict} round=${round} pr=${pr}`)
  // The inner workflow RETURNS {PR#, verdict}; the OUTER/human layer does the
  // irreversible merge (merge.ts stays outer — defense in depth). This top-level
  // `return` is the Workflow runtime's result API (it wraps the body in an async
  // context). `node --check` flags it as an illegal top-level return — EXPECTED.
  return {
    ok: true,
    prNumber: pr,
    branch: forgeBranch,
    verdict: finalVerdict,
    round,
    checkpoint: finalVerdict === 'APPROVE' ? 'argus-approved' : 'argus-request-changes',
  }
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
    { label: 'cleanup:worktree', phase: 'Synthesis' },
  )
}
