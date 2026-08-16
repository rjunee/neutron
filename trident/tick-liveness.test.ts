/**
 * A DEAD BUILD MUST BE DETECTED IN SECONDS, NOT NINETY MINUTES.
 *
 * Liveness is SELF-REPORTED today: a run counts as alive because it keeps stamping
 * its own `last_advanced_at`. A process that dies hard — OOM, SIGKILL, host restart —
 * stops stamping and merely looks SLOW, so nothing separates "thinking" from "dead"
 * and the only backstop is the 90-minute `NO_ADVANCE_HANG_MS` reaper, whose reason
 * ("suspected agent hang") does not even say it died. At 10-way concurrency that is a
 * tenth of the machine idle for an hour and a half, reporting nothing.
 *
 * These cases pin the EXTERNAL signal that fixes it: a polled 'trident-liveness'
 * loop that asks whether the launcher generation recorded on an in-flight row is
 * still a live PROCESS, and terminally fails only a POSITIVE death.
 *
 * The two halves that must both hold, and each names the mutation that turns it RED:
 *   • a positively-dead generation is terminal in the liveness pass, names the
 *     death, and runs the terminal observers;
 *   • 'alive' / 'unknown' / a throwing probe change NOTHING. The separation between
 *     slow and dead is BINARY (process aliveness), never a time threshold, so a
 *     legitimately long-thinking agent can never be reaped by this signal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { NO_ADVANCE_HANG_MS } from './liveness.ts'
import type { AdvanceOutcome } from './state-machine.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import {
  TridentTickLoop,
  type LauncherLiveness,
  type TridentDeadLauncherLatch,
  type TridentLivenessProbe,
} from './tick.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trident-tick-liveness-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** A step that never advances anything — the probe loop is what is under test. */
const idleStep = async (run: TridentRun): Promise<AdvanceOutcome> => ({
  run,
  changed: false,
  waiting: true,
  note: 'idle',
})

/** A probe that answers the same way for everything, recording what it was asked. */
function fixedProbe(
  answer: LauncherLiveness,
  seen: string[] = [],
): { probe: TridentLivenessProbe; seen: string[] } {
  return {
    seen,
    probe: async (run: TridentRun) => {
      seen.push(run.id)
      return answer
    },
  }
}

/** A recording latch that never touches the store — T1/T4/T5 assert the CALLS. */
function recordingLatch(): {
  latch: TridentDeadLauncherLatch
  calls: Array<{ key: string; reason: string }>
} {
  const calls: Array<{ key: string; reason: string }> = []
  return { calls, latch: async (key, reason) => void calls.push({ key, reason }) }
}

/** Seed a run mid-build, in flight under launcher generation `generation`. */
async function seedInFlight(id: string, generation: string): Promise<TridentRun> {
  await store.create({ id, slug: id, project_slug: 'p', repo_path: '/repo', task: 'build' })
  return (await store.update(id, {
    phase: 'ralph-task',
    branch: 'trident/x',
    pr: 61,
    inner_checkpoint: 'ralph-task-built',
    round: 2,
    ralph_round: 3,
    subagent_run_id: 'wf-1',
    subagent_status: 'running',
    workflow_run_id: generation,
  }))!
}

