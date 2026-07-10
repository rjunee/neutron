/**
 * @neutronai/runtime — subagent-registry persistence + boot reap (plan §P7).
 *
 * Proves the D-6 acceptance ("a restart SURFACES, not vanishes, in-flight
 * dispatches") and the CRITICAL care ("the `fired`/`redispatched`
 * orphan-detection sets stay volatile — a restart still re-detects orphans").
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  SubagentRegistry,
  type CreateRecordInput,
  type SubagentPersistence,
  type SubagentRecord,
  type SubagentStatus,
} from './registry.ts'
import { SubagentRegistryStore } from './store.ts'
import { sweepOrphanedDispatchesOnBoot } from './boot-sweep.ts'
import { cancelRun, failRun, newControlState, registerCanceller } from './control.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-subagent-persist-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const dispatchInput = (over: Partial<CreateRecordInput> = {}): CreateRecordInput => ({
  run_id: over.run_id ?? 'run-1',
  instance_key: over.instance_key ?? 'owner-a',
  agent_kind: over.agent_kind ?? 'atlas',
  spawn_depth: over.spawn_depth ?? 0,
  ...(over.parent_run_id !== undefined ? { parent_run_id: over.parent_run_id } : {}),
  ...(over.parent_session_id !== undefined ? { parent_session_id: over.parent_session_id } : {}),
  ...(over.delivery_target !== undefined ? { delivery_target: over.delivery_target } : {}),
  ...(over.delegation_claims !== undefined ? { delegation_claims: over.delegation_claims } : {}),
  ...(over.spawn_key !== undefined ? { spawn_key: over.spawn_key } : {}),
})

// Boot-owner tokens: a reap surfaces a row ONLY when its owning boot differs
// from the sweeping store's boot. `PRIOR_BOOT` stamps rows a dead prior process
// left behind (the reap must find them); `CURR_BOOT` is the booting process that
// runs the sweep (its own live rows must survive). Tests that only exercise
// `get`/`loadAll`/`markCrashed` (all boot-agnostic) use the default boot id.
const PRIOR_BOOT = 'boot-prior-process'
const CURR_BOOT = 'boot-current-process'
/** A store representing the PRIOR (dead) process — seeds reapable orphan rows. */
const priorStore = (): SubagentRegistryStore => new SubagentRegistryStore(db, PRIOR_BOOT)
/** A store representing the CURRENT boot — runs `loadReapable()` / the sweep. */
const currStore = (): SubagentRegistryStore => new SubagentRegistryStore(db, CURR_BOOT)

describe('migration 0099 idempotency', () => {
  test('the raw 0099 SQL re-applies cleanly (IF NOT EXISTS everywhere)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const sql = readFileSync(
      join(here, '..', '..', 'migrations', '0099_code_subagent_registry.sql'),
      'utf8',
    )
    const fresh = new Database(':memory:')
    fresh.exec(sql)
    // Direct reapplication must NOT throw "table/index already exists"
    // (migrations/AGENTS.md: idempotent, CREATE ... IF NOT EXISTS everywhere).
    expect(() => fresh.exec(sql)).not.toThrow()
    fresh.close()
  })
})

