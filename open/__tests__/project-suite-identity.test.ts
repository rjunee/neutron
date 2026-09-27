import { afterEach, expect, spyOn, test } from 'bun:test'
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
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

test('manifest-free suite identity remains known and still binds installed bytes', async () => {
  const { root, git } = await fixture()
  await git('rm', 'package.json')
  await git('commit', '-qm', 'manifest-free fixture')
  await mkdir(join(root, 'node_modules'))
  const installed = join(root, 'node_modules', 'input.js')
  await writeFile(installed, 'one')
  const before = await projectSuiteIdentity(root)
  expect(before).toMatch(/^[a-f0-9]{64}$/)
  expect(await projectSuiteIdentity(root)).toBe(before)
  await writeFile(installed, 'two')
  const after = await projectSuiteIdentity(root)
  expect(after).toMatch(/^[a-f0-9]{64}$/)
  expect(after).not.toBe(before)
})

test('manifest resolution refuses incomplete successful output but accepts a complete empty mapping', async () => {
  const { root } = await fixture()
  const toolDir = await mkdtemp(join(tmpdir(), 'suite-resolution-tool-'))
  roots.push(toolDir)
  const executable = join(toolDir, 'bun'), oldPath = process.env.PATH
  try {
    process.env.PATH = `${toolDir}:${oldPath ?? ''}`
    for (const output of ['', 'incomplete', '{}']) {
      await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 })
      expect(await projectSuiteIdentity(root)).toBeNull()
    }
    await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' '[]'\n", { mode: 0o755 })
    const known = await projectSuiteIdentity(root)
    expect(known).toMatch(/^[a-f0-9]{64}$/)
    expect(await projectSuiteIdentity(root)).toBe(known)
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
  }
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

test('identity diagnostics distinguish dirty inputs from measured hashes without leaking paths or contents', async () => {
  const { root } = await fixture()
  const known = spyOn(console, 'log').mockImplementation(() => {})
  const unknown = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const identity = await projectSuiteIdentity(root)
    expect(identity).toMatch(/^[a-f0-9]{64}$/)
    expect(known.mock.calls.flat().join('\n')).toContain(`identity=${identity}`)
    expect(known.mock.calls.flat().join('\n')).toContain('preparation=')
    await writeFile(join(root, 'private-filename'), 'private contents')
    expect(await projectSuiteIdentity(root)).toBeNull()
    const diagnostic = unknown.mock.calls.flat().join('\n')
    expect(diagnostic).toContain('probe=git-status reason=dirty')
    for (const sensitive of [root, 'private-filename', 'private contents']) {
      expect(diagnostic).not.toContain(sensitive)
      expect(known.mock.calls.flat().join('\n')).not.toContain(sensitive)
    }
  } finally { known.mockRestore(); unknown.mockRestore() }
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
  expect(calls[0]![0].slice(1, 4)).toEqual(['-I', '-S', new URL('../wiring/project-build-installed-tree.py', import.meta.url).pathname])
  expect(calls[0]![0][4]).toBe(root)
  expect(JSON.parse(calls[0]![0][7]!)).toEqual([modules])
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
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await projectInstalledTreeIdentity(root, run)).toBeNull()
      expect(warning.mock.calls.flat().join('\n')).toContain(`reason=${failure === 'malformed' ? 'invalid-output' : `probe-${failure}`}`)
      expect(warning.mock.calls.flat().join('\n')).not.toContain(root)
    } finally { warning.mockRestore() }
    expect(await projectInstalledTreeIdentity(root)).toMatch(/^[a-f0-9]{64}$/)
  })
}

