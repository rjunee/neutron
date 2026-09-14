import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import { effectivePromptPath, readEffectivePrompt, recordEffectivePrompt } from '../effective-prompt.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function path(): string {
  const root = mkdtempSync(join(tmpdir(), 'effective-prompt-'))
  roots.push(root)
  return effectivePromptPath(root, 'project', 'topic')
}
function spec(prompt: string): AgentSpec {
  return { prompt, tools: [], model_preference: ['test'] }
}
test('cold, warm and reset retain exact dispatch inputs', () => {
  const file = path()
  expect(readEffectivePrompt(file)).toBeNull()
  const cold = spec('persona + project instructions + tool instructions')
  recordEffectivePrompt(file, cold, true)
  recordEffectivePrompt(file, spec('warm message'), false)
  expect(readEffectivePrompt(file)?.session_start).toEqual(cold)
  expect(readEffectivePrompt(file)?.latest_dispatch).toEqual(spec('warm message'))
  recordEffectivePrompt(file, spec('new session'), true)
  expect(readEffectivePrompt(file)?.session_start).toEqual(spec('new session'))
})
test('unknown session start stays unknown and unreadable is distinct from missing', () => {
  const file = path()
  recordEffectivePrompt(file, spec('warm'), false)
  expect(readEffectivePrompt(file)?.session_start).toBeNull()
  const valid = readEffectivePrompt(file)!
  writeFileSync(file, JSON.stringify({ ...valid, format_version: 2 }))
  expect(() => readEffectivePrompt(file)).toThrow()
  writeFileSync(file, 'broken JSON')
  expect(() => readEffectivePrompt(file)).toThrow()
  writeFileSync(file, '{}')
  expect(() => readEffectivePrompt(file)).toThrow()
})
test('project and topic boundaries produce distinct paths', () => {
  expect(effectivePromptPath('data', 'one', 'topic')).not.toBe(effectivePromptPath('data', 'two', 'topic'))
  expect(effectivePromptPath('data', 'one', 'topic')).not.toBe(effectivePromptPath('data', 'one', 'other'))
})


test('cold dispatch replaces an unreadable old record', () => {
  const file = path()
  recordEffectivePrompt(file, spec('old'), true)
  writeFileSync(file, 'broken')
  recordEffectivePrompt(file, spec('fresh'), true)
  expect(readEffectivePrompt(file)?.session_start).toEqual(spec('fresh'))
})

test('record schema rejects malformed specs and timestamps', () => {
  const file = path()
  recordEffectivePrompt(file, spec('valid'), true)
  const valid = readEffectivePrompt(file)!
  for (const invalid of [
    { ...valid, observed_at: null },
    { ...valid, latest_dispatch: null },
    { ...valid, session_start: {} },
    { ...valid, latest_dispatch: { ...spec('p'), tools: null } },
    { ...valid, latest_dispatch: { ...spec('p'), model_preference: null } },
    { ...valid, latest_dispatch: { ...spec('p'), prompt: null } },
  ]) {
    writeFileSync(file, JSON.stringify(invalid))
    expect(() => readEffectivePrompt(file)).toThrow()
  }
})
