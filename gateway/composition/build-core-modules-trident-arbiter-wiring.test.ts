/**
 * #541 — the arbiter tier reaches the COMPOSED orchestrator, asserted BEHAVIOURALLY.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SOURCE ASSERTION IT REPLACES. The first
 * version of this guard matched the text
 * `orchestratorOpts.arbitrate = tridentWiring.arbitrate` in
 * `build-core-modules.ts`. That is green against the line sitting in dead code, or
 * behind a condition that never fires, or after a `return` — the whole class of bug
 * the `resolve_phase_models` lesson is about. So this drives the REAL composed
 * module: `buildCoreModules` → `tridentModule.init` → the real
 * `buildTridentOrchestrator` → the real `buildMergeCleanupDeps` → a scripted
 * `run_host` whose rebase conflicts, and asserts the arbiter this composition input
 * carried was actually CONSULTED, and that its decision was ACTED ON.
 *
 * HOW A RUN REACHES THE MERGE HERE. The composed orchestrator uses the REAL
 * mutation proof gate (`prove_mutation` is not a composition key, deliberately), so
 * the row has to pass it rather than have it stubbed out. It passes by the
 * prose-only exemption: the scripted host reports a diff of one markdown file, so
 * the gate exempts with its own reason and the run proceeds to the merge. That is a
 * real production path, not a bypass.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import type { HostCommandResult } from '@neutronai/trident/git-mode.ts'
import type { ArbitrationInput } from '@neutronai/trident/arbiter.ts'
import { CONFLICT_ARBITER_RETRY_OPTION } from '@neutronai/trident/merge.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'
import { buildCoreModules } from './build-core-modules.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-arbiter-wiring-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const fakeCtx: ModuleContext = {
  graph: { get: () => ({}) as never, names: () => [] },
  config: {},
}

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
const fail = (stderr = 'boom'): HostCommandResult => ({ ok: false, stdout: '', stderr, exit_code: 1 })

const BRANCH = 'trident/arbiter-wiring'
const HEAD_SHA = 'e'.repeat(40)
const RUN_ID = 'arbiter-wiring-run'
const REPO = '/composed-repo'
/** The per-run merge worktree path (`runWorktreePath`: repo/.trident-worktrees/<slug>-<id8>). */
const WT = `${REPO}/.trident-worktrees/${RUN_ID}-${RUN_ID.slice(0, 8)}`

/**
 * A host that takes the run to the merge and then conflicts ONCE in the run's own
 * merge worktree. Prose-only diff so the real mutation gate exempts; every ref
 * resolves to the same sha so no #542 drift is measured.
 */
type TridentWiring = NonNullable<CompositionInput['trident']>
type HostRunner = NonNullable<TridentWiring['run_host']>

function mergingHost(conflictRounds: number): { host: HostRunner; calls: string[] } {
  const calls: string[] = []
  let reported = 0
  const host: HostRunner = async (cmd) => {
    const joined = cmd.join(' ')
    calls.push(joined)
    // The branch name is checked before any git operand use.
    if (cmd.includes('check-ref-format')) return ok()
    // THE PROSE-ONLY DIFF the real mutation gate exempts on. `-z --name-status`
    // emits the status letter and the path as SEPARATE NUL-terminated records.
    if (cmd.includes('diff') && cmd.includes('--name-status')) {
      return ok('M\u0000docs/NOTES.md\u0000')
    }
    // The run's own rebase in its own worktree conflicts; the shared checkout's
    // recovery probes never do.
    const ownRebase = cmd.includes(WT) && cmd.includes('rebase') && !cmd.includes('--abort')
    if (ownRebase && reported < conflictRounds) {
      reported++
      return fail('CONFLICT (content): Merge conflict in docs/NOTES.md')
    }
    if (cmd.includes('diff') && cmd.includes('--diff-filter=U')) return ok('docs/NOTES.md')
    // Every ref resolves to the same commit: fork point == tip == head, so the
    // base-drift gate measures no movement.
    if (cmd.includes('rev-parse') || cmd.includes('merge-base')) return ok(HEAD_SHA)
    if (cmd.includes('symbolic-ref')) return ok('origin/main')
    return ok()
  }
  return { host, calls }
}

