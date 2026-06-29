/**
 * Tests for the Trident v2 inner-loop LAUNCHER (`buildWorkflowInnerLoop`) and the
 * production INTERACTIVE-substrate launcher (`buildSubstrateInnerLauncher`).
 *
 * THE BILLING FIX (2026-06-29): the launcher runs as ONE turn on the persistent
 * INTERACTIVE-REPL substrate (billing-EXEMPT), NOT a `claude -p` print-mode
 * subprocess (API-billed). The launcher invokes the `Workflow` tool, HOLDS its
 * turn open while polling the background run to terminal, and replies with
 * `TRIDENT_RESULT=<json>`. These tests inject a FAKE `LaunchInnerWorkflow` (for
 * the loop mechanics) and a FAKE `Substrate` (for the launcher), so everything is
 * exercised WITHOUT a live claude / Workflow tool — and WITHOUT ever spawning a
 * `claude -p` subprocess (there is none in this module).
 *
 * THE REGRESSION THIS SUITE PINS: the pre-fix launcher settled on the FIRST reply
 * — i.e. it could resolve BEFORE TRIDENT_RESULT existed (the background workflow
 * still running, then aborted). Two guards encode "the launcher does NOT settle
 * before the turn produces a terminal result":
 *   (1) `buildSubstrateInnerLauncher` resolves ONLY on the substrate's `completion`
 *       event (by which point the launcher polled the workflow to terminal +
 *       replied), never on an earlier `token`.
 *   (2) `buildWorkflowInnerLoop` maps a settled turn with NO parseable
 *       TRIDENT_RESULT to `failed` (no silent success).
 */

import { describe, expect, test } from 'bun:test'
import {
  buildWorkflowInnerLoop,
  buildSubstrateInnerLauncher,
  parseTridentResult,
  type InnerLoopInput,
  type LaunchInnerWorkflow,
  type LaunchInnerWorkflowResult,
} from './inner-loop.ts'
import type { Event } from '../runtime/events.ts'
import type { SessionHandle } from '../runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '../runtime/substrate.ts'
import type { TridentRun } from './store.ts'

