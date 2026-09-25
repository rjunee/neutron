import { realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { BoundedWorkRequest } from '../bounded-work.ts'

/** Opaque host authority, never serialized into a worker request. */
export interface NativeChildWorkspace { readonly kind: 'native-child-workspace' }
interface PendingChild { runId: string; stepId: string; generation: number }
interface Record {
  session: object
  request: BoundedWorkRequest
  identity: PendingChild
  pending(): readonly PendingChild[]
  paths: string[]
  directory: string
  inode: string
  branch: string
  common: string
  readOnly: boolean
  bound: boolean
  completed: boolean
  done: Promise<void>
  finish(): void
}
const records = new WeakMap<NativeChildWorkspace, Record>()
const sessions = new WeakMap<object, Set<Record>>()
const contains = (a: string, b: string) => { const path = relative(a, b); return path === '' || (path !== '..' && !path.startsWith(`..${sep}`)) }

/** Called only after durable admission. Measure the assigned Git worktree, not a
 * role or requested cwd. Git identity, canonical paths and inode identity all
 * participate: an alias must never become a second independent writer. */
export async function admitNativeChildWorkspace(input: {
  session: object
  request: BoundedWorkRequest
  runId: string
  worktree: string
  branch: string
  generation: number
  pending(): readonly PendingChild[]
  git(args: string[]): Promise<string>
}): Promise<NativeChildWorkspace> {
  if (input.request.run_id !== input.runId) throw new Error('Native workspace belongs to another run')
  const root = await realpath(input.worktree)
  if (await realpath(input.request.cwd) !== root) throw new Error('Native request does not use its assigned worktree')
  const [top, directory, common, branch] = await Promise.all([
    input.git(['rev-parse', '--show-toplevel']).then(path => realpath(path)),
    input.git(['rev-parse', '--absolute-git-dir']).then(path => realpath(path)),
    input.git(['rev-parse', '--path-format=absolute', '--git-common-dir']).then(path => realpath(path)),
    input.git(['symbolic-ref', '--quiet', 'HEAD']),
  ])
  if (root !== top || branch !== `refs/heads/${input.branch}` || directory === common) {
    throw new Error('Native writer requires the checked assigned linked worktree')
  }
  const info = await stat(root)
  const result = join(await realpath(dirname(input.request.result.path)), input.request.result.path.split(sep).at(-1)!)
  const identity = { runId: input.runId, stepId: input.request.step_id, generation: input.generation }
  if (input.pending().filter(row => isDeepStrictEqual(row, identity)).length !== 1) throw new Error('Native writer has no unique durable admission')
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const record: Record = { session: input.session, request: structuredClone(input.request), identity, pending: input.pending,
    paths: [root, result], directory, common, branch, inode: `${info.dev}:${info.ino}`,
    readOnly: !input.request.writable && (input.request.tools === 'none' || input.request.tools === 'read-only'),
    bound: false, completed: false, done, finish }
  const admission: NativeChildWorkspace = Object.freeze({ kind: 'native-child-workspace' })
  records.set(admission, record)
  const owned = sessions.get(input.session) ?? new Set<Record>()
  owned.add(record)
  sessions.set(input.session, owned)
  return admission
}

export function ownsNativeChildWorkspace(admission: NativeChildWorkspace, session: object, request: BoundedWorkRequest): boolean {
  const record = records.get(admission)
  return !!record && !record.completed && record.session === session && isDeepStrictEqual(record.request, request)
}

/** Restart/foreign leases have no local proof. A duplicate identity is ambiguous.
 * Such work must be reconciled through its original reservation before dispatch. */
export function nativeChildCensusKnown(admission: NativeChildWorkspace): boolean {
  const record = records.get(admission)
  if (!record || record.completed) return false
  try {
    const pending = record.pending()
    return pending.filter(row => isDeepStrictEqual(row, record.identity)).length === 1
      && pending.every((row, index) => pending.findIndex(other => isDeepStrictEqual(row, other)) === index
        && [...sessions.get(record.session) ?? []].some(other => !other.completed && isDeepStrictEqual(other.identity, row)))
  } catch { return false }
}

export function bindNativeChildWorkspace(admission: NativeChildWorkspace): void {
  const record = records.get(admission)
  if (record) record.bound = true
}

export function independentNativeChildren(next: NativeChildWorkspace | undefined, prior: NativeChildWorkspace | undefined): boolean {
  if (!next || !prior) return !next && !prior
  const a = records.get(next), b = records.get(prior)
  return !!a && !!b && !a.completed && !b.completed && a.session === b.session && b.bound
    && ((a.readOnly && b.readOnly) || (!a.readOnly && !b.readOnly
      && a.directory !== b.directory && a.inode !== b.inode && (a.common !== b.common || a.branch !== b.branch)
      && a.paths.every(left => b.paths.every(right => !contains(left, right) && !contains(right, left)))))
}

export function nativeChildWorkspaceCompletion(admission: NativeChildWorkspace): Promise<void> | undefined {
  return records.get(admission)?.done
}

/** Host calls only after validated terminal evidence and durable lease release,
 * or refusal before dispatch. Unknown never completes this authority. */
export function completeNativeChildWorkspace(admission: NativeChildWorkspace): void {
  const record = records.get(admission)
  if (!record || record.completed) return
  record.completed = true
  sessions.get(record.session)?.delete(record)
  record.finish()
}

/** Reconstructed runners reconcile the original request against the same pooled
 * session. They must release its existing authority, never mint a new child. */
export function completeNativeChildWorkspaceRequest(session: object, request: BoundedWorkRequest): void {
  for (const record of sessions.get(session) ?? []) {
    if (!isDeepStrictEqual(record.request, request)) continue
    record.completed = true
    sessions.get(session)?.delete(record)
    record.finish()
  }
}
