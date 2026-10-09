/**
 * SEQUENCE-TRACE CLI (test support).
 *
 *   bun tests/fixtures/trident-sequence-trace/cli.ts <trace.json>
 *
 * Reads one JSON file shaped `{ runId, taskCount, events }`, decodes it with
 * `./decode.ts` and judges its order with `./validate.ts`. Structurally valid
 * input prints exactly one JSON `SequenceValidation` line to stdout and exits 0
 * only for `accepted`; an `incomplete` or `rejected` trace still prints its one
 * result line, with empty stderr, and exits 1. Any usage (exit 2), read, parse
 * or structure error (exit 1) writes one concise stderr line and nothing to
 * stdout. Diagnostics never echo the input's contents: decoder reasons carry a
 * field name or zero-based event index only. No network, repository, database,
 * provider or environment access; the input file is only read.
 */
import { readFile } from 'node:fs/promises'
import { decodeSequenceTrace } from './decode.ts'
import { validateCompletedSequence } from './validate.ts'

function fail(message: string, code: number): void {
  process.stderr.write(`${message}\n`)
  process.exitCode = code
}

async function main(args: readonly string[]): Promise<void> {
  const path = args[0]
  if (args.length !== 1 || path === undefined) return fail('usage: bun cli.ts <trace.json>', 2)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return fail('cannot read input file', 1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('input is not valid JSON', 1)
  }
  const decoded = decodeSequenceTrace(parsed)
  if (!decoded.ok) return fail(`trace: ${decoded.reason}`, 1)
  const result = validateCompletedSequence(decoded.trace)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.status === 'accepted' ? 0 : 1
}

await main(process.argv.slice(2))
