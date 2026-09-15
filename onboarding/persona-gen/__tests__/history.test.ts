import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { personaHistory, writePersonaVersion, deletePersonaVersion } from '../history.ts'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'persona-history-'))
  roots.push(root)
  return join(root, 'SOUL.md')
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

for (const legacy of [null, '', 'legacy persona']) {
  test(`migration preserves legacy ${JSON.stringify(legacy)} and is idempotent`, () => {
    const path = fixture()
    if (legacy !== null) writeFileSync(path, legacy)
    const baseline = personaHistory(path)
    expect(baseline.map(row => row.content)).toEqual([legacy])
    expect(baseline[0]!.observed_at).toBeGreaterThan(0)
    expect(personaHistory(path)).toEqual(baseline)
    writePersonaVersion(path, 'regenerated')
    writePersonaVersion(path, 'edited')
    expect(readFileSync(path, 'utf8')).toBe('edited')
    expect(personaHistory(path).map(row => row.content)).toEqual([legacy, 'regenerated', 'edited'])
    deletePersonaVersion(path)
    expect(personaHistory(path).map(row => row.content)).toEqual([legacy, 'regenerated', 'edited', null])
  })
}

test('edit imports the legacy preimage without a prior history read', () => {
  const path = fixture()
  writeFileSync(path, 'unversioned')
  writePersonaVersion(path, 'new')
  expect(personaHistory(path).map(row => row.content)).toEqual(['unversioned', 'new'])
})

test('unknown read failure refuses replacement; corrupt history refuses replacement', () => {
  const path = fixture()
  mkdirSync(path)
  expect(() => writePersonaVersion(path, 'replacement')).toThrow()
  rmSync(path, { recursive: true })
  writeFileSync(path, 'prior')
  writeFileSync(join(path, '..', '.persona-history.sqlite'), 'corrupt database')
  expect(() => writePersonaVersion(path, 'replacement')).toThrow()
  expect(readFileSync(path, 'utf8')).toBe('prior')
})


test('a symlink is an unknown read, never a missing baseline', () => {
  const path = fixture()
  symlinkSync('missing-target', path)
  expect(() => writePersonaVersion(path, 'replacement')).toThrow()
})

test('restart snapshots an external edit before deleting it', () => {
  const path = fixture()
  writePersonaVersion(path, 'first')
  writeFileSync(path, 'external edit')
  deletePersonaVersion(path)
  expect(personaHistory(path).map(row => row.content)).toEqual([null, 'first', 'external edit', null])
})
