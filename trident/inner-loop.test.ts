/**
 * Tests for the Trident v2 inner-loop LAUNCHER (Work Board Phase 2a exec-model):
 * the FIRER (`buildWorkflowFirer`) + the production warm-substrate FIRE seam
 * (`buildSubstrateWorkflowFire`) + the typed-result decoder (`parseInnerResult`).
 *
 * The firer invokes the `Workflow` tool on `inner-workflow.mjs` on a WARM
 * substrate and SETTLES the launching turn immediately — the workflow then runs
 * DETACHED and writes its own typed result to the DB (harvested by the OUTER
 * loop). These tests inject a FAKE `FireInnerWorkflow` (for firer mechanics) and
 * a FAKE `Substrate` (for the production fire seam), so everything is exercised
 * WITHOUT a live claude / Workflow tool.
 *
 * THE DISCIPLINE THIS SUITE PINS: a fire is `fired` ONLY when the launching turn
 * settles cleanly (a `completion` event). A settle-timeout / `error` event /
 * stream-closed-without-completion is `failed` — paused ≠ finished, never a
 * silent success.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildWorkflowFirer,
  buildWorkflowArgs,
  buildSubstrateWorkflowFire,
  CODEX_BUILD_SCRIPT_PATH,
  CODEX_REVIEW_SCRIPT_PATH,
  STAGE_STAMP_SCRIPT_PATH,
  parseCheckpointFindings,
  parseInnerResult,
  GH_AUTHED_SCRIPT_PATH,
  TERMINAL_CAUSE_MAX,
  WORKFLOW_FIRE_TOOL_NAMES,
  type FireInnerWorkflow,
  type FireInnerWorkflowInput,
  type FireOutcome,
  type InnerLoopInput,
} from './inner-loop.ts'
import { buildReflectionGuidance } from './reflection-guidance.ts'
import type { BriefParts } from './brief-parts.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { TridentRun } from './store.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

function makeRun(over: Partial<TridentRun> = {}): TridentRun {
  return makeTridentRun({
    id: 'run-1',
    slug: 'add-widget',
    project_slug: 'proj',
    max_rounds: 3,
    branch: 'trident/add-widget',
    merge_mode: 'pr',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/repo',
    task: 'Add a widget',
    started_at: '1970-01-01T00:00:00.000Z',
    last_advanced_at: '1970-01-01T00:00:00.000Z',
    ...over,
  })
}

function input(over: Partial<InnerLoopInput> = {}): InnerLoopInput {
  return {
    run: makeRun(),
    base_branch: 'main',
    db_path: '/tmp/project.db',
    max_rounds: 3,
    resume_checkpoint: null,
    ...over,
  }
}

/** A fake `FireInnerWorkflow` recording its input + returning a scripted outcome. */
function fakeFire(
  outcome: (i: FireInnerWorkflowInput) => FireOutcome,
): { fire: FireInnerWorkflow; calls: FireInnerWorkflowInput[] } {
  const calls: FireInnerWorkflowInput[] = []
  const fire: FireInnerWorkflow = async (i) => {
    calls.push(i)
    return outcome(i)
  }
  return { fire, calls }
}

describe('parseCheckpointFindings — a resumed fix round fixes RECORDED findings, or none', () => {
  test('decodes a recorded array verbatim', () => {
    const findings = [{ severity: 'blocker', title: 'boom', evidence: 'a.ts:1' }]
    expect(parseCheckpointFindings(JSON.stringify(findings))).toEqual(findings)
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['unparseable', '{not json'],
    ['an object, not an array', '{"severity":"blocker"}'],
    ['a bare string', '"boom"'],
  ])('%s → [] (the workflow then RE-REVIEWS instead of fixing blind)', (_label, raw) => {
    expect(parseCheckpointFindings(raw as string | null | undefined)).toEqual([])
  })
})

