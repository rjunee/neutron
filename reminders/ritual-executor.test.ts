/**
 * @neutronai/reminders — ritual EXECUTOR tests (plan task 4).
 *
 * Every spec'd module invocation gets an explicit assertion: the approval
 * checker is BUILT from the row-derived cadence and CONSULTED; skip verdicts land
 * durable `code_ritual_runs` 'skipped' rows and spawn NOTHING; an approved ritual
 * spawns a registry `agent_kind:'ritual'` record + a 'running' history row bound
 * to the content hash; the substrate turn receives the exact prompt/tools/model/
 * timeout/cwd; turn settlement drives the run row + registry terminal; a spawn
 * refusal lands a 'failed' row with no registry leak; and `fire()` REJECTS on a
 * STARTUP loss (no durable row landed) so the tick reverts the #319 claim, while
 * resolving whenever a durable row (skipped / failed / running) was written.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import type { ReminderOutbound, ReminderOutboundInput } from './dispatcher.ts'
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

/** Poll until `pred` holds (or throw). Used to await detached settle+post chains. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred()) return
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('condition not met within timeout')
}

const approver = (value: boolean): RitualApprovalCheck => ({ isApproved: () => value })

/** A no-op delivery seam for the pre-task-5 assertions that don't inspect posts. */
const passThroughOutbound: ReminderOutbound = { post: async () => true }
const resolveTopic = (): string => 'app:owner-topic'

