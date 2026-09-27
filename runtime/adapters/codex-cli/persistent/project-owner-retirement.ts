import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { CodexOwnerBindingFacts } from './project-control-bootstrap.ts'
import { privatePath, type HelperIdentity, type OwnerHelperDescriptor } from './project-owner-helper-protocol.ts'
import { assertNoOtherCodexOwner, readCrashedOwner, type CodexOwnerCrashReceipt } from './project-owner-crash-recovery.ts'
import { assertOwnerProcessDead, nextOwnerDirectory } from './project-owner-generation.ts'
export { assertOwnerProcessDead, nextOwnerDirectory } from './project-owner-generation.ts'

/** Completed exit evidence, never a request to terminate or a timeout. */
export interface CodexOwnerRetirementReceipt {
  version: 1
  facts: CodexOwnerBindingFacts
  helper: HelperIdentity
  terminal: HelperIdentity
  native: { identity: HelperIdentity; code: number | null; signal: string | null }
}

export interface CodexOwnerResume {
  predecessorDirectory: string
  receipt: CodexOwnerRetirementReceipt | CodexOwnerCrashReceipt
}

/** The prior generation's immutable host attestation corroborates the receipt.
 * All old processes must be positively gone before a new helper is permitted.
 */
export function readCompletedOwnerRetirement(directory: string): CodexOwnerRetirementReceipt {
  privatePath(directory, 'directory')
  const retirementPath = join(directory, '.neutron-owner-retired.json')
  const authorityPath = join(directory, '.neutron-owner-authority.json')
  privatePath(retirementPath, 'file'); privatePath(authorityPath, 'file')
  const receipt = JSON.parse(readFileSync(retirementPath, 'utf8')) as CodexOwnerRetirementReceipt
  const authority = JSON.parse(readFileSync(authorityPath, 'utf8')) as OwnerHelperDescriptor
  if (receipt.version !== 1 || !receipt.facts || !receipt.native
    || !isDeepStrictEqual(receipt.facts, authority.facts) || !isDeepStrictEqual(receipt.helper, authority.helper)
    || !Number.isInteger(receipt.native.code) && receipt.native.code !== null
    || typeof receipt.native.signal !== 'string' && receipt.native.signal !== null
    || receipt.native.code === null && receipt.native.signal === null) throw new Error('Owner retirement receipt is not corroborated')
  nextOwnerDirectory(receipt.facts)
  assertOwnerProcessDead(receipt.native.identity)
  assertOwnerProcessDead(receipt.terminal)
  assertOwnerProcessDead(receipt.helper)
  return receipt
}

export function validateOwnerResume(directory: string, resume: CodexOwnerResume, cwd: string, codexHome: string): void {
  const receipt = 'kind' in resume.receipt && resume.receipt.kind === 'crash'
    ? readCrashedOwner(resume.predecessorDirectory) : readCompletedOwnerRetirement(resume.predecessorDirectory)
  if (!isDeepStrictEqual(receipt, resume.receipt) || directory !== nextOwnerDirectory(receipt.facts)
    || receipt.facts.cwd !== cwd || receipt.facts.codexHome !== codexHome) {
    throw new Error('Owner resume does not match its completed predecessor')
  }
  if ('kind' in receipt && receipt.kind === 'crash') assertNoOtherCodexOwner(receipt.facts)
}
