/**
 * Phase 2b — the agent-native `work_board_dispatch_build` tool.
 *
 * Proves the orchestrator's handle on the trident loop enforces the board
 * chokepoint (required item + ask-gate), creates a `code_trident_runs` row, and
 * binds it to the Plan item — sharing the SAME `dispatchBoardBoundBuild` core as
 * `/code`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { TridentRunStore } from './store.ts'
import type { TridentBoardBinder } from './board-dispatch.ts'
import { registerTridentBuildToolSurface, WORK_BOARD_DISPATCH_BUILD_TOOL } from './work-board-build-tool.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore
let attached: Array<{ id: string; run_id: string }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-wb-build-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
  attached = []
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function board(): TridentBoardBinder {
  return {
    get: (_slug, id) =>
      id === 'ready'
        ? { id: 'ready', title: 'wire the CSV export button to the new endpoint with tests', design_doc_ref: null }
        : id === 'terse'
          ? { id: 'terse', title: 'auth', design_doc_ref: null }
          : null,
    attachRun: async (_slug, id, run_id) => {
      attached.push({ id, run_id })
    },
  }
}

const ctx = { project_slug: 'proj-1', topic_id: null, call_id: 'c1', speaker_user_id: null }

function toolFor() {
  const reg = new ToolRegistry()
  registerTridentBuildToolSurface(reg, {
    store,
    work_board: board(),
    repo_path: '/repo',
    // Identity workspace resolver — keep repo_path as-is, no real fs/git in unit tests.
    resolveBuildRepo: async (home) => home,
    resolveMergeMode: async () => 'local',
    resolveRalph: async () => false,
  })
  return reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!
}

describe('work_board_dispatch_build tool', () => {
  test('registers with the dispatch capability + prompt-user approval + required fields', () => {
    const reg = new ToolRegistry()
    registerTridentBuildToolSurface(reg, {
      store,
      work_board: board(),
      repo_path: '/repo',
    })
    const tool = reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!
    expect(tool.capability_required).toBe('agent:dispatch_subagent')
    expect(tool.approval_policy).toBe('prompt-user')
    expect(tool.input_schema.required).toEqual(['board_item_id', 'task'])
  })

  test('a ready item creates a bound run', async () => {
    const out = (await toolFor().handler(
      { board_item_id: 'ready', task: 'build the export' },
      ctx,
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(typeof out.run_id).toBe('string')
    expect(out.board_item_id).toBe('ready')
    const run = store.get(out.run_id as string)!
    expect(run.phase).toBe('forge-init')
    expect(run.task).toBe('build the export')
    expect(attached).toEqual([{ id: 'ready', run_id: out.run_id as string }])
  })

  test('an unknown item is rejected with no run created', async () => {
    const out = (await toolFor().handler({ board_item_id: 'nope', task: 'x' }, ctx)) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('nope')
    expect(store.listNonTerminal().length).toBe(0)
    expect(attached.length).toBe(0)
  })

  test('ask-before-acting: an underspecified item BLOCKS the build (no run)', async () => {
    const out = (await toolFor().handler({ board_item_id: 'terse', task: 'do auth' }, ctx)) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error).toLowerCase()).toContain('underspecified')
    expect(store.listNonTerminal().length).toBe(0)
    expect(attached.length).toBe(0)
  })

  test('an empty task is rejected', async () => {
    const out = (await toolFor().handler({ board_item_id: 'ready', task: '   ' }, ctx)) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('task')
  })
})
