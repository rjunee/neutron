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
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// The REAL decoder the outer merge pins on — the resume-path assertions below run
// it against the shape this script writes, rather than restating the rule.
import { reviewedHeadOid } from './merge.ts'
import { TERMINAL_PHASES } from './state-machine.ts'
import type { TridentRun } from './store.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

// Lift ONE function's source out of the .mjs. Module scope because two loaders need
// it (the gate helpers, and the codex bridge command below) and a second copy could
// drift into extracting something other than what ships.
function grabFunction(name: string): string {
  const at = SRC.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} is missing from inner-workflow.mjs`)
  // Brace-match to the end of the function so the extraction survives edits
  // inside the body rather than depending on a fixed line count.
  let depth = 0
  let started = false
  for (let i = at; i < SRC.length; i += 1) {
    const c = SRC[i]
    if (c === '{') {
      depth += 1
      started = true
    } else if (c === '}') {
      depth -= 1
      if (started && depth === 0) return SRC.slice(at, i + 1)
    }
  }
  throw new Error(`could not brace-match ${name}`)
}

function loadCodexForgeSchema(): {
  required: string[]
  properties: Record<string, { type?: unknown; description?: string }>
} {
  const start = SRC.indexOf('const FORGE_SCHEMA =')
  const end = SRC.indexOf('const PLAN_SCHEMA =', start)
  if (start === -1 || end === -1) throw new Error('Forge schemas are missing from inner-workflow.mjs')
  return new Function(`${SRC.slice(start, end)}; return CODEX_FORGE_SCHEMA`)() as {
    required: string[]
    properties: Record<string, { type?: unknown; description?: string }>
  }
}

function loadCodexBridgePrompts(): { build: string; collect: string; wait: string } {
  const factory = new Function(
    'runId',
    'slug',
    'codexBuildSh',
    'codexBriefByPath',
    'chunkTextOnLines',
    'CODEX_BRIEF_CHUNK_BYTES',
    'briefIntegrity',
    'codexBuildDiffFile',
    'dbPath',
    'checkpointSh',
    'forgeBranch',
    'baseBranch',
    'mergeMode',
    'codexHome',
    'NO_INTERACTIVE_RULE',
    'REDIRECT_RULE',
    'NO_PATTERN_KILL_RULE',
    [
      grabFunction('shSingleQuote'),
      grabFunction('wrapperErrTailInstruction'),
      grabFunction('workflowStageStampCommand'),
      grabFunction('codexBuildPrompt'),
      grabFunction('codexCollectPrompt'),
      grabFunction('codexWaitMorePrompt'),
      `return {
        build: codexBuildPrompt('r1', 'brief', { envVar: '', model: '' }, 'forge-done'),
        collect: codexCollectPrompt('r1'),
        wait: codexWaitMorePrompt('r1'),
      }`,
    ].join('\n'),
  ) as (...args: unknown[]) => { build: string; collect: string; wait: string }
  return factory(
    'prompt-pin',
    'fallback-slug',
    '/harness/trident/codex-build.sh',
    () => null,
    (text: string) => [{ text, mode: 'raw' }],
    4096,
    () => '6:receipt',
    () => '/tmp/reviewer.diff',
    null,
    '/harness/trident/checkpoint.sh',
    'trident/prompt-pin',
    'main',
    'pr',
    '/codex-home',
    '',
    '',
    '',
  )
}

function loadCodexDeferralMessage(): (
  label: string,
  codexStatus: string,
  wrapperErrTail: string,
) => string {
  return new Function(
    `${grabFunction('codexDeferralMessage')}; return codexDeferralMessage`,
  )() as (label: string, codexStatus: string, wrapperErrTail: string) => string
}

// The checked-in checkpoint-writer the workflow's Bash steps invoke (P10) —
// its SQL is asserted here; its runtime behavior in checkpoint-sh.test.ts.
const CHECKPOINT_SH = readFileSync(fileURLToPath(new URL('./checkpoint.sh', import.meta.url)), 'utf8')

/** `SRC` with whole-line comments stripped. Used ONLY by the assertions that a
 *  destructive command is GONE: the comments deliberately quote the exact
 *  `git worktree remove --force` / `git branch -D` line #541 removed, and a
 *  grep over the raw source could never tell the ban from its own rationale. */
const CODE = SRC.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

// The checked-in worktree cleanup the workflow's finally{} invokes (#541) — its
// decision table is asserted here; its runtime behavior against real git repos in
// worktree-cleanup-sh.test.ts.
const CLEANUP_SH = readFileSync(
  fileURLToPath(new URL('./worktree-cleanup.sh', import.meta.url)),
  'utf8',
)

/** The SHIPPED `classifyCleanupOutcome`, executed rather than grepped (#541).
 *  Uses the module-scope `grabFunction` above — the same extractor the other
 *  loaders use, so this can never drift into extracting something that does not
 *  ship. */
function loadCleanupClassifier(): (
  reported: unknown,
  raw: unknown,
) => { exit: number | null; outcome: string } {
  return new Function(
    `${grabFunction('classifyCleanupOutcome')}; return classifyCleanupOutcome`,
  )() as (reported: unknown, raw: unknown) => { exit: number | null; outcome: string }
}

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

describe('inner-workflow.mjs — codex wrapper refusal propagation', () => {
  const refusal =
    'CODEX_BUILD_BRIEF_PART_CORRUPT: brief part X measures 27893:ff41febe but its receipt is 28462:9f34d3b0'

  test('CODEX_FORGE_SCHEMA requires the wrapper stderr tail as a string', () => {
    const schema = loadCodexForgeSchema()
    expect(schema.properties.wrapperErrTail?.type).toBe('string')
    expect(schema.required).toContain('wrapperErrTail')
  })

  test('build, collect, and wait bridges render the same bounded verbatim-tail instruction', () => {
    const prompts = loadCodexBridgePrompts()
    const errFile = '/tmp/trident-codex-build-prompt-pin-r1.err'
    const instruction =
      `Whenever \`codexStatus !== 'connected'\`, run \`tail -c 400 '${errFile}' 2>/dev/null || true\` and copy its output VERBATIM into \`wrapperErrTail\`; when \`codexStatus === 'connected'\`, set \`wrapperErrTail\` to \`""\`.`

    for (const [bridge, prompt] of Object.entries(prompts)) {
      expect(prompt, `${bridge} bridge is missing wrapperErrTail`).toContain('wrapperErrTail')
      expect(prompt, `${bridge} bridge is missing the non-connected condition`).toContain(
        "codexStatus !== 'connected'",
      )
      expect(prompt, `${bridge} bridge is missing the wrapper .err path`).toContain(errFile)
      expect(prompt, `${bridge} bridge drifted from the bounded-tail instruction`).toContain(instruction)
    }
  })

  test('the forge deferral message carries the measured refusal verbatim', () => {
    const message = loadCodexDeferralMessage()('forge:build', 'deferred', refusal)
    expect(message).toBe(`forge:build deferred (codexStatus=deferred): ${refusal}`)
    expect(message).toContain('deferred')
    expect(message).toContain(refusal)
    expect(grabFunction('forgeAgent')).toContain(
      'codexDeferralMessage(opts.label, res.codexStatus, res.wrapperErrTail)',
    )
  })
})

describe('inner-workflow.mjs — inlined contracts + rules in EVERY agent', () => {
  test('Forge writes an artifact-time checkpoint with the shell-resolved branch head', () => {
    const helper = grabFunction('artifactCheckpointCommand')
    const contract = grabFunction('forgeBuildContract')
    expect(helper).toContain('if (!dbPath || !runId) return null')
    expect(helper).toContain('inner_checkpoint_head "$(git rev-parse --verify HEAD)"')
    expect(contract).toContain("artifactCommand === null ? 6 : 7")
    expect(contract).toContain("artifactCommand === null\n    ? ''")
    expect(SRC).toContain("forgeBuildContract(resuming, 'forge-done')")
    expect(SRC).toContain('forgeBuildContract(true, `fix-round-${round}`)')

    const whitelist = CHECKPOINT_SH.slice(CHECKPOINT_SH.indexOf('case "$field" in'), CHECKPOINT_SH.indexOf('    *)', CHECKPOINT_SH.indexOf('case "$field" in')))
    for (const field of ['branch', 'inner_checkpoint', 'inner_checkpoint_head', 'inner_findings_file', 'subagent_status']) {
      expect(helper).toContain(field)
      expect(whitelist).toContain(field)
    }
    expect(helper.match(/bash \$\{shSingleQuote\(checkpointSh\)\}/g)).toHaveLength(1)
  })

  test('Codex dispatch threads the same artifact checkpoint names only with run storage', () => {
    const prompt = grabFunction('codexBuildPrompt')
    const dispatch = grabFunction('forgeAgent')
    expect(prompt).toContain("const checkpointEnv = !dbPath || !runId")
    for (const name of ['SCRIPT', 'DB', 'RUN_ID', 'NAME']) {
      expect(prompt).toContain(`NEUTRON_CODEX_BUILD_CHECKPOINT_${name}`)
    }
    expect(dispatch).toContain("opts.label === 'forge:build' ? 'forge-done' : opts.label.slice('forge:'.length)")
    expect(SRC).toContain('await checkpoint(`fix-round-${round}`')
    expect(SRC).toContain("await checkpoint('forge-done'")
  })

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
    // Row selection is still WHERE id — the terminal freeze lives in the SET
    // expressions, so it never narrows which row the UPDATE addresses.
    expect(CHECKPOINT_SH).toContain('quoted_run="$(sql_quote "$run")"')
    expect(CHECKPOINT_SH).toContain("WHERE id='$quoted_run'")
    // Timestamps computed IN the script (Date.now unavailable in workflows);
    // both legacy inline UPDATEs unconditionally stamped last_advanced_at.
    expect(CHECKPOINT_SH).toContain('$(date -u +%FT%TZ)')
    expect(CHECKPOINT_SH).toContain('last_advanced_at=')
  })

  test("checkpoint.sh's terminal-phase set is the SAME set as state-machine.ts TERMINAL_PHASES", () => {
    // The script is shell, so it cannot import the constant — it carries a fourth
    // copy of the literal (store.ts TERMINAL_PHASE_SQL and run-progress.ts hold the
    // other two). Pin it against the source of truth here, in the suite that already
    // asserts this script's SQL as text, so the copies cannot drift: a phase added to
    // TERMINAL_PHASES and not to the script would leave the terminal freeze blind to
    // it, and the divergence would be invisible at runtime.
    const literal = `('${TERMINAL_PHASES.join("', '")}')`
    expect(literal).toBe("('done', 'failed', 'stopped')") // guards the join shape itself
    expect(CHECKPOINT_SH).toContain(`terminal_phases="${literal}"`)
    // ...and it is the ONLY terminal-set literal in the script (no second, stale copy).
    expect(CHECKPOINT_SH.match(/'done'/g)?.length).toBe(1)
  })

  test('checkpoints forge-done, argus-approved/argus-request-changes, and fix-round-N', () => {
    expect(SRC).toContain("checkpoint('forge-done'")
    expect(SRC).toContain("'argus-approved'")
    expect(SRC).toContain("'argus-request-changes'")
    expect(SRC).toContain('checkpoint(`fix-round-${round}`')
  })
})

