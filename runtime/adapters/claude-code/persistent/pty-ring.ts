/**
 * pty-ring.ts — the rendered-screen ring: the REPL's most recent screen, with a
 * per-turn "what is new" read.
 *
 * § herdr step 2b. This WAS an append-only byte ring over a raw PTY stream. It is
 * now SNAPSHOT-REPLACE over a rendered screen, because herdr — the REPL container
 * — has no raw output stream to append. `onScreen` is synthesized by polling
 * `pane.read`, so each delivery is the pane's whole current screen, not a chunk.
 *
 * WHY SNAPSHOT-REPLACE AND NOT DIFF-APPEND. Both shapes were available and they
 * break opposite invariants. Diff-append would have kept this file a byte stream,
 * but it breaks the detector FALLING EDGE (`output-scan.ts` — `if (!present) {
 * st.latched = false }`): a cleared menu appends nothing, so `present` never goes
 * false and the latch never drops, and every content detector is a one-shot for
 * the life of the session. Snapshot-replace makes the falling edge correct by
 * construction — a cleared pane simply IS a screen with no menu on it — at the
 * cost of `textSince`, which this file then has to fix. That trade is the right
 * way round, and it is the fix `spawn.ts` already names: the auto-approve
 * detector's documented limitation says in so many words that the proper fix is
 * substrate-level, "a rendered-screen ring". This is that ring.
 *
 * HOW A TURN IS SCOPED WHEN THE RING IS A SCREEN — the central design problem.
 *
 * The old contract was arithmetic: `totalBytesAppended()` handed out a character
 * count, and `textSince(mark)` returned the last `(now - mark)` characters. That
 * is meaningless here. A screen re-rendered unchanged (an Ink TUI repaints
 * constantly) would advance any byte counter by a full screen per poll, so
 * `textSince` would return the entire screen forever — and returning the entire
 * screen is exactly the stale-banner re-arm that per-turn scoping exists to
 * prevent. A counter cannot distinguish "the screen was redrawn" from "the
 * program printed something".
 *
 * So the mark stops being a number and becomes a BASELINE. {@link PtyRing.mark}
 * captures the screen as it read at the turn boundary, and
 * {@link PtyRing.textSince} returns an ORDER-PRESERVING MULTISET DIFFERENCE: walk
 * the current screen top to bottom and emit each line only once the baseline's
 * remaining count for that exact line is used up.
 *
 *   • A MULTISET, not a set, because an identical line can legitimately recur. A
 *     credential banner on screen at the mark and printed AGAIN this turn appears
 *     twice now and once then, so exactly one copy is new. A set difference would
 *     suppress it and blind the detector — a false negative on the very signal
 *     the scoping was added to catch.
 *   • ORDER-PRESERVING, because the consumers feed the result straight into
 *     `buildDetectorContext`, which takes a bottom-N line slice and applies the
 *     doc-quote guard. Both are positional; a bag of lines would break them.
 *
 * This is STRICTLY STRONGER than the byte-count version for the case that
 * motivated per-turn scoping: a line already on screen at the mark is excluded no
 * matter how little has been printed since, whereas the byte count only excluded
 * it once enough bytes had arrived to push it past the mark offset. That gap was
 * the documented limitation. It is weaker in exactly one scoped way, recorded
 * here rather than hidden: a line that was on screen at the mark, scrolled off,
 * and came back byte-identical reads as not-new.
 *
 * Reads are unchanged in shape. `getRecentOutput({ bottomN })` still returns the
 * last N newline-delimited lines, and `normalize` still collapses ANSI on READ
 * rather than on store, so the stored text keeps the line structure the
 * positional guards in `output-scan.ts` depend on.
 */

import { normalizePtyText } from './pty-text.ts'

/**
 * Default retained size in bytes.
 *
 * Sized to hold a WHOLE screen at herdr's measured read cap (999 lines) without
 * clamping: 999 lines of a wide terminal is a couple of hundred KB. The old
 * 64 KB was chosen for a byte stream, where clamping only lost old scrollback;
 * here a clamp would cut the TOP off the current screen, so the cap has to sit
 * above a realistic screen rather than at a stream's working-set size.
 */
export const DEFAULT_RING_MAX_BYTES = 512 * 1024

