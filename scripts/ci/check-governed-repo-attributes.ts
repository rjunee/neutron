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
 * assignment. git takes the LAST matching rule; a later wildcard beats an
 * earlier exact path; and a `.gitattributes` in a SUBDIRECTORY beats the root
 * one entirely. Each of those made the gate print ✅ over exactly the
 * regression it exists to catch. It now asks `git check-attr`, over every
 * tracked attributes file that can reach the log (`resolveTrackedMergeDrivers`).
 *
 * WHAT IS BEING GATED IS THE TRACKED FLOOR, NOT THIS CLONE. The entry-aware
 * driver binds itself in the UNTRACKED `$GIT_COMMON_DIR/info/attributes`, which
 * outranks `.gitattributes` — so on a machine that ran
 * `scripts/install-merge-drivers.sh`, this clone's effective driver is
 * `as-built-log` and that is CORRECT, an opt-in upgrade over an intact floor.
 * The two questions are asked separately: the verdict comes from an isolated
 * probe carrying only the tracked files (what a fresh clone gets — measured, by
 * cloning), and this clone's local answer is reported underneath as information
 * that never decides anything.
 *
 * Exit 0 conformant (including "not a governed repo" and "no log to protect" —
 * both are legitimately nothing to enforce), exit 1 otherwise.
 */

import {
  BUILT_IN_MERGE_DRIVERS,
  collectTrackedAttributesFiles,
  INSTALLER_MERGE_DRIVER,
  localEffectiveMergeDrivers,
  MERGE_ATTRIBUTE_STATES,
  mergeRulesAcross,
  presentAsBuiltLogs,
  resolveTrackedMergeDrivers,
  unionAttributeLine,
  untrackedOverlayAttributes,
} from '@neutronai/trident/as-built-union-attribute.ts'

const root = process.argv[2] ?? process.cwd()

// `SPEC.md` is read from DISK on purpose, and it is the one thing here that is.
// It decides only WHETHER to run; a governed tree that has not committed its
// spec yet is still one, and the cost of being wrong is running a check that
// then finds nothing to enforce. What is GATED — the log and the rule reaching
// it — is read from the COMMITTED TREE, because that is what a fresh clone
// gets. The index is not: it also holds staged-but-uncommitted work, and
// reading it printed ✅ over a floor that existed only in one working copy.
const isGoverned = await Bun.file(`${root}/SPEC.md`).exists()
if (!isGoverned) {
  console.log(`governed-repo attributes: ${root} has no root SPEC.md — not a governed repo, nothing to enforce`)
  process.exit(0)
}

const present = presentAsBuiltLogs(root)

if (present.length === 0) {
  console.log('governed-repo attributes: no append-only build log found — nothing to enforce')
  process.exit(0)
}

const attributesFiles = collectTrackedAttributesFiles(root, present)
const tracked = resolveTrackedMergeDrivers({ attributesFiles, paths: present })
const failing = present.filter((path) => tracked.get(path) !== 'union')

/**
 * The local clone's view, reported but never decisive — and credited to the
 * untracked overlay only when that overlay demonstrably PRODUCES this clone's
 * answer. Otherwise the divergence is reported as unexplained, because
 * "harmless local upgrade" is a claim, not a default.
 */
