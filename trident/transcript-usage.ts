import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export const MAX_TRANSCRIPT_READ_BYTES = 1024 * 1024

export interface TranscriptAttribution {
  project: string
  topic: string
  agent: string
  phase: string
  run_id?: string | null
  /** When supplied, the rollout's own session metadata must name one of these roots. */
  expected_cwds?: readonly string[]
}

export interface TranscriptIngestResult {
  rows: number
  byte_offset: number
  caught_up: boolean
}

interface Totals {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  reasoning_tokens: number
}

interface Watermark extends Totals { byte_offset: number }

const ZERO: Totals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0 }

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Decode the cumulative usage snapshot carried by a Codex token_count event. */
export function parseTranscriptUsageLine(line: string): { observed_at: number; totals: Totals } | null {
  let root: Record<string, unknown>
  try { root = JSON.parse(line) as Record<string, unknown> } catch { return null }
  if (root['type'] !== 'event_msg') return null
  const payload = root['payload']
  if (typeof payload !== 'object' || payload === null || (payload as Record<string, unknown>)['type'] !== 'token_count') return null
  const info = (payload as Record<string, unknown>)['info']
  if (typeof info !== 'object' || info === null) return null
  const usage = (info as Record<string, unknown>)['total_token_usage']
  if (typeof usage !== 'object' || usage === null) return null
  const rec = usage as Record<string, unknown>
  const input = integer(rec['input_tokens'])
  const output = integer(rec['output_tokens'])
  if (input === null || output === null) return null
  const cached = integer(rec['cached_input_tokens'] ?? 0)
  const reasoning = integer(rec['reasoning_output_tokens'] ?? 0)
  if (cached === null || reasoning === null || cached > input || reasoning > output) return null
  const stamp = typeof root['timestamp'] === 'string' ? Date.parse(root['timestamp']) : Number.NaN
  if (!Number.isFinite(stamp) || stamp < 0) return null
  return { observed_at: stamp, totals: { input_tokens: input, output_tokens: output, cache_read_tokens: cached, reasoning_tokens: reasoning } }
}

function delta(next: Totals, prior: Totals): Totals | null {
  const result = {
    input_tokens: next.input_tokens - prior.input_tokens,
    output_tokens: next.output_tokens - prior.output_tokens,
    cache_read_tokens: next.cache_read_tokens - prior.cache_read_tokens,
    reasoning_tokens: next.reasoning_tokens - prior.reasoning_tokens,
  }
  return Object.values(result).every((value) => value >= 0) ? result : null
}

/** A bounded, durable reader. Only newline-terminated records advance its watermark. */
export class TranscriptUsageIngestor {
  constructor(private readonly db: ProjectDb) {}

  async ingest(path: string, attribution: TranscriptAttribution): Promise<TranscriptIngestResult> {
    const previous = this.db.get<Watermark>(
      'SELECT byte_offset, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens FROM transcript_usage_watermarks WHERE source_path = ?',
      [path],
    ) ?? { byte_offset: 0, ...ZERO }
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      if (size < previous.byte_offset) throw new Error('transcript shrank behind its durable watermark')
      const length = Math.min(size - previous.byte_offset, MAX_TRANSCRIPT_READ_BYTES)
      if (length === 0) return { rows: 0, byte_offset: previous.byte_offset, caught_up: true }
      const buffer = Buffer.allocUnsafe(length)
      const bytes = readSync(fd, buffer, 0, length, previous.byte_offset)
      const text = buffer.subarray(0, bytes).toString('utf8')
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline < 0) return { rows: 0, byte_offset: previous.byte_offset, caught_up: false }
      const complete = text.slice(0, lastNewline + 1)
      if (previous.byte_offset === 0 && attribution.expected_cwds !== undefined) {
        const cwd = complete.match(/[^\n]*\n/g)?.map((candidate) => {
          try {
            const record = JSON.parse(candidate) as Record<string, unknown>
            const payload = record['payload']
            return record['type'] === 'session_meta' && typeof payload === 'object' && payload !== null &&
              typeof (payload as Record<string, unknown>)['cwd'] === 'string'
              ? (payload as Record<string, unknown>)['cwd'] as string
              : null
          } catch { return null }
        }).find((value): value is string => value !== null) ?? null
        if (cwd === null || !attribution.expected_cwds.includes(cwd)) {
          throw new Error('transcript session metadata does not match the attributed run')
        }
      }
      let cursor = previous.byte_offset
      let totals: Totals = previous
      let rows = 0
      await this.db.transaction((tx) => {
        for (const lineWithNewline of complete.match(/[^\n]*\n/g) ?? []) {
          const lineOffset = cursor
          cursor += Buffer.byteLength(lineWithNewline)
          const parsed = parseTranscriptUsageLine(lineWithNewline.slice(0, -1))
          if (parsed === null) continue
          const change = delta(parsed.totals, totals)
          if (change === null) throw new Error('cumulative transcript usage moved backwards')
          tx.runSync(`INSERT INTO transcript_usage_events
            (source_path, line_offset, observed_at, project, topic, agent, phase, run_id,
             input_tokens, output_tokens, cache_read_tokens, reasoning_tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [path, lineOffset, parsed.observed_at, attribution.project, attribution.topic,
            attribution.agent, attribution.phase, attribution.run_id ?? null,
            change.input_tokens, change.output_tokens, change.cache_read_tokens, change.reasoning_tokens])
          totals = parsed.totals
          rows++
        }
        tx.runSync(`INSERT INTO transcript_usage_watermarks
          (source_path, byte_offset, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_path) DO UPDATE SET byte_offset=excluded.byte_offset,
            input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
            cache_read_tokens=excluded.cache_read_tokens, reasoning_tokens=excluded.reasoning_tokens`,
        [path, cursor, totals.input_tokens, totals.output_tokens, totals.cache_read_tokens, totals.reasoning_tokens])
      })
      return { rows, byte_offset: cursor, caught_up: cursor === size }
    } finally { closeSync(fd) }
  }
}
