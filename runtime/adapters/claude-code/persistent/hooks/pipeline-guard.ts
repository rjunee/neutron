#!/usr/bin/env bun

interface HookInput {
  tool_name?: string
  tool_input?: { command?: unknown }
}

const FULL_BUFFERING_CONSUMERS = new Set(['tail', 'sort', 'wc', 'less', 'tac', 'sponge'])

function pipelineSegments(command: string): string[] {
  const segments: string[] = []
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if (quote !== undefined) { if (char === quote) quote = undefined; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '|' && command[i - 1] !== '|') {
      let start = i + 1
      if (command[start] === '&') start += 1
      let end = start
      let innerQuote: "'" | '"' | undefined
      for (; end < command.length; end += 1) {
        const next = command[end]!
        if (innerQuote !== undefined) { if (next === innerQuote) innerQuote = undefined; continue }
        if (next === "'" || next === '"') { innerQuote = next; continue }
        if (next === '|' || next === ';' || next === '\n') break
      }
      segments.push(command.slice(start, end))
    }
  }
  return segments
}

function shellWords(segment: string): string[] {
  return segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, '$2')) ?? []
}

/** Return the first full-buffering command receiving a pipe, if any. */
export function findBufferedPipelineConsumer(command: string): string | undefined {
  for (const segment of pipelineSegments(command)) {
    const words = shellWords(segment)
    while (words[0] === 'command' || words[0] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift()
    const executable = (words.shift() ?? '').replace(/^\\/, '').split('/').at(-1) ?? ''
    if (FULL_BUFFERING_CONSUMERS.has(executable)) {
      if (executable === 'tail' && words.some((word) => word === '-f' || word === '--follow' || /^-[^-]*f/.test(word))) continue
      return executable
    }
    if (executable === 'jq' && words.some((word) => word === '-s' || word === '--slurp' || /^-[^-]*s/.test(word))) return 'jq -s'
    if (executable === 'column' && words.some((word) => word === '-t' || word === '--table' || /^-[^-]*t/.test(word))) return 'column -t'
  }
  return undefined
}

async function main(): Promise<void> {
  let input: HookInput
  try {
    input = JSON.parse(await Bun.stdin.text()) as HookInput
  } catch {
    process.exit(0)
  }
  if (input.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') process.exit(0)
  const offender = findBufferedPipelineConsumer(input.tool_input.command)
  if (offender === undefined) process.exit(0)
  process.stderr.write(
    `Refused Bash call: pipeline output may not be sent to full-buffering consumer '${offender}' during a chat turn. Redirect to a log file and inspect it in a separate call.\n`,
  )
  process.exit(2)
}

if (import.meta.main) main().catch(() => process.exit(0))
