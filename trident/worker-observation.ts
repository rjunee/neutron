import type { TridentRun } from './store.ts'

/** Structural boundary with the terminal observer; statuses do not extend the
 * database's subagent lifecycle enum. Unknown is an observation, not failure. */
export interface RunWorkerObservation {
  state: 'blocked' | 'working' | 'unknown'
  observed_at: string
  detail: string
  screen: string
}
export type RunWorkerObserver = (run: TridentRun) => Promise<RunWorkerObservation>

export function unknownWorkerObservation(detail: string, observed_at = new Date().toISOString()): RunWorkerObservation {
  return { state: 'unknown', observed_at, detail, screen: '' }
}

export function workerEvidence(o: RunWorkerObservation): string {
  return `worker=${o.state}; observed_at=${o.observed_at}; ${o.detail}; last screen:\n${o.screen || '(capture unavailable)'}`
}
