/**
 * THE APPROVAL PROMPT AND THE APPROVED GRANT MUST DESCRIBE THE SAME THING.
 *
 * An installed MCP server is a subprocess started with the owner's permissions, and
 * the owner is the only gate. Two properties carry that:
 *
 *   1. THE HASH covers everything that decides what runs — so a command, an arg or an
 *      env-var NAME cannot change under an approval the owner already gave.
 *   2. THE PROMPT names everything the hash covers, and never a secret VALUE.
 *
 * The pairing is what the tests below assert, rather than the wording: a prompt that
 * overstates or understates what it grants is worse than no gate, and this repo has
 * already shipped that failure once (an egress approval for a capability the code
 * could not exercise — `docs/as-built/2026-08-09-live-agent-web-tools.md`).
 *
 * The fingerprint gets its own describe block because the two ways to get it wrong
 * have opposite symptoms and both are silent: too sensitive and the warm REPL is
 * evicted on every turn (the owner pays a cold spawn per message); too coarse and a
 * server he installed never appears until a restart.
 */

import { describe, expect, test } from 'bun:test'

import {
  MCP_SERVER_ARGS_MAX,
  MCP_SERVER_BANNED_CHARS_RE,
  MCP_SERVER_ENV_TOTAL_MAX,
  MCP_SERVER_ENV_VALUE_MAX,
  computeMcpServerGrantHash,
  isReservedMcpServerName,
  mcpSurfaceFingerprint,
  parseOwnerMcpServerInput,
  renderMcpServerGrant,
  type ResolvedOwnerMcpServer,
} from '../mcp-servers.ts'

const GOOD = {
  name: 'example-server',
  command: '/usr/local/bin/example-mcp',
  args: ['--stdio', '--region', 'eu'],
  env: { EXAMPLE_API_KEY: 'sk-not-a-real-key', EXAMPLE_REGION: 'eu' },
}

