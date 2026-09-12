/**
 * WE KILLED IT, AND THE RECORD SAYS SO (#518).
 *
 * A trident inner workflow runs detached inside a warm `claude` REPL the gateway
 * owns, so `systemctl restart` — what a deploy does once the new vendor tree is
 * checked out — reaches `shutdownAllPersistentRepls` and kills every build in
 * flight. Nothing outside the dying process can reconstruct that afterwards: a
 * later reader sees a dead pid, and "was there a deploy near this?" is a
 * correlation over timestamps that #240 already refused to assert cause from.
 *
 * So the shutdown writes it down. These cases pin the marker's two halves — that
 * it is recorded, and that it is REFUSED when it does not describe the child being
 * asked about — because the second is the one whose absence makes the reporting
 * lie in the direction the spec item forbids: a genuine fault credited to a
 * deploy. Each case names the mutation that turns it red.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeCrashReportEdge,
  gatewayShutdownKillEntryFor,
  recordGatewayShutdownKill,
  observationOf,
  pruneGatewayShutdownKills,
  sampleLivenessBeforeShutdownKill,
  undeterminedShutdownDetail,
  gatewayShutdownKillDetail,
  recordGatewayShutdownOutcome,
  reportGatewayShutdownKill,
  wasKilledByGatewayShutdown,
} from '../gateway-shutdown-kill.ts'
import {
  GATEWAY_SHUTDOWN_KILL_HISTORY,
  GATEWAY_SHUTDOWN_KILL_RETENTION_MS,
  getRecord,
  patchRecord,
  upsertRecord,
  type ReplRegistryRecord,
} from '../repl-registry.ts'

/** The generations this row records as killed by a gateway shutdown, in order. */
const killedGenerations = (record: ReplRegistryRecord | undefined): string[] =>
  (record?.killed_by_gateway_shutdown ?? []).map((e) => e.generation)
const killedAt = (record: ReplRegistryRecord | undefined, generation: string): number | undefined =>
  (record?.killed_by_gateway_shutdown ?? []).find((e) => e.generation === generation)?.at
import type { ChildCrashInfo, PersistentReplSubstrateOptions } from '../types.ts'

/** The session key `seed` writes. */
const KEY = 'cc-trident-fire-o-abc /repo'

function registryPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'neutron-gsk-')), 'repl-registry.json')
}

function seed(path: string, over: Partial<ReplRegistryRecord> = {}): ReplRegistryRecord {
  const record: ReplRegistryRecord = {
    sessionKey: 'cc-trident-fire-o-abc /repo',
    sessionId: 'session-1',
    cwd: '/repo',
    channelName: 'chan-1',
    has_session: true,
    pid: 4242,
    child_generation: 'gen-live',
    first_ready_at: 1_000,
    ...over,
  }
  upsertRecord(path, record)
  return record
}

