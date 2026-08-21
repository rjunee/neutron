import { Database } from 'bun:sqlite'

export const STAGE_SEGMENTS = [
  ['fire-dispatched', 'fire-settled'],
  ['fire-settled', 'plan-start'],
  ['plan-start', 'build-agent-start'],
  ['build-agent-start', 'wrapper-invoke'],
  ['wrapper-invoke', 'wrapper-start'],
  ['wrapper-start', 'codex-exec-start'],
] as const

/**
 * Stages that repeat BY DESIGN.
 *
 * TWO KINDS, and both had to be listed. The `*-alive` pair are the mid-phase liveness
 * heartbeats the build and review wrappers emit every ~5 minutes so the hang watchdog
 * has evidence during a long `codex exec` (see THE MID-EXEC HEARTBEAT in
 * `trident/codex-build.sh`). The `codex-review-*` BRACKETS repeat for a different
 * reason, and listing only the heartbeats was a real oversight: a fire window is split
 * at `launch-start` ONLY (`groupIntoFireWindows` below), which `orchestrator.ts` stamps
 * once per `launch()`, while a review is stamped once per ROUND — many rounds per
 * window. Worse, `inner-workflow.mjs` builds BOTH the adversarial (`:5260`) and the
 * cross-model (`:5285`) codex reviewer prompts from the SAME `reviewStageEnv`, so two
 * reviewers stamp the same run id concurrently in a single round. Left in, every
 * healthy multi-round run carried a `duplicate:codex-review-start` note.
 *
 * EXCLUDED FROM THE `duplicate:` NOTES, and only from those. A duplicate note exists
 * to flag an ANOMALY — a stage stamped twice in one fire window means a re-entry or a
 * double-launch worth looking at. A stage that repeats because that is its job would
 * put an anomaly note on every healthy run and teach the reader to ignore the notes
 * column. No measured segment is affected: every duration this file computes is between
 * two EXPLICITLY named stages (`STAGE_SEGMENTS` above), and no segment names any stage
 * in this set.
 */
export const REPEATING_STAGES: ReadonlySet<string> = new Set([
  'codex-exec-alive',
  'codex-review-alive',
  'codex-review-start',
  'codex-review-end',
])

/** @deprecated Prior name, kept so an out-of-tree importer does not break. */
export const HEARTBEAT_STAGES: ReadonlySet<string> = REPEATING_STAGES

export interface StageEvent {
  id?: number
  run_id: string
  stage: string
  at: string
  meta: string | null
}

export interface FireWindow {
  runId: string
  index: number
  label: string
  startAt: string
  round: string | null
  ralphRound: string | null
  hasLaunchStart: boolean
  events: StageEvent[]
}

export interface AttributedSegment {
  name: string
  from: string
  to: string
  durationMs: number | null
  status: string | null
  percentage: number | null
}

export interface WindowAttribution {
  segments: AttributedSegment[]
  attributedSumMs: number
  briefToBuildMs: number | null
  briefToBuildStatus: string | null
  briefToBuildHasBothStamps: boolean
  codexBuildMs: number | null
  codexBuildStatus: string | null
  notes: string[]
}

interface InputDatabase {
  label: string
  path: string
}

interface LoadedWindow {
  project: string
  source: string
  window: FireWindow
  attribution: WindowAttribution
}

interface DbStageEvent extends StageEvent {
  project_label: string | null
}

interface LoadedDatabase {
  windows: LoadedWindow[]
  attributionMode: string
}

const USAGE = 'usage: bun trident/stage-attribution.ts <db-path> [<db-path> ...] [--label <name>=<path>]'

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function metaValue(meta: string | null, key: 'round' | 'ralph_round'): string | null {
  if (meta === null) return null
  const match = meta.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`))
  return match?.[1] ?? null
}

function makeWindow(
  runId: string,
  index: number,
  firstEvent: StageEvent,
  launch: StageEvent | null,
): FireWindow {
  const round = launch === null ? null : metaValue(launch.meta, 'round')
  const ralphRound = launch === null ? null : metaValue(launch.meta, 'ralph_round')
  const qualifiers = launch === null
    ? ['no-launch-start']
    : [round === null ? null : `round=${round}`, ralphRound === null ? null : `ralph_round=${ralphRound}`]
        .filter((value): value is string => value !== null)
  return {
    runId,
    index,
    label: `${runId}#${index}${qualifiers.length === 0 ? '' : ` ${qualifiers.join(' ')}`}`,
    startAt: firstEvent.at,
    round,
    ralphRound,
    hasLaunchStart: launch !== null,
    events: [],
  }
}

