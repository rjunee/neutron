import { afterEach, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { projectSuiteIdentity } from '../wiring/project-build-dependencies.ts'
import { spawnCapture } from '../../trident/git-mode.ts'

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