describe('wasKilledByGatewayShutdown — the marker must describe THIS child', () => {
  it('true when the marker names the row\'s current generation', () => {
    // RED-mutation: return false unconditionally. Then the whole reporting chain
    // reverts to "pooled child exited" for a death the gateway caused.
    const path = registryPath()
    seed(path)
    recordGatewayShutdownOutcome(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 1_700_000_000_000, 'alive-and-killed')
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(wasKilledByGatewayShutdown(record)).toBe(true)
    expect(killedAt(record, 'gen-live')).toBe(1_700_000_000_000)
  })

  it('FALSE for a marker naming a SUPERSEDED generation — a later crash is not a deploy', () => {
    // THE COMPLEMENT THAT MAKES THE ABOVE MEAN ANYTHING. The registry row is keyed
    // by pool session key and outlives the child, so a marker left in place would go
    // on excusing deaths forever and the next child's genuine fault would be reported
    // as a deploy — the negative half of the spec item's acceptance, failing.
    //
    // RED-mutation: drop the `marked === record.child_generation` comparison in
    // `wasKilledByGatewayShutdown` (accept any non-empty marker) and this reddens
    // while every positive case above still passes.
    // The entry NAMES its own generation, so a respawn moving the row forward cannot
    // make it describe the new child. This is now structural rather than enforced —
    // there is no guard to remove, the shape cannot express the mistake — which is
    // why `spawn.ts` no longer clears anything here: the entry MUST outlive the
    // generation it describes.
    const path = registryPath()
    seed(path)
    expect(recordGatewayShutdownOutcome(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 1_700_000_000_000, 'alive-and-killed')).toBe(true)
    patchRecord(path, 'cc-trident-fire-o-abc /repo', { child_generation: 'gen-NEXT' })
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    // The old generation's record SURVIVES the respawn — that is the point of it...
    expect(killedGenerations(record)).toEqual(['gen-live'])
    expect(record?.child_generation).toBe('gen-NEXT')
    // ...and is not read as describing the new child.
    expect(wasKilledByGatewayShutdown(record)).toBe(false)
  })

  it('false for an unmarked row, and for no row at all', () => {
    const path = registryPath()
    seed(path)
    expect(wasKilledByGatewayShutdown(getRecord(path, 'cc-trident-fire-o-abc /repo'))).toBe(false)
    expect(wasKilledByGatewayShutdown(undefined)).toBe(false)
  })

  it('false when the marker is an empty string (a half-written row)', () => {
    const path = registryPath()
    seed(path, { child_generation: '', killed_by_gateway_shutdown: [{ generation: '', at: 5 }] })
    // Two empty strings are EQUAL, so a bare lookup would call this a deploy.
    // RED-mutation: drop the `generation.length === 0` guard in
    // `gatewayShutdownKillEntryFor`.
    expect(wasKilledByGatewayShutdown(getRecord(path, 'cc-trident-fire-o-abc /repo'))).toBe(false)
    // And a half-written entry is not positive evidence either.
    seed(path, { child_generation: 'gen-live', killed_by_gateway_shutdown: [{ generation: 'gen-live' }] as never })
    expect(wasKilledByGatewayShutdown(getRecord(path, 'cc-trident-fire-o-abc /repo'))).toBe(false)
  })
})

describe('recordGatewayShutdownOutcome', () => {
  it('records the CAUSE, and deliberately does NOT close the crash-report edge', () => {
    // The two are different facts and the ordering between them is load-bearing. The
    // attribution is knowable before the kill ("we are about to terminate a child we
    // observed alive"); that the death was REPORTED is not knowable until the sink
    // commits. Writing them together — as an earlier revision did — records an
    // intention as an outcome, and a transient sink failure then becomes permanent
    // silence: the next boot skips the edge, the respawn clears the marker, and the
    // owner gets no reason at all.
    //
    // RED-mutation: add `child_crash_notified_at: at` back to this patch. The
    // sequence test in `poison-eviction-live-work-guard.test.ts` is what catches it —
    // this case only pins the split.
    const path = registryPath()
    seed(path)
    expect(recordGatewayShutdownOutcome(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 555, 'alive-and-killed')).toBe(true)
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(killedGenerations(record)).toEqual(['gen-live'])
    expect(killedAt(record, 'gen-live')).toBe(555)
    expect(record?.child_crash_notified_at).toBeUndefined()
  })

  it('closeCrashReportEdge closes it, and only for the generation the row names', () => {
    // RED-mutation: drop the generation check in `closeCrashReportEdge` — a superseded
    // generation then silences a report nobody has made for the CURRENT child.
    const path = registryPath()
    seed(path)
    expect(closeCrashReportEdge(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 777)).toBe(true)
    expect(getRecord(path, 'cc-trident-fire-o-abc /repo')?.child_crash_notified_at).toBe(777)

    // A superseded generation may not close the edge of the one the row now names.
    const other = registryPath()
    seed(other)
    expect(closeCrashReportEdge(other, 'cc-trident-fire-o-abc /repo', 'gen-OLD', 888)).toBe(false)
    expect(getRecord(other, 'cc-trident-fire-o-abc /repo')?.child_crash_notified_at).toBeUndefined()
  })

  it('reports FALSE for the silent no-op — an absent row is patched by nobody', () => {
    // `patchRecord` only writes when the row already exists (`if (prev)`), and
    // `withRegistry` skips the save entirely on a whole-file read error. So "the call
    // did not throw" is not evidence anything was recorded, and a no-op reporting
    // success would put the next boot back to calling our own kill a crash with
    // nothing saying so (CONTRIBUTING: a no-op must be distinguishable from success).
    //
    // RED-mutation: `return true` after `patchRecord` instead of reading the row back.
    const path = registryPath()
    seed(path)
    expect(recordGatewayShutdownOutcome(path, 'a-key-with-no-row', 'gen-live', 1, 'alive-and-killed')).toBe(false)
    // And nothing was invented for the row that DOES exist.
    expect(wasKilledByGatewayShutdown(getRecord(path, 'cc-trident-fire-o-abc /repo'))).toBe(false)
  })

  it('reports false rather than throwing when the registry file cannot be reached', () => {
    const wrote = recordGatewayShutdownOutcome(
      join(tmpdir(), 'neutron-gsk-does-not-exist', 'nested', 'registry.json'),
      'k',
      'g',
      1,
      'alive-and-killed',
    )
    expect(wrote).toBe(false)
  })
})

