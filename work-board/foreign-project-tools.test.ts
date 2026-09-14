import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { registerTridentBuildToolSurface } from '@neutronai/trident/work-board-build-tool.ts'
import { registerWorkBoardToolSurface } from './agent-tool.ts'
import { WorkBoardStore } from './store.ts'
import { WorkBoardRemovalService } from './removal.ts'

let tmp: string
let db: ProjectDb
let store: WorkBoardStore
let registry: ToolRegistry
const context = { project_slug: 'scope-owner', project_id: 'local', topic_id: null, call_id: 'c1', speaker_user_id: null }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'board-foreign-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  store = new WorkBoardStore(db)
  registry = new ToolRegistry()
  registerWorkBoardToolSurface(registry, store, { removal: new WorkBoardRemovalService({ store }) })
  registerTridentBuildToolSurface(registry, {
    store: new TridentRunStore(db), work_board: store, repo_path: tmp,
    resolveBuildRepo: async () => tmp,
    merge_mode_probe: {
      credential: { owner_handle: 'test-owner', source: 'fixture', load: async () => ({}) },
      hasGithubOrigin: async () => false,
      publisherAvailable: async () => ({ authenticated: true }),
    },
    resolveRalph: async () => false,
  })
})
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })

test('runtime enumeration covers every registered work_board tool with foreign and local controls', async () => {
  const tools = registry.list().filter(tool => tool.name.startsWith('work_board_'))
  const covered = new Set<string>()
  for (const tool of tools) {
    // Persisted before dispatch: old rows get the same scoped checks as new rows.
    const foreign = await store.create('foreign', { title: `${tool.name} wire the CSV export button to the endpoint with tests` })
    const local = await store.create('local', { title: foreign.title })
    const beforeForeign = store.list('foreign')
    if (tool.name === 'work_board_list') {
      const result = await tool.handler({}, context) as { items: Array<{ id: string }> }
      expect(result.items.some(item => item.id === local.id)).toBe(true)
      expect(result.items.some(item => item.id === foreign.id)).toBe(false)
    } else if (tool.name === 'work_board_add') {
      const result = await tool.handler({ title: 'local addition' }, context) as { ok: boolean; item: { project_slug: string } }
      expect(result.ok).toBe(true)
      expect(result.item.project_slug).toBe('local')
    } else {
      const args: Record<string, unknown> = {
        id: foreign.id, board_item_id: foreign.id, title: 'changed',
        task: foreign.title, reason: 'cancelled',
      }
      const beforeLocal = store.list('local')
      const refused = await tool.handler(args, context) as { ok: boolean; error: string }
      expect(refused.ok).toBe(false)
      expect(refused.error).toContain(foreign.id)
      expect(store.list('local')).toEqual(beforeLocal)
      const accepted = await tool.handler({ ...args, id: local.id, board_item_id: local.id }, context) as { ok: boolean }
      expect(accepted.ok).toBe(true)
    }
    expect(store.list('foreign')).toEqual(beforeForeign)
    covered.add(tool.name)
  }
  console.log('Executed work_board surface:', [...covered].join(', '))
  expect([...covered].sort()).toEqual([
    'work_board_add', 'work_board_complete', 'work_board_dispatch_build', 'work_board_list',
    'work_board_remove', 'work_board_reorder', 'work_board_start', 'work_board_update',
  ])
})

for (const field of ['id', 'before', 'after', 'precedes']) {
  test(`reorder refuses foreign ${field} loudly without changing either board`, async () => {
    const foreign = await store.create('foreign', { title: 'foreign card' })
    const local = await store.create('local', { title: 'local card' })
    const sibling = await store.create('local', { title: 'local sibling' })
    const snapshot = [store.list('local'), store.list('foreign')]
    const result = await registry.get('work_board_reorder')!.handler(
      { id: local.id, [field]: foreign.id }, context,
    ) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain(foreign.id)
    expect([store.list('local'), store.list('foreign')]).toEqual(snapshot)
    if (field === 'precedes') {
      await db.run("UPDATE work_board_items SET status = 'blocked' WHERE id = ?", [sibling.id])
    }
    const accepted = await registry.get('work_board_reorder')!.handler(
      { id: local.id, ...(field !== 'id' ? { [field]: sibling.id } : {}) }, context,
    ) as { ok: boolean }
    expect(accepted.ok).toBe(true)
  })
}

for (const name of ['work_board_update', 'work_board_complete', 'work_board_reorder', 'work_board_remove']) {
  test(`${name} refuses a genuinely missing ID`, async () => {
    const result = await registry.get(name)!.handler({ id: 'missing-card', reason: 'cancelled' }, context) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('missing-card')
  })
}

test('a failed scoped read remains an error rather than an empty board or success', async () => {
  store.get = () => { throw new Error('read unavailable') }
  await expect(registry.get('work_board_reorder')!.handler({ id: 'card' }, context)).rejects.toThrow('read unavailable')
})
