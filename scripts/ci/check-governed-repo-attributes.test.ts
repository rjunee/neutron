/**
 * Subprocess self-tests for scripts/ci/check-governed-repo-attributes.ts — the
 * gate that asserts NO tracked rule assigns a merge driver to a governed repo's
 * FROZEN build log.
 *
 * THE POLARITY IS THE OPPOSITE OF WHAT IT WAS, and every fixture below reads
 * that way now. While the log was append-only the gate REQUIRED `merge=union`;
 * the log is frozen (`docs/AS_BUILT.md:5`) and the live record is one file per
 * change under `docs/as-built/`, so union has nothing left to resolve and, on a
 * file nobody may write, an attribute that can never report a conflict would
 * silently double an edit instead of stopping it. A `merge=union` line is
 * therefore now the BROKEN fixture and an absent rule is the healthy one.
 *
 * WHY SUBPROCESS AND NOT UNIT. The gate shipped with 17 green unit tests over
 * its pure helpers and an in-memory probe, and NOTHING executed the gate. Three
 * false successes lived underneath that green: a `.gitattributes` whose union
 * line was overridden by a later rule, one overridden by a later wildcard, and
 * one overridden by a `docs/.gitattributes` the gate never read. All three are
 * covered below, and all three fail without the fix — the helper tests cannot
 * see any of them, because the bug was never in a helper. It was in deciding
 * the verdict from a helper at all.
 *
 * Every case runs the REAL gate against a THROWAWAY fixture directory, so no
 * assertion depends on the state of this repo, and each asserts BOTH the exit
 * code and the output, because a gate that exits 1 with the wrong explanation
 * sends the next reader to the wrong file.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('./check-governed-repo-attributes.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Everything a fixture commit needs from the machine it runs on, pinned.
 *
 * `commit.gpgsign=false` is the load-bearing one: a maintainer with
 * `commit.gpgSign = true` set globally has every fixture below reach for a
 * signing key, which fails on a machine without one and BLOCKS on a pinentry
 * prompt on a machine with one — in a suite that is supposed to be unattended.
 */
const COMMIT_IDENTITY_PIN = [
  '-c',
  'user.email=a@b',
  '-c',
  'user.name=a',
  '-c',
  'commit.gpgsign=false',
] as const

const created: string[] = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/**
 * A throwaway directory shaped like a repo. `governed` writes the root SPEC.md
 * that makes the convention apply; `attributes` is the root tracked file,
 * omitted entirely when undefined; `subAttributes` maps a directory to its own
 * `.gitattributes`.
 */
function fixture(opts: {
  governed?: boolean
  logs?: string[]
  attributes?: string
  subAttributes?: Record<string, string>
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'governed-attrs-'))
  created.push(dir)
  if (opts.governed !== false) writeFileSync(join(dir, 'SPEC.md'), '# spec\n')
  for (const log of opts.logs ?? ['docs/AS_BUILT.md']) {
    const path = join(dir, log)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '# log\n')
  }
  if (opts.attributes !== undefined) writeFileSync(join(dir, '.gitattributes'), opts.attributes)
  for (const [subdir, content] of Object.entries(opts.subAttributes ?? {})) {
    mkdirSync(join(dir, subdir), { recursive: true })
    writeFileSync(join(dir, subdir, '.gitattributes'), content)
  }
  return dir
}

/**
 * Make `dir` a real repo, COMMIT everything in it, and add the untracked
 * overlay the installer writes.
 *
 * Committing matters: the gate reads attributes from the COMMITTED TREE in a
 * repo, because neither an untracked nor a merely staged `.gitattributes`
 * reaches a clone, and neither may count as a floor. A fixture that only wrote
 * the file to disk would be asserting the opposite of the property.
 */
function initRepoWithOverlay(dir: string, overlay: string): void {
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', dir, ...COMMIT_IDENTITY_PIN, 'commit', '-qm', 'seed'],
    { stdio: 'pipe' },
  )
  mkdirSync(join(dir, '.git', 'info'), { recursive: true })
  writeFileSync(join(dir, '.git', 'info', 'attributes'), overlay)
}

