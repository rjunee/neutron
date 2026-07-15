/**
 * @neutronai/onboarding — append-only JSONL transcript.
 *
 * Per docs/plans/P2-onboarding.md § 2.8. Each onboarding session writes
 * one JSONL file at `<owner_home>/persona/onboarding-transcript.jsonl`.
 * One line per event; each line a complete JSON object. Used for: audit,
 * agent context on resume, persona-file generation Pass.
 *
 * The format is deliberately the most resilient log format — partial
 * writes only corrupt the in-progress final line, which a forward reader
 * can drop without losing prior events.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '@neutronai/logger'

const log = createLogger('onboarding-transcript')

export type TranscriptRole = 'agent' | 'user' | 'system'

export interface TranscriptEntry {
  /** Unix ms when the entry was appended. */
  ts: number
  role: TranscriptRole
  /** The natural-language body for `agent` / `user` lines, or a structured
   *  description for `system` entries (e.g. "phase advanced: signup →
   *  name_chosen"). */
  body: string
  /** Phase the engine was in when this entry landed. Optional so legacy
   *  test fixtures that don't yet model phase still validate. */
  phase?: string
  /** When the entry was driven by a button-prompt emit / resolve, this
   *  carries the prompt_id so a reader can correlate entries with rows in
   *  `button_prompts`. */
  button_prompt_id?: string
  /** When the entry IS a user button choice, this is the choice value. */
  button_choice?: string
}

export interface TranscriptWriterOptions {
  /** Absolute path to the JSONL file. The parent dir is created if absent. */
  path: string
  now?: () => number
}

export class TranscriptWriter {
  private readonly path: string
  private readonly now: () => number

  constructor(opts: TranscriptWriterOptions) {
    this.path = opts.path
    this.now = opts.now ?? ((): number => Date.now())
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    if (!existsSync(this.path)) writeFileSync(this.path, '', { mode: 0o644 })
  }

  /** Append one entry. Synchronous + idempotent on the line level — JSONL
   *  has no concept of duplicate-line dedup; the engine layer dedupes
   *  upstream. Throws on disk error. */
  append(entry: Omit<TranscriptEntry, 'ts'> & { ts?: number }): TranscriptEntry {
    const ts = entry.ts ?? this.now()
    const persisted: TranscriptEntry = { ts, role: entry.role, body: entry.body }
    if (entry.phase !== undefined) persisted.phase = entry.phase
    if (entry.button_prompt_id !== undefined) persisted.button_prompt_id = entry.button_prompt_id
    if (entry.button_choice !== undefined) persisted.button_choice = entry.button_choice
    appendFileSync(this.path, JSON.stringify(persisted) + '\n')
    return persisted
  }

  /** Read every entry. Drops a malformed final line (likely a partial
   *  write from a crash) but logs a warn so ops can spot it. */
  readAll(): TranscriptEntry[] {
    const text = readFileSync(this.path, 'utf8')
    const out: TranscriptEntry[] = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.length === 0) continue
      try {
        out.push(JSON.parse(line) as TranscriptEntry)
      } catch {
        const isLast = i === lines.length - 1
        if (!isLast) {
          // A non-trailing malformed line is a real corruption — surface
          // it loudly. Final line might be a partial write, swallow it.
          log.warn('dropped_malformed_line', { line: i + 1, path: this.path })
        }
      }
    }
    return out
  }

  /** Path the entries land at — surfaced so callers can attach the file
   *  to support tickets or move it on instance migration. */
  filePath(): string {
    return this.path
  }
}
