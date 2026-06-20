/**
 * @neutronai/research-core — chat-command parser unit tests.
 *
 * Per docs/plans/research-core-tier1-brief.md § 2.3.
 */

import { describe, expect, test } from 'bun:test'

import { parseResearchCommand } from '../src/chat-commands.ts'

describe('parseResearchCommand — recognised shapes', () => {
  test('bare /research → help', () => {
    expect(parseResearchCommand('/research').kind).toBe('help')
  })

  test('/research help → help', () => {
    expect(parseResearchCommand('/research help').kind).toBe('help')
  })

  test('/research list → list', () => {
    expect(parseResearchCommand('/research list').kind).toBe('list')
  })

  test('/research deep <topic>', () => {
    const c = parseResearchCommand('/research deep how to ship features')
    expect(c.kind).toBe('deep')
    if (c.kind === 'deep') expect(c.topic).toBe('how to ship features')
  })

  test('/research find <q>', () => {
    const c = parseResearchCommand('/research find shipping containers')
    expect(c.kind).toBe('find')
    if (c.kind === 'find') expect(c.query).toBe('shipping containers')
  })

  test('/research <topic> standard capture (no subcommand keyword)', () => {
    const c = parseResearchCommand('/research how to ship features fast')
    expect(c.kind).toBe('capture')
    if (c.kind === 'capture') expect(c.topic).toBe('how to ship features fast')
  })

  test('/research find with quoted multi-word query (treated as plain text — FTS5 sanitiser handles quoting downstream)', () => {
    const c = parseResearchCommand('/research find "ship date 2026"')
    expect(c.kind).toBe('find')
    if (c.kind === 'find') expect(c.query).toBe('"ship date 2026"')
  })

  test('/research deep without topic → unrecognized usage', () => {
    expect(parseResearchCommand('/research deep').kind).toBe('unrecognized')
  })

  test('/research find without query → unrecognized usage', () => {
    expect(parseResearchCommand('/research find').kind).toBe('unrecognized')
  })

  test('leading whitespace tolerated', () => {
    expect(parseResearchCommand('  /research list').kind).toBe('list')
  })

  test('case-insensitive verb match', () => {
    expect(parseResearchCommand('/Research list').kind).toBe('list')
  })
})

describe('parseResearchCommand — non-matching shapes', () => {
  test('non-/research prefix → unrecognized', () => {
    expect(parseResearchCommand('hello agent').kind).toBe('unrecognized')
  })

  test('/researchfoo (no space) → unrecognized', () => {
    expect(parseResearchCommand('/researchfoo bar').kind).toBe('unrecognized')
  })

  test('empty string → unrecognized', () => {
    expect(parseResearchCommand('').kind).toBe('unrecognized')
  })
})
