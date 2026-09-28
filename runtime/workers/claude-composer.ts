import { stripAnsi } from '../adapters/claude-code/persistent/pty-text.ts'

/** Observe the rendered composer, not a historical prompt in scrollback. Claude
 * draws its input between two rules; everything between them belongs to the
 * draft, including continuation lines after an empty first line. Unknown chrome
 * is not evidence that Enter is safe. This is an observation, not an input lock. */
export function claudeComposerEmpty(screen: string): boolean {
  const lines = stripAnsi(screen).replace(/\r/g, '').trimEnd().split('\n')
  const rule = (line: string) => /^\s*─{3,}\s*$/.test(line)
  const bottom = lines.findLastIndex(rule)
  if (bottom < 0 || lines.length - bottom > 12) return false
  const top = lines.slice(0, bottom).findLastIndex(rule)
  if (top < 0 || lines[top] !== lines[bottom]) return false
  const input = lines.slice(top + 1, bottom).filter(line => line.trim() !== '')
  const margin = /^\s*/.exec(lines[bottom]!)![0]
  // A continuation line is indented inside the composer. It cannot stand in
  // for the outer prompt or rule merely because it quotes their glyphs.
  if (input.length !== 1 || !input[0]!.startsWith(`${margin}❯`) || input[0]!.slice(margin.length + 1).trim() !== '') return false
  // Working/menu chrome is not a ready composer even when the input is blank.
  const footer = lines.slice(bottom + 1).join('\n')
  return !/esc\s+to\s+(?:interrupt|cancel)|enter\s+to\s+(?:select|confirm)|[❯›]/i.test(footer)
}