/**
 * A NOTE ON THE UNIT, because it has been got wrong here once already. Every bound
 * in this file is denominated in UTF-8 BYTES, measured with {@link utf8Bytes} —
 * never `String.length`, which counts UTF-16 code units and is smaller than the
 * byte count for anything non-ASCII. A measurement is only about what it measured:
 * `.length` reads like a size and is not one.
 */

/** Options for {@link PtyRing.getRecentOutput}. */
export interface RecentOutputOpts {
  /** Return only the last N newline-delimited lines (line-addressable read).
   *  Omit for the whole retained screen. A non-positive value yields ''. */
  bottomN?: number
  /** Collapse ANSI/CSI escapes + whitespace via `normalizePtyText` so a
   *  contiguous-signature regex survives the Ink TUI rendering. Applied AFTER
   *  the bottom-N line slice, so it never destroys the line structure the slice
   *  depends on. Default false (caller gets raw, line-structured text). */
  normalize?: boolean
}

/**
 * An opaque turn boundary.
 *
 * It carries the BASELINE SCREEN, not a character count, because on a screen ring
 * "what is new" is only answerable against a baseline (see the file header). Mint
 * one with {@link PtyRing.mark} and read with {@link PtyRing.textSince}. Treat it
 * as opaque: the fields are what `textSince` needs, not a public contract, and
 * nothing may infer a quantity of output from `seq`.
 */
export interface RingMark {
  /** The ring's snapshot sequence when the mark was minted. Diagnostics only —
   *  a MONOTONIC POLL COUNT, never a byte or line quantity. (herdr's own
   *  `revision` is inert, hardcoded 0 on every read, so the ring mints this.) */
  readonly seq: number
  /** The screen, split to lines, as it read when the mark was minted. */
  readonly lines: readonly string[]
}

/**
 * The REPL's most recent rendered screen, with a per-turn "what is new" read.
 * One per warm REPL session.
 */
export class PtyRing {
  private buf = ''
  private readonly maxBytes: number
  /** Monotonic count of snapshots ever accepted. Our own poll sequence — herdr's
   *  `revision` is inert (hardcoded 0 on reads), so it cannot be used. */
  private seq = 0

  constructor(maxBytes: number = DEFAULT_RING_MAX_BYTES) {
    this.maxBytes = maxBytes > 0 ? maxBytes : DEFAULT_RING_MAX_BYTES
  }

  /**
   * Take a freshly-polled screen as the ring's whole contents.
   *
   * REPLACE, NOT APPEND — this is the substrate change. An EMPTY screen is a
   * legitimate snapshot (a cleared pane) and is stored as such, because that is
   * what supplies the detector falling edge. The host must therefore only ever
   * call this for a read that SUCCEEDED: a failed read (the pane has exited and
   * taken its output with it) must be dropped, never delivered as an empty
   * screen, because the ring is the only surviving record of a dead REPL's last
   * output.
   */
  replace(screen: string): void {
    this.seq += 1
    // BYTES, NOT CODE UNITS. `String.length` counts UTF-16 units, which for any
    // non-ASCII screen is FEWER than the UTF-8 bytes it occupies — so comparing it
    // against a byte budget makes the bound too LAX, exactly the direction the same
    // confusion took in the client's short-write check. A screen of 400,000 `é`
    // is 800,000 bytes and was retained untrimmed against a 512 KiB limit.
    this.buf =
      utf8Bytes(screen) > this.maxBytes ? clampLeadingLines(screen, this.maxBytes) : screen
  }

  /** The whole retained screen, verbatim (line structure preserved). */
  text(): string {
    return this.buf
  }

  /** The ring's snapshot sequence — a monotonic poll count, exposed for
   *  diagnostics and tests. NOT a quantity of output. */
  snapshotSeq(): number {
    return this.seq
  }

  /**
   * Mint a turn boundary. Captures the current screen as the baseline; pass the
   * result to {@link textSince} to read only what this turn has put on screen.
   */
  mark(): RingMark {
    return { seq: this.seq, lines: splitScreen(this.buf) }
  }

