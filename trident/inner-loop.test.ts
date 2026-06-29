/**
 * Tests for the Trident v2 inner-loop LAUNCHER (`buildWorkflowInnerLoop`).
 *
 * The launcher runs ONE substrate turn that invokes the `Workflow` tool on
 * `inner-workflow.mjs` and reports `TRIDENT_RESULT=<json>`. These tests inject a
 * FAKE substrate whose `start()` yields scripted token + completion events, so
 * the launcher mechanics (tool surface, args, result parsing, false-completion
 * discipline, timeout) are exercised WITHOUT a live claude / Workflow tool.
 */

import { describe, expect, test } from 'bun:test'
import type { Event } from '../runtime/events.ts'
import type { SessionHandle } from '../runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '../runtime/substrate.ts'
import {
  buildWorkflowInnerLoop,
  parseTridentResult,
  type InnerLoopInput,
} from './inner-loop.ts'
import type { TridentRun } from './store.ts'

const completion = (): Event => ({
  kind: 'completion',
  usage: { input_tokens: 1, output_tokens: 1 },
  substrate_instance_id: 'mock',
})

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

/** A fake substrate whose `start` replays a scripted event list + records the
 *  spec it was handed + cwd it was built with + whether `cancel()` fired. */
function fakeSubstrate(
  script: (spec: AgentSpec) => Event[],
  opts: { hang?: boolean; throwOnStart?: boolean } = {},
): { build: (cwd: string) => Substrate; specs: AgentSpec[]; cwds: string[]; cancelled: () => boolean } {
  const specs: AgentSpec[] = []
  const cwds: string[] = []
  let cancelled = false
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      if (opts.throwOnStart === true) throw new Error('cold-start failed')
      const events = script(spec)
      let release: (() => void) | null = null
      const blocked = new Promise<void>((r) => (release = r))
      async function* gen(): AsyncGenerator<Event> {
        for (const ev of events) yield ev
        if (opts.hang === true) await blocked
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {
          cancelled = true
          if (release !== null) release()
        },
        tool_resolution: 'internal',
      }
    },
  }
  return {
    build: (cwd: string) => {
      cwds.push(cwd)
      return substrate
    },
    specs,
    cwds,
    cancelled: () => cancelled,
  }
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

