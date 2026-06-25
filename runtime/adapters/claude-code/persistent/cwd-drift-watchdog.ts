/**
 * cwd-drift-watchdog.ts — detect a PTY child whose LIVE working directory has
 * DRIFTED off the session's canonical cwd and respawn it pinned back (Vajra port
 * row #12, NON-substrate watchdog).
 *
 * LIFTED from Nova `gateway/cwd-drift-watchdog.ts`. This is a WATCHDOG over the
 * child PID — NOT an output-scan / ring detector. It never touches the
 * persistent-repl-substrate register-block; it adds a NEW respawn trigger keyed
 * on a cwd mismatch.
 *
 * THE PROBLEM. A PTY child's live cwd can drift from the session's canonical cwd
 * — e.g. a Bash `cd` into a worktree that later gets merged/removed leaves the
 * child pinned to a dead directory, while the session's canonical project dir is
 * still perfectly valid. The wedge watchdog (`wedge-detector.ts`) keys off
 * liveness + `/health` and is blind to this: the child is alive and answering,
 * just rooted in the wrong place. Inbound turns then run from a stale/dead dir.
 *
 * THE LESSON (2026-04-23, must not be lost):
 *  - A Bash `cd` into a since-merged worktree stuck the session; the re-init
 *    keyed the WRONG project dir. The fix is to respawn pinned to the canonical
 *    `record.cwd` (the existing respawn already spawns from `record.cwd`, so the
 *    pin is automatic once we trigger it).
 *  - A SYNC `lsof` ×20 stalled the event loop for ≤40s. So this watchdog asks the
 *    OS the live cwd via ASYNC, BATCHED `lsof` (cap ~5 concurrent) — NEVER a sync
 *    lsof loop on the hot path (cross-cutting invariant #9 — bounded, off the hot
 *    path; #5 — ask the OS directly, don't trust cached cwd state).
 *  - EXISTENCE-GUARD the canonical dir: if the canonical cwd itself is MISSING on
 *    disk, NEVER respawn (you'd just respawn into nothing) — alert instead.
 *  - Per-session 1h respawn throttle so a persistently-drifting child can't churn.
 *
 * The pure cores (`normalizeCwd` / `isCwdDrifted` / `decideCwdDriftAction`) +
 * the lsof probe + the bounded batcher live here and are fully unit-testable. The
 * substrate wires `runCwdDriftTick` to the live pool/registry/respawn in
 * `persistent-repl-substrate.ts`.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Per-session throttle: a second drift within this window does NOT re-respawn. */
export const DEFAULT_CWD_DRIFT_THROTTLE_MS = 60 * 60 * 1000
/** Max concurrent `lsof` probes (cap ~5) — the async/batched replacement for the
 *  sync `lsof×20` that stalled the loop ≤40s. */
export const DEFAULT_LSOF_CONCURRENCY = 5
/** Per-probe `lsof` timeout — a hung lsof must not pin a worker slot forever. */
export const DEFAULT_LSOF_TIMEOUT_MS = 5_000

// ─── Pure cwd comparison ─────────────────────────────────────────────────────

/**
 * Normalize a cwd for comparison: trim, drop a trailing " (deleted)" marker
 * (lsof appends it for an unlinked dir — the merged-worktree case), and collapse
 * trailing slashes while preserving root `/`. A non-string / empty input
 * normalizes to `''` (treated as "unknown" by the comparators). Pure.
 */
