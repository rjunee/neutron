#!/usr/bin/env bun
/**
 * Refuse a narrow, mechanically provable stale-prose shape:
 *
 *   - a diff changes the literal assigned to a named JS/TS `const`; and
 *   - an ADDED Markdown line asserts that identifier's old literal without
 *     also carrying the new literal.
 *
 * Only added prose is judged. Existing historical prose is outside this
 * instrument, as are computed expressions and semantic contradictions whose
 * values are not named literal constants. Narrowness is intentional: a noisy
 * prose gate is soon disabled and then protects nothing.
 *
 * Exit 0 = no proved stale assertion, 1 = stale assertion found,
 * exit 2 = the requested diff could not be inspected.
 */

import { spawnSync } from 'node:child_process'

export type ChangedLiteral = { name: string; before: string; after: string }

type FileDelta = { path: string; removed: string[]; added: string[] }

const SOURCE_SUFFIX = /\.(?:[cm]?[jt]sx?)$/
const CONST_LITERAL = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(.*?)\s*;?\s*$/

function literalValue(rhs: string): string | null {
  const value = rhs.replace(/\s+as\s+const\s*$/, '').replace(/;\s*$/, '').trim()
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?|0[xob][0-9a-f]+)$/i.test(value)) return value
  if (/^(['"])(?:\\.|(?!\1).)*\1$/.test(value)) return value
  if (/^\[(?:\s*(['"])(?:\\.|(?!\1).)*\1\s*(?:,\s*(['"])(?:\\.|(?!\2).)*\2\s*)*)?\]$/.test(value)) return value
  return null
}

function declarations(lines: string[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of lines) {
    const match = CONST_LITERAL.exec(line)
    if (!match) continue
    const value = literalValue(match[2]!)
    if (value !== null) found.set(match[1]!, value)
  }
  return found
}

export function changedLiterals(deltas: FileDelta[]): ChangedLiteral[] {
  const before = new Map<string, string>()
  const after = new Map<string, string>()
  for (const delta of deltas.filter((item) => SOURCE_SUFFIX.test(item.path))) {
    for (const [name, value] of declarations(delta.removed)) before.set(name, value)
    for (const [name, value] of declarations(delta.added)) after.set(name, value)
  }
  return [...before]
    .filter(([name, value]) => after.has(name) && after.get(name) !== value)
    .map(([name, value]) => ({ name, before: value, after: after.get(name)! }))
}

function compact(value: string): string {
  return value.replace(/[\s`'";]/g, '').toLowerCase()
}

export function staleAssertions(
  deltas: FileDelta[],
  changes: ChangedLiteral[],
): Array<ChangedLiteral & { path: string; line: string }> {
  const results: Array<ChangedLiteral & { path: string; line: string }> = []
  for (const delta of deltas.filter((item) => item.path.endsWith('.md'))) {
    for (const line of delta.added) {
      const normalized = compact(line)
      for (const change of changes) {
        if (!line.includes(change.name)) continue
        if (!normalized.includes(compact(change.before))) continue
        // A correction that names both states is not an assertion left stale.
        if (normalized.includes(compact(change.after))) continue
        results.push({ ...change, path: delta.path, line })
      }
    }
  }
  return results
}

export function parseZeroContextDiff(diff: string): FileDelta[] {
  const files: FileDelta[] = []
  let current: FileDelta | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      current = { path: line.slice(6), removed: [], added: [] }
      files.push(current)
      continue
    }
    if (current === null || line.startsWith('--- ') || line.startsWith('@@')) continue
    if (line.startsWith('+')) current.added.push(line.slice(1))
    else if (line.startsWith('-')) current.removed.push(line.slice(1))
  }
  return files
}

function main(): number {
  const base = process.argv[2] ?? process.env.STALE_PROSE_BASE_SHA ?? 'origin/main'
  const head = process.argv[3] ?? process.env.STALE_PROSE_HEAD_SHA ?? 'HEAD'
  const result = spawnSync(
    'git',
    ['diff', '--unified=0', '--no-renames', `${base}...${head}`, '--', '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.md'],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    process.stderr.write(`stale-prose-guard: could not inspect ${base}...${head}; refusing to skip\n${result.stderr}`)
    return 2
  }
  const deltas = parseZeroContextDiff(result.stdout)
  const changes = changedLiterals(deltas)
  const stale = staleAssertions(deltas, changes)
  if (stale.length === 0) {
    console.log(`stale-prose-guard: OK — checked ${changes.length} changed literal constant(s) against added Markdown lines`)
    return 0
  }
  console.error('stale-prose-guard: FAILED — added prose asserts a literal this diff replaced:')
  for (const item of stale) {
    console.error(`  ${item.path}: ${item.name} changed from ${item.before} to ${item.after}`)
    console.error(`    +${item.line}`)
  }
  console.error('This check covers added Markdown assertions about changed JS/TS literal constants only; it does not claim semantic or cross-document coverage.')
  return 1
}

if (import.meta.main) process.exit(main())
