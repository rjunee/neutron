/**
 * @neutronai/trident — Forge / Argus sub-agent prompts + result parsers.
 *
 * Trident-OWNED port of Vajra's `~/vajra/prompts/forge.md` +
 * `~/vajra/prompts/argus.md`, adapted to Open's substrate (no tmux,
 * no `spawn-agent.sh`, no `/forge/delivered` POST, no Telegram). A
 * Forge/Argus turn here is a single substrate session driven by the
 * tick loop, so the prompts ask only for the work + the locked terminal
 * contract lines the orchestrator parses.
 *
 * Layering note: this module is owned by the foundational `trident/`
 * runtime — it deliberately does NOT import from `cores/free/code-gen`
 * (a Core importing-up into the runtime is fine; the runtime importing
 * DOWN into a Core is not). The shapes intentionally mirror code-gen's
 * `prompts/*-system.ts` so PR-5 can retire the Core wrapper onto these.
 *
 * INVARIANT (ported from Vajra battle-tested fixes):
 *   • Forge emits PR_NUMBER / BRANCH / WORKTREE as the LAST lines, never
 *     fenced — a closing ``` would be misread as the last line.
 *   • Argus NEVER exits silently: on any blocker (oversized diff, a file
 *     it can't read) it posts a TRUNCATED verdict saying what it could
 *     not verify, rather than vanishing.
 *   • Oversized-diff guard: Argus never reads a >~3000-line diff in one
 *     shot (the documented silent-exit trigger). `chooseArgusScope`
 *     selects the focused scope from a pre-spawn diff-size probe.
 */

import type { TridentRun } from './store.ts'

/**
 * Diff-size ceiling (in changed lines) above which Argus must NOT read
 * the diff in one shot. Verbatim from Vajra's SKILL.md oversized-diff
 * rule ("only if that diff is under 3000 lines").
 */
export const ARGUS_DIFF_LINE_LIMIT = 3000

// ---------------------------------------------------------------------------
// Forge
// ---------------------------------------------------------------------------

export const FORGE_SYSTEM_PROMPT = `You are Forge — Neutron's autonomous build sub-agent. You build, test, push, and open a PR without blocking on human input.

WORKTREE / REPO
- Working dir: {{repo_path}}
- Base branch: {{base_branch}}
- Feature branch (create + use this): {{branch}}

CONTRACT
1. Read the task below.
2. From {{base_branch}}, create + check out {{branch}}.
3. Make the smallest correct change that satisfies the task. Match the codebase's conventions.
4. Run the project's test command (e.g. \`bun test\`). Iterate until it is green.
5. \`git add -A && git commit -m "<one-line title>"\`.
6. Push the branch ({{push_hint}}).
7. Open the PR ({{pr_hint}}).
8. Emit the LAST THREE LINES of your final response with NO trailing text and NOT wrapped in a code fence:
   PR_NUMBER=<integer>
   BRANCH={{branch}}
   WORKTREE={{repo_path}}

RULES
- NEVER commit to {{base_branch}}. Always {{branch}}.
- NEVER block on human input. If ambiguous, make the best judgment call + note it in the PR body.
- If a test failure is genuinely unrelated to your change, skip it with a one-line reason + flag it in the PR body.
- Keep the diff minimal. Three similar lines beats a premature abstraction.

CROSS-MODEL REVIEW (best-effort — NEVER a hang point)
- Order is FIXED: OPEN THE PR FIRST (steps 6-8 above), THEN run any cross-model / second-model / Codex review. The PR must already exist so a stalled or timed-out review never costs the deliverable.
- A cross-model review is BEST-EFFORT. It must NEVER gate the PR, block your turn, or be a reason to withhold the contract lines. A failed, empty, or timed-out review is fine — note it and move on.
- NEVER end your turn to "wait for", "be notified by", or "resume when" an async / background review (or a scheduled wakeup that awaits one). Nothing resumes a yielded headless turn, so it idles until reaped with the PR unshipped. If you run a review at all, run it SYNCHRONOUSLY inline in this turn (a blocking foreground call) and read its result here, or skip it entirely.`