describe('inner-workflow.mjs — idempotent crash-resume (C2)', () => {
  test("a classified approved resume skips build+review", () => {
    expect(SRC).toContain("if (resumeMode === 'approved')")
    expect(SRC).toContain('skipping build+review')
  })

  test('an existing PR is REUSED, never duplicated', () => {
    expect(SRC).toContain('outer loop reuses the PR')
    expect(SRC).toContain('Do NOT push and do NOT run')
    expect(SRC).toContain('outer loop already owns PR')
  })
})

describe('inner-workflow.mjs — #545: the reviewed head is the COMMIT THE DIFF CAME FROM, and is CARRIED', () => {
  // The OUTER merge pins `gh pr merge --match-head-commit` to this exact field
  // (`reviewedHeadOid`, merge.ts), so whatever is recorded here is what the merge
  // certifies as reviewed.
  //
  // IT MUST NEVER COME FROM A FRESH HEAD PROBE. `forge.commitSha` and `diffFile`
  // are reported by the SAME agent run, so the sha names exactly the tree the
  // reviewers read. A remote head probe does not: a third party's push satisfies
  // it just as well, and recording THAT as `reviewedHead` makes the merge pin to —
  // and thereby vouch for — a commit no reviewer saw. Binding to the reported sha
  // can only ever fail CLOSED: a merely stale sha makes `--match-head-commit`
  // refuse, which is the safe direction.

  /** Every assignment to `reviewedHead` anywhere in the script. */
  const reviewedHeadAssignments = (): string[] =>
    SRC.split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(let )?reviewedHead\s*=/.test(l))

  // THE CONSTRUCT, NOT ITS SPELLING. Both offsets below match the bare
  // `reviewAndSynthesize(` CALL. Pinning the whole assignment (`let synthesis =
  // await reviewAndSynthesize(`) made these assertions fail the moment the call was
  // wrapped in `synthesisOrInfraBlock(...)`, a change that left the ORDERING they
  // check completely intact — the same trap `round-landed.test.ts` records having
  // been caught by twice already.
  test("round 1 pins to Forge's reported commit sha, fixed BEFORE the review that judges it", () => {
    const decl = SRC.indexOf('reviewedHead = branchHead')
    const firstReview = SRC.indexOf('runReviewRound(diffFile, round, pr)')
    expect(decl).toBeGreaterThan(-1)
    expect(firstReview).toBeGreaterThan(decl)
  })

  test('NO assignment of reviewedHead is ever derived from a head probe (the fail-open)', () => {
    const assigns = reviewedHeadAssignments()
    expect(assigns.length).toBeGreaterThan(0)
    for (const line of assigns) {
      // `readBranchHead`/`headAfter` answer "did the branch move?", NOT "what did
      // the reviewers read?" — pinning to either certifies an unreviewed push.
      expect(line).not.toContain('readBranchHead')
      expect(line).not.toContain('headAfter')
    }
  })

  test("every pr-mode fix hands its own commit back to the outer publisher before re-review", () => {
    // The fix round's CLAIM is read once, through `oidClaim` — the same shape round 1
    // uses. (It used to be a raw `typeof fix?.commitSha === 'string'` trim beside a
    // separate `oidClaim` null-test, two readings of one value.)
    const handoff = SRC.indexOf('const fixClaim = oidClaim(fix?.commitSha)')
    const returned = SRC.indexOf('return publishResult', handoff)
    expect(handoff).toBeGreaterThan(-1)
    expect(returned).toBeGreaterThan(handoff)
  })

  test("every fix round re-pins to the head read from git at that round's completion", () => {
    const rePin = SRC.indexOf('reviewedHead = fixHead')
    // `lastIndexOf`: the FIRST call is round 1's pre-loop review, which of course
    // precedes the re-pin. The one that must follow it is the in-loop RE-review.
    const loopReview = SRC.lastIndexOf('runReviewRound(diffFile, round, pr)')
    expect(rePin).toBeGreaterThan(-1)
    expect(loopReview).toBeGreaterThan(rePin)
    // The fix agent is asked for that sha under the same schema round 1 uses —
    // asserted as "through the SAME dispatch helper", which is the property that
    // matters now that a build has two possible executors. Round 1 and every fix
    // round going through one function is what stops a fix round from silently
    // landing on a different builder than the one that opened the branch.
    expect(SRC).toContain('const fix = await forgeAgent(')
    expect(SRC).toContain('const forge = await forgeAgent(')
  })

  test('the terminal result carries `reviewedHead` (the field merge.ts pins on)', () => {
    const start = SRC.indexOf('const terminalResult = {')
    const end = SRC.indexOf('await writeTerminalResult(terminalResult)')
    expect(start).toBeGreaterThan(-1)
    expect(SRC.slice(start, end)).toContain('reviewedHead,')
  })

  // The matching-head resume path is covered behaviorally in
  // inner-workflow-resume.test.ts. It must carry the RECORDED head, never the
  // live probe, so the outer merge pins the commit that was actually reviewed.
  //
  // It runs only when the prior process reached 'argus-approved' and its terminal
  // result was never harvested — and the terminal result is the ONLY place a
  // reviewed OID is written, so by construction none exists to resume from.
  // Probing the head at resume and labelling it `reviewedHead` would certify an
  // unreviewed commit: reviewers approve A, B is pushed into the crash window,
  // resume reads B, and the merge pins to B and SUCCEEDS. The pin then vouches for
  // a commit nobody read, which is worse than no pin at all.
  describe('the crash-resume shortcut carries only the recorded reviewed head', () => {
    // The resume block's CODE, sliced out so these assertions cannot be satisfied
    // by an unrelated part of the file. Comment lines are stripped: the docblock
    // there names `reviewedHead` to explain why it is deliberately absent, and a
    // naive check would fail on the documentation of the very fix it verifies.
    const resumeBlock = (): string => {
      const at = SRC.indexOf("if (resumeMode === 'approved') {")
      expect(at).toBeGreaterThan(-1)
      const end = SRC.indexOf('return resumeResult', at)
      expect(end).toBeGreaterThan(at)
      return SRC.slice(at, end)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
    }

    test('it pins from the recorded checkpoint rather than the live probe', () => {
      const block = resumeBlock()
      expect(block).toContain('reviewedHead: recordedResumeHead')
      expect(block).not.toContain('reviewedHead: currentHeadAtResume')
    })

    test('the resume result omits the field entirely, so `reviewedHeadOid` yields null', () => {
      // Mirrors the object the resume path builds. merge.ts must refuse this.
      const resumeResult = {
        ok: true,
        prNumber: 42,
        branch: 'feat-x',
        verdict: 'APPROVE',
        round: 0,
        checkpoint: 'argus-approved',
      }
      expect('reviewedHead' in resumeResult).toBe(false)
      // The REAL decoder, on the REAL shape — not a restatement of the rule.
      expect(reviewedHeadOid({ inner_result: JSON.stringify(resumeResult) } as TridentRun)).toBeNull()
    })

    test('A approved → crash → B pushed → resume must not merge B', () => {
      // The boundary the shortcut used to get wrong, end to end through the real
      // decoder: whatever B is, a resume result cannot name it as reviewed.
      const B = 'b'.repeat(40)
      const resumeResult = {
        ok: true,
        prNumber: 42,
        branch: 'feat-x',
        verdict: 'APPROVE',
        round: 0,
        checkpoint: 'argus-approved',
      }
      const pinned = reviewedHeadOid({ inner_result: JSON.stringify(resumeResult) } as TridentRun)
      expect(pinned).toBeNull()
      expect(pinned).not.toBe(B)
    })
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
    // Asserts the two PROPERTIES rather than the literal condition text. The old
    // regex pinned the exact string `while (finalVerdict === 'REQUEST_CHANGES' &&
    // round < maxRounds)`, so adding a legitimate third clause broke it while the
    // loop remained correct — a source-string test failing on a change it has no
    // opinion about. (2026-08-09: the clause added was `blockKind !== 'infra-only'`,
    // which stops the loop re-Forging in response to a lane that could not run;
    // behaviour covered in lane-retry.test.ts.)
    expect(SRC).toMatch(/while \(\s*finalVerdict === 'REQUEST_CHANGES'/)
    expect(SRC).toMatch(/round < maxRounds/)
  })

  test('Codex [P1]: fix rounds RE-ENTER the existing branch/PR (no `git switch -c` collision, no duplicate PR)', () => {
    // The forge contract is parameterized by `reenter`: round 1 creates the
    // branch (`forgeBuildContract(resuming)`), but every fix round re-enters the
    // EXISTING branch + reuses the PR (`forgeBuildContract(true)`). Reusing the
    // round-1 (create) contract in fix rounds told Forge to `git switch -c` an
    // already-created branch + `gh pr create` a duplicate — breaking every
    // REQUEST_CHANGES run.
    expect(SRC).toContain('function forgeBuildContract(reenter, artifactCheckpointName)')
    expect(SRC).toContain("forgeBuildContract(resuming, 'forge-done')")
    expect(SRC).toContain('forgeBuildContract(true, `fix-round-${round}`)')
    // The re-enter step switches WITHOUT -c; the create step uses -c.
    expect(SRC).toContain('Re-enter it WITHOUT')
  })

  test('the FRESH forge step tolerates a leftover local branch: create-or-re-enter, -c first', () => {
    // Measured incident d5c1e219: a relaunched card whose earlier run left
    // refs/heads/trident/<slug> behind died on `git switch -c` ("branch already
    // exists") and committed on the worktree-wf_ auto branch instead. The fresh
    // step must fall back to plain `git switch`; order (-c first) distinguishes
    // it from the reenter step, which tries the plain switch first.
    expect(SRC).toContain('git switch -c ${forgeBranch} 2>/dev/null || git switch ${forgeBranch}')
    expect(SRC).toContain('git switch ${forgeBranch} 2>/dev/null || git switch -c ${forgeBranch}')
  })
})

