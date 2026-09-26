import { isAbsolute } from 'node:path'
import type { NativeProcessExit } from './project-control-broker-transport.ts'

type Rpc = Record<string, unknown>
const object = (value: unknown): value is Rpc => typeof value === 'object' && value !== null && !Array.isArray(value)
export type RetirementRefusal = { status: 'busy' | 'unknown'; reason: string }
export interface NativeRetirementFacts { generation: number; epoch: number; threadId: string; rolloutPath: string | null }
export type NativeOwnerRetirement = RetirementRefusal | (NativeRetirementFacts & { status: 'retired'; exit: NativeProcessExit })
export type PreparedNativeRetirement = RetirementRefusal | { status: 'prepared'; lease: NativeRetirementFacts & {
  abort(): void
  retire(): Promise<NativeOwnerRetirement>
} }

class CensusRefusal extends Error {
  constructor(readonly status: 'busy' | 'unknown', reason: string) { super(reason) }
}
const unknown = (reason: string): never => { throw new CensusRefusal('unknown', reason) }
const busy = (reason: string): never => { throw new CensusRefusal('busy', reason) }

/** Host-private exhaustive native census. Never use the broker's filtered list. */
export async function inspectNativeRetirement(
  rpc: (method: string, params: Rpc) => Promise<unknown>, rootId: string, observedThreads: ReadonlySet<string> = new Set(),
): Promise<RetirementRefusal | { status: 'idle'; rolloutPath: string | null }> {
  try {
    const pages = async (method: string, params: Rpc): Promise<unknown[]> => {
      const data: unknown[] = [], seen = new Set<string>()
      let cursor: string | null = null
      for (let page = 0; page < 1000; page++) {
        const result = await rpc(method, { ...params, cursor, limit: 100 })
        if (!object(result) || !Array.isArray(result.data) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) return unknown(`Incomplete ${method} census`)
        data.push(...result.data)
        if (result.nextCursor === null) return data
        if (!result.nextCursor || seen.has(result.nextCursor)) return unknown(`Repeated ${method} cursor`)
        cursor = result.nextCursor; seen.add(cursor)
      }
      return unknown(`Unbounded ${method} census`)
    }
    const loaded = await pages('thread/loaded/list', {})
    if (loaded.some(value => typeof value !== 'string' || !value) || new Set(loaded).size !== loaded.length || !loaded.includes(rootId)) return unknown('Loaded owner census incomplete')
    const threads = new Map<string, Rpc>()
    const read = async (threadId: string): Promise<Rpc> => {
      const result = await rpc('thread/read', { threadId, includeTurns: false })
      if (!object(result) || !object(result.thread) || result.thread.id !== threadId
        || typeof result.thread.sessionId !== 'string' || !result.thread.sessionId
        || !(result.thread.parentThreadId === null || typeof result.thread.parentThreadId === 'string')
        || !object(result.thread.status)) return unknown('Native thread identity incomplete')
      threads.set(threadId, result.thread)
      return result.thread
    }
    for (const threadId of loaded as string[]) await read(threadId)
    const root = threads.get(rootId)!
    if (root.parentThreadId !== null || !(root.path === null || typeof root.path === 'string' && isAbsolute(root.path))) return unknown('Native root resume identity incomplete')
    const completed = new Set<string>(), discovered = new Set<string>([rootId]), parents = new Map<string, string>()
    for (const threadId of discovered) {
      if (discovered.size > 1000) return unknown('Unbounded native child census')
      const thread = threads.get(threadId) ?? await read(threadId)
      if (thread.sessionId !== root.sessionId) return unknown('Foreign native session')
      const status = (thread.status as Rpc).type
      if (status === 'active') return busy('Native thread is active')
      if (status !== 'idle' && !(threadId !== rootId && status === 'notLoaded' && completed.has(threadId))) return unknown('Native thread liveness unknown')
      const pending = new Set<string>()
      const turns = await pages('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc' })
      const turnIds = new Set<string>()
      for (const turn of turns) {
        if (!object(turn) || typeof turn.id !== 'string' || turnIds.has(turn.id) || turn.itemsView !== 'full' || !Array.isArray(turn.items)) return unknown('Native turn history incomplete')
        turnIds.add(turn.id)
        if (turn.status === 'inProgress') return busy('Native turn is active')
        if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))) return unknown('Native turn status unknown')
        for (const item of turn.items) {
          if (!object(item)) return unknown('Native item malformed')
          if (item.type !== 'subAgentActivity') continue
          if (typeof item.agentThreadId !== 'string' || !item.agentThreadId || typeof item.agentPath !== 'string' || !item.agentPath) return unknown('Native child correlation missing')
          if (item.agentThreadId === rootId || parents.has(item.agentThreadId) && parents.get(item.agentThreadId) !== threadId) return unknown('Native child parent correlation changed')
          parents.set(item.agentThreadId, threadId)
          const key = JSON.stringify([turn.id, item.agentThreadId, item.agentPath])
          discovered.add(item.agentThreadId)
          if (item.kind === 'started') {
            if (pending.has(key)) return unknown('Duplicate native child start')
            pending.add(key); completed.delete(item.agentThreadId)
          } else if (item.kind === 'completed') {
            if (!pending.delete(key)) return unknown('Unpaired native child completion')
            completed.add(item.agentThreadId)
          } else return unknown('Native child activity unknown')
        }
      }
      if (pending.size) return busy('Native child has not completed')
      if ((await pages('thread/backgroundTerminals/list', { threadId })).length) return busy('Native background terminal remains')
      if ((await pages('thread/queue/list', { threadId })).length) return busy('Native queued work remains')
      const goal = await rpc('thread/goal/get', { threadId })
      if (!object(goal) || !('goal' in goal)) return unknown('Native goal census incomplete')
      if (goal.goal !== null) {
        if (!object(goal.goal) || goal.goal.threadId !== threadId || typeof goal.goal.status !== 'string') return unknown('Native goal identity incomplete')
        if (['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(goal.goal.status)) return busy('Native goal remains unresolved')
        if (goal.goal.status !== 'complete') return unknown('Native goal status unknown')
      }
    }
    for (const [threadId, thread] of threads) {
      if (threadId === rootId) continue
      if (!discovered.has(threadId) || !completed.has(threadId)) return unknown('Unaccounted loaded native child')
      if (parents.get(threadId) !== thread.parentThreadId) return unknown('Native child parent correlation mismatch')
      const seen = new Set<string>([threadId])
      let parent = thread.parentThreadId
      while (parent !== rootId) {
        if (typeof parent !== 'string' || seen.has(parent) || !threads.has(parent)) return unknown('Native child lineage incomplete')
        seen.add(parent); parent = threads.get(parent)!.parentThreadId
      }
    }
    if ([...observedThreads].some(threadId => !discovered.has(threadId))) return unknown('Observed native child missing from authoritative census')
    return { status: 'idle', rolloutPath: root.path as string | null }
  } catch (error) {
    return { status: error instanceof CensusRefusal ? error.status : 'unknown', reason: error instanceof Error ? error.message : 'Native census failed' }
  }
}
