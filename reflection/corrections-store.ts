/**
 * @neutronai/reflection — the corrections-log store.
 *
 * Vajra self-improves through `Resources/system/corrections-log.md`: when the
 * owner corrects or redirects the agent (or confirms a non-obvious approach),
 * the learning is logged — what was wrong, what's right, why — and the agent
 * ADAPTS SILENTLY (no "I've noted that" announcement). This is the Neutron-
 * native equivalent for a self-hoster.
 *
 * Single append-only markdown file under the owner home:
 *
 *   <ownerDataDir>/corrections/corrections-log.md
 *
 * Each correction is a `## ` block with fixed, one-line bullet fields so the
 * file is BOTH human-readable (open it in Obsidian) and machine-parseable
 * (`readRecentCorrections` round-trips it deterministically). Append-only: a
 * write never edits a prior block.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Correction } from './types.ts'

export interface AppendCorrectionInput {
  /** Owner data dir (NEUTRON_HOME). Writes under `<dir>/corrections/`. */
  ownerDataDir: string
  /** What the agent did / assumed. */
  wrong: string
  /** What the owner wants instead — the durable learning. Required. */
  right: string
  /** Why — reason / context. */
  why?: string
  /** Scope (topic id or `general`). Defaults to `general`. */
  scope?: string
  /** Short excerpt of the correcting message, for provenance. */
  source?: string
  /** Override the wall clock (tests). Defaults to `Date.now()`. */
  observed_at?: number
}

export interface ReadCorrectionsInput {
  ownerDataDir: string
  /** Hard cap on returned entries (newest-first). Defaults to 25. */
  limit?: number
}

function correctionsDir(ownerDataDir: string): string {
  return join(ownerDataDir, 'corrections')
}

function logPath(ownerDataDir: string): string {
  return join(correctionsDir(ownerDataDir), 'corrections-log.md')
}

const FILE_HEADER = [
  '---',
  'kind: corrections-log',
  '---',
  '',
  '# Corrections Log',
  '',
  'Append-only record of the owner correcting / redirecting the agent (or',
  'confirming a non-obvious approach). The agent reads recent entries each',
  'session and ADAPTS SILENTLY — it does not re-announce that it noted them.',
  '',
].join('\n')

/** Collapse to one line so a bullet field never spans rows. */
function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Derive a stable, sortable id from the timestamp: `c-<ms-in-base36>`. Two
 * corrections in the same millisecond get a counter suffix so ids stay unique
 * within a process; cross-process collisions are astronomically unlikely and
 * never affect retrieval (id is provenance, not a key).
 */
let lastMs = 0
let sameMsCounter = 0
function nextId(ms: number): string {
  if (ms === lastMs) {
    sameMsCounter += 1
  } else {
    lastMs = ms
    sameMsCounter = 0
  }
  const suffix = sameMsCounter > 0 ? `-${sameMsCounter}` : ''
  return `c-${ms.toString(36)}${suffix}`
}

/**
 * Append one correction. Creates the dir + file (with header) on first write.
 * Returns the persisted `Correction`. Throws only on an empty `right` (a
 * correction with no learning is meaningless) or an un-writable directory.
 */
export function appendCorrection(input: AppendCorrectionInput): Correction {
  const right = oneLine(input.right)
  if (right.length === 0) throw new Error('reflection corrections: empty `right`')
  const observed_at = input.observed_at ?? Date.now()
  const ts = new Date(observed_at).toISOString()
  const id = nextId(observed_at)
  const wrong = oneLine(input.wrong ?? '')
  const why = oneLine(input.why ?? '')
  const scope = oneLine(input.scope ?? 'general') || 'general'
  const source = oneLine(input.source ?? '')

  const dir = correctionsDir(input.ownerDataDir)
  mkdirSync(dir, { recursive: true })
  const path = logPath(input.ownerDataDir)
  if (!existsSync(path)) appendFileSync(path, FILE_HEADER, { mode: 0o600 })

  const block = [
    `## ${ts} · ${id}`,
    '',
    `- **wrong:** ${wrong}`,
    `- **right:** ${right}`,
    `- **why:** ${why}`,
    `- **scope:** ${scope}`,
    `- **source:** ${source}`,
    '',
    '',
  ].join('\n')
  appendFileSync(path, block, { mode: 0o600 })

  return { id, ts, wrong, right, why, scope, source }
}

/** Pull a `- **field:** value` bullet's value out of a block, or '' if absent. */
function field(block: string, name: string): string {
  const re = new RegExp(`^- \\*\\*${name}:\\*\\* ?(.*)$`, 'm')
  const m = block.match(re)
  return m && typeof m[1] === 'string' ? m[1].trim() : ''
}

/**
 * Read recent corrections, newest-first, capped at `limit` (default 25).
 * Missing file → `[]`. Parsing is tolerant: a block missing optional fields
 * still parses (only `right` is load-bearing for application).
 */
export function readRecentCorrections(input: ReadCorrectionsInput): Correction[] {
  const path = logPath(input.ownerDataDir)
  if (!existsSync(path)) return []
  const limit = Math.max(0, input.limit ?? 25)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  // Split on the `## ` block headers, keeping the header line with its block.
  const blocks: Correction[] = []
  const parts = raw.split(/\n(?=## )/)
  for (const part of parts) {
    const headerMatch = part.match(/^## (\S+) · (\S+)/m)
    if (headerMatch === null) continue
    const ts = headerMatch[1] ?? ''
    const id = headerMatch[2] ?? ''
    const right = field(part, 'right')
    if (right.length === 0) continue
    blocks.push({
      id,
      ts,
      wrong: field(part, 'wrong'),
      right,
      why: field(part, 'why'),
      scope: field(part, 'scope') || 'general',
      source: field(part, 'source'),
    })
  }
  // File is append-only oldest-first; return newest-first.
  blocks.reverse()
  return limit > 0 ? blocks.slice(0, limit) : blocks
}
