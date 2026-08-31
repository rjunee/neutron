import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'
import { buildCoreModules } from './build-core-modules.ts'

let tmp: string
let db: ProjectDb
/** Scratch directories created outside `tmp` (real git repos) — removed after each test. */
let scratchDirs: string[]
/** Individual scratch FILES the run-evidence probes are meant to see — removed after each test. */
let scratchFiles: string[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-liveness-wiring-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  scratchDirs = []
  scratchFiles = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  for (const file of scratchFiles) rmSync(file, { force: true })
})

/**
 * A UNIQUE run id per test. The run-evidence probes search the REAL process table
 * and the REAL scratch directory for the run id, so a literal id shared with
 * another lane on this machine — or with any argv or leftover file — would decide
 * this test from something other than what it seeded. `randomUUID` is also
 * comfortably past the probes' MIN_SCANNABLE_RUN_ID floor.
 */
function runId(): string {
  return crypto.randomUUID()
}

/** A real, one-commit git repository — the branch-ref probe needs a repo to answer about. */
async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-trident-liveness-repo-'))
  scratchDirs.push(dir)
  for (const cmd of [
    ['git', 'init', '-q', '-b', 'main', '.'],
    ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'],
  ]) {
    const res = await spawnCapture(cmd, dir)
    if (!res.ok) throw new Error(`repo setup failed: ${cmd.join(' ')}: ${res.stderr}`)
  }
  return dir
}

const fakeCtx: ModuleContext = {
  graph: { get: () => ({}) as never, names: () => [] },
  config: {},
}

function baseInput(): CompositionInput {
  return {
    db,
    project_slug: 'alice',
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
  }
}

function tridentInput(probe_launcher_alive?: NonNullable<CompositionInput['trident']>['probe_launcher_alive']): CompositionInput {
  return {
    ...baseInput(),
    trident: {
      fire_inner_workflow: async () => ({ status: 'fired', error: null }),
      run_host: async () => ({ ok: true, stdout: 'main', stderr: '', exit_code: 0 }),
      delivery_sink: { send: async () => '' },
      ...(probe_launcher_alive === undefined ? {} : { probe_launcher_alive }),
    },
  }
}

async function seedRunning(id: string, generation: string, repo_path = '/repo'): Promise<void> {
  const store = new TridentRunStore(db)
  await store.create({ id, slug: id, project_slug: 'alice', repo_path, task: 'build' })
  await store.update(id, {
    phase: 'ralph-task',
    branch: 'trident/test',
    pr: 312,
    inner_checkpoint: 'ralph-task-built',
    subagent_run_id: 'wf-wire-1',
    subagent_status: 'running',
    workflow_run_id: generation,
  })
}

describe('trident external liveness composition wiring', () => {
  test('an absent probe preserves the two existing timers', async () => {
    const mods = buildCoreModules(tridentInput())
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      expect(instance.loop.describeAll().map((descriptor) => descriptor.name)).toEqual(['trident', 'trident-watch'])
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })

  test('a wired probe exposes the default 15 second timer', async () => {
    const mods = buildCoreModules(tridentInput(async () => 'dead'))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      expect(instance.loop.describeAll()).toContainEqual(expect.objectContaining({ name: 'trident-liveness', cadenceMs: 15_000 }))
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })

  test('positive launcher death enters the existing durable recovery path', async () => {
    const mods = buildCoreModules(tridentInput(async () => 'dead'))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedRunning('dead-run', 'gen-wire-1')
      await instance.loop.runLivenessOnce()
      const after = new TridentRunStore(db).get('dead-run')!
      expect(after.phase).toBe('ralph-task')
      expect(after.subagent_status).toBe('crashed')
      expect(after.subagent_run_id).toBe('wf-wire-1')
      expect(after.workflow_run_id).toBe('gen-wire-1')
      expect(after.failure_reason).toStartWith('inner workflow launcher crashed:')
      expect(after.failure_reason).toContain('gen-wire-1')
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })

  test('alive evidence leaves the running row untouched', async () => {
    const mods = buildCoreModules(tridentInput(async () => 'alive'))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedRunning('alive-run', 'gen-alive-1')
      await instance.loop.runLivenessOnce()
      expect(new TridentRunStore(db).get('alive-run')!.subagent_status).toBe('running')
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })
})

/**
 * THE PROBE'S POSITIVE ANSWER, READ BY THE HANG WATCHDOG.
 *
 * The liveness loop above acts ONLY on a positive 'dead' (`tick.ts`: "if (verdict !==
 * 'dead') continue"), so the one fact that could spare a working build — 'alive' — was
 * computed every 15 seconds and thrown away, while the 90-minute reaper killed lanes
 * that were demonstrably running.
 *
 * WIRED, NOT JUST WRITTEN. This repo has landed a module plus its unit tests five times
 * in one night and skipped the registration, so a green merge delivered no behaviour.
 * These drive the REAL composed orchestrator and assert the probe was CONSULTED and
 * ACTED ON, rather than asserting a seam that production may never pass.
 */