/**
 * Split one run's chronologically sorted ledger rows at every launch-start.
 * An orphan prefix is retained as its own no-launch-start window.
 */
export function groupIntoFireWindows(events: readonly StageEvent[]): FireWindow[] {
  if (events.length === 0) return []

  const windows: FireWindow[] = []
  let current: FireWindow | null = null
  for (const event of events) {
    if (event.stage === 'launch-start') {
      current = makeWindow(event.run_id, windows.length, event, event)
      windows.push(current)
    } else if (current === null) {
      current = makeWindow(event.run_id, windows.length, event, null)
      windows.push(current)
    }
    current.events.push(event)
  }
  return windows
}

function firstStages(events: readonly StageEvent[]): {
  first: Map<string, StageEvent>
  notes: string[]
} {
  const first = new Map<string, StageEvent>()
  const duplicates = new Set<string>()
  for (const event of events) {
    if (first.has(event.stage)) {
      if (!REPEATING_STAGES.has(event.stage)) duplicates.add(event.stage)
    } else first.set(event.stage, event)
  }
  return {
    first,
    notes: [...duplicates].sort(lexicalCompare).map((stage) => `duplicate:${stage}`),
  }
}

function durationBetween(
  first: ReadonlyMap<string, StageEvent>,
  from: string,
  to: string,
): { durationMs: number | null; status: string | null; hasBoth: boolean } {
  const fromEvent = first.get(from)
  const toEvent = first.get(to)
  if (fromEvent === undefined || toEvent === undefined) {
    const missing = [fromEvent === undefined ? from : null, toEvent === undefined ? to : null]
      .filter((stage): stage is string => stage !== null)
    return {
      durationMs: null,
      status: `unattributed(${missing.join(',')})`,
      hasBoth: false,
    }
  }

  const fromMs = Date.parse(fromEvent.at)
  const toMs = Date.parse(toEvent.at)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { durationMs: null, status: 'unattributed(invalid timestamp)', hasBoth: true }
  }
  const durationMs = toMs - fromMs
  if (durationMs < 0) {
    return { durationMs: null, status: 'unattributed(non-monotonic)', hasBoth: true }
  }
  return { durationMs, status: null, hasBoth: true }
}

/**
 * A fire can contain more than one Codex attempt. Each wrapper invocation stamps
 * both success and failure, so the useful measurement is the latest attempt: its
 * last start and last end. This also pairs a retry after a killed, unstamped first
 * attempt, while preserving non-monotonic reporting for malformed ordering.
 */
function durationBetweenLastStages(
  events: readonly StageEvent[],
  from: string,
  to: string,
): { durationMs: number | null; status: string | null; hasBoth: boolean } {
  const pair = new Map<string, StageEvent>()
  for (const event of events) {
    if (event.stage === from) pair.set(from, event)
    if (event.stage === to) pair.set(to, event)
  }
  return durationBetween(pair, from, to)
}

/** Attribute the six pre-build stage pairs and the separate exact build window. */
export function computeSegments(fireWindow: FireWindow): WindowAttribution {
  const { first, notes } = firstStages(fireWindow.events)
  const rawSegments = STAGE_SEGMENTS.map(([from, to]) => {
    const result = durationBetween(first, from, to)
    return {
      name: `${from}→${to}`,
      from,
      to,
      durationMs: result.durationMs,
      status: result.status,
      percentage: null,
    } satisfies AttributedSegment
  })
  const attributedSumMs = rawSegments.reduce(
    (sum, segment) => sum + (segment.durationMs ?? 0),
    0,
  )
  const segments = rawSegments.map((segment) => ({
    ...segment,
    percentage:
      segment.durationMs === null || attributedSumMs === 0
        ? null
        : (segment.durationMs / attributedSumMs) * 100,
  }))
  const briefToBuild = durationBetween(first, 'fire-dispatched', 'wrapper-start')
  const codexBuild = durationBetweenLastStages(
    fireWindow.events,
    'codex-exec-start',
    'codex-exec-end',
  )
  return {
    segments,
    attributedSumMs,
    briefToBuildMs: briefToBuild.durationMs,
    briefToBuildStatus: briefToBuild.status,
    briefToBuildHasBothStamps: briefToBuild.hasBoth,
    codexBuildMs: codexBuild.durationMs,
    codexBuildStatus: codexBuild.status,
    notes,
  }
}

