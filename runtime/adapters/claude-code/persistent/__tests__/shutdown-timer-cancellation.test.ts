/**
 * A BOUND THAT IS ALSO A FLOOR IS NOT A BOUND (#518).
 *
 * Both waits in `gateway-shutdown-kill.ts` are `Promise.race([work, timer])`. Racing
 * settles the AWAIT as soon as the work wins; it does not stop the timer, and a pending
 * timer keeps the runtime alive. So a shutdown whose children exited at once and whose
 * sinks answered at once still sat out the full budget — inside a deadline systemd owns
 * (`TimeoutStopSec=30`), spent on nothing, while the cgroup SIGKILL comes regardless.
 *
 * THE DETERMINISTIC CASES CANNOT SEE THIS, and that is the lesson rather than an
 * oversight: they inject a wait that resolves instantly, which makes the requested BUDGET
 * observable and the TIMER unobservable. A fake that replaces the mechanism removes the
 * property the mechanism has. Process liveness is only observable in a process, so this
 * file runs the real code in a subprocess and measures how long that process lives.
 *
 * The leak control is what makes the measurement evidence rather than decoration: the
 * same script, with one uncancelled race added, must be held open for the whole budget.
 * Without it a fast harness would "prove" cancellation on a machine where the timer
 * never ran at all.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Long enough that a leak is unmistakable, short enough to pay twice. */
const BUDGET_MS = 3_000
const MODULE = join(import.meta.dir, '..', 'gateway-shutdown-kill.ts')

function script(mode: 'delivery' | 'confirm' | 'leak'): string {
  return `
import { deliverShutdownKillReports, confirmShutdownExits } from ${JSON.stringify(MODULE)}

const report = {
  options: { substrate_instance_id: 'x', cwd: '/repo', onChildCrash: () => {} },
  sessionKey: 'k',
  childGeneration: 'g',
  at: 1,
  observed: 'alive-and-killed',
  liveness: 'alive',
  durablyRecorded: 'alive-and-killed',
}

const mode = ${JSON.stringify(mode)}
if (mode === 'confirm') {
  // A child that is not yet flagged exited, whose exit lands immediately: the grace is
  // raced and won, and must then be released.
  let exited = false
  const child = {
    exited: Promise.resolve(0).then((c) => { exited = true; return c }),
    hasExited: () => exited,
    kill: () => {},
  }
  await confirmShutdownExits([{ report, child, signalDelivered: true }], { graceMs: ${BUDGET_MS} })
} else {
  await deliverShutdownKillReports([report], { perSinkMs: ${BUDGET_MS}, phaseBudgetMs: ${BUDGET_MS} })
  if (mode === 'leak') {
    // THE CONTROL: one uncancelled race, exactly what the code used to do.
    await Promise.race([Promise.resolve(), Bun.sleep(${BUDGET_MS})])
  }
}
console.log('done')
`
}

/** Run the script to completion. The CALLER times it, deliberately: the elapsed
 *  subtraction has to be visible in the case itself or the wall-clock gate cannot see
 *  the assertion it is being asked to excuse, and the opt-out marker would be prose. */
async function runFor(mode: 'delivery' | 'confirm' | 'leak'): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-timer-'))
  const file = join(dir, `${mode}.ts`)
  writeFileSync(file, script(mode))
  const proc = Bun.spawn(['bun', 'run', file], { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${mode} exited ${code}: ${await new Response(proc.stderr).text()}`)
}

describe('a bounded wait is released when the work wins (#518)', () => {
  it('THE CONTROL — an uncancelled race really does hold the process open', async () => {
    const started = Date.now()
    await runFor('leak')
    // WALL-CLOCK-BOUND-OK: the property IS elapsed process lifetime — a leaked timer is
    // observable only as a process that stays alive, and no logical clock can stand in
    // for that. This case exists to prove the measurement CAN fail: without it the two
    // below would pass on an implementation that never cancelled anything. Measured
    // margin: an uncancelled 3 s race exits at ~3.0 s (2.14 s for a 2 s race on this
    // box); the threshold is 2.5 s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(BUDGET_MS - 500)
  }, 30_000)

  it('the delivery phase leaves nothing pending after a sink that answers at once', async () => {
    const started = Date.now()
    await runFor('delivery')
    // WALL-CLOCK-BOUND-OK: same property as the control above, and the deterministic
    // cases cannot reach it — injecting the wait is exactly what made the timer
    // invisible. Measured margin: ~0.3 s against a 3 s budget, asserted at 2 s, so the
    // case has an order of magnitude of headroom on a loaded runner. RED-mutation: drop
    // `bound.cancel()` from the `finally` in `deliverShutdownKillReports`.
    expect(Date.now() - started).toBeLessThan(BUDGET_MS - 1_000)
  }, 30_000)

  it('the exit-confirmation grace is released once the children are gone', async () => {
    const started = Date.now()
    await runFor('confirm')
    // WALL-CLOCK-BOUND-OK: the second site is separate code with the same
    // unobservable-by-fake property, and the same measured margin (~0.3 s against a 3 s
    // budget, asserted at 2 s). RED-mutation: drop `bound.cancel()` from
    // `confirmShutdownExits`.
    expect(Date.now() - started).toBeLessThan(BUDGET_MS - 1_000)
  }, 30_000)
})
