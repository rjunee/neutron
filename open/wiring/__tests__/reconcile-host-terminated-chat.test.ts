import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmissionStore } from '@neutronai/gateway/project-admission-store.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { releaseReconciliationFence } from '../reconcile-host-terminated-chat.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

test.each(['success', 'transient', 'lost-ack', 'persistent', 'replacement'] as const)
('exact reconciliation fence release handles %s without touching another epoch', async fault => {
  const dir = mkdtempSync(join(tmpdir(), 'reconciliation-fence-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'project.db'); seedMigratedDb(path)
  const db = ProjectDb.open(path); cleanup.push(() => db.close())
  const store = new ProjectAdmissionStore(db)
  const scope = { ownerHandle: 'fixture', projectId: null }
  await store.register(scope)
  const fence = (await store.beginMaintenance(scope))!
  const abandon = store.abandon.bind(store)
  let calls = 0
  const release = spyOn(store, 'abandon').mockImplementation(async exact => {
    calls++
    expect(exact).toEqual(fence)
    if (fault === 'persistent' || fault === 'transient' && calls === 1) return false
    const result = await abandon(exact)
    if (fault === 'lost-ack') throw new Error('fixture lost acknowledgement after commit')
    if (fault === 'replacement') { expect(await store.beginMaintenance(scope)).not.toBeNull(); return false }
    return result
  })
  try {
    expect(await releaseReconciliationFence(store, fence)).toBe(!['persistent', 'replacement'].includes(fault))
    expect(calls).toBe(['persistent', 'transient'].includes(fault) ? 2 : 1)
    if (fault === 'persistent') expect(store.resume(scope)).toEqual(fence)
    else if (fault === 'replacement') {
      expect(store.resume(scope)?.generation).toBe(fence.generation + 1)
      expect(store.resume(scope)?.token).not.toBe(fence.token)
      expect(store.inspect(scope)?.phase).toBe('draining')
      expect(await abandon(fence)).toBe(false)
      expect(store.inspect(scope)?.phase).toBe('draining')
    } else expect(store.inspect(scope)).toMatchObject({ phase: 'open', generation: fence.generation })
  } finally { release.mockRestore() }
  // A legitimate current-epoch owner can release after a transient/persistent
  // failure; no stale fence is substituted for that independently held identity.
  const current = store.resume(scope)
  if (current) expect(await releaseReconciliationFence(store, current)).toBe(true)
  expect(store.inspect(scope)?.phase).toBe('open')
})
