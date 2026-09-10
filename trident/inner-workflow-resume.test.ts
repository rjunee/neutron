/**
 * MID-LOOP RESUME — AS-BUILT behavioral coverage, executed over the REAL
 * `inner-workflow.mjs` body (not a parallel re-implementation).
 *
 * THE PROBLEM. A lane's host process dies mid-loop (the shared account hits its
 * session limit; the 429 ends the session). The branch and its pushed commits
 * survive, so no code is lost — but the relaunch rebuilt and re-reviewed from
 * zero, re-paying for review rounds already bought. Fifteen lanes died that way in
 * three waves on 2026-08-12; several had finished round-1 review, one was at fix
 * round 7.
 *
 * THE FAILURE DIRECTION THAT MATTERS IS A FALSE RESUME, so that is what this suite
 * is built around. A resume that re-runs too much costs money; a resume that skips
 * a review costs correctness — it can ship code no reviewer read. Every test below
 * therefore asserts WHICH PHASES DID NOT RUN, not merely that the run finished:
 * a "resume" that silently re-runs everything is the old behaviour wearing a new
 * name and would pass a naive "it returned APPROVE" test.
 *
 * Harness identical in spirit to `inner-workflow-ralph-refire.test.ts`: read the
 * un-importable script (top-level `return` + Workflow-runtime globals), strip the
 * single `export`, and run the body as an AsyncFunction with MOCKED runtime globals
 * that RECORD every `agent()` label and prompt. `dbPath`/`runId` ARE threaded here
 * (unlike the ralph harness) so the checkpoint steps issue their agent() call and
 * this suite can read the exact command they would run — nothing executes it, so no
 * database is touched.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { reviewedHeadOid } from './merge.ts'
import { resumeHeadDecides } from './orchestrator.ts'
import type { TridentRun } from './store.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

/** Full 40-hex OIDs — `normalizeOid` (and merge.ts) refuse anything shorter. */
const RECORDED = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const FRESH_BUILD = 'c'.repeat(40)
const FIX_SHA = (round: number): string => String(round).repeat(40).slice(0, 40)

const RECORDED_FINDINGS = [
  { severity: 'blocker', title: 'RECORDED — null deref in parseWidget', evidence: 'widget.ts:42' },
]

/**
 * The shape an INFRA-ONLY round records: a lane blocker, identified by the `kind` field
 * the cross-model gate stamps — NOT by its severity, which is 'blocker' precisely so a
 * dead seat cannot be approved past. The classifier drops it before it reads severity at
 * all; the resume seam must do the same, or a checkpoint that says "codex never answered"
 * buys a Forge round to edit code over it.
 */
const LANE_ONLY_FINDINGS = [
  {
    severity: 'blocker',
    kind: 'lane',
    title: 'REVIEW SEAT DOWN: codex produced no verdict',
    evidence: 'the codex seat returned nothing this round; the panel was incomplete',
  },
]

/** The shape an advisory-only round records: workflow-stamped, all non-blocking. */
const ADVISORY_ONLY_FINDINGS = [
  {
    severity: 'major',
    advisory: true,
    title: 'CI CHECK RED ON THIS PR AND AT THE BASE — pre-existing at the base',
    evidence: 'shard 3/8 fails identically at the base commit; the excuse holds the merge, it does not force a round',
  },
]

/**
 * The advisory the CI GATE ITSELF writes onto `argus-request-changes-round-N` when every
 * red is also red at the base — `ciBlockerFindings`' second arm, title and marker
 * included. This is the exact row a PR-mode round records, and therefore the exact input
 * a resume of that row reads back.
 */
const RECORDED_CI_ADVISORY = [
  {
    severity: 'major',
    advisory: true,
    title: 'CI RED FOR PRE-EXISTING REASONS: test',
    evidence: 'The `test` check is FAILURE on this PR — AND it is already failing at the base.',
  },
]

interface RunOut {
  labels: string[]
  prompts: Array<{ label: string; prompt: string }>
  result: {
    ok: boolean
    verdict: string | null
    prNumber: number | null
    branch: string
    round: number
    checkpoint: string
    reviewedHead?: string
    remainingTasks?: number
    blockKind?: string
    terminalCause?: string
  }
}

interface ResumeOpts {
  checkpoint?: string | null
  recordedHead?: string | null
  /** What the branch-head probe reports. Defaults to the recorded OID (unchanged). */
  currentHead?: string
  /** The live head the LAUNCHER read from git. Supplied → the probe seat must not be
   *  dispatched at all. Omitted → an old launcher, and the probe still runs. */
  resumeLiveHead?: string
  findings?: unknown[] | null
  /** Synthesised verdicts, consumed one per review round. Defaults to APPROVE. */
  verdicts?: Array<'APPROVE' | 'REQUEST_CHANGES'>
  maxRounds?: number
  /** Bytes the resume-diff step reports writing. 0 → it could not produce one. */
  diffBytes?: number
  ralph?: boolean
  /** The rendered TEST EXECUTION block. Omitted → '' (a launcher that derives none),
   *  which is the arming condition for the full-suite gate. */
  testStrategy?: string
  /** PR MODE, with a PR number — the ONLY world in which CI exists. `probeCi` returns
   *  `{status:'none'}` without spending a seat when `!isPr`, so a CI property asserted
   *  in local mode is asserted about nothing. */
  pr?: boolean
  /** What `gh pr checks` reports for the PR, in PR mode. Defaults to green. */
  ci?: 'red' | 'green'
  /** What the SAME check reports AT THE BASE. 'red' → the PR's red is excused as
   *  pre-existing (advisory), which is the finding this branch's economy is about. */
  ciBase?: 'red' | 'green'
}

