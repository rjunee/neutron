/**
 * `/code` → foundational Trident — the retired-wrapper entry contract.
 *
 * Proves the rewired `/code` command:
 *   • parses identically to the old Code-Gen Core surface,
 *   • creates a `code_trident_runs` row (no separate orchestrator), and
 *   • the row, once created, is driven end-to-end by the SAME tick loop +
 *     orchestrator the rest of Trident uses — `/code <task>` → run → tick
 *     → forge → argus APPROVE → merge → done, with a mocked substrate.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  parseAndExecuteCodeCommand,
  parseCodeCommand,
  slugifyTask,
  type TridentCodeContext,
} from './code-command.ts'
import type { TridentBoardBinder } from './board-dispatch.ts'
import type { HostCommandResult } from './git-mode.ts'
import { buildSimFirer } from './inner-loop-sim.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import { TridentTickLoop } from './tick.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore
let attached: Array<{ id: string; run_id: string }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-code-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
  attached = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

/** A board binder with one READY item ('item-1', a detailed title → passes the
 *  ask-gate), a doc-backed item ('item-doc'), and a terse UNDERSPECIFIED item
 *  ('item-terse'). Records bindings into the module-level `attached`. */
function boardStub(over: Partial<TridentBoardBinder> = {}): TridentBoardBinder {
  return {
    get: (_slug, id) =>
      id === 'item-1'
        ? { id: 'item-1', title: 'wire the export button to the new CSV endpoint with tests', design_doc_ref: null }
        : id === 'item-doc'
          ? { id: 'item-doc', title: 'auth', design_doc_ref: 'https://docs/auth' }
          : id === 'item-terse'
            ? { id: 'item-terse', title: 'auth', design_doc_ref: null }
            : null,
    attachRun: async (_slug, id, run_id) => {
      attached.push({ id, run_id })
    },
    ...over,
  }
}

function ctx(over: Partial<TridentCodeContext> = {}): TridentCodeContext {
  return {
    store,
    work_board: boardStub(),
    project_slug: 'proj-1',
    repo_path: '/repo',
    // Identity workspace resolver — keep repo_path as-is, no real fs/git in unit tests.
    resolveBuildRepo: async (home) => home,
    resolveMergeMode: async () => 'pr',
    resolveRalph: async () => false,
    ...over,
  }
}

describe('/code parser parity with the Code-Gen Core surface', () => {
  test('bare /code → help', () => {
    expect(parseCodeCommand('/code')).toEqual({ kind: 'help' })
  })
  test('/code <task> → dispatch', () => {
    expect(parseCodeCommand('/code add a dark mode toggle')).toEqual({
      kind: 'dispatch',
      task: 'add a dark mode toggle',
    })
  })
  test('/code --item <id> <task> → dispatch with board_item_id (flag stripped from task)', () => {
    expect(parseCodeCommand('/code --item item-1 add a dark mode toggle')).toEqual({
      kind: 'dispatch',
      task: 'add a dark mode toggle',
      board_item_id: 'item-1',
    })
    // flag may appear after the task text too
    expect(parseCodeCommand('/code add dark mode --item=ABC')).toEqual({
      kind: 'dispatch',
      task: 'add dark mode',
      board_item_id: 'ABC',
    })
  })
  test('/code stop and /code cancel <id>', () => {
    expect(parseCodeCommand('/code stop')).toEqual({ kind: 'stop' })
    expect(parseCodeCommand('/code cancel abc123')).toEqual({ kind: 'stop', run_ref: 'abc123' })
  })
  test('retired sub-verbs are rejected, not dispatched as tasks', () => {
    const r = parseCodeCommand('/code status')
    expect(r.kind).toBe('unrecognized')
  })
  test('/codefoo is not a /code command (returns null from the bridge entry)', async () => {
    expect(await parseAndExecuteCodeCommand('/codefoo bar', ctx())).toBeNull()
  })
  test('slugify matches the SKILL grammar', () => {
    expect(slugifyTask('Add a Dark-Mode Toggle!!!')).toBe('add-a-dark-mode-toggle')
    expect(slugifyTask('')).toBe('code-task')
  })
})

