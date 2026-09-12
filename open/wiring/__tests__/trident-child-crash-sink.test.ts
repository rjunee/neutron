/**
 * THE OWNER IS TOLD WHICH HAPPENED (#518 — `a-deploy-must-not-kill-builds-in-flight`).
 *
 * A trident inner workflow runs detached inside a warm `cc-trident-fire-*` REPL the
 * gateway owns, so `systemctl restart` — what a deploy does once the new vendor tree
 * is checked out — kills every build in flight. Three of five recorded
 * `trident_launcher_crashes` landed 18-28 s after a vendor checkout; the 08-13 deploy
 * rolled trident's OWN merge, so a build that landed killed the builds still running.
 *
 * The acceptance criterion these cases pin is the reporting one: *a deploy-caused
 * death is never reported as a bare "child crashed" / "pooled child exited" — assert
 * the stored reason names the deploy.* They assert against the REAL store, on the
 * real `code_trident_runs` row, through the production sink — not against a retyped
 * copy of the composition.
 *
 * AND THEY COME IN PAIRS. A sink that answered "a deploy" to everything would satisfy
 * the first case in each pair and be worse than no change at all, so every deploy case
 * is followed by its complement: a genuine crash with no shutdown marker must still
 * read as a crash. That pairing is what makes the spec item's two negative criteria
 * real — the 08-10 23:30 and 08-11 06:04 crashes have no checkout near them and must
 * not be claimed by this fix.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { interpretFailure } from '@neutronai/trident/delivery.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { buildTridentChildCrashSink } from '../trident-child-crash-sink.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trident-deploy-kill-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const OBSERVED = new Date('2026-08-13T04:05:55.000Z')
const BOOTED = new Date('2026-08-13T04:05:40.000Z')

function sink(): (info: {
  sessionKey: string
  generationKey: string
  cause: 'child-died' | 'gateway-shutdown'
  detail: string
}) => Promise<void> {
  return buildTridentChildCrashSink({
    latch: (session_key, failure_reason) => store.crashRunningByLauncher(session_key, failure_reason),
    now: () => OBSERVED,
    gateway_booted_at: () => BOOTED,
  })
}

/** A run mid-build inside launcher generation `generation`, exactly as a fire leaves
 *  it: branch pushed, PR open, `subagent_status='running'`. */
async function seedRunning(id: string, generation: string): Promise<void> {
  await store.create({ id, slug: id, project_slug: 'p', repo_path: '/repo', task: 'build' })
  await store.update(id, {
    phase: 'ralph-task',
    branch: `trident/${id}`,
    pr: 282,
    inner_checkpoint: 'ralph-task-built',
    subagent_run_id: 'wf-1',
    subagent_status: 'running',
    workflow_run_id: generation,
  })
}

describe('a deploy-caused death names the deploy', () => {
  test('the stored failure_reason says deploy, and never says the child crashed', async () => {
    // RED-mutation: in `buildTridentChildCrashSink`, delete the `gateway-shutdown` arm
    // (let the #240 crash sentence handle both). Every assertion below fails.
    await seedRunning('deploy-1', 'gen-08-13')
    await sink()({
      sessionKey: 'cc-trident-fire-o-abc /repo',
      generationKey: 'gen-08-13',
      cause: 'gateway-shutdown',
      detail: 'terminated by its own gateway shutting down at 2026-08-13T04:05:27.000Z (a service restart or a deploy) — NOT a crash of the child or the build',
    })

    const row = store.get('deploy-1')
    expect(row?.subagent_status).toBe('crashed')
    const reason = row?.failure_reason ?? ''
    // PINNED VALUES, not a relation: the word the acceptance criterion asks for, and
    // the two phrases it forbids.
    expect(reason).toContain('deploy')
    expect(reason).toContain('killed by a gateway restart or deploy')
    expect(reason).not.toContain('child crashed')
    expect(reason).not.toContain('pooled child exited')
    // The generation is still named — the reason has to stay actionable evidence.
    expect(reason).toContain('gen-08-1')
  })

  test('THE COMPLEMENT — a genuine crash with no deploy near it still reads as a crash', async () => {
    // THE 08-10 23:30 / 08-11 06:04 SHAPE. Those two recorded crashes have no vendor
    // checkout near them, the spec item says they are NOT explained by this fix, and a
    // change that claimed them fails review. The shutdown path is the only thing that
    // produces `cause: 'gateway-shutdown'`, so an event nobody attributed arrives here
    // as `child-died` and MUST keep the #240 sentence.
    //
    // RED-mutation: make the `gateway-shutdown` arm unconditional. This reddens while
    // the case above still passes — which is the whole point of the pair.
    await seedRunning('crash-1', 'gen-08-10-2330')
    await sink()({
      sessionKey: 'cc-trident-fire-o-abc /repo',
      generationKey: 'gen-08-10-2330',
      cause: 'child-died',
      detail: 'pooled child exited',
    })

    const reason = store.get('crash-1')?.failure_reason ?? ''
    expect(reason).toBe(
      'inner workflow child crashed: pooled child exited ' +
        '(observed 2026-08-13T04:05:55.000Z; gateway process booted 2026-08-13T04:05:40.000Z)',
    )
    expect(reason).not.toContain('deploy')
  })

  test('an EVICTION is a fault, not a deploy — the pool killing a poisoned child keeps the crash sentence', async () => {
    // `notifyEvictedChild` (spawn.ts) is the other place we deliberately kill a child,
    // and it is NOT a deploy: it is the pool's response to an abandon-poisoned session.
    // Folding it into `gateway-shutdown` would be the negative criterion failing on a
    // third event class.
    await seedRunning('evicted-1', 'gen-evicted')
    await sink()({
      sessionKey: 'cc-trident-fire-o-abc /repo',
      generationKey: 'gen-evicted',
      cause: 'child-died',
      detail: 'pooled child evicted (abandon-poisoned) — every in-process workload it hosted died with it',
    })
    const reason = store.get('evicted-1')?.failure_reason ?? ''
    expect(reason).toContain('inner workflow child crashed')
    expect(reason).not.toContain('deploy')
  })

  test('only the runs the DEAD generation owned are touched', async () => {
    // A launcher is shared infrastructure. The store's own predicate does the scoping;
    // this pins that the deploy arm did not widen it.
    await seedRunning('deploy-2', 'gen-dead')
    await seedRunning('other-1', 'gen-live')
    await sink()({
      sessionKey: 'k',
      generationKey: 'gen-dead',
      cause: 'gateway-shutdown',
      detail: 'terminated by its own gateway shutting down (a service restart or a deploy)',
    })
    expect(store.get('deploy-2')?.subagent_status).toBe('crashed')
    expect(store.get('other-1')?.subagent_status).toBe('running')
    expect(store.get('other-1')?.failure_reason ?? '').toBe('')
  })
})

