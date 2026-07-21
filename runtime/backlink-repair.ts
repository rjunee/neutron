/**
 * @neutronai/runtime — deterministic entity BACKLINK REPAIR, event-driven on the
 * entity-writer sync hook (Q2 overturn 2, split by tier — the CORE-MEMORY half of
 * dreaming's uncovered work).
 *
 * Spec of record: `docs/plans/executor-mode-reminders-2026-07-20.md` — the
 * DEEPENED header "Ryan's Q2, split by tier" (line ~131): "backlink repair → core
 * memory, deterministic, EVENT-DRIVEN on the sync hook (the entity writer already
 * emits `newLinks`/`removedLinks`)". This is a THIRD {@link SyncHook} wrapper layer
 * (outermost — after the GBrain hook and the memory-index wrap) so its repair
 * writes re-enter the FULL chain.
 *
 * WHAT IT REPAIRS (fully deterministic, NO LLM): a compiled-truth wikilink/mdlink
 * whose target has NO entity page, when a UNIQUE existing page differs only by
 * hyphen POSITION (`[[white-board]]` while `entities/concepts/whiteboard.md`
 * exists). `normaliseSlug` (`runtime/auto-link.ts`) already collapses casing /
 * underscore / whitespace at extraction time, so those fuzzy classes never reach
 * here as broken — the residual DETERMINISTIC class is hyphen-position variants,
 * resolved by strip-hyphen KEY equality with a UNIQUE existing match. Zero or
 * multiple candidates → orphan / ambiguous, LOGGED and NEVER mutated (Vajra
 * dreaming parity — the always-safe direction).
 *
 * REPAIR SYNERGY: a repaired rewrite drops the broken edge from compiled-truth →
 * the re-entrant write's `removedLinks` → `GBrainSyncHook` `remove_link` +
 * `purgeDeferred` (ISSUES #102) retract the broken edge and re-add the fixed one,
 * so the graph self-heals event-driven with no separate reconciliation pass.
 *
 * The wrapper mirrors {@link wrapSyncHookWithMemoryIndex} (`runtime/memory-index.ts`):
 * inner-hook-first, repair scheduled in a `finally` so a rejecting inner hook can
 * never suppress the repair, coalesced single-flight drain with an `idle()` test
 * seam. Every repair error is caught → `logFailure`, NEVER rejected out — a repair
 * must never disturb the entity-write path it hangs off.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  ENTITY_KINDS,
  KIND_TO_DIR,
  DIR_TO_KIND,
  type EntityKind,
  type TimelineEntry,
  extractCompiledTruth,
  parseFrontmatter,
} from './entity-format.ts'
import { SLUG_REGEX } from './entity-slug.ts'
import { normaliseSlug } from './auto-link.ts'
import { writeEntity as defaultWriteEntity, type SyncHook } from './entity-writer.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { createLogger } from '@neutronai/logger'

const log = createLogger('runtime')

/**
 * The entity-writer surface the repair needs — the RB3 superset with the atomic
 * CAS `precondition` + the `conflict` result + the multi-row `timelineAppend`.
 * The real `runtime/entity-writer.ts:writeEntity` satisfies it (an extra optional
 * field on the input is fine); tests inject a recorder. Kept local so this leaf
 * never grows a package edge into scribe (where the identical `ReflectWriteEntity`
 * lives).
 */
export type BacklinkWriteEntity = (
  input: {
    ownerDataDir: string
    kind: EntityKind
    slug: string
    body: {
      frontmatter: Record<string, unknown>
      compiledTruth: string
      timelineAppend: TimelineEntry | readonly TimelineEntry[]
    }
    originInstance: string
    receivingInstanceSlug: string
    precondition?: { ifBodyEquals: string | null }
  },
  deps?: { syncHook?: SyncHook },
) => Promise<{ path: string; changed: boolean; newLinks: unknown[]; conflict?: boolean }>

/**
 * A {@link SyncHook} that fans an entity-write onto an inner hook AND a
 * deterministic backlink-repair pass. `idle()` resolves when the coalesced repair
 * queue has fully drained (tests). `stats` is a live counter of repaired / orphaned
 * / ambiguous broken links (observability — an operator can see the repair working
 * and the always-safe holds it declined to touch). `stats.repaired` counts only
 * COMMITTED repairs (a conflicted/no-op write is not counted).
 */
export interface BacklinkRepairSyncHook extends SyncHook {
  idle(): Promise<void>
  readonly stats: { repaired: number; orphaned: number; ambiguous: number }
}