describe('SubagentRegistryStore — migration + write-through', () => {
  test('migration applies — code_subagent_registry table exists', () => {
    const row = db
      .prepare<{ name: string }, [string]>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get('code_subagent_registry')
    expect(row?.name).toBe('code_subagent_registry')
  })

  test('every field round-trips — full shape incl. integer boundaries + JSON blobs', async () => {
    const store = new SubagentRegistryStore(db)
    const registry = new SubagentRegistry(store)
    // create() only accepts the create-input subset; the rest (pid, timestamps,
    // etc.) are applied via update() — exercise both write paths, then reload.
    await registry.create(
      dispatchInput({
        run_id: 'run-rich',
        instance_key: 'owner-x',
        agent_kind: 'argus',
        spawn_depth: 1,
        parent_run_id: 'parent-9',
        parent_session_id: 'sess-p',
        delivery_target: { channel: 'app', binding_id: 'b-1' },
        delegation_claims: { instance: 'owner-x', depth: 1, scope: ['review', 'merge'], jti: 'j-1' },
        spawn_key: 'code-gen:t1:argus',
      }),
    )
    const bigStart = 9_007_199_254_740_991 // Number.MAX_SAFE_INTEGER
    await registry.update('run-rich', {
      status: 'running',
      child_session_id: 'child-7',
      pid: 0, // boundary: zero pid
      pid_starttime: bigStart, // boundary: max-safe integer
      ended_at: 1_700_000_000_000,
      cleanup_after: 1_700_000_600_000,
      failure_reason: 'stuck',
      last_event_at: 1_699_999_999_000,
    })

    const loaded = store.get('run-rich')
    expect(loaded).toEqual({
      run_id: 'run-rich',
      instance_key: 'owner-x',
      agent_kind: 'argus',
      spawn_depth: 1,
      status: 'running',
      parent_run_id: 'parent-9',
      parent_session_id: 'sess-p',
      child_session_id: 'child-7',
      pid: 0,
      pid_starttime: bigStart,
      started_at: loaded?.started_at as number,
      ended_at: 1_700_000_000_000,
      last_event_at: 1_699_999_999_000,
      cleanup_after: 1_700_000_600_000,
      delivery_target: { channel: 'app', binding_id: 'b-1' },
      delegation_claims: { instance: 'owner-x', depth: 1, scope: ['review', 'merge'], jti: 'j-1' },
      spawn_key: 'code-gen:t1:argus',
      failure_reason: 'stuck',
    })
    expect(typeof loaded?.started_at).toBe('number')
  })

  test('a minimal record persists with all optionals ABSENT (no null leaks as defined keys)', async () => {
    const store = new SubagentRegistryStore(db)
    const registry = new SubagentRegistry(store)
    await registry.create(dispatchInput({ run_id: 'run-min' }))
    const loaded = store.get('run-min')
    // Optional columns are NULL in the DB → absent (not `undefined`-valued) keys.
    for (const k of [
      'parent_run_id',
      'parent_session_id',
      'child_session_id',
      'pid',
      'pid_starttime',
      'ended_at',
      'cleanup_after',
      'delivery_target',
      'delegation_claims',
      'spawn_key',
      'failure_reason',
    ]) {
      expect(loaded).not.toHaveProperty(k)
    }
    expect(loaded?.status).toBe('pending')
  })

  test('update write-throughs the status transition; delete removes the row', async () => {
    const store = new SubagentRegistryStore(db)
    const registry = new SubagentRegistry(store)
    await registry.create(dispatchInput({ run_id: 'run-u' }))
    await registry.update('run-u', { status: 'running', child_session_id: 'child-1', pid: 4242 })
    const running = store.get('run-u')
    expect(running?.status).toBe('running')
    expect(running?.child_session_id).toBe('child-1')
    expect(running?.pid).toBe(4242)

    await registry.delete('run-u')
    expect(store.get('run-u')).toBeNull()
  })

  test('no persistence sink → registry stays pure in-memory (no table writes)', async () => {
    const registry = new SubagentRegistry() // S3 behaviour — no store
    await registry.create(dispatchInput({ run_id: 'run-mem' }))
    const store = new SubagentRegistryStore(db)
    expect(store.loadAll()).toHaveLength(0)
    // In-memory registry still holds it.
    expect(registry.byRunId('run-mem')?.run_id).toBe('run-mem')
  })

  test('a rejecting persist sink does not mutate the in-memory registry (persist-first)', async () => {
    const throwingPersist: SubagentPersistence = {
      persist: () => {
        throw new Error('db down')
      },
      remove: () => {},
    }
    const registry = new SubagentRegistry(throwingPersist)
    // create() propagates the write failure AND leaves the in-memory map empty.
    await expect(registry.create(dispatchInput({ run_id: 'run-fail' }))).rejects.toThrow('db down')
    expect(registry.byRunId('run-fail')).toBeUndefined()
    expect(registry.snapshot()).toHaveLength(0)
  })

  test('an update whose persist rejects leaves the in-memory record on its prior value', async () => {
    let live = true
    const flaky: SubagentPersistence = {
      persist: () => {
        if (!live) throw new Error('db down')
      },
      remove: () => {},
    }
    const registry = new SubagentRegistry(flaky)
    await registry.create(dispatchInput({ run_id: 'run-flaky' })) // persisted while live
    live = false
    await expect(registry.update('run-flaky', { status: 'running' })).rejects.toThrow('db down')
    // Prior value retained — the synchronous publish is rolled back on rejection.
    expect(registry.byRunId('run-flaky')?.status).toBe('pending')
  })

  test('two OVERLAPPING failing updates roll back to the last PERSISTED state (not an optimistic predecessor)', async () => {
    // The create persists cleanly ('pending'); every LATER persist rejects
    // ASYNCHRONOUSLY (yields a microtask BEFORE throwing) so both overlapping
    // updates publish to memory before either's catch runs — a real interleave.
    // (A synchronous throw would run each update fully sequentially, no overlap.)
    let createDone = false
    const failAfterCreate: SubagentPersistence = {
      persist: async (_rec) => {
        if (createDone) {
          await Promise.resolve()
          throw new Error('db down')
        }
        createDone = true
      },
      remove: async () => {},
    }
    const registry = new SubagentRegistry(failAfterCreate)
    await registry.create(dispatchInput({ run_id: 'r' })) // persisted at 'pending'

    // Fire TWO overlapping updates without awaiting between them: A publishes
    // 'running' synchronously, then B reads that optimistic 'running' and
    // publishes 'finished'. BOTH durable writes reject. A's rollback is a no-op
    // (B superseded it in byId); B must roll back to the last PERSISTED snapshot
    // ('pending'), NOT to its captured predecessor ('running', which A never
    // committed). Restoring the predecessor would strand memory on 'running'
    // while the store holds 'pending'.
    // allSettled attaches rejection handlers to BOTH synchronously (avoids an
    // unhandled-rejection escaping while awaiting the first).
    const [ra, rb] = await Promise.allSettled([
      registry.update('r', { status: 'running' }),
      registry.update('r', { status: 'finished' }),
    ])
    expect(ra.status).toBe('rejected')
    expect(rb.status).toBe('rejected')

    expect(registry.byRunId('r')?.status).toBe('pending') // == the persisted truth
  })
})

