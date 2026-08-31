#!/usr/bin/env bun
// Keyboard-taps gate — every app/ scrollable declares keyboardShouldPersistTaps.
//
// ── THE BUG THIS MAKES PERMANENT ──────────────────────────────────────
// React Native defaults a scrollable to `keyboardShouldPersistTaps="never"`.
// With the keyboard up, the FIRST tap anywhere outside the input is consumed by
// the keyboard dismissal and never reaches the Pressable underneath — so the
// owner taps a button, nothing happens, and they tap again. Owner-reported;
// swept on this branch across 43 sites that took
// `keyboardShouldPersistTaps="handled"` plus 2 argued exemptions.
// Card: docs/plans/mobile-the-first-tap-is-eaten-while-the-keyboard-is-open-key-p1z70d.md
//
// The sweep is a one-time act. THIS GATE IS WHY THE 46TH SCROLLABLE CANNOT
// RE-EAT THE TAP: a new `<ScrollView>` / `<FlashList>` / `<FlatList>` under
// `app/` fails CI here unless it sets the prop or argues an exemption in its
// own opening tag.
//
// ── WHY AN AST, NOT A GREP ────────────────────────────────────────────
// A raw `grep -E '<(ScrollView|FlashList|FlatList)\b'` over this tree returns
// four hits that are not elements at all — they are TYPE positions, e.g.
// `useRef<ScrollView | null>(null)` at app/components/TaskList.tsx:73. A grep
// cannot tell a type argument, a `ScrollViewProps` alias, a string literal or a
// comment from a rendered element, so it either nags about un-fixable "sites"
// or gets narrowed until it stops seeing the real ones. This gate parses the
// TypeScript AST and only ever looks at JsxOpeningElement / JsxSelfClosingElement
// nodes, so those four classes can never be hits — each is locked as a test in
// keyboard-taps-check.test.ts.
//
// Property-access tails are matched too (`<Animated.ScrollView>`), by tag-name
// EQUALITY on the tail — `<ScrollViewBanner>` is a different component and is
// not a site.
//
// ── THE OPT-OUT ───────────────────────────────────────────────────────
// A scrollable with ZERO tappable children has nothing for the first tap to
// reach, so the prop is noise there. Those carry a marker INSIDE THE OPENING
// TAG:
//
//   <ScrollView
//     style={styles.body}
//     // KEYBOARD-TAPS-EXEMPT: diff body is plain selectable Text lines
//   >
//
// Placement is deliberate and enforced by construction: the checked span is
// `node.getStart()..node.getEnd()` of the OPENING TAG, which begins after
// leading trivia and ends at `>`. A comment ABOVE the element, or a JSX child
// comment `{/* … */}` inside the body, is therefore outside the span and does
// NOT exempt — the argument has to sit where the reader of the tag will see it.
// The marker REQUIRES at least MIN_JUSTIFICATION_CHARS characters of prose; a
// bare `KEYBOARD-TAPS-EXEMPT` is its own failure class, so an exemption stays an
// argued exception rather than a silent one.
//
// ── WHY THE CONTROLS AND TRIPWIRES ────────────────────────────────────
// This repo has been bitten by a check that matched nothing and therefore
// reported success — a standing-red gate hid a second, completely DEAD gate for
// days. An extraction that finds nothing must never read as a pass. So every
// invocation, before it touches the tree at all, runs:
//   * a POSITIVE control — a hard-coded sample whose 2 offenses + 1 prop the
//     matcher must reproduce exactly, or the gate exits 1 saying the matcher is
//     broken;
//   * a NEGATIVE control — a multi-line tag with the prop and a multi-line tag
//     with a justified marker must both come back clean;
//   * a zero-FILES-walked tripwire (the walk moved, or `app/` did);
//   * a zero-SITES-matched tripwire (the matcher or the tree moved — this tree
//     has 45).
// Any of those failing is a FAILURE, not a pass with nothing to report.
//
// ── SCOPE ─────────────────────────────────────────────────────────────
// `app/**/*.tsx` only. Tests are excluded (`__tests__/`, `*.test.tsx`): a
// fixture that renders a bare scrollable is asserting about rendering, not
// shipping a surface the owner taps.
//
// NOTE ON VALUE: the gate checks the prop is DECLARED, not what it is set to.
// `"handled"` is the right value and `"always"` is wrong (it also stops taps on
// empty space dismissing the keyboard) — that policy lives in the card and in
// review, because a site that thought about the prop enough to pass a value is
// not the regression this gate exists to catch.
//
// EXIT: 0 = every site declares the prop or argues its exemption,
//       1 = at least one offense, or a control/tripwire tripped.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import ts from 'typescript'

