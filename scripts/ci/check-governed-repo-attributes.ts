#!/usr/bin/env bun
/**
 * CI conformance check: a governed repo leaves its FROZEN build log with no
 * merge driver at all.
 *
 * A governed repo is one with a `SPEC.md` at its git root (the Spec-Drift
 * Guardrails convention, the same test `detectRalphMode` uses). Those repos
 * keep an as-built log. While that log was APPEND-ONLY this gate required it to
 * resolve `merge=union`, because two open PRs conflicted by construction rather
 * than by subject and "keep both" was always the right resolution.
 *
 * THE LOG IS FROZEN NOW (`docs/AS_BUILT.md:5`) and the live record is one file
 * per change under `docs/as-built/`, so the requirement is inverted rather than
 * dropped. Union NEVER reports a conflict; on a file nobody may write, that
 * turns an edit that should have stopped someone into a silent doubling. Two
 * per-change files never conflict with each other, so there is nothing union
 * would still buy. The gate therefore fails when ANY tracked rule assigns the
 * log a merge driver, and passes when git resolves the path as unspecified.
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

import { join, resolve } from 'node:path'

import {
  BUILT_IN_MERGE_DRIVERS,
  clonedTreeContains,
  collectTrackedAttributesFiles,
  INSTALLER_MERGE_DRIVER,
  localEffectiveMergeDrivers,
  MERGE_ATTRIBUTE_STATES,
  mergeDriverConfig,
  mergeRulesAcross,
  presentAsBuiltLogs,
  resolveTrackedMergeDrivers,
  untrackedOverlayAttributes,
} from '@neutronai/trident/as-built-union-attribute.ts'

const root = process.argv[2] ?? process.cwd()

/**
 * THE LOG IS PROTECTED TWO WAYS, AND BOTH ARE GATED HERE.
 *
 * The rest of this file gates the tracked MERGE FLOOR — that a fresh clone
 * resolves `merge=union` over the log. That floor is what makes concurrent
 * appends resolvable; it is not what stops them. GitHub never runs merge drivers
 * server-side, so two branches that both prepend still arrive as a text conflict
 * on the PR. The second half of the rule is that no BRANCH writes the canonical
 * log at all — entries are staged under `.trident/as-built/` and the outer loop
 * folds them onto main after the merge lands.
 *
 * That second half lives in `as-built-write-guard.sh` and is invoked from here
 * because here is somewhere the repo can reach. The rule's first home was an
 * eleven-line step in `.github/workflows/ci.yml`, and no agent in this system can
 * write that file — the token is scoped `repo read:org`, `workflow` scope is
 * asserted ABSENT by test, and GitHub rejects the push outright. The `layering`
 * job already runs this gate unconditionally with `fetch-depth: 0`, which is
 * exactly what the guard needs: a required check with real history. The guard
 * reads its own event filter and base/head shas from the Actions payload, so the
 * whole rule is expressed in files the repo owns.
 *
 * A branch writing the log is a hard stop, so it is checked FIRST and the exit
 * code propagates verbatim (1 = wrote the log, 2 = the guard could not tell).
 * There is no value in also reporting the attribute verdict over a diff that is
 * already disqualified.
 *
 * SCOPED TO THIS REPO ON PURPOSE. This gate is also pointed at fixture repos by
 * its own tests. Inside Actions those runs would inherit the REAL PR's shas and
 * ask a fixture to resolve them — an exit 2 that says nothing about the fixture.
 * So the guard runs only when this gate is reading the repo it lives in.
 */