describe('async-persist update boundary — a landing completion stays visible', () => {
  // Regression for the persist-first update hazard: with an ASYNC persistence
  // sink, `update` must publish the new status to memory SYNCHRONOUSLY (then
  // await + roll back on failure), NOT await the durable write first. A
  // persist-first update hides a landing `finished` for the whole duration of
  // its durable write, defeating the watchdog's `failRun` re-read guard. These
  // tests block the durable `finished` write mid-flight and assert the finish is
  // still visible / not clobbered — they fail against the old persist-first code.

  // A persistence sink whose `finished` write BLOCKS until released, so the
  // durable write for the completion is provably in flight during the assertion.
  const gatedOnFinish = (): { sink: SubagentPersistence; release: () => void } => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const sink: SubagentPersistence = {
      persist: async (rec) => {
        if (rec.status === 'finished') await gate
      },
      remove: async () => {},
    }
    return { sink, release }
  }

  test('a completion is visible in memory while its durable persist is still in flight', async () => {
    const { sink, release } = gatedOnFinish()
    const reg = new SubagentRegistry(sink)
    await reg.create(dispatchInput({ run_id: 'r' }))

    // Completion lands; its durable persist is BLOCKED (still in flight).
    const completion = reg.update('r', { status: 'finished', ended_at: 1 })
    // No await of `completion` — the synchronous publish already ran.
    expect(reg.byRunId('r')?.status).toBe('finished') // old persist-first: still 'pending'

    release()
    expect((await completion).status).toBe('finished')
    expect(reg.byRunId('r')?.status).toBe('finished')
  })

  test('failRun does NOT clobber a finish whose persist is still in flight', async () => {
    const { sink, release } = gatedOnFinish()
    const reg = new SubagentRegistry(sink)
    const control = newControlState(reg)
    await reg.create(dispatchInput({ run_id: 'r' }))
    await reg.update('r', { status: 'running' })

    // A slow canceller keeps failRun parked so a completion can land during it.
    let releaseCancel!: () => void
    const cancelGate = new Promise<void>((r) => {
      releaseCancel = r
    })
    registerCanceller(control, 'r', async () => {
      await cancelGate
    })

    // failRun passes its first guard (running), then awaits the canceller.
    const failing = failRun(control, 'r', 'stuck', 999)
    await Promise.resolve()

    // The real completion lands now; its durable persist is blocked, but the
    // synchronous publish makes `finished` immediately visible.
    const completion = reg.update('r', { status: 'finished', ended_at: 1 })
    expect(reg.byRunId('r')?.status).toBe('finished')

    // Release the canceller → failRun's post-await re-read runs. It must SEE the
    // finish and decline (return false), not overwrite it with 'crashed'.
    releaseCancel()
    const clobbered = await failing
    release()
    await completion

    expect(clobbered).toBe(false) // old persist-first: true (false failure emitted)
    expect(reg.byRunId('r')?.status).toBe('finished') // finish preserved, not crashed
    expect(reg.byRunId('r')?.failure_reason).toBeUndefined()
  })
})

