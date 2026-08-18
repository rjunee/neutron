/**
 * @neutronai/trident — reading a codex seat's usage off disk.
 *
 * The only free exhaustion signal Neutron has. There is no usage-gauge endpoint
 * that can be polled without spending quota, so instead of probing, this reads
 * what the CLI already wrote down: every `codex` session appends a rollout JSONL
 * under `<CODEX_HOME>/sessions/YYYY/MM/DD/`, and its `token_count` events carry a
 * `rate_limits` block with each window's `used_percent`, `window_minutes` and
 * `resets_at`. Harvesting after a run therefore costs nothing and needs no
 * daemon, no timer and no extra API call.
 *
 * THAT THE ROLLOUT FOLLOWS `CODEX_HOME` IS MEASURED, NOT ASSUMED. Pointing
 * `CODEX_HOME` at an empty directory and invoking `codex exec` produced a
 * complete state root under THAT directory — `sessions/` included, with the
 * rollout inside it — on codex-cli 0.147.0. The run was not even authenticated,
 * which makes the result stronger: the session file is written regardless of
 * whether the call to the model succeeded. Had rollouts instead landed in the
 * host's own `~/.codex`, this whole signal would have been dead and the design
 * would have needed the wrappers to capture `--json` stdout instead.
 *
 * Everything here is bounded and failure-tolerant on purpose: an unreadable or
 * missing rollout returns a tagged non-answer, and the policy layer is written so
 * a non-answer can never cool a seat.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

import { parseRolloutRateLimits, type HarvestOutcome } from './codex-rotation.ts'

/**
 * Cap on how much of a rollout is read. Sessions can grow to megabytes and the
 * snapshot needed is in the LAST `rate_limits` line, so reading the whole file
 * to find it would make a cheap check scale with transcript length. The tail is
 * where the answer is.
 */
export const MAX_ROLLOUT_TAIL_BYTES = 512 * 1024

/** How many candidate rollout files to consider, newest first. */
const MAX_CANDIDATES = 8

/**
 * Hard ceiling on how many rollout files the walk will collect.
 *
 * The CLI never prunes `sessions/`, so this directory only grows; a corpus of a
 * few thousand files was enough to make the walk take hundreds of milliseconds
 * synchronously. Only the newest handful can ever be selected (`MAX_CANDIDATES`),
 * so collecting more than a small multiple of that is pure waste.
 */
const MAX_SCAN_FILES = 64

/**
 * The newest rollout file under a CODEX_HOME, or null when there is none.
 *
 * The date-partitioned layout (`sessions/2026/08/17/rollout-*.jsonl`) is walked
 * rather than assumed, because sorting names lexicographically would break the
 * moment a partition scheme changed; modification time is what "newest" actually
 * means here.
 */
export function findNewestRollout(codexHome: string, minMtimeMs = 0): string | null {
  return listRollouts(codexHome, minMtimeMs)[0]?.path ?? null
}

/**
 * Every rollout under a CODEX_HOME, newest first.
 *
 * The date-partitioned layout (`sessions/2026/08/17/rollout-*.jsonl`) is walked
 * rather than assumed, because sorting names lexicographically would break the
 * moment the partition scheme changed; modification time is what "newest"
 * actually means here.
 */
