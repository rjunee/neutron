/**
 * Phase 2b — the agent-native `work_board_dispatch_build` tool.
 *
 * Proves the orchestrator's handle on the trident loop enforces the board
 * chokepoint (required item + ask-gate), creates a `code_trident_runs` row, and
 * binds it to the Plan item — sharing the SAME `dispatchBoardBoundBuild` core as
 * `/code`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { TridentRunStore } from './store.ts'
import type { TridentBoardBinder } from './board-dispatch.ts'
import {
  registerTridentBuildToolSurface,
  WORK_BOARD_DISPATCH_BUILD_TOOL,
  WORK_BOARD_START_TOOL,
} from './work-board-build-tool.ts'
import type { EnvCapableHostRunner, GitModeProbe } from './git-mode.ts'
import { makeCredentialedHostRunner } from './git-mode.ts'
import { slugifyTask } from './slugify-task.ts'

/**
 * A merge-mode probe that never shells out. `hasGithubOrigin: false` short-
 * circuits `detectMergeMode` to 'local' before it ever consults the credential,
 * which is what these tests want and what a local project genuinely is.
 *
 * It carries a `credential` because every probe must: the whole point of the
 * seam taking a probe rather than a bare resolver is that WHOSE credential is in
 * play is always visible, and inspectable by identity rather than by label.
 */
function localProbe(): GitModeProbe {
  return {
    credential: {
      owner_handle: 'test-owner',
      source: 'test stub',
      load: async () => ({}),
    },
    hasGithubOrigin: async () => false,
    publisherAvailable: async () => ({ authenticated: true }),
  }
}

function prProbe(): GitModeProbe {
  const probe = localProbe()
  return {
    ...probe,
    hasGithubOrigin: async () => true,
  }
}

