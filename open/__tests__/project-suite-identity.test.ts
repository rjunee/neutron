import { afterEach, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { projectInstalledTreeIdentity, projectSuiteIdentity } from '../wiring/project-build-dependencies.ts'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'suite-identity-'))
  roots.push(root)
  const git = async (...args: string[]) => {
    const result = await spawnCapture(['git', ...args], root)
    if (!result.ok) throw new Error(result.stderr)
  }
  await git('init', '-q')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
  await writeFile(join(root, 'package.json'), '{}')
  await writeFile(join(root, '.gitignore'), 'node_modules/\n')
  await writeFile(join(root, 'test.ts'), '// code\n')
  await git('add', '.')
  await git('commit', '-qm', 'fixture')
  return { root, git }
}

test('suite identity preserves identical input and invalidates dependencies, code, revision and installation', async () => {
  const { root, git } = await fixture()
  const first = await projectSuiteIdentity(root)
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(await projectSuiteIdentity(root)).toBe(first)
  expect(await projectSuiteIdentity(root, 'f'.repeat(40))).toBeNull()
  for (const path of ['package.json', 'bun.lock', 'bunfig.toml', 'test.ts', 'untracked-test.ts']) {
    await writeFile(join(root, path), path === 'package.json' ? '{"name":"changed"}' : 'changed')
    expect(await projectSuiteIdentity(root)).toBeNull()
    if (path === 'package.json' || path === 'test.ts') await git('restore', '--', path)
    else await rm(join(root, path))
    expect(await projectSuiteIdentity(root)).toBe(first)
  }
  await mkdir(join(root, 'node_modules'))
  const installed = await projectSuiteIdentity(root)
  expect(installed).not.toBe(first)
  await rename(join(root, 'node_modules'), join(root, 'node_modules-old'))
  await mkdir(join(root, 'node_modules'))
  await rm(join(root, 'node_modules-old'), { recursive: true })
  expect(await projectSuiteIdentity(root)).not.toBe(installed)
  await rm(join(root, 'node_modules'), { recursive: true })
  await symlink(tmpdir(), join(root, 'node_modules'))
  expect(await projectSuiteIdentity(root)).toBeNull()
  await rm(join(root, 'node_modules'))
  await git('commit', '--allow-empty', '-qm', 'next revision')
  expect(await projectSuiteIdentity(root)).not.toBe(first)
})

test('suite identity binds the host runtime executable and worktree location', async () => {
  const { root } = await fixture()
  const first = await projectSuiteIdentity(root)
  const toolDir = await mkdtemp(join(tmpdir(), 'suite-tools-'))
  roots.push(toolDir)
  await copyFile(process.execPath, join(toolDir, 'bun'))
  const oldPath = process.env.PATH
  try {
    process.env.PATH = `${toolDir}:${oldPath ?? ''}`
    expect(await projectSuiteIdentity(root)).not.toBe(first)
  } finally { process.env.PATH = oldPath }
  expect(await projectSuiteIdentity(root)).toBe(first)
  const moved = `${root}-moved`
  roots.push(moved)
  await rename(root, moved)
  expect(await projectSuiteIdentity(moved)).not.toBe(first)
})

test('suite identity detects internal dependency changes even when entrypoint and mtime stay unchanged', async () => {
  const { root, git } = await fixture()
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }))
  await git('add', 'package.json')
  await git('commit', '-qm', 'dependency')
  const dependency = join(root, 'node_modules', 'example')
  await mkdir(dependency, { recursive: true })
  await writeFile(join(dependency, 'package.json'), '{"name":"example","main":"index.js"}')
  await writeFile(join(dependency, 'index.js'), 'module.exports = require("./implementation.js")')
  const implementation = join(dependency, 'implementation.js')
  await writeFile(implementation, 'module.exports = 1')
  const before = await projectSuiteIdentity(root)
  expect(before).toMatch(/^[a-f0-9]{64}$/)
  expect(await projectSuiteIdentity(root)).toBe(before)
  const original = await stat(implementation)
  await writeFile(implementation, 'module.exports = 2')
  await utimes(implementation, original.atime, original.mtime)
  const changed = await projectSuiteIdentity(root)
  expect(changed).not.toBeNull()
  expect(changed).not.toBe(before)
  expect(await projectSuiteIdentity(root)).toBe(changed)
  await symlink(tmpdir(), join(dependency, 'external'))
  expect(await projectSuiteIdentity(root)).toBeNull()
})