test('native dependency observation follows only validated local link targets and tracks their internals', async () => {
  const { root } = await fixture()
  await mkdir(join(root, 'node_modules'))
  const workspace = join(root, 'workspace-package')
  await mkdir(workspace)
  await writeFile(join(workspace, 'implementation.js'), 'one')
  await symlink(workspace, join(root, 'node_modules', 'local'))
  const before = await projectInstalledTreeIdentity(root)
  expect(before).toMatch(/^[a-f0-9]{64}$/)
  expect(await projectInstalledTreeIdentity(root)).toBe(before)
  await writeFile(join(workspace, 'implementation.js'), 'two')
  expect(await projectInstalledTreeIdentity(root)).not.toBe(before)
  const external = await mkdtemp(join(tmpdir(), 'suite-external-'))
  roots.push(external)
  await writeFile(join(external, 'code.js'), 'outside')
  await symlink(external, join(workspace, 'external'))
  expect(await projectInstalledTreeIdentity(root)).toBeNull()
})

async function workspaceFixture() {
  const f = await fixture()
  const workspace = join(f.root, 'pkg')
  const nested = join(workspace, 'tools')
  await mkdir(nested, { recursive: true })
  await mkdir(join(f.root, 'node_modules'))
  await writeFile(join(workspace, 'package.json'), '{"name":"local","main":"index.js"}')
  await writeFile(join(workspace, 'index.js'), 'module.exports = 1')
  await writeFile(join(nested, '.gitignore'), 'generated.js\nscratch-*\n')
  await symlink(workspace, join(f.root, 'node_modules', 'local'))
  await f.git('add', '.')
  await f.git('commit', '-qm', 'workspace')
  return { ...f, workspace, nested }
}

test('workspace directory scratch churn preserves suite identity, including nested directory size and timestamps', async () => {
  const { root, workspace, nested } = await workspaceFixture()
  const before = await projectSuiteIdentity(root)
  expect(before).toMatch(/^[a-f0-9]{64}$/)
  const original = await stat(nested)
  for (let index = 0; index < 128; index++) await mkdir(join(nested, `scratch-${index}`))
  for (let index = 0; index < 128; index++) await rm(join(nested, `scratch-${index}`), { recursive: true })
  await utimes(nested, original.atime, new Date(original.mtimeMs + 5000))
  expect((await stat(nested)).mtimeMs).not.toBe(original.mtimeMs)
  expect(await projectSuiteIdentity(root)).toBe(before)
  // Exercise size canonicalization independently of the filesystem's directory
  // allocation policy; retain a real, valid native observation for every field.
  const changedSize = Object.assign(async (...args: Parameters<typeof spawnCapture>) => {
    const result = await spawnCapture(...args)
    const fields = result.stdout.split('\0')
    for (let index = 0; index + 11 < fields.length; index += 12) {
      if (fields[index] === nested) fields[index + 4] = String(Number(fields[index + 4]) + 4096)
    }
    return { ...result, stdout: fields.join('\0') }
  }, { writesDiffOutput: true as const })
  expect(await projectInstalledTreeIdentity(root, changedSize)).toBe(await projectInstalledTreeIdentity(root))
  await chmod(workspace, 0o700)
  expect(await projectSuiteIdentity(root)).not.toBe(before)
})

