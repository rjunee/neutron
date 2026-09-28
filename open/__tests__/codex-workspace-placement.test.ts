import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as rpc from '@neutronai/runtime/adapters/claude-code/persistent/herdr-client.ts'
import * as identity from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'
import { FakeHerdrWorkspaceServer } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'
import { codexOwnerTerminal } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-workspace.ts'
import { herdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import type { ProjectWorkspaceLaunch } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspace-host.ts'
import { codexOwnerCredentialIdentity, openDurableCodexOwner } from '../wiring/codex-durable-owner.ts'
import { createWorkerTerminalHost, ownerWorkspaceLaunch } from '../wiring/project-build-terminal.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-workspace-placement-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const server = new FakeHerdrWorkspaceServer()
  const connect = spyOn(rpc, 'createHerdrRpc').mockImplementation(() => server)
  const processIdentity = spyOn(identity, 'helperIdentity').mockImplementation(pid => ({ pid: pid ?? process.pid, boot: 'fixture-boot', start: '1' }))
  cleanup.push(() => connect.mockRestore(), () => processIdentity.mockRestore())
  const options = (projectId: string | null) => {
    const home = join(root, projectId === null ? 'null' : `project-${projectId}`)
    mkdirSync(home, { mode: 0o700 })
    if (projectId !== null) writeFileSync(join(home, 'project-owner.json'), JSON.stringify(projectId), { mode: 0o600 })
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: {
      account_id: 'fixture-account', access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    } }), { mode: 0o600 })
    return { projectId, cwd: root, codexHome: home, binary: 'must-not-run', socketPath: join(home, 'owner.sock'),
      generalAuthorityPath: join(root, 'general-owner.json'), timeoutMs: 1,
      env: { HERDR_SOCKET_PATH: join(root, 'fake.sock'), HERDR_WORKSPACE_ID: 'foreign-inherited-workspace' },
      projectWorkspace: ownerWorkspaceLaunch(root, { instanceId: 'instance', projectId, projectLabel: 'Same display name' }) }
  }
  return { root, server, options }
}

test('durable helper, native Chat and bounded worker share each exact project workspace; General stays separate', async () => {
  const f = fixture()
  const workspaces = new Set<string>()
  for (const projectId of ['alpha', 'general', null]) {
    const options = f.options(projectId)
    // The fake server never executes a command. The actual launch path reserves
    // and places its helper, then correctly refuses the missing native descriptor.
    await expect(openDurableCodexOwner(options)).rejects.toThrow('launch is uncertain')
    const launch = JSON.parse(readFileSync(join(options.codexHome, '.neutron-owner-launch.json'), 'utf8'))
    expect(launch.projectWorkspace).toEqual(options.projectWorkspace)
    const helperLayout = f.server.workerLayouts().at(-1)!
    const workspaceId = String(helperLayout.params.workspace_id)
    workspaces.add(workspaceId)
    expect(helperLayout.params).toMatchObject({ tab_label: 'Owner helper · Codex', focus: false })
    expect(workspaceId).not.toBe('foreign-inherited-workspace')
    expect(f.server.callsTo('workspace.create').at(-1)?.params.label)
      .toBe(projectId === null ? 'Neutron General' : 'Same display name')

    // Consume the helper's production terminal configuration through the real
    // strict host and manager; the one fake is the Herdr server transport.
    const terminal = codexOwnerTerminal(launch.projectWorkspace, projectId, async () => f.server)
    const chat = await terminal.terminalHost.spawn(['fixture-native-owner'], {
      cwd: options.cwd, env: options.env, onScreen() {}, projectPlacement: terminal.projectPlacement,
    })
    chat.detach?.()
    expect(f.server.callsTo('layout.apply').at(-1)?.params).toMatchObject({ workspace_id: workspaceId, tab_label: 'Chat', focus: false })
    expect(f.server.callsTo('tab.move').at(-1)?.params.insert_index).toBe(0)
    const worker = createWorkerTerminalHost(f.root, { selected: herdrHost, connect: async () => f.server })!
    const child = await worker.spawn(['fixture-worker'], { cwd: options.cwd, env: {}, onScreen() {}, projectPlacement: {
      ...options.projectWorkspace.placement, role: 'worker', taskLabel: 'Review · change', operationId: `review-${projectId}`,
    } })
    child.detach?.()
    expect(f.server.workerLayouts().at(-1)?.params.workspace_id).toBe(workspaceId)
    // A lost launch reply is durable uncertainty, never a second helper spawn.
    const layouts = f.server.callsTo('layout.apply').length
    await expect(openDurableCodexOwner(options)).rejects.toThrow()
    expect(f.server.callsTo('layout.apply')).toHaveLength(layouts)
  }
  expect(workspaces.size).toBe(3)
  expect(f.server.callsTo('workspace.create')).toHaveLength(3)
  expect(f.server.callsTo('workspace.close')).toHaveLength(0)
})

