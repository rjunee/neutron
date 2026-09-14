import { describe, expect, test } from 'bun:test'

import { extractJson, MAX_RESEARCH_RESPONSE_CHARS } from '../src/backend.ts'

describe('extractJson response bound', () => {
  test('refuses oversized model output before fence parsing and preserves ordinary JSON', () => {
    const oversized = `\`\`\`json\n{"ok":true}\n\`\`\`${' '.repeat(MAX_RESEARCH_RESPONSE_CHARS)}`
    expect(() => extractJson(oversized)).toThrow(/response exceeds/)
    expect(extractJson('```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })
})
