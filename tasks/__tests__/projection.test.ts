import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import {
  buildProjectionWriter,
  PROJECTION_BLOCK_END,
  PROJECTION_BLOCK_START,
  findMarkedBlock,
  formatPriorityTag,
  renderActionsFile,
  renderStatusBlock,
  replaceMarkedBlock,
} from '../projection/index.ts'
import { TaskStore, type Task } from '../store.ts'

const NOW = Date.parse('2026-05-20T12:00:00.000Z')

function fakeTask(overrides: Partial<Task>): Task {
  return {
    id: 'fake',
    project_slug: 't1',
    project_id: 'proj-A',
    title: 'placeholder',
    description: null,
    status: 'open',
    priority: null,
    due_date: null,
    owner_persona: null,
    source: null,
    focus_score: 10,
    focus_score_updated_at: new Date(NOW).toISOString(),
    llm_rank: null,
    llm_reason: null,
    prioritized_by: null,
    prioritized_at: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    completed_at: null,
    ...overrides,
  }
}

describe('projection — format', () => {
  test('formatPriorityTag converts 0..3 → P3..P0', () => {
    expect(formatPriorityTag(3)).toBe('P0')
    expect(formatPriorityTag(2)).toBe('P1')
    expect(formatPriorityTag(1)).toBe('P2')
    expect(formatPriorityTag(0)).toBe('P3')
    expect(formatPriorityTag(null)).toBeNull()
  })

  test('renderStatusBlock emits Nova-style tags', () => {
    const out = renderStatusBlock({
      active: [
        fakeTask({
          id: '1',
          title: 'submit Q3 report',
          priority: 2,
          due_date: '2026-05-25T09:00:00.000Z',
          focus_score: 18.5,
        }),
      ],
      done: [
        fakeTask({
          id: '2',
          title: 'archive old emails',
          status: 'done',
          completed_at: '2026-05-15T10:00:00.000Z',
        }),
      ],
    })
    expect(out).toContain('## Tasks')
    expect(out).toContain('### Active')
    expect(out).toContain(
      '- [ ] submit Q3 report [P1] [due:2026-05-25] [focus:18.5]',
    )
    expect(out).toContain('### Done (last 30 days)')
    expect(out).toContain('- [x] ~~archive old emails~~ ✅ 2026-05-15')
  })

  test('renderActionsFile produces frontmatter + auto-gen header', () => {
    const out = renderActionsFile({
      active: [fakeTask({ id: '1', title: 'one', priority: 3 })],
      done: [],
      project_id: 'proj-A',
      project_name: 'Project A',
      last_updated_iso: new Date(NOW).toISOString(),
    })
    expect(out).toMatch(/^---\nproject: proj-A\n/)
    expect(out).toContain('generated_by: neutron-tasks-projection')
    expect(out).toContain('# Project A — Actions')
    expect(out).toContain('- [ ] one [P0]')
  })

  test('renderStatusBlock empty active/done renders placeholders', () => {
    const out = renderStatusBlock({ active: [], done: [] })
    expect(out).toContain('_No active tasks._')
    expect(out).toContain('_No tasks completed in the last 30 days._')
  })
})

describe('projection — parse', () => {
  test('replaceMarkedBlock injects markers when absent', () => {
    const out = replaceMarkedBlock('# Header\n\nSome narrative.', 'BODY')
    expect(out).toContain(PROJECTION_BLOCK_START)
    expect(out).toContain('BODY')
    expect(out).toContain(PROJECTION_BLOCK_END)
    expect(out.indexOf('Some narrative.')).toBeLessThan(
      out.indexOf(PROJECTION_BLOCK_START),
    )
  })

  test('replaceMarkedBlock preserves outside-block content', () => {
    const existing = [
      '# Header',
      '',
      'Outer narrative.',
      '',
      PROJECTION_BLOCK_START,
      '',
      'OLD BODY',
      '',
      PROJECTION_BLOCK_END,
      '',
      'Footer text that must survive.',
    ].join('\n')
    const out = replaceMarkedBlock(existing, 'NEW BODY')
    expect(out).toContain('Outer narrative.')
    expect(out).toContain('NEW BODY')
    expect(out).toContain('Footer text that must survive.')
    expect(out).not.toContain('OLD BODY')
    // Markers still bracket the body exactly once.
    const range = findMarkedBlock(out)
    expect(range).not.toBeNull()
  })

  test('findMarkedBlock returns null on missing markers', () => {
    expect(findMarkedBlock('no markers at all')).toBeNull()
    expect(findMarkedBlock(PROJECTION_BLOCK_START)).toBeNull()
  })
})

/**
 * Poll a condition until true or a generous deadline elapses. Replaces fixed
 * `setTimeout(debounce + slack)` sleeps so these debounce-timing tests stay
 * green under heavy concurrent CI load (the bounded-memory chunk runner packs
 * ~100 files / 1000+ tests into one process, where a fixed 70 ms slack over a
 * 50 ms debounce reliably slips — a load flake, not a real regression). The
 * semantics are unchanged: the debounce still fires on its own; we just wait
 * for its effect instead of guessing how long it takes.
 */
