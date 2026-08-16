#!/usr/bin/env bun
/**
 * CI conformance check: a governed repo binds its append-only build log to a
 * merge rule that keeps both sides — `merge=union`, or the repo's OWN
 * entry-aware driver where it ships one.
 *
 * A governed repo is one with a `SPEC.md` at its git root (the Spec-Drift
 * Guardrails convention, the same test `detectRalphMode` uses). Those repos
 * keep an as-built log that every change appends to at the top, so two open PRs
 * conflict by construction rather than by subject.
 *
 * WHY THIS NO LONGER DEMANDS `union` SPECIFICALLY. Union takes both sides of a
 * conflicting hunk, which is right about the goal and wrong about the unit: it
 * emits each side's UNIQUE lines around the lines they SHARE, and two generated
 * entries share plenty. Measured on git 2.50.1 with this exact attribute, two
 * concurrently-appended entries merged at exit 0 with the FIRST entry's closing
 * line absorbed into the second — no conflict, no marker, nothing to review.
 * (`scripts/git/as-built-merge-realgit.test.ts`, "UNION silently drops a line
 * the two entries share".) So a repo that ships an entry-aware driver must be
 * allowed to bind it; union remains the correct floor for a repo that does not.
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

import { planUnionAttribute, existingMergeDriver, AS_BUILT_CANDIDATES } from '@neutronai/trident/as-built-union-attribute.ts'

/**
 * The entry-aware driver this repo ships, and the files that make it real.
 *
 * A custom driver name in `.gitattributes` is only acceptable if the repo can
 * actually merge with it — otherwise it IS the stray-rule case this gate exists
 * to catch. So the name is not enough: the driver script and its installer have
 * to be present in the same tree.
 */
const ENTRY_AWARE_DRIVER = 'as-built-log'
const ENTRY_AWARE_FILES = ['scripts/git/as-built-merge-driver.ts', 'scripts/install-merge-drivers.sh']

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

// A CUSTOM driver in the TRACKED file is not automatically a preference to
// respect — a name the repo cannot run is exactly the stray rule this gate
// exists to catch. But it is not automatically wrong either, and the reasoning
// that said it was has been measured and corrected.
//
// THE CORRECTED PREMISE. This used to reject every tracked custom driver on the
// grounds that git treats a declared-but-unconfigured driver as FATAL (exit
// 128). It does not. Measured on git 2.50.1, fresh repo, attribute tracked, no
// `merge.<name>.*` config at all: `git merge` returns an ORDINARY CONFLICT
// (exit 1) and `git apply --3way` returns 0. Exit 128 is reachable only from a
// half-written config that sets `merge.<name>.name` without `.driver`, which is
// an installer bug rather than a property of tracking the attribute — and this
// repo's installer can no longer produce it, because it never writes `.name`.
//
// So the rule is about CAPABILITY, not about tracking: a repo may bind its own
// entry-aware driver iff it actually ships that driver.
const entryAwareShipped = (
  await Promise.all(ENTRY_AWARE_FILES.map((rel) => Bun.file(`${root}/${rel}`).exists()))
).every(Boolean)

const tracked = plan.skipped.filter((s) => {
  if (s.reason !== 'custom-driver') return false
  const driver = existingMergeDriver(attributes ?? '', s.path)
  return !(driver === ENTRY_AWARE_DRIVER && entryAwareShipped)
})
if (tracked.length > 0) {
  console.error('❌ governed-repo attributes: a CUSTOM merge driver is named in the tracked .gitattributes,')
  console.error('   and this repo does not ship it.')
  console.error('')
  console.error('   A tracked attribute naming a driver nobody has configured is not fatal — git')
  console.error('   falls back to an ordinary conflict — but it is a rule the repo cannot honour,')
  console.error('   which is indistinguishable from having no rule at all.')
  console.error('')
  console.error(`   Either use \`merge=union\`, or ship the entry-aware driver (${ENTRY_AWARE_FILES.join(', ')})`)
  console.error(`   and bind \`merge=${ENTRY_AWARE_DRIVER}\`.`)
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
