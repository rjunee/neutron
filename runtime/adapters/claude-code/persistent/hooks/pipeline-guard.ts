#!/usr/bin/env bun

interface HookInput {
  tool_name?: string
  tool_input?: { command?: unknown }
}

const FULL_BUFFERING_CONSUMERS = ['tail', 'sort'] as const

/** Return the first full-buffering command receiving a pipe, if any. */
export function findBufferedPipelineConsumer(command: string): string | undefined {
  for (const consumer of FULL_BUFFERING_CONSUMERS) {
    const pattern = new RegExp(String.raw`(?:^|[^|])\|\s*(?:command\s+)?${consumer}(?:\s|$)`, 'm')
    if (pattern.test(command)) return consumer
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
