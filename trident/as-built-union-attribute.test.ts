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

import { describe, expect, it } from 'bun:test'

import {
  AS_BUILT_CANDIDATES,
  ensureUnionAttribute,
  existingMergeDriver,
  planUnionAttribute,
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

  it('distinguishes a CUSTOM driver, so the caller can decide whether the repo can run it', () => {
    // The planner carries the reason rather than collapsing it to "not ours" because a fixer and
    // a gate answer differently: a fixer must not overwrite somebody's choice, a gate has to ask
    // whether the repo actually ships that driver.
    //
    // The original comment here said a tracked custom driver "breaks every fresh clone" because
    // git errors `lacks command line`. Measured on git 2.50.1: it does not — an unconfigured
    // driver falls back to an ordinary CONFLICT (exit 1), and the fatal form needs a half-written
    // config (`.name` set, `.driver` unset). See `BUILT_IN_MERGE_DRIVERS` for the measurement.
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