describe('parseInnerResult — decode the typed terminal column', () => {
  test('parses a full result object', () => {
    const raw = JSON.stringify({
      ok: true,
      prNumber: 7,
      branch: 'feat-x',
      verdict: 'APPROVE',
      round: 2,
      checkpoint: 'argus-approved',
      remainingTasks: 0,
    })
    expect(parseInnerResult(raw)).toEqual({
      ok: true,
      verdict: 'APPROVE',
      mutation_claim: null,
      pr_number: 7,
      branch: 'feat-x',
      round: 2,
      checkpoint: 'argus-approved',
      remaining_tasks: 0,
      pr_merged: false,
      deviated_from_spec: false,
      publish_requested: false,
      publish_head: null,
      block_kind: null,
      terminal_cause: null,
      findings_present: false,
      // The findings ARRAY now travels beside the boolean. `findings_present` answers
      // "did a reviewer speak"; `findings` answers "what did they say", which is what
      // the store requires as evidence before it will record a REQUEST_CHANGES. Absent
      // in this payload, so it decodes to the same fail-closed empty the boolean does.
      findings: [],
    })
  })
  // T4 (run f384460d) — DID A REVIEWER SAY ANYTHING AT ALL? This is the field that tells an
  // infrastructure death (the wrapper's catch path: `checkpoint:'inner-error'`, `findings: []`)
  // apart from a terminal result carrying real review findings. Decoded FAIL-CLOSED, because a
  // false positive re-creates the defect: a crash delivered to the owner as REQUEST_CHANGES.
  test('decodes findings_present — only a NON-EMPTY array counts', () => {
    const presence = (raw: Record<string, unknown>) =>
      parseInnerResult(JSON.stringify({ verdict: 'REQUEST_CHANGES', ...raw }))?.findings_present
    // The measured f384460d shape: the catch path does not write the field at all.
    expect(presence({})).toBe(false)
    // The reviewed-nothing shape: written, and empty.
    expect(presence({ findings: [] })).toBe(false)
    // A real review finding behind the stop → NOT an infra death.
    expect(presence({ findings: [{ severity: 'blocker', title: 'it is broken' }] })).toBe(true)
    // Garbled/foreign shapes decode false rather than reading truthy.
    for (const bogus of ['garbled', 1, true, {}, null]) expect(presence({ findings: bogus })).toBe(false)
  })
  // A MERGE IS TERMINAL (#563). The flag the OUTER loop reads to finish a run
  // WITHOUT running a second `gh pr merge`, so only the exact boolean counts: every
  // truthy stand-in below is a field that did not arrive in the shape the workflow
  // writes, and reading one as a merge would strand an unmerged PR as "done".
  test('decodes prMerged; absent or any non-boolean → false', () => {
    expect(
      parseInnerResult(JSON.stringify({ verdict: 'APPROVE', checkpoint: 'pr-merged', prMerged: true }))
        ?.pr_merged,
    ).toBe(true)
    expect(parseInnerResult(JSON.stringify({ verdict: 'APPROVE' }))?.pr_merged).toBe(false)
    for (const bogus of ['true', 1, 'yes', {}, [], null]) {
      expect(
        parseInnerResult(JSON.stringify({ verdict: 'APPROVE', prMerged: bogus }))?.pr_merged,
      ).toBe(false)
    }
    expect(parseInnerResult(JSON.stringify({ verdict: 'APPROVE', prMerged: false }))?.pr_merged).toBe(
      false,
    )
  })
  // A NON-POSITIVE prNumber IS THE WRAPPER'S "NO PR" SENTINEL, NOT A PR (run f384460d,
  // 2026-08-15). The codex build wrapper reports `PR_NUMBER=0` in pr mode BY DESIGN —
  // the outer loop publishes after the build exits — and GitHub's numbers start at 1, so
  // 0 can never be an answer. Decoding it as one is what ended a run whose row held
  // pr=267 at pr=0: `result.pr_number ?? run.pr` keeps the 0, because 0 is not nullish.
  // Mapping it to null here restores the known PR at every `?? run.pr` site at once.
  test('a non-positive or non-integer prNumber decodes to null (the "no PR" sentinel)', () => {
    const prOf = (prNumber: unknown) =>
      parseInnerResult(JSON.stringify({ verdict: 'REQUEST_CHANGES', prNumber }))?.pr_number
    expect(prOf(0)).toBeNull()
    expect(prOf(-1)).toBeNull()
    expect(prOf(3.5)).toBeNull()
    // A real PR number still decodes untouched.
    expect(prOf(7)).toBe(7)
  })
  // The deviation flag decides whether the NEXT Ralph iteration pays for the full
  // whole-repo survey (~287 s) or takes the cheap `plan:next` continuation. It is
  // fail-closed in the direction that costs money, not correctness: a truthy
  // stand-in read as `true` would re-plan from scratch every iteration forever,
  // silently undoing the saving this card exists for.
  test('decodes deviatedFromSpec; absent or any non-boolean → false', () => {
    expect(
      parseInnerResult(JSON.stringify({ verdict: 'REQUEST_CHANGES', deviatedFromSpec: true }))
        ?.deviated_from_spec,
    ).toBe(true)
    expect(parseInnerResult(JSON.stringify({ verdict: 'APPROVE' }))?.deviated_from_spec).toBe(false)
    for (const bogus of ['true', 1, 'yes', {}, [], null]) {
      expect(
        parseInnerResult(JSON.stringify({ verdict: 'APPROVE', deviatedFromSpec: bogus }))
          ?.deviated_from_spec,
      ).toBe(false)
    }
    expect(
      parseInnerResult(JSON.stringify({ verdict: 'APPROVE', deviatedFromSpec: false }))
        ?.deviated_from_spec,
    ).toBe(false)
  })
  test('decodes remainingTasks (the #362 Ralph re-fire signal); absent → null', () => {
    const withRemaining = parseInnerResult(
      JSON.stringify({ verdict: 'REQUEST_CHANGES', checkpoint: 'ralph-task-built', remainingTasks: 3 }),
    )
    expect(withRemaining?.remaining_tasks).toBe(3)
    // Absent field (legacy/non-Ralph rows) → null (no re-fire).
    const withoutRemaining = parseInnerResult(JSON.stringify({ verdict: 'APPROVE' }))
    expect(withoutRemaining?.remaining_tasks).toBeNull()
  })
  // WHY IT STOPPED, AND WHY (#240 / run 8417b277). The workflow has always written
  // `blockKind`, and this decoder has always dropped it — so the orchestrator wrote the
  // generic round sentence for a build that never reached a review seat. `terminalCause`
  // is the measured half: the probe's own words, already redacted upstream.
  test("decodes blockKind + terminalCause — the infra-only stop's own explanation", () => {
    const out = parseInnerResult(
      JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        round: 1,
        checkpoint: 'argus-request-changes',
        blockKind: 'infra-only',
        terminalCause: 'REVIEW DEFERRED — PR readiness could not be read: gh auth login',
      }),
    )
    expect(out?.block_kind).toBe('infra-only')
    expect(out?.terminal_cause).toContain('gh auth login')
    for (const kind of ['none', 'code', 'round-lost'] as const) {
      expect(parseInnerResult(JSON.stringify({ verdict: 'APPROVE', blockKind: kind }))?.block_kind).toBe(kind)
    }
  })
  test('FAIL-CLOSED: an unrecognised blockKind or an empty cause decodes to null', () => {
    // The orchestrator keys a SPECIFIC failure message off `infra-only` + a non-null
    // cause, so anything it does not recognise must fall back to the generic sentence
    // rather than be coerced toward the specific one.
    for (const bogus of ['weird', 'INFRA-ONLY', '', 42, true, null, {}]) {
      expect(parseInnerResult(JSON.stringify({ verdict: 'APPROVE', blockKind: bogus }))?.block_kind).toBeNull()
    }
    expect(parseInnerResult(JSON.stringify({ verdict: 'APPROVE' }))?.block_kind).toBeNull()
    for (const bogus of ['', '   ', 42, true, null, {}, []]) {
      expect(
        parseInnerResult(JSON.stringify({ verdict: 'APPROVE', terminalCause: bogus }))?.terminal_cause,
      ).toBeNull()
    }
    expect(parseInnerResult(JSON.stringify({ verdict: 'APPROVE' }))?.terminal_cause).toBeNull()
  })
  /**
   * THE TWO CAPS MUST AGREE, AND NOTHING WAS CHECKING THAT (Argus r4). `TERMINAL_CAUSE_MAX`
   * is declared HERE and hand-mirrored in `inner-workflow.mjs` (a Workflow script cannot
   * import TS), and the SMALLER of the two is what actually decides — so a drift is silent
   * and one-directional. It has already cost the round-1 unreadable-head cause its only
   * actionable clause at the previous 300/300 pair. The mirror is scraped from the .mjs
   * rather than restated, the same way `inner-workflow-built-head.test.ts` reads
   * `BUILT_HEAD_READ_ATTEMPTS`.
   */
  test('the .mjs mirror of TERMINAL_CAUSE_MAX is the same number', () => {
    const src = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')
    const mirrored = /const TERMINAL_CAUSE_MAX = (\d+)/.exec(src)?.[1]
    expect(mirrored).toBeDefined()
    expect(Number(mirrored)).toBe(TERMINAL_CAUSE_MAX)
  })
  test('a cause is clamped — it is persisted and then read in a chat row', () => {
    const out = parseInnerResult(JSON.stringify({ verdict: 'APPROVE', terminalCause: `  ${'y'.repeat(900)}  ` }))
    expect(out?.terminal_cause?.length).toBe(TERMINAL_CAUSE_MAX)
  })
  /**
   * THE CLAMP MUST NOT CUT A REAL CAUSE OFF AT THE KNEES. At 300 the workflow's round-1
   * unreadable-head sentence — 331 chars with the longest branch name `slugify-task` can
   * produce — lost its trailing "re-run when the read succeeds", i.e. the clamp deleted
   * the only actionable clause in it. This is the composed sentence, at full length.
   */
  test('the longest realistic composed cause survives the clamp whole', () => {
    const branch = `trident/${'x'.repeat(35)}` // slugify-task caps the slug at 35
    const cause =
      `could not read the head of refs/heads/${branch} after forge:build (3 attempts) — re-run when the read succeeds; ` +
      `this run rebuilt, published and reviewed nothing; the build reported '${'a'.repeat(40)}' and wrote a diff to /tmp/${branch.replace('/', '-')}.diff`
    const out = parseInnerResult(JSON.stringify({ verdict: 'REQUEST_CHANGES', terminalCause: cause }))
    expect(out?.terminal_cause).toBe(cause)
    expect(out?.terminal_cause).toContain('re-run when the read succeeds')
  })
  // A COMMIT OID IS READ, NOT REPORTED (defect 2026-08-14). `publishHead` is the build's
  // CLAIM, kept only so the outer publisher can CHECK it against `rev-parse`. Requiring a
  // full 40-hex string here silently dropped an abbreviated sha, which then read downstream
  // as "the build produced no commit" — and discarded a finished build.
  test('decodes publishHead as a CLAIM: any 7-40 hex string survives verbatim; anything else → null', () => {
    const full = 'abcdef0123456789abcdef0123456789abcdef01'
    expect(parseInnerResult(JSON.stringify({ verdict: 'REQUEST_CHANGES', publishHead: full }))?.publish_head).toBe(full)
    expect(
      parseInnerResult(JSON.stringify({ verdict: 'REQUEST_CHANGES', publishHead: 'abc1234' }))?.publish_head,
    ).toBe('abc1234')
    // Below the 7-char floor is not a plausible OID — no claim at all (still publishable).
    expect(
      parseInnerResult(JSON.stringify({ verdict: 'REQUEST_CHANGES', publishHead: 'abc123' }))?.publish_head,
    ).toBeNull()
    expect(
      parseInnerResult(JSON.stringify({ verdict: 'REQUEST_CHANGES', publishHead: 'not-a-sha' }))?.publish_head,
    ).toBeNull()
    expect(parseInnerResult(JSON.stringify({ verdict: 'REQUEST_CHANGES' }))?.publish_head).toBeNull()
  })
  test('null/empty/garbage → null (still in flight)', () => {
    expect(parseInnerResult(null)).toBeNull()
    expect(parseInnerResult(undefined)).toBeNull()
    expect(parseInnerResult('')).toBeNull()
    expect(parseInnerResult('   ')).toBeNull()
    expect(parseInnerResult('{bad json')).toBeNull()
    expect(parseInnerResult('"a string"')).toBeNull()
  })
  test('normalizes an unknown verdict to null + missing fields to defaults', () => {
    expect(parseInnerResult(JSON.stringify({ verdict: 'COMMENT' }))).toEqual({
      ok: false,
      verdict: null,
      mutation_claim: null,
      pr_number: null,
      branch: null,
      round: 0,
      checkpoint: null,
      remaining_tasks: null,
      pr_merged: false,
      deviated_from_spec: false,
      publish_requested: false,
      publish_head: null,
      block_kind: null,
      terminal_cause: null,
      findings_present: false,
      // The findings ARRAY now travels beside the boolean. `findings_present` answers
      // "did a reviewer speak"; `findings` answers "what did they say", which is what
      // the store requires as evidence before it will record a REQUEST_CHANGES. Absent
      // in this payload, so it decodes to the same fail-closed empty the boolean does.
      findings: [],
    })
  })
})

