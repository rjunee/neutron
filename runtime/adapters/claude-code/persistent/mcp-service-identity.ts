import { readFileSync, writeFileSync } from 'node:fs'
import { isProcessIdentity, readProcessIdentity, type ProcessIdentity } from './process-identity.ts'
import { replSessionConfigPaths } from './session-config-paths.ts'

/** Spawn correlation within the existing same-OS-user boundary, not a credential
 * against an actor able to read the owner's private spawn files. */
export const MCP_SERVICE_ID_ENV = 'NEUTRON_MCP_SERVICE_ID'

export interface McpServiceOwner {
  sessionKey: string
  childGeneration: string
  channelName: string
  pid: number
}

export interface McpServiceProof {
  ownerPid: number
  ownerIdentity: ProcessIdentity
  markers: ReadonlySet<string>
}

/** The only writer, called with the newly spawned parent and the markers actually
 * placed in its MCP config. No current settings reader can update this receipt. */
export function recordMcpServiceOwner(owner: McpServiceOwner, markers: readonly string[]): void {
  writeFileSync(replSessionConfigPaths(owner.channelName).mcpIdentityPath, JSON.stringify({
    version: 1, owner, identity: readProcessIdentity(owner.pid) ?? null, markers,
  }), { flag: 'wx', mode: 0o600 })
}

/** Adoption uses the original channel and generation. Missing, malformed, legacy,
 * or other-generation evidence throws; none authorizes an idle census. */
export function readMcpServiceProof(owner: McpServiceOwner): McpServiceProof {
  const value = JSON.parse(readFileSync(replSessionConfigPaths(owner.channelName).mcpIdentityPath, 'utf8'))
  if (value?.version !== 1 || value.owner?.sessionKey !== owner.sessionKey
    || value.owner?.childGeneration !== owner.childGeneration || value.owner?.channelName !== owner.channelName
    || value.owner?.pid !== owner.pid || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || !isProcessIdentity(value.identity) || value.identity.start_ticks < 0
    || !Array.isArray(value.markers) || value.markers.length === 0
    || value.markers.some((marker: unknown) => typeof marker !== 'string' || !/^[0-9a-f]{64}$/.test(marker))
    || new Set(value.markers).size !== value.markers.length) {
    throw new Error('MCP spawn identity is missing, malformed or belongs to another owner')
  }
  return { ownerPid: owner.pid, ownerIdentity: value.identity, markers: new Set(value.markers) }
}
