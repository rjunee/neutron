import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { attachCodexOwner, readCodexOwnerBinding, type bootstrapCodexOwner, type CodexOwnerAttachment } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { assertOwnerScope, helperIdentity, privatePath, readOwnerHelperDescriptor } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'
import { HerdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { createHerdrRpc } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-client.ts'
import { createProjectWorkspaceHost, type ProjectWorkspaceLaunch } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspace-host.ts'
import { ProjectWorkspaceRefusal } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspaces.ts'
import type { HerdrHost as HerdrHostType } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { readAccountId, validateCodexSubscriptionAuth } from '@neutronai/trident/codex-auth.ts'

export type OwnerLaunch = Parameters<typeof bootstrapCodexOwner>[0] & { projectId: string | null; generalAuthorityPath?: string
  /** #1226 — the owner's project workspace, as a journal PATH plus the Chat placement:
   * serializable across the durable helper boundary, never a live host object. When
   * present, the helper pane is placed as a worker tab of that workspace and the
   * helper places the native TUI as its `Chat`; neither uses an inherited workspace. */
  projectWorkspace?: ProjectWorkspaceLaunch
  /** #1226 — the composition's SHARED strict project-workspace host (in-process only,
   * never written to the launch file). The gateway-side helper-tab placement goes
   * through it, so it serializes per scope with every other placement of this
   * composition instead of racing them from a second manager over the same journal. */
  projectWorkspaceHost?: HerdrHostType }

/** The helper pane's worker tab label in its project workspace. */
export const CODEX_OWNER_HELPER_TAB = 'Owner helper · Codex'

/** Account identity survives native access/id/refresh-token rotation. The private
 * credential service's file is the source; JWT bodies are not invented authority. */
export function codexOwnerCredentialIdentity(bytes: string): string {
  if (!validateCodexSubscriptionAuth(bytes).ok) throw new Error('Codex owner subscription credential identity is unavailable')
  const account = readAccountId(bytes)
  if (account) return createHash('sha256').update(JSON.stringify(['chatgpt-account', account])).digest('hex')
  throw new Error('Codex owner credential identity is unavailable')
}

/** Host journal is written before launch. Any incomplete/uncertain prior launch
 * refuses replacement; only an authenticated exact surviving helper is adopted. */
export async function openDurableCodexOwner(options: OwnerLaunch): Promise<CodexOwnerAttachment> {
  assertOwnerScope(options.codexHome, options.projectId)
  const descriptorPath = join(options.codexHome, '.neutron-owner-helper.json')
  const launchPath = join(options.codexHome, '.neutron-owner-launch.json')
  const authorityPath = join(options.codexHome, '.neutron-owner-authority.json')
  const panePath = join(options.codexHome, '.neutron-owner-pane.json')
  const socketPath = options.env.HERDR_SOCKET_PATH
  const connect = socketPath ? { connect: async () => createHerdrRpc({ socketPath }) } : {}
  // Placed: the strict project host (it refuses any unplaced spawn). Unplaced (off
  // Herdr composition, legacy callers): the former host, byte-for-byte.
  const workspace = options.projectWorkspace
  const { projectWorkspaceHost, ...launchOptions } = options
  const host = workspace !== undefined ? projectWorkspaceHost ?? createProjectWorkspaceHost(workspace.journalPath, connect)
    : new HerdrHost({ ...connect, ...(options.env.HERDR_WORKSPACE_ID ? { workspaceId: options.env.HERDR_WORKSPACE_ID } : {}) })
  const credentialPath = join(options.codexHome, 'auth.json')
  privatePath(credentialPath, 'file')
  const credential = codexOwnerCredentialIdentity(readFileSync(credentialPath, 'utf8'))
  const scope = { projectId: options.projectId, cwd: options.cwd, codexHome: options.codexHome, credential }
  if (options.projectId === null) {
    const path = options.generalAuthorityPath
    if (!path) throw new Error('General owner requires its fixed instance authority journal')
    // Reserve the General owner independently of the rotating credential home.
    // A different seat or account after restart cannot create a second owner.
    try { writeFileSync(path, JSON.stringify(scope), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    privatePath(path, 'file')
    if (!isDeepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), scope)) {
      throw new Error('General owner credential or directory changed; explicit reconciliation required')
    }
  }
  let authority: ReturnType<typeof readOwnerHelperDescriptor> | undefined
  let launchedPid: number | undefined
  if (existsSync(launchPath)) {
    privatePath(launchPath, 'file'); privatePath(authorityPath, 'file')
    const previous = JSON.parse(readFileSync(launchPath, 'utf8'))
    if (!isDeepStrictEqual(previous.scope, scope)) throw new Error('Codex owner launch credential or project changed')
    authority = JSON.parse(readFileSync(authorityPath, 'utf8'))
  } else {
    if (existsSync(descriptorPath) || existsSync(authorityPath)) throw new Error('Codex owner launch provenance is missing')
    // Exclusive creation is the no-second-owner guard across gateway processes.
    // The helper's own tab is a worker operation of its scope, reserved once per
    // launch: the launch file above is exclusive, so this id is never re-placed.
    const helperOperationId = `codex-owner-helper:${randomUUID()}`
    writeFileSync(launchPath, JSON.stringify({ ...launchOptions, scope, gatewayIdentity: helperIdentity(),
      ...(workspace === undefined ? {} : { helperOperationId }) }), { flag: 'wx', mode: 0o600 })
    let child: Awaited<ReturnType<typeof host.spawn>>
    try {
      child = await host.spawn([process.execPath,
        new URL('../../runtime/adapters/codex-cli/persistent/project-owner-helper-main.ts', import.meta.url).pathname, launchPath],
      { cwd: options.cwd, env: options.env, onScreen() {},
        ...(workspace === undefined ? {} : { label: CODEX_OWNER_HELPER_TAB, projectPlacement: {
          ...workspace.placement, role: 'worker' as const, taskLabel: CODEX_OWNER_HELPER_TAB, operationId: helperOperationId,
        } }) })
    } catch (error) {
      // A placement the journal refused before any Herdr RPC launched nothing: unwind
      // the exclusive launch reservation, so the next launch retries instead of
      // failing forever on an authority file that can never be written. Any other
      // failure may have created a pane and stays reserved for reconciliation.
      if (error instanceof ProjectWorkspaceRefusal) unlinkSync(launchPath)
      throw error
    }
    child.detach?.()
    launchedPid = child.pid
    if (!child.paneHandle) throw new Error('Codex helper has no durable pane authority')
    writeFileSync(panePath, JSON.stringify({ handle: child.paneHandle, identity: helperIdentity(child.pid) }), { flag: 'wx', mode: 0o600 })
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    while (!existsSync(descriptorPath)) {
      if (Date.now() >= deadline) throw new Error('Codex owner helper launch is uncertain; reconciliation required')
      await Bun.sleep(25)
    }
  }
  const descriptor = readOwnerHelperDescriptor(descriptorPath)
  if (launchedPid !== undefined && descriptor.helper.pid !== launchedPid) throw new Error('Codex helper launch process changed')
  privatePath(panePath, 'file')
  const pane = JSON.parse(readFileSync(panePath, 'utf8'))
  if (typeof pane.handle !== 'string' || !isDeepStrictEqual(pane.identity, descriptor.helper)) throw new Error('Codex helper pane identity changed')
  const inspected = await host.inspectHandle(pane.handle)
  if (inspected.kind !== 'live' || inspected.pid !== descriptor.helper.pid) throw new Error('Codex helper pane cannot be attested')
  if (authority && !isDeepStrictEqual(authority, descriptor)) throw new Error('Codex owner helper authority changed')
  if (descriptor.facts.cwd !== options.cwd || descriptor.facts.codexHome !== options.codexHome) throw new Error('Foreign Codex owner helper')
  const owner = await attachCodexOwner({ descriptorPath, expected: descriptor.facts })
  try {
    readCodexOwnerBinding(owner.binding)
    if (!authority) writeFileSync(authorityPath, JSON.stringify(descriptor), { flag: 'wx', mode: 0o600 })
    return owner
  } catch (error) { await owner.close(); throw error }
}
