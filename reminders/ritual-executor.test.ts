/**
 * @neutronai/reminders — ritual EXECUTOR tests (plan task 4).
 *
 * Every spec'd module invocation gets an explicit assertion: the approval
 * checker is BUILT from the row-derived cadence and CONSULTED; skip verdicts land
 * durable `code_ritual_runs` 'skipped' rows and spawn NOTHING; an approved ritual
 * spawns a registry `agent_kind:'ritual'` record + a 'running' history row bound
 * to the content hash; the substrate turn receives the exact prompt/tools/model/
 * timeout/cwd; turn settlement drives the run row + registry terminal; a spawn
 * refusal lands a 'failed' row with no registry leak; and `fire()` never rejects.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import { spawnSubagent } from '@neutronai/runtime/subagent/spawn.ts'
import { ApprovalManager, type ApprovalNotifier } from '@neutronai/tools/approval.ts'

import { ReminderStore, type Reminder } from './store.ts'
import {
  createRitualRegistry,
  RITUAL_MODEL_TIER,
  RITUAL_TIMEOUT_MS,
  type RitualApprovalCheck,
  type RitualDef,
  type RitualRegistry,
} from './rituals.ts'
import { computeRitualContentHash } from './ritual-approval.ts'
import { createRitualRunStore, type RitualRunStore } from './ritual-runs.ts'
import {
  createRitualExecutor,
  type RitualTurn,
  type RitualTurnInput,
  type RitualTurnResult,
} from './ritual-executor.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

let tmp: string
let db: ProjectDb
let store: ReminderStore
let runs: RitualRunStore
let subagents: SubagentRegistry
let ritualsDir: string

const noopNotifier: ApprovalNotifier = { notify: async () => {} }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-ritual-exec-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new ReminderStore(db)
  runs = createRitualRunStore(db)
  subagents = new SubagentRegistry()
  ritualsDir = mkdtempSync(join(tmpdir(), 'neutron-rituals-'))
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
  rmSync(ritualsDir, { recursive: true, force: true })
})

function def(overrides: Partial<RitualDef> = {}): RitualDef {
  return {
    id: 'morning-brief',
    description: 'read STATUS.md + calendar and summarise the day',
    scope: 'project',
    tool_surface: ['Read', 'Glob', 'Grep'],
    egress: 'none',
    silent: false,
    ...overrides,
  }
}

function registryWith(d: RitualDef, promptBody = 'Do the morning brief.'): RitualRegistry {
  const reg = createRitualRegistry({ rituals_dir: ritualsDir })
  reg.register(d)
  writeFileSync(join(ritualsDir, `${d.id}.md`), promptBody, 'utf8')
  return reg
}

/** A due one-shot reminder tagged as a ritual. */
async function ritualRow(ritual_id: string): Promise<Reminder> {
  const r = await store.create({ owner_slug: 'owner', topic_id: null, fire_at: 1000, message: 'x' })
  db.raw().run('UPDATE reminders SET ritual_id = ? WHERE id = ?', [ritual_id, r.id])
  return { ...r, ritual_id }
}

/** Poll the run store until `run_id` reaches a terminal (non-running) status. */
async function waitTerminal(run_id: string): Promise<ReturnType<RitualRunStore['get']>> {
  const start = Date.now()
  while (Date.now() - start < 2000) {
    const row = runs.get(run_id)
    if (row !== null && row.status !== 'running') return row
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`run ${run_id} never reached terminal`)
}

const approver = (value: boolean): RitualApprovalCheck => ({ isApproved: () => value })

