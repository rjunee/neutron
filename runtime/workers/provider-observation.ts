import type { ProviderObservation } from '../bounded-work.ts'

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Read only host-owned observation receipts; a corrupt receipt is unknown telemetry. */
export function readProviderObservation(bytes: string, source: ProviderObservation['source']): ProviderObservation | undefined {
  try {
    const value = JSON.parse(bytes) as ProviderObservation
    if (!value || value.source !== source || count(value.started_at_ms) === null || count(value.finished_at_ms) === null
      || value.finished_at_ms < value.started_at_ms || value.observed_at_ms !== value.finished_at_ms
      || !(value.model_reported === null || text(value.model_reported) !== null)
      || !(value.thread_id === null || text(value.thread_id) !== null)) return undefined
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
      if (value.usage[key] !== null && count(value.usage[key]) === null) return undefined
    }
    const cost = value.usage.cost_usd
    if (cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) return undefined
    return value
  } catch { return undefined }
}

/** Only call with host-read CLI stdout. Never pass a model-authored result envelope. */
export function claudeObservation(bytes: string, started_at_ms: number, finished_at_ms: number): ProviderObservation {
  let receipt: Record<string, unknown> = {}
  try { const parsed = record(JSON.parse(bytes)); if (parsed.type === 'result') receipt = parsed } catch { /* unavailable */ }
  const usage = record(receipt.usage)
  const models = Object.keys(record(receipt.modelUsage))
  return { source: 'claude-cli-json', started_at_ms, finished_at_ms, observed_at_ms: finished_at_ms,
    model_reported: models.length === 1 ? models[0]! : null, thread_id: text(receipt.session_id),
    usage: { input_tokens: count(usage.input_tokens), output_tokens: count(usage.output_tokens),
      cache_read_input_tokens: count(usage.cache_read_input_tokens),
      cache_creation_input_tokens: count(usage.cache_creation_input_tokens),
      cost_usd: typeof receipt.total_cost_usd === 'number' && Number.isFinite(receipt.total_cost_usd)
        && receipt.total_cost_usd >= 0 ? receipt.total_cost_usd : null } }
}

/** Codex input_tokens includes cached_input_tokens. Keep disjoint accounting
 * unknown when that split is unavailable or contradictory; never count it twice. */
export function codexObservation(usageValue: unknown, thread: string | null, started_at_ms: number,
  finished_at_ms: number): ProviderObservation {
  const usage = record(usageValue)
  const total = count(usage.input_tokens), cached = count(usage.cached_input_tokens)
  const coherent = total !== null && cached !== null && cached <= total
  return { source: 'codex-cli-jsonl', started_at_ms, finished_at_ms, observed_at_ms: finished_at_ms,
    model_reported: null, thread_id: thread,
    usage: { input_tokens: coherent ? total - cached : null,
      output_tokens: count(usage.output_tokens), cache_read_input_tokens: total !== null && cached !== null && cached > total ? null : cached,
      cache_creation_input_tokens: null, cost_usd: null } }
}
