import { describe, expect, test } from 'bun:test'
import { deriveClaimedPaths } from './claimed-paths.ts'

describe('deriveClaimedPaths', () => {
  test('extracts a bare repo-relative path from prose', () => {
    const paths = deriveClaimedPaths({
      task: 'The publish step in trident/inner-workflow.mjs trims the replay patch.',
    })
    expect(paths).toContain('trident/inner-workflow.mjs')
  })

  test('extracts a backticked path', () => {
    const paths = deriveClaimedPaths({ task: 'Add the gates to `trident/board-dispatch.ts`.' })
    expect(paths).toContain('trident/board-dispatch.ts')
  })

  test('ignores URLs — a link is not a file', () => {
    const paths = deriveClaimedPaths({ task: 'See https://a.b/c.d for the rationale.' })
    expect(paths).toEqual([])
  })

  test('ignores version-ish tokens (no slash, no known extension)', () => {
    const paths = deriveClaimedPaths({ task: 'Bump the pinned toolchain to v1.2.3 before building.' })
    expect(paths).not.toContain('v1.2.3')
    expect(paths).toEqual([])
  })

  test('rejects absolute paths and parent escapes', () => {
    const paths = deriveClaimedPaths({
      task: 'Do not read /etc/passwd.txt nor ../secrets/keys.json from here.',
    })
    expect(paths).toEqual([])
  })

  test('dedupes across the task and the plan doc, preserving first-seen order', () => {
    const paths = deriveClaimedPaths({
      task: 'Edit trident/store.ts then trident/tick.ts.',
      planDoc: 'Also `trident/store.ts` — same file, second mention.',
    })
    expect(paths).toEqual(['trident/store.ts', 'trident/tick.ts'])
  })

  test('strips trailing sentence punctuation and a leading ./', () => {
    const paths = deriveClaimedPaths({ task: 'Touch ./work-board/store.ts, then stop.' })
    expect(paths).toEqual(['work-board/store.ts'])
  })

  test('caps at 64 paths', () => {
    const task = Array.from({ length: 100 }, (_, i) => `pkg/file${i}.ts`).join(' ')
    expect(deriveClaimedPaths({ task })).toHaveLength(64)
  })

  test('empty input derives nothing (and therefore can never hold a dispatch)', () => {
    expect(deriveClaimedPaths({ task: '' })).toEqual([])
    expect(deriveClaimedPaths({ task: 'ship the thing', planDoc: null })).toEqual([])
  })
})