describe('parseOwnerMcpServerInput — the one validator', () => {
  test('accepts a well-formed server and keeps env NAMES only', () => {
    const { spec, env, errors } = parseOwnerMcpServerInput(GOOD)
    expect(errors).toEqual([])
    expect(spec).not.toBeNull()
    expect(spec!.name).toBe('example-server')
    expect(spec!.args).toEqual(['--stdio', '--region', 'eu'])
    // Sorted, so a re-save in a different key order is the SAME grant.
    expect(spec!.env_names).toEqual(['EXAMPLE_API_KEY', 'EXAMPLE_REGION'])
    // The values come back separately, never on the spec.
    expect(env['EXAMPLE_API_KEY']).toBe('sk-not-a-real-key')
    expect(JSON.stringify(spec)).not.toContain('sk-not-a-real-key')
  })

  test('reports EVERY problem, not the first', () => {
    // The owner is the only one who can fix a bad value, and a form that reports one
    // fault per round trip is a form nobody finishes.
    const { spec, errors } = parseOwnerMcpServerInput({ name: 'Bad Name', command: '' })
    expect(spec).toBeNull()
    expect(errors.length).toBeGreaterThan(1)
    expect(errors.join(' ')).toContain('name')
    expect(errors.join(' ')).toContain('command')
  })

  test('refuses the names Neutron\'s own plumbing occupies', () => {
    // A collision would either shadow the agent's only way to reply or be silently
    // dropped, decided by merge order.
    expect(parseOwnerMcpServerInput({ ...GOOD, name: 'neutron' }).spec).toBeNull()
    expect(parseOwnerMcpServerInput({ ...GOOD, name: 'neutron-abcdef' }).spec).toBeNull()
    expect(isReservedMcpServerName('neutron')).toBe(true)
    expect(isReservedMcpServerName('neutron-deadbeef')).toBe(true)
    expect(isReservedMcpServerName('example-server')).toBe(false)
  })

  test('refuses a command carrying a newline or a bidi override', () => {
    // Both would let the rendered prompt show one thing while the exec\'d argv carried
    // another — the prompt lying is the failure this whole gate exists to prevent.
    expect(parseOwnerMcpServerInput({ ...GOOD, command: '/bin/a\n/bin/b' }).spec).toBeNull()
    expect(parseOwnerMcpServerInput({ ...GOOD, command: '/bin/a‮b' }).spec).toBeNull()
    expect(parseOwnerMcpServerInput({ ...GOOD, args: ['--flag​'] }).spec).toBeNull()
  })

  test('refuses every invisible FIVE PROBES FOUND — the regression list, not the definition', () => {
    // TITLED FOR WHAT IT CHECKS. An earlier title claimed this test refused EVERY
    // invisible, which it cannot: it walks a curated list, so it can only ever pin the
    // code points somebody has already thought of — and the whole history below is of
    // that list being found short. It stays because a named regression is worth pinning
    // by name, but the COMPLETENESS claim belongs to the two tests after it: the
    // superset guard, which re-sweeps the entire code space, and the accepted-edge test,
    // which states what is deliberately left out.
    //
    // The first draft of the denylist enumerated the bidi controls, the zero-widths and
    // the C0 controls, and stopped — leaving a whole family of characters that also
    // occupy no width. Measured in a browser against the approval prompt's own type
    // styles, three specs differing only by a WORD JOINER rendered to the identical
    // pixel width, so two grants the hash correctly DISTINGUISHES were indistinguishable
    // on screen. That is a legibility hole rather than a substitution one — an invisible
    // can pad a string but cannot hide a visible character — and it still has to close,
    // because the promise this prompt makes is that the owner can SEE what he approves.
    //
    // Asserted CHARACTER BY CHARACTER, by code point, so a future narrowing of the
    // regex fails here instead of quietly re-opening one range.
    const invisibles: Array<[string, string]> = [
      ['NEL (U+0085)', '\u{0085}'],
      // The rest of the C1 block. An earlier revision banned both of its neighbours
      // — DEL (U+007F) and NEL (U+0085) — and left U+0080-U+0084 / U+0086-U+009F out,
      // though every one of them renders as nothing too: a spec padded with one
      // printed identically to a spec without it while hashing differently, which is
      // the same legibility hole this test exists for. Written as ESCAPES, not literal
      // bytes, so the file stays greppable and no editor can silently eat one; pinned
      // at both ends of the range and either side of the NEL that was already there.
      ['C1 PAD (U+0080)', '\u{0080}'],
      ['C1 U+0084', '\u{0084}'],
      ['C1 U+0086', '\u{0086}'],
      ['C1 APC (U+009F)', '\u{009F}'],
      ['SOFT HYPHEN', '­'],
      ['ARABIC LETTER MARK', '؜'],
      ['MONGOLIAN VOWEL SEPARATOR', '᠎'],
      ['LINE SEPARATOR', ' '],
      ['PARAGRAPH SEPARATOR', ' '],
      ['WORD JOINER', '⁠'],
      ['INVISIBLE TIMES', '⁢'],
      ['DEPRECATED INHIBIT SYMMETRIC SWAPPING', '⁪'],
      ['INTERLINEAR ANNOTATION ANCHOR', '￹'],
      ['TAG SPACE', '\u{E0020}'],
      // THE VARIATION-SELECTOR FAMILY — the gap the TAG block's own argument predicted.
      // A revision banned U+E0000-U+E007F and stopped, leaving the VARIATION SELECTORS
      // SUPPLEMENT (U+E0100-U+E01EF) — the other half of the same default-ignorable
      // family, 0x80 code points further on — accepted, along with its BMP counterparts
      // U+FE00-U+FE0F. Probed against the regex itself, fourteen zero-advance code points
      // came back accepted while four positive controls were correctly refused, so two
      // specs the grant hash distinguishes still printed identically. Pinned at both ends
      // of both ranges.
      ['VARIATION SELECTOR-1 (U+FE00)', '\u{FE00}'],
      ['VARIATION SELECTOR-16 (U+FE0F)', '\u{FE0F}'],
      ['VARIATION SELECTOR-17 (U+E0100)', '\u{E0100}'],
      ['VARIATION SELECTOR-256 (U+E01EF)', '\u{E01EF}'],
      // COMBINING GRAPHEME JOINER and the MONGOLIAN FREE VARIATION SELECTORS: the same
      // zero-advance shape. U+180E (VOWEL SEPARATOR) was already banned alone, which left
      // its immediate neighbours U+180B-U+180D and U+180F out of a contiguous block.
      ['COMBINING GRAPHEME JOINER (U+034F)', '\u{034F}'],
      ['MONGOLIAN FVS ONE (U+180B)', '\u{180B}'],
      ['MONGOLIAN FVS FOUR (U+180F)', '\u{180F}'],
      // BLANK RATHER THAN NARROW: these carry no mark at all, so a spec padded with one
      // reads as trailing space. None has a legitimate place in a path, an arg or an
      // env-var name.
      ['BRAILLE PATTERN BLANK (U+2800)', '\u{2800}'],
      ['HANGUL CHOSEONG FILLER (U+115F)', '\u{115F}'],
      ['HANGUL JUNGSEONG FILLER (U+1160)', '\u{1160}'],
      ['HANGUL FILLER (U+3164)', '\u{3164}'],
      ['HALFWIDTH HANGUL FILLER (U+FFA0)', '\u{FFA0}'],
      // THE TWENTY-FIVE THE FIFTH PROBE FOUND, and the reason the regex is now stated by
      // UNICODE PROPERTY rather than by hand. Every revision above closed the code points
      // one reviewer had probed and left the next batch open; these were all still
      // accepted, all zero-advance, and all capable of making two hash-distinct specs
      // print identically. `\p{Cf}` catches every one of them without naming any, which is
      // the property this block is here to pin: narrow the regex back to an enumeration
      // and these fail again.
      ['ARABIC NUMBER SIGN (U+0600)', '\u{0600}'],
      ['ARABIC NUMBER MARK ABOVE (U+0605)', '\u{0605}'],
      ['ARABIC END OF AYAH (U+06DD)', '\u{06DD}'],
      ['SYRIAC ABBREVIATION MARK (U+070F)', '\u{070F}'],
      ['ARABIC POUND MARK ABOVE (U+0890)', '\u{0890}'],
      ['ARABIC PIASTRE MARK ABOVE (U+0891)', '\u{0891}'],
      ['ARABIC DISPUTED END OF AYAH (U+08E2)', '\u{08E2}'],
      ['KHMER VOWEL INHERENT AQ (U+17B4)', '\u{17B4}'],
      ['KHMER VOWEL INHERENT AA (U+17B5)', '\u{17B5}'],
      ['KAITHI NUMBER SIGN (U+110BD)', '\u{110BD}'],
      ['KAITHI NUMBER SIGN ABOVE (U+110CD)', '\u{110CD}'],
      ['EGYPTIAN HIEROGLYPH VERTICAL JOINER (U+13430)', '\u{13430}'],
      ['EGYPTIAN HIEROGLYPH END WALLED ENCLOSURE (U+13437)', '\u{13437}'],
      ['EGYPTIAN HIEROGLYPH MIRROR VERTICALLY (U+1343F)', '\u{1343F}'],
      ['SHORTHAND FORMAT LETTER OVERLAP (U+1BCA0)', '\u{1BCA0}'],
      ['SHORTHAND FORMAT UP STEP (U+1BCA3)', '\u{1BCA3}'],
      ['MUSICAL SYMBOL BEGIN BEAM (U+1D173)', '\u{1D173}'],
      ['MUSICAL SYMBOL END BEAM (U+1D174)', '\u{1D174}'],
      ['MUSICAL SYMBOL END PHRASE (U+1D17A)', '\u{1D17A}'],
    ]
    for (const [label, ch] of invisibles) {
      expect(MCP_SERVER_BANNED_CHARS_RE.test(ch)).toBe(true)
      // Refused in all three of the fields the grant hash covers, not only in `command`.
      expect(parseOwnerMcpServerInput({ ...GOOD, command: `/bin/a${ch}b` }).spec).toBeNull()
      expect(parseOwnerMcpServerInput({ ...GOOD, args: [`--flag${ch}`] }).spec).toBeNull()
      expect(label.length).toBeGreaterThan(0)
    }
    // A DENYLIST of invisibles, not an allowlist of printable ASCII: a path or an
    // argument can legitimately carry non-ASCII text, and refusing all of it would break
    // working servers to close a rendering hole.
    expect(parseOwnerMcpServerInput({ ...GOOD, command: '/opt/сервер/example-mcp' }).spec).not.toBeNull()
    expect(parseOwnerMcpServerInput({ ...GOOD, args: ['--label', 'für-alle'] }).spec).not.toBeNull()
  })

  test('NARROWING the denylist cannot re-open anything it already closed', () => {
    // THE COMPLETENESS ASSERTION THE CURATED LIST ABOVE CANNOT MAKE, and the guard that
    // makes the fifth revision the last one. Five hand-extensions of this set each read as
    // finished and each was a strict subset of the next; the sixth change is not going to
    // announce itself either. So the SIXTH revision is checked mechanically instead: the
    // regex as it stood BEFORE `\p{Default_Ignorable_Code_Point}` landed is written out here
    // as a literal, and the whole code space is swept to prove the live regex still refuses
    // every code point that one did.
    //
    // A regex is not a set you can subtract, so the sweep IS the comparison. 0x110000 tests
    // of a one-character regex run in well under a second, which is cheaper than a sixth
    // reviewer finding the next batch by hand.
    //
    // What this catches that nothing else does: a later reader "tidying" the class back to
    // the general categories plus a few hand-written ranges — which is exactly the shape of
    // the literal below, and reads as equivalent. It is not. No general category matches an
    // UNASSIGNED code point, and the block reserved for default-ignorables is mostly
    // unassigned (U+2065, U+E0002-U+E001F, U+E0080-U+E00FF, U+E01F0-U+E0FFF) — invisible in
    // every renderer precisely BECAUSE nothing is assigned there, which is why the
    // predecessor needed ranges at all and why each of its ranges was one a reviewer had to
    // find.
    //
    // MUTATION-TESTED BOTH WAYS. Deleting `\p{Default_Ignorable_Code_Point}` outright and
    // keeping the rest fails here with 429 code points named — those are the ones ONLY the
    // property closes out of the 665 the predecessor had. Replacing the whole live class with
    // the predecessor literal accepts 3609 that the live class refuses; that direction is the
    // strict-superset check at the end of this test rather than the sweep, since the sweep
    // only walks what the predecessor closed.
    const PREDECESSOR =
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0000}-\u{E01EF}]/u
    const reopened: string[] = []
    let closedByPredecessor = 0
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue // lone surrogates are not characters
      const ch = String.fromCodePoint(cp)
      if (!PREDECESSOR.test(ch)) continue
      closedByPredecessor += 1
      if (!MCP_SERVER_BANNED_CHARS_RE.test(ch)) reopened.push(`U+${cp.toString(16).toUpperCase()}`)
    }
    expect(reopened).toEqual([])
    // Sanity on the sweep itself: a probe that silently matched nothing would report a
    // clean superset while proving nothing at all (the positive control the invisible-char
    // work needed twice). The predecessor closed 665 code points, so the loop must have
    // examined 665.
    expect(closedByPredecessor).toBe(665)
    // And the union is a STRICT superset, not an equal set — the U+E01F0-U+E0FFF tail the
    // predecessor's own "take the block whole" argument stopped short of, and U+FFF0-U+FFF8
    // next to the interlinear annotation marks it did ban, are the proof.
    // U+2065 is deliberately NOT in this list: the predecessor did ban it, via the whole
    // U+2060-U+206F range. It is the one unassigned default-ignorable a reviewer had already
    // found, which is why the range around it is there — and it is why the four below,
    // sitting in blocks nobody had swept, were still open.
    for (const ch of ['\u{E01F0}', '\u{E0FFF}', '\u{FFF0}', '\u{FFF8}']) {
      expect(PREDECESSOR.test(ch)).toBe(false)
      expect(MCP_SERVER_BANNED_CHARS_RE.test(ch)).toBe(true)
      expect(parseOwnerMcpServerInput({ ...GOOD, command: `/bin/a${ch}b` }).spec).toBeNull()
    }
  })

  test('the whitespace confusables stay ACCEPTED — the documented edge of the denylist', () => {
    // NOT an oversight, and asserted so nobody has to guess. NO-BREAK SPACE, the
    // U+2000-U+200A quads and IDEOGRAPHIC SPACE all ADVANCE: a spec carrying one renders
    // as a visible gap, so it does not create the pixel-identical pair the invisibles
    // above do. They are CONFUSABLE with U+0020 rather than invisible, and confusability
    // is unbounded — the Cyrillic and Greek homoglyphs (`а`, `ο`) are the same hazard and
    // cannot be enumerated either, which is why the Cyrillic path a few lines up is
    // deliberately accepted too. What bounds them is the grant, not this regex: the hash
    // covers the exact bytes of the command, the args and the env-var names, so a
    // confusable cannot be swapped in after an approval without invalidating it.
    //
    // This test is here so a future reader finds a DECISION where they would otherwise
    // find a hole, and so that deciding to ban them becomes a deliberate edit to a
    // failing assertion rather than a silent widening.
    for (const ch of ['\u{00A0}', '\u{2000}', '\u{2007}', '\u{3000}']) {
      expect(MCP_SERVER_BANNED_CHARS_RE.test(ch)).toBe(false)
      expect(parseOwnerMcpServerInput({ ...GOOD, command: `/bin/a${ch}b` }).spec).not.toBeNull()
    }
  })

  test('CANONICAL EQUIVALENTS stay accepted and hash apart — the strongest confusable, decided', () => {
    // The sharpest case of the paragraph above, and the one worth pinning because both
    // available "fixes" are wrong. `/bin/café` composed (U+00E9) and decomposed
    // (`e` + U+0301) render IDENTICALLY — not merely confusably — and hash differently, so
    // they are a pair of grants the owner cannot tell apart by reading them.
    //
    // NEITHER NORMALIZING NOR REFUSING IS RIGHT, which is why the code does neither:
    // normalizing to NFC would change the bytes that get exec'd, and macOS stores
    // filenames decomposed, so a path copied out of a real directory entry would be
    // rewritten into one that need not resolve; refusing non-NFC input would reject those
    // same legitimate paths outright.
    //
    // What bounds it is the hash, not the charset: a form the owner did not approve is a
    // grant he has not given. Asserted so this stays a DECISION, and so banning or
    // normalizing becomes a deliberate edit to a failing assertion.
    const composed = '/bin/café'
    const decomposed = '/bin/café'
    expect(composed).not.toBe(decomposed)
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'))
    const a = parseOwnerMcpServerInput({ ...GOOD, command: composed }).spec
    const b = parseOwnerMcpServerInput({ ...GOOD, command: decomposed }).spec
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    // Different grants, so an approval of one is not an approval of the other.
    expect(computeMcpServerGrantHash(a!)).not.toBe(computeMcpServerGrantHash(b!))
  })

  test('refuses an env name that is not a POSIX variable, and an empty value', () => {
    expect(parseOwnerMcpServerInput({ ...GOOD, env: { 'not-a-var': 'x' } }).spec).toBeNull()
    expect(parseOwnerMcpServerInput({ ...GOOD, env: { GOOD_NAME: '' } }).spec).toBeNull()
  })

  test('never echoes a VALUE in an error message', () => {
    // An error body is a log line waiting to happen.
    const { errors } = parseOwnerMcpServerInput({
      ...GOOD,
      env: { EXAMPLE_API_KEY: 'z'.repeat(MCP_SERVER_ENV_VALUE_MAX + 1) },
    })
    expect(errors.join(' ')).toContain('EXAMPLE_API_KEY')
    expect(errors.join(' ')).not.toContain('zzzz')
  })

  test('caps the arg list rather than truncating it silently', () => {
    const args = Array.from({ length: MCP_SERVER_ARGS_MAX + 1 }, (_, i) => `--a${i}`)
    expect(parseOwnerMcpServerInput({ ...GOOD, args }).spec).toBeNull()
  })

  test('a missing args/env is legal — a bare command is a real MCP server', () => {
    const { spec, errors } = parseOwnerMcpServerInput({ name: 'bare', command: 'example-mcp' })
    expect(errors).toEqual([])
    expect(spec!.args).toEqual([])
    expect(spec!.env_names).toEqual([])
  })

  test('refuses an env payload that passes per-value but blows the AGGREGATE cap', () => {
    // Two values, each legal on its own, whose JSON together exceeds what the credential
    // store will hold. Refused HERE — where the owner is present and gets a complaint —
    // rather than server-side, where it was a thrown error with nothing useful to say.
    const big = 'x'.repeat(MCP_SERVER_ENV_VALUE_MAX)
    const { spec, errors } = parseOwnerMcpServerInput({
      ...GOOD,
      env: { EXAMPLE_ONE: big, EXAMPLE_TWO: big },
    })
    expect(spec).toBeNull()
    expect(errors.join(' ')).toContain(String(MCP_SERVER_ENV_TOTAL_MAX))
    // The complaint reports SIZES and never echoes the payload.
    expect(errors.join(' ')).not.toContain(big.slice(0, 32))
  })
})