/** Drive the REAL inner-workflow body through a resume. */
async function runResume(opts: ResumeOpts): Promise<RunOut> {
  const labels: string[] = []
  const prompts: Array<{ label: string; prompt: string }> = []
  const verdicts = [...(opts.verdicts ?? ['APPROVE' as const])]
  const currentHead = opts.currentHead ?? opts.recordedHead ?? ''
  let round = 0

  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = o?.label ?? ''
    labels.push(label)
    prompts.push({ label, prompt })
    if (label === 'head-probe-round-resume') return { head: currentHead }
    if (label.startsWith('head-probe-round-built-')) {
      return { head: round === 1 ? FRESH_BUILD : FIX_SHA(round) }
    }
    if (label.startsWith('head-probe-round-')) {
      // A fix round's did-it-land probe: report the sha that round committed.
      return { head: FIX_SHA(round) }
    }
    if (label === 'resume-diff') return { bytes: opts.diffBytes ?? 4096 }
    // ── THE PR-MODE PROBE SEATS ────────────────────────────────────────────────
    // Dispatched only when `mergeMode` is 'pr' AND there is a PR, so these branches
    // are dead for every local-mode case above. Fixture shapes copied from
    // `__tests__/dying-reviewer-e2e.test.ts`, which drives the same seats.
    if (label.startsWith('ci-probe-round-')) {
      return {
        raw: `[{"name":"test","state":"${opts.ci === 'red' ? 'FAILURE' : 'SUCCESS'}","link":"https://x/1"}]\n___EXIT=0`,
        exit_code: 0,
      }
    }
    if (label.startsWith('ci-base-probe-round-')) {
      // Spent only when the PR is red; both halves of the base measurement, in the
      // two-section shape `ciSection`/`mergeBaseCi` parse.
      const state = opts.ciBase === 'red' ? 'FAILURE' : 'SUCCESS'
      return {
        raw: `___SECTION=RUNS\n[{"name":"test","state":"${state}"}]\n___SECTION=STATUSES\n[]\n___EXIT=0`,
        exit_code: 0,
      }
    }
    if (label.startsWith('required-checks-r')) {
      return {
        raw:
          'gh: Not Found (HTTP 404)\n___PROT_EXIT=1\n' +
          '___SECTION=BRANCH\n{"protected":false,"protectionEnabled":false}\n___BRANCH_EXIT=0\n' +
          '___SECTION=RULES\n[]\n___RULES_EXIT=0\n' +
          '___SECTION=RUNS\n{"n":1,"names":["test"]}\n___RUNS_EXIT=0\n' +
          '___SECTION=STATUSES\n{"n":0,"names":[]}\n___STATUSES_EXIT=0\n___EXIT=0',
        exit_code: 0,
      }
    }
    if (label.startsWith('review-readiness-r')) {
      return {
        raw: JSON.stringify({
          mergeable: 'MERGEABLE',
          // COMPLETED whatever its conclusion: the readiness gate asks whether the
          // checks have SETTLED, and a red-but-finished check is ready to review.
          statusCheckRollup: [
            { name: 'test', status: 'COMPLETED', conclusion: opts.ci === 'red' ? 'FAILURE' : 'SUCCESS' },
          ],
        }),
        exit_code: 0,
      }
    }
    if (label.startsWith('merge-probe-round-')) {
      return { raw: '{"state":"OPEN","mergedAt":""}\n___EXIT=0', exit_code: 0 }
    }
    if (label === 'plan:fable') {
      return {
        implementationPlan: '- [ ] task A',
        topTask: 'task A',
        executionSpec: 'TARGET FILES: a.ts',
        complexity: 'reasoning',
        remainingTasks: 0,
      }
    }
    if (label === 'forge:build') {
      round = 1
      return {
        prNumber: null,
        branch: 'trident/resume-run',
        diffFile: '/tmp/fresh-build.diff',
        worktreePath: '/wt',
        commitSha: FRESH_BUILD,
        testsPassed: true,
      }
    }
    if (label.startsWith('forge:fix-round-')) {
      round = Number(label.slice('forge:fix-round-'.length))
      return {
        prNumber: null,
        branch: 'trident/resume-run',
        diffFile: '/tmp/fresh-build.diff',
        worktreePath: '/wt',
        commitSha: FIX_SHA(round),
        testsPassed: true,
      }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') return { verdict: 'APPROVE', findings: [] }
    if (label === 'argus:synthesis') {
      const v = verdicts.shift() ?? 'REQUEST_CHANGES'
      return v === 'APPROVE'
        ? { verdict: 'APPROVE', findings: [] }
        : {
            verdict: 'REQUEST_CHANGES',
            findings: [{ severity: 'blocker', title: 'FRESH — still broken', evidence: 'widget.ts:9' }],
          }
    }
    // checkpoint / terminal-result / cleanup Bash steps: recorded, never executed.
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (): void => {}
  const budget = { total: 0, spent: (): number => 0 }

  const args = {
    repoPath: '/repo',
    task: 'Ship the widget',
    baseBranch: 'main',
    slug: 'resume-run',
    maxRounds: opts.maxRounds ?? 10,
    ralph: opts.ralph === true,
    // local mode keeps the panel to claude+adversarial+synthesis (no CI probe, no
    // cross-model seats) — the resume decision is git-mode independent. `pr: true`
    // switches to the mode where CI EXISTS, which is the only place a CI property can
    // be measured at all (`probeCi` early-returns 'none' when `!isPr`).
    mergeMode: opts.pr === true ? 'pr' : 'local',
    prNumber: opts.pr === true ? 7 : null,
    branch: 'trident/resume-run',
    dbPath: '/tmp/does-not-exist.db',
    runId: 'run-resume-1',
    resumeCheckpoint: opts.checkpoint ?? null,
    resumeCheckpointHead: opts.recordedHead ?? null,
    ...(opts.resumeLiveHead !== undefined ? { resumeLiveHead: opts.resumeLiveHead } : {}),
    resumeFindings: opts.findings ?? null,
    codexHome: null,
    checkpointScript: '/repo/trident/checkpoint.sh',
    worktreeCleanupScript: '/repo/trident/worktree-cleanup.sh',
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance: '',
    ...(opts.testStrategy !== undefined ? { testStrategy: opts.testStrategy } : {}),
  }

  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  const result = (await fn(agent, parallel, phase, log, budget, args)) as RunOut['result']
  return { labels, prompts, result }
}

const built = (labels: string[]): boolean => labels.includes('forge:build')
const reviewed = (labels: string[]): boolean => labels.includes('argus:claude')
const promptFor = (out: RunOut, label: string): string =>
  out.prompts.find((p) => p.label === label)?.prompt ?? ''

describe('mid-loop resume — the head UNCHANGED fast paths actually SKIP work', () => {
  test("'forge-done' + unchanged head → NO build, review the recorded commit", async () => {
    const out = await runResume({ checkpoint: 'forge-done', recordedHead: RECORDED })

    // THE SKIP, asserted as an absence. Without this the test would pass on a
    // "resume" that rebuilt everything and happened to approve.
    expect(built(out.labels)).toBe(false)
    expect(out.labels).not.toContain('plan:fable')
    // …and the work that SHOULD run, did: the diff was regenerated and reviewed.
    expect(out.labels).toContain('resume-diff')
    expect(reviewed(out.labels)).toBe(true)
    expect(out.labels).toContain('argus:synthesis')

    expect(out.result.verdict).toBe('APPROVE')
    // The merge pins to the commit the reviewers just read — the recorded one,
    // which the probe proved is still the branch head.
    expect(out.result.reviewedHead).toBe(RECORDED)
  })

  test('the regenerated diff is taken from the OID, never from the branch name', async () => {
    const out = await runResume({ checkpoint: 'forge-done', recordedHead: RECORDED })
    const cmd = promptFor(out, 'resume-diff')
    expect(cmd).toContain(`git diff 'main'..'${RECORDED}'`)
    // A branch-name diff would silently swap the code under review if anything
    // pushed between the head comparison and this command.
    expect(cmd).not.toContain("git diff 'main'..'trident/resume-run'")
  })

  test("'argus-approved' + unchanged head → NO build and NO review at all", async () => {
    const out = await runResume({ checkpoint: 'argus-approved', recordedHead: RECORDED })

    expect(built(out.labels)).toBe(false)
    expect(out.labels.some((l) => l.startsWith('argus:'))).toBe(false)
    expect(out.labels).not.toContain('resume-diff')

    expect(out.result.verdict).toBe('APPROVE')
    expect(out.result.round).toBe(0)
    expect(out.result.checkpoint).toBe('argus-approved')
    // Pinned to the RECORDED approved commit, decoded by the REAL merge-side
    // decoder — this is the value `gh pr merge --match-head-commit` receives.
    expect(out.result.reviewedHead).toBe(RECORDED)
    expect(reviewedHeadOid({ inner_result: JSON.stringify(out.result) } as TridentRun)).toBe(RECORDED)
  })

  test("'argus-request-changes' + unchanged head + recorded findings → straight to the FIX round", async () => {
    const out = await runResume({
      checkpoint: 'argus-request-changes',
      recordedHead: RECORDED,
      findings: RECORDED_FINDINGS,
      verdicts: ['APPROVE'],
    })

    expect(built(out.labels)).toBe(false)
    // THE ROUND THAT WAS ALREADY PAID FOR IS NOT RE-RUN: the panel runs exactly
    // ONCE here, and it is the review of the FIXED head, not a repeat of the one
    // whose verdict we resumed from.
    expect(out.labels.filter((l) => l === 'argus:claude')).toHaveLength(1)
    const firstReview = out.labels.indexOf('argus:claude')
    const fixRound = out.labels.indexOf('forge:fix-round-2')
    expect(fixRound).toBeGreaterThan(-1)
    expect(firstReview).toBeGreaterThan(fixRound)

    // The fix agent is handed the RECORDED findings, not an empty list.
    expect(promptFor(out, 'forge:fix-round-2')).toContain('RECORDED — null deref in parseWidget')

    expect(out.result.verdict).toBe('APPROVE')
    // …and the APPROVE is pinned to the FIXED commit, never the resumed one.
    expect(out.result.reviewedHead).toBe(FIX_SHA(2))
    expect(out.result.reviewedHead).not.toBe(RECORDED)
  })

  /**
   * THE ADVISORY-ONLY HOLD IS A MEASUREMENT, NOT REVIEW DEBT — SO A RESUME RE-MEASURES.
   *
   * Run 4f28c9e0's round-4 review (reaped by the watchdog; preserved in the relaunch
   * dispatch) reproduced a livelock: a recorded REQUEST_CHANGES whose findings were all
   * non-blocking was rebuilt at resume as a paid 'advisory-only' review, `runReviewRound`
   * returned it untouched (no CI probe, no reviewer), and the fix loop exits on
   * 'advisory-only' — so the terminal hold replayed forever and a red that had become
   * green could never be observed. These two tests EXECUTE the boundary; both were red
   * against the unfixed seam.
   */
  test("'argus-request-changes-round-2' + unchanged head + ONLY advisory findings → RE-REVIEW, and a now-green world reaches a verdict", async () => {
    const out = await runResume({
      checkpoint: 'argus-request-changes-round-2',
      recordedHead: RECORDED,
      findings: ADVISORY_ONLY_FINDINGS,
      verdicts: ['APPROVE'],
    })
    // The build stays skipped (the head is unchanged) and the diff is regenerated…
    expect(built(out.labels)).toBe(false)
    expect(out.labels).toContain('resume-diff')
    // …but the hold is NOT replayed: the panel actually runs, exactly once.
    expect(out.labels.filter((l) => l === 'argus:claude')).toHaveLength(1)
    // No Forge round is bought on the stale advisories — the economy 17c72201 bought.
    expect(out.labels.some((l) => l.startsWith('forge:'))).toBe(false)
    // The run reaches a verdict instead of replaying REQUEST_CHANGES forever…
    expect(out.result.verdict).toBe('APPROVE')
    expect(out.labels).toContain('checkpoint:argus-approved')
    // …pinned to the commit the panel just re-read: the recorded, unchanged head.
    expect(out.result.reviewedHead).toBe(RECORDED)
  })

  test('a re-probed advisory hold that is STILL rejected feeds the fix round the FRESH findings, never the stale advisories', async () => {
    const out = await runResume({
      checkpoint: 'argus-request-changes-round-2',
      recordedHead: RECORDED,
      findings: ADVISORY_ONLY_FINDINGS,
      verdicts: ['REQUEST_CHANGES', 'APPROVE'],
    })
    expect(built(out.labels)).toBe(false)
    // The fresh panel stated real code work, so the loop buys the round it names —
    // round 3, because round 2 was inherited from the checkpoint.
    expect(out.labels).toContain('forge:fix-round-3')
    const fixPrompt = promptFor(out, 'forge:fix-round-3')
    expect(fixPrompt).toContain('FRESH — still broken')
    expect(fixPrompt).not.toContain('pre-existing at the base')
    expect(out.result.verdict).toBe('APPROVE')
    expect(out.result.reviewedHead).toBe(FIX_SHA(3))
  })

  /**
   * A RECORDED LANE BLOCKER IS NOT RECORDED CODE WORK — the other half of the same
   * predicate. `classifyBlock` drops `kind: 'lane'` FIRST and only then asks about
   * severity, and the resume seam asked only the severity half: a persisted
   * `{severity:'blocker', kind:'lane'}` finding — what the lane gate writes onto
   * `argus-request-changes-round-N`, and what the orchestrator's infra-only auto-retry
   * replays — therefore asserted `blockKind: 'code'` at resume and sent Forge off to fix
   * a dead review seat with code. Both sites now ask ONE function.
   */
  test("'argus-request-changes-round-1' + unchanged head + a recorded LANE blocker → RE-REVIEW, NO Forge round", async () => {
    const out = await runResume({
      checkpoint: 'argus-request-changes-round-1',
      recordedHead: RECORDED,
      findings: LANE_ONLY_FINDINGS,
      verdicts: ['APPROVE'],
    })
    // No code was written to "fix" a seat that never answered…
    expect(out.labels.some((l) => l.startsWith('forge:'))).toBe(false)
    expect(built(out.labels)).toBe(false)
    // …and the lane is RE-MEASURED instead of replayed: the panel runs, exactly once.
    expect(out.labels.filter((l) => l === 'argus:claude')).toHaveLength(1)
    // The seat answers this time, so the run reaches a verdict on the unchanged head.
    expect(out.result.verdict).toBe('APPROVE')
    expect(out.result.reviewedHead).toBe(RECORDED)
    // And the stale lane text is nowhere in what this round dispatched.
    expect(out.prompts.every((pr) => !pr.prompt.includes('REVIEW SEAT DOWN'))).toBe(true)
  })

  /**
   * THE SAME BOUNDARY, IN THE ONLY MODE WHERE CI EXISTS — and this is the half the two
   * tests above CANNOT measure (round-3 review, confirmed by three panelists). They run in
   * `mergeMode: 'local'`, where `probeCi` returns `{status:'none'}` without spending a seat,
   * so "the CI red is re-probed and a red that went green is observed" was asserted about a
   * probe that never ran. These two run in PR mode with a PR number, and they run IN
   * SEQUENCE — the second consumes what the first recorded — because the livelock is a
   * property of the SECOND run: once a round terminates 'advisory-only', a rerun on the same
   * head could never observe that CI had gone green, and replayed the hold forever.
   */
  test('PR mode, CI still red at the PR and at the base → the hold holds, and it still buys NO Forge round', async () => {
    const out = await runResume({
      pr: true,
      checkpoint: 'argus-request-changes-round-2',
      recordedHead: RECORDED,
      findings: RECORDED_CI_ADVISORY,
      ci: 'red',
      ciBase: 'red',
      verdicts: ['APPROVE'],
    })
    // The seat that cannot exist in local mode ACTUALLY RAN — this round measured CI.
    expect(out.labels).toContain('ci-probe-round-2')
    expect(out.labels).toContain('ci-base-probe-round-2')
    // The panel approved, and the red PR still holds the merge…
    expect(out.result.verdict).toBe('REQUEST_CHANGES')
    // …as an ADVISORY-ONLY hold: every red is red at the base, so there is no code work.
    expect(out.result.blockKind).toBe('advisory-only')
    // The economy 17c72201 bought is intact: no round is bought on a pre-existing red.
    expect(out.labels.some((l) => l.startsWith('forge:'))).toBe(false)
    // And the hold is RECORDED with the advisory, which is what the next run reads back.
    expect(promptFor(out, 'checkpoint:argus-request-changes-round-2')).toContain(
      'CI RED FOR PRE-EXISTING REASONS',
    )
  })

  test('PR mode, the SAME recorded advisory on an UNCHANGED head, CI now GREEN → re-probed, and the run reaches a verdict', async () => {
    const out = await runResume({
      pr: true,
      checkpoint: 'argus-request-changes-round-2',
      recordedHead: RECORDED,
      findings: RECORDED_CI_ADVISORY,
      ci: 'green',
      // ARMED, deliberately: `resumeSuiteFindings` is inert when the launcher derived no
      // strategy, so the carry-forward filter below can only be measured with one set.
      testStrategy: 'bun run test',
      verdicts: ['APPROVE'],
    })
    // THE RE-PROBE, EXECUTED. Replaying the recorded hold returns before `reviewAndSynthesize`
    // and therefore before `probeCi`, so this label is absent in the livelocked shape.
    expect(out.labels).toContain('ci-probe-round-2')
    // Nothing was rebuilt and no round was bought — the head never moved.
    expect(built(out.labels)).toBe(false)
    expect(out.labels.some((l) => l.startsWith('forge:'))).toBe(false)
    // The panel re-ran, exactly once, and the run REACHES A VERDICT instead of replaying.
    expect(out.labels.filter((l) => l === 'argus:claude')).toHaveLength(1)
    expect(out.result.verdict).toBe('APPROVE')
    expect(out.labels).toContain('checkpoint:argus-approved')
    expect(out.result.reviewedHead).toBe(RECORDED)
    // AND THE STALE ADVISORY IS NOT REPLAYED INTO THE PROMPTS. `resumeSuiteFindings` keeps
    // only the SUITE gate's own entries off a fix-mode row, precisely because a CI advisory
    // is re-measured here — carrying it forward would assert a red this round just watched
    // turn green.
    expect(promptFor(out, 'argus:claude')).not.toContain('CI RED FOR PRE-EXISTING REASONS')
    expect(promptFor(out, 'argus:synthesis')).not.toContain('CI RED FOR PRE-EXISTING REASONS')
  })

  /**
   * THE ADVISORY THE GATE PAID FOR SURVIVES THE FALL-THROUGH. `withSuiteBlocker` merges the
   * full-suite gate's finding into the synthesis before the verdict is checkpointed, so an
   * `argus-request-changes-round-N` row carries the panel's findings AND the suite claim.
   * The fall-through dropped the whole row, and a resume that then APPROVED reported no
   * suite advisory at all — a claim no build in THIS process can re-derive.
   */
  test('a recorded suite advisory rides through the re-review and reaches the panel and the verdict', async () => {
    const out = await runResume({
      checkpoint: 'argus-request-changes-round-2',
      recordedHead: RECORDED,
      testStrategy: 'bun run test',
      findings: [
        {
          severity: 'major',
          advisory: true,
          kind: 'suite',
          title: 'FULL SUITE RED FOR PRE-EXISTING REASONS — the build says the failures are not its diff',
          evidence: 'the same 14 files fail identically at the merge base',
        },
      ],
      verdicts: ['APPROVE'],
    })
    // Still no round bought — the advisory economy is untouched…
    expect(out.labels.some((l) => l.startsWith('forge:'))).toBe(false)
    expect(out.result.verdict).toBe('APPROVE')
    // …the panel was TOLD about the unproven suite before it answered…
    expect(promptFor(out, 'argus:claude')).toContain('FULL SUITE RED FOR PRE-EXISTING REASONS')
    // …and it is written back onto the DURABLE record, so the next resume of this row
    // still knows the suite was never proven. (An APPROVE terminal result carries no
    // findings by design — the checkpoint is where the claim has to survive.)
    expect(promptFor(out, 'checkpoint:argus-approved')).toContain('FULL SUITE RED FOR PRE-EXISTING REASONS')
  })

  test("'fix-round-7' + unchanged head → review it, and INHERIT the spent round budget", async () => {
    const out = await runResume({
      checkpoint: 'fix-round-7',
      recordedHead: RECORDED,
      maxRounds: 10,
      verdicts: ['REQUEST_CHANGES', 'APPROVE'],
    })

    expect(built(out.labels)).toBe(false)
    expect(reviewed(out.labels)).toBe(true)
    // Round 8, not round 2: a resumed lane gets the rounds it has LEFT. Restarting
    // the counter would hand a crashed loop a fresh full budget every crash.
    expect(out.labels).toContain('forge:fix-round-8')
    expect(out.labels).not.toContain('forge:fix-round-2')
    expect(out.result.round).toBe(8)
  })

  test('a resumed round budget can still be EXHAUSTED (the cap keeps bounding)', async () => {
    const out = await runResume({
      checkpoint: 'fix-round-7',
      recordedHead: RECORDED,
      maxRounds: 8,
      verdicts: ['REQUEST_CHANGES', 'REQUEST_CHANGES'],
    })
    expect(out.labels).toContain('forge:fix-round-8')
    expect(out.labels).not.toContain('forge:fix-round-9')
    expect(out.result.verdict).toBe('REQUEST_CHANGES')
  })
})

describe('mid-loop resume — a head that MOVED is re-reviewed, never trusted', () => {
  test("'forge-done' + head MOVED → the build runs again and nothing is skipped", async () => {
    const out = await runResume({ checkpoint: 'forge-done', recordedHead: RECORDED, currentHead: MOVED })

    expect(built(out.labels)).toBe(true)
    expect(reviewed(out.labels)).toBe(true)
    // No fast path was taken, so no diff was regenerated from the stale OID.
    expect(out.labels).not.toContain('resume-diff')
    // The merge pins to what the fresh build committed — not to either the
    // recorded OID or the commit the probe saw.
    expect(out.result.reviewedHead).toBe(FRESH_BUILD)
    expect(out.result.reviewedHead).not.toBe(RECORDED)
    expect(out.result.reviewedHead).not.toBe(MOVED)
  })

  test("'argus-approved' + head MOVED → NO instant APPROVE; the code is rebuilt and re-reviewed (#545)", async () => {
    // A approved → crash → B pushed. This is the case that must never merge B.
    const out = await runResume({
      checkpoint: 'argus-approved',
      recordedHead: RECORDED,
      currentHead: MOVED,
      verdicts: ['APPROVE'],
    })

    expect(built(out.labels)).toBe(true)
    expect(reviewed(out.labels)).toBe(true)
    expect(out.result.round).not.toBe(0) // not the shortcut's result
    // The only APPROVE that can come out of this run is pinned to the commit the
    // panel actually read in THIS run.
    expect(out.result.reviewedHead).toBe(FRESH_BUILD)
    expect(out.result.reviewedHead).not.toBe(MOVED)
    expect(reviewedHeadOid({ inner_result: JSON.stringify(out.result) } as TridentRun)).toBe(FRESH_BUILD)
  })

  test("'argus-request-changes' + head MOVED → the recorded findings are NOT replayed", async () => {
    const out = await runResume({
      checkpoint: 'argus-request-changes',
      recordedHead: RECORDED,
      currentHead: MOVED,
      findings: RECORDED_FINDINGS,
      verdicts: ['APPROVE'],
    })
    expect(built(out.labels)).toBe(true)
    expect(reviewed(out.labels)).toBe(true)
    // Findings about commit A must not be handed to a fix round on commit B.
    for (const p of out.prompts) {
      expect(p.prompt).not.toContain('RECORDED — null deref in parseWidget')
    }
  })
})

describe('mid-loop resume — every "could not tell" answer re-reviews', () => {
  test('NO recorded OID → rebuild, and the head is not even probed', async () => {
    const out = await runResume({ checkpoint: 'forge-done', recordedHead: null })
    expect(built(out.labels)).toBe(true)
    // With nothing to compare against, the answer is rebuild whatever the head is
    // — so the probe is not worth an agent.
    expect(out.labels).not.toContain('head-probe-round-resume')
    expect(out.labels).not.toContain('resume-diff')
  })

  test('an ABBREVIATED sha is not a recorded OID → rebuild', async () => {
    const out = await runResume({ checkpoint: 'argus-approved', recordedHead: 'a1b2c3d' })
    expect(built(out.labels)).toBe(true)
    expect(out.result.round).not.toBe(0)
  })

  // An UNREADABLE live head is covered by its own suite below: it is still never
  // "unchanged" (no fast path opens, no resume-diff), but since Part 2b its
  // consequence is a bounded STOP rather than a rebuild.

  test('a diff that could not be regenerated → rebuild rather than review nothing', async () => {
    const out = await runResume({ checkpoint: 'forge-done', recordedHead: RECORDED, diffBytes: 0 })
    expect(out.labels).toContain('resume-diff')
    expect(built(out.labels)).toBe(true)
  })

  test("'argus-request-changes' with NO recorded findings → re-review, never a blind fix round", async () => {
    const out = await runResume({
      checkpoint: 'argus-request-changes',
      recordedHead: RECORDED,
      findings: [],
      verdicts: ['APPROVE'],
    })
    // The build is still skipped (the head is unchanged), but the panel runs: a
    // fix round with nothing to fix is worse than paying for the review again.
    expect(built(out.labels)).toBe(false)
    expect(reviewed(out.labels)).toBe(true)
    const firstReview = out.labels.indexOf('argus:claude')
    expect(out.labels.slice(0, firstReview).some((l) => l.startsWith('forge:fix-round-'))).toBe(false)
  })

  test("'ralph-task-built' + unchanged head → rebuild, because the NEXT task is still unbuilt", async () => {
    const out = await runResume({
      checkpoint: 'ralph-task-built',
      recordedHead: RECORDED,
      ralph: true,
    })
    expect(out.labels).toContain('plan:fable')
    expect(built(out.labels)).toBe(true)
    expect(out.labels).not.toContain('resume-diff')
  })

  test('NO checkpoint at all (a fresh run) → the ordinary build path, no probe', async () => {
    const out = await runResume({ checkpoint: null, recordedHead: null })
    expect(built(out.labels)).toBe(true)
    expect(out.labels).not.toContain('head-probe-round-resume')
    expect(out.result.reviewedHead).toBe(FRESH_BUILD)
  })
})

describe('mid-loop resume — the OID is RECORDED at every checkpoint (the enabling fact)', () => {
  /** The checkpoint step's Bash command, as the agent would run it. */
  const checkpointCmd = (out: RunOut, name: string): string => promptFor(out, `checkpoint:${name}`)

  test('forge-done records the sha Forge reported committing', async () => {
    const out = await runResume({ checkpoint: null, recordedHead: null })
    expect(checkpointCmd(out, 'forge-done')).toContain(`inner_checkpoint_head '${FRESH_BUILD}'`)
  })

  test('the argus checkpoint records the REVIEWED head and the findings a resume would fix', async () => {
    const out = await runResume({ checkpoint: null, recordedHead: null, verdicts: ['REQUEST_CHANGES', 'APPROVE'] })
    const cmd = checkpointCmd(out, 'argus-request-changes-round-1')
    expect(cmd).toContain(`inner_checkpoint_head '${FRESH_BUILD}'`)
    expect(cmd).toContain('FRESH — still broken')
    expect(cmd).toContain('inner_findings_file')
  })

  test('a fix round records ITS OWN commit, so the next resume judges the right code', async () => {
    const out = await runResume({ checkpoint: null, recordedHead: null, verdicts: ['REQUEST_CHANGES', 'APPROVE'] })
    expect(checkpointCmd(out, 'fix-round-2')).toContain(`inner_checkpoint_head '${FIX_SHA(2)}'`)
  })

  test('a phase that reports NO sha CLEARS the recorded OID instead of inheriting the last one', async () => {
    // Belt-and-braces on the pairing rule: the field is always written, so a
    // checkpoint can never sit next to an OID that belongs to an earlier phase.
    expect(SRC).toContain('fields.push(`inner_checkpoint_head ${shSingleQuote(normalizeOid(o.head))}`)')
    const out = await runResume({ checkpoint: null, recordedHead: null })
    // Every checkpoint command in the run carries the field.
    const checkpointPrompts = out.prompts.filter((p) => p.label.startsWith('checkpoint:'))
    expect(checkpointPrompts.length).toBeGreaterThan(0)
    for (const p of checkpointPrompts) expect(p.prompt).toContain('inner_checkpoint_head ')
  })
})

/**
 * The decision function itself, lifted OUT of the un-importable script and
 * executed. The behavioral suite above proves the workflow honours it end to end;
 * these cases pin the boundaries cheaply (case, whitespace, malformed input) where
 * driving a whole workflow per case would be absurd.
 *
 * THE EXTRACTION IS PROVEN BEFORE IT IS TRUSTED. A slicer that quietly grabbed the
 * wrong text — or nothing — would make every assertion below vacuous, which is the
 * exact failure mode a source-reading test is prone to.
 */
describe('classifyResume — the boundaries, executed', () => {
  function extractFn(name: string): string {
    const at = SRC.indexOf(`function ${name}(`)
    expect(at).toBeGreaterThan(-1)
    const open = SRC.indexOf('{', at)
    let depth = 0
    for (let i = open; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++
      else if (SRC[i] === '}') {
        depth--
        if (depth === 0) return SRC.slice(at, i + 1)
      }
    }
    throw new Error(`unbalanced braces extracting ${name}`)
  }

  const source = [
    'const FULL_OID = /^[0-9a-f]{40}$/',
    extractFn('normalizeOid'),
    extractFn('classifyResume'),
    extractFn('resumeOnUnchangedHead'),
    extractFn('parseResumeRound'),
    'return { normalizeOid, classifyResume, parseResumeRound }',
  ].join('\n')

  test('POSITIVE CONTROL: the extraction really pulled the decision code', () => {
    // Named markers from inside each function. If the slicer misses, this fails
    // LOUDLY here instead of turning every case below into a silent pass.
    expect(source).toContain("reason: 'head-moved'")
    expect(source).toContain("reason: 'no-recorded-head'")
    expect(source).toContain("mode: 'approved'")
    expect(source).toContain('fix-round-')
    // …and from the head-unchanged half, which now lives in its own function.
    expect(source).toContain("reason: 'unknown-checkpoint'")
    expect(source).toContain("reason: 'ralph-progress-unknown'")
    expect(source.length).toBeGreaterThan(500)
  })

  const fns = new Function(source)() as {
    normalizeOid: (v: unknown) => string
    classifyResume: (i: {
      checkpoint: unknown
      recordedHead: unknown
      currentHead: unknown
      hasFindings: boolean
      ralph?: boolean
    }) => { mode: string; reason: string }
    parseResumeRound: (n: unknown, roundCap: number) => number
  }

  const at = (
    checkpoint: unknown,
    recordedHead: unknown,
    currentHead: unknown,
    hasFindings = false,
  ): { mode: string; reason: string } =>
    fns.classifyResume({ checkpoint, recordedHead, currentHead, hasFindings })

  test('every non-matching comparison is a rebuild, with the reason named', () => {
    expect(at(null, RECORDED, RECORDED)).toEqual({ mode: 'rebuild', reason: 'no-checkpoint' })
    expect(at('forge-done', null, RECORDED)).toEqual({ mode: 'rebuild', reason: 'no-recorded-head' })
    // An UNREADABLE head is still never "unchanged" — but its consequence is a
    // bounded STOP, not the most expensive action available (Part 2b).
    expect(at('forge-done', RECORDED, '')).toEqual({ mode: 'stop', reason: 'head-unreadable' })
    // 'absent' is a SUCCESSFUL read saying the branch is gone from the authority — a
    // different fact from '' ("could not read"), and named as such.
    expect(at('forge-done', RECORDED, 'absent')).toEqual({
      mode: 'rebuild',
      reason: 'head-branch-absent',
    })
    expect(at('forge-done', RECORDED, MOVED)).toEqual({ mode: 'rebuild', reason: 'head-moved' })
    expect(at('who-knows', RECORDED, RECORDED)).toEqual({ mode: 'rebuild', reason: 'unknown-checkpoint' })
  })

  test('the matching comparisons unlock exactly one step each', () => {
    expect(at('pr-merged', null, '')).toEqual({ mode: 'merged', reason: 'already-merged' })
    expect(at('argus-approved', RECORDED, RECORDED).mode).toBe('approved')
    expect(at('forge-done', RECORDED, RECORDED).mode).toBe('review')
    expect(at('fix-round-12', RECORDED, RECORDED).mode).toBe('review')
    expect(at('argus-request-changes', RECORDED, RECORDED, true).mode).toBe('fix')
    expect(at('argus-request-changes', RECORDED, RECORDED, false).mode).toBe('review')
    expect(
      fns.classifyResume({
        checkpoint: 'forge-done',
        recordedHead: RECORDED,
        currentHead: RECORDED,
        hasFindings: false,
        ralph: true,
      }),
    ).toEqual({ mode: 'rebuild', reason: 'ralph-progress-unknown' })
  })

  /**
   * THE BOUNDED STOP MUST NOT PRE-EMPT A DECISION THE HEAD NEVER PARTICIPATES IN
   * (Argus r5). Two dispositions are `rebuild` on EVERY head — a ralph `forge-done`
   * and any unrecognised name, `ralph-task-built` above all. Ordering the `''` check
   * in front of them made a transient read failure convert a rebuild that was going
   * to happen anyway into a TERMINAL stop: one `ls-remote` blip would have killed
   * every resuming ralph re-fire, which is a strictly worse outcome than the one this
   * card set out to remove.
   */
  test('an unreadable head does NOT stop a checkpoint that rebuilds on every head', () => {
    // `ralph-task-built` — the checkpoint the ralph re-fire path writes.
    expect(at('ralph-task-built', RECORDED, '')).toEqual({
      mode: 'rebuild',
      reason: 'unknown-checkpoint',
    })
    // …and the same answer on every OTHER head, which is what makes it head-independent.
    expect(at('ralph-task-built', RECORDED, RECORDED).mode).toBe('rebuild')
    expect(at('ralph-task-built', RECORDED, MOVED).mode).toBe('rebuild')
    expect(at('ralph-task-built', RECORDED, 'absent').mode).toBe('rebuild')
    // `forge-done` in ralph mode: built one task, progress unknown → rebuild regardless.
    const ralphAt = (currentHead: unknown): { mode: string; reason: string } =>
      fns.classifyResume({
        checkpoint: 'forge-done',
        recordedHead: RECORDED,
        currentHead,
        hasFindings: false,
        ralph: true,
      })
    expect(ralphAt('')).toEqual({ mode: 'rebuild', reason: 'ralph-progress-unknown' })
    expect(ralphAt(RECORDED).mode).toBe('rebuild')
    expect(ralphAt(MOVED).mode).toBe('rebuild')
    // NEGATIVE CONTROL — the head-DEPENDENT names still stop, or the exemption above
    // would have quietly deleted the bounded stop entirely.
    expect(at('forge-done', RECORDED, '')).toEqual({ mode: 'stop', reason: 'head-unreadable' })
    expect(at('argus-approved', RECORDED, '').mode).toBe('stop')
    expect(at(`outer-published:${RECORDED}:3:1`, RECORDED, '').mode).toBe('stop')
    expect(at('fix-round-2', RECORDED, '').mode).toBe('stop')
    expect(at('argus-request-changes', RECORDED, '', true).mode).toBe('stop')
  })

  /**
   * THE LAUNCHER'S FAST-EXIT AND `classifyResume` MUST AGREE ON EVERY NAME. The exit
   * in `orchestrator.ts launch()` exists only to skip a fire whose outcome is already
   * known; a name it exits on that `classifyResume` would NOT have stopped is a run
   * killed for nothing (that is exactly the r5 finding), and a name it fires on that
   * `classifyResume` DOES stop is only a wasted fire. `resumeHeadDecides` is a hand
   * mirror of the `.mjs` decision — this executes both and pins the mirror.
   */
  test('resumeHeadDecides mirrors classifyResume on every checkpoint name', () => {
    const names = [
      '',
      'pr-merged',
      'argus-approved',
      'argus-request-changes',
      'argus-request-changes-round-3',
      'forge-done',
      'fix-round-1',
      'fix-round-12',
      `outer-published:${RECORDED}:3:1`,
      // CODEX REVIEW [Major]: the PRODUCTION variant. #291 appends `:deviated` when the
      // build reported it deviated from its exec spec, and `classifyResume` accepts it —
      // but the launcher's mirror regex did not, so a deviated publish spent a whole
      // workflow fire to reach a stop it should have fast-exited on. This table is the
      // mirror's only guard, and it did not carry the suffixed form.
      `outer-published:${RECORDED}:3:1:deviated`,
      `outer-published:${RECORDED}:2:3:deviated`,
      'ralph-task-built',
      'who-knows',
      'outer-published:nothex:3:1',
    ]
    for (const ralph of [false, true]) {
      for (const name of names) {
        const verdict = fns.classifyResume({
          checkpoint: name,
          recordedHead: RECORDED,
          currentHead: '',
          hasFindings: true,
          ralph,
        })
        expect({ name, ralph, exits: resumeHeadDecides(name, ralph) }).toEqual({
          name,
          ralph,
          exits: verdict.mode === 'stop',
        })
      }
    }
  })

  test('case and surrounding whitespace do not change a comparison of the same commit', () => {
    expect(at('argus-approved', RECORDED.toUpperCase(), ` ${RECORDED} `).mode).toBe('approved')
  })

  test('a SHORT or malformed sha is never "the same commit"', () => {
    expect(fns.normalizeOid(RECORDED.slice(0, 12))).toBe('')
    expect(fns.normalizeOid('z'.repeat(40))).toBe('')
    expect(fns.normalizeOid(42)).toBe('')
    // …and an abbreviation of the very commit that IS on the branch still rebuilds,
    // because merge.ts would refuse that pin anyway.
    expect(at('argus-approved', RECORDED.slice(0, 12), RECORDED).mode).toBe('rebuild')
  })

  test('a fix-round checkpoint yields its round; anything else yields 0', () => {
    expect(fns.parseResumeRound('fix-round-7', 8)).toBe(7)
    expect(fns.parseResumeRound('argus-request-changes-round-7', 8)).toBe(7)
    expect(fns.parseResumeRound('fix-round-9', 8)).toBe(0)
    expect(fns.parseResumeRound('fix-round-0', 8)).toBe(0)
    expect(fns.parseResumeRound('argus-request-changes', 8)).toBe(0)
    expect(fns.parseResumeRound(null, 8)).toBe(0)
    expect(fns.parseResumeRound('fix-round-x', 8)).toBe(0)
  })
})

/**
 * A GIT FACT IS READ BY CODE, NEVER RELAYED BY A MODEL (Part 2a).
 *
 * The live head used to come from a haiku PROBE AGENT in this file
 * (`head-probe-round-resume`). When the launcher reads it instead — at the
 * credentialed host boundary, with `git ls-remote`/`rev-parse` — the seat must not be
 * dispatched at all, for ANY of the three answers it can carry.
 */
describe('mid-loop resume — the launcher-read head replaces the probe agent', () => {
  const probed = (labels: string[]): boolean =>
    labels.some((l) => l.startsWith('head-probe-round-resume'))

  test('a launcher-read head that MATCHES takes the fast path with no probe agent', async () => {
    const out = await runResume({
      checkpoint: 'forge-done',
      recordedHead: RECORDED,
      resumeLiveHead: RECORDED,
    })
    expect(probed(out.labels)).toBe(false)
    expect(built(out.labels)).toBe(false)
    expect(out.labels).toContain('resume-diff')
    expect(out.result.reviewedHead).toBe(RECORDED)
  })

  test('a launcher-read head that MOVED rebuilds, still with no probe agent', async () => {
    const out = await runResume({
      checkpoint: 'forge-done',
      recordedHead: RECORDED,
      resumeLiveHead: MOVED,
    })
    expect(probed(out.labels)).toBe(false)
    expect(built(out.labels)).toBe(true)
    expect(out.labels).not.toContain('resume-diff')
  })

  test("'absent' — the authority says the branch is gone — is a REAL read, and rebuilds", async () => {
    const out = await runResume({
      checkpoint: 'forge-done',
      recordedHead: RECORDED,
      resumeLiveHead: 'absent',
    })
    expect(probed(out.labels)).toBe(false)
    expect(built(out.labels)).toBe(true)
  })

  test('a launcher that predates the arg still probes — the fallback is pinned', async () => {
    const out = await runResume({ checkpoint: 'forge-done', recordedHead: RECORDED })
    expect(out.labels).toContain('head-probe-round-resume')
  })

  /**
   * …AND THE FALLBACK SPEAKS THE SAME TRI-STATE. It did not: `readBranchHead` ran a bare
   * `git rev-parse <branch>` (local), which PRINTS THE BRANCH NAME and exits 128 for a
   * missing branch, and a plain `ls-remote` (pr), which prints nothing. Both reached
   * `classifyResume` as `''` = "could not read" — and since Part 2b gives `''` a bounded
   * STOP, a genuinely DELETED branch became a permanent stop no re-run could ever clear,
   * on exactly the launchers that have no `resume_live_head` to rescue them.
   */
  test('a LEGACY probe that says the branch is gone REBUILDS — it does not stop', async () => {
    const out = await runResume({ checkpoint: 'forge-done', recordedHead: RECORDED, currentHead: 'absent' })
    expect(out.labels).toContain('head-probe-round-resume')
    expect(built(out.labels)).toBe(true)
    // It ran to a real verdict rather than the bounded infra stop `''` earns.
    expect(out.result.blockKind).not.toBe('infra-only')
    expect(out.result.terminalCause).toBeUndefined()
  })

  test('the probe command can tell "no such branch" from a failed read', () => {
    // The two halves of the tri-state, asserted on the command the seat is handed: git is
    // asked to VERIFY (so a missing ref is an error, not an echoed argument) and the
    // repository's own health is what distinguishes `absent` from silence.
    expect(SRC).toContain('git rev-parse --verify --quiet ')
    expect(SRC).toContain('git ls-remote --exit-code origin ')
    // The bare form that printed the branch name back is gone.
    expect(SRC).not.toMatch(/git rev-parse \$\{shSingleQuote\(forgeBranch\)\}/)
  })
})

/**
 * AN UNREADABLE HEAD IS A BOUNDED STOP, NEVER A REBUILD (Part 2b).
 *
 * The safety decision stays fail-closed: "could not tell" is never
 * "unchanged", so no fast path opens. What changes is the CONSEQUENCE. The recorded
 * work is committed and intact — only the READ failed — so rebuilding redoes it at
 * the most expensive effort available and can fork a divergent commit the publisher
 * then refuses. That is the measured double-failure of the neutron-enterprise #439
 * run (133,169 output tokens for a rebuild caused by one failed probe read).
 *
 * Every test here asserts the ABSENCES that make it a stop: no plan, no build, no
 * review — and that the terminal result names the branch and the recorded OID so the
 * run is re-runnable the moment the read succeeds.
 */
describe('mid-loop resume — an unreadable head is a bounded STOP, never a rebuild', () => {
  const planned = (labels: string[]): boolean => labels.includes('plan:fable')
  const judged = (labels: string[]): boolean => labels.some((l) => l.startsWith('argus:'))

  test('a launcher-read head of "" STOPS: no probe, no build, no review, and it names the work', async () => {
    const out = await runResume({
      checkpoint: 'forge-done',
      recordedHead: RECORDED,
      resumeLiveHead: '',
    })

    // The launcher already read (and retried) — the probe seat is not dispatched.
    expect(out.labels).not.toContain('head-probe-round-resume')
    // THE STOP, asserted as absences: nothing was re-planned, rebuilt or re-judged.
    expect(built(out.labels)).toBe(false)
    expect(planned(out.labels)).toBe(false)
    expect(judged(out.labels)).toBe(false)
    expect(out.labels).not.toContain('resume-diff')

    expect(out.result.ok).toBe(false)
    expect(out.result.verdict).toBeNull()
    // The RECORDED checkpoint is passed through untouched, so the failed row still says
    // WHAT was built and WHERE. It is evidence, not a resume input: a re-run is a fresh
    // dispatch with null checkpoints and rebuilds (corrected at Argus r4).
    expect(out.result.checkpoint).toBe('forge-done')
    expect(out.result.blockKind).toBe('infra-only')
    // The cause names the two facts a human (or a re-run) needs, verbatim.
    expect(out.result.terminalCause).toContain('trident/resume-run')
    expect(out.result.terminalCause).toContain(RECORDED)
    expect(out.result.terminalCause).toContain('could not read')
    // Not the Ralph re-fire path: there is no task to hand back.
    expect(out.result.remainingTasks).toBe(0)
    // The finally block still ran — a bounded stop is still a tidy exit.
    expect(out.labels).toContain('cleanup:worktree')
  })

  test('a LEGACY probe that reports "" stops too — one probe, then no build and no review', async () => {
    const out = await runResume({ checkpoint: 'forge-done', recordedHead: RECORDED, currentHead: '' })

    // Old launcher → the fallback probe seat is still dispatched, exactly once.
    expect(out.labels.filter((l) => l === 'head-probe-round-resume')).toHaveLength(1)
    expect(built(out.labels)).toBe(false)
    expect(planned(out.labels)).toBe(false)
    expect(judged(out.labels)).toBe(false)
    expect(out.labels).not.toContain('resume-diff')

    expect(out.result.ok).toBe(false)
    expect(out.result.verdict).toBeNull()
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.terminalCause).toContain('trident/resume-run')
    expect(out.result.terminalCause).toContain(RECORDED)
    expect(out.result.remainingTasks).toBe(0)
  })

  test('an outer-published resume with an unreadable head does not re-enter review or re-fire', async () => {
    const checkpoint = `outer-published:${RECORDED}:2:3`
    const out = await runResume({ checkpoint, recordedHead: RECORDED, resumeLiveHead: '' })

    expect(judged(out.labels)).toBe(false)
    expect(out.labels.some((l) => l.startsWith('forge:'))).toBe(false)
    // remainingTasks 0 keeps the outer loop off the Ralph re-fire path…
    expect(out.result.remainingTasks).toBe(0)
    // …and the published checkpoint survives verbatim, so the re-run reviews the
    // very OID the publisher recorded.
    expect(out.result.checkpoint).toBe(checkpoint)
  })
})

