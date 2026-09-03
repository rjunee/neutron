import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { FIRE_PUBLISHED_REASON_MARKER, FIRE_SETTLE_TIMEOUT_ERROR } from '@neutronai/trident/fire-evidence.ts'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'
import { buildCoreModules } from './build-core-modules.ts'

let tmp: string
let db: ProjectDb
/** Scratch directories created outside `tmp` (real git repos and worktrees) — removed after each test. */
let scratchDirs: string[]
/** Individual scratch FILES the real firer writes (`writeBriefParts`) — removed after each test. */
let scratchFiles: string[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-fire-evidence-wiring-'))
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

/** A real, one-commit git repository — the branch-holder probe needs a repo to answer about. */
async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-trident-fire-evidence-repo-'))
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

/** THE ONE FIRE OUTCOME THIS GATE IS SCOPED TO — the launcher never settled. */
const TIMEOUT_OUTCOME = { status: 'failed', error: FIRE_SETTLE_TIMEOUT_ERROR } as const

type RunHost = NonNullable<NonNullable<CompositionInput['trident']>['run_host']>

/** The liveness wiring test's canned host: every git command answers `main`. */
const PLAIN_HOST: RunHost = async () => ({ ok: true, stdout: 'main', stderr: '', exit_code: 0 })

function timeoutFireInput(run_host: RunHost): CompositionInput {
  return {
    ...baseInput(),
    trident: {
      fire_inner_workflow: async () => TIMEOUT_OUTCOME,
      run_host,
      delivery_sink: { send: async () => '' },
    },
  }
}

/**
 * Seed a FRESH run the way a real dispatch does — `create` defaults are load-bearing
 * (phase `forge-init`, merge_mode `local`), because a fresh local-mode run reaches the
 * fire on the FIRST `runOnce()`. The real firer writes the brief `.part` files for the
 * run id, so they are registered for cleanup here.
 */
async function seedFreshRun(id: string, repo_path: string, branch: string): Promise<void> {
  const store = new TridentRunStore(db)
  await store.create({ id, slug: id, project_slug: 'alice', repo_path, task: 'build', branch })
  scratchFiles.push(join('/tmp', `trident-brief-${id}-task.part`), join('/tmp', `trident-brief-${id}-reflection.part`))
}

/**
 * THE COMPOSED PROOF THAT THE GATHERER IS WIRED, NOT MERELY WRITTEN.
 *
 * `trident/fire-evidence.ts` and `trident/fire-evidence-probes.ts` landed green with
 * full unit suites while production still passed no gatherer at all — i.e. the fix was
 * built, tested, and INERT. These tests drive the REAL composed orchestrator through
 * `buildCoreModules` and assert the evidence was CONSULTED and ACTED ON, so they fail
 * on any tree where the gatherer exists but is never handed to the orchestrator.
 */
// ARGUS r4 (major): the `branch_live` hold created for a WORKTREE-ONLY holder has
// no run whose terminalization fires the hold sweep, so on a quiet instance the
// queued card never drains. The composed tick loop now drives the same sweep on
// its own cadence — this proves the option is WIRED at the composition root, not
// merely accepted by the type.
//
// AND THE WIRE IS ALL THIS PROVES, DELIBERATELY (Argus r5). `buildCoreModules`
// has no default sweep to drive: the production drain is composed one level up
// (`open/composer.ts` passes `drain_dispatch_holds: () => tridentHoldSweep()`),
// so a behavioural assertion here would exercise a sweep this file built itself
// — proving nothing about production. The DRAIN'S BEHAVIOUR is pinned where the
// sweep really is: `trident/dispatch-holds.test.ts` ("a FIRST-EVER dispatch
// refused on branch liveness is QUEUED, and the sweep fires it later" seeds a
// hold, frees the holder, and asserts the row is gone and the run created; "the
// sweep drains with NO run argument at all" pins the tick-cadence trigger), and
// its cadence and failure-containment in `trident/tick.test.ts`.
//
// SO THE END-TO-END PATH IS PINNED IN TWO HALVES, ON PURPOSE (Argus r10, which
// read this test's `expect(drained).toBe(1)` as leaving tick -> real sweep
// unpinned). This half proves the composed tick CALLS whatever drain it was
// handed; `open/__tests__/open-dispatch-hold-drain-wiring.test.ts` takes the
// drain the PRODUCTION composer built — not one a test wrote — and proves that
// calling it moves real hold state (a seeded row for a card that is on no board
// is gone afterwards). Joining them in one test would mean building the sweep
// here, which is exactly the self-proof the paragraph above declines.
//
// INCLUDING THE TRANSITION BOUNDARY (Argus r3). The state case that motivated
// this seam — a hold seeded BEFORE the card's own run went live, refused with
// "nothing stays queued", then that run STOPPED — is pinned over the real store
// and the real sweep by "the branch_live refusal behind the card's own live run
// leaves NOTHING for the sweep to re-fire" in the same file.
describe('trident hold-drain composition wiring — the composed tick drains the dispatch-hold queue', () => {
  test('drain_dispatch_holds is called by the composed loop on an ordinary tick', async () => {
    let drained = 0
    const input = timeoutFireInput(PLAIN_HOST)
    input.trident!.drain_dispatch_holds = async () => {
      drained += 1
    }
    const mods = buildCoreModules(input)
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await instance.loop.runOnce()
      expect(drained).toBe(1)
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  }, 20_000)
})

describe('trident fire-evidence composition wiring — the composed orchestrator consults settle-timeout evidence', () => {
  test('a settle-timeout fire over a branch held by a LIVE worktree lock holds the lane instead of terminalizing it', async () => {
    const id = crypto.randomUUID()
    const repo = await makeRepo()
    const branch = `trident/${id}`
    const wt = join(mkdtempSync(join(tmpdir(), 'neutron-trident-fire-evidence-wt-')), 'wt')
    scratchDirs.push(wt)
    for (const cmd of [
      ['git', '-C', repo, 'worktree', 'add', wt, '-b', branch],
      // The lock reason must match `WORKTREE_LOCK_PID` (`/pid (\d+)( start (\d+))?/`).
      // `start` is OMITTED deliberately: with no recorded starttime the signal-0 answer
      // on our OWN live pid is what decides, which is the fact this test is about.
      ['git', '-C', repo, 'worktree', 'lock', '--reason', `claude agent test (pid ${process.pid})`, wt],
    ]) {
      const res = await spawnCapture(cmd, repo)
      if (!res.ok) throw new Error(`worktree setup failed: ${cmd.join(' ')}: ${res.stderr}`)
    }

    const mods = buildCoreModules(timeoutFireInput(PLAIN_HOST))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedFreshRun(id, repo, branch)
      await instance.loop.runOnce()

      // The composed gatherer re-reads the row (no workflow-owned delta, no published
      // checkpoint), then probes the REAL repo with REAL git: the linked worktree holds
      // `refs/heads/<branch>` under a live lock pid → `launched` → the lane is HELD.
      const after = new TridentRunStore(db).get(id)!
      expect(isTerminalPhase(after.phase)).toBe(false)
      expect(after.subagent_status).toBe('running')
      expect(after.failure_reason).toBeNull()
      expect(after.subagent_run_id).not.toBeNull()
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  }, 20_000)

  test('a settle-timeout fire over a row that already says outer-published is recorded as built-and-published, review not run', async () => {
    const id = crypto.randomUUID()
    const sha = '7'.repeat(40)
    const checkpoint = `outer-published:${sha}:0:3`
    const store = new TridentRunStore(db)
    // The repo path DELIBERATELY does not exist: the row is the cheapest evidence there
    // is and must answer BEFORE any git runs. Were the seam misordered, the probe would
    // fail into `none` and this assertion would catch it.
    const mods = buildCoreModules(
      // SHAPED host — with the plain always-`main` stub `resolveResumeLiveHead` reads a
      // non-hex head and the launcher takes the resume-head bounded stop BEFORE the fire.
      timeoutFireInput(async (cmd: string[]) => ({
        ok: true,
        stdout: cmd.includes('rev-parse') ? sha : 'main',
        stderr: '',
        exit_code: 0,
      })),
    )
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedFreshRun(id, '/repo', `trident/${id}`)
      await store.update(id, { inner_checkpoint: checkpoint })
      await instance.loop.runOnce()

      const after = new TridentRunStore(db).get(id)!
      expect(after.phase).toBe('failed')
      expect(after.failure_reason ?? '').toContain(FIRE_PUBLISHED_REASON_MARKER)
      expect(after.failure_reason ?? '').toContain('review not run')
      expect(after.failure_reason ?? '').not.toContain('fire failed')
      expect(after.inner_verdict).toBe('REVIEW_NOT_RUN')
      expect(after.inner_checkpoint).toBe(checkpoint)
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  }, 20_000)

  test('a settle-timeout fire with NO evidence composed still fails byte-identically', async () => {
    // THE MUST-PASS SIBLING — green before AND after the wiring. Positive evidence only:
    // no worktree holds the branch and the row says nothing, so the run records exactly
    // today's failure, character for character.
    const id = crypto.randomUUID()
    const repo = await makeRepo()
    const mods = buildCoreModules(timeoutFireInput(PLAIN_HOST))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedFreshRun(id, repo, `trident/${id}`)
      await instance.loop.runOnce()

      const after = new TridentRunStore(db).get(id)!
      expect(after.phase).toBe('failed')
      expect(after.failure_reason).toBe(`inner workflow fire failed: ${FIRE_SETTLE_TIMEOUT_ERROR}`)
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  }, 20_000)
})
