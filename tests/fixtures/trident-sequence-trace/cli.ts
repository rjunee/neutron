/**
 * SEQUENCE-TRACE CLI (test support).
 *
 *   bun tests/fixtures/trident-sequence-trace/cli.ts <trace.json>
 *
 * Reads one JSON file shaped `{ runId, taskCount, events }`, decodes its
 * structure (`./decode.ts`) and judges its order (`./validate.ts`). For a
 * structurally valid trace it prints exactly one JSON result line
 * `{ runId, taskCount, events, verdict }` to stdout and exits 0 only when the
 * verdict is `accepted`; `incomplete` and `rejected` still print the result
 * line and exit 1 with nothing on stderr. Usage, read, parse or structure
 * errors print one concise stderr line, nothing on stdout, and exit nonzero.
 * Diagnostics never echo the input's contents; `runId` is copied from the
 * input into the result line only, so a value placed there appears in stdout
 * and never in a diagnostic. No network, repository, database or environment
 * access; the input file is only read.
 */
import { readFile } from 'node:fs/promises'
import { decodeSequenceTrace } from './decode.ts'
import { validateSequenceTrace } from './validate.ts'

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
  const result = decodeSequenceTrace(parsed)
  // Decoder diagnostics carry event indices and rule names only.
  if (!result.ok) return fail(`invalid sequence trace: ${result.error}`, 1)
  const verdict = validateSequenceTrace(result.trace)
  process.stdout.write(`${JSON.stringify({ runId: result.trace.runId, taskCount: result.trace.taskCount, events: result.trace.events.length, verdict })}\n`)
  process.exitCode = verdict === 'accepted' ? 0 : 1
}

await main(process.argv.slice(2))
