/**
 * THE PULL HALF, AND WHOSE DOING IT WAS (#518).
 *
 * `probeLauncherGenerationAlive` is the cross-restart probe behind trident's
 * `trident-liveness` loop: it asks the OS whether a recorded launcher pid is still a
 * live process. After a deploy it is the thing that finds a build's launcher gone —
 * and before #518 the only answer it had was `'dead'`, so the tick latched "inner
 * workflow launcher crashed" for a child the gateway itself had killed.
 *
 * These cases pin the attribution and, in the same breath, pin that it CANNOT
 * manufacture a death or outlive the generation it describes. The negative half is
 * the load-bearing one: the spec item says the 08-10 23:30 and 08-11 06:04 crashes
 * have no deploy near them and a fix that claims them fails review.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeLauncherGenerationAlive } from '../supervision.ts'
import { recordGatewayShutdownOutcome } from '../gateway-shutdown-kill.ts'
import { patchRecord, upsertRecord, type ReplRegistryRecord } from '../repl-registry.ts'

const KEY = 'cc-trident-fire-o-abc /repo'
/** A pid that is certainly not running: `kill -0` on it answers ESRCH. */
const DEAD_PID = 0x7ffffffe
const LIVE_PID = process.pid

function registry(over: Partial<ReplRegistryRecord> = {}, opts: { noPid?: boolean } = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), 'neutron-lla-')), 'repl-registry.json')
  const record: ReplRegistryRecord = {
    sessionKey: KEY,
    sessionId: 'session-1',
    cwd: '/repo',
    channelName: 'chan-1',
    has_session: true,
    pid: DEAD_PID,
    child_generation: 'gen-1',
    first_ready_at: 1_000,
    ...over,
  }
  if (opts.noPid === true) delete record.pid
  upsertRecord(path, record)
  return path
}

