import { lstatSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { validateProjectControlScope } from './project-control-broker-scope.ts'
import type { CodexOwnerBindingFacts } from './project-control-bootstrap.ts'

type Rpc = Record<string, unknown>
const object = (value: unknown): value is Rpc => typeof value === 'object' && value !== null && !Array.isArray(value)
export const OWNER_BOOTSTRAP_ORIGINATOR = 'neutron-owner-bootstrap'

/** Only the native TUI's exact required feature override is admissible. */
export function admitsBootstrapConfig(config: unknown): boolean {
  if (!object(config) || Object.keys(config).some(key => !['personality', 'web_search', 'features'].includes(key))) return false
  return object(config.features) && Object.keys(config.features).length === 1 && config.features.multi_agent_v2 === true
}

/** Evidence of native support and enablement, not proof that a child has run. */
export function validateBootstrapMultiAgent(features: unknown): void {
  if (!object(features) || !Array.isArray(features.data) || features.nextCursor !== null
    || features.data.filter(feature => object(feature) && feature.name === 'multi_agent_v2').length !== 1
    || !features.data.some(feature => object(feature) && feature.name === 'multi_agent_v2'
      && feature.enabled === true && ['beta', 'underDevelopment', 'stable'].includes(String(feature.stage)))) throw new Error('Native multi-agent capability unavailable')
}

/** Internal validation, never a constructor for an authoritative binding handle. */
export function validateBootstrapThread(thread: unknown, event: Rpc | undefined, cwd: string, codexHome: string,
  resumed?: CodexOwnerBindingFacts): asserts thread is Rpc & {
  id: string; sessionId: string; path: string; source: string; originator: string; modelProvider: string
} {
  if (!object(thread) || !event || ['id', 'sessionId', 'cwd', 'path', 'source', 'originator', 'ephemeral', 'modelProvider'].some(key => thread[key] !== event[key])
    || JSON.stringify(thread.environments) !== JSON.stringify(event.environments)
    || typeof thread.id !== 'string' || !thread.id || typeof thread.sessionId !== 'string' || !thread.sessionId
    || typeof thread.path !== 'string' || !isAbsolute(thread.path) || thread.cwd !== cwd
    || thread.ephemeral !== false || thread.originator !== OWNER_BOOTSTRAP_ORIGINATOR || typeof thread.source !== 'string' || !thread.source
    || typeof thread.modelProvider !== 'string' || !thread.modelProvider
    || thread.parentThreadId != null || thread.forkedFromId != null || !Array.isArray(thread.turns)
    || resumed === undefined && thread.turns.length !== 0) {
    throw new Error('Native owner binding mismatch')
  }
  if (resumed && (thread.id !== resumed.threadId || thread.sessionId !== resumed.sessionId
    || thread.path !== resumed.rolloutPath || thread.source !== resumed.nativeMetadata.source
    || thread.originator !== resumed.nativeMetadata.originator || thread.modelProvider !== resumed.modelProvider)) {
    throw new Error('Native resumed owner identity mismatch')
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
