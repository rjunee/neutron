import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexProjectHome, materializeCodexAuth, readMaterializedAuth } from './codex-auth.ts'
import { CodexProjectOwnerError, migrateCodexProjectOwner, ownedCodexProjectHome } from './codex-project-owner.ts'

const roots: string[] = []
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-owner-'))
  roots.push(dir)
  return dir
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test('owner succeeds repeatedly; a colliding directory refuses the requesting project', () => {
  const global = root()
  const home = ownedCodexProjectHome(global, 'alpha')
  materializeCodexAuth({ codexHome: home, authJson: 'credential-alpha' })
  expect(ownedCodexProjectHome(global, 'alpha')).toBe(home)
  expect(readMaterializedAuth(home)).toBe('credential-alpha\n')
  // Force the collision outcome at the derived path, without searching for a hash collision.
  cpSync(home, codexProjectHome(global, 'beta'), { recursive: true })
  expect(() => ownedCodexProjectHome(global, 'beta')).toThrow(CodexProjectOwnerError)
  expect(readMaterializedAuth(codexProjectHome(global, 'beta'))).toBe('credential-alpha\n')
})

test('legacy migration on a copy is explicit, preserves live bytes, and is idempotent', () => {
  const original = root()
  const home = codexProjectHome(original, 'alpha')
  materializeCodexAuth({ codexHome: home, authJson: 'refreshed-credential' })
  const copy = root()
  cpSync(original, copy, { recursive: true })
  expect(() => ownedCodexProjectHome(copy, 'alpha')).toThrow(CodexProjectOwnerError)
  expect(migrateCodexProjectOwner(copy, 'alpha')).toEqual({ changed: true })
  expect(migrateCodexProjectOwner(copy, 'alpha')).toEqual({ changed: false })
  const migrated = ownedCodexProjectHome(copy, 'alpha')
  expect(readMaterializedAuth(migrated)).toBe(readMaterializedAuth(home))
  expect(readFileSync(join(migrated, 'project-owner.json'), 'utf8')).toBe('"alpha"\n')
  expect(() => ownedCodexProjectHome(original, 'alpha')).toThrow(CodexProjectOwnerError)
})

test('migration cannot replace a different or malformed owner', () => {
  const global = root()
  const home = ownedCodexProjectHome(global, 'alpha')
  for (const marker of ['"beta"', '{broken', 'null']) {
    writeFileSync(join(home, 'project-owner.json'), marker)
    expect(() => migrateCodexProjectOwner(global, 'alpha')).toThrow(CodexProjectOwnerError)
    expect(() => ownedCodexProjectHome(global, 'alpha')).toThrow(CodexProjectOwnerError)
    expect(readFileSync(join(home, 'project-owner.json'), 'utf8')).toBe(marker)
  }
})

test('empty unmarked directories are not silently adopted, including interrupted creation', () => {
  const global = root()
  mkdirSync(codexProjectHome(global, 'alpha'), { recursive: true })
  expect(() => ownedCodexProjectHome(global, 'alpha')).toThrow(CodexProjectOwnerError)
})

test('invalid project ids cannot claim the global home or an alias', () => {
  const global = root()
  for (const id of ['', 'alpha/beta', 'alpha beta', 'a'.repeat(129)]) {
    expect(() => ownedCodexProjectHome(global, id)).toThrow(CodexProjectOwnerError)
    expect(() => migrateCodexProjectOwner(global, id)).toThrow(CodexProjectOwnerError)
  }
})