/**
 * The Ralph BOOTSTRAP note, appended to the initial Forge prompt when a
 * run is governed (`run.ralph`). This is the FIRST iteration of the
 * one-task-per-fresh-context loop: the init Forge writes the first
 * `IMPLEMENTATION_PLAN.md`, builds ONLY the top task, and reports how many
 * tasks remain. Ported from Vajra SKILL.md "Ralph build mode (v3)"
 * `RALPH_INIT_NOTE`.
 */
export const RALPH_BOOTSTRAP_NOTE = `RALPH MODE — this is the FIRST iteration of a one-task-per-fresh-context loop (a governed, spec-driven build):
- Read SPEC.md (and AS-BUILT.md if present) at the repo root. SPEC.md is the master spec — do NOT invent a competing plan doc.
- Write IMPLEMENTATION_PLAN.md at the repo root: a prioritized checklist of the discrete tasks needed to make the code match SPEC.md, each as '- [ ] <task>'.
- Implement ONLY the single top-priority unchecked task. Do NOT start any other task — later iterations get their own fresh context.
- Write/run tests for that one task, update AS-BUILT.md, and check that one task off ('- [x]') in IMPLEMENTATION_PLAN.md. Commit everything.
- In ADDITION to the three contract lines above, emit a FOURTH last line (bare, NOT fenced):
  REMAINING_TASKS=<count of still-unchecked '- [ ]' items in IMPLEMENTATION_PLAN.md>
- A missing/garbled REMAINING_TASKS halts the whole build, so ALWAYS emit a valid integer count.`

/**
 * Render the initial Forge prompt for a run. The push/PR hints differ by
 * merge mode so a `local` run (no GitHub remote) is not told to run
 * `gh pr create`. When `run.ralph` is set the Ralph bootstrap note is
 * appended so the first iteration writes the plan + reports
 * `REMAINING_TASKS` (parsed by `parseForgeOutput`).
 */
export function renderForgePrompt(run: TridentRun, base_branch: string): string {
  const branch = run.branch ?? `trident/${run.slug}`
  const isPr = run.merge_mode === 'pr'
  const push_hint = isPr ? `git push -u origin ${branch}` : `commit locally on ${branch}`
  const pr_hint = isPr
    ? `gh pr create --title "<title>" --body "<3-5 line description>"`
    : `there is no GitHub remote — record the branch name as PR_NUMBER is a local placeholder; emit PR_NUMBER=0`
  const ralphNote = run.ralph ? `\n\n${RALPH_BOOTSTRAP_NOTE}` : ''
  return fill(FORGE_SYSTEM_PROMPT, {
    repo_path: run.worktree ?? run.repo_path,
    base_branch,
    branch,
    push_hint,
    pr_hint,
  }) + ralphNote + `\n\nTASK\n${run.task}`
}

/**
 * Render the Ralph PLANNING-pass prompt — a fresh, docs-only Forge turn
 * that diffs `SPEC.md` against the actual code on the branch and rewrites
 * a prioritized `IMPLEMENTATION_PLAN.md`. It writes NO feature code and
 * reports the unchecked-task count + the single next task. Ported from
 * Vajra SKILL.md "Spawn a Ralph planner".
 */
export function renderRalphPlanPrompt(run: TridentRun, base_branch: string): string {
  const branch = run.branch ?? `trident/${run.slug}`
  const dir = run.worktree ?? run.repo_path
  const commit_hint =
    run.merge_mode === 'pr' ? `push the branch` : `commit locally on ${branch}`
  return `You are Forge running a RALPH PLANNING PASS — NO feature code this turn. Working dir: ${dir}, branch: ${branch} (base ${base_branch}).

CONTRACT
1. Read SPEC.md at the repo root (the master spec) and AS-BUILT.md if present.
2. Diff the SPEC against the ACTUAL code on this branch: what does the spec require that the code does NOT yet do, or does differently? Include code that has drifted from the spec, not only unbuilt tasks.
3. Rewrite IMPLEMENTATION_PLAN.md at the repo root as a prioritized checklist: '- [x] <task>' for what the code already satisfies, '- [ ] <task>' for what remains, highest-leverage first. Keep it tight — it drives the next single-task build.
4. Commit ONLY IMPLEMENTATION_PLAN.md (docs-only; do NOT touch feature code or AS-BUILT.md this turn), then ${commit_hint}.
5. Emit the LAST TWO LINES with NO trailing text and NOT wrapped in a code fence:
   REMAINING_TASKS=<count of unchecked '- [ ]' items>
   NEXT_TASK=<the single top-priority unchecked task, one line>

RULES
- SPEC.md is the source of truth — read it, NEVER rewrite it.
- Exactly one IMPLEMENTATION_PLAN.md at the repo root — regenerate it, NEVER fork a competing plan doc.
- A missing/garbled REMAINING_TASKS halts the whole build, so ALWAYS emit a valid integer count.`
}