function makeRun(over: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'run-1',
    slug: 'add-widget',
    project_slug: 'proj',
    phase: 'forge-init',
    round: 1,
    max_rounds: 3,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'trident/add-widget',
    pr: null,
    merge_mode: 'pr',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/repo',
    worktree: null,
    task: 'Add a widget',
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

const OK: Omit<LaunchInnerWorkflowResult, 'stdout'> = {
  stderr: '',
  exit_code: 0,
  timed_out: false,
  spawn_error: null,
}

/** A fake `LaunchInnerWorkflow` that records its input + returns a scripted result. */
function fakeLaunch(
  result: (i: Parameters<LaunchInnerWorkflow>[0]) => LaunchInnerWorkflowResult,
): { launch: LaunchInnerWorkflow; calls: Array<Parameters<LaunchInnerWorkflow>[0]> } {
  const calls: Array<Parameters<LaunchInnerWorkflow>[0]> = []
  const launch: LaunchInnerWorkflow = async (i) => {
    calls.push(i)
    return result(i)
  }
  return { launch, calls }
}

describe('parseTridentResult — walks from the end, tolerates preamble', () => {
  test('parses the last TRIDENT_RESULT= line', () => {
    const raw = 'launching…\nworkflow ran\nTRIDENT_RESULT={"ok":true,"verdict":"APPROVE","prNumber":7}'
    expect(parseTridentResult(raw)).toEqual({ ok: true, verdict: 'APPROVE', prNumber: 7 })
  })
  test('returns null when no result line is present', () => {
    expect(parseTridentResult('no result here\njust text')).toBeNull()
  })
  test('a malformed earlier line is shadowed by a good later one', () => {
    const raw = 'TRIDENT_RESULT={bad json\nTRIDENT_RESULT={"verdict":"REQUEST_CHANGES"}'
    expect(parseTridentResult(raw)).toEqual({ verdict: 'REQUEST_CHANGES' })
  })
})

describe('buildWorkflowInnerLoop — launcher mechanics (over the launch seam)', () => {
  test('a clean turn (exit_code 0) with a TRIDENT_RESULT line → parsed result', async () => {
    const { launch } = fakeLaunch(() => ({
      ...OK,
      stdout:
        'invoked the Workflow tool…\nTRIDENT_RESULT={"ok":true,"prNumber":42,"branch":"trident/add-widget","verdict":"APPROVE","round":2,"checkpoint":"argus-approved"}',
    }))
    const loop = buildWorkflowInnerLoop({ launch })
    const res = await loop(input())

    expect(res.status).toBe('completed')
    expect(res.verdict).toBe('APPROVE')
    expect(res.pr_number).toBe(42)
    expect(res.branch).toBe('trident/add-widget')
    expect(res.round).toBe(2)
    expect(res.checkpoint).toBe('argus-approved')
  })

  test('REQUEST_CHANGES round-trips as a verdict (maxRounds exhausted upstream)', async () => {
    const { launch } = fakeLaunch(() => ({
      ...OK,
      stdout: 'TRIDENT_RESULT={"ok":true,"prNumber":9,"verdict":"REQUEST_CHANGES","round":3}',
    }))
    const loop = buildWorkflowInnerLoop({ launch })
    const res = await loop(input())
    expect(res.status).toBe('completed')
    expect(res.verdict).toBe('REQUEST_CHANGES')
    expect(res.pr_number).toBe(9)
  })

  test('the launcher prompt carries scriptPath + args + structured-JSON note + the held-open-turn discipline, rooted at the worktree cwd', async () => {
    const { launch, calls } = fakeLaunch(() => ({
      ...OK,
      stdout: 'TRIDENT_RESULT={"verdict":"APPROVE"}',
    }))
    const loop = buildWorkflowInnerLoop({
      launch,
      workflow_script_path: '/abs/inner-workflow.mjs',
    })
    await loop(input({ run: makeRun({ worktree: '/wt/run-1', task: 'do the thing' }) }))

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.prompt).toContain('/abs/inner-workflow.mjs')
    expect(call.prompt).toContain('do the thing')
    expect(call.prompt).toContain('TRIDENT_RESULT=')
    // Defense-in-depth: the launcher must tell the model to pass `args` as a
    // structured JSON object, not a JSON-encoded string (a real run showed the
    // model stringifying it, which zeroes out every workflow field).
    expect(call.prompt).toContain('STRUCTURED JSON OBJECT')
    // …and to HOLD the turn open (poll the BACKGROUND run) rather than replying
    // on the Workflow tool's immediate runId return (the abort this fix closes).
    expect(call.prompt.toLowerCase()).toContain('background')
    expect(call.prompt.toLowerCase()).toContain('poll')
    expect(call.prompt).toContain('reply()')
    // The launcher turn is rooted at the run's worktree.
    expect(call.cwd).toBe('/wt/run-1')
  })

  test('args thread resume_checkpoint + existing pr/branch for idempotent resume', async () => {
    const { launch, calls } = fakeLaunch(() => ({
      ...OK,
      stdout: 'TRIDENT_RESULT={"verdict":"APPROVE"}',
    }))
    const loop = buildWorkflowInnerLoop({ launch })
    await loop(input({ run: makeRun({ pr: 55 }), resume_checkpoint: 'argus-request-changes' }))
    const prompt = calls[0]!.prompt
    expect(prompt).toContain('"prNumber":55')
    expect(prompt).toContain('"resumeCheckpoint":"argus-request-changes"')
  })

  test('REGRESSION: a settled turn with NO parseable result line → failed (turn settled before TRIDENT_RESULT existed)', async () => {
    // The pre-fix symptom: the launcher settled before the background workflow
    // produced a result. A clean turn with no result line must be a LOUD failure,
    // never a silent success.
    const { launch } = fakeLaunch(() => ({
      ...OK,
      stdout: 'I launched the workflow but the turn settled before it finished',
    }))
    const loop = buildWorkflowInnerLoop({ launch })
    const res = await loop(input())
    expect(res.status).toBe('failed')
    expect(res.verdict).toBeNull()
  })

  test('a non-completion turn (exit_code !== 0) → failed even with a stray result line', async () => {
    const { launch } = fakeLaunch(() => ({
      ...OK,
      exit_code: null,
      spawn_error: 'substrate error: boom',
      stdout: 'TRIDENT_RESULT={"verdict":"APPROVE"}',
    }))
    const loop = buildWorkflowInnerLoop({ launch })
    const res = await loop(input())
    expect(res.status).toBe('failed')
  })

  test('a launcher spawn_error → failed', async () => {
    const { launch } = fakeLaunch(() => ({
      stdout: '',
      stderr: '',
      exit_code: null,
      timed_out: false,
      spawn_error: 'substrate start failed: empty Anthropic credential pool',
    }))
    const loop = buildWorkflowInnerLoop({ launch })
    const res = await loop(input())
    expect(res.status).toBe('failed')
  })

  test('a timed-out launch → timed_out', async () => {
    const { launch } = fakeLaunch(() => ({
      stdout: 'still building…',
      stderr: '',
      exit_code: null,
      timed_out: true,
      spawn_error: null,
    }))
    const loop = buildWorkflowInnerLoop({ launch })
    const res = await loop(input())
    expect(res.status).toBe('timed_out')
  })

  test('a launch seam that REJECTS → failed (crashed launcher, never a silent advance)', async () => {
    const launch: LaunchInnerWorkflow = async () => {
      throw new Error('unexpected launcher crash')
    }
    const loop = buildWorkflowInnerLoop({ launch })
    const res = await loop(input())
    expect(res.status).toBe('failed')
    expect(res.raw).toContain('unexpected launcher crash')
  })
})

