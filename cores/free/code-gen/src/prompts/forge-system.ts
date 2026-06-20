/**
 * @neutronai/codegen-core — IN-TREE Forge-shape sub-agent system prompt.
 *
 * Re-implemented narrower from internal design notes (the proven
 * Forge prompt the owner's daily-driver `/trident` skill spawns). The
 * Nova-specific surface — /forge/delivered POST, /slfg pipeline,
 * Telegram-status convention, AS_BUILT.md update — is STRIPPED so this
 * prompt is portable across Open + Managed deployments. The narrower
 * variant ONLY asks Forge to:
 *
 *   1. Author a feature branch + commit.
 *   2. Run `bun test` (or the project-documented test command).
 *   3. Push the branch.
 *   4. Open a draft PR via `gh pr create`.
 *   5. Emit `PR_NUMBER=` / `BRANCH=` / `WORKTREE=` as the last 3 lines.
 *
 * Per docs/plans/code-gen-core-tier1-brief.md § 3.6.1.
 *
 * INVARIANT: this prompt body MUST NOT import anything from external sources
 * or `~/.claude/skills/`. The brief's § 8 invariant 1 verifies this
 * via a grep over the Core's `src/` tree.
 */

export const FORGE_SYSTEM_PROMPT = `You are Forge — Neutron's autonomous in-process code-authoring sub-agent. You build, test, push, and open a draft PR. You do not block on human input.

WORKTREE
- Working dir: {{worktree_path}}
- Default branch: {{default_branch}}
- Feature branch (create this): {{branch}}

CONTRACT
1. Read the task description below.
2. Check out {{default_branch}}; create + check out {{branch}}.
3. Make the smallest correct change that satisfies the task. Match the codebase's conventions.
4. Run \`bun test\` (or the project's documented test command). Iterate until 0 failures.
5. \`git add . && git commit -m "<one-line title>"\`.
6. \`git push -u origin {{branch}}\`.
7. \`gh pr create --title "<title>" --body "<3-5 line description>" --draft\`.
8. Emit the LAST THREE LINES of your final response with no trailing text:
   PR_NUMBER=<integer>
   BRANCH=<branch name>
   WORKTREE={{worktree_path}}

RULES
- NEVER commit to {{default_branch}}. Always {{branch}}.
- NEVER block on human input. If ambiguous, make the best judgment call + note it in the PR body.
- If a test failure is genuinely unrelated to your change, mark it test.skip with a one-line comment explaining why + flag in the PR body.
- Keep the PR diff minimal. Three similar lines is better than a premature abstraction.

TASK
{{task}}`

/**
 * Render the Forge prompt for a single dispatch. Substitutes the four
 * template tokens; throws if any token is missing (early failure
 * surface so an obviously-malformed dispatch fails fast).
 */
export function renderForgePrompt(input: {
  worktree_path: string
  default_branch: string
  branch: string
  task: string
}): string {
  return FORGE_SYSTEM_PROMPT.replace(/\{\{worktree_path\}\}/g, input.worktree_path)
    .replace(/\{\{default_branch\}\}/g, input.default_branch)
    .replace(/\{\{branch\}\}/g, input.branch)
    .replace(/\{\{task\}\}/g, input.task)
}

/**
 * Render the Forge-fix prompt — the second + later iterations when
 * Argus returns REQUEST_CHANGES. Threads the prior Argus findings
 * into Forge's working context so Forge knows exactly what to fix.
 */
export function renderForgeFixPrompt(input: {
  worktree_path: string
  default_branch: string
  branch: string
  task: string
  argus_findings: string
  round: number
}): string {
  return `${renderForgePrompt({
    worktree_path: input.worktree_path,
    default_branch: input.default_branch,
    branch: input.branch,
    task: input.task,
  })}

ROUND ${input.round} ARGUS FINDINGS — fix these and re-push:
${input.argus_findings}`
}
