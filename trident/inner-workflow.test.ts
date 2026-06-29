/**
 * Source-string assertions over `trident/inner-workflow.mjs` (mirrors
 * `prompts-disk-source.test.ts`). The inner workflow is a CC Dynamic Workflow
 * script — NOT runnable under plain bun/node (its globals
 * agent/parallel/phase/log/budget are injected by the Workflow runtime, and the
 * top-level `return` is the runtime's result API). So it is verified by asserting
 * the load-bearing requirements are PRESENT in the script source, not by
 * executing it. (The launcher mechanics that DRIVE it are unit-tested in
 * inner-loop.test.ts; the orchestrator that LAUNCHES it in orchestrator.test.ts.)
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

describe('inner-workflow.mjs — meta + phases', () => {
  test('exports a pure meta literal named trident-v2-inner with the three phases', () => {
    expect(SRC).toContain("name: 'trident-v2-inner'")
    expect(SRC).toMatch(/export const meta = \{/)
    expect(SRC).toContain("{ title: 'Build' }")
    expect(SRC).toContain("{ title: 'Review' }")
    expect(SRC).toContain("{ title: 'Synthesis' }")
  })

  test('destructures the args contract with defaults', () => {
    for (const key of ['repoPath', 'task', 'baseBranch', 'slug', 'maxRounds', 'ralph', 'prNumber', 'branch', 'dbPath', 'runId', 'resumeCheckpoint']) {
      expect(SRC).toContain(key)
    }
  })

  // A real headless launcher run (2026-06-28) showed the substrate claude can
  // serialize the `Workflow` tool's `args` as a JSON STRING instead of an
  // object; destructuring a raw string yields all-undefined (slug→default,
  // dbPath/runId→undefined → checkpoints no-op → crash-resume dead, mergeMode→
  // 'pr', task→undefined). The script must NORMALIZE args before destructuring.
  test('normalizes a JSON-STRING args form before destructuring (real-run blocker fix)', () => {
    expect(SRC).toContain('function normalizeWorkflowArgs(')
    // Destructures the normalized value, NOT the raw `args || {}`.
    expect(SRC).toContain('} = normalizeWorkflowArgs(args)')
    // Parses a string form and guards a non-object/parse-failure to {}.
    expect(SRC).toContain("typeof raw === 'string'")
    expect(SRC).toContain('JSON.parse(raw)')
  })
})

// Execute the EXACT normalization logic the script uses, so the fix is verified
// behaviorally (not just by source string). Kept in lockstep with the .mjs.
describe('inner-workflow.mjs — args normalization behavior', () => {
  function normalizeWorkflowArgs(raw: unknown): Record<string, unknown> {
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      } catch {
        return {}
      }
    }
    return (raw as Record<string, unknown>) || {}
  }

  test('a JSON-STRING args form is parsed so fields survive', () => {
    const raw = JSON.stringify({ slug: 'v2-verify', dbPath: '/tmp/x.db', runId: 'r1', mergeMode: 'local', maxRounds: 1 })
    const a = normalizeWorkflowArgs(raw)
    expect(a['slug']).toBe('v2-verify')
    expect(a['dbPath']).toBe('/tmp/x.db')
    expect(a['runId']).toBe('r1')
    expect(a['mergeMode']).toBe('local')
    expect(a['maxRounds']).toBe(1)
  })

  test('an OBJECT args form passes through unchanged', () => {
    const obj = { slug: 'v2-verify', mergeMode: 'local' }
    expect(normalizeWorkflowArgs(obj)).toBe(obj)
  })

  test('a malformed string / null / undefined degrades to an empty object (defaults apply)', () => {
    expect(normalizeWorkflowArgs('not json')).toEqual({})
    expect(normalizeWorkflowArgs('"a-bare-string"')).toEqual({})
    expect(normalizeWorkflowArgs(null)).toEqual({})
    expect(normalizeWorkflowArgs(undefined)).toEqual({})
  })
})

describe('inner-workflow.mjs — inlined contracts + rules in EVERY agent', () => {
  test('inlines the Forge build contract (PR_NUMBER/BRANCH/WORKTREE, push + open PR, smallest-correct-change)', () => {
    expect(SRC).toContain('PR_NUMBER=')
    expect(SRC).toContain('BRANCH=')
    expect(SRC).toContain('WORKTREE=')
    expect(SRC).toContain('open a PR')
    expect(SRC).toContain('SMALLEST CORRECT change')
  })

  test('inlines the Argus rubric (APPROVE/REQUEST_CHANGES, blockers/important/nits, oversized-diff guard, never silent exit)', () => {
    expect(SRC).toContain('APPROVE')
    expect(SRC).toContain('REQUEST_CHANGES')
    expect(SRC).toContain('blockers')
    expect(SRC).toContain('OVERSIZED-DIFF GUARD')
    expect(SRC).toContain('NEVER EXIT SILENTLY')
  })

  test('NO_INTERACTIVE_RULE + REDIRECT_RULE are defined and woven into agent prompts', () => {
    expect(SRC).toContain('NEVER call AskUserQuestion')
    expect(SRC).toContain('redirect stdout+stderr to a log file')
    // Both rules are interpolated into the Forge + Argus prompts.
    expect(SRC).toContain('${NO_INTERACTIVE_RULE}')
    expect(SRC).toContain('${REDIRECT_RULE}')
  })
})

describe('inner-workflow.mjs — deterministic branch + worktree isolation', () => {
  test('deterministic branch is trident/<slug>', () => {
    expect(SRC).toContain('`trident/${slug}`')
  })

  test('Forge build agent uses isolation:worktree + FORGE_SCHEMA', () => {
    expect(SRC).toContain("isolation: 'worktree'")
    expect(SRC).toContain('schema: FORGE_SCHEMA')
  })

  test('ralph bootstrap note appended when ralph === true', () => {
    expect(SRC).toContain('ralph === true ? RALPH_NOTE')
    expect(SRC).toContain('RALPH MODE')
    expect(SRC).toContain('IMPLEMENTATION_PLAN.md')
  })
})

describe('inner-workflow.mjs — per-phase SQLite checkpointing (C1)', () => {
  test('a checkpoint Bash step UPDATEs code_trident_runs with date -u timestamps', () => {
    expect(SRC).toContain('sqlite3 "${dbPath}"')
    expect(SRC).toContain('UPDATE code_trident_runs SET')
    expect(SRC).toContain("WHERE id='${runId}'")
    // Timestamps computed IN the Bash step (Date.now unavailable in workflows).
    expect(SRC).toContain('$(date -u +%FT%TZ)')
  })

  test('checkpoints forge-done, argus-approved/argus-request-changes, and fix-round-N', () => {
    expect(SRC).toContain("checkpoint('forge-done'")
    expect(SRC).toContain("'argus-approved'")
    expect(SRC).toContain("'argus-request-changes'")
    expect(SRC).toContain('checkpoint(`fix-round-${round}`')
  })
})

describe('inner-workflow.mjs — idempotent crash-resume (C2)', () => {
  test("resumeCheckpoint === 'argus-approved' skips build+review", () => {
    expect(SRC).toContain("resumeCheckpoint === 'argus-approved'")
    expect(SRC).toContain('skipping build+review')
  })

  test('an existing PR is REUSED, never duplicated', () => {
    expect(SRC).toContain('gh pr list --head')
    expect(SRC).toContain('NEVER open a duplicate PR')
  })
})

describe('inner-workflow.mjs — parallel adversarial review + asymmetric synthesis', () => {
  test('parallel() runs argus-claude + argus-adversarial, each with VERDICT_SCHEMA', () => {
    expect(SRC).toContain('parallel([')
    expect(SRC).toContain("label: 'argus:claude'")
    expect(SRC).toContain("label: 'argus:adversarial'")
    expect(SRC).toContain('schema: VERDICT_SCHEMA')
    // adversarial reviewer hunts NaN/overflow/edges/hidden invariants
    expect(SRC).toContain('NaN/overflow')
  })

  test('synthesis applies asymmetric gating (minority-veto + unverified label)', () => {
    expect(SRC).toContain('ASYMMETRIC GATING')
    expect(SRC).toContain('minority-veto')
    expect(SRC).toContain('VETO APPROVE')
    expect(SRC).toContain("label it 'unverified'")
  })

  test('a bounded fix loop runs while REQUEST_CHANGES and round < maxRounds', () => {
    expect(SRC).toMatch(/while \(finalVerdict === 'REQUEST_CHANGES' && round < maxRounds\)/)
  })
})

describe('inner-workflow.mjs — mandatory worktree cleanup on ALL paths', () => {
  test('a finally{} block scans git worktree list for the trident/<slug> branch and removes the WORKTREE on every path (D-1, unconditional)', () => {
    expect(SRC).toContain('} finally {')
    expect(SRC).toContain('git worktree list --porcelain')
    expect(SRC).toContain('git worktree remove --force')
    expect(SRC).toContain('git worktree prune')
    // Independent of Forge's return value — scans for the deterministic branch.
    expect(SRC).toContain("label: 'cleanup:worktree'")
  })

  test('branch teardown is MODE-AWARE: deleted only in pr-mode; KEPT in local-mode for the outer merge', () => {
    // D-1 removes the worktree unconditionally, but the branch holds the only
    // copy of the un-merged commits in local mode — the OUTER loop merges it.
    expect(SRC).toContain('const branchTeardownStep = isPr')
    // pr-mode: delete the local branch (work is on origin/the PR).
    expect(SRC).toContain('git branch -D ${forgeBranch}')
    // local-mode: KEEP the branch so the outer mergeLocal can merge it.
    expect(SRC).toMatch(/KEEP the branch '\$\{forgeBranch\}'/)
  })

  test('the top-level return carries the Workflow result API shape', () => {
    expect(SRC).toContain('return {')
    expect(SRC).toContain('prNumber:')
    expect(SRC).toContain('verdict:')
    expect(SRC).toContain('checkpoint:')
    // Annotated: node --check flags the top-level return — expected.
    expect(SRC).toContain('node --check')
  })
})