export function normalizeCwd(p: string | null | undefined): string {
  if (typeof p !== 'string') return ''
  let s = p.trim()
  if (s.length === 0) return ''
  s = s.replace(/ \(deleted\)$/, '')
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/**
 * Whether `liveCwd` has drifted off `canonicalCwd`. Trailing-slash normalized
 * with DESCENDANT TOLERANCE: the live cwd being canonical itself OR a descendant
 * of canonical (a `cd` into a project subdirectory) is NOT drift. Only a cwd
 * OUTSIDE the canonical subtree counts. An unknown (`''`) live or canonical cwd
 * is never drift — we don't act on a cwd we couldn't resolve. Pure.
 */
export function isCwdDrifted(liveCwd: string, canonicalCwd: string): boolean {
  const live = normalizeCwd(liveCwd)
  const canon = normalizeCwd(canonicalCwd)
  if (live === '' || canon === '') return false
  if (live === canon) return false
  // Descendant tolerance — `<canon>/sub` is fine; root `/` makes every path a
  // descendant, so a root canonical can never drift.
  const prefix = canon === '/' ? '/' : `${canon}/`
  if (live.startsWith(prefix)) return false
  return true
}

// ─── Pure decision ───────────────────────────────────────────────────────────

export type CwdDriftAction =
  | { kind: 'ignore'; reason: 'no-live-cwd' | 'not-drifted' }
  /** Drift detected BUT the canonical dir is gone — NEVER respawn, alert only. */
  | { kind: 'alert-missing-canonical'; live: string; canonical: string }
  /** Drift detected, canonical valid, but within the 1h throttle — skip. */
  | { kind: 'throttled'; live: string; canonical: string }
  /** Drift detected, canonical valid, throttle clear — respawn pinned to canonical. */
  | { kind: 'respawn'; live: string; canonical: string }

export interface CwdDriftActionContext {
  /** The child's live cwd from lsof. `null` (probe failed / process gone) → no act. */
  liveCwd: string | null
  /** The session's canonical cwd (`record.cwd`). */
  canonicalCwd: string
  /** Whether the canonical dir exists on disk (existence guard). */
  canonicalExists: boolean
  /** Last cwd-drift respawn time for this session — the throttle anchor. */
  lastDriftRespawnAt: number | undefined
  now: number
  /** Override the 1h throttle (tests). */
  throttleMs?: number
}

/**
 * Decide what to do about a session's cwd. Pure, total function. Gate order:
 *   1. no live cwd (probe failed) → ignore (`no-live-cwd`) — never act on unknown.
 *   2. not drifted (== canonical or a descendant) → ignore (`not-drifted`).
 *   3. drifted BUT canonical missing on disk → `alert-missing-canonical` (NEVER
 *      respawn — you'd respawn into nothing; the 2026-04-23 existence guard).
 *   4. drifted, canonical valid, within the 1h throttle → `throttled`.
 *   5. otherwise → `respawn` (pinned to canonical).
 */
export function decideCwdDriftAction(ctx: CwdDriftActionContext): CwdDriftAction {
  const live = normalizeCwd(ctx.liveCwd)
  if (ctx.liveCwd === null || live === '') {
    return { kind: 'ignore', reason: 'no-live-cwd' }
  }
  const canonical = normalizeCwd(ctx.canonicalCwd)
  if (!isCwdDrifted(live, canonical)) {
    return { kind: 'ignore', reason: 'not-drifted' }
  }
  // Drift confirmed. Existence-guard the CANONICAL dir BEFORE any respawn: a
  // respawn spawns from `record.cwd`, so a missing canonical would just respawn
  // into nothing. Alert instead, never respawn.
  if (!ctx.canonicalExists) {
    return { kind: 'alert-missing-canonical', live, canonical }
  }
  const throttleMs = ctx.throttleMs ?? DEFAULT_CWD_DRIFT_THROTTLE_MS
  if (ctx.lastDriftRespawnAt !== undefined && ctx.now - ctx.lastDriftRespawnAt < throttleMs) {
    return { kind: 'throttled', live, canonical }
  }
  return { kind: 'respawn', live, canonical }
}

/** Operator alert for the missing-canonical case (drift, but cannot fix). */
export function buildCwdDriftMissingCanonicalAlert(args: {
  sessionKey: string
  live: string
  canonical: string
}): string {
  return (
    `\u{26A0}\u{FE0F} REPL \`${args.sessionKey}\` cwd drifted to \`${args.live}\`, but its ` +
    `canonical dir \`${args.canonical}\` is MISSING on disk — refusing to respawn ` +
    `(would respawn into nothing). Recreate the directory or re-point the session.`
  )
}

// ─── lsof probe + bounded batcher ────────────────────────────────────────────

/** Ask the OS for a pid's live cwd; `null` when it cannot be resolved. */
export type CwdProbe = (pid: number) => Promise<string | null>

/**
 * Default live-cwd probe: ASYNC `lsof -a -p <pid> -d cwd -Fn`. `-Fn` field
 * output emits the cwd path as the first `n`-prefixed line; `-d cwd` restricts to
 * the cwd descriptor. lsof exits non-zero when the process is gone / has no
 * matching fd — we parse stdout regardless and return `null` when no path line is
 * present (so a dead pid reads as "unknown", never a false drift). Bounded by a
 * per-probe timeout. NEVER call this synchronously in a loop (the sync lsof×20
 * that stalled the loop ≤40s — use {@link runCwdDriftTick}'s batcher).
 */
export function defaultProbeCwd(
  pid: number,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { timeout: opts.timeoutMs ?? DEFAULT_LSOF_TIMEOUT_MS },
      (_err, stdout) => {
        const line = (stdout ?? '')
          .split('\n')
          .find((l) => l.startsWith('n') && l.length > 1)
        resolve(line ? line.slice(1) : null)
      },
    )
  })
}

/**
 * Map `items` through async `fn` with at most `limit` in flight at once — the
 * bounded, batched replacement for a fan-out of blocking spawns. Preserves input
 * order in the result. `limit` is clamped to `[1, items.length]`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results
  let next = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      results[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

// ─── Injectable tick ─────────────────────────────────────────────────────────

/** One supervised session to check this tick. */
export interface CwdDriftSupervisedEntry {
  sessionKey: string
  /** LIVE child pid to ask the OS about (`lsof -p <pid>`). */
  pid: number
  /** Canonical cwd the session should be pinned to (`record.cwd`). */
  canonicalCwd: string
}