describe('per-run serialization: memory never diverges from the last committed persist', () => {
  // A sink whose CREATE ('pending') always commits; the two updates' outcomes are
  // chosen by target status. `block` makes a status' persist wait until released;
  // `fail` makes it throw. `committed()` is the last status the store durably
  // accepted — the durable truth memory must equal.
  const orderedSink = (opts: {
    block?: SubagentStatus
    fail?: SubagentStatus
  }): { sink: SubagentPersistence; committed: () => SubagentStatus; release: () => void } => {
    let released = false
    let waiters: Array<() => void> = []
    let committed: SubagentStatus = 'pending'
    const sink: SubagentPersistence = {
      persist: async (rec) => {
        if (opts.block !== undefined && rec.status === opts.block && !released) {
          await new Promise<void>((r) => waiters.push(r))
        }
        if (opts.fail !== undefined && rec.status === opts.fail) {
          throw new Error(`persist failed for ${rec.status}`)
        }
        committed = rec.status
      },
      remove: async () => {},
    }
    const release = (): void => {
      released = true
      const pending = waiters
      waiters = []
      for (const w of pending) w()
    }
    return { sink, committed: () => committed, release }
  }

  test('A(running) blocked+succeeds, B(finished) fails first → memory AND storage agree on running', async () => {
    // THE 4th-edge repro. Without per-run serialization: B(finished) runs while A
    // is blocked, fails, and rolls memory back to 'pending'; then A commits
    // 'running' but only advances lastPersisted, never republishing byId — memory
    // stranded at 'pending' while storage holds 'running'. Serialization orders
    // B strictly AFTER A, so this cannot happen.
    const { sink, committed, release } = orderedSink({ block: 'running', fail: 'finished' })
    const reg = new SubagentRegistry(sink)
    await reg.create(dispatchInput({ run_id: 'r' })) // committed = 'pending'

    const settled = Promise.allSettled([
      reg.update('r', { status: 'running' }),
      reg.update('r', { status: 'finished' }),
    ])
    await new Promise((r) => setTimeout(r, 10)) // give B a chance to (wrongly) run+fail early
    release() // A's persist completes → 'running' commits
    const [ra, rb] = await settled

    expect(ra.status).toBe('fulfilled') // A(running) committed
    expect(rb.status).toBe('rejected') // B(finished) failed
    expect(committed()).toBe('running') // durable truth
    expect(reg.byRunId('r')?.status).toBe('running') // memory AGREES (not stranded 'pending')
  })

  test('mirror: A(running) fails, B(finished) succeeds → memory AND storage agree on finished', async () => {
    // A runs first and fails (rolls back to the persisted 'pending'); B then
    // commits 'finished'. A's failure must not clobber B's committed value.
    const { sink, committed } = orderedSink({ fail: 'running' })
    const reg = new SubagentRegistry(sink)
    await reg.create(dispatchInput({ run_id: 'r' }))

    const [ra, rb] = await Promise.allSettled([
      reg.update('r', { status: 'running' }),
      reg.update('r', { status: 'finished' }),
    ])

    expect(ra.status).toBe('rejected') // A(running) failed
    expect(rb.status).toBe('fulfilled') // B(finished) committed after A rolled back
    expect(committed()).toBe('finished') // durable truth
    expect(reg.byRunId('r')?.status).toBe('finished') // memory agrees, A didn't clobber
  })

  test('uncontended update is visible SYNCHRONOUSLY (no await) — S3 zero-await visibility preserved', async () => {
    const reg = new SubagentRegistry() // pure in-memory
    await reg.create(dispatchInput({ run_id: 'r' }))
    const p = reg.update('r', { status: 'running' })
    // Read BEFORE awaiting p — the normal sequential lifecycle stays zero-await.
    expect(reg.byRunId('r')?.status).toBe('running')
    await p
  })
})

describe('live-path persist failures are best-effort (never reject, canceller never leaks)', () => {
  // Persist SUCCEEDS for pending/running but THROWS for terminal statuses — the
  // store outage that bites exactly at a live→terminal transition.
  const terminalFailSink = (): SubagentPersistence => ({
    persist: async (rec) => {
      if (rec.status === 'crashed' || rec.status === 'cancelled') {
        throw new Error('terminal persist down')
      }
    },
    remove: async () => {},
  })

  test('failRun: a terminal persist failure does not reject; canceller removed, returns true', async () => {
    const reg = new SubagentRegistry(terminalFailSink())
    const control = newControlState(reg)
    await reg.create(dispatchInput({ run_id: 'r' }))
    await reg.update('r', { status: 'running' }) // running persists fine
    let cancelled = false
    registerCanceller(control, 'r', async () => {
      cancelled = true
    })

    // The crashed-status persist throws — failRun must swallow it.
    const won = await failRun(control, 'r', 'process_dead', 500)
    expect(won).toBe(true) // reap intent stands (crash is surfaced to the caller)
    expect(cancelled).toBe(true) // the live process was still terminated
    expect(control.cancellers.has('r')).toBe(false) // canceller removed — no leak
    // Live record forced terminal despite the failed persist — no watchdog re-reap.
    expect(reg.byRunId('r')?.status).toBe('crashed')
    expect(reg.live().map((r) => r.run_id)).not.toContain('r')
  })

  test('cancelRun: a terminal persist failure does not reject; canceller removed', async () => {
    const reg = new SubagentRegistry(terminalFailSink())
    const control = newControlState(reg)
    await reg.create(dispatchInput({ run_id: 'r' }))
    await reg.update('r', { status: 'running' })
    registerCanceller(control, 'r', async () => {})

    // The cancelled-status persist throws — cancelRun must not reject.
    await cancelRun(control, 'r')
    expect(control.cancellers.has('r')).toBe(false) // canceller removed — no leak
    // Live record forced terminal despite the failed persist.
    expect(reg.byRunId('r')?.status).toBe('cancelled')
    expect(reg.live().map((r) => r.run_id)).not.toContain('r')
  })
})