describe('/code <task> creates a code_trident_runs row', () => {
  test('dispatch persists a forge-init row with detected mode + ralph flag', async () => {
    const res = await parseAndExecuteCodeCommand('/code --item item-1 add a thing', ctx({ resolveRalph: async () => false }))
    expect(res).not.toBeNull()
    const data = res!.data as { run_id: string; ralph: boolean; merge_mode: string }
    const row = store.get(data.run_id)!
    expect(row.phase).toBe('forge-init')
    expect(row.task).toBe('add a thing')
    expect(row.project_slug).toBe('proj-1')
    expect(row.repo_path).toBe('/repo')
    expect(row.merge_mode).toBe('pr')
    expect(row.ralph).toBe(false)
    expect(row.branch).toBe('trident/add-a-thing')
    expect(res!.text).toContain('Trident run')
  })

  test('a governed repo (SPEC.md) creates a ralph run', async () => {
    const res = await parseAndExecuteCodeCommand('/code --item item-1 build the spec', ctx({ resolveRalph: async () => true }))
    const data = res!.data as { run_id: string }
    expect(store.get(data.run_id)!.ralph).toBe(true)
    expect(res!.text).toContain('Ralph')
  })

  test('RT1: with NO resolveRalph override (production shape) a real root SPEC.md still resolves ralph=false', async () => {
    // Production composition (open/composer.ts `trident_build_dispatch`) never
    // sets `resolveRalph` — it relies on the chokepoint's default. Absent the
    // RT1 window override, that default is `detectRalphMode`, which would flip
    // this run governed because `repo_path` has a real root SPEC.md. Build the
    // context WITHOUT the `ctx()` helper (which always stubs resolveRalph) so
    // this test exercises the real fallback in `board-dispatch.ts`.
    const specDir = mkdtempSync(join(tmpdir(), 'neutron-trident-code-specdir-'))
    writeFileSync(join(specDir, 'SPEC.md'), '# spec\n')
    try {
      const noOverrideCtx: TridentCodeContext = {
        store,
        work_board: boardStub(),
        project_slug: 'proj-1',
        repo_path: specDir,
        resolveBuildRepo: async (home) => home, // identity — repo_path stays specDir
        resolveMergeMode: async () => 'pr',
        // resolveRalph deliberately OMITTED.
      }
      const res = await parseAndExecuteCodeCommand('/code --item item-1 add a thing', noOverrideCtx)
      expect(res).not.toBeNull()
      const data = res!.data as { run_id: string; ralph: boolean }
      expect(data.ralph).toBe(false)
      expect(store.get(data.run_id)!.ralph).toBe(false)
      expect(res!.text).not.toContain('Ralph')
    } finally {
      rmSync(specDir, { recursive: true, force: true })
    }
  })

  test('#317 threads the originating channel_kind onto the run row', async () => {
    const res = await parseAndExecuteCodeCommand(
      '/code --item item-1 build from the app',
      ctx({ chat_id: 'web:u1', channel_kind: 'app_socket' }),
    )
    const data = res!.data as { run_id: string }
    expect(store.get(data.run_id)!.channel_kind).toBe('app_socket')
  })

  test('#317 defaults the run channel_kind to telegram when the context omits it', async () => {
    const res = await parseAndExecuteCodeCommand('/code --item item-1 a telegram build', ctx({ chat_id: '-100' }))
    const data = res!.data as { run_id: string }
    expect(store.get(data.run_id)!.channel_kind).toBe('telegram')
  })

  test('/code stop marks the most-recent in-flight run stopped', async () => {
    const a = (await parseAndExecuteCodeCommand('/code --item item-1 first', ctx()))!.data as { run_id: string }
    const b = (await parseAndExecuteCodeCommand('/code --item item-1 second', ctx()))!.data as { run_id: string }
    const stop = await parseAndExecuteCodeCommand('/code stop', ctx())
    expect((stop!.data as { run_id: string }).run_id).toBe(b.run_id)
    expect(store.get(b.run_id)!.phase).toBe('stopped')
    expect(store.get(a.run_id)!.phase).toBe('forge-init') // untouched
  })

  test('/code stop <prefix> targets a specific run', async () => {
    const a = (await parseAndExecuteCodeCommand('/code --item item-1 only one', ctx()))!.data as { run_id: string }
    const stop = await parseAndExecuteCodeCommand(`/code stop ${a.run_id.slice(0, 8)}`, ctx())
    expect((stop!.data as { run_id: string }).run_id).toBe(a.run_id)
    expect(store.get(a.run_id)!.phase).toBe('stopped')
  })

  test('/code stop with nothing in flight is a friendly no-op', async () => {
    const stop = await parseAndExecuteCodeCommand('/code stop', ctx())
    expect(stop!.text).toContain('No in-flight')
    expect(stop!.error).toBeUndefined()
  })

  test('§F6a race: /code stop reports accurately when the run finished first (lost race)', async () => {
    // The run is active when `resolveStopTarget` reads it, but the tick loop wins
    // the terminal transition (commits `done`) before `terminate()` executes. The
    // atomic transition then LOSES — the command must NOT claim it stopped the run.
    const created = (await parseAndExecuteCodeCommand('/code --item item-1 build', ctx()))!.data as {
      run_id: string
    }
    const active = store.get(created.run_id)!
    // The tick loop committed a real terminal result during the await gap.
    await store.save({ ...active, phase: 'done' })

    // A store whose STALE `listNonTerminal` still surfaces the run (so the stop
    // targets it), but whose atomic `terminalTransition` hits the now-terminal DB
    // row → loses. `get`/`terminalTransition` delegate to the real (terminal) store.
    const staleActive = { ...active, phase: 'forge-init' as const }
    const racingStore = {
      listNonTerminal: () => [staleActive],
      get: (id: string) => store.get(id),
      terminalTransition: (id: string, patch: { phase: TridentRun['phase']; failure_reason?: string | null }) =>
        store.terminalTransition(id, patch),
    } as unknown as typeof store

    const stop = await parseAndExecuteCodeCommand('/code stop', ctx({ store: racingStore }))

    // Accurate report — NOT a false "Stopped".
    expect(stop!.text).toContain('already finished')
    expect((stop!.data as { already_terminal?: boolean }).already_terminal).toBe(true)
    // The real result stands — the DB row was NOT clobbered from `done` to `stopped`.
    expect(store.get(created.run_id)!.phase).toBe('done')
  })
})