describe('gatewayShutdownKillDetail — the sentence a human reads', () => {
  it('names the deploy and denies the crash, and pins the timestamp it was given', () => {
    // PINNED VALUES, not a relation: these exact words are the acceptance criterion
    // ("never handed a bare 'child crashed' for an event that was a deploy"), and the
    // classifier downstream matches authored text.
    const detail = gatewayShutdownKillDetail(Date.parse('2026-08-13T04:05:27.000Z'))
    expect(detail).toContain('deploy')
    expect(detail).toContain('gateway shutting down')
    expect(detail).toContain('2026-08-13T04:05:27.000Z')
    expect(detail).toContain('NOT a crash')
    expect(detail.toLowerCase()).not.toContain('pooled child exited')
  })
})

describe('reportGatewayShutdownKill — one call, both records', () => {
  const optionsFor = (
    path: string,
    seen: ChildCrashInfo[],
    over: Partial<PersistentReplSubstrateOptions> = {},
  ): PersistentReplSubstrateOptions =>
    ({
      substrate_instance_id: 'cc-trident-fire-o-abc',
      cwd: '/repo',
      replRegistryPath: path,
      onChildCrash: (info) => {
        seen.push(info)
      },
      ...over,
    }) as PersistentReplSubstrateOptions

  it('tells the sink with cause gateway-shutdown AND marks the registry', async () => {
    // RED-mutation: pass `cause: 'child-died'`. The sink's consumer composes the
    // crash sentence from that field, so the stored reason silently reverts.
    const path = registryPath()
    seed(path)
    const seen: ChildCrashInfo[] = []
    await reportGatewayShutdownKill(optionsFor(path, seen), 'cc-trident-fire-o-abc /repo', 'gen-live', 900, 'alive', { killed: true })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.cause).toBe('gateway-shutdown')
    expect(seen[0]?.generationKey).toBe('gen-live')
    expect(seen[0]?.detail).toContain('deploy')
    expect(wasKilledByGatewayShutdown(getRecord(path, 'cc-trident-fire-o-abc /repo'))).toBe(true)
  })

  it('still marks the registry when no sink is wired', async () => {
    // The marker is the backstop the NEXT boot reads. A substrate with no durable
    // sink (every pooled REPL that is not the trident launcher) must still leave the
    // record, or the next boot's watchdog reports a bare crash for our own kill.
    const path = registryPath()
    seed(path)
    await reportGatewayShutdownKill(
      { substrate_instance_id: 'cc-agent-o', cwd: '/repo', replRegistryPath: path } as PersistentReplSubstrateOptions,
      'cc-trident-fire-o-abc /repo',
      'gen-live',
      901,
      'alive',
      { killed: true },
    )
    expect(wasKilledByGatewayShutdown(getRecord(path, 'cc-trident-fire-o-abc /repo'))).toBe(true)
  })

  it('a throwing sink does not stop the shutdown, and the marker still lands', async () => {
    const path = registryPath()
    seed(path)
    await reportGatewayShutdownKill(
      optionsFor(path, [], {
        onChildCrash: () => {
          throw new Error('sink down')
        },
      }),
      'cc-trident-fire-o-abc /repo',
      'gen-live',
      902,
      'alive',
      { killed: true },
    )
    const row = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(wasKilledByGatewayShutdown(row)).toBe(true)
    // AND THE EDGE IS LEFT OPEN. This is what makes the marker a backstop rather than
    // a decoration: the next boot's watchdog must still be free to report this death.
    // RED-mutation: close the edge before the sink call instead of after it.
    expect(row?.child_crash_notified_at).toBeUndefined()
  })

  it('AWAITS an async sink — the gateway closes its database right after', async () => {
    // `shutdownAllPersistentRepls` returns a few statements before `db.close()`
    // (`gateway/index.ts`), so a sink that is not awaited loses exactly the report
    // this exists to produce. RED-mutation: drop the `await` in
    // `reportGatewayShutdownKill` and this reddens.
    const path = registryPath()
    seed(path)
    let committed = false
    await reportGatewayShutdownKill(
      optionsFor(path, [], {
        onChildCrash: async () => {
          await Promise.resolve()
          await Bun.sleep(1)
          committed = true
        },
      }),
      'cc-trident-fire-o-abc /repo',
      'gen-live',
      903,
      'alive',
      { killed: true },
    )
    expect(committed).toBe(true)
  })
})

