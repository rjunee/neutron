/**
 * @neutronai/gateway/push — DevicePushTokenStore tests.
 *
 * Covers: register round-trip, idempotent register-on-conflict, project
 * isolation, listByOwner ordering, listByUser scoping, unregister
 * semantics. The store is a thin DDL wrapper, so the tests focus on
 * the contract the upstream dispatcher + HTTP surface rely on.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { DevicePushTokenStore } from './store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-push-store-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('DevicePushTokenStore', () => {
  test('register + getByDeviceToken round-trip', async () => {
    const store = new DevicePushTokenStore(db)
    const row = await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'ExponentPushToken[abcdef]',
      platform: 'ios',
    })
    expect(row.project_slug).toBe('t1')
    expect(row.user_id).toBe('user-a')
    expect(row.device_token).toBe('ExponentPushToken[abcdef]')
    expect(row.platform).toBe('ios')
    expect(row.registered_at.length).toBeGreaterThan(0)
    expect(row.updated_at).toBe(row.registered_at)
    expect(typeof row.id).toBe('string')
    expect(row.id.length).toBeGreaterThan(0)

    const fetched = store.getByDeviceToken('t1', 'ExponentPushToken[abcdef]')
    expect(fetched).not.toBeNull()
    expect(fetched?.id).toBe(row.id)
    expect(fetched?.user_id).toBe('user-a')
  })

  test('register is idempotent on (project_slug, device_token); same id, updated_at advances', async () => {
    const store = new DevicePushTokenStore(db)
    const first = await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-xyz',
      platform: 'ios',
    })
    // Wait so the ISO timestamp differs predictably.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-xyz',
      platform: 'ios',
    })
    expect(second.id).toBe(first.id)
    expect(second.registered_at).toBe(first.registered_at)
    expect(second.updated_at > first.updated_at).toBe(true)
    const tokens = store.listByOwner('t1')
    expect(tokens.length).toBe(1)
  })

  test('register-on-conflict swaps user_id when the device changes hands', async () => {
    const store = new DevicePushTokenStore(db)
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-shared',
      platform: 'android',
    })
    await store.register({
      project_slug: 't1',
      user_id: 'user-b',
      device_token: 'tok-shared',
      platform: 'android',
    })
    const row = store.getByDeviceToken('t1', 'tok-shared')
    expect(row?.user_id).toBe('user-b')
    // The original user no longer has any tokens.
    expect(store.listByUser('t1', 'user-a').length).toBe(0)
    expect(store.listByUser('t1', 'user-b').length).toBe(1)
  })

  test('register-on-conflict refreshes platform when it changes', async () => {
    const store = new DevicePushTokenStore(db)
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-platform',
      platform: 'ios',
    })
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-platform',
      platform: 'android',
    })
    const row = store.getByDeviceToken('t1', 'tok-platform')
    expect(row?.platform).toBe('android')
  })

  test('listByOwner returns all tokens for project, ordered by updated_at DESC', async () => {
    const store = new DevicePushTokenStore(db)
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-1',
      platform: 'ios',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-2',
      platform: 'android',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await store.register({
      project_slug: 't1',
      user_id: 'user-b',
      device_token: 'tok-3',
      platform: 'ios',
    })
    const tokens = store.listByOwner('t1')
    expect(tokens.length).toBe(3)
    // Newest first.
    expect(tokens[0]?.device_token).toBe('tok-3')
    expect(tokens[1]?.device_token).toBe('tok-2')
    expect(tokens[2]?.device_token).toBe('tok-1')
  })

  test('listByUser scopes to (project, user)', async () => {
    const store = new DevicePushTokenStore(db)
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-a1',
      platform: 'ios',
    })
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-a2',
      platform: 'android',
    })
    await store.register({
      project_slug: 't1',
      user_id: 'user-b',
      device_token: 'tok-b1',
      platform: 'ios',
    })
    const a = store.listByUser('t1', 'user-a').map((r) => r.device_token).sort()
    const b = store.listByUser('t1', 'user-b').map((r) => r.device_token).sort()
    expect(a).toEqual(['tok-a1', 'tok-a2'])
    expect(b).toEqual(['tok-b1'])
  })

  test('project isolation: same device_token across projects stays separate', async () => {
    const store = new DevicePushTokenStore(db)
    await store.register({
      project_slug: 't1',
      user_id: 'u1',
      device_token: 'shared-token',
      platform: 'ios',
    })
    await store.register({
      project_slug: 't2',
      user_id: 'u2',
      device_token: 'shared-token',
      platform: 'android',
    })
    expect(store.listByOwner('t1').length).toBe(1)
    expect(store.listByOwner('t2').length).toBe(1)
    const t1 = store.getByDeviceToken('t1', 'shared-token')
    const t2 = store.getByDeviceToken('t2', 'shared-token')
    expect(t1?.user_id).toBe('u1')
    expect(t1?.platform).toBe('ios')
    expect(t2?.user_id).toBe('u2')
    expect(t2?.platform).toBe('android')
  })

  test('unregister removes the row and returns true; second unregister returns false', async () => {
    const store = new DevicePushTokenStore(db)
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-bye',
      platform: 'ios',
    })
    expect(await store.unregister('t1', 'tok-bye')).toBe(true)
    expect(store.getByDeviceToken('t1', 'tok-bye')).toBeNull()
    expect(await store.unregister('t1', 'tok-bye')).toBe(false)
  })

  test('unregister scoped to project — does not nuke same-token cross-project', async () => {
    const store = new DevicePushTokenStore(db)
    await store.register({
      project_slug: 't1',
      user_id: 'u1',
      device_token: 'shared',
      platform: 'ios',
    })
    await store.register({
      project_slug: 't2',
      user_id: 'u2',
      device_token: 'shared',
      platform: 'ios',
    })
    expect(await store.unregister('t1', 'shared')).toBe(true)
    expect(store.getByDeviceToken('t1', 'shared')).toBeNull()
    expect(store.getByDeviceToken('t2', 'shared')).not.toBeNull()
  })

  test('rejects unknown platform via CHECK constraint', async () => {
    const store = new DevicePushTokenStore(db)
    // The TypeScript type forbids this, but a malformed HTTP body
    // could attempt it. CHECK catches it at the DB layer.
    await expect(
      store.register({
        project_slug: 't1',
        user_id: 'u1',
        device_token: 'tok-bad',
        platform: 'desktop' as unknown as 'ios',
      }),
    ).rejects.toThrow(/CHECK|constraint/i)
  })
})
