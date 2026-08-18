import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ToolRegistry, type ToolCallContext } from '@neutronai/tools/registry.ts'
import { GENERAL_WORK_BOARD_PROJECT_ID, WorkBoardStore, type WorkBoardItem } from './store.ts'
import { INLINE_EVIDENCE_WINDOW_MS, withDerivedInlineActive } from './inline-activity.ts'
import { WorkBoardRemovalService } from './removal.ts'
import {
  registerWorkBoardToolSurface,
  WORK_BOARD_ADD_TOOL,
  WORK_BOARD_COMPLETE_TOOL,
  WORK_BOARD_LIST_TOOL,
  WORK_BOARD_REMOVE_TOOL,
  WORK_BOARD_REORDER_TOOL,
  WORK_BOARD_UPDATE_TOOL,
} from './agent-tool.ts'

let tmp: string
let db: ProjectDb
let registry: ToolRegistry
let store: WorkBoardStore

function ctx(project_slug: string, project_id: string | null = null): ToolCallContext {
  return { project_slug, project_id, topic_id: null, call_id: 'c1', speaker_user_id: null }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-work-board-tool-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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

describe('work_board_* active-project scoping (P0: named-project builds must NOT land on General)', () => {
  test('add with an ACTIVE project_id scopes the item to that project, NOT the owner/General slug', async () => {
    const add = registry.get(WORK_BOARD_ADD_TOOL)!
    // The composing turn is for project "acme" (owner slug = "owner").
    const res = (await add.handler({ title: 'Ship kvlog' }, ctx('owner', 'acme'))) as {
      ok: boolean
      item?: { project_slug: string }
    }
    expect(res.ok).toBe(true)
    // Stored on acme's board (scope key = the project id), NOT General (owner).
    expect(res.item?.project_slug).toBe('acme')
    expect(store.list('acme').length).toBe(1)
    expect(store.list('owner').length).toBe(0)
  })

  test('add with NO active project (General) still scopes to the owner slug (regression guard)', async () => {
    const add = registry.get(WORK_BOARD_ADD_TOOL)!
    await add.handler({ title: 'General work' }, ctx('owner', null))
    // project_id === 'general' maps to General too.
    await add.handler({ title: 'Also general' }, ctx('owner', 'general'))
    expect(store.list('owner').length).toBe(2)
    expect(store.list('acme').length).toBe(0)
  })

  test('list under an active project returns ONLY that project’s board', async () => {
    await store.create('acme', { title: 'A' })
    await store.create('owner', { title: 'general-only' })
    const list = registry.get(WORK_BOARD_LIST_TOOL)!
    const acme = (await list.handler({}, ctx('owner', 'acme'))) as { items: unknown[] }
    const general = (await list.handler({}, ctx('owner', null))) as { items: unknown[] }
    expect(acme.items.length).toBe(1)
    expect(general.items.length).toBe(1)
  })

  test('update / complete key on the active project scope; a cross-scope write is a no-op', async () => {
    const add = registry.get(WORK_BOARD_ADD_TOOL)!
    const created = (await add.handler({ title: 'acme item' }, ctx('owner', 'acme'))) as {
      item: { id: string }
    }
    const id = created.item.id
    // Same-project update succeeds and returns the item…
    const update = registry.get(WORK_BOARD_UPDATE_TOOL)!
    const upd = (await update.handler({ id, status: 'in_progress' }, ctx('owner', 'acme'))) as {
      ok: boolean
      item?: { status: string }
    }
    expect(upd.item?.status).toBe('in_progress')
    // …but a General-scoped update for the SAME id cannot SEE it (different board):
    // the store finds no row in the owner/General scope, so it is a silent no-op
    // (ok, but no item) and acme's item is untouched.
    const crossScope = (await update.handler({ id, status: 'done' }, ctx('owner', null))) as {
      ok: boolean
      item?: { status: string }
    }
    expect(crossScope.item).toBeUndefined()
    expect(store.get('acme', id)?.status).toBe('in_progress')
    // Complete in acme scope works.
    const complete = registry.get(WORK_BOARD_COMPLETE_TOOL)!
    const done = (await complete.handler({ id }, ctx('owner', 'acme'))) as {
      ok: boolean
      item?: { status: string }
    }
    expect(done.item?.status).toBe('done')
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
    const seen: Array<{ title: string; docsProjectId: string; spec?: string }> = []
    // Minimal structural stand-in for WorkBoardSpecDocService.
    const specDoc = {
      createCardWithOptionalSpec: async (
        scope: string,
        docsProjectId: string,
        input: { title: string; spec?: string; status?: 'upcoming' | 'in_progress' | 'done'; design_doc_ref?: string | null },
      ) => {
        seen.push({
          title: input.title,
          docsProjectId,
          ...(input.spec !== undefined ? { spec: input.spec } : {}),
        })
        return store.create(scope, { title: input.title, design_doc_ref: 'neutron-docs:plans/x.md' })
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
    // THIS IS THE DEFECT, pinned. The context here has `project_id: null` — the
    // General scope — and the board scope key for General collapses to the OWNER
    // SLUG. Passing that same value to `writeDoc` is what created
    // `Projects/<owner-slug>/docs/plans/`, a phantom project directory the owner's
    // Documents tab (which reads `Projects/general/docs`) could never show.
    //
    // So the docs id must be `general`, not the owner slug, even though the board
    // row is still scoped the old way. Board scope and docs root are allowed to
    // differ; what is not allowed is one argument pretending to be both.
    expect(seen).toEqual([{ title: 'Wire it', docsProjectId: 'general', spec: 'a\nb\nc' }])
    expect(out.item?.design_doc_ref).toBe('neutron-docs:plans/x.md')
  })
})

describe('work_board chat-ack seam (#429 task 4)', () => {
  interface AckPost {
    project_id: string | null
    item_id: string
    title: string
    kind: string
  }
  function spyAck() {
    const posts: AckPost[] = []
    const ack = { post: (p: AckPost) => posts.push(p) }
    return { posts, ack: ack as unknown as import('./chat-ack.ts').WorkBoardChatAck }
  }

  test('a successful plain-store add posts card_added with the created item', async () => {
    const reg = new ToolRegistry()
    const { posts, ack } = spyAck()
    registerWorkBoardToolSurface(reg, store, { chatAck: ack })
    const out = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Ship it' },
      ctx('owner', 'acme'),
    )) as { ok: boolean; item: { id: string } }
    expect(out.ok).toBe(true)
    expect(posts).toEqual([
      { project_id: 'acme', item_id: out.item.id, title: 'Ship it', kind: 'card_added' },
    ])
  })

  test('a successful specDoc-branch add posts card_added', async () => {
    const reg = new ToolRegistry()
    const { posts, ack } = spyAck()
    const specDoc = {
      createCardWithOptionalSpec: async (scope: string, _docsProjectId: string, input: { title: string }) =>
        store.create(scope, { title: input.title }),
      resolveTaskForItem: async () => 'unused',
    }
    registerWorkBoardToolSurface(reg, store, {
      chatAck: ack,
      specDoc: specDoc as unknown as import('./spec-doc-service.ts').WorkBoardSpecDocService,
    })
    const out = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Docd item', spec: 'x\ny\nz' },
      ctx('owner', null),
    )) as { ok: boolean; item: { id: string } }
    expect(out.ok).toBe(true)
    expect(posts).toEqual([
      { project_id: null, item_id: out.item.id, title: 'Docd item', kind: 'card_added' },
    ])
  })

  test('a validation-failed add posts NOTHING', async () => {
    const reg = new ToolRegistry()
    const { posts, ack } = spyAck()
    registerWorkBoardToolSurface(reg, store, { chatAck: ack })
    const out = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'x', design_doc_ref: 'javascript:alert(1)' },
      ctx('owner'),
    )) as { ok: boolean }
    expect(out.ok).toBe(false)
    expect(posts).toEqual([])
  })

  test('an update flipping inline_active false→true posts inline_started', async () => {
    const reg = new ToolRegistry()
    const { posts, ack } = spyAck()
    registerWorkBoardToolSurface(reg, store, { chatAck: ack })
    const created = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Inline work' },
      ctx('owner', 'acme'),
    )) as { item: { id: string } }
    const id = created.item.id
    posts.length = 0 // drop the card_added post
    await reg.get(WORK_BOARD_UPDATE_TOOL)!.handler({ id, inline_active: true }, ctx('owner', 'acme'))
    expect(posts).toEqual([
      { project_id: 'acme', item_id: id, title: 'Inline work', kind: 'inline_started' },
    ])
  })

  test('an update setting inline_active true→true posts NOTHING (no transition)', async () => {
    const reg = new ToolRegistry()
    const { posts, ack } = spyAck()
    registerWorkBoardToolSurface(reg, store, { chatAck: ack })
    const created = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Inline work' },
      ctx('owner', 'acme'),
    )) as { item: { id: string } }
    const id = created.item.id
    await reg.get(WORK_BOARD_UPDATE_TOOL)!.handler({ id, inline_active: true }, ctx('owner', 'acme'))
    posts.length = 0
    // Already true → true: no flip, no post.
    await reg.get(WORK_BOARD_UPDATE_TOOL)!.handler({ id, inline_active: true }, ctx('owner', 'acme'))
    expect(posts).toEqual([])
  })

  test('an update WITHOUT inline_active in the patch posts NOTHING', async () => {
    const reg = new ToolRegistry()
    const { posts, ack } = spyAck()
    registerWorkBoardToolSurface(reg, store, { chatAck: ack })
    const created = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Some item' },
      ctx('owner', 'acme'),
    )) as { item: { id: string } }
    const id = created.item.id
    posts.length = 0
    await reg.get(WORK_BOARD_UPDATE_TOOL)!.handler({ id, status: 'in_progress' }, ctx('owner', 'acme'))
    expect(posts).toEqual([])
  })

  test('omitted chatAck opt → no throw, byte-identical behaviour', async () => {
    const reg = new ToolRegistry()
    registerWorkBoardToolSurface(reg, store)
    const out = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'No ack' },
      ctx('owner', 'acme'),
    )) as { ok: boolean; item?: { id: string } }
    expect(out.ok).toBe(true)
    expect(out.item?.id).toBeDefined()
  })
})