describe('SubagentRegistryStore — malformed-row isolation', () => {
  test('one row with corrupt JSON does not abort loadReapable; valid orphans still reap', async () => {
    const store = priorStore()
    const reg = new SubagentRegistry(store)
    await reg.create(
      dispatchInput({
        run_id: 'good',
        delivery_target: { channel: 'app', binding_id: 'b' },
      }),
    )
    await reg.update('good', { status: 'running' })
    await reg.create(dispatchInput({ run_id: 'corrupt' }))
    await reg.update('corrupt', { status: 'running' })
    // Corrupt the second row's delivery_target JSON directly in the table.
    await db.run(`UPDATE code_subagent_registry SET delivery_target = '{' WHERE run_id = ?`, [
      'corrupt',
    ])

    // loadReapable must NOT throw — both prior-boot rows come back (corrupt field dropped).
    const live = currStore().loadReapable()
    expect(live.map((r) => r.run_id).sort()).toEqual(['corrupt', 'good'])
    const corrupt = live.find((r) => r.run_id === 'corrupt')
    expect(corrupt).not.toHaveProperty('delivery_target') // malformed → dropped
    const good = live.find((r) => r.run_id === 'good')
    expect(good?.delivery_target).toEqual({ channel: 'app', binding_id: 'b' })

    // The boot sweep still reaps BOTH orphans despite the corrupt row.
    const fired: string[] = []
    const swept = await sweepOrphanedDispatchesOnBoot({
      store: currStore(),
      report: (rec) => {
        fired.push(rec.run_id)
      },
      now: () => 1,
    })
    expect(swept.map((r) => r.run_id).sort()).toEqual(['corrupt', 'good'])
    expect(fired.sort()).toEqual(['corrupt', 'good'])
  })
})

describe('mutex-serialized writes survive a concurrent foreign transaction rollback', () => {
  // Round-4 hazard (persistence/db-api.test.ts "runSync bypass hazard"): a
  // synchronous write issued while another caller holds a `transaction()` open on
  // the SAME ProjectDb is absorbed into it and wiped on rollback. The store writes
  // via the ASYNC, mutex-serialized `db.run`/`transaction`, which QUEUES on the
  // per-instance mutex and therefore runs as its OWN statement only AFTER the
  // foreign transaction has committed or rolled back — never captured by it. These
  // tests hold a foreign transaction open across the store write and assert the
  // registry mutation survives its rollback (create / update / delete / boot claim).

  async function runDuringForeignOpenTx(work: () => Promise<void>): Promise<void> {
    let entered = false
    const txDone = db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO code_subagent_registry (run_id, instance_key, agent_kind, started_at, last_event_at, boot_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['foreign-doomed', 'owner', 'core', 1, 1, PRIOR_BOOT],
      )
      entered = true
      await Bun.sleep(30) // hold the BEGIN open across the queued store write
      throw new Error('forced rollback')
    })
    while (!entered) await Bun.sleep(1)
    // Kick off the store write WHILE the foreign transaction holds the mutex; it
    // queues behind it. Then let the transaction roll back, and the queued write
    // lands as its own statement.
    const done = work()
    await expect(txDone).rejects.toThrow('forced rollback')
    await done
  }

  test('create survives; the foreign transaction is rolled back', async () => {
    const store = new SubagentRegistryStore(db)
    const registry = new SubagentRegistry(store)
    await runDuringForeignOpenTx(async () => {
      await registry.create(dispatchInput({ run_id: 'survivor' }))
    })
    expect(store.get('foreign-doomed')).toBeNull() // foreign write rolled back
    expect(store.get('survivor')?.status).toBe('pending') // survived
  })

  test('update survives a concurrent foreign rollback', async () => {
    const store = new SubagentRegistryStore(db)
    const registry = new SubagentRegistry(store)
    await registry.create(dispatchInput({ run_id: 'upd' }))
    await runDuringForeignOpenTx(async () => {
      await registry.update('upd', { status: 'running', pid: 55 })
    })
    const reloaded = store.get('upd')
    expect(reloaded?.status).toBe('running')
    expect(reloaded?.pid).toBe(55)
  })

  test('delete survives a concurrent foreign rollback', async () => {
    const store = new SubagentRegistryStore(db)
    const registry = new SubagentRegistry(store)
    await registry.create(dispatchInput({ run_id: 'del' }))
    await runDuringForeignOpenTx(async () => {
      await registry.delete('del')
    })
    expect(store.get('del')).toBeNull() // delete persisted
  })

  test('boot claim (markCrashed) survives a concurrent foreign rollback', async () => {
    const store = new SubagentRegistryStore(db)
    const registry = new SubagentRegistry(store)
    await registry.create(dispatchInput({ run_id: 'claim' }))
    await registry.update('claim', { status: 'running' })
    await runDuringForeignOpenTx(async () => {
      const won = await store.markCrashed('claim', 'process_dead', 99)
      expect(won).toBe(true)
    })
    const reloaded = store.get('claim')
    expect(reloaded?.status).toBe('crashed')
    expect(reloaded?.failure_reason).toBe('process_dead')
  })
})

