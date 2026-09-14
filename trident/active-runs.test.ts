import { describe, expect, it } from 'bun:test'
import { countActiveBuildRuns, probeBuildFleet, describeBuildFleet, type FleetSnapshot } from './active-runs.ts'
import { parseCodeCommand } from './code-command.ts'

const snapshot = (n: number): FleetSnapshot => ({ status: 'known', reason: null, lanes:
  Array.from({ length: n }, (_, i) => ({ id: `lane-${i}`, run_id: null, owner: 'live',
    processes: [{ pid: i + 10, started_at: 1000, cwd: '/tmp/build' }] })) })

describe('process-backed build census', () => {
  it('counts zero, one, four and more than the old row cap from live evidence', () => {
    for (const n of [0, 1, 4, 501]) expect(countActiveBuildRuns(() => snapshot(n))).toBe(n)
  })
  it('does not count stale rows even when every row claims a build phase', () => {
    // The OLD count was this store's row count. Seven rows say `forge-init`, every one
    // of them a build that is no longer running. The census sees one process, so the
    // count is one and the rendering shows one lane — the rows change neither. This is
    // the positive control that the store is still reachable and still says seven.
    const store = {
      listNonTerminal: () => Array.from({ length: 7 }, () => ({ phase: 'forge-init' })),
      get: () => null,
    }
    expect(store.listNonTerminal()).toHaveLength(7)
    expect(countActiveBuildRuns(() => snapshot(0))).toBe(0)
    expect(countActiveBuildRuns(() => snapshot(1))).toBe(1)
    expect(describeBuildFleet(store, () => snapshot(1)).text).toContain('Running build lanes: 1')
  })
  it('unknown never becomes zero, including a partially readable fleet', () => {
    for (const n of [0, 2]) {
      const probe = (): FleetSnapshot => ({ ...snapshot(n), status: 'unknown', reason: 'permission denied' })
      expect(() => countActiveBuildRuns(probe)).toThrow('permission denied')
      const response = describeBuildFleet({ get: () => null }, probe)
      expect(response.error?.code).toBe('backend_error')
      expect(response.text).toContain('Running build lanes: UNKNOWN')
    }
  })
  it('exposes process start, PID, unmatched lanes, owner death and unavailable cost', () => {
    const fleet = snapshot(1)
    fleet.lanes[0]!.owner = 'dead'
    const response = describeBuildFleet({ get: () => null }, () => fleet)
    expect(response.text).toContain('Running build lanes: 1')
    expect(response.text).toContain('PID 10 | since 1970-01-01T00:16:40.000Z')
    expect(response.text).toContain('run untracked | PR unknown | owner dead')
    expect(response.text).toContain('Cost: unavailable (#554)')
    expect(response.error).toBeUndefined()
    expect(parseCodeCommand('/code fleet')).toEqual({ kind: 'fleet' })
  })
})

it('joins PR metadata and keeps metadata errors distinct from process counts', () => {
  const fleet = snapshot(1)
  fleet.lanes[0]!.run_id = 'run-proof'
  expect(describeBuildFleet({ get: (id) => ({ id, pr: 615 }) }, () => fleet).text).toContain('run run-proof | PR 615')
  const failed = describeBuildFleet({ get: () => { throw new Error('locked') } }, () => fleet)
  expect(failed.error?.code).toBe('backend_error')
  expect(failed.text).toContain('Run metadata: UNKNOWN')
})

it('helper errors and malformed responses are unknown, never an empty fleet', () => {
  const output = (stdout: string, status = 0) => ({ stdout, stderr: '', status, signal: null, pid: 1, output: [] })
  expect(probeBuildFleet(() => output(JSON.stringify(snapshot(0)))).status).toBe('known')
  for (const result of [output(JSON.stringify(snapshot(0)), 3), output('not json'), output('{}'), output('{"status":"known","lanes":null}')]) {
    expect(probeBuildFleet(() => result).status).toBe('unknown')
  }
  expect(probeBuildFleet(() => { throw new Error('unavailable') }).status).toBe('unknown')
})
