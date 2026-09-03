import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeSegments,
  groupIntoFireWindows,
  type StageEvent,
} from './stage-attribution.ts'

const SCRIPT = fileURLToPath(new URL('./stage-attribution.ts', import.meta.url))
// Execute the shipped migration body itself: the reader fixture must fail if
// the ledger schema ever drifts away from the migration.
const STAGE_MIGRATION = readFileSync(
  fileURLToPath(new URL('../migrations/0135_code_trident_stage_events.sql', import.meta.url)),
  'utf8',
)
const BASE = Date.parse('2026-08-18T00:00:00.000Z')

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function event(
  run_id: string,
  stage: string,
  offsetMs: number,
  meta: string | null = null,
): StageEvent {
  return { run_id, stage, at: at(offsetMs), meta }
}

function fixture(options: { projectSchema?: boolean } = {}): {
  path: string
  db: Database
} {
  const dir = mkdtempSync(join(tmpdir(), 'trident-stage-attribution-'))
  tempDirs.push(dir)
  const path = join(dir, 'project.db')
  const db = new Database(path, { create: true })
  db.exec(STAGE_MIGRATION)
  if (options.projectSchema === true) {
    db.exec(`
      CREATE TABLE code_trident_runs (
        id TEXT PRIMARY KEY NOT NULL,
        project_slug TEXT NOT NULL
      ) STRICT;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL
      ) STRICT;
    `)
  }
  return { path, db }
}

function insertRun(db: Database, runId: string, projectId = 'project-1'): void {
  db.run('INSERT INTO code_trident_runs (id, project_slug) VALUES (?, ?)', [runId, projectId])
}

function insertEvents(db: Database, events: readonly StageEvent[]): void {
  const insert = db.prepare(
    'INSERT INTO code_trident_stage_events (run_id, stage, at, meta) VALUES (?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (const row of events) insert.run(row.run_id, row.stage, row.at, row.meta)
  })()
}

function completeWindow(runId: string, startMs: number, ralphRound: number): StageEvent[] {
  return [
    event(runId, 'launch-start', startMs, `round=1 ralph_round=${ralphRound}`),
    event(runId, 'fire-dispatched', startMs + 100),
    event(runId, 'fire-settled', startMs + 200),
    event(runId, 'plan-start', startMs + 300),
    event(runId, 'build-agent-start', startMs + 900),
    event(runId, 'wrapper-invoke', startMs + 1000),
    event(runId, 'wrapper-start', startMs + 1100),
    event(runId, 'codex-exec-start', startMs + 1200),
    event(runId, 'codex-exec-end', startMs + 2200),
  ]
}