describe('computeMcpServerGrantHash — what an approval is bound to', () => {
  const base = parseOwnerMcpServerInput(GOOD).spec!

  test('is stable for the same spec', () => {
    expect(computeMcpServerGrantHash(base)).toBe(
      computeMcpServerGrantHash(parseOwnerMcpServerInput(GOOD).spec!),
    )
  })

  test('CHANGES on a new command, a changed arg, or a new env NAME', () => {
    // Each of these changes what runs, so each must drop the old approval.
    const changed = [
      { ...GOOD, command: '/usr/local/bin/other-mcp' },
      { ...GOOD, args: ['--stdio', '--region', 'us'] },
      { ...GOOD, args: ['--stdio'] },
      { ...GOOD, env: { ...GOOD.env, EXTRA_TOKEN: 'x' } },
    ]
    for (const c of changed) {
      const spec = parseOwnerMcpServerInput(c).spec!
      expect(computeMcpServerGrantHash(spec)).not.toBe(computeMcpServerGrantHash(base))
    }
  })

  test('does NOT change when only a VALUE is rotated', () => {
    // Rotating a token must not silently revoke the approval and stop the assistant
    // working — what was granted is which program runs with which variables set.
    const rotated = parseOwnerMcpServerInput({
      ...GOOD,
      env: { EXAMPLE_API_KEY: 'sk-a-different-value', EXAMPLE_REGION: 'eu' },
    }).spec!
    expect(computeMcpServerGrantHash(rotated)).toBe(computeMcpServerGrantHash(base))
  })

  test('is order-insensitive for env names and order-SENSITIVE for args', () => {
    const reordered = parseOwnerMcpServerInput({
      ...GOOD,
      env: { EXAMPLE_REGION: 'eu', EXAMPLE_API_KEY: 'sk-not-a-real-key' },
    }).spec!
    expect(computeMcpServerGrantHash(reordered)).toBe(computeMcpServerGrantHash(base))
    const swapped = parseOwnerMcpServerInput({ ...GOOD, args: ['--region', '--stdio', 'eu'] }).spec!
    expect(computeMcpServerGrantHash(swapped)).not.toBe(computeMcpServerGrantHash(base))
  })

  test('cannot be forged by moving text across a field boundary', () => {
    // A delimiter-joined hash would collide these two. A canonical JSON array cannot.
    const a = parseOwnerMcpServerInput({ name: 'x', command: 'a', args: ['b'] }).spec!
    const b = parseOwnerMcpServerInput({ name: 'x', command: 'a b', args: [] }).spec!
    expect(computeMcpServerGrantHash(a)).not.toBe(computeMcpServerGrantHash(b))
  })
})

