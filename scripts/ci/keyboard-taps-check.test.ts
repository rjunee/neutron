// Unit tests for the keyboard-taps gate (scripts/ci/keyboard-taps-check.mjs).
//
// The gate exists because React Native defaults a scrollable to
// `keyboardShouldPersistTaps="never"`, so with the keyboard up the FIRST tap
// inside it is eaten by the keyboard dismissal and never reaches the Pressable.
// The branch swept 45 sites; this gate is what stops the 46th regressing.
//
// These tests pin its PRECISION in both directions. In particular they lock the
// four TYPE-position hits that motivated an AST matcher instead of a grep —
// `useRef<ScrollView | null>(null)` (the real shape at
// app/components/TaskList.tsx:73), `ScrollViewProps`, a type-only import, and
// `<ScrollView` inside a string or a comment — none of which is an element and
// none of which a grep can tell apart from one. They also pin the real-tree
// floor and the CLI's own controls, because an extraction that matches nothing
// must never read as a pass.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  MARKER,
  MIN_JUSTIFICATION_CHARS,
  findScrollableSites,
  mightCarrySite,
  scanTree,
} from './keyboard-taps-check.mjs'

/** Sites the gate fails on: no prop, a forbidden value, or a marker with no
 *  argument. */
function offenders(src: string) {
  return findScrollableSites(src).filter((s) => s.state !== 'prop' && s.state !== 'exempt')
}

describe('findScrollableSites — the shapes it MUST catch', () => {
  test('a bare single-line ScrollView is an offense', () => {
    const hits = offenders(`
      export const P = () => (
        <ScrollView style={s.x}>
          <Text>body</Text>
        </ScrollView>
      )
    `)
    expect(hits.length).toBe(1)
    expect(hits[0]?.tag).toBe('ScrollView')
    expect(hits[0]?.state).toBe('offense')
  })

  test('a self-closing FlashList is an offense', () => {
    const hits = offenders(`
      export const P = () => <FlashList data={rows} renderItem={ri} />
    `)
    expect(hits.length).toBe(1)
    expect(hits[0]?.tag).toBe('FlashList')
  })

  test('a self-closing FlatList is an offense', () => {
    const hits = offenders(`
      export const P = () => <FlatList data={rows} />
    `)
    expect(hits.length).toBe(1)
    expect(hits[0]?.tag).toBe('FlatList')
  })

  // Property-access tail: `<Animated.ScrollView>` is the same component wrapped,
  // and eats the same first tap.
  test('a property-access tag (Animated.ScrollView) is an offense', () => {
    const hits = offenders(`
      export const P = () => (
        <Animated.ScrollView style={s.x}>
          <Text>body</Text>
        </Animated.ScrollView>
      )
    `)
    expect(hits.length).toBe(1)
    expect(hits[0]?.tag).toBe('ScrollView')
  })

  // A multi-segment namespace (`<RN.Animated.ScrollView>`) is the shape the
  // PRE-FILTER used to reject: it allowed exactly one qualifier segment, so the
  // file was never parsed and the offense passed CI silently.
  test('a MULTI-SEGMENT property-access tag is an offense, and the prefilter lets it through', () => {
    const src = `
      export const P = () => (
        <RN.Animated.ScrollView style={s.x}>
          <Text>body</Text>
        </RN.Animated.ScrollView>
      )
    `
    expect(mightCarrySite(src)).toBe(true)
    const hits = offenders(src)
    expect(hits.length).toBe(1)
    expect(hits[0]?.tag).toBe('ScrollView')
    expect(hits[0]?.state).toBe('offense')
  })

  // SectionList shares RN's `keyboardShouldPersistTaps="never"` default, so it
  // eats the same first tap; MasonryFlashList and KeyboardAwareScrollView are
  // covered for the same reason FlatList is — the site that does not exist yet.
  test('SectionList, MasonryFlashList and KeyboardAwareScrollView are sites too', () => {
    expect(offenders(`const P = () => <SectionList sections={s} renderItem={r} />`).length).toBe(1)
    expect(offenders(`const P = () => <MasonryFlashList data={rows} renderItem={r} />`).length).toBe(1)
    const kasv = `const P = () => <KeyboardAwareScrollView><Pressable onPress={go} /></KeyboardAwareScrollView>`
    expect(offenders(kasv).length).toBe(1)
  })

  test('two offending sites in one file are reported separately, in source order', () => {
    const hits = offenders(`export const A = () => (
  <ScrollView style={s.a}>
    <Text>a</Text>
  </ScrollView>
)
export const B = () => <FlashList data={rows} renderItem={ri} />
`)
    expect(hits.length).toBe(2)
    expect(hits.map((h) => h.line)).toEqual([2, 6])
  })
})