describe('buildWorkflowFirer — fire mechanics over a fire seam', () => {
  test('workflow args omit absent brief parts and carry a supplied manifest verbatim', () => {
    const without = buildWorkflowArgs(input())
    expect('briefParts' in without).toBe(false)
    const parts: BriefParts = {
      taskFile: '/tmp/task.part',
      taskIntegrity: '4:12345678',
      reflectionFile: '/tmp/reflection.part',
      reflectionIntegrity: '5:87654321',
    }
    expect(buildWorkflowArgs(input(), parts).briefParts).toBe(parts)
  })

  /**
   * The durable re-fire counter. The workflow gates its cheap `plan:next`
   * continuation planner (and the every-Kth full re-plan) on it, so a launcher that
   * dropped it would silently pay the full whole-repo survey on every Ralph task —
   * exactly the waste that planner exists to remove, and invisible from either side.
   */
  test('the Ralph round counter is threaded from the run row', () => {
    expect(buildWorkflowArgs(input()).ralphRound).toBe(0)
    expect(buildWorkflowArgs(input({ run: makeRun({ ralph: true, ralph_round: 4 }) })).ralphRound).toBe(4)
  })

  /**
   * ONLY A REAL WAVE CHILD TAKES THE WAVE-CHILD PATH.
   *
   * The first cut discriminated on `parent_run_id !== null && wave_task_id !== null`, which
   * is TRUE for a run that simply OMITS the fields — `undefined !== null`. A row read from
   * the store always carries both (0137 added the columns), so production never saw it;
   * every in-process caller building a partial run did, and 62 tests across 11 files died on
   * `wave child … has no run branch`. The rule is positive evidence, not absence of null:
   * two non-empty strings, or it is an ordinary run.
   */
  test('a run missing the wave columns is an ORDINARY run, not a malformed wave child', () => {
    const bare = { ...makeRun({ branch: 'feat/x' }) } as Record<string, unknown>
    delete bare['parent_run_id']
    delete bare['wave_task_id']
    const args = buildWorkflowArgs(input({ run: bare as unknown as TridentRun }))
    expect('pinnedTaskId' in args).toBe(false)
    expect(args.branch).toBe('feat/x')

    // POSITIVE CONTROL — the same call WITH both fields present must still produce the
    // member args, so this cannot pass by the wave path being dead altogether.
    const child = buildWorkflowArgs(
      input({ run: makeRun({ branch: 'feat/x--wT3', parent_run_id: 'parent-1', wave_task_id: 'T3' }) }),
    )
    expect(child.pinnedTaskId).toBe('T3')
    expect(child.branch).toBe('feat/x')
  })

  test('a valid launch base sha is threaded and invalid values are omitted', () => {
    const sha = 'a'.repeat(40)
    expect(buildWorkflowArgs(input({ base_sha: sha })).baseSha).toBe(sha)
    expect('baseSha' in buildWorkflowArgs(input())).toBe(false)
    expect('baseSha' in buildWorkflowArgs(input({ base_sha: 'abc' }))).toBe(false)
    expect('baseSha' in buildWorkflowArgs(input({ base_sha: 'A'.repeat(40) }))).toBe(false)
  })

  /**
   * The live head the launcher READ from git (never a model's report of it). The key's
   * PRESENCE is the signal that a code-read answer exists, so it must be absent — not
   * null — when the launcher did not read one, or the workflow could not tell an old
   * launcher apart from an unreadable head.
   */
  test('the launcher-read resume head is threaded verbatim, and omitted when there is none', () => {
    const HEAD = 'a'.repeat(40)
    expect(buildWorkflowArgs(input({ resume_live_head: HEAD })).resumeLiveHead).toBe(HEAD)
    expect('resumeLiveHead' in buildWorkflowArgs(input())).toBe(false)
    // '' ("could not read") and 'absent' ("the authority says it is gone") are DIFFERENT
    // facts with different consequences — neither may be normalised into the other.
    expect(buildWorkflowArgs(input({ resume_live_head: '' })).resumeLiveHead).toBe('')
    expect(buildWorkflowArgs(input({ resume_live_head: 'absent' })).resumeLiveHead).toBe('absent')
  })

  test('writes launcher-held strings and threads the returned manifest into the prompt', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const parts: BriefParts = {
      taskFile: '/tmp/exact-task.part',
      taskIntegrity: '8:12345678',
      reflectionFile: '/tmp/exact-reflection.part',
      reflectionIntegrity: '9:87654321',
    }
    const writes: Parameters<
      NonNullable<Parameters<typeof buildWorkflowFirer>[0]['write_brief_parts']>
    >[0][] = []
    const write_brief_parts = (opts: (typeof writes)[number]) => {
      writes.push(opts)
      return parts
    }
    const reflection_context = '<learned_corrections>use TS — preserve … and 🚀</learned_corrections>'
    const run = makeRun({ id: 'run-parts', task: 'exact task' })
    const firer = buildWorkflowFirer({ fire, write_brief_parts })
    expect(await firer(input({ run, reflection_context }))).toEqual({ status: 'fired', error: null })
    expect(writes).toEqual([
      {
        runId: run.id,
        task: run.task,
        reflectionGuidance: buildReflectionGuidance(reflection_context),
      },
    ])
    expect(calls[0]!.prompt).toContain(`"briefParts":${JSON.stringify(parts)}`)
    const args = JSON.parse(calls[0]!.prompt.match(/^   args = (.+)$/m)?.[1] ?? '{}')
    expect(args.reflectionGuidance).toBe(writes[0]!.reflectionGuidance)
  })

  test('a failed part write never prevents the fire and omits the manifest', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire, write_brief_parts: () => null })
    expect(await firer(input())).toEqual({ status: 'fired', error: null })
    expect(calls[0]!.prompt).not.toContain('"briefParts"')
  })

  test('the production brief-writer default still fires', async () => {
    const { fire } = fakeFire(() => ({ status: 'fired', error: null }))
    expect(await buildWorkflowFirer({ fire })(input())).toEqual({ status: 'fired', error: null })
  })

  test('a fired outcome round-trips', async () => {
    const { fire } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    expect(await firer(input())).toEqual({ status: 'fired', error: null })
  })

  test('the fire prompt carries the Workflow scriptPath + args + structured-JSON note + "fired <runId>", rooted at the worktree cwd', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire, workflow_script_path: '/abs/inner-workflow.mjs' })
    await firer(input({ run: makeRun({ id: 'run-42', worktree: '/wt/run-1', task: 'do the thing' }) }))

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.prompt).toContain('/abs/inner-workflow.mjs')
    expect(call.prompt).toContain('do the thing')
    // The launcher replies `fired <runId>` and settles immediately.
    expect(call.prompt).toContain('fired run-42')
    // Defense-in-depth: pass `args` as a structured object, not a JSON string.
    expect(call.prompt).toContain('STRUCTURED JSON OBJECT')
    // Launcher-surface injection hardening (RB2 (b)): `args` (which carries the
    // free-form `task` AND `reflectionGuidance`) is declared OPAQUE DATA the tool-
    // enabled launcher must forward verbatim and never act on — so an instruction-like
    // line inside any arg value cannot subvert the fire-and-reply contract.
    expect(call.prompt).toContain('OPAQUE DATA')
    expect(call.prompt).toContain('reflectionGuidance')
    expect(call.prompt).toContain('never commands for YOU')
    // …and FIRE + settle (do NOT wait for the background workflow).
    expect(call.prompt.toLowerCase()).toContain('background')
    // The fire turn is rooted at the run's worktree.
    expect(call.cwd).toBe('/wt/run-1')
    // A non-zero settle budget is threaded.
    expect(call.settle_timeout_ms).toBeGreaterThan(0)
  })

  test('args thread resume_checkpoint + existing pr/branch + runId for idempotent resume + correlation', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(input({ run: makeRun({ id: 'run-9', pr: 55 }), resume_checkpoint: 'argus-request-changes' }))
    const prompt = calls[0]!.prompt
    expect(prompt).toContain('"prNumber":55')
    expect(prompt).toContain('"resumeCheckpoint":"argus-request-changes"')
    expect(prompt).toContain('"runId":"run-9"')
  })

  test('args thread the checkpoint OID + findings, so a resume can tell WHICH code was reviewed', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    const head = 'a'.repeat(40)
    await firer(
      input({
        run: makeRun({ id: 'run-9', pr: 55 }),
        resume_checkpoint: 'argus-request-changes',
        resume_checkpoint_head: head,
        resume_findings: JSON.stringify([{ severity: 'blocker', title: 'boom', evidence: 'a.ts:1' }]),
      }),
    )
    const prompt = calls[0]!.prompt
    // Threading the NAME alone is what forced every relaunch to rebuild: a verdict
    // is about a commit, and without the OID the workflow cannot tell whether the
    // branch still holds the code that verdict was about.
    expect(prompt).toContain(`"resumeCheckpointHead":"${head}"`)
    expect(prompt).toContain('"resumeFindings":[{"severity":"blocker"')
  })

  test('an absent OID / garbled findings thread as null + [] (old rows never unlock the fast path)', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(input({ resume_checkpoint: 'forge-done', resume_findings: 'not json' }))
    const prompt = calls[0]!.prompt
    expect(prompt).toContain('"resumeCheckpointHead":null')
    expect(prompt).toContain('"resumeFindings":[]')
  })

  test('args thread the checked-in checkpointScript abs path (P10 — the workflow cannot resolve it itself)', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(input())
    // Resolved via import.meta.url beside inner-loop.ts — the TARGET repo need
    // not contain trident/, so the path must be threaded, never derived there.
    const m = calls[0]!.prompt.match(/"checkpointScript":"([^"]*\/trident\/checkpoint\.sh)"/)
    expect(m).not.toBeNull()
    const threaded = m![1]!
    // Must be a DECODED filesystem path, not a URL `.pathname` (which leaves
    // spaces as `%20` etc.) — else `bash <path>` fails on any checkout dir
    // containing a space. fileURLToPath decodes; new URL(...).pathname does not.
    expect(threaded).not.toContain('%')
    expect(threaded.startsWith('/')).toBe(true)
  })

  test('buildWorkflowArgs carries the harness stage-stamp writer path', () => {
    const threaded = buildWorkflowArgs(input()).stageStampScript
    expect(threaded).toBe(STAGE_STAMP_SCRIPT_PATH)
    expect(String(threaded)).toEndWith('/trident/stage-stamp.sh')
    expect(existsSync(String(threaded))).toBe(true)
  })

  test('args thread the harness codexBuildScript abs path (the target repo need not contain trident/)', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(input())
    const m = calls[0]!.prompt.match(/"codexBuildScript":"([^"]*\/trident\/codex-build\.sh)"/)
    expect(m).not.toBeNull()
    const threaded = m![1]!
    expect(threaded.startsWith('/')).toBe(true)
    expect(existsSync(threaded)).toBe(true)
    expect(threaded).toBe(CODEX_BUILD_SCRIPT_PATH)
  })

  test('args thread the harness codexReviewScript abs path (the target repo need not contain trident/)', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(input())
    const m = calls[0]!.prompt.match(/"codexReviewScript":"([^"]*\/trident\/codex-review\.sh)"/)
    expect(m).not.toBeNull()
    const threaded = m![1]!
    expect(threaded.startsWith('/')).toBe(true)
    expect(existsSync(threaded)).toBe(true)
    expect(threaded).toBe(CODEX_REVIEW_SCRIPT_PATH)
  })

  test('args thread the checked-in worktreeCleanupScript abs path (#541 — no LLM in the destructive path)', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(input())
    // Same threading contract as checkpointScript: resolved beside inner-loop.ts,
    // decoded (a `%20` would break `bash <path>` on a checkout dir with a space).
    const m = calls[0]!.prompt.match(
      /"worktreeCleanupScript":"([^"]*\/trident\/worktree-cleanup\.sh)"/,
    )
    expect(m).not.toBeNull()
    expect(m![1]!).not.toContain('%')
    expect(m![1]!.startsWith('/')).toBe(true)
  })

  test('args thread codexHome when a per-project CODEX_HOME is configured (cross-model review)', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(input({ codex_home: '/projects/acme/.codex' }))
    expect(calls[0]!.prompt).toContain('"codexHome":"/projects/acme/.codex"')
  })

  test('args thread codexHome=null when no codex credential is configured (Claude-only review)', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(input())
    expect(calls[0]!.prompt).toContain('"codexHome":null')
  })

  // THE INNER LOOP'S GITHUB READS — the credentialed-`gh` runner's path + store
  // COORDINATES ride the args (paths and a handle), and the token never does.
  test('args thread the credentialed-`gh` runner + the store coordinates it resolves the token from', () => {
    const args = buildWorkflowArgs(
      input({ gh_data_dir: '/home/owner/projects/acme', gh_owner_handle: 'acme' }),
    )
    expect(args['ghAuthedScript']).toBe(GH_AUTHED_SCRIPT_PATH)
    expect(String(args['ghAuthedScript']).startsWith('/')).toBe(true)
    expect(String(args['ghAuthedScript']).endsWith('trident/gh-authed.ts')).toBe(true)
    expect(args['ghDataDir']).toBe('/home/owner/projects/acme')
    expect(args['ghOwnerHandle']).toBe('acme')
    // The ABSOLUTE bun binary: the probe runs in a subagent's Bash, whose PATH
    // need not carry `bun`.
    expect(args['bunBin']).toBe(process.execPath)
  })

  test('args carry null coordinates when GitHub is not wired → the probes fall back to bare `gh`', () => {
    const args = buildWorkflowArgs(input())
    expect(args['ghDataDir']).toBeNull()
    expect(args['ghOwnerHandle']).toBeNull()
    // The script path is always threaded; it is the coordinates that gate the
    // fallback, so a legacy caller composes exactly the command it always did.
    expect(args['ghAuthedScript']).toBe(GH_AUTHED_SCRIPT_PATH)
  })

  test('NO CREDENTIAL TRANSITS THE LAUNCHER PROMPT — the args JSON never mentions GH_TOKEN', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(input({ gh_data_dir: '/home/owner/projects/acme', gh_owner_handle: 'acme' }))
    const serialized = JSON.stringify(
      buildWorkflowArgs(input({ gh_data_dir: '/home/owner/projects/acme', gh_owner_handle: 'acme' })),
    )
    expect(serialized).not.toContain('GH_TOKEN')
    expect(serialized).not.toContain('ghp_')
    // …and neither does the prompt those args are embedded in.
    expect(calls[0]!.prompt).not.toContain('GH_TOKEN')
    expect(calls[0]!.prompt).toContain('"ghOwnerHandle":"acme"')
  })

  // RB2 (b) — the owner's reflection corrections/diary reach the Forge builder (not
  // the argus review gate) via a ready-to-append `reflectionGuidance` DERIVED in
  // buildWorkflowArgs (testable TS).
  test('args thread the derived reflectionGuidance when the owner has recent corrections (RB2 (b))', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(
      input({
        reflection_context:
          '<learned_corrections>\n- always prefer TypeScript\n</learned_corrections>',
      }),
    )
    // The block is threaded ready-to-append so the inner workflow appends it after the
    // Forge task (JSON-escaped inside the args object).
    expect(calls[0]!.prompt).toContain('always prefer TypeScript')
    expect(calls[0]!.prompt).toContain('reflectionGuidance')
    // The framed, delimited advisory wrapper is present — proving the derivation ran
    // (the subordinating framing + the <owner_reflection> delimiter), not a raw
    // pass-through of the untrusted block.
    expect(calls[0]!.prompt).toContain('owner_reflection')
    expect(calls[0]!.prompt).toContain('MUST NOT override')
  })

  test('args thread an EMPTY reflectionGuidance when nothing has been learned (clean no-op)', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    await firer(input())
    expect(calls[0]!.prompt).toContain('"reflectionGuidance":""')
  })

  test('args thread an EMPTY reflectionGuidance for a whitespace-only context (no bare wrapper)', async () => {
    const { fire, calls } = fakeFire(() => ({ status: 'fired', error: null }))
    const firer = buildWorkflowFirer({ fire })
    // A whitespace-only context must derive to '' end-to-end through buildWorkflowArgs,
    // never a bare wrapper that would perturb the prompt.
    await firer(input({ reflection_context: '   \n\t  ' }))
    expect(calls[0]!.prompt).toContain('"reflectionGuidance":""')
  })

  // The TEST EXECUTION block rides the SAME carriage as `reflectionGuidance`, but is
  // derived one layer up (the orchestrator holds the live run count + host budget), so
  // this layer's whole job is to pass it through verbatim as a string.
  test('args carry the orchestrator-composed testStrategy verbatim', () => {
    const args = buildWorkflowArgs(input({ test_strategy: 'TEST EXECUTION\nX' }))
    expect(args['testStrategy']).toBe('TEST EXECUTION\nX')
  })

  test('args carry an EMPTY testStrategy when none was composed (byte-identical legacy contract)', () => {
    // '' — never undefined and never null: the `.mjs` compares against '' to decide
    // whether to splice, and an absent arg must reproduce the pre-existing prompt.
    expect(buildWorkflowArgs(input()).testStrategy).toBe('')
    expect(buildWorkflowArgs(input({ test_strategy: null })).testStrategy).toBe('')
  })

  test('args carry the orchestrator-composed testStrategyIntermediate verbatim', () => {
    const marker = 'TEST EXECUTION\nTASK-2-INTERMEDIATE-MARKER'
    const args = buildWorkflowArgs(input({ test_strategy_intermediate: marker }))
    expect(args['testStrategyIntermediate']).toBe(marker)
  })

  test('args carry an EMPTY testStrategyIntermediate when none was composed', () => {
    expect(buildWorkflowArgs(input()).testStrategyIntermediate).toBe('')
    expect(buildWorkflowArgs(input({ test_strategy_intermediate: null })).testStrategyIntermediate).toBe('')
  })

  test('a fire seam that REJECTS → failed (crashed launcher, never a silent advance)', async () => {
    const fire: FireInnerWorkflow = async () => {
      throw new Error('unexpected launcher crash')
    }
    const firer = buildWorkflowFirer({ fire })
    const res = await firer(input())
    expect(res.status).toBe('failed')
    expect(res.error).toContain('unexpected launcher crash')
  })
})