for (const target of ['entrypoint', 'internal'] as const) {
  test(`shared dependency ${target} hardlink churn preserves proof while changed bytes require proof again`, async () => {
    const { root, git } = await fixture()
    const dependency = join(root, 'node_modules', 'example')
    await mkdir(dependency, { recursive: true })
    await writeFile(join(root, 'package.json'), '{"dependencies":{"example":"1.0.0"}}')
    await writeFile(join(dependency, 'package.json'), '{"name":"example","main":"index.js"}')
    await writeFile(join(dependency, 'index.js'), 'module.exports = require("./internal.js")')
    await writeFile(join(dependency, 'internal.js'), 'module.exports = 1')
    await git('add', '.'); await git('commit', '-qm', 'dependency')
    const input = join(dependency, target === 'entrypoint' ? 'index.js' : 'internal.js')
    const pinned = new Date('2020-01-01T00:00:00.000Z')
    await utimes(input, pinned, pinned)
    const other = await mkdtemp(join(tmpdir(), 'independent-install-'))
    roots.push(other)
    const before = await projectSuiteIdentity(root)
    expect(before).toMatch(/^[a-f0-9]{64}$/)
    const original = await stat(input, { bigint: true })
    const bytes = await readFile(input)
    await link(input, join(other, 'shared.js'))
    const shared = await stat(input, { bigint: true })
    expect(shared.ino).toBe(original.ino)
    expect(shared.nlink).toBe(original.nlink + 1n)
    expect(shared.ctimeNs).not.toBe(original.ctimeNs)
    expect(await readFile(input)).toEqual(bytes)
    expect(await projectSuiteIdentity(root)).toBe(before)
    await rm(join(other, 'shared.js'))
    expect(await projectSuiteIdentity(root)).toBe(before)
    // Same inode, same length, restored mtime: content is the required evidence.
    const metadata = await stat(input)
    await writeFile(input, bytes.toString().replace(target === 'entrypoint' ? 'require' : '1', target === 'entrypoint' ? 'REQUIRE' : '2'))
    await utimes(input, metadata.atime, metadata.mtime)
    expect((await stat(input)).size).toBe(metadata.size)
    expect((await stat(input, { bigint: true })).mtimeNs).toBe(original.mtimeNs)
    expect(await projectSuiteIdentity(root)).not.toBe(before)
  })
}

for (const target of ['ignored generated file', 'local symlink target', 'deep installed dependency'] as const) {
  test(`workspace observation detects same-size ${target} rewrite with restored mtime`, async () => {
    const { root, git, nested } = await workspaceFixture()
    let input = join(nested, 'generated.js')
    if (target === 'local symlink target') {
      input = join(root, 'generated-target.js')
      await writeFile(join(root, '.gitignore'), 'node_modules/\ngenerated-target.js\n')
      await symlink(input, join(nested, 'local.js'))
      await git('add', '.')
      await git('commit', '-qm', 'local link')
    }
    if (target === 'deep installed dependency') {
      const dependency = join(nested, 'node_modules', 'deep')
      await mkdir(dependency, { recursive: true })
      input = join(dependency, 'implementation.js')
    }
    await writeFile(input, 'module.exports = 1')
    const before = await projectSuiteIdentity(root)
    expect(before).toMatch(/^[a-f0-9]{64}$/)
    const original = await stat(input)
    await writeFile(input, 'module.exports = 2')
    await utimes(input, original.atime, original.mtime)
    expect((await stat(input)).size).toBe(original.size)
    const after = await projectSuiteIdentity(root)
    expect(after).toMatch(/^[a-f0-9]{64}$/)
    expect(after).not.toBe(before)
  })
}

test('workspace observation refuses a tracked external symlink even with clean git status', async () => {
  const { root, git, nested } = await workspaceFixture()
  const external = await mkdtemp(join(tmpdir(), 'suite-external-'))
  roots.push(external)
  await writeFile(join(external, 'code.js'), 'outside')
  await symlink(join(external, 'code.js'), join(nested, 'external.js'))
  await git('add', '.')
  await git('commit', '-qm', 'external link')
  expect((await spawnCapture(['git', 'status', '--porcelain'], root)).stdout).toBe('')
  expect(await projectSuiteIdentity(root)).toBeNull()
  await rm(join(nested, 'external.js'))
  await git('add', '.')
  await git('commit', '-qm', 'remove external link')
  expect(await projectSuiteIdentity(root)).toMatch(/^[a-f0-9]{64}$/)
})

test('workspace observation retains directory timestamps inside deeply nested node_modules', async () => {
  const { root, nested } = await workspaceFixture()
  const dependency = join(nested, 'node_modules', 'deep')
  await mkdir(dependency, { recursive: true })
  const before = await projectSuiteIdentity(root)
  expect(before).toMatch(/^[a-f0-9]{64}$/)
  const original = await stat(dependency)
  await utimes(dependency, original.atime, new Date(original.mtimeMs + 5000))
  const after = await projectSuiteIdentity(root)
  expect(after).toMatch(/^[a-f0-9]{64}$/)
  expect(after).not.toBe(before)
})
