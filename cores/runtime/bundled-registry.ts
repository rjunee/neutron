/**
 * @neutronai/cores-runtime — bundled-free Core registry.
 *
 * First-party / bundled-free Cores live in the Neutron monorepo at
 * `<rootDir>/cores/<name>/` (workspace packages). At gateway boot, this
 * module walks each root's `cores/` dir, validates each manifest via the
 * loader, and returns a deterministic `Map<slug, BundledCore>` the runtime
 * composer iterates to drive auto-install for new instances.
 *
 * Multi-root (2-tier Cores layout) — `rootDir` accepts either a single
 * string (legacy, equivalent to a one-element array) or an array of repo
 * roots. Duplicate slugs are handled by their kind:
 *
 *   - CROSS-root duplicate (different roots declare the same slug): a
 *     precedence resolution. Earlier roots win by ARRAY ORDER; the loser
 *     is dropped + a `cores.duplicate_slug_resolved` event is routed to
 *     the optional `telemetry` sink.
 *   - SAME-root duplicate (one root declares the same normalized slug
 *     twice): a packaging misconfiguration — throws
 *     `CoreInstallError('duplicate_install')`. This preserves the
 *     pre-multi-root invariant: two Cores in the same repo root must
 *     never collide on slug.
 *
 * This is the substrate that makes the 2-tier layout work — Open boots
 * from `[<publicRoot>]` and Managed boots from `[<publicRoot>,
 * <managedPrivateRoot>]` so Tier 1 free + Tier 2 paid Cores merge into
 * one runtime view. Until the physical Sprint C repo split lands, both
 * Open and Managed pass a single-element array `[<repoRoot>]` — the
 * array shape is the forward-compatible API even though only one root
 * is wired today. See
 * `docs/research/neutron-cores-marketplace-split-2026-05-17.md § 3`
 * for the locked design.
 *
 * The shape mirrors third-party Cores byte-for-byte — every bundled
 * Core ships the same `package.json`-with-`"neutron"`-block contract,
 * just authored inside the monorepo. Forward-compat with the
 * marketplace fetch flow (P3+) lands by adding a parallel registry that
 * resolves third-party Cores to a downloaded directory; the loader,
 * lifecycle, and capability-guard surfaces are all directory-shape
 * agnostic.
 *
 * Failure mode: a bundled Core whose manifest fails validation is a
 * BLOCKING boot error. Bundled Cores must always validate clean — if
 * they don't, the gateway must NOT start, because every instance boot
 * downstream assumes the registry is well-formed. (The runtime
 * currently itself does not auto-install bundled Cores; subsequent
 * sprints wire that. v1 just exposes the registry.)
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  CoreInstallError,
} from './errors.ts'
import {
  findCoreDirs,
  loadCoreFromDir,
  readCorePackage,
  type LoadedCore,
} from './loader.ts'

export interface BundledCore extends LoadedCore {
  /** Stable: 'bundled'. Reserved for the marketplace registry, which
   *  will use 'marketplace'. */
  source: 'bundled'
  /** Repo root the Core was discovered under. With multi-root layouts
   *  this is how the composer + telemetry tell apart a Tier 1 free
   *  Core (loaded from the public root) from a Tier 2 paid Core
   *  (loaded from the managed-private root). */
  rootDir: string
}

export interface BundledRegistry {
  list(): BundledCore[]
  get(slug: string): BundledCore | null
}

/**
 * Emitted when two DIFFERENT roots both declare a Core with the same
 * slug. The earlier (lower-index) root wins; the later root's Core is
 * dropped from the registry. Exactly one event per losing duplicate
 * (not per Core file read) — three roots that all declare the same
 * slug produce two events (root[0] vs root[1], root[0] vs root[2]).
 *
 * Note: same-root duplicates throw `CoreInstallError('duplicate_install')`
 * rather than emitting this event — that's a packaging misconfiguration,
 * not a precedence resolution.
 */
export interface BundledRegistryDuplicateSlugEvent {
  event_name: 'cores.duplicate_slug_resolved'
  slug: string
  /** Repo root whose copy of the Core is being used. */
  winning_root: string
  /** Repo root whose copy is being dropped. */
  losing_root: string
}