test('native dependency observation is one bounded argv call and preserves unusual filenames', async () => {
  const { root } = await fixture()
  const modules = join(root, 'node_modules')
  await mkdir(modules)
  await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(join(modules, `file-${index}.js`), 'one')))
  const unusual = join(modules, 'spaces\nand;$()"quotes.js')
  await writeFile(unusual, 'one')
  const calls: Parameters<typeof spawnCapture>[] = []
  const observed = Object.assign(async (...args: Parameters<typeof spawnCapture>) => {
    calls.push(args)
    return spawnCapture(...args)
  }, { writesDiffOutput: true as const })
  const before = await projectInstalledTreeIdentity(root, observed)
  expect(before).toMatch(/^[a-f0-9]{64}$/)
  expect(calls).toHaveLength(1)
  expect(calls[0]![0]).toEqual(['find', '-P', modules, '-printf', '%p\\0%D\\0%i\\0%m\\0%s\\0%T@\\0%C@\\0%y\\0%l\\0'])
  expect(calls[0]![3]).toBeGreaterThan(0)
  expect(calls[0]![3]).toBeLessThanOrEqual(5000)
  expect(await projectInstalledTreeIdentity(root)).toBe(before)
  await writeFile(unusual, 'two')
  expect(await projectInstalledTreeIdentity(root)).not.toBe(before)
})

for (const failure of ['timeout', 'exit', 'malformed'] as const) {
  test(`native dependency observation refuses ${failure} instead of reusing a partial transcript`, async () => {
    const { root } = await fixture()
    await mkdir(join(root, 'node_modules'))
    const run = Object.assign(async (...args: Parameters<typeof spawnCapture>) => {
      const valid = await spawnCapture(...args)
      expect(valid.ok).toBe(true)
      return { ...valid, ok: failure !== 'exit', exit_code: failure === 'exit' ? 1 : 0,
        ...(failure === 'malformed' ? { stdout: 'partial' } : {}),
        ...(failure === 'timeout' ? { timed_out: true } : {}) }
    }, { writesDiffOutput: true as const })
    expect(await projectInstalledTreeIdentity(root, run)).toBeNull()
    expect(await projectInstalledTreeIdentity(root)).toMatch(/^[a-f0-9]{64}$/)
  })
}

/** A declared Bun-style workspace: node_modules/@scope/pkg -> ../../pkg beside a
 * third-party package, committed so the tree is clean and pkg/ is tracked. */
async function workspaceFixture() {
  const { root, git } = await fixture()
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['pkg'] }))
  await mkdir(join(root, 'pkg'))
  await writeFile(join(root, 'pkg', 'package.json'), JSON.stringify({ name: '@scope/pkg', main: 'index.js' }))
  await writeFile(join(root, 'pkg', 'index.js'), 'module.exports = "first party"\n')
  await mkdir(join(root, 'node_modules', '@scope'), { recursive: true })
  await symlink('../../pkg', join(root, 'node_modules', '@scope', 'pkg'))
  await mkdir(join(root, 'node_modules', 'third'))
  await writeFile(join(root, 'node_modules', 'third', 'package.json'), '{"name":"third","main":"index.js"}')
  await writeFile(join(root, 'node_modules', 'third', 'index.js'), 'module.exports = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'workspace')
  const measure = async () => ({ installed: await projectInstalledTreeIdentity(root), suite: await projectSuiteIdentity(root) })
  // Positive control: the fixture is measurable before any mutation, so an
  // equality below can never be two nulls.
  const baseline = await measure()
  expect(baseline.installed).toMatch(/^[a-f0-9]{64}$/)
  expect(baseline.suite).toMatch(/^[a-f0-9]{64}$/)
  return { root, git, measure, baseline }
}

test('suite identity is stable across first-party workspace directory activity', async () => {
  const { root, measure, baseline } = await workspaceFixture()
  const scratch = join(root, 'pkg', 'scratch.tmp')
  await writeFile(scratch, 'temporary')
  await rm(scratch)
  // Five seconds ahead moves %T@ and %C@ regardless of timestamp granularity.
  const future = new Date(Date.now() + 5000)
  await utimes(join(root, 'pkg'), future, future)
  expect((await stat(join(root, 'pkg'))).mtimeMs).toBe(future.getTime())
  expect(await measure()).toEqual(baseline)
})