/**
 * FINDING 1 — THIS MODULE'S OWN THESIS, RUNNING BACKWARDS.
 *
 * `kill()` is idempotent after exit (`pty-host.ts`), so teardown "kills" a child that
 * died of a genuine fault moments earlier exactly as readily as a live one. The first
 * cut reported before sampling anything, which meant a real fault was attributed to
 * the deploy — and that is the WORSE direction of the same defect this PR fixes: a
 * bare crash for a deploy makes the owner look for a bug that is not there, but a
 * deploy for a real fault makes him not look at a bug that is.
 */
describe('sampleLivenessBeforeShutdownKill — three answers, because there are three facts', () => {
  it('a live child is alive; an exited child is already-gone', () => {
    expect(sampleLivenessBeforeShutdownKill(() => false)).toBe('alive')
    expect(sampleLivenessBeforeShutdownKill(() => true)).toBe('already-gone')
  })

  it('a probe that THROWS is could-not-sample — not alive, and not gone either', () => {
    // "It was dead" and "I could not look" are different facts and only one is an
    // observation. RED-mutation: drop the try/catch (the throw escapes) or return
    // `'already-gone'` from the catch, collapsing a non-observation into an observation.
    expect(
      sampleLivenessBeforeShutdownKill(() => {
        throw new Error('child handle gone')
      }),
    ).toBe('could-not-sample')
  })
})

