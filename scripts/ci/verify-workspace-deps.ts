/**
 * verify-workspace-deps.ts — refuse to run a test suite in a tree whose
 * dependencies were never installed.
 *
 * WHY THIS EXISTS (measured 2026-08-19, lane 282ad664 / PR #449)
 * -------------------------------------------------------------
 * A trident lane reported `suiteOutcome='failed-preexisting'` with 411 of 1,370
 * test files red, and "proved" it by re-running the failing files at the base
 * commit, where they were red too. Both runs were red for the same reason, and
 * it was not the code:
 *
 *     40x  Cannot find package 'react'
 *     36x  Cannot find module 'react/jsx-dev-runtime'
 *    132x  Cannot find module '@neutronai/persistence/index.ts'
 *      7x  Cannot find package 'zod'
 *
 * The positive control: `app/__tests__/activity-client.test.ts`, the FIRST file
 * in that lane's failing list, runs 20 pass / 0 fail in a checkout whose deps
 * are installed, and CI was SUCCESS on `test` and all eight shards for the very
 * same head.
 *
 * This is a bun workspace. Third-party packages live in `node_modules/.bun/`
 * and each workspace package reaches them through its OWN `node_modules`; all
 * of it is gitignored. So a fresh `git worktree add` has NONE of it, and lane
 * worktrees are provisioned inconsistently — of the three newest on disk when
 * this was written, one resolved `react` and two had an empty `node_modules`.
 *
 * An unprovisioned tree therefore spends ~14 minutes producing hundreds of
 * import errors that read, to every downstream gate, as the branch's fault. The
 * suite has no way to tell "your diff is broken" from "this tree was never
 * installed", so the build cannot honestly report `passed` and the full-suite
 * gate blocks it. That is the failure this file converts into a one-second
 * refusal with the actual remedy in it.
 *
 * WHAT IT CHECKS, AND WHY IN THIS ORDER
 * -------------------------------------
 * 1. The bun store (`node_modules/.bun`) exists and is non-empty. This is the
 *    single thing whose absence explains every error above.
 * 2. Every workspace package that DECLARES dependencies can actually RESOLVE
 *    one, from its own directory. Derived from each package.json rather than an
 *    allowlist, so a new package is covered the day it is added and a package
 *    with no deps is never falsely accused.
 *
 * Check 2 is a resolution sweep and not a presence test, and the first draft of
 * this file got that wrong in a way worth recording: it asserted that a package
 * declaring dependencies must have its own `node_modules` directory. Run
 * against a KNOWN-HEALTHY tree that rule failed instantly — bun HOISTS, so 15
 * of 32 packages here legitimately have no `node_modules` of their own and
 * resolve upward to the root. A presence test also passes over a directory that
 * resolves nothing, which is the wrong answer in both directions. Resolution is
 * the only question that matters, so resolution is what is asked.
 *
 * The probe target is DERIVED, never hardcoded: hardcoding `react` would rot
 * the day `app` drops it, and would quietly stop checking at exactly the moment
 * it started lying.
 *
 * EVERY EXTRACTION FAILS LOUDLY (exit 3), because an empty check reads as a
 * passing check. Finding zero package.json files, or zero packages declaring
 * dependencies, or being unable to pick a probe target, is a FAILURE of this
 * verifier — not a clean tree. That specific mistake has been made twice in
 * this repo (a preflight COLS regex and a `gh pr checks` jq filter, both of
 * which parsed nothing and reported green).
 *
 * ZERO WORKSPACE IMPORTS — THIS IS A CONTRACT, NOT UNTIDINESS. This file runs
 * precisely when `@neutronai/*` cannot be resolved. An import of one would make
 * the verifier die with the same error class it exists to diagnose, and a
 * verifier that cannot run in a broken tree verifies nothing. `node:fs` and
 * `node:path` only.
 *
 * EXIT CODES
 *   0  the tree can resolve its dependencies — run the suite
 *   3  the tree is not provisioned, or this verifier could not check
 * 3 rather than 1 so a caller can tell "the tree was never installed" from
 * "tests failed", which is the whole distinction this file exists to restore.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REFUSAL = 3

/** Directories that are never workspace packages, whatever they contain. */
const NEVER_A_PACKAGE = new Set(['node_modules'])

function fail(lines: string[]): never {
  for (const line of lines) console.error(line)
  console.error('')
  console.error('  This tree was never installed. Run `bun install` here before running tests.')
  console.error('  A suite run in this state reds hundreds of files on import errors that have')
  console.error("  nothing to do with the diff, and every downstream gate reads that as the")
  console.error('  branch being broken. Refusing rather than producing that evidence.')
  process.exit(REFUSAL)
}

const root = resolve(process.argv[2] ?? process.cwd())

