/**
 * @neutronai/cores-runtime — package loader.
 *
 * Reads a Core directory, pulls the `"neutron"` block out of `package.json`,
 * runs it through the Sprint 24 `@neutronai/cores-sdk` Zod schema, and
 * returns a `LoadedCore` carrying the validated manifest + a derived
 * `core_slug` the runtime uses everywhere downstream.
 *
 * Failures throw `CoreInstallError` with one of:
 *   - `package_not_found`         — the directory doesn't exist
 *   - `package_json_unreadable`   — the file exists but JSON parse failed
 *   - `no_neutron_section`        — JSON parsed but `"neutron"` is absent
 *   - `manifest_invalid`          — `"neutron"` exists but `parseManifest`
 *                                    rejected (Zod issues attached)
 *
 * v1 reads from a local directory; the marketplace fetch / npm-tarball
 * shape is a P3+ detail.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ZodError } from 'zod'

import {
  parseManifest,
  type NeutronManifest,
} from '@neutronai/cores-sdk'

import { CoreInstallError } from './errors.ts'

export interface CorePackageJson {
  name: string
  version: string
  neutron: unknown
}

export interface LoadedCore {
  /** Stable runtime slug; lowercased + sanitized derivation of package
   *  name. `@neutronai/dtc-analytics` → `dtc_analytics` so it's safe inside
   *  SQL identifiers (the per-Core table prefix uses this). */
  slug: string
  /** The raw npm package name from `package.json`. */
  package_name: string
  /** The semver tag from `package.json`. */
  package_version: string
  /** Validated manifest from `package.json.neutron`. */
  manifest: NeutronManifest
  /** Absolute path to the Core's directory on disk. */
  coreDir: string
}

/**
 * Convert an npm package name into a slug safe for use as a SQLite
 * identifier prefix. Lowercases, strips a leading `@scope/`, replaces any
 * non-alphanum char with `_`, collapses runs of `_`, and strips leading /
 * trailing `_`. Hard-rejects an empty result with a typed
 * `CoreInstallError` because every other downstream step depends on a
 * non-empty slug (table prefix, sidecar filename, `core_installations`
 * primary key).
 */
export function packageNameToSlug(packageName: string): string {
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new CoreInstallError(
      'manifest_invalid',
      `package.json name is missing or not a string`,
      { packageName },
    )
  }
  // Strip a leading `@scope/` per npm scope syntax.
  const noScope = packageName.replace(/^@[^/]+\//, '')
  const lower = noScope.toLowerCase()
  const cleaned = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (cleaned.length === 0) {
    throw new CoreInstallError(
      'manifest_invalid',
      `package.json name=${packageName} produces an empty slug after normalization`,
      { packageName },
    )
  }
  return cleaned
}

/**
 * Read + parse `<coreDir>/package.json`. Throws `CoreInstallError` with a
 * specific code on every failure mode.
 */
