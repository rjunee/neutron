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

/** Sites the gate fails on: no prop, or a marker with no argument. */
function offenders(src: string) {
  return findScrollableSites(src).filter((s) => s.state === 'offense' || s.state === 'bare-exempt')
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
  test('the prop counts on a single-line tag, whatever its value', () => {
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

  test('the prefilter never rejects a file that carries a real site', () => {
    expect(mightCarrySite('<ScrollView style={s.x}>')).toBe(true)
    expect(mightCarrySite('<Animated.ScrollView>')).toBe(true)
    expect(mightCarrySite('<FlashList data={rows} />')).toBe(true)
    expect(mightCarrySite('export const P = () => <View />')).toBe(false)
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
    expect(sites.length).toBeGreaterThanOrEqual(20)
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
  // Runs the gate for real, controls and tripwires included: on this tree it
  // must exit 0 and say so.
  test('exits 0 on this tree and prints the success line', () => {
    const res = Bun.spawnSync(['bun', join(import.meta.dir, 'keyboard-taps-check.mjs')])
    const stdout = res.stdout.toString()
    expect(res.exitCode).toBe(0)
    expect(stdout).toContain('KEYBOARD-TAPS GATE')
    expect(stdout).toContain('✅')
  })
})