/**
 * Emitted when a configured root does not exist on disk OR is not a
 * directory. The walk skips the root rather than crashing — Managed
 * deployments may legitimately ship without the optional
 * managed-private root if no Tier 2 Cores are installed, and we don't
 * want a missing directory to brick boot. One event per missing root.
 */
export interface BundledRegistryRootSkippedEvent {
  event_name: 'cores.root_skipped'
  rootDir: string
  reason: 'not_found' | 'not_a_directory'
}

export type BundledRegistryEvent =
  | BundledRegistryDuplicateSlugEvent
  | BundledRegistryRootSkippedEvent

export type BundledRegistryTelemetry = (event: BundledRegistryEvent) => void

export interface BuildBundledRegistryOptions {
  /**
   * Repo root, or an array of repo roots. Bundled Cores live at
   * `<rootDir>/cores/<name>/`. When an array is supplied the registry
   * walks each root in order; on a CROSS-root duplicate slug the FIRST
   * root wins (precedence by array order) and the loser is dropped +
   * a `cores.duplicate_slug_resolved` event is routed to `telemetry`.
   * On a SAME-root duplicate slug the registry throws
   * `CoreInstallError('duplicate_install')` — that's a packaging bug,
   * not a precedence resolution.
   *
   * A plain string is treated as a one-element array (backward-compat
   * with single-root callers). An empty array boots a zero-Core
   * registry without crashing.
   *
   * Wiring intent (per `docs/research/neutron-cores-marketplace-split-2026-05-17.md § 3`):
   *   Open      → `[<publicRoot>]`
   *   Managed   → `[<publicRoot>, <managedPrivateRoot>]` (post-Sprint C)
   * Today both shapes pass `[<repoRoot>]` (single root); the managed
   * half lights up when the physical repo split happens in Sprint C.
   */
  rootDir: string | string[]
  /**
   * If true (the default), throw `CoreInstallError` on the FIRST
   * bundled Core whose manifest fails validation. Boot must not
   * proceed in this state. Tests pass `false` to enumerate every
   * issue at once.
   */
  blockOnFirstError?: boolean
  /**
   * Slugs to skip — useful in tests + for excluding the SDK itself or
   * the runtime workspace from the bundled-Core walk. Default skips
   * `sdk` and `runtime` (the workspace packages under `cores/` that
   * are tooling, not bundled Cores).
   */
  excludeSlugs?: ReadonlyArray<string>
  /**
   * Optional telemetry sink. Receives `cores.duplicate_slug_resolved`
   * + `cores.root_skipped` events. Defaults to a no-op. Production
   * wires a structured-log writer (the gateway's stdout/journald
   * sink); tests inject a recorder to assert on the event stream.
   */
  telemetry?: BundledRegistryTelemetry
}

const DEFAULT_EXCLUDED = ['sdk', 'runtime'] as const
const NOOP_TELEMETRY: BundledRegistryTelemetry = (): void => undefined

