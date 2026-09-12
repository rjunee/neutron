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
  sampleLivenessBeforeShutdownKill,
  undeterminedShutdownDetail,
  gatewayShutdownKillAt,
  gatewayShutdownKillDetail,
  markKilledByGatewayShutdown,
  reportGatewayShutdownKill,
  wasKilledByGatewayShutdown,
} from '../gateway-shutdown-kill.ts'
import { getRecord, patchRecord, upsertRecord, type ReplRegistryRecord } from '../repl-registry.ts'
import type { ChildCrashInfo, PersistentReplSubstrateOptions } from '../types.ts'

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
    markKilledByGatewayShutdown(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 1_700_000_000_000)
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(wasKilledByGatewayShutdown(record)).toBe(true)
    expect(gatewayShutdownKillAt(record)).toBe(1_700_000_000_000)
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
    // Built the way production builds it: the marker is written for the generation the
    // row names (the write path refuses anything else — see the row-scoping cases
    // below), and then a respawn moves the row on to a new generation. `spawn.ts`
    // clears the marker on that write; this asserts the SECOND line of defence, for a
    // row where that clearing did not happen.
    const path = registryPath()
    seed(path)
    expect(markKilledByGatewayShutdown(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 1_700_000_000_000)).toBe(true)
    patchRecord(path, 'cc-trident-fire-o-abc /repo', { child_generation: 'gen-NEXT' })
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(record?.killed_by_gateway_shutdown_generation).toBe('gen-live')
    expect(record?.child_generation).toBe('gen-NEXT')
    expect(wasKilledByGatewayShutdown(record)).toBe(false)
    // And no timestamp is quoted for a child the marker does not describe.
    expect(gatewayShutdownKillAt(record)).toBeUndefined()
  })

  it('false for an unmarked row, and for no row at all', () => {
    const path = registryPath()
    seed(path)
    expect(wasKilledByGatewayShutdown(getRecord(path, 'cc-trident-fire-o-abc /repo'))).toBe(false)
    expect(wasKilledByGatewayShutdown(undefined)).toBe(false)
    expect(gatewayShutdownKillAt(undefined)).toBeUndefined()
  })

  it('false when the marker is an empty string (a half-written row)', () => {
    const path = registryPath()
    seed(path, { child_generation: '', killed_by_gateway_shutdown_generation: '' })
    // Two empty strings are EQUAL, so a bare equality check would call this a
    // deploy. RED-mutation: drop the `marked.length === 0` guard.
    expect(wasKilledByGatewayShutdown(getRecord(path, 'cc-trident-fire-o-abc /repo'))).toBe(false)
  })
})

describe('markKilledByGatewayShutdown', () => {
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
    expect(markKilledByGatewayShutdown(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 555)).toBe(true)
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(record?.killed_by_gateway_shutdown_generation).toBe('gen-live')
    expect(record?.killed_by_gateway_shutdown_at).toBe(555)
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
    expect(markKilledByGatewayShutdown(path, 'a-key-with-no-row', 'gen-live', 1)).toBe(false)
    // And nothing was invented for the row that DOES exist.
    expect(wasKilledByGatewayShutdown(getRecord(path, 'cc-trident-fire-o-abc /repo'))).toBe(false)
  })

  it('reports false rather than throwing when the registry file cannot be reached', () => {
    const wrote = markKilledByGatewayShutdown(
      join(tmpdir(), 'neutron-gsk-does-not-exist', 'nested', 'registry.json'),
      'k',
      'g',
      1,
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
    await reportGatewayShutdownKill(optionsFor(path, seen), 'cc-trident-fire-o-abc /repo', 'gen-live', 900, 'alive')

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
    return reportGatewayShutdownKill(optsFor(path, seen), 'cc-trident-fire-o-abc /repo', 'gen-live', 700, 'alive').then(
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
    it(`${liveness} → cause UNKNOWN, no marker, and the crash edge is LEFT OPEN`, async () => {
      // RED-mutation: make `attributed` unconditionally true in
      // `reportGatewayShutdownKill`. A fault that landed moments before teardown is
      // then reported as a deploy and excused on disk — while the ALIVE case above
      // still passes, which is why the pair is the test rather than either half.
      const path = registryPath()
      seed(path)
      const seen: ChildCrashInfo[] = []
      await reportGatewayShutdownKill(optsFor(path, seen), 'cc-trident-fire-o-abc /repo', 'gen-live', 700, liveness)

      expect(seen).toHaveLength(1)
      expect(seen[0]?.cause).toBe('unknown')
      // Not a deploy...
      expect(seen[0]?.detail).toContain('UNDETERMINED')
      expect(seen[0]?.detail).not.toContain('a service restart or a deploy')
      // ...and not a fault verdict either.
      expect(seen[0]?.detail).not.toContain('pooled child exited')

      const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
      // NO EXCUSE ON DISK: a marker here would tell the next boot that a deploy
      // explains this death.
      expect(wasKilledByGatewayShutdown(record)).toBe(false)
      expect(record?.killed_by_gateway_shutdown_generation).toBeUndefined()
      // AND THE EDGE STAYS OPEN, which is the load-bearing half: closing it would
      // silence the next boot's honest report of the very fault we just refused to
      // claim. RED-mutation: stamp `child_crash_notified_at` on the unattributed path.
      expect(record?.child_crash_notified_at).toBeUndefined()
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
describe('markKilledByGatewayShutdown refuses a generation the row has moved past', () => {
  it('refuses, changes nothing, and cannot clobber the current generation\'s marker', async () => {
    // RED-mutation: drop the `child_generation !== childGeneration` early return. The
    // superseded write then lands, `wasKilledByGatewayShutdown` goes false because the
    // two fields disagree, and `child_crash_notified_at` is left set — the backstop
    // broken in both halves at once.
    const path = registryPath()
    seed(path) // row names 'gen-live'
    expect(markKilledByGatewayShutdown(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 500)).toBe(true)

    // Now the quarantined (superseded) generation tries to mark the same row.
    expect(markKilledByGatewayShutdown(path, 'cc-trident-fire-o-abc /repo', 'gen-QUARANTINED', 600)).toBe(false)

    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    // The pooled generation's marker SURVIVES, intact, including its timestamp.
    expect(record?.killed_by_gateway_shutdown_generation).toBe('gen-live')
    expect(record?.killed_by_gateway_shutdown_at).toBe(500)
    expect(wasKilledByGatewayShutdown(record)).toBe(true)
  })

  it('refuses BEFORE any write, so a superseded generation cannot open the edge either', () => {
    // The refusal must not be "write then undo": an unmarked row must come back
    // completely untouched, or a superseded write would close the crash edge for a
    // generation nobody reported.
    const path = registryPath()
    seed(path)
    expect(markKilledByGatewayShutdown(path, 'cc-trident-fire-o-abc /repo', 'gen-OTHER', 600)).toBe(false)
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(record?.killed_by_gateway_shutdown_generation).toBeUndefined()
    expect(record?.killed_by_gateway_shutdown_at).toBeUndefined()
    expect(record?.child_crash_notified_at).toBeUndefined()
  })
})
