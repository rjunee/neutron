/**
 * EXACT-SCOPE INPUT-USAGE CLI (test support).
 *
 *   bun tests/fixtures/trident-scope-usage-match/cli.ts <input.json>
 *
 * Reads one JSON file of `{ before, after }` sides and prints exactly one JSON
 * comparison line to stdout, exit 0, for every structurally valid input —
 * including unmatched scopes and unknown usage (both are reported, never
 * enforced). Any usage, read, parse or validation error exits nonzero with a
 * concise stderr line and nothing on stdout. Diagnostics never echo the input's
 * contents. No network, repository, database, provider or environment access;
 * the input file is only read.
 */
import { readFile } from 'node:fs/promises'
import { compareScopeUsage, ScopeUsageInputError } from './compare.ts'

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
    // The parser's own message can quote input bytes; never forward it.
    return fail('input is not valid JSON', 1)
  }
  let line: string
  try {
    line = `${JSON.stringify(compareScopeUsage(parsed))}\n`
  } catch (error) {
    // Comparator diagnostics carry a structural path and a rule name only.
    return fail(`invalid scope-usage input: ${error instanceof ScopeUsageInputError ? error.message : 'unrecognized error'}`, 1)
  }
  process.stdout.write(line)
  process.exitCode = 0
}

await main(process.argv.slice(2))
