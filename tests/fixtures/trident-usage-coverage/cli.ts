/**
 * USAGE-COVERAGE CLI (test support).
 *
 *   bun tests/fixtures/trident-usage-coverage/cli.ts <input.json>
 *
 * Reads one JSON file of `{ attemptId, outcome, tokens }` records and prints
 * exactly one JSON summary line to stdout, exit 0 — including when some
 * measurements are unknown (coverage is reported, never enforced). Any usage,
 * read, parse or validation error exits nonzero with a concise stderr line and
 * nothing on stdout. Diagnostics never echo the input's contents. No network,
 * repository, database or environment access; the input file is only read.
 */
import { readFile } from 'node:fs/promises'
import { summarizeUsageCoverage } from './summarize.ts'

function fail(message: string, code: number): void {
  process.stderr.write(`${message}\n`)
  process.exitCode = code
}

async function main(args: readonly string[]): Promise<void> {
  const path = args[0]
  if (args.length !== 1 || path === undefined) return fail('usage: bun cli.ts <input.json>', 2)
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
  let line: string
  try {
    line = `${JSON.stringify(summarizeUsageCoverage(parsed))}\n`
  } catch (error) {
    // Reducer diagnostics carry record indices and rule names only.
    return fail(`invalid usage-coverage input: ${error instanceof Error ? error.message : 'unrecognized error'}`, 1)
  }
  process.stdout.write(line)
  process.exitCode = 0
}

await main(process.argv.slice(2))