/**
 * THE FULL-SUITE GATE ACROSS A PROCESS BOUNDARY (Argus round 2, confirmed by two
 * reviewers).
 *
 * In PR mode — the default — the build round ENDS at the durable publisher handoff, so
 * the build's `testsPassed` claim and the review panel that must not APPROVE it live in
 * DIFFERENT PROCESSES. The gate was therefore structurally unreachable there: the
 * resumed process has no build report at all. The same hole swallowed the local-mode
 * crash resume (a process that died between `forge-done` and the panel).
 *
 * The claim now travels on the checkpoint's findings column, which the publisher's
 * re-fire leaves untouched, and arrives here as `resumeFindings`. These tests drive the
 * REAL body through that resume and assert the VERDICT, because "the finding is
 * mentioned somewhere" is exactly what the first version could also have claimed.
 */
describe('mid-loop resume — a RECORDED unproven suite still cannot be approved', () => {
  const STRATEGY = 'TEST EXECUTION\n\nfull suite rules'
  const SUITE_FINDINGS = [
    {
      severity: 'blocker',
      title: 'FULL SUITE NOT PROVEN — the build did not report testsPassed=true',
      evidence: 'The build reported testsPassed=false.',
    },
  ]

  test('the panel runs, APPROVES, and is OVERRIDDEN — no verdict on an unproven suite', async () => {
    const out = await runResume({
      checkpoint: 'forge-done',
      recordedHead: RECORDED,
      resumeLiveHead: RECORDED,
      findings: SUITE_FINDINGS,
      testStrategy: STRATEGY,
      // Round 1's panel approves; only the recorded blocker can stop it.
      verdicts: ['APPROVE', 'APPROVE'],
    })

    expect(built(out.labels)).toBe(false)
    // The panel is NOT skipped — its findings are what the fix round needs.
    expect(reviewed(out.labels)).toBe(true)
    // …and its APPROVE bought exactly one more round rather than a merge.
    expect(out.labels).toContain('forge:fix-round-2')
    expect(promptFor(out, 'forge:fix-round-2')).toContain('FULL SUITE NOT PROVEN')
    // The fix round reports testsPassed: true, so the next panel's APPROVE stands.
    expect(out.result.verdict).toBe('APPROVE')
    expect(out.result.round).toBe(2)
  })

  test('the SAME resume with no recorded blocker approves immediately — no extra round', async () => {
    const out = await runResume({
      checkpoint: 'forge-done',
      recordedHead: RECORDED,
      resumeLiveHead: RECORDED,
      testStrategy: STRATEGY,
      verdicts: ['APPROVE'],
    })
    expect(out.labels.some((l) => l.startsWith('forge:fix-round-'))).toBe(false)
    expect(out.result.verdict).toBe('APPROVE')
  })

  test('a launcher with NO strategy reads the same row as before — byte-identical', async () => {
    // The arming condition is repeated at the read site so a row written by a workflow
    // that never had a strategy cannot be re-read as a gate record.
    const out = await runResume({
      checkpoint: 'forge-done',
      recordedHead: RECORDED,
      resumeLiveHead: RECORDED,
      findings: SUITE_FINDINGS,
      verdicts: ['APPROVE'],
    })
    expect(out.labels.some((l) => l.startsWith('forge:fix-round-'))).toBe(false)
    expect(out.result.verdict).toBe('APPROVE')
  })
})