  /**
   * The lines on the CURRENT screen that were not already on the screen when
   * `mark` was minted — an order-preserving multiset difference (see the file
   * header for why a multiset and why ordered).
   *
   * Returns '' when the screen has nothing the baseline did not already have,
   * which is the same answer the byte-count version gave for "nothing appended
   * since the mark". Used to scope a detector to the CURRENT turn's output so a
   * stale banner still sitting in the ring window — from an earlier turn that
   * never scrolled out — cannot re-fire it.
   */
  textSince(mark: RingMark): string {
    const current = splitScreen(this.buf)
    if (current.length === 0) return ''
    // Remaining occurrences of each line still "explained" by the baseline.
    const remaining = new Map<string, number>()
    for (const line of mark.lines) {
      remaining.set(line, (remaining.get(line) ?? 0) + 1)
    }
    const fresh: string[] = []
    for (const line of current) {
      const left = remaining.get(line)
      if (left !== undefined && left > 0) {
        // Already on screen at the mark — this occurrence is accounted for.
        remaining.set(line, left - 1)
        continue
      }
      fresh.push(line)
    }
    return fresh.join('\n')
  }

  /**
   * Recent output for signature matching. With `bottomN` set, returns the last
   * N newline-delimited lines (the line-addressable read every positional
   * detector uses); otherwise the whole retained screen. With `normalize`,
   * collapses ANSI + whitespace for contiguous-phrase matching.
   */
  getRecentOutput(opts: RecentOutputOpts = {}): string {
    let out = this.buf
    if (opts.bottomN !== undefined) {
      out = bottomNLines(this.buf, opts.bottomN)
    }
    return opts.normalize === true ? normalizePtyText(out) : out
  }
}

/** Split a stored screen to lines, dropping a single trailing newline so it does
 *  not read as an empty last line. '' yields no lines at all (an empty screen has
 *  zero lines, not one blank one). */
function splitScreen(text: string): string[] {
  if (text === '') return []
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed.split('\n')
}

/**
 * Drop WHOLE lines off the front until `text` fits in `maxBytes`.
 *
 * Line-aligned on purpose: a raw `slice(-maxBytes)` can cut mid-line, and every
 * reader here splits on newlines, so a half line would enter the line array as a
 * real line and a positional guard could match on the fragment. Dropping from the
 * front is the least-harmful clamp because every detector read is bottom-anchored.
 *
 * EXPORTED because it has a second consumer, and having ONE implementation is the
 * point. `bun-terminal-host.ts` accumulates a screen out of a byte stream and has to
 * bound it — and bounding it by LINES cannot work, because a line is unbounded: a
 * child emitting output with no newline in it (`yes x | tr -d '\n'`) is one line
 * forever, and any line-count bound retains all of it. The quantity that can bound
 * memory is BYTES, and the character-safe, line-aligned way to cut to a byte budget
 * already existed here. Two copies of that would be two chances to get the surrogate
 * pair or the mid-line cut wrong.
 */
export function clampLeadingLines(text: string, maxBytes: number): string {
  const lines = text.split('\n')
  let start = 0
  let size = utf8Bytes(text)
  while (start < lines.length - 1 && size > maxBytes) {
    size -= utf8Bytes(lines[start] ?? '') + 1
    start += 1
  }
  const out = lines.slice(start).join('\n')
  // A single line longer than the cap still has to be bounded; keep its TAIL,
  // matching the bottom-anchored read direction. Cut on a CHARACTER boundary
  // measured in bytes — `slice(-maxBytes)` counts code units (so it neither
  // respects the budget nor stops at a character) and can split a surrogate pair.
  return utf8Bytes(out) > maxBytes ? tailBytes(out, maxBytes) : out
}

/** UTF-8 size of a string, which is what every bound in this file is denominated
 *  in. Named rather than inlined so no site can quietly go back to `.length`. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The last `maxBytes` UTF-8 bytes of `text`, cut on a character boundary.
 *
 * Slicing a UTF-8 buffer at an arbitrary offset lands mid-character and decodes to
 * U+FFFD, so the start walks forward off any continuation byte (`0b10xxxxxx`). The
 * result is always ≤ `maxBytes` and never contains a character this function
 * created.
 */
function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let start = buf.length - maxBytes
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1
  return buf.toString('utf8', start)
}

/**
 * The last `n` newline-delimited lines of `text`, rejoined with `\n`. A
 * non-positive `n` returns ''. A trailing newline does NOT count as an empty
 * final line (so bottom-1 of "a\nb\n" is "b", matching `capture-pane`/`tail`).
 * Exported so detectors can take a bottom-N slice of any captured text.
 */
export function bottomNLines(text: string, n: number): string {
  if (n <= 0) return ''
  // Drop a single trailing newline so it doesn't read as an empty last line.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = trimmed.split('\n')
  if (lines.length <= n) return trimmed
  return lines.slice(-n).join('\n')
}
