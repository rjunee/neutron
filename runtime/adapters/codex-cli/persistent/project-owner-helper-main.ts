/** Explicit durable-host entry point; never spawn this as a gateway child. */
import { readFileSync } from 'node:fs'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { createHerdrRpc } from '../../claude-code/persistent/herdr-client.ts'
import type { ProjectWorkspaceLaunch } from '../../claude-code/persistent/project-workspace-host.ts'
import { codexOwnerTerminal } from './project-owner-workspace.ts'
import { privatePath } from './project-owner-helper-protocol.ts'
import { startCodexOwnerHelper } from './project-owner-helper.ts'
import { finishOwnerHelperLifetime } from './project-owner-helper-lifetime.ts'
import { acquireCodexAccountWriteLease, CodexAccountWriterError, type CodexAccountWriteLease } from '../account-writer-lock.ts'
import { recordOwnerAdmissionRefusal } from './project-owner-admission-refusal.ts'

if (import.meta.main) {
  const path = process.argv[2]
  const socketPath = process.env.HERDR_SOCKET_PATH
  if (!path || process.env.HERDR_ENV !== '1' || !socketPath || !process.env.HERDR_PANE_ID) throw new Error('Owner helper requires an explicit Herdr pane and private launch file')
  privatePath(path, 'file')
  const launchBytes = readFileSync(path, 'utf8')
  const options = JSON.parse(launchBytes) as Parameters<typeof startCodexOwnerHelper>[0]
    & { projectWorkspace?: ProjectWorkspaceLaunch }
  let accountWriteLease: CodexAccountWriteLease
  try { accountWriteLease = acquireCodexAccountWriteLease(options.codexHome) }
  catch (error) {
    if (!(error instanceof CodexAccountWriterError)) throw error
    await recordOwnerAdmissionRefusal(path, launchBytes, error)
    process.exit(73)
  }
  const helper = await (async () => {
    try { return await startCodexOwnerHelper({ ...options, accountWriteLease,
      ...codexOwnerTerminal(options.projectWorkspace, options.projectId, async () => createHerdrRpc({ socketPath })) }) }
    finally { accountWriteLease.close() }
  })()
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
