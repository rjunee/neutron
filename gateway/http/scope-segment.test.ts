import { describe, expect, test } from 'bun:test'

import { resolveScopeSegment } from './scope-segment.ts'

describe('resolveScopeSegment', () => {
  test('accepts only the exact reserved scope alongside legal project ids', () => {
    expect(resolveScopeSegment('~general')).toBe('~general')
    expect(resolveScopeSegment('general')).toBe('general')
    expect(resolveScopeSegment('~general')).not.toBe(resolveScopeSegment('general'))
    expect(resolveScopeSegment('~generalize')).toBeNull()
    expect(resolveScopeSegment('known-project')).toBe('known-project')
  })

  test('all four project-path surfaces use the resolver', async () => {
    const files = [
      'app-docs-surface.ts',
      'app-tabs-surface.ts',
      'work-board-surface.ts',
      'activity-surface.ts',
    ]
    for (const file of files) {
      const source = await Bun.file(new URL(file, import.meta.url)).text()
      expect(source).toContain('resolveScopeSegment')
    }
  })
})
