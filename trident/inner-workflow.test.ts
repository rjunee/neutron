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

// The checked-in checkpoint-writer the workflow's Bash steps invoke (P10) —
// its SQL is asserted here; its runtime behavior in checkpoint-sh.test.ts.
const CHECKPOINT_SH = readFileSync(fileURLToPath(new URL('./checkpoint.sh', import.meta.url)), 'utf8')

describe('inner-workflow.mjs — meta + phases', () => {
  test('exports a pure meta literal named trident-v2-inner with the three phases', () => {
    expect(SRC).toContain("name: 'trident-v2-inner'")
    expect(SRC).toMatch(/export const meta = \{/)
    expect(SRC).toContain("{ title: 'Build' }")
    expect(SRC).toContain("{ title: 'Review' }")
    expect(SRC).toContain("{ title: 'Synthesis' }")
  })

  test('destructures the args contract with defaults', () => {
    for (const key of ['repoPath', 'task', 'baseBranch', 'slug', 'maxRounds', 'ralph', 'prNumber', 'branch', 'dbPath', 'runId', 'checkpointScript', 'resumeCheckpoint']) {
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

  test('ralph mode runs a DEDICATED plan:fable orchestrator step (split out of forge:build) that emits an execution spec + complexity tag', () => {
    // P-F2: Ralph planning is no longer FUSED into forge:build — a dedicated
    // Fable planner regenerates IMPLEMENTATION_PLAN.md + emits the per-task
    // exec spec + complexity tag; forge:build is now a pure executor.
    expect(SRC).toContain('function planFablePrompt(')
    expect(SRC).toContain('function ralphExecuteNote(')
    expect(SRC).toContain('const PLAN_SCHEMA =')
    expect(SRC).toContain("label: 'plan:fable'")
    expect(SRC).toContain('schema: PLAN_SCHEMA')
    // Gated on ralph mode; forge:build carries the exec spec + is routed by tag.
    expect(SRC).toContain('if (ralph === true)')
    expect(SRC).toContain('RALPH MODE')
    expect(SRC).toContain('IMPLEMENTATION_PLAN.md')
    expect(SRC).toContain('you are the EXECUTOR')
  })

  test('Ralph fails loudly on a null plan (never runs Forge unplanned) + the planner inspects the reused branch on resume (Codex [P2])', () => {
    // A null plan (planner terminal error) must NOT silently fall through to an
    // unplanned forge:build now that the in-Forge RALPH_NOTE is gone.
    expect(SRC).toContain('refusing to run Forge without a plan in Ralph mode')
    // On resume the planner inspects the reused branch, not just the base branch.
    expect(SRC).toContain('planFablePrompt(resuming)')
    expect(SRC).toContain('RESUME — a prior run ALREADY committed progress')
  })
})

describe('inner-workflow.mjs — per-phase SQLite checkpointing (C1)', () => {
  test('checkpoint Bash steps invoke the checked-in checkpoint.sh — no LLM-transcribed inline SQL (P10)', () => {
    // Both write paths route through the script (threaded via args like
    // dbPath, repo-of-record fallback), passing db + run id + field args.
    expect(SRC).toContain('checkpointScript = null')
    expect(SRC).toMatch(/const checkpointSh = checkpointScript \|\| `\$\{repoPath\}\/trident\/checkpoint\.sh`/)
    expect(SRC).toContain('bash ${shSingleQuote(checkpointSh)} ${shSingleQuote(dbPath)} ${shSingleQuote(runId)}')
    // The raw UPDATE no longer rides in an agent prompt for the LLM to
    // transcribe (and mistranscribe) — it lives in checkpoint.sh.
    expect(SRC).not.toContain('UPDATE code_trident_runs')
    expect(SRC).not.toContain('sqlite3 "${dbPath}"')
  })

  test('checkpoint.sh hardens the write: busy_timeout on the SAME connection + same idempotent UPDATE + in-script timestamp', () => {
    // busy_timeout is per-connection: the PRAGMA must share the sqlite3
    // invocation with the UPDATE, so writes retry under lock (was 0 → a lost
    // terminal write meant no harvest until the 25m reaper).
    expect(CHECKPOINT_SH).toContain('PRAGMA busy_timeout=5000; UPDATE code_trident_runs SET')
    expect(CHECKPOINT_SH).toContain("WHERE id='$(sql_quote \"$run\")'")
    // Timestamps computed IN the script (Date.now unavailable in workflows);
    // both legacy inline UPDATEs unconditionally stamped last_advanced_at.
    expect(CHECKPOINT_SH).toContain('$(date -u +%FT%TZ)')
    expect(CHECKPOINT_SH).toContain('last_advanced_at=')
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
    // The reviewer thunks are collected into a `reviewers` array (codex is pushed
    // conditionally), then run via parallel(reviewers).
    expect(SRC).toContain('const reviewers = [')
    expect(SRC).toContain('await parallel(reviewers)')
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

  test('Codex [P1]: fix rounds RE-ENTER the existing branch/PR (no `git switch -c` collision, no duplicate PR)', () => {
    // The forge contract is parameterized by `reenter`: round 1 creates the
    // branch (`forgeBuildContract(resuming)`), but every fix round re-enters the
    // EXISTING branch + reuses the PR (`forgeBuildContract(true)`). Reusing the
    // round-1 (create) contract in fix rounds told Forge to `git switch -c` an
    // already-created branch + `gh pr create` a duplicate — breaking every
    // REQUEST_CHANGES run.
    expect(SRC).toContain('function forgeBuildContract(reenter)')
    expect(SRC).toContain('forgeBuildContract(resuming)')
    expect(SRC).toContain('forgeBuildContract(true)')
    // The re-enter step switches WITHOUT -c; the create step uses -c.
    expect(SRC).toContain('Re-enter it WITHOUT')
  })
})

describe('inner-workflow.mjs — codex cross-model review panelist', () => {
  test('destructures codexHome from args (per-project CODEX_HOME) + gates on codexConfigured', () => {
    expect(SRC).toContain('codexHome = null')
    expect(SRC).toContain('const codexConfigured =')
    expect(SRC).toContain("typeof codexHome === 'string' && codexHome.length > 0")
  })

  test('a CODEX_VERDICT_SCHEMA carries codexStatus connected/not_connected/deferred', () => {
    expect(SRC).toContain('const CODEX_VERDICT_SCHEMA =')
    expect(SRC).toContain('codexStatus')
    expect(SRC).toContain("enum: ['connected', 'not_connected', 'deferred']")
  })

  test('the codex reviewer runs trident/codex-review.sh SYNCHRONOUSLY with per-project CODEX_HOME (never backgrounded)', () => {
    expect(SRC).toContain('function codexReviewerPrompt(diffFile)')
    expect(SRC).toContain('/trident/codex-review.sh')
    expect(SRC).toContain('CODEX_HOME=')
    expect(SRC).toContain('do NOT background it')
    // Codex reviews the SAME diff FILE Forge wrote — NOT `git diff` in repoPath
    // (which is still on the base branch) — via NEUTRON_CODEX_DIFF_FILE (Codex [P2]).
    expect(SRC).toContain('NEUTRON_CODEX_DIFF_FILE=')
    expect(SRC).toContain('codexReviewerPrompt(diffFile)')
    // Codex [P2]: the wrapper path is shell-quoted (repoPath may contain spaces),
    // and the /tmp output files are keyed on runId (globally unique) not slug
    // (unique only within a project → concurrent same-slug runs would collide).
    expect(SRC).toContain('bash ${shSingleQuote(script)}')
    expect(SRC).toContain('const uniq = runId || slug')
    expect(SRC).toContain('/tmp/trident-codex-${uniq}.out')
    // Wired into the review panel only when a codex credential is configured.
    expect(SRC).toContain('if (codexConfigured)')
    expect(SRC).toContain("label: 'argus:codex'")
    expect(SRC).toContain('schema: CODEX_VERDICT_SCHEMA')
  })

  test('exit codes map to codexStatus: 0→connected, 10/11→not_connected, 3/5→deferred', () => {
    expect(SRC).toContain("codexStatus='connected'")
    expect(SRC).toContain("codexStatus='not_connected'")
    expect(SRC).toContain("codexStatus='deferred'")
    // The graceful path invents no findings; the deferred path never APPROVEs.
    expect(SRC).toContain('do NOT invent findings')
    expect(SRC).toContain('NEVER report APPROVE for a deferred codex')
  })

  test('synthesis folds in the codex verdict as a third panelist / notes not-connected / gates deferred', () => {
    expect(SRC).toContain('Verdict C (codex cross-model')
    expect(SRC).toContain('codex not connected')
    expect(SRC).toContain('full third panelist')
  })

  test('a deterministic never-silent-downgrade guard forces REQUEST_CHANGES on deferred+APPROVE', () => {
    expect(SRC).toContain('function enforceCodexGate(')
    expect(SRC).toContain("codexStatus === 'deferred' && synthesis && synthesis.verdict === 'APPROVE'")
    expect(SRC).toContain('return enforceCodexGate(synthesisRaw, codexStatus)')
  })
})

// Execute the EXACT enforceCodexGate logic the script uses (kept in lockstep with
// the .mjs) so the never-silent-downgrade rule is verified BEHAVIORALLY.
describe('inner-workflow.mjs — enforceCodexGate behavior (never-silent-downgrade)', () => {
  function enforceCodexGate(
    synthesis: { verdict: string; findings: unknown[] } | null,
    codexStatus: string,
  ): { verdict: string; findings: unknown[] } | null {
    if (codexStatus === 'deferred' && synthesis && synthesis.verdict === 'APPROVE') {
      return {
        verdict: 'REQUEST_CHANGES',
        findings: [
          {
            severity: 'blocker',
            title: 'Codex cross-model review DEFERRED — refusing to silently APPROVE',
            evidence: 'codex was configured but the review call failed/timed out',
          },
          ...((synthesis && synthesis.findings) || []),
        ],
      }
    }
    return synthesis
  }

  test('deferred codex + APPROVE synthesis → forced REQUEST_CHANGES with a blocker prepended', () => {
    const out = enforceCodexGate({ verdict: 'APPROVE', findings: [] }, 'deferred')
    expect(out?.verdict).toBe('REQUEST_CHANGES')
    expect(out?.findings.length).toBe(1)
  })

  test('deferred codex + REQUEST_CHANGES synthesis → passes through unchanged (already blocked)', () => {
    const s = { verdict: 'REQUEST_CHANGES', findings: [{ severity: 'major' }] }
    expect(enforceCodexGate(s, 'deferred')).toBe(s)
  })

  test('connected codex + APPROVE → NOT downgraded (codex ran fine)', () => {
    const s = { verdict: 'APPROVE', findings: [] }
    expect(enforceCodexGate(s, 'connected')).toBe(s)
  })

  test('not_connected codex + APPROVE → NOT downgraded (graceful Claude-only)', () => {
    const s = { verdict: 'APPROVE', findings: [] }
    expect(enforceCodexGate(s, 'not_connected')).toBe(s)
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

// Work Board Phase 2a exec-model: the workflow runs DETACHED + the OUTER loop
// harvests `inner_result` from the DB (no process/stdout). So the workflow must
// persist its TYPED terminal result on EVERY terminal path — incl. a throw.
describe('inner-workflow.mjs — exec-model terminal-result harvest signal', () => {
  test('writes inner_result via checkpoint.sh inner_result_file → readfile() CAST AS TEXT (JSON-safe sqlite write)', () => {
    expect(SRC).toContain('async function writeTerminalResult(')
    // The workflow passes the temp-file PATH; the readfile()+CAST that dodges
    // the JSON double-quotes vs the sqlite argument lives in checkpoint.sh,
    // together with the COLUMN-CONSISTENCY CASE (subagent_status flips to
    // 'completed' ONLY when the SAME readfile() yields non-empty text).
    expect(SRC).toContain('inner_result_file ${shSingleQuote(tmp)}')
    expect(CHECKPOINT_SH).toContain("inner_result=CAST(readfile('$f') AS TEXT)")
    expect(CHECKPOINT_SH).toContain(
      "subagent_status=CASE WHEN length(CAST(readfile('$f') AS TEXT)) > 0 THEN 'completed' ELSE subagent_status END",
    )
    // The harvest-ready signal is written on the SUCCESS path before returning.
    expect(SRC).toContain('await writeTerminalResult(terminalResult)')
    // …and on the RESUME-approved short-circuit.
    expect(SRC).toContain('await writeTerminalResult(resumeResult)')
  })

  test('a THROWN workflow persists a terminal FAILURE result so the run fails PROMPTLY (Codex [P2])', () => {
    // Without this, a crashed build writes no inner_result and the outer loop
    // leaves it `running` until the 2 h stall guard. The catch writes a
    // REQUEST_CHANGES failure result the next harvest tick fails on.
    expect(SRC).toContain('} catch (err) {')
    expect(SRC).toContain('trident-v2 inner THREW')
    expect(SRC).toMatch(/const failureResult = \{[\s\S]*?verdict: 'REQUEST_CHANGES'/)
    expect(SRC).toContain("checkpoint: 'inner-error'")
    expect(SRC).toContain('await writeTerminalResult(failureResult)')
    // Best-effort: a failure-write that itself throws falls back to the stall guard.
    expect(SRC).toContain('terminal-failure write ALSO failed')
  })
})

describe('inner-workflow.mjs — RB2 (b) reflection trust boundary (Forge-only)', () => {
  // This script is NOT runnable/importable under bun/node (Workflow-runtime globals +
  // top-level return + no module resolution — see the file header), so the ROLE→prompt
  // gating is codified + executed behaviorally in `build-agent-prompt.ts` (see
  // `build-agent-prompt.test.ts`) and the derivation in `reflection-preamble.test.ts`.
  // These source assertions BIND the real `.mjs` sites to that boundary: the preamble
  // is prepended on the Forge builder sites and NOWHERE on the review-gate sites.
  test('destructures the ready-to-prepend reflectionPreamble from the args contract (defaults to \'\')', () => {
    // The preamble is DERIVED in the launcher (testable TS) and threaded ready — the
    // .mjs carries NO derivation logic of its own (that would be un-executable here).
    expect(SRC).toContain("reflectionPreamble = '',")
    expect(SRC).not.toContain('reflectionContext')
  })

  test('prepends the reflection preamble to the Forge build FIRST-turn prompt', () => {
    expect(SRC).toContain('`${reflectionPreamble}${forgeBuildContract(resuming)}${ralphNote}${reuseNote}')
  })

  test('prepends the reflection preamble to EVERY Forge fix-round prompt too', () => {
    // Each `forge:fix-round-*` is a FRESH agent with no shared transcript, so the
    // corrections must be re-injected — otherwise Forge loses them while revising.
    expect(SRC).toContain('`${reflectionPreamble}${forgeBuildContract(true)}')
  })

  // SECURITY (FIX 1) — the reflection block is UNTRUSTED NL; prepending it ahead of a
  // reviewer contract would prompt-inject the independent MERGE GATE. It must appear
  // on NO reviewer/synthesis/peer site. These are the mutation-kills: re-adding
  // `${reflectionPreamble}` ahead of any argus prompt fails here.
  test('argus:claude reviewer prompt EXCLUDES the preamble (starts at the bare rubric)', () => {
    expect(SRC).toContain('`${ARGUS_RUBRIC}')
    expect(SRC).not.toContain('`${reflectionPreamble}${ARGUS_RUBRIC}')
  })

  test('argus:adversarial reviewer prompt EXCLUDES the preamble', () => {
    expect(SRC).toContain('`You are ARGUS-ADVERSARIAL (independent, read-only).')
    expect(SRC).not.toContain('`${reflectionPreamble}You are ARGUS-ADVERSARIAL')
  })

  test('argus:synthesis verdict-interpreter EXCLUDES the preamble', () => {
    expect(SRC).toContain('`Synthesise these INDEPENDENT review verdicts')
    expect(SRC).not.toContain('`${reflectionPreamble}Synthesise these INDEPENDENT review verdicts')
  })

  test('argus:codex external-peer launcher EXCLUDES the preamble', () => {
    expect(SRC).toContain('agent(codexReviewerPrompt(diffFile), {')
    expect(SRC).not.toContain('`${reflectionPreamble}${codexReviewerPrompt')
  })

  test('the ONLY prompt-assembly uses of reflectionPreamble are the two Forge builder sites', () => {
    // A stray `${reflectionPreamble}` splice anywhere else (e.g. a reviewer prompt)
    // is caught here: exactly two template-interpolation prepend sites exist, both Forge.
    const spliceSites = SRC.match(/`\$\{reflectionPreamble\}/g) ?? []
    expect(spliceSites).toHaveLength(2)
  })
})