function localNote(): string[] {
  const local = localEffectiveMergeDrivers(root, present)
  if (local === null) return []
  const diverging = present.filter((p) => local.get(p) !== tracked.get(p))
  if (diverging.length === 0) return []

  // Attribute the divergence with git, not with a substring search: re-ask the
  // isolated probe with this clone's real overlay layered on top, and credit the
  // overlay only for the paths whose local answer it actually reproduces. A
  // wildcard rule in the overlay is then credited correctly, and an overlay that
  // does not explain the difference is not credited at all.
  const overlay = untrackedOverlayAttributes(root)
  const withOverlay =
    overlay === null
      ? null
      : resolveTrackedMergeDrivers({ attributesFiles, paths: present, overlay: overlay.content })
  const explained = diverging.filter((p) => withOverlay !== null && withOverlay.get(p) === local.get(p))
  const unexplained = diverging.filter((p) => !explained.includes(p))

  const out: string[] = ['']
  if (explained.length > 0 && overlay !== null) {
    out.push(`   (this clone additionally resolves, via ${overlay.path} — informational, not gated:`)
    for (const p of explained) out.push(`      ${p} → ${local.get(p) ?? 'unspecified'}`)
    // Only the installer's OWN driver may be credited to the installer. Any
    // rule at all in `info/attributes` used to be described as "what
    // scripts/install-merge-drivers.sh installs" — so a hand-written local
    // `merge=binary` overlay was reported as the sanctioned upgrade, which
    // sends the reader to an installer that never wrote it.
    const fromInstaller = explained.every((p) => local.get(p) === INSTALLER_MERGE_DRIVER)
    out.push(
      fromInstaller
        ? `    that is what scripts/install-merge-drivers.sh installs, and it does not change the floor)`
        : `    that file is untracked, so it changes your merges and nobody else's, and it does`,
    )
    if (!fromInstaller) out.push('    not change the floor)')
  }
  for (const p of unexplained) {
    out.push(`   (this clone resolves ${p} → ${local.get(p) ?? 'unspecified'}, which differs from the`)
    out.push('    tracked floor above and is NOT explained by an untracked overlay — the usual cause is')
    out.push('    an UNCOMMITTED edit to a .gitattributes (staged or not: neither travels), which')
    out.push('    changes your merges and nobody else\'s.')
    out.push('    Informational, not gated.)')
  }
  return out
}

if (failing.length === 0) {
  const detail = present.map((p) => `${p} (merge=union)`).join(', ')
  console.log(`✅ governed-repo attributes OK — git resolves ${detail} from the tracked files`)
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
console.error('   git check-attr, over the tracked attributes files alone, resolves:')
console.error(
  attributesFiles.length === 0
    ? '   (no tracked .gitattributes reaches this log)'
    : `   (from ${attributesFiles.map((f) => f.path).join(', ')})`,
)

for (const path of failing) {
  const driver = tracked.get(path) ?? null
  console.error('')
  console.error(`     ${path} → merge=${driver ?? 'unspecified'}`)

  if (driver === null) {
    console.error(`       No rule reaches this path. Add to .gitattributes:`)
    console.error(`         ${unionAttributeLine(path)}`)
  } else if ((MERGE_ATTRIBUTE_STATES as readonly string[]).includes(driver)) {
    // `set`/`unset` are attribute STATES, not driver names. Saying "no
    // merge.set.driver config" sends the reader after a config key git has
    // never had.
    console.error(`       '${driver}' is not a driver name — it is what git reports for a bare`)
    if (driver === 'set') {
      console.error(`       '<path> merge' rule. Measured on git 2.50.1: that is the ordinary text`)
      console.error(`       merge, so this log still conflicts with markers on every concurrent append.`)
    } else {
      console.error(`       '<path> -merge' rule. Measured on git 2.50.1: git then treats the file as`)
      console.error(`       BINARY — 'Cannot merge binary files', ours kept whole, the other side's`)
      console.error(`       entries dropped from the working file entirely.`)
    }
    console.error(`       Write the driver out in full:`)
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

  // Name the lines that are actually in the files. When the union line IS there
  // and something later beats it, "add this line" is unactionable advice — the
  // line is already there and the reader needs to be shown the override.
  const rules = mergeRulesAcross(attributesFiles, path)
  const only = rules.length === 1 ? rules[0] : undefined
  if (rules.length > 1) {
    console.error(`       ${rules.length} tracked rules assign this exact path; the LAST wins:`)
    for (const rule of rules) console.error(`         ${rule.file} line ${rule.line}: ${rule.text}`)
  } else if (only !== undefined && only.driver !== driver) {
    console.error(`       ${only.file} line ${only.line} says '${only.text}', but a later`)
    console.error(`       or broader pattern overrides it — git's answer above is the one that counts.`)
  }
}

process.exit(1)