describe('only a child observed ALIVE is attributed to the shutdown', () => {
  const optsFor = (path: string, seen: ChildCrashInfo[]): PersistentReplSubstrateOptions =>
    ({
      substrate_instance_id: 'cc-trident-fire-o-abc',
      cwd: '/repo',
      replRegistryPath: path,
      onChildCrash: (info) => {
        seen.push(info)
      },
    }) as PersistentReplSubstrateOptions

  it('ALIVE → cause gateway-shutdown, and the durable marker is written', () => {
    // The positive arm. Kept beside its complement so neither can be satisfied alone.
    const path = registryPath()
    seed(path)
    const seen: ChildCrashInfo[] = []
    return reportGatewayShutdownKill(optsFor(path, seen), 'cc-trident-fire-o-abc /repo', 'gen-live', 700, 'alive', { killed: true }).then(
      () => {
        expect(seen[0]?.cause).toBe('gateway-shutdown')
        expect(seen[0]?.detail).toContain('deploy')
        const row = getRecord(path, 'cc-trident-fire-o-abc /repo')
        expect(wasKilledByGatewayShutdown(row)).toBe(true)
        // The sink committed, so — and only so — the edge is closed behind it.
        expect(row?.child_crash_notified_at).toBe(700)
      },
    )
  })

  for (const liveness of ['already-gone', 'could-not-sample'] as const) {
    it(`${liveness} → cause UNKNOWN, recorded AS undetermined, not as a kill`, async () => {
      // RED-mutation: make `attributed` unconditionally true in
      // `reportGatewayShutdownKill`. A fault that landed moments before teardown is
      // then reported as a deploy and excused on disk — while the ALIVE case above
      // still passes, which is why the pair is the test rather than either half.
      const path = registryPath()
      seed(path)
      const seen: ChildCrashInfo[] = []
      await reportGatewayShutdownKill(optsFor(path, seen), 'cc-trident-fire-o-abc /repo', 'gen-live', 700, liveness, { killed: false })

      expect(seen).toHaveLength(1)
      expect(seen[0]?.cause).toBe('unknown')
      // Not a deploy...
      expect(seen[0]?.detail).toContain('UNDETERMINED')
      expect(seen[0]?.detail).not.toContain('a service restart or a deploy')
      // ...and not a fault verdict either.
      expect(seen[0]?.detail).not.toContain('pooled child exited')

      const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
      // NO EXCUSE ON DISK: nothing here may tell the next boot that a deploy explains
      // this death.
      expect(wasKilledByGatewayShutdown(record)).toBe(false)
      // BUT THE OUTCOME IS RECORDED, and this assertion was inverted before — it
      // demanded NO entry at all, which left `undetermined` sharing its representation
      // with an ordinary crash, so the retry reported it as a confident `child-died`.
      // An `already-gone` entry excuses nothing; it records that the shutdown reached a
      // child that had already died. RED-mutation: write no entry unless we killed it.
      expect(killedGenerations(record)).toEqual(['gen-live'])
      expect(observationOf(gatewayShutdownKillEntryFor(record, 'gen-live'))).toBe(liveness)
      // AND THE EDGE IS CLOSED, because the report was DELIVERED. This case used to
      // assert the opposite, and that was the defect: the edge records that a report
      // happened, not what it said, so a delivered "undetermined" closes it exactly as
      // a delivered deploy attribution does. Leaving it open let the next tick report
      // the same death again as a confident `child-died`, overwriting the honest
      // answer. RED-mutation: restore `report.attributed &&` on the close condition.
      expect(record?.child_crash_notified_at).toBe(700)
    })
  }

  it('the two undetermined sentences say WHICH of the two happened', () => {
    // A single "undetermined" blur would lose the distinction between an observation
    // and a failure to observe. Pinned values, not a relation.
    const gone = undeterminedShutdownDetail('already-gone', Date.parse('2026-08-13T04:05:27.000Z'))
    const blind = undeterminedShutdownDetail('could-not-sample', Date.parse('2026-08-13T04:05:27.000Z'))
    expect(gone).toContain('ALREADY gone')
    expect(gone).toContain('the shutdown did not end it')
    expect(blind).toContain('could not be read')
    expect(gone).not.toBe(blind)
    for (const text of [gone, blind]) {
      expect(text).toContain('2026-08-13T04:05:27.000Z')
      expect(text).toContain('UNDETERMINED')
    }
  })
})

/**
 * FINDING 2 — THE MARKER IS GENERATION-SCOPED; THE ROW IS NOT.
 *
 * One teardown reaches two generations on one session key: the pooled child, and a
 * quarantined child that held the key before a fresh spawn took it over. They share
 * one registry row, and the later write was replacing the earlier one — leaving the
 * row naming one generation and the marker naming the other, so attribution failed
 * AND `child_crash_notified_at` stayed set, disabling the next boot's backstop in
 * exactly the case it exists for.
 */
