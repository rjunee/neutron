/** Explicit durable-host entry point; never spawn this as a gateway child. */
import { readFileSync } from 'node:fs'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { HerdrHost } from '../../claude-code/persistent/herdr-host.ts'
import { createHerdrRpc } from '../../claude-code/persistent/herdr-client.ts'
import { createProjectWorkspaceHost, type ProjectWorkspaceLaunch } from '../../claude-code/persistent/project-workspace-host.ts'
import { privatePath } from './project-owner-helper-protocol.ts'
import { startCodexOwnerHelper } from './project-owner-helper.ts'

if (import.meta.main) {
  const path = process.argv[2]
  const socketPath = process.env.HERDR_SOCKET_PATH
  if (!path || process.env.HERDR_ENV !== '1' || !socketPath || !process.env.HERDR_PANE_ID) throw new Error('Owner helper requires an explicit Herdr pane and private launch file')
  privatePath(path, 'file')
  const { projectWorkspace, ...options } = JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof startCodexOwnerHelper>[0]
    & { projectWorkspace?: ProjectWorkspaceLaunch }
  const connect = async () => createHerdrRpc({ socketPath })
  // #1226 — a placed launch puts the native TUI in its project workspace as `Chat`,
  // through the same journal the gateway uses; never the helper pane's own workspace.
  const terminalHost = projectWorkspace !== undefined
    ? createProjectWorkspaceHost(projectWorkspace.journalPath, { connect }) : new HerdrHost({ connect })
  const helper = await startCodexOwnerHelper({ ...options, terminalHost,
    ...(projectWorkspace === undefined ? {} : { projectPlacement: { ...projectWorkspace.placement, role: 'chat' as const } }) })
  process.stdout.write('Native Codex owner helper ready; gateway clients may attach.\n')
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    fireAndForget('codex-owner-helper.stop', helper.destroy().then(() => process.exit(0)), () => process.exit(1))
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
}