// ── The production interactive-substrate launcher ─────────────────────────────
//
// A controllable fake `Substrate` whose `start(spec)` returns a SessionHandle
// driven by `push(event)` / `end()`. This stands in for the billing-EXEMPT
// persistent interactive REPL — there is NO `claude -p`, NO `child_process.spawn`.

function makeChannelSubstrate(): {
  build: (cwd: string) => Substrate
  cwds: string[]
  specs: AgentSpec[]
  push: (ev: Event) => void
  end: () => void
  cancelled: () => boolean
  started: () => boolean
} {
  const cwds: string[] = []
  const specs: AgentSpec[] = []
  let cancelledFlag = false
  let started = false
  const queue: Event[] = []
  let wake: (() => void) | null = null
  let ended = false
  const push = (ev: Event): void => {
    queue.push(ev)
    wake?.()
    wake = null
  }
  const end = (): void => {
    ended = true
    wake?.()
    wake = null
  }
  async function* gen(): AsyncGenerator<Event, void, void> {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      if (ended) return
      await new Promise<void>((r) => {
        wake = r
      })
    }
  }
  const build = (cwd: string): Substrate => ({
    start(spec: AgentSpec): SessionHandle {
      started = true
      cwds.push(cwd)
      specs.push(spec)
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {
          cancelledFlag = true
          end()
        },
        tool_resolution: 'internal',
      }
    },
  })
  return { build, cwds, specs, push, end, cancelled: () => cancelledFlag, started: () => started }
}

