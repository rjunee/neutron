import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectWorkspaceManager } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspaces.ts'
import { RelicProcFixture, RelicWorkspaceServer } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/workspace-relic-fixture.ts'
import { createProjectScopeLifecycle } from '../wiring/project-scope-lifecycle.ts'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test.each(['idle', 'busy', 'unknown', 'late-admission', 'legacy'] as const)('production lifecycle reconciles relic-only scope: %s', async fault => {
  const dir = mkdtempSync(join(tmpdir(), 'project-relic-lifecycle-')); directories.push(dir)
  const proc = new RelicProcFixture(), server = new RelicWorkspaceServer()
  server.birthReceipts = fault !== 'legacy'
  const manager = new ProjectWorkspaceManager(join(dir, 'journal.json'), proc)
  const placement = { instanceId: 'instance', projectId: 'project', projectLabel: 'Project', role: 'chat' as const }
  const created = await manager.applyLayout(server, { type: 'pane', cwd: dir, command: ['native-fixture'] }, placement)
  const pane = server.panes.get(created.layout.root.pane_id)!
  pane.argv = ['/bin/bash']; proc.add(pane.shell_pid)
  expect(await manager.relinquishDeadChat(server, placement, pane.pane_id, () => true)).toBe(true)
  let lateAdmission = false
  const originalCall = server.call.bind(server)
  server.call = async (method, params) => {
    const answer = await originalCall(method, params)
    if (fault === 'late-admission' && method === 'pane.check_owned_input') lateAdmission = true
    return answer
  }
  const lifecycle = createProjectScopeLifecycle({
    admission: { listLeases: () => [], hasUnresolvedNativeChildForChat: () => lateAdmission },
    sessions: async () => ({ live: [], unresolved: 0 }), idleMs: 0,
    liveness: () => ({ census: async () => ({ parent: { kind: 'absent' },
      scope: { ownerHandle: 'owner', projectId: 'project' }, fence: null, observedAt: new Date().toISOString(),
      verdict: fault === 'busy' ? 'busy' : fault === 'unknown' ? 'unknown' : 'idle',
      parentTurn: 'idle', children: 'idle', shells: 'idle', reasons: [] }) }),
    conversationTerminal: {
      inspectChat: () => manager.inspectChat(server, placement),
      retireEmptyWorkspace: (_scope, expected, canRetire) => manager.retireEmptyWorkspace(server, placement, expected, canRetire),
    },
    log: { info() {}, warn() {} },
  })
  const result = await lifecycle.sleep('project')
  lifecycle.close()
  if (fault === 'idle') {
    expect(result).toEqual({ status: 'absent' })
    expect(server.panes.size).toBe(0)
    expect(server.workspaces.size).toBe(0)
    expect(server.callsTo('pane.retire_held_owned')).toHaveLength(1)
  } else {
    expect(['refused', 'unknown']).toContain(result.status)
    expect(server.panes.has(pane.pane_id)).toBe(true)
    expect(server.callsTo('pane.retire_held_owned')).toHaveLength(0)
    if (fault === 'late-admission') {
      expect(server.inputHolds.size).toBe(0)
      // The known pre-mutation refusal must not strand a newly admitted wake.
      const replacement = await manager.applyLayout(server, { type: 'pane', cwd: dir, command: ['next-native'] }, placement)
      expect(server.panes.has(replacement.layout.root.pane_id)).toBe(true)
    }
  }
  expect(server.callsTo('workspace.close')).toHaveLength(0)
})
