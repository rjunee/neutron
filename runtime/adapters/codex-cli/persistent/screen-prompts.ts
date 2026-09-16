import { stripAnsi } from '../../claude-code/persistent/pty-text.ts'

export type CodexScreenPrompt =
  | { readonly kind: 'approval'; readonly allowKey: string; readonly denyKey: string }
  | { readonly kind: 'trust'; readonly continueKey: string }

function numberedChoice(lines: readonly string[], label: RegExp): string | undefined {
  for (const line of lines) {
    const match = line.match(/^\s*[›❯>]?\s*(\d+)\.\s+(.+)$/)
    if (match !== null && label.test(match[2] ?? '')) return match[1]
  }
  return undefined
}

/** Classify only a complete prompt on the current rendered screen. */
export function detectCodexScreenPrompt(screen: string): CodexScreenPrompt | undefined {
  const lines = stripAnsi(screen).split('\n').map(line => line.replace(/\r/g, ''))
  const text = lines.join('\n')

  if (text.includes('Do you trust the contents of this directory?')) {
    const continueKey = numberedChoice(lines, /^Yes, continue\b/i)
    if (continueKey !== undefined) return { kind: 'trust', continueKey }
    return undefined
  }

  const approvalTitle = [
    'Would you like to run the following command?',
    'Would you like to make the following edits?',
    'Would you like to grant these permissions?',
    'Would you like to send input to the existing terminal?',
  ].some(title => text.includes(title))
  if (!approvalTitle) return undefined

  const allowKey = numberedChoice(lines, /^Yes, /i)
  const denyKey = numberedChoice(lines, /^No(?:,|\b)/i)
  if (allowKey === undefined || denyKey === undefined) return undefined
  return { kind: 'approval', allowKey, denyKey }
}