function runGate(root: string, env?: NodeJS.ProcessEnv): { status: number; out: string } {
  const res = spawnSync('bun', [GATE, root], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    ...(env ? { env } : {}),
  })
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` }
}

/** A repo with everything committed — the tracked state a clone would get. */
function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, ...COMMIT_IDENTITY_PIN, 'commit', '-qm', 'seed'], {
    stdio: 'pipe',
  })
}

describe('check-governed-repo-attributes (subprocess)', () => {
  test('PASSES when no tracked rule reaches the frozen log', () => {
    const dir = fixture({ attributes: '# nothing assigns the frozen log a merge driver\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('✅')
    expect(out).toContain('merge unspecified')
  })

  test('FAILS when the tracked rule is still union', () => {
    // The line this change deleted from the repo's own .gitattributes. Re-adding
    // it is the regression this gate now exists to catch.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('FROZEN build log still has a merge driver')
    expect(out).toContain('docs/AS_BUILT.md → merge=union')
    expect(out).toContain('DELETE the rule')
    expect(out).toContain('.gitattributes line 1:')
  })

  test('reports the rule git actually resolved when a LATER duplicate overrides an earlier one', () => {
    // The reproduction the shipped gate reported ✅ on. git 2.50.1 resolves the
    // LAST matching rule, so the tracked floor here is `as-built-log`, not
    // union — and every fresh clone gets a plain content conflict on the log.
    const dir = fixture({
      attributes: 'docs/AS_BUILT.md merge=union\ndocs/AS_BUILT.md merge=as-built-log\n',
    })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('FROZEN build log still has a merge driver')
    expect(out).toContain('merge=as-built-log')
    // Both lines have to go, and the reader is shown both.
    expect(out).toContain('the LAST wins')
    expect(out).toContain('.gitattributes line 2:')
  })

  test('FAILS on a WILDCARD nobody wrote the log\'s name into', () => {
    // No exact-pattern matcher can see this one at all: the rule that reaches
    // the log is `docs/*.md`, which never contains the log's name.
    const dir = fixture({ attributes: 'docs/*.md merge=binary\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('merge=binary')
    expect(out).toContain('No exact-path rule assigns it')
  })

  test('FAILS on a rule in a SUBDIRECTORY .gitattributes, which the root file cannot show', () => {
    // The root file is clean. `docs/.gitattributes` outranks it for anything
    // under docs/, and a gate that reads only the root file reports ✅ over a
    // rule that is genuinely there in every clone.
    const dir = fixture({
      attributes: '# clean at the root\n',
      subAttributes: { docs: 'AS_BUILT.md merge=binary\n' },
    })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('docs/AS_BUILT.md → merge=binary')
    // It must NAME the subdirectory file, or the reader edits the root one,
    // sees the union line already there, and concludes the gate is broken.
    expect(out).toContain('docs/.gitattributes')
  })

  test('an UNTRACKED subdirectory override does NOT fail the gate — it reaches no clone', () => {
    // The mirror of the case above, and the reason the gate reads a committed
    // tree rather than the working tree. This clone's own git answers `binary`; a
    // fresh clone answers `unspecified`, and the tracked state is what travels.
    const dir = fixture({ attributes: '# clean at the root\n' })
    initRepoWithOverlay(dir, '')
    writeFileSync(join(dir, 'docs', '.gitattributes'), 'AS_BUILT.md merge=binary\n')

    // Control: this clone really does resolve to the untracked override.
    const local = execFileSync('git', ['-C', dir, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md'], {
      encoding: 'utf8',
    })
    expect(local.trim()).toBe('docs/AS_BUILT.md: merge: binary')

    const { status } = runGate(dir)
    expect(status).toBe(0)
  })

  describe('the floor is what is COMMITTED — the index does not travel', () => {
    /**
     * Clone `dir` for real and ask the clone. The only unarguable reading of
     * "what a fresh clone gets" is a fresh clone, so every case below carries
     * one as its control rather than asserting what git would do.
     */
    function cloneResolves(dir: string): string {
      const target = mkdtempSync(join(tmpdir(), 'governed-attrs-clone-'))
      created.push(target)
      rmSync(target, { recursive: true, force: true })
      execFileSync('git', ['clone', '-q', dir, target], { stdio: 'pipe' })
      return execFileSync('git', ['-C', target, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md'], {
        encoding: 'utf8',
      }).trim()
    }

    test('FAILS when the deletion of the union line is only STAGED, never committed', () => {
      // `git show :<path>` reads the INDEX, which holds staged work that reaches
      // nobody — so reading it would print ✅ over a rule every clone still gets.
      const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
      initRepo(dir)
      writeFileSync(join(dir, '.gitattributes'), '# staged deletion of the union line\n')
      execFileSync('git', ['-C', dir, 'add', '.gitattributes'], { stdio: 'pipe' })

      // Control: the index really has lost the union line...
      expect(
        execFileSync('git', ['-C', dir, 'show', ':.gitattributes'], { encoding: 'utf8' }),
      ).not.toContain('merge=union')
      // ...and a real clone really does still get it.
      expect(cloneResolves(dir)).toBe('docs/AS_BUILT.md: merge: union')

      const { status, out } = runGate(dir)
      expect(status).toBe(1)
      expect(out).toContain('merge=union')
    })

    test('PASSES when the committed tree is clean and a STAGED edit re-adds the rule', () => {
      // The other direction, and the reason this is not just "be stricter":
      // a gate that failed here would red every developer who is mid-edit on a
      // file every clone still resolves correctly.
      const dir = fixture({ attributes: '# clean\n' })
      initRepo(dir)
      writeFileSync(join(dir, '.gitattributes'), 'docs/AS_BUILT.md merge=union\n')
      execFileSync('git', ['-C', dir, 'add', '.gitattributes'], { stdio: 'pipe' })

      // Control: the index has the line, the clone has not.
      expect(
        execFileSync('git', ['-C', dir, 'show', ':.gitattributes'], { encoding: 'utf8' }),
      ).toContain('merge=union')
      expect(cloneResolves(dir)).toBe('docs/AS_BUILT.md: merge: unspecified')

      const { status, out } = runGate(dir)
      expect(status).toBe(0)
      expect(out).toContain('✅')
    })

    test('a STAGED-only log is not a log to protect — it reaches no clone', () => {
      // Presence is read from the same source as the rule, or the two disagree
      // again in the other direction: the gate demands a floor for a file that
      // is not in any clone.
      const dir = fixture({ attributes: '# clean\n' })
      initRepo(dir)
      writeFileSync(join(dir, 'AS-BUILT.md'), '# staged, never committed\n')
      execFileSync('git', ['-C', dir, 'add', 'AS-BUILT.md'], { stdio: 'pipe' })

      // Control: the index lists it; the committed tree does not.
      expect(
        execFileSync('git', ['-C', dir, 'ls-files', '--', 'AS-BUILT.md'], { encoding: 'utf8' }).trim(),
      ).toBe('AS-BUILT.md')
      expect(
        execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'AS-BUILT.md'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('')

      const { status, out } = runGate(dir)
      expect(status).toBe(0)
      expect(out).not.toContain('AS-BUILT.md → merge=')
    })

    test('an UNBORN HEAD falls back to the index rather than reporting nothing to enforce', () => {
      // A repo with no commits has no tree to read, and refusing to answer would
      // exit 0 with "no build log found" over a repo whose first commit is about
      // to ship a rule that should not exist. Measured on git 2.50.1:
      // `rev-parse --verify --quiet HEAD` exits 1 here, and `ls-tree -r HEAD` is
      // `fatal: Not a valid object name HEAD`.
      const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
      execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' })
      execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' })

      // Control: HEAD really is unborn.
      expect(
        spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD']).status,
      ).not.toBe(0)

      const { status, out } = runGate(dir)
      expect(status).toBe(1)
      expect(out).toContain('merge=union')
    })
  })

  test('PASSES when no rule reaches the log at all', () => {
    const dir = fixture({ attributes: '# nothing here\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('✅')
  })

  test('PASSES when .gitattributes is absent entirely', () => {
    const dir = fixture({})
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('✅')
  })

  test('FAILS on another BUILT-IN driver — no driver is the right one now', () => {
    const dir = fixture({ logs: ['AS-BUILT.md'], attributes: 'AS-BUILT.md merge=binary\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain("'binary' is one of git's built-in drivers")
    expect(out).toContain('not correct on a frozen one')
  })

  test('FAILS on a CUSTOM driver, and says what git actually does', () => {
    // Measured on git 2.50.1: with no merge.<name>.* config the merge does NOT
    // abort — it falls back to the text merge and conflicts. The gate's old
    // text promised exit 128 unconditionally, which is a different case.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=as-built-log\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('is a CUSTOM driver')
    expect(out).toContain('falls back to the ordinary text merge')
    expect(out).toContain('this log takes no rule at all')
    // The corrected claim must not be re-asserted as the unconditional one.
    expect(out).not.toContain('breaks every fresh clone')
  })

  test('a bare `merge` rule is reported as the STATE it is, not as a driver', () => {
    // git check-attr answers `set` here. Calling that "a CUSTOM driver" and
    // telling the reader there is no `merge.set.*` config names a config key
    // git has never had, and sends them to invent one.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('merge=set')
    expect(out).toContain('is not a driver name')
    expect(out).toContain("bare '<path> merge' rule")
    expect(out).toContain('DELETE the rule')
    expect(out).not.toContain('merge.set.')
    expect(out).not.toContain("'set' is a CUSTOM driver")
  })

  test('a `-merge` rule is reported as unset, and named both ways it can be written', () => {
    // `unset` is an attribute STATE, and the reader has to be able to find the
    // line: it is either '<path> -merge' or the built-in 'binary' MACRO, which
    // expands to '-diff -merge -text' and contains no `merge` token at all.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md -merge\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('merge=unset')
    expect(out).toContain('is not a driver name')
    expect(out).toContain("'<path> -merge'")
    expect(out).not.toContain('merge.unset.')
  })

  test('PASSES an UNGOVERNED directory untouched — no SPEC.md, nothing to enforce', () => {
    const dir = fixture({ governed: false, attributes: '# nothing here\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('not a governed repo')
  })

  test('a `binary` MACRO is not reported as a `-merge` rule the reader never wrote', () => {
    // Measured on git 2.50.1: the built-in `binary` macro expands to
    // `-diff -merge -text`, so check-attr answers `merge: unset` from a line
    // with no `merge` token in it. Telling that reader "your '<path> -merge'
    // rule" sends them grepping for a string their repo does not contain.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md binary\n' })
    initRepo(dir)

    // Control: git really does report `unset` for the macro.
    expect(
      execFileSync('git', ['-C', dir, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('docs/AS_BUILT.md: merge: unset')

    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('merge=unset')
    // Both spellings named, so whichever one is in the file, the reader finds it.
    expect(out).toContain("'binary' MACRO")
    expect(out).toContain('-diff -merge -text')
  })

  test('a WILDCARD beating duplicate exact rules is not reported as "the LAST wins"', () => {
    // Both exact rules lose to `docs/*.md`. Printing them under "the LAST wins"
    // points at line 2, the reader edits line 2, the wildcard still wins, and
    // the gate stays red for a reason its own output denied.
    const dir = fixture({
      attributes: 'docs/AS_BUILT.md merge=union\ndocs/AS_BUILT.md merge=union\ndocs/*.md merge=binary\n',
    })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('merge=binary')
    expect(out).toContain('NONE of them is what')
    expect(out).toContain('broader pattern overrides them all')
    expect(out).not.toContain('the LAST wins')
  })

  test('a governed repo whose SPEC.md is COMMITTED but not checked out is still gated', () => {
    // A sparse checkout has the spec in the tree and not on disk. Deciding
    // governedness from disk alone turned the whole gate off there — exit 0,
    // "not a governed repo", over a floor nothing had looked at.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
    initRepo(dir)
    rmSync(join(dir, 'SPEC.md'), { force: true })

    // Control: the spec is gone from disk and present in the tree.
    expect(existsSync(join(dir, 'SPEC.md'))).toBe(false)
    expect(
      execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'SPEC.md'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('SPEC.md')

    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).not.toContain('not a governed repo')
  })

  test('an overlay with merge.<name>.name but no .driver is called HALF-INSTALLED', () => {
    // The overlay binds `merge=as-built-log` and `.name` is set with `.driver`
    // absent. Measured on git 2.50.1, that is `fatal: custom merge driver
    // as-built-log lacks command line.` — exit 128, no merge at all. Crediting
    // it to install-merge-drivers.sh describes the one state that merges nothing
    // as the sanctioned upgrade.
    const dir = fixture({ attributes: '# clean\n' })
    initRepoWithOverlay(dir, 'docs/AS_BUILT.md merge=as-built-log\n')
    execFileSync('git', ['-C', dir, 'config', 'merge.as-built-log.name', 'entry-aware'], { stdio: 'pipe' })

    const { status, out } = runGate(dir)
    expect(status).toBe(0) // the TRACKED state is clean; this is informational
    expect(out).toContain('HALF-INSTALLED')
    expect(out).toContain('(exit 128)')
    expect(out).not.toContain('install-merge-drivers.sh installs')
  })

  test('an overlay with NO merge.<name>.* config is not reported as the exit-128 abort', () => {
    // The near-miss in this very change: reading only `.driver` cannot tell
    // "half-installed" from "not installed at all", and they are different git
    // outcomes. Measured on git 2.50.1: with NEITHER key set git falls back to
    // the ordinary text merge — exit 1, CONFLICT (content) — which is not fatal.
    // Printing "exit 128" here would be exactly the kind of confident wrong
    // sentence about git this gate exists to stop producing.
    const dir = fixture({ attributes: '# clean\n' })
    initRepoWithOverlay(dir, 'docs/AS_BUILT.md merge=as-built-log\n')

    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('NO merge.as-built-log.* config at all')
    expect(out).toContain('ordinary text merge')
    expect(out).not.toContain('lacks command line')
    expect(out).not.toContain('install-merge-drivers.sh installs')
  })

  test('PASSES a governed repo with no build log to protect', () => {
    const dir = fixture({ logs: [], attributes: '# nothing here\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('no build log found')
  })

  test('checks EVERY log a repo keeps — the FIRST one being fine does not end the check', () => {
    // The candidate order is AS_BUILT.md, AS-BUILT.md, docs/AS_BUILT.md, so the
    // FIRST log present here is AS-BUILT.md and it is CONFORMANT. Only the
    // second is broken.
    //
    // That arrangement is the whole point. The previous version of this test
    // made the first present log the broken one, so a gate that checked only
    // `present[0]` stayed green through it and the "every log" property was
    // never exercised. Mutation-proved before landing: replacing the failing
    // filter with a `present[0]`-only check makes THIS test fail (gate exits 0)
    // and left the old version passing.
    const dir = fixture({
      logs: ['docs/AS_BUILT.md', 'AS-BUILT.md'],
      attributes: 'docs/AS_BUILT.md merge=union\n',
    })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('docs/AS_BUILT.md → merge=union')
    // ...and the conformant first log is NOT reported as failing.
    expect(out).not.toContain('AS-BUILT.md → merge=')
  })

  test('a local overlay does NOT paper over a tracked rule that every clone still gets', () => {
    // The layering this gate has to keep straight. The untracked
    // $GIT_COMMON_DIR/info/attributes OUTRANKS .gitattributes, and `!merge`
    // there un-specifies the attribute — so in this clone git answers
    // `unspecified` for a repo that still TRACKS `merge=union`. Asking the clone
    // would pass it. What travels is what counts; the local override does not.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
    initRepoWithOverlay(dir, 'docs/AS_BUILT.md !merge\n')
    // Control: this clone really is talked out of the tracked rule.
    const local = execFileSync('git', ['-C', dir, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md'], {
      encoding: 'utf8',
    })
    expect(local.trim()).toBe('docs/AS_BUILT.md: merge: unspecified')

    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('merge=union')
  })

  test('a clean tracked state PLUS a FULLY installed local overlay passes, and names the overlay', () => {
    const dir = fixture({ attributes: '# clean\n' })
    initRepoWithOverlay(dir, 'docs/AS_BUILT.md merge=as-built-log\n')
    // The driver config is half of the install, and the credit below is only
    // true when it is present — the other half is its own test. The overlay is
    // not gated either way: it is this machine's business.
    execFileSync('git', ['-C', dir, 'config', 'merge.as-built-log.driver', 'true %A'], { stdio: 'pipe' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('✅')
    expect(out).toContain('informational, not gated')
    expect(out).toContain('as-built-log')
    expect(out).toContain('install-merge-drivers.sh installs')
    expect(out).not.toContain('HALF-INSTALLED')
    // The note must point at the actual file it read, not at an "untracked
    // overlay" it assumed was there.
    expect(out).toContain(join('info', 'attributes'))
  })

  test('an UNEXPLAINED local divergence is reported as unexplained, not as a harmless upgrade', () => {
    // The tracked state is clean IN THE INDEX and this clone answers something else,
    // with no overlay to account for it — here because .gitattributes has an
    // uncommitted edit. Blaming the installer for that is a claim the gate
    // cannot support, and it reads as reassurance at the exact moment something
    // unaccounted-for is rewriting this developer's merges.
    const dir = fixture({ attributes: '# clean\n' })
    initRepoWithOverlay(dir, '')
    rmSync(join(dir, '.git', 'info', 'attributes'), { force: true })
    writeFileSync(join(dir, '.gitattributes'), 'docs/AS_BUILT.md merge=binary\n')

    // Control: the committed tree assigns nothing, and this working tree does.
    expect(
      execFileSync('git', ['-C', dir, 'show', ':.gitattributes'], { encoding: 'utf8' }).trim(),
    ).toBe('# clean')
    expect(
      execFileSync('git', ['-C', dir, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('docs/AS_BUILT.md: merge: binary')

    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('NOT explained by an untracked overlay')
    expect(out).toContain('UNCOMMITTED edit')
    expect(out).not.toContain('install-merge-drivers.sh installs')
  })

  test('an overlay WILDCARD is still credited as the explanation, not called unexplained', () => {
    // The attribution asks git with the overlay layered on, rather than
    // searching the overlay text for the path. `docs/*.md` never contains the
    // string `docs/AS_BUILT.md`, and a substring check would have reported this
    // as an unaccounted-for divergence on every machine running the installer
    // with a glob binding.
    const dir = fixture({ attributes: '# clean\n' })
    initRepoWithOverlay(dir, 'docs/*.md merge=as-built-log\n')
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('informational, not gated')
    expect(out).not.toContain('NOT explained')
  })

  test('an overlay that is NOT the installer\'s driver is not credited to the installer', () => {
    // Any rule at all in `info/attributes` used to be described as "what
    // scripts/install-merge-drivers.sh installs". A hand-written local
    // `merge=binary` is not, and saying so sends the reader to a script that
    // never wrote the line — while calling a driver that DROPS the other side's
    // entries a sanctioned upgrade.
    const dir = fixture({ attributes: '# clean\n' })
    initRepoWithOverlay(dir, 'docs/AS_BUILT.md merge=binary\n')
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('informational, not gated')
    expect(out).toContain('binary')
    expect(out).not.toContain('install-merge-drivers.sh installs')
    expect(out).toContain("changes your merges and nobody else's")
  })

  test('an UNTRACKED log does not fail a repo whose tracked floor is perfect', () => {
    // Presence was read from DISK while the rule was read from the INDEX. A
    // stray `AS-BUILT.md` in someone's working tree then made the gate answer
    // for a file that reaches no clone.
    const dir = fixture({ attributes: '# clean\n' })
    initRepo(dir)
    writeFileSync(join(dir, 'AS-BUILT.md'), '# stray, never committed\n')

    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('✅')
    expect(out).not.toContain('AS-BUILT.md')
  })

  describe('a poisoned environment cannot flip the verdict', () => {
    /** A committed repo that still TRACKS a merge rule for the frozen log. */
    function brokenRepo(): string {
      const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
      initRepo(dir)
      return dir
    }

    /** A committed repo that assigns the frozen log nothing. */
    function healthyRepo(): string {
      const dir = fixture({ attributes: '# nothing assigns the frozen log a merge driver\n' })
      initRepo(dir)
      return dir
    }

    // Every one of these was measured as a verdict drawn from the WRONG REPO
    // before the isolation reached the reads that feed the probe. This repo runs
    // `scripts/ci` gates from git hooks, and git exports GIT_DIR /
    // GIT_INDEX_FILE into a hook's environment itself.
    const poisons: Array<[string, (healthy: string) => NodeJS.ProcessEnv]> = [
      ['GIT_DIR points at a healthy repo', (h) => ({ GIT_DIR: join(h, '.git') })],
      [
        'GIT_INDEX_FILE + GIT_OBJECT_DIRECTORY come from a healthy repo',
        (h) => ({ GIT_INDEX_FILE: join(h, '.git', 'index'), GIT_OBJECT_DIRECTORY: join(h, '.git', 'objects') }),
      ],
    ]

    for (const [name, build] of poisons) {
      test(`still FAILS a broken floor when ${name}`, () => {
        const healthy = healthyRepo()
        const broken = brokenRepo()
        const env = { ...process.env, ...build(healthy) }

        // Control: the poison is real — unisolated git reads the other repo.
        expect(
          execFileSync('git', ['-C', broken, 'show', ':.gitattributes'], { encoding: 'utf8', env }),
        ).not.toContain('merge=union')

        const { status } = runGate(broken, env)
        expect(status).toBe(1)
      })

      test(`still PASSES an intact floor when ${name}`, () => {
        // The other half: isolation that fails everything is not isolation.
        const healthy = healthyRepo()
        const broken = brokenRepo()
        const env = { ...process.env, ...build(broken) }
        const { status, out } = runGate(healthy, env)
        expect(status).toBe(0)
        expect(out).toContain('✅')
      })
    }

    test('still PASSES a clean repo when the DEFAULT global attributes file grants union', () => {
      // `$XDG_CONFIG_HOME/git/attributes` needs no config entry to be read, so
      // pinning GIT_CONFIG_GLOBAL does not reach it. A machine-local file must
      // not be able to red a repo that tracks nothing.
      const healthy = healthyRepo()
      const xdg = mkdtempSync(join(tmpdir(), 'governed-attrs-xdg-'))
      created.push(xdg)
      mkdirSync(join(xdg, 'git'), { recursive: true })
      writeFileSync(join(xdg, 'git', 'attributes'), 'docs/AS_BUILT.md merge=union\n')
      const env = { ...process.env, XDG_CONFIG_HOME: xdg }

      // Control: with that file in place, an unisolated git answers `union` for
      // a repo that tracks no such rule.
      expect(
        execFileSync('git', ['-C', healthy, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md'], {
          encoding: 'utf8',
          env,
        }).trim(),
      ).toBe('docs/AS_BUILT.md: merge: union')

      expect(runGate(healthy, env).status).toBe(0)
    })

    test('still PASSES a clean repo when an init TEMPLATE injects core.attributesFile', () => {
      const healthy = healthyRepo()
      const template = mkdtempSync(join(tmpdir(), 'governed-attrs-tmpl-'))
      created.push(template)
      const attrs = join(template, 'attrs')
      writeFileSync(attrs, 'docs/AS_BUILT.md merge=union\n')
      writeFileSync(join(template, 'config'), `[core]\n\tattributesFile = ${attrs}\n`)
      const env = { ...process.env, GIT_TEMPLATE_DIR: template }

      // Control: a repo born from that template carries the setting in its OWN
      // config, which outranks the global/system pins — so the probe's scratch
      // repo answered `union` for attributes it had never been shown.
      const control = mkdtempSync(join(tmpdir(), 'governed-attrs-tmplrepo-'))
      created.push(control)
      execFileSync('git', ['init', '-q', control], { stdio: 'pipe', env })
      expect(
        execFileSync(
          'git',
          ['-C', control, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md'],
          {
            encoding: 'utf8',
            env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_ATTR_NOSYSTEM: '1' },
          },
        ).trim(),
      ).toBe('docs/AS_BUILT.md: merge: union')

      expect(runGate(healthy, env).status).toBe(0)
    })
  })

  test('this repo — the governed tree the gate ships in — passes its own gate', () => {
    const { status, out } = runGate(REPO_ROOT)
    expect(out).toContain('docs/AS_BUILT.md')
    expect(status).toBe(0)
  })
})
