import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  findDuplicateEntryHeadings as findDuplicateEntryHeadingsFromCore,
  parseLog,
  serializeLog,
} from '@neutronai/trident/as-built-log.ts'
// This cross-package import is the subject of the shim-identity pin below.
// eslint-disable-next-line import/no-relative-packages
import { findDuplicateEntryHeadings as findDuplicateEntryHeadingsFromShim } from '../scripts/git/as-built-heading-uniqueness.ts'

const REAL_LOG_PATH = join(import.meta.dir, '..', 'docs', 'AS_BUILT.md')
const PREAMBLE = '# AS_BUILT\n\nRunning log, newest first.\n\n'

describe('as-built entry model', () => {
  test('round-trips the real log byte-for-byte', () => {
    const text = readFileSync(REAL_LOG_PATH, 'utf8')
    expect(serializeLog(parseLog(text))).toBe(text)
  })

  test('headings inside backtick and tilde fences are not entries', () => {
    const text =
      '## 2026-08-17 — quotes headings\n\n```md\n## 2000-01-01 — backtick sample\n```\n\n~~~md\n## 2000-01-02 — tilde sample\n~~~\n'
    const parsed = parseLog(text)
    expect(parsed.entries).toHaveLength(1)
    expect(serializeLog(parsed)).toBe(text)
  })

  test('a tab after the hashes begins an entry', () => {
    expect(parseLog('##\ttitle\n\nbody\n').entries).toHaveLength(1)
  })

  test('hashes without a delimiter do not begin an entry', () => {
    expect(parseLog('##foo\n\nbody\n').entries).toHaveLength(0)
  })
})

describe('the frozen log', () => {
  test('carries the freeze note above every entry, and the entries are still there', () => {
    const text = readFileSync(REAL_LOG_PATH, 'utf8')
    const parsed = parseLog(text)
    // The note is PREAMBLE, not an entry: it must not become the newest record.
    expect(parsed.preamble.join('\n')).toContain('FROZEN as of 2026-09-12')
    expect(parsed.entries.length).toBeGreaterThan(400)
    expect(parsed.entries[0]!.lines[0]).toMatch(/^## \d{4}-\d{2}-\d{2} — /)
    expect(findDuplicateEntryHeadingsFromCore(text)).toEqual([])
  })
})
