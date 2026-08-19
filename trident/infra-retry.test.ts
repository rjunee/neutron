/**
 * Run-level infrastructure auto-retry: measured executor/transport failures are
 * retried without a human, while genuine review/build failures stay terminal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { InnerLoopInput } from './inner-loop.ts'
import {
  buildTridentOrchestrator,
  classifyInnerFailure,
  INFRA_RETRY_BACKOFF_MS,
  innerTerminalFailureReason,
} from './orchestrator.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import { TridentTickLoop } from './tick.ts'

const INCIDENT_CAUSE =
  'forge:build was routed to the codex executor and NO BUILD HAPPENED ' +
  '(codexStatus=deferred) — Refusing to continue…'
const WRAPPER_REFUSAL =
  'CODEX_BUILD_BRIEF_PART_CORRUPT: brief part X measures 27893:ff41febe but its receipt is 28462:9f34d3b0'
const WRAPPER_DEFERRAL_CAUSE = `forge:build deferred (codexStatus=deferred): ${WRAPPER_REFUSAL}`

const infraResult = (cause = INCIDENT_CAUSE) => ({
  ok: false,
  verdict: 'REQUEST_CHANGES',
  round: 1,
  checkpoint: 'inner-error',
  blockKind: null,
  terminalCause: cause,
})

let tmp: string
let db: ProjectDb
let store: TridentRunStore
let clockMs: number

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trident-infra-retry-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  clockMs = 0
  store = new TridentRunStore(db, () => new Date(clockMs).toISOString())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function harness(over: {
  wired?: boolean
  max_infra_retries?: number
  on_infra_retry?: (run: TridentRun, attempt: number, cause: string) => Promise<void>
} = {}) {
  const inputs: InnerLoopInput[] = []
  const opts: Parameters<typeof buildTridentOrchestrator>[0] = {
    fire_workflow: async (input) => {
      inputs.push(input)
      return {
        status: 'fired',
        error: null,
        launcher_session_key: `infra-generation-${inputs.length}`,
      }
    },
    db_path: join(tmp, 'project.db'),
    run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
    base_branch: 'main',
    now: () => new Date(clockMs).toISOString(),
  }
  if (over.wired !== false) opts.begin_infra_retry = (id) => store.beginInfraRetry(id)
  if (over.max_infra_retries !== undefined) opts.max_infra_retries = over.max_infra_retries
  if (over.on_infra_retry !== undefined) opts.on_infra_retry = over.on_infra_retry
  const orchestrator = buildTridentOrchestrator(opts)
  return { inputs, loop: new TridentTickLoop({ store, step: orchestrator.step }) }
}

async function createRun(id: string) {
  return store.create({ id, slug: id, project_slug: 'p', repo_path: '/repo', task: 'build' })
}

async function writeResult(id: string, result: Record<string, unknown>): Promise<void> {
  await store.update(id, {
    subagent_status: 'completed',
    inner_checkpoint: typeof result.checkpoint === 'string' ? result.checkpoint : null,
    inner_verdict: result.verdict === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES',
    inner_result: JSON.stringify(result),
  })
}

describe('measured-fields classifier is conservative and total', () => {
  const classify = (
    verdict: 'APPROVE' | 'REQUEST_CHANGES' | null,
    block_kind: 'none' | 'code' | 'infra-only' | 'round-lost' | null,
    terminal_cause: string | null,
    checkpoint: string | null = 'inner-error',
  ) => classifyInnerFailure({ verdict, block_kind, terminal_cause, checkpoint })

  test('recognises only explicit infra-only or closed executor/transport words', () => {
    expect(classify('REQUEST_CHANGES', 'infra-only', 'review service unavailable')).toBe('infrastructure')
    expect(classify('REQUEST_CHANGES', null, INCIDENT_CAUSE)).toBe('infrastructure')
    expect(classify('REQUEST_CHANGES', null, WRAPPER_DEFERRAL_CAUSE)).toBe('infrastructure')
    expect(classify('REQUEST_CHANGES', null, 'upstream returned Bad Gateway')).toBe('infrastructure')
    expect(classify('REQUEST_CHANGES', null, 'tests failed: 3 failing')).toBe('genuine')
    expect(classify('REQUEST_CHANGES', null, null)).toBe('genuine')
    expect(classify('REQUEST_CHANGES', 'infra-only', null)).toBe('genuine')
    expect(classify('REQUEST_CHANGES', 'code', 'review requested changes')).toBe('genuine')
    expect(classify('REQUEST_CHANGES', null, '')).toBe('genuine')
    expect(classify('APPROVE', 'infra-only', 'service unavailable')).toBe('genuine')
  })
})

describe('(a) measured incident retries without a human', () => {
  test('claim clears the slot/result, preserves rounds, waits, then re-fires as a continuation', async () => {
    const h = harness()
    const run = await createRun('incident-replay')

    await h.loop.runOnce()
    expect(h.inputs).toHaveLength(1)
    await writeResult(run.id, infraResult())
    await h.loop.runOnce()

    const claimed = store.get(run.id)!
    expect(claimed.phase).not.toBe('failed')
    expect(claimed.infra_retries).toBe(1)
    expect(claimed.inner_result).toBeNull()
    expect(claimed.subagent_run_id).toBeNull()
    expect(claimed.subagent_status).toBeNull()
    expect(claimed.workflow_run_id).toBeNull()
    expect(claimed.harvested_at).toBeNull()
    expect(claimed.round).toBe(1)
    expect(claimed.ralph_round).toBe(0)

    await h.loop.runOnce()
    expect(h.inputs).toHaveLength(1)
    clockMs = INFRA_RETRY_BACKOFF_MS[0] + 1
    await h.loop.runOnce()
    expect(h.inputs).toHaveLength(2)
    expect(h.inputs[1]?.resume_checkpoint).toBe('inner-error')
  })
})

describe('(b) genuine failures never auto-retry', () => {
  test('a findings-carrying code REQUEST_CHANGES is terminal on the first fire', async () => {
    // MUTANT KILLED: widening `classifyInnerFailure` to treat every no-APPROVE
    // result as infrastructure (dropping either the infra-only conjunct or the
    // closed-word check) makes THIS test retry and fail.
    const h = harness()
    const run = await createRun('genuine-request-changes')
    await h.loop.runOnce()
    await store.update(run.id, { inner_checkpoint_findings: '[{"severity":"blocker"}]' })
    await writeResult(run.id, {
      ok: false,
      verdict: 'REQUEST_CHANGES',
      round: 1,
      checkpoint: 'argus-request-changes',
      blockKind: 'code',
      terminalCause: 'review found a correctness defect',
      findings: [{ severity: 'blocker', summary: 'wrong result' }],
    })
    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(after.infra_retries).toBe(0)
    expect(h.inputs).toHaveLength(1)
  })
})

describe('(c) retry budget and backoff are separate from fix rounds', () => {
  test('two retries produce exactly three fires, then fail with measured budget reason', async () => {
    const h = harness({ max_infra_retries: 2 })
    const run = await createRun('bounded')
    await h.loop.runOnce()

    for (let attempt = 0; attempt < 3; attempt++) {
      await writeResult(run.id, infraResult())
      await h.loop.runOnce()
      if (attempt < 2) {
        const backoffMs = INFRA_RETRY_BACKOFF_MS[attempt]
        if (backoffMs === undefined) throw new Error(`no backoff configured for attempt ${attempt}`)
        clockMs += backoffMs + 1
        await h.loop.runOnce()
      }
    }

    const after = store.get(run.id)!
    expect(h.inputs).toHaveLength(3)
    expect(after.phase).toBe('failed')
    expect(after.infra_retries).toBe(2)
    expect(after.round).toBe(1)
    expect(after.ralph_round).toBe(0)
    expect(after.failure_reason).toContain('(budget 2)')
    expect(after.failure_reason).toContain(INCIDENT_CAUSE)
    expect(after.failure_reason).not.toContain('exhausted')
  })

  test('the attempt-1 observer is restart-proof told-once and a throw cannot stop retries', async () => {
    const calls: Array<{ attempt: number; cause: string }> = []
    const h = harness({
      on_infra_retry: async (_run, attempt, cause) => {
        calls.push({ attempt, cause })
        throw new Error('notification transport down')
      },
    })
    const run = await createRun('told-once')
    await h.loop.runOnce()

    for (let attempt = 0; attempt < 3; attempt++) {
      await writeResult(run.id, infraResult())
      await h.loop.runOnce()
      const backoffMs = INFRA_RETRY_BACKOFF_MS[attempt]
      if (backoffMs === undefined) throw new Error(`no backoff configured for attempt ${attempt}`)
      clockMs += backoffMs + 1
      await h.loop.runOnce()
    }

    expect(calls).toEqual([{ attempt: 1, cause: INCIDENT_CAUSE }])
    expect(h.inputs).toHaveLength(4)
    expect(store.get(run.id)?.infra_retries).toBe(3)
    expect(store.get(run.id)?.phase).not.toBe('failed')
  })
})

describe('legacy wiring and atomic claim ownership', () => {
  test('unwired begin_infra_retry preserves the exact legacy terminal reason', async () => {
    const h = harness({ wired: false })
    const run = await createRun('legacy')
    await h.loop.runOnce()
    await writeResult(run.id, infraResult())
    const before = store.get(run.id)!
    const expected = innerTerminalFailureReason(before, {
      round: 1,
      checkpoint: 'inner-error',
      block_kind: null,
      terminal_cause: INCIDENT_CAUSE,
    })

    await h.loop.runOnce()

    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(after.failure_reason).toBe(expected)
    expect(after.infra_retries).toBe(0)
    expect(h.inputs).toHaveLength(1)
  })

  test('beginInfraRetry loses to terminal rows and to the crash lane latch', async () => {
    const terminal = await createRun('claim-terminal')
    await store.terminalTransition(terminal.id, { phase: 'failed' })
    expect(await store.beginInfraRetry(terminal.id)).toBeNull()

    const crashed = await createRun('claim-crashed')
    await store.update(crashed.id, { subagent_status: 'running', workflow_run_id: 'dead-generation' })
    await store.crashRunningByLauncher('dead-generation', 'launcher died')
    expect(await store.beginInfraRetry(crashed.id)).toBeNull()
    expect(store.get(crashed.id)?.subagent_status).toBe('crashed')
    expect(store.get(crashed.id)?.infra_retries).toBe(0)
  })
})
