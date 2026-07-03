/**
 * Tests for the bounded Forge merge-conflict resolver (#342).
 *
 * Pins the terminal-marker parsing (RESOLVED / ESCALATE), the conservative
 * escalation on an ambiguous/absent marker, the per-cwd substrate factory + the
 * tool-less conflict prompt, and the crash/timeout → escalate discipline —
 * against a mocked `Substrate`, no real REPL.
 */

import { describe, expect, test } from 'bun:test'
import type { AgentSpec, Substrate } from '../runtime/substrate.ts'
import type { SessionHandle } from '../runtime/session-handle.ts'
import type { Event } from '../runtime/events.ts'
import { buildForgeConflictResolver } from './conflict-resolver.ts'
import type { TridentRun } from './store.ts'

const completion = (): Event => ({
  kind: 'completion',
  usage: { input_tokens: 1, output_tokens: 1 },
  substrate_instance_id: 'mock',
})

/** A mocked per-cwd substrate factory that replays a scripted terminal text. */
function scriptedFactory(
  text: string,
  opts: { throwOnStart?: boolean; hang?: boolean } = {},
): { build: (cwd: string) => Substrate; cwds: string[]; specs: AgentSpec[] } {
  const cwds: string[] = []
  const specs: AgentSpec[] = []
  const build = (cwd: string): Substrate => {
    cwds.push(cwd)
    return {
      start(spec: AgentSpec): SessionHandle {
        specs.push(spec)
        if (opts.throwOnStart === true) throw new Error('cold start failed')
        let cancelSignal: (() => void) | null = null
        const cancelled = new Promise<void>((r) => {
          cancelSignal = r
        })
        async function* gen(): AsyncGenerator<Event> {
          yield { kind: 'token', text }
          if (opts.hang === true) {
            await cancelled
            return
          }
          yield completion()
        }
        return {
          events: gen(),
          async respondToTool(): Promise<void> {
            throw new Error('no tools')
          },
          async cancel(): Promise<void> {
            if (cancelSignal !== null) cancelSignal()
          },
          tool_resolution: 'internal',
        }
      },
    }
  }
  return { build, cwds, specs }
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
    repo_path: '/proj/code',
    worktree: null,
    task: 'add a ring buffer flush()',
    chat_id: null,
    thread_id: null,
    channel_kind: 'app_socket',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

const input = () => ({
  repo_path: '/proj/code',
  branch: 'trident/flush-fix',
  base_branch: 'main',
  run: run(),
  conflicted_files: ['flush.ts', 'ring.ts'],
})

describe('buildForgeConflictResolver', () => {
  test('RESOLVED marker → resolved:true; roots the substrate at the repo + tool-less prompt names the files', async () => {
    const f = scriptedFactory('...work...\nRESOLVED')
    const resolve = buildForgeConflictResolver({ build_substrate: f.build })
    const out = await resolve(input())
    expect(out).toEqual({ resolved: true })
    // Built once, rooted at the conflicted working tree.
    expect(f.cwds).toEqual(['/proj/code'])
    // The Forge turn is tool-less (the CC subprocess drives its own tools) and
    // the prompt lists the conflicted files + forbids `rebase --continue`.
    expect(f.specs[0]!.tools).toEqual([])
    expect(f.specs[0]!.prompt).toContain('flush.ts, ring.ts')
    expect(f.specs[0]!.prompt).toContain('rebase --continue')
    expect(f.specs[0]!.model_preference.length).toBeGreaterThan(0)
  })

  test('ESCALATE: <question> → resolved:false with the specific question', async () => {
    const q = 'flush.ts: drop-oldest vs block — which behaviour do you want?'
    const f = scriptedFactory(`I cannot safely merge these.\nESCALATE: ${q}`)
    const resolve = buildForgeConflictResolver({ build_substrate: f.build })
    const out = await resolve(input())
    expect(out.resolved).toBe(false)
    expect(out).toMatchObject({ resolved: false, question: q })
  })

  test('ESCALATE wins even if a stray RESOLVED also appears', async () => {
    const f = scriptedFactory('RESOLVED maybe?\nESCALATE: still ambiguous, which side wins?')
    const resolve = buildForgeConflictResolver({ build_substrate: f.build })
    const out = await resolve(input())
    expect(out.resolved).toBe(false)
    expect((out as { question: string }).question).toContain('which side wins')
  })

  test('no clear marker → escalates conservatively (never a silent resolve)', async () => {
    const f = scriptedFactory('I looked at the files and hmm.')
    const resolve = buildForgeConflictResolver({ build_substrate: f.build })
    const out = await resolve(input())
    expect(out.resolved).toBe(false)
    expect((out as { question: string }).question).toMatch(/flush\.ts, ring\.ts/)
  })

  test('a substrate that fails to start → escalates (never resolves a conflict it never touched)', async () => {
    const f = scriptedFactory('RESOLVED', { throwOnStart: true })
    const resolve = buildForgeConflictResolver({ build_substrate: f.build })
    const out = await resolve(input())
    expect(out.resolved).toBe(false)
  })

  test('a timeout cancels the turn and escalates', async () => {
    const f = scriptedFactory('RESOLVED', { hang: true })
    let fire: () => void = () => {}
    const resolve = buildForgeConflictResolver({
      build_substrate: f.build,
      timeout_ms: 1000,
      set_timer: (fn) => {
        fire = fn
        return 1
      },
      clear_timer: () => {},
    })
    const p = resolve(input())
    // Trip the timeout immediately.
    fire()
    const out = await p
    expect(out.resolved).toBe(false)
    expect((out as { question: string }).question).toContain('timed out')
  })
})