describe('inner-workflow.mjs — codex cross-model review panelist', () => {
  test('the codex build coda pins both halves of the host-side branch binding', () => {
    expect(SRC).toContain('STEP 1 IS ALREADY DONE FOR YOU')
    expect(SRC).toContain('Stay on branch ${forgeBranch}')
  })

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
    expect(SRC).toContain('const codexReviewSh =')
    expect(SRC).toContain('codexReviewScript = null')
    // The repoPath resolution IS the defect — its absence is the fix.
    expect(SRC).not.toContain('${repoPath}/trident/codex-review.sh')
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
    // The literal `if (codexConfigured)` was GENERALISED into a per-slot route
    // check when the cross-model seats became configurable slots: the guard is now
    // `routeAvailable(route)`, which resolves `codexConfigured` for a codex route
    // and `kimiConfigured` for a kimi one. Assert the PROPERTY — a peer only runs
    // when its runtime is configured — rather than the old spelling, which would
    // otherwise fail a refactor that strictly preserves the property it protects.
    expect(SRC).toContain('const routeAvailable = (route) =>')
    expect(SRC).toContain("route.group === 'codex' ? codexConfigured")
    expect(SRC).toContain('routeAvailable(slotOneRoute)')
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

  test('the bridge READS BACK the truncation marker — the wrapper tells the model, the grep tells the workflow', () => {
    // The wrapper caps the diff and discloses it IN THE PROMPT, but exit 0 is exit 0:
    // without this grep a review of the first 3000 lines of an 11k-line diff came
    // back as a clean whole-change APPROVE, and nothing downstream could tell.
    expect(SRC).toContain('grep -q CODEX_REVIEW_DIFF_TRUNCATED')
    expect(SRC).toContain('CODEX_TRUNCATED=1')
    expect(SRC).toContain('CODEX_TRUNCATED=0')
    // …and it is a REQUIRED schema field, copied from that line rather than judged.
    expect(SRC).toContain("required: ['verdict', 'findings', 'codexStatus', 'codexTruncated']")
    expect(SRC).toContain('copy the CODEX_TRUNCATED line VERBATIM')
  })

  /**
   * THE READBACK, EXECUTED — because the substring assertions above cannot fail on the
   * mutation that matters. Swap the two echo branches (`=1` on the else) and every
   * string those assertions look for is still present, still spelled the same, still
   * in the same file: green suite, inverted meaning, every truncated review from then
   * on presented to the synthesis as a full-coverage panelist. A guard whose only
   * coverage survives its own inversion is documentation.
   *
   * So these run the REAL fragment — generated by the shipped `codexReviewerPrompt`,
   * not retyped here — against a fixture stderr file, and assert on its OUTPUT.
   */
  const BASH = existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash'

  const codexBridgeCommand = (runId: string): string => {
    // Instantiate the real prompt builder with stub closure values; `shSingleQuote`
    // comes from the same source so the quoting under test is the shipped quoting.
    const factory = new Function(
      'repoPath',
      'slug',
      'runId',
      'codexHome',
      'codexReviewSh',
      'baseBranch',
      'NO_INTERACTIVE_RULE',
      'REDIRECT_RULE',
      'NO_PATTERN_KILL_RULE',
      // The owner's chosen review model, resolved once per run and spliced onto the
      // command as an env assignment. A REALISTIC value rather than '': the
      // truncation readback is a tail of that same command line, so a prefix that
      // shifted or broke its quoting has to be able to fail this.
      'CODEX_ENV_PREFIX',
      [grabFunction('shSingleQuote'), grabFunction('codexReviewerPrompt'), 'return codexReviewerPrompt'].join('\n'),
    ) as (...args: string[]) => (diffFile: string) => string
    return factory(
      '/repo',
      'the-slug',
      runId,
      '/codex-home',
      '/harness/trident/codex-review.sh',
      'main',
      '',
      '',
      '',
      "CODEX_REVIEW_MODEL='gpt-5.6-sol' ",
    )('/tmp/some-diff.diff')
  }

  /** Run ONLY the truncation-readback tail of the bridge command, on a fixture stderr. */
  const runReadback = (errContent: string | null): string => {
    const runId = `truncation-readback-${process.pid}`
    const errFile = `/tmp/trident-codex-${runId}.err`
    rmSync(errFile, { force: true })
    if (errContent !== null) writeFileSync(errFile, errContent)
    const command = codexBridgeCommand(runId)
    const at = command.indexOf('if grep -q')
    if (at === -1) throw new Error('the bridge command no longer greps stderr for the truncation marker')
    const nl = command.indexOf('\n', at)
    const fragment = command.slice(at, nl === -1 ? undefined : nl)
    // The fragment must read the file this test wrote, or it is proving nothing.
    expect(fragment).toContain(errFile)
    const out = spawnSync(BASH, ['-c', fragment], { encoding: 'utf8' }).stdout.trim()
    rmSync(errFile, { force: true })
    return out
  }

  test('BEHAVIOR: wrapper stderr carrying the marker makes the bridge report CODEX_TRUNCATED=1', () => {
    const out = runReadback(
      'CODEX_REVIEW_DIFF_TRUNCATED: showing the first 3000 of 11241 diff lines to codex.\n',
    )
    expect(out).toBe('CODEX_TRUNCATED=1')
  })

  test('BEHAVIOR: stderr WITHOUT the marker reports CODEX_TRUNCATED=0 — the flag is not always-on', () => {
    // The other half of the inversion: a full-diff review must not be hedged into a
    // partial one, or the PARTIAL framing becomes noise everyone learns to skip.
    const out = runReadback('reading prompt from stdin\nmodel: gpt-5.6-sol\n')
    expect(out).toBe('CODEX_TRUNCATED=0')
  })

  test('BEHAVIOR: a MISSING stderr file reports 0 — that case is caught by the exit code, not here', () => {
    // grep exits 2 on an unreadable file, so this says "not truncated". Safe only
    // because a wrapper that never wrote stderr did not exit 0 either, and a non-zero
    // exit maps to deferred/not_connected — which the panel gates on independently.
    expect(runReadback(null)).toBe('CODEX_TRUNCATED=0')
  })

  test('a deterministic never-silent-downgrade guard forces REQUEST_CHANGES on deferred+APPROVE', () => {
    expect(SRC).toContain('function enforceCrossModelGate(')
    expect(SRC).toContain('function deferredCrossModelPeers(')
    // Both are INVOKED and composed — asserted without pinning the inline nesting.
    // The old form required the exact expression
    // `enforceCrossModelGate(synthesisRaw, deferredCrossModelPeers(`, so hoisting the
    // peer list into a named const broke it while the composition was unchanged.
    // (2026-08-09: hoisted so `classifyBlock` can also read the deferred peers.)
    //
    // LOOSENED AGAIN, same day, for the same reason: the CI gate folds a red build
    // into the synthesis before this call, so the first argument is no longer literally
    // `synthesisRaw`. Twice now this assertion has failed on a change that left the
    // composition intact — so it asserts the composition and nothing about the
    // spelling of the arguments.
    expect(SRC).toMatch(/deferredCrossModelPeers\(\{ codex:/)
    expect(SRC).toMatch(/enforceCrossModelGate\(\w+, \w+\)/)
  })
})

// The never-silent-downgrade gate, verified BEHAVIORALLY against the REAL
// function — extracted from the .mjs source and evaluated, not re-implemented
// here.
//
// It USED to be a hand-copied TypeScript duplicate with a comment asking future
// editors to keep it "in lockstep with the .mjs". That is a test that cannot fail
// for the reason it claims to check: the copy would keep passing while the real
// gate was broken or deleted. The workflow script genuinely cannot be imported
// (it has no module resolution and its top-level `return` is the Workflow
// runtime's result API), so the gate is lifted out of the source text and run.
interface Peer {
  name: string
  title: string
  evidence: string
}

function loadRealGate(): {
  enforceCrossModelGate: (
    s: unknown,
    peers: unknown[],
  ) => {
    verdict: string
    findings: Array<{ kind?: string; title?: string; severity?: string; evidence?: string }>
  } | null
  deferredCrossModelPeers: (statuses: unknown, routes?: unknown) => Peer[]
  crossModelPeerStatus: (slot: number | null, verdicts: unknown[], statusKey: string) => string
  missingCoreReviewers: (verdicts: unknown[], seats: unknown[]) => Peer[]
  coreSeats: Array<{ slot: number; name: string; letter: string; panelLabel: string }>
  classifyBlock: (s: unknown, peers: unknown[]) => string
  corePanelLine: (letter: string, label: string, verdict: unknown) => string
  codexPanelLine: (status: string, review: unknown) => string
} {
  const grab = grabFunction
  // The consts the functions close over come along, lifted from the SAME source so
  // the test cannot disagree with the shipped values. `LANE_FINDING_KIND` is the
  // field `enforceCrossModelGate` stamps and `classifyBlock` reads — hard-coding
  // 'lane' here would let the two drift apart with the test still green, which is
  // the whole failure shape this file exists to prevent.
  const grabConst = (name: string): string => {
    const line = SRC.split('\n').find((l) => l.startsWith(`const ${name} =`))
    if (line === undefined) throw new Error(`const ${name} is missing from inner-workflow.mjs`)
    return line
  }
  // THE CORE SEATS ARE NO LONGER A LITERAL TO LIFT. They used to be a top-level
  // `const CORE_REVIEWER_SEATS = [{ slot: 0 }, { slot: 1 }]`, which is the positional
  // pattern the file itself documents as a latent bug for codex — inserting a seat at
  // the head of the panel left the new one ungated (fail-OPEN). The slots are now
  // DERIVED from `reviewers.length` at push time, so this reconstructs them the same
  // way: read the `pushCoreReviewer` call sites IN ORDER and number them. The names,
  // letters, labels and ORDERING therefore still come from the shipped source (a
  // renamed seat or a reordered panel shows up here), while nothing hard-codes a slot.
  const grabCoreSeats = (): Array<{ slot: number; name: string; letter: string; panelLabel: string }> => {
    const sites = [...SRC.matchAll(/pushCoreReviewer\(\s*\{([^}]*)\}/g)]
    if (sites.length === 0) throw new Error('no pushCoreReviewer(...) sites in inner-workflow.mjs')
    return sites.map((m, slot) => {
      const field = (f: string): string => {
        const hit = new RegExp(`${f}:\\s*'([^']*)'`).exec(m[1] ?? '')
        if (hit === null) throw new Error(`core seat ${slot} has no ${f}`)
        return hit[1] as string
      }
      return { slot, name: field('name'), letter: field('letter'), panelLabel: field('panelLabel') }
    })
  }
  const factory = new Function(
    [
      grabConst('LANE_FINDING_KIND'),
      // `classifyBlock` now closes over the severity set too — lifted from the SAME
      // source for the same reason as LANE_FINDING_KIND: re-declaring {minor,nit}
      // here would let the classifier and the severity gate drift apart green.
      grabConst('NON_BLOCKING_SEVERITIES'),
      // `usableStatus` is the ONE "did this field answer" predicate the lane retry and
      // `hasUsableVerdict` now share; `CORE_SEAT_STATUS_KEY` is the field it reads for a
      // core seat. Both are lifted rather than restated for the same reason as the two
      // above — restating them here is exactly how the retry and the gate drifted apart
      // green in the first place.
      grabConst('usableStatus'),
      grabConst('CORE_SEAT_STATUS_KEY'),
      grab('enforceCrossModelGate'),
      grab('deferredCrossModelPeers'),
      grab('crossModelPeerStatus'),
      grab('hasUsableVerdict'),
      grab('missingCoreReviewers'),
      grab('corePanelLine'),
      grab('codexPanelLine'),
      grab('classifyBlock'),
      'return { enforceCrossModelGate, deferredCrossModelPeers, crossModelPeerStatus, missingCoreReviewers, classifyBlock, corePanelLine, codexPanelLine }',
    ].join('\n'),
  ) as () => Omit<ReturnType<typeof loadRealGate>, 'coreSeats'>
  return { ...factory(), coreSeats: grabCoreSeats() }
}

describe('inner-workflow.mjs — cross-model gate behavior (never-silent-downgrade)', () => {
  // LOADED INSIDE THE TESTS, NOT IN THE DESCRIBE BODY. Calling loadRealGate() at
  // describe-evaluation time made a load failure DELETE these tests instead of
  // failing them: a mutation that broke the extraction produced "0 fail" with
  // seven tests silently absent, which is the same guard-cannot-fail shape this
  // whole file exists to prevent. A throw inside a test is a red test.
  const gate = (): ReturnType<typeof loadRealGate> => loadRealGate()

  test('the gate is actually extractable from the .mjs (guards the extraction itself)', () => {
    const g = gate()
    expect(typeof g.enforceCrossModelGate).toBe('function')
    expect(typeof g.deferredCrossModelPeers).toBe('function')
    expect(typeof g.codexPanelLine).toBe('function')
  })

  test('a TRUNCATED codex APPROVE is handed to the synthesis as PARTIAL, not as a whole-change approval', () => {
    // The defect: codex read the first N lines of the diff, said APPROVE about them,
    // and the panel line presented it as "a full third panelist" — a cross-model
    // approval of code codex never saw.
    const { codexPanelLine } = gate()
    const line = codexPanelLine('connected', {
      verdict: 'APPROVE',
      findings: [],
      codexStatus: 'connected',
      codexTruncated: true,
    })
    expect(line).toContain('PARTIAL')
    expect(line).toContain('CODEX_REVIEW_DIFF_TRUNCATED')
    expect(line).toContain('do NOT record it as a whole-change cross-model approval')
    expect(line).not.toContain('full third panelist')
    // Its BLOCKERS are not softened — only its approval is re-scoped.
    expect(line).toContain('VETO')
  })

  test('an UNtruncated connected codex is still the full third panelist (the re-scoping is not blanket)', () => {
    const { codexPanelLine } = gate()
    const line = codexPanelLine('connected', {
      verdict: 'APPROVE',
      findings: [],
      codexStatus: 'connected',
      codexTruncated: false,
    })
    expect(line).toContain('full third panelist')
    expect(line).not.toContain('PARTIAL')
  })

  test('a MISSING codexTruncated is PARTIAL, not full coverage — the flag fails SAFE', () => {
    // The old test only ever passed the field, so the DEFAULT was untested and it
    // pointed the wrong way: `=== true` meant a bridge that dropped the field earned
    // the "full third panelist" framing — the permissive answer for the one case where
    // nothing is known about coverage. Same direction as crossModelPeerStatus, where a
    // configured seat with no status defaults to 'deferred'.
    const { codexPanelLine } = gate()
    const line = codexPanelLine('connected', { verdict: 'APPROVE', findings: [], codexStatus: 'connected' })
    expect(line).toContain('PARTIAL')
    expect(line).toContain('SCOPE UNKNOWN')
    expect(line).not.toContain('full third panelist')
    // Blockers keep their veto here too — only the approval is re-scoped.
    expect(line).toContain('VETO')
  })

  test('a NON-BOOLEAN codexTruncated is PARTIAL — a stringified flag is not a reported one', () => {
    // A schema-violating 'true'/'false' string used to sail into the full-panelist
    // branch; 'false' as a string is truthy, so the truncated case did too.
    const { codexPanelLine } = gate()
    for (const bad of ['true', 'false', 1, 0, null, undefined]) {
      const line = codexPanelLine('connected', {
        verdict: 'APPROVE',
        findings: [],
        codexStatus: 'connected',
        codexTruncated: bad,
      })
      expect(line).toContain('PARTIAL')
      expect(line).not.toContain('full third panelist')
    }
    // …and a review object that is missing entirely is not a full panelist either.
    expect(codexPanelLine('connected', null)).not.toContain('full third panelist')
  })

  test('deferred/not_connected panel lines are unchanged by the truncation flag', () => {
    const { codexPanelLine } = gate()
    const deferredLine = codexPanelLine('deferred', { codexTruncated: true })
    expect(deferredLine).toContain('DEFERRED')
    expect(deferredLine).toContain('do NOT return APPROVE')
    // The deferral no longer claims the CALL failed — an empty diff is the other way in.
    expect(deferredLine).toContain('EMPTY')
    expect(codexPanelLine('not_connected', { codexTruncated: true })).toContain('NOT CONNECTED')
  })

  test('the deferred-codex blocker text names the EMPTY-DIFF cause, not just auth', () => {
    // An operator whose diff file failed to write was told to re-run "once codex auth
    // is restored" — a correct-looking instruction that fixes nothing.
    const { deferredCrossModelPeers } = gate()
    const [codexPeer] = deferredCrossModelPeers({ codex: 'deferred', kimi: 'connected' })
    expect(codexPeer?.evidence).toContain('EMPTY')
    expect(codexPeer?.evidence).toContain('CODEX_REVIEW_EMPTY_DIFF')
    expect(codexPeer?.evidence).not.toContain('Re-run once codex auth is restored')
  })

  test('deferred codex + APPROVE synthesis → forced REQUEST_CHANGES with a blocker prepended', () => {
    const { enforceCrossModelGate, deferredCrossModelPeers } = gate()
    const deferredCodex = deferredCrossModelPeers({ codex: 'deferred', kimi: 'connected' })
    const out = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, deferredCodex)
    expect(out?.verdict).toBe('REQUEST_CHANGES')
    expect(out?.findings.length).toBe(1)
  })

  // THE BUG THIS PAIR REPLACES. The gate used to early-return an ALREADY
  // REQUEST_CHANGES synthesis untouched — "already blocked, nothing to do". But the
  // synthesis prompt tells the model, verbatim, "do NOT return APPROVE" when a seat is
  // down, so the COMPLIANT synthesis takes exactly that path: the deterministic
  // "which seat is missing" blocker was dropped from the PR entirely, and because
  // nothing stamped `kind`, `classifyBlock` read the model's own findings as CODE and
  // re-Forged a full round against a panel that was still down a seat.
  test('deferred codex + REQUEST_CHANGES synthesis → the lane blocker is STILL injected', () => {
    const { enforceCrossModelGate, deferredCrossModelPeers } = gate()
    const deferredCodex = deferredCrossModelPeers({ codex: 'deferred', kimi: 'connected' })
    const s = { verdict: 'REQUEST_CHANGES', findings: [{ severity: 'major', title: 'real code bug' }] }
    const out = enforceCrossModelGate(s, deferredCodex)
    expect(out?.verdict).toBe('REQUEST_CHANGES')
    // Prepended, and STAMPED — the model's finding still rides along behind it.
    expect(out?.findings).toHaveLength(2)
    expect(out?.findings[0]?.kind).toBe('lane')
    expect(out?.findings[0]?.title).toContain('Codex')
    expect(out?.findings[1]?.title).toBe('real code bug')
  })

  test('a dead CORE seat + a compliant REQUEST_CHANGES classifies as infra-only, NOT code', () => {
    // End to end on the exact path the prompt makes likely: the synthesis obeys
    // "do NOT return APPROVE", and the loop must NOT re-Forge code for a reviewer
    // that never ran. Composed from the real functions, so a gate that forgets to
    // stamp `kind` fails here rather than silently costing a round.
    const { missingCoreReviewers, coreSeats, enforceCrossModelGate, classifyBlock } = gate()
    const peers = missingCoreReviewers([null, { verdict: 'APPROVE' }], coreSeats)
    const compliant = { verdict: 'REQUEST_CHANGES', findings: [] }
    const out = enforceCrossModelGate(compliant, peers)
    expect(out?.findings[0]?.title).toContain('produced NO verdict')
    expect(classifyBlock(out, peers)).toBe('infra-only')
  })

  test('a non-object synthesis (a dead synthesis agent) still yields a blocked verdict', () => {
    // The gate must not read `.findings` off null and crash the round; an absent
    // synthesis with an incomplete panel is the most blocked state there is.
    const { missingCoreReviewers, coreSeats, enforceCrossModelGate } = gate()
    const peers = missingCoreReviewers([null, null], coreSeats)
    for (const dead of [null, undefined, 'REQUEST_CHANGES']) {
      const out = enforceCrossModelGate(dead, peers)
      expect(out?.verdict).toBe('REQUEST_CHANGES')
      expect(out?.findings).toHaveLength(2)
    }
  })

  test('connected peers + APPROVE → NOT downgraded (both ran fine)', () => {
    const { enforceCrossModelGate, deferredCrossModelPeers } = gate()
    const noneDeferred = deferredCrossModelPeers({ codex: 'connected', kimi: 'connected' })
    const s = { verdict: 'APPROVE', findings: [] }
    expect(enforceCrossModelGate(s, noneDeferred)).toBe(s)
  })

  test('not_connected peers + APPROVE → NOT downgraded (graceful Claude-only)', () => {
    const { enforceCrossModelGate, deferredCrossModelPeers } = gate()
    const s = { verdict: 'APPROVE', findings: [] }
    expect(
      enforceCrossModelGate(s, deferredCrossModelPeers({ codex: 'not_connected', kimi: 'not_connected' })),
    ).toBe(s)
  })

  test('a deferred KIMI alone blocks an APPROVE — the second peer is really gated', () => {
    // The point of generalising one gate instead of adding a second: a new peer
    // is enforced by construction, not by remembering to write a parallel guard.
    const { enforceCrossModelGate, deferredCrossModelPeers } = gate()
    const peers = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' })
    expect(peers).toHaveLength(1)
    const out = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, peers)
    expect(out?.verdict).toBe('REQUEST_CHANGES')
    expect(JSON.stringify(out?.findings)).toContain('Kimi K3')
  })

  test('BOTH peers deferred → both blockers surface, so the operator knows which is down', () => {
    const { enforceCrossModelGate, deferredCrossModelPeers } = gate()
    const peers = deferredCrossModelPeers({ codex: 'deferred', kimi: 'deferred' })
    const out = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, peers)
    expect(out?.verdict).toBe('REQUEST_CHANGES')
    expect(out?.findings.length).toBe(2)
  })

  // EVERY PRODUCER OWNS ITS TITLE, AND EVERY TITLE IS ASSERTED. The gate posts
  // `title: p.title` verbatim, so authorship sits with each producer — and deleting
  // the `title:` line from the codex or kimi branch used to survive the entire suite
  // green, leaving the gate to post a blocker reading `title: undefined` on the PR.
  // (Only missingCoreReviewers' title was behaviourally asserted; the others were
  // covered by a whole-file substring grep, which any producer's title satisfies for
  // all of them.) The title is the line a human reads first when a lane is down.
  test('the codex + kimi blockers each carry their OWN non-empty, self-identifying title', () => {
    const { deferredCrossModelPeers, enforceCrossModelGate } = gate()
    const peers = deferredCrossModelPeers({ codex: 'deferred', kimi: 'deferred' })
    const byName = (n: string): Peer => peers.find((p) => p.name === n) as Peer
    expect(byName('Codex').title).toBe('Codex cross-model review DEFERRED — refusing to silently APPROVE')
    expect(byName('Kimi K3').title).toBe('Kimi K3 cross-model review DEFERRED — refusing to silently APPROVE')
    // …and they survive the gate as distinct titles, so the PR names WHICH lane died.
    const titles = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, peers)?.findings.map((f) => f.title)
    expect(titles).toEqual([byName('Codex').title, byName('Kimi K3').title])
    for (const t of titles ?? []) expect(typeof t).toBe('string')
  })

  test("the kimi blocker states there is NO Claude-family fallback", () => {
    // A fallback would restore the single-family panel while still reporting that
    // a cross-model review happened, so the refusal is part of the contract.
    const { deferredCrossModelPeers } = gate()
    const peers = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' })
    expect(peers[0]!.evidence).toContain('NO fallback to a Claude-family')
  })

  test('deferred diagnostics follow the selected route family, not the legacy slot name', () => {
    const { deferredCrossModelPeers } = gate()
    const [peer] = deferredCrossModelPeers(
      { codex: 'deferred', kimi: 'connected' },
      { codex: { group: 'claude' }, kimi: { group: 'kimi' } },
    )
    expect(peer!.name).toBe('Cross-model review 1 (Claude)')
    expect(peer!.title).toContain('Cross-model review 1 (Claude) DEFERRED')
    expect(peer!.evidence).not.toContain('CODEX_HOME')
  })
})

