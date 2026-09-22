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

// #1133 round 31: the first test reads only the TEST column of `| Gnnn |` rows, so a PROSE
// citation could point at a blank line and nothing went red (the inventory's own positive
// control sat on a blank `inner-workflow.test.ts:979` after the branch moved it to `:995`).
test('the prose positive control for NO TEST adjudication cites a line that names it', () => {
  const inventory = readFileSync(inventoryPath, 'utf8')
  const found = [...inventory.matchAll(/positive control for the latter is `enforceCrossModelGate` in `trident\/inner-workflow\.test\.ts:(\d+)`/g)]
  expect(found).toHaveLength(1)
  const line = Number(found[0]![1])
  const lines = readFileSync(resolve(root, 'trident/inner-workflow.test.ts'), 'utf8').split('\n')
  expect(line).toBeGreaterThan(0)
  expect(lines[line - 1] ?? '', `inner-workflow.test.ts:${line}`).toContain('enforceCrossModelGate')
})
