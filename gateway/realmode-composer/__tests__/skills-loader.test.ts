/**
 * Sprint A — skills-loader acceptance tests.
 * Plan: docs/plans/2026-05-09-gbrain-methodology-integration-v2.md § 3.4.
 *
 * Six gates:
 *   1. empty `skills/` → `body=''`, no errors
 *   2. four-convention seed → `body` contains all four file contents,
 *      `---` separators, file-path header comments
 *   3. mtime cache hit → second call returns referentially-equal object
 *   4. mtime cache miss after `touch` → next call returns fresh object
 *   5. symlinks rejected
 *   6. >256 KB combined body throws `SkillsLoaderError('body_too_large')`
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadSkills,
  SkillsLoaderError,
  _resetSkillsLoaderCache,
  MAX_BODY_BYTES,
} from '../skills-loader.ts'

let tmpRoot: string

beforeEach(() => {
  _resetSkillsLoaderCache()
  tmpRoot = mkdtempSync(join(tmpdir(), 'skills-loader-test-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function skillsDir(): string {
  return join(tmpRoot, 'skills')
}

function seedFile(relPath: string, body: string): string {
  const abs = join(skillsDir(), relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body, 'utf8')
  return abs
}

test('1. empty skills/ directory yields body="" with no errors', async () => {
  // Don't even create `skillsDir()` — back-compat for pre-Sprint-A instances.
  const out = await loadSkills({ skillsDir: skillsDir() })
  expect(out.body).toBe('')
  expect(out.files).toEqual([])
  expect(out.mtimes).toEqual({})
})

test('1b. existing skills/ root with empty conventions/ also yields body=""', async () => {
  mkdirSync(join(skillsDir(), 'conventions'), { recursive: true })
  const out = await loadSkills({ skillsDir: skillsDir() })
  expect(out.body).toBe('')
  expect(out.files).toEqual([])
})

test('2. four conventions are concatenated in lex order with header + separators', async () => {
  seedFile('conventions/brain-first.md', 'BRAIN_FIRST_BODY\n')
  seedFile('conventions/brain-vs-memory.md', 'BRAIN_VS_MEMORY_BODY\n')
  seedFile('conventions/friction-protocol.md', 'FRICTION_BODY\n')
  seedFile('conventions/quality.md', 'QUALITY_BODY\n')

  const out = await loadSkills({ skillsDir: skillsDir() })
  expect(out.files).toEqual([
    'conventions/brain-first.md',
    'conventions/brain-vs-memory.md',
    'conventions/friction-protocol.md',
    'conventions/quality.md',
  ])
  expect(out.body).toContain('BRAIN_FIRST_BODY')
  expect(out.body).toContain('BRAIN_VS_MEMORY_BODY')
  expect(out.body).toContain('FRICTION_BODY')
  expect(out.body).toContain('QUALITY_BODY')
  expect(out.body).toContain('<!-- skill: conventions/brain-first.md -->')
  expect(out.body).toContain('<!-- skill: conventions/quality.md -->')
  // Three `---` separators between the four files (no leading separator
  // before the first file).
  expect(out.body.match(/\n---\n/g)?.length ?? 0).toBe(3)
})

test('3. mtime cache hit returns referentially-equal object on repeat call', async () => {
  seedFile('conventions/brain-first.md', 'x\n')
  const first = await loadSkills({ skillsDir: skillsDir() })
  const second = await loadSkills({ skillsDir: skillsDir() })
  expect(second).toBe(first)
})

test('4. mtime cache miss after touch returns a fresh object with new content', async () => {
  const filePath = seedFile('conventions/brain-first.md', 'original\n')
  const first = await loadSkills({ skillsDir: skillsDir() })
  expect(first.body).toContain('original')

  // Bump mtime by 2 seconds and rewrite — guarantees a different mtimeMs
  // even on filesystems with second-granularity mtimes.
  writeFileSync(filePath, 'updated\n', 'utf8')
  const original = statSync(filePath)
  utimesSync(filePath, original.atime, new Date(original.mtimeMs + 2_000))

  const second = await loadSkills({ skillsDir: skillsDir() })
  expect(second).not.toBe(first)
  expect(second.body).toContain('updated')
  expect(second.body).not.toContain('original')
})

test('5a. symlinked skill file is rejected', async () => {
  const targetPath = join(tmpRoot, 'outside.md')
  writeFileSync(targetPath, 'malicious\n', 'utf8')
  mkdirSync(join(skillsDir(), 'conventions'), { recursive: true })
  symlinkSync(targetPath, join(skillsDir(), 'conventions', 'sneaky.md'))

  let err: unknown = null
  try {
    await loadSkills({ skillsDir: skillsDir() })
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(SkillsLoaderError)
  expect((err as SkillsLoaderError).code).toBe('symlink_rejected')
})

test('5b. symlinked conventions subdir is rejected', async () => {
  const targetDir = join(tmpRoot, 'outside-conventions')
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'evil.md'), 'evil\n', 'utf8')
  mkdirSync(skillsDir(), { recursive: true })
  symlinkSync(targetDir, join(skillsDir(), 'conventions'))

  let err: unknown = null
  try {
    await loadSkills({ skillsDir: skillsDir() })
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(SkillsLoaderError)
  expect((err as SkillsLoaderError).code).toBe('symlink_rejected')
})

test('5c. symlinked skillsDir root is rejected', async () => {
  const targetDir = join(tmpRoot, 'outside-root')
  mkdirSync(join(targetDir, 'conventions'), { recursive: true })
  writeFileSync(join(targetDir, 'conventions', 'x.md'), 'x\n', 'utf8')
  symlinkSync(targetDir, skillsDir())

  let err: unknown = null
  try {
    await loadSkills({ skillsDir: skillsDir() })
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(SkillsLoaderError)
  expect((err as SkillsLoaderError).code).toBe('symlink_rejected')
})

test('6. body > 256 KB throws SkillsLoaderError("body_too_large")', async () => {
  // 130 KB per file × 3 files = ~390 KB, well past the cap.
  const blob = 'x'.repeat(130 * 1024)
  seedFile('conventions/a.md', blob)
  seedFile('conventions/b.md', blob)
  seedFile('conventions/c.md', blob)

  let err: unknown = null
  try {
    await loadSkills({ skillsDir: skillsDir() })
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(SkillsLoaderError)
  expect((err as SkillsLoaderError).code).toBe('body_too_large')
  expect((err as SkillsLoaderError).message).toMatch(/262144|256/)
  // Sanity: cap constant is the expected 256 KB.
  expect(MAX_BODY_BYTES).toBe(256 * 1024)
})

test('non-md files and hidden files are ignored', async () => {
  seedFile('conventions/brain-first.md', 'good\n')
  seedFile('conventions/.hidden.md', 'should-not-appear\n')
  seedFile('conventions/notes.txt', 'should-not-appear\n')

  const out = await loadSkills({ skillsDir: skillsDir() })
  expect(out.files).toEqual(['conventions/brain-first.md'])
  expect(out.body).not.toContain('should-not-appear')
})

test('subdirs option filters which subdirectories are read', async () => {
  seedFile('conventions/brain-first.md', 'CONV\n')
  seedFile('onboarding/welcome.md', 'ONBOARD\n')

  const defaults = await loadSkills({ skillsDir: skillsDir() })
  expect(defaults.body).toContain('CONV')
  expect(defaults.body).not.toContain('ONBOARD')

  _resetSkillsLoaderCache()
  const both = await loadSkills({
    skillsDir: skillsDir(),
    subdirs: ['conventions', 'onboarding'],
  })
  expect(both.body).toContain('CONV')
  expect(both.body).toContain('ONBOARD')
})