describe('createRitualExecutor.fire — skip verdicts', () => {
  test('unknown ritual → durable skipped row, spawnSubagent NOT invoked', async () => {
    const registry = createRitualRegistry({ rituals_dir: ritualsDir }) // empty
    const turn = mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' }))
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      turn,
      runs,
      resolve_model: () => 'm',
      scope_cwd: () => '/scope',
      mint_run_id: () => 'attempt-0',
    })
    await exec.fire(await ritualRow('does-not-exist'))

    const row = runs.get('attempt-0')!
    expect(row.status).toBe('skipped')
    expect(row.skip_reason).toBe('unknown_ritual')
    expect(row.subagent_run_id).toBeNull()
    // NOTHING spawned + the turn never fired.
    expect(subagents.snapshot()).toHaveLength(0)
    expect(turn).not.toHaveBeenCalled()
  })

  test('unapproved (checker returns false) → skipped/unapproved row', async () => {
    const registry = registryWith(def())
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      turn: mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' })),
      runs,
      resolve_model: () => 'm',
      scope_cwd: () => '/scope',
      build_approval_check: () => approver(false),
      mint_run_id: () => 'attempt-1',
    })
    await exec.fire(await ritualRow('morning-brief'))
    const row = runs.get('attempt-1')!
    expect(row.status).toBe('skipped')
    expect(row.skip_reason).toBe('unapproved')
    expect(subagents.snapshot()).toHaveLength(0)
  })

  test('unapproved (checker THROWS → fail-closed) → skipped/unapproved row', async () => {
    const registry = registryWith(def())
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      turn: mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' })),
      runs,
      resolve_model: () => 'm',
      scope_cwd: () => '/scope',
      build_approval_check: () => ({
        isApproved: () => {
          throw new Error('approval store down')
        },
      }),
      mint_run_id: () => 'attempt-2',
    })
    await exec.fire(await ritualRow('morning-brief'))
    const row = runs.get('attempt-2')!
    expect(row.status).toBe('skipped')
    expect(row.skip_reason).toBe('unapproved')
  })
})

describe('createRitualExecutor.fire — approved spawn + turn wiring', () => {
  test('approved → ritual registry record + running row (content_hash + subagent_run_id) + correct turn input', async () => {
    const d = def()
    const promptBody = 'Read STATUS.md and summarise.'
    const registry = registryWith(d, promptBody)
    let seenCadence = ''
    const turnCalls: RitualTurnInput[] = []
    const turn: RitualTurn = async (input) => {
      turnCalls.push(input)
      return { result: 'brief done', status: 'completed' }
    }
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      turn,
      runs,
      resolve_model: () => 'model-x',
      scope_cwd: (scope) => `/scope/${scope}`,
      build_approval_check: (cadence) => {
        seenCadence = cadence
        return approver(true)
      },
      mint_run_id: () => 'sub-0',
    })

    // A recurring row so the cadence string is non-trivial (spec:<cron>).
    const base = await store.createRecurring({
      owner_slug: 'owner',
      topic_id: null,
      fire_at: 1000,
      message: 'x',
      recurrence_spec: '0 9 * * *',
    })
    db.raw().run('UPDATE reminders SET ritual_id = ? WHERE id = ?', ['morning-brief', base.id])
    const row: Reminder = { ...base, ritual_id: 'morning-brief' }

    await exec.fire(row)

    // build_approval_check saw the row-derived cadence.
    expect(seenCadence).toBe('spec:0 9 * * *')

    // A ritual registry record exists (kind 'ritual').
    const rec = subagents.byRunId('sub-0')!
    expect(rec.agent_kind).toBe('ritual')

    // The 'running' history row carries content_hash + subagent_run_id.
    const running = runs.get('sub-0')!
    expect(running.status).toBe('running')
    expect(running.subagent_run_id).toBe('sub-0')
    const expectedHash = computeRitualContentHash({
      prompt: promptBody,
      tool_surface: d.tool_surface,
      scope: d.scope,
      cadence: 'spec:0 9 * * *',
      model_tier: RITUAL_MODEL_TIER,
      timeout_ms: RITUAL_TIMEOUT_MS,
    })
    expect(running.content_hash).toBe(expectedHash)

    // The turn received the exact prompt bytes / surface / model / timeout / cwd.
    expect(turnCalls).toHaveLength(1)
    const ti = turnCalls[0]!
    expect(ti.user_message).toBe(promptBody)
    expect(ti.tools).toEqual(d.tool_surface)
    expect(ti.model).toBe('model-x')
    expect(ti.timeout_ms).toBe(RITUAL_TIMEOUT_MS)
    expect(ti.repo_path).toBe('/scope/project')
    expect(ti.trident_run_id).toBe('sub-0')

    // Settlement drives the run row + registry terminal.
    const settled = await waitTerminal('sub-0')!
    expect(settled!.status).toBe('finished')
    expect(settled!.output_summary).toBe('brief done')
    expect(subagents.byRunId('sub-0')!.status).toBe('finished')
  })

  test.each([
    ['timed_out', 'timed_out', 'crashed'],
    ['failed', 'failed', 'crashed'],
    ['cancelled', 'failed', 'cancelled'],
  ] as const)(
    'turn status %s → run row %s + registry %s',
    async (turnStatus, expectedRun, expectedReg) => {
      const registry = registryWith(def())
      const turn: RitualTurn = async () => ({ result: 'partial', status: turnStatus })
      const exec = createRitualExecutor({
        registry,
        approvals: new ApprovalManager(db, noopNotifier),
        project_slug: 'owner',
        instance_key: 'owner',
        subagents,
        turn,
        runs,
        resolve_model: () => 'm',
        scope_cwd: () => '/s',
        build_approval_check: () => approver(true),
        mint_run_id: () => 'sub-1',
      })
      await exec.fire(await ritualRow('morning-brief'))
      const settled = await waitTerminal('sub-1')!
      expect(settled!.status).toBe(expectedRun)
      expect(subagents.byRunId('sub-1')!.status).toBe(expectedReg)
    },
  )

  test('turn REJECTION → crashed run row + crashed registry record', async () => {
    const registry = registryWith(def())
    const turn: RitualTurn = async () => {
      throw new Error('substrate exploded')
    }
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      turn,
      runs,
      resolve_model: () => 'm',
      scope_cwd: () => '/s',
      build_approval_check: () => approver(true),
      mint_run_id: () => 'sub-2',
    })
    await exec.fire(await ritualRow('morning-brief'))
    const settled = await waitTerminal('sub-2')!
    expect(settled!.status).toBe('crashed')
    expect(settled!.failure_reason).toContain('substrate exploded')
    expect(subagents.byRunId('sub-2')!.status).toBe('crashed')
  })
})

