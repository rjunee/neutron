/**
 * Action 7 — overnight pass cron tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import action07 from '../07-overnight-pass.ts'
import { buildContext, makeFixture, teardown, type TestFixture } from '../../__tests__/test-helpers.ts'

let fix: TestFixture

beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

describe('action 07-overnight-pass', () => {
  test('always fires (no trigger gate)', () => {
    expect(action07.triggerCondition(buildContext(fix))).toBe(true)
  })

  test('registers cron job + records cron_state row', async () => {
    const ctx = buildContext(fix)
    const result = await action07.run(ctx)
    expect(result.fired).toBe(true)
    expect(result.reason).toBe('scheduled')
    const job = fix.cron_jobs.get('overnight-t1')
    expect(job).toBeDefined()
    expect(job?.handler).toBe('overnight_handler')
    expect(job?.schedule.kind).toBe('interval_ms')
    const state = fix.cron_state.get('overnight-t1', 't1')
    expect(state).not.toBeNull()
    expect(state?.last_run_status).toBe('ok')
  })

  test('idempotent — re-running does not throw on duplicate registration', async () => {
    const ctx = buildContext(fix)
    await action07.run(ctx)
    const second = await action07.run(ctx)
    expect(second.fired).toBe(true)
    expect(second.reason).toBe('already_scheduled')
  })

  test('underscore in project_slug normalized to dash for job_name', async () => {
    const ctx = buildContext(fix, { project_slug: 'workspace_one' })
    await action07.run(ctx)
    expect(fix.cron_jobs.get('overnight-workspace-one')).toBeDefined()
  })
})
