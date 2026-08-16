/**
 * The rule that makes a governed repo's append-only log union-merged, and the
 * probe that decides whether it holds.
 *
 * The failure this file guards is not "the line is missing" — that is loud, and
 * the next conflict finds it. It is the SILENT ones, every one of which shipped
 * green at some point:
 *
 *   1. A union line that a LATER rule, a wildcard, or a SUBDIRECTORY
 *      `.gitattributes` overrides — the floor gone, the gate ✅.
 *   2. A probe whose isolation is asserted rather than real, so a caller's
 *      environment answers the question instead of the repository.
 *
 * Every git claim below is measured against real git in a throwaway repo, and
 * every isolation test carries an UNPINNED CONTROL proving the poison it defeats
 * was actually poisonous — otherwise "the pin worked" is indistinguishable from
 * "the attack never landed".
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AS_BUILT_CANDIDATES,
  checkAttrEnv,
  clonedTreeContains,
  collectTrackedAttributesFiles,
  INSTALLER_MERGE_DRIVER,
  localEffectiveMergeDrivers,
  mergeDriverConfig,
  mergeRulesAcross,
  mergeRulesFor,
  parseCheckAttrZ,
  presentAsBuiltLogs,
  relevantAttributesPaths,
  resolveTrackedMergeDrivers,
  unionAttributeLine,
  untrackedOverlayAttributes,
} from './as-built-union-attribute.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const LOG = 'docs/AS_BUILT.md'

const scratchDirs: string[] = []
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  scratchDirs.push(dir)
  return dir
}

function scratchRepo(): string {
  const dir = scratch('union-attr-realgit')
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' })
  return dir
}

/**
 * Everything a fixture commit needs from the machine it runs on, pinned.
 *
 * The identity halves are obvious. `commit.gpgsign=false` is the one that bites:
 * a maintainer with `commit.gpgSign = true` globally has every fixture commit
 * here reach for a signing key, and it fails — or worse, blocks on a pinentry
 * prompt in a suite that is supposed to be unattended. `log.showSignature` is
 * pinned for the same reason on the read side: it prepends signature blocks to
 * output some assertions read.
 */
const COMMIT_IDENTITY_PIN = [
  '-c',
  'user.email=a@b',
  '-c',
  'user.name=a',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'log.showSignature=false',
] as const

/** Write `files` into `dir` and commit them, so they are in the COMMITTED TREE. */
function commitFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, ...COMMIT_IDENTITY_PIN, 'commit', '-qm', 'seed'], { stdio: 'pipe' })
}

/** `git check-attr merge` in `dir`, as a plain string, for use as a CONTROL. */
function directCheckAttr(dir: string, path = LOG, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-C', dir, 'check-attr', 'merge', '--', path], {
    encoding: 'utf8',
    ...(env ? { env } : {}),
  }).trim()
}

function rootOnly(content: string): Array<{ path: string; content: string }> {
  return [{ path: '.gitattributes', content }]
}

describe('mergeRulesFor', () => {
  it('reports every active assignment with its line number and source file', () => {
    const attributes = `# lead\n${LOG} merge=union\n*.png binary\n${LOG} merge=as-built-log\n`
    expect(mergeRulesFor(attributes, LOG)).toEqual([
      { file: '.gitattributes', line: 2, text: `${LOG} merge=union`, driver: 'union' },
      { file: '.gitattributes', line: 4, text: `${LOG} merge=as-built-log`, driver: 'as-built-log' },
    ])
  })

  it('skips commented and unrelated lines', () => {
    expect(mergeRulesFor(`# ${LOG} merge=union\n*.md merge=union\n`, LOG)).toEqual([])
  })

  it('reads the merge attribute when other attributes share the line', () => {
    expect(mergeRulesFor('AS-BUILT.md text eol=lf merge=union\n', 'AS-BUILT.md')[0]?.driver).toBe('union')
  })

  it('does not match a different path that merely contains this one', () => {
    expect(mergeRulesFor(`${LOG}.bak merge=union\n`, LOG)).toEqual([])
  })
})

describe('mergeRulesAcross', () => {
  it('rewrites the pattern relative to each file, root first', () => {
    // The rule inside docs/ is spelled `AS_BUILT.md`, not `docs/AS_BUILT.md`.
    // Matching the root spelling against it is how a subdirectory override
    // became invisible to the diagnostic.
    const rules = mergeRulesAcross(
      [
        { path: 'docs/.gitattributes', content: 'AS_BUILT.md merge=binary\n' },
        { path: '.gitattributes', content: `${LOG} merge=union\n` },
      ],
      LOG,
    )
    expect(rules.map((r) => [r.file, r.driver])).toEqual([
      ['.gitattributes', 'union'],
      ['docs/.gitattributes', 'binary'],
    ])
  })

  it('ignores an attributes file that cannot reach the path', () => {
    expect(mergeRulesAcross([{ path: 'app/.gitattributes', content: 'AS_BUILT.md merge=binary\n' }], LOG)).toEqual([])
  })
})

describe('relevantAttributesPaths', () => {
  it('is the path\'s own directory and every ancestor, shallowest first', () => {
    expect(relevantAttributesPaths([LOG])).toEqual(['.gitattributes', 'docs/.gitattributes'])
    expect(relevantAttributesPaths(['AS-BUILT.md'])).toEqual(['.gitattributes'])
  })

  it('unions across several logs without duplicating the root', () => {
    expect(relevantAttributesPaths([LOG, 'AS-BUILT.md', 'a/b/L.md'])).toEqual([
      '.gitattributes',
      'a/.gitattributes',
      'docs/.gitattributes',
      'a/b/.gitattributes',
    ])
  })
})

describe('parseCheckAttrZ', () => {
  it('reads the NUL triples and maps unspecified to null', () => {
    const stream = ['a.md', 'merge', 'union', 'b.md', 'merge', 'unspecified', ''].join('\0')
    const parsed = parseCheckAttrZ(stream)
    expect(parsed.get('a.md')).toBe('union')
    expect(parsed.get('b.md')).toBeNull()
    expect(parsed.size).toBe(2)
  })
})

