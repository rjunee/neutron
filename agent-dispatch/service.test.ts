/**
 * @neutronai/agent-dispatch — service WIRING tests.
 *
 * These exercise the full seam the parity brief asked for —
 * dispatch → registry → substrate → report — not a unit of any one piece:
 * a real `SubagentRegistry` + `ControlState`, a recording mock `DispatchTurn`
 * (the substrate stand-in), and a recording report sink.
 */

import { describe, expect, test } from 'bun:test'

import {
  MAX_CONCURRENT_SUBAGENTS,
  SubagentRegistry,
  newControlState,
  runAgentWatchdog,
  type ControlState,
} from '../runtime/subagent/index.ts'
import {
  DispatchService,
  type DispatchReport,
  type DispatchServiceDeps,
  type DispatchTurn,
  type DispatchTurnInput,
  type DispatchTurnResult,
  type PersonaLoader,
} from './index.ts'

/** A persona loader that returns a recognisable role string per kind. */
const stubPersona: PersonaLoader = (kind) => ({
  content: kind === 'atlas' ? 'ATLAS-ROLE' : 'SENTINEL-ROLE',
  source: 'file',
})

interface Harness {
  registry: SubagentRegistry
  control: ControlState
  service: DispatchService
  calls: DispatchTurnInput[]
  reports: DispatchReport[]
  resolveTurn: (r: DispatchTurnResult) => void
}

/**
 * Build a service whose substrate turn does not settle until the test calls
 * `resolveTurn`, so the in-flight (`running`) state is observable.
 */
function makeHarness(over: Partial<DispatchServiceDeps> = {}): Harness {
  const registry = new SubagentRegistry()
  const control = newControlState(registry)
  const calls: DispatchTurnInput[] = []
  const reports: DispatchReport[] = []
  let resolveTurn: (r: DispatchTurnResult) => void = () => {}
  const dispatch: DispatchTurn = (input) => {
    calls.push(input)
    return new Promise<DispatchTurnResult>((resolve) => {
      resolveTurn = resolve
    })
  }
  let seq = 0
  const service = new DispatchService({
    registry,
    control,
    dispatch,
    report: (r) => {
      reports.push(r)
    },
    instance_key: 'inst-a',
    // Phase 2b — a board binder that returns a READY item for any id (detailed
    // title → passes the ask-gate) and records bindings; tests that exercise the
    // gate/rejection override `board`.
    board: {
      get: (_slug: string, id: string) => ({
        id,
        title: 'a fully specified plan item with plenty of detail to act on',
        design_doc_ref: null,
      }),
      attachRun: async () => undefined,
      clearRun: async () => undefined,
    },
    project_slug: 'proj-1',
    repo_path: '/home/owner',
    default_model: 'claude-sonnet-4-6',
    persona_loader: stubPersona,
    mint_run_id: () => `run-${++seq}`,
    now: () => 1000,
    ...over,
  })
  return {
    registry,
    control,
    service,
    calls,
    reports,
    resolveTurn: (r) => resolveTurn(r),
  }
}

