import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const prompt = readFileSync(join(import.meta.dir, '..', 'repl-agent-base.md'), 'utf8')

describe('persistent REPL agent base prompt', () => {
  it('forbids full-buffering consumers because they hide turn activity', () => {
    const rule = prompt.match(/## Long-running commands must emit progress([\s\S]*)/)?.[1] ?? ''
    expect(rule).toContain('full-buffering consumer')
    expect(rule).toMatch(/waits? for EOF|complete output/i)
    expect(rule).toContain('inactivity timeout')
    expect(rule).toMatch(/tee|poll/i)
    expect(rule).toMatch(/early-exit[\s\S]*terminate its producer/i)
  })
})
