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
export const MAX_REVIEW_SETTLEMENT_WAIT_MS = 60_000
export interface ReviewPermissionLease {
  /** The only native start admitted by this lease. No caller permission overrides. */
  start(input: readonly unknown[]): Promise<{ turnId: string }>
  /** Waits at most 60 seconds for exact tree settlement; false permanently fences. */
  waitSettled(timeoutMs: number): Promise<boolean>
  /** Restores and verifies policy after the whole tree settles; retains exclusivity. */
  restore(): Promise<void>
  /** Host acknowledgement only: releases the journal after verified restoration. */
  release(): Promise<void>
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
  assertCurrent(): void
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
  let parentTurn: string | undefined, used = false, released = false, restoring = false, restored = false, phase = 'snapshot'
  const completed = new Set<string>(), turns = new Map<string, Set<string>>()
  const spawns = new Map<string, { parent: string; turn: string; child: string }>()
  let observationUncertain = false
  let checkSettlement: (() => void) | undefined
  const fence = (): void => { observationUncertain = true; checkSettlement?.(); host.fence() }
  const fail = (): never => { fence(); throw new Error(`Native review permissions require reconciliation (${phase})`) }
  const assertStage = (): void => {
    const now = lstatSync(request.stageDir)
    if (realpathSync(request.stageDir) !== request.stageDir || !now.isDirectory() || now.dev !== initialStage.dev || now.ino !== initialStage.ino) fail()
  }
  const snapshot = (value: unknown): Rpc => {
    if (!object(value) || value.cwd !== host.cwd || !object(value.thread) || value.thread.id !== host.threadId
      || !object(value.sandbox) || value.approvalPolicy === undefined || value.approvalsReviewer === undefined) return fail()
    return value
  }
  const treeSettled = (): boolean => {
    if (observationUncertain || !parentTurn || !completed.has(JSON.stringify([host.threadId, parentTurn]))) return false
    const tree = new Set([host.threadId]), parents = new Map<string, string>(), direct = new Set<string>()
    let changed = true
    while (changed) {
      changed = false
      for (const edge of spawns.values()) {
        if (!tree.has(edge.parent)) continue
        if (edge.parent === host.threadId ? edge.turn !== parentTurn : !turns.get(edge.parent)?.has(edge.turn)) return false
        if (edge.child === host.threadId || edge.child === edge.parent || parents.has(edge.child) && parents.get(edge.child) !== edge.parent) return false
        parents.set(edge.child, edge.parent)
        if (edge.parent === host.threadId) direct.add(edge.child)
        if (!tree.has(edge.child)) { tree.add(edge.child); changed = true }
      }
    }
    if (direct.size !== 1 || [...spawns.values()].some(edge => !tree.has(edge.parent))) return false
    // A started thread lacking a spawn edge is unknown correlation, not proof
    // of an unrelated worker. Preserve events that arrive before their edge.
    for (const [thread, observed] of turns) {
      if (!tree.has(thread) || thread === host.threadId && [...observed].some(turn => turn !== parentTurn)) return false
      for (const turn of observed) if (!completed.has(JSON.stringify([thread, turn]))) return false
    }
    return [...tree].every(thread => thread === host.threadId || !!turns.get(thread)?.size)
  }
  return {
    observe(message) {
      if (!used || released || !object(message.params)) return
      const params = message.params
      const spawn = message.method === 'item/completed' && object(params.item) && params.item.type === 'subAgentActivity' && params.item.kind === 'started'
      if (spawn) {
        const item = params.item as Rpc
        if (typeof params.threadId !== 'string' || typeof params.turnId !== 'string' || typeof item.agentThreadId !== 'string') observationUncertain = true
        else spawns.set(JSON.stringify([params.threadId, params.turnId, item.agentThreadId]), { parent: params.threadId, turn: params.turnId, child: item.agentThreadId })
      }
      if (phase === 'restoration' && (spawn || message.method === 'turn/started')) {
        fence()
      }
      if (typeof params.threadId === 'string' && object(params.turn) && typeof params.turn.id === 'string') {
        if (message.method === 'turn/started') {
          if (params.threadId === host.threadId) parentTurn ??= params.turn.id
          const observed = turns.get(params.threadId) ?? new Set<string>()
          observed.add(params.turn.id); turns.set(params.threadId, observed)
        }
        if (message.method === 'turn/completed') completed.add(JSON.stringify([params.threadId, params.turn.id]))
      }
      checkSettlement?.()
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
              if (!treeSettled()) return fail()
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
              if (!treeSettled()) return fail()
              restored = true
            } catch { return fail() }
          },
          async waitSettled(timeoutMs) {
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REVIEW_SETTLEMENT_WAIT_MS) throw new Error('Native review settlement timeout must be 1..60000 milliseconds')
            if (!parentTurn || released || restoring || checkSettlement) throw new Error('Native review settlement wait unavailable')
            phase = 'settlement wait'
            return new Promise<boolean>(resolve => {
              const deadline = performance.now() + timeoutMs
              const timer = setTimeout(() => { fence() }, timeoutMs)
              const finish = (settled: boolean): void => { clearTimeout(timer); checkSettlement = undefined; resolve(settled) }
              checkSettlement = () => {
                if (observationUncertain) { finish(false); host.fence(); return }
                if (performance.now() >= deadline) { fence(); return }
                try { host.assertCurrent(); assertStage() } catch { fence(); return }
                if (treeSettled()) finish(true)
              }
              checkSettlement()
            })
          },
          async release() {
            if (released) throw new Error('Native review lease already released')
            phase = 'release'
            if (!restored || !treeSettled()) return fail()
            try {
              assertStage()
              host.finish()
              released = true
            } catch { return fail() }
          },
          abandon() { if (!released) fence() },
        }
      } catch { return fail() }
    },
  }
}
