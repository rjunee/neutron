import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { attachCodexOwner, readCodexOwnerBinding, type bootstrapCodexOwner, type CodexOwnerAttachment, type CodexOwnerBindingFacts, type CodexOwnerRetirement } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { assertOwnerScope, helperIdentity, privatePath, readOwnerHelperDescriptor } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'
import { HerdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { createHerdrRpc } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-client.ts'
import { readAccountId, validateCodexSubscriptionAuth } from '@neutronai/trident/codex-auth.ts'
import { nextOwnerDirectory, readCompletedOwnerRetirement, type CodexOwnerResume } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-retirement.ts'

export type OwnerLaunch = Parameters<typeof bootstrapCodexOwner>[0] & { projectId: string | null; generalAuthorityPath?: string }

/** Only ENOENT proves absence. Inaccessible journals retain ownership. */
export function durableOwnerPathExists(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Read-only recovery, independent of a frontend whose lost reply fenced it. */
export function recoverDurableOwnerRetirement(stateDirectory: string, expected: CodexOwnerBindingFacts): CodexOwnerRetirement | undefined {
  try {
    if (!durableOwnerPathExists(join(stateDirectory, '.neutron-owner-retired.json'))) return undefined
    const receipt = readCompletedOwnerRetirement(stateDirectory)
    if (!isDeepStrictEqual(receipt.facts, expected)) throw new Error('Retired owner identity changed')
    return { status: 'retired', receipt }
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : 'Owner retirement evidence unavailable' }
  }
}

export function locateDurableOwnerGeneration(codexHome: string, cwd: string): {
  stateDirectory: string; resume?: CodexOwnerResume; predecessors: string[]
} {
  let stateDirectory = codexHome
  let resume: CodexOwnerResume | undefined
  const predecessors: string[] = []
  while (durableOwnerPathExists(join(stateDirectory, '.neutron-owner-retired.json'))) {
    if (predecessors.length >= 1000 || predecessors.includes(stateDirectory)) throw new Error('Owner retirement history is unbounded')
    const receipt = readCompletedOwnerRetirement(stateDirectory)
    if (receipt.facts.codexHome !== codexHome || receipt.facts.cwd !== cwd) throw new Error('Foreign retired owner')
    predecessors.push(stateDirectory)
    resume = { predecessorDirectory: stateDirectory, receipt }
    stateDirectory = nextOwnerDirectory(receipt.facts)
  }
  return { stateDirectory, ...(resume ? { resume } : {}), predecessors }
}

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
  const { stateDirectory, resume, predecessors } = locateDurableOwnerGeneration(options.codexHome, options.cwd)
  if (resume) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
    privatePath(stateDirectory, 'directory')
    options = { ...options, ownerStateDirectory: stateDirectory, resume }
  }
  const descriptorPath = join(stateDirectory, '.neutron-owner-helper.json')
  const launchPath = join(stateDirectory, '.neutron-owner-launch.json')
  const authorityPath = join(stateDirectory, '.neutron-owner-authority.json')
  const panePath = join(stateDirectory, '.neutron-owner-pane.json')
  const socketPath = options.env.HERDR_SOCKET_PATH
  const host = new HerdrHost({ ...(socketPath ? { connect: async () => createHerdrRpc({ socketPath }) } : {}),
    ...(options.env.HERDR_WORKSPACE_ID ? { workspaceId: options.env.HERDR_WORKSPACE_ID } : {}) })
  const credentialPath = join(options.codexHome, 'auth.json')
  privatePath(credentialPath, 'file')
  const credential = codexOwnerCredentialIdentity(readFileSync(credentialPath, 'utf8'))
  const scope = { projectId: options.projectId, cwd: options.cwd, codexHome: options.codexHome, credential }
  for (const directory of predecessors) {
    const path = join(directory, '.neutron-owner-launch.json')
    privatePath(path, 'file')
    if (!isDeepStrictEqual(JSON.parse(readFileSync(path, 'utf8')).scope, scope)) throw new Error('Retired owner launch credential or project changed')
  }
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
    return { ...owner,
      recoverRetirement: () => recoverDurableOwnerRetirement(stateDirectory, descriptor.facts),
      async retire(expectedEpoch) {
      const outcome = await owner.retire!(expectedEpoch)
      if (outcome.status === 'busy') return outcome
      // A lost HTTP reply is recoverable only from the completed immutable
      // receipt plus actual process death, never from the caller's timeout.
      const deadline = Date.now() + (options.timeoutMs ?? 30_000)
      let reason = outcome.status === 'unknown' ? outcome.reason : 'Owner helper exit is not confirmed'
      do {
        try {
          const receipt = readCompletedOwnerRetirement(stateDirectory)
          if (!isDeepStrictEqual(receipt.facts, descriptor.facts)) throw new Error('Retired owner identity changed')
          return { status: 'retired', receipt }
        } catch (error) { reason = error instanceof Error ? error.message : 'Owner retirement evidence unavailable' }
        if (!existsSync(join(stateDirectory, '.neutron-owner-retiring.json'))) break
        await Bun.sleep(25)
      } while (Date.now() < deadline)
      return { status: 'unknown', reason }
    } }
  } catch (error) { await owner.close(); throw error }
}
