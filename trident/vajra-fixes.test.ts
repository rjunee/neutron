/**
 * Vajra battle-tested-fix parity — one explicit assertion per fix.
 *
 * Trident-port PR-5 mandate: every battle-tested fix from Vajra's
 * `/trident` SKILL.md + the forge/argus prompts must map onto an
 * Open-substrate equivalent with a regression test so none can silently
 * regress. This file is that map — each `test` names the Vajra fix (and,
 * where relevant, the incident of record) and pins its Open analog.
 *
 * Where a fix is already exercised by a broader suite (orchestrator /
 * state-machine / prompts / restart-resume), this file still asserts the
 * narrow invariant directly so the mapping is legible in one place.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { HostCommandResult } from './git-mode.ts'
import {
  ARGUS_DIFF_LINE_LIMIT,
  chooseArgusScope,
  parseArgusVerdict,
  parseForgeOutput,
  parseRalphPlan,
  renderForgePrompt,
} from './prompts.ts'
import { buildTridentOrchestrator, computeDiffLineCount } from './orchestrator.ts'
import { buildClaudePrintArgs } from './inner-loop.ts'
import { TridentSessionManager, type TridentDispatch } from './session.ts'
import { computeTransition } from './state-machine.ts'
import type { MergeMode, TridentRun } from './store.ts'

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
const fail = (): HostCommandResult => ({ ok: false, stdout: '', stderr: 'boom', exit_code: 1 })

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
    started_at: '1970-01-01T00:00:00.000Z',
    last_advanced_at: '1970-01-01T00:00:00.000Z',
    ...over,
  }
}

// ---------------------------------------------------------------------------
// FIX 1 — Spawn validation: confirm a session actually started before
// treating it as in-flight (Vajra: "don't poll a phantom session"; the
// poll-up-to-60s + bare-substring grep guard, 2026-04-15 + 2026-06-09).
// Open analog: spawn() records the `running` entry SYNCHRONOUSLY before it
// returns, so the very next classify/isTracked can never miss it; an empty
// id mint is a hard throw, not a phantom in-flight.
// ---------------------------------------------------------------------------
describe('FIX 1 — spawn validation (no phantom in-flight)', () => {
  const inflight: TridentDispatch = async () => {
    await new Promise<void>(() => {}) // never resolves
    return { result: '', status: 'completed' }
  }

  test('spawn registers the session synchronously — isTracked true before any await', () => {
    const mgr = new TridentSessionManager({ dispatch: inflight, mint_run_id: () => 'fixed-id' })
    const id = mgr.spawn({
      kind: 'forge',
      phase: 'forge-init',
      system: 's',
      user_message: 'u',
      repo_path: '/repo',
      trident_run_id: 'r1',
      model: 'claude-sonnet-4-6',
      timeout_ms: 1000,
    })
    expect(id).toBe('fixed-id')
    // No await between spawn() and this check — yet the session is tracked.
    expect(mgr.isTracked('fixed-id')).toBe(true)
    expect(mgr.runningCount()).toBe(1)
  })

  test('an empty/blank minted id throws at spawn time (never a phantom row)', () => {
    const mgr = new TridentSessionManager({ dispatch: inflight, mint_run_id: () => '' })
    expect(() =>
      mgr.spawn({
        kind: 'forge',
        phase: 'forge-init',
        system: 's',
        user_message: 'u',
        repo_path: '/repo',
        trident_run_id: 'r1',
        model: 'm',
        timeout_ms: 1000,
      }),
    ).toThrow(/empty id/)
  })
})

// ---------------------------------------------------------------------------
// FIX 2 — Reap / "dispatch lost on restart" → re-dispatch, bounded. Vajra reaped
// a dead tmux window/PID and re-dispatched. Open v2 analog: an orphaned
// persisted subagent_run_id (the inner-loop dispatch this process no longer
// tracks) relaunches a FRESH workflow once per process under the default policy.
// (Full lifecycle in restart-resume.test.ts; here we pin the bound + 'wait'.)
// ---------------------------------------------------------------------------
describe('FIX 2 — reap → bounded re-dispatch', () => {
  test('an untracked in-flight id re-dispatches exactly once, then waits (bounded)', async () => {
    let calls = 0
    // The inner loop never settles, so the run stays in flight and the SAME run
    // re-enters the orphan path on the next tick.
    const { step } = buildTridentOrchestrator({
      inner_loop: async () => {
        calls++
        await new Promise<void>(() => {})
        return { status: 'failed', verdict: null, pr_number: null, branch: null, round: 0, checkpoint: null, raw: '' }
      },
      db_path: '/tmp/db',
      run_host: async () => ok(),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    let run = makeRun({ subagent_run_id: 'STALE', subagent_status: 'running' })

    const t1 = await step(run)
    run = t1.run
    // Re-dispatched: slot now holds a fresh, tracked id (not STALE).
    expect(run.subagent_run_id).not.toBe('STALE')
    expect(run.subagent_run_id).not.toBeNull()
    expect(calls).toBe(1)

    // Tracked now → the next step polls it (waiting), never a 2nd re-dispatch.
    const t2 = await step(run)
    expect(t2.waiting).toBe(true)
    expect(t2.run.subagent_run_id).toBe(run.subagent_run_id)
    expect(calls).toBe(1)
  })

  test("'wait' policy never re-dispatches an orphan (operator-driven recovery)", async () => {
    const { step } = buildTridentOrchestrator({
      inner_loop: async () => ({ status: 'completed', verdict: 'APPROVE', pr_number: 1, branch: 'feat-x', round: 1, checkpoint: 'argus-approved', raw: '' }),
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
// in one shot (Vajra silent-exit trigger). Open analog: a pre-spawn
// numstat probe + chooseArgusScope downgrades to the meaty-commits scope
// and conservatively treats an unmeasurable diff as OVER the ceiling.
// ---------------------------------------------------------------------------
describe('FIX 3 — oversized-diff guard', () => {
  test('a diff over the ceiling steers Argus to meaty commits + "could not verify"', () => {
    const scope = chooseArgusScope({ base_branch: 'main', round: 1, diff_line_count: ARGUS_DIFF_LINE_LIMIT + 1 })
    expect(scope).toContain('OVER')
    expect(scope).toContain('git log --oneline main..HEAD')
    expect(scope).toContain('could not verify')
    expect(scope).not.toContain('git diff main..HEAD') // must NOT read it whole
  })

  test('a diff under the ceiling lets Argus read the full branch diff', () => {
    const scope = chooseArgusScope({ base_branch: 'main', round: 1, diff_line_count: 10 })
    expect(scope).toContain('git diff main..HEAD')
    expect(scope).not.toContain('OVER')
  })

  test('round 2+ always reviews only the latest fix commit (never the whole branch)', () => {
    const scope = chooseArgusScope({ base_branch: 'main', round: 2, diff_line_count: 999999 })
    expect(scope).toContain('git show HEAD')
    expect(scope).not.toContain('OVER')
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
// rather than spinning forever. Open analog: computeTransition.
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
// written a beat after spawn-agent.sh returned, so a naive poll raced it.
// Open analog: spawn() is synchronous; a classify before the dispatch
// resolves reports `running` (never a phantom crash), and an unknown id
// (lost map) defaults to the SAFE `running` (the non-null id blocks a
// re-spawn at the session layer; the orchestrator owns orphan recovery).
// ---------------------------------------------------------------------------
describe('FIX 5 — no phantom-ID race', () => {
  test('classify right after spawn (before completion) reports running, not crashed', async () => {
    const session = new TridentSessionManager({
      dispatch: async () => {
        await new Promise<void>(() => {})
        return { result: '', status: 'completed' }
      },
      mint_run_id: () => 'live-id',
    })
    const id = session.spawn({
      kind: 'argus',
      phase: 'argus',
      system: 's',
      user_message: 'u',
      repo_path: '/repo',
      trident_run_id: 'r1',
      model: 'm',
      timeout_ms: 1000,
    })
    const outcome = await session.classify(makeRun({ subagent_run_id: id, phase: 'argus' }))
    expect(outcome.status).toBe('running')
  })

  test('an unknown id defaults to the safe running (no spurious crash/merge)', async () => {
    const session = new TridentSessionManager({ dispatch: async () => ({ result: 'APPROVE', status: 'completed' }) })
    const outcome = await session.classify(makeRun({ subagent_run_id: 'never-spawned', phase: 'argus' }))
    expect(outcome.status).toBe('running')
  })

  test('unknown_session:crashed opts into loud orphan failure at the session layer', async () => {
    const session = new TridentSessionManager({
      dispatch: async () => ({ result: 'APPROVE', status: 'completed' }),
      unknown_session: 'crashed',
    })
    const outcome = await session.classify(makeRun({ subagent_run_id: 'never-spawned', phase: 'argus' }))
    expect(outcome.status).toBe('crashed')
  })
})

// ---------------------------------------------------------------------------
// FIX 6 — No silent exit / no silent merge.
// Vajra: a Forge that never emitted the PR contract is a failure (not
// silent success); an unreadable Argus verdict must NEVER auto-merge.
// ---------------------------------------------------------------------------
describe('FIX 6 — no silent exit / no silent merge', () => {
  test('a forge-init with no PR/BRANCH/WORKTREE contract → crashed (not success)', async () => {
    const session = new TridentSessionManager({ dispatch: async () => ({ result: 'I did some stuff', status: 'completed' }) })
    const id = session.spawn({
      kind: 'forge',
      phase: 'forge-init',
      system: 's',
      user_message: 'u',
      repo_path: '/repo',
      trident_run_id: 'r1',
      model: 'm',
      timeout_ms: 1000,
    })
    await session.drain()
    const outcome = await session.classify(makeRun({ subagent_run_id: id, phase: 'forge-init' }))
    expect(outcome.status).toBe('crashed')
  })

  test('an unparseable Argus verdict fails safe to REQUEST_CHANGES (never auto-merge)', () => {
    expect(parseArgusVerdict('the diff looks fine to me probably')).toBe('REQUEST_CHANGES')
    expect(parseArgusVerdict('')).toBe('REQUEST_CHANGES')
  })

  test('a clean APPROVE on its own line parses as APPROVE', () => {
    expect(parseArgusVerdict('Looks good.\nAPPROVE')).toBe('APPROVE')
  })
})

// ---------------------------------------------------------------------------
// FIX 7 — Missing/garbled REMAINING_TASKS fails loudly (never silently
// reviews a partial governed build).
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

  test('a garbled REMAINING_TASKS string parses to null (strict ^[0-9]+$)', () => {
    expect(parseRalphPlan('REMAINING_TASKS=lots\nNEXT_TASK=x').remaining).toBeNull()
    expect(parseForgeOutput('PR_NUMBER=1\nBRANCH=b\nWORKTREE=/w\nREMAINING_TASKS=3')?.remaining).toBe(3)
  })

  test('a legacy (non-ralph) forge-init with absent remaining → argus, not failed', () => {
    const run = makeRun({ phase: 'forge-init', ralph: false })
    const t = computeTransition(run, {})
    expect(t.phase).toBe('argus')
  })
})

// ---------------------------------------------------------------------------
// FIX 8 — Model routing / effort. Vajra routed every spawn to the fleet default
// and the Fable opt-in was removed (export-control). Trident v2 analog: per-phase
// model routing MOVED into the inner workflow's own agent() calls (the
// orchestrator no longer carries forge_model/argus_model). The v2 invariant is
// (a) the `claude -p` LAUNCHER pins a NON-Fable model (default `opus`) for the
// print-mode process, while per-phase routing still lives in the workflow's own
// agent() calls, and (b) export-control holds — the workflow never hard-pins a
// Fable id.
// ---------------------------------------------------------------------------
describe('FIX 8 — model routing delegated to the workflow (export-control holds)', () => {
  test('the inner-loop launcher pins a non-Fable model (default opus; per-phase routing lives in the workflow)', () => {
    const args = buildClaudePrintArgs('launcher prompt', 'opus')
    const mi = args.indexOf('--model')
    expect(mi).toBeGreaterThanOrEqual(0)
    expect(args[mi + 1]).toBe('opus')
    // Export-control: the launcher argv never hard-pins a Fable model id.
    expect(args.join(' ').toLowerCase()).not.toContain('fable')
  })

  test('export-control: the inner workflow source never hard-pins a Fable model id', () => {
    const src = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')
    expect(src.toLowerCase()).not.toContain('fable')
  })
})

// ---------------------------------------------------------------------------
// FIX 9 — Fleet PREMATURE-COMPLETION reconciliation (Vajra PR #164 + #160).
// Vajra incident (fleet-wide, 2026-06-23): a Forge pushed its branch then
// HUNG at the cross-model (Codex) review before opening the PR — it self-ran
// an ASYNC review and yielded its turn to await a result nothing feeds back to
// a headless agent, so it idled until reaped, PR unshipped. Two Open analogs:
//   (a) PROMPT: the rendered Forge prompt must encode OPEN-PR-FIRST +
//       review-is-best-effort + NEVER-yield-the-turn-to-await-a-review (the
//       Open analog of Vajra's prompts/forge.md cross-model rewrite). Open has
//       no openai-codex stop-review-gate plugin in its repo surface, so the
//       durable defense here is the prompt, not a per-worktree gate pin.
//   (b) FALSE-COMPLETION race: a substrate turn whose stream ends WITHOUT a
//       terminal completion/error event (paused, not finished) must NOT be
//       classified as completed — asserted in substrate-dispatch.test.ts.
// See docs/research/vajra-neutron-fix-reconciliation-2026-06-24.md.
// ---------------------------------------------------------------------------
describe('FIX 9 — fleet premature-completion / cross-model-review wedge', () => {
  const prompt = renderForgePrompt(makeRun({ merge_mode: 'pr' as MergeMode }), 'main')

  test('the Forge prompt orders PR-FIRST then review (a stalled review never costs the PR)', () => {
    expect(prompt).toContain('OPEN THE PR FIRST')
    // The review ACTION is explicitly sequenced AFTER opening the PR.
    expect(prompt).toMatch(/OPEN THE PR FIRST[\s\S]*THEN run any cross-model/i)
  })

  test('the Forge prompt marks cross-model review BEST-EFFORT (never gates the PR)', () => {
    expect(prompt).toMatch(/BEST-EFFORT/)
    expect(prompt.toLowerCase()).toContain('never gate the pr')
  })

  test('the Forge prompt BANS yielding the turn to await an async/background review', () => {
    // The live wedge: ending the turn "to wait for"/"resume when" a review.
    expect(prompt).toMatch(/NEVER end your turn/i)
    expect(prompt.toLowerCase()).toContain('synchronously')
  })
})
