import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  CapabilityDeniedError,
  CapabilityGuard,
  SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'

import {
  TaskNotFoundError,
  buildInMemoryTaskStore,
  buildPickNextService,
  buildStubPickNextLlmClient,
  buildTools,
  loadManifest,
  type PickNextLlmClient,
} from '../index.ts'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog
const OWNER = 't1'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tasks-core-tools-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Deterministic clock+id helpers — keep tests stable across runs and
 * sidestep wall-clock collisions when create-then-list runs faster than
 * 1ms. The clock advances by 1 ms on every tick so the recent-first
 * ordering assertions are repeatable.
 */
function buildFixtures() {
  let nowMs = 1_700_000_000_000
  let nextN = 0
  const now = (): number => ++nowMs
  const nextId = (): string => `t-${nextN++}`
  return {
    store: buildInMemoryTaskStore({ now, nextId }),
    advance: (n: number) => (nowMs += n),
  }
}

describe('buildTools — capability-gated dispatch', () => {
  test('tasks_create + tasks_list round-trip through the TaskStore backend', async () => {
    const { store } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({
      manifest,
      project_slug: OWNER,
      audit,
      store,
    })

    const created = await tools.tasks_create({ title: 'ship Tasks Core' })
    expect(created.id).toBe('t-0')
    expect(created.task.title).toBe('ship Tasks Core')
    expect(created.task.status).toBe('open')
    expect(created.task.created_at).toBeGreaterThan(0)
    expect(created.task.updated_at).toBe(created.task.created_at)

    const created2 = await tools.tasks_create({
      title: 'wire launcher',
      priority: 2,
      project_id: 'p_neutron',
      due_date: '2026-06-01',
    })
    expect(created2.task.priority).toBe(2)
    expect(created2.task.project_id).toBe('p_neutron')
    expect(created2.task.due_date).toBe('2026-06-01')

    const list = await tools.tasks_list({})
    // Newest-first per the brief's behavioural-spec gate; the second
    // create was the most recent, so it lands at position 0.
    expect(list.results.map((r) => r.id)).toEqual(['t-1', 't-0'])

    // Every successful dispatch writes an audit row — proves the
    // capability guard ran on the success path.
    const auditRows = await audit.list({
      project_slug: OWNER,
      core_slug: 'tasks_core',
    })
    const successRows = auditRows.filter((r) => r.outcome === 'ok')
    expect(successRows.length).toBeGreaterThanOrEqual(3)
    const toolNames = new Set(successRows.map((r) => r.label))
    expect(toolNames.has('tasks_create')).toBe(true)
    expect(toolNames.has('tasks_list')).toBe(true)
  })

  test('tasks_update patches arbitrary fields + persists across reads', async () => {
    const { store, advance } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, store })

    const { id } = await tools.tasks_create({ title: 'first draft', priority: 5 })
    advance(10)

    const updated = await tools.tasks_update({
      task_id: id,
      fields: { title: 'final draft', priority: 1 },
    })
    expect(updated.task.title).toBe('final draft')
    expect(updated.task.priority).toBe(1)
    expect(updated.task.status).toBe('open')
    expect(updated.task.updated_at).toBeGreaterThan(updated.task.created_at)

    // List reflects the patch.
    const after = await tools.tasks_list({})
    expect(after.results[0]?.title).toBe('final draft')
    expect(after.results[0]?.priority).toBe(1)
  })

  test('tasks_complete stamps status=done + completed_at', async () => {
    const { store, advance } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, store })

    const { id } = await tools.tasks_create({ title: 'flush queue' })
    advance(5)

    const done = await tools.tasks_complete({ task_id: id })
    expect(done.task.status).toBe('done')
    expect(done.task.completed_at).toBeGreaterThan(0)
    expect(done.task.completed_at).toBe(done.task.updated_at)

    // The default `tasks_list` status filter excludes 'done' tasks.
    const openOnly = await tools.tasks_list({})
    expect(openOnly.results.map((r) => r.id)).not.toContain(id)

    // status='done' surfaces the completed row; status='all' surfaces both.
    const doneOnly = await tools.tasks_list({ status: 'done' })
    expect(doneOnly.results.map((r) => r.id)).toEqual([id])

    const all = await tools.tasks_list({ status: 'all' })
    expect(all.results.map((r) => r.id)).toEqual([id])
  })

  test('tasks_list status filter — `open` is the default, excludes done', async () => {
    const { store, advance } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, store })

    const a = await tools.tasks_create({ title: 'a' })
    advance(1)
    const b = await tools.tasks_create({ title: 'b' })
    advance(1)
    await tools.tasks_create({ title: 'c' })
    advance(1)
    await tools.tasks_complete({ task_id: a.id })
    await tools.tasks_complete({ task_id: b.id })

    const open = await tools.tasks_list({})
    expect(open.results.map((r) => r.id)).toEqual(['t-2'])

    const all = await tools.tasks_list({ status: 'all' })
    // 'all' still respects newest-first ordering.
    expect(all.results.map((r) => r.id)).toEqual(['t-2', 't-1', 't-0'])
  })

  test('tasks_list project_id filter narrows to a single project', async () => {
    const { store, advance } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, store })

    await tools.tasks_create({ title: 'global a' })
    advance(1)
    await tools.tasks_create({ title: 'p1 task', project_id: 'p1' })
    advance(1)
    await tools.tasks_create({ title: 'p2 task', project_id: 'p2' })

    const p1 = await tools.tasks_list({ project_id: 'p1' })
    expect(p1.results.map((r) => r.title)).toEqual(['p1 task'])
    const p2 = await tools.tasks_list({ project_id: 'p2' })
    expect(p2.results.map((r) => r.title)).toEqual(['p2 task'])
  })

  test('tasks_delete removes the row + downstream reads ignore it', async () => {
    const { store, advance } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, store })

    const a = await tools.tasks_create({ title: 'a' })
    advance(1)
    const b = await tools.tasks_create({ title: 'b' })

    const result = await tools.tasks_delete({ task_id: a.id })
    expect(result.ok).toBe(true)
    expect(result.task_id).toBe(a.id)

    const list = await tools.tasks_list({ status: 'all' })
    expect(list.results.map((r) => r.id)).toEqual([b.id])

    // Deleting a non-existent task throws TaskNotFoundError (the guard
    // wrapper records an `error` outcome and re-throws).
    await expect(tools.tasks_delete({ task_id: 'missing' })).rejects.toThrow(
      TaskNotFoundError,
    )
  })

  test('capability gate: stripped write capability rejects every write tool, leaves read intact', async () => {
    const { store } = buildFixtures()
    // Synthesise a manifest with the five tool entries but strip
    // `write:tasks_core.db` from the capabilities[] array. The guard
    // must reject every write tool with `capability_not_declared`
    // and write a `capability_denied` audit row. `tasks_list`
    // continues to work — its gate is `read:tasks_core.db` which
    // is still declared.
    const m0 = loadManifest()
    const downgraded: NeutronManifest = {
      ...m0,
      capabilities: m0.capabilities.filter((c) => c !== 'write:tasks_core.db'),
    }
    const tools = buildTools({
      manifest: downgraded,
      project_slug: OWNER,
      audit,
      store,
    })

    await expect(tools.tasks_create({ title: 'x' })).rejects.toThrow(
      CapabilityDeniedError,
    )
    await expect(
      tools.tasks_update({ task_id: 't-0', fields: { title: 'y' } }),
    ).rejects.toThrow(CapabilityDeniedError)
    await expect(tools.tasks_complete({ task_id: 't-0' })).rejects.toThrow(
      CapabilityDeniedError,
    )
    await expect(tools.tasks_delete({ task_id: 't-0' })).rejects.toThrow(
      CapabilityDeniedError,
    )

    const list = await tools.tasks_list({})
    expect(list.results).toEqual([])

    const denied = await audit.listDenied({
      project_slug: OWNER,
      core_slug: 'tasks_core',
    })
    const labels = new Set(denied.map((r) => r.label))
    expect(labels.has('tasks_create')).toBe(true)
    expect(labels.has('tasks_update')).toBe(true)
    expect(labels.has('tasks_complete')).toBe(true)
    expect(labels.has('tasks_delete')).toBe(true)
    expect(labels.has('tasks_list')).toBe(false)
  })

  test('tasks_pick_next is registered when pickNext dep is supplied', async () => {
    const { store } = buildFixtures()
    const manifest = loadManifest()
    const pickNext = buildPickNextService({
      store,
      llm: buildStubPickNextLlmClient(),
    })
    const tools = buildTools({ manifest, project_slug: OWNER, audit, store, pickNext })
    expect(tools.tasks_pick_next).toBeDefined()

    // Empty backlog: short-circuit to null candidate, no LLM call.
    const empty = await tools.tasks_pick_next!({})
    expect(empty.candidate).toBeNull()
    expect(empty.alternatives).toEqual([])

    // Seed two tasks + assert the chosen candidate is the focus-leader.
    await tools.tasks_create({ title: 'low', priority: 0 })
    await tools.tasks_create({ title: 'high', priority: 3 })
    const picked = await tools.tasks_pick_next!({})
    expect(picked.candidate?.title).toBe('high')
    expect(picked.audit.candidates_considered).toBe(2)
    expect(picked.audit.llm_model).toBe('stub-pick-next')
  })

  test('tasks_pick_next is omitted when no pickNext dep is supplied', () => {
    const { store } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, store })
    expect(tools.tasks_pick_next).toBeUndefined()
  })

  test('tasks_pick_next: stripped read capability rejects + audit_denied', async () => {
    const { store } = buildFixtures()
    const m0 = loadManifest()
    const downgraded = {
      ...m0,
      capabilities: m0.capabilities.filter((c) => c !== 'read:tasks_core.db'),
    }
    const pickNext = buildPickNextService({
      store,
      llm: buildStubPickNextLlmClient(),
    })
    const tools = buildTools({
      manifest: downgraded,
      project_slug: OWNER,
      audit,
      store,
      pickNext,
    })
    await expect(tools.tasks_pick_next!({})).rejects.toThrow(CapabilityDeniedError)
    const denied = await audit.listDenied({
      project_slug: OWNER,
      core_slug: 'tasks_core',
    })
    expect(denied.some((r) => r.label === 'tasks_pick_next')).toBe(true)
  })

  test('tasks_pick_next: project_id narrows + LLM stub picks index 0', async () => {
    const { store } = buildFixtures()
    const manifest = loadManifest()
    const recorded: { calls: number; lastCount: number } = { calls: 0, lastCount: 0 }
    const llm: PickNextLlmClient = {
      async rank({ candidates }) {
        recorded.calls += 1
        recorded.lastCount = candidates.length
        return { chosen_index: 0, rationale: 'pick the top one', model_id: 'recorded' }
      },
    }
    const pickNext = buildPickNextService({ store, llm })
    const tools = buildTools({ manifest, project_slug: OWNER, audit, store, pickNext })

    await tools.tasks_create({ title: 'p1-a', priority: 3, project_id: 'p1' })
    await tools.tasks_create({ title: 'p2-a', priority: 3, project_id: 'p2' })

    const out = await tools.tasks_pick_next!({ project_id: 'p1' })
    expect(out.candidate?.title).toBe('p1-a')
    expect(out.audit.llm_model).toBe('recorded')
    expect(recorded.calls).toBe(1)
    expect(recorded.lastCount).toBe(1)
  })

  test('capability gate: undeclared tool name is rejected by `tool_not_declared`', async () => {
    // Build a guard directly + assert against an undeclared tool. The
    // wrapped handlers exposed by `buildTools` use only the five tool
    // names declared in the manifest, so this verifies the underlying
    // gate behaviour for completeness — a Core author who registered
    // an extra tool at runtime would trip this.
    const m = loadManifest()
    const guard = new CapabilityGuard({
      manifest: m,
      core_slug: 'tasks_core',
      project_slug: OWNER,
      audit,
    })

    const result = guard.check({
      tool_name: 'tasks_unknown_tool',
      capability_required: 'write:tasks_core.db',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('tool_not_declared')
    }
  })
})
