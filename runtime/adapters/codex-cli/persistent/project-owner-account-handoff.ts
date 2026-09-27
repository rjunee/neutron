import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { CodexOwnerBindingFacts } from './project-control-bootstrap.ts'
import { assertOwnerScope, privatePath } from './project-owner-helper-protocol.ts'
import { readCompletedOwnerRetirement, type CodexOwnerRetirementReceipt } from './project-owner-retirement-receipt.ts'
import { readCrashedOwner } from './project-owner-crash-recovery.ts'
import { nextOwnerDirectory } from './project-owner-generation.ts'

export interface GeneralOwnerScope { projectId: null; cwd: string; codexHome: string; credential: string }
export interface AccountHandoff {
  version: 1
  source: GeneralOwnerScope
  target: GeneralOwnerScope
  predecessorDirectory: string
  receipt: CodexOwnerRetirementReceipt
  stateDirectory: string
  rolloutPath: string
  bytes: number
  digest: string
}
export interface AccountHandoffLocator { authorityPath: string; index: number }
export interface AccountHandoffPreparation {
  version: 1
  source: GeneralOwnerScope
  target: GeneralOwnerScope
  predecessorDirectory: string
  facts: CodexOwnerBindingFacts
}
export interface GeneralOwnerAuthority {
  scope: GeneralOwnerScope
  rootDirectory: string
  nextIndex: number
  pending?: { locator: AccountHandoffLocator; handoff: AccountHandoff }
  preparing?: { locator: AccountHandoffLocator; preparation: AccountHandoffPreparation }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function read(path: string): unknown { privatePath(path, 'file'); return JSON.parse(readFileSync(path, 'utf8')) }
function durableCreate(path: string, value: string | Uint8Array): void {
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
  const parent = openSync(dirname(path), 'r')
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
function transitionPath({ authorityPath, index }: AccountHandoffLocator): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 1000) throw new Error('Invalid General handoff index')
  return `${authorityPath}.handoff-${index}.json`
}
function scope(value: GeneralOwnerScope): void {
  if (!value || value.projectId !== null || !/^[a-f0-9]{64}$/.test(value.credential)
    || !isAbsolute(value.cwd) || realpathSync(value.cwd) !== value.cwd) throw new Error('Invalid General account scope')
  assertOwnerScope(value.codexHome, null)
}
function transcript(path: string, home: string): Buffer {
  const nested = relative(join(home, 'sessions'), path)
  if (!nested || nested.startsWith('..') || isAbsolute(nested) || realpathSync(path) !== path) throw new Error('Foreign account handoff transcript')
  const info = lstatSync(path)
  if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1) throw new Error('Account handoff needs an owned regular transcript')
  return readFileSync(path)
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function validatePreparation(preparation: AccountHandoffPreparation, source: GeneralOwnerScope, rootDirectory: string): void {
  scope(preparation.source); scope(preparation.target)
  if (preparation.version !== 1 || !isDeepStrictEqual(preparation.source, source)
    || source.cwd !== preparation.target.cwd || source.codexHome === preparation.target.codexHome
    || source.credential === preparation.target.credential) throw new Error('Invalid General account handoff')
  const facts = preparation.facts
  nextOwnerDirectory(facts)
  let ancestor = rootDirectory
  for (let depth = 0; ancestor !== preparation.predecessorDirectory; depth++) {
    if (depth >= 1000) throw new Error('Account handoff predecessor is outside its owner lineage')
    const prior = exists(join(ancestor, '.neutron-owner-retired.json'))
      ? readCompletedOwnerRetirement(ancestor) : readCrashedOwner(ancestor)
    if (prior.facts.codexHome !== source.codexHome || prior.facts.cwd !== source.cwd
      || prior.facts.threadId !== facts.threadId || prior.facts.sessionId !== facts.sessionId) {
      throw new Error('Account handoff predecessor lineage changed')
    }
    ancestor = nextOwnerDirectory(prior.facts)
  }
  const launch = read(join(preparation.predecessorDirectory, '.neutron-owner-launch.json')) as { scope?: unknown }
  const authority = read(join(preparation.predecessorDirectory, '.neutron-owner-authority.json')) as { facts?: unknown }
  if (!isDeepStrictEqual(launch.scope, source) || !isDeepStrictEqual(authority.facts, facts)
    || facts.cwd !== source.cwd || facts.codexHome !== source.codexHome) throw new Error('Account handoff predecessor authority changed')
}

