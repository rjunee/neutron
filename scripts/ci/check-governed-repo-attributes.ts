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
 * THE VERDICT COMES FROM GIT, NOT FROM READING THE FILE. This gate used to
 * decide by parsing `.gitattributes` and taking the first exact-path `merge=`
 * assignment. git takes the LAST matching rule, and a later wildcard beats an
 * earlier exact path — so a tracked file whose union line was overridden two
 * lines below resolved to the override in git and to `union` here, and the gate
 * printed ✅ over exactly the regression it exists to catch. It now asks
 * `git check-attr` (see `resolveTrackedMergeDrivers`).
 *
 * WHAT IS BEING GATED IS THE TRACKED FLOOR, NOT THIS CLONE. The entry-aware
 * driver binds itself in the UNTRACKED `$GIT_COMMON_DIR/info/attributes`, which
 * outranks `.gitattributes` — so on a machine that ran
 * `scripts/install-merge-drivers.sh`, this clone's effective driver is
 * `as-built-log` and that is CORRECT, an opt-in upgrade over an intact floor.
 * The two questions are asked separately: the verdict comes from an isolated
 * probe carrying only the tracked file (what a fresh clone, and GitHub's own
 * server-side merge, will see), and this clone's local answer is reported
 * underneath as information that never decides anything.
 *
 * Exit 0 conformant (including "not a governed repo" and "no log to protect" —
 * both are legitimately nothing to enforce), exit 1 otherwise.
 */

import {
  AS_BUILT_CANDIDATES,
  BUILT_IN_MERGE_DRIVERS,
  localEffectiveMergeDrivers,
  mergeRulesFor,
  resolveTrackedMergeDrivers,
  unionAttributeLine,
} from '@neutronai/trident/as-built-union-attribute.ts'

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

const tracked = resolveTrackedMergeDrivers({ attributes, paths: present })
const failing = present.filter((path) => tracked.get(path) !== 'union')

/** The local clone's view, reported but never decisive. */
function localNote(): string[] {
  const local = localEffectiveMergeDrivers(root, present)
  if (local === null) return []
  const upgraded = present.filter((p) => local.get(p) !== tracked.get(p))
  if (upgraded.length === 0) return []
  return [
    '',
    '   (this clone additionally resolves, via an untracked overlay — informational, not gated:',
    ...upgraded.map((p) => `      ${p} → ${local.get(p) ?? 'unspecified'}`),
    '    that is what scripts/install-merge-drivers.sh installs, and it does not change the floor)',
  ]
}

if (failing.length === 0) {
  const detail = present.map((p) => `${p} (merge=union)`).join(', ')
  console.log(`✅ governed-repo attributes OK — git resolves ${detail} from the tracked file`)
  for (const line of localNote()) console.log(line)
  process.exit(0)
}

console.error('❌ governed-repo attributes: the append-only build log is not union-merged.')
console.error('')
console.error('   Every change appends an entry at the top of this file, so two open PRs')
console.error('   conflict by construction rather than by subject, and the resolution is')
console.error('   always the same mechanical "keep both". git has a built-in driver for')
console.error('   that shape, and the tracked rule is the floor every fresh clone gets.')
console.error('')
console.error('   git check-attr, over the tracked .gitattributes alone, resolves:')

for (const path of failing) {
  const driver = tracked.get(path) ?? null
  console.error('')
  console.error(`     ${path} → merge=${driver ?? 'unspecified'}`)

  if (driver === null) {
    console.error(`       No rule reaches this path. Add to .gitattributes:`)
    console.error(`         ${unionAttributeLine(path)}`)
  } else if ((BUILT_IN_MERGE_DRIVERS as readonly string[]).includes(driver)) {
    console.error(`       '${driver}' is a built-in driver, but it is not union: this log still`)
    console.error(`       conflicts on every concurrent append. Make the winning rule:`)
    console.error(`         ${unionAttributeLine(path)}`)
  } else {
    console.error(`       '${driver}' is a CUSTOM driver, and naming one in the TRACKED file does`)
    console.error(`       not give a fresh clone union behaviour. Measured on git 2.50.1: a clone`)
    console.error(`       with no merge.${driver}.* config falls back to the ordinary text merge —`)
    console.error(`       an exit-1 content conflict with markers, which is the thing this rule is`)
    console.error(`       supposed to prevent. (The fatal 'lacks command line' abort is a different`)
    console.error(`       case: merge.${driver}.name defined with no .driver.)`)
    console.error(`       Bind a custom driver in the UNTRACKED $GIT_COMMON_DIR/info/attributes`)
    console.error(`       instead (scripts/install-merge-drivers.sh), which outranks .gitattributes`)
    console.error(`       where installed and is absent where it is not, and keep the tracked line:`)
    console.error(`         ${unionAttributeLine(path)}`)
  }

  // Name the lines that are actually in the file. When the union line IS there
  // and something later beats it, "add this line" is unactionable advice — the
  // line is already there and the reader needs to be shown the override.
  const rules = attributes === null ? [] : mergeRulesFor(attributes, path)
  const only = rules.length === 1 ? rules[0] : undefined
  if (rules.length > 1) {
    console.error(`       .gitattributes assigns this exact path ${rules.length} times; the LAST wins:`)
    for (const rule of rules) console.error(`         line ${rule.line}: ${rule.text}`)
  } else if (only !== undefined && only.driver !== driver) {
    console.error(`       .gitattributes line ${only.line} says '${only.text}', but a later`)
    console.error(`       or broader pattern overrides it — git's answer above is the one that counts.`)
  }
}

process.exit(1)
