import { asOwnerHandle } from '@neutronai/persistence/index.ts'
/**
 * Executor-mode reminders (plan task 4) — PRODUCTION WIRING guard for the ritual
 * executor.
 *
 * `remindersModule.init` must, when the composition supplies a
 * `ritual_executor_factory`, invoke it with the GRAPH's `ApprovalManager` and
 * wire the returned executor as the tick loop's ritual dispatch branch. This test
 * obtains the loop THROUGH the real composition path
 * (`buildCoreModules(input).remindersModule.init(ctx)`) so the only thing that
 * makes a ritual row route to the executor is the production wiring under test.
 *
 * MUTATION-KILL: delete the `deps: ['approval']` + factory-invocation block from
 * `build-core-modules.ts`'s `remindersModule` and this test goes RED — the loop
 * is built with no `ritual_executor`, so a ritual row is consumed (logged) and
 * the sentinel `fire` is never called.
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { ApprovalManager } from '@neutronai/tools/approval.ts'
import { ReminderStore, type Reminder } from '@neutronai/reminders/store.ts'
import type { RitualExecutor } from '@neutronai/reminders/ritual-executor.ts'

import { buildCoreModules } from './build-core-modules.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'

const OWNER = asOwnerHandle('ritual-exec-composition')

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeProjectDb(): ProjectDb {
  const tmp = mkdtempSync(join(tmpdir(), 'ritual-exec-comp-'))
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  cleanups.push(() => db.close())
  applyMigrations(db.raw())
  return db
}

function baseInput(db: ProjectDb): CompositionInput {
  return {
    db,
    project_slug: OWNER,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
  } as unknown as CompositionInput
}

test('remindersModule invokes the ritual_executor_factory with the graph ApprovalManager + wires it as the tick branch', async () => {
  const db = makeProjectDb()

  // The graph's real ApprovalManager instance the factory must receive.
  const graphApprovals = new ApprovalManager(db, { notify: async () => undefined })

  // Sentinel executor whose fire() records calls; the factory records the
  // approvals it was handed.
  const fireCalls: Reminder[] = []
  const sentinel: RitualExecutor = { fire: async (r) => { fireCalls.push(r) } }
  let seenApprovals: unknown = null

  const input = {
    ...baseInput(db),
    ritual_executor_factory: (deps: { approvals: ApprovalManager }): RitualExecutor => {
      seenApprovals = deps.approvals
      return sentinel
    },
  } as unknown as CompositionInput

  const mods = buildCoreModules(input)
  const ctx: ModuleContext = {
    graph: {
      get: ((name: string) => (name === 'approval' ? graphApprovals : undefined)) as never,
      names: () => ['approval'],
    },
    config: {},
  }

  const { loop, store } = mods.remindersModule.init(ctx)
  cleanups.push(() => { void loop.stop() })

  // The factory was invoked with the EXACT graph ApprovalManager.
  expect(seenApprovals).toBe(graphApprovals)

  // A due ritual row routes to the sentinel executor via the wired branch.
  const reminderStore = store as ReminderStore
  const row = await reminderStore.create({ owner_slug: OWNER, topic_id: null, fire_at: 1, message: 'x' })
  db.raw().run('UPDATE reminders SET ritual_id = ? WHERE id = ?', ['some-ritual', row.id])

  const res = await loop.runOnce()
  expect(res.fired).toBe(1)
  expect(fireCalls).toHaveLength(1)
  expect(fireCalls[0]!.id).toBe(row.id)
  expect(fireCalls[0]!.ritual_id).toBe('some-ritual')
})
