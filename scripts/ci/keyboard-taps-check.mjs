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
// Card: .trident/plans/trident/fix-the-mobile-first-tap-is-eaten-w.md
//
// The sweep is a one-time act. THIS GATE IS WHY THE 46TH SCROLLABLE CANNOT
// RE-EAT THE TAP: a new scrollable under `app/` (see SCROLLABLE_TAGS) fails CI
// here unless it sets the prop or argues an exemption in its own opening tag.
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
// Property-access tails are matched too (`<Animated.ScrollView>`,
// `<RN.Animated.ScrollView>` — any depth), by tag-name EQUALITY on the tail —
// `<ScrollViewBanner>` is a different component and is not a site. IMPORT
// ALIASES are resolved as well: `import { ScrollView as NativeScroll }` renders
// the identical component and eats the identical first tap, but its tag text
// never mentions a scrollable, so a tag-text-only matcher would let it through
// as a non-site. The cheap pre-filter that decides whether a file is worth
// parsing is built FROM the same tag set, allows the same qualifier depth and
// admits the alias form, so it cannot drift narrower than the matcher and skip a
// file that carries a real site.
//
// ── THE OPT-OUT ───────────────────────────────────────────────────────
// A scrollable with ZERO tappable children has nothing for the first tap to
// reach, so the prop is noise there. Those carry a marker INSIDE THE OPENING
// TAG, IN A COMMENT:
//
//   <ScrollView
//     style={styles.body}
//     // KEYBOARD-TAPS-EXEMPT: diff body is plain selectable Text lines
//   >
//
// Placement is deliberate and enforced by construction, twice over. First, only
// the OPENING TAG is looked at (`node.getStart()..node.getEnd()`, which begins
// after leading trivia and ends at `>`), so a comment ABOVE the element, or a
// JSX child comment `{/* … */}` inside the body, does NOT exempt — the argument
// has to sit where the reader of the tag will see it. Second, only COMMENT
// TRIVIA within that span is read, never the raw text: a marker inside an
// attribute VALUE (`testID="KEYBOARD-TAPS-EXEMPT: …"`) is data, not an argument,
// and the justification is the rest of THE COMMENT — so a bare
// `/* KEYBOARD-TAPS-EXEMPT */` cannot launder the attribute text that follows it
// into a reason. The marker REQUIRES at least MIN_JUSTIFICATION_CHARS characters
// of prose; a bare `KEYBOARD-TAPS-EXEMPT` is its own failure class, so an
// exemption stays an argued exception rather than a silent one.
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
// NOTE ON VALUE: the gate does not demand a particular value — a genuinely
// computed one (`keyboardShouldPersistTaps={mode}`) is a site that thought about
// the prop, and that is not the regression this gate exists to catch. But EVERY
// LITERAL spelling of the two values the card FORBIDS is rejected outright:
// `"never"` is the RN default that IS the bug, and `"always"` also stops a tap on
// empty space dismissing the keyboard. That includes the BOOLEAN spellings, which
// are the same bug wearing a different hat: React Native's ScrollView maps
// `false` → "never" and `true` → "always" (deprecated, still functional), it
// types the prop `boolean | 'always' | 'never' | 'handled'` so `{false}`
// typechecks clean, and a JSX shorthand `keyboardShouldPersistTaps` IS `{true}`.
// `as const` / parenthesis wrappers are unwrapped first, and when a tag declares
// the prop TWICE any forbidden occurrence condemns it (React applies the last).
// Declaring the bug by name — in any of its spellings — must not buy a pass.
//
// EXIT: 0 = every site declares the prop (not a forbidden value) or argues its
//           exemption,
//       1 = at least one offense, or a control/tripwire tripped.
//
// USAGE: `bun scripts/ci/keyboard-taps-check.mjs [appDir]` — the optional
// argument overrides the scanned tree (default `<repo>/app`), which is how the
// companion test exercises the zero-files / zero-sites tripwires for real.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

export const MARKER = 'KEYBOARD-TAPS-EXEMPT'

/** Prose required after the marker for an exemption to count. Set so a real
 *  reason clears it and a shrug ("n/a", "ok", "later") does not. */
export const MIN_JUSTIFICATION_CHARS = 12