describe('Phase 2b — board-binding chokepoint (required item + ask-gate + bind)', () => {
  test('a /code build with NO --item is REJECTED (no untracked dispatches, no row)', async () => {
    const res = await parseAndExecuteCodeCommand('/code add a thing', ctx())
    expect(res!.error?.code).toBe('malformed')
    expect(res!.text).toContain('--item')
    expect(res!.data).toBeUndefined()
    // No run row was created.
    expect(store.listNonTerminal().length).toBe(0)
    expect(attached.length).toBe(0)
  })

  test('a /code build against an UNKNOWN item is rejected (no row)', async () => {
    const res = await parseAndExecuteCodeCommand('/code --item nope build a thing', ctx())
    expect(res!.error).toBeDefined()
    expect(res!.text).toContain('nope')
    expect(store.listNonTerminal().length).toBe(0)
  })

  test('ask-before-acting: an UNDERSPECIFIED item BLOCKS the dispatch (no row)', async () => {
    const res = await parseAndExecuteCodeCommand('/code --item item-terse do the auth thing', ctx())
    expect(res!.error?.code).toBe('malformed')
    expect(res!.text.toLowerCase()).toContain('underspecified')
    expect(store.listNonTerminal().length).toBe(0)
    expect(attached.length).toBe(0)
  })

  test('an item WITH a design_doc_ref passes the ask-gate even with a terse title', async () => {
    const res = await parseAndExecuteCodeCommand('/code --item item-doc build per the doc', ctx())
    expect(res!.error).toBeUndefined()
    const data = res!.data as { run_id: string }
    expect(store.get(data.run_id)).not.toBeNull()
  })

  test('a successful dispatch BINDS the created run to its board item', async () => {
    const res = await parseAndExecuteCodeCommand('/code --item item-1 wire the widget', ctx())
    const data = res!.data as { run_id: string }
    expect(attached).toEqual([{ id: 'item-1', run_id: data.run_id }])
    expect(res!.text).toContain('Plan item')
  })
})

describe('end-to-end — /code → tick loop drives the run to done (mocked substrate)', () => {
  test('a /code dispatch is built + reviewed + merged by the foundational loop', async () => {
    // 1. The user types /code — only a row is created, no orchestrator.
    const res = await parseAndExecuteCodeCommand('/code --item item-1 wire the widget', ctx({ resolveMergeMode: async () => 'pr' }))
    const run_id = (res!.data as { run_id: string }).run_id

    // 2. The foundational tick loop (the SAME one the gateway runs) sweeps the
    //    row and drives it with a mocked FIRER (the CC Dynamic Workflow exec
    //    model): the fire settles + the simulated workflow writes a server-gated
    //    APPROVE result to the DB, which the tick loop harvests + merges.
    const sim = buildSimFirer(store, () => ({
      result: { verdict: 'APPROVE', prNumber: 101, branch: 'trident/wire-the-widget' },
    }))
    const hostCalls: string[][] = []
    const orch = buildTridentOrchestrator({
      fire_workflow: sim.fire_workflow,
      db_path: join(tmp, 'project.db'),
      run_host: async (cmd) => {
        hostCalls.push(cmd)
        return ok()
      },
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    const loop = new TridentTickLoop({ store, step: orch.step })

    let final = store.get(run_id)!
    for (let i = 0; i < 40 && !isTerminalPhase(final.phase); i++) {
      await loop.runOnce()
      await sim.drain() // simulate the detached workflow finishing
      final = store.get(run_id)!
    }

    expect(final.phase).toBe('done')
    expect(final.pr).toBe(101)
    expect(hostCalls.map((c) => c.join(' '))).toContain('gh pr merge 101 --squash')
  })
})
