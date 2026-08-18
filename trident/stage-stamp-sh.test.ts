import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '../migrations/runner.ts'

const SCRIPT = fileURLToPath(new URL('./stage-stamp.sh', import.meta.url))

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trident-stage-stamp-sh-'))
  dbPath = join(dir, 'project.db')
  const db = ProjectDb.open(dbPath)
  applyMigrations(db.raw())
  db.close()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function stamp(args: string[]): { code: number; stderr: string } {
  const result = Bun.spawnSync(['bash', SCRIPT, ...args])
  return { code: result.exitCode, stderr: result.stderr.toString() }
}

function events(path = dbPath): Array<{
  run_id: string
  stage: string
  at: string
  meta: string | null
}> {
  const db = new Database(path, { readonly: true })
  const rows = db
    .query('SELECT run_id, stage, at, meta FROM code_trident_stage_events ORDER BY id')
    .all() as Array<{ run_id: string; stage: string; at: string; meta: string | null }>
  db.close()
  return rows
}

describe('stage-stamp.sh — append-only best-effort writer', () => {
  test('records run, stage, millisecond UTC timestamp, and meta', () => {
    const result = stamp([dbPath, 'run-1', 'wrapper-start', 'round=1'])
    expect(result.code).toBe(0)
    expect(events()).toEqual([
      {
        run_id: 'run-1',
        stage: 'wrapper-start',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        meta: 'round=1',
      },
    ])
  })

  test('stores absent or empty meta as NULL', () => {
    expect(stamp([dbPath, 'run-1', 'wrapper-start']).code).toBe(0)
    expect(stamp([dbPath, 'run-1', 'codex-exec-start', '']).code).toBe(0)
    expect(events().map((event) => event.meta)).toEqual([null, null])
  })

  test('single quotes in stage and meta round-trip without changing the table', () => {
    expect(stamp([dbPath, 'run-1', "wrap'per", "meta's value"]).code).toBe(0)
    expect(events()[0]).toMatchObject({ stage: "wrap'per", meta: "meta's value" })
  })

  test('missing arguments report usage and still exit 0', () => {
    for (const args of [[], [dbPath], [dbPath, 'run-1']]) {
      const result = stamp(args)
      expect(result.code).toBe(0)
      expect(result.stderr).toContain('usage: stage-stamp.sh')
    }
  })

  test('a database path whose parent does not exist reports the failure and exits 0', () => {
    const missing = join(dir, 'missing', 'project.db')
    const result = stamp([missing, 'run-1', 'wrapper-start'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('stage-stamp.sh: stamp not recorded')
  })

  test('an unmigrated database reports the missing table and exits 0', () => {
    const unmigratedDir = join(dir, 'unmigrated')
    mkdirSync(unmigratedDir)
    const unmigrated = join(unmigratedDir, 'project.db')
    new Database(unmigrated, { create: true }).close()

    const result = stamp([unmigrated, 'run-1', 'wrapper-start'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('stage-stamp.sh: stamp not recorded')
    expect(result.stderr).toContain('code_trident_stage_events')
  })
})
