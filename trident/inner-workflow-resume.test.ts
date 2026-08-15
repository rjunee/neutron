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
    if (label.startsWith('head-probe-round-')) {
      // A fix round's did-it-land probe: report the sha that round committed.
      return { head: FIX_SHA(round) }
    }
    if (label === 'resume-diff') return { bytes: opts.diffBytes ?? 4096 }
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
    // cross-model seats) — the resume decision is git-mode independent.
    mergeMode: 'local',
    prNumber: null,
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

  test('an UNREADABLE live head → rebuild (a failed probe is not "unchanged")', async () => {
    const out = await runResume({ checkpoint: 'forge-done', recordedHead: RECORDED, currentHead: '' })
    expect(out.labels).toContain('head-probe-round-resume')
    expect(built(out.labels)).toBe(true)
    expect(out.labels).not.toContain('resume-diff')
  })

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
    expect(at('forge-done', RECORDED, '')).toEqual({ mode: 'rebuild', reason: 'head-unreadable' })
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
})
