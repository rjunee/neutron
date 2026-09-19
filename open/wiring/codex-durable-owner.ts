import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { attachCodexOwner, readCodexOwnerBinding, type bootstrapCodexOwner, type CodexOwnerAttachment } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { assertProjectOwner, helperIdentity, privatePath, readOwnerHelperDescriptor } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'
import { HerdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { createHerdrRpc } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-client.ts'
import { readAccountId, validateCodexSubscriptionAuth } from '@neutronai/trident/codex-auth.ts'

export type OwnerLaunch = Parameters<typeof bootstrapCodexOwner>[0] & { projectId: string }

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
  assertProjectOwner(options.codexHome, options.projectId)
  const descriptorPath = join(options.codexHome, '.neutron-owner-helper.json')
  const launchPath = join(options.codexHome, '.neutron-owner-launch.json')
  const authorityPath = join(options.codexHome, '.neutron-owner-authority.json')
  const panePath = join(options.codexHome, '.neutron-owner-pane.json')
  const socketPath = options.env.HERDR_SOCKET_PATH
  const host = new HerdrHost({ ...(socketPath ? { connect: async () => createHerdrRpc({ socketPath }) } : {}),
    ...(options.env.HERDR_WORKSPACE_ID ? { workspaceId: options.env.HERDR_WORKSPACE_ID } : {}) })
  const credentialPath = join(options.codexHome, 'auth.json')
  privatePath(credentialPath, 'file')
  const credential = codexOwnerCredentialIdentity(readFileSync(credentialPath, 'utf8'))
  const scope = { projectId: options.projectId, cwd: options.cwd, codexHome: options.codexHome, credential }
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
    writeFileSync(launchPath, JSON.stringify({ ...options, scope, gatewayIdentity: helperIdentity() }), { flag: 'wx', mode: 0o600 })
    const child = await host.spawn([process.execPath,
      new URL('../../runtime/adapters/codex-cli/persistent/project-owner-helper-main.ts', import.meta.url).pathname, launchPath],
    { cwd: options.cwd, env: options.env, onScreen() {} })
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
