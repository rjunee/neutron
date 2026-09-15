import { createLogger } from '@neutronai/logger'
import { TERMINAL_CAUSE_MAX } from '../inner-loop.ts'

const log = createLogger('trident')

/** Preserve the full host exception in the journal while bounding its relayed refusal. */
export function unknownCause(message: string, error: unknown, runId: string): { kind: 'unknown'; detail: string } {
  const cause = String(error)
  log.error('gate_host_observation_failed', { run_id: runId, gate: message, cause })
  return { kind: 'unknown', detail: `${message}: ${cause}`.slice(0, TERMINAL_CAUSE_MAX) }
}