describe('AS_BUILT_CANDIDATES', () => {
  it('is EXACTLY the four log paths the two repos use', () => {
    // Pinned as a set, not as a shape. The previous version asserted only that
    // every entry contained the substring `BUILT`, which is true of
    // `docs/REBUILT-NOTES.md` and of any three of the four — so both dropping a
    // real candidate and adding a wrong one left it green, and the candidate
    // list is what decides which files get gated at all.
    expect([...AS_BUILT_CANDIDATES]).toEqual([
      'AS_BUILT.md',
      'AS-BUILT.md',
      'docs/AS_BUILT.md',
      'docs/AS-BUILT.md',
    ])
  })

  it('covers the append-only logs and nothing that is edited in place', () => {
    // SPEC.md and ISSUES.md are rewritten in place, and union would silently
    // double a rewrite instead of conflicting on it.
    expect(AS_BUILT_CANDIDATES).not.toContain('SPEC.md' as never)
    expect(AS_BUILT_CANDIDATES).not.toContain('ISSUES.md' as never)
  })

  it('names the log THIS repo actually keeps, so the gate is not vacuous here', () => {
    expect(AS_BUILT_CANDIDATES).toContain(LOG)
  })
})

describe('unionAttributeLine', () => {
  it('is the line a maintainer can paste', () => {
    expect(unionAttributeLine(LOG)).toBe(`${LOG} merge=union`)
  })
})

// ---------------------------------------------------------------------------
// REAL GIT. Everything above is a reading of text; this is the boundary where
// the verdict is actually decided.
// ---------------------------------------------------------------------------

