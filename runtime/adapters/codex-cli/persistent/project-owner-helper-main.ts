/** Explicit durable-host entry point; never spawn this as a gateway child. */
import { readFileSync } from 'node:fs'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { createHerdrRpc } from '../../claude-code/persistent/herdr-client.ts'
import type { ProjectWorkspaceLaunch } from '../../claude-code/persistent/project-workspace-host.ts'
import { codexOwnerTerminal } from './project-owner-workspace.ts'
import { privatePath } from './project-owner-helper-protocol.ts'
import { startCodexOwnerHelper } from './project-owner-helper.ts'
import { finishOwnerHelperLifetime } from './project-owner-helper-lifetime.ts'

if (import.meta.main) {
  const path = process.argv[2]
  const socketPath = process.env.HERDR_SOCKET_PATH
  if (!path || process.env.HERDR_ENV !== '1' || !socketPath || !process.env.HERDR_PANE_ID) throw new Error('Owner helper requires an explicit Herdr pane and private launch file')
  privatePath(path, 'file')
  const options = JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof startCodexOwnerHelper>[0]
    & { projectWorkspace?: ProjectWorkspaceLaunch }
  const helper = await startCodexOwnerHelper({ ...options,
    ...codexOwnerTerminal(options.projectWorkspace, options.projectId, async () => createHerdrRpc({ socketPath })) })
  process.stdout.write('Native Codex owner helper ready; gateway clients may attach.\n')
  fireAndForget('codex-owner-helper.lifetime', finishOwnerHelperLifetime(helper, code => process.exit(code)), () => process.exit(1))
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    fireAndForget('codex-owner-helper.stop', helper.destroy().then(() => process.exit(0)), () => process.exit(1))
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
}
