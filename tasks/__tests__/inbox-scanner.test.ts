import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { TaskStore } from '../store.ts'
import { appendInboxRow, runTaskScan, type TaskScanPaths } from '../inbox/index.ts'
import { completeLineTail, finalizeProcessing } from '../inbox/scanner.ts'

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

  test('a FAILED requeue write LEAVES the sidecar (no data loss) and the next scan recovers it', async () => {
    // Drive finalize directly with a residual row past the inline drain's
    // baseline, and make the requeue WRITE fail by pointing the live inbox
    // at a directory (appendFileSync → EISDIR). The previous code
    // unconditionally unlinked the sidecar in that case → silent loss.
    const sidecar = `${paths.inbox}.processing`
    const appliedLine = JSON.stringify({ action: 'add', id: 'done', title: 'already applied' }) + '\n'
    const residualLine = JSON.stringify({ action: 'add', id: 'resid', title: 'residual row' }) + '\n'
    writeFileSync(sidecar, appliedLine + residualLine)
    const finalBaseline = Buffer.byteLength(appliedLine, 'utf8')

    // Make the live-inbox append throw.
    mkdirSync(paths.inbox, { recursive: true })
    finalizeProcessing(paths.inbox, finalBaseline)

    // Sidecar still present and INTACT — residual not dropped.
    expect(existsSync(sidecar)).toBe(true)
    expect(readFileSync(sidecar, 'utf8')).toBe(appliedLine + residualLine)

    // Repair the live inbox; the next real scan recovers the leftover
    // sidecar and applies BOTH rows (reprocessing the already-applied one is
    // an idempotent no-op via the stable id).
    rmSync(paths.inbox, { recursive: true, force: true })
    const recovered = await scan()
    expect(recovered.applied).toBe(2)
    expect(store.get('done')?.title).toBe('already applied')
    expect(store.get('resid')?.title).toBe('residual row')
    expect(existsSync(sidecar)).toBe(false)
  })

  test('a final inbox row WITHOUT a trailing newline is applied, not stranded (Codex P2)', async () => {
    // task-inbox.jsonl is markdown-first and hand-editable: a direct edit
    // can leave the last complete JSON object with NO closing newline.
    // A strict newline-snap would strand it forever (the sidecar would be
    // re-left every scan, livelocking that row + all later live rows). The
    // settled (non-growing) trailing line must be treated as complete.
    appendInboxRow(paths.inbox, { action: 'add', id: 'nl', title: 'has newline' })
    // Raw write of a second valid row WITHOUT a trailing newline.
    appendFileSync(
      paths.inbox,
      JSON.stringify({ action: 'add', id: 'nonl', title: 'no trailing newline' }),
    )

    const result = await scan()
    expect(result.applied).toBe(2)
    expect(result.parse_errors).toBe(0)
    expect(store.get('nl')?.title).toBe('has newline')
    expect(store.get('nonl')?.title).toBe('no trailing newline')
    // Sidecar fully consumed and dropped — no livelock.
    expect(existsSync(`${paths.inbox}.processing`)).toBe(false)

    // Re-scan is a clean no-op (queue drained).
    const second = await scan()
    expect(second.applied).toBe(0)
    expect(store.list({ project_slug: 't1', status: 'all' }).length).toBe(2)
  })

  test('a STABLE malformed final line without a newline is archived, never stranded (Codex P2)', async () => {
    // A hand-edited final line that is invalid JSON with no trailing newline
    // must NOT block the queue forever. Since `claimInbox` always drains the
    // sidecar before the live inbox, a stranded bad tail would livelock all
    // later rows. A stable (non-growing) malformed tail is consumed and
    // archived as a parse error like any other bad row.
    const sidecar = `${paths.inbox}.processing`
    const goodLine = JSON.stringify({ action: 'add', id: 'good', title: 'complete row' }) + '\n'
    const malformed = '{"action":"add","id":"trunc","ti' // invalid JSON, no newline, stable
    writeFileSync(sidecar, goodLine + malformed)

    const first = await scan()
    expect(first.applied).toBe(1)
    expect(first.parse_errors).toBe(1) // malformed tail archived, not stranded
    expect(store.get('good')?.title).toBe('complete row')
    expect(store.get('trunc')).toBeNull()
    // Sidecar cleared — no livelock.
    expect(existsSync(sidecar)).toBe(false)
    const archive = readFileSync(paths.archive, 'utf8')
    expect(archive).toContain('"status":"parse_error"')

    // Later live-inbox rows are no longer blocked.
    appendInboxRow(paths.inbox, { action: 'add', id: 'later', title: 'unblocked' })
    const second = await scan()
    expect(second.applied).toBe(1)
    expect(store.get('later')?.title).toBe('unblocked')
  })

  test('a newline-less residual is requeued NEWLINE-TERMINATED so it cannot livelock', async () => {
    // finalize requeues a settled newline-less residual to the live inbox.
    // It MUST normalize the trailing newline, else the next scan would see
    // a newline-less line again and re-leave it forever.
    const sidecar = `${paths.inbox}.processing`
    const drainedLine = JSON.stringify({ action: 'add', id: 'drained', title: 'drained' }) + '\n'
    const residualNoNl = JSON.stringify({ action: 'add', id: 'tail', title: 'requeued tail' })
    writeFileSync(sidecar, drainedLine + residualNoNl)
    const finalBaseline = Buffer.byteLength(drainedLine, 'utf8')

    finalizeProcessing(paths.inbox, finalBaseline)

    // Residual requeued to the live inbox WITH a terminating newline.
    const live = readFileSync(paths.inbox, 'utf8')
    expect(live).toBe(residualNoNl + '\n')
    expect(existsSync(sidecar)).toBe(false)

    // The next scan applies the requeued row cleanly (no livelock).
    const result = await scan()
    expect(result.applied).toBe(1)
    expect(result.parse_errors).toBe(0)
    expect(store.get('tail')?.title).toBe('requeued tail')
  })
})

describe('completeLineTail — newline-boundary snapping', () => {
  test('returns only whole lines and never advances past a partial', () => {
    const buf = Buffer.from('{"a":1}\n{"b":2}\n{"c":', 'utf8')
    const slice = completeLineTail(buf, 0)
    expect(slice).not.toBeNull()
    expect(slice?.tail).toBe('{"a":1}\n{"b":2}\n')
    expect(slice?.nextBaseline).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n', 'utf8'))
  })

  test('returns null when only a partial line exists past the baseline', () => {
    const buf = Buffer.from('{"a":1}\n{"partial', 'utf8')
    const baseline = Buffer.byteLength('{"a":1}\n', 'utf8')
    expect(completeLineTail(buf, baseline)).toBeNull()
  })

  test('returns null when nothing new past the baseline', () => {
    const buf = Buffer.from('{"a":1}\n', 'utf8')
    expect(completeLineTail(buf, buf.length)).toBeNull()
  })
})
