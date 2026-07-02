import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { ToolRegistry, type ToolCallContext } from '../tools/registry.ts'
import { WorkBoardStore } from './store.ts'
import {
  registerWorkBoardToolSurface,
  WORK_BOARD_ADD_TOOL,
  WORK_BOARD_COMPLETE_TOOL,
  WORK_BOARD_LIST_TOOL,
  WORK_BOARD_REORDER_TOOL,
  WORK_BOARD_UPDATE_TOOL,
} from './agent-tool.ts'

let tmp: string
let db: ProjectDb
let registry: ToolRegistry
let store: WorkBoardStore

function ctx(project_slug: string): ToolCallContext {
  return { project_slug, topic_id: null, call_id: 'c1', speaker_user_id: null }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-work-board-tool-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  registry = new ToolRegistry()
  store = new WorkBoardStore(db)
  registerWorkBoardToolSurface(registry, store)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('work_board_* agent tools', () => {
  test('all five tools register, visible (non-agent_hidden), auto + capability', () => {
    for (const name of [
      WORK_BOARD_LIST_TOOL,
      WORK_BOARD_ADD_TOOL,
      WORK_BOARD_UPDATE_TOOL,
      WORK_BOARD_COMPLETE_TOOL,
      WORK_BOARD_REORDER_TOOL,
    ]) {
      const tool = registry.get(name)
      expect(tool).toBeDefined()
      expect(tool!.agent_hidden).not.toBe(true)
      expect(tool!.approval_policy).toBe('auto')
      expect(tool!.capability_required.startsWith('read:') || tool!.capability_required.startsWith('write:')).toBe(true)
    }
    expect(registry.get(WORK_BOARD_LIST_TOOL)!.capability_required).toBe('read:project_data')
    expect(registry.get(WORK_BOARD_ADD_TOOL)!.capability_required).toBe('write:project_data')
  })

  test('input schemas do NOT expose project_slug (server-derived only)', () => {
    for (const name of [WORK_BOARD_ADD_TOOL, WORK_BOARD_UPDATE_TOOL, WORK_BOARD_REORDER_TOOL]) {
      const schema = registry.get(name)!.input_schema as {
        properties?: Record<string, unknown>
      }
      expect(schema.properties).toBeDefined()
      expect(Object.keys(schema.properties!)).not.toContain('project_slug')
    }
  })

  test('handler keys writes by ctx.project_slug, IGNORING any project_slug in args', async () => {
    const add = registry.get(WORK_BOARD_ADD_TOOL)!
    // The model passes a bogus project_slug in args; it must be ignored.
    const res = (await add.handler(
      { title: 'spoof attempt', project_slug: 'victim' },
      ctx('owner'),
    )) as { ok: boolean; item?: { id: string } }
    expect(res.ok).toBe(true)
    // Stored under the server ctx slug, NOT the arg slug.
    expect(store.list('owner').length).toBe(1)
    expect(store.list('victim').length).toBe(0)
  })

  test('list returns the ctx-scoped board', async () => {
    await store.create('owner', { title: 'A' })
    await store.create('owner', { title: 'B' })
    await store.create('elsewhere', { title: 'C' })
    const list = registry.get(WORK_BOARD_LIST_TOOL)!
    const res = (await list.handler({}, ctx('owner'))) as { items: unknown[] }
    expect(res.items.length).toBe(2)
  })

  test('add → update → complete round-trips through the tools', async () => {
    const add = registry.get(WORK_BOARD_ADD_TOOL)!
    const created = (await add.handler({ title: 'do the thing' }, ctx('owner'))) as {
      ok: boolean
      item: { id: string }
    }
    const id = created.item.id
    const update = registry.get(WORK_BOARD_UPDATE_TOOL)!
    await update.handler({ id, status: 'in_progress' }, ctx('owner'))
    const complete = registry.get(WORK_BOARD_COMPLETE_TOOL)!
    const done = (await complete.handler({ id }, ctx('owner'))) as {
      ok: boolean
      item?: { status: string }
    }
    expect(done.item?.status).toBe('done')
  })

  test('add with a disallowed design_doc_ref scheme returns an error result (not a throw)', async () => {
    const add = registry.get(WORK_BOARD_ADD_TOOL)!
    const res = (await add.handler(
      { title: 'x', design_doc_ref: 'javascript:alert(1)' },
      ctx('owner'),
    )) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('design_doc_ref')
  })
})

describe('work_board_add spec-doc routing (M1)', () => {
  test('the add schema exposes a `spec` param', () => {
    const schema = registry.get(WORK_BOARD_ADD_TOOL)!.input_schema as {
      properties?: Record<string, unknown>
    }
    expect(Object.keys(schema.properties!)).toContain('spec')
  })

  test('when a specDoc service is wired, add routes through it (spec persisted)', async () => {
    const reg = new ToolRegistry()
    const seen: Array<{ title: string; spec?: string }> = []
    // Minimal structural stand-in for WorkBoardSpecDocService.
    const specDoc = {
      createCardWithOptionalSpec: async (
        slug: string,
        input: { title: string; spec?: string; status?: 'upcoming' | 'in_progress' | 'done'; design_doc_ref?: string | null },
      ) => {
        seen.push({ title: input.title, ...(input.spec !== undefined ? { spec: input.spec } : {}) })
        return store.create(slug, { title: input.title, design_doc_ref: 'neutron-docs:plans/x.md' })
      },
      resolveTaskForItem: async () => 'unused',
    }
    registerWorkBoardToolSurface(reg, store, {
      specDoc: specDoc as unknown as import('./spec-doc-service.ts').WorkBoardSpecDocService,
    })
    const out = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Wire it', spec: 'a\nb\nc' },
      ctx('owner'),
    )) as { ok: boolean; item?: { design_doc_ref: string | null } }
    expect(out.ok).toBe(true)
    expect(seen).toEqual([{ title: 'Wire it', spec: 'a\nb\nc' }])
    expect(out.item?.design_doc_ref).toBe('neutron-docs:plans/x.md')
  })
})
