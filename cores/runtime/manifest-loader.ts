/**
 * @neutronai/cores-runtime — shared Core manifest loader.
 *
 * Refactor X4 (item 1). Every bundled Core carried a byte-identical
 * `loadManifest` + `defaultPackageJsonPath` in its `src/manifest.ts` (×9):
 * read `package.json`, pull the `"neutron"` block, delegate to
 * `parseManifest`. This is the ONE shared implementation; each Core keeps a
 * one-line `loadManifest` wrapper that supplies its own default path (via
 * `import.meta.url`) so the on-disk resolution is unchanged.
 *
 * Behaviour is preserved EXACTLY: same `parseManifest` (Zod) validation,
 * same plain-`Error` messages on a non-object package.json or a missing
 * `"neutron"` section (NOT the runtime's `CoreInstallError` — the Core boot
 * path wraps these itself).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseManifest, type NeutronManifest } from '@neutronai/cores-sdk'

/**
 * Load + parse a Core's manifest from an explicit `package.json` path.
 * Throws a plain `Error` if the file is not a JSON object or has no
 * `"neutron"` section; throws the `parseManifest` Zod error on an invalid
 * manifest body.
 */
export function loadManifestFromPackageJson(
  package_json_path: string,
): NeutronManifest {
  const raw = readFileSync(package_json_path, 'utf8')
  const pkg: unknown = JSON.parse(raw)
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new Error(`package.json at ${package_json_path} is not an object`)
  }
  const block = (pkg as Record<string, unknown>)['neutron']
  if (block === undefined) {
    throw new Error(
      `package.json at ${package_json_path} has no "neutron" section`,
    )
  }
  return parseManifest(block)
}

/**
 * Load + parse a Core's manifest from its package DIRECTORY (reads
 * `<packageDir>/package.json`).
 */
export function loadManifestFromPackageDir(
  package_dir: string,
): NeutronManifest {
  return loadManifestFromPackageJson(join(package_dir, 'package.json'))
}