function guardBranchWritesOfCanonicalLog(): void {
  const here = import.meta.dir
  const ownRepoRoot = resolve(here, '../..')
  if (resolve(root) !== ownRepoRoot) return

  const guard = Bun.spawnSync(['bash', join(here, 'as-built-write-guard.sh')], {
    cwd: ownRepoRoot,
    env: { ...process.env, AS_BUILT_GUARD_ROOT: ownRepoRoot },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (guard.exitCode !== 0) process.exit(guard.exitCode)
}

guardBranchWritesOfCanonicalLog()

/**
 * MIGRATION ORDINAL COLLISIONS — the second repo-owned rule hosted here, for the
 * SAME reason as the one above and with the same evidence behind it.
 *
 * `migration-ordinal-guard.sh` landed on main with #404 and then ran NOWHERE: it
 * had zero callers for five days. Its own header says it "lives in the `layering`
 * job because that is the one job checked out with full history" — it never got
 * there, because reaching `ci.yml` needs `workflow` scope and this system's token
 * is `repo read:org`, with the absence asserted by test
 * (`github/__tests__/device-flow.test.ts`). So a guard written specifically to
 * stop an outage sat inert, which is the exact failure mode the guard above was
 * moved here to escape. A rule that runs nowhere is indistinguishable from a rule
 * nobody wrote.
 *
 * WHAT IT CATCHES. Nothing allocates migration ordinals, so two branches cut from
 * the same main both see the next integer as free and both take it. The runner
 * refuses a duplicate at boot — AFTER the collision has merged. On 2026-08-17
 * that was a live outage: a silently skipped ordinal shipped code writing columns
 * that did not exist, and every dispatch died on `no such column`.
 *
 * THIS FILE IS THE LAYERING JOB'S REACHABLE ENTRY POINT, and that is now its
 * second job rather than an accident. `layering` checks out at `fetch-depth: 0`
 * — its own step comment says a depth-1 checkout "has no origin/main to compare"
 * — which is precisely the base ref this guard needs.
 *
 * NO EVENT FILTER, because it does not need one and a wrong one would be worse.
 * On a push to main the tree's ordinals ARE the base's, name for name, so there
 * is no collision to find and the guard passes on its own logic rather than by
 * being skipped. It fails CLOSED on an unresolvable base ref and on parsing zero
 * migration files, so neither a shallow checkout nor a renamed directory can turn
 * it into a silent pass.
 *
 * SCOPED TO THIS REPO, like the guard above: this gate is pointed at fixture
 * repos by its own tests, and a fixture has no `migrations/` to answer for.
 */
function guardMigrationOrdinalCollisions(): void {
  const here = import.meta.dir
  const ownRepoRoot = resolve(here, '../..')
  if (resolve(root) !== ownRepoRoot) return

  const guard = Bun.spawnSync(['bash', join(here, 'migration-ordinal-guard.sh'), 'migrations'], {
    cwd: ownRepoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (guard.exitCode !== 0) process.exit(guard.exitCode)
}

guardMigrationOrdinalCollisions()

/**
 * THE AS-BUILT STAGING FLOOR — the third repo-owned rule hosted here, for the
 * same reason as the two above: `.github/workflows/` is unreachable to every
 * agent in this system, and `layering` already runs this gate unconditionally at
 * `fetch-depth: 0`.
 *
 * WHAT IT PREVENTS, MEASURED. A branch stages one record at
 * `.trident/as-built/<branch>.md` and the promoter moves it to
 * `docs/as-built/<slug>.md` on the base after the merge. When a promotion
 * consumes the LAST staged record the directory loses every tracked file, so it
 * stops existing in the tree — and the promotion commit is, file for file, a move
 * out of it into `docs/as-built/`. Git reads the pair as a directory rename, and
 * every open PR carrying a staged record acquires `CONFLICT (file location) …
 * suggesting it should perhaps be moved to docs/as-built/<name>.md`. On
 * 2026-09-12 that happened: one promotion emptied the directory and two of the
 * seven then-open PRs acquired that conflict. Its suggested resolution writes a
 * shard FROM A BRANCH, which is exactly what the one-writer rule forbids.
 *
 * One tracked non-record file in the directory removes the class, because git
 * skips directory-rename detection for a directory that still exists. THE RULE IS
 * PER-DIRECTORY, and that was measured rather than assumed: git decides rename
 * detection one directory at a time, and branch names in this repo carry a slash,
 * so records land under `.trident/as-built/fix/` far more often than at the top.
 * A lone `.trident/as-built/.gitkeep` leaves that subdirectory free to vanish and
 * the conflict fully intact — proved with real merges in
 * `trident/as-built-staging-floor-realgit.test.ts`, whose control arms show the
 * conflict appearing with no floor AND with a top-level floor only.
 *
 * So the guard refuses two things: a branch that removes the floor under
 * `.trident/as-built/` itself, and a proposed tree in which ANY directory holding
 * a staged record has no floor. The rule was prose in `docs/as-built/README.md`
 * first, and prose is advice to an agent that never read it (root
 * `AGENTS.md:65-67`) — so it is a machine-checked refusal now.
 *
 * Same propagation contract as the guards above (1 = removes the floor, 2 = could
 * not tell) and the same scoping to this repo, for the same reason: pointed at a
 * fixture repo inside Actions it would inherit the real PR's shas and answer
 * about the wrong tree.
 */
function guardStagingFloorDeletion(): void {
  const here = import.meta.dir
  const ownRepoRoot = resolve(here, '../..')
  if (resolve(root) !== ownRepoRoot) return

  const guard = Bun.spawnSync(['bash', join(here, 'as-built-staging-floor-guard.sh')], {
    cwd: ownRepoRoot,
    env: { ...process.env, AS_BUILT_STAGING_FLOOR_ROOT: ownRepoRoot },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (guard.exitCode !== 0) process.exit(guard.exitCode)
}

guardStagingFloorDeletion()

/** Is `SPEC.md` in the tree a fresh clone would get, even if not checked out? */
function specIsCommitted(dir: string): boolean {
  return clonedTreeContains(dir, ['SPEC.md']).length > 0
}

// Governedness is the union of DISK and the COMMITTED TREE, and it is the one
// question here decided that way — deliberately, because both halves of it fail
// in a direction that turns the whole gate off silently.
//
//   - disk alone: a repo whose SPEC.md is committed but NOT CHECKED OUT (a
//     sparse checkout, or a cone that excludes the root) reads as ungoverned,
//     and the gate exits 0 with "not a governed repo" over a floor it never
//     looked at.
//   - tree alone: a governed tree that has not committed its spec yet — the
//     first commit of a new repo, and every fixture in this gate's own tests —
//     reads as ungoverned too.
//
// Either way the failure is an exit 0 that looks like an answer. Taking the
// union costs at worst running a check that then finds nothing to enforce.
//
// What is GATED — the log and the rule reaching it — is still read from the
// COMMITTED TREE alone, because that is what a fresh clone gets. The index is
// not: it also holds staged-but-uncommitted work, and reading it printed ✅ over
// a floor that existed only in one working copy.
const isGoverned = (await Bun.file(`${root}/SPEC.md`).exists()) || specIsCommitted(root)
if (!isGoverned) {
  console.log(`governed-repo attributes: ${root} has no root SPEC.md — not a governed repo, nothing to enforce`)
  process.exit(0)
}

const present = presentAsBuiltLogs(root)

if (present.length === 0) {
  console.log('governed-repo attributes: no build log found — nothing to enforce')
  process.exit(0)
}

const attributesFiles = collectTrackedAttributesFiles(root, present)
const tracked = resolveTrackedMergeDrivers({ attributesFiles, paths: present })
// `null` is `git check-attr` reporting `unspecified` — no rule reaches the path,
// which is the whole requirement now. Every other answer is a rule to delete,
// including the attribute STATES `set`/`unset`: a bare `<path> merge` and a
// `<path> -merge` are both somebody deciding how this file merges, and nobody
// gets to decide that about a file nobody may write.
const failing = present.filter((path) => tracked.get(path) !== null)

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
    const namesInstaller = explained.every((p) => local.get(p) === INSTALLER_MERGE_DRIVER)
    // Naming the installer's driver is not the same as HAVING it, and the two
    // ways of not having it do DIFFERENT things. Measured on git 2.50.1:
    // `.name` set with `.driver` unset aborts the merge outright (`fatal: custom
    // merge driver <name> lacks command line.`, exit 128); with NEITHER key set
    // git just falls back to the ordinary text merge and conflicts. Crediting
    // either to the installer describes a broken clone as a sanctioned upgrade —
    // and reporting exit 128 for the neither-set case would be its own false
    // claim about git.
    const config = namesInstaller
      ? mergeDriverConfig(root, INSTALLER_MERGE_DRIVER)
      : { driver: null, name: null }
    if (namesInstaller && config.driver !== null) {
      out.push(`    that is what scripts/install-merge-drivers.sh installs, and it does not change the floor)`)
    } else if (namesInstaller && config.name !== null) {
      out.push(`    but merge.${INSTALLER_MERGE_DRIVER}.driver is NOT set while .name IS, so this clone is`)
      out.push(`    HALF-INSTALLED: measured on git 2.50.1, git aborts the merge with 'lacks command`)
      out.push(`    line' (exit 128) rather than merging at all. Re-run scripts/install-merge-drivers.sh,`)
      out.push(`    or scripts/install-merge-drivers.sh --uninstall. The floor itself is unaffected.)`)
    } else if (namesInstaller) {
      out.push(`    but this clone has NO merge.${INSTALLER_MERGE_DRIVER}.* config at all, so the binding`)
      out.push(`    does nothing: measured on git 2.50.1, git falls back to the ordinary text merge and`)
      out.push(`    this log conflicts with markers. Run scripts/install-merge-drivers.sh, or`)
      out.push(`    scripts/install-merge-drivers.sh --uninstall. The floor itself is unaffected.)`)
    } else {
      out.push(`    that file is untracked, so it changes your merges and nobody else's, and it does`)
      out.push('    not change the floor)')
    }
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
  const detail = present.map((p) => `${p} (merge unspecified)`).join(', ')
  console.log(`✅ governed-repo attributes OK — no tracked rule assigns a merge driver to ${detail}`)
  for (const line of localNote()) console.log(line)
  process.exit(0)
}
console.error('❌ governed-repo attributes: the FROZEN build log still has a merge driver.')
console.error('')
console.error('   This log no longer grows — it is the record up to its freeze date and new')
console.error('   records are one file per change under docs/as-built/. A merge attribute on it')
console.error('   can only do harm now: `union` never reports a conflict, so an edit that should')
console.error('   have stopped somebody gets silently doubled instead, and no other driver is any')
console.error('   safer on a file nobody is allowed to write. git\'s default is the loud one.')
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

  if (driver !== null && (MERGE_ATTRIBUTE_STATES as readonly string[]).includes(driver)) {
    // `set`/`unset` are attribute STATES, not driver names. Saying "delete the
    // merge=set rule" sends the reader looking for a token nobody wrote: `set`
    // comes from a bare `<path> merge`, and `unset` from `<path> -merge` OR from
    // the built-in `binary` MACRO, which expands to `-diff -merge -text` and
    // contains no `merge` token at all.
    console.error(`       '${driver}' is not a driver name — it is the attribute STATE git reports.`)
    console.error(
      driver === 'set'
        ? `       It comes from a bare '<path> merge' rule.`
        : `       It comes from '<path> -merge', or from the built-in 'binary' MACRO, which`,
    )
    if (driver !== 'set') console.error(`       expands to '-diff -merge -text'.`)
  } else if (driver !== null && (BUILT_IN_MERGE_DRIVERS as readonly string[]).includes(driver)) {
    console.error(`       '${driver}' is one of git's built-in drivers. It was correct here while this`)
    console.error(`       log was append-only; it is not correct on a frozen one.`)
  } else if (driver !== null) {
    console.error(`       '${driver}' is a CUSTOM driver, bound in a TRACKED attributes file — which`)
    console.error(`       does not even give a fresh clone that behaviour. Measured on git 2.50.1: a`)
    console.error(`       clone with no merge.${driver}.* config falls back to the ordinary text merge.`)
    console.error(`       Either way, this log takes no rule at all.`)
  }
  console.error(`       DELETE the rule. No replacement line goes in its place.`)

  // Name the lines that are actually in the files, so the reader can find the
  // rule to delete. "the LAST wins" is only true when the last EXACT-path rule is
  // in fact what git resolved: a later WILDCARD outranks every exact rule
  // collected here, and printing the list under that heading points at the wrong
  // line.
  const rules = mergeRulesAcross(attributesFiles, path)
  const last = rules.length > 0 ? rules[rules.length - 1] : undefined
  const listRules = () => {
    for (const rule of rules) console.error(`         ${rule.file} line ${rule.line}: ${rule.text}`)
  }
  if (rules.length === 0) {
    console.error(`       No exact-path rule assigns it, so a WILDCARD in one of the files above`)
    console.error(`       reaches this log — git's answer is the one that counts.`)
  } else if (last !== undefined && last.driver === driver) {
    console.error(
      rules.length > 1
        ? `       ${rules.length} tracked rules assign this exact path; the LAST wins:`
        : `       The rule is here:`,
    )
    listRules()
  } else {
    console.error(`       ${rules.length} tracked rule(s) assign this exact path and NONE of them is what`)
    console.error(`       git resolved, so a later or broader pattern overrides them all:`)
    listRules()
    console.error(`       git's answer above is the one that counts.`)
  }
}

process.exit(1)