/** Flush enough microtasks that the launcher's synchronous start() + first
 *  iterator step have run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('buildSubstrateInnerLauncher — interactive substrate turn (billing-exempt)', () => {
  test('starts the turn on the substrate rooted at cwd; spec carries the prompt + model, declares no Core tools', async () => {
    const sub = makeChannelSubstrate()
    const launch = buildSubstrateInnerLauncher({
      build_substrate: sub.build,
      model: 'opus',
      assert_model_floor: () => {},
    })
    const p = launch({ prompt: 'launcher prompt', cwd: '/wt/run-1', timeout_ms: 60_000 })
    await flush()
    expect(sub.started()).toBe(true)
    expect(sub.cwds[0]).toBe('/wt/run-1')
    expect(sub.specs[0]!.prompt).toBe('launcher prompt')
    expect(sub.specs[0]!.model_preference).toEqual(['opus'])
    // The launcher declares NO Core ToolDefs — the REPL's built-in surface
    // (Workflow + Task*/Monitor) comes from the substrate, not the spec.
    expect(sub.specs[0]!.tools).toEqual([])
    sub.push({ kind: 'token', text: 'TRIDENT_RESULT={"verdict":"APPROVE"}' })
    sub.push({
      kind: 'completion',
      usage: { input_tokens: 0, output_tokens: 0 },
      substrate_instance_id: 'cc-trident-x',
    } as Event)
    await p
  })

  test('REGRESSION: resolves ONLY on the completion event, never on an earlier token (held-open turn)', async () => {
    const sub = makeChannelSubstrate()
    const launch = buildSubstrateInnerLauncher({
      build_substrate: sub.build,
      assert_model_floor: () => {},
    })

    let settled = false
    const p = launch({ prompt: 'go', cwd: '/repo', timeout_ms: 60_000 }).then((r) => {
      settled = true
      return r
    })

    await flush()
    // The launcher's progress streams in as tokens — but the turn has NOT settled
    // (the background workflow is still running; the launcher is still polling).
    sub.push({ kind: 'token', text: 'launched workflow, polling…\n' })
    await flush()
    // CRITICAL: must NOT have settled on the token. (Pre-fix, the REPL turn settled
    // on the first reply here, aborting the still-running workflow.)
    expect(settled).toBe(false)

    // The final reply (after the workflow drained) carries TRIDENT_RESULT; the
    // substrate then emits its single completion event.
    sub.push({ kind: 'token', text: 'TRIDENT_RESULT={"verdict":"APPROVE","prNumber":7}' })
    sub.push({
      kind: 'completion',
      usage: { input_tokens: 0, output_tokens: 0 },
      substrate_instance_id: 'cc-trident-x',
    } as Event)

    const res = await p
    expect(settled).toBe(true)
    expect(res.exit_code).toBe(0)
    expect(res.timed_out).toBe(false)
    expect(res.spawn_error).toBeNull()
    expect(parseTridentResult(res.stdout)).toEqual({ verdict: 'APPROVE', prNumber: 7 })
  })

  test('a substrate error event → spawn_error (never a silent success), and cancels the turn', async () => {
    const sub = makeChannelSubstrate()
    const launch = buildSubstrateInnerLauncher({
      build_substrate: sub.build,
      assert_model_floor: () => {},
    })
    const p = launch({ prompt: 'go', cwd: '/repo', timeout_ms: 60_000 })
    await flush()
    sub.push({ kind: 'error', message: 'HTTP 429: rate limited', retryable: true } as Event)
    const res = await p
    expect(res.spawn_error).toContain('429')
    expect(res.exit_code).toBeNull()
    expect(sub.cancelled()).toBe(true)
  })

  test('cancels the turn + reports timed_out when the budget elapses', async () => {
    const sub = makeChannelSubstrate()
    let fire: (() => void) | null = null
    const launch = buildSubstrateInnerLauncher({
      build_substrate: sub.build,
      assert_model_floor: () => {},
      set_timer: (fn) => {
        fire = fn
        return 1
      },
      clear_timer: () => {},
    })
    const p = launch({ prompt: 'go', cwd: '/repo', timeout_ms: 5 })
    await flush()
    expect(fire).not.toBeNull()
    fire!()
    const res = await p
    expect(res.timed_out).toBe(true)
    expect(res.exit_code).toBeNull()
    expect(sub.cancelled()).toBe(true)
  })

  test('REGRESSION: a turn that ends with NO completion event → failed (paused ≠ finished)', async () => {
    const sub = makeChannelSubstrate()
    const launch = buildSubstrateInnerLauncher({
      build_substrate: sub.build,
      assert_model_floor: () => {},
    })
    const p = launch({ prompt: 'go', cwd: '/repo', timeout_ms: 60_000 })
    await flush()
    sub.push({ kind: 'token', text: 'some partial work' })
    sub.end() // channel closed WITHOUT a terminal completion event
    const res = await p
    expect(res.exit_code).toBeNull()
    expect(res.spawn_error).toContain('without a terminal completion')
  })

  test('a substrate start() that throws → spawn_error (no turn, never a silent success)', async () => {
    const launch = buildSubstrateInnerLauncher({
      build_substrate: () => {
        throw new Error('empty Anthropic credential pool')
      },
      assert_model_floor: () => {},
    })
    const res = await launch({ prompt: 'go', cwd: '/repo', timeout_ms: 60_000 })
    expect(res.spawn_error).toContain('substrate start failed')
    expect(res.spawn_error).toContain('empty Anthropic credential pool')
    expect(res.exit_code).toBeNull()
  })

  test('a below-floor model fails the launch LOUDLY (auto-mode model floor)', async () => {
    const sub = makeChannelSubstrate()
    // The default floor guard rejects a positively-below-floor model.
    const launch = buildSubstrateInnerLauncher({
      build_substrate: sub.build,
      model: 'claude-opus-4-5',
    })
    const res = await launch({ prompt: 'go', cwd: '/repo', timeout_ms: 60_000 })
    expect(res.spawn_error).toContain('below floor')
    expect(res.exit_code).toBeNull()
    // No turn was ever started.
    expect(sub.started()).toBe(false)
  })
})
