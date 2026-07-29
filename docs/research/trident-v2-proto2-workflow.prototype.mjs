// =============================================================================
// PROTOTYPE — Trident v2 inner loop as a CC Dynamic Workflow (reference seed)
// =============================================================================
//
// STATUS: PROTOTYPE / REFERENCE ONLY. Not wired into the build. Not imported by
//         anything. Not a test. Lives in docs/research/ so CI's `tsc --noEmit`
//         (explicit .ts include list) and `run-tests.sh` (*.test.ts only) never
//         touch it.
//
// PURPOSE: the seed Phase 2 grows into the real trident-v2 inner workflow. It
//          encodes the shape proven by prototype-2 (2026-06-28) — Forge build in
//          an isolated worktree -> parallel adversarial Argus review -> verdict —
//          PLUS the two non-obvious requirements the prototype surfaced:
//
//   (A) WORKTREE CLEANUP IS EXPLICIT. `isolation:'worktree'` auto-removes a
//       worktree ONLY IF UNCHANGED. A Forge agent always commits, so its
//       worktree is left ORPHANED unless trident removes it itself. The
//       finally-block below is the load-bearing D-1 fix. (Evidence: proto-2 run
//       wf_13f3e3c8-726 left .claude/worktrees/wf_13f3e3c8-726-1 on disk with a
//       commit after the workflow returned.)
//
//   (B) LONG-COMMAND OUTPUT MUST BE REDIRECTED TO A FILE. The Q1 agent ran the
//       full 822-file / 8638-test suite in one agent() (281s, no timeout / token
//       cap / context overflow) ONLY because it piped the ~4800-line output to a
//       log and read just the summary tail. Inline that rule into every agent
//       prompt that runs a verbose/long command.
//
// HOW TO RUN: invoke via the CC `Workflow` tool with this file's path as
//             `scriptPath`. Globals (agent/parallel/pipeline/phase/log/budget)
//             are injected by the Workflow runtime — this file is NOT runnable
//             with plain `node`/`bun`.
//
// The DURABLE OUTER loop (TridentTickLoop + code_trident_runs SQLite, migration
// 0077) is NOT here — it stays as-is. This file is only the INNER workflow.
// Cross-session resume does NOT exist (proto-2 confirmed resumeFromRunId is
// same-session only); the outer loop checkpoints each phase (proto-2 confirmed
// an agent() Bash step can write sqlite/file mid-workflow) and relaunches a
// FRESH workflow that idempotently skips completed phases on crash-restart.
// =============================================================================

export const meta = {
  name: 'trident-v2-inner',
  description: 'PROTOTYPE: trident-v2 inner loop — Forge(worktree) -> parallel adversarial Argus -> verdict, with mandatory worktree cleanup.',
  phases: [
    { title: 'Build' },
    { title: 'Review' },
    { title: 'Synthesis' },
  ],
}

// `args` is supplied by the outer loop: { repoPath, task, baseBranch, slug, maxRounds }
const { repoPath, task, baseBranch = 'main', slug = 'trident-run', maxRounds = 3 } =
  (args || {})

// Deterministic branch name — the cleanup step finds the worktree by this name
// even if Forge fails before returning a result (see the finally block).
const forgeBranch = `trident/${slug}`

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
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
  type: 'object', additionalProperties: false,
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

// The Forge/Argus personas (CLAUDE.md, the no-interactive-prompt rule, the
// review rubric) must be INLINED — workflow agent()s are BARE workers (proto-2
// C6). Keep these as imported constants in Phase 2; abbreviated here.
const NO_INTERACTIVE_RULE =
  'You run unattended. NEVER call AskUserQuestion or any interactive prompt — if you would need to ask, ABORT with a clear error instead of hanging. Make the best judgment call and note it.'

const REDIRECT_RULE =
  'For ANY long or verbose command (builds, full test runs), redirect stdout+stderr to a log file and read ONLY the summary tail — never let raw output flood your context.'

phase('Build')
log(`trident-v2 inner: slug=${slug} budget.total=${String(budget.total)} spent=${budget.spent()}`)

