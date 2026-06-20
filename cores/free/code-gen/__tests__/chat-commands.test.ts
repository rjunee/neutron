/**
 * @neutronai/codegen-core — `/code` chat-command parser + dispatcher tests.
 *
 * Code-Gen Core S2: the user-facing chat surface is TWO commands —
 * `/code <task>` (autonomous build) and `/code stop`/`/code cancel`
 * (emergency stop). The 7 retired sub-commands (status / review /
 * merge / judge / history / automerge) must return a friendly reject.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CodegenOrchestrator,
  CodegenTaskNotFoundError,
  buildInMemoryCodegenRunner,
  buildSkeletonCodegenRunner,
  type CodegenTaskStatus,
} from '../src/backend.ts'
import {
  executeCodeCommand,
  parseAndExecuteCodeCommand,
  parseCodeCommand,
  type CodeCommandContext,
} from '../src/chat-commands.ts'
import { CodegenSidecarResolver } from '../src/sidecar/store.ts'

/* -------- parseCodeCommand: happy paths -------- */

describe('parseCodeCommand', () => {
  test('non-`/code` input returns unrecognized with `not_a_code_command`', () => {
    expect(parseCodeCommand('hello')).toEqual({ kind: 'unrecognized', reason: 'not_a_code_command' })
    expect(parseCodeCommand('/notes')).toEqual({ kind: 'unrecognized', reason: 'not_a_code_command' })
    // `/codefoo` is NOT a /code command — the verb must terminate on whitespace.
    expect(parseCodeCommand('/codex foo')).toEqual({ kind: 'unrecognized', reason: 'not_a_code_command' })
    expect(parseCodeCommand('/codefoo')).toEqual({ kind: 'unrecognized', reason: 'not_a_code_command' })
  })

  test('bare `/code` (no arg) renders help', () => {
    expect(parseCodeCommand('/code')).toEqual({ kind: 'help' })
    expect(parseCodeCommand('  /code  ')).toEqual({ kind: 'help' })
  })

  test('`/code help` renders help', () => {
    expect(parseCodeCommand('/code help')).toEqual({ kind: 'help' })
  })

  test('`/code <task description>` dispatches with the full task body', () => {
    expect(parseCodeCommand('/code add a /healthz endpoint')).toEqual({
      kind: 'dispatch',
      task: 'add a /healthz endpoint',
    })
    expect(parseCodeCommand('  /code  rewrite the foo router  ')).toEqual({
      kind: 'dispatch',
      task: 'rewrite the foo router',
    })
    expect(parseCodeCommand('/code hello world')).toEqual({
      kind: 'dispatch',
      task: 'hello world',
    })
  })

  test('`/code stop` parses with NO task_id', () => {
    const got = parseCodeCommand('/code stop')
    expect(got).toEqual({ kind: 'stop' })
  })

  test('`/code stop <task_id>` parses with explicit task_id', () => {
    expect(parseCodeCommand('/code stop abc123')).toEqual({ kind: 'stop', task_id: 'abc123' })
  })

  test('`/code cancel` parses identical to `/code stop`', () => {
    expect(parseCodeCommand('/code cancel')).toEqual({ kind: 'stop' })
    expect(parseCodeCommand('/code cancel def456')).toEqual({ kind: 'stop', task_id: 'def456' })
  })

  test('retired sub-verbs return a friendly reject pointing at the new shape', () => {
    for (const sub of ['status', 'review', 'merge', 'judge', 'history', 'automerge']) {
      const got = parseCodeCommand(`/code ${sub}`)
      expect(got.kind).toBe('unrecognized')
      if (got.kind === 'unrecognized') {
        expect(got.reason).toContain('no longer a /code sub-command')
        expect(got.reason).toContain(sub)
      }
    }
  })

  test('retired sub-verbs reject even with trailing arguments (don\'t fall through to dispatch)', () => {
    // `/code status abc-123` MUST NOT become a dispatch with task='status abc-123'.
    const got = parseCodeCommand('/code status abc-123')
    expect(got.kind).toBe('unrecognized')
    const got2 = parseCodeCommand('/code merge #5 confirm')
    expect(got2.kind).toBe('unrecognized')
  })
})

/* -------- executeCodeCommand: dispatch + stop + help -------- */

interface TestCtx {
  cleanup: () => void
  ctx: CodeCommandContext
}