/**
 * Render the Ralph TASK prompt — a fresh Forge with a clean context that
 * implements ONLY the single top task the planner surfaced. Progress lives
 * in files + git history, never in a context window. Ported from Vajra
 * SKILL.md "ralph-task" phase.
 */
export function renderRalphTaskPrompt(
  run: TridentRun,
  base_branch: string,
  next_task: string | null,
): string {
  const branch = run.branch ?? `trident/${run.slug}`
  const dir = run.worktree ?? run.repo_path
  const task =
    next_task !== null && next_task.trim().length > 0
      ? next_task.trim()
      : 'the single top-priority unchecked task in IMPLEMENTATION_PLAN.md'
  const commit_hint =
    run.merge_mode === 'pr' ? `push the same branch` : `commit locally on ${branch}`
  return `You are Forge running a RALPH TASK — ONE task, fresh context. Working dir: ${dir}, branch: ${branch} (base ${base_branch}).

CONTRACT
1. Read SPEC.md and IMPLEMENTATION_PLAN.md at the repo root.
2. Implement ONLY this single task: ${task}
3. Do NOT start any other unchecked task — the next iteration gets its own fresh context.
4. Write/run tests for it until green. Update AS-BUILT.md. Check THIS one task off ('- [x]') in IMPLEMENTATION_PLAN.md.
5. Commit everything and ${commit_hint} (the PR/branch already exists; this updates it).
6. Emit the LAST THREE LINES with NO trailing text and NOT wrapped in a code fence:
   PR_NUMBER=${run.pr ?? 0}
   BRANCH=${branch}
   WORKTREE=${dir}`
}

/**
 * Render the Forge-fix prompt — round 2+ after Argus REQUEST CHANGES.
 * Threads the prior Argus findings into Forge's context so it knows
 * exactly what to address, then re-pushes the SAME branch.
 */
export function renderForgeFixPrompt(
  run: TridentRun,
  base_branch: string,
  findings: readonly string[],
  round: number,
): string {
  const branch = run.branch ?? `trident/${run.slug}`
  const numbered =
    findings.length > 0
      ? findings.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : '(no machine-parsed findings — re-read the latest Argus verdict in context)'
  return `You are Forge — fixing Argus's findings on branch ${branch} (PR #${run.pr ?? '?'}, round ${round}).

WORKTREE / REPO
- Working dir: ${run.worktree ?? run.repo_path}
- Base branch: ${base_branch}
- Branch to update (do NOT open a new one): ${branch}

CONTRACT
1. Address EVERY blocker + important finding below. Minor nits are optional.
2. Run the project's test command until green.
3. \`git add -A && git commit -m "fix: address Argus round ${round} findings"\` and push the same branch.
4. Emit the LAST THREE LINES with NO trailing text and NOT fenced:
   PR_NUMBER=${run.pr ?? 0}
   BRANCH=${branch}
   WORKTREE=${run.worktree ?? run.repo_path}

ROUND ${round} ARGUS FINDINGS:
${numbered}`
}

// ---------------------------------------------------------------------------
// Argus
// ---------------------------------------------------------------------------

