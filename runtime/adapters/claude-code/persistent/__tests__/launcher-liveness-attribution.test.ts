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
import { markKilledByGatewayShutdown } from '../gateway-shutdown-kill.ts'
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
    markKilledByGatewayShutdown(path, KEY, 'gen-1', 1_755_000_000_000)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('killed-by-gateway-shutdown')
  })

  it('THE COMPLEMENT — a dead pid with no marker is still just dead', () => {
    // The 08-10 / 08-11 shape: a launcher that died with nothing recorded near it.
    // RED-mutation: return 'killed-by-gateway-shutdown' unconditionally from the ESRCH
    // arm — this reddens while the case above stays green.
    const path = registry()
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('dead')
  })

  it('a superseded generation does not excuse the current one — but IS still findable', () => {
    // Two claims, and they used to be in tension because the row held one marker.
    //
    // (a) The NEW child's genuine crash is not excused by the old child's kill. RED-
    //     mutation: have `wasKilledByGatewayShutdown` ignore which generation an entry
    //     names — the negative criterion, failing.
    const path = registry()
    markKilledByGatewayShutdown(path, KEY, 'gen-1', 1_755_000_000_000)
    patchRecord(path, KEY, { child_generation: 'gen-2', pid: DEAD_PID })
    expect(probeLauncherGenerationAlive('gen-2', path)).toBe('dead')

    // (b) The SUPERSEDED generation is still attributable, which is new and is the
    //     point: this is exactly the shape of a QUARANTINED child once its replacement
    //     has spawned over the session key, and it is the child most likely to have
    //     been hosting live work. It used to answer 'unknown' and its build waited out
    //     the 90-minute reaper.
    //
    //     This is NOT "absence read as death" — the rule that arm still obeys. It is a
    //     POSITIVE record, written by the process that did the killing, before it did
    //     it. RED-mutation: delete the entry scan in `probeLauncherGenerationAlive` and
    //     this returns to 'unknown'.
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('killed-by-gateway-shutdown')

    // And a generation nobody ever recorded is still 'unknown' — absence, unchanged.
    expect(probeLauncherGenerationAlive('gen-never-seen', path)).toBe('unknown')
  })

  it('a LIVE pid is alive, marker or no marker — the marker never manufactures a death', () => {
    // RED-mutation: consult the marker before the `process.kill(pid, 0)` probe.
    const path = registry({ pid: LIVE_PID })
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('alive')
    markKilledByGatewayShutdown(path, KEY, 'gen-1', 1_755_000_000_000)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('alive')
  })

  it('a marked row with no usable pid is unknown, not a deploy', () => {
    // "I cannot tell" must never launder into an answer. A row with no pid cannot
    // support ANY death claim, attributed or otherwise.
    const path = registry({}, { noPid: true })
    markKilledByGatewayShutdown(path, KEY, 'gen-1', 1_755_000_000_000)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('unknown')
  })

  it('an unreadable registry is unknown', () => {
    expect(probeLauncherGenerationAlive('gen-1', join(tmpdir(), 'neutron-lla-absent', 'registry.json'))).toBe(
      'unknown',
    )
  })
})