export interface BacklinkRepairOptions {
  /** The instance's Zone-B data dir (the writer/enumerator append `/entities`). */
  ownerDataDir: string
  /** Own instance slug — the own-origin stamp + provenance source for repair writes. */
  ownSlug: string
  /** Entity-writer seam. Defaults to the real `runtime/entity-writer.ts:writeEntity`. */
  writeEntity?: BacklinkWriteEntity
  /** Failure sink. Defaults to a structured warn. */
  logFailure?: (msg: string, err: unknown) => void
  /** Clock injection for determinism. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Parse `(kind, slug)` from an on-disk entity path
 * (`<ownerDataDir>/entities/<kind-dir>/<slug>.md`). Returns null on any
 * unrecognised shape — unlike `GBrainSyncHook.parseEntityPath`, repair NEVER
 * throws (a bad path is logged + skipped, never a crash of the write path).
 */
function parseEntityPath(absPath: string): { kind: EntityKind; slug: string } | null {
  const parts = absPath.split('/')
  if (parts.length < 3) return null
  const fname = parts[parts.length - 1] ?? ''
  const dir = parts[parts.length - 2] ?? ''
  if (!fname.endsWith('.md')) return null
  const slug = fname.slice(0, -3)
  const kind = DIR_TO_KIND[dir]
  if (kind === undefined) return null
  return { kind, slug }
}

/** Enumerate every existing entity slug (all six kinds) by FILENAME only — no
 *  content reads. A missing/unreadable per-kind dir is skipped. */
function enumerateExistingSlugs(ownerDataDir: string): Set<string> {
  const out = new Set<string>()
  for (const kind of ENTITY_KINDS) {
    const dir = join(ownerDataDir, 'entities', KIND_TO_DIR[kind])
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue // dir absent for this kind — nothing to enumerate
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const slug = name.slice(0, -3)
      if (SLUG_REGEX.test(slug)) out.add(slug)
    }
  }
  return out
}

/** Strip-hyphen key — the deterministic hyphen-position collapse. */
function stripKey(slug: string): string {
  return slug.replace(/-/g, '')
}

/**
 * Rewrite every wikilink / relative mdlink whose `normaliseSlug(target)` is a key
 * in `repairs`, to the repaired slug — preserving the human display text:
 *   - wikilink WITH alias   `[[white-board|the board]]` → `[[whiteboard|the board]]`
 *   - wikilink WITHOUT alias `[[white-board]]`          → `[[whiteboard|white-board]]`
 *   - relative mdlink        `[the board](white-board)` → `[the board](whiteboard)`
 * `normaliseSlug` is the SINGLE grammar (exported from `auto-link.ts`) — never
 * reimplemented here.
 */
function rewriteLinks(compiledTruth: string, repairs: ReadonlyMap<string, string>): string {
  let out = compiledTruth.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g,
    (full, rawTarget: string, alias: string | undefined): string => {
      const slug = normaliseSlug(rawTarget)
      if (slug === null) return full
      const fixed = repairs.get(slug)
      if (fixed === undefined) return full
      if (alias !== undefined) return `[[${fixed}|${alias}]]`
      const raw = rawTarget.trim()
      return raw !== fixed ? `[[${fixed}|${raw}]]` : `[[${fixed}]]`
    },
  )
  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (full, text: string, target: string): string => {
      if (/^[a-z]+:/i.test(target)) return full
      if (target.startsWith('#') || target.startsWith('/') || target.includes('..')) return full
      const slug = normaliseSlug(target)
      if (slug === null) return full
      const fixed = repairs.get(slug)
      if (fixed === undefined) return full
      return `[${text}](${fixed})`
    },
  )
  return out
}