describe('resolveTrackedMergeDrivers (real git)', () => {
  it('agrees with git that a LATER duplicate rule wins', () => {
    const attributes = `${LOG} merge=union\n${LOG} merge=as-built-log\n`
    // Control: git itself, asked directly in a throwaway repo, so this test
    // proves the expectation rather than assuming it.
    const repo = scratchRepo()
    writeFileSync(join(repo, '.gitattributes'), attributes)
    expect(directCheckAttr(repo)).toBe(`${LOG}: merge: as-built-log`)

    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly(attributes), paths: [LOG] }).get(LOG)).toBe(
      'as-built-log',
    )
  })

  it('agrees with git that a LATER WILDCARD beats an earlier exact path', () => {
    const attributes = `${LOG} merge=union\ndocs/*.md merge=binary\n`
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly(attributes), paths: [LOG] }).get(LOG)).toBe('binary')
  })

  it('agrees with git that a SUBDIRECTORY .gitattributes beats the root file', () => {
    // The blocker. Seeding the probe with only the root file answers `union`
    // here, which is a PASS over a floor that is genuinely broken.
    const files = [
      { path: '.gitattributes', content: `${LOG} merge=union\n` },
      { path: 'docs/.gitattributes', content: 'AS_BUILT.md merge=binary\n' },
    ]

    // Control 1: in a real repo carrying both files, git answers `binary`.
    const repo = scratchRepo()
    commitFiles(repo, {
      '.gitattributes': files[0]!.content,
      'docs/.gitattributes': files[1]!.content,
      [LOG]: '# log\n',
    })
    expect(directCheckAttr(repo)).toBe(`${LOG}: merge: binary`)

    // Control 2: and so does a FRESH CLONE of it — this is not a local artefact,
    // it is what every clone gets, which is precisely what the gate claims to
    // measure.
    const clone = scratch('union-attr-clone')
    rmSync(clone, { recursive: true, force: true })
    execFileSync('git', ['clone', '-q', repo, clone], { stdio: 'pipe' })
    scratchDirs.push(clone)
    expect(directCheckAttr(clone)).toBe(`${LOG}: merge: binary`)

    // And the probe agrees, because it is seeded with both files.
    expect(resolveTrackedMergeDrivers({ attributesFiles: files, paths: [LOG] }).get(LOG)).toBe('binary')
    // Mutation control: seeding ONLY the root file is the shipped bug, and it
    // really does produce the false PASS. If this ever stops being 'union', the
    // test above has stopped proving anything.
    expect(resolveTrackedMergeDrivers({ attributesFiles: [files[0]!], paths: [LOG] }).get(LOG)).toBe('union')
  })

  it('reports union for the plain case, and null when nothing matches', () => {
    // The positive control. Without it, a probe that had silently stopped
    // working would "confirm" every finding by reporting nothing everywhere.
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly(`${LOG} merge=union\n`), paths: [LOG] }).get(LOG)).toBe(
      'union',
    )
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly('# nothing\n'), paths: [LOG] }).get(LOG)).toBeNull()
    expect(resolveTrackedMergeDrivers({ attributesFiles: [], paths: [LOG] }).get(LOG)).toBeNull()
  })

  it('answers for several logs in one call', () => {
    const attributes = `${LOG} merge=union\nAS-BUILT.md merge=binary\n`
    const resolved = resolveTrackedMergeDrivers({ attributesFiles: rootOnly(attributes), paths: [LOG, 'AS-BUILT.md'] })
    expect(resolved.get(LOG)).toBe('union')
    expect(resolved.get('AS-BUILT.md')).toBe('binary')
  })

  it('is NOT swayed by the untracked overlay the entry-aware driver installs', () => {
    // scripts/install-merge-drivers.sh binds its driver in
    // $GIT_COMMON_DIR/info/attributes precisely because untracked outranks
    // tracked. A gate that asked the local clone would read that upgrade as the
    // floor and pass a repo whose tracked line had been deleted.
    const repo = scratchRepo()
    mkdirSync(join(repo, '.git', 'info'), { recursive: true })
    writeFileSync(join(repo, '.git', 'info', 'attributes'), `${LOG} merge=as-built-log\n`)
    writeFileSync(join(repo, '.gitattributes'), `${LOG} merge=union\n`)

    // Control: in THIS clone git really does answer with the overlay...
    expect(localEffectiveMergeDrivers(repo, [LOG])?.get(LOG)).toBe('as-built-log')
    // ...while the tracked floor, asked in isolation, is still union.
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly(`${LOG} merge=union\n`), paths: [LOG] }).get(LOG)).toBe(
      'union',
    )
  })

  it('asks nothing when there are no paths', () => {
    expect(resolveTrackedMergeDrivers({ attributesFiles: [], paths: [] }).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ISOLATION. Each case: a control proving the poison lands without the pin,
// then the assertion that the probe is unmoved by it.
// ---------------------------------------------------------------------------

describe('resolveTrackedMergeDrivers isolation (real git, each with an unpinned control)', () => {
  /** A repo with no attributes at all, plus a file naming a driver for LOG. */
  function poisonFixture(): { repo: string; attrs: string } {
    const repo = scratchRepo()
    writeFileSync(join(repo, '.gitattributes'), '# nothing\n')
    const home = scratch('union-attr-poison')
    const attrs = join(home, 'attrs')
    writeFileSync(attrs, `${LOG} merge=poisoned\n`)
    return { repo, attrs }
  }

  it('is NOT swayed by a machine-local global attributes file', () => {
    const { repo, attrs } = poisonFixture()
    const home = scratch('union-attr-home')
    const gitconfig = join(home, 'gitconfig')
    writeFileSync(gitconfig, `[core]\n\tattributesFile = ${attrs}\n`)

    // Control: the poison is real and does reach an uncovered path.
    expect(directCheckAttr(repo, LOG, { ...process.env, GIT_CONFIG_GLOBAL: gitconfig })).toBe(
      `${LOG}: merge: poisoned`,
    )

    const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig }
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly('# nothing\n'), paths: [LOG], env }).get(LOG)).toBeNull()
  })

  it('is NOT swayed by GIT_CONFIG_PARAMETERS — what `git -c` exports to every child', () => {
    const { repo, attrs } = poisonFixture()
    const poison = { GIT_CONFIG_PARAMETERS: `'core.attributesFile=${attrs}'` }

    // Control: with only the three old pins, this poison lands.
    expect(
      directCheckAttr(repo, LOG, {
        ...process.env,
        ...poison,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
      }),
    ).toBe(`${LOG}: merge: poisoned`)

    const env = { ...process.env, ...poison }
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly('# nothing\n'), paths: [LOG], env }).get(LOG)).toBeNull()
  })

  it('is NOT swayed by GIT_CONFIG_COUNT / KEY / VALUE — the numbered spelling', () => {
    const { repo, attrs } = poisonFixture()
    const poison = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.attributesFile',
      GIT_CONFIG_VALUE_0: attrs,
    }

    expect(
      directCheckAttr(repo, LOG, {
        ...process.env,
        ...poison,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
      }),
    ).toBe(`${LOG}: merge: poisoned`)

    const env = { ...process.env, ...poison }
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly('# nothing\n'), paths: [LOG], env }).get(LOG)).toBeNull()
  })

  it('is NOT swayed by GIT_DIR pointing at another repository', () => {
    const other = scratchRepo()
    mkdirSync(join(other, '.git', 'info'), { recursive: true })
    writeFileSync(join(other, '.git', 'info', 'attributes'), `${LOG} merge=from-other-repo\n`)
    const { repo } = poisonFixture()
    const poison = { GIT_DIR: join(other, '.git') }

    // Control: -C <repo> does NOT protect against this; the other repo answers.
    expect(
      directCheckAttr(repo, LOG, {
        ...process.env,
        ...poison,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
      }),
    ).toBe(`${LOG}: merge: from-other-repo`)

    const env = { ...process.env, ...poison }
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly(`${LOG} merge=union\n`), paths: [LOG], env }).get(LOG)).toBe(
      'union',
    )
  })

  it('is NOT swayed by GIT_ATTR_SOURCE, which reads attributes from a tree', () => {
    const repo = scratchRepo()
    commitFiles(repo, { '.gitattributes': `${LOG} merge=from-tree\n` })
    writeFileSync(join(repo, '.gitattributes'), '# nothing\n')
    const poison = { GIT_ATTR_SOURCE: 'HEAD' }

    // Control: the working file says nothing, and git answers from the tree.
    expect(
      directCheckAttr(repo, LOG, {
        ...process.env,
        ...poison,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
      }),
    ).toBe(`${LOG}: merge: from-tree`)

    const env = { ...process.env, ...poison }
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly('# nothing\n'), paths: [LOG], env }).get(LOG)).toBeNull()
  })

  it('is NOT swayed by an init template that ships its own info/attributes', () => {
    // `git init` copies $GIT_TEMPLATE_DIR (or init.templateDir) into the new
    // .git, and info/attributes is one of the files it will copy — which would
    // put a machine's opinion INSIDE the probe that exists to exclude it.
    const template = scratch('union-attr-template')
    mkdirSync(join(template, 'info'), { recursive: true })
    writeFileSync(join(template, 'info', 'attributes'), `${LOG} merge=from-template\n`)

    // Control: the template really does reach a freshly-initialised repo.
    const control = scratch('union-attr-templated')
    rmSync(control, { recursive: true, force: true })
    execFileSync('git', ['init', '-q', `--template=${template}`, control], { stdio: 'pipe' })
    scratchDirs.push(control)
    writeFileSync(join(control, '.gitattributes'), `${LOG} merge=union\n`)
    expect(directCheckAttr(control)).toBe(`${LOG}: merge: from-template`)

    const env = { ...process.env, GIT_TEMPLATE_DIR: template }
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly(`${LOG} merge=union\n`), paths: [LOG], env }).get(LOG)).toBe(
      'union',
    )
  })

  it('is NOT swayed by an init template whose CONFIG sets core.attributesFile', () => {
    // The template's `info/attributes` was removed after `init`; its `config`
    // was not, and a copied `core.attributesFile` is a REPO-LOCAL setting that
    // outranks the GIT_CONFIG_GLOBAL/SYSTEM pins. Different file in the same
    // directory, entirely different escape route.
    const template = scratch('union-attr-tmplcfg')
    const attrs = join(template, 'attrs')
    writeFileSync(attrs, `${LOG} merge=from-template-config\n`)
    writeFileSync(join(template, 'config'), `[core]\n\tattributesFile = ${attrs}\n`)

    // Control: a repo born from that template really does answer the poison,
    // even with every environment pin the old code applied.
    const control = scratch('union-attr-tmplcfg-repo')
    rmSync(control, { recursive: true, force: true })
    execFileSync('git', ['init', '-q', `--template=${template}`, control], { stdio: 'pipe' })
    scratchDirs.push(control)
    writeFileSync(join(control, '.gitattributes'), '# nothing\n')
    expect(
      directCheckAttr(control, LOG, {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
      }),
    ).toBe(`${LOG}: merge: from-template-config`)

    const env = { ...process.env, GIT_TEMPLATE_DIR: template }
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly('# nothing\n'), paths: [LOG], env }).get(LOG)).toBeNull()
  })

  it('is NOT swayed by the DEFAULT global attributes file, which needs no config', () => {
    // `$XDG_CONFIG_HOME/git/attributes` (or `~/.config/git/attributes`) is
    // consulted with no `core.attributesFile` set anywhere, so pinning
    // GIT_CONFIG_GLOBAL to /dev/null does not reach it. Measured on git 2.50.1
    // as an end-to-end false PASS over a repo whose union line was deleted.
    const xdg = scratch('union-attr-xdg')
    mkdirSync(join(xdg, 'git'), { recursive: true })
    writeFileSync(join(xdg, 'git', 'attributes'), `${LOG} merge=from-xdg-default\n`)
    const { repo } = poisonFixture()

    // Control: the three environment pins do NOT defeat it.
    expect(
      directCheckAttr(repo, LOG, {
        ...process.env,
        XDG_CONFIG_HOME: xdg,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
      }),
    ).toBe(`${LOG}: merge: from-xdg-default`)

    const env = { ...process.env, XDG_CONFIG_HOME: xdg }
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly('# nothing\n'), paths: [LOG], env }).get(LOG)).toBeNull()
  })
})

