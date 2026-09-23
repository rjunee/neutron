import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnCapture } from './git-mode.ts'
import { createMutationProver, mutationFailureSummary, runMutationProofGate, spawnGuardCommand } from './mutation-prover.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function command(cwd: string, ...argv: string[]) {
  const result = await spawnCapture(argv, cwd)
  if (!result.ok) throw new Error(`${argv.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
async function seed() {
  const repo = mkdtempSync(join(tmpdir(), 'mutation-workspace-'))
  roots.push(repo)
  await command(repo, 'git', 'init', '-q', '--initial-branch=main')
  await command(repo, 'git', 'config', 'user.name', 'Test Setup')
  await command(repo, 'git', 'config', 'user.email', 'setup@neutron.local')
  const put = (file: string, text: string) => writeFileSync(join(repo, file), text)
  mkdirSync(join(repo, 'packages', 'limit'), { recursive: true })
  mkdirSync(join(repo, 'packages', 'schema'), { recursive: true })
  mkdirSync(join(repo, 'tests'))
  put('.gitignore', 'node_modules/\n.trident-worktrees/\n')
  put('package.json', JSON.stringify({ name: 'fixture', workspaces: ['packages/*'],
    dependencies: { '@fixture/limit': 'workspace:*', '@fixture/schema': 'workspace:*' },
    scripts: { postinstall: `bun -e 'require("fs").writeFileSync(${JSON.stringify(join(repo, 'hook-ran'))}, "ran")'` } }))
  put('packages/limit/package.json', JSON.stringify({ name: '@fixture/limit', exports: './index.ts' }))
  put('packages/schema/package.json', JSON.stringify({ name: '@fixture/schema', exports: './index.ts' }))
  put('packages/limit/index.ts', 'export const limit = 1\n')
  put('packages/schema/index.ts', 'export const schema = 1\n')
  put('tests/guard.test.ts', "import { expect, test } from 'bun:test'; import { limit } from '@fixture/limit'; test('ceiling', () => expect(limit).toBe(2))\n")
  put('tests/control.test.ts', "import { expect, test } from 'bun:test'; import { schema } from '@fixture/schema'; test('schema is this commit', () => expect(schema).toBe(2))\n")
  await command(repo, 'bun', 'install', '--ignore-scripts', '--no-progress')
  await command(repo, 'git', 'add', '.')
  await command(repo, 'git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed')
  await command(repo, 'git', 'switch', '-qc', 'trident/proof')
  put('packages/limit/index.ts', 'export const limit = 2\n')
  put('packages/schema/index.ts', 'export const schema = 2\n')
  await command(repo, 'git', 'add', '.')
  await command(repo, 'git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'new behavior and schema')
  const head = await command(repo, 'git', 'rev-parse', 'HEAD')
  await command(repo, 'git', 'switch', '-q', 'main')
  const run = { id: 'workspace-proof', slug: 'workspace-proof', repo_path: repo, branch: 'trident/proof' }
  const claim = { file: 'packages/limit/index.ts', find: 'limit = 2', replace: 'limit = 0',
    guard: ['bun', 'test', 'tests/guard.test.ts'], control: ['bun', 'test', 'tests/control.test.ts'] }
  return { repo, head, run, claim }
}

test('real detached proof sees its workspace code and schema, on both observations, without install hooks', async () => {
  const f = await seed()
  // Same ancestor-resolution shape as production: a new commit beneath an old
  // checkout with installed workspace aliases. This control must actually fail.
  const candidate = join(f.repo, '.trident-worktrees', 'candidate')
  await command(f.repo, 'git', 'worktree', 'add', '--detach', candidate, f.head)
  const oldResolution = await spawnCapture(f.claim.control, candidate)
  expect(oldResolution.ok).toBe(false)
  expect(oldResolution.stderr).toContain('Received: 1')
  const calls: string[][] = []
  const result = await runMutationProofGate({ run: f.run, claim: f.claim, expected_head: f.head,
    base_branch: 'main', run_host: spawnCapture,
    run_guard: async (argv, cwd, signal) => { calls.push(argv); return spawnGuardCommand(argv, cwd, signal) } })
  expect(result.ok).toBe(true)
  expect(result.evidence?.observed?.guard_mutated.exit_code).toBe(1)
  expect(result.evidence?.observed?.control_mutated.exit_code).toBe(0)
  expect(result.evidence?.observed?.guard_restored.exit_code).toBe(0)
  expect(calls.filter(argv => argv[1] === 'install')).toHaveLength(2)
  expect(existsSync(join(f.repo, 'hook-ran'))).toBe(false)
  expect(readFileSync(join(f.repo, 'packages/schema/index.ts'), 'utf8')).toContain('schema = 1')
  // Positive control: the committed hook really executes if scripts are enabled.
  await command(candidate, 'bun', 'install', '--frozen-lockfile', '--no-progress')
  expect(readFileSync(join(f.repo, 'hook-ran'), 'utf8')).toBe('ran')
}, 30_000)

test('frozen install failure refuses before any guard and cannot fall back to ancestor packages', async () => {
  const f = await seed()
  const calls: string[][] = []
  const prover = createMutationProver({ run_host: spawnCapture, run_guard: async argv => {
    calls.push(argv)
    return { ok: false, exit_code: 17, stdout: 'private diagnostic must not leak', stderr: '', timed_out: false }
  } })
  const result = await prover.prove({ run: f.run, claim: f.claim, head_sha: f.head })
  expect(result.proved).toBe(false)
  expect(result.observed).toBeNull()
  expect(result.reason).toContain('frozen install failed (exit 17')
  expect(result.reason).not.toContain('private diagnostic')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.slice(0, 2)).toEqual(['bun', 'install'])
}, 30_000)

test('a broad mutation still refuses when the control observes the same broken behavior', async () => {
  const f = await seed()
  const result = await runMutationProofGate({ run: f.run, claim: { ...f.claim,
    control: ['bun', 'test', 'tests/guard.test.ts', '--timeout', '4000'] },
    expected_head: f.head, base_branch: 'main', run_host: spawnCapture })
  expect(result.ok).toBe(false)
  expect(result.evidence?.observed, result.reason).not.toBeNull()
  expect(result.evidence?.observed?.control_mutated.exit_code).toBe(1)
  expect(result.reason).toContain('control did not stay GREEN')
}, 30_000)

for (const destination of ['node_modules', 'packages/limit/node_modules']) {
  test(`committed ${destination} symlink cannot make dependency provisioning write outside its tree`, async () => {
    const f = await seed()
    const shared = mkdtempSync(join(tmpdir(), 'mutation-shared-'))
    roots.push(shared)
    writeFileSync(join(shared, 'control.txt'), 'preserved')
    await command(f.repo, 'git', 'switch', '-q', 'trident/proof')
    rmSync(join(f.repo, destination), { recursive: true, force: true })
    symlinkSync(shared, join(f.repo, destination))
    await command(f.repo, 'git', 'add', '-f', destination)
    await command(f.repo, 'git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'tracked install destination')
    const calls: string[][] = []
    const prover = createMutationProver({ run_host: spawnCapture, run_guard: async (argv, cwd, signal) => {
      calls.push(argv)
      return spawnGuardCommand(argv, cwd, signal)
    } })
    const result = await prover.prove({ run: f.run, claim: f.claim })
    expect(readdirSync(shared)).toEqual(['control.txt'])
    expect(readFileSync(join(shared, 'control.txt'), 'utf8')).toBe('preserved')
    expect(calls).toHaveLength(0)
    expect(result.proved).toBe(false)
    expect(result.reason).toContain('install destination already exists')
  }, 30_000)
}

test('a non-Bun workspace can still prove ordinary relative-import tests without a Bun lockfile', async () => {
  const f = await seed()
  await command(f.repo, 'git', 'switch', '-q', 'trident/proof')
  unlinkSync(join(f.repo, 'bun.lock'))
  writeFileSync(join(f.repo, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'npm@10.0.0', workspaces: ['packages/*'] }))
  writeFileSync(join(f.repo, 'tests/guard.test.ts'), "import { expect, test } from 'bun:test'; import { limit } from '../packages/limit/index.ts'; test('ceiling', () => expect(limit).toBe(2))\n")
  writeFileSync(join(f.repo, 'tests/control.test.ts'), "import { expect, test } from 'bun:test'; import { schema } from '../packages/schema/index.ts'; test('schema', () => expect(schema).toBe(2))\n")
  await command(f.repo, 'git', 'add', '-A')
  await command(f.repo, 'git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'non bun workspace')
  const calls: string[][] = []
  const prover = createMutationProver({ run_host: spawnCapture, run_guard: async (argv, cwd, signal) => {
    calls.push(argv)
    return spawnGuardCommand(argv, cwd, signal)
  } })
  const result = await prover.prove({ run: f.run, claim: f.claim })
  expect(result.proved, result.reason).toBe(true)
  expect(calls).toHaveLength(3)
  expect(calls.every(argv => argv[1] === 'test')).toBe(true)
}, 30_000)

test('control failure preserves a fixed diagnostic category and digest, never raw output', async () => {
  const f = await seed()
  const prover = createMutationProver({ run_host: spawnCapture, run_guard: async (argv, cwd, signal) => {
    if (argv[2] === 'tests/control.test.ts') return { ok: false, exit_code: 1, stdout: '',
      stderr: 'SQLiteError: table private_table has no column named secret_column\nTOKEN=do-not-retain', }
    return spawnGuardCommand(argv, cwd, signal)
  } })
  const result = await prover.prove({ run: f.run, claim: f.claim, head_sha: f.head })
  expect(result.proved).toBe(false)
  expect(result.observed?.control_mutated.failure_kind).toBe('database-schema-mismatch')
  const summary = mutationFailureSummary(result)
  expect(summary).toContain('control_mutated: exit=1, timed_out=false, kind=database-schema-mismatch')
  expect(summary).toContain('output_sha256=')
  expect(JSON.stringify(result)).not.toContain('secret_column')
  expect(JSON.stringify(result)).not.toContain('do-not-retain')
}, 30_000)

for (const layout of ['wildcard', 'explicit', 'ancestor']) test(`${layout} workspace-directory symlink cannot hide an external install destination`, async () => {
  const f = await seed()
  const shared = mkdtempSync(join(tmpdir(), 'mutation-external-workspace-'))
  roots.push(shared)
  const packageDir = layout === 'ancestor' ? join(shared, 'nested') : shared
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@fixture/external',
    dependencies: { '@fixture/schema': 'workspace:*' } }))
  await command(f.repo, 'git', 'switch', '-q', 'trident/proof')
  symlinkSync(shared, join(f.repo, 'packages/escape'))
  if (layout !== 'wildcard') {
    const manifest = JSON.parse(readFileSync(join(f.repo, 'package.json'), 'utf8'))
    manifest.workspaces.push(layout === 'ancestor' ? 'packages/escape/nested' : 'packages/escape')
    writeFileSync(join(f.repo, 'package.json'), JSON.stringify(manifest))
  }
  // Freeze the exact graph Bun sees, then remove only fixture-generated install
  // output so the proof has an independently measured unchanged-directory check.
  await command(f.repo, 'bun', 'install', '--ignore-scripts', '--no-progress')
  const installerFollowedSymlink = existsSync(join(packageDir, 'node_modules'))
  rmSync(join(packageDir, 'node_modules'), { recursive: true, force: true })
  const before = readdirSync(packageDir).sort()
  const manifestBefore = readFileSync(join(packageDir, 'package.json'), 'utf8')
  await command(f.repo, 'git', 'add', '-A')
  await command(f.repo, 'git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'external workspace directory')
  const calls: string[][] = []
  const prover = createMutationProver({ run_host: spawnCapture, run_guard: async (argv, cwd, signal) => {
    calls.push(argv)
    return spawnGuardCommand(argv, cwd, signal)
  } })
  const result = await prover.prove({ run: f.run, claim: f.claim })
  expect(installerFollowedSymlink).toBe(layout !== 'wildcard')
  expect(readFileSync(join(f.repo, 'bun.lock'), 'utf8').includes('@fixture/external')).toBe(layout !== 'wildcard')
  expect(readdirSync(packageDir).sort()).toEqual(before)
  expect(readFileSync(join(packageDir, 'package.json'), 'utf8')).toBe(manifestBefore)
  expect(result.proved).toBe(false)
  expect(calls).toHaveLength(0)
  expect(result.reason).toContain('workspace directory path contains a symlink')
}, 30_000)

test('a local workspace-directory alias is refused before install, too', async () => {
  const f = await seed()
  await command(f.repo, 'git', 'switch', '-q', 'trident/proof')
  symlinkSync('limit', join(f.repo, 'packages/alias'))
  await command(f.repo, 'git', 'add', '-A')
  await command(f.repo, 'git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'local workspace alias')
  const calls: string[][] = []
  const prover = createMutationProver({ run_host: spawnCapture, run_guard: async (argv, cwd, signal) => {
    calls.push(argv)
    return spawnGuardCommand(argv, cwd, signal)
  } })
  const result = await prover.prove({ run: f.run, claim: f.claim })
  expect(result.proved).toBe(false)
  expect(result.reason).toContain('workspace directory path contains a symlink')
  expect(calls).toHaveLength(0)
}, 30_000)