describe('what the owner actually reads', () => {
  test('the announce says a deploy killed it and that nothing was rejected', async () => {
    // The stored reason is the input to `interpretFailure`, which composes the chat
    // announce. Without its own class the reason falls through to the `unknown`
    // fallback — which prints the raw sentence only while it stays under 200
    // characters, so the owner's copy would be one reword away from "The build did not
    // complete." RED-mutation: delete the `deploy-restart` branch in `delivery.ts`.
    await seedRunning('deploy-3', 'gen-x')
    await sink()({
      sessionKey: 'k',
      generationKey: 'gen-x',
      cause: 'gateway-shutdown',
      detail: 'terminated by its own gateway shutting down at 2026-08-13T04:05:27.000Z (a service restart or a deploy) — NOT a crash of the child or the build',
    })
    const row = store.get('deploy-3')
    expect(row).not.toBeNull()
    const interp = interpretFailure(row!)
    expect(interp.klass).toBe('deploy-restart')
    expect(interp.summary).toContain('killed by a deploy or restart')
    expect(interp.summary).toContain('nothing about the code was rejected')
    // NOT the two misroutes a token fall-through would produce — the hang class
    // ("stopped making progress") or the generic unknown fallback.
    expect(interp.summary).not.toContain('stopped making progress')
    expect(interp.summary).not.toBe('The build did not complete.')
    // And retrying IS the advice here: the cause is entirely outside the work.
    expect(interp.input_needed).toContain('Reply to retry')
  })

  test('THE COMPLEMENT — a plain crash is NOT announced as a deploy', async () => {
    await seedRunning('crash-2', 'gen-y')
    await sink()({
      sessionKey: 'k',
      generationKey: 'gen-y',
      cause: 'child-died',
      detail: 'pooled child exited',
    })
    const interp = interpretFailure(store.get('crash-2')!)
    expect(interp.klass).not.toBe('deploy-restart')
    expect(interp.summary).not.toContain('deploy')
  })
})

describe('the tombstone cannot be overwritten back into a crash', () => {
  test('a late bare-crash notification for the same generation does not erase the deploy', async () => {
    // `crashRunningByLauncher` upserts the tombstone with
    // `ON CONFLICT(session_key) DO UPDATE SET failure_reason = excluded.failure_reason`,
    // and `saveIfActive` reads that tombstone back to stamp a row it vetoed. So a
    // second, bare notification for the same dead generation WOULD launder the deploy
    // attribution away. The shutdown path stamps `child_crash_notified_at` precisely so
    // the next boot's watchdog never fires that second edge — this case is why that
    // field is in the patch, and it documents what the row looks like if it is lost.
    await seedRunning('deploy-4', 'gen-z')
    const s = sink()
    await s({
      sessionKey: 'k',
      generationKey: 'gen-z',
      cause: 'gateway-shutdown',
      detail: 'terminated by its own gateway shutting down (a service restart or a deploy)',
    })
    const afterDeploy = store.get('deploy-4')?.failure_reason ?? ''
    expect(afterDeploy).toContain('deploy')

    // The run row itself is already terminal, so a second notification cannot rewrite
    // it: `crashRunningByLauncher`'s UPDATE is predicated on `subagent_status='running'`.
    await s({ sessionKey: 'k', generationKey: 'gen-z', cause: 'child-died', detail: 'pooled child exited' })
    expect(store.get('deploy-4')?.failure_reason).toBe(afterDeploy)
  })
})
