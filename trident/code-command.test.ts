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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import {
  parseAndExecuteCodeCommand,
  parseCodeCommand,
  slugifyTask,
  type TridentCodeContext,
} from './code-command.ts'
import type { HostCommandResult } from './git-mode.ts'
import { buildSimFirer } from './inner-loop-sim.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore } from './store.ts'
import { TridentTickLoop } from './tick.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-code-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

function ctx(over: Partial<TridentCodeContext> = {}): TridentCodeContext {
  return {
    store,
    project_slug: 'proj-1',
    repo_path: '/repo',
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
    const res = await parseAndExecuteCodeCommand('/code add a thing', ctx({ resolveRalph: async () => false }))
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
    const res = await parseAndExecuteCodeCommand('/code build the spec', ctx({ resolveRalph: async () => true }))
    const data = res!.data as { run_id: string }
    expect(store.get(data.run_id)!.ralph).toBe(true)
    expect(res!.text).toContain('Ralph')
  })

  test('#317 threads the originating channel_kind onto the run row', async () => {
    const res = await parseAndExecuteCodeCommand(
      '/code build from the app',
      ctx({ chat_id: 'web:u1', channel_kind: 'app_socket' }),
    )
    const data = res!.data as { run_id: string }
    expect(store.get(data.run_id)!.channel_kind).toBe('app_socket')
  })

  test('#317 defaults the run channel_kind to telegram when the context omits it', async () => {
    const res = await parseAndExecuteCodeCommand('/code a telegram build', ctx({ chat_id: '-100' }))
    const data = res!.data as { run_id: string }
    expect(store.get(data.run_id)!.channel_kind).toBe('telegram')
  })

  test('/code stop marks the most-recent in-flight run stopped', async () => {
    const a = (await parseAndExecuteCodeCommand('/code first', ctx()))!.data as { run_id: string }
    const b = (await parseAndExecuteCodeCommand('/code second', ctx()))!.data as { run_id: string }
    const stop = await parseAndExecuteCodeCommand('/code stop', ctx())
    expect((stop!.data as { run_id: string }).run_id).toBe(b.run_id)
    expect(store.get(b.run_id)!.phase).toBe('stopped')
    expect(store.get(a.run_id)!.phase).toBe('forge-init') // untouched
  })

  test('/code stop <prefix> targets a specific run', async () => {
    const a = (await parseAndExecuteCodeCommand('/code only one', ctx()))!.data as { run_id: string }
    const stop = await parseAndExecuteCodeCommand(`/code stop ${a.run_id.slice(0, 8)}`, ctx())
    expect((stop!.data as { run_id: string }).run_id).toBe(a.run_id)
    expect(store.get(a.run_id)!.phase).toBe('stopped')
  })

  test('/code stop with nothing in flight is a friendly no-op', async () => {
    const stop = await parseAndExecuteCodeCommand('/code stop', ctx())
    expect(stop!.text).toContain('No in-flight')
    expect(stop!.error).toBeUndefined()
  })
})

describe('end-to-end — /code → tick loop drives the run to done (mocked substrate)', () => {
  test('a /code dispatch is built + reviewed + merged by the foundational loop', async () => {
    // 1. The user types /code — only a row is created, no orchestrator.
    const res = await parseAndExecuteCodeCommand('/code wire the widget', ctx({ resolveMergeMode: async () => 'pr' }))
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