/**
 * PANEL COMPLETENESS — a reviewer that DIED must never read as one that was ABSENT.
 *
 * BOTH BUGS BELOW FAILED OPEN, which is why they are P1 rather than cosmetic: each one
 * let the panel reach APPROVE with a seat that produced nothing, and an APPROVE is what
 * merges code. A gate that fails CLOSED wastes a round; a gate that fails OPEN ships
 * unreviewed code.
 *
 *   1. A CROSS-MODEL PEER THAT DIED READ AS "NEVER CONFIGURED". The caller's fallback
 *      was `{ verdict: 'COMMENT', findings: [], codexStatus: 'not_connected' }` for both
 *      "no slot" and "slot but null verdict", and only the exact string 'deferred'
 *      blocks. So a configured reviewer whose agent crashed was indistinguishable from
 *      a self-hoster who never set one up — and the second of those is DELIBERATELY a
 *      legitimate reduced panel, so the collapse silently disarmed the gate.
 *
 *   2. A CORE REVIEWER THAT DIED HAD NO GATE AT ALL. `argus:claude` / `argus:adversarial`
 *      are always dispatched, and their verdicts were interpolated into the synthesis
 *      prompt with a bare `JSON.stringify(verdicts[0])` — so a dead one arrived as the
 *      literal token `null`, which a synthesis model most plausibly reads as "this
 *      reviewer raised nothing": an implicit pass. Nothing in code checked.
 *
 * THE DISTINCTION THAT MUST SURVIVE is absent-vs-died. Kimi with no API key is a real
 * product configuration and must still merge; kimi configured and crashed must not.
 * Every assertion here comes in that pair.
 */
