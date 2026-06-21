import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { TaskStore } from '../store.ts'
import { appendInboxRow, runTaskScan, type TaskScanPaths } from '../inbox/index.ts'

const NOW = new Date('2026-06-21T12:00:00.000Z')

describe('inbox — scanner (end-to-end: append → store → markdown)', () => {
  let tmp: string
  let db: ProjectDb
  let store: TaskStore
  let paths: TaskScanPaths

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-inbox-scan-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    store = new TaskStore(db)
    paths = {
      inbox: join(tmp, 'task-inbox.jsonl'),
      archive: join(tmp, 'task-inbox.archive.jsonl'),
      tasks_md: join(tmp, 'tasks.md'),
      dashboard: join(tmp, 'DASHBOARD.md'),
    }
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const scan = () =>
    runTaskScan({ store, project_slug: 't1', paths, now: () => NOW })

  test('an appended add is applied to the store AND reflected in tasks.md + DASHBOARD', async () => {
    appendInboxRow(paths.inbox, {
      action: 'add',
      title: 'launch the surface',
      priority: 'P0',
      due: '2026-06-25',
      project: 'neutron',
    })

    const result = await scan()

    // Store mutation.
    expect(result.applied).toBe(1)
    expect(result.active_count).toBe(1)
    const tasks = store.list({ project_slug: 't1', status: 'all' })
    expect(tasks.length).toBe(1)
    expect(tasks[0]?.title).toBe('launch the surface')
    expect(tasks[0]?.priority).toBe(3)

    // tasks.md content.
    const tasksMd = readFileSync(paths.tasks_md, 'utf8')
    expect(tasksMd).toContain('# Tasks')
    expect(tasksMd).toContain('## Active')
    expect(tasksMd).toContain(
      '- [ ] launch the surface [P0] [due:2026-06-25] [project:neutron]',
    )

    // DASHBOARD content — promoted into the P0 section.
    const dash = readFileSync(paths.dashboard, 'utf8')
    expect(dash).toContain('## 🔴 Do Now (P0)')
    expect(dash).toContain('launch the surface')
  })

  test('the inbox is drained after a scan and re-scan is a no-op', async () => {
    appendInboxRow(paths.inbox, { action: 'add', id: 'x1', title: 'one' })
    const first = await scan()
    expect(first.applied).toBe(1)

    // Inbox drained: rotated away (no pending rows) and the processing
    // sidecar cleaned up after commit.
    const drained = existsSync(paths.inbox) ? readFileSync(paths.inbox, 'utf8') : ''
    expect(drained).toBe('')
    expect(existsSync(`${paths.inbox}.processing`)).toBe(false)

    const second = await scan()
    expect(second.processed).toBe(0)
    expect(second.applied).toBe(0)
    // No duplicate task created.
    expect(store.list({ project_slug: 't1', status: 'all' }).length).toBe(1)
  })

  test('rows appended DURING processing survive the truncate (byte-prefix)', async () => {
    appendInboxRow(paths.inbox, { action: 'add', id: 'a', title: 'before scan' })

    // Simulate a concurrent append landing after we read the snapshot but
    // before truncation, by appending inside the injected clock callback —
    // which runTaskScan calls once at the very start, after the read.
    let appendedDuring = false
    const racyScan = () =>
      runTaskScan({
        store,
        project_slug: 't1',
        paths,
        now: () => {
          if (!appendedDuring) {
            appendedDuring = true
            appendInboxRow(paths.inbox, { action: 'add', id: 'b', title: 'during scan' })
          }
          return NOW
        },
      })

    const result = await racyScan()
    expect(result.applied).toBe(1) // only 'a' was in the snapshot

    // 'b' survived in the inbox for the next scan.
    const remaining = readFileSync(paths.inbox, 'utf8')
    expect(remaining).toContain('during scan')
    expect(remaining).not.toContain('before scan')

    const second = await scan()
    expect(second.applied).toBe(1) // 'b' now applied
    expect(store.list({ project_slug: 't1', status: 'all' }).length).toBe(2)
  })

  test('a leftover .processing sidecar from a crashed scan is recovered', async () => {
    // Simulate a scan that crashed after rotate: a sidecar holds an
    // un-applied row, and the live inbox has a newer one. The leftover is
    // drained FIRST (live inbox waits one cycle); a second scan catches up.
    appendFileSync(`${paths.inbox}.processing`, JSON.stringify({ action: 'add', id: 'crashed', title: 'from crash' }) + '\n')
    appendInboxRow(paths.inbox, { action: 'add', id: 'fresh', title: 'after restart' })

    const first = await scan()
    expect(first.applied).toBe(1) // the recovered leftover row
    expect(store.get('crashed')?.title).toBe('from crash')
    expect(existsSync(`${paths.inbox}.processing`)).toBe(false)

    const second = await scan()
    expect(second.applied).toBe(1) // the live row, one cycle later
    expect(store.get('fresh')?.title).toBe('after restart')
    expect(store.list({ project_slug: 't1', status: 'all' }).length).toBe(2)
  })

  test('a late write to a recovered leftover sidecar is drained, not lost', async () => {
    // Leftover sidecar from a crashed scan, with one row already in it.
    const sidecar = `${paths.inbox}.processing`
    appendFileSync(sidecar, JSON.stringify({ action: 'add', id: 'r1', title: 'recovered' }) + '\n')
    // During recovery apply, a pre-crash fd appends another row to it.
    let injected = false
    const result = await runTaskScan({
      store,
      project_slug: 't1',
      paths,
      now: () => {
        if (!injected) {
          injected = true
          appendFileSync(sidecar, JSON.stringify({ action: 'add', id: 'r2', title: 'late recovered' }) + '\n')
        }
        return NOW
      },
    })
    expect(result.applied).toBe(2) // both the leftover + the late write
    expect(store.get('r1')?.title).toBe('recovered')
    expect(store.get('r2')?.title).toBe('late recovered')
    expect(existsSync(sidecar)).toBe(false)
  })

  test('id-less add gets a stable id at append time (replay-safe)', async () => {
    appendInboxRow(paths.inbox, { action: 'add', title: 'no explicit id' })
    // The persisted line carries an id even though the caller omitted it.
    const persisted = readFileSync(`${paths.inbox}`, 'utf8')
    expect(JSON.parse(persisted.trim()).id).toBeDefined()

    await scan()
    // Replay the SAME row (simulating crash-before-clear) — must skip, not dup.
    const replayLine = persisted
    appendFileSync(paths.inbox, replayLine)
    const replay = await scan()
    expect(replay.skipped).toBe(1)
    expect(replay.outcomes[0]?.reason).toBe('duplicate')
    expect(store.list({ project_slug: 't1', status: 'all' }).length).toBe(1)
  })

  test('a write to the rotated inode during apply is drained in order, same scan', async () => {
    appendInboxRow(paths.inbox, { action: 'add', id: 'a', title: 'first row' })
    // During the apply window, simulate a pre-rename-opened fd writing to
    // the already-rotated sidecar (the exact race the inline drain covers).
    let injected = false
    const result = await runTaskScan({
      store,
      project_slug: 't1',
      paths,
      now: () => {
        if (!injected) {
          injected = true
          appendFileSync(
            `${paths.inbox}.processing`,
            JSON.stringify({ action: 'add', id: 'b', title: 'racing row' }) + '\n',
          )
        }
        return NOW
      },
    })
    // The late row is drained IN ORDER within this same scan — not lost,
    // not deferred, not reordered behind a newer live-inbox row.
    expect(result.applied).toBe(2)
    expect(store.get('a')?.title).toBe('first row')
    expect(store.get('b')?.title).toBe('racing row')
    expect(existsSync(`${paths.inbox}.processing`)).toBe(false)
  })

  test('a dependent add→update pair written across the rotate boundary stays ordered', async () => {
    // 'create' is in the claimed snapshot; its dependent 'update' is
    // written to the rotated sidecar during apply. Inline draining applies
    // the update AFTER the add (correct order), so it is not lost.
    appendInboxRow(paths.inbox, { action: 'add', id: 'dep', title: 'original' })
    let injected = false
    const result = await runTaskScan({
      store,
      project_slug: 't1',
      paths,
      now: () => {
        if (!injected) {
          injected = true
          appendFileSync(
            `${paths.inbox}.processing`,
            JSON.stringify({ action: 'update', id: 'dep', priority: 'P0' }) + '\n',
          )
        }
        return NOW
      },
    })
    expect(result.applied).toBe(2) // add + dependent update
    expect(store.get('dep')?.priority).toBe(3) // update landed after the add
  })

  test('complete via inbox flips the task to Done in tasks.md', async () => {
    appendInboxRow(paths.inbox, { action: 'add', id: 'd1', title: 'finish me' })
    await scan()
    expect(readFileSync(paths.tasks_md, 'utf8')).toContain('- [ ] finish me')

    appendInboxRow(paths.inbox, { action: 'complete', id: 'd1' })
    const result = await scan()
    expect(result.applied).toBe(1)
    expect(store.get('d1')?.status).toBe('done')

    const tasksMd = readFileSync(paths.tasks_md, 'utf8')
    expect(tasksMd).toContain('## Active')
    expect(tasksMd).not.toContain('- [ ] finish me')
    expect(tasksMd).toContain('- [x] ~~finish me~~')
  })

  test('parse errors are archived and do not block valid rows', async () => {
    appendInboxRow(paths.inbox, { action: 'add', id: 'ok', title: 'good row' })
    // Append a raw malformed line directly.
    appendFileSync(paths.inbox, 'this is not json\n')

    const result = await scan()
    expect(result.applied).toBe(1)
    expect(result.parse_errors).toBe(1)
    expect(store.get('ok')?.title).toBe('good row')

    expect(existsSync(paths.archive)).toBe(true)
    const archive = readFileSync(paths.archive, 'utf8')
    expect(archive).toContain('"status":"applied"')
    expect(archive).toContain('"status":"parse_error"')
  })

  test('focus-score ordering holds in the rendered tasks.md', async () => {
    appendInboxRow(paths.inbox, { action: 'add', id: 'lo', title: 'low prio', priority: 'P3' })
    appendInboxRow(paths.inbox, { action: 'add', id: 'hi', title: 'high prio', priority: 'P0' })
    await scan()
    const md = readFileSync(paths.tasks_md, 'utf8')
    expect(md.indexOf('high prio')).toBeLessThan(md.indexOf('low prio'))
  })
})
