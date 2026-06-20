import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { TridentRunStore } from './store.ts'
import {
  stubAdvanceDeps,
  type AdvanceDeps,
  type SubagentOutcome,
} from './state-machine.ts'
import { TridentTickLoop } from './tick.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-tick-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const fixedNow = '2026-01-01T01:00:00.000Z'

/** Deps that report a fixed outcome for whichever run is classified. */
function depsWith(outcome: SubagentOutcome): AdvanceDeps {
  return { now: () => fixedNow, classify: async () => outcome }
}

describe('TridentTickLoop.runOnce', () => {
  test('advances every non-terminal run whose sub-agent completed', async () => {
    const store = new TridentRunStore(db)
    const a = await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    const b = await store.create({ slug: 'b', project_slug: 't1', repo_path: '/r', task: 't' })

    const loop = new TridentTickLoop({ store, deps: depsWith({ status: 'completed', result: {} }) })
    const res = await loop.runOnce()

    // both forge-init → argus
    expect(res.advanced).toBe(2)
    expect(store.get(a.id)?.phase).toBe('argus')
    expect(store.get(b.id)?.phase).toBe('argus')
  })

  test('does not touch terminal runs (only queries non-terminal)', async () => {
    const store = new TridentRunStore(db)
    const done = await store.create({ slug: 'done', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.save({ ...done, phase: 'done' })
    const active = await store.create({ slug: 'active', project_slug: 't1', repo_path: '/r', task: 't' })

    const loop = new TridentTickLoop({ store, deps: depsWith({ status: 'completed', result: {} }) })
    const res = await loop.runOnce()

    expect(res.advanced).toBe(1)
    expect(store.get(done.id)?.phase).toBe('done')
    expect(store.get(active.id)?.phase).toBe('argus')
  })

  test('idempotent: a running sub-agent advances nothing', async () => {
    const store = new TridentRunStore(db)
    const a = await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    const loop = new TridentTickLoop({ store, deps: stubAdvanceDeps(() => fixedNow) })

    expect((await loop.runOnce()).advanced).toBe(0)
    expect((await loop.runOnce()).advanced).toBe(0)
    expect(store.get(a.id)?.phase).toBe('forge-init')
  })

  test('per_tick_limit caps the per-tick advance count', async () => {
    const store = new TridentRunStore(db)
    for (let i = 0; i < 5; i++) {
      await store.create({ slug: `r${i}`, project_slug: 't1', repo_path: '/r', task: 't' })
    }
    const loop = new TridentTickLoop({
      store,
      deps: depsWith({ status: 'completed', result: {} }),
      per_tick_limit: 2,
    })
    expect((await loop.runOnce()).advanced).toBe(2)
    // 3 still in forge-init
    expect(store.listNonTerminal().filter((r) => r.phase === 'forge-init').length).toBe(3)
  })

  test('a single run advance error does not abort the tick', async () => {
    const store = new TridentRunStore(db)
    await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.create({ slug: 'b', project_slug: 't1', repo_path: '/r', task: 't' })

    let calls = 0
    const flakyDeps: AdvanceDeps = {
      now: () => fixedNow,
      classify: async () => {
        calls++
        if (calls === 1) throw new Error('classify boom')
        return { status: 'completed', result: {} }
      },
    }
    const loop = new TridentTickLoop({ store, deps: flakyDeps })
    const res = await loop.runOnce()
    // one threw, the other advanced
    expect(res.advanced).toBe(1)
  })

  test('start is idempotent; stop clears the timer', () => {
    const store = new TridentRunStore(db)
    const loop = new TridentTickLoop({ store, deps: stubAdvanceDeps(), tick_interval_ms: 60_000 })
    loop.start()
    loop.start() // no throw, no double-timer
    loop.stop()
    loop.stop() // safe to stop twice
    expect(loop.stats().advanced).toBe(0)
  })
})