/** A recording delivery seam — captures every post for task-5 delivery assertions. */
function recordingOutbound(): { posts: ReminderOutboundInput[]; outbound: ReminderOutbound } {
  const posts: ReminderOutboundInput[] = []
  return {
    posts,
    outbound: {
      post: mock(async (i: ReminderOutboundInput): Promise<boolean> => {
        posts.push(i)
        return true
      }),
    },
  }
}

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
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
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
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
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
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
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

  test('unsupported scope (scope_cwd THROWS → fail-closed) → skipped row, NO running row, nothing spawned', async () => {
    // Mirrors the composer wiring (Argus r1 MAJOR): v1 wires only the 'instance'
    // root; a 'project'-scoped ritual's scope_cwd throws → the executor lands a
    // durable 'skipped' row BEFORE any running row / spawn, rather than silently
    // over-granting the owner-wide dir.
    const registry = registryWith(def({ scope: 'project' }))
    const turn = mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' }))
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'm',
      scope_cwd: (scope) => {
        if (scope !== 'instance') throw new Error(`ritual scope '${scope}' not yet supported: task 6`)
        return '/scope'
      },
      build_approval_check: () => approver(true),
      mint_run_id: () => 'attempt-scope',
    })
    await exec.fire(await ritualRow('morning-brief'))
    const row = runs.get('attempt-scope')!
    expect(row.status).toBe('skipped')
    expect(row.skip_reason).toBe('unsupported_scope')
    expect(row.subagent_run_id).toBeNull()
    // No running row leaked, nothing spawned, the turn never fired.
    expect(subagents.snapshot()).toHaveLength(0)
    expect(turn).not.toHaveBeenCalled()
  })

  test('gated tool surface (Bash) → durable skipped/gated_tool_surface row, fire() RESOLVES, nothing spawned', async () => {
    // Blocker A end-to-end: a Bash-surface ritual is refused fail-CLOSED with
    // reason 'gated_tool_surface'; the executor persists that verbatim via
    // insertSkipped against the STRICT 0106 DDL. Before the CHECK admitted the
    // value, this INSERT threw 'CHECK constraint failed' → outer catch re-throw →
    // fire() REJECTED → tick claimRevert → 30s hot loop, no durable row. The
    // resolve assertion is the no-hot-loop proof (the tick will NOT revert).
    const registry = registryWith(def({ tool_surface: ['Read', 'Bash'] }))
    const turn = mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' }))
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'm',
      scope_cwd: () => '/scope',
      build_approval_check: () => approver(true),
      mint_run_id: () => 'attempt-gated',
    })

    // fire() RESOLVES — a durable skip landed, so the tick does not claimRevert.
    await expect(exec.fire(await ritualRow('morning-brief'))).resolves.toBeUndefined()

    const row = runs.get('attempt-gated')!
    expect(row.status).toBe('skipped')
    expect(row.skip_reason).toBe('gated_tool_surface')
    expect(row.subagent_run_id).toBeNull()
    // NOTHING spawned + the turn never fired.
    expect(subagents.snapshot()).toHaveLength(0)
    expect(turn).not.toHaveBeenCalled()
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
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
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
    // Operator/shutdown cancel is its OWN terminal — NOT a merit 'failed' (Argus
    // r1 minor): distinct run-row status, registry 'cancelled', no failure notice,
    // does not feed the consecutive-failure escalation.
    ['cancelled', 'cancelled', 'cancelled'],
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
        outbound: passThroughOutbound,
        resolve_topic: resolveTopic,
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
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
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
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
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

  test('insertRunning throws AFTER spawn → registry key freed (no wedge), durable failed row + notice (Argus r2)', async () => {
    // The subagent record is persisted by spawnSubagent BEFORE the 'running'
    // history row is written. If insertRunning throws, a live `ritual:<id>`
    // registry record must NOT be left behind — `on_duplicate:'refuse'` would
    // then wedge EVERY future fire of this ritual as a duplicate with no durable
    // row explaining why. The catch marks the record terminal (freeing the key)
    // and lands a durable failed row + failure notice.
    const registry = registryWith(def())
    const brokenRuns: RitualRunStore = {
      ...runs,
      insertRunning: async () => {
        throw new Error('running-row write blew up')
      },
    }
    const rec = recordingOutbound()
    let n = 0
    const turn = mock(async (): Promise<RitualTurnResult> => ({ result: 'never runs', status: 'completed' }))
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: rec.outbound,
      resolve_topic: resolveTopic,
      turn,
      runs: brokenRuns,
      resolve_model: () => 'm',
      scope_cwd: () => '/s',
      build_approval_check: () => approver(true),
      mint_run_id: () => `sub-${n++}`,
    })

    await expect(exec.fire(await ritualRow('morning-brief'))).resolves.toBeUndefined()

    // The registry record spawned as 'sub-0' is now TERMINAL, so the spawn_key is
    // freed — a future fire is NOT refused as a duplicate.
    expect(subagents.liveByKey('ritual:morning-brief', 'owner')).toBeUndefined()
    expect(subagents.byRunId('sub-0')!.status).toBe('crashed')

    // A durable failed run row records the attempt (minted after the spawn id).
    const failed = runs.get('sub-1')!
    expect(failed.status).toBe('failed')
    expect(failed.failure_reason).toContain('run-history insert failed after spawn')

    // A failure notice was surfaced, and the substrate turn never launched.
    await waitFor(() => rec.posts.length >= 1)
    expect(rec.posts[0]!.body).toMatch(/Ritual 'morning-brief' failed \(run sub-1\)/)
    expect(turn).not.toHaveBeenCalled()
  })

  test('fire() REJECTS when a startup run-store write throws (no durable row → tick reverts claim)', async () => {
    // Argus r1 BLOCKER: the outer catch used to log-and-RESOLVE any startup throw,
    // so a scheduled occurrence with NO durable code_ritual_runs row was silently
    // consumed by the tick. It must now REJECT so the tick reverts the #319 claim.
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
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
      turn: mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' })),
      runs: brokenRuns,
      resolve_model: () => 'm',
      scope_cwd: () => '/s',
      build_approval_check: () => approver(false), // → insertSkipped throws
      mint_run_id: () => 'attempt-x',
    })
    await expect(exec.fire(await ritualRow('morning-brief'))).rejects.toThrow('db down')
  })

  test('fire() REJECTS when insertRunning AND insertFailed both throw (total run-store outage)', async () => {
    // The insertRunning-failure path frees the spawn key, then best-effort writes a
    // durable failed row. If THAT also throws, NO durable row exists — reject so the
    // tick reverts the claim (the spawn key was already freed → clean re-fire).
    const registry = registryWith(def())
    const brokenRuns: RitualRunStore = {
      ...runs,
      insertRunning: async () => {
        throw new Error('running-row write blew up')
      },
      insertFailed: async () => {
        throw new Error('failed-row write blew up too')
      },
    }
    let n = 0
    const turn = mock(async (): Promise<RitualTurnResult> => ({ result: 'never runs', status: 'completed' }))
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: passThroughOutbound,
      resolve_topic: resolveTopic,
      turn,
      runs: brokenRuns,
      resolve_model: () => 'm',
      scope_cwd: () => '/s',
      build_approval_check: () => approver(true),
      mint_run_id: () => `sub-${n++}`,
    })

    await expect(exec.fire(await ritualRow('morning-brief'))).rejects.toThrow('running-row write blew up')
    // The spawn key was freed BEFORE the reject, so a re-fire is not wedged as a duplicate.
    expect(subagents.liveByKey('ritual:morning-brief', 'owner')).toBeUndefined()
    // The substrate turn never launched (startup failed).
    expect(turn).not.toHaveBeenCalled()
  })
})