function listRollouts(codexHome: string, minMtimeMs = 0): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 5 || out.length >= MAX_SCAN_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // NEWEST PARTITION FIRST, and stop once enough candidates are in hand. The
    // layout is `sessions/YYYY/MM/DD/`, whose components are zero-padded and so
    // sort lexicographically in date order; descending therefore visits the most
    // recent day first. Without this the walk was an unbounded synchronous scan
    // of every session the CLI has ever written — it never prunes them — sitting
    // on the path that resolves a run's credential, which a read-only HTTP
    // handler also reaches. Bounding it keeps the cost proportional to RECENT
    // activity instead of to lifetime history.
    const sorted = [...entries].sort((a, b) => b.name.localeCompare(a.name))
    for (const entry of sorted) {
      if (out.length >= MAX_SCAN_FILES) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const mtime = statSync(full).mtimeMs
          // A rollout older than the seat's connect stamp belongs to whatever
          // account previously occupied this directory. See `harvestNewestRollout`.
          if (mtime < minMtimeMs) continue
          out.push({ path: full, mtime })
        } catch {
          // A file that vanished between readdir and stat is not an error worth
          // failing the harvest over — the CLI rotates these while we look.
        }
      }
    }
  }
  walk(join(codexHome, 'sessions'), 0)
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/**
 * Read the newest rollout under `codexHome` and return its last usage snapshot.
 *
 * The three outcomes are deliberately distinct. `absent` means the seat has no
 * readable usage history yet (a freshly connected account has run nothing);
 * `error` means the read itself failed; only `snapshot` carries evidence. The
 * caller must not conflate them, because two of the three say nothing about
 * quota and cooling a seat on them would retire a working account.
 */
export function harvestNewestRollout(codexHome: string, now: number, minMtimeMs = 0): HarvestOutcome {
  let newest: string | null
  try {
    newest = findNewestRollout(codexHome, minMtimeMs)
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) }
  }
  if (newest === null) return { kind: 'absent' }

  let text: string
  try {
    text = readRollingTail(newest, MAX_ROLLOUT_TAIL_BYTES)
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) }
  }
  // Several candidates are tried because the newest file can legitimately be a
  // session that never reached a `token_count` event (an immediate failure, a
  // cancelled run). Falling back to the next-newest recovers a usable reading
  // instead of reporting `absent` while the answer sat one file away.
  const first = parseRolloutRateLimits(text, now)
  if (first.kind === 'snapshot') return first
  return harvestFromCandidates(codexHome, now, newest, minMtimeMs)
}

/** Try progressively older rollouts when the newest carries no usage event. */
function harvestFromCandidates(
  codexHome: string,
  now: number,
  skip: string,
  minMtimeMs: number,
): HarvestOutcome {
  let candidates: { path: string; mtime: number }[]
  try {
    candidates = listRollouts(codexHome, minMtimeMs)
  } catch {
    return { kind: 'absent' }
  }
  let considered = 0
  for (const c of candidates) {
    if (c.path === skip) continue
    if (considered >= MAX_CANDIDATES) break
    considered++
    try {
      const outcome = parseRolloutRateLimits(readRollingTail(c.path, MAX_ROLLOUT_TAIL_BYTES), now)
      if (outcome.kind === 'snapshot') return outcome
    } catch {
      continue
    }
  }
  return { kind: 'absent' }
}

/**
 * Read at most `maxBytes` from the END of a file, then drop the first (probably
 * truncated) line. Dropping it matters: a half-line would fail to parse and,
 * were it the only line carrying `rate_limits`, would turn a readable file into
 * a silent `absent`.
 */
function readRollingTail(path: string, maxBytes: number): string {
  const size = statSync(path).size
  if (size <= maxBytes) return readFileSync(path, 'utf8')
  // A POSITIONED read, not a whole-file read that is sliced afterwards. Slicing
  // after `readFileSync` would allocate and copy the ENTIRE rollout — defeating
  // the cap this function exists to enforce, and doing it on the synchronous
  // path that resolves a run's credential, where a multi-hundred-megabyte
  // transcript would be loaded in full to reach its last few kilobytes.
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(maxBytes)
    const read = readSync(fd, buf, 0, maxBytes, size - maxBytes)
    const tail = buf.subarray(0, read).toString('utf8')
    // The first line is almost certainly cut mid-record; dropping it matters,
    // because a half-line fails to parse and — were it the only line carrying
    // `rate_limits` — would turn a readable file into a silent `absent`.
    const nl = tail.indexOf('\n')
    return nl >= 0 ? tail.slice(nl + 1) : tail
  } finally {
    closeSync(fd)
  }
}
