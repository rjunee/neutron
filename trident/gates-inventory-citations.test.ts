import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const inventoryPath = resolve(root, 'docs/trident-gates-inventory.md')

test('every test-column file:line citation resolves', () => {
  const rows = readFileSync(inventoryPath, 'utf8').split('\n').filter(line => /^\| G\d{3} \|/.test(line))
  expect(rows).toHaveLength(166)

  const citations: string[] = []
  for (const row of rows) {
    const columns = row.split('|')
    const gate = columns[1]!.trim()
    const testColumn = columns[5]!
    if (testColumn.includes('NO TEST')) continue
    const found = [...testColumn.matchAll(/`([^`]+\.test\.[a-z]+):(\d+)`/g)]
    expect(found.length, `${gate} has no parseable test citation`).toBeGreaterThan(0)
    for (const match of found) citations.push(`${gate} ${match[1]}:${match[2]}`)
  }
  expect(citations.length).toBeGreaterThan(0)

  for (const citation of citations) {
    const match = citation.match(/^(G\d{3}) (.+):(\d+)$/)!
    const [, gate, path, rawLine] = match
    const target = resolve(root, path!)
    expect(existsSync(target), `${gate} cites missing ${path}`).toBe(true)
    const line = Number(rawLine)
    const lines = readFileSync(target, 'utf8').split('\n')
    expect(line, `${gate} cites invalid ${path}:${rawLine}`).toBeGreaterThan(0)
    expect(line, `${gate} cites past EOF ${path}:${rawLine} (${lines.length} lines)`).toBeLessThanOrEqual(lines.length)
  }
})
