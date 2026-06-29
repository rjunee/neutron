/**
 * Tests for the Trident v2 inner-loop LAUNCHER (`buildWorkflowInnerLoop`) and the
 * production print-mode launcher (`buildClaudePrintLauncher`).
 *
 * The launcher spawns a BLOCKING `claude -p` print-mode process that invokes the
 * `Workflow` tool on `inner-workflow.mjs`, drains the background workflow to
 * completion, and prints `TRIDENT_RESULT=<json>`. These tests inject a FAKE
 * `LaunchInnerWorkflow` (for the loop mechanics) and a FAKE `spawn` (for the
 * print-mode launcher), so everything is exercised WITHOUT a live claude /
 * Workflow tool.
 *
 * THE REGRESSION THIS SUITE PINS: the pre-fix launcher ran as a persistent-REPL
 * turn that settled on the FIRST reply — i.e. it could resolve BEFORE
 * TRIDENT_RESULT existed (the background workflow was still running and got
 * aborted). Two guards encode "the launcher does NOT settle before the workflow
 * produces a terminal result":
 *   (1) `buildClaudePrintLauncher` resolves ONLY on the child's `close` event
 *       (by which point print-mode has drained the workflow), never earlier.
 *   (2) `buildWorkflowInnerLoop` maps a clean exit with NO parseable
 *       TRIDENT_RESULT to `failed` (no silent success).
 */

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  buildWorkflowInnerLoop,
  buildClaudePrintLauncher,
  buildClaudePrintArgs,
  parseTridentResult,
  type InnerLoopInput,
  type LaunchInnerWorkflow,
  type LaunchInnerWorkflowResult,
} from './inner-loop.ts'
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