/**
 * The probe was isolated; the reads that FEED it were not.
 *
 * `collectTrackedAttributesFiles` decides which `.gitattributes` the probe is
 * shown, and it decides it with `git show :<path>` — which an ambient `GIT_DIR`
 * (or `GIT_INDEX_FILE` + `GIT_OBJECT_DIRECTORY`) silently re-points at another
 * repository. The probe downstream then answers correctly about the wrong repo,
 * and a correct answer to the wrong question is exactly the shape of failure
 * this module exists to stop. Both routes are measured below with a control.
 *
 * ⚠️ These tests hand the poison in EXPLICITLY, so they prove the isolation is
 * applied to the env this module is given — and they CANNOT prove it is applied
 * to the env it inherits. A call that simply omits `env` inherits the test
 * runner's clean environment and passes every assertion here. The AMBIENT case
 * is only observable across a process boundary, which is why
 * `scripts/ci/check-governed-repo-attributes.test.ts` runs the gate as a
 * subprocess under each poisoned environment. Mutation-proved both ways:
 * dropping `env` from the `git show` call leaves these four green and fails the
 * four subprocess ones; using the raw env instead of `checkAttrEnv` fails these.
 */
/**
 * `refs/replace/*` rewrites OBJECT READS, so it reaches the reads that feed the
 * probe rather than the probe itself — and it is a purely local reading: `git
 * clone` does not carry replace refs, and neither does `actions/checkout`.
 */
describe('a local git replace ref cannot forge the committed floor', () => {
  /** A repo whose committed `.gitattributes` is broken, with a healthy blob replacing it. */
  function replacedRepo(): { repo: string; healthy: string } {
    const repo = scratchRepo()
    commitFiles(repo, { '.gitattributes': '# broken, no union rule\n', [LOG]: '# log\n' })
    const broken = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD:.gitattributes'], {
      encoding: 'utf8',
    }).trim()
    const healthy = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], {
      encoding: 'utf8',
      input: `${LOG} merge=union\n`,
    }).trim()
    execFileSync('git', ['-C', repo, 'replace', broken, healthy], { stdio: 'pipe' })
    return { repo, healthy }
  }

  it('reads the COMMIT\'s blob, not the replacement — and matches a fresh clone', () => {
    const { repo } = replacedRepo()

    // Control 1: the replacement is real. An unisolated read hands back the
    // healthy blob for a commit that does not contain it.
    expect(
      execFileSync('git', ['-C', repo, 'show', 'HEAD:.gitattributes'], { encoding: 'utf8' }),
    ).toContain('merge=union')

    // Control 2: and a fresh clone — the thing the floor claim is ABOUT — does
    // not carry refs/replace/*, so it gets the broken file.
    const clone = scratch('union-attr-replace-clone')
    rmSync(clone, { recursive: true, force: true })
    execFileSync('git', ['clone', '-q', repo, clone], { stdio: 'pipe' })
    scratchDirs.push(clone)
    expect(readFileSync(join(clone, '.gitattributes'), 'utf8')).toBe('# broken, no union rule\n')

    // The module agrees with the clone, not with this machine's replace ref.
    expect(collectTrackedAttributesFiles(repo, [LOG])).toEqual([
      { path: '.gitattributes', content: '# broken, no union rule\n' },
    ])
  })

  it('is what checkAttrEnv pins, so the pin is visible rather than implied', () => {
    expect(checkAttrEnv({}).GIT_NO_REPLACE_OBJECTS).toBe('1')
  })
})

/**
 * `git init` writes `core.ignorecase = true` on a case-insensitive filesystem,
 * which every macOS `$TMPDIR` is — and the probe's scratch repo lives there.
 */
