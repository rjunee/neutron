import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  CapabilityDeniedError,
  CapabilityGuard,
  SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'

import {
  CodegenInputError,
  CodegenNotConfiguredError,
  CodegenOrchestrator,
  CodegenRunError,
  CodegenTaskFailedError,
  CodegenTaskNotFoundError,
  CodegenTaskPendingError,
  buildTools,
  loadManifest,
  nextMacrotaskTick,
  type CodegenRunInput,
  type CodegenRunResult,
  type CodegenTaskStatus,
} from '../index.ts'
// buildInMemoryCodegenRunner is a deterministic test fake — imported from
// the package internals, not the public barrel (R1, audit P2-17).
import { buildInMemoryCodegenRunner } from '../src/backend.ts'

const OWNER = 't1'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codegen-tools-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

function fixtureResult(over: Partial<CodegenRunResult> = {}): CodegenRunResult {
  return {
    pr_number: 42,
    branch: 'feat/forge-fixture',
    worktree: '/tmp/forge-fixture',
    summary: 'add the thing',
    ...over,
  }
}

/**
 * Drain macrotask ticks until the named task reaches a terminal state
 * (`completed` or `failed`). Used by tests that exercise the
 * orchestrator's single-slot mutex — the second task can't start until
 * the first finishes, so a fixed number of `nextMacrotaskTick()` calls
 * is not enough. Caps at 50 ticks so a stuck test fails loudly.
 */
async function awaitTerminal(
  tools: ReturnType<typeof buildTools>,
  task_id: string,
  maxTicks = 50,
): Promise<CodegenTaskStatus> {
  for (let i = 0; i < maxTicks; i++) {
    const s = await tools.codegen_status({ task_id })
    if (s.status === 'completed' || s.status === 'failed') return s.status
    await nextMacrotaskTick()
  }
  throw new Error(
    `awaitTerminal: task ${task_id} did not reach terminal state after ${maxTicks} ticks`,
  )
}

interface ToolsBuild {
  tools: ReturnType<typeof buildTools>
  orchestrator: CodegenOrchestrator
}

function makeTools(opts: {
  results?: Array<CodegenRunResult | CodegenRunError>
  respond?: (input: CodegenRunInput) => Promise<CodegenRunResult>
  schedule_kickoff?: (fn: () => void) => void
} = {}): ToolsBuild {
  const runner = buildInMemoryCodegenRunner({
    ...(opts.results !== undefined ? { results: opts.results } : {}),
    ...(opts.respond !== undefined ? { respond: opts.respond } : {}),
  })
  const orchestrator = new CodegenOrchestrator({
    runner,
    ...(opts.schedule_kickoff !== undefined
      ? { schedule_kickoff: opts.schedule_kickoff }
      : {}),
  })
  const manifest = loadManifest()
  const tools = buildTools({
    manifest,
    project_slug: OWNER,
    audit,
    orchestrator,
  })
  return { tools, orchestrator }
}