describe('createRitualExecutor.fire — sync launch-construction failure (task 6R Blocker B)', () => {
  test('resolve_model throws synchronously → run settles crashed, spawn key freed, fire() resolves; a re-fire is admitted', async () => {
    // Blocker B: step (f) evaluates `deps.resolve_model()` SYNCHRONOUSLY during the
    // turn() argument construction — AFTER the durable 'running' row + the live
    // `ritual:<id>` registry record exist. A sync throw must route through the SAME
    // settleCrashed path as a promise rejection (run 'crashed', spawn key freed) and
    // fire() must RESOLVE (occurrence legitimately consumed — no claim revert, no
    // stuck 'running', no live-key wedge).
    const registry = registryWith(def())
    const rec = recordingOutbound()
    let modelCalls = 0
    let n = 0
    const turn = mock(async (): Promise<RitualTurnResult> => ({ result: 'ok', status: 'completed' }))
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: rec.outbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => {
        modelCalls += 1
        if (modelCalls === 1) throw new Error('model boom')
        return 'm'
      },
      scope_cwd: () => '/s',
      build_approval_check: () => approver(true),
      mint_run_id: () => `sub-${n++}`,
    })

    // The sync throw during launch construction is caught → settleCrashed → resolve.
    await expect(exec.fire(await ritualRow('morning-brief'))).resolves.toBeUndefined()

    // Exactly one registry record, terminal 'crashed' → the spawn key is freed.
    expect(subagents.snapshot()).toHaveLength(1)
    const crashedRunId = subagents.snapshot()[0]!.run_id
    expect(subagents.byRunId(crashedRunId)!.status).toBe('crashed')
    expect(subagents.liveByKey('ritual:morning-brief', 'owner')).toBeUndefined()

    // The run-history row (shares the subagent run_id) settled 'crashed' + reason.
    const crashed = runs.get(crashedRunId)!
    expect(crashed.status).toBe('crashed')
    expect(crashed.failure_reason).toContain('model boom')

    // The turn NEVER launched (resolve_model threw before turn was invoked), and a
    // failure notice WAS posted (settleCrashed awaited before fire() resolved).
    expect(turn).not.toHaveBeenCalled()
    expect(rec.posts.length).toBeGreaterThanOrEqual(1)
    expect(rec.posts[0]!.body).toContain('morning-brief')

    // REGRESSION — the freed key admits a re-fire (before the fix the still-live
    // `ritual:<id>` key refused the next occurrence as a duplicate). The second fire
    // launches normally and settles.
    const row2 = await ritualRow('morning-brief')
    await exec.fire(row2)
    expect(subagents.snapshot()).toHaveLength(2)
    const live = subagents.snapshot().find((s) => s.run_id !== crashedRunId)!
    await waitTerminal(live.run_id)
    expect(turn).toHaveBeenCalledTimes(1)
  })

  test('turn() throwing synchronously (non-promise) settles crashed identically', async () => {
    // Same hazard via the turn() invocation itself throwing synchronously (rather
    // than returning a rejected promise) — must land the identical crashed settle.
    const registry = registryWith(def())
    const rec = recordingOutbound()
    let n = 0
    const turn = mock((): Promise<RitualTurnResult> => {
      throw new Error('sync turn boom')
    })
    const exec = createRitualExecutor({
      registry,
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: rec.outbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'm',
      scope_cwd: () => '/s',
      build_approval_check: () => approver(true),
      mint_run_id: () => `sub-${n++}`,
    })

    await expect(exec.fire(await ritualRow('morning-brief'))).resolves.toBeUndefined()

    expect(subagents.snapshot()).toHaveLength(1)
    const crashedRunId = subagents.snapshot()[0]!.run_id
    expect(subagents.byRunId(crashedRunId)!.status).toBe('crashed')
    expect(subagents.liveByKey('ritual:morning-brief', 'owner')).toBeUndefined()

    const crashed = runs.get(crashedRunId)!
    expect(crashed.status).toBe('crashed')
    expect(crashed.failure_reason).toContain('sync turn boom')
    expect(rec.posts.length).toBeGreaterThanOrEqual(1)
  })
})

