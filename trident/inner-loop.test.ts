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
import {
  buildWorkflowFirer,
  buildSubstrateWorkflowFire,
  parseInnerResult,
  WORKFLOW_FIRE_TOOL_NAMES,
  type FireInnerWorkflow,
  type FireInnerWorkflowInput,
  type FireOutcome,
  type InnerLoopInput,
} from './inner-loop.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
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
    inner_result: null,
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

describe('parseInnerResult — decode the typed terminal column', () => {
  test('parses a full result object', () => {
    const raw = JSON.stringify({
      ok: true,
      prNumber: 7,
      branch: 'feat-x',
      verdict: 'APPROVE',
      round: 2,
      checkpoint: 'argus-approved',
    })
    expect(parseInnerResult(raw)).toEqual({
      ok: true,
      verdict: 'APPROVE',
      pr_number: 7,
      branch: 'feat-x',
      round: 2,
      checkpoint: 'argus-approved',
    })
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
      pr_number: null,
      branch: null,
      round: 0,
      checkpoint: null,
    })
  })
})

describe('buildWorkflowFirer — fire mechanics over a fire seam', () => {
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

  test('a settle-timeout → failed + cancels the turn', async () => {
    // The events iterator hangs forever; the settle timer fires + cancels.
    let cancelled = false
    const substrate: Substrate = {
      start(): SessionHandle {
        return {
          events: (async function* () {
            await new Promise<void>((resolve) => {
              // resolve only when cancelled, so the for-await loop can end.
              const iv = setInterval(() => {
                if (cancelled) {
                  clearInterval(iv)
                  resolve()
                }
              }, 1)
            })
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
    expect(res.status).toBe('failed')
    expect(res.error).toContain('did not settle')
    expect(cancelled).toBe(true)
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
