/**
 * ACCEPTED-CHILD OVERLAP CLI (test support).
 *
 *   bun tests/fixtures/trident-child-overlap/cli.ts <input.json>
 *
 * Reads one JSON file holding exactly two `{ childId, acceptedAt, finishedAt,
 * inputTokens }` records and, when they are structurally valid, prints exactly
 * one JSON result line to stdout:
 *   - exit 0 when the two intervals strictly overlap — including when an input
 *     token count is unknown (coverage is reported, never enforced);
 *   - exit 3 when the records are valid but do not overlap (touching or serial).
 * Any usage error (exit 2), or read, parse or validation error (exit 1), prints
 * one concise stderr line and nothing on stdout. Diagnostics never echo the
 * input's contents. No network, repository, database, provider or environment
 * access; the input file is only read.
 */
import { readFile } from 'node:fs/promises'
import { checkChildOverlap, type ChildOverlapResult } from './check.ts'

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
  let result: ChildOverlapResult
  try {
    result = checkChildOverlap(parsed)
  } catch (error) {
    // Validator diagnostics carry record indices and rule names only.
    return fail(`invalid child-overlap input: ${error instanceof Error ? error.message : 'unrecognized error'}`, 1)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.overlap ? 0 : 3
}

await main(process.argv.slice(2))