// ── T3 — completion delivery + failure surfacing (plan task 5) ──────────────
describe('createRitualExecutor.fire — completion delivery (task 5)', () => {
  /** Build an executor whose turn is `turn`, with a recording outbound. */
  function execWith(
    turn: RitualTurn,
    opts: {
      registry?: RitualRegistry
      scope_cwd?: () => string
      mint?: () => string
    } = {},
  ): { exec: ReturnType<typeof createRitualExecutor>; posts: ReminderOutboundInput[] } {
    const rec = recordingOutbound()
    let n = 0
    const exec = createRitualExecutor({
      registry: opts.registry ?? registryWith(def()),
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: rec.outbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'm',
      scope_cwd: opts.scope_cwd ?? ((): string => '/s'),
      build_approval_check: () => approver(true),
      mint_run_id: opts.mint ?? ((): string => `sub-${n++}`),
    })
    return { exec, posts: rec.posts }
  }

  test('(a) finished non-silent → artifact on disk + durable history row + one post', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'neutron-ritual-repo-'))
    const marker = join(repo, 'BRIEF.md')
    const turn: RitualTurn = async (input) => {
      writeFileSync(join(input.repo_path, 'BRIEF.md'), 'ran', 'utf8')
      return { result: 'Brief: 3 things today', status: 'completed' }
    }
    const { exec, posts } = execWith(turn, { scope_cwd: () => repo, mint: () => 'sub-a' })
    await exec.fire(await ritualRow('morning-brief'))
    await waitFor(() => posts.length >= 1)

    // artifact-on-disk: the turn actually ran and wrote the file.
    expect(existsSync(marker)).toBe(true)
    // exactly one post, to the resolved topic, carrying the final text.
    expect(posts).toHaveLength(1)
    expect(posts[0]!.topic_id).toBe('app:owner-topic')
    expect(posts[0]!.body).toContain('Brief: 3 things today')
    // durable history row: finished, output_summary carries the text.
    const row = runs.get('sub-a')!
    expect(row.status).toBe('finished')
    expect(row.output_summary).toContain('Brief: 3 things today')
    rmSync(repo, { recursive: true, force: true })
  })

  test('(b) silent finished → row finished, NO post', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'neutron-ritual-repo-'))
    const turn: RitualTurn = async (input) => {
      writeFileSync(join(input.repo_path, 'BRIEF.md'), 'ran', 'utf8')
      return { result: 'quiet output', status: 'completed' }
    }
    const { exec, posts } = execWith(turn, {
      registry: registryWith(def({ silent: true })),
      scope_cwd: () => repo,
      mint: () => 'sub-silent',
    })
    await exec.fire(await ritualRow('morning-brief'))
    await waitTerminal('sub-silent')
    // give any (erroneous) late post a chance to land, then assert none.
    await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(join(repo, 'BRIEF.md'))).toBe(true)
    expect(runs.get('sub-silent')!.status).toBe('finished')
    expect(posts).toHaveLength(0)
    rmSync(repo, { recursive: true, force: true })
  })

  test('(d) finished non-silent with EMPTY output → completion fallback line', async () => {
    const turn: RitualTurn = async () => ({ result: '   ', status: 'completed' })
    const { exec, posts } = execWith(turn, { mint: () => 'sub-empty' })
    await exec.fire(await ritualRow('morning-brief'))
    await waitFor(() => posts.length >= 1)
    expect(posts[0]!.body).toBe("Ritual 'morning-brief' finished (run sub-empty): no output.")
  })

  test.each([
    ['failed', /Ritual 'morning-brief' failed \(run .+\)/],
    ['timed_out', /Ritual 'morning-brief' timed_out \(run .+\)/],
  ] as const)('(c) turn status %s → exactly one failure notice', async (status, re) => {
    const turn: RitualTurn = async () => ({ result: '', status })
    const { exec, posts } = execWith(turn, { mint: () => `sub-${status}` })
    await exec.fire(await ritualRow('morning-brief'))
    await waitFor(() => posts.length >= 1)
    await new Promise((r) => setTimeout(r, 10))
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toMatch(re)
  })

  test('(c) turn CANCELLED → durable cancelled row, NO failure notice', async () => {
    // Operator/shutdown abort is not a merit failure (Argus r1 minor): the row is
    // 'cancelled' and NO scary failure notice is posted.
    const turn: RitualTurn = async () => ({ result: 'partial before abort', status: 'cancelled' })
    const { exec, posts } = execWith(turn, { mint: () => 'sub-cancel' })
    await exec.fire(await ritualRow('morning-brief'))
    await waitTerminal('sub-cancel')
    // give any (erroneous) late post a chance to land, then assert none.
    await new Promise((r) => setTimeout(r, 20))
    expect(runs.get('sub-cancel')!.status).toBe('cancelled')
    expect(posts).toHaveLength(0)
  })

  test('(c) turn REJECTS → crashed failure notice carrying the run id', async () => {
    const turn: RitualTurn = async () => {
      throw new Error('substrate exploded')
    }
    const { exec, posts } = execWith(turn, { mint: () => 'sub-crash' })
    await exec.fire(await ritualRow('morning-brief'))
    await waitFor(() => posts.length >= 1)
    expect(posts[0]!.body).toMatch(/Ritual 'morning-brief' crashed \(run sub-crash\)/)
  })

  test('(c) spawn refusal → failure notice posted for the refused attempt', async () => {
    // saturate the ritual lane so the executor spawn is refused.
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
    const turn = mock(async (): Promise<RitualTurnResult> => ({ result: '', status: 'completed' }))
    const { exec, posts } = execWith(turn, { mint: () => 'refused-1' })
    await exec.fire(await ritualRow('morning-brief'))
    await waitFor(() => posts.length >= 1)
    expect(posts[0]!.body).toMatch(/Ritual 'morning-brief' failed \(run .+\)/)
    expect(turn).not.toHaveBeenCalled()
  })
})