describe('DispatchService — register → spawn → report wiring', () => {
  test('research dispatch registers a record, spawns the substrate, reports back', async () => {
    const h = makeHarness()
    const handle = await h.service.dispatch({ board_item_id: 'it-svc', kind: 'research', task: 'survey the auth flow' })

    // Registry record exists + is running while the turn is in flight.
    expect(handle.run_id).toBe('run-1')
    const rec = h.registry.byRunId('run-1')
    expect(rec?.agent_kind).toBe('atlas')
    expect(rec?.status).toBe('running')
    expect(rec?.instance_key).toBe('inst-a')

    // Substrate turn was invoked with the persona folded into user_message
    // (NOT system — the substrate drops system) + the bound repo/model.
    expect(h.calls).toHaveLength(1)
    const call = h.calls[0]!
    expect(call.kind).toBe('atlas')
    expect(call.user_message).toContain('ATLAS-ROLE')
    expect(call.user_message).toContain('survey the auth flow')
    expect(call.repo_path).toBe('/home/owner')
    expect(call.model).toBe('claude-sonnet-4-6')
    expect(call.trident_run_id).toBe('run-1')

    // No report yet — the turn hasn't settled.
    expect(h.reports).toHaveLength(0)

    // Settle the substrate turn → registry goes finished + report fires.
    h.resolveTurn({ result: 'Done. See https://example.com/pull/42', status: 'completed' })
    const outcome = await handle.completion
    expect(outcome.status).toBe('finished')
    expect(h.registry.byRunId('run-1')?.status).toBe('finished')
    expect(h.reports).toHaveLength(1)
    const report = h.reports[0]!
    expect(report.kind).toBe('research')
    expect(report.agent_kind).toBe('atlas')
    expect(report.status).toBe('finished')
    expect(report.markdown).toContain('atlas')
    expect(report.payload.deliverables).toContain('https://example.com/pull/42')
  })

  test('review dispatch maps to sentinel + folds the sentinel persona', async () => {
    const h = makeHarness()
    const handle = await h.service.dispatch({ board_item_id: 'it-svc', kind: 'review', task: 'check the brief' })
    expect(h.registry.byRunId('run-1')?.agent_kind).toBe('sentinel')
    expect(h.calls[0]!.user_message).toContain('SENTINEL-ROLE')
    h.resolveTurn({ result: 'looks good', status: 'completed' })
    expect((await handle.completion).status).toBe('finished')
  })

  test('adhoc dispatch maps to the generic core kind + the inline role', async () => {
    const h = makeHarness()
    const handle = await h.service.dispatch({ board_item_id: 'it-svc', kind: 'adhoc', task: 'rename the widget' })
    expect(h.registry.byRunId('run-1')?.agent_kind).toBe('core')
    expect(h.calls[0]!.user_message).toContain('background agent')
    expect(h.calls[0]!.user_message).toContain('rename the widget')
    h.resolveTurn({ result: 'done', status: 'completed' })
    expect((await handle.completion).status).toBe('finished')
  })

  test('a failed substrate turn is reflected as crashed in the registry + report', async () => {
    const h = makeHarness()
    const handle = await h.service.dispatch({ board_item_id: 'it-svc', kind: 'adhoc', task: 'x' })
    h.resolveTurn({ result: '', status: 'failed' })
    const outcome = await handle.completion
    expect(outcome.status).toBe('crashed')
    expect(h.registry.byRunId('run-1')?.status).toBe('crashed')
    expect(h.reports[0]!.status).toBe('crashed')
  })

  test('a timed-out turn is crashed with failure_reason=stuck', async () => {
    const h = makeHarness()
    const handle = await h.service.dispatch({ board_item_id: 'it-svc', kind: 'adhoc', task: 'x' })
    h.resolveTurn({ result: '', status: 'timed_out' })
    await handle.completion
    const rec = h.registry.byRunId('run-1')
    expect(rec?.status).toBe('crashed')
    expect(rec?.failure_reason).toBe('stuck')
  })

  test('a throwing substrate closure is a crashed dispatch (not an unhandled rejection)', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const reports: DispatchReport[] = []
    const service = new DispatchService({
      registry,
      control,
      dispatch: () => Promise.reject(new Error('empty credential pool')),
      report: (r) => {
        reports.push(r)
      },
      instance_key: 'inst-a',
      repo_path: '/home/owner',
      board: {
        get: (_slug: string, id: string) => ({ id, title: 'a fully specified plan item with plenty of detail', design_doc_ref: null }),
        attachRun: async () => undefined,
        clearRun: async () => undefined,
      },
      project_slug: 'proj-1',
      default_model: 'm',
      persona_loader: stubPersona,
      mint_run_id: () => 'run-x',
    })
    const handle = await service.dispatch({ board_item_id: 'it-svc', kind: 'adhoc', task: 'x' })
    const outcome = await handle.completion
    expect(outcome.status).toBe('crashed')
    expect(reports[0]!.status).toBe('crashed')
  })
})

