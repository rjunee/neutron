import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { writeInstanceModelProvider } from '@neutronai/gateway/storage/owner-metadata.ts'
import { CodexCredentialService } from '@neutronai/trident/codex-credential.ts'
import * as durable from '../wiring/codex-durable-owner.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { until } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

test('production Open chat dispatch supplies canonical Codex workspace scope for two projects and General', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-workspace-composition-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'project.db')
  seedMigratedDb(dbPath)
  const db = ProjectDb.open(dbPath)
  cleanup.push(() => db.close())
  await writeInstanceModelProvider(db, 'owner', 'openai-codex')
  const homes = new Map<string | null, string>()
  for (const projectId of ['alpha', 'general', null]) {
    const home = join(root, projectId === null ? 'general-credential' : `credential-${projectId}`)
    mkdirSync(home, { mode: 0o700 }); homes.set(projectId, home)
    if (projectId !== null) {
      mkdirSync(join(root, 'Projects', projectId), { recursive: true })
      writeFileSync(join(home, 'project-owner.json'), JSON.stringify(projectId), { mode: 0o600 })
      db.raw().run(`INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at, model_provider)
        VALUES (?, 'Same display name', 'private', 'personal', '2026-01-01', '2026-01-01', 'openai-codex')`, [projectId])
    }
  }
  const credential = (projectId: string | null) => ({ codexHome: homes.get(projectId)!, credentialIdentity: 'fixture-account' })
  const projects = spyOn(CodexCredentialService.prototype, 'resolveProjectOwnerCredential')
    .mockImplementation((_owner, projectId) => credential(projectId))
  const general = spyOn(CodexCredentialService.prototype, 'resolveGeneralOwnerCredential')
    .mockImplementation(() => credential(null))
  const launches: durable.OwnerLaunch[] = []
  const launch = spyOn(durable, 'openDurableCodexOwner').mockImplementation(async options => {
    launches.push(options)
    throw new Error('Fixture stops before native launch')
  })
  cleanup.push(() => projects.mockRestore(), () => general.mockRestore(), () => launch.mockRestore())
  const bearer = 'nbt_test_q7Xz-Kd9m2Vp4Rw8Ty6Bn1Cs3Ej5Gh'
  const env = { ...process.env, NEUTRON_HOME: root, OWNER_HOME: root, NEUTRON_DB_PATH: dbPath,
    NEUTRON_INSTANCE_SLUG: 'owner', NEUTRON_OWNER_BEARER: bearer,
    NEUTRON_LANDING_STATIC_DIR: join(import.meta.dir, '../../landing'),
    NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789' }
  const composition = await buildOpenGraphComposer({ env })({ db, project_slug: 'owner' })
  cleanup.push(async () => { for (const close of composition.realmode_cleanups ?? []) await close() })
  const surface = composition.app_ws_surface!
  const server = new Proxy({} as Parameters<typeof surface.handler>[1], {
    get() { throw new Error('HTTP chat must not use a server socket') },
  })
  for (const projectId of ['alpha', 'general', null]) {
    const response = await surface.handler(new Request('http://fixture/api/app/chat/send', {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Workspace routing probe', client_msg_id: `placement-${projectId}`,
        ...(projectId === null ? {} : { project_id: projectId }) }),
    }), server)
    expect(response?.status).toBe(200)
    const options = await until(() => launches.find(row => row.projectId === projectId), 100, 10)
    expect(options.projectWorkspace).toEqual({
      journalPath: join(root, '.trident', 'project-builds', 'herdr-workspaces', 'project-workspaces.json'),
      placement: { instanceId: 'owner', projectId, role: 'chat',
        projectLabel: projectId === null ? 'Neutron General' : 'Same display name' },
    })
  }
  expect(launches.map(row => row.projectId)).toEqual(['alpha', 'general', null])
})