describe('createRitualExecutor.fire — escalation (task 5)', () => {
  const escalations = (posts: ReminderOutboundInput[]): number =>
    posts.filter((p) => /failed 3 consecutive runs/.test(p.body)).length

  test('3 consecutive failures → exactly one escalation; 4th → still one; success then 3 → a second', async () => {
    const rec = recordingOutbound()
    let n = 0
    const turnResult: { status: RitualTurnResult['status'] } = { status: 'failed' }
    const turn: RitualTurn = async () => ({ result: '', status: turnResult.status })
    const exec = createRitualExecutor({
      registry: registryWith(def()),
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: rec.outbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'm',
      scope_cwd: () => '/s',
      build_approval_check: () => approver(true),
      mint_run_id: () => `run-${n++}`,
    })

    // Fire one ritual run and wait for its full settle+surface chain to drain.
    async function fireOne(id: string): Promise<void> {
      const before = rec.posts.length
      await exec.fire(await ritualRow('morning-brief'))
      await waitTerminal(id)
      // the failure/success notice for THIS run marks the settle chain done.
      await waitFor(() => rec.posts.length > before)
      // small drain so the escalation post (which follows the failure post) lands.
      await new Promise((r) => setTimeout(r, 15))
    }

    // 3 consecutive failures → one escalation.
    await fireOne('run-0')
    await fireOne('run-1')
    await fireOne('run-2')
    expect(escalations(rec.posts)).toBe(1)

    // 4th failure → still exactly one (the streak already escalated).
    await fireOne('run-3')
    expect(escalations(rec.posts)).toBe(1)

    // a success (resets the streak; non-silent → posts final text), then 3 more failures.
    turnResult.status = 'completed'
    await fireOne('run-4')
    turnResult.status = 'failed'
    await fireOne('run-5')
    await fireOne('run-6')
    await fireOne('run-7')
    expect(escalations(rec.posts)).toBe(2)
  })
})