function validate(handoff: AccountHandoff, preparation: AccountHandoffPreparation): void {
  const receipt = readCompletedOwnerRetirement(handoff.predecessorDirectory)
  if (handoff.version !== 1 || !isDeepStrictEqual(handoff.source, preparation.source)
    || !isDeepStrictEqual(handoff.target, preparation.target) || handoff.predecessorDirectory !== preparation.predecessorDirectory
    || !isDeepStrictEqual(receipt, handoff.receipt) || !isDeepStrictEqual(receipt.facts, preparation.facts)
    || !Number.isSafeInteger(handoff.bytes) || handoff.bytes <= 0 || !/^[a-f0-9]{64}$/.test(handoff.digest)
    || handoff.stateDirectory !== join(handoff.target.codexHome, '.neutron-account-handoffs', receipt.facts.bindingRevision)
    || handoff.rolloutPath !== join(handoff.target.codexHome, 'sessions', `handoff-${receipt.facts.bindingRevision}`, basename(receipt.facts.rolloutPath))) {
    throw new Error('Account handoff predecessor or destination changed')
  }
}

function verifySource(handoff: AccountHandoff): void {
  const bytes = transcript(handoff.receipt.facts.rolloutPath, handoff.source.codexHome)
  if (bytes.length !== handoff.bytes || digest(bytes) !== handoff.digest) throw new Error('Retired conversation changed after handoff')
}

/** The original reservation and every transition/acknowledgement are immutable.
 * A pending transition names the only permitted successor; it is not a licence
 * to reopen the retired source, even after a gateway restart. */
export function readGeneralOwnerAuthority(authorityPath: string): GeneralOwnerAuthority | undefined {
  if (!exists(authorityPath)) return undefined
  let current = read(authorityPath) as GeneralOwnerScope
  scope(current)
  let rootDirectory = current.codexHome
  for (let index = 0; index < 1000; index++) {
    const locator = { authorityPath, index }, path = transitionPath(locator)
    if (!exists(`${path}.prepare`)) {
      if ([path, `${path}.abort`, `${path}.ack`].some(exists)) throw new Error('Account handoff preparation is missing')
      return { scope: current, rootDirectory, nextIndex: index }
    }
    const preparation = read(`${path}.prepare`) as AccountHandoffPreparation
    validatePreparation(preparation, current, rootDirectory)
    if (exists(`${path}.abort`)) {
      if (exists(path) || exists(`${path}.ack`) || !isDeepStrictEqual(read(`${path}.abort`),
        { version: 1, preparation, reason: 'native-busy' })) throw new Error('Account handoff abort is not corroborated')
      continue
    }
    if (!exists(path)) return { scope: current, rootDirectory, nextIndex: index, preparing: { locator, preparation } }
    const handoff = read(path) as AccountHandoff
    validate(handoff, preparation)
    if (!exists(`${path}.ack`)) {
      verifySource(handoff)
      return { scope: handoff.target, rootDirectory: handoff.stateDirectory, nextIndex: index, pending: { locator, handoff } }
    }
    const acknowledged = read(`${path}.ack`) as CodexOwnerBindingFacts
    attestAccountHandoff(handoff, acknowledged)
    const authority = read(join(handoff.stateDirectory, '.neutron-owner-authority.json')) as { facts?: unknown }
    if (!isDeepStrictEqual(authority.facts, acknowledged)) throw new Error('General handoff acknowledgement is not corroborated')
    current = handoff.target; rootDirectory = handoff.stateDirectory
  }
  throw new Error('General account handoff history exceeds its bound')
}

/** Written before retirement RPC. A missing completed receipt does not withdraw
 * this exact target or permit ordinary source-account resume after restart. */
export function prepareAccountHandoff(authorityPath: string, source: GeneralOwnerScope, target: GeneralOwnerScope,
  predecessorDirectory: string, facts: CodexOwnerBindingFacts): AccountHandoffLocator {
  const current = readGeneralOwnerAuthority(authorityPath)
  if (!current || current.pending || current.preparing || !isDeepStrictEqual(current.scope, source)) throw new Error('General account authority changed before handoff')
  const preparation: AccountHandoffPreparation = { version: 1, source, target, predecessorDirectory, facts }
  validatePreparation(preparation, source, current.rootDirectory)
  if (exists(join(target.codexHome, '.neutron-account-handoffs', facts.bindingRevision))
    || exists(join(target.codexHome, 'sessions', `handoff-${facts.bindingRevision}`, basename(facts.rolloutPath)))) {
    throw new Error('Account handoff destination already exists')
  }
  const locator = { authorityPath, index: current.nextIndex }
  durableCreate(`${transitionPath(locator)}.prepare`, JSON.stringify(preparation))
  return locator
}

/** An authenticated clean busy refusal plus the unchanged live binding permits
 * explicit abort. Native retirement markers retain uncertainty and cannot abort. */
export function abortAccountHandoff(locator: AccountHandoffLocator, facts: CodexOwnerBindingFacts): void {
  const current = readGeneralOwnerAuthority(locator.authorityPath)
  const prepared = current?.preparing
  if (!prepared || !isDeepStrictEqual(prepared.locator, locator) || !isDeepStrictEqual(prepared.preparation.facts, facts)
    || ['.neutron-owner-retiring.json', '.neutron-owner-retired.json', '.neutron-owner-crashed.json']
      .some(file => exists(join(prepared.preparation.predecessorDirectory, file)))) throw new Error('Account handoff cannot abort uncertain retirement')
  durableCreate(`${transitionPath(locator)}.abort`, JSON.stringify({ version: 1, preparation: prepared.preparation, reason: 'native-busy' }))
}

