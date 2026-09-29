/**
 * LEDGER-DELTA CLI (test support).
 *
 *   bun tests/fixtures/trident-ledger-delta/cli.ts <input.json>
 *
 * Reads one JSON file of exactly `{ before, after }`, each a ledger string in
 * the strict grammar of `./decode.ts`, decodes both and compares them with
 * `./compare.ts`. Structurally valid input prints exactly one JSON
 * `LedgerDeltaResult` line to stdout and exits 0 only for an accepted delta; a
 * rejected delta still prints its one result line and exits 1. Any usage,
 * read, parse, key or ledger-structure error exits nonzero with a concise
 * stderr line and nothing on stdout. Diagnostics never echo the input's
 * contents. No network, repository, database, provider or environment access;
 * the input file is only read.
 */
import { readFile } from 'node:fs/promises'
import { decodeLedger } from './decode.ts'
import { compareLedgerDelta } from './compare.ts'

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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('input must be an object with exactly the keys before and after', 1)
  }
  const keys = Object.keys(parsed).sort()
  if (keys.length !== 2 || keys[0] !== 'after' || keys[1] !== 'before') {
    return fail('input must be an object with exactly the keys before and after', 1)
  }
  const { before, after } = parsed as { before: unknown; after: unknown }
  if (typeof before !== 'string') return fail('before is not a string', 1)
  if (typeof after !== 'string') return fail('after is not a string', 1)
  // Decoder reasons carry a zero-based line index and rule name only.
  const beforeLedger = decodeLedger(before)
  if (!beforeLedger.ok) return fail(`before ledger: ${beforeLedger.reason}`, 1)
  const afterLedger = decodeLedger(after)
  if (!afterLedger.ok) return fail(`after ledger: ${afterLedger.reason}`, 1)
  const result = compareLedgerDelta(beforeLedger.ledger, afterLedger.ledger)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.ok ? 0 : 1
}

await main(process.argv.slice(2))