describe('the row records EVERY generation it killed, which is what a quarantined child needs', () => {
  it('a superseded generation is recorded ALONGSIDE the current one, not instead of it', () => {
    // THE BLOCKER THIS SHAPE FIXES. One teardown reaches two generations on one
    // session key: the pooled child, and a QUARANTINED child the row no longer names
    // because a replacement spawned over it. The previous single-slot marker could
    // hold only one, so it REFUSED the quarantined one — and that child, quarantined
    // precisely because it still hosts running workflows, had no durable record at
    // all if its live report failed.
    //
    // RED-mutation: restore the single-slot write (`patchRecord` with
    // `killed_by_gateway_shutdown_generation`) — the second mark overwrites the first
    // and this reddens on the first assertion.
    const path = registryPath()
    seed(path) // row names 'gen-live'
    expect(recordGatewayShutdownOutcome(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 500, 'alive-and-killed')).toBe(true)
    // The quarantined generation the row has already moved past.
    expect(recordGatewayShutdownOutcome(path, 'cc-trident-fire-o-abc /repo', 'gen-QUARANTINED', 600, 'alive-and-killed')).toBe(true)

    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(killedGenerations(record)).toEqual(['gen-live', 'gen-QUARANTINED'])
    expect(killedAt(record, 'gen-live')).toBe(500)
    expect(killedAt(record, 'gen-QUARANTINED')).toBe(600)
    // The CURRENT child's answer is unchanged by the presence of the other entry.
    expect(wasKilledByGatewayShutdown(record)).toBe(true)
    expect(killedAt(record, 'gen-live')).toBe(500)
    // And the superseded generation is findable on its own terms — the lookup a
    // quarantined child's build depends on.
    expect(gatewayShutdownKillEntryFor(record, 'gen-QUARANTINED')?.at).toBe(600)
  })

  it('re-marking a generation keeps the first timestamp — the kill happened once', () => {
    // RED-mutation: append unconditionally. The list then grows one entry per retry
    // and the recorded time drifts away from the kill it describes.
    const path = registryPath()
    seed(path)
    expect(recordGatewayShutdownOutcome(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 500, 'alive-and-killed')).toBe(true)
    expect(recordGatewayShutdownOutcome(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 900, 'alive-and-killed')).toBe(true)
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(killedGenerations(record)).toEqual(['gen-live'])
    expect(killedAt(record, 'gen-live')).toBe(500)
  })

  it('an entry a LIVE RUN still references is never evicted, however many follow it', () => {
    // THE PROPERTY, not the mechanism. The old case asserted that eviction happens; it
    // could not see that eviction had taken an attribution a running build still needed.
    // Repro it named: `g0` owns a running build, its live report failed, and enough later
    // generations are recorded on the same session key to push it out. Under a count cap
    // `g0` was evicted and its attribution was unrecoverable — the stranding this whole
    // change exists to prevent, caused by the cap meant to be harmless.
    //
    // RED-mutation: drop the `stillReferenced` arm from `pruneGatewayShutdownKills` (keep
    // only the age test). `g0` disappears and this reddens.
    const path = registryPath()
    seed(path)
    const ANCIENT = 1_000
    expect(recordGatewayShutdownOutcome(path, KEY, 'g0', ANCIENT, 'alive-and-killed', 4242)).toBe(true)

    // `g0` still owns an in-flight run; every other generation does not.
    const stillReferenced = (generation: string): boolean => generation === 'g0'
    // Far more than the backstop, and all of them far NEWER than the retention window.
    const recent = ANCIENT + GATEWAY_SHUTDOWN_KILL_RETENTION_MS * 10
    for (let i = 0; i < GATEWAY_SHUTDOWN_KILL_HISTORY + 20; i++) {
      patchRecord(path, KEY, { child_generation: `later-${i}` })
      recordGatewayShutdownOutcome(path, KEY, `later-${i}`, recent + i, 'alive-and-killed', 4242, stillReferenced)
    }

    const record = getRecord(path, KEY)
    // `g0` SURVIVES — ancient, far past the window, and beyond the cap, because a run
    // still refers to it. Its attribution is therefore still recoverable.
    expect(gatewayShutdownKillEntryFor(record, 'g0')?.at).toBe(ANCIENT)
    expect(observationOf(gatewayShutdownKillEntryFor(record, 'g0'))).toBe('alive-and-killed')
  })

  it('the PRODUCTION path threads hostsLiveWork, so a live run protects its own entry', () => {
    // The unit cases above hand `stillReferenced` in directly, which proves the RULE and
    // not the WIRING — measured: a mutation that stopped `reportGatewayShutdownKill`
    // passing the probe survived every one of them. `hostsLiveWork` is the seam the pool
    // already consults before evicting a child that hosts live work, and this asserts the
    // record path consults the same one.
    //
    // RED-mutation: pass `undefined` instead of the `hostsLiveWork` adapter in
    // `recordGatewayShutdownKill`. The ancient entry is then released on age, because
    // nothing tells retention that a run still needs it.
    const path = registryPath()
    seed(path)
    const ANCIENT = 1_000
    expect(recordGatewayShutdownOutcome(path, KEY, 'gen-live', ANCIENT, 'alive-and-killed', 4242)).toBe(true)

    patchRecord(path, KEY, { child_generation: 'gen-next' })
    const options = {
      substrate_instance_id: 'cc-trident-fire-o-abc',
      cwd: '/repo',
      replRegistryPath: path,
      // The old generation still hosts a live workflow; the new one does not.
      hostsLiveWork: (generation: string) => (generation === 'gen-live' ? 3 : 0),
    } as PersistentReplSubstrateOptions
    recordGatewayShutdownKill(
      options,
      KEY,
      'gen-next',
      ANCIENT + GATEWAY_SHUTDOWN_KILL_RETENTION_MS * 5,
      'alive',
      4242,
    )

    // The ancient entry survives ONLY because the threaded probe said a run still needs it.
    expect(gatewayShutdownKillEntryFor(getRecord(path, KEY), 'gen-live')?.at).toBe(ANCIENT)
  })

  it('a THROWING hostsLiveWork does not break the record path', () => {
    const path = registryPath()
    seed(path)
    const options = {
      substrate_instance_id: 'x',
      cwd: '/repo',
      replRegistryPath: path,
      hostsLiveWork: () => {
        throw new Error('store down')
      },
    } as PersistentReplSubstrateOptions
    expect(() => recordGatewayShutdownKill(options, KEY, 'gen-live', 10, 'alive', 4242)).not.toThrow()
    expect(gatewayShutdownKillEntryFor(getRecord(path, KEY), 'gen-live')).toBeDefined()
  })

  it('an entry outside the window that nothing references IS released', () => {
    // The complement: retention must actually bound growth, or the fix above is just a
    // leak. RED-mutation: `return true` from the age test — nothing is ever released.
    const path = registryPath()
    seed(path)
    expect(recordGatewayShutdownOutcome(path, KEY, 'gen-old', 1_000, 'alive-and-killed', 4242)).toBe(true)
    patchRecord(path, KEY, { child_generation: 'gen-new' })
    recordGatewayShutdownOutcome(
      path,
      KEY,
      'gen-new',
      1_000 + GATEWAY_SHUTDOWN_KILL_RETENTION_MS + 1,
      'alive-and-killed',
      4242,
      () => false,
    )
    const record = getRecord(path, KEY)
    expect(gatewayShutdownKillEntryFor(record, 'gen-old')).toBeUndefined()
    expect(gatewayShutdownKillEntryFor(record, 'gen-new')).toBeDefined()
  })

  it('inside the window an entry is kept even when nothing claims to reference it', () => {
    // Age governs on its own, so an unwired or negative reference probe can never evict a
    // young entry. RED-mutation: make the keep condition `stillReferenced?.(...) === true`
    // alone, dropping the age test.
    const path = registryPath()
    seed(path)
    recordGatewayShutdownOutcome(path, KEY, 'gen-young', 5_000, 'alive-and-killed', 4242)
    patchRecord(path, KEY, { child_generation: 'gen-next' })
    recordGatewayShutdownOutcome(path, KEY, 'gen-next', 6_000, 'alive-and-killed', 4242, () => false)
    expect(gatewayShutdownKillEntryFor(getRecord(path, KEY), 'gen-young')).toBeDefined()
  })

  it('pruneGatewayShutdownKills: a THROWING reference probe never protects, and never crashes', () => {
    const young = { generation: 'y', at: 1_000, observed: 'alive-and-killed' as const }
    const old = { generation: 'o', at: 0, observed: 'alive-and-killed' as const }
    // `young` is a strict `<`, so the boundary is exclusive: pick a `now` that leaves the
    // young entry genuinely inside the window.
    const now = GATEWAY_SHUTDOWN_KILL_RETENTION_MS + 999
    const kept = pruneGatewayShutdownKills([old, young], now, () => {
      throw new Error('store down')
    })
    // The young one survives on age; the old one is released because the probe
    // established nothing and age already answered.
    expect(kept.map((e) => e.generation)).toEqual(['y'])
  })

  it('a row that does not exist is still refused — a no-op is not a success', () => {
    const path = registryPath()
    seed(path)
    expect(recordGatewayShutdownOutcome(path, 'a-key-with-no-row', 'gen-live', 1, 'alive-and-killed')).toBe(false)
    expect(recordGatewayShutdownOutcome(path, 'cc-trident-fire-o-abc /repo', '', 1, 'alive-and-killed')).toBe(false)
  })
})

