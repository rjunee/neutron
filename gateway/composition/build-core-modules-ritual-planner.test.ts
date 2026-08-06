import { asOwnerHandle } from '@neutronai/persistence/index.ts'
/**
 * PRODUCTION WIRING guard for the ritual fire planner (ISSUES #504).
 *
 * `remindersModule.init` must, when the composition supplies `init_ritual_planner`,
 * invoke it with the GRAPH's `ApprovalManager` — the content-hash approval checker
 * source, and therefore the thing the entire remaining security model depends on.
 * If the planner is never installed, an approved ritual can never fire and no
 * approval is ever checked, so this hook not running is a silent, total failure.
 *
 * AND it must NOT give the tick loop any ritual-shaped option. This file replaced
 * `build-core-modules-ritual-executor.test.ts`, whose whole subject was that a due
 * `ritual_id` row routed to a separate executor INSTEAD of the dispatcher. That
 * routing was the defect: it sent rituals to an ephemeral REPL with no tool bridge,
 * so the morning brief could not reach a Core. The second assertion below is the
 * inversion — every due row, ritual or not, reaches the ONE `reminder_dispatcher`.
 *
 * MUTATION-KILL (1): delete the `init_ritual_planner` invocation block from
 * `build-core-modules.ts`'s `remindersModule` → `seenApprovals` stays null, RED.
 * MUTATION-KILL (2): reintroduce a `ritual_id` branch in `reminders/tick.ts` that
 * routes around `dispatcher.dispatch` → the second test's `dispatched` array is
 * empty, RED.
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

import { buildCoreModules } from './build-core-modules.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'

const OWNER = asOwnerHandle('ritual-planner-composition')

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeProjectDb(): ProjectDb {
  const tmp = mkdtempSync(join(tmpdir(), 'ritual-planner-comp-'))
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  cleanups.push(() => db.close())
  applyMigrations(db.raw())
  return db
}

function baseInput(db: ProjectDb, dispatched: Reminder[]): CompositionInput {
  return {
    db,
    project_slug: OWNER,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: {
      dispatch: async (r: Reminder) => {
        dispatched.push(r)
      },
    },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
  } as unknown as CompositionInput
}

function makeCtx(graphApprovals: ApprovalManager): ModuleContext {
  return {
    graph: {
      get: ((name: string) => (name === 'approval' ? graphApprovals : undefined)) as never,
      names: () => ['approval'],
    },
    config: {},
  }
}

test('remindersModule installs the ritual planner with the graph ApprovalManager', async () => {
  const db = makeProjectDb()
  const graphApprovals = new ApprovalManager(db, { notify: async () => undefined })
  let seenApprovals: unknown = null

  const input = {
    ...baseInput(db, []),
    init_ritual_planner: (deps: { approvals: ApprovalManager }): void => {
      seenApprovals = deps.approvals
    },
  } as unknown as CompositionInput

  const mods = buildCoreModules(input)
  // `init` is typed `X | Promise<X>`; await handles both arms.
  const { loop } = await mods.remindersModule.init(makeCtx(graphApprovals))
  cleanups.push(() => {
    void loop.stop()
  })

  // The hook ran, with the EXACT graph ApprovalManager instance.
  expect(seenApprovals).toBe(graphApprovals)
})

test('a due RITUAL row reaches the ONE reminder_dispatcher — there is no second target', async () => {
  const db = makeProjectDb()
  const graphApprovals = new ApprovalManager(db, { notify: async () => undefined })
  const dispatched: Reminder[] = []

  const input = {
    ...baseInput(db, dispatched),
    init_ritual_planner: (): void => {},
  } as unknown as CompositionInput

  const mods = buildCoreModules(input)
  const { loop, store } = await mods.remindersModule.init(makeCtx(graphApprovals))
  cleanups.push(() => {
    void loop.stop()
  })

  const reminderStore = store as ReminderStore
  const row = await reminderStore.create({
    owner_slug: OWNER,
    topic_id: null,
    fire_at: 1,
    message: 'x',
  })
  db.raw().run('UPDATE reminders SET ritual_id = ? WHERE id = ?', ['some-ritual', row.id])

  const res = await loop.runOnce()
  expect(res.fired).toBe(1)
  // Composed through the real path, the ritual row landed on the ordinary
  // dispatcher, carrying its ritual_id so the fire plan can resolve the prompt.
  expect(dispatched).toHaveLength(1)
  expect(dispatched[0]!.id).toBe(row.id)
  expect(dispatched[0]!.ritual_id).toBe('some-ritual')
})