describe('trident hang-watchdog wiring — the composed orchestrator consults the launcher probe', () => {
  /** Age a run's advancement clock past the 90-minute hang threshold, in SQL — the
   *  store deliberately re-stamps `last_advanced_at` on every save. Returns the stamp
   *  it wrote, so a test can assert whether the composed tick MOVED it. */
  const ageBeyondHangThreshold = (id: string): string => {
    const aged = new Date(Date.now() - 100 * 60_000).toISOString()
    db.raw().run('UPDATE code_trident_runs SET last_advanced_at = ? WHERE id = ?', [aged, id])
    return aged
  }

  test('an ALIVE launcher spares a run the 90-minute reaper would have killed', async () => {
    let probed = 0
    const mods = buildCoreModules(
      tridentInput(async () => {
        probed += 1
        return 'alive'
      }),
    )
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedRunning('watchdog-alive', 'gen-watchdog-1')
      const aged = ageBeyondHangThreshold('watchdog-alive')
      await instance.loop.runOnce()

      const after = new TridentRunStore(db).get('watchdog-alive')!
      expect(probed).toBeGreaterThan(0)
      expect(after.phase).not.toBe('failed')
      expect(after.failure_reason ?? '').not.toContain('suspected agent hang')
      // AND THE CLOCK DID NOT MOVE. The real gatherer answers nothing/nothing/unknown
      // for this run, so the only thing sparing it is the launcher — a SHARED
      // GENERATION, not this run — and a generation-scoped answer must not renew this
      // run's window (T4), or the 2 h ceiling would never be reachable.
      expect(after.last_advanced_at).toBe(aged)
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })

  test('a POSITIVELY QUIET run still reaps — and the terminal record DISCLOSES what was checked', async () => {
    // THE COMPOSED POSITIVE CONTROL. This test used to reap an UNQUERYABLE world,
    // which is precisely the premise the card overturns: a probe that could not run
    // may no longer authorise a kill. So the world here is positively quiet instead —
    // a real repository that does not carry the run's branch (ref probe answers
    // `nothing`), a run id no argv on this machine carries and no scratch file
    // mentions, and a worktree path that does not exist. Quiet, not unreadable.
    //
    // Both directions matter: a watchdog that can no longer kill anything is the same
    // family of bug as one that kills everything. This is the direction that proves the
    // reap is still reachable through the REAL composed orchestrator, and that the
    // terminal record names all three probes and what each of them answered — every one
    // of the reaped rows in the live DB carried the bare "suspected agent hang" string
    // and disclosed no evidence at all.
    const id = runId()
    const repo = await makeRepo()
    const mods = buildCoreModules(tridentInput(async () => 'unknown'))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedRunning(id, 'gen-watchdog-2', repo)
      ageBeyondHangThreshold(id)
      await instance.loop.runOnce()

      const after = new TridentRunStore(db).get(id)!
      expect(after.phase).toBe('failed')
      expect(after.failure_reason ?? '').toContain('suspected agent hang')
      expect(after.failure_reason ?? '').toMatch(/liveness checked:/)
      expect(after.failure_reason ?? '').toContain('launcher probe=unknown')
      // The three run-scoped clauses, verbatim from `describeRunEvidence`.
      expect(after.failure_reason ?? '').toContain('run process=none observed')
      expect(after.failure_reason ?? '').toContain('no run artifacts found')
      expect(after.failure_reason ?? '').toContain('no branch ref movement recorded')
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  }, 20_000)

  test('a fresh run-scoped artifact spares a run the reaper would have killed', async () => {
    // NO launcher probe is wired here, and the run has no stage events, so the ONLY
    // thing that can spare this run is the run-evidence seam reading the artifact
    // written below. That is deliberate: this test fails on a tree where the gatherer
    // is built but never handed to the orchestrator, so it pins CONSULTATION rather
    // than construction. It is also the exact incident — lanes reported 57-85 minutes
    // "stale" while writing log output that same second.
    const id = runId()
    const mods = buildCoreModules(tridentInput())
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedRunning(id, 'gen-watchdog-3')
      const aged = ageBeyondHangThreshold(id)
      const artifact = join(tmpdir(), `trident-${id}.out`)
      scratchFiles.push(artifact)
      writeFileSync(artifact, 'forge is writing this second\n')
      await instance.loop.runOnce()

      const after = new TridentRunStore(db).get(id)!
      expect(after.phase).not.toBe('failed')
      expect(after.failure_reason ?? '').not.toContain('suspected agent hang')
      // AND THE COMPOSED STALENESS CLOCK MOVED. The artifact is RUN-SCOPED evidence, so
      // the spare re-stamps `last_advanced_at` end to end (T4) — this is the phantom
      // staleness fix, observable through the real composition rather than at a seam.
      expect(after.last_advanced_at).not.toBe(aged)
      expect(Date.parse(after.last_advanced_at)).toBeGreaterThan(Date.parse(aged))
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  }, 20_000)

  test('an unqueryable world DEFERS instead of reaping', async () => {
    // The repo path does not exist, so the real `git -C … log -g` exits 128 with
    // "cannot change to" — which is NOT one of git's positively-missing-ref wordings.
    // A look that could not happen is `unknown`, and unknown may not authorise a kill:
    // the run stays exactly as it was, to be re-examined on the next tick.
    const id = runId()
    const mods = buildCoreModules(tridentInput())
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedRunning(id, 'gen-watchdog-4')
      const aged = ageBeyondHangThreshold(id)
      await instance.loop.runOnce()

      const after = new TridentRunStore(db).get(id)!
      expect(after.phase).toBe('ralph-task')
      expect(after.subagent_status).toBe('running')
      expect(after.failure_reason).toBeNull()
      // AND NOTHING WAS WRITTEN. A DEFER never re-stamps the clock (T4): an unknown
      // check must not manufacture progress the run never demonstrated.
      expect(after.last_advanced_at).toBe(aged)
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  }, 20_000)
})