function buildTestCtx(opts: {
  orchestratorOpts?: ConstructorParameters<typeof CodegenOrchestrator>[0]
} = {}): TestCtx {
  const tmp = mkdtempSync(join(tmpdir(), 'codegen-chat-test-'))
  const resolver = new CodegenSidecarResolver({ owner_home: tmp })
  const orchestrator = new CodegenOrchestrator(
    opts.orchestratorOpts ?? { runner: buildSkeletonCodegenRunner() },
  )
  const ctx: CodeCommandContext = {
    orchestrator,
    resolve_sidecar: (pid: string) => resolver.resolve(pid),
    project_id: 'proj-a',
    user_id: 'u1',
    now: new Date(),
  }
  return {
    ctx,
    cleanup: () => {
      resolver.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

describe('executeCodeCommand — help', () => {
  test('returns the HELP_TEXT cheatsheet', async () => {
    const t = buildTestCtx()
    try {
      const out = await executeCodeCommand({ kind: 'help' }, t.ctx)
      expect(out.text).toContain('Code-Gen Core')
      expect(out.text).toContain('/code <task description>')
      expect(out.text).toContain('/code stop')
      expect(out.text).toContain('Auto-merge is ON by default')
      // Retired sub-commands must NOT appear in the cheatsheet.
      expect(out.text).not.toContain('/code status')
      expect(out.text).not.toContain('/code review')
      expect(out.text).not.toContain('/code merge')
      expect(out.text).not.toContain('/code judge')
      expect(out.text).not.toContain('/code history')
      expect(out.text).not.toContain('/code automerge')
    } finally {
      t.cleanup()
    }
  })
})

describe('executeCodeCommand — dispatch', () => {
  test('calls orchestrator.dispatch and replies with the task_id', async () => {
    const t = buildTestCtx({
      orchestratorOpts: {
        runner: buildInMemoryCodegenRunner({
          results: [{ pr_number: 1, branch: 'feat/x', worktree: '/x', summary: 's' }],
        }),
      },
    })
    try {
      const out = await executeCodeCommand(
        { kind: 'dispatch', task: 'add a /healthz endpoint' },
        t.ctx,
      )
      expect(out.text).toContain('Building')
      expect(out.text).toContain('add a /healthz endpoint')
      const data = out.data as { task_id?: string }
      expect(typeof data.task_id).toBe('string')
      expect((data.task_id ?? '').length).toBeGreaterThan(0)
    } finally {
      t.cleanup()
    }
  })

  test('CodegenInputError from the orchestrator becomes a malformed reply', async () => {
    const t = buildTestCtx()
    try {
      // Empty task body trips validateDispatchInput → CodegenInputError.
      const out = await executeCodeCommand(
        { kind: 'dispatch', task: '   ' },
        t.ctx,
      )
      expect(out.text).toContain('rejected')
      expect(out.error?.code).toBe('malformed')
    } finally {
      t.cleanup()
    }
  })
})

describe('executeCodeCommand — stop (explicit task_id)', () => {
  test('hand-rolled orchestrator stub: cancels with prior_status running', async () => {
    let cancelArg: { task_id: string } | undefined
    const fakeOrchestrator = {
      dispatch: async () => {
        throw new Error('not used')
      },
      status: () => {
        throw new Error('not used')
      },
      fetch: () => {
        throw new Error('not used')
      },
      cancel: (input: { task_id: string }) => {
        cancelArg = input
        return { cancelled: true, prior_status: 'running' as CodegenTaskStatus }
      },
    }
    const tmp = mkdtempSync(join(tmpdir(), 'codegen-chat-stop-'))
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    try {
      const ctx: CodeCommandContext = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        orchestrator: fakeOrchestrator as any,
        resolve_sidecar: (pid: string) => resolver.resolve(pid),
        project_id: 'proj-a',
        user_id: 'u1',
        now: new Date(),
      }
      const out = await executeCodeCommand(
        { kind: 'stop', task_id: 'task-xyz-123' },
        ctx,
      )
      expect(cancelArg).toEqual({ task_id: 'task-xyz-123' })
      expect(out.text).toContain('Cancelled')
      expect(out.text).toContain('task-xyz')
      const data = out.data as { cancelled?: boolean; prior_status?: string }
      expect(data.cancelled).toBe(true)
      expect(data.prior_status).toBe('running')
    } finally {
      resolver.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('explicit task_id with unknown id surfaces unknown_task error', async () => {
    const fakeOrchestrator = {
      dispatch: async () => {
        throw new Error('not used')
      },
      status: () => {
        throw new Error('not used')
      },
      fetch: () => {
        throw new Error('not used')
      },
      cancel: (input: { task_id: string }) => {
        throw new CodegenTaskNotFoundError(input.task_id)
      },
    }
    const tmp = mkdtempSync(join(tmpdir(), 'codegen-chat-stop-missing-'))
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    try {
      const ctx: CodeCommandContext = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        orchestrator: fakeOrchestrator as any,
        resolve_sidecar: (pid: string) => resolver.resolve(pid),
        project_id: 'proj-a',
        user_id: 'u1',
        now: new Date(),
      }
      const out = await executeCodeCommand(
        { kind: 'stop', task_id: 'nope-nope' },
        ctx,
      )
      expect(out.text).toContain('No task')
      expect(out.error?.code).toBe('unknown_task')
    } finally {
      resolver.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('executeCodeCommand — stop (no task_id, resolves most-recent in-flight)', () => {
  test('returns no-in-flight reply when sidecar has no tasks', async () => {
    const t = buildTestCtx()
    try {
      const out = await executeCodeCommand({ kind: 'stop' }, t.ctx)
      expect(out.text).toContain('No in-flight Code-Gen task')
      expect(out.text).toContain('proj-a')
    } finally {
      t.cleanup()
    }
  })

  test('finds most-recent running task in sidecar and cancels it', async () => {
    let cancelArg: { task_id: string } | undefined
    const fakeOrchestrator = {
      dispatch: async () => {
        throw new Error('not used')
      },
      status: () => {
        throw new Error('not used')
      },
      fetch: () => {
        throw new Error('not used')
      },
      cancel: (input: { task_id: string }) => {
        cancelArg = input
        return { cancelled: true, prior_status: 'running' as CodegenTaskStatus }
      },
    }
    const tmp = mkdtempSync(join(tmpdir(), 'codegen-chat-stop-resolve-'))
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    try {
      // Seed two rows: an older completed task, and a newer running task.
      const sidecar = await resolver.resolve('proj-a')
      sidecar.tasks.insert({
        task_id: 't-old-completed',
        request: 'old',
        status: 'pending',
      })
      sidecar.tasks.update('t-old-completed', { status: 'completed' })
      // Give the second row a strictly later updated_at by sleeping
      // until the unix-ms tick increments — sidecar.now uses Date.now().
      await new Promise((r) => setTimeout(r, 5))
      sidecar.tasks.insert({
        task_id: 't-new-running',
        request: 'new',
        status: 'pending',
      })
      sidecar.tasks.update('t-new-running', { status: 'running' })

      const ctx: CodeCommandContext = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        orchestrator: fakeOrchestrator as any,
        resolve_sidecar: (pid: string) => resolver.resolve(pid),
        project_id: 'proj-a',
        user_id: 'u1',
        now: new Date(),
      }
      const out = await executeCodeCommand({ kind: 'stop' }, ctx)
      expect(cancelArg).toEqual({ task_id: 't-new-running' })
      expect(out.text).toContain('Cancelled')
      expect(out.text).toContain('t-new-ru')
    } finally {
      resolver.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

/* -------- parseAndExecuteCodeCommand: bridge null-passthrough -------- */

describe('parseAndExecuteCodeCommand', () => {
  test('returns null for non-`/code` input so the bridge falls through to the LLM', async () => {
    const t = buildTestCtx()
    try {
      expect(await parseAndExecuteCodeCommand('hello world', t.ctx)).toBeNull()
      expect(await parseAndExecuteCodeCommand('/notes blah', t.ctx)).toBeNull()
    } finally {
      t.cleanup()
    }
  })

  test('routes `/code help` through executeCodeCommand', async () => {
    const t = buildTestCtx()
    try {
      const out = await parseAndExecuteCodeCommand('/code help', t.ctx)
      expect(out).not.toBeNull()
      expect(out?.text).toContain('cheatsheet')
    } finally {
      t.cleanup()
    }
  })

  test('routes a retired sub-verb to the friendly reject (NOT null)', async () => {
    const t = buildTestCtx()
    try {
      const out = await parseAndExecuteCodeCommand('/code status', t.ctx)
      expect(out).not.toBeNull()
      expect(out?.text).toContain('no longer a /code sub-command')
    } finally {
      t.cleanup()
    }
  })
})
