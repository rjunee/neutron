import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const prompt = readFileSync(join(import.meta.dir, '..', 'repl-agent-base.md'), 'utf8')

describe('persistent REPL agent base prompt', () => {
  it('forbids full-buffering consumers because they hide turn activity', () => {
    expect(prompt).toContain('Never route a command started by a chat turn through a full-buffering consumer')
    expect(prompt).toContain('inactivity timeout can kill a')
    expect(prompt).toContain('healthy but apparently silent turn')
    expect(prompt).toContain('early-exit prefix filter is safe')
  })
})