// --- 1. The bun store -------------------------------------------------------
const store = join(root, 'node_modules', '.bun')
if (!existsSync(store)) {
  fail([`verify-workspace-deps: ${root}/node_modules/.bun does not exist.`])
}
const storeEntries = readdirSync(store)
if (storeEntries.length === 0) {
  fail([`verify-workspace-deps: ${root}/node_modules/.bun is empty.`])
}

// --- 2. Every package that declares dependencies has somewhere to find them --
type Pkg = { dir: string; name: string; deps: string[] }

function readPackages(): Pkg[] {
  const packages: Pkg[] = []
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.') || NEVER_A_PACKAGE.has(entry)) continue
    const dir = join(root, entry)
    let isDir = false
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) continue

    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue

    let parsed: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    } catch {
      // A package.json this verifier cannot read is not a clean tree.
      fail([`verify-workspace-deps: ${manifest} is not readable JSON.`])
    }

    // Workspace siblings (`@neutronai/*`) resolve through the same per-package
    // `node_modules`, so they count exactly like third-party deps here.
    const deps = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies })
    packages.push({ dir, name: parsed.name ?? entry, deps })
  }
  return packages
}

const packages = readPackages()

// The loud-empty rules. Each of these means the verifier failed to look, which
// is never the same as having looked and found nothing wrong.
if (packages.length === 0) {
  fail([`verify-workspace-deps: found NO workspace packages under ${root} — the verifier could not check anything.`])
}

const withDeps = packages.filter((pkg) => pkg.deps.length > 0)
if (withDeps.length === 0) {
  fail([
    `verify-workspace-deps: none of the ${packages.length} workspace packages declare dependencies —`,
    '  that cannot be right, so the verifier is refusing rather than reporting clean.',
  ])
}

// The resolution sweep. One dependency per package is enough: the chain either
// resolves from that directory or it does not, and a tree that was never
// installed fails on the first name it is asked for. Deterministic targets
// (first package by name, first dep by name) so a failure message is
// reproducible rather than depending on directory-listing order.
const broken: string[] = []
let probed = 0

for (const pkg of [...withDeps].sort((a, b) => a.name.localeCompare(b.name))) {
  const dep = [...pkg.deps].sort((a, b) => a.localeCompare(b))[0]
  if (!dep) continue
  probed += 1
  try {
    // `Bun.resolveSync` walks the same node_modules chain the test runner does,
    // from the package's OWN directory — which is where the chain breaks, and
    // it accounts for hoisting to the root exactly as bun does at test time.
    Bun.resolveSync(dep, pkg.dir)
  } catch (error) {
    broken.push(`    ${pkg.name} cannot resolve '${dep}' — ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (probed === 0) {
  fail(['verify-workspace-deps: resolved NOTHING — the verifier could not check anything.'])
}

// THE THRESHOLD IS MEASURED, NOT PICKED, and it is deliberately blunt.
//
// A healthy checkout does NOT resolve everything: measured on main at
// 2026-08-19, 4 of 32 packages could not resolve their first declared
// dependency (`@neutronai/landing`, `@neutronai/tools`, `@neutronai/runtime`,
// `@neutronai/gbrain-memory` — packages whose optional deps are simply not
// installed here, and whose tests pass regardless). Root-level deps are no
// cleaner: 2 of 26 do not resolve, `@types/bun` among them. So "everything
// resolves" is not a property of a working tree and asserting it would red CI.
//
// An UNPROVISIONED tree fails essentially all of them — the same tree that
// produced 411 red files could not resolve `react`, `zod`, or any
// `@neutronai/*` at all. The two populations are ~12% broken and ~100% broken,
// so any line drawn between them is safe; half is chosen because it needs no
// maintenance as packages come and go, and because this check only has to
// separate "installed" from "never installed" — the suite itself is the
// authority on everything finer.
const resolvedCount = probed - broken.length
if (resolvedCount * 2 < probed) {
  const shown = broken.slice(0, 8)
  const rest = broken.length > 8 ? [`    …and ${broken.length - 8} more`] : []
  fail([
    `verify-workspace-deps: ${broken.length} of ${probed} workspace packages cannot resolve their own`,
    '  declared dependencies — this tree is not installed, not merely incomplete:',
    ...shown,
    ...rest,
  ])
}

// Reported even on success: these are real gaps, and a silent one becomes the
// next "pre-existing failure" nobody can account for.
for (const line of broken) console.log(`verify-workspace-deps: note —${line.replace(/^ {4}/, ' ')}`)

console.log(
  `verify-workspace-deps: OK — ${storeEntries.length} packages in the bun store, ` +
    `${resolvedCount}/${probed} workspace packages resolved a declared dependency.`,
)
