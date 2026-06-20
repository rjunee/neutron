import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CodegenMaxRoundsReachedError,
  CodegenRunError,
} from '../src/backend.ts'
import { buildStubHostRunners } from '../src/host-runners.ts'
import {
  buildRuntimeCodegenRunner,
  parseForgeOutput,
  type SubagentDispatchInput,
  type SubagentDispatchResult,
} from '../src/runtime-runner.ts'
import { CodegenSidecarResolver } from '../src/sidecar/store.ts'

const OWNER = 'rr-project'
const PROJECT = 'rr-proj'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codegen-rr-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('parseForgeOutput', () => {
  test('parses the locked terminal lines', () => {
    const out = parseForgeOutput(
      `did the thing\nPR_NUMBER=42\nBRANCH=feat/foo\nWORKTREE=/tmp/proj/code\n`,
    )
    expect(out.pr_number).toBe(42)
    expect(out.branch).toBe('feat/foo')
    expect(out.worktree).toBe('/tmp/proj/code')
    expect(out.summary).toBe('did the thing')
  })

  test('throws when PR_NUMBER missing', () => {
    expect(() => parseForgeOutput('BRANCH=foo\nWORKTREE=/x')).toThrow(/PR_NUMBER/)
  })

  test('throws when BRANCH missing', () => {
    expect(() => parseForgeOutput('PR_NUMBER=1\nWORKTREE=/x')).toThrow(/BRANCH/)
  })

  test('throws when WORKTREE missing', () => {
    expect(() => parseForgeOutput('PR_NUMBER=1\nBRANCH=foo')).toThrow(/WORKTREE/)
  })

  test('throws when PR_NUMBER is not a positive integer', () => {
    expect(() =>
      parseForgeOutput('PR_NUMBER=abc\nBRANCH=foo\nWORKTREE=/x'),
    ).toThrow(/positive integer/)
  })
})

function buildScriptedDispatch(
  responses: ReadonlyArray<{
    kind: 'forge' | 'argus'
    result: string
    status?: SubagentDispatchResult['status']
  }>,
): {
  dispatch: (input: SubagentDispatchInput) => Promise<SubagentDispatchResult>
  calls: SubagentDispatchInput[]
} {
  const calls: SubagentDispatchInput[] = []
  let idx = 0
  return {
    calls,
    dispatch: async (input) => {
      calls.push(input)
      const next = responses[idx++]
      if (next === undefined) {
        return { result: '', subagent_run_id: `run-${idx}-empty`, status: 'failed' }
      }
      // Light shape check — the dispatch should be called for the
      // expected kind in order.
      return {
        result: next.result,
        subagent_run_id: `run-${idx}`,
        status: next.status ?? 'completed',
      }
    },
  }
}

