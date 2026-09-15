import { afterAll, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = fileURLToPath(new URL('./stale-prose-guard.ts', import.meta.url))
const CI_HOST = fileURLToPath(new URL('./check-governed-repo-attributes.ts', import.meta.url))
const repos: string[] = []

afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function commit(repo: string, message: string): string {
  git(repo, 'add', '-A')
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message)
  return git(repo, 'rev-parse', 'HEAD')
}

function fixture(): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), 'stale-prose-'))
  repos.push(repo)
  git(repo, 'init', '-q', '--initial-branch=main')
  mkdirSync(join(repo, 'src'))
  mkdirSync(join(repo, 'docs'))
  writeFileSync(join(repo, 'src', 'policy.ts'), "export const TOOL_NAMES = ['Read', 'Grep'] as const\n")
  writeFileSync(join(repo, 'docs', 'existing.md'), "`TOOL_NAMES` is `['Read', 'Grep']`.\n")
  const base = commit(repo, 'base')
  return { repo, base }
}

function run(repo: string, base: string, head: string): { status: number; output: string } {
  const result = spawnSync('bun', [GUARD, base, head], { cwd: repo, encoding: 'utf8' })
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
}

test('refuses an added Markdown assertion of the literal replaced in the same diff', () => {
  const { repo, base } = fixture()
  writeFileSync(join(repo, 'src', 'policy.ts'), 'export const TOOL_NAMES = [] as const\n')
  writeFileSync(join(repo, 'docs', 'record.md'), "The enforced value of `TOOL_NAMES` is `['Read', 'Grep']`.\n")
  const head = commit(repo, 'stale record')

  const result = run(repo, base, head)
  expect(result.status).toBe(1)
  expect(result.output).toContain('docs/record.md')
  expect(result.output).toContain('TOOL_NAMES changed')
})

test('does not flag a symbol mentioned only in unchanged prose', () => {
  const { repo, base } = fixture()
  writeFileSync(join(repo, 'src', 'policy.ts'), 'export const TOOL_NAMES = [] as const\n')
  const head = commit(repo, 'code only')

  const result = run(repo, base, head)
  expect(result.status).toBe(0)
  expect(result.output).toContain('checked 1 changed literal constant')
})

test('accepts added prose carrying the old state only as an explicit old-to-new correction', () => {
  const { repo, base } = fixture()
  writeFileSync(join(repo, 'src', 'policy.ts'), 'export const TOOL_NAMES = [] as const\n')
  writeFileSync(join(repo, 'docs', 'record.md'), "`TOOL_NAMES` was `['Read', 'Grep']`; it is now `[]`.\n")
  const head = commit(repo, 'correct record')

  expect(run(repo, base, head).status).toBe(0)
})

test('fails closed when the requested diff cannot be read', () => {
  const { repo, base } = fixture()
  const result = run(repo, base, 'missing-ref')
  expect(result.status).toBe(2)
  expect(result.output).toContain('refusing to skip')
})

test('the already-required layering entry point invokes the guard', () => {
  const host = readFileSync(CI_HOST, 'utf8')
  expect(host.match(/^guardChangedLiteralProse\(\)$/gm)?.length).toBe(1)
  expect(host).toContain("join(here, 'stale-prose-guard.ts')")
})