describe('renderMcpServerGrant — the prompt says exactly what the hash covers', () => {
  const spec = parseOwnerMcpServerInput(GOOD).spec!
  const prompt = renderMcpServerGrant(spec)

  test('names the server, the command, EVERY arg, and every env NAME', () => {
    expect(prompt).toContain('example-server')
    expect(prompt).toContain('/usr/local/bin/example-mcp')
    for (const arg of spec.args) expect(prompt).toContain(arg)
    for (const name of spec.env_names) expect(prompt).toContain(name)
  })

  test('never contains a VALUE — the promise it makes about itself', () => {
    expect(prompt).not.toContain('sk-not-a-real-key')
    expect(prompt).toContain('values never')
  })

  test('says what approving PERMITS, and names the tool namespace', () => {
    // "Approve" with no statement of consequence is the understating failure.
    expect(prompt.toLowerCase()).toContain('start this program')
    expect(prompt).toContain('mcp__example-server')
  })

  test('a server with no variables SAYS SO rather than leaving a blank section', () => {
    const bare = parseOwnerMcpServerInput({ name: 'bare', command: 'example-mcp' }).spec!
    expect(renderMcpServerGrant(bare)).toContain('no environment variables')
  })

  test('every field the hash covers appears in the prompt — the pairing, mechanically', () => {
    // The guard against the two halves drifting: change what is hashed without
    // changing what is shown and this fails, whatever the wording is.
    const fields = [spec.name, spec.command, ...spec.args, ...spec.env_names]
    for (const field of fields) expect(prompt).toContain(field)
  })

  test('TWO SPECS THAT HASH DIFFERENTLY NEVER RENDER THE SAME', () => {
    // "Contains every field" is necessary and NOT sufficient, which is how the
    // space-joined command line survived review: `{command:'a b'}` and
    // `{command:'a',args:['b']}` both contain every field and both printed `a b`, so the
    // owner could read one grant and approve the other. Different hash ⇒ different
    // prompt is the property that actually makes the display honest, and these are the
    // adversarial pairs — argv-boundary confusion, whitespace, and arg ORDER.
    const pairs: Array<[unknown, unknown]> = [
      [
        { name: 'ambiguity', command: '/usr/local/bin/example mcp' },
        { name: 'ambiguity', command: '/usr/local/bin/example', args: ['mcp'] },
      ],
      [
        { name: 'ambiguity', command: 'example-mcp', args: ['--flag one', '--other'] },
        { name: 'ambiguity', command: 'example-mcp', args: ['--flag', 'one --other'] },
      ],
      [
        { name: 'ambiguity', command: 'example-mcp', args: ['--a', '--b'] },
        { name: 'ambiguity', command: 'example-mcp', args: ['--b', '--a'] },
      ],
      [
        { name: 'ambiguity', command: 'example-mcp', args: ['--flag'] },
        { name: 'ambiguity', command: 'example-mcp', args: ['--flag '] },
      ],
      [
        { name: 'ambiguity', command: 'example-mcp', args: [] },
        { name: 'ambiguity', command: 'example-mcp', args: [''] },
      ],
    ]
    for (const [rawA, rawB] of pairs) {
      const a = parseOwnerMcpServerInput(rawA).spec
      const b = parseOwnerMcpServerInput(rawB).spec
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      // The premise: these ARE different grants.
      expect(computeMcpServerGrantHash(a!)).not.toBe(computeMcpServerGrantHash(b!))
      // The property: so the owner is shown different text.
      expect(renderMcpServerGrant(a!)).not.toBe(renderMcpServerGrant(b!))
    }
  })

  test('an argument list is numbered in ARGV ORDER, so the order is checkable', () => {
    const ordered = parseOwnerMcpServerInput({
      name: 'ordered',
      command: 'example-mcp',
      args: ['--first', '--second'],
    }).spec!
    const text = renderMcpServerGrant(ordered)
    expect(text.indexOf('--first')).toBeLessThan(text.indexOf('--second'))
    expect(text).toContain('arg 1')
    expect(text).toContain('arg 2')
  })

  test('a server with no ARGUMENTS says so rather than leaving the section empty', () => {
    const bare = parseOwnerMcpServerInput({ name: 'bare', command: 'example-mcp' }).spec!
    expect(renderMcpServerGrant(bare)).toContain('no arguments')
  })

  test('says that removing the server revokes the approval — because it now does', () => {
    expect(prompt).toContain('revokes this approval')
  })
})

