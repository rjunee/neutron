import { Database } from 'bun:sqlite'
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertOwnerProcessDead, nextOwnerDirectory } from './project-owner-generation.ts'
import { privatePath, type HelperIdentity, type OwnerHelperDescriptor } from './project-owner-helper-protocol.ts'
import type { CodexOwnerBindingFacts } from './project-control-bootstrap.ts'

/** Death is observed independently; this is not a successful retirement receipt. */
export interface CodexOwnerCrashReceipt {
  version: 1
  kind: 'crash'
  facts: CodexOwnerBindingFacts
  helper: HelperIdentity
}

export interface OwnerCrashProbes {
  boot(): string
  dead(identity: HelperIdentity): void
  noOtherOwner(facts: CodexOwnerBindingFacts): void
}

export interface OwnerProcessCensus {
  self: number
  uid: number | undefined
  pids(): number[]
  stat(pid: number): { uid: number; state: string; identity: HelperIdentity }
  argv(pid: number): string[]
  env(pid: number): string[]
}
const processCensus: OwnerProcessCensus = {
  self: process.pid, uid: process.getuid?.(),
  pids: () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number),
  stat(pid) {
    const uid = lstatSync(`/proc/${pid}`).uid
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (!boot || !fields[19] || !/^\d+$/.test(fields[19]) || !fields[0]) throw new Error('Codex process census identity is unknown')
    return { uid, state: fields[0], identity: { pid, boot, start: fields[19] } }
  },
  argv: pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'),
  env: pid => readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'),
}

/** Fail closed on an incomplete census. Any same-home process or exact thread
 * resume is a competing owner, even when it was not started through Neutron. */
