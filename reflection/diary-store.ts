/**
 * @neutronai/reflection — the diary store.
 *
 * Append-only, per-UTC-day markdown files under `<ownerDataDir>/diary/`:
 *
 *   <ownerDataDir>/diary/2026-06-21.md
 *
 * Each file opens with a small frontmatter header (written once, on create)
 * and then accumulates one entry PER LINE in a stable, parseable shape that
 * mirrors the entity-writer's Timeline rows:
 *
 *   - <ISO-8601 ts> | <kind> | <session-or-> | <text>
 *
 * Append-only by contract: a write NEVER rewrites a prior line, so the file is
 * a durable, human-readable journal. Reading parses the rows back. The agent
 * can ALSO read these files directly (they live under the owner home, which the
 * live-agent REPL has Read/Glob access to) — `readRecentDiary` is the
 * structured path the context-injector uses.
 *
 * Writes go through `appendFileSync` with a leading mkdir; the per-day file is
 * the unit of concurrency and appends are atomic at the OS level for the small
 * line sizes we write (a single `write(2)` under PIPE_BUF). No torn lines.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DiaryEntry } from './types.ts'

/** Field separator for diary rows. Matches the entity-writer Timeline shape. */
const SEP = ' | '
/** Sentinel for an absent session. */
const NONE = '-'

export interface AppendDiaryInput {
  /** Owner data dir (NEUTRON_HOME). The store writes under `<dir>/diary/`. */
  ownerDataDir: string
  /** The reflection text. Required, non-empty after trim. */
  text: string
  /** Classification — defaults to `reflection`. */
  kind?: string
  /** Owning session / topic, if any. */
  session?: string | null
  /** Override the wall clock (tests). Defaults to `Date.now()`. */
  observed_at?: number
}

export interface ReadDiaryInput {
  ownerDataDir: string
  /** How many trailing UTC days of files to scan. Defaults to 7. */
  days?: number
  /** Hard cap on returned entries (after newest-first sort). Defaults to 50. */
  limit?: number
  /** Override the wall clock (tests). Defaults to `Date.now()`. */
  now?: number
}

/** Collapse newlines/tabs so an entry is always one parseable line. */
function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function diaryDir(ownerDataDir: string): string {
  return join(ownerDataDir, 'diary')
}

function dayFilePath(ownerDataDir: string, date: string): string {
  return join(diaryDir(ownerDataDir), `${date}.md`)
}

function header(date: string): string {
  return [
    '---',
    `date: ${date}`,
    'kind: diary',
    '---',
    '',
    `# Diary — ${date}`,
    '',
    'Append-only short reflections. Newest entries are at the bottom.',
    '',
  ].join('\n')
}

/**
 * Append one diary entry to today's (UTC) file. Creates the diary dir + the
 * day file (with header) on first write. Returns the written entry + its path.
 * Throws only on an empty text or a genuinely un-writable directory.
 */
export function appendDiaryEntry(input: AppendDiaryInput): DiaryEntry {
  const text = oneLine(input.text)
  if (text.length === 0) throw new Error('reflection diary: empty text')
  const observed_at = input.observed_at ?? Date.now()
  const ts = new Date(observed_at).toISOString()
  const date = utcDate(observed_at)
  const kind = oneLine(input.kind ?? 'reflection') || 'reflection'
  const session = input.session != null && input.session.trim().length > 0 ? oneLine(input.session) : null

  const dir = diaryDir(input.ownerDataDir)
  mkdirSync(dir, { recursive: true })
  const path = dayFilePath(input.ownerDataDir, date)
  if (!existsSync(path)) appendFileSync(path, header(date), { mode: 0o600 })

  const row = `- ${ts}${SEP}${kind}${SEP}${session ?? NONE}${SEP}${text}\n`
  appendFileSync(path, row, { mode: 0o600 })

  return { ts, date, kind, session, text }
}

/** Parse one stored diary row back into a `DiaryEntry`, or null if malformed. */
function parseRow(line: string, date: string): DiaryEntry | null {
  if (!line.startsWith('- ')) return null
  const body = line.slice(2)
  // Split into at most 4 fields; the text field may itself contain ` | `.
  const idx1 = body.indexOf(SEP)
  if (idx1 < 0) return null
  const idx2 = body.indexOf(SEP, idx1 + SEP.length)
  if (idx2 < 0) return null
  const idx3 = body.indexOf(SEP, idx2 + SEP.length)
  if (idx3 < 0) return null
  const ts = body.slice(0, idx1).trim()
  const kind = body.slice(idx1 + SEP.length, idx2).trim()
  const sessionRaw = body.slice(idx2 + SEP.length, idx3).trim()
  const text = body.slice(idx3 + SEP.length).trim()
  if (ts.length === 0 || text.length === 0) return null
  return {
    ts,
    date,
    kind: kind.length > 0 ? kind : 'reflection',
    session: sessionRaw === NONE || sessionRaw.length === 0 ? null : sessionRaw,
    text,
  }
}

/**
 * Read recent diary entries, newest-first, across the last `days` UTC day-files
 * (default 7), capped at `limit` (default 50). Missing dir / files yield `[]` —
 * a fresh instance with no diary is not an error.
 */
export function readRecentDiary(input: ReadDiaryInput): DiaryEntry[] {
  const dir = diaryDir(input.ownerDataDir)
  if (!existsSync(dir)) return []
  const days = Math.max(1, input.days ?? 7)
  const limit = Math.max(0, input.limit ?? 50)
  const now = input.now ?? Date.now()

  // Candidate day keys for the window, newest-first.
  const wanted = new Set<string>()
  for (let i = 0; i < days; i++) {
    wanted.add(utcDate(now - i * 86_400_000))
  }
  // Also honour any on-disk day files within the window even if the clock
  // skipped (tests write fixed dates) — intersect dir listing with wanted.
  let present: string[]
  try {
    present = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .filter((d) => wanted.has(d))
      .sort()
      .reverse()
  } catch {
    return []
  }

  const out: DiaryEntry[] = []
  for (const date of present) {
    let raw: string
    try {
      raw = readFileSync(dayFilePath(input.ownerDataDir, date), 'utf8')
    } catch {
      continue
    }
    const rows: DiaryEntry[] = []
    for (const line of raw.split('\n')) {
      const entry = parseRow(line, date)
      if (entry !== null) rows.push(entry)
    }
    // Within a day file, newest entries are at the bottom — reverse to newest-first.
    rows.reverse()
    for (const e of rows) {
      out.push(e)
      if (out.length >= limit && limit > 0) return out
    }
  }
  return out
}
