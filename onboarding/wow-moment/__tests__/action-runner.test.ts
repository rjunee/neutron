/**
 * ActionRunner — wraps each action call with telemetry + retry policy.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { ActionRunner } from '../action-runner.ts'
import { WowTelemetry } from '../telemetry.ts'
import { buildContext, makeFixture, teardown, type TestFixture } from './test-helpers.ts'
import type { WowActionContext, WowActionModule, WowActionResult } from '../action-types.ts'

let fix: TestFixture

beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

function makeModule(
  action_id: WowActionModule['action_id'],
  cb: (ctx: WowActionContext) => Promise<WowActionResult>,
  trigger: boolean = true,
): WowActionModule {
  return {
    action_id,
    triggerCondition: () => trigger,
    run: cb,
  }
}

describe('ActionRunner', () => {
  test('records telemetry + returns fired:false on no_trigger', async () => {
    const sleep = async (): Promise<void> => undefined
    const telemetry = new WowTelemetry({ db: fix.db })
    const runner = new ActionRunner({ telemetry, sleep })
    const module = makeModule(
      '01-first-week-brief',
      async () => ({ fired: true, reason: 'never-runs' }),
      false,
    )
    const ctx = buildContext(fix)
    const out = await runner.run({ module, ctx })
    expect(out.fired).toBe(false)
    expect(out.reason).toBe('no_trigger')
    const rows = telemetry.list('t1')
    expect(rows.length).toBe(1)
    expect(rows[0]?.success_reason).toBe('no_trigger')
  })

  test('retries retry-eligible action exactly once on throw, with sleep', async () => {
    let attempts = 0
    const sleeps: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms)
    }
    const telemetry = new WowTelemetry({ db: fix.db })
    const runner = new ActionRunner({ telemetry, sleep, retryDelay_ms: 30_000 })
    const module = makeModule('01-first-week-brief', async () => {
      attempts += 1
      if (attempts === 1) throw new Error('substrate transient')
      return { fired: true, reason: 'recovered' }
    })
    const ctx = buildContext(fix)
    const out = await runner.run({ module, ctx })
    expect(attempts).toBe(2)
    expect(sleeps).toEqual([30_000])
    expect(out.fired).toBe(true)
    expect(out.reason).toBe('recovered')
  })

  test('exhausted retry budget records substrate_error', async () => {
    const sleep = async (): Promise<void> => undefined
    const telemetry = new WowTelemetry({ db: fix.db })
    const runner = new ActionRunner({ telemetry, sleep })
    const module = makeModule('01-first-week-brief', async () => {
      throw new Error('always fails')
    })
    const ctx = buildContext(fix)
    const out = await runner.run({ module, ctx })
    expect(out.fired).toBe(false)
    expect(out.reason).toBe('substrate_error')
    const row = telemetry.list('t1')[0]!
    expect(row.success_reason).toBe('substrate_error')
    expect(row.success).toBe(false)
  })

  test('non-retry-eligible action throws → substrate_error after one attempt', async () => {
    const sleeps: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms)
    }
    const telemetry = new WowTelemetry({ db: fix.db })
    const runner = new ActionRunner({ telemetry, sleep })
    let attempts = 0
    const module = makeModule('05-followup-email-draft', async () => {
      attempts += 1
      throw new Error('one-shot failure')
    })
    const ctx = buildContext(fix)
    const out = await runner.run({ module, ctx })
    expect(attempts).toBe(1)
    expect(sleeps.length).toBe(0)
    expect(out.fired).toBe(false)
    expect(out.reason).toBe('substrate_error')
  })

  test('trigger predicate throw is recorded as trigger_threw', async () => {
    const sleep = async (): Promise<void> => undefined
    const telemetry = new WowTelemetry({ db: fix.db })
    const runner = new ActionRunner({ telemetry, sleep })
    const module: WowActionModule = {
      action_id: '01-first-week-brief',
      triggerCondition: () => {
        throw new Error('predicate broken')
      },
      run: async () => ({ fired: false, reason: 'unreachable' }),
    }
    const ctx = buildContext(fix)
    const out = await runner.run({ module, ctx })
    expect(out.fired).toBe(false)
    expect(out.reason).toBe('trigger_threw')
  })

  // 2026-06-10 wow-hang-resilience (prod incident t-33333333) — the
  // per-action timeout is the hang→handled converter. See
  // ActionRunnerDeps.action_timeout_ms.
  describe('per-action timeout', () => {
    test('an action whose run() NEVER settles is converted to a timeout failure', async () => {
      const sleep = async (): Promise<void> => undefined
      const telemetry = new WowTelemetry({ db: fix.db })
      const runner = new ActionRunner({ telemetry, sleep, action_timeout_ms: 50 })
      const module = makeModule(
        '01-first-week-brief',
        // The prod failure shape: pending forever — no resolve, no reject.
        () => new Promise<WowActionResult>(() => {}),
      )
      const ctx = buildContext(fix)
      const t0 = Date.now()
      const out = await runner.run({ module, ctx })
      expect(Date.now() - t0).toBeLessThan(5_000)
      expect(out.fired).toBe(false)
      expect(out.reason).toBe('timeout')
      // Telemetry records the timeout so wow_events answers "what hung?".
      const rows = telemetry.list('t1')
      expect(rows.length).toBe(1)
      expect(rows[0]?.success_reason).toBe('timeout')
    })

    test('a timeout does NOT consume the substrate-error retry (no second hang window)', async () => {
      let attempts = 0
      const sleeps: number[] = []
      const sleep = async (ms: number): Promise<void> => {
        sleeps.push(ms)
      }
      const telemetry = new WowTelemetry({ db: fix.db })
      const runner = new ActionRunner({ telemetry, sleep, action_timeout_ms: 50 })
      // Retry-ELIGIBLE action id — but a hang must fail fast, not retry.
      const module = makeModule('01-first-week-brief', () => {
        attempts += 1
        return new Promise<WowActionResult>(() => {})
      })
      const ctx = buildContext(fix)
      const out = await runner.run({ module, ctx })
      expect(attempts).toBe(1)
      expect(sleeps).toEqual([]) // no retry backoff was slept
      expect(out.reason).toBe('timeout')
    })

    test('a fast action is unaffected by the timeout (timer cleared on win path)', async () => {
      const sleep = async (): Promise<void> => undefined
      const telemetry = new WowTelemetry({ db: fix.db })
      const runner = new ActionRunner({ telemetry, sleep, action_timeout_ms: 60_000 })
      const module = makeModule('07-overnight-pass', async () => ({
        fired: true,
        reason: 'scheduled',
      }))
      const ctx = buildContext(fix)
      const out = await runner.run({ module, ctx })
      expect(out.fired).toBe(true)
      expect(out.reason).toBe('scheduled')
    })
  })
})