/**
 * #518 — CORRUPT AND FORWARD-VERSION ENTRIES MUST NOT BECOME POSITIVE ATTRIBUTION.
 *
 * An earlier revision validated only `generation` and `at`, and mapped every missing OR
 * UNRECOGNISED `observed` value to `'alive-and-killed'` — the MOST definite answer
 * available. So an entry written by a newer build than the one reading it, with no
 * corruption at all, made a genuine crash report as a deploy. That is the first defect in
 * this change with the arrow reversed: two rounds went into making sure `unknown` never
 * rides the branch carrying a definite answer, and the parser then promoted a value it
 * did not recognise to the most definite one there is.
 */
describe('an entry that cannot say what was observed is evidence of nothing', () => {
  for (const [label, observed] of [
    ['a corrupt value', 'corrupt'],
    ['a FORWARD-VERSION value a newer build might write', 'killed-by-some-future-mechanism'],
    ['an empty string', ''],
    ['a non-string', 7],
    ['null', null],
  ] as const) {
    it(`${label} is refused, not promoted to alive-and-killed`, () => {
      // RED-mutation: restore the `: 'alive-and-killed'` fallback in `observationOf`, or
      // drop `isObservation(e.observed)` from the validator. Each of these cases reddens
      // on its own.
      const path = registryPath()
      seed(path, { killed_by_gateway_shutdown: [{ generation: 'gen-live', at: 1, observed }] as never })
      const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
      expect(gatewayShutdownKillEntryFor(record, 'gen-live')).toBeUndefined()
      expect(observationOf(gatewayShutdownKillEntryFor(record, 'gen-live'))).toBeUndefined()
      // The load-bearing consequence: no deploy attribution for a death nobody recorded.
      expect(wasKilledByGatewayShutdown(record)).toBe(false)
    })
  }

  it('an ABSENT observed is refused too — there is no legacy shape to protect', () => {
    // Measured, not assumed: `killed_by_gateway_shutdown` has zero occurrences on
    // `origin/main`, so the container and `observed` ship in the SAME unmerged change and
    // no build has ever written an entry without it. A compat arm would cover nothing
    // while silently promoting every corrupt and forward-version entry.
    //
    // RED-mutation: treat `undefined` as `'alive-and-killed'`.
    const path = registryPath()
    seed(path, { killed_by_gateway_shutdown: [{ generation: 'gen-live', at: 1 }] as never })
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(gatewayShutdownKillEntryFor(record, 'gen-live')).toBeUndefined()
    expect(wasKilledByGatewayShutdown(record)).toBe(false)
  })

  it('THE COMPLEMENT — all three real observations still round-trip', () => {
    // A validator that refused everything would pass every case above and break the
    // feature. RED-mutation: `return false` from `isObservation`.
    for (const observed of ['alive-and-killed', 'already-gone', 'could-not-sample'] as const) {
      const path = registryPath()
      seed(path)
      expect(recordGatewayShutdownOutcome(path, KEY, 'gen-live', 42, observed, 4242)).toBe(true)
      const record = getRecord(path, KEY)
      expect(observationOf(gatewayShutdownKillEntryFor(record, 'gen-live'))).toBe(observed)
      expect(wasKilledByGatewayShutdown(record)).toBe(observed === 'alive-and-killed')
    }
  })
})
