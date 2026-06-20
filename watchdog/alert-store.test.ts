import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { AlertStore } from './alert-store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-alertstore-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('AlertStore', () => {
  test('record + listOpen round-trip', async () => {
    const store = new AlertStore(db)
    await store.record({
      id: 'a1',
      kind: 'stuck_agent',
      project_slug: 't1',
      detected_at: 1000,
      resolved_at: null,
      payload: { pid: 999, name: 'agent-1' },
    })
    const open = store.listOpen('t1')
    expect(open.length).toBe(1)
    expect(open[0]?.kind).toBe('stuck_agent')
    expect(open[0]?.payload).toEqual({ pid: 999, name: 'agent-1' })
  })

  test('resolve flips resolved_at and excludes from listOpen', async () => {
    const store = new AlertStore(db)
    await store.record({
      id: 'a1',
      kind: 'crashed_agent',
      project_slug: 't1',
      detected_at: 1000,
      resolved_at: null,
      payload: {},
    })
    await store.resolve('a1', 2000)
    expect(store.listOpen('t1').length).toBe(0)
    expect(store.listAll('t1').length).toBe(1)
  })
})