describe('work_board_list derived inline activity', () => {
  // Controllable evidence + clock: the real derivation, a stub reader. The dep is
  // BATCH (one evidence read per call) exactly like the composer's closure.
  let evidenceAt = 0
  let now = 1_000_000
  let seenProjectIds: string[] = []
  const dep = (items: WorkBoardItem[], project_id: string): WorkBoardItem[] => {
    seenProjectIds.push(project_id)
    return withDerivedInlineActive(items, { lastWriteActivityAt: () => evidenceAt }, project_id, now)
  }

  function wired(): ToolRegistry {
    const reg = new ToolRegistry()
    registerWorkBoardToolSurface(reg, store, { deriveInlineActive: dep })
    return reg
  }

  beforeEach(() => {
    evidenceAt = 0
    now = 1_000_000
    seenProjectIds = []
  })

  test('(a) fresh evidence activates a card with NO work_board_update in the path', async () => {
    const reg = wired()
    const created = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Inline edit', status: 'in_progress' },
      ctx('owner', 'acme'),
    )) as { item: { id: string; inline_active: boolean } }
    expect(created.item.inline_active).toBe(false)

    evidenceAt = now - 1
    const listed = (await reg.get(WORK_BOARD_LIST_TOOL)!.handler({}, ctx('owner', 'acme'))) as {
      items: { id: string; inline_active: boolean }[]
    }
    expect(listed.items.find((i) => i.id === created.item.id)!.inline_active).toBe(true)
    // The derivation NEVER writes: the stored row is still the false hint.
    expect(store.list('acme').find((i) => i.id === created.item.id)!.inline_active).toBe(false)
  })

  test('(b) a crashed session stale flag reads NOT active', async () => {
    const reg = wired()
    const created = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Died mid-work', status: 'in_progress' },
      ctx('owner', 'acme'),
    )) as { item: { id: string } }
    await store.update('acme', created.item.id, { inline_active: true })
    expect(store.list('acme')[0]!.inline_active).toBe(true)

    evidenceAt = 0
    const listed = (await reg.get(WORK_BOARD_LIST_TOOL)!.handler({}, ctx('owner', 'acme'))) as {
      items: { inline_active: boolean }[]
    }
    expect(listed.items[0]!.inline_active).toBe(false)
  })

  test('(c) the derivation cannot latch on — quiet means quiet', async () => {
    const reg = wired()
    await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Goes quiet', status: 'in_progress' },
      ctx('owner', 'acme'),
    )
    evidenceAt = now - 1
    const active = (await reg.get(WORK_BOARD_LIST_TOOL)!.handler({}, ctx('owner', 'acme'))) as {
      items: { inline_active: boolean }[]
    }
    expect(active.items[0]!.inline_active).toBe(true)

    now += INLINE_EVIDENCE_WINDOW_MS
    const quiet = (await reg.get(WORK_BOARD_LIST_TOOL)!.handler({}, ctx('owner', 'acme'))) as {
      items: { inline_active: boolean }[]
    }
    expect(quiet.items[0]!.inline_active).toBe(false)
  })

  test('an absent dep is a byte-identical raw stored-flag passthrough', async () => {
    // `registry` is the default beforeEach registration: NO deriveInlineActive.
    const created = (await registry.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Legacy box', status: 'in_progress' },
      ctx('owner', 'acme'),
    )) as { item: { id: string } }
    await store.update('acme', created.item.id, { inline_active: true })
    const listed = (await registry.get(WORK_BOARD_LIST_TOOL)!.handler({}, ctx('owner', 'acme'))) as {
      items: { inline_active: boolean }[]
    }
    expect(listed.items[0]!.inline_active).toBe(true)
  })

  test('a General turn feeds the dep the General project id (inspector scope)', async () => {
    const reg = wired()
    await reg.get(WORK_BOARD_ADD_TOOL)!.handler({ title: 'General card' }, ctx('owner', null))
    await reg.get(WORK_BOARD_LIST_TOOL)!.handler({}, ctx('owner', null))
    expect(seenProjectIds).toEqual([GENERAL_WORK_BOARD_PROJECT_ID])
  })

  test('(d) the derivation gates NOTHING — an inline_active update still succeeds', async () => {
    const reg = wired()
    const created = (await reg.get(WORK_BOARD_ADD_TOOL)!.handler(
      { title: 'Still writable' },
      ctx('owner', 'acme'),
    )) as { item: { id: string } }
    const out = (await reg.get(WORK_BOARD_UPDATE_TOOL)!.handler(
      { id: created.item.id, inline_active: true },
      ctx('owner', 'acme'),
    )) as { ok: boolean }
    expect(out.ok).toBe(true)
  })
})