test('suite identity refuses installed-dependency changes', async () => {
  const { root, git, measure, baseline } = await workspaceFixture()
  const identities = [baseline]
  const expectChanged = async () => {
    const next = await measure()
    expect(next.installed).toMatch(/^[a-f0-9]{64}$/)
    expect(next.suite).toMatch(/^[a-f0-9]{64}$/)
    for (const prior of identities) {
      expect(next.installed).not.toBe(prior.installed)
      expect(next.suite).not.toBe(prior.suite)
    }
    identities.push(next)
  }
  // A third-party byte change with the original mtime restored.
  const third = join(root, 'node_modules', 'third', 'index.js')
  const original = await stat(third)
  await writeFile(third, 'module.exports = 2\n')
  await utimes(third, original.atime, original.mtime)
  await expectChanged()
  await mkdir(join(root, 'node_modules', 'added'))
  await writeFile(join(root, 'node_modules', 'added', 'package.json'), '{"name":"added"}')
  await expectChanged()
  await rm(join(root, 'node_modules', 'third'), { recursive: true })
  await expectChanged()
  // Retarget the workspace link to another tracked first-party directory.
  await mkdir(join(root, 'pkg2'))
  await writeFile(join(root, 'pkg2', 'package.json'), JSON.stringify({ name: '@scope/pkg', main: 'index.js' }))
  await git('add', 'pkg2')
  await git('commit', '-qm', 'pkg2')
  identities.push(await measure())
  await rm(join(root, 'node_modules', '@scope', 'pkg'))
  await symlink('../../pkg2', join(root, 'node_modules', '@scope', 'pkg'))
  await expectChanged()
  // Third-party installs nested under a linked workspace are still measured.
  await mkdir(join(root, 'pkg2', 'node_modules', 'nested'), { recursive: true })
  await writeFile(join(root, 'pkg2', 'node_modules', 'nested', 'index.js'), 'one')
  await expectChanged()
  await writeFile(join(root, 'pkg2', 'node_modules', 'nested', 'index.js'), 'two')
  await expectChanged()
})

test('first-party link targets are recorded, not walked', async () => {
  const { root, git, baseline } = await workspaceFixture()
  // A first-party source edit is git's to prove: the installed tree is unchanged,
  // and the dirty tree makes the suite identity unmeasurable.
  await writeFile(join(root, 'pkg', 'index.js'), 'module.exports = "edited"\n')
  expect(await projectInstalledTreeIdentity(root)).toBe(baseline.installed)
  expect(await projectSuiteIdentity(root)).toBeNull()
  await git('restore', '--', 'pkg/index.js')
  expect(await projectSuiteIdentity(root)).toBe(baseline.suite)
  // A link to a target outside the root refuses.
  const external = await mkdtemp(join(tmpdir(), 'suite-external-'))
  roots.push(external)
  await writeFile(join(external, 'code.js'), 'outside')
  await symlink(external, join(root, 'node_modules', 'external'))
  expect(await projectInstalledTreeIdentity(root)).toBeNull()
  await rm(join(root, 'node_modules', 'external'))
  expect(await projectInstalledTreeIdentity(root)).toMatch(/^[a-f0-9]{64}$/)
  // A first-party target git ignores is covered by neither HEAD nor status.
  await mkdir(join(root, 'vendor'))
  await writeFile(join(root, 'vendor', 'index.js'), 'vendored')
  await symlink('../vendor', join(root, 'node_modules', 'vendored'))
  const tracked = await projectInstalledTreeIdentity(root)
  expect(tracked).toMatch(/^[a-f0-9]{64}$/)
  await writeFile(join(root, '.gitignore'), 'node_modules/\nvendor/\n')
  expect(await projectInstalledTreeIdentity(root)).toBeNull()
  await writeFile(join(root, '.gitignore'), 'node_modules/\n')
  expect(await projectInstalledTreeIdentity(root)).toBe(tracked)
  // A nested node_modules that is not a plain directory refuses.
  await rm(join(root, 'node_modules', 'vendored'))
  await symlink('../node_modules/third', join(root, 'pkg', 'node_modules'))
  expect(await projectInstalledTreeIdentity(root)).toBeNull()
})
