/**
 * Tests for the bounded Fable build-escalation arbiter.
 *
 * Pins the decision/owner-only marker protocol, authority guards, exact
 * read-only tool grant, per-run cap, and every turn failure → unavailable
 * discipline against a mocked `Substrate`, with no real model process.
 */

import { describe, expect, test } from 'bun:test'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { FABLE_MODEL } from '@neutronai/runtime/models.ts'
import {
  ARBITER_TOOL_NAMES,
  FORBIDDEN_OPTION_IDS,
  assertArbitrableOptions,
  buildFableArbiter,
  isOwnerOnlyQuestion,
} from './arbiter.ts'
import type { ArbitrationInput } from './arbiter.ts'
import type { TridentRun } from './store.ts'

const completion = (): Event => ({
  kind: 'completion',
  usage: { input_tokens: 1, output_tokens: 1 },
  substrate_instance_id: 'mock',
})

interface ScriptedFactoryOptions {
  throwOnStart?: boolean
  error?: boolean
  crash?: boolean
  hang?: boolean
}

/** A mocked per-cwd substrate factory that replays a scripted turn. */
function scriptedFactory(
  text: string,
  opts: ScriptedFactoryOptions = {},
): {
  build: (cwd: string) => Substrate
  cwds: string[]
  specs: AgentSpec[]
  starts: { count: number }
  cancels: { count: number }
} {
  const cwds: string[] = []
  const specs: AgentSpec[] = []
  const starts = { count: 0 }
  const cancels = { count: 0 }
  const build = (cwd: string): Substrate => {
    cwds.push(cwd)
    return {
      start(spec: AgentSpec): SessionHandle {
        starts.count += 1
        specs.push(spec)
        if (opts.throwOnStart === true) throw new Error('cold start failed')
        let cancelSignal: (() => void) | null = null
        const cancelled = new Promise<void>((resolve) => {
          cancelSignal = resolve
        })
        async function* gen(): AsyncGenerator<Event> {
          yield { kind: 'token', text }
          if (opts.error === true) {
            yield { kind: 'error', message: 'turn failed', retryable: false }
            return
          }
          if (opts.crash === true) throw new Error('event stream crashed')
          if (opts.hang === true) {
            await cancelled
            return
          }
          yield completion()
        }
        return {
          events: gen(),
          async respondToTool(): Promise<void> {
            throw new Error('tools resolve internally')
          },
          async cancel(): Promise<void> {
            cancels.count += 1
            if (cancelSignal !== null) cancelSignal()
          },
          tool_resolution: 'internal',
        }
      },
    }
  }
  return { build, cwds, specs, starts, cancels }
}

function run(over: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'r1',
    slug: 'flush-fix',
    project_slug: 'proj',
    phase: 'done',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'trident/flush-fix',
    pr: null,
    merge_mode: 'local',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/tmp/fake',
    worktree: null,
    task: 'add a ring buffer flush()',
    chat_id: null,
    thread_id: null,
    channel_kind: 'app_socket',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_checkpoint_head: null,
    inner_checkpoint_findings: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    harvested_at: null,
    crash_recoveries: 0,
    infra_retries: 0,
    reviewed_head: null,
    bound_pr: null,
    fenced_paths: null,
    ...over,
  }
}

function input(over: Partial<ArbitrationInput> = {}): ArbitrationInput {
  return {
    run: run(),
    repo_path: '/tmp/fake',
    question: 'Which side of the flush() conflict is correct?',
    evidence: 'walstore vs ringbuf: the implementations disagree about backpressure',
    options: [
      { id: 'retry-resolution', description: 'Try the resolver with targeted guidance' },
      { id: 'rebuild', description: 'Rebuild the branch from the new base' },
      { id: 'stop', description: 'Stop because neither path can be made safe' },
    ],
    ...over,
  }
}