describe('the probe answers case-SENSITIVELY, like a Linux clone', () => {
  it('does not let a wrong-case rule satisfy the floor', () => {
    const attributes = 'docs/as_built.md merge=union\n'

    // Control, where the filesystem provides one. A scratch repo made exactly as
    // the probe makes one inherits `core.ignorecase` from `git init`'s probe of
    // $TMPDIR: true on macOS, absent on a Linux runner. Where it is true the
    // wrong-case rule really does resolve — that IS the false PASS. Where the
    // filesystem is case-sensitive there is nothing to defeat, and asserting the
    // poison would red CI for the platform being right.
    const repo = scratchRepo()
    writeFileSync(join(repo, '.gitattributes'), attributes)
    const ignorecase = spawnSync('git', ['-C', repo, 'config', '--get', 'core.ignorecase'], {
      encoding: 'utf8',
    }).stdout.trim()
    if (ignorecase === 'true') {
      expect(directCheckAttr(repo)).toBe(`${LOG}: merge: union`)
    } else {
      expect(directCheckAttr(repo)).toBe(`${LOG}: merge: unspecified`)
    }

    // Either way the probe answers case-SENSITIVELY, so the verdict is the one
    // the strictest clone gives — which is the clone the floor claim is about.
    expect(resolveTrackedMergeDrivers({ attributesFiles: rootOnly(attributes), paths: [LOG] }).get(LOG)).toBeNull()
  })

  it('still answers union for the correctly-spelled rule', () => {
    // The other half: a pin that fails everything is not a pin.
    expect(
      resolveTrackedMergeDrivers({ attributesFiles: rootOnly(`${LOG} merge=union\n`), paths: [LOG] }).get(LOG),
    ).toBe('union')
  })
})

describe('collectTrackedAttributesFiles isolation (real git, each with an unpinned control)', () => {
  /** A repo whose tracked floor is INTACT, to be pointed at from elsewhere. */
  function healthyRepo(): string {
    const repo = scratchRepo()
    commitFiles(repo, { '.gitattributes': `${LOG} merge=union\n`, [LOG]: '# log\n' })
    return repo
  }

  /** A repo whose tracked floor is GONE — the one that must keep failing. */
  function brokenRepo(): string {
    const repo = scratchRepo()
    commitFiles(repo, { '.gitattributes': '*.png binary\n', [LOG]: '# log\n' })
    return repo
  }

  it('is NOT swayed by GIT_DIR pointing at a healthy repository', () => {
    const healthy = healthyRepo()
    const broken = brokenRepo()
    const poison = { ...process.env, GIT_DIR: join(healthy, '.git') }

    // Control: `-C <broken>` does not protect `git show`; the healthy repo's
    // index answers, which is how a broken repo used to read as healthy.
    expect(execFileSync('git', ['-C', broken, 'show', ':.gitattributes'], { encoding: 'utf8', env: poison })).toContain(
      'merge=union',
    )

    expect(collectTrackedAttributesFiles(broken, [LOG], poison)).toEqual([
      { path: '.gitattributes', content: '*.png binary\n' },
    ])
  })

  it('is NOT swayed by GIT_INDEX_FILE + GIT_OBJECT_DIRECTORY from another repository', () => {
    const healthy = healthyRepo()
    const broken = brokenRepo()
    const poison = {
      ...process.env,
      GIT_INDEX_FILE: join(healthy, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: join(healthy, '.git', 'objects'),
    }

    // Control: the same two variables git itself exports into hooks.
    expect(execFileSync('git', ['-C', broken, 'show', ':.gitattributes'], { encoding: 'utf8', env: poison })).toContain(
      'merge=union',
    )

    expect(collectTrackedAttributesFiles(broken, [LOG], poison)).toEqual([
      { path: '.gitattributes', content: '*.png binary\n' },
    ])
  })
})

describe('presentAsBuiltLogs (real git)', () => {
  it('reports the logs the COMMITTED TREE carries', () => {
    const repo = scratchRepo()
    commitFiles(repo, { 'SPEC.md': '# spec\n', [LOG]: '# log\n' })
    expect(presentAsBuiltLogs(repo)).toEqual([LOG])
  })

  it('IGNORES a STAGED-but-uncommitted log, which reaches no clone either', () => {
    const repo = scratchRepo()
    commitFiles(repo, { 'SPEC.md': '# spec\n', [LOG]: '# log\n' })
    writeFileSync(join(repo, 'AS-BUILT.md'), '# staged, never committed\n')
    execFileSync('git', ['-C', repo, 'add', 'AS-BUILT.md'], { stdio: 'pipe' })

    // Control: `ls-files` lists it, so a presence check reading the index
    // demands a floor for a file the clone does not have.
    expect(
      execFileSync('git', ['-C', repo, 'ls-files', '--', 'AS-BUILT.md'], { encoding: 'utf8' }).trim(),
    ).toBe('AS-BUILT.md')

    expect(presentAsBuiltLogs(repo)).toEqual([LOG])
  })

  it('reads the INDEX when HEAD is UNBORN, so a first commit is still gated', () => {
    const repo = scratchRepo()
    writeFileSync(join(repo, 'AS-BUILT.md'), '# log\n')
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })
    expect(spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD']).status).not.toBe(0)
    expect(presentAsBuiltLogs(repo)).toEqual(['AS-BUILT.md'])
  })

  it('IGNORES an untracked log, which reaches no clone', () => {
    // Presence used to be read from disk while the RULE was read from the index.
    // A stray untracked `AS-BUILT.md` then made the gate demand a rule for a
    // file no clone has, failing a repo whose tracked floor was perfect.
    const repo = scratchRepo()
    commitFiles(repo, { 'SPEC.md': '# spec\n', [LOG]: '# log\n' })
    writeFileSync(join(repo, 'AS-BUILT.md'), '# stray\n')
    expect(presentAsBuiltLogs(repo)).toEqual([LOG])
  })

  it('falls back to disk outside a repository', () => {
    const dir = scratch('union-attr-logs-norepo')
    writeFileSync(join(dir, 'AS-BUILT.md'), '# log\n')
    expect(presentAsBuiltLogs(dir)).toEqual(['AS-BUILT.md'])
  })

  it('is NOT swayed by GIT_DIR pointing at another repository', () => {
    const other = scratchRepo()
    commitFiles(other, { 'AS-BUILT.md': '# other repo log\n' })
    const repo = scratchRepo()
    commitFiles(repo, { [LOG]: '# log\n' })
    const poison = { ...process.env, GIT_DIR: join(other, '.git') }

    // Control: the poison really does redirect an unisolated ls-files.
    expect(
      execFileSync('git', ['-C', repo, 'ls-files', '--', ...AS_BUILT_CANDIDATES], {
        encoding: 'utf8',
        env: poison,
      }).trim(),
    ).toBe('AS-BUILT.md')

    expect(presentAsBuiltLogs(repo, poison)).toEqual([LOG])
  })

  it('FAILS CLOSED when the committed tree cannot be read', () => {
    // It used to `catch { return [] }`, which the gate prints as "no
    // append-only build log found — nothing to enforce" and exits 0 on. So any
    // unreadable governed repo read as a clean bill of health — the one failure
    // direction this module is not allowed to have.
    const repo = scratchRepo()
    commitFiles(repo, { [LOG]: '# log\n' })

    // Control: it works before the object store is broken.
    expect(presentAsBuiltLogs(repo)).toEqual([LOG])

    // Break the read without breaking the repo: point HEAD at a branch that does
    // not exist (so the unborn-HEAD path is taken, which reads the index) and
    // corrupt the index it would read. Measured: `git ls-files` then exits 128
    // with `fatal: .git/index: index file smaller than expected`.
    execFileSync('git', ['-C', repo, 'symbolic-ref', 'HEAD', 'refs/heads/does-not-exist'], { stdio: 'pipe' })
    writeFileSync(join(repo, '.git', 'index'), 'GARBAGE-NOT-AN-INDEX')
    expect(spawnSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).status).toBe(128)

    expect(() => presentAsBuiltLogs(repo)).toThrow(/could not read the committed tree/)
  })
})