describe('T1 — a positively dead launcher is latched ONCE, and honestly', () => {
  test('the reason names the death, the generation, and nothing it does not mean', async () => {
    // RED-mutation: drop the `inner workflow child crashed:` prefix and delivery.ts
    // stops classifying this as a crash; add "exhausted" and it is reported as a
    // review that ran out of rounds — a confident lie about a build whose reviewer
    // may never have run.
    await seedInFlight('dead-1', 'gen-1')
    const { probe } = fixedProbe('dead')
    const { latch, calls } = recordingLatch()
    const loop = new TridentTickLoop({ store, step: idleStep, probe_launcher_alive: probe, latch_launcher_dead: latch })

    await loop.runLivenessOnce()

    expect(calls.length).toBe(1)
    expect(calls[0]!.key).toBe('gen-1')
    const reason = calls[0]!.reason
    expect(reason).toMatch(/^inner workflow child crashed:/)
    expect(reason).toContain('gen-1')
    expect(reason).toContain('dead')
    expect(reason.toLowerCase()).not.toContain('exhausted')
    expect(reason.toLowerCase()).not.toContain('suspected agent hang')
  })

  test('two runs sharing one generation latch it exactly once', async () => {
    // RED-mutation: drop the per-generation `seen` map and the same dead launcher is
    // probed and latched once per run it owned.
    await seedInFlight('dead-a', 'gen-1')
    await seedInFlight('dead-b', 'gen-1')
    const { probe, seen } = fixedProbe('dead')
    const { latch, calls } = recordingLatch()
    const loop = new TridentTickLoop({
      store,
      step: idleStep,
      probe_launcher_alive: probe,
      latch_launcher_dead: latch,
    })

    await loop.runLivenessOnce()

    expect(seen.length).toBe(1)
    expect(calls.length).toBe(1)
    expect(calls[0]!.key).toBe('gen-1')
  })

  test('probes every running launcher beyond the sweep batch limit', async () => {
    for (let i = 0; i < 51; i++) await seedInFlight(`run-${String(i).padStart(2, '0')}`, `gen-${i}`)
    const { probe, seen } = fixedProbe('alive')
    const { latch } = recordingLatch()
    const loop = new TridentTickLoop({
      store,
      step: idleStep,
      per_tick_limit: 50,
      probe_launcher_alive: probe,
      latch_launcher_dead: latch,
    })

    await loop.runLivenessOnce()

    expect(seen).toHaveLength(51)
    expect(seen).toContain('run-50')
  })
})

describe('T2 — TERMINAL in the liveness pass, with owner and board hooks', () => {
  test('the run fails and fans its committed terminal row while still fresh', async () => {
    // RED-mutation: make the probe loop a no-op (or gate 'dead' behind a staleness
    // check) and this run sits `running` until the 90-minute reaper, which would then
    // report "suspected agent hang" — the wrong cause, 90 minutes late.
    const delivered: TridentRun[] = []
    const transitioned: TridentRun[] = []
    const { probe } = fixedProbe('dead')
    const loop = new TridentTickLoop({
      store,
      step: idleStep,
      probe_launcher_alive: probe,
      latch_launcher_dead: (key, reason) => store.failRunningByLauncher(key, reason),
      on_terminal: { onTerminal: async (run) => void delivered.push(run) },
      on_transition: { onTransition: async (run) => void transitioned.push(run) },
    })
    await seedInFlight('terminal-1', 'gen-dead')

    await loop.runLivenessOnce()

    const after = store.get('terminal-1')!
    expect(after.phase).toBe('failed')
    // The death is NAMED on the row: the latched probe text survives into the
    // terminal reason.
    expect(after.failure_reason ?? '').toContain('external liveness probe')
    expect(after.failure_reason ?? '').toContain('gen-dead')
    expect((after.failure_reason ?? '').toLowerCase()).not.toContain('exhausted')
    expect(delivered).toEqual([after])
    expect(transitioned).toEqual([after])
    expect(loop.stats()).toMatchObject({ delivered: 1, transitions: 1 })
    // AND THE REAPER PLAYED NO PART: the row's progress stamp is nowhere near the
    // 90-minute no-advance threshold, so nothing time-based could have done this.
    const ageMs = Date.now() - Date.parse(after.last_advanced_at)
    expect(ageMs).toBeLessThan(NO_ADVANCE_HANG_MS)
    expect(ageMs).toBeLessThan(60_000)
  })
  test('terminal outcome is independent of the pushed-crash recovery budget', async () => {
    const { probe } = fixedProbe('dead')
    const loop = new TridentTickLoop({
      store,
      step: idleStep,
      probe_launcher_alive: probe,
      latch_launcher_dead: (key, reason) => store.failRunningByLauncher(key, reason),
    })
    await seedInFlight('terminal-budget-independent', 'gen-dead')

    await loop.runLivenessOnce()

    const after = store.get('terminal-budget-independent')!
    expect(after.phase).toBe('failed')
    expect(after.subagent_status).toBeNull()
    expect(after.crash_recoveries).toBe(0)
    expect(after.round).toBe(2)
    expect(after.ralph_round).toBe(3)
  })
})