describe('DispatchService — caps + guards (shared with the Trident registry)', () => {
  test('respects MAX_CONCURRENT_SUBAGENTS', async () => {
    const h = makeHarness()
    // Fill the concurrency budget with live dispatches.
    for (let i = 0; i < MAX_CONCURRENT_SUBAGENTS; i++) {
      // eslint-disable-next-line no-await-in-loop
      await h.service.dispatch({ board_item_id: 'it-svc', kind: 'adhoc', task: `t${i}` })
    }
    expect(h.registry.live()).toHaveLength(MAX_CONCURRENT_SUBAGENTS)
    // The next one is refused by the shared spawn cap.
    await expect(h.service.dispatch({ board_item_id: 'it-svc', kind: 'adhoc', task: 'overflow' })).rejects.toThrow(
      /concurrency cap/,
    )
  })

  test('a spawn_key collision coalesces onto the in-flight run (one process)', async () => {
    const h = makeHarness()
    const first = await h.service.dispatch({ board_item_id: 'it-svc', kind: 'research', task: 'a', spawn_key: 'k1' })
    const dup = await h.service.dispatch({ board_item_id: 'it-svc', kind: 'research', task: 'a', spawn_key: 'k1' })
    expect(dup.run_id).toBe(first.run_id)
    // Only ONE substrate turn was fired despite two dispatch calls.
    expect(h.calls).toHaveLength(1)
  })
})

describe('DispatchService — stop + supervision', () => {
  test('stop drives the record to cancelled; the late turn result is discarded', async () => {
    const h = makeHarness()
    const handle = await h.service.dispatch({ board_item_id: 'it-svc', kind: 'adhoc', task: 'x' })
    expect(await h.service.stop('run-1')).toBe(true)
    expect(h.registry.byRunId('run-1')?.status).toBe('cancelled')
    // The substrate turn settles late — must NOT clobber the cancelled status.
    h.resolveTurn({ result: 'late finish', status: 'completed' })
    const outcome = await handle.completion
    expect(outcome.status).toBe('cancelled')
    expect(h.registry.byRunId('run-1')?.status).toBe('cancelled')
  })

  test('stop aborts the AbortSignal the substrate turn received (real cancellation wired)', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    let receivedSignal: AbortSignal | undefined
    const dispatch: DispatchTurn = (input) => {
      receivedSignal = input.signal
      return new Promise<DispatchTurnResult>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve({ result: '', status: 'cancelled' }), {
          once: true,
        })
      })
    }
    const service = new DispatchService({
      registry,
      control,
      dispatch,
      report: () => {},
      instance_key: 'inst-a',
      repo_path: '/home/owner',
      board: {
        get: (_slug: string, id: string) => ({ id, title: 'a fully specified plan item with plenty of detail', design_doc_ref: null }),
        attachRun: async () => undefined,
        clearRun: async () => undefined,
      },
      project_slug: 'proj-1',
      default_model: 'm',
      persona_loader: stubPersona,
      mint_run_id: () => 'run-cancel-1',
    })
    const handle = await service.dispatch({ board_item_id: 'it-svc', kind: 'adhoc', task: 'long' })
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(receivedSignal!.aborted).toBe(false)
    await service.stop('run-cancel-1')
    expect(receivedSignal!.aborted).toBe(true)
    expect((await handle.completion).status).toBe('cancelled')
    expect(registry.byRunId('run-cancel-1')?.status).toBe('cancelled')
  })

  test('liveDispatches excludes terminal + foreign-instance records', async () => {
    const h = makeHarness()
    await h.service.dispatch({ board_item_id: 'it-svc', kind: 'research', task: 'a' })
    expect(h.service.liveDispatches().map((r) => r.run_id)).toEqual(['run-1'])
  })

  test('the shared watchdog reaps a stuck dispatch + the registry shows crashed', async () => {
    const h = makeHarness()
    await h.service.dispatch({ board_item_id: 'it-svc', kind: 'adhoc', task: 'x' })
    // Force staleness: backdate last_event_at well past the stuck threshold.
    h.registry.update('run-1', { last_event_at: 0 })
    const res = await runAgentWatchdog({
      control: h.control,
      registry: h.registry,
      now: () => 10 * 60_000,
    })
    expect(res.surfaced).toHaveLength(1)
    expect(res.surfaced[0]!.reason).toBe('stuck')
    expect(h.registry.byRunId('run-1')?.status).toBe('crashed')
  })
})