/** Also used at restart: only the reserved exact owner's completed, corroborated
 * process-death receipt can advance preparation to transcript staging. */
export function completeAccountHandoff(locator: AccountHandoffLocator): void {
  const current = readGeneralOwnerAuthority(locator.authorityPath)
  if (current?.pending && isDeepStrictEqual(current.pending.locator, locator)) return
  if (!current?.preparing || !isDeepStrictEqual(current.preparing.locator, locator)) throw new Error('Account handoff preparation is not current')
  const preparation = current.preparing.preparation
  const { source, target, predecessorDirectory } = preparation
  const receipt = readCompletedOwnerRetirement(predecessorDirectory)
  const bytes = transcript(receipt.facts.rolloutPath, source.codexHome)
  const handoff: AccountHandoff = { version: 1, source, target, predecessorDirectory, receipt,
    stateDirectory: join(target.codexHome, '.neutron-account-handoffs', receipt.facts.bindingRevision),
    rolloutPath: join(target.codexHome, 'sessions', `handoff-${receipt.facts.bindingRevision}`, basename(receipt.facts.rolloutPath)),
    bytes: bytes.length, digest: digest(bytes) }
  validate(handoff, preparation)
  verifySource(handoff)
  if (exists(handoff.stateDirectory) || exists(handoff.rolloutPath)) throw new Error('Account handoff destination already exists')
  durableCreate(transitionPath(locator), JSON.stringify(handoff))
}

export function readAccountHandoff(locator: AccountHandoffLocator): AccountHandoff {
  const current = readGeneralOwnerAuthority(locator.authorityPath)
  if (!current?.pending || !isDeepStrictEqual(current.pending.locator, locator)) throw new Error('Account handoff is not the reserved successor')
  return current.pending.handoff
}

/** Only transcript bytes cross homes, never auth, configuration, or refresh
 * ownership. Interrupted partial writes remain fenced instead of overwritten. */
export function stageAccountHandoff(locator: AccountHandoffLocator): {
  predecessorDirectory: string; receipt: CodexOwnerRetirementReceipt; handoff: AccountHandoffLocator
} {
  const handoff = readAccountHandoff(locator)
  for (const directory of [handoff.stateDirectory, dirname(handoff.rolloutPath)]) {
    let ancestor = handoff.target.codexHome
    for (const part of relative(ancestor, directory).split(sep)) {
      ancestor = join(ancestor, part)
      if (!exists(ancestor)) mkdirSync(ancestor, { mode: 0o700 })
      if (!lstatSync(ancestor).isDirectory() || realpathSync(ancestor) !== ancestor || lstatSync(ancestor).uid !== process.getuid?.()) {
        throw new Error('Account handoff destination is not canonical and owned')
      }
    }
    privatePath(directory, 'directory')
  }
  if (!exists(handoff.rolloutPath)) durableCreate(handoff.rolloutPath, transcript(handoff.receipt.facts.rolloutPath, handoff.source.codexHome))
  validateAccountHandoffTranscript(handoff)
  return { predecessorDirectory: handoff.predecessorDirectory, receipt: handoff.receipt, handoff: locator }
}

export function validateAccountHandoffTranscript(handoff: AccountHandoff): void {
  const bytes = transcript(handoff.rolloutPath, handoff.target.codexHome)
  // A native successor may have appended its resume record before a lost ack.
  if (bytes.length < handoff.bytes || digest(bytes.subarray(0, handoff.bytes)) !== handoff.digest) throw new Error('Account handoff transcript prefix changed')
}

export function attestAccountHandoff(handoff: AccountHandoff, facts: CodexOwnerBindingFacts): void {
  const old = handoff.receipt.facts
  if (facts.threadId !== old.threadId || facts.sessionId !== old.sessionId || facts.cwd !== old.cwd
    || facts.codexHome !== handoff.target.codexHome || facts.rolloutPath !== handoff.rolloutPath
    || facts.credentialIdentity !== handoff.target.credential || facts.modelProvider !== old.modelProvider
    || !isDeepStrictEqual(facts.nativeMetadata, old.nativeMetadata) || facts.bindingRevision === old.bindingRevision) {
    throw new Error('Native successor did not acknowledge the reserved account and conversation')
  }
}

export function acknowledgeAccountHandoff(locator: AccountHandoffLocator, facts: CodexOwnerBindingFacts): void {
  const handoff = readAccountHandoff(locator)
  attestAccountHandoff(handoff, facts)
  const authority = read(join(handoff.stateDirectory, '.neutron-owner-authority.json')) as { facts?: unknown }
  if (!isDeepStrictEqual(authority.facts, facts)) throw new Error('Account handoff lacks native host authority')
  durableCreate(`${transitionPath(locator)}.ack`, JSON.stringify(facts))
}