describe('inner-workflow.mjs — panel completeness is derived in CODE, not read off a prompt', () => {
  const gate = (): ReturnType<typeof loadRealGate> => loadRealGate()

  test('the completeness helpers are extractable (a guard that cannot load cannot fail)', () => {
    const g = gate()
    expect(typeof g.crossModelPeerStatus).toBe('function')
    expect(typeof g.missingCoreReviewers).toBe('function')
    expect(typeof g.classifyBlock).toBe('function')
    expect(g.coreSeats.map((s) => s.slot)).toEqual([0, 1])
  })

  describe('crossModelPeerStatus — the slot is the authority on "was this configured"', () => {
    test('NO SLOT → not_connected (never configured: the reduced panel that must still merge)', () => {
      const { crossModelPeerStatus } = gate()
      expect(crossModelPeerStatus(null, [], 'kimiStatus')).toBe('not_connected')
      expect(crossModelPeerStatus(undefined as unknown as null, [], 'kimiStatus')).toBe('not_connected')
    })

    test('SLOT + null verdict → deferred, NOT not_connected — this is the #535 fix', () => {
      // The agent was dispatched and died. Before the fix this returned
      // 'not_connected', which no gate blocks on.
      const { crossModelPeerStatus } = gate()
      expect(crossModelPeerStatus(2, [{}, {}, null], 'codexStatus')).toBe('deferred')
      expect(crossModelPeerStatus(2, [{}, {}], 'codexStatus')).toBe('deferred')
    })

    test('SLOT + a verdict object MISSING its status field → deferred', () => {
      // A malformed reply is a review we did not get. The old code read the absent
      // field, applied `|| 'not_connected'`, and merged.
      const { crossModelPeerStatus } = gate()
      expect(crossModelPeerStatus(2, [{}, {}, { verdict: 'APPROVE' }], 'codexStatus')).toBe('deferred')
      expect(crossModelPeerStatus(2, [{}, {}, { codexStatus: '' }], 'codexStatus')).toBe('deferred')
    })

    test('SLOT + a real status → that status, verbatim (including the graceful exit-10 path)', () => {
      const { crossModelPeerStatus } = gate()
      const v = [{}, {}, { codexStatus: 'connected' }, { kimiStatus: 'not_connected' }]
      expect(crossModelPeerStatus(2, v, 'codexStatus')).toBe('connected')
      // An EXPLICIT not_connected from the reviewer itself still means "no credential"
      // and still yields a legitimate reduced panel. Only the DEFAULT changed.
      expect(crossModelPeerStatus(3, v, 'kimiStatus')).toBe('not_connected')
      expect(crossModelPeerStatus(2, [{}, {}, { codexStatus: 'deferred' }], 'codexStatus')).toBe('deferred')
    })

    test('end to end: a DEAD configured peer now blocks an APPROVE; an ABSENT one does not', () => {
      // The whole seam in four lines. Same synthesis verdict, same statusKey, one
      // difference: whether the reviewer had a seat.
      const { crossModelPeerStatus, deferredCrossModelPeers, enforceCrossModelGate } = gate()
      const approve = { verdict: 'APPROVE', findings: [] }

      const died = crossModelPeerStatus(2, [{}, {}, null], 'kimiStatus')
      const blocked = enforceCrossModelGate(approve, deferredCrossModelPeers({ codex: 'connected', kimi: died }))
      expect(blocked?.verdict).toBe('REQUEST_CHANGES')

      const absent = crossModelPeerStatus(null, [{}, {}], 'kimiStatus')
      expect(enforceCrossModelGate(approve, deferredCrossModelPeers({ codex: 'connected', kimi: absent }))).toBe(
        approve,
      )
    })
  })

  describe('missingCoreReviewers — the always-configured seats, which had no gate (#536)', () => {
    test('both core reviewers answered → no peers, and an APPROVE stands', () => {
      const { missingCoreReviewers, coreSeats, enforceCrossModelGate } = gate()
      const verdicts = [
        { verdict: 'APPROVE', findings: [] },
        { verdict: 'APPROVE', findings: [] },
      ]
      const missing = missingCoreReviewers(verdicts, coreSeats)
      expect(missing).toHaveLength(0)
      const approve = { verdict: 'APPROVE', findings: [] }
      expect(enforceCrossModelGate(approve, missing)).toBe(approve)
    })

    test('a null core verdict → one peer, and it BLOCKS an APPROVE', () => {
      const { missingCoreReviewers, coreSeats, enforceCrossModelGate } = gate()
      const missing = missingCoreReviewers([null, { verdict: 'APPROVE', findings: [] }], coreSeats)
      expect(missing).toHaveLength(1)
      expect(missing[0]!.name).toContain('rubric')
      const out = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, missing)
      expect(out?.verdict).toBe('REQUEST_CHANGES')
      expect(out?.findings[0]?.title).toContain('produced NO verdict')
    })

    test('BOTH core reviewers dead → two blockers, so the operator knows the panel was empty', () => {
      const { missingCoreReviewers, coreSeats, enforceCrossModelGate } = gate()
      const missing = missingCoreReviewers([null, undefined], coreSeats)
      expect(missing).toHaveLength(2)
      const out = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, missing)
      expect(out?.verdict).toBe('REQUEST_CHANGES')
      expect(out?.findings.length).toBe(2)
    })

    test('a MALFORMED core verdict (no `verdict` string) counts as missing', () => {
      // VERDICT_SCHEMA requires `verdict`. An object without it is not a review, and
      // treating "an object came back" as success is how a dead seat passes.
      const { missingCoreReviewers, coreSeats } = gate()
      expect(missingCoreReviewers([{ findings: [] }, { verdict: '' }], coreSeats)).toHaveLength(2)
      expect(missingCoreReviewers(['APPROVE', 42], coreSeats)).toHaveLength(2)
    })

    test('the blocker EXPLAINS the never-ran/found-nothing distinction, not just that it failed', () => {
      // The evidence lands in the PR. "Reviewer X produced no verdict" with no reason
      // reads as a flake to be re-run blind; the operator needs to know the panel was
      // incomplete and why that is not an approval.
      const { missingCoreReviewers, coreSeats } = gate()
      const evidence = missingCoreReviewers([null, null], coreSeats)[0]!.evidence
      expect(evidence).toContain('never ran')
      expect(evidence).toContain('not the same as finding nothing')
    })
  })

  describe('the block is classified as infra-only, so the fix loop does not re-Forge a dead agent', () => {
    test('a missing core seat composes through the REAL gate to infra-only', () => {
      // COMPOSED FROM THE REAL FUNCTIONS rather than a hand-built finding: the gate
      // stamps `kind` and the classifier reads it, and this is the only assertion that
      // fails if those two ever disagree. Editing a title can no longer break it, and
      // renaming the field can no longer pass it.
      const { missingCoreReviewers, coreSeats, enforceCrossModelGate, classifyBlock } = gate()
      const peers = missingCoreReviewers([null, { verdict: 'APPROVE', findings: [] }], coreSeats)
      const gated = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, peers)
      expect(classifyBlock(gated, peers)).toBe('infra-only')
    })

    test('a dead seat PLUS a real code finding is still code — a genuine blocker is never dropped', () => {
      const { missingCoreReviewers, coreSeats, enforceCrossModelGate, classifyBlock } = gate()
      const peers = missingCoreReviewers([null, { verdict: 'APPROVE', findings: [] }], coreSeats)
      const gated = enforceCrossModelGate(
        { verdict: 'APPROVE', findings: [{ severity: 'blocker', title: 'Null deref in the reap path' }] },
        peers,
      )
      expect(classifyBlock(gated, peers)).toBe('code')
    })

    test('a deferred cross-model peer composes through the same path to infra-only', () => {
      const { deferredCrossModelPeers, enforceCrossModelGate, classifyBlock } = gate()
      const peers = deferredCrossModelPeers({ codex: 'deferred', kimi: 'deferred' })
      const gated = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, peers)
      expect(classifyBlock(gated, peers)).toBe('infra-only')
    })
  })

  describe('the wiring — derived in code, and after the severity gate', () => {
    test('the synthesis prompt no longer hands a dead core reviewer the bare token `null`', () => {
      expect(SRC).not.toContain('Verdict A (Claude rubric): ${JSON.stringify(verdicts[0])}')
      expect(SRC).not.toContain('Verdict B (Claude adversarial): ${JSON.stringify(verdicts[1])}')
      // Every core panel line is produced by corePanelLine, DERIVED FROM THE SAME
      // `coreSeats` the gate reads — no `verdicts[0]` / `verdicts[1]` literal to fall
      // out of step with the seat list (the letter+label ride on the seat).
      expect(SRC).toContain('corePanelLine(seat.letter, seat.panelLabel, verdicts[seat.slot])')
      expect(SRC).toContain('${corePanelLines}')
    })

    test('the core seats DERIVE their slot at push time — no positional literal anywhere', () => {
      // The literal `[{ slot: 0 }, { slot: 1 }]` is the pattern this file documents as
      // a latent bug for the cross-model peers: insert a reviewer at the HEAD of the
      // panel and the new seat is ungated (fail-OPEN, the shape of #536) while Verdict
      // A is labelled with the wrong reviewer's review. Its ABSENCE is the fix.
      expect(SRC).not.toContain('CORE_REVIEWER_SEATS')
      expect(SRC).toContain('coreSeats.push({ ...seat, slot: reviewers.length')
      expect(SRC).toContain('missingCoreReviewers(verdicts, coreSeats)')
      // …and the derived list is the SAME object the retry, the prompt and the gate
      // all read, so a seat cannot be enforced in one and forgotten in another.
      expect(SRC).toContain('...coreSeats,')
    })

    test('a core seat that DIED is retried like any other lane (not thrown away)', () => {
      // A dead CORE seat had zero retries: the slots list held only codex/kimi, so one
      // transient argus:claude crash produced an infra-only block, exited the loop on
      // round 1 and discarded the whole Forge build. `statusKey: 'verdict'` is what
      // makes a core seat retryable by the same helper — a real verdict is never
      // 'deferred', so only a seat that produced nothing is re-run.
      expect(SRC).toContain("const CORE_SEAT_STATUS_KEY = 'verdict'")
      expect(SRC).toContain('statusKey: CORE_SEAT_STATUS_KEY')
      // The retry re-runs the seat's OWN thunk, so it cannot drift from the prompt
      // the seat was originally dispatched with.
      expect(SRC).toContain('return await reviewers[core.slot]()')
    })

    // RUN corePanelLine, DO NOT GREP FOR IT. The assertions above are wiring checks:
    // they prove the call site exists, and nothing more. The original guard for the
    // #536 prompt fix was `expect(SRC).toContain('DID NOT COMPLETE')`, and a mutation
    // that replaces the branch condition with `true` — putting the bare `null` straight
    // back into the prompt and leaving the dead-seat message unreachable — keeps that
    // phrase in the file and keeps the test green. That mutant survived. These do not.
    describe('corePanelLine — the dead-seat message is produced, not merely present in the file', () => {
      test('a real verdict is passed through verbatim as JSON', () => {
        const { corePanelLine } = gate()
        const v = { verdict: 'APPROVE', findings: [] }
        const line = corePanelLine('A', 'Claude rubric', v)
        expect(line).toBe(`Verdict A (Claude rubric): ${JSON.stringify(v)}`)
        expect(line).not.toContain('DID NOT COMPLETE')
      })

      test('a DEAD seat yields DID NOT COMPLETE and never the token `null`', () => {
        const { corePanelLine } = gate()
        for (const dead of [null, undefined, 'APPROVE', 42, {}, { verdict: '' }]) {
          const line = corePanelLine('B', 'Claude adversarial', dead)
          expect(line).toContain('DID NOT COMPLETE')
          // The precise regression: `Verdict B (…): null`. A synthesis model reads a
          // verdict-shaped blank as "this reviewer raised nothing" — an implicit pass.
          expect(line).not.toContain(': null')
          expect(line).not.toContain(': undefined')
          expect(line).toContain('do NOT return APPROVE')
        }
      })

      test('it agrees with missingCoreReviewers on EVERY seat — one predicate, never two', () => {
        // The dangerous drift is the pair disagreeing: the prompt saying a seat is fine
        // while the gate blocks it, or worse, the prompt saying DID NOT COMPLETE while
        // nothing blocks. Asserted over the same inputs both callers can see.
        //
        // EVERY SEAT MEANS EVERY SEAT. This used to place each case at index 0 with slot
        // 1 always healthy, so the name claimed coverage the body did not have: the
        // whole B seat went unexercised. Now the case is walked ACROSS the seats — the
        // one under test is the dead one, and the other seats are healthy — so the
        // assertion is made once per seat per case, and a seat added to the panel
        // widens this loop automatically.
        const { corePanelLine, missingCoreReviewers, coreSeats } = gate()
        expect(coreSeats.length).toBeGreaterThan(1)
        const cases: unknown[] = [null, undefined, {}, { verdict: '' }, 'APPROVE', 42, { verdict: 'APPROVE' }]
        for (const seat of coreSeats) {
          for (const c of cases) {
            const verdicts = coreSeats.map((s) => (s.slot === seat.slot ? c : { verdict: 'APPROVE' }))
            const missing = missingCoreReviewers(verdicts, coreSeats)
            const blocked = missing.length === 1 && missing[0]?.name === seat.name
            const saysDead = corePanelLine(seat.letter, seat.panelLabel, c).includes('DID NOT COMPLETE')
            expect(saysDead).toBe(blocked)
          }
        }
      })
    })

    test('no caller invents a not_connected status for a slot that exists', () => {
      // The exact literal that collapsed died-into-absent. Its absence is the fix.
      // COMMENT LINES ARE STRIPPED FIRST: the docblock on `crossModelPeerStatus` quotes
      // the old expression verbatim to explain the bug, and a naive whole-file check
      // would fail on the documentation of the very fix it is verifying.
      const code = SRC.split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
      expect(code).not.toContain("codexStatus: 'not_connected' }")
      expect(code).not.toContain("kimiStatus: 'not_connected' }")
      // The status key is now chosen from the SLOT'S ROUTE rather than hardcoded, because
    // either slot may hold either provider. Same call, same guarantee — the key follows
    // what the seat actually ran, which is the whole point of making the seats generic.
    expect(SRC).toContain('crossModelPeerStatus(codexSlot, verdicts,')
    expect(SRC).toContain("slotOneRoute.group === 'kimi' ? 'kimiStatus'")
      expect(SRC).toContain('crossModelPeerStatus(kimiSlot, verdicts,')
    expect(SRC).toContain("slotTwoRoute.group === 'kimi' ? 'kimiStatus'")
    })

    test('missingCore reaches the gate on BOTH the CI-pending and CI-settled branches', () => {
      // One branch carrying the peers and the other not is how half a gate ships.
      expect(SRC).toContain('missingCoreReviewers(verdicts, coreSeats)')
      expect(SRC).toContain('[...missingCore, ...deferred, ciDeferredPeer(ci)]')
      expect(SRC).toContain('[...missingCore, ...deferred]')
    })

    test('the completeness peers are assembled AFTER enforceSeverityGate, which can only pass', () => {
      // enforceSeverityGate turns a nit-only REQUEST_CHANGES into an APPROVE. If the
      // completeness gate ran before it, that downgrade would undo this block.
      expect(SRC.indexOf('enforceSeverityGate(synthesisRaw)')).toBeGreaterThan(-1)
      expect(SRC.indexOf('const gated = enforceCrossModelGate(')).toBeGreaterThan(
        SRC.indexOf('enforceSeverityGate(synthesisRaw)'),
      )
    })
  })
})