async function runCli(path: string, label = 'fixture'): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  const child = Bun.spawn([process.execPath, SCRIPT, '--label', `${label}=${path}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

describe('stage attribution pure reader', () => {
  test('happy path computes six pre-build durations plus exact brief and build windows', () => {
    const events = [
      event('run-happy', 'launch-start', 0, 'round=1 ralph_round=1'),
      event('run-happy', 'fire-dispatched', 100),
      event('run-happy', 'fire-settled', 1_100),
      event('run-happy', 'plan-start', 3_100),
      event('run-happy', 'build-agent-start', 6_100),
      event('run-happy', 'wrapper-invoke', 7_100),
      event('run-happy', 'wrapper-start', 9_100),
      event('run-happy', 'codex-exec-start', 10_100),
      event('run-happy', 'codex-exec-end', 40_100),
    ]
    const [fireWindow] = groupIntoFireWindows(events)
    expect(fireWindow?.label).toBe('run-happy#0 round=1 ralph_round=1')

    const result = computeSegments(fireWindow!)
    expect(result.segments.map((segment) => segment.durationMs)).toEqual([
      1_000,
      2_000,
      3_000,
      1_000,
      2_000,
      1_000,
    ])
    expect(result.segments.map((segment) => segment.percentage)).toEqual([10, 20, 30, 10, 20, 10])
    expect(result.attributedSumMs).toBe(10_000)
    expect(result.briefToBuildMs).toBe(9_000)
    expect(result.codexBuildMs).toBe(30_000)
  })

  test('re-fire interleaving opens isolated windows and never emits a negative duration', () => {
    const events = [
      event('run-refire', 'launch-start', 0, 'round=1 ralph_round=1'),
      event('run-refire', 'fire-dispatched', 100),
      event('run-refire', 'fire-settled', 200),
      event('run-refire', 'launch-start', 1_000, 'round=1 ralph_round=2'),
      event('run-refire', 'fire-dispatched', 1_100),
      event('run-refire', 'fire-settled', 1_300),
      event('run-refire', 'plan-start', 1_500),
    ]
    const windows = groupIntoFireWindows(events)

    expect(windows.map((fireWindow) => fireWindow.label)).toEqual([
      'run-refire#0 round=1 ralph_round=1',
      'run-refire#1 round=1 ralph_round=2',
    ])
    expect(windows[0]?.events.map((row) => row.at)).toEqual(events.slice(0, 3).map((row) => row.at))
    expect(windows[1]?.events.map((row) => row.at)).toEqual(events.slice(3).map((row) => row.at))
    for (const fireWindow of windows) {
      for (const segment of computeSegments(fireWindow).segments) {
        expect(segment.durationMs === null || segment.durationMs >= 0).toBe(true)
      }
    }
  })

  test('missing stages are unattributed on both adjacent segments while other segments survive', () => {
    const [fireWindow] = groupIntoFireWindows([
      event('run-missing', 'launch-start', 0),
      event('run-missing', 'fire-dispatched', 100),
      event('run-missing', 'fire-settled', 200),
      event('run-missing', 'build-agent-start', 400),
      event('run-missing', 'wrapper-invoke', 500),
      event('run-missing', 'wrapper-start', 600),
      event('run-missing', 'codex-exec-start', 700),
    ])
    const result = computeSegments(fireWindow!)

    expect(result.segments[0]).toMatchObject({ durationMs: 100, status: null })
    expect(result.segments[1]).toMatchObject({ durationMs: null, status: 'unattributed(plan-start)' })
    expect(result.segments[2]).toMatchObject({ durationMs: null, status: 'unattributed(plan-start)' })
    expect(result.segments[3]).toMatchObject({ durationMs: 100, status: null })
    expect(result.segments[4]).toMatchObject({ durationMs: 100, status: null })
    expect(result.segments[5]).toMatchObject({ durationMs: 100, status: null })
    expect(result).toMatchObject({
      codexBuildMs: null,
      codexBuildStatus: 'unattributed(codex-exec-end)',
    })
  })

  test('orphan rows are retained in a no-launch-start window and duplicates use the first stamp', () => {
    const events = [
      event('run-orphan', 'fire-dispatched', 0),
      event('run-orphan', 'fire-dispatched', 50),
      event('run-orphan', 'fire-settled', 100),
      event('run-orphan', 'launch-start', 1_000, 'round=2 ralph_round=3'),
      event('run-orphan', 'fire-dispatched', 1_100),
    ]
    const windows = groupIntoFireWindows(events)

    expect(windows[0]?.label).toBe('run-orphan#0 no-launch-start')
    expect(computeSegments(windows[0]!).segments[0]?.durationMs).toBe(100)
    expect(computeSegments(windows[0]!).notes).toContain('duplicate:fire-dispatched')
    expect(windows[1]?.label).toBe('run-orphan#1 round=2 ralph_round=3')
  })

  // ARGUS r5 (minor): the settle-timeout HOLD path stamps `fire-unobserved-launch`
  // INSTEAD OF `fire-settled` (the launcher never confirmed, so claiming it
  // settled would be a lie) — and with no entry in the pair table every held lane
  // read as `unattributed(fire-settled)` on BOTH fire segments, losing exactly
  // the runs that seam exists to rescue from the ledger.
  test('a HELD lane attributes both fire segments off `fire-unobserved-launch`', () => {
    const [fireWindow] = groupIntoFireWindows([
      event('run-held', 'launch-start', 0),
      event('run-held', 'fire-dispatched', 100),
      event('run-held', 'fire-unobserved-launch', 180_100, 'worktree wf_x holds the branch'),
      event('run-held', 'plan-start', 183_100),
    ])
    const result = computeSegments(fireWindow!)

    expect(result.segments[0]?.durationMs).toBe(180_000)
    expect(result.segments[0]?.status).toBeNull()
    expect(result.segments[1]?.durationMs).toBe(3_000)
    expect(result.segments[1]?.status).toBeNull()
  })

  test('a lane with NEITHER fire terminator is still unattributed, not zero', () => {
    const [fireWindow] = groupIntoFireWindows([
      event('run-blind', 'launch-start', 0),
      event('run-blind', 'fire-dispatched', 100),
      event('run-blind', 'plan-start', 3_100),
    ])
    const result = computeSegments(fireWindow!)

    expect(result.segments[0]?.durationMs).toBeNull()
    expect(result.segments[0]?.status).toBe('unattributed(fire-settled)')
    expect(result.segments[1]?.status).toBe('unattributed(fire-settled)')
  })

  test('a killed Codex attempt pairs the remaining end with the retry start', () => {
    const [fireWindow] = groupIntoFireWindows([
      event('run-retry', 'launch-start', 0),
      event('run-retry', 'codex-exec-start', 700),
      // No end for the first attempt: the process died before its best-effort stamp.
      event('run-retry', 'codex-exec-start', 10_700),
      event('run-retry', 'codex-exec-end', 12_700),
    ])
    const result = computeSegments(fireWindow!)

    expect(result.codexBuildMs).toBe(2_000)
    expect(result.codexBuildStatus).toBeNull()
    expect(result.notes).toContain('duplicate:codex-exec-start')
  })

  test('a completed failed attempt cannot hide the later successful retry duration', () => {
    const [fireWindow] = groupIntoFireWindows([
      event('run-retry', 'launch-start', 0),
      event('run-retry', 'codex-exec-start', 1_000),
      event('run-retry', 'codex-exec-end', 31_000),
      event('run-retry', 'codex-exec-start', 60_000),
      event('run-retry', 'codex-exec-end', 1_860_000),
    ])
    const result = computeSegments(fireWindow!)

    expect(result.codexBuildMs).toBe(1_800_000)
    expect(result.codexBuildStatus).toBeNull()
    expect(result.notes).toContain('duplicate:codex-exec-start')
    expect(result.notes).toContain('duplicate:codex-exec-end')
  })

  /**
   * THE MID-EXEC HEARTBEAT lands `codex-exec-alive` rows every ~5 minutes so the hang
   * watchdog has evidence during a long `codex exec` — a two-hour build stamps it ~24
   * times. It must not be reported as an anomaly, and it must not move any measured
   * duration: the notes column exists to flag re-entries, and a note on every healthy
   * run is a note nobody reads.
   */
  test('heartbeat rows neither skew the build window nor raise a duplicate note', () => {
    const [fireWindow] = groupIntoFireWindows([
      event('run-heartbeat', 'launch-start', 0),
      event('run-heartbeat', 'codex-exec-start', 1_000),
      event('run-heartbeat', 'codex-exec-alive', 301_000),
      event('run-heartbeat', 'codex-exec-alive', 601_000),
      event('run-heartbeat', 'codex-exec-alive', 901_000),
      event('run-heartbeat', 'codex-exec-end', 1_801_000),
    ])
    const result = computeSegments(fireWindow!)

    // The window is measured start→end, untouched by anything stamped between them.
    expect(result.codexBuildMs).toBe(1_800_000)
    expect(result.codexBuildStatus).toBeNull()
    expect(result.notes).not.toContain('duplicate:codex-exec-alive')
    // POSITIVE CONTROL: the same reader on the same window still reports a REAL
    // duplicate, so "no note" above is the exclusion working and not the notes
    // machinery having gone silent.
    const [withRetry] = groupIntoFireWindows([
      event('run-heartbeat-2', 'launch-start', 0),
      event('run-heartbeat-2', 'codex-exec-start', 1_000),
      event('run-heartbeat-2', 'codex-exec-alive', 301_000),
      event('run-heartbeat-2', 'codex-exec-start', 601_000),
      event('run-heartbeat-2', 'codex-exec-alive', 901_000),
      event('run-heartbeat-2', 'codex-exec-end', 1_801_000),
    ])
    const retryResult = computeSegments(withRetry!)
    expect(retryResult.notes).toContain('duplicate:codex-exec-start')
    expect(retryResult.notes).not.toContain('duplicate:codex-exec-alive')
  })

  /**
   * THE REVIEW BRACKETS REPEAT TOO, and only the `*-alive` heartbeats were excluded
   * at first. A fire window is split at `launch-start` ONLY, which is stamped once per
   * `launch()`, while `codex-review-start` / `codex-review-end` are stamped once per
   * review ROUND — and `inner-workflow.mjs` builds BOTH the adversarial and the
   * cross-model codex reviewer prompts from the same `reviewStageEnv`, so two
   * reviewers stamp the same run id in a single round. That put a
   * `duplicate:codex-review-start` note on every healthy multi-round run: exactly the
   * anomaly-note pollution the exclusion exists to prevent.
   */
  test('review brackets repeat per round and per reviewer without raising a duplicate note', () => {
    const [fireWindow] = groupIntoFireWindows([
      event('run-review', 'launch-start', 0),
      event('run-review', 'codex-exec-start', 1_000),
      event('run-review', 'codex-exec-end', 1_801_000),
      // round 1: two codex reviewers, same run id, overlapping.
      event('run-review', 'codex-review-start', 1_802_000),
      event('run-review', 'codex-review-start', 1_803_000),
      event('run-review', 'codex-review-alive', 2_103_000),
      event('run-review', 'codex-review-end', 2_402_000),
      event('run-review', 'codex-review-end', 2_405_000),
      // round 2, same fire window — nothing re-stamps launch-start between rounds.
      event('run-review', 'codex-review-start', 3_000_000),
      event('run-review', 'codex-review-end', 3_600_000),
    ])
    const result = computeSegments(fireWindow!)
    expect(result.notes).not.toContain('duplicate:codex-review-start')
    expect(result.notes).not.toContain('duplicate:codex-review-end')
    expect(result.notes).not.toContain('duplicate:codex-review-alive')
    // The build window is still measured exactly, untouched by the review rows.
    expect(result.codexBuildMs).toBe(1_800_000)

    // POSITIVE CONTROL: the notes machinery is alive on this very window shape — a
    // genuinely anomalous repeat still raises its note.
    const [withRetry] = groupIntoFireWindows([
      event('run-review-2', 'launch-start', 0),
      event('run-review-2', 'codex-exec-start', 1_000),
      event('run-review-2', 'codex-exec-start', 2_000),
      event('run-review-2', 'codex-review-start', 3_000),
      event('run-review-2', 'codex-review-start', 4_000),
      event('run-review-2', 'codex-exec-end', 5_000),
    ])
    const retry = computeSegments(withRetry!)
    expect(retry.notes).toContain('duplicate:codex-exec-start')
    expect(retry.notes).not.toContain('duplicate:codex-review-start')
  })

  test('an end timestamp before its start is non-monotonic, not a missing stamp', () => {
    const [fireWindow] = groupIntoFireWindows([
      event('run-regression', 'launch-start', 0),
      event('run-regression', 'codex-exec-end', 500),
      event('run-regression', 'codex-exec-start', 1_000),
    ])

    expect(computeSegments(fireWindow!)).toMatchObject({
      codexBuildMs: null,
      codexBuildStatus: 'unattributed(non-monotonic)',
    })
  })

  test('logical stage regression becomes unattributed(non-monotonic), never a negative duration', () => {
    const [fireWindow] = groupIntoFireWindows([
      event('run-regression', 'launch-start', 0),
      event('run-regression', 'fire-settled', 100),
      event('run-regression', 'fire-dispatched', 200),
    ])
    expect(computeSegments(fireWindow!).segments[0]).toMatchObject({
      durationMs: null,
      status: 'unattributed(non-monotonic)',
    })
  })
})

describe('stage attribution CLI', () => {
  test('prints six pre-build segments, direct brief/build windows, aggregates, and refuses n<5', async () => {
    const { path, db } = fixture({ projectSchema: true })
    db.run('INSERT INTO projects (id, name) VALUES (?, ?)', ['project-1', 'Neutron Test'])
    for (let index = 0; index < 4; index += 1) {
      const runId = `run-${index + 1}`
      insertRun(db, runId)
      insertEvents(db, completeWindow(runId, index * 10_000, 1))
    }
    db.close()

    const result = await runCli(path)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('project attribution: schema join')
    expect(result.stdout).toContain('project: Neutron Test')
    expect(result.stdout).toContain('sample count n=4')
    expect(result.stdout).toContain('fire-dispatched→fire-settled: 100 ms (0.100 s) (9.09%)')
    expect(result.stdout).toContain('attributed segment sum: 1100 ms (1.100 s)')
    expect(result.stdout).toContain('brief→build (fire-dispatched→wrapper-start): 1000 ms (1.000 s)')
    expect(result.stdout).toContain('codex build (codex-exec-start→codex-exec-end): 1000 ms (1.000 s)')
    expect(result.stdout).toContain('mean codex build: 1000 ms (1.000 s) (samples=4)')
    expect(result.stdout).toContain('insufficient samples (n=4 < 5): no conclusion')
    expect(result.stdout).not.toContain('dominant:')
  })

  test('the fifth complete window enables the arithmetically correct dominant conclusion', async () => {
    const { path, db } = fixture({ projectSchema: true })
    db.run('INSERT INTO projects (id, name) VALUES (?, ?)', ['project-1', 'Neutron Test'])
    for (let index = 0; index < 5; index += 1) {
      const runId = `run-${index + 1}`
      insertRun(db, runId)
      insertEvents(db, completeWindow(runId, index * 10_000, 1))
    }
    db.close()

    const result = await runCli(path)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('sample count n=5')
    expect(result.stdout).toContain('dominant: plan-start→build-agent-start 54.55%')
    expect(result.stdout).not.toContain('insufficient samples')
  })

  test('stdout is byte-identical across invocations and the read-only CLI leaves DB bytes unchanged', async () => {
    const { path, db } = fixture()
    insertEvents(db, [
      event('run-fallback', 'fire-dispatched', 0),
      event('run-fallback', 'fire-settled', 100),
    ])
    db.close()
    const bytesBefore = readFileSync(path)

    const first = await runCli(path, 'fallback-project')
    const second = await runCli(path, 'fallback-project')

    expect(first).toEqual(second)
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('project attribution: database label/path')
    expect(first.stdout).toContain('window: run-fallback#0 no-launch-start')
    expect(first.stdout).toContain('project: fallback-project')
    expect(readFileSync(path).equals(bytesBefore)).toBe(true)
  })
})