describe('work_board_remove', () => {
  interface RemoveHarness {
    reg: ToolRegistry
    names: string[]
    events: string[]
    moves: Array<{ project_id: string; from: string; to: string }>
    deletedDocs: Array<{ project_id: string; path: string }>
  }

  /**
   * A registry with the removal chokepoint wired — a REAL `WorkBoardRemovalService`
   * over the SAME store the other tools use, with structural stubs recording into
   * ONE shared `events` array (the ordering pin). `store.delete` is wrapped rather
   * than faked, so the sequence is observed against the REAL row delete.
   */
  function withRemoval(): RemoveHarness {
    const reg = new ToolRegistry()
    const events: string[] = []
    const moves: Array<{ project_id: string; from: string; to: string }> = []
    const deletedDocs: Array<{ project_id: string; path: string }> = []
    const removal = new WorkBoardRemovalService({
      store: {
        get: (scope, id) => store.get(scope, id),
        delete: async (scope, id) => {
          events.push('delete')
          await store.delete(scope, id)
        },
      },
      trident_runs: {
        get: () => ({ phase: 'forge' }),
        update: async () => null,
        terminate: async () => {
          events.push('terminate')
          return { won: true }
        },
      },
      is_terminal_phase: () => false,
      docs: {
        moveDoc: async (project_id, from, to) => {
          events.push('moveDoc')
          moves.push({ project_id, from, to })
          return null
        },
        deleteDoc: async (project_id, path) => {
          events.push('deleteDoc')
          deletedDocs.push({ project_id, path })
          return null
        },
      },
    })
    const names = registerWorkBoardToolSurface(reg, store, { removal })
    return { reg, names, events, moves, deletedDocs }
  }

  test('registers only when a removal chokepoint is wired', () => {
    // The default beforeEach registry has no `removal` — legacy boots unchanged.
    expect(registry.get(WORK_BOARD_REMOVE_TOOL)).toBeUndefined()

    const h = withRemoval()
    const tool = h.reg.get(WORK_BOARD_REMOVE_TOOL)
    expect(tool).toBeDefined()
    expect(tool!.approval_policy).toBe('auto')
    expect(tool!.capability_required).toBe('write:project_data')
    const schema = tool!.input_schema as {
      properties: Record<string, { enum?: string[] }>
      required: string[]
    }
    expect(schema.required).toEqual(['id', 'reason'])
    expect(schema.properties.reason!.enum).toEqual(['shipped', 'cancelled', 'moved'])
    expect(Object.keys(schema.properties)).not.toContain('project_slug')
    expect(schema.properties.delete_plan_doc).toBeDefined()
    expect(h.names).toContain(WORK_BOARD_REMOVE_TOOL)
  })

  test('the five legacy tools register unchanged when `removal` is absent', () => {
    const reg = new ToolRegistry()
    const names = registerWorkBoardToolSurface(reg, store)
    expect(names).toEqual([
      WORK_BOARD_LIST_TOOL,
      WORK_BOARD_ADD_TOOL,
      WORK_BOARD_UPDATE_TOOL,
      WORK_BOARD_COMPLETE_TOOL,
      WORK_BOARD_REORDER_TOOL,
    ])
    expect(reg.get(WORK_BOARD_REMOVE_TOOL)).toBeUndefined()
  })

  test('removing a card with a LIVE bound run CANCELS the run before the row delete', async () => {
    // The acceptance's named test (guard against a fake test): the card HAS a
    // live run, and the assertion is the ORDERED event sequence through the AGENT
    // surface. Two mutants go RED: skipping cancellation (no 'terminate') and
    // deleting first (['delete','terminate']).
    const h = withRemoval()
    const item = await store.create('owner', { title: 'live build' })
    await store.bindRun('owner', item.id, 'run-9')

    const res = (await h.reg.get(WORK_BOARD_REMOVE_TOOL)!.handler(
      { id: item.id, reason: 'cancelled' },
      ctx('owner'),
    )) as { ok: boolean; cancelled_run?: string }

    expect(res.ok).toBe(true)
    expect(res.cancelled_run).toBe('run-9')
    expect(h.events).toContain('terminate')
    expect(h.events).toContain('delete')
    expect(h.events.indexOf('terminate')).toBeLessThan(h.events.indexOf('delete'))
  })

  test("the plan doc is MOVED to a folder named for the reason (docs id ≠ board scope)", async () => {
    const h = withRemoval()
    const item = await store.create('owner', {
      title: 'has a spec',
      design_doc_ref: 'neutron-docs:plans/has-a-spec-abc123.md',
    })

    const res = (await h.reg.get(WORK_BOARD_REMOVE_TOOL)!.handler(
      { id: item.id, reason: 'moved' },
      ctx('owner'),
    )) as { ok: boolean; plan_doc?: { path: string; disposition: string; to?: string } }

    expect(res.ok).toBe(true)
    expect(res.plan_doc?.disposition).toBe('moved')
    expect(res.plan_doc?.to).toBe('plans/moved/has-a-spec-abc123.md')
    // The BOARD keyed on the owner slug; the DOCS id is `general` — the
    // conflation hazard from spec-doc-service.ts, pinned on the removal path too.
    expect(h.moves).toEqual([
      {
        project_id: GENERAL_WORK_BOARD_PROJECT_ID,
        from: 'plans/has-a-spec-abc123.md',
        to: 'plans/moved/has-a-spec-abc123.md',
      },
    ])
    expect(h.deletedDocs).toEqual([])
  })

  test('delete_plan_doc:true is the ONLY tool input that destroys the doc', async () => {
    const h = withRemoval()
    const doomed = await store.create('owner', {
      title: 'destroy the doc',
      design_doc_ref: 'neutron-docs:plans/doomed-abc123.md',
    })

    const res = (await h.reg.get(WORK_BOARD_REMOVE_TOOL)!.handler(
      { id: doomed.id, reason: 'cancelled', delete_plan_doc: true },
      ctx('owner'),
    )) as { ok: boolean; plan_doc?: { disposition: string } }

    expect(res.plan_doc?.disposition).toBe('deleted')
    expect(h.deletedDocs).toEqual([
      { project_id: GENERAL_WORK_BOARD_PROJECT_ID, path: 'plans/doomed-abc123.md' },
    ])
    expect(h.moves).toEqual([])
  })

  test('WITHOUT the flag, no reason ever destroys a doc', async () => {
    for (const reason of ['shipped', 'cancelled', 'moved']) {
      const h = withRemoval()
      const item = await store.create('owner', {
        title: `card ${reason}`,
        design_doc_ref: `neutron-docs:plans/card-${reason}.md`,
      })
      const res = (await h.reg.get(WORK_BOARD_REMOVE_TOOL)!.handler(
        { id: item.id, reason },
        ctx('owner'),
      )) as { ok: boolean; plan_doc?: { disposition: string; to?: string } }
      expect(res.plan_doc?.disposition).toBe('moved')
      expect(res.plan_doc?.to).toBe(`plans/${reason}/card-${reason}.md`)
      expect(h.deletedDocs).toEqual([])
    }
  })

  test('the removed card is REALLY gone from a subsequent work_board_list', async () => {
    const h = withRemoval()
    const doomed = await store.create('owner', { title: 'remove me' })
    const survivor = await store.create('owner', { title: 'keep me' })

    const res = (await h.reg.get(WORK_BOARD_REMOVE_TOOL)!.handler(
      { id: doomed.id, reason: 'shipped' },
      ctx('owner'),
    )) as { ok: boolean }
    expect(res.ok).toBe(true)

    const listed = (await h.reg.get(WORK_BOARD_LIST_TOOL)!.handler({}, ctx('owner'))) as {
      items: Array<{ id: string }>
    }
    expect(listed.items.map((i) => i.id)).toEqual([survivor.id])
  })

  test('bad input is an ANSWER, not a throw: unknown id / bad reason / missing reason', async () => {
    const h = withRemoval()
    const remove = h.reg.get(WORK_BOARD_REMOVE_TOOL)!
    const item = await store.create('owner', { title: 'still here' })

    const unknown = (await remove.handler({ id: 'nope-1', reason: 'cancelled' }, ctx('owner'))) as {
      ok: boolean
      error?: string
    }
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('nope-1')

    const badReason = (await remove.handler({ id: item.id, reason: 'archived' }, ctx('owner'))) as {
      ok: boolean
      error?: string
    }
    expect(badReason.ok).toBe(false)

    const noReason = (await remove.handler({ id: item.id }, ctx('owner'))) as {
      ok: boolean
      error?: string
    }
    expect(noReason.ok).toBe(false)

    const noId = (await remove.handler({ reason: 'cancelled' }, ctx('owner'))) as { ok: boolean }
    expect(noId.ok).toBe(false)

    // Nothing was removed, and no doc/run side effect fired.
    expect(store.get('owner', item.id)).not.toBeNull()
    expect(h.events).toEqual([])
  })
})