describe('inner-workflow.mjs — worktree cleanup on ALL paths, destructive on NONE', () => {
  test('a finally{} block cleans up the trident/<slug> worktree on every path (D-1) via the checked-in script', () => {
    expect(SRC).toContain('} finally {')
    expect(SRC).toContain("label: 'cleanup:worktree'")
    // Independent of Forge's return value — the script scans for the
    // DETERMINISTIC branch, so it holds even when Forge threw before returning.
    expect(SRC).toContain(
      'bash ${shSingleQuote(worktreeCleanupSh)} ${shSingleQuote(repoPath)} ${shSingleQuote(forgeBranch)} ${cleanupMode}',
    )
    expect(SRC).toContain('worktreeCleanupScript = null')
    expect(SRC).toMatch(
      /const worktreeCleanupSh = worktreeCleanupScript \|\| `\$\{repoPath\}\/trident\/worktree-cleanup\.sh`/,
    )
  })

  // ISSUES #541 — the cleanup step USED to be a cheap-model agent told to "ignore
  // individual command failures" while running `git worktree remove --force` +
  // `git branch -D`, from a finally{} that fires on THROW and ABORT. On PR #171 it
  // destroyed 197 insertions across 7 files. Both halves of that must stay gone:
  // the force-removal AND the LLM judgement wrapped around it.
  test('the finally{} NEVER force-removes a worktree and NEVER deletes a branch itself', () => {
    expect(CODE).not.toContain('worktree remove --force')
    expect(CODE).not.toContain('git branch -D')
    // No "best-effort, ignore failures" licence anywhere near the destructive path.
    expect(CODE).not.toContain('ignore individual command failures')
  })

  test('the cleanup agent has NO judgement: one fixed command, output reported verbatim', () => {
    // Same shape as the head/CI probes: schema'd raw+exit_code, an explicit ban on
    // running anything else, and an explicit ban on "fixing" the non-zero exit that
    // MEANS work was preserved.
    expect(SRC).toContain('const CLEANUP_SCHEMA = {')
    expect(SRC).toContain('schema: CLEANUP_SCHEMA')
    expect(SRC).toContain('Run EXACTLY this single Bash command')
    expect(SRC).toMatch(/do NOT remove or modify any worktree, branch or file yourself/)
    expect(SRC).toMatch(/exit 3 means the script PRESERVED work ON PURPOSE/)
    // A preservation is logged in full — it is the operator's only notice.
    expect(SRC).toContain('cleanup:worktree PRESERVED WORK')
  })

  test('branch teardown is MODE-AWARE: delete-branch only in pr-mode; keep-branch in local-mode', () => {
    // The branch holds the only copy of the un-merged commits in local mode — the
    // OUTER loop merges it — so the mode is passed to the script as a flag and the
    // script (not a model) decides whether the pr-mode branch is safe to delete.
    expect(SRC).toContain("const cleanupMode = isPr ? 'delete-branch' : 'keep-branch'")
    expect(CLEANUP_SH).toContain('PRESERVED branch $branch reason=not-on-origin')
    expect(CLEANUP_SH).toContain('PRESERVED branch $branch reason=unpushed')
  })

  test("the script SOURCE still carries the two lines an edit is likeliest to 'simplify' away", () => {
    // NAME SAYS WHAT THIS IS: two greps over the shell source, executing nothing.
    // The behavior — untracked work preserved, individual paths named, exit 3 —
    // is proven against real git in worktree-cleanup-sh.test.ts ("untracked files
    // inside an untracked DIRECTORY are named INDIVIDUALLY", "UNTRACKED-ONLY work
    // is preserved"). These greps only guard the exact spelling those tests rely on.
    expect(CLEANUP_SH).toContain('git -C "$wt" status --porcelain --untracked-files=all')
    expect(CLEANUP_SH).toContain('[ "$preserved" -eq 0 ] || exit 3')
  })

  describe('the cleanup verdict survives its trip through the transcribing agent', () => {
    // EXECUTED, not grepped: `classifyCleanupOutcome` is lifted out of the shipped
    // source and run. The script's verdict is deterministic; getting it back into
    // the run log is not, because an LLM types the answer out — and every way that
    // transcription can go wrong lands on the SAME failure, the run reporting
    // "NOTHING was inspected or removed" over work that was in fact preserved.
    const classify = loadCleanupClassifier()

    test('exit 3 is a preservation; 0 is a clean run', () => {
      expect(classify(3, 'PRESERVED worktree /wt reason=dirty\nRESULT preserved=1 removed=0').outcome)
        .toBe('preserved')
      expect(classify(0, 'RESULT preserved=0 removed=1').outcome).toBe('ok')
    })

    test('a STRING "3" is still a preservation (Number.isFinite("3") is false)', () => {
      // The schema says integer, but the value comes from a model. Rejecting the
      // string reclassified a real preservation as a cleanup FAILURE — the exact
      // inversion of the operator's only data-loss alarm.
      expect(classify('3', 'PRESERVED worktree /wt reason=dirty').outcome).toBe('preserved')
      expect(classify('3', '').exit).toBe(3)
      expect(classify('0', 'RESULT preserved=0 removed=0').outcome).toBe('ok')
    })

    test('a MISSING exit_code falls back to the ___EXIT= marker in the transcript', () => {
      const raw = 'PRESERVED worktree /wt reason=dirty\nRESULT preserved=1 removed=0\n___EXIT=3'
      expect(classify(undefined, raw).outcome).toBe('preserved')
      expect(classify(null, raw).exit).toBe(3)
      expect(classify('', raw).exit).toBe(3)
      // An agent that echoed the command it was told to run puts the UNEXPANDED
      // `___EXIT=$?` in front of the real marker; only the expanded one counts.
      expect(classify(null, `bash cleanup.sh 2>&1; echo "___EXIT=$?"\n${raw}`).exit).toBe(3)
      // The marker is APPENDED, so the LAST one is the real one. Anything earlier
      // is content — and the dirty list is arbitrary filenames chosen by whoever
      // was editing, not a namespace this script controls.
      expect(
        classify(
          null,
          'PRESERVED worktree /wt reason=dirty\n  ?? notes/___EXIT=0.txt\n___EXIT=3',
        ).exit,
      ).toBe(3)
    })

    test('no exit code ANYWHERE, but PRESERVED records in the output → still the alarm', () => {
      // The 20k-line-dirty-tree case: the marker fell off the end of the agent's
      // window. A wasted look costs the operator a minute; the inverse costs them
      // the work, so the transcript's own records decide.
      const got = classify(undefined, 'PRESERVED worktree /wt reason=dirty\n  ?? brand-new.ts')
      expect(got.outcome).toBe('preserved-unmarked')
      expect(got.exit).toBe(null)
    })

    test('a reported 0 does NOT outrank PRESERVED records in the transcript', () => {
      // THE ONE READING THAT FAILS SILENTLY. Every other mis-transcription lands on
      // 'failed', which logs LOUDLY; this one lands on 'ok', so the operator's only
      // notice that a worktree still holds uncommitted work is simply never printed
      // and the lost-work alarm is invisible rather than wrong.
      //
      // The pair is impossible in a real run: the script increments `preserved` at
      // every PRESERVED record and ends on `[ "$preserved" -eq 0 ] || exit 3`, so
      // exit 0 and a PRESERVED line cannot both be true — asserted against the
      // SHIPPED script above, not assumed. So the record is believed over the number.
      const raw = 'PRESERVED worktree /wt reason=dirty\n  ?? brand-new.ts\nRESULT preserved=1 removed=0'
      expect(classify(0, raw).outcome).toBe('preserved-unmarked')
      expect(classify('0', raw).outcome).toBe('preserved-unmarked')
      expect(classify(0, `${raw}\n___EXIT=0`).outcome).toBe('preserved-unmarked')
      // …and a GENUINE clean run still reads as ok — the script emits no PRESERVED
      // line at all when it preserved nothing, so believing the record cannot cry wolf.
      expect(classify(0, 'REMOVED /wt\nDELETED branch b\nRESULT preserved=0 removed=1').outcome).toBe('ok')
      expect(classify(0, 'SKIPPED /wt reason=not-a-worktree-root\nRESULT preserved=0 removed=0').outcome)
        .toBe('ok')
      expect(classify(0, 'KEPT branch b reason=checked-out\nRESULT preserved=0 removed=0').outcome).toBe('ok')
    })

    test('a cleanup that never ran is a FAILURE, never a preservation', () => {
      // Exit 2 (usage), 127 (wrong script path) and a silent agent all mean the
      // script inspected NOTHING. Calling those "PRESERVED WORK" points the
      // operator at work that does not exist and drowns the real alarm in noise.
      expect(classify(2, 'worktree-cleanup.sh: usage: …').outcome).toBe('failed')
      expect(classify(127, 'bash: no such file').outcome).toBe('failed')
      expect(classify(undefined, '').outcome).toBe('failed')
      expect(classify(undefined, 'REMOVED /wt\nRESULT preserved=0 removed=1').outcome).toBe('failed')
      expect(classify('not-a-number', 'REMOVED /wt').outcome).toBe('failed')
      // …and the log line for those says so, rather than crying preservation.
      expect(SRC).toContain('cleanup:worktree FAILED')
      expect(SRC).toContain('this is not a preservation')
    })

    test('a mis-transcribed NON-ZERO code does not outrank PRESERVED records either', () => {
      // The 'reported 0' case above was fixed by letting the transcript win — but
      // only for 0 and "no code at all". Every OTHER mis-transcription (1, 2, 127,
      // a negative, a stringified one) still fell through to 'failed', whose log
      // line reads "NOTHING was inspected or removed (this is not a preservation)".
      // That is the opposite of what the transcript in the same log says, and it
      // sends the operator away from work that is sitting on disk.
      const raw = 'PRESERVED worktree /wt reason=dirty\n  ?? brand-new.ts\nRESULT preserved=1 removed=0'
      for (const reported of [1, 2, 127, -1, '2', 3.5]) {
        expect(classify(reported, raw).outcome).toBe('preserved-unmarked')
      }
      // The script's OWN marker saying 3 while the agent typed something else is
      // the same story: the records decide.
      expect(classify(2, `${raw}\n___EXIT=3`).outcome).toBe('preserved-unmarked')
      // The log line names the mis-reported number so the operator can see the
      // disagreement rather than being quietly overruled.
      expect(SRC).toContain('mis-reported as')
      // NO CRY WOLF: the genuine never-ran exits emit no PRESERVED record at all,
      // so they are untouched by this and still read as a cleanup FAILURE.
      expect(classify(2, 'worktree-cleanup.sh: usage: …').outcome).toBe('failed')
      expect(classify(127, 'bash: no such file').outcome).toBe('failed')
    })
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
    // Two nested guards, terminal freeze OUTERMOST: a cancelled run's surviving
    // workflow records its result but never flips the liveness column to
    // 'completed' (the result is inert on a terminal row — nothing harvests it).
    expect(CHECKPOINT_SH).toContain(
      "subagent_status=CASE WHEN phase IN $terminal_phases THEN subagent_status WHEN length(CAST(readfile('$f') AS TEXT)) > 0 THEN 'completed' ELSE subagent_status END",
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

// RUN f384460d (2026-08-15) — `pr` WENT 267 → 0 AND THE RUN DIED ON IT.
//
// The build wrapper's pr-mode trailer is `PR_NUMBER=0` BY DESIGN (FORGE_PR_LINE: "the outer
// loop publishes after this build exits"), so the sentinel is CORRECT and stays. What was
// wrong is that three consumers treated it as a measurement: the forge adoption took it over
// the PR threaded in at launch, and `checkpoint()` + `writeTerminalResult()` then persisted
// the zero onto the run row. GitHub numbers PRs from 1, so a non-positive one is never an
// answer — each site now adopts/writes only a POSITIVE INTEGER.
describe('inner-workflow.mjs — a prNumber of 0 is a sentinel, never a PR number', () => {
  test('the forge adoption takes a positive integer ONLY (the old nullish test is gone)', () => {
    expect(SRC).toContain('if (Number.isInteger(forge.prNumber) && forge.prNumber > 0) pr = forge.prNumber')
    // The mutation this kills: restoring the "anything that is not null/undefined" test,
    // which is exactly what adopted the 0.
    expect(SRC).not.toContain('forge.prNumber !== null && forge.prNumber !== undefined')
  })

  test('checkpoint() refuses to persist a non-positive pr', () => {
    expect(SRC).toContain('const prNum = Number(o.pr)')
    expect(SRC).toContain('if (Number.isInteger(prNum) && prNum > 0) fields.push(`pr ${prNum}`)')
    expect(SRC).not.toContain('if (o.pr !== undefined && o.pr !== null)')
  })

  test('writeTerminalResult() refuses to persist a non-positive pr', () => {
    expect(SRC).toContain('const terminalPr = Number(result.prNumber)')
    expect(SRC).toContain('if (Number.isInteger(terminalPr) && terminalPr > 0)')
    expect(SRC).not.toContain('if (result.prNumber !== undefined && result.prNumber !== null)')
  })

  test('the wrapper contract itself is UNCHANGED — the sentinel is the consumers\' problem', () => {
    // Hardening the readers must not quietly rewrite what the build reports; the trailer
    // line stays exactly as the wrapper and the build brief agree on it.
    expect(SRC).toContain('PR_NUMBER=0   (the outer loop publishes after this build exits)')
    expect(SRC).toContain('PR_NUMBER=0   (local mode — no GitHub PR)')
  })
})

describe('inner-workflow.mjs — RB2 (b) reflection trust boundary + subordination', () => {
  // The ROLE→prompt gating + placement are covered BEHAVIORALLY against the as-built
  // script by `inner-workflow-assembly.test.ts` (a mock-execution harness that captures
  // real agent() prompts) and the derivation by `reflection-guidance.test.ts`. These
  // source assertions are belt-and-suspenders: the guidance is APPENDED after the task
  // on the Forge builder sites and NOWHERE on the review-gate sites.
  test('destructures the ready-to-append reflectionGuidance from the args contract (defaults to \'\')', () => {
    // The guidance is DERIVED in the launcher (testable TS) and threaded ready — the
    // .mjs carries NO derivation logic of its own (that would be un-executable here).
    expect(SRC).toContain("reflectionGuidance = '',")
    expect(SRC).not.toContain('reflectionPreamble')
    expect(SRC).not.toContain('reflectionContext')
  })

  test('APPENDS the reflection guidance AFTER the Forge build task (never before the contract)', () => {
    // Subordination: the fixed contract + task keep primacy; the untrusted advisory
    // block is appended at the very end. `${task}${reflectionGuidance}` — not prepended.
    expect(SRC).toContain('TASK:\n${task}${reflectionGuidance}')
    // Belt: the guidance never precedes the Forge contract.
    expect(SRC).not.toContain('${reflectionGuidance}${forgeBuildContract')
  })

  test('APPENDS the reflection guidance AFTER the task on EVERY Forge fix-round prompt too', () => {
    // Each `forge:fix-round-*` is a FRESH agent, so the corrections are re-appended
    // (else Forge loses them while revising) — still after the task, never before.
    const appendSites = SRC.match(/TASK:\n\$\{task\}\$\{reflectionGuidance\}/g) ?? []
    expect(appendSites).toHaveLength(2) // forge:build + the forge:fix-round-* prompt
  })

  // SECURITY (FIX 1) — the reflection block is UNTRUSTED NL; giving it to a reviewer
  // would prompt-inject the independent MERGE GATE. It must appear on NO
  // reviewer/synthesis/peer site. Mutation-kills: adding `reflectionGuidance` to any
  // argus prompt fails here.
  test('argus:claude reviewer prompt EXCLUDES reflection (starts at the bare rubric)', () => {
    expect(SRC).toContain('`${ARGUS_RUBRIC}')
    expect(SRC).not.toContain('reflectionGuidance}${ARGUS_RUBRIC')
  })

  test('argus:adversarial reviewer prompt EXCLUDES reflection', () => {
    expect(SRC).toContain('`You are ARGUS-ADVERSARIAL (independent, read-only).')
    expect(SRC).not.toContain('reflectionGuidance}You are ARGUS-ADVERSARIAL')
  })

  test('argus:synthesis verdict-interpreter EXCLUDES reflection', () => {
    expect(SRC).toContain('`Synthesise these INDEPENDENT review verdicts')
    expect(SRC).not.toContain('reflectionGuidance}Synthesise these INDEPENDENT review verdicts')
  })

  test('argus:codex external-peer launcher EXCLUDES reflection', () => {
    // The prompt is selected per route (`peerPrompt`) now that a slot can hold either
    // provider; `codexReviewerPrompt` is still what a codex route resolves to.
    expect(SRC).toContain("agent(peerPrompt('argus:codex', slotOneRoute, 1), peerAgentOpts({ label: 'argus:codex'")
    expect(SRC).toContain("route.group === 'kimi' ? kimiReviewerPrompt(diffFile, cliOpts) : codexReviewerPrompt(diffFile, cliOpts)")
    expect(SRC).not.toContain('reflectionGuidance}${codexReviewerPrompt')
  })

  test('the ONLY prompt-assembly uses of reflectionGuidance are the two Forge builder sites', () => {
    // A stray `${reflectionGuidance}` interpolation anywhere else (e.g. a reviewer
    // prompt) is caught here: exactly two template-interpolation append sites, both Forge.
    const spliceSites = SRC.match(/\$\{reflectionGuidance\}/g) ?? []
    expect(spliceSites).toHaveLength(2)
  })
})

describe('#568 — the head-probe seat is wrapped, and this test EXISTS because the first version was vacuous', () => {
  // The review panel's own finding on this PR: "the new head-probe seatAttempt guard
  // is mutation-unproven — removing it left 70 pass → 70 pass". A guard no test can
  // kill is indistinguishable from no guard, so these assertions are written to FAIL
  // if the wrapper is removed.
  //
  // SOURCE-SCOPED, and labelled honestly. `seatAttempt` is not exported from the
  // .mjs, so it cannot be driven behaviourally from here; every assertion below is
  // about the SHAPE of the source, which is the same technique the rest of this file
  // uses. It proves the wiring is present, NOT that a rejecting probe is handled at
  // runtime — that stronger claim needs the seam to be exported, which is deliberately
  // out of scope for a fix landing under time pressure.
  test('the head-probe dispatch goes THROUGH seatAttempt (mutant: unwrap it)', () => {
    // Anchor on the COMPOSITION, not on the label alone. Writing this the obvious way
    // — indexOf('head-probe-round-') — finds the routing table in `routeModel` first,
    // which mentions the same label and knows nothing about dispatch. That is the very
    // trap this PR's other fix is about, and it caught the author of this test too.
    expect(SRC).toContain('seatAttempt(`head-probe-round-')
  })

  test('seatAttempt SWALLOWS the rejection rather than rethrowing (mutant: re-throw)', () => {
    const at = SRC.indexOf('async function seatAttempt(')
    expect(at).toBeGreaterThan(-1)
    const body = SRC.slice(at, at + 500)
    expect(body).toContain('catch')
    expect(body).toContain('return null')
    // The whole point of the guard: a dead seat must not propagate. If someone
    // "improves" this by rethrowing, the lane dies again exactly as it did at round 7.
    expect(body).not.toContain('throw err')
  })

  test('a dead seat is NAMED on the transcript (mutant: drop the seat from the log)', () => {
    const at = SRC.indexOf('async function seatAttempt(')
    const body = SRC.slice(at, at + 500)
    // "an infra block that does not say WHICH seat died and WHY leaves the operator
    // with nothing to act on" — so the log line must carry both.
    expect(body).toContain('trident.seat-died')
    expect(body).toContain('seat=')
    expect(body).toContain('reason=')
  })
})
