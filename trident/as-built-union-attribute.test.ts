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
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AS_BUILT_CANDIDATES,
  checkAttrEnv,
  collectTrackedAttributesFiles,
  localEffectiveMergeDrivers,
  mergeRulesAcross,
  mergeRulesFor,
  parseCheckAttrZ,
  relevantAttributesPaths,
  resolveTrackedMergeDrivers,
  unionAttributeLine,
  untrackedOverlayAttributes,
} from './as-built-union-attribute.ts'

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

/** Write `files` into `dir` and commit them, so they are in the INDEX. */
function commitFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'seed'],
    { stdio: 'pipe' },
  )
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
  it('covers the append-only logs and nothing that is edited in place', () => {
    expect(AS_BUILT_CANDIDATES).not.toContain('SPEC.md' as never)
    expect(AS_BUILT_CANDIDATES).not.toContain('ISSUES.md' as never)
    for (const candidate of AS_BUILT_CANDIDATES) expect(candidate).toContain('BUILT')
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
  it('collects the root and subdirectory files from the INDEX', () => {
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
    // Present on disk, absent from the index.
    writeFileSync(join(repo, 'docs', '.gitattributes'), 'AS_BUILT.md merge=binary\n')

    // Control: this clone's git DOES honour it, which is why "read from disk"
    // would be the wrong reading of "what a fresh clone gets".
    expect(directCheckAttr(repo)).toBe(`${LOG}: merge: binary`)

    const files = collectTrackedAttributesFiles(repo, [LOG])
    expect(files.map((f) => f.path)).toEqual(['.gitattributes'])
    expect(resolveTrackedMergeDrivers({ attributesFiles: files, paths: [LOG] }).get(LOG)).toBe('union')
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
