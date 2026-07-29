import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { OvernightQueueStore } from './queue-store.ts'
import {
  OvernightDispatcher,
  currentWindowDate,
  inOvernightWindow,
  type OptedInProject,
  type OvernightTridentCreateInput,
  type OvernightTridentSeam,
  type OvernightTridentSnapshot,
} from './dispatcher.ts'
import { runMorningBrief, type MorningBriefDeliverInput } from './morning-brief.ts'
import {
  buildOvernightTridentSeam,
  defaultResultDocWriter,
  defaultStatusMdIO,
} from './register.ts'

// PDT (June, UTC-7): 23:00–07:00 PT == 06:00 UTC–14:00 UTC.
const INSIDE_WINDOW = Date.parse('2026-06-20T08:30:00Z') // 01:30 PDT → window 2026-06-19
const OUTSIDE_WINDOW = Date.parse('2026-06-20T20:00:00Z') // 13:00 PDT
const REPORTER_TIME = Date.parse('2026-06-20T13:55:00Z') // 06:55 PDT → window 2026-06-19
const WINDOW_DATE = '2026-06-19'

let tmp: string
let db: ProjectDb
let queue: OvernightQueueStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-overnight-disp-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  queue = new OvernightQueueStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ---- test helpers ---------------------------------------------------------

