/**
 * pty-ring.ts — F1: the public, line-addressable PTY ring-read accessor.
 *
 * § Terminal-detection port, prereq F1 (docs/research/vajra-terminal-detection-
 * keystroke-port-2026-06-25.md). Vajra's tmux era treated the pane as the I/O
 * channel and read it with `capture-pane`; Neutron moved turn I/O off the
 * terminal, so the only recent-output surface was a private 16 KB closure ring
 * exposed read-only ONLY under `NEUTRON_REPL_DEBUG=1` (`debugRing()`) with no
 * line/bottom-N addressing. EVERY content detector (wedge prompt, auto-approve,
 * compact-resume picker, rate-limit menu) needs to read recent output, so F1
 * promotes that closure into a real `PtyRing` with:
 *
 *   • a widened buffer (64 KB vs the old 16 KB) — the 2026-06-16 Robobuddha miss
 *     was a status panel rendered BELOW the footer; bottom-N positional guards
 *     need enough scrollback to see it (the master-table lesson, row #1/#4).
 *   • `getRecentOutput({ bottomN })` — line-addressable: returns the last N
 *     newline-delimited lines so positional guards (bottom-24) work off a clean
 *     line array, exactly like `capture-pane -S` did.
 *   • optional `normalize` — collapses Ink per-word-cursor ANSI via
 *     `normalizePtyText` so contiguous-signature regexes survive matching.
 *
 * The ring stores the stripPtyNoise'd (DCS/CR-clean) stream the PTY host already
 * feeds `onData`; the heavier full-ANSI strip (`normalizePtyText`) is applied on
 * READ, per matcher need, so the stored text keeps its line structure for the
 * positional / doc-quote guards in `output-scan.ts` (F3).
 */

import { normalizePtyText } from './pty-text.ts'

/** Default ring capacity in bytes. Widened from the legacy 16 KB so bottom-N
 *  guards can see content rendered below the footer (Robobuddha 2026-06-16). */
export const DEFAULT_RING_MAX_BYTES = 64 * 1024

/** Options for {@link PtyRing.getRecentOutput}. */
export interface RecentOutputOpts {
  /** Return only the last N newline-delimited lines (line-addressable read).
   *  Omit for the whole retained buffer. A non-positive value yields ''. */
  bottomN?: number
  /** Collapse ANSI/CSI escapes + whitespace via `normalizePtyText` so a
   *  contiguous-signature regex survives the Ink TUI rendering. Applied AFTER
   *  the bottom-N line slice, so it never destroys the line structure the slice
   *  depends on. Default false (caller gets raw, line-structured text). */
  normalize?: boolean
}

/**
 * A bounded rolling buffer over a PTY child's recent output, with public
 * bottom-N line-addressed reads. One per warm REPL session.
 */
export class PtyRing {
  private buf = ''
  private readonly maxBytes: number
  /** Monotonic count of characters ever appended (does NOT shrink when the rolling
   *  buffer evicts). A caller snapshots this at a boundary via
   *  {@link totalBytesAppended} and later reads {@link textSince} to get only the
   *  output produced after that boundary. */
  private totalAppended = 0

  constructor(maxBytes: number = DEFAULT_RING_MAX_BYTES) {
    this.maxBytes = maxBytes > 0 ? maxBytes : DEFAULT_RING_MAX_BYTES
  }

  /** Append a freshly-emitted chunk, keeping only the last `maxBytes`. */
  append(chunk: string): void {
    this.totalAppended += chunk.length
    this.buf = (this.buf + chunk).slice(-this.maxBytes)
  }

  /** The whole retained buffer, verbatim (line structure preserved). */
  text(): string {
    return this.buf
  }

  /** Total characters ever appended (monotonic; ignores rolling eviction).
   *  Snapshot this at a turn boundary, then pass it to {@link textSince} to read
   *  only the output produced during that turn. */
  totalBytesAppended(): number {
    return this.totalAppended
  }

  /**
   * The retained text appended SINCE `mark` (a prior {@link totalBytesAppended}
   * snapshot) — the last `(now - mark)` characters, clamped to whatever the
   * rolling buffer still holds. Returns '' when nothing has been appended since
   * `mark`. Used to scope a detector to the CURRENT turn's output so a stale
   * banner still sitting in the ring window (from an earlier turn that never
   * scrolled out) can't re-fire it.
   */
  textSince(mark: number): string {
    const newBytes = this.totalAppended - mark
    if (newBytes <= 0) return ''
    return newBytes >= this.buf.length ? this.buf : this.buf.slice(-newBytes)
  }

  /**
   * Recent output for signature matching. With `bottomN` set, returns the last
   * N newline-delimited lines (the line-addressable read every positional
   * detector uses); otherwise the whole retained buffer. With `normalize`,
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
