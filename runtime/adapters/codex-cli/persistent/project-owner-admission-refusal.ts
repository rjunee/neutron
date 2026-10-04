import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { CodexAccountWriterError } from '../account-writer-lock.ts'
import { helperIdentity, privatePath, type HelperIdentity } from './project-owner-helper-protocol.ts'
import { assertOwnerProcessDead } from './project-owner-generation.ts'

function present(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

export function ownerAdmissionRefusalPath(launchPath: string, bytes: string): string {
  return join(dirname(launchPath), `.neutron-owner-admission-refused-${createHash('sha256').update(bytes).digest('hex')}.json`)
}

/** Called only from the helper's account-acquire catch, before bootstrap or any
 * child exists. Keep the helper alive until the host captures its pane identity. */
export async function recordOwnerAdmissionRefusal(launchPath: string, bytes: string, error: CodexAccountWriterError): Promise<void> {
  privatePath(launchPath, 'file')
  if (readFileSync(launchPath, 'utf8') !== bytes) throw new Error('Owner launch changed before account admission')
  const path = ownerAdmissionRefusalPath(launchPath, bytes)
  const receipt = JSON.stringify({ version: 1, kind: 'pre-native-account-refusal', helper: helperIdentity(), code: error.code })
  writeFileSync(path, receipt, { flag: 'wx', mode: 0o600 })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (present(`${path}.ack`)) {
      privatePath(`${path}.ack`, 'file')
      if (readFileSync(`${path}.ack`, 'utf8') !== receipt) throw new Error('Owner refusal acknowledgement changed')
      return
    }
    await Bun.sleep(25)
  }
}

/** Release only a conclusively never-started launch. Uncertain native state,
 * foreign receipt, live helper or concurrent cleanup never authorizes deletion. */
export async function releaseRefusedOwnerLaunch(launchPath: string, bytes: string, timeoutMs: number): Promise<CodexAccountWriterError | null> {
  const path = ownerAdmissionRefusalPath(launchPath, bytes)
  if (!present(path)) return null
  privatePath(path, 'file')
  const receiptBytes = readFileSync(path, 'utf8')
  const receipt = JSON.parse(receiptBytes) as { version: number; kind: string; helper: HelperIdentity; code: string }
  const state = dirname(launchPath)
  const panePath = join(state, '.neutron-owner-pane.json')
  privatePath(panePath, 'file')
  const pane = JSON.parse(readFileSync(panePath, 'utf8'))
  if (receipt.version !== 1 || receipt.kind !== 'pre-native-account-refusal'
    || !['accountBusy', 'accountAdmissionUnknown'].includes(receipt.code)
    || !isDeepStrictEqual(receipt.helper, pane.identity)) throw new Error('Owner account refusal identity changed')
  for (const name of ['.neutron-owner-helper.json', '.neutron-owner-authority.json', '.neutron-owner-bootstrap.sqlite']) {
    if (present(join(state, name))) throw new Error('Account refusal conflicts with native owner evidence')
  }
  try { writeFileSync(`${path}.ack`, receiptBytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    privatePath(`${path}.ack`, 'file')
    if (readFileSync(`${path}.ack`, 'utf8') !== receiptBytes) throw new Error('Owner refusal acknowledgement changed')
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { assertOwnerProcessDead(receipt.helper); break }
    catch (error) { if (Date.now() >= deadline) throw error }
    await Bun.sleep(25)
  }
  // This permanent, exclusive claim prevents a second cleanup from unlinking a
  // subsequent launch. An interrupted cleanup remains explicitly uncertain.
  writeFileSync(`${path}.cleanup`, receiptBytes, { flag: 'wx', mode: 0o600 })
  privatePath(launchPath, 'file')
  if (readFileSync(launchPath, 'utf8') !== bytes) throw new Error('Owner launch changed during refused admission')
  unlinkSync(panePath)
  unlinkSync(launchPath)
  return new CodexAccountWriterError(receipt.code as 'accountBusy' | 'accountAdmissionUnknown',
    'Native account admission refused before launch; retry when the account is available')
}