describe('markCrashed claim is EXACTLY-ONCE across SEPARATE connections (multi-process boot reap)', () => {
  // The real multi-process scenario: two gateway processes (here, two DISTINCT
  // ProjectDb connections on the SAME WAL db file — the in-process mutex does NOT
  // span them) both boot-reap the same prior-process `running` orphan. The claim
  // authority is the guarded UPDATE's affected-row COUNT: exactly one connection
  // sees a matching row (changes===1 → true) and the other matches zero rows
  // (already crashed → changes===0 → false). The prior bug returned `true`
  // unconditionally, so BOTH connections would have fired the report sink.

  // Seeds a PRIOR-boot orphan so BOTH current-boot sweepers (distinct boot ids)
  // see it as reapable.
  async function seedRunningOrphan(run_id: string): Promise<void> {
    const reg = new SubagentRegistry(priorStore())
    await reg.create(dispatchInput({ run_id }))
    await reg.update(run_id, { status: 'running' })
  }

  test('two connections CONCURRENTLY claiming one running orphan → exactly ONE wins', async () => {
    await seedRunningOrphan('orphan')
    // Two distinct connections on the same file — as two OS processes would open,
    // each with its OWN boot id (both differ from the prior-boot orphan).
    const connA = ProjectDb.open(db.path)
    const connB = ProjectDb.open(db.path)
    try {
      const storeA = new SubagentRegistryStore(connA, 'boot-proc-A')
      const storeB = new SubagentRegistryStore(connB, 'boot-proc-B')
      // Both race to claim the SAME live row. The guarded UPDATE's affected-row
      // count is the authority: exactly one commits the transition (changes=1 →
      // true); the other's UPDATE re-evaluates against the committed state and
      // matches ZERO rows (changes=0 → false). The prior bug returned `true`
      // unconditionally, so BOTH would have "won" and double-reported.
      const [wonA, wonB] = await Promise.all([
        storeA.markCrashed('orphan', 'process_dead', 111),
        storeB.markCrashed('orphan', 'process_dead', 222),
      ])

      expect([wonA, wonB].filter(Boolean)).toHaveLength(1) // EXACTLY one winner
      // Row is crashed exactly once (the loser's UPDATE was a no-op).
      const row = new SubagentRegistryStore(db).get('orphan')
      expect(row?.status).toBe('crashed')
    } finally {
      connA.close()
      connB.close()
    }
  })

  test('two boot sweeps over separate connections fire the report sink EXACTLY ONCE total', async () => {
    await seedRunningOrphan('orphan2')
    // Two processes booting simultaneously: each opens its own connection with its
    // OWN boot id, each loadReapable()s the prior-boot orphan, and both race to reap it.
    const connA = ProjectDb.open(db.path)
    const connB = ProjectDb.open(db.path)
    try {
      const fired: string[] = []
      const report = (rec: SubagentRecord): void => {
        fired.push(rec.run_id)
      }
      const [sweptA, sweptB] = await Promise.all([
        sweepOrphanedDispatchesOnBoot({
          store: new SubagentRegistryStore(connA, 'boot-proc-A'),
          report,
          now: () => 1,
        }),
        sweepOrphanedDispatchesOnBoot({
          store: new SubagentRegistryStore(connB, 'boot-proc-B'),
          report,
          now: () => 2,
        }),
      ])

      // Both loaded the orphan as live, but only ONE claimed + reported it.
      expect(sweptA.length + sweptB.length).toBe(1)
      expect(fired).toEqual(['orphan2']) // EXACTLY ONCE total across both processes
      expect(currStore().get('orphan2')?.status).toBe('crashed')
    } finally {
      connA.close()
      connB.close()
    }
  })
})

describe('(a) a dispatched agent row persists across a simulated process restart', () => {
  test('a running dispatch survives; a fresh registry over the same db still sees it live', async () => {
    // Process 1: dispatch + drive to running.
    const store1 = priorStore()
    const registry1 = new SubagentRegistry(store1)
    await registry1.create(dispatchInput({ run_id: 'run-live', agent_kind: 'sentinel' }))
    await registry1.update('run-live', { status: 'running', pid: 9001 })

    // Process 2 (RESTART): a brand-new in-memory registry + store over the SAME
    // db with a fresh boot id. The in-memory map starts empty (crash lost it) —
    // but the store retains the row, so the dispatch did NOT vanish.
    const registry2 = new SubagentRegistry(currStore())
    expect(registry2.snapshot()).toHaveLength(0) // in-memory state gone

    const store2 = currStore()
    const live = store2.loadReapable()
    expect(live).toHaveLength(1)
    expect(live[0]?.run_id).toBe('run-live')
    expect(live[0]?.status).toBe('running')
    expect(live[0]?.pid).toBe(9001)
  })
})

