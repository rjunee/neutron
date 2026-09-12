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
  gatewayShutdownKillAt,
  gatewayShutdownKillDetail,
  markKilledByGatewayShutdown,
  reportGatewayShutdownKill,
  wasKilledByGatewayShutdown,
} from '../gateway-shutdown-kill.ts'
import { getRecord, upsertRecord, type ReplRegistryRecord } from '../repl-registry.ts'
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
    const path = registryPath()
    seed(path)
    markKilledByGatewayShutdown(path, 'cc-trident-fire-o-abc /repo', 'gen-OLD', 1_700_000_000_000)
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(record?.killed_by_gateway_shutdown_generation).toBe('gen-OLD')
    expect(record?.child_generation).toBe('gen-live')
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
  it('records the generation, the timestamp, and the crash-notified edge', () => {
    // The third field is not incidental: the caller notifies the durable crash sink
    // itself, and `crashRunningByLauncher` UPSERTS the failure reason, so the next
    // boot's watchdog re-notifying the same pid edge would OVERWRITE the deploy
    // attribution with its own bare sentence.
    // RED-mutation: drop `child_crash_notified_at` from the patch.
    const path = registryPath()
    seed(path)
    expect(markKilledByGatewayShutdown(path, 'cc-trident-fire-o-abc /repo', 'gen-live', 555)).toBe(true)
    const record = getRecord(path, 'cc-trident-fire-o-abc /repo')
    expect(record?.killed_by_gateway_shutdown_generation).toBe('gen-live')
    expect(record?.killed_by_gateway_shutdown_at).toBe(555)
    expect(record?.child_crash_notified_at).toBe(555)
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
    await reportGatewayShutdownKill(optionsFor(path, seen), 'cc-trident-fire-o-abc /repo', 'gen-live', 900)

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
    )
    expect(wasKilledByGatewayShutdown(getRecord(path, 'cc-trident-fire-o-abc /repo'))).toBe(true)
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
    )
    expect(committed).toBe(true)
  })
})