export function wrapSyncHookWithBacklinkRepair(
  inner: SyncHook | undefined,
  opts: BacklinkRepairOptions,
): BacklinkRepairSyncHook {
  const { ownerDataDir, ownSlug } = opts
  const writeEntity: BacklinkWriteEntity =
    opts.writeEntity ?? (defaultWriteEntity as unknown as BacklinkWriteEntity)
  const now = opts.now ?? ((): number => Date.now())
  const logFailure =
    opts.logFailure ??
    ((msg: string, err: unknown): void => {
      log.warn(msg, { error: err instanceof Error ? err.message : String(err) })
    })

  const stats = { repaired: 0, orphaned: 0, ambiguous: 0 }
  // Coalesced single-flight drain (mirrors the memory-index regenerator): a burst
  // of writes queues distinct repair jobs; one drain processes them one-at-a-time
  // so repair writes never interleave, and `idle()` awaits the whole queue.
  const queue: Array<{ path: string; body: string; newLinks: readonly { object: string }[] }> = []
  let draining = false
  const waiters: Array<() => void> = []
  // Re-entrancy guard: the path of a repair currently being committed. Defence in
  // depth beside the STRUCTURAL termination (a repaired link resolves on re-entry,
  // so the re-entrant pass finds nothing to repair).
  const inFlight = new Set<string>()

  // `self` is passed as the repair write's syncHook so the corrected write
  // re-enters the FULL chain (GBrain retracts the broken edge + re-adds the fixed
  // one). Bound after construction below.
  let self: BacklinkRepairSyncHook

  async function repairOne(
    job: {
      path: string
      body: string
      newLinks: readonly { object: string }[]
    },
    existing: Set<string>,
  ): Promise<void> {
    if (job.newLinks.length === 0) return
    if (inFlight.has(job.path)) return
    const parsed = parseEntityPath(job.path)
    if (parsed === null) {
      logFailure(`backlink-repair: unrecognised entity path ${job.path}`, undefined)
      return
    }
    // Detect broken links + resolve unique hyphen-position candidates.
    const repairs = new Map<string, string>() // broken → fixed
    const seenBroken = new Set<string>()
    for (const triple of job.newLinks) {
      const broken = triple.object
      if (typeof broken !== 'string' || broken.length === 0) continue
      if (existing.has(broken)) continue // link resolves — not broken
      if (seenBroken.has(broken)) continue
      seenBroken.add(broken)
      const key = stripKey(broken)
      const candidates: string[] = []
      for (const slug of existing) {
        if (stripKey(slug) === key) candidates.push(slug)
      }
      if (candidates.length === 1) {
        repairs.set(broken, candidates[0]!)
      } else if (candidates.length === 0) {
        stats.orphaned += 1
        logFailure(`backlink orphan: no entity page for [[${broken}]] (source ${job.path})`, undefined)
      } else {
        stats.ambiguous += 1
        logFailure(
          `backlink ambiguous: [[${broken}]] matches ${candidates.length} pages (${candidates.join(', ')}) — left untouched`,
          undefined,
        )
      }
    }
    if (repairs.size === 0) return

    const rewritten = rewriteLinks(extractCompiledTruth(job.body), repairs)
    const summary = [...repairs.entries()].map(([b, f]) => `${b} → ${f}`).join(', ')

    inFlight.add(job.path)
    try {
      const out = await writeEntity(
        {
          ownerDataDir,
          kind: parsed.kind,
          slug: parsed.slug,
          body: {
            frontmatter: parseFrontmatter(job.body),
            compiledTruth: rewritten,
            timelineAppend: {
              ts: new Date(now()).toISOString(),
              source: `backlink-repair:${ownSlug}`,
              body: `Repaired broken link(s): ${summary}`,
            },
          },
          originInstance: ownSlug,
          receivingInstanceSlug: ownSlug,
          // CAS: commit only if the on-disk body is still the exact event body a
          // later write superseded meanwhile flips this to a no-op conflict and a
          // subsequent write re-triggers the repair.
          precondition: { ifBodyEquals: job.body },
        },
        { syncHook: self }, // re-enter the FULL chain
      )
      if (out.conflict === true) {
        logFailure(`backlink-repair: CAS conflict for ${job.path} — skipped (a later write re-triggers)`, undefined)
        return
      }
      if (out.changed === true) stats.repaired += repairs.size
    } catch (err) {
      logFailure(`backlink-repair: write failed for ${job.path}`, err)
    } finally {
      inFlight.delete(job.path)
    }
  }

  async function drain(): Promise<void> {
    draining = true
    try {
      // Enumerate the existing-slug corpus ONCE per drain cycle (Argus r1 minor):
      // a write burst of N jobs was doing N full readdir scans across all six kind
      // dirs (O(jobs × corpus)). Repair only REWRITES links inside pages that
      // already exist — it never creates a new page — so the slug set is stable
      // across a single drain, and re-scanning per job was pure waste. A page
      // created by a concurrent non-repair write shows up on the NEXT drain (that
      // write schedules its own job), so eventual consistency is preserved.
      const existing = enumerateExistingSlugs(ownerDataDir)
      while (queue.length > 0) {
        const job = queue.shift()!
        try {
          await repairOne(job, existing)
        } catch (err) {
          logFailure('backlink-repair: repair pass threw', err)
        }
      }
    } finally {
      draining = false
      const pending = waiters.splice(0)
      for (const w of pending) w()
    }
  }

  function schedule(payload: {
    path: string
    body: string
    newLinks: readonly { object: string }[]
  }): void {
    // Skip enqueuing work that can never repair (no links) — keeps `idle()` cheap.
    if (payload.newLinks.length === 0) return
    queue.push({ path: payload.path, body: payload.body, newLinks: payload.newLinks })
    if (!draining) fireAndForget('backlink-repair.drain', drain())
  }

  self = {
    async onEntityWrite(payload): Promise<void> {
      // Schedule the repair REGARDLESS of the inner hook's outcome (in `finally`),
      // so a rejecting inner hook can't suppress it. The inner hook's own error
      // contract is preserved — its rejection still propagates (the writer logs +
      // swallows it).
      try {
        if (inner !== undefined) await inner.onEntityWrite(payload)
      } finally {
        schedule(payload)
      }
    },
    idle(): Promise<void> {
      if (!draining && queue.length === 0) return Promise.resolve()
      return new Promise<void>((res) => waiters.push(res))
    },
    stats,
  }
  return self
}