function makeProject(
  slug: string,
  opts: { optIn?: boolean; contextFiles?: Record<string, string>; bullets?: string } = {},
): OptedInProject {
  const repo_root = join(tmp, 'Projects', slug)
  mkdirSync(repo_root, { recursive: true })
  for (const [rel, body] of Object.entries(opts.contextFiles ?? {})) {
    const abs = join(repo_root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  const optIn = opts.optIn ?? true
  const status_md_path = join(repo_root, 'STATUS.md')
  const fm = `---\nname: ${slug}\n${optIn ? 'autonomous_overnight_enabled: true\n' : ''}---\n`
  writeFileSync(
    status_md_path,
    `${fm}\n# Status\n\n## Autonomous Overnight Work\n\n${opts.bullets ?? '_No overnight work queued._'}\n`,
  )
  return { slug, repo_root, status_md_path }
}

/** A scripted Trident seam the test transitions to terminal on demand. */
class FakeTrident implements OvernightTridentSeam {
  created: OvernightTridentCreateInput[] = []
  private snaps = new Map<string, OvernightTridentSnapshot>()
  private seq = 0
  async createRun(input: OvernightTridentCreateInput) {
    this.created.push(input)
    const id = `run-${++this.seq}`
    this.snaps.set(id, { phase: 'forge-init', failure_reason: null, branch: null, pr: null })
    return { id, slug: input.slug }
  }
  getRun(id: string) {
    return this.snaps.get(id) ?? null
  }
  finish(id: string, snap: OvernightTridentSnapshot) {
    this.snaps.set(id, snap)
  }
}

function makeDispatcher(
  trident: OvernightTridentSeam,
  projects: OptedInProject[],
  now: number,
  overrides: Partial<ConstructorParameters<typeof OvernightDispatcher>[0]> = {},
): OvernightDispatcher {
  return new OvernightDispatcher({
    store: queue,
    trident,
    io: defaultStatusMdIO,
    result_docs: defaultResultDocWriter,
    listOptedInProjects: () => projects,
    now: () => now,
    ...overrides,
  })
}

// ---- window helpers -------------------------------------------------------

describe('window gating', () => {
  test('inOvernightWindow / currentWindowDate', () => {
    expect(inOvernightWindow(INSIDE_WINDOW)).toBe(true)
    expect(inOvernightWindow(OUTSIDE_WINDOW)).toBe(false)
    expect(currentWindowDate(INSIDE_WINDOW)).toBe(WINDOW_DATE)
    expect(currentWindowDate(OUTSIDE_WINDOW)).toBeNull()
  })

  test('scan tick is a no-op outside the window', async () => {
    const p = makeProject('acme', { contextFiles: { 'docs/spec.md': 'spec' } })
    await queue.create({
      id: 'owk-20260619-001',
      owner_slug: 'acme',
      description: 'x',
      context_relpath: 'docs/spec.md',
    })
    const trident = new FakeTrident()
    const d = makeDispatcher(trident, [p], OUTSIDE_WINDOW)
    expect(await d.runScanTick()).toBeNull()
    expect(trident.created.length).toBe(0)
    expect(queue.get('owk-20260619-001')?.status).toBe('queued')
  })
})

// ---- the core path: item → Trident run → REAL result → brief --------------

describe('item runs AS a Trident run; brief reports the REAL result', () => {
  test('scan dispatches a run; advance records the real result + writes a doc on disk', async () => {
    const p = makeProject('acme', { contextFiles: { 'docs/spec.md': '# spec\nbuild the importer' } })
    await queue.create({
      id: 'owk-20260619-001',
      owner_slug: 'acme',
      description: 'Build the importer',
      priority: 'P1',
      context_relpath: 'docs/spec.md',
    })
    const trident = new FakeTrident()
    const d = makeDispatcher(trident, [p], INSIDE_WINDOW)

    // SCAN — a real Trident run is created with the resolved context threaded in.
    const scan = await d.runScanTick()
    expect(scan?.dispatched).toBe(1)
    expect(trident.created.length).toBe(1)
    expect(trident.created[0]!.task).toBe('Build the importer')
    expect(trident.created[0]!.context_text).toContain('build the importer')
    const dispatched = queue.get('owk-20260619-001')!
    expect(dispatched.status).toBe('in-flight')
    expect(dispatched.trident_run_id).not.toBeNull()
    expect(dispatched.window_date_local).toBe(WINDOW_DATE)

    // The Trident run reaches a REAL terminal state (Argus APPROVE → merge).
    trident.finish(dispatched.trident_run_id!, {
      phase: 'done',
      failure_reason: null,
      branch: 'overnight/owk-20260619-001',
      pr: 42,
    })

    // ADVANCE — records the REAL result and writes it to disk (NOT "phase advanced").
    const advance = await d.runAdvanceTick()
    expect(advance.completed).toBe(1)
    const done = queue.get('owk-20260619-001')!
    expect(done.status).toBe('completed')
    expect(done.result).toBe('PR#42')
    expect(done.finished_at).not.toBeNull()

    // REAL doc on disk in the project repo.
    const docPath = join(p.repo_root, 'docs', 'overnight', 'owk-20260619-001.md')
    expect(existsSync(docPath)).toBe(true)
    expect(readFileSync(docPath, 'utf8')).toContain('PR#42')

    // STATUS.md re-rendered to reflect the completed item.
    const statusMd = readFileSync(p.status_md_path, 'utf8')
    expect(statusMd).toContain('[x]')
    expect(statusMd).toContain('[result:PR#42]')

    // MORNING BRIEF — reports the REAL result, routed.
    const delivered: MorningBriefDeliverInput[] = []
    const brief = await runMorningBrief({
      store: queue,
      deliver: (m) => {
        delivered.push(m)
        return true
      },
      general_topic_id: 'general',
      resolveProjectTopic: (slug) => (slug === 'acme' ? 'topic-acme' : null),
      now: () => REPORTER_TIME,
    })
    expect(brief.status).toBe('reported')
    expect(brief.items_reported).toBe(1)
    // General summary + per-project detail.
    const general = delivered.find((m) => m.topic_id === 'general')!
    expect(general.body).toContain('1 completed')
    const detail = delivered.find((m) => m.topic_id === 'topic-acme')!
    expect(detail.body).toContain('PR#42')
    expect(detail.body).toContain('Build the importer')
  })

  test('a failed Trident run records the real failure reason (no invention)', async () => {
    const p = makeProject('acme', { contextFiles: { 'docs/spec.md': 'spec' } })
    await queue.create({
      id: 'owk-20260619-002',
      owner_slug: 'acme',
      description: 'Risky build',
      context_relpath: 'docs/spec.md',
    })
    const trident = new FakeTrident()
    const d = makeDispatcher(trident, [p], INSIDE_WINDOW)
    await d.runScanTick()
    const runId = queue.get('owk-20260619-002')!.trident_run_id!
    trident.finish(runId, {
      phase: 'failed',
      failure_reason: 'reached max_rounds (8) without Argus APPROVE',
      branch: null,
      pr: null,
    })
    const advance = await d.runAdvanceTick()
    expect(advance.failed).toBe(1)
    const item = queue.get('owk-20260619-002')!
    expect(item.status).toBe('failed')
    expect(item.result).toContain('reached max_rounds')
  })
})

// ---- the hard gate --------------------------------------------------------

describe('[context:] hard gate at dispatch', () => {
  test('an item with no context is rejected, not dispatched', async () => {
    const p = makeProject('acme')
    await queue.create({ id: 'owk-20260619-010', owner_slug: 'acme', description: 'no ctx' })
    const trident = new FakeTrident()
    const rejections: string[] = []
    const d = makeDispatcher(trident, [p], INSIDE_WINDOW, {
      on_rejection: (r) => rejections.push(`${r.item.id}:${r.reason}`),
    })
    const scan = await d.runScanTick()
    expect(scan?.dispatched).toBe(0)
    expect(scan?.rejected).toBe(1)
    expect(trident.created.length).toBe(0)
    expect(rejections).toContain('owk-20260619-010:missing-context-tag')
    expect(queue.get('owk-20260619-010')?.status).toBe('queued')
  })

  test('an item whose context file is missing is rejected', async () => {
    const p = makeProject('acme')
    await queue.create({
      id: 'owk-20260619-011',
      owner_slug: 'acme',
      description: 'bad ctx',
      context_relpath: 'docs/ghost.md',
    })
    const trident = new FakeTrident()
    const d = makeDispatcher(trident, [p], INSIDE_WINDOW)
    const scan = await d.runScanTick()
    expect(scan?.rejected).toBe(1)
    expect(trident.created.length).toBe(0)
  })
})

// ---- budget / concurrency caps -------------------------------------------

describe('budget + concurrency caps', () => {
  test('max_concurrent caps simultaneous dispatch', async () => {
    const p = makeProject('acme', { contextFiles: { 'docs/spec.md': 'spec' } })
    for (let i = 1; i <= 3; i++) {
      await queue.create({
        id: `owk-20260619-02${i}`,
        owner_slug: 'acme',
        description: `t${i}`,
        context_relpath: 'docs/spec.md',
      })
    }
    const trident = new FakeTrident()
    const d = makeDispatcher(trident, [p], INSIDE_WINDOW, { max_concurrent: 2, max_per_window: 8 })
    const scan = await d.runScanTick()
    expect(scan?.dispatched).toBe(2)
    expect(queue.countInFlight()).toBe(2)
    expect(queue.listByStatus('queued').length).toBe(1)
  })

  test('max_per_window caps cumulative dispatch across ticks', async () => {
    const p = makeProject('acme', { contextFiles: { 'docs/spec.md': 'spec' } })
    for (let i = 1; i <= 3; i++) {
      await queue.create({
        id: `owk-20260619-03${i}`,
        owner_slug: 'acme',
        description: `t${i}`,
        context_relpath: 'docs/spec.md',
      })
    }
    const trident = new FakeTrident()
    const d = makeDispatcher(trident, [p], INSIDE_WINDOW, { max_concurrent: 5, max_per_window: 1 })
    const scan = await d.runScanTick()
    expect(scan?.dispatched).toBe(1)
    expect(queue.startedThisWindow(WINDOW_DATE)).toBe(1)
    // Even with concurrency headroom, the window cap blocks further dispatch.
    const scan2 = await d.runScanTick()
    expect(scan2?.dispatched).toBe(0)
  })

  test('higher priority dispatches first', async () => {
    const p = makeProject('acme', { contextFiles: { 'docs/spec.md': 'spec' } })
    await queue.create({
      id: 'owk-20260619-040',
      owner_slug: 'acme',
      description: 'low',
      priority: 'P3',
      context_relpath: 'docs/spec.md',
    })
    await queue.create({
      id: 'owk-20260619-041',
      owner_slug: 'acme',
      description: 'high',
      priority: 'P1',
      context_relpath: 'docs/spec.md',
    })
    const trident = new FakeTrident()
    const d = makeDispatcher(trident, [p], INSIDE_WINDOW, { max_concurrent: 1, max_per_window: 8 })
    await d.runScanTick()
    expect(queue.get('owk-20260619-041')?.status).toBe('in-flight')
    expect(queue.get('owk-20260619-040')?.status).toBe('queued')
  })
})

// ---- onboarding seed: STATUS.md bullet → real queue row -------------------

describe('reconcile: hand-seeded STATUS.md bullet becomes a real queue row', () => {
  test('a bare seeded bullet is adopted into the queue + dispatched', async () => {
    const p = makeProject('acme', {
      contextFiles: { 'docs/overnight/seed-context.md': '# ctx\nproject signal' },
      bullets:
        '- [ ] Deepen + analyze acme from imported context [agent:atlas] [priority:P3] [context:docs/overnight/seed-context.md]',
    })
    const trident = new FakeTrident()
    const d = makeDispatcher(trident, [p], INSIDE_WINDOW)
    const scan = await d.runScanTick()
    expect(scan?.reconciled).toBe(1)
    // The adopted row exists with an allocated owk-id and was dispatched.
    const rows = queue.listByProject('acme')
    expect(rows.length).toBe(1)
    expect(rows[0]!.id).toMatch(/^owk-\d{8}-\d{3,}$/)
    expect(rows[0]!.agent_role).toBe('atlas')
    expect(rows[0]!.status).toBe('in-flight')
    expect(trident.created.length).toBe(1)
  })
})

// ---- the REAL Trident store seam ------------------------------------------

describe('real TridentRunStore seam', () => {
  test('dispatch creates a code_trident_runs row; advance reads its real terminal state', async () => {
    const p = makeProject('acme', { contextFiles: { 'docs/spec.md': 'spec' } })
    await queue.create({
      id: 'owk-20260619-050',
      owner_slug: 'acme',
      description: 'real run',
      context_relpath: 'docs/spec.md',
    })
    const tridentStore = new TridentRunStore(db)
    const seam = buildOvernightTridentSeam(tridentStore)
    const d = makeDispatcher(seam, [p], INSIDE_WINDOW)

    await d.runScanTick()
    const runId = queue.get('owk-20260619-050')!.trident_run_id!
    // A genuine code_trident_runs row exists for this item.
    const run = tridentStore.get(runId)
    expect(run).not.toBeNull()
    expect(run?.task).toContain('real run')
    expect(run?.project_slug).toBe('acme')

    // Drive the run to a real terminal state through the Trident store.
    await tridentStore.update(runId, { phase: 'done', pr: 7, branch: 'overnight/owk-20260619-050' })

    const advance = await d.runAdvanceTick()
    expect(advance.completed).toBe(1)
    expect(queue.get('owk-20260619-050')?.result).toBe('PR#7')
  })
})