/** The scrollables that eat the first tap. Matched by tag-name EQUALITY (on the
 *  property tail for `Animated.ScrollView`), never by prefix. `SectionList`
 *  shares RN's `"never"` default; `MasonryFlashList` and
 *  `KeyboardAwareScrollView` are here for the same prophylactic reason
 *  `FlatList` is — app/ has no JSX use of any of them today, and the point of a
 *  gate is the site that does not exist yet. */
const SCROLLABLE_TAGS = new Set([
  'ScrollView',
  'FlashList',
  'FlatList',
  'SectionList',
  'MasonryFlashList',
  'KeyboardAwareScrollView',
])

/** @typedef {'prop'|'exempt'|'bare-exempt'|'offense'|'forbidden'} SiteState */

/** Values the card forbids outright: `"never"` is the RN default that IS the
 *  bug, `"always"` breaks tap-to-dismiss. See the NOTE ON VALUE in the header. */
const FORBIDDEN_VALUES = new Set(['never', 'always'])

const IGNORE_DIRS = new Set(['node_modules', '__tests__', '.expo', '.git', 'dist', 'coverage', 'vendor'])

/** The tag name of a JSX element, or null for shapes we do not classify. */
function tagNameOf(node) {
  const tagName = node.tagName
  if (ts.isIdentifier(tagName)) return tagName.text
  if (ts.isPropertyAccessExpression(tagName)) return tagName.name.text
  return null
}

/** EVERY `keyboardShouldPersistTaps` attribute of an opening tag, in source
 *  order. Plural on purpose: `keyboardShouldPersistTaps="handled"
 *  keyboardShouldPersistTaps="never"` is legal TSX and React applies the LAST
 *  one, so a gate that read only the first would pass the tag that ships the
 *  bug. Any forbidden occurrence condemns the tag. */
function propAttributes(node) {
  return node.attributes.properties.filter(
    (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === 'keyboardShouldPersistTaps',
  )
}

/** Strip the wrappers that do not change the value: `('never' as const)`,
 *  `(<'never'>x)`, `('never' satisfies T)`, parentheses at any depth. */
function unwrapValue(expr) {
  let e = expr
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      (ts.isSatisfiesExpression?.(e) ?? false))
  ) {
    e = e.expression
  }
  return e
}

/** The forbidden value this tag sets the prop to, or null. A genuinely computed
 *  value is not inspected — see the NOTE ON VALUE in the header — but every
 *  LITERAL spelling of the two forbidden values is, including the BOOLEAN ones:
 *  React Native's ScrollView maps `false` → "never" and `true` → "always"
 *  (ScrollView.js, deprecated but still functional), and its own types declare
 *  the prop `boolean | 'always' | 'never' | 'handled'`, so `{false}` is the bug
 *  itself and typechecks clean. A shorthand `keyboardShouldPersistTaps` with no
 *  initializer is JSX `{true}` — "always". */
function forbiddenValueOf(attr) {
  const init = attr.initializer
  if (!init) return 'always' // shorthand attribute === {true} === "always"
  const expr = unwrapValue(ts.isJsxExpression(init) ? init.expression : init)
  if (!expr) return null
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 'always'
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'never'
  if (!ts.isStringLiteralLike(expr)) return null
  return FORBIDDEN_VALUES.has(expr.text) ? expr.text : null
}

/** The COMMENT TRIVIA inside an opening tag, in source order. Comments between
 *  attributes are the trivia preceding the next attribute; a comment after the
 *  last attribute precedes the `>` / `/>` that closes the tag, which is where
 *  `attributes.end` sits. Both TRAILING ranges (same line as the previous token)
 *  and LEADING ranges (after a line break) are read, because TypeScript splits
 *  the trivia at a position between those two by whether a newline has been
 *  passed. Reading only comments is what keeps a marker inside a STRING
 *  attribute value from exempting anything. */
function tagComments(source, node) {
  const start = node.getStart()
  const end = node.getEnd()
  const positions = [...node.attributes.properties.map((p) => p.pos), node.attributes.end]
  const out = []
  const seen = new Set()
  for (const pos of positions) {
    const ranges = [
      ...(ts.getTrailingCommentRanges(source, pos) ?? []),
      ...(ts.getLeadingCommentRanges(source, pos) ?? []),
    ]
    for (const range of ranges) {
      if (range.pos < start || range.end > end || seen.has(range.pos)) continue
      seen.add(range.pos)
      out.push(source.slice(range.pos, range.end))
    }
  }
  return out
}

