import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { migrateGeneralDocsScope } from './docs-general-scope-migration.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'general-docs-scope-'))
  roots.push(value)
  return value
}

describe('General docs scope migration', () => {
  test('moves every docs-owned component and is idempotent', async () => {
    const home = root()
    for (const component of ['docs', '.docs-versions', '.docs-blobs', '.comments']) {
      const dir = join(home, 'Projects', 'general', component)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'proof'), component)
    }

    await migrateGeneralDocsScope(home)
    await migrateGeneralDocsScope(home)

    for (const component of ['docs', '.docs-versions', '.docs-blobs', '.comments']) {
      expect(existsSync(join(home, 'Projects', 'general', component))).toBe(false)
      expect(readFileSync(join(home, 'Projects', '~general', component, 'proof'), 'utf8')).toBe(component)
    }
  })

  test('refuses an ambiguous component instead of overwriting either copy', async () => {
    const home = root()
    const oldDir = join(home, 'Projects', 'general', 'docs')
    const newDir = join(home, 'Projects', '~general', 'docs')
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(oldDir, 'old.md'), 'old')
    writeFileSync(join(newDir, 'new.md'), 'new')

    await expect(migrateGeneralDocsScope(home)).rejects.toThrow('both locations contain docs')
    expect(readFileSync(join(oldDir, 'old.md'), 'utf8')).toBe('old')
    expect(readFileSync(join(newDir, 'new.md'), 'utf8')).toBe('new')
  })
})
