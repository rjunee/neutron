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
const { briefIntegrity, chunkTextOnLines } = sandbox()

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
    const chunks = chunkTextOnLines(brief, CHUNK_BYTES)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(brief)
    // And the receipt over the reassembly is the receipt over the original, which is
    // literally what the wrapper compares.
    expect(briefIntegrity(chunks.join(''))).toBe(briefIntegrity(brief))
  })

  test('every chunk that CAN respect the limit does', () => {
    const brief = `${Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')}\n`
    for (const c of chunkTextOnLines(brief, CHUNK_BYTES)) {
      expect(bytes(c)).toBeLessThanOrEqual(CHUNK_BYTES)
    }
  })

  test('a single line longer than the limit is left WHOLE, not broken', () => {
    // Breaking mid-line is not available: a heredoc emits each line plus its newline,
    // so a mid-line cut would gain a newline on reassembly and fail the receipt.
    // Overshooting the limit is the honest answer; corrupting the brief is not.
    const long = 'x'.repeat(CHUNK_BYTES * 3)
    const brief = `short\n${long}\nshort again\n`
    const chunks = chunkTextOnLines(brief, CHUNK_BYTES)
    expect(chunks.join('')).toBe(brief)
    expect(chunks.some((c) => bytes(c) > CHUNK_BYTES)).toBe(true)
  })

  test('multi-byte characters survive the split', () => {
    // The brief carries the owner's own words. A split that counted UTF-16 units
    // would cut a line budget wrong and, worse, could land mid-character.
    const brief = `${Array.from({ length: 400 }, (_, i) => `строка ${i} — 日本語 — emoji 🙂`).join('\n')}\n`
    const chunks = chunkTextOnLines(brief, CHUNK_BYTES)
    expect(chunks.join('')).toBe(brief)
    expect(briefIntegrity(chunks.join(''))).toBe(briefIntegrity(brief))
  })

  test('degenerate inputs do not produce a file that is not the brief', () => {
    expect(chunkTextOnLines('', CHUNK_BYTES).join('')).toBe('')
    expect(chunkTextOnLines('one\n', CHUNK_BYTES).join('')).toBe('one\n')
    // Blank lines are content: dropping one changes the bytes and fails the receipt.
    const blanks = 'a\n\n\n\nb\n'
    expect(chunkTextOnLines(blanks, CHUNK_BYTES).join('')).toBe(blanks)
  })

  test('a REAL-SIZED brief splits into a workable number of calls', () => {
    // 26 KB is the size that broke; assert it is now carried, and that carrying it
    // does not explode into a call count nobody would follow.
    const brief = `${'a contract line with some words in it\n'.repeat(700)}`
    expect(bytes(brief)).toBeGreaterThan(25_000)
    const chunks = chunkTextOnLines(brief, CHUNK_BYTES)
    expect(chunks.join('')).toBe(brief)
    expect(chunks.length).toBeLessThanOrEqual(16)
  })
})