describe('probeLauncherGenerationAlive — attribution, not invention', () => {
  it('a dead pid whose row records OUR shutdown answers killed-by-gateway-shutdown', () => {
    // RED-mutation: return a bare `'dead'` from the ESRCH arm. The probe still reaps
    // the run, and reaps it with the crash sentence — the defect the spec item names.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed')
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('killed-by-gateway-shutdown')
  })

  it('CURRENT generation, already-gone → dead-cause-undetermined, NOT a deploy', () => {
    // THE BRANCH THE SUITE NEVER REACHED. Every undetermined case moved
    // `child_generation` forward first, so they all exercised the HISTORICAL-entry scan
    // and the current-row branch had no undetermined coverage at all. It was still
    // asking "is there a timestamp?", so all three observations funnelled to a deploy
    // kill and the owner was told a deploy killed a build that died on its own.
    //
    // RED-mutation: revert the current-row classification to the presence test
    // (`gatewayShutdownKillAt(record) !== undefined ? 'killed-by-gateway-shutdown' :
    // 'dead'`). This case reddens ON ITS OWN.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'already-gone', DEAD_PID)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('dead-cause-undetermined')
  })

  it('CURRENT generation, could-not-sample → dead-cause-undetermined, NOT a deploy', () => {
    // The second observation, asserted separately rather than in a loop with the first,
    // so the mutation run shows each one killing the mutant individually.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'could-not-sample', DEAD_PID)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('dead-cause-undetermined')
  })

  it('CURRENT generation, alive-and-killed → the deploy attribution is still earned', () => {
    // The complement that keeps the two cases above meaningful: a child the shutdown DID
    // kill is still attributed. RED-mutation: return `'dead-cause-undetermined'`
    // unconditionally from the current-row branch.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', DEAD_PID)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('killed-by-gateway-shutdown')
  })

  it('THE COMPLEMENT — a dead pid with no marker is still just dead', () => {
    // The 08-10 / 08-11 shape: a launcher that died with nothing recorded near it.
    // RED-mutation: return 'killed-by-gateway-shutdown' unconditionally from the ESRCH
    // arm — this reddens while the case above stays green.
    const path = registry()
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('dead')
  })

  it('a superseded generation does not excuse the current one — and needs its OWN death confirmed', () => {
    // (a) The NEW child's genuine crash is not excused by the old child's kill. RED-
    //     mutation: have `wasKilledByGatewayShutdown` ignore which generation an entry
    //     names — the negative criterion, failing.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', DEAD_PID)
    patchRecord(path, KEY, { child_generation: 'gen-2', pid: DEAD_PID })
    expect(probeLauncherGenerationAlive('gen-2', path)).toBe('dead')

    // (b) The SUPERSEDED generation is attributable — the shape of a QUARANTINED child
    //     once its replacement has spawned over the session key, and the child most
    //     likely to have been hosting live work. It used to answer 'unknown' forever.
    //
    //     BUT ONLY WITH ITS OWN DEATH CONFIRMED, against the pid the entry carries.
    //     Here that pid is dead, so the attribution is earned.
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('killed-by-gateway-shutdown')

    // And a generation nobody recorded is still 'unknown' — absence, unchanged.
    expect(probeLauncherGenerationAlive('gen-never-seen', path)).toBe('unknown')
  })

  it('A MARKED GENERATION WHOSE PROCESS IS STILL ALIVE IS NOT REPORTED DEAD', () => {
    // THE BOUNDARY AN EARLIER REVISION GOT WRONG, AND IT COULD KILL A LIVE RUN. The
    // entry is written BEFORE `kill()`; `kill()` can throw, and the process can die
    // between the two. So an entry means "we intended to kill a child we had observed
    // alive" — it ATTRIBUTES a death, it does not ESTABLISH one. A revision that
    // returned the attribution from the entry alone would crash an active build whose
    // launcher was still running.
    //
    // RED-mutation: return `'killed-by-gateway-shutdown'` from the entry without the
    // `process.kill(pid, 0)` confirmation — exactly the code this replaced.
    const path = registry({ pid: DEAD_PID })
    // Marked, with a pid that IS alive (this test process), then superseded.
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', LIVE_PID)
    patchRecord(path, KEY, { child_generation: 'gen-2' })
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('unknown')
  })

  it('an UNDETERMINED entry with a dead pid is dead-cause-undetermined, not a deploy', () => {
    // Death confirmed, cause not. RED-mutation: return `'killed-by-gateway-shutdown'`
    // for any entry regardless of what it observed — the shutdown would then claim a
    // death it explicitly recorded as not its own, and the deploy case above still
    // passes, which is why this pair is the test.
    for (const observed of ['already-gone', 'could-not-sample'] as const) {
      const path = registry()
      recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, observed, DEAD_PID)
      patchRecord(path, KEY, { child_generation: 'gen-2' })
      expect(probeLauncherGenerationAlive('gen-1', path)).toBe('dead-cause-undetermined')
    }
  })

  it('an UNDETERMINED entry whose pid is still ALIVE is unknown — no death to report', () => {
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'already-gone', LIVE_PID)
    patchRecord(path, KEY, { child_generation: 'gen-2' })
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('unknown')
  })

  it('a marked generation with NO pid on its entry is unknown, not dead', () => {
    // An entry written before the pid field existed cannot be confirmed, and "I cannot
    // check" must not read as "it is gone". RED-mutation: fall back to returning the
    // attribution when the pid is missing.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed') // no pid
    patchRecord(path, KEY, { child_generation: 'gen-2' })
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('unknown')
  })

  it('a LIVE pid is alive, marker or no marker — the marker never manufactures a death', () => {
    // RED-mutation: consult the marker before the `process.kill(pid, 0)` probe.
    const path = registry({ pid: LIVE_PID })
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('alive')
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed')
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('alive')
  })

  it('a marked row with no usable pid is unknown, not a deploy', () => {
    // "I cannot tell" must never launder into an answer. A row with no pid cannot
    // support ANY death claim, attributed or otherwise.
    const path = registry({}, { noPid: true })
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed')
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('unknown')
  })

  it('an unreadable registry is unknown', () => {
    expect(probeLauncherGenerationAlive('gen-1', join(tmpdir(), 'neutron-lla-absent', 'registry.json'))).toBe(
      'unknown',
    )
  })
})
