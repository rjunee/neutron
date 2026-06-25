/**
 * pty-text.ts — shared PTY text normalisation for dialog-signature matching.
 *
 * The interactive `claude` TUI is an Ink/React terminal app: it positions every
 * word with cursor-move CSI escapes, so a phrase like "using this for local
 * development" is NEVER contiguous in the raw PTY stream — it arrives shredded
 * by `\x1b[…H`/`\x1b[…G` cursor jumps and whitespace. `normalizePtyText`
 * collapses a PTY chunk to bare, escape-free, whitespace-free letters so a
 * signature regex survives the rendering. It is the matching primitive shared
 * by the substrate (disclaimer dismiss + timeout-tail logging), the public
 * ring-read accessor (F1, `pty-ring.ts`), and the output-scan detector
 * framework (F3, `output-scan.ts`).
 *
 * NOTE: this is LOSSY — newlines are stripped too, so it is ONLY for
 * contiguous-signature presence checks. Anything that needs line structure
 * (bottom-N positional guards, `^❯` cursor anchoring, doc-quote guards) must
 * operate on the raw line-split text BEFORE normalising — use {@link stripAnsi}
 * (escapes gone, line structure + spaces kept) for line-anchored matches like
 * the wedged-prompt cursor anchor. See `wedged-prompt-detector.ts`.
 */

/** Drop ANSI/CSI/OSC escapes but KEEP whitespace + newlines, so a line-anchored
 *  regex (`^❯\s*\d+\.`) still works on a single rendered line. The whitespace-
 *  preserving sibling of {@link normalizePtyText}. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
    .replace(/\x1b[[\]()][0-9;?]*[A-Za-z]?/g, '')
}

/** Collapse a PTY chunk to bare letters: drop ANSI/CSI/OSC escapes + all
 *  whitespace so dialog-signature matching survives the Ink TUI's per-word
 *  cursor positioning. */
export function normalizePtyText(s: string): string {
  return stripAnsi(s).replace(/\s+/g, '')
}
