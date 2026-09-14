/** Local Linux build census. Rows enrich process evidence; they never create it. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { TridentRun } from './store.ts'

export interface FleetLane {
  id: string
  run_id: string | null
  owner: 'live' | 'dead' | 'unknown'
  processes: { pid: number; started_at: number; cwd: string }[]
}
export type FleetSnapshot = {
  status: 'known' | 'unknown'
  reason: string | null
  observed_at?: number
  lanes: FleetLane[]
}

/** The helper checks pidfds after reading identity, excluding exited/reused PIDs. */
function runCensus() {
  return spawnSync('python3', ['-B', fileURLToPath(new URL('./lane-processes.py', import.meta.url)), 'census'], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
    })
}

export function probeBuildFleet(run = runCensus): FleetSnapshot {
  try {
    const result = run()
    if (result.error || result.status !== 0) throw new Error('process census unavailable')
    const value = JSON.parse(result.stdout) as FleetSnapshot
    if (!['known', 'unknown'].includes(value.status) || !Array.isArray(value.lanes)) {
      throw new Error('invalid process census')
    }
    return value
  } catch {
    return { status: 'unknown', reason: 'process census unavailable', lanes: [] }
  }
}

/** Unknown throws into the launcher's existing planned-fan-out fallback. */
export function countActiveBuildRuns(probe = probeBuildFleet): number {
  const snapshot = probe()
  if (snapshot.status === 'unknown') throw new Error(snapshot.reason ?? 'process census unknown')
  return snapshot.lanes.length
}

/** `/code fleet`: all local same-user lane claims, including ones without rows. */
export function describeBuildFleet(store: { get(id: string): Pick<TridentRun, 'id' | 'pr'> | null }, probe = probeBuildFleet) {
  const snapshot = probe()
  const lines = [snapshot.status === 'known'
    ? `Running build lanes: ${snapshot.lanes.length}`
    : `Running build lanes: UNKNOWN (${snapshot.reason})`,
  'Scope: local same-user lane claims and unclaimed Codex build wrappers. Cost: unavailable (#554).']
  try {
    for (const lane of snapshot.lanes) {
      const run = lane.run_id ? store.get(lane.run_id) : null
      lines.push(`Lane ${lane.id} | run ${run?.id ?? lane.run_id ?? 'untracked'} | PR ${run?.pr ?? 'unknown'} | owner ${lane.owner}`)
      for (const proc of lane.processes) {
        lines.push(`  PID ${proc.pid} | since ${new Date(proc.started_at * 1000).toISOString()} | ${proc.cwd}`)
      }
    }
  } catch {
    return { text: `${lines.join('\n')}\nRun metadata: UNKNOWN`, data: snapshot,
      error: { code: 'backend_error' as const, message: 'run metadata unavailable' } }
  }
  return { text: lines.join('\n'), data: snapshot,
    ...(snapshot.status === 'unknown' ? { error: { code: 'backend_error' as const, message: snapshot.reason ?? 'process census unknown' } } : {}) }
}
