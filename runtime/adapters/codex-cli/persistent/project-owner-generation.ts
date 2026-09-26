import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { CodexOwnerBindingFacts } from './project-control-bootstrap.ts'
import { helperIdentity, type HelperIdentity } from './project-owner-helper-protocol.ts'

/** A reused PID is not the recorded process; unreadable procfs is not death. */
export function assertOwnerProcessDead(identity: HelperIdentity): void {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
    || typeof identity.boot !== 'string' || !identity.boot || !/^\d+$/.test(identity.start)) {
    throw new Error('Retired owner process identity is incomplete')
  }
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!boot) throw new Error('Owner process liveness is unknown')
  if (boot !== identity.boot) return
  try {
    // A zombie refusal is not itself the positive absence proof needed here.
    lstatSync(`/proc/${identity.pid}`)
    if (isDeepStrictEqual(helperIdentity(identity.pid), identity)) throw new Error('Retired owner process is still live')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function nextOwnerDirectory(facts: CodexOwnerBindingFacts): string {
  if (!/^[a-f0-9]{64}$/.test(facts.bindingRevision)) throw new Error('Invalid retired owner revision')
  return join(facts.codexHome, '.neutron-owner-generations', facts.bindingRevision)
}
