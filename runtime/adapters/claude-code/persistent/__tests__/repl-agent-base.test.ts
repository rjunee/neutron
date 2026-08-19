import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const prompt = readFileSync(join(import.meta.dir, '..', 'repl-agent-base.md'), 'utf8')

describe('persistent REPL agent base prompt', () => {
  it('forbids full-buffering consumers because they hide turn activity', () => {
    expect(prompt).toMatch(/while.{0,80}producer is still running.{0,120}never route/is)
    expect(prompt).toMatch(/full-buffering consumer[\s\S]{0,300}inactivity timeout/i)
    expect(prompt).toMatch(/`tee` with its stdout still[\s\S]{0,40}terminal|background and poll/i)
    expect(prompt).toMatch(/after exit[\s\S]{0,80}`tail -20` is safe/i)
    expect(prompt).toMatch(/early-exit prefix filter does not buffer[\s\S]{0,100}terminate a producer/i)
  })
})