export function buildBundledRegistry(
  options: BuildBundledRegistryOptions,
): BundledRegistry {
  const blockOnFirstError = options.blockOnFirstError ?? true
  const excluded = new Set([
    ...DEFAULT_EXCLUDED,
    ...(options.excludeSlugs ?? []),
  ])
  const telemetry: BundledRegistryTelemetry = options.telemetry ?? NOOP_TELEMETRY
  const roots: string[] = Array.isArray(options.rootDir)
    ? [...options.rootDir]
    : [options.rootDir]

  const cores: BundledCore[] = []
  const bySlug = new Map<string, BundledCore>()
  const errors: Array<{ dir: string; error: CoreInstallError }> = []

  outer: for (const rootDir of roots) {
    const status = rootStatusOf(rootDir)
    if (status !== 'ok') {
      telemetry({ event_name: 'cores.root_skipped', rootDir, reason: status })
      continue
    }
    const coresDir = join(rootDir, 'cores')
    const candidateDirs = findCoreDirs(coresDir)
    // Reset per root so the same-root duplicate check still fires when
    // an earlier root has already claimed (shadowed) the slug — without
    // this set, the second same-root copy would hit the cross-root
    // branch on bySlug and get silently absorbed as a precedence
    // resolution instead of surfacing the packaging bug.
    const seenInThisRoot = new Set<string>()
    // Buffer cross-root precedence events for this root and only flush
    // them after the root walks cleanly. If a same-root duplicate is
    // discovered mid-walk, the buffer is discarded (we hit `break outer`
    // before the flush) so a broken root never pollutes the telemetry
    // stream with apparently-valid precedence resolutions.
    const pendingCrossRoot: BundledRegistryDuplicateSlugEvent[] = []

    for (const dir of candidateDirs) {
      // Skip the SDK + runtime workspaces (and any explicit excludes).
      const lastSegment = dir.split('/').pop() ?? ''
      if (excluded.has(lastSegment)) continue

      // Skip dirs whose package.json has no `"neutron"` block. These
      // are tooling workspaces under `cores/` that the registry must
      // ignore.
      let hasNeutronBlock = false
      try {
        const pkg = readCorePackage(dir)
        void pkg.neutron
        hasNeutronBlock = true
      } catch (err) {
        if (err instanceof CoreInstallError && err.code === 'no_neutron_section') {
          continue
        }
        // package_json_unreadable / package_not_found / manifest_invalid
        // — surface as boot error.
        errors.push({ dir, error: err instanceof CoreInstallError
          ? err
          : new CoreInstallError(
              'package_json_unreadable',
              err instanceof Error ? err.message : String(err),
              { coreDir: dir },
            ) })
        if (blockOnFirstError) break outer
        continue
      }
      if (!hasNeutronBlock) continue

      try {
        const loaded = loadCoreFromDir(dir)
        if (seenInThisRoot.has(loaded.slug)) {
          // Same root, same slug → packaging misconfiguration. Checked
          // BEFORE bySlug so an earlier root's shadow of this slug
          // can't divert us into the cross-root branch.
          throw new CoreInstallError(
            'duplicate_install',
            `bundled Core slug=${loaded.slug} declared twice in root=${rootDir}`,
            { core_slug: loaded.slug, rootDir, coreDir: dir },
          )
        }
        seenInThisRoot.add(loaded.slug)
        const existing = bySlug.get(loaded.slug)
        if (existing !== undefined) {
          // Cross-root duplicate: earlier root wins; this Core is the
          // loser. Buffer the event until the per-root walk completes
          // cleanly so a same-root dup discovered later in this root
          // doesn't leak precedence resolutions for a broken root.
          pendingCrossRoot.push({
            event_name: 'cores.duplicate_slug_resolved',
            slug: loaded.slug,
            winning_root: existing.rootDir,
            losing_root: rootDir,
          })
          continue
        }
        const bundled: BundledCore = { ...loaded, source: 'bundled', rootDir }
        cores.push(bundled)
        bySlug.set(loaded.slug, bundled)
      } catch (err) {
        if (err instanceof CoreInstallError) {
          errors.push({ dir, error: err })
        } else {
          errors.push({ dir, error: new CoreInstallError(
            'manifest_invalid',
            err instanceof Error ? err.message : String(err),
            { coreDir: dir },
          )})
        }
        if (blockOnFirstError) break outer
      }
    }

    // Per-root walk completed without same-root duplicate (or any
    // other blocking error). Flush the cross-root precedence events
    // we deferred during the walk.
    for (const ev of pendingCrossRoot) telemetry(ev)
  }

  if (blockOnFirstError && errors.length > 0) {
    const first = errors[0]!
    throw first.error
  }

  return {
    list(): BundledCore[] {
      return [...cores]
    },
    get(slug: string): BundledCore | null {
      return bySlug.get(slug) ?? null
    },
  }
}

function rootStatusOf(rootDir: string): 'ok' | 'not_found' | 'not_a_directory' {
  if (!existsSync(rootDir)) return 'not_found'
  if (!statSync(rootDir).isDirectory()) return 'not_a_directory'
  return 'ok'
}