/**
 * Classify the exemption marker carried by an opening tag's comments.
 *   'none'        — no marker in any comment in the tag
 *   'bare-exempt' — marker present, justification too short
 *   'exempt'      — marker + a real reason
 * The justification is the rest of THAT COMMENT's first line, so nothing outside
 * the comment (the `style={…}` that follows a `/* … *\/`, say) can stand in for
 * an argument.
 */
function classifyTagMarker(comments) {
  let seen = 'none'
  for (const comment of comments) {
    const idx = comment.indexOf(MARKER)
    if (idx === -1) continue
    const justification = comment
      .slice(idx + MARKER.length)
      .split('\n')[0]
      .replace(/\*\/\s*$/, '')
      .replace(/^\s*:/, '')
      .trim()
    if (justification.length >= MIN_JUSTIFICATION_CHARS) return 'exempt'
    seen = 'bare-exempt'
  }
  return seen
}

/**
 * The LOCAL names a file binds to a scrollable it imported under another name:
 * `import { ScrollView as NativeScroll } from 'react-native'` renders the same
 * component and eats the same first tap, but the tag text says `NativeScroll`
 * and matching on tag text alone never sees it. Type-only imports are skipped —
 * they cannot be rendered.
 * @returns {Set<string>} local names that are scrollables in THIS file.
 */
function aliasedScrollableNames(sf) {
  const out = new Set()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const clause = stmt.importClause
    if (!clause || clause.isTypeOnly) continue
    const bindings = clause.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const el of bindings.elements) {
      if (el.isTypeOnly) continue
      const imported = (el.propertyName ?? el.name).text
      if (SCROLLABLE_TAGS.has(imported) && el.name.text !== imported) out.add(el.name.text)
    }
  }
  return out
}

/**
 * Find every JSX scrollable element in `source`.
 * @param {string} source     TS/TSX source text.
 * @param {string} [fileName] virtual file name (drives TSX parsing).
 * @returns {{line:number, tag:string, state:SiteState, text:string}[]}
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
  const aliases = aliasedScrollableNames(sf)
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagNameOf(node)
      // An alias binds a bare identifier, so it is only consulted for one —
      // `<Something.NativeScroll>` is a different component's property.
      if (tag && (SCROLLABLE_TAGS.has(tag) || (ts.isIdentifier(node.tagName) && aliases.has(tag)))) {
        const attrs = propAttributes(node)
        let state
        if (attrs.length > 0) {
          state = attrs.some((a) => forbiddenValueOf(a)) ? 'forbidden' : 'prop'
        } else {
          // The OPENING TAG ONLY, and only its COMMENTS: a comment above the
          // element, a JSX child comment, or a marker in an attribute value are
          // all excluded by construction — see THE OPT-OUT in the header.
          const marker = classifyTagMarker(tagComments(source, node))
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
 *  are rejected by the AST pass, which makes the actual decision. Built FROM
 *  SCROLLABLE_TAGS, and with ANY number of qualifier segments, because a
 *  pre-filter narrower than the matcher (it once allowed exactly one, so
 *  `<RN.Animated.ScrollView>` skipped the parse) is a SILENT miss in the one
 *  artifact whose whole job is preventing silent misses. */
const SITE_PREFILTER = new RegExp(
  `<\\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\\s*\\.\\s*)*(?:${[...SCROLLABLE_TAGS].join('|')})\\b` +
    // …or an ALIASED import of one (`{ ScrollView as NativeScroll }`), whose
    // element text never mentions a scrollable at all. The matcher resolves the
    // binding, so the prefilter has to let the file reach it.
    `|\\b(?:${[...SCROLLABLE_TAGS].join('|')})\\s+as\\s+[A-Za-z_$]`,
)