describe('buildFableArbiter', () => {
  test('DECISION plus REASONING selects an offered option', async () => {
    const f = scriptedFactory(
      'Inspection complete.\nDECISION: rebuild\nREASONING: The base changed the same invariant; a clean rebuild is safer.',
    )
    const arbitrate = buildFableArbiter({ build_substrate: f.build })

    expect(await arbitrate(input())).toEqual({
      kind: 'decision',
      option_id: 'rebuild',
      reasoning: 'The base changed the same invariant; a clean rebuild is safer.',
    })
  })

  test('option-id matching is case- and whitespace-insensitive', async () => {
    const f = scriptedFactory('DECISION:  Rebuild  \nREASONING: Verified the conflict.')
    const arbitrate = buildFableArbiter({ build_substrate: f.build })

    expect(await arbitrate(input())).toEqual({
      kind: 'decision',
      option_id: 'rebuild',
      reasoning: 'Verified the conflict.',
    })
  })

  test('an unoffered decision degrades to unavailable instead of guessing', async () => {
    const f = scriptedFactory('DECISION: retry-ish\nREASONING: Close enough?')
    const arbitrate = buildFableArbiter({ build_substrate: f.build })

    const outcome = await arbitrate(input())
    expect(outcome.kind).toBe('unavailable')
    expect((outcome as { reason: string }).reason).toContain('not offered')
  })

  test('OWNER_ONLY carries the emitted owner question', async () => {
    const f = scriptedFactory('OWNER_ONLY: Should I purchase the hosted runner for $40/month?')
    const arbitrate = buildFableArbiter({ build_substrate: f.build })

    expect(await arbitrate(input())).toEqual({
      kind: 'owner-only',
      question: 'Should I purchase the hosted runner for $40/month?',
    })
  })

  test('OWNER_ONLY wins when a turn emits both markers', async () => {
    const f = scriptedFactory(
      'DECISION: rebuild\nREASONING: Technically sound.\nOWNER_ONLY: Which product priority should win?',
    )
    const arbitrate = buildFableArbiter({ build_substrate: f.build })

    expect(await arbitrate(input())).toEqual({
      kind: 'owner-only',
      question: 'Which product priority should win?',
    })
  })

  test('no terminal marker degrades to unavailable', async () => {
    const f = scriptedFactory('I inspected the repository but did not decide.')
    const arbitrate = buildFableArbiter({ build_substrate: f.build })

    expect(await arbitrate(input())).toEqual({
      kind: 'unavailable',
      reason: 'the arbiter returned no clear result',
    })
  })

  test('an error event degrades to unavailable', async () => {
    const f = scriptedFactory('', { error: true })
    const arbitrate = buildFableArbiter({ build_substrate: f.build })

    expect(await arbitrate(input())).toEqual({
      kind: 'unavailable',
      reason: 'the arbiter turn errored',
    })
    expect(f.cancels.count).toBe(1)
  })

  test('a substrate start throw degrades to unavailable', async () => {
    const f = scriptedFactory('', { throwOnStart: true })
    const arbitrate = buildFableArbiter({ build_substrate: f.build })

    expect(await arbitrate(input())).toEqual({
      kind: 'unavailable',
      reason: 'the arbiter could not start',
    })
  })

  test('a crashing event stream degrades to unavailable', async () => {
    const f = scriptedFactory('', { crash: true })
    const arbitrate = buildFableArbiter({ build_substrate: f.build })

    expect(await arbitrate(input())).toEqual({
      kind: 'unavailable',
      reason: 'the arbiter turn crashed',
    })
  })

  test('a timeout cancels the handle and degrades to unavailable', async () => {
    const f = scriptedFactory('', { hang: true })
    const arbitrate = buildFableArbiter({
      build_substrate: f.build,
      timeout_ms: 1000,
      set_timer: (fn) => {
        fn()
        return 1
      },
      clear_timer: () => {},
    })

    expect(await arbitrate(input())).toEqual({
      kind: 'unavailable',
      reason: 'the arbiter timed out',
    })
    expect(f.cancels.count).toBe(1)
  })

  test('owner-only pre-guard catches spend, production deploy, and external send without a turn', async () => {
    const questions = [
      'Should I spend $40/month on a hosted runner for this?',
      'Deploy this build to production now?',
      'Send the invoice email to the client?',
    ]

    for (const question of questions) {
      const f = scriptedFactory('DECISION: rebuild')
      const arbitrate = buildFableArbiter({ build_substrate: f.build })
      expect(await arbitrate(input({ question }))).toEqual({ kind: 'owner-only', question })
      expect(f.starts.count).toBe(0)
      expect(f.cwds).toEqual([])
    }
  })

  test('publishing a branch is not publishing a release', () => {
    expect(
      isOwnerOnlyQuestion(
        'Should I publish the branch and open a PR despite the flaky pre-existing test?',
      ),
    ).toBe(false)
  })

  test('forbidden options are rejected without starting a turn', async () => {
    for (const id of ['approve', 'merge', 'skip-review']) {
      const f = scriptedFactory('DECISION: stop')
      const arbitrate = buildFableArbiter({ build_substrate: f.build })
      const outcome = await arbitrate(input({ options: [{ id, description: 'Not allowed' }] }))
      expect(outcome.kind).toBe('unavailable')
      expect((outcome as { reason: string }).reason).toContain('forbidden')
      expect(f.starts.count).toBe(0)
      expect(f.cwds).toEqual([])
    }
  })

  test('assertArbitrableOptions throws TypeError for every forbidden id and an empty list', () => {
    expect(() => assertArbitrableOptions([])).toThrow(TypeError)
    for (const id of FORBIDDEN_OPTION_IDS) {
      expect(() =>
        assertArbitrableOptions([{ id: `  ${id.toUpperCase()}  `, description: 'No' }]),
      ).toThrow(TypeError)
    }
  })

  test('the exact read-only tool surface and bounded prompt reach the substrate', async () => {
    const f = scriptedFactory('DECISION: stop\nREASONING: Verified the repository state.')
    const arbitrate = buildFableArbiter({ build_substrate: f.build })
    await arbitrate(input())

    expect(f.specs[0]!.tools.map((tool) => tool.name)).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Bash',
    ])
    expect(f.specs[0]!.tools.map((tool) => tool.name)).toEqual([...ARBITER_TOOL_NAMES])
    expect(f.specs[0]!.prompt).toContain('OWNER_ONLY')
    expect(f.specs[0]!.prompt).toContain('DECISION:')
    expect(f.specs[0]!.prompt).toContain('NEVER edit')
    expect(f.specs[0]!.prompt).toContain('git add')
    expect(f.specs[0]!.prompt).toContain('pkill')
    expect(f.specs[0]!.model_preference).toEqual([FABLE_MODEL])
    expect(f.cwds).toEqual(['/tmp/fake'])
  })

  test('the invocation cap is per run and a different run still gets a turn', async () => {
    const f = scriptedFactory('DECISION: rebuild\nREASONING: Verified.')
    const arbitrate = buildFableArbiter({
      build_substrate: f.build,
      max_invocations_per_run: 2,
    })

    expect((await arbitrate(input())).kind).toBe('decision')
    expect((await arbitrate(input())).kind).toBe('decision')
    const capped = await arbitrate(input())
    expect(capped.kind).toBe('unavailable')
    expect((capped as { reason: string }).reason).toContain('cap')
    expect(f.starts.count).toBe(2)

    expect((await arbitrate(input({ run: run({ id: 'r2' }) }))).kind).toBe('decision')
    expect(f.starts.count).toBe(3)
  })

  test('a turn that errors still spends invocation budget', async () => {
    const f = scriptedFactory('', { error: true })
    const arbitrate = buildFableArbiter({
      build_substrate: f.build,
      max_invocations_per_run: 1,
    })

    expect((await arbitrate(input())).kind).toBe('unavailable')
    const capped = await arbitrate(input())
    expect(capped.kind).toBe('unavailable')
    expect((capped as { reason: string }).reason).toContain('cap')
    expect(f.starts.count).toBe(1)
  })
})
