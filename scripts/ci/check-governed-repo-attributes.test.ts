/**
 * Subprocess self-tests for scripts/ci/check-governed-repo-attributes.ts — the
 * gate that asserts a governed repo's append-only build log is union-merged.
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('./check-governed-repo-attributes.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

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
 * Committing matters: the gate reads attributes from the INDEX in a repo,
 * because an untracked `.gitattributes` reaches no clone and must not count as
 * a floor. A fixture that only wrote the file to disk would be asserting the
 * opposite of the property.
 */
function initRepoWithOverlay(dir: string, overlay: string): void {
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'seed'],
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
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'seed'], {
    stdio: 'pipe',
  })
}

describe('check-governed-repo-attributes (subprocess)', () => {
  test('PASSES when the tracked rule is union', () => {
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('✅')
    expect(out).toContain('merge=union')
  })

  test('FAILS when a LATER duplicate rule overrides the union line', () => {
    // The reproduction the shipped gate reported ✅ on. git 2.50.1 resolves the
    // LAST matching rule, so the tracked floor here is `as-built-log`, not
    // union — and every fresh clone gets a plain content conflict on the log.
    const dir = fixture({
      attributes: 'docs/AS_BUILT.md merge=union\ndocs/AS_BUILT.md merge=as-built-log\n',
    })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('not union-merged')
    expect(out).toContain('merge=as-built-log')
    // The remediation must show the override, not tell the reader to add a line
    // that is already on line 1.
    expect(out).toContain('the LAST wins')
    expect(out).toContain('.gitattributes line 2:')
  })

  test('FAILS when a LATER WILDCARD overrides the exact-path union line', () => {
    // No exact-pattern matcher can see this one at all: the union line is
    // present, correct, and beaten by `docs/*.md`.
    const dir = fixture({
      attributes: 'docs/AS_BUILT.md merge=union\ndocs/*.md merge=binary\n',
    })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('merge=binary')
    expect(out).toContain('overrides it')
  })

  test('FAILS when a SUBDIRECTORY .gitattributes overrides the root union line', () => {
    // The root file is perfect. `docs/.gitattributes` outranks it for anything
    // under docs/, and a gate that reads only the root file reports ✅ over a
    // floor that is genuinely gone in every clone.
    const dir = fixture({
      attributes: 'docs/AS_BUILT.md merge=union\n',
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
    // The mirror of the case above, and the reason the gate reads the index
    // rather than the working tree. This clone's own git answers `binary`; a
    // fresh clone answers `union`, and the floor is what travels.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
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

  test('FAILS when no rule reaches the log at all', () => {
    const dir = fixture({ attributes: '# nothing here\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('unspecified')
    expect(out).toContain('docs/AS_BUILT.md merge=union')
  })

  test('FAILS when .gitattributes is absent entirely', () => {
    const dir = fixture({})
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('unspecified')
    expect(out).toContain('no tracked .gitattributes reaches this log')
  })

  test('FAILS on another BUILT-IN driver, which is not union', () => {
    // `binary` is somebody's choice and a fixer must not overwrite it — but the
    // property this gate holds is "the log union-merges", and binary does not.
    // A fixer must not overwrite; a gate must not bless. Same fact, two jobs.
    const dir = fixture({ logs: ['AS-BUILT.md'], attributes: 'AS-BUILT.md merge=binary\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain("'binary' is a built-in driver, but it is not union")
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
    expect(out).toContain('$GIT_COMMON_DIR/info/attributes')
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
    expect(out).toContain('ordinary text')
    expect(out).not.toContain('merge.set.')
    expect(out).not.toContain("'set' is a CUSTOM driver")
  })

  test('a `-merge` rule is reported as unset, with what git actually does to the file', () => {
    // Measured on git 2.50.1: `-merge` makes git treat the file as BINARY —
    // "Cannot merge binary files", ours kept whole, the other side's entries
    // silently absent. That is a worse outcome than a conflict and the text has
    // to say so.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md -merge\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('merge=unset')
    expect(out).toContain('is not a driver name')
    expect(out).toContain('BINARY')
    expect(out).not.toContain('merge.unset.')
  })

  test('PASSES an UNGOVERNED directory untouched — no SPEC.md, nothing to enforce', () => {
    const dir = fixture({ governed: false, attributes: '# nothing here\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('not a governed repo')
  })

  test('PASSES a governed repo with no build log to protect', () => {
    const dir = fixture({ logs: [], attributes: '# nothing here\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('no append-only build log found')
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
      attributes: 'AS-BUILT.md merge=union\n',
    })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('docs/AS_BUILT.md → merge=unspecified')
    // ...and the conformant first log is NOT reported as failing.
    expect(out).not.toContain('AS-BUILT.md → merge=')
  })

  test('a local overlay upgrade does NOT paper over a broken tracked floor', () => {
    // The layering this gate has to keep straight. `install-merge-drivers.sh`
    // binds the entry-aware driver in the untracked $GIT_COMMON_DIR/info/
    // attributes, which OUTRANKS .gitattributes — so in this clone git answers
    // `as-built-log` for a repo whose tracked union line is gone. Asking the
    // clone would pass it. The floor is what travels; the upgrade is not.
    const dir = fixture({ attributes: '# the union line was deleted\n' })
    initRepoWithOverlay(dir, 'docs/AS_BUILT.md merge=as-built-log\n')
    // Control: this clone really does resolve to the overlay.
    const local = execFileSync('git', ['-C', dir, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md'], {
      encoding: 'utf8',
    })
    expect(local.trim()).toBe('docs/AS_BUILT.md: merge: as-built-log')

    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('unspecified')
  })

  test('an intact floor PLUS a local upgrade passes, and names the overlay it came from', () => {
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
    initRepoWithOverlay(dir, 'docs/AS_BUILT.md merge=as-built-log\n')
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('✅')
    expect(out).toContain('informational, not gated')
    expect(out).toContain('as-built-log')
    // The note must point at the actual file it read, not at an "untracked
    // overlay" it assumed was there.
    expect(out).toContain(join('info', 'attributes'))
  })

  test('an UNEXPLAINED local divergence is reported as unexplained, not as a harmless upgrade', () => {
    // The floor is intact IN THE INDEX and this clone answers something else,
    // with no overlay to account for it — here because .gitattributes has an
    // uncommitted edit. Blaming the installer for that is a claim the gate
    // cannot support, and it reads as reassurance at the exact moment something
    // unaccounted-for is rewriting this developer's merges.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
    initRepoWithOverlay(dir, '')
    rmSync(join(dir, '.git', 'info', 'attributes'), { force: true })
    writeFileSync(join(dir, '.gitattributes'), 'docs/AS_BUILT.md merge=binary\n')

    // Control: the committed floor is union, and this working tree is not.
    expect(
      execFileSync('git', ['-C', dir, 'show', ':.gitattributes'], { encoding: 'utf8' }).trim(),
    ).toBe('docs/AS_BUILT.md merge=union')
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
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
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
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
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
    // stray `AS-BUILT.md` in someone's working tree then made the gate demand a
    // rule for a file that reaches no clone — a repo with a perfect tracked
    // floor failing on a file that is not in it.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
    initRepo(dir)
    writeFileSync(join(dir, 'AS-BUILT.md'), '# stray, never committed\n')

    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('✅')
    expect(out).not.toContain('AS-BUILT.md')
  })

  describe('a poisoned environment cannot flip the verdict', () => {
    /** A committed repo whose tracked union line is GONE. */
    function brokenRepo(): string {
      const dir = fixture({ attributes: '# the union line was deleted\n' })
      initRepo(dir)
      return dir
    }

    /** A committed repo whose tracked union line is intact. */
    function healthyRepo(): string {
      const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
      initRepo(dir)
      return dir
    }

    // Every one of these was measured as an exit-0 "✅ governed-repo attributes
    // OK" over a DELETED floor before the isolation reached the reads that feed
    // the probe. This repo runs `scripts/ci` gates from git hooks, and git
    // exports GIT_DIR / GIT_INDEX_FILE into a hook's environment itself.
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
        ).toContain('merge=union')

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

    test('still FAILS a broken floor when the DEFAULT global attributes file grants union', () => {
      // `$XDG_CONFIG_HOME/git/attributes` needs no config entry to be read, so
      // pinning GIT_CONFIG_GLOBAL does not reach it.
      const broken = brokenRepo()
      const xdg = mkdtempSync(join(tmpdir(), 'governed-attrs-xdg-'))
      created.push(xdg)
      mkdirSync(join(xdg, 'git'), { recursive: true })
      writeFileSync(join(xdg, 'git', 'attributes'), 'docs/AS_BUILT.md merge=union\n')
      const env = { ...process.env, XDG_CONFIG_HOME: xdg }

      // Control: with that file in place, an unisolated git answers `union` for
      // a repo that tracks no such rule.
      expect(
        execFileSync('git', ['-C', broken, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md'], {
          encoding: 'utf8',
          env,
        }).trim(),
      ).toBe('docs/AS_BUILT.md: merge: union')

      expect(runGate(broken, env).status).toBe(1)
    })

    test('still FAILS a broken floor when an init TEMPLATE injects core.attributesFile', () => {
      const broken = brokenRepo()
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

      expect(runGate(broken, env).status).toBe(1)
    })
  })

  test('this repo — the governed tree the gate ships in — passes its own gate', () => {
    const { status, out } = runGate(REPO_ROOT)
    expect(out).toContain('docs/AS_BUILT.md')
    expect(status).toBe(0)
  })
})