describe('T4 — NO FALSE DEATHS: absence of evidence is never death', () => {
  /** A store whose clock is 3 h in the past, so rows land far past every threshold. */
  function staleStore(): TridentRunStore {
    const stale = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
    return new TridentRunStore(db, () => stale)
  }

  async function seedStale(id: string, generation: string): Promise<TridentRun> {
    const st = staleStore()
    await st.create({ id, slug: id, project_slug: 'p', repo_path: '/repo', task: 'build' })
    return (await st.update(id, {
      phase: 'ralph-task',
      subagent_run_id: 'wf-1',
      subagent_status: 'running',
      workflow_run_id: generation,
    }))!
  }

  for (const answer of ['alive', 'unknown'] as const) {
    test(`a run 3 hours stale whose probe says '${answer}' is left completely alone`, async () => {
      // THE CARD'S EXPLICIT PIN. Reaping a slow-but-alive build would be strictly
      // worse than the latency this loop removes. RED-mutation: treat 'unknown' (or
      // anything !== 'alive') as death and this fails — which is exactly the bug a
      // two-valued probe would ship.
      const before = await seedStale(`stale-${answer}`, `gen-${answer}`)
      const { probe } = fixedProbe(answer)
      const { latch, calls } = recordingLatch()
      const loop = new TridentTickLoop({
        store,
        step: idleStep,
        probe_launcher_alive: probe,
        latch_launcher_dead: latch,
        now: () => Date.now(),
      })

      await loop.runLivenessOnce()

      expect(calls).toEqual([])
      expect(store.get(before.id)).toEqual(before)
    })
  }

  test('a probe that THROWS latches nothing and does not kill the loop', async () => {
    // A probe outage must degrade to "I cannot tell", not to a massacre — and the
    // next cadence must still probe, or one bad registry read disarms the signal
    // for the life of the process.
    const before = await seedStale('stale-throw', 'gen-throw')
    let probes = 0
    const probe: TridentLivenessProbe = async () => {
      probes++
      throw new Error('registry unreadable')
    }
    const { latch, calls } = recordingLatch()
    const loop = new TridentTickLoop({
      store,
      step: idleStep,
      probe_launcher_alive: probe,
      latch_launcher_dead: latch,
    })

    await loop.runLivenessOnce()
    await loop.runLivenessOnce()

    expect(probes).toBe(2)
    expect(calls).toEqual([])
    expect(store.get(before.id)).toEqual(before)
  })
})

describe('T5 — only a run actually in flight under a recorded generation is probed', () => {
  test('terminal rows, non-running statuses and blank generations are skipped', async () => {
    // The probe answers a question about a LIVE launcher. Asking it about a finished
    // run, a run that has not fired yet, or a row with no generation recorded can
    // only produce noise — and, for an already-crashed row, a redundant re-latch.
    const done = await seedInFlight('scope-terminal', 'gen-terminal')
    await store.save({ ...done, phase: 'done' })
    await seedInFlight('scope-completed', 'gen-completed')
    await store.update('scope-completed', { subagent_status: 'completed' })
    await seedInFlight('scope-crashed', 'gen-crashed')
    await store.update('scope-crashed', { subagent_status: 'crashed' })
    await seedInFlight('scope-nullstatus', 'gen-nullstatus')
    await store.update('scope-nullstatus', { subagent_status: null })
    await seedInFlight('scope-nogen', 'gen-x')
    await store.update('scope-nogen', { workflow_run_id: null })
    await seedInFlight('scope-emptygen', 'gen-y')
    await store.update('scope-emptygen', { workflow_run_id: '' })
    await seedInFlight('scope-live', 'gen-live')

    const { probe, seen } = fixedProbe('dead')
    const { latch, calls } = recordingLatch()
    const loop = new TridentTickLoop({
      store,
      step: idleStep,
      probe_launcher_alive: probe,
      latch_launcher_dead: latch,
    })

    await loop.runLivenessOnce()

    expect(seen).toEqual(['scope-live'])
    expect(calls.map((c) => c.key)).toEqual(['gen-live'])
  })
})