/**
 * The SHELVED lane on the AGENT surface (migration 0130). This is the lever that
 * exists so the agent asked to take four deprioritised cards off the board no
 * longer has to mark them `done` — the misreport of 2026-08-14.
 */
describe('work_board_update — the SHELVED lane (status=archived)', () => {
  test("the schemas advertise 'archived' but NEVER 'failed'", () => {
    for (const name of [WORK_BOARD_ADD_TOOL, WORK_BOARD_UPDATE_TOOL]) {
      const schema = registry.get(name)!.input_schema as {
        properties: { status: { enum: string[]; description: string } }
      }
      expect(schema.properties.status.enum).toContain('archived')
      // 'failed' is run-driven (terminal reconcile only) — not client-writable.
      expect(schema.properties.status.enum).not.toContain('failed')
      // The model is told archived ≠ shipped.
      expect(schema.properties.status.description).toContain('archived')
    }
  })

  test("status:'archived' shelves the card — and work_board_list shows it NOT done", async () => {
    const add = registry.get(WORK_BOARD_ADD_TOOL)!
    const update = registry.get(WORK_BOARD_UPDATE_TOOL)!
    const created = (await add.handler({ title: 'deprioritised email card' }, ctx('owner'))) as {
      item: { id: string }
    }
    const id = created.item.id

    const res = (await update.handler({ id, status: 'archived' }, ctx('owner'))) as {
      ok: boolean
      item?: { status: string; completed_at: string | null }
    }
    expect(res.ok).toBe(true)
    expect(res.item?.status).toBe('archived')
    // Acceptance (b): it is counted as completed NOWHERE.
    expect(res.item?.completed_at).toBeNull()

    const listed = (await registry.get(WORK_BOARD_LIST_TOOL)!.handler({}, ctx('owner'))) as {
      items: Array<{ id: string; status: string; completed_at: string | null }>
    }
    const row = listed.items.find((i) => i.id === id)
    expect(row).toBeDefined()
    expect(row!.status).toBe('archived')
    expect(listed.items.filter((i) => i.status === 'done')).toEqual([])
  })

  test('shelving a card whose build is LIVE is a REFUSAL result, not a throw', async () => {
    const reg = new ToolRegistry()
    const liveStore = new WorkBoardStore(db, { isRunLive: () => true })
    registerWorkBoardToolSurface(reg, liveStore)
    const item = await liveStore.create('owner', { title: 'building right now' })
    await liveStore.attachRun('owner', item.id, 'run-live')

    const res = (await reg.get(WORK_BOARD_UPDATE_TOOL)!.handler(
      { id: item.id, status: 'archived' },
      ctx('owner'),
    )) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('run-live')
    expect(res.error).toContain('still running')
    // Nothing was written.
    expect(liveStore.get('owner', item.id)?.status).toBe('in_progress')
  })
})
