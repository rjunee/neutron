/**
 * THE BRIEF TRANSPORT — that chunking cannot corrupt what it carries.
 *
 * WHY THIS FILE EXISTS. On 2026-08-13 run `000cedc8` could not start a build: the
 * workflow composed a 26,183-byte brief and the bridge agent wrote 24,524 bytes,
 * ending mid-word. The contractual retry produced a BYTE-IDENTICAL wrong copy, so the
 * "one retry" policy — which assumes independent attempts — could never recover it.
 * The brief now travels in `CODEX_BRIEF_CHUNK_BYTES`-sized pieces instead.
 *
 * The property under test is the one the receipt depends on: the pieces must
 * reassemble to EXACTLY the bytes `briefIntegrity` was measured over. If they do not,
 * every build fails closed on a corrupt brief — which is safe, and useless.
 *
 * `inner-workflow.mjs` is not importable (top-level `return`, Workflow-runtime globals,
 * no module resolution), so this reads the source and evaluates the two pure helpers
 * out of it — the same as-built approach `inner-workflow-assembly.test.ts` takes,
 * rather than a parallel copy that could drift from what ships.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

function extract(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} not found in inner-workflow.mjs`)
  // Brace-match from the signature's opening `{` so the whole body comes across.
  const open = SRC.indexOf('{', start)
  let depth = 0
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1
    else if (SRC[i] === '}') {
      depth -= 1
      if (depth === 0) return SRC.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

const CHUNK_BYTES = Number(/const CODEX_BRIEF_CHUNK_BYTES = (\d+)/.exec(SRC)?.[1])

const sandbox = new Function(
  `${extract('briefIntegrity')}\n${extract('chunkTextOnLines')}\nreturn { briefIntegrity, chunkTextOnLines }`,
) as () => {
  briefIntegrity: (s: string) => string
  chunkTextOnLines: (s: string, max: number) => string[]
}
const { briefIntegrity, chunkTextOnLines: rawChunk } = sandbox()

/** The segments, and the reassembly the receipt is taken over. */
const chunk = (s: string, max: number): Array<{ text: string; mode: string }> =>
  rawChunk(s, max) as unknown as Array<{ text: string; mode: string }>
const rejoin = (segs: Array<{ text: string }>): string => segs.map((x) => x.text).join('')

/** Bytes as the receipt counts them, so the assertions speak the receipt's units. */
const bytes = (s: string): number => Number(briefIntegrity(s).split(':')[0])