export function mightCarrySite(src) {
  return SITE_PREFILTER.test(src)
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
 * @returns {{files:number, sites:{rel:string, line:number, tag:string, state:SiteState, text:string}[]}}
 */
export function scanTree(rootDir) {
  const files = []
  walk(rootDir, files)
  const sites = []
  for (const abs of files) {
    // `relative`, not a length slice: a rootDir with a trailing slash used to
    // chop the first character off every path it reported.
    const rel = relative(rootDir, abs).split(sep).join('/')
    const src = readFileSync(abs, 'utf8')
    if (!mightCarrySite(src)) continue
    for (const site of findScrollableSites(src, abs)) sites.push({ rel, ...site })
  }
  return { files: files.length, sites }
}

// ── CLI ───────────────────────────────────────────────────────────────

/** A sample with exactly 3 offenses, 2 forbidden values and 1 prop. If the
 *  matcher stops reproducing that, it is broken and the gate must not report a
 *  pass. Three shapes are in here on purpose because each was, at some point, a
 *  SILENT MISS: the multi-segment namespace (the pre-filter once allowed exactly
 *  one qualifier and skipped that file entirely), the ALIASED import (invisible
 *  to a tag-text matcher), and `{false}` (RN's boolean spelling of "never" — the
 *  bug itself, and it typechecks). */
const POSITIVE_CONTROL = `
import { FlatList as Rows } from 'react-native'

export function Sample() {
  return (
    <>
      <RN.Animated.ScrollView style={styles.x}>
        <Text>body</Text>
      </RN.Animated.ScrollView>
      <FlashList data={rows} renderItem={ri} />
      <Rows data={rows} renderItem={ri} />
      <SectionList keyboardShouldPersistTaps="never" sections={rows} />
      <ScrollView keyboardShouldPersistTaps={false}>
        <Pressable onPress={go} />
      </ScrollView>
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
  // a green line. The pre-filter is checked against the SAME sample, because a
  // pre-filter that rejects a file the matcher would have flagged is a silent
  // miss no offense count can see.
  const control = findScrollableSites(POSITIVE_CONTROL)
  const controlOffenses = control.filter((s) => s.state === 'offense').length
  const controlForbidden = control.filter((s) => s.state === 'forbidden').length
  const controlProps = control.filter((s) => s.state === 'prop').length
  if (
    control.length !== 6 ||
    controlOffenses !== 3 ||
    controlForbidden !== 2 ||
    controlProps !== 1 ||
    !mightCarrySite(POSITIVE_CONTROL)
  ) {
    console.error('KEYBOARD-TAPS GATE: positive control failed — matcher broken, refusing to pass')
    process.exit(1)
  }

  // 2 — NEGATIVE CONTROL. The other direction: a matcher that flagged
  // everything would be just as useless.
  const negative = findScrollableSites(NEGATIVE_CONTROL)
  const negativeBad = negative.filter((s) => s.state !== 'prop' && s.state !== 'exempt').length
  if (negative.length !== 2 || negativeBad !== 0) {
    console.error('KEYBOARD-TAPS GATE: negative control failed — matcher broken, refusing to pass')
    process.exit(1)
  }

  const appDir = process.argv[2] ? resolve(process.argv[2]) : join(import.meta.dir, '..', '..', 'app')
  const { files, sites } = scanTree(appDir)

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
  const forbidden = sites.filter((s) => s.state === 'forbidden')
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
  if (forbidden.length > 0) {
    failed = true
    console.error(
      '\n`keyboardShouldPersistTaps` set to a value the card forbids. "never" is the\n' +
        'React Native default that IS this bug — the first tap is eaten. "always" also\n' +
        'stops a tap on empty space dismissing the keyboard, so the keyboard becomes\n' +
        'hard to get rid of. The value is "handled":',
    )
    for (const s of forbidden) console.error(`  app/${s.rel}:${s.line}  ${s.text}`)
  }

  if (failed) {
    console.error(
      `\nKEYBOARD-TAPS GATE: FAILED — ${missing.length} without the prop, ${forbidden.length} with a forbidden ` +
        `value, ${bare.length} unjustified exemption(s)`,
    )
    process.exit(1)
  }

  console.log(
    'KEYBOARD-TAPS GATE (every app/ scrollable declares keyboardShouldPersistTaps or argues its exemption): ' +
      `${sites.length} sites checked ✅ (${exempt} exempt)`,
  )
}