describe('clonedTreeContains', () => {
  it('answers for any path, which is how SPEC.md governedness survives a sparse checkout', () => {
    const repo = scratchRepo()
    commitFiles(repo, { 'SPEC.md': '# spec\n', [LOG]: '# log\n' })
    // Committed, then removed from the working tree — the shape a sparse
    // checkout leaves behind.
    rmSync(join(repo, 'SPEC.md'), { force: true })
    expect(existsSync(join(repo, 'SPEC.md'))).toBe(false)
    expect(clonedTreeContains(repo, ['SPEC.md'])).toEqual(['SPEC.md'])
  })

  it('does not invent a path the tree does not have', () => {
    const repo = scratchRepo()
    commitFiles(repo, { [LOG]: '# log\n' })
    expect(clonedTreeContains(repo, ['SPEC.md'])).toEqual([])
  })

  it('falls back to disk outside a repository', () => {
    const dir = scratch('union-attr-tree-norepo')
    writeFileSync(join(dir, 'SPEC.md'), '# spec\n')
    expect(clonedTreeContains(dir, ['SPEC.md'])).toEqual(['SPEC.md'])
  })
})

describe('mergeDriverConfig', () => {
  function withConfig(entries: Record<string, string>): string {
    const repo = scratchRepo()
    for (const [key, value] of Object.entries(entries)) {
      execFileSync('git', ['-C', repo, 'config', `merge.${INSTALLER_MERGE_DRIVER}.${key}`, value], { stdio: 'pipe' })
    }
    return repo
  }

  it('reports BOTH keys, because which one is missing changes what git does', () => {
    // The three states have three outcomes — exit 0, exit 128, exit 1 — so a
    // diagnostic that reads only `.driver` cannot tell the last two apart, and
    // saying "exit 128" over the neither-set case is a false claim about git.
    expect(mergeDriverConfig(withConfig({ name: 'entry-aware' }), INSTALLER_MERGE_DRIVER)).toEqual({
      driver: null,
      name: 'entry-aware',
    })
    expect(mergeDriverConfig(withConfig({ driver: 'true %A' }), INSTALLER_MERGE_DRIVER)).toEqual({
      driver: 'true %A',
      name: null,
    })
    expect(mergeDriverConfig(withConfig({}), INSTALLER_MERGE_DRIVER)).toEqual({ driver: null, name: null })
  })

  it('is empty outside a repository', () => {
    expect(mergeDriverConfig(scratch('union-attr-nodriver'), INSTALLER_MERGE_DRIVER)).toEqual({
      driver: null,
      name: null,
    })
  })
})

describe('INSTALLER_MERGE_DRIVER', () => {
  it('is the name the installer script actually binds', () => {
    // The diagnostic credits an untracked overlay to
    // `scripts/install-merge-drivers.sh` only when it names THIS driver. If the
    // shell script renames it and this constant does not follow, that credit
    // becomes a lie about which tool wrote the file.
    const installer = readFileSync(join(REPO_ROOT, 'scripts', 'install-merge-drivers.sh'), 'utf8')
    expect(installer).toContain(`DRIVER_NAME="${INSTALLER_MERGE_DRIVER}"`)
  })
})

describe('checkAttrEnv', () => {
  it('strips every redirection variable and applies the pins', () => {
    const out = checkAttrEnv({
      PATH: '/usr/bin',
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_CONFIG_PARAMETERS: "'core.attributesFile=/poison'",
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.attributesFile',
      GIT_CONFIG_VALUE_0: '/poison',
      GIT_CONFIG_KEY_11: 'core.attributesFile',
      GIT_ATTR_SOURCE: 'HEAD',
    })
    expect(out.PATH).toBe('/usr/bin')
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_KEY_11',
      'GIT_ATTR_SOURCE',
    ]) {
      expect(Object.hasOwn(out, key)).toBe(false)
    }
    expect(out.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(out.GIT_ATTR_NOSYSTEM).toBe('1')
  })

  it('deletes the key rather than setting it undefined', () => {
    // An `undefined` VALUE is not the same as an absent key: how a child process
    // reads it depends on the spawn implementation, and "GIT_DIR=undefined" is a
    // path. Absence is the only unambiguous spelling.
    const out = checkAttrEnv({ GIT_DIR: '/x' })
    expect('GIT_DIR' in out).toBe(false)
  })
})

