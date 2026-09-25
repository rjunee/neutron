import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bunTerminalHost } from '@neutronai/runtime/adapters/claude-code/persistent/bun-terminal-host.ts'
import { herdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { FakeHerdrWorkspaceServer } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'
import { createWorkerPlacement } from '@neutronai/runtime/workers/worker-placement.ts'
import { createWorkerTerminalHost, WORKER_TERMINAL_DIR, workerPlacementScope } from '../wiring/project-build-terminal.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

test('General resolves to the null scope and Neutron General; a project literally named general keeps its id', () => {
  const names = new Map([['general', 'general'], ['alpha', '  Alpha Project  ']])
  const projectName = (id: string) => names.get(id)
  expect(workerPlacementScope({ instanceId: 'owner', ownerSlug: 'owner', runScopeKey: 'owner', projectName }))
    .toEqual({ instanceId: 'owner', projectId: null, projectLabel: 'Neutron General' })
  expect(workerPlacementScope({ instanceId: 'owner', ownerSlug: 'owner', runScopeKey: 'general', projectName }))
    .toEqual({ instanceId: 'owner', projectId: 'general', projectLabel: 'general' })
  expect(workerPlacementScope({ instanceId: 'owner', ownerSlug: 'owner', runScopeKey: 'alpha', projectName }))
    .toEqual({ instanceId: 'owner', projectId: 'alpha', projectLabel: 'Alpha Project' })
})

test('a missing or unreadable project name falls back to the id, never to General', () => {
  expect(workerPlacementScope({ instanceId: 'owner', ownerSlug: 'owner', runScopeKey: 'beta', projectName: () => undefined }).projectLabel).toBe('beta')
  expect(workerPlacementScope({ instanceId: 'owner', ownerSlug: 'owner', runScopeKey: 'beta', projectName: () => '   ' }).projectLabel).toBe('beta')
  expect(workerPlacementScope({ instanceId: 'owner', ownerSlug: 'owner', runScopeKey: 'beta',
    projectName: () => { throw new Error('no projects table') } })).toEqual({ instanceId: 'owner', projectId: 'beta', projectLabel: 'beta' })
})

test('off Herdr there is no worker terminal host; on Herdr one strict host journals under the private state directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-build-terminal-')); directories.push(root)
  expect(createWorkerTerminalHost(root, { selected: bunTerminalHost })).toBeNull()
  const server = new FakeHerdrWorkspaceServer()
  const host = createWorkerTerminalHost(root, { selected: herdrHost, connect: async () => server })
  expect(host).not.toBeNull()
  // Strict: an unplaced spawn is refused before any RPC.
  await expect(host!.spawn(['viewer'], { cwd: root, env: {}, onScreen() {} })).rejects.toThrow('explicit placement')
  expect(server.calls).toEqual([])
  const placement = createWorkerPlacement({ host: host!, scope: { instanceId: 'owner', projectId: 'alpha', projectLabel: 'Alpha' } })
  expect((await placement.place({ key: 'k', taskLabel: 'Review · alpha', cwd: root, viewPath: join(root, 'k.log'), receiptDir: root })).kind).toBe('placed')
  const journal = join(root, WORKER_TERMINAL_DIR, 'project-workspaces.json')
  expect(Object.keys(JSON.parse(await readFile(journal, 'utf8')))).toHaveLength(1)
  expect((await stat(join(root, WORKER_TERMINAL_DIR))).mode & 0o077).toBe(0)
})

test('production composition hands every build AND every owner conversation the one shared terminal host', async () => {
  const source = await readFile(new URL('../composer.ts', import.meta.url), 'utf8')
  expect(source.match(/createWorkerTerminalHost\(/g)).toHaveLength(1)
  expect(source).toContain('const projectTerminalHost = createWorkerTerminalHost(projectBuildStateRoot, { env })')
  const call = source.slice(source.indexOf('return prepareProjectBuild(input, {'))
  expect(call.slice(0, call.indexOf('}, signal)'))).toMatch(/workerTerminal: \{ host: projectTerminalHost, scope: workerPlacementScope\(\{\s+instanceId: owner_handle, ownerSlug: project_slug, runScopeKey: input\.run\.project_slug,/)
  // The conversation terminal is built over the SAME host, before the substrates consume it.
  expect(source).toMatch(/createConversationTerminal\(\{\s+host: projectTerminalHost,/)
  expect(source.indexOf('createConversationTerminal({')).toBeLessThan(source.indexOf('} = wireSubstrates(wiringCtx)'))
  expect(source).toContain("...(conversationTerminal === undefined ? {} : { conversationTerminal }),")
  expect(source).toContain('codexOwnerBindings.projectWorkspace = projectId => ({ journalPath, placement: conversationTerminal.placementFor(projectId) })')
})
