import { isDeepStrictEqual } from 'node:util'
import { assertNoOtherCodexOwner, readCrashedOwner, type CodexOwnerCrashReceipt } from './project-owner-crash-recovery.ts'
import { nextOwnerDirectory } from './project-owner-generation.ts'
import { readAccountHandoff, validateAccountHandoffTranscript, type AccountHandoffLocator } from './project-owner-account-handoff.ts'
import { readCompletedOwnerRetirement, type CodexOwnerRetirementReceipt } from './project-owner-retirement-receipt.ts'
export { readCompletedOwnerRetirement, type CodexOwnerRetirementReceipt } from './project-owner-retirement-receipt.ts'
export { assertOwnerProcessDead, nextOwnerDirectory } from './project-owner-generation.ts'

export interface CodexOwnerResume {
  predecessorDirectory: string
  receipt: CodexOwnerRetirementReceipt | CodexOwnerCrashReceipt
  /** Explicit General transition; never inferred from a changed CODEX_HOME. */
  handoff?: AccountHandoffLocator
}

export function validateOwnerResume(directory: string, resume: CodexOwnerResume, cwd: string, codexHome: string): void {
  if (resume.handoff) {
    const handoff = readAccountHandoff(resume.handoff)
    if (directory !== handoff.stateDirectory || cwd !== handoff.target.cwd || codexHome !== handoff.target.codexHome
      || resume.predecessorDirectory !== handoff.predecessorDirectory || !isDeepStrictEqual(resume.receipt, handoff.receipt)) {
      throw new Error('Owner resume does not match its reserved account handoff')
    }
    validateAccountHandoffTranscript(handoff)
    assertNoOtherCodexOwner({ ...handoff.receipt.facts, codexHome: handoff.target.codexHome, rolloutPath: handoff.rolloutPath })
    return
  }
  const receipt = 'kind' in resume.receipt && resume.receipt.kind === 'crash'
    ? readCrashedOwner(resume.predecessorDirectory) : readCompletedOwnerRetirement(resume.predecessorDirectory)
  if (!isDeepStrictEqual(receipt, resume.receipt) || directory !== nextOwnerDirectory(receipt.facts)
    || receipt.facts.cwd !== cwd || receipt.facts.codexHome !== codexHome) {
    throw new Error('Owner resume does not match its completed predecessor')
  }
  if ('kind' in receipt && receipt.kind === 'crash') assertNoOtherCodexOwner(receipt.facts)
}
