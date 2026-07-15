/**
 * Vajra battle-tested-fix parity — one explicit assertion per fix, pinned on
 * the LIVE exec-model path.
 *
 * Trident-port mandate: every battle-tested fix from Vajra's `/trident`
 * SKILL.md + the forge/argus prompts must map onto an Open-substrate
 * equivalent with a regression test so none can silently regress. This file
 * is that map — each `test` names the Vajra fix (and, where relevant, the
 * incident of record) and pins its Open analog.
 *
 * The v1 outer state machine (`session.ts` / `substrate-dispatch.ts` +
 * `prompts.ts` render/parse) was DELETED (K8 refactor). The live loop is the
 * native CC Dynamic Workflow `inner-workflow.mjs`, FIRED by `inner-loop.ts`
 * (`buildSubstrateWorkflowFire`) and driven/harvested by `orchestrator.ts`
 * (`buildTridentOrchestrator`). Every fix below now asserts against one of
 * those live artifacts — several read `inner-workflow.mjs` source directly
 * (the Forge/Argus contract is inlined there, the single live source), the
 * way FIX 8 always has.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { HostCommandResult } from './git-mode.ts'
import { ARGUS_DIFF_LINE_LIMIT } from './prompts.ts'
import { buildTridentOrchestrator, computeDiffLineCount } from './orchestrator.ts'
import {
  buildSubstrateWorkflowFire,
  type TridentWorkflowFirer,
} from './inner-loop.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { computeTransition } from './state-machine.ts'
import type { MergeMode, TridentRun } from './store.ts'

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
const fail = (): HostCommandResult => ({ ok: false, stdout: '', stderr: 'boom', exit_code: 1 })

/** The single live source of the Forge/Argus contract. */
const INNER_WORKFLOW_SRC = readFileSync(
  fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)),
  'utf8',
)

function makeRun(over: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'r1',
    slug: 'add-thing',
    project_slug: 't1',
    phase: 'forge-init',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'feat-x',
    pr: 42,
    merge_mode: 'pr' as MergeMode,
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/repo',
    worktree: null,
    task: 'Add a thing',
    chat_id: null,
    thread_id: null,
    channel_kind: 'telegram',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '1970-01-01T00:00:00.000Z',
    last_advanced_at: '1970-01-01T00:00:00.000Z',
    harvested_at: null,
    ...over,
  }
}

/**
 * A one-shot substrate whose single turn emits the events supplied by
 * `script`, then closes its stream. Used to drive `buildSubstrateWorkflowFire`
 * — the live "fire" seam whose settle discipline replaces the deleted v1
 * `TridentSessionManager` spawn/classify machinery.
 */
function scriptedSubstrate(script: () => AsyncGenerator<Event>): { substrate: Substrate; specs: AgentSpec[] } {
  const specs: AgentSpec[] = []
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      return {
        events: script(),
        async respondToTool() {},
        async cancel() {},
        tool_resolution: 'internal',
      } as SessionHandle
    },
  }
  return { substrate, specs }
}

const completionEvent: Event = {
  kind: 'completion',
  usage: { input_tokens: 1, output_tokens: 1 } as never,
  substrate_instance_id: 'cc-trident-fire-test',
}

// ---------------------------------------------------------------------------
// FIX 1 — Spawn validation: never treat a session that did not actually start
// as in-flight (Vajra: "don't poll a phantom session", 2026-04-15 + 2026-06-09).
// Open v2 analog: `buildSubstrateWorkflowFire` reports `fired` ONLY when a real
// launcher turn settles. A substrate that cannot even START the fire turn is a
// hard `failed`, never a phantom `fired` the harvester would then poll.
// ---------------------------------------------------------------------------
describe('FIX 1 — spawn validation (no phantom fire)', () => {
  test('a substrate whose start() throws → failed, never a phantom "fired"', async () => {
    const substrate: Substrate = {
      start() {
        throw new Error('substrate down')
      },
    }
    const fire = buildSubstrateWorkflowFire({ substrate })
    const out = await fire({ prompt: 'p', cwd: '/repo', settle_timeout_ms: 1000 })
    expect(out.status).toBe('failed')
    expect(out.error).toContain('fire start failed')
  })
})