export const ARGUS_SYSTEM_PROMPT = `You are Argus — Neutron's autonomous code-review sub-agent. You review a branch's changes and return an APPROVE / REQUEST CHANGES verdict.

SCOPE
- Branch: {{branch}}
- PR: #{{pr_number}}
- Round: {{round}} of {{max_rounds}}
{{scope}}

CONTRACT
1. Read the changes within the scope above.
2. Identify blockers (must-fix before merge), important issues (should-fix), and minor nits (optional).
3. Emit a verdict line on its own: either \`APPROVE\` or \`REQUEST CHANGES\`.
4. If REQUEST CHANGES, follow with a numbered list (blockers first). Be specific: file:line + what's wrong + what to do.
5. Keep the response under 4 KB.

RULES
- NEVER exit silently. If you cannot complete the review (diff too large, a file you can't read), post a TRUNCATED verdict explaining exactly what you could NOT verify — do not vanish.
- Be terse and fair. Block on correctness, security, and spec adherence — never on style the codebase already contradicts.`

/**
 * Choose Argus's review scope text from a pre-spawn diff-size probe.
 * Ports Vajra's oversized-diff guard:
 *
 *   • round 1 → review the branch (`git diff <base>..HEAD`) when it is
 *     under the line limit; otherwise review the meaty commits one by
 *     one and say what couldn't be verified.
 *   • round 2+ → the fix-pass is one commit; review `git show HEAD`.
 *
 * A single commit (round > 1) is always small, so the guard only ever
 * downgrades the round-1 full-branch read.
 */
export function chooseArgusScope(input: {
  base_branch: string
  round: number
  diff_line_count: number
}): string {
  if (input.round > 1) {
    return `- Review ONLY the latest fix commit: \`git show HEAD\`. Do NOT read the full ${input.base_branch}..HEAD diff (silent-exit trigger on large branches).`
  }
  if (input.diff_line_count <= ARGUS_DIFF_LINE_LIMIT) {
    return `- Review the whole branch: \`git diff ${input.base_branch}..HEAD\` (${input.diff_line_count} changed lines — under the ${ARGUS_DIFF_LINE_LIMIT}-line ceiling).`
  }
  return `- The branch diff is ${input.diff_line_count} lines — OVER the ${ARGUS_DIFF_LINE_LIMIT}-line ceiling. Do NOT read it in one shot (silent-exit trigger). Instead run \`git log --oneline ${input.base_branch}..HEAD\`, \`git show <sha>\` the most significant commits, and EXPLICITLY state in your verdict which parts you could not verify.`
}

export function renderArgusPrompt(input: {
  branch: string
  pr_number: number
  round: number
  max_rounds: number
  base_branch: string
  diff_line_count: number
}): string {
  const scope = chooseArgusScope({
    base_branch: input.base_branch,
    round: input.round,
    diff_line_count: input.diff_line_count,
  })
  return fill(ARGUS_SYSTEM_PROMPT, {
    branch: input.branch,
    pr_number: String(input.pr_number),
    round: String(input.round),
    max_rounds: String(input.max_rounds),
    scope,
  })
}

// ---------------------------------------------------------------------------
// Parsers — the locked terminal contract
// ---------------------------------------------------------------------------

export interface ParsedForgeOutput {
  pr_number: number
  branch: string
  worktree: string
  /** Unchecked-task count from a Ralph bootstrap/planner; null when absent. */
  remaining: number | null
}

/**
 * Parse Forge's locked terminal lines (`PR_NUMBER=` / `BRANCH=` /
 * `WORKTREE=`, plus an optional `REMAINING_TASKS=` for Ralph). Walks
 * from the END so trailing preamble can't shadow the contract. Returns
 * null when the three required lines are not all present — the caller
 * decides whether that is a hard fail (Forge contract breach).
 */
export function parseForgeOutput(response: string): ParsedForgeOutput | null {
  const lines = response
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  let pr_number: number | undefined
  let branch: string | undefined
  let worktree: string | undefined
  let remaining: number | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (remaining === null && line.startsWith('REMAINING_TASKS=')) {
      // Strict `^[0-9]+$` (Vajra's fail-loud rule): a garbled count stays
      // null so the state machine halts rather than treating it as "0".
      remaining = parseStrictCount(line.slice('REMAINING_TASKS='.length))
      continue
    }
    if (worktree === undefined && line.startsWith('WORKTREE=')) {
      worktree = line.slice('WORKTREE='.length).trim()
      continue
    }
    if (branch === undefined && line.startsWith('BRANCH=')) {
      branch = line.slice('BRANCH='.length).trim()
      continue
    }
    if (pr_number === undefined && line.startsWith('PR_NUMBER=')) {
      const n = parseInt(line.slice('PR_NUMBER='.length).trim(), 10)
      if (Number.isFinite(n) && n >= 0) pr_number = n
      continue
    }
  }
  if (pr_number === undefined || branch === undefined || worktree === undefined) {
    return null
  }
  return { pr_number, branch, worktree, remaining }
}

