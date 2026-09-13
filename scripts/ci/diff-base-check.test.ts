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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  commentOpenerIndex,
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
  test('the positive control reproduces EXACTLY its six offenses, at their lines', () => {
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
      // THE SHORTHAND, promoted from the NEGATIVE control in round twenty-four: this gate
      // exempted `origin/${baseBranch}..` while the runtime path refused it. A gate that
      // exempts the thing it exists to catch cannot report its own blind spot.
      { line: 19, name: 'baseBranch' },
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

  /**
   * THE REVIEW-GATE FINDING ON THIS FILE'S OWN FIRST LANDING (P1).
   *
   * The matcher required the dots to follow the interpolation IMMEDIATELY, so
   * `git diff "${BASE_BRANCH}"..HEAD` — which the shell evaluates as exactly the
   * forbidden `main..HEAD` — returned []. That is the SAME failure as the
   * `shSingleQuote(...)` one a few tests up: a spelling I had not enumerated. These
   * tests pin the three spellings that were named, and the block below pins the
   * complement, so the fix cannot be "make the matcher permissive".
   */
  test('A CLOSING QUOTE between the operand and its dots does not hide it', () => {
    for (const src of [
      'git diff "${BASE_BRANCH}"..HEAD > "$f"',
      "git diff '${BASE_BRANCH}'..HEAD",
      'const r = `git diff ${baseBranch}`..${head}`',
    ]) {
      expect({ src, hits: findBareBaseRanges(src).map((h) => h.line) }).toEqual({ src, hits: [1] })
    }
  })

  test('a CONCATENATION with no interpolation at all is caught', () => {
    // `'git diff ' + base + '..HEAD'` reaches git as the identical range and contains
    // no `${…}` anywhere, so every interpolation-shaped rule was blind to it.
    const src = ["const base = await resolveBase(run)", "const cmd = 'git diff ' + base + '..HEAD'"].join('\n')
    expect(findBareBaseRanges(src).map((h) => ({ line: h.line, name: h.name }))).toEqual([
      { line: 2, name: 'base' },
    ])
    expect(findBareBaseRanges("run_host(['git','diff', baseBranch + '..' + head])").map((h) => h.line)).toEqual([1])
  })

  test('a range SPLIT OVER TWO LINES is caught, and reported at its first line', () => {
    // Which is where a formatter puts it as soon as the line gets long, so this is
    // not an exotic shape — it is the shape the next long range will have.
    const src = ['const r = `git diff ${baseBranch}` +', '  `..${head}`'].join('\n')
    expect(findBareBaseRanges(src).map((h) => ({ line: h.line, name: h.name }))).toEqual([
      { line: 1, name: 'baseBranch' },
    ])
  })

  test('taint follows ALIASES to a fixpoint, not just one hop', () => {
    const src = [
      'const base = await resolveBase(run)',
      'const b = base',
      'const c = b',
      'const cmd = `git diff ${c}..${head}`',
    ].join('\n')
    expect(findBareBaseRanges(src).map((h) => h.line)).toEqual([4])
    expect(taintedNames(src)).toEqual(new Set(['base', 'b', 'c']))
  })

  test('the alias fixpoint is a FIXPOINT — a reverse-ordered chain past any fixed cap', () => {
    // The loop was capped at FOUR rounds while calling itself a fixpoint. The cap is
    // invisible in DEPENDENCY order, because a forward chain propagates end-to-end
    // within a single scan however long it is — which is exactly how the old alias test
    // was written, so the iteration boundary was never exercised. A REVERSE-ordered
    // chain advances one hop per round, so it is the only shape that can see the cap.
    const chain = (n: number): string => {
      const links = []
      for (let i = n; i >= 1; i--) links.push(`const v${i} = ${i === 1 ? 'base' : `v${i - 1}`}`)
      links.push('const base = await resolveBase(run)')
      links.push(`const cmd = \`git diff \${v${n}}..\${head}\``)
      return links.join('\n')
    }

    // SIX hops, reverse-ordered: comfortably past the old cap of 4, and past any other
    // fixed number a future author might reach for.
    const six = chain(6)
    expect(findBareBaseRanges(six).map((h) => h.line)).toEqual([8])
    expect([...taintedNames(six)].sort()).toEqual(['base', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'])

    // AND IT SCALES, so this is not "7 happens to work". A 40-hop reverse chain needs
    // 40 rounds; the bound is the binding count, which is a real bound rather than a
    // number chosen for comfort.
    const forty = chain(40)
    expect(findBareBaseRanges(forty).map((h) => h.line)).toEqual([42])
    expect(taintedNames(forty).size).toBe(41)

    // THE COMPLEMENT: an equally long chain rooted in a RESOLVED value stays clean, so
    // the fixpoint spreads taint along real edges rather than to everything in reach.
    const clean = chain(40).replace('const base = await resolveBase(run)', 'const base = diffBase')
    expect(findBareBaseRanges(clean)).toEqual([])
  })

  test('an identifier containing `$` aliases like any other — no meta-character in sight', () => {
    // CodeQL `js/useless-regexp-character-escape`, HIGH, on this file's own first
    // landing. The alias hop used to build a regex per tainted name by splicing the name
    // in UNESCAPED, and names come from `([A-Za-z_$][\w$]*)` — a class that includes `$`.
    // So `const $base = await resolveBase(run)` spliced `…(?:await\s+)?$base\b`, where
    // `$` is an END-OF-LINE ANCHOR: the pattern could never match, the alias hop silently
    // did nothing, and the gate returned NO HITS for a range it was supposed to catch.
    //
    // The assertion is written as `$`-name AGAINST an identical `z`-name control, in one
    // comparison, because that is the shape the bug had: the control passed throughout
    // and made the broken half look intentional.
    const shape = (base: string): string =>
      [
        `const ${base} = await resolveBase(run)`,
        `const alias = ${base}`,
        'const cmd = `git diff ${alias}..${head}`',
      ].join('\n')

    const dollar = shape('$base')
    const control = shape('zbase')
    expect({
      dollarTainted: [...taintedNames(dollar)].sort(),
      dollarHits: findBareBaseRanges(dollar).map((h) => h.line),
      controlTainted: [...taintedNames(control)].sort(),
      controlHits: findBareBaseRanges(control).map((h) => h.line),
    }).toEqual({
      dollarTainted: ['$base', 'alias'],
      dollarHits: [3],
      controlTainted: ['alias', 'zbase'],
      controlHits: [3],
    })
  })

  test('no regex is BUILT from scanned source at all — the splice is gone, not escaped', () => {
    // The fix is structural rather than a better escape, and this is what keeps it that
    // way: a future `new RegExp(... + <something from the source> + ...)` reintroduces the
    // whole question. The gate's three range patterns are static; nothing else may be.
    const fs = require('node:fs') as typeof import('node:fs')
    const gate = fs.readFileSync(GATE, 'utf8')
    const dynamic = gate
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter((l) => l.text.includes('new RegExp(') && !l.text.startsWith('*') && !l.text.startsWith('//'))
    // Exactly the two static range constructors, each concatenating only String.raw
    // literals — no identifier from the scanned text.
    expect(dynamic.map((l) => l.text)).toEqual([
      'const RANGE_BRACED = new RegExp(String.raw`\\$\\{([^{}]*)\\}` + RANGE_TAIL, \'g\')',
      'const RANGE_BARE = new RegExp(String.raw`\\$([A-Za-z_][\\w]*)` + RANGE_TAIL, \'g\')',
    ])
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
      'const cmd = `git diff refs/tags/${baseBranch}..${head}`',
    ]) {
      expect({ src, hits: findBareBaseRanges(src) }).toEqual({ src, hits: [] })
    }
    // …AND THESE ARE NOT REFS, however much they look like one. The exemption must agree with
    // the invariant it enforces — an operand is a full object name or BEGINS WITH `refs/` —
    // so anything it admits that is not one of those two forms is a hole by construction.
    //
    // Two holes have been found here, one per round: `'origin/'` on a prefix LIST (it is a
    // shorthand git resolves across namespaces, preferring TAGS), and then an UNANCHORED
    // `refs/` pattern, which matched at index 3 of `notrefs/` and inside `origin/refs/`.
    // **The exemption kept deciding "qualified" by a looser rule than the invariant.**
    for (const src of [
      'const cmd = `git diff origin/${baseBranch}..${head}`',
      'const cmd = `git diff origin/${base_branch}..${head}`',
      'git diff "origin/${BASE_BRANCH}..HEAD"',
      // `refs/` as a SUFFIX of another token — the unanchored pattern's blind spot.
      'const cmd = `git diff notrefs/${baseBranch}..${head}`',
      'const cmd = `git diff xrefs/${baseBranch}..${head}`',
      // …and a `refs/` path that is not at the START of the operand.
      'const cmd = `git diff origin/refs/${baseBranch}..${head}`',
    ]) {
      expect({ src, hits: findBareBaseRanges(src).length }).toEqual({ src, hits: 1 })
    }
    // THE COMPLEMENT, so the anchor is not just "report everything": a real `refs/` operand is
    // still silent at every boundary it can legally start at — INCLUDING assembled by
    // concatenation, where the operand's left half is the string literal before the `+` and the
    // text immediately left of the identifier ends in `' + `. That case was a FALSE POSITIVE in
    // a required check until this round: the gate reported an offence against a line where git
    // receives a fully qualified ref.
    //
    // EACH MEMBER IS PROVED TO REACH THE MATCHER. The version of this list that shipped carried
    // `"const cmd = 'git diff refs/tags/' + baseBranch"` — no `..`, so `RANGE_CONCAT` never
    // matched it and it passed because NOTHING WAS EXAMINED. **A control that passes for the
    // wrong reason is worse than a missing one, because it occupies the slot.** So every entry
    // below carries the de-qualified variant that must be REPORTED, which is the only way to
    // show the matcher saw the qualified one at all.
    for (const [silent, reported] of [
      [
        'const cmd = `git diff refs/heads/${baseBranch}..${head}`',
        'const cmd = `git diff ${baseBranch}..${head}`',
      ],
      [
        'git diff "refs/remotes/origin/${BASE_BRANCH}..HEAD"',
        'git diff "${BASE_BRANCH}..HEAD"',
      ],
      [
        "const cmd = 'git diff refs/tags/' + baseBranch + '..HEAD'",
        "const cmd = 'git diff ' + baseBranch + '..HEAD'",
      ],
      [
        "const cmd = 'git diff refs/heads/' + baseBranch + '...HEAD'",
        "const cmd = 'git diff ' + baseBranch + '...HEAD'",
      ],
      [
        'const cmd = `git diff refs/heads/${baseBranch}..${head}`\nconst x = 1',
        'const cmd = `git diff ${baseBranch}..${head}`\nconst x = 1',
      ],
    ] as const) {
      expect({ silent, hits: findBareBaseRanges(silent) }).toEqual({ silent, hits: [] })
      // …and the SAME shape with the qualification removed IS reported, so the silence above
      // is the exemption working rather than the matcher never arriving.
      expect({ reported, hits: findBareBaseRanges(reported).length }).toEqual({ reported, hits: 1 })
    }
  })

  test('THE COMPLEMENT of the quote/concat/line-break widening: a RESOLVED base in each of those exact positions is silent', () => {
    // Without this, the fix for the review-gate finding could have been "loosen the
    // regex until it matches", which would trade a blind spot for a muted gate.
    //
    // EVERY MEMBER CARRIES THE VARIANT THAT MUST BE REPORTED, for the same reason as the list
    // above: silence proves the near-miss works only if the matcher reached it. Each pair
    // changes exactly the one thing the member is about — the NAME for the first seven, the
    // range OPERATOR for the last, whose whole point is that an ellipsis is not a range.
    for (const [silent, reported] of [
      ['git diff "${BASE_DIFF_REF}"..HEAD', 'git diff "${BASE_BRANCH}"..HEAD'],
      ['git diff "refs/remotes/origin/${baseBranch}"..HEAD', 'git diff "${baseBranch}"..HEAD'],
      ["const cmd = 'git diff ' + baseRef + '..HEAD'", "const cmd = 'git diff ' + baseBranch + '..HEAD'"],
      ["const cmd = 'git diff ' + base_sha + '..HEAD'", "const cmd = 'git diff ' + base_branch + '..HEAD'"],
      ['const r = `git diff ${diffBase}` +\n  `..${head}`', 'const r = `git diff ${baseBranch}` +\n  `..${head}`'],
      // A non-base operand on the left of a concat — `head..HEAD` is a different
      // question and none of this gate's business.
      ["const cmd = 'git log ' + head + '..HEAD'", "const cmd = 'git log ' + baseBranch + '..HEAD'"],
      // An alias of a RESOLVED value is not tainted, so the fixpoint above cannot
      // spread taint to everything a file assigns.
      [
        'const b = diffBase\nconst r = `git diff ${b}..${head}`',
        'const b = baseBranch\nconst r = `git diff ${b}..${head}`',
      ],
      // Ordinary prose that happens to name the variable and use an ellipsis: the ELLIPSIS is
      // what makes it silent, so the variant swaps `…` for a real range operator.
      ['// the base branch ${baseBranch} … and more prose', 'const r = `git diff ${baseBranch}..${head}` // prose'],
    ] as const) {
      expect({ silent, hits: findBareBaseRanges(silent) }).toEqual({ silent, hits: [] })
      expect({ reported, hits: findBareBaseRanges(reported).length }).toEqual({ reported, hits: 1 })
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

    // THE ADVERSARIAL HALF, and the case the line above could not fail on. The opener test
    // used to be "is there a `//` anywhere to the left of the marker", which never asked
    // whether that opener was itself inside a string — so ONE LINE could carry a fake
    // comment in data AND the real offence, and report nothing.
    const smuggled = `const note = " ${EXEMPT_MARKER} ${reason}"; ${bad}`
    expect(findBareBaseRanges(smuggled).map((h) => h.line)).toEqual([1])
    // Every quote flavour, because the scanner tracks three of them and a test that only
    // tried double quotes would leave two live.
    for (const q of ['"', "'", '`']) {
      const src = `const note = ${q} // ${EXEMPT_MARKER} ${reason}${q}; ${bad}`
      expect({ q, hits: findBareBaseRanges(src).map((h) => h.line) }).toEqual({ q, hits: [1] })
    }
    // A `#` smuggled the same way — the shell files are scanned with the same matcher.
    expect(
      findBareBaseRanges(`MSG="# ${EXEMPT_MARKER} ${reason}"; git diff "\${BASE_BRANCH}..HEAD"`).map((h) => h.line),
    ).toEqual([1])

    // THE COMPLEMENT: a REAL trailing comment still exempts even when the same line holds a
    // string containing quote characters, so the fix is not "stop honouring exemptions".
    const withString = `const label = "a // b"; ${bad} // ${EXEMPT_MARKER} ${reason}`
    expect(findBareBaseRanges(withString)).toEqual([])
    // …and a jsdoc continuation line above the offence still exempts it.
    expect(findBareBaseRanges([` * ${EXEMPT_MARKER} ${reason}`, bad].join('\n'))).toEqual([])
    // …as does a block comment on the offence's own line.
    expect(findBareBaseRanges(`${bad} /* ${EXEMPT_MARKER} ${reason} */`)).toEqual([])

    // The helper itself, since the cases above rest on it: an opener inside a string is not
    // an opener, and one outside a string is.
    expect(commentOpenerIndex('const note = " // x"')).toBe(-1)
    expect(commentOpenerIndex('const note = "x" // y')).toBe(17)
    expect(commentOpenerIndex(' * jsdoc')).toBe(1)
    expect(commentOpenerIndex('const url = "http://x"')).toBe(-1)

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

  test('MUTATION: reverting the quote-boundary handling reddens the suite', async () => {
    // The gate's own history is that a matcher which cannot fail on the bug reports
    // success exactly as a fixed tree does — twice. So the guard on the fix is the fix
    // being REMOVED: rewrite RANGE_TAIL back to a bare `\.{2,3}` in a copy of the gate
    // and the quoted-boundary case must stop being found.
    const fs = require('node:fs') as typeof import('node:fs')
    const src = fs.readFileSync(GATE, 'utf8')
    const TAIL = 'const RANGE_TAIL = '
    expect(src).toContain(TAIL)
    const reverted = src.replace(
      /const RANGE_TAIL = String\.raw`[^`]*`/,
      'const RANGE_TAIL = String.raw`\\.{2,3}`',
    )
    expect(reverted).not.toBe(src)

    // Written OUTSIDE the repository, for two reasons: `scripts/` is a SCAN_ROOT and
    // this copy carries the gate's own controls, so a copy left behind by a crashed
    // test would redden CI for a file nobody shipped; and nothing here can then be
    // mistaken for a second gate.
    const copy = join(mkdtempSync(join(tmpdir(), 'diff-base-mutation-')), 'mutated.mjs')
    fs.writeFileSync(copy, reverted)
    try {
      // AWAITED inside the try, so the import completes before the file is removed.
      const mutated = (await import(copy)) as { findBareBaseRanges: typeof findBareBaseRanges }
      // BLIND, as the shipped matcher was when the review gate found it…
      expect(mutated.findBareBaseRanges('git diff "${BASE_BRANCH}"..HEAD')).toEqual([])
      // …while the unquoted form it never lost still lands, so the mutation is narrow
      // and this is not merely a broken import returning nothing for everything.
      expect(mutated.findBareBaseRanges('git diff ${BASE_BRANCH}..HEAD').map((h) => h.line)).toEqual([1])
      // And the SHIPPED matcher does see it.
      expect(findBareBaseRanges('git diff "${BASE_BRANCH}"..HEAD').map((h) => h.line)).toEqual([1])
    } finally {
      fs.rmSync(copy, { force: true })
    }
  })

  test('the scan surface is the git-range surface, named not inferred', () => {
    expect(SCAN_ROOTS).toEqual(['trident', 'tools', 'scripts'])
  })

  /**
   * THE SELF-EXCLUSION, AND THE TEST THAT COULD NOT CATCH ITS BUG.
   *
   * The previous version of this test planted a DIFFERENTLY NAMED sibling and asserted it
   * was caught, under a comment stating "the exclusion is by BASENAME, so it cannot
   * silently widen to a sibling". Both the code and the test treated by-basename as the
   * DESIGN. It was the defect: an offender at `trident/diff-base-check.mjs` was skipped
   * and the gate reported clean — measured before the fix.
   *
   * A differently named file can never test that property. The exclusion is a claim about
   * ONE PATH, so the falsifying input is the SAME BASENAME SOMEWHERE ELSE, which is what
   * the first case below plants. A test written from the implementation's premise tests
   * the premise.
   */
  const planted = (relDir: string, name: string, body: string): { path: string; clean: () => void } => {
    const fs = require('node:fs') as typeof import('node:fs')
    const dir = join(ROOT, relDir)
    fs.mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    fs.writeFileSync(path, body)
    return { path, clean: () => fs.rmSync(path, { force: true }) }
  }
  const OFFENDER = 'const cmd = `git diff ${baseBranch}..${headOid}`\n'

  test('a file with the gate OWN BASENAME, in another directory, IS scanned and caught', () => {
    // The case the old test could not express, and the bug it therefore missed. Both scan
    // roots, because `trident/` and `tools/` are separate walks and one could be fixed
    // while the other is not.
    for (const relDir of ['trident', 'tools']) {
      const f = planted(relDir, 'diff-base-check.mjs', OFFENDER)
      try {
        const res = spawnSync('bun', [GATE], { cwd: ROOT, encoding: 'utf8' })
        expect({ relDir, status: res.status }).toEqual({ relDir, status: 1 })
        expect(res.stderr).toContain(`${relDir}/diff-base-check.mjs:1`)
      } finally {
        f.clean()
      }
    }
  })

  test('…while the gate itself stays excluded, and a differently named sibling is caught', () => {
    // The two halves of the original claim, kept: the exclusion still works for the one
    // path it is for, and it has not widened to any other name in the same directory.
    const f = planted('scripts/ci', 'diff-base-check-mutation-sibling.mjs', OFFENDER)
    try {
      const res = spawnSync('bun', [GATE], { cwd: ROOT, encoding: 'utf8' })
      expect(res.status).toBe(1)
      expect(res.stderr).toContain('diff-base-check-mutation-sibling.mjs:1')
      // The gate's own file is NOT in the report — what the exclusion buys.
      expect(res.stderr).not.toContain('scripts/ci/diff-base-check.mjs:')
    } finally {
      f.clean()
    }
  })

  test('and with nothing planted, the gate is clean — so the cases above are not vacuous', () => {
    // WHY THIS IS SAFE NEXT TO THE PLANTING TESTS ABOVE, measured rather than assumed:
    // `bun test` runs test FILES SEQUENTIALLY. Verified with two files, one holding a
    // marker on disk for 1200 ms and the other reporting whether it could see it — it
    // could not. Within a file, tests are serial too, and each plant cleans up in a
    // `finally`. So the only way this assertion can see a planted offender is TWO
    // CONCURRENT `bun test` invocations against the same worktree, which is not how CI
    // runs it (one invocation per shard, per checkout) and which is exactly what made this
    // test red once during development.
    const res = spawnSync('bun', [GATE], { cwd: ROOT, encoding: 'utf8' })
    expect({ status: res.status, stderr: res.stderr }).toEqual({ status: 0, stderr: '' })
  })
})
