/**
 * Default SourceParser dispatcher tests.
 *
 * K11c (Codex r1) — the OAuth-source purge narrowed `ImportSource` to the
 * two zip sources and removed the parser's OAuth arms. The `switch` now has
 * a `default:` arm that fails loud + typed for any legacy non-zip `source`
 * string a stale DB row could still carry (migration 0040's `import_jobs`
 * CHECK constraint, immutable history, still permits `-oauth` strings).
 *
 * Pins the NEW reject contract (replaces the deleted OAuth-bypass test).
 */

import { expect, test } from 'bun:test'

import { buildDefaultSourceParser } from '../default-source-parser.ts'
import { ImportError, type ImportSource } from '../types.ts'

test('parser rejects a legacy non-zip source with a typed ImportError (parse_failed)', () => {
  const parse = buildDefaultSourceParser()
  // Cast through `unknown`: the narrowed `ImportSource` type rejects the
  // literal, but a legacy DB row can still deliver this string at runtime.
  let thrown: unknown
  try {
    parse('gmail-oauth' as unknown as ImportSource, Buffer.from(''))
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(ImportError)
  expect((thrown as ImportError).code).toBe('parse_failed')
  expect((thrown as ImportError).message).toContain('gmail-oauth')
})