describe('buildWorkflowInnerLoop — launcher mechanics', () => {
  test('a completed turn with a TRIDENT_RESULT line → parsed result', async () => {
    const fake = fakeSubstrate(() => [
      { kind: 'token', text: 'invoked the Workflow tool…\n' },
      {
        kind: 'token',
        text: 'TRIDENT_RESULT={"ok":true,"prNumber":42,"branch":"trident/add-widget","verdict":"APPROVE","round":2,"checkpoint":"argus-approved"}',
      },
      completion(),
    ])
    const loop = buildWorkflowInnerLoop({ build_substrate: fake.build })
    const res = await loop(input())

    expect(res.status).toBe('completed')
    expect(res.verdict).toBe('APPROVE')
    expect(res.pr_number).toBe(42)
    expect(res.branch).toBe('trident/add-widget')
    expect(res.round).toBe(2)
    expect(res.checkpoint).toBe('argus-approved')
  })

  test('REQUEST_CHANGES round-trips as a verdict (maxRounds exhausted upstream)', async () => {
    const fake = fakeSubstrate(() => [
      { kind: 'token', text: 'TRIDENT_RESULT={"ok":true,"prNumber":9,"verdict":"REQUEST_CHANGES","round":3}' },
      completion(),
    ])
    const loop = buildWorkflowInnerLoop({ build_substrate: fake.build })
    const res = await loop(input())
    expect(res.status).toBe('completed')
    expect(res.verdict).toBe('REQUEST_CHANGES')
    expect(res.pr_number).toBe(9)
  })

  test('the launcher spec carries the Workflow tool surface + scriptPath + args', async () => {
    const fake = fakeSubstrate(() => [
      { kind: 'token', text: 'TRIDENT_RESULT={"verdict":"APPROVE"}' },
      completion(),
    ])
    const loop = buildWorkflowInnerLoop({
      build_substrate: fake.build,
      workflow_script_path: '/abs/inner-workflow.mjs',
    })
    await loop(input({ run: makeRun({ worktree: '/wt/run-1', task: 'do the thing' }) }))

    expect(fake.specs).toHaveLength(1)
    const spec = fake.specs[0]!
    const toolNames = spec.tools.map((t) => t.name)
    expect(toolNames).toEqual(['Workflow', 'Agent', 'Bash', 'Edit', 'Read'])
    expect(spec.prompt).toContain('/abs/inner-workflow.mjs')
    expect(spec.prompt).toContain('do the thing')
    expect(spec.prompt).toContain('TRIDENT_RESULT=')
    // Defense-in-depth: the launcher must tell the model to pass `args` as a
    // structured JSON object, not a JSON-encoded string (a real run showed the
    // model stringifying it, which zeroes out every workflow field).
    expect(spec.prompt).toContain('STRUCTURED JSON OBJECT')
    // Built rooted at the run's worktree.
    expect(fake.cwds).toEqual(['/wt/run-1'])
  })

  test('the launcher spec pins a NON-EMPTY model_preference (persistent-REPL rejects [])', async () => {
    // Regression guard: the persistent-REPL substrate throws
    // `persistent-repl: model_preference is empty; at least one model required`
    // when `spec.model_preference[0]` is undefined, so a launcher spec with `[]`
    // can NEVER spawn — the inner loop dies at start() before invoking Workflow.
    // (Real-run blocker the fake-substrate unit tests previously missed.)
    const fake = fakeSubstrate(() => [
      { kind: 'token', text: 'TRIDENT_RESULT={"verdict":"APPROVE"}' },
      completion(),
    ])
    const loop = buildWorkflowInnerLoop({ build_substrate: fake.build })
    await loop(input())
    expect(fake.specs[0]!.model_preference.length).toBeGreaterThan(0)
    expect(fake.specs[0]!.model_preference[0]).toBeTruthy()
  })

  test('the launcher model is overridable via opts.model', async () => {
    const fake = fakeSubstrate(() => [
      { kind: 'token', text: 'TRIDENT_RESULT={"verdict":"APPROVE"}' },
      completion(),
    ])
    const loop = buildWorkflowInnerLoop({ build_substrate: fake.build, model: 'claude-opus-4-8' })
    await loop(input())
    expect(fake.specs[0]!.model_preference).toEqual(['claude-opus-4-8'])
  })

  test('args thread resume_checkpoint + existing pr/branch for idempotent resume', async () => {
    const fake = fakeSubstrate(() => [
      { kind: 'token', text: 'TRIDENT_RESULT={"verdict":"APPROVE"}' },
      completion(),
    ])
    const loop = buildWorkflowInnerLoop({ build_substrate: fake.build })
    await loop(input({ run: makeRun({ pr: 55 }), resume_checkpoint: 'argus-request-changes' }))
    const prompt = fake.specs[0]!.prompt
    expect(prompt).toContain('"prNumber":55')
    expect(prompt).toContain('"resumeCheckpoint":"argus-request-changes"')
  })

  test('a completed turn with NO parseable result line → failed (no silent success)', async () => {
    const fake = fakeSubstrate(() => [
      { kind: 'token', text: 'I ran the workflow but forgot the result line' },
      completion(),
    ])
    const loop = buildWorkflowInnerLoop({ build_substrate: fake.build })
    const res = await loop(input())
    expect(res.status).toBe('failed')
    expect(res.verdict).toBeNull()
  })

  test('a stream that ENDS WITHOUT a terminal completion → failed (paused ≠ finished)', async () => {
    const fake = fakeSubstrate(() => [
      { kind: 'token', text: 'TRIDENT_RESULT={"verdict":"APPROVE"}' },
      // no completion(), no error — channel just closes.
    ])
    const loop = buildWorkflowInnerLoop({ build_substrate: fake.build })
    const res = await loop(input())
    expect(res.status).toBe('failed')
  })

  test('an error event → failed and cancels', async () => {
    const fake = fakeSubstrate(() => [
      { kind: 'token', text: 'partial' },
      { kind: 'error', message: 'overloaded', retryable: true },
    ])
    const loop = buildWorkflowInnerLoop({ build_substrate: fake.build })
    const res = await loop(input())
    expect(res.status).toBe('failed')
    expect(fake.cancelled()).toBe(true)
  })

  test('a build_substrate that throws → failed (crashed launcher)', async () => {
    const loop = buildWorkflowInnerLoop({
      build_substrate: () => {
        throw new Error('empty credential pool')
      },
    })
    const res = await loop(input())
    expect(res.status).toBe('failed')
  })

  test('a turn that never completes is cancelled at timeout_ms → timed_out', async () => {
    const fake = fakeSubstrate(() => [{ kind: 'token', text: 'thinking…' }], { hang: true })
    let fire: (() => void) | null = null
    const loop = buildWorkflowInnerLoop({
      build_substrate: fake.build,
      set_timer: (fn) => {
        fire = fn
        return 1
      },
      clear_timer: () => {},
    })
    const p = loop(input())
    await Promise.resolve()
    expect(fire).not.toBeNull()
    fire!()
    const res = await p
    expect(res.status).toBe('timed_out')
    expect(fake.cancelled()).toBe(true)
  })
})