describe('T6 — lifecycle: unwired is byte-identical, wired is a visible third timer', () => {
  test('WITHOUT the seams there is no third timer at all', async () => {
    // An unwired TridentTickLoop must behave exactly as it did before this loop
    // existed — same two descriptors, no extra timer, no extra store reads.
    const loop = new TridentTickLoop({ store, step: idleStep })
    loop.start()
    expect(loop.describeAll().map((d) => d.name)).toEqual(['trident', 'trident-watch'])
    // The test handle is a no-op rather than a throw, so a caller cannot tell.
    expect(await loop.runLivenessOnce()).toEqual({ skipped: true })
    await loop.stop()
  })

  test('WITH the seams the inventory sees `trident-liveness` at its configured cadence', async () => {
    // An unregistered timer is one the inventory reports as healthy by never
    // mentioning it (the same lesson `trident-watch` taught).
    const { probe } = fixedProbe('alive')
    const { latch } = recordingLatch()
    const loop = new TridentTickLoop({
      store,
      step: idleStep,
      probe_launcher_alive: probe,
      latch_launcher_dead: latch,
      liveness_interval_ms: 25,
    })
    loop.start()
    expect(loop.describeAll().map((d) => d.name)).toEqual([
      'trident',
      'trident-watch',
      'trident-liveness',
    ])
    expect(loop.describeAll().map((d) => d.cadenceMs)).toEqual([90_000, 2_000, 25])
    // `describe()` is unchanged for single-loop callers.
    expect(loop.describe().name).toBe('trident')
    await loop.stop()
  })

  test('the default cadence is the shared liveness constant', async () => {
    const { probe } = fixedProbe('alive')
    const { latch } = recordingLatch()
    const loop = new TridentTickLoop({
      store,
      step: idleStep,
      probe_launcher_alive: probe,
      latch_launcher_dead: latch,
    })
    expect(loop.describeAll().map((d) => d.cadenceMs)).toEqual([90_000, 2_000, 15_000])
  })

  for (const [label, interval] of [
    ['0', 0],
    ['NaN', Number.NaN],
    ['overflow', 3_000_000_000],
  ] as const) {
    test(`liveness_interval_ms: ${label} disables the probe loop`, async () => {
      // `NaN <= 0` is FALSE, so a bare `<= 0` disable check would let NaN through to
      // `setInterval(fn, NaN)`, which clamps to ~1 ms: a ~500 Hz pid probe where the
      // caller asked for none.
      const { probe, seen } = fixedProbe('dead')
      const { latch, calls } = recordingLatch()
      await seedInFlight(`off-${label}`, `gen-off-${label}`)
      const loop = new TridentTickLoop({
        store,
        step: idleStep,
        probe_launcher_alive: probe,
        latch_launcher_dead: latch,
        liveness_interval_ms: interval,
      })
      loop.start()
      expect(loop.describeAll().map((d) => d.name)).toEqual(['trident', 'trident-watch'])
      await loop.runLivenessOnce()
      await new Promise((r) => setTimeout(r, 60))
      expect(seen).toEqual([])
      expect(calls).toEqual([])
      await loop.stop()
    })
  }

  test('a probe without a latch (and a latch without a probe) leaves the loop unarmed', async () => {
    // Half a signal is not a signal: a probe with nowhere to latch would observe
    // deaths and discard them, and a latch with no probe has nothing to say.
    const { probe } = fixedProbe('dead')
    const { latch } = recordingLatch()
    const probeOnly = new TridentTickLoop({ store, step: idleStep, probe_launcher_alive: probe })
    const latchOnly = new TridentTickLoop({ store, step: idleStep, latch_launcher_dead: latch })
    expect(probeOnly.describeAll().map((d) => d.name)).toEqual(['trident', 'trident-watch'])
    expect(latchOnly.describeAll().map((d) => d.name)).toEqual(['trident', 'trident-watch'])
  })
})
