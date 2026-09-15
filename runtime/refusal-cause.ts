import { createLogger } from '@neutronai/logger'

const log = createLogger('trident')

/**
 * Shared persistence bound for caught causes that become refusal detail.
 * This remains mirrored in `trident/inner-workflow.mjs`, which cannot import TS.
 */
export const TERMINAL_CAUSE_MAX = 500

/** Preserve the full host exception in the journal while bounding persisted refusal detail. */
export function unknownCause(detail: string, error: unknown, runId: string): string {
  const cause = String(error)
  log.error('refusal_cause', { run_id: runId, error: cause })
  return `${detail}: ${cause.slice(0, TERMINAL_CAUSE_MAX)}`
}