async function waitUntil(check: () => boolean, timeoutMs = 4000, stepMs = 10): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - start >= timeoutMs) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

describe('projection — writer (debounced atomic write)', () => {
  let tmp: string
  let db: ProjectDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-projection-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('mutation triggers projection write after debounce', async () => {
    const store = new TaskStore(db)
    const projectsDir = join(tmp, 'Projects')
    const writer = buildProjectionWriter({
      store,
      resolveProjectDir: ({ project_id }) =>
        project_id === ''
          ? null
          : { dir: join(projectsDir, project_id), name: project_id },
      debounce_ms: 50,
    })
    await store.create({
      project_slug: 't1',
      project_id: 'proj-A',
      title: 'one',
      priority: 2,
    })
    const statusPath = join(projectsDir, 'proj-A', 'STATUS.md')
    const actionsPath = join(projectsDir, 'proj-A', 'ACTIONS.md')
    // Wait for the debounce to fire on its own (load-robust poll, not a fixed
    // sleep over a 50 ms debounce).
    await waitUntil(() => existsSync(statusPath) && existsSync(actionsPath))
    const status = readFileSync(statusPath, 'utf8')
    const actions = readFileSync(actionsPath, 'utf8')
    expect(status).toContain('- [ ] one [P1]')
    expect(actions).toContain('# proj-A — Actions')
    expect(actions).toContain('- [ ] one [P1]')
    await writer.stop()
  })

  test('STATUS.md narrative outside the marked block is preserved', async () => {
    const store = new TaskStore(db)
    const projectsDir = join(tmp, 'Projects')
    const statusPath = join(projectsDir, 'proj-A', 'STATUS.md')
    // Seed pre-existing narrative.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(projectsDir, 'proj-A'), { recursive: true })
    writeFileSync(
      statusPath,
      [
        '---',
        'project: proj-A',
        '---',
        '',
        '# Project A',
        '',
        '## Narrative',
        '',
        'This text MUST survive the projection rewrite.',
        '',
      ].join('\n'),
      'utf8',
    )
    const writer = buildProjectionWriter({
      store,
      resolveProjectDir: ({ project_id }) =>
        project_id === ''
          ? null
          : { dir: join(projectsDir, project_id), name: project_id },
      debounce_ms: 30,
    })
    await store.create({
      project_slug: 't1',
      project_id: 'proj-A',
      title: 'survivor task',
    })
    await writer.flushNow()
    const after = readFileSync(statusPath, 'utf8')
    expect(after).toContain('## Narrative')
    expect(after).toContain('This text MUST survive the projection rewrite.')
    expect(after).toContain('- [ ] survivor task')
    expect(after).toContain(PROJECTION_BLOCK_START)
    await writer.stop()
  })

  test('debounce coalesces a burst of mutations into one write', async () => {
    const store = new TaskStore(db)
    const projectsDir = join(tmp, 'Projects')
    const writer = buildProjectionWriter({
      store,
      resolveProjectDir: ({ project_id }) =>
        project_id === ''
          ? null
          : { dir: join(projectsDir, project_id), name: project_id },
      debounce_ms: 100,
    })
    for (let i = 0; i < 10; i++) {
      await store.create({
        project_slug: 't1',
        project_id: 'proj-A',
        title: `t-${i}`,
      })
    }
    // Wait for the single coalesced write to land (load-robust poll past the
    // 100 ms debounce window).
    await waitUntil(() => writer.stats().writes >= 1)
    const stats = writer.stats()
    expect(stats.writes).toBe(1)
    expect(stats.coalesced).toBeGreaterThan(0)
    await writer.stop()
  })

  test('atomic write lands projection files with mode 0o600 (owner-only)', async () => {
    const store = new TaskStore(db)
    const projectsDir = join(tmp, 'Projects')
    const writer = buildProjectionWriter({
      store,
      resolveProjectDir: ({ project_id }) =>
        project_id === ''
          ? null
          : { dir: join(projectsDir, project_id), name: project_id },
      debounce_ms: 20,
    })
    await store.create({
      project_slug: 't1',
      project_id: 'proj-A',
      title: 'sensitive title',
    })
    await writer.flushNow()
    const statusPath = join(projectsDir, 'proj-A', 'STATUS.md')
    const actionsPath = join(projectsDir, 'proj-A', 'ACTIONS.md')
    // Mask out the file-type bits; we only care about the perm bits.
    expect(statSync(statusPath).mode & 0o777).toBe(0o600)
    expect(statSync(actionsPath).mode & 0o777).toBe(0o600)
    await writer.stop()
  })

  test('NO_PROJECT bucket can be opted out via resolveProjectDir=null', async () => {
    const store = new TaskStore(db)
    let skips = 0
    const writer = buildProjectionWriter({
      store,
      resolveProjectDir: () => null,
      debounce_ms: 20,
      log: (event) => {
        if (event.kind === 'skipped_no_dir') skips += 1
      },
    })
    await store.create({ project_slug: 't1', title: 'unscoped' })
    await new Promise((r) => setTimeout(r, 80))
    expect(skips).toBe(1)
    expect(writer.stats().writes).toBe(0)
    await writer.stop()
  })
})