// ── The production warm-substrate FIRE seam ───────────────────────────────────

/** Build a fake `Substrate` whose single turn emits the given scripted events,
 *  recording the spec it was started with. */
function fakeSubstrate(events: Event[]): { substrate: Substrate; specs: AgentSpec[]; cancelled: () => boolean } {
  const specs: AgentSpec[] = []
  let cancelled = false
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      return {
        events: (async function* () {
          for (const ev of events) yield ev
        })(),
        async respondToTool() {},
        async cancel() {
          cancelled = true
        },
        tool_resolution: 'internal',
      } as SessionHandle
    },
  }
  return { substrate, specs, cancelled: () => cancelled }
}

const completion: Event = {
  kind: 'completion',
  usage: { input_tokens: 1, output_tokens: 1 } as never,
  substrate_instance_id: 'cc-trident-fire-test',
}

describe('buildSubstrateWorkflowFire — fire + settle on a warm substrate', () => {
  const fireInput = (over: Partial<FireInnerWorkflowInput> = {}): FireInnerWorkflowInput => ({
    prompt: 'fire it',
    cwd: '/repo',
    settle_timeout_ms: 60_000,
    ...over,
  })

  test('a turn that settles with a completion event → fired', async () => {
    const { substrate, specs } = fakeSubstrate([{ kind: 'token', text: 'invoking Workflow…' }, completion])
    const fire = buildSubstrateWorkflowFire({ substrate })
    expect(await fire(fireInput())).toEqual({ status: 'fired', error: null })
    // The fire surface is EXACTLY the constant Workflow tool surface.
    expect(specs[0]!.tools.map((t) => t.name)).toEqual([...WORKFLOW_FIRE_TOOL_NAMES])
  })

  test('an error event before settling → failed', async () => {
    const { substrate, cancelled } = fakeSubstrate([
      { kind: 'error', message: 'turn died', retryable: false },
    ])
    const fire = buildSubstrateWorkflowFire({ substrate })
    const res = await fire(fireInput())
    expect(res.status).toBe('failed')
    expect(cancelled()).toBe(true)
  })

  test('a stream that closes WITHOUT a completion → failed (paused ≠ finished)', async () => {
    const { substrate } = fakeSubstrate([{ kind: 'token', text: 'partial' }])
    const fire = buildSubstrateWorkflowFire({ substrate })
    const res = await fire(fireInput())
    expect(res.status).toBe('failed')
    expect(res.error).toContain('without a completion')
  })

  // REGRESSION (2026-09-03 root cause). The settle-timeout used to `cancel()` the
  // launcher turn, which abandon-poisoned the SHARED warm launcher session; the
  // next fire on that key then evicted (SIGKILLed) the `claude` child hosting every
  // other run's in-process Argus panel / arbiter / terminal steps — 33% of all
  // trident run deaths. The budget is now a reporting deadline: the turn drains.
  test('a settle-timeout → UNCONFIRMED; the turn is NOT cancelled, and its late completion resolves `settled` as fired with the launcher generation', async () => {
    let cancelled = false
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const substrate: Substrate = {
      start(): SessionHandle {
        return {
          events: (async function* () {
            await released
            yield { ...completion, launcher_session_key: 'generation-late' } as Event
          })(),
          async respondToTool() {},
          async cancel() {
            cancelled = true
          },
          tool_resolution: 'internal',
        } as SessionHandle
      },
    }
    let fireTimer: (() => void) | null = null
    const fire = buildSubstrateWorkflowFire({
      substrate,
      set_timer: (fn) => {
        fireTimer = fn
        return 1
      },
      clear_timer: () => {},
    })
    const p = fire(fireInput({ settle_timeout_ms: 5 }))
    // Trip the settle timeout.
    await Promise.resolve()
    expect(fireTimer).not.toBeNull()
    fireTimer!()
    const res = await p
    expect(res.status).toBe('unconfirmed')
    expect(res.error).toContain('did not settle within the budget')
    expect(res.error).toContain('not cancelled')
    expect(res.turn_cancelled).toBe(false)
    expect(res.budget_ms).toBe(5)
    expect(res.elapsed_ms).toBeGreaterThanOrEqual(0)
    // THE assertion: the turn was left running. Red mutation: restoring
    // `handle.cancel()` in the settle-timeout callback flips this.
    expect(cancelled).toBe(false)
    expect(res.settled).toBeDefined()

    // The turn drains on its own; the late settle is exposed for the orchestrator.
    release()
    const late = await res.settled!
    expect(late).toEqual({ status: 'fired', error: null, launcher_session_key: 'generation-late' })
    expect(cancelled).toBe(false)
  })

  test('a fire stream that never yields still resolves at the budget — as unconfirmed, with the turn left running', async () => {
    // Red mutation: reverting the unconditional race makes this hang until the
    // test runner times out, because nothing ever ends the stream.
    let cancelled = false
    const substrate: Substrate = {
      start(): SessionHandle {
        return {
          events: (async function* () {
            await new Promise<void>(() => {})
          })(),
          async respondToTool() {},
          async cancel() {
            cancelled = true
          },
          tool_resolution: 'internal',
        } as SessionHandle
      },
    }
    const fire = buildSubstrateWorkflowFire({ build_substrate: () => substrate })

    const res = await fire(fireInput({ settle_timeout_ms: 20 }))
    expect(res.status).toBe('unconfirmed')
    expect(res.error).toBe('fire turn did not settle within the budget (turn left running, not cancelled)')
    expect(res.turn_cancelled).toBe(false)
    expect(cancelled).toBe(false)
  })

  test('a stream that ERRORS after the budget resolves `settled` as failed — it never rejects', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const substrate: Substrate = {
      start(): SessionHandle {
        return {
          events: (async function* () {
            await released
            throw new Error('pty gone')
          })(),
          async respondToTool() {},
          async cancel() {},
          tool_resolution: 'internal',
        } as SessionHandle
      },
    }
    const fire = buildSubstrateWorkflowFire({ substrate })
    const res = await fire(fireInput({ settle_timeout_ms: 5 }))
    expect(res.status).toBe('unconfirmed')
    release()
    const late = await res.settled!
    expect(late.status).toBe('failed')
    expect(late.error).toContain('fire stream error')
  })

  test('a substrate whose start() throws → failed (crashed launcher)', async () => {
    const substrate: Substrate = {
      start(): SessionHandle {
        throw new Error('empty credential pool')
      },
    }
    const fire = buildSubstrateWorkflowFire({ substrate })
    const res = await fire(fireInput())
    expect(res.status).toBe('failed')
    expect(res.error).toContain('empty credential pool')
  })

  test('build_substrate factory is called with the fire cwd', async () => {
    const { substrate } = fakeSubstrate([completion])
    const cwds: string[] = []
    const fire = buildSubstrateWorkflowFire({
      build_substrate: (cwd) => {
        cwds.push(cwd)
        return substrate
      },
    })
    await fire(fireInput({ cwd: '/some/repo' }))
    expect(cwds).toEqual(['/some/repo'])
  })

  test('requires exactly one of substrate / build_substrate', () => {
    expect(() => buildSubstrateWorkflowFire({})).toThrow(/exactly one/)
  })
})
