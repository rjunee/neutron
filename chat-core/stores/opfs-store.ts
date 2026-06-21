/**
 * @neutron/chat-core/stores — durable web local store over OPFS.
 *
 * Implements the {@link Store} interface against the Origin Private File
 * System (research doc §5 — "wasm-SQLite/OPFS on web"). This is the Phase-1
 * durable substrate: a fast in-memory index for queries, snapshotted to an
 * OPFS file so the transcript survives reloads → instant cold-open + offline
 * read. The {@link Store} seam means a Phase-2 wasm-SQLite engine (with FTS5)
 * drops in here without touching the sync engine, send-queue, or UI.
 *
 * GRACEFUL DEGRADATION (scope guard): OPFS + `createWritable` aren't
 * universally available (older browsers, some private-mode contexts, no
 * COOP/COEP). {@link createWebStore} feature-detects and silently falls back
 * to a pure in-memory {@link InMemoryStore} so the web client NEVER breaks —
 * it just loses durability until the environment supports OPFS.
 */

import { InMemoryStore, type Store } from '../store.ts'
import type { ChatMessage } from '../types.ts'

const SNAPSHOT_FILE = 'neutron-chat-core.json'

/** Subset of the OPFS surface we use, so we can feature-detect precisely. */
interface OpfsFileHandle {
  getFile(): Promise<{ text(): Promise<string> }>
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>
}
interface OpfsDirHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>
}

type SnapshotShape = Record<string, ChatMessage[]>

export class OpfsChatStore implements Store {
  private readonly mem = new InMemoryStore()
  private readonly dir: OpfsDirHandle
  private persistScheduled = false
  private persistChain: Promise<void> = Promise.resolve()

  private constructor(dir: OpfsDirHandle) {
    this.dir = dir
  }

  /**
   * Open the OPFS-backed store and hydrate the in-memory index from the
   * persisted snapshot. Throws when OPFS isn't usable — callers should use
   * {@link createWebStore}, which catches and degrades.
   */
  static async open(): Promise<OpfsChatStore> {
    const dir = await getOpfsRoot()
    const store = new OpfsChatStore(dir)
    await store.hydrate()
    return store
  }

  private async hydrate(): Promise<void> {
    try {
      const fh = await this.dir.getFileHandle(SNAPSHOT_FILE, { create: true })
      const file = await fh.getFile()
      const text = await file.text()
      if (text.length === 0) return
      const parsed = JSON.parse(text) as SnapshotShape
      for (const topic of Object.keys(parsed)) {
        const rows = parsed[topic]
        if (!Array.isArray(rows)) continue
        this.knownTopics.add(topic)
        for (const row of rows) await this.mem.upsert(row)
      }
    } catch {
      // Corrupt / unreadable snapshot — start empty rather than throw. The
      // next persist overwrites it with valid JSON.
    }
  }

  async upsert(msg: ChatMessage): Promise<void> {
    await this.mem.upsert(msg)
    this.knownTopics.add(msg.topic_id)
    this.schedulePersist()
  }

  list(topic_id: string): Promise<ChatMessage[]> {
    return this.mem.list(topic_id)
  }

  getByClientMsgId(topic_id: string, client_msg_id: string): Promise<ChatMessage | null> {
    return this.mem.getByClientMsgId(topic_id, client_msg_id)
  }

  getByMessageId(topic_id: string, message_id: string): Promise<ChatMessage | null> {
    return this.mem.getByMessageId(topic_id, message_id)
  }

  lastSeenSeq(topic_id: string): Promise<number> {
    return this.mem.lastSeenSeq(topic_id)
  }

  pendingSends(topic_id: string): Promise<ChatMessage[]> {
    return this.mem.pendingSends(topic_id)
  }

  async clear(topic_id: string): Promise<void> {
    await this.mem.clear(topic_id)
    this.knownTopics.delete(topic_id)
    this.schedulePersist()
  }

  /** Force any pending snapshot write to complete (tests / unload). */
  async flushPersist(): Promise<void> {
    await this.persistChain
  }

  // Coalesce bursts of upserts (a resume replay) into a single snapshot
  // write on a microtask boundary, serialized so writes never interleave.
  private schedulePersist(): void {
    if (this.persistScheduled) return
    this.persistScheduled = true
    this.persistChain = this.persistChain.then(() =>
      Promise.resolve().then(() => {
        this.persistScheduled = false
        return this.persistSnapshot()
      }),
    )
  }

  private async persistSnapshot(): Promise<void> {
    try {
      const snapshot: SnapshotShape = {}
      // Reconstruct per-topic lists from the in-memory index.
      for (const topic of await this.topics()) {
        snapshot[topic] = await this.mem.list(topic)
      }
      const fh = await this.dir.getFileHandle(SNAPSHOT_FILE, { create: true })
      const writable = await fh.createWritable()
      await writable.write(JSON.stringify(snapshot))
      await writable.close()
    } catch {
      // Persist failure is non-fatal: the in-memory index is still correct
      // for this session; durability simply lapses for this write.
    }
  }

  // InMemoryStore doesn't expose its topic set; we accumulate touched topics
  // (from hydrate + upsert) so persistSnapshot can enumerate them without
  // widening the Store API.
  private readonly knownTopics = new Set<string>()
  private async topics(): Promise<string[]> {
    return [...this.knownTopics]
  }
}

/** Resolve the OPFS root, or throw if the platform lacks usable OPFS. */
async function getOpfsRoot(): Promise<OpfsDirHandle> {
  const nav = (globalThis as { navigator?: unknown }).navigator as
    | { storage?: { getDirectory?: () => Promise<unknown> } }
    | undefined
  if (nav?.storage?.getDirectory === undefined) {
    throw new Error('OPFS unavailable: navigator.storage.getDirectory missing')
  }
  const root = (await nav.storage.getDirectory()) as OpfsDirHandle & {
    getFileHandle?: unknown
  }
  if (typeof root.getFileHandle !== 'function') {
    throw new Error('OPFS unavailable: getFileHandle missing')
  }
  // Probe createWritable support without leaving a stray file around beyond
  // our snapshot file (which we reuse anyway).
  const probe = (await root.getFileHandle(SNAPSHOT_FILE, { create: true })) as OpfsFileHandle & {
    createWritable?: unknown
  }
  if (typeof probe.createWritable !== 'function') {
    throw new Error('OPFS unavailable: createWritable missing')
  }
  return root
}

/**
 * Construct the best available web Store: OPFS-backed durable when supported,
 * else an in-memory fallback. NEVER throws — the web client can always get a
 * working Store.
 */
export async function createWebStore(): Promise<Store> {
  try {
    return await OpfsChatStore.open()
  } catch {
    return new InMemoryStore()
  }
}