function parseArgs(args: readonly string[]): InputDatabase[] | null {
  const inputs: InputDatabase[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--label') {
      const value = args[index + 1]
      if (value === undefined) return null
      const equals = value.indexOf('=')
      if (equals <= 0 || equals === value.length - 1) return null
      inputs.push({ label: value.slice(0, equals), path: value.slice(equals + 1) })
      index += 1
      continue
    }
    if (arg.startsWith('--')) return null
    if (arg.length === 0) return null
    inputs.push({ label: arg, path: arg })
  }
  return inputs.length === 0 ? null : inputs
}

function tableColumns(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function loadDatabase(input: InputDatabase): LoadedDatabase {
  const db = new Database(input.path, { readonly: true })
  try {
    const runColumns = tableColumns(db, 'code_trident_runs')
    const projectColumns = tableColumns(db, 'projects')
    const hasRunProject = runColumns.has('id') && runColumns.has('project_slug')
    const hasProjectName = hasRunProject && projectColumns.has('id') && projectColumns.has('name')

    let sql = `SELECT e.id, e.run_id, e.stage, e.at, e.meta, NULL AS project_label
                 FROM code_trident_stage_events e
                ORDER BY e.run_id, e.at, e.id`
    let attributionMode = 'database label/path (no run-to-project schema join available)'
    if (hasProjectName) {
      sql = `SELECT e.id, e.run_id, e.stage, e.at, e.meta,
                    COALESCE(NULLIF(p.name, ''), NULLIF(r.project_slug, '')) AS project_label
               FROM code_trident_stage_events e
               LEFT JOIN code_trident_runs r ON r.id = e.run_id
               LEFT JOIN projects p ON p.id = r.project_slug
              ORDER BY e.run_id, e.at, e.id`
      attributionMode = 'schema join (run_id→code_trident_runs; projects.name, then project_slug; database label/path for unmatched runs)'
    } else if (hasRunProject) {
      sql = `SELECT e.id, e.run_id, e.stage, e.at, e.meta,
                    NULLIF(r.project_slug, '') AS project_label
               FROM code_trident_stage_events e
               LEFT JOIN code_trident_runs r ON r.id = e.run_id
              ORDER BY e.run_id, e.at, e.id`
      attributionMode = 'schema join (run_id→code_trident_runs.project_slug; database label/path for unmatched runs)'
    }

    const rows = db.query(sql).all() as DbStageEvent[]
    const byRun = new Map<string, DbStageEvent[]>()
    for (const row of rows) {
      const runRows = byRun.get(row.run_id)
      if (runRows === undefined) byRun.set(row.run_id, [row])
      else runRows.push(row)
    }

    const windows: LoadedWindow[] = []
    for (const [runId, runRows] of byRun) {
      const project = runRows.find((row) => row.project_label !== null)?.project_label ?? input.label
      for (const fireWindow of groupIntoFireWindows(runRows)) {
        windows.push({
          project,
          source: input.path,
          window: { ...fireWindow, runId },
          attribution: computeSegments(fireWindow),
        })
      }
    }
    return { windows, attributionMode }
  } finally {
    db.close()
  }
}

function formatMs(durationMs: number): string {
  return `${durationMs} ms (${(durationMs / 1000).toFixed(3)} s)`
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function renderProject(project: string, windows: readonly LoadedWindow[]): string[] {
  const lines = [`project: ${project}`]
  const n = windows.filter((item) => item.attribution.briefToBuildHasBothStamps).length
  lines.push(`sample count n=${n} (windows with fire-dispatched and wrapper-start)`)

  for (const item of windows) {
    const { window: fireWindow, attribution } = item
    lines.push(`window: ${fireWindow.label}`)
    lines.push(`  start: ${fireWindow.startAt}`)
    for (const segment of attribution.segments) {
      if (segment.durationMs === null) {
        lines.push(`  ${segment.name}: ${segment.status}`)
      } else if (segment.percentage === null) {
        lines.push(`  ${segment.name}: ${formatMs(segment.durationMs)} (percentage unavailable: attributed sum is 0 ms)`)
      } else {
        lines.push(`  ${segment.name}: ${formatMs(segment.durationMs)} (${segment.percentage.toFixed(2)}%)`)
      }
    }
    lines.push(`  attributed segment sum: ${formatMs(attribution.attributedSumMs)}`)
    lines.push(
      attribution.briefToBuildMs === null
        ? `  brief→build (fire-dispatched→wrapper-start): ${attribution.briefToBuildStatus}`
        : `  brief→build (fire-dispatched→wrapper-start): ${formatMs(attribution.briefToBuildMs)}`,
    )
    lines.push(
      attribution.codexBuildMs === null
        ? `  codex build (codex-exec-start→codex-exec-end): ${attribution.codexBuildStatus}`
        : `  codex build (codex-exec-start→codex-exec-end): ${formatMs(attribution.codexBuildMs)}`,
    )
    if (attribution.notes.length > 0) lines.push(`  notes: ${attribution.notes.join(', ')}`)
  }

  lines.push('aggregate:')
  const briefValues = windows
    .map((item) => item.attribution.briefToBuildMs)
    .filter((value): value is number => value !== null)
  const briefMean = mean(briefValues)
  lines.push(
    briefMean === null
      ? '  mean brief→build: unattributed (samples=0)'
      : `  mean brief→build: ${formatMs(Number(briefMean.toFixed(3)))} (samples=${briefValues.length})`,
  )
  const codexBuildValues = windows
    .map((item) => item.attribution.codexBuildMs)
    .filter((value): value is number => value !== null)
  const codexBuildMean = mean(codexBuildValues)
  lines.push(
    codexBuildMean === null
      ? '  mean codex build: unattributed (samples=0)'
      : `  mean codex build: ${formatMs(Number(codexBuildMean.toFixed(3)))} (samples=${codexBuildValues.length})`,
  )

  const segmentMeans: Array<{ name: string; percentage: number | null }> = []
  for (let index = 0; index < STAGE_SEGMENTS.length; index += 1) {
    const [from, to] = STAGE_SEGMENTS[index]!
    const samples = windows
      .map((item) => item.attribution.segments[index]!)
      .filter((segment) => segment.durationMs !== null && segment.percentage !== null)
    const durationMean = mean(samples.map((segment) => segment.durationMs!))
    const percentageMean = mean(samples.map((segment) => segment.percentage!))
    segmentMeans.push({ name: `${from}→${to}`, percentage: percentageMean })
    lines.push(
      durationMean === null || percentageMean === null
        ? `  ${from}→${to}: unattributed (samples=0)`
        : `  ${from}→${to}: mean ${formatMs(Number(durationMean.toFixed(3)))}, mean ${percentageMean.toFixed(2)}% (samples=${samples.length})`,
    )
  }

  if (n < 5) {
    lines.push(`insufficient samples (n=${n} < 5): no conclusion`)
  } else {
    const dominant = segmentMeans
      .filter((entry): entry is { name: string; percentage: number } => entry.percentage !== null)
      .sort((left, right) => right.percentage - left.percentage || lexicalCompare(left.name, right.name))[0]
    lines.push(
      dominant === undefined
        ? 'dominant: unattributed (no attributed segment percentages)'
        : `dominant: ${dominant.name} ${dominant.percentage.toFixed(2)}%`,
    )
  }
  return lines
}

export function buildReport(inputs: readonly InputDatabase[]): string {
  const loaded = inputs.map(loadDatabase)
  const allWindows = loaded.flatMap((result) => result.windows)
  const modes = [...new Set(loaded.map((result) => result.attributionMode))].sort(lexicalCompare)
  const sources = [...inputs]
    .sort((left, right) => lexicalCompare(left.label, right.label) || lexicalCompare(left.path, right.path))
    .map((input) => `${input.label}=${input.path}`)
  const lines = [
    'stage attribution report',
    `project attribution: ${modes.join('; ')}`,
    `sources: ${sources.join(', ')}`,
  ]

  const byProject = new Map<string, LoadedWindow[]>()
  for (const item of allWindows) {
    const projectWindows = byProject.get(item.project)
    if (projectWindows === undefined) byProject.set(item.project, [item])
    else projectWindows.push(item)
  }
  for (const project of [...byProject.keys()].sort(lexicalCompare)) {
    const projectWindows = byProject.get(project)!
    projectWindows.sort(
      (left, right) =>
        lexicalCompare(left.window.startAt, right.window.startAt) ||
        left.window.index - right.window.index ||
        lexicalCompare(left.window.runId, right.window.runId) ||
        lexicalCompare(left.source, right.source),
    )
    lines.push('', ...renderProject(project, projectWindows))
  }
  return `${lines.join('\n')}\n`
}

export function runStageAttributionCli(args: readonly string[]): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const inputs = parseArgs(args)
  if (inputs === null) return { exitCode: 2, stdout: '', stderr: `${USAGE}\n` }
  try {
    return { exitCode: 0, stdout: buildReport(inputs), stderr: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { exitCode: 1, stdout: '', stderr: `stage-attribution: ${message.split('\n')[0]}\n` }
  }
}

if (import.meta.main) {
  const result = runStageAttributionCli(process.argv.slice(2))
  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  if (result.stderr.length > 0) process.stderr.write(result.stderr)
  process.exit(result.exitCode)
}
