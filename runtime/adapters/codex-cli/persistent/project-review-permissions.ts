import { randomBytes } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

type Rpc = Record<string, unknown>
const object = (value: unknown): value is Rpc => value !== null && typeof value === 'object' && !Array.isArray(value)
function configured(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(configured)
  return object(value) ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null).map(([key, entry]) => [key, configured(entry)])) : value
}

export interface ReviewPermissionRequest {
  stageDir: string
  network: boolean
}
export interface ReviewPermissionLease {
  /** The only native start admitted by this lease. No caller permission overrides. */
  start(input: readonly unknown[]): Promise<{ turnId: string }>
  /** Requires measured parent and child completion, then restores and re-reads policy. */
  restore(): Promise<void>
  /** Uncertain work never releases the project writer or its durable journal. */
  abandon(): void
}
export async function prepareNativeReviewPermissions(broker: {
  reviewPermissions?(request: ReviewPermissionRequest, expectedEpoch: number): Promise<ReviewPermissionLease>
}, request: ReviewPermissionRequest, expectedEpoch: number): Promise<
  { kind: 'ready'; lease: ReviewPermissionLease } | { kind: 'refused'; reason: 'capability-unsupported' }
> {
  if (!broker.reviewPermissions) return { kind: 'refused', reason: 'capability-unsupported' }
  return { kind: 'ready', lease: await broker.reviewPermissions(request, expectedEpoch) }
}
export interface ReviewPermissionHost {
  cwd: string
  codexHome: string
  threadId: string
  rpc(method: string, params: Rpc): Promise<unknown>
  finish(): void
  fence(): void
}

/** Host-only transaction, called while the broker excludes every other writer.
 * Profile configuration is installed through native config/batchWrite so its
 * file lock and atomic writer remain authoritative. Profile names are never
 * reused; a cold late child cannot resolve one to another step's grant.
 */
