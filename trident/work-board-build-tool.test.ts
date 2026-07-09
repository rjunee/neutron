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
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { TridentRunStore } from './store.ts'
import type { TridentBoardBinder } from './board-dispatch.ts'
import {
  registerTridentBuildToolSurface,
  WORK_BOARD_DISPATCH_BUILD_TOOL,
  WORK_BOARD_START_TOOL,
} from './work-board-build-tool.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore
let attached: Array<{ id: string; run_id: string }>
// A `linked_run_id` the board stub reports for the 'running' item (set by a test
// that binds a live run to exercise the already-running guard).
let runningRunId: string | null

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-wb-build-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
  attached = []
  runningRunId = null
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
          : id === 'running'
            ? {
                id: 'running',
                title: 'a card with a live build already bound to it and running',
                design_doc_ref: null,
                linked_run_id: runningRunId,
              }
            : null,
    attachRun: async (_slug, id, run_id) => {
      attached.push({ id, run_id })
    },
  }
}

const ctx = { project_slug: 'proj-1', project_id: null, topic_id: null, call_id: 'c1', speaker_user_id: null }

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

  test('#339 — resolve_delivery stamps the originating chat topic (from ctx.project_id) onto the run', async () => {
    const reg = new ToolRegistry()
    registerTridentBuildToolSurface(reg, {
      store,
      work_board: board(),
      repo_path: '/repo',
      resolveBuildRepo: async (home) => home,
      resolveMergeMode: async () => 'local',
      resolveRalph: async () => false,
      resolve_delivery: (projectId) => ({
        chat_id: projectId !== null ? `app:owner:${projectId}` : 'app:owner',
        thread_id: null,
      }),
    })
    const tool = reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!
    const out = (await tool.handler(
      { board_item_id: 'ready', task: 'build the export' },
      { ...ctx, project_id: 'p9' },
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    const run = store.get(out.run_id as string)!
    // The run now carries a chat topic → terminal delivery can announce back here.
    expect(run.chat_id).toBe('app:owner:p9')
    expect(run.thread_id).toBeNull()
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

describe('active-project scoping (P0: a named-project build lands on that project’s board)', () => {
  // A board stub that RECORDS the scope key it is asked for, so we can assert the
  // dispatch keyed on the active project — not the owner/General slug.
  function recordingBoard(seen: { getSlugs: string[]; attachSlugs: string[] }): TridentBoardBinder {
    return {
      get: (slug, id) => {
        seen.getSlugs.push(slug)
        return id === 'ready'
          ? { id: 'ready', title: 'wire the CSV export button to the new endpoint with tests', design_doc_ref: null }
          : null
      },
      attachRun: async (slug, id, run_id) => {
        seen.attachSlugs.push(slug)
        attached.push({ id, run_id })
      },
    }
  }

  function dispatchToolWith(board_stub: TridentBoardBinder) {
    const reg = new ToolRegistry()
    registerTridentBuildToolSurface(reg, {
      store,
      work_board: board_stub,
      repo_path: '/repo',
      resolveBuildRepo: async (home) => home,
      resolveMergeMode: async () => 'local',
      resolveRalph: async () => false,
    })
    return reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!
  }

  test('work_board_dispatch_build in project "acme" scopes the run + binding to acme, NOT the owner slug', async () => {
    const seen = { getSlugs: [] as string[], attachSlugs: [] as string[] }
    const tool = dispatchToolWith(recordingBoard(seen))
    const acmeCtx = { project_slug: 'proj-1', project_id: 'acme', topic_id: null, call_id: 'c1', speaker_user_id: null }
    const out = (await tool.handler({ board_item_id: 'ready', task: 'build kvlog' }, acmeCtx)) as Record<string, unknown>
    expect(out.ok).toBe(true)
    // The board lookup + the run binding both keyed on the ACTIVE project scope.
    expect(seen.getSlugs).toEqual(['acme'])
    expect(seen.attachSlugs).toEqual(['acme'])
    // And the persisted run row is scoped to acme (not the owner/General slug).
    const run = store.get(out.run_id as string)!
    expect(run.project_slug).toBe('acme')
  })

  test('work_board_dispatch_build with NO active project (General) scopes to the owner slug (regression guard)', async () => {
    const seen = { getSlugs: [] as string[], attachSlugs: [] as string[] }
    const tool = dispatchToolWith(recordingBoard(seen))
    // project_id null → General → the owner/instance slug (proj-1), the prior behaviour.
    const out = (await tool.handler({ board_item_id: 'ready', task: 'build' }, ctx)) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(seen.getSlugs).toEqual(['proj-1'])
    expect(seen.attachSlugs).toEqual(['proj-1'])
    expect(store.get(out.run_id as string)!.project_slug).toBe('proj-1')
  })

  test('work_board_start in project "acme" resolves the spec + run under acme', async () => {
    const seen = { getSlugs: [] as string[], attachSlugs: [] as string[] }
    const reg = new ToolRegistry()
    const resolveSlugs: string[] = []
    registerTridentBuildToolSurface(reg, {
      store,
      work_board: recordingBoard(seen),
      repo_path: '/repo',
      resolveBuildRepo: async (home) => home,
      resolveMergeMode: async () => 'local',
      resolveRalph: async () => false,
      resolve_task: async (slug) => {
        resolveSlugs.push(slug)
        return 'resolved spec for acme'
      },
    })
    const start = reg.get(WORK_BOARD_START_TOOL)!
    const acmeCtx = { project_slug: 'proj-1', project_id: 'acme', topic_id: null, call_id: 'c1', speaker_user_id: null }
    const out = (await start.handler({ board_item_id: 'ready' }, acmeCtx)) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(seen.getSlugs).toContain('acme')
    expect(resolveSlugs).toEqual(['acme'])
    expect(store.get(out.run_id as string)!.project_slug).toBe('acme')
  })
})

function startToolFor(resolve_task?: (slug: string, item: { title: string; design_doc_ref: string | null }) => Promise<string>) {
  const reg = new ToolRegistry()
  registerTridentBuildToolSurface(reg, {
    store,
    work_board: board(),
    repo_path: '/repo',
    // Identity workspace resolver — keep repo_path as-is, no real fs/git in unit tests.
    resolveBuildRepo: async (home) => home,
    resolveMergeMode: async () => 'local',
    resolveRalph: async () => false,
    ...(resolve_task !== undefined ? { resolve_task } : {}),
  })
  return reg.get(WORK_BOARD_START_TOOL)!
}

describe('work_board_start tool (▶ agent-native parity)', () => {
  test('registers with dispatch capability + only board_item_id required', () => {
    const tool = startToolFor()
    expect(tool.capability_required).toBe('agent:dispatch_subagent')
    expect(tool.approval_policy).toBe('prompt-user')
    expect(tool.input_schema.required).toEqual(['board_item_id'])
  })

  test('starts a ready item using its title (no resolve_task wired)', async () => {
    const out = (await startToolFor().handler({ board_item_id: 'ready' }, ctx)) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(out.board_item_id).toBe('ready')
    const run = store.get(out.run_id as string)!
    // Falls back to the item title as the task.
    expect(run.task).toContain('wire the CSV export button')
    expect(attached).toEqual([{ id: 'ready', run_id: out.run_id as string }])
  })

  test('resolve_task supplies the saved spec as the task', async () => {
    const out = (await startToolFor(async () => 'THE FULL SAVED SPEC').handler(
      { board_item_id: 'ready' },
      ctx,
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    const run = store.get(out.run_id as string)!
    expect(run.task).toBe('THE FULL SAVED SPEC')
  })

  test('an unknown item is rejected with no run', async () => {
    const out = (await startToolFor().handler({ board_item_id: 'nope' }, ctx)) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('nope')
    expect(attached.length).toBe(0)
  })

  test('ask-before-acting: a doc-less, thin item is blocked', async () => {
    const out = (await startToolFor().handler({ board_item_id: 'terse' }, ctx)) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error).toLowerCase()).toContain('underspecified')
    expect(attached.length).toBe(0)
  })

  test('missing board_item_id is rejected', async () => {
    const out = (await startToolFor().handler({}, ctx)) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('board_item_id')
  })

  test('BLOCKS a card that already has a LIVE run — no second run, no orphan (Codex [P1])', async () => {
    // Bind a live (non-terminal) run to the 'running' item.
    const live = await store.create({
      slug: 'live-build',
      project_slug: 'proj-1',
      repo_path: '/repo',
      task: 'the in-flight build',
      merge_mode: 'local',
      ralph: false,
      branch: 'trident/live-build',
    })
    runningRunId = live.id
    expect(isTerminalPhaseCheck(live.id)).toBe(false)

    const out = (await startToolFor().handler({ board_item_id: 'running' }, ctx)) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error).toLowerCase()).toContain('already has a live build')
    // No SECOND run created, no re-bind that would orphan the first.
    expect(attached.length).toBe(0)
    expect(store.listNonTerminal().length).toBe(1) // only the original live run
  })

  test('ALLOWS retry when the linked run is TERMINAL (failed/stopped)', async () => {
    const dead = await store.create({
      slug: 'dead-build',
      project_slug: 'proj-1',
      repo_path: '/repo',
      task: 'a build that failed',
      merge_mode: 'local',
      ralph: false,
      branch: 'trident/dead-build',
    })
    await store.update(dead.id, { phase: 'failed' })
    runningRunId = dead.id
    const out = (await startToolFor().handler({ board_item_id: 'running' }, ctx)) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(attached).toEqual([{ id: 'running', run_id: out.run_id as string }])
  })
})

/** Helper: is the run with `id` in a terminal phase? (false while forge-init.) */
function isTerminalPhaseCheck(id: string): boolean {
  const run = store.get(id)
  return run !== null && ['done', 'failed', 'stopped'].includes(run.phase)
}
