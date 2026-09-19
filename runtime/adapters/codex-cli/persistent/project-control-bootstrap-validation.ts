import { lstatSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { validateProjectControlScope } from './project-control-broker-scope.ts'

type Rpc = Record<string, unknown>
const object = (value: unknown): value is Rpc => typeof value === 'object' && value !== null && !Array.isArray(value)
export const OWNER_BOOTSTRAP_ORIGINATOR = 'neutron-owner-bootstrap'

/** Internal validation, never a constructor for an authoritative binding handle. */
export function validateBootstrapThread(thread: unknown, event: Rpc | undefined, cwd: string, codexHome: string): asserts thread is Rpc & {
  id: string; sessionId: string; path: string; source: string; originator: string; modelProvider: string
} {
  if (!object(thread) || !event || ['id', 'sessionId', 'cwd', 'path', 'source', 'originator', 'ephemeral', 'modelProvider'].some(key => thread[key] !== event[key])
    || JSON.stringify(thread.environments) !== JSON.stringify(event.environments)
    || typeof thread.id !== 'string' || !thread.id || typeof thread.sessionId !== 'string' || !thread.sessionId
    || typeof thread.path !== 'string' || !isAbsolute(thread.path) || thread.cwd !== cwd
    || thread.ephemeral !== false || thread.originator !== OWNER_BOOTSTRAP_ORIGINATOR || typeof thread.source !== 'string' || !thread.source
    || typeof thread.modelProvider !== 'string' || !thread.modelProvider
    || thread.parentThreadId != null || thread.forkedFromId != null || !Array.isArray(thread.turns) || thread.turns.length !== 0) {
    throw new Error('Native owner binding mismatch')
  }
  const path = relative(join(codexHome, 'sessions'), thread.path)
  if (!path || path.startsWith('..') || isAbsolute(path) || join(codexHome, 'sessions', path) !== thread.path) throw new Error('Foreign rollout namespace')
  let ancestor = codexHome
  for (const part of ['sessions', ...path.split(sep)]) {
    ancestor = join(ancestor, part)
    try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Symlink rollout namespace') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error }
  }
  validateProjectControlScope('thread/start', thread.environments == null ? { cwd: thread.cwd } :
    { cwd: thread.cwd, environments: thread.environments }, cwd, message => new Error(message))
}

/** Native remote TUI uses '/', an explicit bearer, and no browser Origin. */
export function admitsOwnerTui(request: Request, token: string, occupied: boolean): boolean {
  return !occupied && !request.headers.has('origin') && new URL(request.url).pathname === '/'
    && request.headers.get('authorization') === `Bearer ${token}`
}