describe('boot-owner predicate: a current-boot live row is NEVER reaped', () => {
  // Reads a row's persisted owning boot id (write-once stamp) directly.
  const bootOf = (run_id: string): string | undefined =>
    db
      .prepare<{ boot_id: string }, [string]>(
        `SELECT boot_id FROM code_subagent_registry WHERE run_id = ?`,
      )
      .get(run_id)?.boot_id ?? undefined

  test('the current boot sweeps a PRIOR-boot orphan but leaves its OWN live dispatch running', async () => {
    // The exact hazard the boot_id token closes: the sweep runs inside the
    // composer, so a repeat composition (or any second sweep) in the SAME process
    // must NOT crash a dispatch THIS boot created and is legitimately running.
    const current = currStore()

    // Current boot creates a live dispatch (stamped CURR_BOOT).
    const mine = new SubagentRegistry(current)
    await mine.create(dispatchInput({ run_id: 'mine-live', agent_kind: 'atlas' }))
    await mine.update('mine-live', { status: 'running' })

    // A prior (dead) process left its own live orphan (stamped PRIOR_BOOT).
    const prior = new SubagentRegistry(priorStore())
    await prior.create(dispatchInput({ run_id: 'their-orphan', agent_kind: 'core' }))
    await prior.update('their-orphan', { status: 'running' })

    // Rows carry the expected owning boot ids (proves the write-once stamp).
    expect(bootOf('mine-live')).toBe(CURR_BOOT)
    expect(bootOf('their-orphan')).toBe(PRIOR_BOOT)

    // loadReapable under CURR_BOOT returns ONLY the prior-boot row.
    expect(current.loadReapable().map((r) => r.run_id)).toEqual(['their-orphan'])

    // The sweep (CURR_BOOT) reaps ONLY the prior-boot orphan.
    const fired: string[] = []
    const swept = await sweepOrphanedDispatchesOnBoot({
      store: currStore(),
      report: (rec) => {
        fired.push(rec.run_id)
      },
      now: () => 100,
    })
    expect(swept.map((r) => r.run_id)).toEqual(['their-orphan'])
    expect(fired).toEqual(['their-orphan'])
    // CRITICAL: the current boot's own live dispatch was NOT crashed.
    expect(current.get('mine-live')?.status).toBe('running')
    expect(current.get('their-orphan')?.status).toBe('crashed')
  })

  test('a repeat sweep in the SAME boot reaps nothing (its own live rows survive)', async () => {
    // Repeat composition in one process: create a live dispatch under CURR_BOOT,
    // then run the sweep AGAIN under the SAME boot id — the old bug would crash it.
    const current = currStore()
    const reg = new SubagentRegistry(current)
    await reg.create(dispatchInput({ run_id: 'live-1' }))
    await reg.update('live-1', { status: 'running' })

    const swept = await sweepOrphanedDispatchesOnBoot({
      store: currStore(),
      report: () => {},
      now: () => 1,
    })
    expect(swept).toHaveLength(0) // no prior-boot rows → nothing reaped
    expect(current.get('live-1')?.status).toBe('running') // survives
  })
})

