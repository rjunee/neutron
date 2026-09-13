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
import { currentBootId, readProcessIdentity, type ProcessIdentity } from '../process-identity.ts'

const KEY = 'cc-trident-fire-o-abc /repo'
/** A pid that is certainly not running: `kill -0` on it answers ESRCH. */
const DEAD_PID = 0x7ffffffe
const LIVE_PID = process.pid
/** This boot. A stamped entry is only comparable with pids from the same one. */
const BOOT = currentBootId() as string
/** What the shutdown stamps for a child it is about to kill, once that child is gone:
 *  the pid is free, so only the boot has to match for the entry to be comparable. */
const GONE_IDENTITY: ProcessIdentity = { start_ticks: 12_345, boot_id: BOOT }
/** The true identity of the live pid used below (this very test process). */
const LIVE_IDENTITY = readProcessIdentity(LIVE_PID) as ProcessIdentity
/** The same pid, stamped when a DIFFERENT process held it — what the registry looks
 *  like once the kernel has reissued a killed launcher's pid. */
const REISSUED_IDENTITY: ProcessIdentity = { ...LIVE_IDENTITY, start_ticks: LIVE_IDENTITY.start_ticks - 1 }

function registry(over: Partial<ReplRegistryRecord> = {}, opts: { noPid?: boolean } = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), 'neutron-lla-')), 'repl-registry.json')
  const record: ReplRegistryRecord = {
    sessionKey: KEY,
    sessionId: 'session-1',
    cwd: '/repo',
    channelName: 'neutron-15ab0d54e889689d70965ba3f945b480',
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
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', DEAD_PID, undefined, GONE_IDENTITY)
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
    // STAMPED, so this exercises the identity-confirmed branch rather than the
    // unverifiable fallback — the production shape, and the one where the observation
    // is the only thing standing between an undetermined death and a deploy claim.
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'already-gone', DEAD_PID, undefined, GONE_IDENTITY)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('dead-cause-undetermined')
  })

  it('CURRENT generation, could-not-sample → dead-cause-undetermined, NOT a deploy', () => {
    // The second observation, asserted separately rather than in a loop with the first,
    // so the mutation run shows each one killing the mutant individually.
    const path = registry()
    // STAMPED, so this exercises the identity-confirmed branch rather than the
    // unverifiable fallback — the production shape, and the one where the observation
    // is the only thing standing between an undetermined death and a deploy claim.
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'could-not-sample', DEAD_PID, undefined, GONE_IDENTITY)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('dead-cause-undetermined')
  })

  it('CURRENT generation, alive-and-killed → the deploy attribution is still earned', () => {
    // The complement that keeps the two cases above meaningful: a child the shutdown DID
    // kill is still attributed. RED-mutation: return `'dead-cause-undetermined'`
    // unconditionally from the current-row branch.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', DEAD_PID, undefined, GONE_IDENTITY)
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
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', DEAD_PID, undefined, GONE_IDENTITY)
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
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', LIVE_PID, undefined, LIVE_IDENTITY)
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
      recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, observed, DEAD_PID, undefined, GONE_IDENTITY)
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

  // ─── #518: a pid is an identifier, not a handle ────────────────────────────────

  it('A REISSUED PID DOES NOT KEEP A DEAD LAUNCHER ALIVE', () => {
    // Entries stay eligible for four hours and pids are recycled well inside that. With
    // only a number to go on, `process.kill(pid, 0)` answers about WHOEVER HOLDS IT NOW
    // and the probe called a killed launcher alive — its build then waits out the
    // 90-minute reaper, which is this item's own lag defect arriving through the process
    // table. The identity stamped beside the pid is what tells them apart: a running
    // process keeps its pid, so a DIFFERENT start time is positive evidence that ours
    // let go of it.
    //
    // RED-mutation: have `classifyRecordedPid` compare only `boot_id`, or return
    // `'ours-alive'` whenever the pid is live.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', LIVE_PID, undefined, REISSUED_IDENTITY)
    patchRecord(path, KEY, { child_generation: 'gen-2' })
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('killed-by-gateway-shutdown')
  })

  it('THE COMPLEMENT — the SAME pid with its TRUE identity is still ours, and still alive', () => {
    // Without this pair the case above is satisfied by code that calls every live pid
    // reissued, which would report every running launcher as killed by the deploy — the
    // spec item's forbidden direction, with the arrow reversed.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', LIVE_PID, undefined, LIVE_IDENTITY)
    patchRecord(path, KEY, { child_generation: 'gen-2' })
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('unknown')
  })

  it('AN ENTRY WITH NO IDENTITY ESTABLISHES A DEATH BUT ATTRIBUTES NOTHING', () => {
    // Reuse-followed-by-exit: the pid was handed to something unrelated and released
    // again, so its absence now is an observation about a NUMBER. An unstamped entry (a
    // pre-upgrade one, or a host with no `/proc`) cannot be tied to the process it
    // describes, so the death is reported with the cause undetermined rather than as a
    // deploy. `unknown` must not confirm.
    //
    // RED-mutation: return `'killed-by-gateway-shutdown'` from the unverifiable ESRCH
    // arm — the stamped case above stays green, so only this one catches it.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', DEAD_PID)
    patchRecord(path, KEY, { child_generation: 'gen-2' })
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('dead-cause-undetermined')
  })

  it('a half-shaped identity is no identity — it does not launder into a comparison', () => {
    // Registry rows survive upgrades and are not a trusted type boundary. A `start_ticks`
    // that is not a number must degrade to "unverifiable", never to a comparison against
    // `undefined` that happens to succeed.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', DEAD_PID, undefined, {
      start_ticks: 'soon' as unknown as number,
      boot_id: BOOT,
    })
    patchRecord(path, KEY, { child_generation: 'gen-2' })
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('dead-cause-undetermined')
  })

  it('an entry from ANOTHER BOOT is not compared against this boot pid space', () => {
    // Start ticks are counted FROM boot, so two processes from different boots can share
    // a pid AND a start time. The boot id is what stops that coincidence becoming an
    // answer — and a process from a previous boot is certainly not running now, so the
    // death is established and the entry may explain it.
    //
    // RED-mutation: drop `boot_id` from the comparison. This case then reads a live pid
    // from THIS boot as our long-dead launcher and answers 'unknown'.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', LIVE_PID, undefined, {
      start_ticks: LIVE_IDENTITY.start_ticks,
      boot_id: '00000000-0000-4000-8000-000000000000',
    })
    patchRecord(path, KEY, { child_generation: 'gen-2' })
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('killed-by-gateway-shutdown')
  })

  it('THE CURRENT-ROW BRANCH ASKS THE SAME QUESTION — a reissued pid is not a live launcher', () => {
    // The two branches are separate code and an earlier round of this item was a defect
    // in exactly one of them. Here the row still NAMES the generation, so the current-row
    // reader answers — and before the identity check it said 'alive' about a stranger.
    const path = registry({ pid: LIVE_PID })
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', LIVE_PID, undefined, REISSUED_IDENTITY)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('killed-by-gateway-shutdown')
  })

  it('THE COMPLEMENT — the current row with its TRUE identity is alive', () => {
    const path = registry({ pid: LIVE_PID })
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', LIVE_PID, undefined, LIVE_IDENTITY)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('alive')
  })

  it('the current row with a dead pid and NO identity is dead, cause undetermined', () => {
    // Same refusal on the current-row branch: the death is established by the absent pid,
    // the attribution is not, because nothing ties the number to our child.
    const path = registry()
    recordGatewayShutdownOutcome(path, KEY, 'gen-1', 1_755_000_000_000, 'alive-and-killed', DEAD_PID)
    expect(probeLauncherGenerationAlive('gen-1', path)).toBe('dead-cause-undetermined')
  })

  it('an unreadable registry is unknown', () => {
    expect(probeLauncherGenerationAlive('gen-1', join(tmpdir(), 'neutron-lla-absent', 'registry.json'))).toBe(
      'unknown',
    )
  })
})
