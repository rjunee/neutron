/**
 * The rule that makes a governed repo's append-only log union-merged.
 *
 * The failure this file guards is not "the line is missing" — that is loud, and
 * the next conflict finds it. It is the two SILENT ones:
 *
 *   1. A rule written for a log the repo does not have, which reads as coverage
 *      and provides none.
 *   2. A rule written OVER somebody's existing merge driver, which is the same
 *      class of mistake as union itself when misapplied: a change nothing
 *      reports.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AS_BUILT_CANDIDATES,
  ensureUnionAttribute,
  existingMergeDriver,
  localEffectiveMergeDrivers,
  mergeRulesFor,
  parseCheckAttrZ,
  planUnionAttribute,
  resolveTrackedMergeDrivers,
  unionAttributeLine,
  type UnionAttributeProbe,
} from './as-built-union-attribute.ts'

describe('existingMergeDriver', () => {
  it('finds an active rule for the exact path', () => {
    expect(existingMergeDriver('docs/AS_BUILT.md merge=union\n', 'docs/AS_BUILT.md')).toBe('union')
    expect(existingMergeDriver('AS-BUILT.md merge=ours\n', 'AS-BUILT.md')).toBe('ours')
  })

  it('does NOT count a commented-out rule', () => {
    // A disabled entry and a present one look identical to a naive substring
    // check, and treating them the same is how a repo believes it has a guard
    // it deliberately turned off.
    expect(existingMergeDriver('# docs/AS_BUILT.md merge=union\n', 'docs/AS_BUILT.md')).toBeNull()
  })

  it('does not match a different path that merely contains this one', () => {
    expect(existingMergeDriver('docs/AS_BUILT.md.bak merge=union\n', 'docs/AS_BUILT.md')).toBeNull()
  })

  it('reads the merge attribute when other attributes share the line', () => {
    expect(existingMergeDriver('AS-BUILT.md text eol=lf merge=union\n', 'AS-BUILT.md')).toBe('union')
  })

  it('returns null for a path with attributes but no merge driver', () => {
    expect(existingMergeDriver('AS-BUILT.md text\n', 'AS-BUILT.md')).toBeNull()
  })

  it('takes the LAST assignment, the way git does, not the first', () => {
    // The first-match reading is what let the gate report a healthy union floor
    // over a file that had already overridden it. This helper still does not
    // speak for git — nothing below a wildcard is visible to it — but it must at
    // least not contradict git on the one case it does model.
    const attributes = 'docs/AS_BUILT.md merge=union\ndocs/AS_BUILT.md merge=as-built-log\n'
    expect(existingMergeDriver(attributes, 'docs/AS_BUILT.md')).toBe('as-built-log')
  })
})

describe('mergeRulesFor', () => {
  it('reports every active assignment with its line number', () => {
    const attributes = '# lead\ndocs/AS_BUILT.md merge=union\n*.png binary\ndocs/AS_BUILT.md merge=as-built-log\n'
    expect(mergeRulesFor(attributes, 'docs/AS_BUILT.md')).toEqual([
      { line: 2, text: 'docs/AS_BUILT.md merge=union', driver: 'union' },
      { line: 4, text: 'docs/AS_BUILT.md merge=as-built-log', driver: 'as-built-log' },
    ])
  })

  it('skips commented and unrelated lines', () => {
    expect(mergeRulesFor('# docs/AS_BUILT.md merge=union\n*.md merge=union\n', 'docs/AS_BUILT.md')).toEqual([])
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

describe('planUnionAttribute', () => {
  it('creates the file, with the scope-limit comment, when there is none', () => {
    const plan = planUnionAttribute({ attributes: null, asBuiltPaths: ['docs/AS_BUILT.md'] })
    expect(plan.action).toBe('write')
    expect(plan.added).toEqual(['docs/AS_BUILT.md'])
    expect(plan.content).toContain('docs/AS_BUILT.md merge=union')
    // The comment is not decoration: union's danger is that it never reports a
    // conflict, so the next reader has to be told why this is scoped.
    expect(plan.content).toContain('never reports a conflict')
    expect(plan.content.endsWith('\n')).toBe(true)
  })

  it('is a NOOP when the repo has no append-only log', () => {
    // A rule for a file that does not exist reads as coverage and is none.
    const plan = planUnionAttribute({ attributes: null, asBuiltPaths: [] })
    expect(plan.action).toBe('noop')
    expect(plan.content).toBe('')
  })

  it('is idempotent — a repo already carrying the rule is left alone', () => {
    const plan = planUnionAttribute({
      attributes: 'docs/AS_BUILT.md merge=union\n',
      asBuiltPaths: ['docs/AS_BUILT.md'],
    })
    expect(plan.action).toBe('noop')
    expect(plan.skipped).toEqual([{ path: 'docs/AS_BUILT.md', reason: 'already-union' }])
  })

  it('REFUSES to overwrite another BUILT-IN driver somebody chose', () => {
    const plan = planUnionAttribute({
      attributes: 'AS-BUILT.md merge=binary\n',
      asBuiltPaths: ['AS-BUILT.md'],
    })
    expect(plan.action).toBe('noop')
    expect(plan.skipped).toEqual([{ path: 'AS-BUILT.md', reason: 'builtin-driver' }])
  })

  it('distinguishes a CUSTOM driver, because tracked it is fatal rather than a preference', () => {
    // Found by mutating the CI gate against its own repo: naming the custom
    // as-built-log driver in the TRACKED file PASSED, and it is the one case
    // that breaks every fresh clone — git errors `lacks command line` (exit 128)
    // instead of falling back. A fixer must not overwrite it; a gate must not
    // bless it. Same fact, two correct responses, which is why the reason is
    // carried rather than collapsed to "not ours".
    const plan = planUnionAttribute({
      attributes: 'docs/AS_BUILT.md merge=as-built-log\n',
      asBuiltPaths: ['docs/AS_BUILT.md'],
    })
    expect(plan.action).toBe('noop')
    expect(plan.skipped).toEqual([{ path: 'docs/AS_BUILT.md', reason: 'custom-driver' }])
  })

  it('appends to an existing file without eating its last line', () => {
    // The existing content has NO trailing newline. Getting this wrong welds
    // the new rule onto `*.png binary`, producing a pattern that matches
    // nothing — silently, which is the whole problem with this class of bug.
    const plan = planUnionAttribute({
      attributes: '*.png binary',
      asBuiltPaths: ['AS-BUILT.md'],
    })
    expect(plan.action).toBe('write')
    const lines = plan.content.split('\n')
    expect(lines).toContain('*.png binary')
    expect(lines).toContain('AS-BUILT.md merge=union')
    expect(plan.content).not.toContain('*.png binaryAS-BUILT.md')
  })

  it('adds only the missing log when a repo keeps two', () => {
    const plan = planUnionAttribute({
      attributes: 'docs/AS_BUILT.md merge=union\n',
      asBuiltPaths: ['docs/AS_BUILT.md', 'AS-BUILT.md'],
    })
    expect(plan.added).toEqual(['AS-BUILT.md'])
    expect(plan.skipped).toEqual([{ path: 'docs/AS_BUILT.md', reason: 'already-union' }])
  })

  it('never marks SPEC.md or ISSUES.md — they are edited in place', () => {
    // Both are in every governed repo and neither is append-only. Union on
    // either would take both sides of a real disagreement and report success.
    expect(AS_BUILT_CANDIDATES).not.toContain('SPEC.md' as never)
    expect(AS_BUILT_CANDIDATES).not.toContain('ISSUES.md' as never)
    for (const candidate of AS_BUILT_CANDIDATES) expect(candidate).toContain('BUILT')
  })
})

describe('unionAttributeLine', () => {
  it('is the git syntax, not an approximation of it', () => {
    expect(unionAttributeLine('docs/AS_BUILT.md')).toBe('docs/AS_BUILT.md merge=union')
  })
})

function probeOver(files: Map<string, string>): UnionAttributeProbe & { files: Map<string, string> } {
  return {
    files,
    read: async (path) => files.get(path) ?? null,
    exists: async (path) => files.has(path),
    write: async (path, content) => {
      files.set(path, content)
    },
  }
}

describe('ensureUnionAttribute', () => {
  it('writes the rule for the log the repo actually has', async () => {
    const probe = probeOver(new Map([['/repo/docs/AS_BUILT.md', '# log']]))
    const result = await ensureUnionAttribute('/repo', probe)
    expect(result.changed).toBe(true)
    expect(result.added).toEqual(['docs/AS_BUILT.md'])
    expect(probe.files.get('/repo/.gitattributes')).toContain('docs/AS_BUILT.md merge=union')
  })

  it('writes NOTHING for a repo with no append-only log', async () => {
    const probe = probeOver(new Map([['/repo/SPEC.md', '# spec']]))
    const result = await ensureUnionAttribute('/repo', probe)
    expect(result.changed).toBe(false)
    expect(probe.files.has('/repo/.gitattributes')).toBe(false)
  })

  it('a second call writes nothing — the whole point of running it per build', async () => {
    const probe = probeOver(new Map([['/repo/AS-BUILT.md', '# log']]))
    const first = await ensureUnionAttribute('/repo', probe)
    const after = probe.files.get('/repo/.gitattributes')
    const second = await ensureUnionAttribute('/repo', probe)
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    // Byte-identical, not merely "no crash": an ensure that rewrites the file
    // every build shows up as a spurious diff in every PR.
    expect(probe.files.get('/repo/.gitattributes')).toBe(after)
  })
})

// ---------------------------------------------------------------------------
// REAL GIT. Everything above is a reading of text; this is the boundary where
// the verdict is actually decided, and it had no test at all.
// ---------------------------------------------------------------------------

const scratchDirs: string[] = []
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'union-attr-realgit-'))
  scratchDirs.push(dir)
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' })
  return dir
}

function scratchRepoFromTemplate(template: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'union-attr-templated-'))
  scratchDirs.push(dir)
  execFileSync('git', ['init', '-q', `--template=${template}`, dir], { stdio: 'pipe' })
  return dir
}

describe('resolveTrackedMergeDrivers (real git)', () => {
  const LOG = 'docs/AS_BUILT.md'

  it('agrees with git that a LATER duplicate rule wins', () => {
    const attributes = `${LOG} merge=union\n${LOG} merge=as-built-log\n`
    // Control: git itself, asked directly in a throwaway repo, so this test
    // proves the expectation rather than assuming it.
    const repo = scratchRepo()
    writeFileSync(join(repo, '.gitattributes'), attributes)
    const direct = execFileSync('git', ['-C', repo, 'check-attr', 'merge', '--', LOG], { encoding: 'utf8' })
    expect(direct.trim()).toBe(`${LOG}: merge: as-built-log`)

    expect(resolveTrackedMergeDrivers({ attributes, paths: [LOG] }).get(LOG)).toBe('as-built-log')
  })

  it('agrees with git that a LATER WILDCARD beats an earlier exact path', () => {
    const attributes = `${LOG} merge=union\ndocs/*.md merge=binary\n`
    expect(resolveTrackedMergeDrivers({ attributes, paths: [LOG] }).get(LOG)).toBe('binary')
  })

  it('reports union for the plain case, and null when nothing matches', () => {
    // The positive control. Without it, a probe that had silently stopped
    // working would "confirm" every finding by reporting nothing everywhere.
    expect(resolveTrackedMergeDrivers({ attributes: `${LOG} merge=union\n`, paths: [LOG] }).get(LOG)).toBe('union')
    expect(resolveTrackedMergeDrivers({ attributes: '# nothing\n', paths: [LOG] }).get(LOG)).toBeNull()
    expect(resolveTrackedMergeDrivers({ attributes: null, paths: [LOG] }).get(LOG)).toBeNull()
  })

  it('answers for several logs in one call', () => {
    const attributes = `${LOG} merge=union\nAS-BUILT.md merge=binary\n`
    const resolved = resolveTrackedMergeDrivers({ attributes, paths: [LOG, 'AS-BUILT.md'] })
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
    expect(resolveTrackedMergeDrivers({ attributes: `${LOG} merge=union\n`, paths: [LOG] }).get(LOG)).toBe('union')
  })

  it('is NOT swayed by a machine-local global attributes file', () => {
    // Measured before this was written: with core.attributesFile pointing at a
    // file that names a driver for this path, a repo tracking NO rule resolves
    // to the global one — a pass that reproduces on nobody else's machine.
    const home = mkdtempSync(join(tmpdir(), 'union-attr-home-'))
    scratchDirs.push(home)
    writeFileSync(join(home, 'attrs'), `${LOG} merge=from-global\n`)
    writeFileSync(join(home, 'gitconfig'), `[core]\n\tattributesFile = ${join(home, 'attrs')}\n`)

    const repo = scratchRepo()
    writeFileSync(join(repo, '.gitattributes'), '# nothing\n')
    // Control: the poison is real and does reach an uncovered path.
    const polluted = execFileSync('git', ['-C', repo, 'check-attr', 'merge', '--', LOG], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: join(home, 'gitconfig') },
    })
    expect(polluted.trim()).toBe(`${LOG}: merge: from-global`)

    const poisoned = { ...process.env, GIT_CONFIG_GLOBAL: join(home, 'gitconfig') }
    expect(
      resolveTrackedMergeDrivers({ attributes: '# nothing\n', paths: [LOG], env: poisoned }).get(LOG),
    ).toBeNull()
  })

  it('is NOT swayed by an init template that ships its own info/attributes', () => {
    // `git init` copies $GIT_TEMPLATE_DIR (or init.templateDir) into the new
    // .git, and info/attributes is one of the files it will copy — which would
    // put a machine's opinion INSIDE the probe that exists to exclude it.
    const template = mkdtempSync(join(tmpdir(), 'union-attr-template-'))
    scratchDirs.push(template)
    mkdirSync(join(template, 'info'), { recursive: true })
    writeFileSync(join(template, 'info', 'attributes'), `${LOG} merge=from-template\n`)

    // Control: the template really does reach a freshly-initialised repo.
    const control = scratchRepoFromTemplate(template)
    writeFileSync(join(control, '.gitattributes'), `${LOG} merge=union\n`)
    const polluted = execFileSync('git', ['-C', control, 'check-attr', 'merge', '--', LOG], { encoding: 'utf8' })
    expect(polluted.trim()).toBe(`${LOG}: merge: from-template`)

    const templated = { ...process.env, GIT_TEMPLATE_DIR: template }
    expect(
      resolveTrackedMergeDrivers({ attributes: `${LOG} merge=union\n`, paths: [LOG], env: templated }).get(LOG),
    ).toBe('union')
  })

  it('asks nothing when there are no paths', () => {
    expect(resolveTrackedMergeDrivers({ attributes: null, paths: [] }).size).toBe(0)
  })
})

describe('localEffectiveMergeDrivers (real git)', () => {
  it('returns null outside a repository rather than throwing', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'union-attr-norepo-'))
    scratchDirs.push(notARepo)
    expect(localEffectiveMergeDrivers(notARepo, ['docs/AS_BUILT.md'])).toBeNull()
  })
})
