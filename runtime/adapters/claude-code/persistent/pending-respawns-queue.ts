/**
 * pending-respawns-queue.ts — restart-idempotent persistence for deferred REPL
 * respawns (substrate-lift S2 § 2 row #11).
 *
 * LIFTED from Nova `gateway/pending-respawns-queue.ts` (★ pure functions
 * verbatim; ◆ the entry shape + replay sink adapt at the boundary). Nova's
 * snapshot recorded `TopicEntry{name,thread_id,cwd,port}` and replayed dropped
 * inbounds via tmux `send-keys`. Neutron records a REPL respawn request keyed on
 * `sessionKey` + `sessionId` and replays the dropped inbound via the dev-channel
 * `POST /message`.
 *
 * Architectural principle (Nova northwind incident 2026-05-21): **disk is the
 * source of truth** — a crash between "schedule the deferred respawn" and "the
 * setTimeout fires" must not silently drop the recovery. The queue is snapshot
 * BEFORE the drain `setTimeout`s fire; at boot, before anything else, any
 * leftover entries are drained (each is a REPL whose `setTimeout` died with the
 * previous gateway). Single-shot per restart: the file is deleted once drained,
 * or per-entry as each entry's `setTimeout` fires (whichever the caller wires).
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { atomicWriteFileSync } from '../../../atomic-write.ts'

/** One deferred REPL respawn. `sessionKey` is opaque (follows S3 keying). */
export interface PendingRespawnEntry {
  /** Pool key the respawn re-attaches. */
  sessionKey: string
  /** Session UUID to `--resume`. */
  sessionId: string
  /** REPL working dir. */
  cwd: string
  /** The crashed substrate's `substrate_instance_id`. Recorded so the drain can
   *  reconstruct the EXACT pool key (`${substrate_instance_id}\0${cwd}`) and
   *  replay into the session the inbound was dropped from — the instance queue is
   *  shared across substrates, so the drain's own options can't be trusted to
   *  identify the target (Codex P2). Optional for back-compat with legacy rows. */
  substrate_instance_id?: string
  /** Last-known dev-channel port (advisory — the respawn rebinds a fresh one). */
  devchannel_port?: number
  /** The inbound text dropped when the REPL died mid-turn, to replay via the
   *  dev-channel `POST /message` after the resume. Absent if nothing was
   *  in-flight. */
  droppedInbound?: string
  /** Replay-redelivery routing (S3 #106). The user's reconnect channel
   *  (`web:<user_id>`) the recovered reply must reach. Persisted explicitly so the
   *  boot-drain (before the owning substrate re-registers) can route without
   *  reconstructing it. Absent on legacy rows / when no delivery handle threaded. */
  topic_id?: string
  /** Owning instance slug (advisory — redelivery logging / scoping). */
  instance_slug?: string
  /** The dropped turn's `<incarnation>:<seq>` (§3) — the idempotency key the
   *  redelivery sink dedupes a live-delivered + persisted race on. */
  turn_id?: string
}

/** Result of trying to parse the on-disk queue file. */
export type LoadResult =
  | { kind: 'absent' }
  | { kind: 'loaded'; entries: PendingRespawnEntry[] }
  | { kind: 'corrupt'; reason: string }

// ─── Pure (de)serialization ────────────────────────────────────────────────

/** Parse raw file contents into a queue. Pure — does no IO. A single malformed
 *  row is dropped rather than poisoning the whole queue. */
export function parsePendingRespawnsContents(contents: string): LoadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (e) {
    return { kind: 'corrupt', reason: `json-parse-error: ${(e as Error).message}` }
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'corrupt', reason: 'not-an-array' }
  }
  const entries: PendingRespawnEntry[] = []
  for (const raw of parsed) {
    if (!isMinimalEntry(raw)) continue
    entries.push(raw as PendingRespawnEntry)
  }
  return { kind: 'loaded', entries }
}

/** Serialize a queue to disk-ready JSON. Pretty-printed for grep-ability. */
export function serializePendingRespawns(entries: PendingRespawnEntry[]): string {
  return JSON.stringify(entries, null, 2)
}

/** Remove the entry with the given `sessionKey`, returning a new array. Used as
 *  each drain `setTimeout` fires so a mid-drain crash leaves only the
 *  still-pending entries on disk. */
export function removeEntryBySessionKey(
  entries: PendingRespawnEntry[],
  sessionKey: string,
): PendingRespawnEntry[] {
  return entries.filter((e) => e.sessionKey !== sessionKey)
}

/** Pure staggered drain plan: assign each entry an increasing delay so a batch
 *  of leftover respawns doesn't thundering-herd the host on boot. Mirrors
 *  Nova's `500 * (i + 1)` stagger; `baseDelayMs` defaults to 500. */
export function planZombieRespawns(
  entries: PendingRespawnEntry[],
  baseDelayMs = 500,
): Array<{ entry: PendingRespawnEntry; delayMs: number }> {
  return entries.map((entry, i) => ({ entry, delayMs: baseDelayMs * (i + 1) }))
}

// ─── Disk-touching wrappers ────────────────────────────────────────────────

/** Load the queue file. `{ kind: 'absent' }` when the file doesn't exist (the
 *  steady-state case). On corrupt/unreadable contents returns
 *  `{ kind: 'corrupt' }` so the caller can log + delete + continue. */
export function loadPendingRespawns(path: string): LoadResult {
  if (!existsSync(path)) return { kind: 'absent' }
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (e) {
    return { kind: 'corrupt', reason: `read-error: ${(e as Error).message}` }
  }
  return parsePendingRespawnsContents(contents)
}

/** Atomically write the queue. Empty array → delete the file (steady state). */
export function savePendingRespawns(path: string, entries: PendingRespawnEntry[]): void {
  if (entries.length === 0) {
    clearPendingRespawns(path)
    return
  }
  atomicWriteFileSync(path, serializePendingRespawns(entries))
}

/**
 * Upsert one deferred-respawn entry, keyed on `sessionKey` (load → replace-or-
 * append → save). Used by the enqueue-on-crash path: when a warm REPL dies
 * mid-turn the in-flight inbound is recorded here so it can be replayed once the
 * session resumes (in-process via the watchdog tick, or across a gateway restart
 * via the boot-drain). A corrupt/unreadable file is treated as empty so a single
 * poisoned row never blocks the recovery of a fresh crash. Disk-is-source-of-
 * truth: the write is atomic (`atomic-write.ts`).
 */
export function enqueuePendingRespawn(path: string, entry: PendingRespawnEntry): void {
  const loaded = loadPendingRespawns(path)
  const existing = loaded.kind === 'loaded' ? loaded.entries : []
  const next = removeEntryBySessionKey(existing, entry.sessionKey)
  next.push(entry)
  savePendingRespawns(path, next)
}

/** Delete the queue file. Idempotent — no error if already gone. */
export function clearPendingRespawns(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Best-effort. If the file resurrects, parse will flag corruption next boot.
  }
}

// ─── Internals ─────────────────────────────────────────────────────────────

function isMinimalEntry(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  return (
    typeof r.sessionKey === 'string' &&
    typeof r.sessionId === 'string' &&
    typeof r.cwd === 'string'
  )
}