export function assertNoOtherCodexOwner(facts: CodexOwnerBindingFacts, census: OwnerProcessCensus = processCensus): void {
  const entries = census.pids()
  if (census.uid === undefined || !entries.includes(census.self)) throw new Error('Codex process census is incomplete')
  for (const pid of entries) {
    if (pid === census.self) continue
    try {
      const before = census.stat(pid)
      if (before.uid !== census.uid || ['Z', 'X'].includes(before.state)) continue
      const argv = census.argv(pid), env = census.env(pid)
      if (!isDeepStrictEqual(before.identity, census.stat(pid).identity)) throw new Error('Codex process census changed')
      if (env.includes(`CODEX_HOME=${facts.codexHome}`) || argv.includes(facts.threadId) || argv.includes(facts.rolloutPath)) {
        throw new Error('Another process may own the Codex conversation')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

const probes: OwnerCrashProbes = {
  boot: () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  dead: assertOwnerProcessDead,
  noOtherOwner: assertNoOtherCodexOwner,
}

/** A reboot proves all old-boot processes died, including legacy owners whose
 * attestation predates native/TUI identities. Same-boot recovery needs all three. */
export function assertCrashedOwnerDead(authority: OwnerHelperDescriptor, probe: OwnerCrashProbes = probes): void {
  const boot = probe.boot()
  if (!boot || !authority.helper?.boot) throw new Error('Codex owner boot identity is unknown')
  probe.dead(authority.helper)
  if (boot === authority.helper.boot && !authority.facts.processes) {
    throw new Error('Legacy Codex owner lacks native process death evidence')
  }
  if (authority.facts.processes) {
    probe.dead(authority.facts.processes.native)
    probe.dead(authority.facts.processes.terminal)
  }
}

function readCrashAuthority(directory: string): OwnerHelperDescriptor {
  privatePath(directory, 'directory')
  const read = (name: string) => {
    const path = join(directory, name)
    privatePath(path, 'file')
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  const authority = read('.neutron-owner-authority.json') as OwnerHelperDescriptor
  const descriptor = read('.neutron-owner-helper.json') as OwnerHelperDescriptor
  const pane = read('.neutron-owner-pane.json')
  if (authority.version !== 1 || !isDeepStrictEqual(authority, descriptor)
    || !isDeepStrictEqual(pane.identity, authority.helper) || typeof pane.handle !== 'string') {
    throw new Error('Codex crash authority is not corroborated')
  }
  const facts = authority.facts
  nextOwnerDirectory(facts)
  // A sealed SQLite attestation is an independent construction-time control.
  const journalPath = join(directory, '.neutron-owner-bootstrap.sqlite')
  privatePath(journalPath, 'file')
  const db = new Database(journalPath, { readonly: true })
  try {
    const sealed = db.query<{ value: string }, []>('SELECT value FROM attestation WHERE id=1').get()
    const row = db.query<{ generation: number; unresolved: string | null; binding: string }, []>('SELECT generation, unresolved, binding FROM broker WHERE id=1').get()
    if (!sealed || !isDeepStrictEqual(JSON.parse(sealed.value), facts) || !row || row.generation !== facts.generation
      || row.unresolved !== null || row.binding !== JSON.stringify([join(directory, '.neutron-owner-bootstrap'), 'fresh-owner-bootstrap', facts.cwd, facts.codexHome])) {
      throw new Error('Codex crash generation is not sealed')
    }
  } finally { db.close() }
  const path = relative(join(facts.codexHome, 'sessions'), facts.rolloutPath)
  if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('Foreign Codex crash transcript')
  // The native CLI owns rollout mode; its private home is the access boundary.
  // Require the exact canonical regular file without inventing a new CLI mode.
  const transcript = lstatSync(facts.rolloutPath)
  if (!transcript.isFile() || transcript.uid !== process.getuid?.() || realpathSync(facts.rolloutPath) !== facts.rolloutPath) {
    throw new Error('Codex crash transcript is not an owned canonical file')
  }
  return authority
}

/** A live helper can outlast native shutdown. Report only independently observed
 * deaths from its sealed generation, never infer them from a failed attachment. */
export function observeOwnerNativeStop(directory: string, expected: OwnerHelperDescriptor,
  dead: (identity: HelperIdentity) => void = assertOwnerProcessDead): 'dead' | 'draining' | 'unknown' {
  const authority = readCrashAuthority(directory)
  if (!isDeepStrictEqual(authority, expected) || !authority.facts.processes) {
    throw new Error('Native owner shutdown lacks exact process authority')
  }
  const proven = (identity: HelperIdentity): boolean => { try { dead(identity); return true } catch { return false } }
  const native = proven(authority.facts.processes.native), terminal = proven(authority.facts.processes.terminal)
  if (!native && !terminal) return 'unknown'
  return native && terminal && proven(authority.helper) ? 'dead' : 'draining'
}

export function readCrashedOwner(directory: string, probe: OwnerCrashProbes = probes): CodexOwnerCrashReceipt {
  const authority = readCrashAuthority(directory)
  const path = join(directory, '.neutron-owner-crashed.json')
  privatePath(path, 'file')
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as CodexOwnerCrashReceipt
  if (!isDeepStrictEqual(receipt, { version: 1, kind: 'crash', facts: authority.facts, helper: authority.helper })) {
    throw new Error('Codex crash receipt is not corroborated')
  }
  assertCrashedOwnerDead(authority, probe)
  return receipt
}

/** An exclusive successor launch remains the single-owner claim. This immutable
 * record preserves the predecessor and cannot erase an unresolved work marker. */
export function recordCrashedOwner(directory: string, probe: OwnerCrashProbes = probes, expected?: OwnerHelperDescriptor): CodexOwnerCrashReceipt {
  const authority = readCrashAuthority(directory)
  if (expected && !isDeepStrictEqual(authority, expected)) throw new Error('Codex crash authority changed during attachment')
  assertCrashedOwnerDead(authority, probe)
  probe.noOtherOwner(authority.facts)
  // An interrupted explicit sleep/provider handoff is not an awake crash.
  try { lstatSync(join(directory, '.neutron-owner-retiring.json')); throw new Error('Codex owner retirement is unresolved') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const receipt: CodexOwnerCrashReceipt = { version: 1, kind: 'crash', facts: authority.facts, helper: authority.helper }
  try { writeFileSync(join(directory, '.neutron-owner-crashed.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  return readCrashedOwner(directory, probe)
}