test.each(['missing', 'foreign-project', 'general-confusion', 'blank-instance', 'invalid-instance', 'blank-label', 'relative-journal', 'worker-role'])('%s scope refuses before launch or fallback', async fault => {
  const f = fixture(), options = f.options(null)
  const invalid = structuredClone(options) as Omit<typeof options, 'projectWorkspace'> & { projectWorkspace?: ProjectWorkspaceLaunch }
  if (fault === 'missing') delete invalid.projectWorkspace
  else if (fault === 'foreign-project') invalid.projectWorkspace!.placement.projectId = 'alpha'
  else if (fault === 'general-confusion') invalid.projectWorkspace!.placement.projectId = 'general'
  else if (fault === 'blank-instance') invalid.projectWorkspace!.placement.instanceId = ''
  else if (fault === 'invalid-instance') invalid.projectWorkspace!.placement.instanceId = 'invalid\ninstance'
  else if (fault === 'blank-label') invalid.projectWorkspace!.placement.projectLabel = ''
  else if (fault === 'relative-journal') invalid.projectWorkspace!.journalPath = 'workspaces.json'
  else invalid.projectWorkspace!.placement.role = 'worker'
  await expect(openDurableCodexOwner(invalid)).rejects.toThrow('explicit matching project workspace')
  expect(() => codexOwnerTerminal(invalid.projectWorkspace, null, async () => f.server)).toThrow('explicit matching project workspace')
  expect(existsSync(join(options.codexHome, '.neutron-owner-launch.json'))).toBe(false)
  expect(f.server.calls).toEqual([])
  // Honest sibling: the same credential/scope can reserve and place after the
  // invalid precondition is corrected, without deleting an ownership claim.
  await expect(openDurableCodexOwner(options)).rejects.toThrow('launch is uncertain')
  expect(f.server.workerLayouts()).toHaveLength(1)
})

test.each(['instance', 'journal'])('recorded %s authority cannot be changed while adopting a placed owner', async fault => {
  const f = fixture(), options = f.options('alpha')
  const scope = { projectId: options.projectId, cwd: options.cwd, codexHome: options.codexHome,
    credential: codexOwnerCredentialIdentity(readFileSync(join(options.codexHome, 'auth.json'), 'utf8')) }
  writeFileSync(join(options.codexHome, '.neutron-owner-launch.json'), JSON.stringify({ scope, projectWorkspace: options.projectWorkspace }), { mode: 0o600 })
  writeFileSync(join(options.codexHome, '.neutron-owner-authority.json'), '{}', { mode: 0o600 })
  const changed = structuredClone(options)
  if (fault === 'instance') changed.projectWorkspace.placement.instanceId = 'foreign'
  else changed.projectWorkspace.journalPath = join(f.root, 'foreign.json')
  await expect(openDurableCodexOwner(changed)).rejects.toThrow('workspace authority changed')
  expect(f.server.calls).toEqual([])
})