describe('buildTools — capability-gated dispatch', () => {
  test('codegen_dispatch returns a task_id and starts the task in pending state', async () => {
    // A never-resolving runner (`respond` returns a Promise that the
    // test never settles) so the task stays in `running` after the
    // kickoff tick. Pre-tick, the task should still be `pending`.
    const stall = new Promise<CodegenRunResult>(() => {})
    const { tools } = makeTools({ respond: () => stall })

    const dispatched = await tools.codegen_dispatch({ task: 'add a footer link' })
    expect(dispatched.task_id).toBeTruthy()

    // Pre-kickoff: still pending. The orchestrator schedules the
    // runner on the macrotask queue, so `await dispatch(...)` (which
    // only drains microtasks) returns with status still `pending`.
    const s0 = await tools.codegen_status({ task_id: dispatched.task_id })
    expect(s0.status).toBe('pending')

    // Drain one macrotask tick — the kickoff fires, `markRunning`
    // runs synchronously, then the runner awaits the never-resolving
    // promise. Status now reads `running`.
    await nextMacrotaskTick()
    const s1 = await tools.codegen_status({ task_id: dispatched.task_id })
    expect(s1.status).toBe('running')
  })

  test('codegen_dispatch → codegen_status → codegen_fetch happy path returns the PR shape', async () => {
    const result = fixtureResult({ pr_number: 101, branch: 'feat/x' })
    const { tools } = makeTools({ results: [result] })

    const { task_id } = await tools.codegen_dispatch({ task: 'do the thing' })
    // Two ticks: one for the macrotask kickoff to fire, one for the
    // in-memory runner's microtask chain to resolve before the
    // orchestrator's `markCompleted` lands.
    await nextMacrotaskTick()
    await nextMacrotaskTick()

    const s = await tools.codegen_status({ task_id })
    expect(s.status).toBe('completed')

    const fetched = await tools.codegen_fetch({ task_id })
    expect(fetched.pr_number).toBe(101)
    expect(fetched.branch).toBe('feat/x')
    expect(fetched.worktree).toBe(result.worktree)
    expect(fetched.summary).toBe(result.summary)

    // Audit log: every dispatch → status → fetch on the success path
    // writes a `tool_call outcome=ok` row, proving the capability
    // guard ran.
    const auditRows = await audit.list({
      project_slug: OWNER,
      core_slug: 'codegen_core',
    })
    const successRows = auditRows.filter((r) => r.outcome === 'ok')
    expect(successRows.length).toBeGreaterThanOrEqual(3)
    const toolNames = new Set(successRows.map((r) => r.label))
    expect(toolNames.has('codegen_dispatch')).toBe(true)
    expect(toolNames.has('codegen_status')).toBe(true)
    expect(toolNames.has('codegen_fetch')).toBe(true)
  })

  test('codegen_fetch on a non-existent task_id throws CodegenTaskNotFoundError', async () => {
    const { tools } = makeTools()
    await expect(
      tools.codegen_fetch({ task_id: 'no-such-task' }),
    ).rejects.toThrow(CodegenTaskNotFoundError)
  })

  test('codegen_status on a non-existent task_id throws CodegenTaskNotFoundError', async () => {
    // Status mirrors fetch's not-found surface so chat clients can
    // handle both via the same typed-error branch.
    const { tools } = makeTools()
    await expect(
      tools.codegen_status({ task_id: 'no-such-task' }),
    ).rejects.toThrow(CodegenTaskNotFoundError)
  })

  test('codegen_fetch on a still-running task throws CodegenTaskPendingError', async () => {
    const stall = new Promise<CodegenRunResult>(() => {})
    const { tools } = makeTools({ respond: () => stall })

    const { task_id } = await tools.codegen_dispatch({ task: 'pending check' })
    await nextMacrotaskTick()
    expect((await tools.codegen_status({ task_id })).status).toBe('running')

    await expect(
      tools.codegen_fetch({ task_id }),
    ).rejects.toThrow(CodegenTaskPendingError)
  })

  test('failed runner → status becomes failed, fetch throws CodegenTaskFailedError with structured metadata', async () => {
    const { tools } = makeTools({
      results: [
        new CodegenRunError(
          'patch_did_not_apply',
          'git apply rejected the diff at runtime/foo.ts',
        ),
      ],
    })

    const { task_id } = await tools.codegen_dispatch({ task: 'broken patch' })
    await nextMacrotaskTick()
    await nextMacrotaskTick()

    const s = await tools.codegen_status({ task_id })
    expect(s.status).toBe('failed')

    let captured: CodegenTaskFailedError | undefined
    try {
      await tools.codegen_fetch({ task_id })
    } catch (err) {
      if (err instanceof CodegenTaskFailedError) {
        captured = err
      } else {
        throw err
      }
    }
    expect(captured).toBeDefined()
    expect(captured?.task_id).toBe(task_id)
    expect(captured?.run_error.code).toBe('patch_did_not_apply')
    expect(captured?.run_error.message).toBe(
      'git apply rejected the diff at runtime/foo.ts',
    )
  })

  test('plain-Error throws in the runner are mapped to code=unknown_error in the failure record', async () => {
    // A runner that throws a generic Error (no `code` field) — the
    // orchestrator must coerce to a stable `unknown_error` code so
    // chat clients can branch without parsing prose.
    const { tools } = makeTools({
      respond: async () => {
        throw new Error('something exploded')
      },
    })

    const { task_id } = await tools.codegen_dispatch({ task: 'generic error' })
    await nextMacrotaskTick()
    await nextMacrotaskTick()

    let captured: CodegenTaskFailedError | undefined
    try {
      await tools.codegen_fetch({ task_id })
    } catch (err) {
      if (err instanceof CodegenTaskFailedError) {
        captured = err
      } else {
        throw err
      }
    }
    expect(captured).toBeDefined()
    expect(captured?.run_error.code).toBe('unknown_error')
    expect(captured?.run_error.message).toBe('something exploded')
  })

  test('runner receives the task_id alongside the dispatch input', async () => {
    // The orchestrator passes the freshly-minted task_id to the
    // runner so production implementations (which post status to
    // Telegram / write log lines / open PRs) can correlate their
    // side-effects with the Core's tracker.
    let captured: CodegenRunInput | undefined
    const { tools } = makeTools({
      respond: async (input) => {
        captured = input
        return fixtureResult({ branch: input.target_branch ?? 'auto' })
      },
    })

    const { task_id } = await tools.codegen_dispatch({
      task: 'with branch',
      target_branch: 'feat/from-tools',
      repo_path: '/tmp/example-repo',
    })
    await nextMacrotaskTick()
    await nextMacrotaskTick()

    expect(captured?.task_id).toBe(task_id)
    expect(captured?.task).toBe('with branch')
    expect(captured?.target_branch).toBe('feat/from-tools')
    expect(captured?.repo_path).toBe('/tmp/example-repo')

    const fetched = await tools.codegen_fetch({ task_id })
    expect(fetched.branch).toBe('feat/from-tools')
  })

  test('back-to-back dispatches: each task tracked independently end-to-end', async () => {
    // Two back-to-back dispatches with two prepared results in the
    // FIFO queue. Per the sprint brief's "one task at a time" lock the
    // orchestrator serializes execution (see `single-slot mutex` test
    // below); both tasks still reach `completed` and `fetch` returns
    // the right PR per id (FIFO queue maps tasks to results in
    // dispatch order). `awaitTerminal` drains macrotask ticks until
    // both tasks settle so the test is robust to scheduling order.
    const { tools } = makeTools({
      results: [
        fixtureResult({ pr_number: 1, branch: 'feat/one' }),
        fixtureResult({ pr_number: 2, branch: 'feat/two' }),
      ],
    })

    const a = await tools.codegen_dispatch({ task: 'task one' })
    const b = await tools.codegen_dispatch({ task: 'task two' })
    expect(a.task_id).not.toBe(b.task_id)

    await awaitTerminal(tools, a.task_id)
    await awaitTerminal(tools, b.task_id)

    expect((await tools.codegen_fetch({ task_id: a.task_id })).pr_number).toBe(1)
    expect((await tools.codegen_fetch({ task_id: b.task_id })).pr_number).toBe(2)
  })

  test('single-slot mutex: only one task is in `running` state at any moment', async () => {
    // Per the sprint brief lock ("one task at a time" for v1) the
    // orchestrator serializes dispatches FIFO. Inflate the runner's
    // own `await` window so both tasks would race if the mutex were
    // absent — the test asserts the observed concurrent-runner count
    // never exceeds 1.
    let running = 0
    let maxRunning = 0
    const { tools } = makeTools({
      respond: async () => {
        running++
        if (running > maxRunning) maxRunning = running
        // A handful of microtask boundaries — the second task would
        // see `running === 2` here if the mutex were absent.
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        running--
        return fixtureResult()
      },
    })

    const a = await tools.codegen_dispatch({ task: 'a' })
    const b = await tools.codegen_dispatch({ task: 'b' })

    await awaitTerminal(tools, a.task_id)
    await awaitTerminal(tools, b.task_id)

    expect(maxRunning).toBe(1)
  })

  test('codegen_dispatch deep-clones the dispatch input — caller mutation after dispatch does not leak to the runner or tracker', async () => {
    // Argus r1 MINOR: dispatch input not snapshotted before macrotask
    // kickoff. A caller that mutates the object after `await
    // dispatch(...)` returns would leak the mutation into the runner's
    // `run({...input, task_id})` argument and the tracker's
    // `request` record.
    let captured: CodegenRunInput | undefined
    const { tools } = makeTools({
      respond: async (input) => {
        captured = input
        return fixtureResult()
      },
    })

    const inputObj: {
      task: string
      target_branch?: string
      repo_path?: string
    } = {
      task: 'original-task',
      target_branch: 'feat/original',
      repo_path: '/tmp/original',
    }
    const { task_id } = await tools.codegen_dispatch(inputObj)

    // Mutate the input ref AFTER dispatch returns. The clone the
    // orchestrator took at the start of `dispatch` must shield both
    // the runner argument and the tracker row from this mutation.
    inputObj.task = 'MUTATED'
    inputObj.target_branch = 'MUTATED-BRANCH'
    inputObj.repo_path = '/tmp/MUTATED'

    await awaitTerminal(tools, task_id)

    expect(captured?.task).toBe('original-task')
    expect(captured?.target_branch).toBe('feat/original')
    expect(captured?.repo_path).toBe('/tmp/original')
  })

  describe('input validation — CodegenInputError', () => {
    // Argus r1 BLOCKING: McpServer.dispatch passes raw JSON straight
    // through to handlers without enforcing the manifest's
    // input_schema. The orchestrator must reject malformed payloads
    // with a typed `CodegenInputError` distinguishable from
    // `CodegenTaskNotFoundError` so an LLM tool-call client can
    // self-correct on bad input.

    test('codegen_dispatch rejects non-object input', async () => {
      const { tools } = makeTools()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(tools.codegen_dispatch(null as any)).rejects.toThrow(
        CodegenInputError,
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(tools.codegen_dispatch('string' as any)).rejects.toThrow(
        CodegenInputError,
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(tools.codegen_dispatch([] as any)).rejects.toThrow(
        CodegenInputError,
      )
    })

    test('codegen_dispatch rejects missing or non-string task', async () => {
      const { tools } = makeTools()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(tools.codegen_dispatch({} as any)).rejects.toThrow(
        CodegenInputError,
      )
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools.codegen_dispatch({ task: 42 } as any),
      ).rejects.toThrow(CodegenInputError)
    })

    test('codegen_dispatch rejects empty / whitespace-only task', async () => {
      const { tools } = makeTools()
      await expect(tools.codegen_dispatch({ task: '' })).rejects.toThrow(
        CodegenInputError,
      )
      await expect(tools.codegen_dispatch({ task: '   ' })).rejects.toThrow(
        CodegenInputError,
      )
    })

    test('codegen_dispatch rejects non-string optional fields when set', async () => {
      const { tools } = makeTools()
      await expect(
        tools.codegen_dispatch({
          task: 'ok',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          repo_path: 42 as any,
        }),
      ).rejects.toThrow(CodegenInputError)
      await expect(
        tools.codegen_dispatch({
          task: 'ok',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          target_branch: {} as any,
        }),
      ).rejects.toThrow(CodegenInputError)
    })

    test('codegen_status rejects non-object input + missing/empty task_id', async () => {
      const { tools } = makeTools()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(tools.codegen_status(null as any)).rejects.toThrow(
        CodegenInputError,
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(tools.codegen_status({} as any)).rejects.toThrow(
        CodegenInputError,
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(tools.codegen_status({ task_id: 42 } as any)).rejects.toThrow(
        CodegenInputError,
      )
      await expect(tools.codegen_status({ task_id: '' })).rejects.toThrow(
        CodegenInputError,
      )
      await expect(tools.codegen_status({ task_id: '   ' })).rejects.toThrow(
        CodegenInputError,
      )
    })

    test('codegen_fetch rejects non-object input + missing/empty task_id', async () => {
      const { tools } = makeTools()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(tools.codegen_fetch(undefined as any)).rejects.toThrow(
        CodegenInputError,
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(tools.codegen_fetch({} as any)).rejects.toThrow(
        CodegenInputError,
      )
      await expect(tools.codegen_fetch({ task_id: '' })).rejects.toThrow(
        CodegenInputError,
      )
    })

    test('CodegenInputError vs CodegenTaskNotFoundError are distinguishable on bad input vs real miss', async () => {
      // A tool-call client treating "bad shape" the same as "task
      // gone" is the bug this guards against — the LLM never self-
      // corrects when the two collapse into one error.
      const { tools } = makeTools()

      let inputErr: unknown
      try {
        await tools.codegen_status({ task_id: '' })
      } catch (e) {
        inputErr = e
      }

      let notFoundErr: unknown
      try {
        await tools.codegen_status({ task_id: 'real-shape-but-missing' })
      } catch (e) {
        notFoundErr = e
      }

      expect(inputErr).toBeInstanceOf(CodegenInputError)
      expect(notFoundErr).toBeInstanceOf(CodegenTaskNotFoundError)
    })

    test('CodegenInputError message names the tool + field for diagnosis', async () => {
      const { tools } = makeTools()
      let captured: CodegenInputError | undefined
      try {
        await tools.codegen_fetch({ task_id: '' })
      } catch (e) {
        if (e instanceof CodegenInputError) captured = e
      }
      expect(captured).toBeDefined()
      expect(captured?.tool).toBe('codegen_fetch')
      expect(captured?.field).toBe('task_id')
      expect(captured?.message).toContain('codegen_fetch')
      expect(captured?.message).toContain('task_id')
    })
  })

  describe('skeleton runner — Tier 1 ships without a production code-authoring substrate', () => {
    // Argus r1 IMPORTANT: Tier 1 Code-Gen is a SKELETON Core; the
    // host gateway must inject a real `CodegenRunner` (or install the
    // Tier 2 paid Coding Core) for real code-authoring behaviour. The
    // default skeleton runner fails dispatched tasks with
    // `codegen_not_configured` so the chat client renders an
    // actionable error rather than silently hanging.

    test('CodegenOrchestrator constructed without a runner defaults to the skeleton', async () => {
      const orchestrator = new CodegenOrchestrator()
      const manifest = loadManifest()
      const tools = buildTools({
        manifest,
        project_slug: OWNER,
        audit,
        orchestrator,
      })

      const { task_id } = await tools.codegen_dispatch({ task: 'try anything' })
      await awaitTerminal(tools, task_id)

      let captured: CodegenTaskFailedError | undefined
      try {
        await tools.codegen_fetch({ task_id })
      } catch (e) {
        if (e instanceof CodegenTaskFailedError) captured = e
      }
      expect(captured).toBeDefined()
      expect(captured?.run_error.code).toBe('codegen_not_configured')
    })

    test('CodegenNotConfiguredError carries the stable `codegen_not_configured` code', () => {
      const err = new CodegenNotConfiguredError()
      expect(err.code).toBe('codegen_not_configured')
      expect(err).toBeInstanceOf(CodegenRunError)
      expect(err.message).toContain('Tier 2')
    })
  })

  test('capability gate: tool dispatched against a manifest missing the required capability rejects + audits capability_denied', async () => {
    // Synthesize a manifest with the three tool entries but strip
    // `write:codegen_core.tasks` from capabilities[]. The guard must
    // reject `codegen_dispatch` (the only WRITE tool) with
    // `CapabilityDeniedError` and write a `capability_denied` audit
    // row. The READ tools (`status`, `fetch`) keep working because
    // their gate is `read:codegen_core.tasks` which is still declared.
    const m0 = loadManifest()
    const downgraded: NeutronManifest = {
      ...m0,
      capabilities: m0.capabilities.filter((c) => c !== 'write:codegen_core.tasks'),
    }
    const runner = buildInMemoryCodegenRunner({ results: [fixtureResult()] })
    const orchestrator = new CodegenOrchestrator({ runner })
    const tools = buildTools({
      manifest: downgraded,
      project_slug: OWNER,
      audit,
      orchestrator,
    })

    await expect(
      tools.codegen_dispatch({ task: 'x' }),
    ).rejects.toThrow(CapabilityDeniedError)

    // READ tools still resolve — `status` against an unknown id
    // throws CodegenTaskNotFoundError (the gate let the call through;
    // the orchestrator rejected the lookup). `fetch` same.
    await expect(
      tools.codegen_status({ task_id: 'anything' }),
    ).rejects.toThrow(CodegenTaskNotFoundError)
    await expect(
      tools.codegen_fetch({ task_id: 'anything' }),
    ).rejects.toThrow(CodegenTaskNotFoundError)

    // Confirm the dispatch attempt landed as a capability_denied
    // audit row; status/fetch did NOT (they passed the gate then
    // hit the not-found branch — audit logs that as `error`, not
    // `capability_denied`).
    const denied = await audit.listDenied({
      project_slug: OWNER,
      core_slug: 'codegen_core',
    })
    const labels = new Set(denied.map((r) => r.label))
    expect(labels.has('codegen_dispatch')).toBe(true)
    expect(labels.has('codegen_status')).toBe(false)
    expect(labels.has('codegen_fetch')).toBe(false)
  })

  test('capability gate: tool name not in manifest.tools[] is rejected by `tool_not_declared`', async () => {
    // Build a guard directly + assert against an undeclared tool. The
    // wrapped handlers exposed by `buildTools` use only the three tool
    // names declared in the manifest, so this verifies the underlying
    // gate behaviour for completeness.
    const m = loadManifest()
    const guard = new CapabilityGuard({
      manifest: m,
      core_slug: 'codegen_core',
      project_slug: OWNER,
      audit,
    })

    const result = guard.check({
      tool_name: 'codegen_unknown_tool',
      capability_required: 'write:codegen_core.tasks',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('tool_not_declared')
    }
  })
})