let forge = null
try {
  forge = await agent(
    `You are FORGE. ${NO_INTERACTIVE_RULE} ${REDIRECT_RULE}
Repo: ${repoPath}. You are in a fresh isolated git worktree (your cwd). Build this task on the DETERMINISTIC branch '${forgeBranch}' (run \`git switch -c ${forgeBranch}\` as your FIRST step — the cleanup step relies on this exact name to find your worktree even if you fail later):

TASK:
${task}

Then: run the relevant tests (redirect output to a log, read the tail), commit, push the branch to origin, open a PR with \`gh pr create\`, and write your diff to a file for the reviewers. Report worktreePath (pwd), branch, commitSha, prNumber, diffFile, testsPassed.`,
    { label: 'forge:build', phase: 'Build', isolation: 'worktree', schema: FORGE_SCHEMA }
  )

  if (!forge) throw new Error('forge agent returned null (terminal error)')

  // -------------------- ADVERSARIAL REVIEW (parallel, proven) --------------
  phase('Review')
  const verdicts = await parallel([
    () => agent(
      `You are ARGUS (Claude, read-only). ${NO_INTERACTIVE_RULE}
Review the diff at ${forge.diffFile} for the task below. Apply the v1 Argus rubric: spec/as-built drift, correctness, and TEST-QUALITY discipline (reject toHaveBeenCalled-style gap tests; demand boundary/edge coverage). Every finding AND every dismissal needs evidence (file:line / repro). Do NOT modify files.
TASK: ${task}`,
      { label: 'argus:claude', phase: 'Review', schema: VERDICT_SCHEMA }
    ),
    // Phase 5: add a second, MODEL-DIVERSE reviewer that shells out to codex
    // (an external runtime an agent INVOKES; NOT agent({model})). Kept as a
    // second Claude lens here until Codex-OAuth admin capture lands.
    () => agent(
      `You are ARGUS-2 (independent, read-only, adversarial). ${NO_INTERACTIVE_RULE}
Independently try to REFUTE the change at ${forge.diffFile}: hunt NaN/overflow/edge cases, hidden invariants, and untested boundaries. Evidence-gate every claim. Do NOT modify files.
TASK: ${task}`,
      { label: 'argus:adversarial', phase: 'Review', schema: VERDICT_SCHEMA }
    ),
  ])

  // -------------------- SYNTHESIS (asymmetric gating) ----------------------
  // minority-veto: one credible evidence-backed blocker blocks merge; a single
  // non-confirmed finding surfaces as `unverified`, not a merge-blocker.
  phase('Synthesis')
  const synthesis = await agent(
    `Merge these two review verdicts into one. Keep findings BOTH reviewers confirm as confirmed; a single credible evidence-backed BLOCKER vetoes APPROVE; single-reviewer non-blocking findings -> label unverified. Output the final verdict + the merged finding list.
Verdict A: ${JSON.stringify(verdicts[0])}
Verdict B: ${JSON.stringify(verdicts[1])}`,
    { label: 'argus:synthesis', phase: 'Synthesis', schema: VERDICT_SCHEMA }
  )

  // Inner workflow RETURNS {PR#, verdict}; the OUTER/human layer does the
  // irreversible merge (merge.ts stays outer — defense in depth).
  // NOTE: top-level `return` is the Workflow runtime's result API (it wraps the
  // body in an async context). `node --check` flags it as an illegal top-level
  // return — that's expected; this is a Workflow script, NOT a plain-node module.
  return { ok: true, prNumber: forge.prNumber, branch: forge.branch, verdict: synthesis, budget: { total: budget.total, spent: budget.spent() } }
} finally {
  // (A) MANDATORY WORKTREE CLEANUP — runs on success, REQUEST_CHANGES, throw,
  // or abort. The harness removes a worktree ONLY IF UNCHANGED, and a Forge build
  // always changes its worktree, so trident must remove it explicitly.
  //
  // CRITICAL (proto-2 codex review): the cleanup CANNOT depend on `forge` being a
  // valid result. If Forge mutates its worktree then fails before returning JSON
  // (tests fail, `gh pr create` fails, the agent throws -> agent() returns null),
  // `forge` is null yet the changed worktree exists. So we clean up by SCANNING
  // git state for any worktree on the deterministic '${forgeBranch}' branch —
  // independent of Forge's return value. This is what makes the guarantee hold on
  // ALL paths. (The branch is pushed on the success path, so deleting the local
  // worktree+branch loses nothing.)
  await agent(
    `Cleanup step (must succeed on every path). From ${repoPath}, ignoring individual failures:
1. Find the worktree for branch '${forgeBranch}':  git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{ if ($2=="refs/heads/${forgeBranch}") print w }'
2. For that path (if any):  git worktree remove --force <path>
3. git branch -D ${forgeBranch}   (ignore "not found")
4. git worktree prune
5. Verify: git worktree list — confirm NO worktree remains on '${forgeBranch}'. Report the final worktree count and whether any orphan remained.`,
    { label: 'cleanup:worktree', phase: 'Synthesis' }
  )
}
