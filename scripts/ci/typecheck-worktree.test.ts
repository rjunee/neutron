import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir
const REPO_ROOT = join(HERE, '..', '..')
const scratch: string[] = []

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function run(cwd: string, command: string, args: string[]) {
  const localTmp = join(cwd, '.fixture-tmp')
  const localCache = join(cwd, '.fixture-bun-cache')
  mkdirSync(localTmp, { recursive: true })
  mkdirSync(localCache, { recursive: true })
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: localTmp,
      TMP: localTmp,
      TEMP: localTmp,
      BUN_INSTALL_CACHE_DIR: localCache,
    },
  })
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function fixture(): { repo: string; fresh: string; linked: string; stale: string } {
  const root = mkdtempSync(join(tmpdir(), 'typecheck-worktree-'))
  scratch.push(root)
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'scripts', 'ci'), { recursive: true })
  mkdirSync(join(repo, 'app'), { recursive: true })
  cpSync(realpathSync(join(REPO_ROOT, 'node_modules', 'typescript')), join(repo, 'vendor', 'typescript'), { recursive: true })
  writeFileSync(
    join(repo, 'vendor', 'typescript', 'package.json'),
    JSON.stringify({ name: 'typescript', version: '5.9.3', main: './lib/typescript.js', bin: { tsc: './bin/tsc' } }),
  )
  copyFileSync(join(HERE, 'typecheck-all.sh'), join(repo, 'scripts', 'ci', 'typecheck-all.sh'))
  copyFileSync(join(HERE, 'verify-workspace-deps.ts'), join(repo, 'scripts', 'ci', 'verify-workspace-deps.ts'))
  chmodSync(join(repo, 'scripts', 'ci', 'typecheck-all.sh'), 0o755)
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
  const localTypeScript = 'file:vendor/typescript'
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, workspaces: ['app'], devDependencies: { typescript: localTypeScript } }))
  writeFileSync(join(repo, 'app', 'package.json'), JSON.stringify({ name: '@fixture/app', dependencies: { typescript: 'file:../vendor/typescript' } }))
  // Model the invalid ancestor entry from the live failure without depending on
  // the invoking checkout. Removing `types: []` must reproduce TS2688 for @types.
  mkdirSync(join(repo, 'app', 'fixture-types', '@types'), { recursive: true })
  writeFileSync(join(repo, 'app', 'fixture-types', '@types', 'package.json'), JSON.stringify({ name: '@types/@types', version: '0.0.0' }))
  writeFileSync(
    join(repo, 'app', 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, typeRoots: ['./fixture-types'], types: [] }, include: ['index.ts'] }),
  )
  writeFileSync(join(repo, 'app', 'index.ts'), 'export const answer: number = 42\n')

  expect(run(repo, 'git', ['init', '-q', '-b', 'main']).code).toBe(0)
  const installed = run(repo, 'bun', ['install'])
  expect(installed.code, installed.out).toBe(0)
  expect(run(repo, 'git', ['add', '.']).code).toBe(0)
  expect(run(repo, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']).code).toBe(0)

  const fresh = join(root, 'fresh')
  const linked = join(root, 'linked')
  const stale = join(root, 'stale')
  expect(run(repo, 'git', ['worktree', 'add', '-q', '--detach', fresh, 'HEAD']).code).toBe(0)
  expect(run(repo, 'git', ['worktree', 'add', '-q', '--detach', linked, 'HEAD']).code).toBe(0)
  expect(run(repo, 'git', ['worktree', 'add', '-q', '--detach', stale, 'HEAD']).code).toBe(0)
  symlinkSync(join(repo, 'node_modules'), join(linked, 'node_modules'))
  writeFileSync(
    join(stale, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['app'], dependencies: { broken: 'file:vendor/missing' }, devDependencies: { typescript: localTypeScript } }),
  )
  return { repo, fresh, linked, stale }
}

describe('typecheck-all — real linked worktrees', () => {
  test('a fresh worktree installs locally and typechecks', () => {
    const { fresh } = fixture()

    const healthy = run(fresh, 'bash', ['scripts/ci/typecheck-all.sh'])
    expect(healthy.code, healthy.out).toBe(0)
    expect(healthy.out).toContain('provisioning worktree dependencies')
    expect(healthy.out).toContain('TYPECHECK MATRIX: ALL PASS')
  }, 120_000)

  test('a shared dependency symlink is refused before typechecking', () => {
    const { linked } = fixture()

    const broken = run(linked, 'bash', ['scripts/ci/typecheck-all.sh'])
    expect(broken.code).toBe(3)
    expect(broken.out).toContain('node_modules is a symlink')
    expect(broken.out).not.toContain('tsc -p')
  }, 120_000)

  test('a frozen-lockfile install failure is refused before typechecking', () => {
    const { stale } = fixture()

    const broken = run(stale, 'bash', ['scripts/ci/typecheck-all.sh'])
    expect(broken.code).toBe(3)
    expect(broken.out).toContain('worktree dependency installation failed')
    expect(broken.out).not.toContain('tsc -p')
  }, 120_000)
})