export function createReviewPermissionTransaction(host: ReviewPermissionHost, request: ReviewPermissionRequest): {
  prepare(): Promise<ReviewPermissionLease>
  observe(message: Rpc): void
} {
  const prefix = join(host.cwd, '.neutron', 'build-results')
  if (!request.stageDir.startsWith(`${prefix}/`) || !/^[a-f0-9]{64}$/.test(request.stageDir.slice(prefix.length + 1))
    || realpathSync(request.stageDir) !== request.stageDir || realpathSync(host.cwd) !== host.cwd
    || !lstatSync(request.stageDir).isDirectory()) throw new Error('Exact native review stage required')
  const initialStage = lstatSync(request.stageDir)
  const profile = `neutron_review_${randomBytes(16).toString('hex')}`
  let parentTurn: string | undefined, used = false, released = false, restoring = false, phase = 'snapshot'
  const completed = new Set<string>(), children = new Set<string>(), childTurns = new Map<string, string>()
  const fail = (): never => { host.fence(); throw new Error(`Native review permissions require reconciliation (${phase})`) }
  const assertStage = (): void => {
    const now = lstatSync(request.stageDir)
    if (realpathSync(request.stageDir) !== request.stageDir || !now.isDirectory() || now.dev !== initialStage.dev || now.ino !== initialStage.ino) fail()
  }
  const snapshot = (value: unknown): Rpc => {
    if (!object(value) || value.cwd !== host.cwd || !object(value.thread) || value.thread.id !== host.threadId
      || !object(value.sandbox) || value.approvalPolicy === undefined || value.approvalsReviewer === undefined) return fail()
    return value
  }
  return {
    observe(message) {
      if (!used || released || !object(message.params)) return
      const params = message.params
      if (message.method === 'item/completed' && params.threadId === host.threadId && params.turnId === parentTurn
        && object(params.item) && params.item.type === 'subAgentActivity' && params.item.kind === 'started'
        && typeof params.item.agentThreadId === 'string') children.add(params.item.agentThreadId)
      if (typeof params.threadId !== 'string' || !object(params.turn) || typeof params.turn.id !== 'string') return
      if (message.method === 'turn/started') {
        if (params.threadId === host.threadId) parentTurn ??= params.turn.id
        else childTurns.set(params.threadId, params.turn.id)
      }
      if (message.method === 'turn/completed') completed.add(JSON.stringify([params.threadId, params.turn.id]))
    },
    async prepare() {
      try {
        const before = snapshot(await host.rpc('thread/resume', { threadId: host.threadId, cwd: host.cwd }))
        phase = 'tool admission'
        const configuration = await host.rpc('config/read', { includeLayers: false, cwd: host.cwd })
        if (!object(configuration) || !object(configuration.config)) return fail()
        const servers = configuration.config.mcp_servers
        // A filesystem profile cannot restrict an MCP server's own filesystem.
        if (servers !== undefined && (!object(servers) || Object.values(servers).some(server => !object(server) || server.enabled !== false))) return fail()
        const grant = { filesystem: { ':root': 'read', [request.stageDir]: 'write' }, network: { enabled: request.network } }
        phase = 'profile provision'
        const originalDefault = configuration.config.default_permissions ?? null
        const originalProfiles = configured(configuration.config.permissions ?? {})
        await host.rpc('config/batchWrite', { filePath: join(host.codexHome, 'config.toml'), edits: [
          { keyPath: `permissions.${profile}`, value: grant, mergeStrategy: 'replace' },
          { keyPath: 'default_permissions', value: originalDefault ?? ':read-only', mergeStrategy: 'replace' },
        ] })
        const installed = await host.rpc('config/read', { includeLayers: false, cwd: host.cwd })
        phase = 'profile verification'
        if (!object(installed) || !object(installed.config) || !object(installed.config.permissions)
          || !isDeepStrictEqual(configured(installed.config.permissions[profile]), grant)) return fail()
        return {
          async start(input) {
            if (used || released) throw new Error('Native review dispatch lease already used')
            used = true
            phase = 'dispatch'
            try {
              assertStage()
              const result = await host.rpc('turn/start', { threadId: host.threadId, cwd: host.cwd,
                permissions: profile, approvalPolicy: 'never', input: [...input] })
              if (!object(result) || !object(result.turn) || typeof result.turn.id !== 'string') return fail()
              if (parentTurn !== undefined && parentTurn !== result.turn.id) return fail()
              parentTurn = result.turn.id
              return { turnId: parentTurn }
            } catch { return fail() }
          },
          async restore() {
            if (released || restoring) throw new Error('Native review restoration already requested')
            restoring = true
            phase = 'settlement'
            try {
              if (!parentTurn || !completed.has(JSON.stringify([host.threadId, parentTurn])) || children.size !== 1) return fail()
              for (const child of children) {
                const turn = childTurns.get(child)
                if (!turn || !completed.has(JSON.stringify([child, turn]))) return fail()
              }
              assertStage()
              phase = 'restoration'
              const active = before.activePermissionProfile
              const policy = object(active) && typeof active.id === 'string'
                ? { permissions: active.id } : { sandboxPolicy: before.sandbox }
              await host.rpc('thread/settings/update', { threadId: host.threadId, ...policy,
                approvalPolicy: before.approvalPolicy, approvalsReviewer: before.approvalsReviewer })
              await host.rpc('config/batchWrite', { filePath: join(host.codexHome, 'config.toml'), edits: [
                { keyPath: `permissions.${profile}`, value: null, mergeStrategy: 'replace' },
                { keyPath: 'default_permissions', value: originalDefault, mergeStrategy: 'replace' },
              ] })
              const restoredConfig = await host.rpc('config/read', { includeLayers: false, cwd: host.cwd })
              if (!object(restoredConfig) || !object(restoredConfig.config)
                || (restoredConfig.config.default_permissions ?? null) !== originalDefault
                || !isDeepStrictEqual(configured(restoredConfig.config.permissions ?? {}), originalProfiles)) return fail()
              const after = snapshot(await host.rpc('thread/resume', { threadId: host.threadId, cwd: host.cwd }))
              for (const key of ['sandbox', 'activePermissionProfile', 'approvalPolicy', 'approvalsReviewer', 'runtimeWorkspaceRoots']) {
                if (!isDeepStrictEqual(after[key], before[key])) return fail()
              }
              released = true
              host.finish()
            } catch { return fail() }
          },
          abandon() { if (!released) host.fence() },
        }
      } catch { return fail() }
    },
  }
}