let tmp: string
let db: ProjectDb
let store: TridentRunStore
let attached: Array<{ id: string; run_id: string }>
// A `linked_run_id` the board stub reports for the 'running' item (set by a test
// that binds a live run to exercise the already-running guard).
let runningRunId: string | null

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-wb-build-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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
    merge_mode_probe: localProbe(),
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
      merge_mode_probe: localProbe(),
    })
    const tool = reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!
    expect(tool.capability_required).toBe('agent:dispatch_subagent')
    expect(tool.approval_policy).toBe('prompt-user')
    expect(tool.input_schema.required).toEqual(['board_item_id', 'task'])
  })

  test('the tool advertises bound_pr and passes it through', async () => {
    let createInput: Parameters<TridentRunStore['create']>[0] | null = null
    const originalCreate = store.create.bind(store)
    store.create = async (input) => {
      createInput = input
      return originalCreate(input)
    }
    const tool = toolFor()

    expect((tool.input_schema.properties as Record<string, unknown> | undefined)?.bound_pr).toBeDefined()
    expect(tool.input_schema.required).not.toContain('bound_pr')
    const out = (await tool.handler(
      { board_item_id: 'ready', task: 'review PR #524', bound_pr: 524 },
      ctx,
    )) as Record<string, unknown>

    expect(out.ok).toBe(true)
    expect(createInput).not.toBeNull()
    expect(createInput!.bound_pr).toBe(524)
  })

  test('the tool surfaces the review refusal', async () => {
    const out = (await toolFor().handler(
      { board_item_id: 'ready', task: 'run a review round on PR #515' },
      ctx,
    )) as Record<string, unknown>

    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('bound_pr')
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

  test('RT1 (tool): no resolveRalph override + a root SPEC.md → persisted ralph=true', async () => {
    // The agent-native production path (`work_board_dispatch_build`) shares the
    // `dispatchBoardBoundBuild` core with `/code` and does NOT supply
    // `resolveRalph` in production, so the K10 flip must engage here too. Point
    // repo_path at a dir WITH a root SPEC.md and omit the override.
    const specDir = mkdtempSync(join(tmpdir(), 'neutron-wb-build-spec-'))
    writeFileSync(join(specDir, 'SPEC.md'), '# spec\n')
    try {
      const reg = new ToolRegistry()
      registerTridentBuildToolSurface(reg, {
        store,
        work_board: board(),
        repo_path: specDir,
        resolveBuildRepo: async (home) => home, // identity — repo_path stays specDir
        merge_mode_probe: localProbe(),
        // resolveRalph deliberately OMITTED — exercises the detectRalphMode default.
      })
      const out = (await reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!.handler(
        { board_item_id: 'ready', task: 'build the export' },
        ctx,
      )) as Record<string, unknown>
      expect(out.ok).toBe(true)
      expect(store.get(out.run_id as string)!.ralph).toBe(true)
    } finally {
      rmSync(specDir, { recursive: true, force: true })
    }
  })

  test('RT1 (tool): no resolveRalph override + NO root SPEC.md → persisted ralph=false', async () => {
    // The ungoverned boundary of the same agent-native path: no override + no
    // SPEC.md stays legacy. A regression that force-injected `resolveRalph:
    // false` in the tool adapter would fail the positive test above; one that
    // force-enabled Ralph would fail this. Together they pin the SPEC.md gate.
    const noSpecDir = mkdtempSync(join(tmpdir(), 'neutron-wb-build-nospec-'))
    try {
      const reg = new ToolRegistry()
      registerTridentBuildToolSurface(reg, {
        store,
        work_board: board(),
        repo_path: noSpecDir,
        resolveBuildRepo: async (home) => home,
        merge_mode_probe: localProbe(),
        // resolveRalph deliberately OMITTED; no SPEC.md on disk.
      })
      const out = (await reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!.handler(
        { board_item_id: 'ready', task: 'build the export' },
        ctx,
      )) as Record<string, unknown>
      expect(out.ok).toBe(true)
      expect(store.get(out.run_id as string)!.ralph).toBe(false)
    } finally {
      rmSync(noSpecDir, { recursive: true, force: true })
    }
  })

  test('#339 — resolve_delivery stamps the originating chat topic (from ctx.project_id) onto the run', async () => {
    const reg = new ToolRegistry()
    registerTridentBuildToolSurface(reg, {
      store,
      work_board: board(),
      repo_path: '/repo',
      resolveBuildRepo: async (home) => home,
      merge_mode_probe: localProbe(),
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

  test('an already-landed rejection preserves the chokepoint message', async () => {
    const reg = new ToolRegistry()
    registerTridentBuildToolSurface(reg, {
      store,
      work_board: board(),
      repo_path: '/repo',
      resolveBuildRepo: async (home) => home,
      merge_mode_probe: prProbe(),
      resolveRalph: async () => false,
      landed_probe: async () => ({
        pr: 336,
        merged_at: null,
        head_on_base: null,
        base: 'main',
      }),
    })
    const out = (await reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!.handler(
      { board_item_id: 'ready', task: 'build the export' },
      ctx,
    )) as Record<string, unknown>

    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('already merged as #336')
    expect(String(out.error)).toContain('verify the card instead of rebuilding')
    expect(store.listNonTerminal()).toEqual([])
    expect(attached).toEqual([])
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
      merge_mode_probe: localProbe(),
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
      merge_mode_probe: localProbe(),
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
    merge_mode_probe: localProbe(),
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

describe('chat-ack seam (#429 task 4)', () => {
  interface AckPost {
    project_id: string | null
    item_id: string
    title: string
    kind: string
  }
  function spyAck() {
    const posts: AckPost[] = []
    const ack = { post: (p: AckPost) => posts.push(p) }
    return { posts, ack: ack as unknown as import('@neutronai/work-board/chat-ack.ts').WorkBoardChatAck }
  }
  function surface(chat_ack: import('@neutronai/work-board/chat-ack.ts').WorkBoardChatAck) {
    const reg = new ToolRegistry()
    registerTridentBuildToolSurface(reg, {
      store,
      work_board: board(),
      repo_path: '/repo',
      resolveBuildRepo: async (home) => home,
      merge_mode_probe: localProbe(),
      resolveRalph: async () => false,
      chat_ack,
    })
    return reg
  }

  test('a successful dispatch_build posts build_dispatched with the bound item title', async () => {
    const { posts, ack } = spyAck()
    const reg = surface(ack)
    const out = (await reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!.handler(
      { board_item_id: 'ready', task: 'build the export' },
      { ...ctx, project_id: 'acme' },
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(posts).toEqual([
      {
        project_id: 'acme',
        item_id: 'ready',
        title: 'wire the CSV export button to the new endpoint with tests',
        kind: 'build_dispatched',
      },
    ])
  })

  test('a REJECTED (underspecified) dispatch posts NOTHING', async () => {
    const { posts, ack } = spyAck()
    const reg = surface(ack)
    const out = (await reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!.handler(
      { board_item_id: 'terse', task: 'do auth' },
      ctx,
    )) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(posts).toEqual([])
  })

  test('an unknown item posts NOTHING', async () => {
    const { posts, ack } = spyAck()
    const reg = surface(ack)
    const out = (await reg.get(WORK_BOARD_DISPATCH_BUILD_TOOL)!.handler(
      { board_item_id: 'nope', task: 'x' },
      ctx,
    )) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(posts).toEqual([])
  })

  test('a successful work_board_start posts build_dispatched with the item title', async () => {
    const { posts, ack } = spyAck()
    const reg = surface(ack)
    const out = (await reg.get(WORK_BOARD_START_TOOL)!.handler(
      { board_item_id: 'ready' },
      { ...ctx, project_id: 'acme' },
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(posts).toEqual([
      {
        project_id: 'acme',
        item_id: 'ready',
        title: 'wire the CSV export button to the new endpoint with tests',
        kind: 'build_dispatched',
      },
    ])
  })

  test('omitted chat_ack → unchanged behaviour, no throw', async () => {
    const out = (await toolFor().handler(
      { board_item_id: 'ready', task: 'build the export' },
      ctx,
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
  })
})

/**
 * THE CREDENTIAL MUST REACH THE SEED PROBE FROM EVERY TOOL ENTRY, NOT JUST ONE.
 *
 * Argus r17 blocker: `work_board_dispatch_build` spread `host_runner` into the
 * chokepoint deps and `work_board_start` — the agent-native ▶ START/RETRY, which
 * is the path a re-dispatched card actually takes — did not. On that path
 * `dispatchBoardBoundBuild` fell back to bare `spawnCapture`, so against a PRIVATE
 * origin the built-but-never-reviewed tip probe exited non-zero, collapsed to '',
 * and seeded nothing: the finished commit rebuilt from scratch, failing closed so
 * nothing ever looked wrong. That is the exact waste this card exists to remove.
 *
 * These drive the REAL tools through the REAL chokepoint against a REAL `git` on
 * PATH that refuses an uncredentialed `ls-remote`, and each entry carries its own
 * unwired falsification. A four-site substring count over `open/composer.ts`
 * (`open-trident-prod-boot-wiring.test.ts`) cannot see this: the drop is a layer
 * BELOW the composer, in the tool surface's own deps builder.
 */
describe('the seed tip probe is credentialed on EVERY tool entry (private origin, real git)', () => {
  const HEAD = 'a'.repeat(40)
  const BASE = 'c'.repeat(40)
  const FINDINGS = '[{"severity":"P2","title":"full suite deferred"}]'
  const TITLES: Record<string, string> = {
    // The leading words differ WITHIN the first 35 characters on purpose:
    // `slugifyTask` truncates there, and four cards sharing a slug would share a
    // prior run and a branch, which is a different test than this one.
    'd-wired': 'dispatch entry wired: rebuild the CSV export pipeline with tests',
    'd-bare': 'dispatch entry unwired: rebuild the CSV export pipeline with tests',
    's-wired': 'start entry wired: rebuild the CSV export pipeline with tests',
    's-bare': 'start entry unwired: rebuild the CSV export pipeline with tests',
  }
  let links: Map<string, string>
  let shimPath: string | undefined

  beforeEach(() => {
    links = new Map()
    shimPath = undefined
  })
  afterEach(() => {
    if (shimPath !== undefined) process.env['PATH'] = shimPath
  })

  function binder(): TridentBoardBinder {
    return {
      get: (_slug, id) =>
        TITLES[id] === undefined
          ? null
          : { id, title: TITLES[id]!, design_doc_ref: null, linked_run_id: links.get(id) ?? null },
      attachRun: async () => {},
    }
  }

  /** A finished, BUILT-but-never-reviewed prior attempt at `task`, named by the card. */
  async function priorRun(itemId: string, task: string): Promise<void> {
    const run = await store.create({
      slug: slugifyTask(task),
      project_slug: 'proj-1',
      repo_path: tmp,
      task,
      branch: `trident/${slugifyTask(task)}`,
    })
    await store.update(run.id, {
      phase: 'failed',
      inner_checkpoint: 'forge-done',
      inner_checkpoint_head: HEAD,
      inner_checkpoint_findings: FINDINGS,
      inner_verdict: 'REVIEW_NOT_RUN',
      base_sha: BASE,
    })
    links.set(itemId, run.id)
  }

  /** A `git` that answers `ls-remote` ONLY with the credential env present. */
  function privateOriginGit(): string {
    const shimDir = join(tmp, 'git-shim')
    mkdirSync(shimDir)
    const argv = join(tmp, 'git-argv')
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\n` +
        `printf '%s\\n' "$*" >> "${argv}"\n` +
        `case "$*" in\n` +
        `  *ls-remote*)\n` +
        `    [ -n "\${GIT_CONFIG_COUNT:-}" ] || { echo "fatal: could not read Username" >&2; exit 128; }\n` +
        `    printf '%s\\t%s\\n' "${HEAD}" "refs/heads/whatever"\n` +
        `    ;;\n` +
        `esac\n` +
        `exit 0\n`,
    )
    chmodSync(join(shimDir, 'git'), 0o755)
    shimPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${shimPath ?? ''}`
    return argv
  }

  /** The tool surface as the composition root builds it, with or without the runner. */
  function tools(host_runner?: EnvCapableHostRunner): ToolRegistry {
    const reg = new ToolRegistry()
    registerTridentBuildToolSurface(reg, {
      store,
      work_board: binder(),
      repo_path: tmp,
      resolveBuildRepo: async (home) => home,
      merge_mode_probe: prProbe(),
      resolveRalph: async () => false,
      // Not under test, and it must not need a live `gh`.
      landed_probe: async () => null,
      ...(host_runner !== undefined ? { host_runner } : {}),
    })
    return reg
  }

  const credentialed = (): EnvCapableHostRunner =>
    makeCredentialedHostRunner({ GH_TOKEN: 'test-sentinel', GIT_CONFIG_COUNT: '1' })

  /** Did the dispatch ADOPT the prior build's commit, or throw it away? */
  function seededCheckpoint(out: Record<string, unknown>): string | null {
    expect(out.ok).toBe(true)
    return store.get(out.run_id as string)!.inner_checkpoint
  }

  test('work_board_start (the ▶ RETRY path) adopts the built commit only when host_runner is wired', async () => {
    const argv = privateOriginGit()
    await priorRun('s-wired', TITLES['s-wired']!)
    await priorRun('s-bare', TITLES['s-bare']!)

    const wired = (await tools(credentialed()).get(WORK_BOARD_START_TOOL)!.handler(
      { board_item_id: 's-wired' },
      ctx,
    )) as Record<string, unknown>
    const bare = (await tools().get(WORK_BOARD_START_TOOL)!.handler(
      { board_item_id: 's-bare' },
      ctx,
    )) as Record<string, unknown>

    // The remote read really was attempted — an assertion about the credential is
    // worth nothing if the probe never ran.
    expect(readFileSync(argv, 'utf8')).toContain('ls-remote --heads origin')
    // WIRED: the credential arrived, the tip matched the recorded head, the
    // finished commit (and its recorded findings) are adopted instead of rebuilt.
    expect(seededCheckpoint(wired)).toBe('forge-done')
    expect(store.get(wired.run_id as string)!.inner_checkpoint_head).toBe(HEAD)
    expect(store.get(wired.run_id as string)!.inner_checkpoint_findings).toBe(FINDINGS)
    // UNWIRED, the same card shape one line apart: the private origin refuses the
    // read, nothing is adopted, and the built commit is rebuilt from scratch.
    expect(seededCheckpoint(bare)).toBeNull()
    expect(store.get(bare.run_id as string)!.inner_checkpoint_findings).toBeNull()
  })

  test('work_board_dispatch_build carries the same runner — the two entries do not disagree', async () => {
    const argv = privateOriginGit()
    await priorRun('d-wired', TITLES['d-wired']!)
    await priorRun('d-bare', TITLES['d-bare']!)

    const wired = (await tools(credentialed()).get(WORK_BOARD_DISPATCH_BUILD_TOOL)!.handler(
      { board_item_id: 'd-wired', task: TITLES['d-wired'] },
      ctx,
    )) as Record<string, unknown>
    const bare = (await tools().get(WORK_BOARD_DISPATCH_BUILD_TOOL)!.handler(
      { board_item_id: 'd-bare', task: TITLES['d-bare'] },
      ctx,
    )) as Record<string, unknown>

    expect(readFileSync(argv, 'utf8')).toContain('ls-remote --heads origin')
    expect(seededCheckpoint(wired)).toBe('forge-done')
    expect(seededCheckpoint(bare)).toBeNull()
  })
})