export const MARKER = 'KEYBOARD-TAPS-EXEMPT'

/** Prose required after the marker for an exemption to count. Set so a real
 *  reason clears it and a shrug ("n/a", "ok", "later") does not. */
export const MIN_JUSTIFICATION_CHARS = 12

/** The scrollables that eat the first tap. Matched by tag-name EQUALITY (on the
 *  property tail for `Animated.ScrollView`), never by prefix. */
const SCROLLABLE_TAGS = new Set(['ScrollView', 'FlashList', 'FlatList'])

const IGNORE_DIRS = new Set(['node_modules', '__tests__', '.expo', '.git', 'dist', 'coverage', 'vendor'])

/** The tag name of a JSX element, or null for shapes we do not classify. */
function tagNameOf(node) {
  const tagName = node.tagName
  if (ts.isIdentifier(tagName)) return tagName.text
  if (ts.isPropertyAccessExpression(tagName)) return tagName.name.text
  return null
}

/** True iff the opening tag declares `keyboardShouldPersistTaps` at all. The
 *  value is deliberately not inspected — see the NOTE ON VALUE in the header. */
function declaresProp(node) {
  return node.attributes.properties.some(
    (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === 'keyboardShouldPersistTaps',
  )
}

/**
 * Classify the exemption marker inside an opening-tag source slice.
 *   'none'        — no marker in the tag
 *   'bare-exempt' — marker present, justification too short
 *   'exempt'      — marker + a real reason
 */
function classifyTagMarker(tagSource) {
  const idx = tagSource.indexOf(MARKER)
  if (idx === -1) return 'none'
  const justification = tagSource
    .slice(idx + MARKER.length)
    .split('\n')[0]
    .replace(/^\s*:/, '')
    .replace(/\*\/\s*$/, '')
    .trim()
  return justification.length >= MIN_JUSTIFICATION_CHARS ? 'exempt' : 'bare-exempt'
}

/**
 * Find every JSX scrollable element in `source`.
 * @param {string} source     TS/TSX source text.
 * @param {string} [fileName] virtual file name (drives TSX parsing).
 * @returns {{line:number, tag:string, state:'prop'|'exempt'|'bare-exempt'|'offense', text:string}[]}
 */
export function findScrollableSites(source, fileName = 'fixture.tsx') {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const out = []
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagNameOf(node)
      if (tag && SCROLLABLE_TAGS.has(tag)) {
        // The OPENING TAG ONLY: the span starts after leading trivia and ends
        // at `>`, so a comment above the element or a JSX child comment is
        // excluded by construction — see THE OPT-OUT in the header.
        const tagSource = source.slice(node.getStart(sf), node.getEnd())
        let state
        if (declaresProp(node)) {
          state = 'prop'
        } else {
          const marker = classifyTagMarker(tagSource)
          state = marker === 'none' ? 'offense' : marker
        }
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        out.push({
          line: line + 1,
          tag,
          state,
          text: node.getText(sf).split('\n')[0].trim(),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Cheap pre-filter: a file can only carry a site if the text of one appears in
 *  it. Conservative — comments, strings and type positions get through here and
 *  are rejected by the AST pass, which makes the actual decision. */
export function mightCarrySite(src) {
  return /<\s*(?:[A-Za-z][A-Za-z0-9]*\.)?(?:ScrollView|FlashList|FlatList)\b/.test(src)
}

function walk(dir, out) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (IGNORE_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) out.push(full)
  }
}

/**
 * Scan a directory tree for scrollable sites.
 * @param {string} rootDir
 * @returns {{files:number, sites:{rel:string, line:number, tag:string, state:'prop'|'exempt'|'bare-exempt'|'offense', text:string}[]}}
 */
export function scanTree(rootDir) {
  const files = []
  walk(rootDir, files)
  const sites = []
  for (const abs of files) {
    const rel = abs.slice(rootDir.length + 1).split(sep).join('/')
    const src = readFileSync(abs, 'utf8')
    if (!mightCarrySite(src)) continue
    for (const site of findScrollableSites(src, abs)) sites.push({ rel, ...site })
  }
  return { files: files.length, sites }
}

// ── CLI ───────────────────────────────────────────────────────────────

/** A sample with exactly 2 offenses and 1 prop. If the matcher stops
 *  reproducing that, it is broken and the gate must not report a pass. */
const POSITIVE_CONTROL = `
export function Sample() {
  return (
    <>
      <ScrollView style={styles.x}>
        <Text>body</Text>
      </ScrollView>
      <FlashList data={rows} renderItem={ri} />
      <FlatList keyboardShouldPersistTaps="handled" data={rows} />
    </>
  )
}
`

/** A sample that must come back completely clean: the prop on a multi-line tag,
 *  and a justified in-tag marker on another. */
const NEGATIVE_CONTROL = `
export function Sample() {
  return (
    <>
      <ScrollView
        keyboardShouldPersistTaps="handled"
      >
        <Text>body</Text>
      </ScrollView>
      <ScrollView
        style={styles.y}
        // ${MARKER}: read-only content; nothing tappable inside
      >
        <Text>plain</Text>
      </ScrollView>
    </>
  )
}
`

if (import.meta.main) {
  // 1 — POSITIVE CONTROL. Runs before the tree is touched: a matcher that has
  // stopped seeing offenses would otherwise walk app/, find nothing, and print
  // a green line.
  const control = findScrollableSites(POSITIVE_CONTROL)
  const controlOffenses = control.filter((s) => s.state === 'offense').length
  const controlProps = control.filter((s) => s.state === 'prop').length
  if (control.length !== 3 || controlOffenses !== 2 || controlProps !== 1) {
    console.error('KEYBOARD-TAPS GATE: positive control failed — matcher broken, refusing to pass')
    process.exit(1)
  }

  // 2 — NEGATIVE CONTROL. The other direction: a matcher that flagged
  // everything would be just as useless.
  const negative = findScrollableSites(NEGATIVE_CONTROL)
  const negativeBad = negative.filter((s) => s.state === 'offense' || s.state === 'bare-exempt').length
  if (negative.length !== 2 || negativeBad !== 0) {
    console.error('KEYBOARD-TAPS GATE: negative control failed — matcher broken, refusing to pass')
    process.exit(1)
  }

  const ROOT = join(import.meta.dir, '..', '..')
  const { files, sites } = scanTree(join(ROOT, 'app'))

  // 3 — TRIPWIRES. An empty match set is a broken gate, never a clean tree.
  if (files === 0) {
    console.error('KEYBOARD-TAPS GATE: walked zero .tsx files under app/ — the walk is broken, refusing to pass')
    process.exit(1)
  }
  if (sites.length === 0) {
    console.error(
      'KEYBOARD-TAPS GATE: matched zero scrollables under app/ — matcher or tree moved, refusing to pass',
    )
    process.exit(1)
  }

  // 4 — OFFENSES.
  const missing = sites.filter((s) => s.state === 'offense')
  const bare = sites.filter((s) => s.state === 'bare-exempt')
  const exempt = sites.filter((s) => s.state === 'exempt').length

  let failed = false
  if (missing.length > 0) {
    failed = true
    console.error(
      'A scrollable under app/ does not declare `keyboardShouldPersistTaps`. React\n' +
        'Native defaults it to "never", so with the keyboard up the FIRST tap on\n' +
        'anything inside is eaten by the keyboard dismissal and never reaches the\n' +
        'Pressable — the mobile "first tap is eaten while the keyboard is open" bug.\n' +
        'Fix: set `keyboardShouldPersistTaps="handled"` (never "always" — that also\n' +
        'stops a tap on empty space dismissing the keyboard). If — and only if — the\n' +
        'scrollable has zero tappable children, put\n' +
        `      // ${MARKER}: <why, at least ${MIN_JUSTIFICATION_CHARS} characters>\n` +
        'INSIDE the opening tag instead (a comment above the element, or a JSX child\n' +
        'comment, does not count). Offending scrollables:',
    )
    for (const s of missing) console.error(`  app/${s.rel}:${s.line}  ${s.text}`)
  }
  if (bare.length > 0) {
    failed = true
    console.error(
      `\nA \`${MARKER}\` marker with no real justification — an exemption has to be an\n` +
        `ARGUED exception, not a silent one. Write at least ${MIN_JUSTIFICATION_CHARS} characters saying why this\n` +
        'scrollable has nothing tappable for the eaten first tap to reach:',
    )
    for (const s of bare) console.error(`  app/${s.rel}:${s.line}  ${s.text}`)
  }

  if (failed) {
    console.error(
      `\nKEYBOARD-TAPS GATE: FAILED — ${missing.length} without the prop, ${bare.length} unjustified exemption(s)`,
    )
    process.exit(1)
  }

  console.log(
    'KEYBOARD-TAPS GATE (every app/ scrollable declares keyboardShouldPersistTaps or argues its exemption): ' +
      `${sites.length} sites checked ✅ (${exempt} exempt)`,
  )
}