export interface ParsedRalphPlan {
  /**
   * Unchecked-task count. `null` when the planner emitted no valid
   * `REMAINING_TASKS=<int>` line — the state machine fails LOUDLY on that
   * (never review a partial governed build), so this is deliberately NOT
   * coerced to 0.
   */
  remaining: number | null
  /** The single top-priority next task, threaded into the next ralph-task. */
  next_task: string | null
}

/**
 * Parse a Ralph PLANNING pass's terminal lines (`REMAINING_TASKS=` +
 * `NEXT_TASK=`). UNLIKE `parseForgeOutput`, a planner does a docs-only
 * commit and emits NO PR/BRANCH/WORKTREE contract — so this parser does
 * not require them. Walks from the END so trailing preamble can't shadow
 * the contract. `REMAINING_TASKS` is matched strictly (`^[0-9]+$`); a
 * missing/garbled count yields `remaining: null` (fail-loud upstream).
 */
export function parseRalphPlan(response: string): ParsedRalphPlan {
  const lines = response
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  let remaining: number | null = null
  let next_task: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (remaining === null && line.startsWith('REMAINING_TASKS=')) {
      remaining = parseStrictCount(line.slice('REMAINING_TASKS='.length))
      continue
    }
    if (next_task === null && line.startsWith('NEXT_TASK=')) {
      const t = line.slice('NEXT_TASK='.length).trim()
      if (t.length > 0) next_task = t
      continue
    }
  }
  return { remaining, next_task }
}

/**
 * Parse the Argus verdict. Returns `APPROVE` or `REQUEST_CHANGES`. The
 * fail-safe default on unparseable output is `REQUEST_CHANGES` — an
 * unreadable verdict must NEVER auto-merge (Vajra's no-silent-exit +
 * no-silent-merge invariant).
 */
export function parseArgusVerdict(response: string): 'APPROVE' | 'REQUEST_CHANGES' {
  const trimmed = response.trim()
  for (const raw of trimmed.split(/\r?\n/)) {
    const l = raw.trim().replace(/\*\*/g, '').replace(/^#+\s*/, '')
    if (l === 'APPROVE') return 'APPROVE'
    if (l === 'REQUEST CHANGES' || l === 'REQUEST_CHANGES') return 'REQUEST_CHANGES'
  }
  if (/\bAPPROVE\b/.test(trimmed) && !/REQUEST\s*CHANGES?/i.test(trimmed)) {
    return 'APPROVE'
  }
  return 'REQUEST_CHANGES'
}

/**
 * Extract the bullet/numbered findings under a REQUEST_CHANGES verdict,
 * stripping list markers. Used to thread findings into the Forge-fix
 * prompt.
 */
export function parseArgusFindings(response: string): string[] {
  const out: string[] = []
  for (const raw of response.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    const bare = line.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim()
    if (bare === 'APPROVE' || bare === 'REQUEST CHANGES' || bare === 'REQUEST_CHANGES') continue
    const stripped = line.replace(/^[-*\d.)\s]+/, '').trim()
    if (stripped.length > 0) out.push(stripped)
  }
  return out
}

/**
 * Strict non-negative-integer parse (`^[0-9]+$`). Returns null for any
 * non-numeric / negative / decimal value — the basis of the "missing or
 * garbled REMAINING_TASKS fails loudly" guard (a partial governed build
 * must never be silently treated as done).
 */
function parseStrictCount(raw: string): number | null {
  const v = raw.trim()
  return /^[0-9]+$/.test(v) ? parseInt(v, 10) : null
}

function fill(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v)
  }
  return out
}
