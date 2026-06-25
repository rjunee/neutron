/**
 * session-disk-recovery.ts — find the latest resumable session on disk for a cwd.
 *
 * § Terminal-detection port, master-table row #7 (docs/research/vajra-terminal-
 * detection-keystroke-port-2026-06-25.md). The Neutron analog of Vajra's
 * `findLatestSessionForTopic` (`index.ts:1865`): given a project cwd, scan the
 * Claude Code transcript directory (`<projectsDir>/<cwd-dashed>/`) and return the
 * UUID of the most-recently-active session whose JSONL still exists with real
 * content on disk.
 *
 * This is the DISK-RECOVERY half of the resume-session-failure safety net
 * (`resume-picker-detector.ts`): when `--resume <stale-id>` drops to CC's
 * interactive "Resume Session" picker, we ESCAPE out (never blind-answer) and
 * then call here to recover the user's most recent real session instead of
 * silently spawning a fresh, empty-context one.
 *
 * INVARIANT — JSONL/disk is the source of truth (cross-cutting invariant §5).
 * A session id is only a recovery candidate when its transcript exists with ≥1
 * non-empty line, mirroring `validateAndPersistSessionId`'s ghost-session guard
 * (Nova 2026-04-13: a ghost UUID with no JSONL traps `--resume` in an infinite
 * fail loop). Selection is by file mtime (most-recently-touched transcript = the
 * session the user was last in).
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { dashifyCwd } from './session-validation.ts'

/** A resumable transcript found on disk. */
export interface DiskSessionCandidate {
  /** The session UUID (the `<sessionId>.jsonl` basename, sans extension). */
  sessionId: string
  /** Last-modified time of the transcript (ms epoch) — the recency key. */
  mtimeMs: number
}

/** Options for {@link findLatestResumableSession}. */
export interface FindLatestSessionOpts {
  /** A session id to EXCLUDE from the candidates — typically the stale id that
   *  just failed to resume (and dropped us into the picker), so the recovery
   *  never "recovers" the very session that just failed. */
  excludeSessionId?: string
}

/**
 * The most-recently-active resumable session for `cwd`, or `null` when none
 * exists. Scans `<projectsDir>/<cwd-dashed>/*.jsonl`, keeps only transcripts that
 * are real files with ≥1 non-empty line (the JSONL-is-truth ghost guard), and
 * returns the UUID of the one with the newest mtime.
 *
 * Pure-ish: only reads the filesystem, never writes / mutates. Every fs error is
 * swallowed to `null` / skip — a recovery scan must never throw into the PTY
 * `onData` hot path it is dispatched from.
 */
export function findLatestResumableSession(
  cwd: string,
  projectsDir: string = join(homedir(), '.claude', 'projects'),
  opts: FindLatestSessionOpts = {},
): string | null {
  const dir = join(projectsDir, dashifyCwd(cwd))
  if (!existsSync(dir)) return null

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }

  let best: DiskSessionCandidate | null = null
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const sessionId = name.slice(0, -'.jsonl'.length)
    if (!sessionId) continue
    if (opts.excludeSessionId !== undefined && sessionId === opts.excludeSessionId) continue

    const full = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (!st.isFile() || st.size === 0) continue
    // JSONL-is-truth (invariant §5): require ≥1 non-empty line, mirroring
    // validateAndPersistSessionId — an empty/whitespace transcript is a ghost.
    try {
      if (readFileSync(full, 'utf8').trim().length === 0) continue
    } catch {
      continue
    }

    if (best === null || st.mtimeMs > best.mtimeMs) {
      best = { sessionId, mtimeMs: st.mtimeMs }
    }
  }
  return best?.sessionId ?? null
}