export interface CwdDriftTickDeps {
  /** Supervised entries (only LIVE, pid-resolvable children). */
  entries: readonly CwdDriftSupervisedEntry[]
  /** Ask the OS for a child's live cwd. Default async lsof ({@link defaultProbeCwd}). */
  probeCwd?: CwdProbe
  /** Whether the canonical dir exists on disk. Default `existsSync`. */
  canonicalExists?: (cwd: string) => boolean
  /** Read the last cwd-drift respawn time for a session (throttle). */
  lastDriftRespawnAt: (sessionKey: string) => number | undefined
  /** Record a cwd-drift respawn time — stamped when a respawn FIRES (throttle). */
  markDriftRespawn: (sessionKey: string, at: number) => void
  /** Actuate the cwd-pinned respawn. Returns true if it fired. */
  respawn: (entry: CwdDriftSupervisedEntry) => boolean | Promise<boolean>
  /** Operator alert sink (missing-canonical case). */
  postAlert?: (text: string) => void
  now?: () => number
  throttleMs?: number
  /** Max concurrent lsof probes (cap ~5). */
  concurrency?: number
}

export interface CwdDriftTickResult {
  sessionKey: string
  /** The action kind, or — for an `ignore` — its reason (`no-live-cwd` /
   *  `not-drifted`), so the live wiring is observable in tests + logs. */
  action: Exclude<CwdDriftAction['kind'], 'ignore'> | 'no-live-cwd' | 'not-drifted'
  respawned: boolean
}

/**
 * Run ONE cwd-drift watchdog tick. ASYNC + BATCHED: every supervised child's
 * live cwd is probed via the bounded (`concurrency`, default 5) lsof batcher —
 * NEVER a sync lsof loop. Then each is run through the pure `decideCwdDriftAction`
 * and actuated:
 *   - `respawn` → stamp the throttle BEFORE the respawn await (fire-once per
 *     detection so a slow/failed respawn can't double-fire next tick within the
 *     window), then call `respawn(entry)`.
 *   - `alert-missing-canonical` → `postAlert` only, NEVER respawn.
 *   - everything else → no side effect.
 * Pure + injectable so the four spec scenarios test hermetically.
 */
export async function runCwdDriftTick(deps: CwdDriftTickDeps): Promise<CwdDriftTickResult[]> {
  const now = (deps.now ?? Date.now)()
  const probeCwd = deps.probeCwd ?? ((pid: number) => defaultProbeCwd(pid))
  const canonicalExists = deps.canonicalExists ?? ((cwd: string) => existsSync(cwd))
  const concurrency = deps.concurrency ?? DEFAULT_LSOF_CONCURRENCY

  // ASYNC + BATCHED lsof (cap ~5) — the replacement for the sync lsof×20 that
  // stalled the loop ≤40s (2026-04-23). A throwing/hung probe degrades to `null`
  // (unknown → no action), never aborting the tick.
  const liveCwds = await mapWithConcurrency(deps.entries, concurrency, async (entry) => {
    try {
      return await probeCwd(entry.pid)
    } catch {
      return null
    }
  })

  const results: CwdDriftTickResult[] = []
  for (let i = 0; i < deps.entries.length; i += 1) {
    const entry = deps.entries[i] as CwdDriftSupervisedEntry
    const action = decideCwdDriftAction({
      liveCwd: liveCwds[i] ?? null,
      canonicalCwd: entry.canonicalCwd,
      canonicalExists: canonicalExists(entry.canonicalCwd),
      lastDriftRespawnAt: deps.lastDriftRespawnAt(entry.sessionKey),
      now,
      ...(deps.throttleMs !== undefined ? { throttleMs: deps.throttleMs } : {}),
    })

    let respawned = false
    if (action.kind === 'alert-missing-canonical') {
      deps.postAlert?.(
        buildCwdDriftMissingCanonicalAlert({
          sessionKey: entry.sessionKey,
          live: action.live,
          canonical: action.canonical,
        }),
      )
    } else if (action.kind === 'respawn') {
      // Stamp the throttle BEFORE the await — a respawn is a mutating action that
      // must be fire-once per detection (cross-cutting invariant #4 analog). A
      // failed respawn intentionally still holds the 1h window so a persistently
      // drifting child can't churn the respawn path every tick.
      deps.markDriftRespawn(entry.sessionKey, now)
      try {
        respawned = await deps.respawn(entry)
      } catch {
        respawned = false
      }
    }
    // Surface the ignore *reason* (no-live-cwd / not-drifted) so the wiring is
    // observable, not just "ignore" (mirrors the wedge tick's label).
    const label = action.kind === 'ignore' ? action.reason : action.kind
    results.push({ sessionKey: entry.sessionKey, action: label, respawned })
  }
  return results
}