describe('mcpSurfaceFingerprint — the warm-session identity of the installed set', () => {
  const one: ResolvedOwnerMcpServer = {
    name: 'example-server',
    command: '/usr/local/bin/example-mcp',
    args: ['--stdio'],
    env_names: ['EXAMPLE_API_KEY'],
    env: { EXAMPLE_API_KEY: 'v1' },
  }

  test('an empty set is the empty string, so a box with nothing installed is inert', () => {
    expect(mcpSurfaceFingerprint([])).toBe('')
  })

  test('EQUAL configuration yields an EQUAL fingerprint — or the pool thrashes', () => {
    // The failure this pins is invisible and expensive: a fingerprint that varied
    // per call would evict the warm REPL on every single turn.
    expect(mcpSurfaceFingerprint([one])).toBe(mcpSurfaceFingerprint([{ ...one }]))
  })

  test('order does not matter — the same two servers are the same surface', () => {
    const two: ResolvedOwnerMcpServer = { ...one, name: 'other-server' }
    expect(mcpSurfaceFingerprint([one, two])).toBe(mcpSurfaceFingerprint([two, one]))
  })

  test('a changed command, arg, added server, or ROTATED VALUE all move it', () => {
    // The rotated value is the one worth stating: a running child holds the old
    // value in its process env, so only a respawn can pick up a new one.
    const base = mcpSurfaceFingerprint([one])
    expect(mcpSurfaceFingerprint([{ ...one, command: '/bin/other' }])).not.toBe(base)
    expect(mcpSurfaceFingerprint([{ ...one, args: ['--http'] }])).not.toBe(base)
    expect(mcpSurfaceFingerprint([one, { ...one, name: 'second' }])).not.toBe(base)
    expect(
      mcpSurfaceFingerprint([{ ...one, env: { EXAMPLE_API_KEY: 'v2' } }]),
    ).not.toBe(base)
  })

  test('is a digest, not the values — nothing recoverable, nothing loggable', () => {
    const fp = mcpSurfaceFingerprint([one])
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    expect(fp).not.toContain('v1')
  })
})
