import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { foldEntryIntoLog } from './as-built-log.ts'

const ROOT = join(import.meta.dir, '..')
const STAGING_DIR = join(ROOT, '.trident', 'as-built')
const LOG_PATH = join(ROOT, 'docs', 'AS_BUILT.md')

describe('staged as-built entries', () => {
  test('every queued entry folds cleanly into the real log', () => {
    if (!existsSync(STAGING_DIR)) return

    const logText = readFileSync(LOG_PATH, 'utf8')
    const stagedPaths = readdirSync(STAGING_DIR, { recursive: true })
      .map(String)
      .filter((path) => path.endsWith('.md'))
    const failures: { path: string; reason: string }[] = []

    for (const path of stagedPaths) {
      const result = foldEntryIntoLog(logText, readFileSync(join(STAGING_DIR, path), 'utf8'))
      if (!result.ok) failures.push({ path, reason: result.reason })
    }

    expect(failures).toEqual([])
  })
})