function inputWith(trident: Partial<TridentWiring>): CompositionInput {
  return {
    db,
    project_slug: 'alice',
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
    trident: {
      fire_inner_workflow: async () => ({ status: 'fired', error: null }),
      run_host: async () => ok(),
      delivery_sink: { send: async () => '' },
      ...trident,
    } as TridentWiring,
  }
}

/** An APPROVED, harvested local-mode run sitting exactly at the merge step. */
async function seedApproved(): Promise<void> {
  const store = new TridentRunStore(db)
  await store.create({
    id: RUN_ID,
    slug: RUN_ID,
    project_slug: 'alice',
    repo_path: REPO,
    task: 'write the notes',
  })
  await store.update(RUN_ID, {
    phase: 'argus',
    merge_mode: 'local',
    branch: BRANCH,
    pr: null,
    subagent_run_id: 'wf-arbiter-1',
    subagent_status: 'completed',
    inner_checkpoint: 'argus-approved',
    inner_result: JSON.stringify({
      ok: true,
      branch: BRANCH,
      verdict: 'APPROVE',
      round: 1,
      checkpoint: 'argus-approved',
      reviewedHead: HEAD_SHA,
    }),
  })
}

describe('#541 the arbiter tier is CONSULTED by the composed orchestrator', () => {
  test('a wired `arbitrate` reaches the real merge deps and its retry decision lands the build', async () => {
    const { host } = mergingHost(1)
    const seen: ArbitrationInput[] = []
    let resolverCalls = 0
    const mods = buildCoreModules(
      inputWith({
        run_host: host,
        resolve_conflict: async () => {
          resolverCalls++
          return resolverCalls === 1
            ? { resolved: false, question: 'docs/NOTES.md: which wording?' }
            : { resolved: true }
        },
        arbitrate: async (i) => {
          seen.push(i)
          return {
            kind: 'decision',
            option_id: CONFLICT_ARBITER_RETRY_OPTION,
            reasoning: 'both paragraphs are additive',
          }
        },
      }),
    )
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedApproved()
      // Tick until the row goes terminal (or we run out of patience).
      for (let i = 0; i < 12; i++) {
        const row = new TridentRunStore(db).get(RUN_ID)
        if (row !== null && (row.phase === 'done' || row.phase === 'failed')) break
        await instance.loop.runOnce()
      }
      // THE ASSERTION: the arbiter this composition input carried was consulted by
      // the orchestrator the composition built. A `arbitrate` that never reaches
      // `orchestratorOpts` — or a line that sits in dead code — makes this zero.
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]?.run.id).toBe(RUN_ID)
      // Rooted at the run's own merge worktree, not the shared checkout.
      expect(seen[0]?.repo_path).toBe(WT)
      // And ACTED ON: the resolver was re-dispatched carrying the reasoning.
      expect(resolverCalls).toBe(2)
      expect(new TridentRunStore(db).get(RUN_ID)?.phase).toBe('done')
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  }, 20_000)

  test('NO `arbitrate` in the composition input leaves the escalation on the owner path', async () => {
    // The control, through the same composed path: absent, the escalation reaches
    // the owner with the resolver's own question as the failure reason.
    const { host } = mergingHost(1)
    const question = 'docs/NOTES.md: which wording?'
    let resolverCalls = 0
    const mods = buildCoreModules(
      inputWith({
        run_host: host,
        resolve_conflict: async () => {
          resolverCalls++
          return { resolved: false, question }
        },
      }),
    )
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedApproved()
      for (let i = 0; i < 12; i++) {
        const row = new TridentRunStore(db).get(RUN_ID)
        if (row !== null && (row.phase === 'done' || row.phase === 'failed')) break
        await instance.loop.runOnce()
      }
      const row = new TridentRunStore(db).get(RUN_ID)
      expect(resolverCalls).toBe(1)
      expect(row?.phase).toBe('failed')
      expect(row?.failure_reason).toBe(question)
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  }, 20_000)
})