describe('findScrollableSites — the shapes it must PASS', () => {
  test('the prop counts on a single-line tag, whatever its value short of the forbidden two', () => {
    expect(findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps="handled" data={rows} />`)[0]?.state).toBe(
      'prop',
    )
    expect(
      findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps={mode} data={rows} />`)[0]?.state,
    ).toBe('prop')
  })

  test('the prop counts on a multi-line tag', () => {
    const sites = findScrollableSites(`
      export const P = () => (
        <ScrollView
          style={s.x}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={s.c}
        >
          <Pressable onPress={go} />
        </ScrollView>
      )
    `)
    expect(sites.length).toBe(1)
    expect(sites[0]?.state).toBe('prop')
  })

  test('a justified marker INSIDE the opening tag exempts the site', () => {
    const sites = findScrollableSites(`
      export const P = () => (
        <ScrollView
          style={s.x}
          // ${MARKER}: diff body is plain selectable Text lines
        >
          <Text>diff</Text>
        </ScrollView>
      )
    `)
    expect(sites.length).toBe(1)
    expect(sites[0]?.state).toBe('exempt')
  })
})

describe('marker discipline — an exemption must be ARGUED and in the right place', () => {
  test('a marker with too little prose is its own offense class', () => {
    const sites = findScrollableSites(`
      export const P = () => (
        <ScrollView
          // ${MARKER}: ok
        >
          <Text>x</Text>
        </ScrollView>
      )
    `)
    expect(sites[0]?.state).toBe('bare-exempt')
    expect('ok'.length).toBeLessThan(MIN_JUSTIFICATION_CHARS)
  })

  test('a marker with no colon and no prose is bare', () => {
    const sites = findScrollableSites(`
      export const P = () => (
        <ScrollView
          // ${MARKER}
        >
          <Text>x</Text>
        </ScrollView>
      )
    `)
    expect(sites[0]?.state).toBe('bare-exempt')
  })

  test('a marker ABOVE the element does not exempt it', () => {
    const sites = findScrollableSites(`
      export const P = () => (
        // ${MARKER}: read-only content with nothing tappable inside
        <ScrollView style={s.x}>
          <Text>x</Text>
        </ScrollView>
      )
    `)
    expect(sites[0]?.state).toBe('offense')
  })

  // The marker is read from COMMENT TRIVIA only. Before that it was an indexOf
  // over the raw tag text, so a BARE marker laundered whatever attribute text
  // happened to follow it into a "justification".
  test('a bare marker cannot borrow the attribute text after it for a justification', () => {
    const sites = findScrollableSites(`const P = () => (
        <ScrollView /* ${MARKER} */ style={s.someLongEnoughName}>
          <Pressable onPress={go} />
        </ScrollView>
      )`)
    expect(sites[0]?.state).toBe('bare-exempt')
  })

  test('a same-line block comment WITH a real reason still exempts', () => {
    const sites = findScrollableSites(`const P = () => (
        <ScrollView /* ${MARKER}: read-only text body */ style={s.x}>
          <Text>x</Text>
        </ScrollView>
      )`)
    expect(sites[0]?.state).toBe('exempt')
  })

  test('the marker inside a STRING attribute value is data, not an argument', () => {
    const sites = findScrollableSites(`const P = () => (
        <ScrollView testID="${MARKER}: nothing tappable in here" style={s.x}>
          <Pressable onPress={go} />
        </ScrollView>
      )`)
    expect(sites[0]?.state).toBe('offense')
  })

  test('a JSX CHILD comment does not exempt the element', () => {
    const sites = findScrollableSites(`
      export const P = () => (
        <ScrollView style={s.x}>
          {/* ${MARKER}: read-only content with nothing tappable inside */}
          <Text>x</Text>
        </ScrollView>
      )
    `)
    expect(sites[0]?.state).toBe('offense')
  })
})

