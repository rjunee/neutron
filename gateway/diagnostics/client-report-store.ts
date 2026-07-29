/**
 * @neutronai/gateway/diagnostics — on-host store for app client reports.
 *
 * WHERE THE REPORTS GO
 * --------------------
 * `<owner_home>/diagnostics/client-reports.jsonl` — one JSON object per line,
 * oldest first. A JSONL file (not a table) because the operator reading it is a
 * person on their own machine with `tail`, `grep` and `jq`, and the whole point
 * of this feature is that diagnosing a phone failure should not require a USB
 * cable, a SaaS account, OR a sqlite client:
 *
 *     tail -n 5 ~/.neutron/diagnostics/client-reports.jsonl | jq .
 *
 * BOUNDED HISTORY
 * ---------------
 * The file is trimmed to the most recent `max_records` lines on every append,
 * so a device stuck in a crash loop cannot grow it without limit. Trimming is a
 * read-modify-write of a file capped at a few hundred small lines — cheap, and
 * far simpler than a rotation scheme nobody would ever tune.
 *
 * FAIL-LOUD ON WRITE, FAIL-SOFT ON READ
 * -------------------------------------
 * `append` propagates an IO failure so the surface answers non-2xx and the
 * device KEEPS the report queued for the next launch (see
 * `app/lib/diagnostic-queue.ts`) — silently swallowing the write would destroy
 * the only copy. `list` degrades to the lines it can parse, so one corrupt line
 * (a half-written record after a power cut) never hides the rest of the history.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { StoredClientReport } from './client-report-redaction.ts'

/** One persisted line: the report plus what the GATEWAY knows about it. The
 *  server-observed fields are authoritative — a device cannot spoof who it
 *  authenticated as or when the report landed. */
export interface ClientReportRecord {
  /** Epoch ms the gateway accepted the report (server clock, not the device's). */
  received_at: number
  /** Resolved from the bearer, never taken from the payload. */
  user_id: string
  report: StoredClientReport
}

export interface ClientReportStore {
  /** Append records, then trim to the retention cap. Throws on IO failure. */
  append(records: readonly ClientReportRecord[]): void
  /** Most recent `limit` records, NEWEST FIRST. Never throws. */
  list(limit: number): ClientReportRecord[]
}

export const DEFAULT_MAX_RECORDS = 500

export interface FileClientReportStoreOptions {
  /** Absolute path to the JSONL file. Parent directories are created. */
  path: string
  /** Retention cap in records. Defaults to `DEFAULT_MAX_RECORDS`. */
  max_records?: number
}

export class FileClientReportStore implements ClientReportStore {
  private readonly path: string
  private readonly maxRecords: number

  constructor(opts: FileClientReportStoreOptions) {
    this.path = opts.path
    this.maxRecords = Math.max(1, opts.max_records ?? DEFAULT_MAX_RECORDS)
  }

  append(records: readonly ClientReportRecord[]): void {
    if (records.length === 0) return
    mkdirSync(dirname(this.path), { recursive: true })
    const lines = records.map((record) => JSON.stringify(record)).join('\n')
    appendFileSync(this.path, `${lines}\n`, 'utf8')
    this.trim()
  }

  list(limit: number): ClientReportRecord[] {
    const bounded = Math.max(0, Math.floor(limit))
    if (bounded === 0) return []
    const parsed = this.readAll()
    // Oldest-first on disk; the reader wants the newest failure first.
    return parsed.slice(-bounded).reverse()
  }

  /** Rewrite the file holding only the newest `maxRecords` lines. No-op while
   *  the file is within cap, so the steady state is a pure append. */
  private trim(): void {
    const raw = this.readRaw()
    if (raw === null) return
    const lines = raw.split('\n').filter((line) => line.trim().length > 0)
    if (lines.length <= this.maxRecords) return
    writeFileSync(this.path, `${lines.slice(-this.maxRecords).join('\n')}\n`, 'utf8')
  }

  private readRaw(): string | null {
    if (!existsSync(this.path)) return null
    try {
      return readFileSync(this.path, 'utf8')
    } catch {
      return null
    }
  }

  private readAll(): ClientReportRecord[] {
    const raw = this.readRaw()
    if (raw === null) return []
    const out: ClientReportRecord[] = []
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        out.push(JSON.parse(line) as ClientReportRecord)
      } catch {
        // One unparseable line (a torn write) must not hide the history
        // around it — skip it and keep reading.
      }
    }
    return out
  }
}
