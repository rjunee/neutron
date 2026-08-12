/**
 * @neutronai/scripts — refuse to submit an EAS build from a tree whose installed
 * packages do not match what `app/package.json` declares (ISSUES #513).
 *
 * ── THE BUG THIS EXISTS FOR, WHICH ALMOST SHIPPED ────────────────────────────
 *
 * On 2026-08-07 `expo-haptics` was added to `app/package.json` and reached
 * `bun.lock`, but the local `node_modules` was never re-installed, so the package
 * was declared, locked, and NOT LINKED. `eas build` computes the runtime
 * fingerprint LOCALLY, at submit time, from what autolinking can SEE — then stamps
 * that value on the build. EAS's own builder installs from the lockfile and
 * therefore DOES link the native module. The submitted build got:
 *
 *   - the native module PRESENT in the binary (the builder installed it), and
 *   - a runtime version computed from a tree WITHOUT it.
 *
 * A new binary wearing an old identity, and nothing failed. Both consequences are
 * silent:
 *
 *   1. An update published against the HONEST fingerprint reaches nobody, because
 *      no installed build declares it.
 *   2. An update published against the STALE fingerprint lands on the old build
 *      too — where the native module does not exist — so the same JS works on one
 *      device and quietly no-ops on the other. And it no-ops rather than crashing
 *      precisely because the feature was written to degrade gracefully. The care
 *      that makes a native call safe is what makes this invisible.
 *
 * The tell was that the fingerprint DID NOT CHANGE for a change that adds a native
 * dependency, which cannot be true. ⇒ **A fingerprint that did not change when a
 * native dependency was added is a measurement of the wrong tree, not evidence the
 * change is OTA-able.**
 *
 * ── WHY THIS CHECKS LINKAGE AND NOT AUTOLINKING ──────────────────────────────
 *
 * The tempting check is "every native dependency must appear among the
 * fingerprint's autolinked sources". That requires this script to decide which
 * packages are native — a heuristic that drifts with every Expo release, and one
 * whose false negatives look exactly like success.
 *
 * The root cause is simpler and fully decidable: a package that `package.json`
 * DECLARES and `node_modules` does not CONTAIN. That is what makes the local
 * fingerprint describe a different tree than the builder's, and it is true
 * whether or not the package happens to ship native code. Non-native packages
 * cannot corrupt a fingerprint, so flagging them costs only a `bun install` —
 * which is the fix in every case anyway.
 *
 * Exit 0 = safe to submit. Exit 1 = declared-but-unlinked packages, named.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PreflightInput {
  /** Parsed `app/package.json`. */
  manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  /** True when the package resolves from the app's install tree. */
  isLinked: (packageName: string) => boolean
}

/**
 * Packages this repo declares but does not install locally.
 *
 * `devDependencies` are deliberately INCLUDED. A dev-only package can still carry
 * a config plugin or an `expo-module.config.json`, and both feed the fingerprint —
 * so "it is only a dev dependency" is not a reason to trust the measurement.
 */
export function unlinkedDependencies(input: PreflightInput): string[] {
  const declared = [
    ...Object.keys(input.manifest.dependencies ?? {}),
    ...Object.keys(input.manifest.devDependencies ?? {}),
  ]
  // Sorted + de-duplicated so the report is stable and a name cannot appear twice
  // when it is in both blocks.
  return [...new Set(declared)].filter((name) => !input.isLinked(name)).sort()
}

/** Resolution against a real tree: the app's own `node_modules`, then the root's. */
export function makeIsLinked(appDir: string, repoRoot: string): (name: string) => boolean {
  return (name) =>
    existsSync(join(appDir, 'node_modules', name)) ||
    existsSync(join(repoRoot, 'node_modules', name))
}

function main(): number {
  const repoRoot = process.argv[2] ?? process.cwd()
  const appDir = join(repoRoot, 'app')
  const manifestPath = join(appDir, 'package.json')
  if (!existsSync(manifestPath)) {
    process.stdout.write(`EAS PREFLIGHT: no app/package.json under ${repoRoot} — nothing to check\n`)
    return 0
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PreflightInput['manifest']
  const missing = unlinkedDependencies({ manifest, isLinked: makeIsLinked(appDir, repoRoot) })

  if (missing.length === 0) {
    process.stdout.write('EAS PREFLIGHT: every declared app dependency is installed ✅\n')
    return 0
  }

  process.stdout.write(
    'EAS PREFLIGHT: FAILED — declared in app/package.json but NOT installed:\n' +
      missing.map((m) => `  ${m}\n`).join('') +
      '\nThe runtime fingerprint is computed from what is INSTALLED, so submitting now\n' +
      'would stamp this build with the fingerprint of a tree that lacks these packages —\n' +
      'while EAS’s builder installs them from the lockfile anyway (ISSUES #513).\n' +
      'Fix: run `bun install`, then re-check that the fingerprint changed as expected.\n',
  )
  return 1
}

// Only when run directly, so the pure functions above stay importable by tests.
if (import.meta.main) process.exit(main())