describe('collectTrackedAttributesFiles (real git)', () => {
  it('collects the root and subdirectory files from the COMMITTED TREE', () => {
    const repo = scratchRepo()
    commitFiles(repo, {
      '.gitattributes': `${LOG} merge=union\n`,
      'docs/.gitattributes': 'AS_BUILT.md merge=binary\n',
      [LOG]: '# log\n',
    })
    expect(collectTrackedAttributesFiles(repo, [LOG])).toEqual([
      { path: '.gitattributes', content: `${LOG} merge=union\n` },
      { path: 'docs/.gitattributes', content: 'AS_BUILT.md merge=binary\n' },
    ])
  })

  it('IGNORES an untracked attributes file, which reaches no clone', () => {
    const repo = scratchRepo()
    commitFiles(repo, { '.gitattributes': `${LOG} merge=union\n`, [LOG]: '# log\n' })
    // Present on disk, absent from the committed tree.
    writeFileSync(join(repo, 'docs', '.gitattributes'), 'AS_BUILT.md merge=binary\n')

    // Control: this clone's git DOES honour it, which is why "read from disk"
    // would be the wrong reading of "what a fresh clone gets".
    expect(directCheckAttr(repo)).toBe(`${LOG}: merge: binary`)

    const files = collectTrackedAttributesFiles(repo, [LOG])
    expect(files.map((f) => f.path)).toEqual(['.gitattributes'])
    expect(resolveTrackedMergeDrivers({ attributesFiles: files, paths: [LOG] }).get(LOG)).toBe('union')
  })

  it('IGNORES a STAGED-but-uncommitted attributes file, which reaches no clone', () => {
    const repo = scratchRepo()
    commitFiles(repo, { '.gitattributes': '# the union line was deleted\n', [LOG]: '# log\n' })
    writeFileSync(join(repo, '.gitattributes'), `${LOG} merge=union\n`)
    execFileSync('git', ['-C', repo, 'add', '.gitattributes'], { stdio: 'pipe' })

    // Control: the INDEX carries the union line, so a gate reading `:<path>`
    // sees a floor that is in nobody else's clone.
    expect(
      execFileSync('git', ['-C', repo, 'show', ':.gitattributes'], { encoding: 'utf8' }),
    ).toContain('merge=union')

    expect(collectTrackedAttributesFiles(repo, [LOG])).toEqual([
      { path: '.gitattributes', content: '# the union line was deleted\n' },
    ])
  })

  it('reads the INDEX when HEAD is UNBORN, which is the only tree there could be', () => {
    const repo = scratchRepo()
    writeFileSync(join(repo, '.gitattributes'), `${LOG} merge=union\n`)
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })

    // Control: there is no HEAD to read.
    expect(spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD']).status).not.toBe(0)

    expect(collectTrackedAttributesFiles(repo, [LOG])).toEqual([
      { path: '.gitattributes', content: `${LOG} merge=union\n` },
    ])
  })

  it('falls back to disk outside a repository', () => {
    const dir = scratch('union-attr-norepo')
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, '.gitattributes'), `${LOG} merge=union\n`)
    writeFileSync(join(dir, 'docs', '.gitattributes'), 'AS_BUILT.md merge=binary\n')
    expect(collectTrackedAttributesFiles(dir, [LOG]).map((f) => f.path)).toEqual([
      '.gitattributes',
      'docs/.gitattributes',
    ])
  })

  it('returns nothing when there is no attributes file at all', () => {
    expect(collectTrackedAttributesFiles(scratch('union-attr-empty'), [LOG])).toEqual([])
  })

  it('reads from DISK for a governed tree NESTED inside a larger repo', () => {
    // An index path is always spelled from the repository top level, so
    // `git show :docs/.gitattributes` here would return the OUTER repo's file —
    // a confident answer to a different question. The nested tree's own files
    // are the ones being asked about.
    const outer = scratchRepo()
    commitFiles(outer, {
      'docs/.gitattributes': 'AS_BUILT.md merge=from-the-OUTER-repo\n',
      '.gitattributes': `${LOG} merge=from-the-OUTER-repo\n`,
    })
    const inner = join(outer, 'nested')
    mkdirSync(join(inner, 'docs'), { recursive: true })
    writeFileSync(join(inner, '.gitattributes'), `${LOG} merge=union\n`)

    // Control: git really does resolve an index path from the OUTER top level,
    // even with -C pointed at the nested directory.
    expect(
      execFileSync('git', ['-C', inner, 'show', ':.gitattributes'], { encoding: 'utf8' }),
    ).toContain('from-the-OUTER-repo')

    const files = collectTrackedAttributesFiles(inner, [LOG])
    expect(files).toEqual([{ path: '.gitattributes', content: `${LOG} merge=union\n` }])
    expect(resolveTrackedMergeDrivers({ attributesFiles: files, paths: [LOG] }).get(LOG)).toBe('union')
  })
})

describe('localEffectiveMergeDrivers (real git)', () => {
  it('returns null outside a repository rather than throwing', () => {
    expect(localEffectiveMergeDrivers(scratch('union-attr-nr'), [LOG])).toBeNull()
  })
})

describe('untrackedOverlayAttributes (real git)', () => {
  it('reads the overlay the installer writes', () => {
    const repo = scratchRepo()
    mkdirSync(join(repo, '.git', 'info'), { recursive: true })
    writeFileSync(join(repo, '.git', 'info', 'attributes'), `${LOG} merge=as-built-log\n`)
    const overlay = untrackedOverlayAttributes(repo)
    expect(overlay?.content).toContain('as-built-log')
    expect(overlay?.path).toContain(join('info', 'attributes'))
  })

  it('is null when the file does not exist, so a divergence cannot be blamed on it', () => {
    expect(untrackedOverlayAttributes(scratchRepo())).toBeNull()
  })

  it('is null outside a repository', () => {
    expect(untrackedOverlayAttributes(scratch('union-attr-noovl'))).toBeNull()
  })
})

/**
 * What git ACTUALLY does with each of these attributes, merged for real.
 *
 * Every claim in this module's docblocks and in the CI gate's remediation text
 * says "measured on git 2.50.1" — and until now nothing in the suite performed
 * a merge, so those sentences were prose that happened to be checked once by
 * hand. One of them had already been WRONG in shipped code and shipped
 * remediation (a custom driver with no config was described as a fatal
 * `lacks command line` abort in every fresh clone; it is an ordinary content
 * conflict). A reader debugging from a wrong sentence looks in the wrong place,
 * so the sentences are pinned to real merges here.
 *
 * So "2.50.1" in those docblocks is PROVENANCE — the machine a sentence was
 * first measured on — and these merges are what keep it true on every other
 * machine. The version test below records what git actually ran and asserts a
 * floor; it deliberately does not pin the number, because a version string is
 * not a behaviour and pinning it would red this suite on the Linux runner for a
 * reason unrelated to the property.
 */
