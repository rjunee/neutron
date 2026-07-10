// persistent-repl-substrate.ts → pending-respawn.ts
// The pending-respawns queue drain (D2 split).

import { classifyEntryResumable } from './disk-recovery.ts'
import { clearPendingRespawns, loadPendingRespawns, planZombieRespawns, removeEntryBySessionKey, savePendingRespawns } from './pending-respawns-queue.ts'
import { supervisedBySessionKey } from './pool-state.ts'
import type { PersistentReplSubstrateOptions } from './types.ts'
import { replayPendingInbound } from './pool.ts'

export interface DrainPendingRespawnsOptions {
  /** Stagger base (ms) between entry replays — `planZombieRespawns(entries,
   *  baseDelayMs)`. Default 500 (boot-drain anti-thundering-herd). The per-tick
   *  drain passes 0. Tests pass 0. */
  baseDelayMs?: number
  /** DI sleep (tests pass a no-op). Default `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Drain the pending-respawns queue, replaying each entry's dropped inbound after
 * its session resumes. Used at gateway boot (replay anything a prior crash left
 * queued) AND on every watchdog tick (replay an inbound dropped since the last
 * tick, once the crash-respawn has resumed the session). No-op when the queue is
 * unconfigured/absent. Single-shot per REPLAYED entry: the entry is removed from
 * disk BEFORE its replay so a replay that itself crashes can't infinite-loop the
 * recovery (Nova "single-shot per restart" semantic). A corrupt queue file is
 * dropped, never replayed.
 *
 * An entry whose owning substrate is NOT registered in `supervisedBySessionKey`
 * (e.g. a cross-restart boot-drain before that substrate's first turn) is SKIPPED
 * and RETAINED on disk — never replayed with another substrate's env/identity
 * (Codex P2). It is picked up by a later drain once its owner re-registers (its
 * first post-restart turn), or covered by respawn-is-always-resume on that turn.
 */
export async function drainPendingRespawns(
  options: PersistentReplSubstrateOptions,
  dopts: DrainPendingRespawnsOptions = {},
): Promise<Array<{ sessionKey: string; replayed: boolean; skipped?: string; resumable?: boolean }>> {
  const path = options.pendingRespawnsPath
  if (path === undefined) return []
  const loaded = loadPendingRespawns(path)
  if (loaded.kind === 'corrupt') {
    clearPendingRespawns(path)
    return []
  }
  if (loaded.kind === 'absent' || loaded.entries.length === 0) return []
  const sleep = dopts.sleep ?? ((ms: number) => Bun.sleep(ms))
  const plan = planZombieRespawns(loaded.entries, dopts.baseDelayMs ?? 500)
  const results: Array<{
    sessionKey: string
    replayed: boolean
    skipped?: string
    resumable?: boolean
  }> = []
  for (const { entry, delayMs } of plan) {
    // Resolve the OWNING substrate's options by the entry's pool key. Unregistered
    // → retain on disk (don't replay with the wrong env) and report the skip.
    const owner = supervisedBySessionKey.get(entry.sessionKey)
    if (owner === undefined) {
      // Disk-JSONL recovery classification (Vajra mechanism #20). The entry was
      // scheduled-but-lost across a restart; its owner hasn't re-registered yet.
      // "Disk JSONL is the source of truth" — read the transcript and classify
      // whether this is a RESUMABLE conversation (live JSONL) vs a true ghost.
      // Retain either way (a later drain replays once the owner registers), but
      // surface resumability so a recoverable topic is observably NOT dropped
      // (the 2026-05-21 pristine lesson).
      let resumable = false
      try {
        resumable = classifyEntryResumable(
          { sessionId: entry.sessionId, cwd: entry.cwd },
          Date.now(),
          {},
          options.projectsDir,
        ).resumable
      } catch {
        /* classification is best-effort; default not-resumable */
      }
      results.push({
        sessionKey: entry.sessionKey,
        replayed: false,
        skipped: 'unregistered',
        resumable,
      })
      continue
    }
    if (delayMs > 0) await sleep(delayMs)
    // Single-shot claim. Two drains can overlap (a staggered boot-drain still
    // sleeping while the watchdog tick fires), both planning from the same
    // initial snapshot. Re-read the queue and resolve THIS key's CURRENT entry:
    //   - absent  → a concurrent drain already replayed+removed it; skip, because
    //     replaying our stale snapshot copy would process the dropped inbound
    //     twice (round-6 Codex P2).
    //   - present → replay the CURRENT entry, NOT the planned snapshot. A same-key
    //     replacement (entry B carrying a NEWER dropped inbound) may have been
    //     upserted during the stagger sleep by a second crash on the same REPL;
    //     `enqueuePendingRespawn` removes the old A and pushes B under the one key.
    //     Replaying the snapshot A here would (a) replay A's now-superseded inbound
    //     and (b) `removeEntryBySessionKey` would delete B — silently losing B's
    //     newer inbound. Replaying the current entry instead means B survives, and
    //     the dropped-twice guard above still holds (Codex GPT-5 r4 BLOCKER).
    const current = loadPendingRespawns(path)
    const currentEntries = current.kind === 'loaded' ? current.entries : []
    const currentEntry = currentEntries.find((e) => e.sessionKey === entry.sessionKey)
    if (currentEntry === undefined) {
      results.push({ sessionKey: entry.sessionKey, replayed: false, skipped: 'already-drained' })
      continue
    }
    savePendingRespawns(path, removeEntryBySessionKey(currentEntries, entry.sessionKey))
    let replayed = false
    try {
      replayed = await replayPendingInbound(owner, currentEntry)
    } catch {
      replayed = false
    }
    results.push({ sessionKey: entry.sessionKey, replayed })
  }
  return results
}
