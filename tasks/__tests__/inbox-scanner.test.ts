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
    // Simulate a scan that mutated nothing yet crashed after rotate: a
    // sidecar holds an un-applied row, and the live inbox has a newer one.
    appendFileSync(`${paths.inbox}.processing`, JSON.stringify({ action: 'add', id: 'crashed', title: 'from crash' }) + '\n')
    appendInboxRow(paths.inbox, { action: 'add', id: 'fresh', title: 'after restart' })

    const result = await scan()
    expect(result.applied).toBe(2) // both the recovered + the fresh row
    expect(store.get('crashed')?.title).toBe('from crash')
    expect(store.get('fresh')?.title).toBe('after restart')
    expect(existsSync(`${paths.inbox}.processing`)).toBe(false)
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
