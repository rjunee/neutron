/**
 * @neutronai/codegen-core — IN-TREE Argus-shape sub-agent system prompt.
 *
 * Re-implemented narrower from internal design notes. The Nova-
 * specific surface — `/codex:review --wait` cross-model gate, the
 * Telegram post-back convention — is STRIPPED. S1 reviews against
 * Sonnet 4.6 only (no Codex CLI cross-model gate); the broader cross-
 * model gate lands when the substrate composer (engineering-plan
 * § A.2) supports Codex CLI per the brief § 9 out-of-scope.
 *
 * Per docs/plans/code-gen-core-tier1-brief.md § 3.6.2.
 *
 * INVARIANT: this prompt body MUST NOT import anything from external sources
 * or `~/.claude/skills/`.
 */

export const ARGUS_SYSTEM_PROMPT = `You are Argus — Neutron's autonomous code-review sub-agent. You review the most recent commit on a branch and return an APPROVE / REQUEST CHANGES verdict.

SCOPE
- Branch: {{branch}}
- PR: #{{pr_number}}
- Round: {{round}} of {{max_rounds}}
- Read ONLY \`git show HEAD\` — the latest commit. Do NOT read the full {{default_branch}}..HEAD diff (causes silent exits on large branches).

CONTRACT
1. Read the HEAD commit.
2. Identify blockers (must-fix before merge), important issues (should-fix), minor nits (optional).
3. Emit a verdict line on its own: either \`APPROVE\` or \`REQUEST CHANGES\`.
4. If REQUEST CHANGES, follow with a numbered list of blockers + important + minor items. Be specific: file:line + what's wrong + what to do.
5. Keep the response under 4 KB.

RULES
- NEVER exit silently. If you cannot complete the review (diff too large, file you can't read, etc.), post a TRUNCATED verdict explaining what you couldn't verify.
- Be terse. The user is a busy operator.
- Don't suggest stylistic changes when the codebase already has a convention you're contradicting.`

export function renderArgusPrompt(input: {
  branch: string
  pr_number: number
  round: number
  max_rounds: number
  default_branch: string
}): string {
  return ARGUS_SYSTEM_PROMPT.replace(/\{\{branch\}\}/g, input.branch)
    .replace(/\{\{pr_number\}\}/g, String(input.pr_number))
    .replace(/\{\{round\}\}/g, String(input.round))
    .replace(/\{\{max_rounds\}\}/g, String(input.max_rounds))
    .replace(/\{\{default_branch\}\}/g, input.default_branch)
}

/**
 * Parse the Argus verdict out of the sub-agent's response text.
 * Returns either `APPROVE` or `REQUEST_CHANGES`. The default on
 * truly-unparseable output is `REQUEST_CHANGES` (fail-safe — if
 * Argus's output is unreadable, do NOT auto-merge).
 */
export function parseArgusVerdict(response: string): 'APPROVE' | 'REQUEST_CHANGES' {
  const trimmed = response.trim()
  // Look for a single line that says exactly APPROVE — first preference.
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim()
    if (l === 'APPROVE') return 'APPROVE'
    if (l === 'REQUEST CHANGES' || l === 'REQUEST_CHANGES') {
      return 'REQUEST_CHANGES'
    }
  }
  // If no exact line match, fall back to the first substring hit (the
  // sub-agent sometimes wraps the verdict in markdown — `**APPROVE**`).
  if (/\bAPPROVE\b/.test(trimmed) && !/REQUEST\s*CHANGES?/i.test(trimmed)) {
    return 'APPROVE'
  }
  // Default fail-safe: anything we can't parse cleanly is REQUEST_CHANGES.
  return 'REQUEST_CHANGES'
}

/**
 * Extract the bullet-list of findings Argus surfaces under a
 * REQUEST_CHANGES verdict. Splits on newline, keeps non-empty lines
 * that look like list items. Caller may decide how to present.
 */
export function parseArgusFindings(response: string): string[] {
  const lines = response.split(/\r?\n/)
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line === 'APPROVE' || line === 'REQUEST CHANGES' || line === 'REQUEST_CHANGES') continue
    // Strip common list-item markers so the surface text stays clean.
    const stripped = line.replace(/^[-*\d+.)]+\s*/, '').trim()
    if (stripped.length > 0) out.push(stripped)
  }
  return out
}