describe('buildWorkflowInnerLoop — launcher mechanics (over a print-mode launch seam)', () => {
  test('a clean exit (code 0) with a TRIDENT_RESULT line → parsed result', async () => {
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

  test('the launcher prompt carries the Workflow scriptPath + args + structured-JSON note, rooted at the worktree cwd', async () => {
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
    // …and to WAIT for the background workflow rather than settling on the
    // Workflow tool's immediate runId return (the bug this fix closes).
    expect(call.prompt.toLowerCase()).toContain('background')
    // The launcher process is rooted at the run's worktree.
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

  test('REGRESSION: a clean exit with NO parseable result line → failed (process exited before TRIDENT_RESULT existed)', async () => {
    // This is the EXACT pre-fix symptom: the launcher returned before the
    // background workflow produced a result. A clean exit with no result line
    // must be a LOUD failure, never a silent success.
    const { launch } = fakeLaunch(() => ({
      ...OK,
      stdout: 'I launched the workflow but the process exited before it finished',
    }))
    const loop = buildWorkflowInnerLoop({ launch })
    const res = await loop(input())
    expect(res.status).toBe('failed')
    expect(res.verdict).toBeNull()
  })

  test('a nonzero exit → failed even if a stray result line is present (crashed launcher)', async () => {
    const { launch } = fakeLaunch(() => ({
      ...OK,
      exit_code: 1,
      stdout: 'TRIDENT_RESULT={"verdict":"APPROVE"}',
    }))
    const loop = buildWorkflowInnerLoop({ launch })
    const res = await loop(input())
    expect(res.status).toBe('failed')
  })

  test('a spawn error → failed', async () => {
    const { launch } = fakeLaunch(() => ({
      stdout: '',
      stderr: '',
      exit_code: null,
      timed_out: false,
      spawn_error: 'claude -p spawn failed: ENOENT',
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

// ── The production print-mode launcher (`claude -p`) ──────────────────────────

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (sig?: string) => void
  killed: () => boolean
  killSignal: () => string | undefined
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let killed = false
  let sig: string | undefined
  child.kill = (s?: string) => {
    killed = true
    sig = s
  }
  child.killed = () => killed
  child.killSignal = () => sig
  return child
}

/** A fake `child_process.spawn` recording its (bin, args, opts) + handing back a
 *  controllable child. */
function fakeSpawn(): {
  spawn: (bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => FakeChild
  calls: Array<{ bin: string; args: string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } }>
  child: () => FakeChild
} {
  const calls: Array<{ bin: string; args: string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } }> =
    []
  let last: FakeChild | null = null
  const spawn = (bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    calls.push({ bin, args, opts })
    last = makeFakeChild()
    return last
  }
  return { spawn, calls, child: () => last! }
}

/** Flush enough microtasks that the launcher's `await resolve_auth_env()` +
 *  synchronous spawn have run and the child exists. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('buildClaudePrintArgs — print-mode argv', () => {
  test('uses -p (print mode), skip-permissions, and pins --model LAST', () => {
    const args = buildClaudePrintArgs('the prompt', 'opus')
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('the prompt')
    expect(args).toContain('--dangerously-skip-permissions')
    const mi = args.indexOf('--model')
    expect(mi).toBeGreaterThanOrEqual(0)
    expect(args[mi + 1]).toBe('opus')
    // No --tools restriction (trusted build path — full surface incl. Workflow).
    expect(args).not.toContain('--tools')
  })
  test('appends extra_args before --model', () => {
    const args = buildClaudePrintArgs('p', 'opus', ['--add-dir', '/repo'])
    expect(args.join(' ')).toContain('--add-dir /repo')
    expect(args.indexOf('--add-dir')).toBeLessThan(args.indexOf('--model'))
  })
})

describe('buildClaudePrintLauncher — blocking spawn that drains to close', () => {
  test('REGRESSION: resolves ONLY on the child close event, never before (drain-to-terminal)', async () => {
    const fs = fakeSpawn()
    const launch = buildClaudePrintLauncher({
      resolve_auth_env: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
      spawn: fs.spawn as never,
    })

    let settled = false
    const p = launch({ prompt: 'go', cwd: '/repo', timeout_ms: 60_000 }).then((r) => {
      settled = true
      return r
    })

    await flush()
    const child = fs.child()
    // The workflow's output streams in — but the process has NOT closed yet.
    child.stdout.emit('data', 'launched workflow…\n')
    await flush()
    // CRITICAL: the launcher must NOT have settled — the background workflow is
    // still running. (Pre-fix, the REPL turn settled here, aborting the workflow.)
    expect(settled).toBe(false)

    // The final turn (after the workflow drained) prints TRIDENT_RESULT, then the
    // process closes cleanly.
    child.stdout.emit('data', 'TRIDENT_RESULT={"verdict":"APPROVE","prNumber":7}\n')
    child.emit('close', 0)

    const res = await p
    expect(settled).toBe(true)
    expect(res.exit_code).toBe(0)
    expect(res.timed_out).toBe(false)
    expect(res.spawn_error).toBeNull()
    expect(parseTridentResult(res.stdout)).toEqual({ verdict: 'APPROVE', prNumber: 7 })
  })

  test('spawns the right bin/argv/cwd and layers the auth env over base_env', async () => {
    const fs = fakeSpawn()
    const launch = buildClaudePrintLauncher({
      resolve_auth_env: async () => ({
        CLAUDE_CODE_OAUTH_TOKEN: 'sekret',
        ANTHROPIC_API_KEY: undefined,
      }),
      claude_bin: '/opt/claude',
      model: 'opus',
      base_env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'inherited-should-be-scrubbed' },
      spawn: fs.spawn as never,
    })
    const p = launch({ prompt: 'go', cwd: '/work/tree', timeout_ms: 60_000 })
    await flush()
    const call = fs.calls[0]!
    expect(call.bin).toBe('/opt/claude')
    expect(call.args[0]).toBe('-p')
    expect(call.opts.cwd).toBe('/work/tree')
    // Auth overlay applied: the live secret is set…
    expect(call.opts.env!['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sekret')
    // …and the inherited API key is scrubbed to undefined (ISSUES #49).
    expect(call.opts.env!['ANTHROPIC_API_KEY']).toBeUndefined()
    // …while unrelated base env survives.
    expect(call.opts.env!['PATH']).toBe('/usr/bin')
    fs.child().emit('close', 0)
    await p
  })

  test('SIGKILLs the child + reports timed_out when the budget elapses', async () => {
    const fs = fakeSpawn()
    let fire: (() => void) | null = null
    const launch = buildClaudePrintLauncher({
      resolve_auth_env: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
      spawn: fs.spawn as never,
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
    expect(fs.child().killed()).toBe(true)
    expect(fs.child().killSignal()).toBe('SIGKILL')
  })

  test('a spawn that throws → spawn_error (never a silent success)', async () => {
    const launch = buildClaudePrintLauncher({
      resolve_auth_env: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
      spawn: (() => {
        throw new Error('ENOENT claude')
      }) as never,
    })
    const res = await launch({ prompt: 'go', cwd: '/repo', timeout_ms: 60_000 })
    expect(res.spawn_error).toContain('ENOENT claude')
    expect(res.exit_code).toBeNull()
  })

  test('an auth-env resolution failure → spawn_error (no process spawned)', async () => {
    const fs = fakeSpawn()
    const launch = buildClaudePrintLauncher({
      resolve_auth_env: async () => {
        throw new Error('all_cooldown')
      },
      spawn: fs.spawn as never,
    })
    const res = await launch({ prompt: 'go', cwd: '/repo', timeout_ms: 60_000 })
    expect(res.spawn_error).toContain('all_cooldown')
    expect(fs.calls).toHaveLength(0)
  })

  test('a child error event → spawn_error', async () => {
    const fs = fakeSpawn()
    const launch = buildClaudePrintLauncher({
      resolve_auth_env: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
      spawn: fs.spawn as never,
    })
    const p = launch({ prompt: 'go', cwd: '/repo', timeout_ms: 60_000 })
    await flush()
    fs.child().emit('error', new Error('broken pipe'))
    const res = await p
    expect(res.spawn_error).toContain('broken pipe')
  })
})