describe('createRitualExecutor.fire — delivery resilience (task 5)', () => {
  test('(f) outbound.post rejects → run row still terminal, fire settles, no throw', async () => {
    const throwing: ReminderOutbound = {
      post: async () => {
        throw new Error('deliver down')
      },
    }
    const turn: RitualTurn = async () => ({ result: 'done', status: 'completed' })
    const exec = createRitualExecutor({
      registry: registryWith(def()),
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound: throwing,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'm',
      scope_cwd: () => '/s',
      build_approval_check: () => approver(true),
      mint_run_id: () => 'sub-resil',
    })
    await expect(exec.fire(await ritualRow('morning-brief'))).resolves.toBeUndefined()
    const settled = await waitTerminal('sub-resil')
    expect(settled!.status).toBe('finished')
  })
})

// ── Argus r3 fixes — postNotice retry (§267) + truncation ownership ──────────
describe('createRitualExecutor.fire — postNotice retry + truncation (task 5R)', () => {
  /** An outbound whose post returns booleans from `script` (last value sticks). */
  function scriptedOutbound(script: boolean[]): {
    post: ReturnType<typeof mock>
    outbound: ReminderOutbound
  } {
    let i = 0
    const post = mock(async (_i: ReminderOutboundInput): Promise<boolean> => {
      const v = i < script.length ? script[i]! : script[script.length - 1]!
      i++
      return v
    })
    return { post, outbound: { post } }
  }

  function buildExec(turn: RitualTurn, outbound: ReminderOutbound, mint: string): ReturnType<typeof createRitualExecutor> {
    return createRitualExecutor({
      registry: registryWith(def()),
      approvals: new ApprovalManager(db, noopNotifier),
      project_slug: 'owner',
      instance_key: 'owner',
      subagents,
      outbound,
      resolve_topic: resolveTopic,
      turn,
      runs,
      resolve_model: () => 'm',
      scope_cwd: () => '/s',
      build_approval_check: () => approver(true),
      mint_run_id: () => mint,
    })
  }

  test('(a) post()==false → ONE retry then a logged failure notice (§267): exactly 2 calls, no throw', async () => {
    const { post } = scriptedOutbound([false, false])
    const turn: RitualTurn = async () => ({ result: 'boom', status: 'failed' })
    const exec = buildExec(turn, { post }, 'sub-pf')
    // A single failure → one failure notice (no escalation) → post retried once.
    await expect(exec.fire(await ritualRow('morning-brief'))).resolves.toBeUndefined()
    await waitFor(() => post.mock.calls.length >= 2)
    await new Promise((r) => setTimeout(r, 10))
    expect(post).toHaveBeenCalledTimes(2)
  })

  test('(a) post() false then true → 2 calls, notice delivered, no error', async () => {
    const { post } = scriptedOutbound([false, true])
    const turn: RitualTurn = async () => ({ result: 'boom', status: 'failed' })
    const exec = buildExec(turn, { post }, 'sub-pft')
    await expect(exec.fire(await ritualRow('morning-brief'))).resolves.toBeUndefined()
    await waitFor(() => post.mock.calls.length >= 2)
    await new Promise((r) => setTimeout(r, 10))
    expect(post).toHaveBeenCalledTimes(2)
  })

  test('(b) long failure reason is whitespace-COLLAPSED then capped at 160 (formatter owns truncation)', async () => {
    // Internal whitespace runs — the pre-fix executor `.slice(0,160)` truncated
    // BEFORE collapse and under-filled the notice. The formatter now owns both.
    const raw = 'x  y '.repeat(80) // 400 chars, double-spaced
    const turn: RitualTurn = async () => ({ result: raw, status: 'failed' })
    const rec = recordingOutbound()
    const exec = buildExec(turn, rec.outbound, 'sub-trunc')
    await exec.fire(await ritualRow('morning-brief'))
    await waitFor(() => rec.posts.length >= 1)
    const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
    const expectedCollapsed = oneLine(raw).slice(0, 160)
    expect(expectedCollapsed.length).toBe(160)
    expect(rec.posts[0]!.body.endsWith(expectedCollapsed)).toBe(true)
  })
})