export function readCorePackage(coreDir: string): CorePackageJson {
  if (!existsSync(coreDir)) {
    throw new CoreInstallError(
      'package_not_found',
      `core directory does not exist: ${coreDir}`,
      { coreDir },
    )
  }
  const dirStat = statSync(coreDir)
  if (!dirStat.isDirectory()) {
    throw new CoreInstallError(
      'package_not_found',
      `core path is not a directory: ${coreDir}`,
      { coreDir },
    )
  }
  const pkgPath = join(coreDir, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new CoreInstallError(
      'package_not_found',
      `core directory is missing package.json: ${pkgPath}`,
      { coreDir },
    )
  }
  let raw: string
  try {
    raw = readFileSync(pkgPath, 'utf8')
  } catch (err) {
    throw new CoreInstallError(
      'package_json_unreadable',
      `failed to read ${pkgPath}: ${err instanceof Error ? err.message : 'unknown'}`,
      { coreDir },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new CoreInstallError(
      'package_json_unreadable',
      `package.json is not valid JSON at ${pkgPath}: ${err instanceof Error ? err.message : 'unknown'}`,
      { coreDir },
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CoreInstallError(
      'package_json_unreadable',
      `package.json must be a JSON object at ${pkgPath}`,
      { coreDir },
    )
  }
  const obj = parsed as Record<string, unknown>
  const name = obj['name']
  const version = obj['version']
  const neutron = obj['neutron']
  if (typeof name !== 'string' || name.length === 0) {
    throw new CoreInstallError(
      'manifest_invalid',
      `package.json at ${pkgPath} is missing a non-empty "name" field`,
      { coreDir },
    )
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new CoreInstallError(
      'manifest_invalid',
      `package.json at ${pkgPath} is missing a non-empty "version" field`,
      { coreDir },
    )
  }
  if (neutron === undefined) {
    throw new CoreInstallError(
      'no_neutron_section',
      `package.json at ${pkgPath} does not declare a "neutron" block — not a Core package`,
      { coreDir, package_name: name },
    )
  }
  return { name, version, neutron }
}

/**
 * Read + validate a Core directory end-to-end. Returns the
 * `LoadedCore` shape every other lifecycle step (install / configure /
 * uninstall / upgrade / capability-guard) consumes.
 *
 * Validation is a single Zod parse; on failure we surface the issues array
 * via `CoreInstallError.details.issues` so the install transcript can list
 * every failing field (vs. just the first one).
 */
export function loadCoreFromDir(coreDir: string): LoadedCore {
  const pkg = readCorePackage(coreDir)
  let manifest: NeutronManifest
  try {
    manifest = parseManifest(pkg.neutron)
  } catch (err) {
    if (err instanceof ZodError) {
      throw new CoreInstallError(
        'manifest_invalid',
        `manifest validation failed for core=${pkg.name} (${err.issues.length} issue${err.issues.length === 1 ? '' : 's'})`,
        {
          coreDir,
          package_name: pkg.name,
          issues: err.issues.map((i) => ({
            path: i.path.join('.'),
            code: i.code,
            message: i.message,
          })),
        },
      )
    }
    throw err
  }
  return {
    slug: packageNameToSlug(pkg.name),
    package_name: pkg.name,
    package_version: pkg.version,
    manifest,
    coreDir,
  }
}

/**
 * Discover candidate Core directories under a parent. Used by the
 * bundled-Core registry to walk `cores/<name>/` at boot. Returns absolute
 * paths only for entries that contain a `package.json`. Validation is
 * the caller's responsibility (typically `loadCoreFromDir`).
 *
 * Recurses ONE level into immediate subdirectories that do NOT themselves
 * contain a `package.json` — those are treated as Tier containers (e.g.
 * `cores/free/`, `cores/managed/`) per the 2-tier Cores layout locked in
 * `docs/research/neutron-cores-marketplace-split-2026-05-17.md § 3`. So:
 *
 *   cores/dtc-analytics/package.json   → discovered (immediate Core)
 *   cores/free/notes/package.json      → discovered (container + Core)
 *   cores/free/tasks/package.json      → discovered (container + Core)
 *   cores/free/foo/bar/package.json    → NOT discovered (too deep)
 *
 * Containers are detected purely by the absence of `package.json` at the
 * immediate level; nothing else (manifest content, dir name) gates it.
 * That keeps the rule mechanical and lets new sub-tiers like
 * `cores/managed/` light up later without touching the loader. Recursion
 * is bounded to a single container level — `cores/<container>/<core>/<anything>/`
 * is never walked, so `node_modules` + `__tests__` directories under a
 * Core can't be mistaken for sibling Cores.
 */
export function findCoreDirs(parentDir: string): string[] {
  if (!existsSync(parentDir)) return []
  const stat = statSync(parentDir)
  if (!stat.isDirectory()) return []
  const fs = require('node:fs') as typeof import('node:fs')
  type Dirent = { name: string; isDirectory(): boolean }
  const readDirents = (dir: string): Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }) as Dirent[]
    } catch {
      return []
    }
  }
  const out: string[] = []
  for (const d of readDirents(parentDir)) {
    if (!d.isDirectory()) continue
    const child = join(parentDir, d.name)
    if (existsSync(join(child, 'package.json'))) {
      out.push(child)
      continue
    }
    // No package.json at this level → treat as a Tier container and
    // walk its immediate children one level deeper. Do NOT recurse
    // further: the layout is `cores/<container>/<core>/`, never deeper.
    for (const g of readDirents(child)) {
      if (!g.isDirectory()) continue
      const grandchild = join(child, g.name)
      if (existsSync(join(grandchild, 'package.json'))) {
        out.push(grandchild)
      }
    }
  }
  // Stable order (full-path lexicographic) so boot logs + test fixtures
  // are deterministic across direct + container-nested Cores. Basename-
  // only sort is ambiguous when two containers share a leaf name.
  out.sort((a, b) => a.localeCompare(b))
  return out
}