describe('codex build brief — chunked transport', () => {
  test('the chunk size is well under the observed break, not tuned to its edge', () => {
    // 24,524 bytes copied correctly; 26,183 did not. A limit anywhere near that is a
    // limit set by luck. Guard the ORDER OF MAGNITUDE, not the exact number, so
    // retuning stays possible and creeping back toward the cliff does not.
    expect(CHUNK_BYTES).toBeGreaterThan(0)
    expect(CHUNK_BYTES).toBeLessThanOrEqual(8192)
  })

  test('chunks reassemble to EXACTLY the input — the property the receipt rests on', () => {
    const brief = `${Array.from({ length: 900 }, (_, i) => `line ${i} — some contract text`).join('\n')}\n`
    const segs = chunk(brief, CHUNK_BYTES)
    expect(segs.length).toBeGreaterThan(1)
    expect(rejoin(segs)).toBe(brief)
    // And the receipt over the reassembly is the receipt over the original, which is
    // literally what the wrapper compares.
    expect(briefIntegrity(rejoin(segs))).toBe(briefIntegrity(brief))
  })

  test('every chunk that CAN respect the limit does', () => {
    const brief = `${Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')}\n`
    for (const c of chunk(brief, CHUNK_BYTES)) {
      expect(bytes(c.text)).toBeLessThanOrEqual(CHUNK_BYTES)
    }
  })

  // CODEX REVIEW, ROUND 1 — BLOCKER. The first cut of this function left an oversized
  // line whole and called the overshoot honest. It is not: the brief carries the
  // owner's free-form task text, so one minified JSON blob, base64 payload or generated
  // source line recreates exactly the deterministic truncation this change exists to
  // prevent. A limit ordinary input can exceed is not a limit. These are the boundary
  // cases the reviewer asked for by name.
  test('an over-long line is split by BYTES and still reassembles exactly', () => {
    const long = 'x'.repeat(CHUNK_BYTES * 3)
    const brief = `short\n${long}\nshort again\n`
    const segs = chunk(brief, CHUNK_BYTES)
    expect(rejoin(segs)).toBe(brief)
    for (const s of segs) expect(bytes(s.text)).toBeLessThanOrEqual(CHUNK_BYTES)
    // It could only be carried by the raw (printf) mode — a heredoc cannot express a
    // partial line without inventing a newline.
    expect(segs.some((s) => s.mode === 'raw')).toBe(true)
  })

  test('limit-1, limit, limit+1 — no segment exceeds the bound at any boundary', () => {
    for (const len of [CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1]) {
      const brief = `${'y'.repeat(len)}\n`
      const segs = chunk(brief, CHUNK_BYTES)
      expect(rejoin(segs)).toBe(brief)
      for (const s of segs) expect(bytes(s.text)).toBeLessThanOrEqual(CHUNK_BYTES)
    }
  })

  test('a SINGLE line past the observed 26 KB failure size is carried in bounded pieces', () => {
    // The exact shape that broke the pipeline, as one unbreakable-looking line.
    const brief = `${'z'.repeat(26_183)}\n`
    const segs = chunk(brief, CHUNK_BYTES)
    expect(rejoin(segs)).toBe(brief)
    expect(briefIntegrity(rejoin(segs))).toBe(briefIntegrity(brief))
    for (const s of segs) expect(bytes(s.text)).toBeLessThanOrEqual(CHUNK_BYTES)
  })

  test('an over-long line of MULTI-BYTE text never splits mid-character', () => {
    // Cutting between surrogates would hand printf half a character, and
    // `briefIntegrity` maps a lone surrogate to U+FFFD — so the receipt would disagree
    // with the file and read as corruption rather than as a bug here.
    const brief = `${'🙂'.repeat(4000)}\n`
    const segs = chunk(brief, CHUNK_BYTES)
    expect(rejoin(segs)).toBe(brief)
    expect(briefIntegrity(rejoin(segs))).toBe(briefIntegrity(brief))
    for (const s of segs) {
      expect(bytes(s.text)).toBeLessThanOrEqual(CHUNK_BYTES)
      // WELL-FORMED, not surrogate-free: an emoji IS a surrogate PAIR, so the thing to
      // rule out is a LONE one — a segment cut through the middle of a character.
      expect(s.text.isWellFormed()).toBe(true)
    }
  })

  test('multi-byte characters survive the split', () => {
    // The brief carries the owner's own words. A split that counted UTF-16 units
    // would cut a line budget wrong and, worse, could land mid-character.
    const brief = `${Array.from({ length: 400 }, (_, i) => `строка ${i} — 日本語 — emoji 🙂`).join('\n')}\n`
    const segs = chunk(brief, CHUNK_BYTES)
    expect(rejoin(segs)).toBe(brief)
    expect(briefIntegrity(rejoin(segs))).toBe(briefIntegrity(brief))
  })

  test('degenerate inputs do not produce a file that is not the brief', () => {
    expect(rejoin(chunk('', CHUNK_BYTES))).toBe('')
    expect(rejoin(chunk('one\n', CHUNK_BYTES))).toBe('one\n')
    // Blank lines are content: dropping one changes the bytes and fails the receipt.
    const blanks = 'a\n\n\n\nb\n'
    expect(rejoin(chunk(blanks, CHUNK_BYTES))).toBe(blanks)
  })

  test('a REAL-SIZED brief splits into a workable number of calls', () => {
    // 26 KB is the size that broke; assert it is now carried, and that carrying it
    // does not explode into a call count nobody would follow.
    const brief = `${'a contract line with some words in it\n'.repeat(700)}`
    expect(bytes(brief)).toBeGreaterThan(25_000)
    const segs = chunk(brief, CHUNK_BYTES)
    expect(rejoin(segs)).toBe(brief)
    expect(segs.length).toBeLessThanOrEqual(16)
  })
})
