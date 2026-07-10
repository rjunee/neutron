/**
 * REAL-sqlite tests for `trident/checkpoint.sh` (refactor P10) — the checked-in
 * checkpoint-writer the inner workflow's Bash steps invoke instead of
 * LLM-transcribed inline SQL. Mirrors the merge-realgit.test.ts discipline: the
 * script IS shell + the sqlite3 CLI, so it is exercised against a real
 * throwaway database file, not a mock (no-mock-past-the-seam).
 *
 * What this suite pins (the P10 accept criteria):
 *   1. the UPDATE semantics are UNCHANGED from the inline SQL it replaced —
 *      same columns/values, same WHERE-id row selection, idempotent re-runs;
 *   2. the terminal-result `inner_result_file` path keeps the readfile()
 *      JSON-safe indirection AND the column-consistency CASE (subagent_status
 *      flips to 'completed' ONLY when the result file has non-empty content);
 *   3. writes RETRY under a held lock (PRAGMA busy_timeout=5000 on the same
 *      connection) instead of failing instantly like the old busy_timeout=0.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./checkpoint.sh', import.meta.url))

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trident-checkpoint-sh-'))
  dbPath = join(dir, 'trident.db')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE code_trident_runs (
    id TEXT PRIMARY KEY,
    pr INTEGER,
    branch TEXT,
    inner_checkpoint TEXT,
    inner_verdict TEXT,
    inner_result TEXT,
    subagent_status TEXT,
    last_advanced_at TEXT
  )`)
  db.exec(`INSERT INTO code_trident_runs (id, subagent_status) VALUES ('run-1', 'pending'), ('run-other', 'pending')`)
  db.close()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function sh(args: string[]): { code: number; stderr: string } {
  const p = Bun.spawnSync(['bash', SCRIPT, ...args])
  return { code: p.exitCode, stderr: p.stderr.toString() }
}

function row(id: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true })
  const r = db.query('SELECT * FROM code_trident_runs WHERE id = ?').get(id) as Record<string, unknown>
  db.close()
  return r
}

describe('checkpoint.sh — C1 per-phase checkpoint write (legacy checkpoint() SQL)', () => {
  test('writes pr/branch/inner_checkpoint/subagent_status + stamps last_advanced_at on ONLY the addressed row', () => {
    const res = sh([dbPath, 'run-1', 'pr', '55', 'branch', 'trident/add-widget', 'inner_checkpoint', 'forge-done', 'subagent_status', 'running'])
    expect(res.code).toBe(0)
    const r = row('run-1')
    expect(r.pr).toBe(55)
    expect(r.branch).toBe('trident/add-widget')
    expect(r.inner_checkpoint).toBe('forge-done')
    expect(r.subagent_status).toBe('running')
    // Timestamp computed in-script (`date -u +%FT%TZ`), like the old Bash step.
    expect(String(r.last_advanced_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    // Untouched columns stay untouched; other rows are never selected.
    expect(r.inner_result).toBeNull()
    expect(row('run-other')).toMatchObject({ subagent_status: 'pending', branch: null, inner_checkpoint: null })
  })

  test('re-running the SAME checkpoint is idempotent (identical row state)', () => {
    const args = [dbPath, 'run-1', 'branch', 'trident/add-widget', 'inner_checkpoint', 'forge-done', 'subagent_status', 'running']
    expect(sh(args).code).toBe(0)
    const first = { ...row('run-1'), last_advanced_at: null }
    expect(sh(args).code).toBe(0)
    const second = { ...row('run-1'), last_advanced_at: null }
    expect(second).toEqual(first)
  })

  test('SQL-escapes values (a single quote cannot break or inject the statement)', () => {
    const res = sh([dbPath, 'run-1', 'branch', "tri'dent", 'inner_checkpoint', "fix'; DROP TABLE code_trident_runs; --"])
    expect(res.code).toBe(0)
    expect(row('run-1').branch).toBe("tri'dent")
    expect(row('run-1').inner_checkpoint).toBe("fix'; DROP TABLE code_trident_runs; --")
  })
})

describe('checkpoint.sh — terminal-result write (legacy writeTerminalResult() SQL)', () => {
  const json = '{"ok":true,"verdict":"APPROVE","prNumber":55,"branch":"trident/add-widget","round":1,"checkpoint":"argus-approved"}'

  test('inner_result_file loads the JSON via readfile() and flips subagent_status to completed; idempotent', () => {
    const tmp = join(dir, 'terminal.json')
    writeFileSync(tmp, json)
    const args = [dbPath, 'run-1', 'inner_result_file', tmp, 'inner_verdict', 'APPROVE', 'branch', 'trident/add-widget', 'pr', '55']
    expect(sh(args).code).toBe(0)
    const first = row('run-1')
    // The JSON round-trips byte-identically (readfile CAST AS TEXT — its own
    // double quotes never touch the sqlite shell argument).
    expect(first.inner_result).toBe(json)
    expect(first.inner_verdict).toBe('APPROVE')
    expect(first.subagent_status).toBe('completed')
    expect(first.pr).toBe(55)
    // Idempotent re-run → same row state.
    expect(sh(args).code).toBe(0)
    expect({ ...row('run-1'), last_advanced_at: null }).toEqual({ ...first, last_advanced_at: null })
  })

  test('COLUMN CONSISTENCY: an EMPTY result file leaves subagent_status untouched (never completed-with-no-result)', () => {
    const tmp = join(dir, 'empty.json')
    writeFileSync(tmp, '')
    expect(sh([dbPath, 'run-1', 'inner_result_file', tmp, 'inner_verdict', 'APPROVE', 'branch', 'b']).code).toBe(0)
    const r = row('run-1')
    expect(r.subagent_status).toBe('pending') // unchanged — the CASE fell through to ELSE
    expect(r.inner_result).toBe('') // readfile of an empty file → empty text, not terminal (parseInnerResult → null)
  })

  test('COLUMN CONSISTENCY: a MISSING result file leaves inner_result NULL and subagent_status untouched', () => {
    expect(sh([dbPath, 'run-1', 'inner_result_file', join(dir, 'nope.json'), 'inner_verdict', 'APPROVE', 'branch', 'b']).code).toBe(0)
    const r = row('run-1')
    expect(r.inner_result).toBeNull()
    expect(r.subagent_status).toBe('pending')
  })
})

describe('checkpoint.sh — argument validation (fail loudly, touch nothing)', () => {
  test.each([
    [['run-1', 'pr', 'abc'], 'pr must be a non-negative integer'],
    [['run-1', 'pr', ''], 'pr must be a non-negative integer'],
    [['run-1', 'evil_field', 'x'], "unknown field 'evil_field'"],
    [['run-1', 'branch'], "missing value for field 'branch'"],
    [['run-1'], 'no fields given'],
  ])('rejects %j', (args, message) => {
    const res = sh([dbPath, ...(args as string[])])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain(message as string)
    expect(row('run-1').branch).toBeNull() // nothing written
  })
})

describe('checkpoint.sh — retry under lock (PRAGMA busy_timeout=5000, the P10 hardening)', () => {
  test('a write against an EXCLUSIVE-locked db retries and lands once the lock releases (old busy_timeout=0 failed instantly)', async () => {
    const holder = new Database(dbPath)
    holder.exec('BEGIN EXCLUSIVE') // hold the write lock
    const proc = Bun.spawn(['bash', SCRIPT, dbPath, 'run-1', 'inner_checkpoint', 'lock-test', 'subagent_status', 'running'], { stderr: 'pipe' })
    // Keep the lock across most of a second — far beyond busy_timeout=0's
    // instant "database is locked", well inside the 5s retry budget.
    await new Promise((r) => setTimeout(r, 750))
    holder.exec('COMMIT')
    holder.close()
    expect(await proc.exited).toBe(0)
    expect(row('run-1').inner_checkpoint).toBe('lock-test')
  })
})