describe('createRitualExecutor.fire — spawn refusal + robustness', () => {
  test('spawn lane cap → failed run row, no registry leak, turn never fired', async () => {
    // Saturate the ritual lane (2 live rituals) so the executor's spawn is refused.
    for (let i = 0; i < 2; i++) {
      // eslint-disable-next-line no-await-in-loop
      await spawnSubagent(
        { instance_key: 'owner', agent_kind: 'ritual' },
        {
          registry: subagents,
          verify_delegation: async () => {
            throw new Error('no nest')
          },
          mint_run_id: () => `live-${i}`,
        },
      )
    }
    const registry = registryWith(def())
    const turn = mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' }))
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      turn,
      runs,
      resolve_model: () => 'm',
      scope_cwd: () => '/s',
      build_approval_check: () => approver(true),
      mint_run_id: () => 'attempt-refused',
    })
    await exec.fire(await ritualRow('morning-brief'))

    const row = runs.get('attempt-refused')!
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toContain('ritual lane cap hit')
    expect(row.subagent_run_id).toBeNull()
    // Only the 2 pre-seeded live rituals — the refused spawn left no record.
    expect(subagents.snapshot()).toHaveLength(2)
    expect(turn).not.toHaveBeenCalled()
  })

  test('fire() NEVER rejects even when the run store write throws', async () => {
    const registry = registryWith(def())
    const brokenRuns: RitualRunStore = {
      ...runs,
      insertSkipped: async () => {
        throw new Error('db down')
      },
    }
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      turn: mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' })),
      runs: brokenRuns,
      resolve_model: () => 'm',
      scope_cwd: () => '/s',
      build_approval_check: () => approver(false), // → insertSkipped throws
      mint_run_id: () => 'attempt-x',
    })
    // Must resolve, not reject.
    await expect(exec.fire(await ritualRow('morning-brief'))).resolves.toBeUndefined()
  })
})
