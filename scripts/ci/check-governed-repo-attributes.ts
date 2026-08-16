#!/usr/bin/env bun
/**
 * CI conformance check: a governed repo marks its append-only build log
 * `merge=union`.
 *
 * A governed repo is one with a `SPEC.md` at its git root (the Spec-Drift
 * Guardrails convention, the same test `detectRalphMode` uses). Those repos
 * keep an as-built log that every change appends to at the top, so two open PRs
 * conflict by construction rather than by subject.
 *
 * This is a CHECK, not a fixer, and deliberately so. The alternative considered
 * was having the build dispatch write `.gitattributes` into a repo when it
 * notices the rule missing — which mutates somebody's working tree as a side
 * effect of starting a build, and leaves an untracked file behind when the
 * build does not happen to commit it. A gate that says "add this line" costs
 * one commit once per repo and surprises nobody.
 *
 * Exit 0 conformant (including "not a governed repo" and "no log to protect" —
 * both are legitimately nothing to enforce), exit 1 otherwise.
 */

import { planUnionAttribute, AS_BUILT_CANDIDATES } from '../../trident/as-built-union-attribute.ts'

const root = process.argv[2] ?? process.cwd()

const isGoverned = await Bun.file(`${root}/SPEC.md`).exists()
if (!isGoverned) {
  console.log(`governed-repo attributes: ${root} has no root SPEC.md — not a governed repo, nothing to enforce`)
  process.exit(0)
}

const present: string[] = []
for (const candidate of AS_BUILT_CANDIDATES) {
  if (await Bun.file(`${root}/${candidate}`).exists()) present.push(candidate)
}

if (present.length === 0) {
  console.log('governed-repo attributes: no append-only build log found — nothing to enforce')
  process.exit(0)
}

const attributesFile = Bun.file(`${root}/.gitattributes`)
const attributes = (await attributesFile.exists()) ? await attributesFile.text() : null

const plan = planUnionAttribute({ attributes, asBuiltPaths: present })

// A CUSTOM driver in the TRACKED file is not a preference to respect — it is a
// repo nobody who has not run the installer can merge, because git treats an
// attribute naming an unconfigured driver as fatal rather than falling back.
// Found by mutation-testing this very gate: it used to report OK for exactly
// this case, on the reasoning that it does not overwrite somebody's choice.
// Correct for a fixer, wrong for a gate.
const tracked = plan.skipped.filter((s) => s.reason === 'custom-driver')
if (tracked.length > 0) {
  console.error('❌ governed-repo attributes: a CUSTOM merge driver is named in the tracked .gitattributes.')
  console.error('')
  console.error('   git treats an attribute naming a driver it has no config for as FATAL:')
  console.error('     fatal: custom merge driver <name> lacks command line.   (exit 128)')
  console.error('')
  console.error('   That breaks every fresh clone, every outside contributor and CI on any merge')
  console.error('   touching the file. Bind a custom driver in the UNTRACKED')
  console.error('   $GIT_COMMON_DIR/info/attributes instead (scripts/install-merge-drivers.sh),')
  console.error('   which outranks .gitattributes where installed and is absent where it is not.')
  console.error('')
  for (const s of tracked) console.error(`     ${s.path}`)
  process.exit(1)
}

if (plan.action === 'noop') {
  const detail = plan.skipped
    .map((s) => `${s.path} (${s.reason})`)
    .join(', ')
  console.log(`✅ governed-repo attributes OK — ${detail}`)
  process.exit(0)
}

console.error('❌ governed-repo attributes: the append-only build log is not union-merged.')
console.error('')
console.error('   Every change appends an entry at the top of this file, so two open PRs')
console.error('   conflict by construction rather than by subject, and the resolution is')
console.error('   always the same mechanical "keep both". git has a built-in driver for')
console.error('   that shape.')
console.error('')
console.error('   Add to .gitattributes:')
for (const path of plan.added) console.error(`     ${path} merge=union`)
if (plan.skipped.length > 0) {
  console.error('')
  console.error('   Left alone (a merge rule already exists and this check does not overwrite one):')
  for (const s of plan.skipped) console.error(`     ${s.path} — ${s.reason}`)
}
process.exit(1)