describe('(b) boot sweep marks prior-process in-flight rows crashed + fires report once each', () => {
  test('two live orphans surface exactly once; terminal rows are untouched', async () => {
    // Prior process left two in-flight dispatches + one cleanly-finished one.
    const store1 = priorStore()
    const reg1 = new SubagentRegistry(store1)
    await reg1.create(dispatchInput({ run_id: 'orphan-1', agent_kind: 'atlas' }))
    await reg1.update('orphan-1', { status: 'running' })
    await reg1.create(dispatchInput({ run_id: 'orphan-2', agent_kind: 'core' }))
    // orphan-2 left in 'pending' (never advanced to running) — still LIVE.
    await reg1.create(dispatchInput({ run_id: 'done-1', agent_kind: 'sentinel' }))
    await reg1.update('done-1', { status: 'finished' })

    // BOOT (process 2): sweep under a fresh boot id.
    const bootStore = currStore()
    const fired: SubagentRecord[] = []
    const swept = await sweepOrphanedDispatchesOnBoot({
      store: bootStore,
      report: (rec) => {
        fired.push(rec)
      },
      now: () => 5_000,
    })

    // Both live orphans surfaced; the finished row was NOT.
    expect(swept.map((r) => r.run_id).sort()).toEqual(['orphan-1', 'orphan-2'])
    expect(fired.map((r) => r.run_id).sort()).toEqual(['orphan-1', 'orphan-2'])
    for (const rec of fired) {
      expect(rec.status).toBe('crashed')
      expect(rec.failure_reason).toBe('process_dead')
      expect(rec.ended_at).toBe(5_000)
    }
    // Persisted terminal status.
    expect(bootStore.get('orphan-1')?.status).toBe('crashed')
    expect(bootStore.get('orphan-2')?.status).toBe('crashed')
    expect(bootStore.get('orphan-1')?.failure_reason).toBe('process_dead')
    // The clean finish is untouched.
    expect(bootStore.get('done-1')?.status).toBe('finished')

    // SECOND BOOT: idempotent — the now-crashed rows must NOT re-fire.
    const fired2: SubagentRecord[] = []
    const swept2 = await sweepOrphanedDispatchesOnBoot({
      store: new SubagentRegistryStore(db, 'boot-third-process'),
      report: (rec) => {
        fired2.push(rec)
      },
      now: () => 9_999,
    })
    expect(swept2).toHaveLength(0)
    expect(fired2).toHaveLength(0)
  })

  test('a throwing sink is best-effort: the orphan is still durably claimed crashed, no throw escapes', async () => {
    // The report is a NOTIFICATION on top of the durable claimed row. A sink
    // failure must not abort the sweep nor un-claim the row — the crash is
    // recorded in the store (the surfacing that never vanishes) and returned.
    const store = priorStore()
    const reg = new SubagentRegistry(store)
    await reg.create(dispatchInput({ run_id: 'boom' }))
    await reg.update('boom', { status: 'running' })

    const swept = await sweepOrphanedDispatchesOnBoot({
      store: currStore(),
      report: () => {
        throw new Error('sink down')
      },
      now: () => 1,
    })
    // Surfaced + durably crashed despite the sink throwing (best-effort notify).
    expect(swept.map((r) => r.run_id)).toEqual(['boom'])
    expect(store.get('boom')?.status).toBe('crashed')
    expect(store.get('boom')?.failure_reason).toBe('process_dead')

    // A second boot does not re-fire (the atomic claim already committed).
    const fired2: string[] = []
    await sweepOrphanedDispatchesOnBoot({
      store: new SubagentRegistryStore(db, 'boot-third-process'),
      report: (rec) => {
        fired2.push(rec.run_id)
      },
      now: () => 2,
    })
    expect(fired2).toEqual([])
  })

  test('concurrent sweeps report a shared orphan EXACTLY ONCE (atomic claim admits one winner)', async () => {
    // Codex boundary: two overlapping sweeps must not both report the same row.
    // The claim is a mutex-serialized `db.transaction` (guard-read + guarded
    // UPDATE), so whichever sweep's claim transaction runs second reads the row
    // already `crashed` and returns false — only one sweep reports.
    const store = priorStore()
    const reg = new SubagentRegistry(store)
    await reg.create(dispatchInput({ run_id: 'shared' }))
    await reg.update('shared', { status: 'running' })

    const fired: string[] = []
    const report = async (rec: SubagentRecord): Promise<void> => {
      // Yield to let the other sweep interleave — a naive report-before-claim
      // implementation would double-report here.
      await Promise.resolve()
      fired.push(rec.run_id)
    }
    // Two overlapping sweeps in the same current boot against a prior-boot orphan.
    const [a, b] = await Promise.all([
      sweepOrphanedDispatchesOnBoot({ store: currStore(), report, now: () => 7 }),
      sweepOrphanedDispatchesOnBoot({ store: currStore(), report, now: () => 7 }),
    ])

    // Reported once total; claimed by exactly one sweep.
    expect(fired).toEqual(['shared'])
    expect(a.length + b.length).toBe(1)
    expect(store.get('shared')?.status).toBe('crashed')
  })
})

describe('(c) the fired/redispatched orphan-detection sets stay volatile', () => {
  test('no persisted column can carry a fired/redispatched/reported dedup marker', () => {
    const cols = db
      .prepare<{ name: string }, []>(`PRAGMA table_info(code_subagent_registry)`)
      .all()
      .map((r) => r.name)
    // The table mirrors SubagentRecord ONLY. If any of these ever appears, a
    // dedup set would be persisted — the exact orphan-detection replay P7 forbids.
    for (const forbidden of ['fired', 'redispatched', 'reported', 'reap_notified']) {
      expect(cols).not.toContain(forbidden)
    }
  })

  test('a persisted running row is ALWAYS re-surfaced on a fresh boot (no suppression flag survives)', async () => {
    // If the persistence layer had smuggled a "this-process fired it" flag, the
    // fresh boot would SKIP the orphan. It must not: the orphan re-detects.
    const store1 = priorStore()
    const reg1 = new SubagentRegistry(store1)
    await reg1.create(dispatchInput({ run_id: 'reorphan' }))
    await reg1.update('reorphan', { status: 'running' })

    const surfaced = await sweepOrphanedDispatchesOnBoot({
      store: currStore(),
      report: () => {},
      now: () => 42,
    })
    expect(surfaced.map((r) => r.run_id)).toEqual(['reorphan'])
    // The re-detection came from the LIVE status alone — the only thing that
    // stops a SECOND boot re-firing is the store transition to terminal, NOT a
    // volatile in-memory dedup set (which a restart would have dropped anyway).
  })

  test('the persisted SubagentRecord shape carries no dedup/fired field', async () => {
    const store = new SubagentRegistryStore(db)
    const reg = new SubagentRegistry(store)
    await reg.create(dispatchInput({ run_id: 'shape' }))
    await reg.update('shape', { status: 'running' })
    const rec = store.get('shape') as unknown as Record<string, unknown>
    for (const forbidden of ['fired', 'redispatched', 'reported']) {
      expect(rec).not.toHaveProperty(forbidden)
    }
  })
})