describe('what git ACTUALLY does with each merge attribute (real merges)', () => {
  interface MergeOutcome {
    status: number
    output: string
    file: string
    markers: number
  }

  /**
   * One repo, one file, two branches editing the same region, merged.
   * `OURS` and `THEIRS` are each prepended at the top — the shape an
   * append-only log actually conflicts in.
   */
  function realMerge(attribute: string, config: Record<string, string> = {}): MergeOutcome {
    const repo = scratchRepo()
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...COMMIT_IDENTITY_PIN, ...args], { stdio: 'pipe' })

    for (const [key, value] of Object.entries(config)) git('config', key, value)
    writeFileSync(join(repo, '.gitattributes'), `${attribute}\n`)
    writeFileSync(join(repo, 'log.txt'), 'base\n')
    git('add', '-A')
    git('commit', '-qm', 'base')
    const trunk = execFileSync('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim()

    git('checkout', '-qb', 'other')
    writeFileSync(join(repo, 'log.txt'), 'THEIRS\nbase\n')
    git('commit', '-qam', 'theirs')
    git('checkout', '-q', trunk)
    writeFileSync(join(repo, 'log.txt'), 'OURS\nbase\n')
    git('commit', '-qam', 'ours')

    const merge = spawnSync('git', ['-C', repo, ...COMMIT_IDENTITY_PIN, 'merge', 'other'], {
      encoding: 'utf8',
    })
    const file = readFileSync(join(repo, 'log.txt'), 'utf8')
    return {
      status: merge.status ?? -1,
      output: `${merge.stdout}${merge.stderr}`,
      file,
      markers: file.split('\n').filter((l) => l.startsWith('<<<<<<<')).length,
    }
  }

  it('records the git it is running against, and is not hostage to a version string', () => {
    // The previous assertion was `toContain('git version 2.')` under a docblock
    // claiming the version was pinned "because 'measured on 2.50.1' stops being
    // a true statement the moment the runner's git differs". It accepted git
    // 2.0 — every git anyone has run this decade — so the docblock's promise and
    // the assertion were different claims, and the weaker one was the one that
    // ran.
    //
    // The promise is not repairable by tightening the number, because that is
    // not where the guarantee comes from. Pinning `2.50.1` would red this suite
    // on the Linux runner for reasons that have nothing to do with the property;
    // and it would still prove nothing, because a version string is not a
    // behaviour. THE GUARANTEE COMES FROM THE MERGES BELOW: every claim the
    // module's docblocks and the gate's remediation text make is re-performed
    // here, against whatever git is on this machine, on every run. `2.50.1` in
    // those docblocks is provenance — where the sentence came from — and the
    // tests are what keep it true.
    //
    // What is left for this test is a floor and a name. `merge=union`,
    // `merge=binary`, the custom-driver fallback, `-merge`-as-binary and the
    // `set`/`unset` spellings of `check-attr` all predate 2.0 by years; anything
    // older than that cannot run this repo at all.
    const raw = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
    const parsed = /^git version (\d+)\.(\d+)/.exec(raw)
    expect(parsed).not.toBeNull()
    const [major, minor] = [Number(parsed![1]), Number(parsed![2])]
    expect(Number.isNaN(minor)).toBe(false)
    // Written this way so a failure names the git it actually found, rather than
    // reporting "expected 1 to be >= 2" about a number with no context.
    expect(major >= 2 ? raw : `${raw} is older than git 2.0`).toBe(raw)
  })

  it('merge=union keeps BOTH entries, with no conflict — the property being gated', () => {
    const out = realMerge('log.txt merge=union')
    expect(out.status).toBe(0)
    expect(out.file).toContain('OURS')
    expect(out.file).toContain('THEIRS')
    expect(out.markers).toBe(0)
  })

  it('a CUSTOM driver with no config is an ordinary content conflict, NOT a fatal abort', () => {
    // The claim `check-governed-repo-attributes.ts` prints for this case, and
    // the one an earlier revision got wrong: it said exit 128 `lacks command
    // line` here, which sends the reader hunting for config that is not the
    // problem.
    const out = realMerge('log.txt merge=as-built-log')
    expect(out.status).toBe(1)
    expect(out.status).not.toBe(128)
    expect(out.output).toContain('CONFLICT (content)')
    expect(out.markers).toBe(1)
  })

  it('a custom driver with .name but no .driver IS the fatal one', () => {
    const out = realMerge('log.txt merge=as-built-log', { 'merge.as-built-log.name': 'entry-aware' })
    expect(out.status).toBe(128)
    expect(out.output).toContain('lacks command line')
  })

  it('a bare `merge` rule is the ordinary text merge — conflict, with markers', () => {
    // `git check-attr` reports this one as `set`, which the gate must describe
    // as a STATE and not as a driver called "set".
    const out = realMerge('log.txt merge')
    expect(out.status).toBe(1)
    expect(out.output).toContain('CONFLICT (content)')
    expect(out.markers).toBe(1)
  })

  it('a `-merge` rule makes git treat the file as BINARY — ours kept whole, no markers', () => {
    // Reported by check-attr as `unset`. This is the quiet one: the other
    // side's entries are simply not in the working file, and there is no
    // conflict marker to notice them missing by.
    const out = realMerge('log.txt -merge')
    expect(out.status).toBe(1)
    expect(out.output).toContain('Cannot merge binary files')
    expect(out.markers).toBe(0)
    expect(out.file).toBe('OURS\nbase\n')
    expect(out.file).not.toContain('THEIRS')
  })

  it('merge=binary — the other built-in — loses the other side the same way', () => {
    const out = realMerge('log.txt merge=binary')
    expect(out.status).toBe(1)
    expect(out.output).toContain('Cannot merge binary files')
    expect(out.file).not.toContain('THEIRS')
  })
})