// ---------------------------------------------------------------------------
// FIX 2 — Reap / "dispatch lost on restart" → re-dispatch, bounded. Vajra
// reaped a dead tmux window/PID and re-dispatched. Open v2 analog: an orphaned
// persisted subagent_run_id (an inner-loop dispatch this process no longer
// tracks) relaunches a FRESH workflow once per process under the default policy.
// (Full lifecycle in restart-resume.test.ts; here we pin the bound + 'wait'.)
// ---------------------------------------------------------------------------
describe('FIX 2 — reap → bounded re-dispatch', () => {
  test('an untracked in-flight id re-dispatches exactly once, then waits (bounded)', async () => {
    let calls = 0
    const fire_workflow: TridentWorkflowFirer = async () => {
      calls++
      return { status: 'fired', error: null }
    }
    const { step } = buildTridentOrchestrator({
      fire_workflow,
      db_path: '/tmp/db',
      run_host: async () => ok(),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    let run = makeRun({ subagent_run_id: 'STALE', subagent_status: 'running' })

    const t1 = await step(run)
    run = t1.run
    expect(run.subagent_run_id).not.toBe('STALE')
    expect(run.subagent_run_id).not.toBeNull()
    expect(calls).toBe(1)

    const t2 = await step(run)
    expect(t2.waiting).toBe(true)
    expect(t2.run.subagent_run_id).toBe(run.subagent_run_id)
    expect(calls).toBe(1)
  })

  test("'wait' policy never re-dispatches an orphan (operator-driven recovery)", async () => {
    const fire_workflow: TridentWorkflowFirer = async () => ({ status: 'fired', error: null })
    const { step } = buildTridentOrchestrator({
      fire_workflow,
      db_path: '/tmp/db',
      run_host: async () => ok(),
      base_branch: 'main',
      on_orphaned_session: 'wait',
      now: () => new Date(0).toISOString(),
    })
    const run = makeRun({ subagent_run_id: 'STALE', subagent_status: 'running' })
    const out = await step(run)
    expect(out.changed).toBe(false)
    expect(out.waiting).toBe(true)
    expect(out.run.subagent_run_id).toBe('STALE')
  })
})

// ---------------------------------------------------------------------------
// FIX 3 — Oversized-diff review guard: Argus never reads a >~3000-line diff
// in one shot (Vajra silent-exit trigger). Open v2 analogs: the live
// `orchestrator.ts` pre-spawn numstat probe (`computeDiffLineCount`)
// conservatively treats an unmeasurable diff as OVER the ceiling, and the
// inlined Argus rubric in `inner-workflow.mjs` carries the guard.
// ---------------------------------------------------------------------------
describe('FIX 3 — oversized-diff guard', () => {
  test('the live Argus rubric bans reading a >~3000-line diff in one shot', () => {
    expect(ARGUS_DIFF_LINE_LIMIT).toBe(3000)
    expect(INNER_WORKFLOW_SRC).toContain('OVERSIZED-DIFF GUARD')
    expect(INNER_WORKFLOW_SRC).toContain('3000-line diff')
    expect(INNER_WORKFLOW_SRC).toContain('STATE what you could not verify')
  })

  test('an unmeasurable diff is treated as OVER the ceiling (conservative)', async () => {
    const overOnFail = await computeDiffLineCount(async () => fail(), '/repo', 'main')
    expect(overOnFail).toBeGreaterThan(ARGUS_DIFF_LINE_LIMIT)
    const overOnThrow = await computeDiffLineCount(async () => {
      throw new Error('git missing')
    }, '/repo', 'main')
    expect(overOnThrow).toBeGreaterThan(ARGUS_DIFF_LINE_LIMIT)
  })
})

// ---------------------------------------------------------------------------
// FIX 4 — max_rounds / max_ralph_rounds caps with loud failure reporting.
// Vajra: a non-converging review loop or planner fails for manual review
// rather than spinning forever. Open analog: computeTransition (state-machine).
// ---------------------------------------------------------------------------
describe('FIX 4 — round caps fail loudly', () => {
  test('argus REQUEST CHANGES past max_rounds → failed with a named reason', () => {
    const run = makeRun({ phase: 'argus', round: 2, max_rounds: 2 })
    const t = computeTransition(run, { approved: false })
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('max_rounds')
  })

  test('ralph re-plan past max_ralph_rounds → failed with a named reason', () => {
    const run = makeRun({ phase: 'ralph-task', ralph: true, ralph_round: 20, max_ralph_rounds: 20 })
    const t = computeTransition(run, {})
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('max_ralph_rounds')
  })

  test('the single ralph-round counter lives in the plan transition (no double-count)', () => {
    const run = makeRun({ phase: 'ralph-task', ralph: true, ralph_round: 3, max_ralph_rounds: 20 })
    const t = computeTransition(run, {})
    expect(t.phase).toBe('ralph-plan')
    expect(t.ralph_round).toBe(4) // incremented exactly once
  })
})

// ---------------------------------------------------------------------------
// FIX 5 — Phantom-ID / async-registry-write race. Vajra's registry row was
// written a beat after spawn-agent.sh returned, so a naive poll raced it and
// could spuriously crash/merge. Open v2 analog: the orchestrator never advances
// an ambiguous (untracked, still-persisted) session toward a terminal/merge
// state under the conservative `wait` policy — it leaves the run untouched for
// operator-driven recovery, never a spurious crash or auto-merge.
// ---------------------------------------------------------------------------
describe('FIX 5 — no phantom-ID race (ambiguous session never auto-terminates)', () => {
  test('an orphaned session under wait is left in place — never crashed or merged', async () => {
    const fire_workflow: TridentWorkflowFirer = async () => ({ status: 'fired', error: null })
    const { step } = buildTridentOrchestrator({
      fire_workflow,
      db_path: '/tmp/db',
      run_host: async () => ok(),
      base_branch: 'main',
      on_orphaned_session: 'wait',
      now: () => new Date(0).toISOString(),
    })
    const out = await step(makeRun({ subagent_run_id: 'never-tracked', subagent_status: 'running' }))
    expect(out.waiting).toBe(true)
    expect(out.run.phase).not.toBe('failed')
    expect(out.run.phase).not.toBe('merged')
    expect(out.run.phase).not.toBe('done')
  })
})

// ---------------------------------------------------------------------------
// FIX 6 — No silent exit / no silent merge.
// Vajra: a Forge that never emitted the PR contract is a failure (not silent
// success); an unreadable/deferred review must NEVER auto-approve/merge. Open
// v2 analog: the inlined Forge contract keeps the PR_NUMBER/BRANCH/WORKTREE
// last-lines discipline, the Argus rubric NEVER exits silently, and the codex
// panelist never-silent-downgrades a failed review into an APPROVE.
// ---------------------------------------------------------------------------
describe('FIX 6 — no silent exit / no silent merge', () => {
  test('the live Forge contract keeps the locked PR_NUMBER/BRANCH/WORKTREE last lines', () => {
    expect(INNER_WORKFLOW_SRC).toContain('BRANCH=')
    expect(INNER_WORKFLOW_SRC).toContain('WORKTREE=')
    expect(INNER_WORKFLOW_SRC).toContain('PR_NUMBER=')
  })

  test('the live Argus rubric refuses to exit silently', () => {
    expect(INNER_WORKFLOW_SRC).toContain('NEVER EXIT SILENTLY')
    expect(INNER_WORKFLOW_SRC).toContain('TRUNCATED verdict')
  })

  test('a configured-but-failed cross-model review never silent-downgrades to APPROVE', () => {
    expect(INNER_WORKFLOW_SRC).toContain('never-silent-downgrade')
    expect(INNER_WORKFLOW_SRC).toContain('refusing to silently APPROVE')
    expect(INNER_WORKFLOW_SRC).toContain('do NOT return APPROVE')
  })
})

// ---------------------------------------------------------------------------
// FIX 7 — Missing/garbled REMAINING_TASKS fails loudly (never silently
// reviews a partial governed build). Open analog: computeTransition (the live
// state-machine) fails a ralph bootstrap/planner whose count is null.
// ---------------------------------------------------------------------------
describe('FIX 7 — missing REMAINING_TASKS fails loud', () => {
  test('a Ralph bootstrap with no valid count → failed (not a one-shot Argus)', () => {
    const run = makeRun({ phase: 'forge-init', ralph: true })
    const t = computeTransition(run, { remaining: null })
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('REMAINING_TASKS')
  })

  test('a planner with no valid count → failed', () => {
    const run = makeRun({ phase: 'ralph-plan', ralph: true, ralph_round: 1 })
    const t = computeTransition(run, { remaining: null })
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('REMAINING_TASKS')
  })

  test('a legacy (non-ralph) forge-init with absent remaining → argus, not failed', () => {
    const run = makeRun({ phase: 'forge-init', ralph: false })
    const t = computeTransition(run, {})
    expect(t.phase).toBe('argus')
  })
})

// ---------------------------------------------------------------------------
// FIX 8 — FABLE-ORCHESTRATOR model routing (Ryan 2026-07-02, M1). This REVERSES
// the 2026-06-13 export-control guard that FORBADE any Fable id in the workflow.
// Doctrine (SPEC Decisions Log 2026-07-02): Fable 5 is the ORCHESTRATOR — it does
// the high-value thinking (plan:fable planning/decomposition + argus:synthesis
// verdict-merge); Opus/Sonnet are SUBORDINATE EXECUTORS carrying out Fable's
// specs (forge:* → Sonnet for [mechanical], Opus for [reasoning]); Opus is the
// reviewer (argus:claude/adversarial). There is NO "escalate to Opus". The
// invariants are now: (a) the FIRE seam still pins a NON-Fable model (default
// `opus`) for the LAUNCHING turn — per-role Fable routing lives INSIDE the
// workflow's agent() calls, not the fire seam; and (b) the workflow ROUTES the
// intended per-role models (guarded positively, no longer forbidden) and never
// HARD-PINS an id literal (the ids are threaded from runtime/models.ts via args).
// ---------------------------------------------------------------------------
describe('FIX 8 — Fable-orchestrator model routing (per-role models in the workflow)', () => {
  test('the inner-loop FIRE seam still pins a non-Fable model (default opus) for the launching turn', async () => {
    const { substrate, specs } = scriptedSubstrate(async function* () {
      yield completionEvent
    })
    const fire = buildSubstrateWorkflowFire({ substrate })
    await fire({ prompt: 'launcher prompt', cwd: '/repo', settle_timeout_ms: 1000 })
    const pref = specs[0]!.model_preference
    expect(pref[0]).toBe('opus')
    // The LAUNCHER turn stays Opus; per-role Fable routing lives INSIDE the
    // workflow's agent() calls, not on the fire seam.
    expect(pref.join(' ').toLowerCase()).not.toContain('fable')
  })

  test('the inner workflow routes the intended per-role models (Fable orchestrates; Opus/Sonnet execute; Opus reviews)', () => {
    const src = INNER_WORKFLOW_SRC
    // Fable ORCHESTRATES: the planner + the verdict synthesis.
    expect(src).toContain("'plan:fable': { model: MODELS.fable")
    expect(src).toContain("'argus:synthesis': { model: MODELS.fable")
    // Opus REVIEWS.
    expect(src).toContain("'argus:claude': { model: MODELS.opus")
    expect(src).toContain("'argus:adversarial': { model: MODELS.opus")
    // Executors route BY the planner's complexity tag: [mechanical]→Sonnet, else Opus.
    expect(src).toContain("tag === 'mechanical'")
    expect(src).toContain('model: MODELS.sonnet')
    expect(src).toContain('model: MODELS.opus')
    // No "escalate to Opus": the unknown-label default is an Opus EXECUTOR, never Fable.
    expect(src).toContain("ROLE_MODEL[label] || { model: MODELS.opus")
    // The model IDS are threaded from runtime/models.ts via args — the workflow
    // must NOT hard-pin an id literal (it can't import the registry).
    expect(src).not.toContain('claude-fable-5')
    expect(src).not.toContain('claude-opus-4-8')
    expect(src).not.toContain('claude-sonnet-4-6')
    // Every spawn is logged with its resolved model so a run is TALLY-ABLE.
    expect(src).toContain('trident.agent label=')
    expect(src).toContain('model=codex-runtime')
  })

  test('FABLE_MODEL is defined in the model registry (single source of truth) and threaded via buildWorkflowArgs', () => {
    const models = readFileSync(fileURLToPath(new URL('../runtime/models.ts', import.meta.url)), 'utf8')
    expect(models).toContain('FABLE_MODEL')
    expect(models).toContain("'claude-fable-5'")
    // The launcher resolves the ids from the registry and threads them via args.
    const loop = readFileSync(fileURLToPath(new URL('./inner-loop.ts', import.meta.url)), 'utf8')
    expect(loop).toContain('FABLE_MODEL')
    expect(loop).toContain('models: {')
    expect(loop).toContain('fable: FABLE_MODEL')
  })
})

// ---------------------------------------------------------------------------
// FIX 9 — Fleet PREMATURE-COMPLETION reconciliation (Vajra PR #164 + #160).
// Vajra incident (fleet-wide, 2026-06-23): a Forge pushed its branch then
// HUNG at the cross-model (Codex) review before opening the PR — it self-ran
// an ASYNC review and yielded its turn to await a result nothing feeds back to
// a headless agent, so it idled until reaped, PR unshipped. Two Open analogs,
// BOTH now on the live path:
//   (a) PROMPT: the inlined live Forge contract in `inner-workflow.mjs` must
//       encode OPEN-PR-FIRST + review-is-best-effort + NEVER-yield-the-turn.
//   (b) FALSE-COMPLETION race: `buildSubstrateWorkflowFire` classifies a fire
//       turn whose stream ends WITHOUT a terminal `completion` event as
//       `failed` (paused ≠ finished), never a silent `fired`.
// See docs/research/vajra-neutron-fix-reconciliation-2026-06-24.md.
// ---------------------------------------------------------------------------
describe('FIX 9 — fleet premature-completion / cross-model-review wedge', () => {
  test('(a) the live Forge contract orders PR-FIRST, best-effort review, never gate/yield', () => {
    // The inlined forgePushStep in inner-workflow.mjs (the single live source).
    expect(INNER_WORKFLOW_SRC).toContain('OPEN THE PR FIRST')
    expect(INNER_WORKFLOW_SRC).toMatch(/best-effort/i)
    expect(INNER_WORKFLOW_SRC).toContain('NEVER gate the PR')
    expect(INNER_WORKFLOW_SRC).toMatch(/yield your turn/i)
  })

  test('(b) a fire turn that ends without a completion event → failed (paused ≠ finished)', async () => {
    // Stream yields a non-terminal event then closes with NO completion — a
    // paused / abnormally-closed launcher turn. It must NEVER be reported fired.
    const { substrate } = scriptedSubstrate(async function* () {
      yield {
        kind: 'token',
        text: 'working...',
        substrate_instance_id: 'cc-trident-fire-test',
      } as Event
      // stream ends here — no completion event
    })
    const fire = buildSubstrateWorkflowFire({ substrate })
    const out = await fire({ prompt: 'p', cwd: '/repo', settle_timeout_ms: 1000 })
    expect(out.status).toBe('failed')
    expect(out.error).toContain('without a completion event')
  })

  test('(b) a fire turn that settles with a completion event → fired', async () => {
    const { substrate } = scriptedSubstrate(async function* () {
      yield completionEvent
    })
    const fire = buildSubstrateWorkflowFire({ substrate })
    const out = await fire({ prompt: 'p', cwd: '/repo', settle_timeout_ms: 1000 })
    expect(out.status).toBe('fired')
  })
})
