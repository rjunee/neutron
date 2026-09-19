import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexOwnerCredentialIdentity, openDurableCodexOwner } from '../wiring/codex-durable-owner.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-owner-refusal-')); roots.push(root)
  const codexHome = join(root, 'home'); mkdirSync(codexHome, { mode: 0o700 })
  writeFileSync(join(codexHome, 'project-owner.json'), JSON.stringify('project-one'), { mode: 0o600 })
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture-account', access_token: 'fixture-access', refresh_token: 'fixture-refresh' } }), { mode: 0o600 })
  return { projectId: 'project-one', cwd: root, codexHome, binary: 'must-not-launch', socketPath: join(codexHome, 'owner.sock'), env: {} }
}

test('native OAuth refresh changes token bytes but not credential authority; account replacement does', () => {
  const auth = (account_id: string, revision: number) => JSON.stringify({ tokens: { account_id,
    access_token: `access-${revision}`, refresh_token: `refresh-${revision}`, id_token: `id-${revision}` }, last_refresh: revision })
  expect(codexOwnerCredentialIdentity(auth('account-one', 1))).toBe(codexOwnerCredentialIdentity(auth('account-one', 2)))
  expect(codexOwnerCredentialIdentity(auth('account-one', 1))).not.toBe(codexOwnerCredentialIdentity(auth('account-two', 1)))
  expect(() => codexOwnerCredentialIdentity('{}')).toThrow('identity is unavailable')
  for (const key of ['metered-one', 'metered-two']) {
    expect(() => codexOwnerCredentialIdentity(JSON.stringify({ OPENAI_API_KEY: key, ...JSON.parse(auth('account-one', 2)) }))).toThrow('subscription')
    expect(() => codexOwnerCredentialIdentity(JSON.stringify({ OPENAI_API_KEY: key }))).toThrow('subscription')
  }
})

test('mixed OAuth plus API key refuses before launch or attachment', async () => {
  const options = fixture()
  writeFileSync(join(options.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'metered-fixture',
    tokens: { account_id: 'fixture-account', access_token: 'fixture-access', refresh_token: 'fixture-refresh' } }), { mode: 0o600 })
  await expect(openDurableCodexOwner(options)).rejects.toThrow('subscription')
})

test('an unfinished launch is not retried even when its descriptor has not appeared', async () => {
  const options = fixture()
  writeFileSync(join(options.codexHome, '.neutron-owner-launch.json'), '{}', { mode: 0o600 })
  await expect(openDurableCodexOwner(options)).rejects.toThrow('ENOENT')
})

test('a descriptor without the host launch provenance never becomes authority', async () => {
  const options = fixture()
  writeFileSync(join(options.codexHome, '.neutron-owner-helper.json'), '{}', { mode: 0o600 })
  await expect(openDurableCodexOwner(options)).rejects.toThrow('provenance')
})

test('foreign full-project marker refuses before launch', async () => {
  const options = fixture()
  await expect(openDurableCodexOwner({ ...options, projectId: 'project-two' })).rejects.toThrow('another project')
})

test('changed launch credentials refuse before any attachment or launch', async () => {
  const options = fixture()
  writeFileSync(join(options.codexHome, '.neutron-owner-launch.json'), JSON.stringify({ scope: { ...options, credential: 'old' } }), { mode: 0o600 })
  writeFileSync(join(options.codexHome, '.neutron-owner-authority.json'), '{}', { mode: 0o600 })
  await expect(openDurableCodexOwner(options)).rejects.toThrow('credential or project changed')
})
