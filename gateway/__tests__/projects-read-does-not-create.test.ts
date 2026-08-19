/**
 * ISSUES #412 — reading a project must not CREATE one.
 *
 * `SqliteProjectSettingsStore.get()` used to persist a default row for any
 * unknown project_id ("auto-seed-on-first-access"), and `list()` reads that
 * same table. So `GET /api/app/projects/<any id>/settings` was, in effect, a
 * project-creation endpoint.
 *
 * It fired in production on 2026-07-28: one tap on a mobile rail tile
 * navigated to `/projects/general`, the shell fetched settings for that id,
 * and a real empty project named "General" appeared in the instance — showing
 * up in the web rail as a duplicate next to the synthetic General scope. Ryan
 * saw two Generals and asked what created the second one.
 *
 * Both implementations are covered because they are twins and the in-memory
 * one is the seam most surface tests run against — a divergence there lets a
 * green surface test describe behaviour production does not have.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SqliteProjectSettingsStore } from '../projects/sqlite-store.ts'
import {
  InMemoryProjectSettingsStore,
  createAppProjectsSurface,
} from '../http/app-projects-surface.ts'
import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'

const OWNER = 'issues-412'

let tmp: string
let db: ProjectDb
let store: SqliteProjectSettingsStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-412-'))
  seedMigratedDb(join(tmp, 'owner.db'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  store = new SqliteProjectSettingsStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('SQLite: GET on an unknown id returns a doc but creates NO project', async () => {
  const doc = await store.get(OWNER, 'general')
  // The settings drawer still gets its canonical document...
  expect(doc?.id).toBe('general')
  expect(doc?.name).toBe('General')
  expect(doc?.privacy_mode).toBe('private')

  // ...and the rail stays empty. THIS is the assertion that was false before.
  expect(await store.list(OWNER)).toHaveLength(0)
})

test('SQLite: the synthesised doc is identical to a persisted-then-read one', async () => {
  // The old code persisted the seed and re-read it through `rowToSettings`,
  // which resolves a NULL emoji column via `resolveProjectEmoji(null, name)`.
  // `buildDefaultSettings` sets `defaultProjectEmoji(name)` — the same call.
  // If those ever diverge, the drawer would render differently before and
  // after the first PATCH, which is a bug a user would actually see.
  const before = await store.get(OWNER, 'weekly-review')
  await store.update(OWNER, 'weekly-review', { privacy_mode: 'private' })
  const after = await store.get(OWNER, 'weekly-review')
  expect(after).toEqual(before!)
})

test('SQLite: a real PATCH DOES materialise the project', async () => {
  // The write path must still work — a project has to come into existence
  // somewhere, and an explicit mutation is the right place.
  const patched = await store.update(OWNER, 'roadmap', { name: 'Roadmap 2027' })
  expect(patched?.name).toBe('Roadmap 2027')

  const listed = await store.list(OWNER)
  expect(listed.map((p) => p.id)).toEqual(['roadmap'])
  // ...and it survives a fresh store over the same DB (real persistence, not
  // a per-instance cache).
  expect(await new SqliteProjectSettingsStore(db).get(OWNER, 'roadmap')).toMatchObject({
    name: 'Roadmap 2027',
  })
})

test('SQLite: a PATCH that changes nothing is a read, and creates nothing', async () => {
  // An empty patch body is not a mutation. Materialising on it would reopen
  // the same hole through a different verb.
  const res = await store.update(OWNER, 'ghost', {})
  expect(res?.id).toBe('ghost')
  expect(await store.list(OWNER)).toHaveLength(0)
})

test('SQLite: an explicitly seeded project is unaffected', async () => {
  // seedDefaults is the legitimate creation path and must keep working.
  await store.seedDefaults([(await store.get(OWNER, 'neutron'))!])
  expect((await store.list(OWNER)).map((p) => p.id)).toEqual(['neutron'])
  // A GET on a DIFFERENT id still adds nothing to the list.
  await store.get(OWNER, 'passing-through')
  expect((await store.list(OWNER)).map((p) => p.id)).toEqual(['neutron'])
})

test('in-memory twin behaves identically — read no, write yes', async () => {
  const mem = new InMemoryProjectSettingsStore()
  expect((await mem.get(OWNER, 'general'))?.name).toBe('General')
  expect(await mem.list(OWNER)).toHaveLength(0)

  await mem.update(OWNER, 'general', {})
  expect(await mem.list(OWNER)).toHaveLength(0)

  await mem.update(OWNER, 'general', { name: 'General' })
  expect((await mem.list(OWNER)).map((p) => p.id)).toEqual(['general'])
})

test('over HTTP: GET /settings then GET /projects — the list stays empty', async () => {
  // The store-level assertions are the substance; this one proves the defect
  // is not reintroduced by the surface between the route and the store
  // (`handleGet` is a direct pass-through at app-projects-surface.ts:889).
  const surface = createAppProjectsSurface({
    store: new InMemoryProjectSettingsStore(),
    auth: createAppWsAuthResolver({ project_slug: OWNER, bypass: true }),
  })

  const authed = { headers: { authorization: 'Bearer dev:sam' } }

  const settings = await surface.handler(
    new Request('http://x/api/app/projects/general/settings', authed),
  )
  expect(settings?.status).toBe(200)
  const settingsBody = (await settings!.json()) as { project: { name: string } }
  expect(settingsBody.project.name).toBe('General')

  const list = await surface.handler(new Request('http://x/api/app/projects', authed))
  expect(list?.status).toBe(200)
  const listBody = (await list!.json()) as { projects: unknown[] }
  expect(listBody.projects).toHaveLength(0)
})