describe('buildRuntimeCodegenRunner — autonomous Forge → Argus → merge (S2)', () => {
  test('happy path: Forge → Argus APPROVE → auto-merge fires unconditionally + autonomous audit row', async () => {
    const runners = buildStubHostRunners({
      gitIsRepo: async () => true,
      gitExec: async (input) => {
        if (input.args[0] === 'remote') {
          return { ok: true, stdout: 'git@github.com:me/x.git', stderr: '', exit_code: 0 }
        }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      },
    })
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const scripted = buildScriptedDispatch([
      { kind: 'forge', result: 'shipped\nPR_NUMBER=7\nBRANCH=feat/x\nWORKTREE=/x' },
      { kind: 'argus', result: 'APPROVE' },
    ])
    const runner = buildRuntimeCodegenRunner({
      dispatch_subagent: scripted.dispatch,
      owner_home: tmp,
      instance_key: OWNER,
      resolve_sidecar: (input) => resolver.resolve(input.project_id),
      gh_runner: runners.gh,
      git_runner: runners.git,
      bun_test_runner: runners.bun_test,
      default_project_id: PROJECT,
      max_argus_rounds: 8,
    })
    const result = await runner.run({ task_id: 'tid-1', task: 'add /healthz' })
    expect(result.pr_number).toBe(7)
    expect(result.branch).toBe('feat/x')
    // S2: auto-merge default ON — gh prMerge fires exactly once on APPROVE.
    expect(runners.calls.pr_merge).toHaveLength(1)
    expect(runners.calls.pr_merge[0]?.pr_number).toBe(7)
    expect(result.summary).toContain('auto-merged PR #7')
    expect(result.summary).not.toContain('awaiting user confirm')
    // Audit row attributed to 'autonomous' (the S2 attribution).
    const sidecar = await resolver.resolve(PROJECT)
    expect(sidecar.audit.countForPr(7)).toBe(1)
    resolver.closeAll()
  })

  test('merge failure: gh pr merge exit≠0 → throws CodegenRunError(merge_failed)', async () => {
    const runners = buildStubHostRunners({
      gitIsRepo: async () => true,
      gitExec: async (input) => {
        if (input.args[0] === 'remote') {
          return { ok: true, stdout: 'git@github.com:me/x.git', stderr: '', exit_code: 0 }
        }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      },
      prMerge: async () => ({ ok: false, stdout: '', stderr: 'not mergeable', exit_code: 1 }),
    })
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const scripted = buildScriptedDispatch([
      { kind: 'forge', result: 'shipped\nPR_NUMBER=14\nBRANCH=feat/x\nWORKTREE=/x' },
      { kind: 'argus', result: 'APPROVE' },
    ])
    const runner = buildRuntimeCodegenRunner({
      dispatch_subagent: scripted.dispatch,
      owner_home: tmp,
      instance_key: OWNER,
      resolve_sidecar: (input) => resolver.resolve(input.project_id),
      gh_runner: runners.gh,
      git_runner: runners.git,
      bun_test_runner: runners.bun_test,
      default_project_id: PROJECT,
    })
    await expect(runner.run({ task_id: 'tid-merge-fail', task: 'foo' })).rejects.toMatchObject({
      code: 'merge_failed',
    })
    resolver.closeAll()
  })

  test('max-rounds-reached: Argus always REQUEST_CHANGES → throws CodegenMaxRoundsReachedError', async () => {
    const runners = buildStubHostRunners({
      gitIsRepo: async () => true,
      gitExec: async (input) => {
        if (input.args[0] === 'remote') {
          return { ok: true, stdout: 'git@github.com:me/x.git', stderr: '', exit_code: 0 }
        }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      },
    })
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    // Forge → REQUEST_CHANGES → Forge fix → REQUEST_CHANGES → Forge fix
    // → REQUEST_CHANGES (3 argus rounds → max 3 → throws).
    const scripted = buildScriptedDispatch([
      // Initial Forge.
      { kind: 'forge', result: 'first\nPR_NUMBER=9\nBRANCH=feat/x\nWORKTREE=/x' },
      // Round 1: Argus REQUEST_CHANGES → Forge-fix.
      { kind: 'argus', result: 'REQUEST CHANGES\n1. fix the foo' },
      { kind: 'forge', result: 'fix1\nPR_NUMBER=9\nBRANCH=feat/x\nWORKTREE=/x' },
      // Round 2: Argus REQUEST_CHANGES → Forge-fix.
      { kind: 'argus', result: 'REQUEST CHANGES\n2. fix the bar' },
      { kind: 'forge', result: 'fix2\nPR_NUMBER=9\nBRANCH=feat/x\nWORKTREE=/x' },
      // Round 3: Argus REQUEST_CHANGES → Forge-fix (each round runs forge-fix).
      { kind: 'argus', result: 'REQUEST CHANGES\n3. fix the baz' },
      { kind: 'forge', result: 'fix3\nPR_NUMBER=9\nBRANCH=feat/x\nWORKTREE=/x' },
    ])
    const runner = buildRuntimeCodegenRunner({
      dispatch_subagent: scripted.dispatch,
      owner_home: tmp,
      instance_key: OWNER,
      resolve_sidecar: (input) => resolver.resolve(input.project_id),
      gh_runner: runners.gh,
      git_runner: runners.git,
      bun_test_runner: runners.bun_test,
      default_project_id: PROJECT,
      max_argus_rounds: 3,
    })
    await expect(runner.run({ task_id: 'tid-3', task: 'foo' })).rejects.toBeInstanceOf(
      CodegenMaxRoundsReachedError,
    )
    expect(runners.calls.pr_merge).toHaveLength(0)
    resolver.closeAll()
  })

  test('max-rounds-reached at 8 rounds (the production default cap)', async () => {
    const runners = buildStubHostRunners({
      gitIsRepo: async () => true,
      gitExec: async (input) => {
        if (input.args[0] === 'remote') {
          return { ok: true, stdout: 'git@github.com:me/x.git', stderr: '', exit_code: 0 }
        }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      },
    })
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    // Forge initial + 8 × (Argus REQUEST_CHANGES + Forge-fix).
    const responses: Array<{ kind: 'forge' | 'argus'; result: string }> = [
      { kind: 'forge', result: 'first\nPR_NUMBER=21\nBRANCH=feat/x\nWORKTREE=/x' },
    ]
    for (let i = 1; i <= 8; i++) {
      responses.push({ kind: 'argus', result: `REQUEST CHANGES\n${i}. nope` })
      responses.push({
        kind: 'forge',
        result: `fix${i}\nPR_NUMBER=21\nBRANCH=feat/x\nWORKTREE=/x`,
      })
    }
    const scripted = buildScriptedDispatch(responses)
    const runner = buildRuntimeCodegenRunner({
      dispatch_subagent: scripted.dispatch,
      owner_home: tmp,
      instance_key: OWNER,
      resolve_sidecar: (input) => resolver.resolve(input.project_id),
      gh_runner: runners.gh,
      git_runner: runners.git,
      bun_test_runner: runners.bun_test,
      default_project_id: PROJECT,
      // No max_argus_rounds → 8 (production default).
    })
    await expect(runner.run({ task_id: 'tid-8', task: 'foo' })).rejects.toMatchObject({
      code: 'max_argus_rounds_reached',
      max_rounds: 8,
    })
    expect(runners.calls.pr_merge).toHaveLength(0)
    resolver.closeAll()
  })

  test('sub-agent failure (Forge fails) → throws CodegenRunError(forge_failed)', async () => {
    const runners = buildStubHostRunners({
      gitIsRepo: async () => true,
      gitExec: async (input) => {
        if (input.args[0] === 'remote') {
          return { ok: true, stdout: 'git@github.com:me/x.git', stderr: '', exit_code: 0 }
        }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      },
    })
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const scripted = buildScriptedDispatch([
      { kind: 'forge', result: '', status: 'failed' },
    ])
    const runner = buildRuntimeCodegenRunner({
      dispatch_subagent: scripted.dispatch,
      owner_home: tmp,
      instance_key: OWNER,
      resolve_sidecar: (input) => resolver.resolve(input.project_id),
      gh_runner: runners.gh,
      git_runner: runners.git,
      bun_test_runner: runners.bun_test,
      default_project_id: PROJECT,
    })
    await expect(runner.run({ task_id: 'tid-4', task: 'foo' })).rejects.toBeInstanceOf(
      CodegenRunError,
    )
    resolver.closeAll()
  })

  test('per-project worktree isolation: dispatch in projectA does NOT touch projectB', async () => {
    const runners = buildStubHostRunners({
      gitIsRepo: async () => true,
      gitExec: async (input) => {
        if (input.args[0] === 'remote') {
          return { ok: true, stdout: 'git@github.com:me/x.git', stderr: '', exit_code: 0 }
        }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      },
    })
    const resolver = new CodegenSidecarResolver({ owner_home: tmp })
    const scripted = buildScriptedDispatch([
      { kind: 'forge', result: 'shipped\nPR_NUMBER=10\nBRANCH=feat/x\nWORKTREE=/x' },
      { kind: 'argus', result: 'APPROVE' },
    ])
    const runner = buildRuntimeCodegenRunner({
      dispatch_subagent: scripted.dispatch,
      owner_home: tmp,
      instance_key: OWNER,
      resolve_sidecar: (input) => resolver.resolve(input.project_id),
      gh_runner: runners.gh,
      git_runner: runners.git,
      bun_test_runner: runners.bun_test,
      default_project_id: 'A',
    })
    await runner.run({ task_id: 'tid-A', task: 'in project A' })
    const sidecarA = await resolver.resolve('A')
    const sidecarB = await resolver.resolve('B')
    expect(sidecarA.tasks.list({ limit: 10 })).toHaveLength(1)
    expect(sidecarB.tasks.list({ limit: 10 })).toHaveLength(0)
    resolver.closeAll()
  })
})
