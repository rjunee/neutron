import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexOwnerCredentialIdentity, openDurableCodexOwner } from '../wiring/codex-durable-owner.ts'
import { assertOwnerScope } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'

const roots: string[] = []
test('General helper admission refuses project homes and project admission refuses unmarked General homes', () => {
  const options = fixture()
  expect(() => assertOwnerScope(options.codexHome, 'project-one')).not.toThrow()
  expect(() => assertOwnerScope(options.codexHome, null)).toThrow('General owner')
  unlinkSync(join(options.codexHome, 'project-owner.json'))
  expect(() => assertOwnerScope(options.codexHome, null)).not.toThrow()
  expect(() => assertOwnerScope(options.codexHome, 'general')).toThrow()
})

test('General fixed authority refuses another selected home after restart and preserves the first reservation', async () => {
  const first = fixture(), second = fixture()
  for (const options of [first, second]) {
    unlinkSync(join(options.codexHome, 'project-owner.json'))
    writeFileSync(join(options.codexHome, '.neutron-owner-helper.json'), '{}', { mode: 0o600 })
  }
  const generalAuthorityPath = join(first.cwd, 'general-owner.json')
  // A positive namespace admission reaches the existing provenance refusal;
  // no native process is required to exercise the production reservation.
  await expect(openDurableCodexOwner({ ...first, projectId: null, generalAuthorityPath })).rejects.toThrow('provenance')
  await expect(openDurableCodexOwner({ ...second, cwd: first.cwd, projectId: null, generalAuthorityPath })).rejects.toThrow('General owner credential or directory changed')
  await expect(openDurableCodexOwner({ ...first, projectId: null, generalAuthorityPath })).rejects.toThrow('provenance')
  writeFileSync(join(first.codexHome, 'auth.json'), JSON.stringify({ tokens: {
    account_id: 'replacement-account', access_token: 'replacement-access', refresh_token: 'replacement-refresh',
  } }), { mode: 0o600 })
  await expect(openDurableCodexOwner({ ...first, projectId: null, generalAuthorityPath })).rejects.toThrow('General owner credential or directory changed')
})
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

test('#1226: a placed launch uses the SHARED host; a journal refusal before any RPC unwinds the launch reservation, any other failure keeps it', async () => {
  const { existsSync, readFileSync: read } = await import('node:fs')
  const { ProjectWorkspaceRefusal } = await import('@neutronai/runtime/adapters/claude-code/persistent/project-workspaces.ts')
  const options = fixture()
  const launchPath = join(options.codexHome, '.neutron-owner-launch.json')
  const projectWorkspace = { journalPath: join(options.cwd, 'journal.json'),
    placement: { instanceId: 'owner', projectId: 'project-one', projectLabel: 'Project One', role: 'chat' as const } }
  const placements: unknown[] = []
  let failure: Error = new ProjectWorkspaceRefusal('project-workspaces: existing ownership is invalid or pending; reconcile before retry')
  let launchFile: Record<string, unknown> | undefined
  const shared = { async spawn(_argv: string[], spawnOptions: { projectPlacement?: unknown }) {
    placements.push(spawnOptions.projectPlacement)
    launchFile = JSON.parse(read(launchPath, 'utf8'))
    throw failure
  } } as unknown as NonNullable<Parameters<typeof openDurableCodexOwner>[0]['projectWorkspaceHost']>
  await expect(openDurableCodexOwner({ ...options, projectWorkspace, projectWorkspaceHost: shared })).rejects.toThrow('reconcile before retry')
  expect(placements).toEqual([expect.objectContaining({ role: 'worker', projectId: 'project-one', taskLabel: 'Owner helper · Codex' })])
  expect(launchFile).not.toHaveProperty('projectWorkspaceHost')
  expect(launchFile).toHaveProperty('helperOperationId')
  expect(existsSync(launchPath)).toBe(false)
  // Not a pre-RPC refusal: a pane may exist, so the reservation stays for reconciliation.
  failure = new Error('layout reply lost')
  await expect(openDurableCodexOwner({ ...options, projectWorkspace, projectWorkspaceHost: shared })).rejects.toThrow('layout reply lost')
  expect(existsSync(launchPath)).toBe(true)
  expect(placements).toHaveLength(2)
})