describe('the two values the card forbids', () => {
  // "never" IS the bug (it is RN's default); "always" also stops a tap on empty
  // space dismissing the keyboard. Declaring the prop must not buy a pass when
  // what it declares is the defect.
  test('"never" is rejected even though the prop is declared', () => {
    const sites = findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps="never" data={rows} />`)
    expect(sites[0]?.state).toBe('forbidden')
  })

  test('"always" is rejected', () => {
    const sites = findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps="always" data={rows} />`)
    expect(sites[0]?.state).toBe('forbidden')
  })

  test('a forbidden value in a braced expression is rejected too', () => {
    const sites = findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps={'never'} data={rows} />`)
    expect(sites[0]?.state).toBe('forbidden')
  })

  // THE BOOLEAN SPELLINGS. React Native maps `false` → "never" and `true` →
  // "always" (ScrollView.js, deprecated but still functional) and TYPES the prop
  // `boolean | 'always' | 'never' | 'handled'` — so `{false}` IS this bug, it
  // typechecks clean, and before this it read as "a site that declared the prop".
  test('{false} is the RN spelling of "never" and is rejected', () => {
    const sites = findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps={false} data={rows} />`)
    expect(sites[0]?.state).toBe('forbidden')
  })

  test('{true} is the RN spelling of "always" and is rejected', () => {
    const sites = findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps={true} data={rows} />`)
    expect(sites[0]?.state).toBe('forbidden')
  })

  test('a SHORTHAND attribute is {true} — "always" — and is rejected', () => {
    const sites = findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps data={rows} />`)
    expect(sites[0]?.state).toBe('forbidden')
  })

  test('`as const` and parentheses do not launder a forbidden value', () => {
    expect(
      findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps={'never' as const} data={r} />`)[0]
        ?.state,
    ).toBe('forbidden')
    expect(
      findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps={('always')} data={r} />`)[0]?.state,
    ).toBe('forbidden')
  })

  // React applies the LAST duplicate attribute; a gate that read the first would
  // pass the tag that ships "never".
  test('a duplicated prop is judged on ALL its occurrences, not the first', () => {
    const src = `const P = () => (
      <ScrollView keyboardShouldPersistTaps="handled" keyboardShouldPersistTaps="never">
        <Pressable onPress={go} />
      </ScrollView>
    )`
    expect(findScrollableSites(src)[0]?.state).toBe('forbidden')
  })

  test('"handled" and a computed value pass', () => {
    expect(
      findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps="handled" data={rows} />`)[0]?.state,
    ).toBe('prop')
    expect(
      findScrollableSites(`const P = () => <FlatList keyboardShouldPersistTaps={mode} data={rows} />`)[0]?.state,
    ).toBe('prop')
  })

  test('no app/ site sets a forbidden value', () => {
    const { sites } = scanTree(join(import.meta.dir, '..', '..', 'app'))
    expect(sites.filter((s) => s.state === 'forbidden')).toEqual([])
  })
})

describe('false-positive locks — the grep hits that are not elements', () => {
  test('a type argument is not a site (the real shape at app/components/TaskList.tsx:73)', () => {
    expect(
      findScrollableSites(`
        import { useRef } from 'react'
        export const P = () => {
          const r = useRef<ScrollView | null>(null)
          return r
        }
      `).length,
    ).toBe(0)
  })

  test('a type alias and a type-only import are not sites', () => {
    expect(
      findScrollableSites(`
        import type { ScrollView } from 'react-native'
        type P = ScrollViewProps
        export type Q = P
      `).length,
    ).toBe(0)
  })

  test('a scrollable quoted in a string or a comment is not a site', () => {
    expect(
      findScrollableSites(`
        const help = 'wrap it in <ScrollView keyboardShouldPersistTaps="handled">'
        // TODO: the old <ScrollView /> here was replaced by a FlatList
        export const P = () => null
      `).length,
    ).toBe(0)
  })

  test('a tag that merely STARTS with a scrollable name is not a site', () => {
    expect(
      findScrollableSites(`
        export const P = () => (
          <ScrollViewBanner style={s.x}>
            <Text>x</Text>
          </ScrollViewBanner>
        )
      `).length,
    ).toBe(0)
  })

  test('the closing tag does not double-count its element', () => {
    const sites = findScrollableSites(`
      export const P = () => (
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text>x</Text>
        </ScrollView>
      )
    `)
    expect(sites.length).toBe(1)
  })

  // The prefilter decides whether a file is PARSED AT ALL, so anything it
  // rejects is invisible to the gate — the one failure mode this artifact exists
  // to prevent. It is built from the same tag set as the matcher and allows any
  // number of qualifier segments.
  test('the prefilter never rejects a file that carries a real site', () => {
    expect(mightCarrySite('<ScrollView style={s.x}>')).toBe(true)
    expect(mightCarrySite('<Animated.ScrollView>')).toBe(true)
    expect(mightCarrySite('<RN.Animated.ScrollView style={x}>')).toBe(true)
    expect(mightCarrySite('<_A.ScrollView>')).toBe(true)
    expect(mightCarrySite('<FlashList data={rows} />')).toBe(true)
    expect(mightCarrySite('<SectionList sections={s} />')).toBe(true)
    expect(mightCarrySite('<MasonryFlashList data={rows} />')).toBe(true)
    expect(mightCarrySite('<KeyboardAwareScrollView>')).toBe(true)
    expect(mightCarrySite('export const P = () => <View />')).toBe(false)
  })

  // The property that matters is not the regex — it is that no shape the MATCHER
  // would flag gets dropped before the parse.
  test('every shape the matcher flags survives the prefilter', () => {
    for (const src of [
      '<ScrollView style={s.x}><Text>x</Text></ScrollView>',
      '<Animated.ScrollView><Text>x</Text></Animated.ScrollView>',
      '<RN.Animated.ScrollView><Text>x</Text></RN.Animated.ScrollView>',
      '<FlashList data={r} />',
      '<FlatList data={r} />',
      '<SectionList sections={s} />',
      '<MasonryFlashList data={r} />',
      '<KeyboardAwareScrollView><Text>x</Text></KeyboardAwareScrollView>',
    ]) {
      expect(findScrollableSites(src).length).toBeGreaterThan(0)
      expect(mightCarrySite(src)).toBe(true)
    }
  })
})

describe('import aliases — the same component under another name', () => {
  // `import { ScrollView as NativeScroll }` renders the identical RN component
  // and eats the identical first tap, but its tag text says nothing about a
  // scrollable, so a tag-text-only matcher reports the file as having no sites
  // at all — a silent miss in the artifact whose whole job is preventing them.
  test('an aliased ScrollView is a site, and the prefilter lets its file through', () => {
    const src = `import { ScrollView as NativeScroll } from 'react-native'
export const P = () => (
  <NativeScroll>
    <Pressable onPress={go} />
  </NativeScroll>
)
`
    expect(mightCarrySite(src)).toBe(true)
    const hits = offenders(src)
    expect(hits.length).toBe(1)
    expect(hits[0]?.state).toBe('offense')
    expect(hits[0]?.line).toBe(3)
  })

  test('an aliased scrollable that declares the prop passes', () => {
    const src = `import { FlashList as Rows } from '@shopify/flash-list'
export const P = () => <Rows keyboardShouldPersistTaps="handled" data={rows} renderItem={ri} />
`
    const sites = findScrollableSites(src)
    expect(sites.length).toBe(1)
    expect(sites[0]?.state).toBe('prop')
  })

  test('an alias of something that is NOT a scrollable is not a site', () => {
    expect(
      findScrollableSites(`import { View as ScrollThing } from 'react-native'
export const P = () => <ScrollThing><Pressable onPress={go} /></ScrollThing>
`).length,
    ).toBe(0)
  })

  test('a TYPE-ONLY aliased import is not a site', () => {
    expect(
      findScrollableSites(`import type { ScrollView as NativeScroll } from 'react-native'
export type P = NativeScroll
`).length,
    ).toBe(0)
  })

  test('an alias binding is only consulted for a bare tag, not a property tail', () => {
    expect(
      findScrollableSites(`import { ScrollView as NativeScroll } from 'react-native'
export const P = () => <Wrapper.NativeScroll><Pressable onPress={go} /></Wrapper.NativeScroll>
`).length,
    ).toBe(0)
  })

  // End-to-end through the PREFILTER, which decides whether the file is parsed
  // at all — the layer the alias used to slip past.
  test('an aliased offender in a scratch tree is reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-alias-'))
    writeFileSync(
      join(dir, 'Aliased.tsx'),
      `import { ScrollView as NativeScroll } from 'react-native'
export const P = () => (
  <NativeScroll>
    <Pressable onPress={go} />
  </NativeScroll>
)
`,
    )
    const { sites } = scanTree(dir)
    expect(sites.length).toBe(1)
    expect(sites[0]?.state).toBe('offense')
    expect(sites[0]?.rel).toBe('Aliased.tsx')
  })
})

describe('scanTree', () => {
  // THE REAL-TREE FLOOR. Pins both directions at once: the matcher still finds
  // the real sites (a silently-narrowed matcher fails here, not silently), and
  // the branch tree stays clean. No assertion about FlatList — app/ has no JSX
  // FlatList today; the gate covers the tag for the future.
  test('the repo tree is found and is clean', () => {
    const { files, sites } = scanTree(join(import.meta.dir, '..', '..', 'app'))
    expect(files).toBeGreaterThan(0)
    // 45 sites at the sweep, and the floor sits ON that number, not under it: a
    // floor of 44 tolerated losing a site to a narrowed walk or matcher, which is
    // exactly the silent miss this gate exists to prevent. Adding a scrollable to
    // app/ is expected to raise this number by hand — that edit is the moment to
    // check the new site declares the prop.
    expect(sites.length).toBeGreaterThanOrEqual(45)
    expect(sites.filter((s) => s.state === 'offense' || s.state === 'bare-exempt')).toEqual([])
    expect(sites.filter((s) => s.state === 'exempt').length).toBeGreaterThan(0)
  })

  test('an offending file in a scratch tree is reported with its rel:line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-'))
    mkdirSync(join(dir, 'panes'))
    writeFileSync(
      join(dir, 'panes', 'Offender.tsx'),
      `export const P = () => (
  <ScrollView style={s.x}>
    <Pressable onPress={go} />
  </ScrollView>
)
`,
    )
    const { files, sites } = scanTree(dir)
    expect(files).toBe(1)
    const bad = sites.filter((s) => s.state === 'offense')
    expect(bad.length).toBe(1)
    expect(bad[0]?.rel).toBe('panes/Offender.tsx')
    expect(bad[0]?.line).toBe(2)
  })

  // End-to-end through the PREFILTER: scanTree skips any file the prefilter
  // rejects, so this is the test that would have caught the silent miss.
  test('a multi-segment namespace scrollable in a scratch tree is reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-ns-'))
    writeFileSync(
      join(dir, 'Namespaced.tsx'),
      `import * as RN from 'react-native'
export const P = () => (
  <RN.Animated.ScrollView style={s.x}>
    <RN.Pressable onPress={go} />
  </RN.Animated.ScrollView>
)
`,
    )
    const { sites } = scanTree(dir)
    expect(sites.length).toBe(1)
    expect(sites[0]?.state).toBe('offense')
    expect(sites[0]?.line).toBe(3)
  })

  test('a rootDir with a trailing slash still reports a correct rel path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-slash-'))
    mkdirSync(join(dir, 'panes'))
    writeFileSync(join(dir, 'panes', 'Offender.tsx'), 'export const P = () => <ScrollView><Pressable /></ScrollView>\n')
    const { sites } = scanTree(`${dir}/`)
    expect(sites[0]?.rel).toBe('panes/Offender.tsx')
  })

  test('an empty tree reports zero files — the CLI refuses on this', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-empty-'))
    const { files, sites } = scanTree(dir)
    expect(files).toBe(0)
    expect(sites.length).toBe(0)
  })

  test('test files are out of scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-tests-'))
    mkdirSync(join(dir, '__tests__'))
    writeFileSync(join(dir, '__tests__', 'a.tsx'), '<ScrollView />')
    writeFileSync(join(dir, 'b.test.tsx'), '<ScrollView />')
    expect(scanTree(dir).files).toBe(0)
  })
})

describe('the CLI', () => {
  const GATE = join(import.meta.dir, 'keyboard-taps-check.mjs')
  /** The gate against a scratch tree — the optional argv root is what makes the
   *  tripwires reachable from a test at all. */
  function runGate(dir?: string) {
    const res = Bun.spawnSync(dir ? ['bun', GATE, dir] : ['bun', GATE])
    return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() }
  }

  // Runs the gate for real, controls and tripwires included: on this tree it
  // must exit 0 and say so.
  test('exits 0 on this tree and prints the success line', () => {
    const res = runGate()
    expect(res.code).toBe(0)
    expect(res.out).toContain('KEYBOARD-TAPS GATE')
    expect(res.out).toContain('✅')
  })

  // THE TRIPWIRES, EXERCISED. This repo has been bitten by a check that matched
  // nothing and reported success, so "an empty extraction exits 1" is a claim
  // that has to be run, not just written.
  test('walking zero .tsx files exits 1, never a silent pass', () => {
    const res = runGate(mkdtempSync(join(tmpdir(), 'keyboard-taps-cli-empty-')))
    expect(res.code).toBe(1)
    expect(res.err).toContain('walked zero .tsx files')
    expect(res.out).not.toContain('✅')
  })

  test('matching zero scrollables in a non-empty tree exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-cli-nosites-'))
    writeFileSync(join(dir, 'Plain.tsx'), 'export const P = () => <View><Text>x</Text></View>\n')
    const res = runGate(dir)
    expect(res.code).toBe(1)
    expect(res.err).toContain('matched zero scrollables')
    expect(res.out).not.toContain('✅')
  })

  test('an offending tree exits 1 and names the file and line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-cli-bad-'))
    const src = 'export const P = () => (\n  <ScrollView>\n    <Pressable />\n  </ScrollView>\n)\n'
    writeFileSync(join(dir, 'Bad.tsx'), src)
    const res = runGate(dir)
    expect(res.code).toBe(1)
    expect(res.err).toContain('Bad.tsx:2')
  })

  test('a boolean-spelled forbidden value exits 1 (RN maps {false} to "never")', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-cli-false-'))
    writeFileSync(join(dir, 'Bool.tsx'), 'export const P = () => <FlatList keyboardShouldPersistTaps={false} data={r} />\n')
    const res = runGate(dir)
    expect(res.code).toBe(1)
    expect(res.err).toContain('forbids')
    expect(res.out).not.toContain('✅')
  })

  test('an aliased scrollable with no prop exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-cli-alias-'))
    writeFileSync(
      join(dir, 'Aliased.tsx'),
      `import { ScrollView as NativeScroll } from 'react-native'
export const P = () => <NativeScroll><Pressable onPress={go} /></NativeScroll>
`,
    )
    const res = runGate(dir)
    expect(res.code).toBe(1)
    expect(res.err).toContain('Aliased.tsx:2')
    expect(res.out).not.toContain('✅')
  })

  test('a forbidden value exits 1 and says which value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-taps-cli-never-'))
    const src = 'export const P = () => <FlatList keyboardShouldPersistTaps="never" data={r} />\n'
    writeFileSync(join(dir, 'Never.tsx'), src)
    const res = runGate(dir)
    expect(res.code).toBe(1)
    expect(res.err).toContain('forbids')
    expect(res.err).toContain('Never.tsx:1')
  })
})
