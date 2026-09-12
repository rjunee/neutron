/**
 * THE #546 DIFF-BASE GATE, tested against the shapes it exists to catch.
 *
 * The gate's job is to make one specific silent failure impossible to reintroduce:
 * a bare local branch name as the left-hand side of a rev-range. So the interesting
 * assertions here are not "it finds the bad thing" — a matcher that flags every
 * `..` would do that. They are:
 *
 *   * it finds EVERY REAL SHAPE the defect shipped in — the bare `${baseBranch}..`,
 *     THE NAME WRAPPED IN A CALL (`${shSingleQuote(baseBranch)}..`, which is the
 *     literal #546 line and which this gate's first draft could not see), a ternary
 *     falling back to the name, a `.ts` site where the name came from `resolveBase()`,
 *     and the `.sh` `"${BASE_BRANCH}..HEAD"` — and
 *   * it stays SILENT on every near-miss — a resolved ref, a qualified ref, an
 *     argued exemption — because a gate that cries wolf gets muted, and a muted
 *     gate is the dead gate this repo has already been bitten by, and
 *   * an empty scan is NOT a pass.
 *
 * The two controls are shared with the gate itself (it runs them on every
 * invocation before touching the tree), so this test cannot pass against a matcher
 * the gate does not actually run.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import {
  EXEMPT_MARKER,
  MIN_JUSTIFICATION_CHARS,
  NEGATIVE_CONTROL,
  POSITIVE_CONTROL,
  SCAN_ROOTS,
  findBareBaseRanges,
  taintedNames,
} from './diff-base-check.mjs'

const ROOT = join(import.meta.dir, '..', '..')
const GATE = join(import.meta.dir, 'diff-base-check.mjs')

describe('the matcher finds every shape #546 actually shipped in', () => {
  test('the positive control reproduces EXACTLY its five offenses, at their lines', () => {
    // Pinned as VALUES — the line numbers and the names, not "more than zero" and
    // not "at least the ones I thought of". A relation against a constant stays
    // green when the constant moves (#575), and a count alone stays green when the
    // matcher finds five DIFFERENT things than the five it is supposed to.
    expect(findBareBaseRanges(POSITIVE_CONTROL).map((h) => ({ line: h.line, name: h.name }))).toEqual([
      { line: 4, name: 'baseBranch' },
      { line: 6, name: 'baseBranch' },
      { line: 8, name: 'baseBranch' },
      { line: 13, name: 'base' },
      { line: 16, name: 'BASE_BRANCH' },
    ])
  })

  test('THE NAME INSIDE A CALL is caught — the exact text writeResumeDiff shipped', () => {
    // The first draft of this gate matched only `${baseBranch}..`, so it was GREEN
    // against `git diff ${shSingleQuote(baseBranch)}..${shSingleQuote(headOid)}` — the
    // real #546 line. Found by mutating the fix and watching the gate not care, which
    // is the only way to find it: a gate that cannot fail on the bug reports success
    // exactly as a fixed tree does.
    const real = 'const cmd = `git diff ${shSingleQuote(baseBranch)}..${shSingleQuote(headOid)}`'
    expect(findBareBaseRanges(real).map((h) => ({ line: h.line, name: h.name }))).toEqual([
      { line: 1, name: 'baseBranch' },
    ])
    // …and the same wrapper around a RESOLVED base is silent, so the rule is about
    // the name and not about the wrapper.
    const fixed = 'const cmd = `git diff ${shSingleQuote(diffBase)}..${shSingleQuote(headOid)}`'
    expect(findBareBaseRanges(fixed)).toEqual([])
  })

  test('a ternary that FALLS BACK to the bare name is caught', () => {
    // The forge contract's old `${pinnedBase ?? baseBranch}..HEAD`: correct whenever a
    // base was pinned, silently stale when one was not — which is the half of a
    // half-fixed site that a reader skims straight past.
    expect(findBareBaseRanges('const c = `git diff ${pinnedBase ?? baseBranch}..HEAD`').map((h) => h.line)).toEqual([
      1,
    ])
    expect(findBareBaseRanges('const c = `git diff ${pinnedBase ?? diffBase}..HEAD`')).toEqual([])
  })

  test('the `.ts` shape is caught THROUGH the binding, not by its name', () => {
    // `base` is not a suspicious name; what makes it one is where it came from.
    // Without this arm the gate would catch the spelling and miss the class — which
    // is precisely how #546 survived two prior call-site fixes.
    const src = ["const base = await resolveBase(run)", 'const cmd = `git diff ${base}..${head}`'].join('\n')
    expect(findBareBaseRanges(src).map((h) => h.line)).toEqual([2])
    expect(taintedNames(src).has('base')).toBe(true)

    // The SAME range, with the binding removed, is invisible — proving the hit
    // above came from the binding and not from the range.
    const unbound = 'const cmd = `git diff ${base}..${head}`'
    expect(findBareBaseRanges(unbound)).toEqual([])
  })

  test('`detectBaseBranch` and a `base_branch` field taint just as `resolveBase` does', () => {
    for (const binding of [
      'const b = await detectBaseBranch(run_host, repo)',
      'const b = opts.base_branch',
      'const b = input.base_branch ?? fallback',
    ]) {
      const src = [binding, 'const cmd = `git diff ${b}..${head}`'].join('\n')
      expect({ binding, hits: findBareBaseRanges(src).map((h) => h.line) }).toEqual({ binding, hits: [2] })
    }
  })

  test('three dots are caught as well as two — the merge-base form has the same defect', () => {
    // `git diff <stale-main>...<branch>` resolves the merge-base, and a stale local
    // `main` IS an ancestor of the branch, so the merge-base is the stale tip and the
    // inflated file list is identical. A gate that only knew `..` would have passed
    // `changedFilesWithStatus`.
    const src = 'const cmd = `git diff --name-only ${baseBranch}...${ref}`'
    expect(findBareBaseRanges(src).map((h) => h.line)).toEqual([1])
  })
})

describe('the matcher stays silent on every near-miss', () => {
  test('the negative control leaves EXACTLY the un-argued exemption', () => {
    const hits = findBareBaseRanges(NEGATIVE_CONTROL)
    expect(hits.map((h) => h.line)).toEqual([12])
  })

  test('a RESOLVED ref is not a hit, under each name the tree uses for one', () => {
    for (const name of ['diffBase', 'baseRef', 'base_ref', 'BASE_REF', 'base_sha', 'pinnedBase']) {
      const src = `const cmd = \`git diff \${${name}}..\${head}\``
      expect({ name, hits: findBareBaseRanges(src) }).toEqual({ name, hits: [] })
    }
  })

  test('a QUALIFIED ref is not a hit — including the one site that measures staleness', () => {
    // `refs/heads/<base>..refs/remotes/origin/<base>` is the launch path's
    // `base_behind` count. It names the LOCAL ref on purpose: it exists to measure
    // how far behind local `main` is. Flagging it would be flagging the measurement
    // of the very bug this gate is about.
    for (const src of [
      'const behind = `rev-list --count refs/heads/${base_branch}..${remoteRef}`',
      'const cmd = `git diff refs/remotes/origin/${baseBranch}..${head}`',
      'const cmd = `git diff origin/${baseBranch}..${head}`',
    ]) {
      expect({ src, hits: findBareBaseRanges(src) }).toEqual({ src, hits: [] })
    }
  })

  test('an exemption must be ARGUED, in a comment, and it exempts only its own site', () => {
    const reason = 'x'.repeat(MIN_JUSTIFICATION_CHARS)
    const bad = 'const cmd = `git diff ${baseBranch}..${head}`'

    // Argued, on the line above → silent. Argued, trailing → silent.
    expect(findBareBaseRanges([`// ${EXEMPT_MARKER} ${reason}`, bad].join('\n'))).toEqual([])
    expect(findBareBaseRanges(`${bad} // ${EXEMPT_MARKER} ${reason}`)).toEqual([])

    // Too short an argument → still a hit. A bare marker is not an argument.
    const short = 'x'.repeat(MIN_JUSTIFICATION_CHARS - 1)
    expect(findBareBaseRanges([`// ${EXEMPT_MARKER} ${short}`, bad].join('\n')).map((h) => h.line)).toEqual([2])

    // Inside a STRING the code goes on to use, the marker is data, not an argument.
    expect(
      findBareBaseRanges([`const note = "${EXEMPT_MARKER} ${reason}"`, bad].join('\n')).map((h) => h.line),
    ).toEqual([2])

    // And it does not reach two lines down — an exemption covers its own site only.
    expect(
      findBareBaseRanges([`// ${EXEMPT_MARKER} ${reason}`, 'const spacer = 1', bad].join('\n')).map((h) => h.line),
    ).toEqual([3])
  })
})

describe('the gate as CI runs it', () => {
  test('it passes on the tree, and says how many files it read', () => {
    const res = spawnSync('bun', [GATE], { cwd: ROOT, encoding: 'utf8' })
    expect({ status: res.status, stderr: res.stderr }).toEqual({ status: 0, stderr: '' })
    // The file COUNT is in the success line, so a scan that silently narrowed to
    // three files cannot read as the same pass as one that read the surface.
    expect(res.stdout).toMatch(/0 found in \d+ files/)
    const scanned = Number(/0 found in (\d+) files/.exec(res.stdout)?.[1] ?? '0')
    expect(scanned).toBeGreaterThan(50)
  })

  test('an empty scan set is a FAILURE, not a pass', () => {
    // Run from a directory where SCAN_ROOTS do not exist. A check that matched
    // nothing and reported success is a documented incident in this repo.
    const res = spawnSync('bun', [GATE], { cwd: import.meta.dir, encoding: 'utf8' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('scanned ZERO files')
  })

  test('it fails on a tree that reintroduces the defect', () => {
    // THE MUTATION, run for real: a scratch SCAN_ROOT holding one offending file.
    // Without this the suite would pass against a gate whose main() never calls the
    // matcher at all.
    const dir = join(ROOT, 'trident', '__diff_base_gate_mutation__')
    const fs = require('node:fs') as typeof import('node:fs')
    fs.mkdirSync(dir, { recursive: true })
    try {
      fs.writeFileSync(join(dir, 'offender.mjs'), 'const cmd = `git diff ${baseBranch}..${headOid}`\n')
      const res = spawnSync('bun', [GATE], { cwd: ROOT, encoding: 'utf8' })
      expect(res.status).toBe(1)
      expect(res.stderr).toContain('offender.mjs:1')
      expect(res.stderr).toContain('[baseBranch]')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the scan surface is the git-range surface, named not inferred', () => {
    expect(SCAN_ROOTS).toEqual(['trident', 'tools', 'scripts'])
  })

  test('the gate excludes ITSELF, and only itself, from the scan', () => {
    // Its controls are the offending shapes by design, so scanning itself would be a
    // permanent self-report. The exclusion is by BASENAME, so it cannot silently widen
    // to a sibling: a planted offender in the same directory is still caught.
    const fs = require('node:fs') as typeof import('node:fs')
    const sibling = join(import.meta.dir, 'diff-base-check-mutation-sibling.mjs')
    fs.writeFileSync(sibling, 'const cmd = `git diff ${baseBranch}..${headOid}`\n')
    try {
      const res = spawnSync('bun', [GATE], { cwd: ROOT, encoding: 'utf8' })
      expect(res.status).toBe(1)
      expect(res.stderr).toContain('diff-base-check-mutation-sibling.mjs:1')
      // …and the gate's own file is NOT in the report, which is what the exclusion buys.
      expect(res.stderr).not.toContain('ci/diff-base-check.mjs:')
    } finally {
      fs.rmSync(sibling, { force: true })
    }
  })
})
