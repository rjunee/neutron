import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { AS_BUILT_DIR, shardStagedEntry } from './as-built-log.ts'

const ROOT = join(import.meta.dir, '..')
const STAGING_DIR = join(ROOT, '.trident', 'as-built')
const RECORD_DIR = join(ROOT, AS_BUILT_DIR)

describe('staged as-built entries', () => {
  test('every queued entry promotes cleanly into docs/as-built/', () => {
    if (!existsSync(STAGING_DIR)) return

    // The names the appender would be suffixing against, read from the real
    // directory: a queued entry whose slug is already taken is not a failure, it
    // just lands as `<slug>-2.md`.
    const taken = new Set(readdirSync(RECORD_DIR).filter((name) => name.endsWith('.md')))
    const stagedPaths = readdirSync(STAGING_DIR, { recursive: true })
      .map(String)
      .filter((path) => path.endsWith('.md'))
    const failures: { path: string; reason: string }[] = []

    for (const path of stagedPaths) {
      const result = shardStagedEntry(path, readFileSync(join(STAGING_DIR, path), 'utf8'), taken)
      if (!result.ok) failures.push({ path, reason: result.reason })
    }

    expect(failures).toEqual([])
  })
})
