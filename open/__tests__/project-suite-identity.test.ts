import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS, projectInstalledTreeIdentity, projectSuiteIdentity, projectSuiteIdentityMeasurement as measureSuiteIdentity } from '../wiring/project-build-dependencies.ts'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'

const roots: string[] = []
let outerShard: string | undefined
beforeEach(() => {
  // CI shards this test file; the nested fixture represents a complete suite.
  outerShard = process.env.NEUTRON_TEST_SHARD
  delete process.env.NEUTRON_TEST_SHARD
})
afterEach(() => {
  if (outerShard === undefined) delete process.env.NEUTRON_TEST_SHARD
  else process.env.NEUTRON_TEST_SHARD = outerShard
})
const projectSuiteIdentityMeasurement = (root: string, head?: string) => measureSuiteIdentity(root, head, 'bun test')
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

test('suite component evidence describes the same aggregate and isolates installed-byte changes', async () => {
  const { root } = await fixture()
  await mkdir(join(root, 'node_modules'))
  const input = join(root, 'node_modules', 'private-input.js')
  await writeFile(input, 'private original bytes')
  const before = await projectSuiteIdentityMeasurement(root)
  expect(before?.identity ?? null).toBe(await projectSuiteIdentity(root))
  expect(await projectSuiteIdentityMeasurement(root)).toEqual(before)
  await writeFile(input, 'private modified bytes')
  const after = await projectSuiteIdentityMeasurement(root)
  expect(after?.identity).not.toBe(before?.identity)
  expect(after?.components).toEqual({ ...before!.components!, installed: expect.any(String) })
  expect(after!.components!.installed).not.toBe(before!.components!.installed)
  for (const component of Object.values(after!.components!)) expect(component).toMatch(/^[a-f0-9]{64}$/)
  for (const privateValue of [root, 'private-input.js', 'private original bytes', 'private modified bytes']) {
    expect(JSON.stringify([before, after])).not.toContain(privateValue)
  }
})

test('portable suite proof matches distinct installations but binds bytes, permissions, links and ignored inputs', async () => {
  const { root, git } = await fixture()
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.env\n')
  await git('add', '.gitignore')
  await git('commit', '-qm', 'ignored environment fixture')
  const sibling = `${root}-retry`; roots.push(sibling)
  await git('worktree', 'add', '--detach', sibling, 'HEAD')
  // Deliberately reverse creation order; readdir order is not identity.
  for (const [tree, entries] of [[root, ['a.js', 'b.js']], [sibling, ['b.js', 'a.js']]] as const) {
    await mkdir(join(tree, 'node_modules'))
    for (const name of entries) await writeFile(join(tree, 'node_modules', name), 'same bytes')
    await symlink('a.js', join(tree, 'node_modules', 'selected.js'))
    await mkdir(join(tree, 'app', 'node_modules'), { recursive: true })
    await symlink('../../node_modules/a.js', join(tree, 'app', 'node_modules', 'local.js'))
  }
  const source = await projectSuiteIdentityMeasurement(root)
  const retry = await projectSuiteIdentityMeasurement(sibling)
  expect(source?.portableIdentity).toMatch(/^[a-f0-9]{64}$/)
  expect(retry?.portableIdentity).toBe(source!.portableIdentity)
  expect(retry?.identity).not.toBe(source!.identity)
  const input = join(sibling, 'node_modules', 'a.js')
  const originalMode = (await stat(input)).mode & 0o777
  await writeFile(input, 'different bytes')
  expect((await projectSuiteIdentityMeasurement(sibling))?.portableIdentity).not.toBe(source!.portableIdentity)
  await writeFile(input, 'same bytes')
  expect((await projectSuiteIdentityMeasurement(sibling))?.portableIdentity).toBe(source!.portableIdentity)
  await chmod(input, 0o755)
  expect((await projectSuiteIdentityMeasurement(sibling))?.portableIdentity).not.toBe(source!.portableIdentity)
  await chmod(input, originalMode)
  const selected = join(sibling, 'node_modules', 'selected.js')
  await rm(selected)
  await symlink('b.js', selected)
  expect((await projectSuiteIdentityMeasurement(sibling))?.portableIdentity).not.toBe(source!.portableIdentity)
  await rm(selected)
  await symlink('a.js', selected)
  expect((await projectSuiteIdentityMeasurement(sibling))?.portableIdentity).toBe(source!.portableIdentity)
  await writeFile(join(sibling, '.env'), 'PRIVATE_FIXTURE_VALUE=hidden')
  const unknown = await projectSuiteIdentityMeasurement(sibling)
  expect(unknown?.identity).toMatch(/^[a-f0-9]{64}$/)
  expect(unknown?.portableIdentity).toBeUndefined()
  await rm(join(sibling, '.env'))
  expect((await projectSuiteIdentityMeasurement(sibling))?.portableIdentity).toBe(source!.portableIdentity)
  await rm(selected)
  await symlink(input, selected)
  expect((await projectSuiteIdentityMeasurement(sibling))?.portableIdentity).toBeUndefined()
})

test('portable identity pins effective environment and host executable bytes without exposing either', async () => {
  const { root } = await fixture()
  const first = await projectSuiteIdentityMeasurement(root)
  expect(first?.portableIdentity).toMatch(/^[a-f0-9]{64}$/)
  const previousStartup = process.env.BASH_ENV
  try {
    process.env.BASH_ENV = '/unread/ambient-startup'
    expect((await projectSuiteIdentityMeasurement(root))?.portableIdentity).toBe(first!.portableIdentity)
  } finally {
    if (previousStartup === undefined) delete process.env.BASH_ENV
    else process.env.BASH_ENV = previousStartup
  }
  const previous = process.env.NEUTRON_SUITE_IDENTITY_TEST
  try {
    process.env.NEUTRON_SUITE_IDENTITY_TEST = 'private test environment'
    const changed = await projectSuiteIdentityMeasurement(root)
    expect(changed?.portableIdentity).toMatch(/^[a-f0-9]{64}$/)
    expect(changed?.portableIdentity).not.toBe(first!.portableIdentity)
    expect(JSON.stringify(changed)).not.toContain('private test environment')
  } finally {
    if (previous === undefined) delete process.env.NEUTRON_SUITE_IDENTITY_TEST
    else process.env.NEUTRON_SUITE_IDENTITY_TEST = previous
  }
  expect((await projectSuiteIdentityMeasurement(root))?.portableIdentity).toBe(first!.portableIdentity)
  const toolDir = await mkdtemp(join(tmpdir(), 'portable-suite-tools-')); roots.push(toolDir)
  const shell = join(toolDir, 'bash'), oldPath = process.env.PATH
  await writeFile(shell, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  try {
    process.env.PATH = `${toolDir}:${oldPath ?? ''}`
    const before = await projectSuiteIdentityMeasurement(root)
    expect(before?.portableIdentity).toMatch(/^[a-f0-9]{64}$/)
    await writeFile(shell, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect((await projectSuiteIdentityMeasurement(root))?.portableIdentity).not.toBe(before!.portableIdentity)
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
  }
})

test('portable proof admits only a measured command closure and refuses tracked external inputs', async () => {
  const { root, git } = await fixture()
  expect((await projectSuiteIdentityMeasurement(root))?.portableIdentity).toMatch(/^[a-f0-9]{64}$/)
  try {
    process.env.NEUTRON_TEST_SHARD = '1/4'
    const sharded = await projectSuiteIdentityMeasurement(root)
    expect(sharded?.identity).toMatch(/^[a-f0-9]{64}$/)
    expect(sharded?.portableIdentity).toBeUndefined()
  } finally { delete process.env.NEUTRON_TEST_SHARD }
  expect((await projectSuiteIdentityMeasurement(root))?.portableIdentity).toMatch(/^[a-f0-9]{64}$/)
  for (const command of [undefined, 'npm test', 'bun test; echo passed', 'bun test test.ts', 'export UNKNOWN=1\nbun test']) {
    const observed = await measureSuiteIdentity(root, undefined, command)
    expect(observed?.identity).toMatch(/^[a-f0-9]{64}$/)
    expect(observed?.portableIdentity).toBeUndefined()
  }
  const previous = process.env.NEUTRON_TEST_ROOT
  try {
    process.env.NEUTRON_TEST_ROOT = '/unmeasured/fixture'
    expect((await projectSuiteIdentityMeasurement(root))?.portableIdentity).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.NEUTRON_TEST_ROOT
    else process.env.NEUTRON_TEST_ROOT = previous
  }
  await symlink('/unmeasured/external-fixture', join(root, 'external-fixture'))
  await git('add', 'external-fixture')
  await git('commit', '-qm', 'tracked link fixture')
  const linked = await projectSuiteIdentityMeasurement(root)
  expect(linked?.identity).toMatch(/^[a-f0-9]{64}$/)
  expect(linked?.portableIdentity).toBeUndefined()
})

test('portable first-party runner requires exact host source and measures utility tools', async () => {
  const { root, git } = await fixture()
  const paths = ['scripts/run-tests.sh', 'scripts/lib/discover-test-files.sh', 'scripts/ci/verify-workspace-deps.ts']
  await mkdir(join(root, 'scripts', 'lib'), { recursive: true })
  await mkdir(join(root, 'scripts', 'ci'), { recursive: true })
  for (const path of paths) await copyFile(new URL(`../../${path}`, import.meta.url), join(root, path))
  await git('add', 'scripts')
  await git('commit', '-qm', 'host runner fixture')
  const command = 'export NEUTRON_TEST_JOBS=1\nexport NEUTRON_TEST_CONCURRENCY=2\nbash scripts/run-tests.sh'
  const before = await measureSuiteIdentity(root, undefined, command)
  expect(before?.portableIdentity).toMatch(/^[a-f0-9]{64}$/)
  try {
    process.env.NEUTRON_TEST_SHARD = '1/4'
    const sharded = await measureSuiteIdentity(root, undefined, command)
    expect(sharded?.identity).toMatch(/^[a-f0-9]{64}$/)
    expect(sharded?.portableIdentity).toBeUndefined()
  } finally { delete process.env.NEUTRON_TEST_SHARD }
  expect((await measureSuiteIdentity(root, undefined, command))?.portableIdentity).toBe(before!.portableIdentity)
  const toolDir = await mkdtemp(join(tmpdir(), 'portable-runner-tools-')); roots.push(toolDir)
  const oldPath = process.env.PATH, tool = join(toolDir, 'awk')
  await writeFile(tool, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  try {
    process.env.PATH = `${toolDir}:${oldPath ?? ''}`
    const original = await measureSuiteIdentity(root, undefined, command)
    expect(original?.portableIdentity).toMatch(/^[a-f0-9]{64}$/)
    await writeFile(tool, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect((await measureSuiteIdentity(root, undefined, command))?.portableIdentity).not.toBe(original!.portableIdentity)
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
  }
  await writeFile(join(root, paths[1]!), '# modified discovery\n')
  await git('add', 'scripts')
  await git('commit', '-qm', 'changed runner fixture')
  expect((await measureSuiteIdentity(root, undefined, command))?.portableIdentity).toBeUndefined()
})

test('portable Bun configuration permits confined tracked first-party preloads and refuses external config', async () => {
  const { root, git } = await fixture()
  const measure = () => projectSuiteIdentityMeasurement(root)
  expect((await measure())?.portableIdentity).toMatch(/^[a-f0-9]{64}$/)
  const config = await readFile(new URL('../../bunfig.toml', import.meta.url), 'utf8')
  await writeFile(join(root, 'bunfig.toml'), config)
  await git('add', 'bunfig.toml')
  await git('commit', '-qm', 'missing preload fixture')
  expect((await measure())?.portableIdentity).toBeUndefined()
  const preloads = (Bun.TOML.parse(config) as { test: { preload: string[] } }).test.preload
  await mkdir(join(root, 'tests', 'support'), { recursive: true })
  for (const preload of preloads) await copyFile(new URL(`../../${preload}`, import.meta.url), join(root, preload))
  await git('add', 'tests')
  await git('commit', '-qm', 'confined tracked preloads fixture')
  expect((await measure())?.portableIdentity).toMatch(/^[a-f0-9]{64}$/)
  await writeFile(join(root, 'bunfig.toml'), '[test]\npreload = ["/unmeasured/external-preload.ts"]\n')
  await git('add', 'bunfig.toml')
  await git('commit', '-qm', 'external preload config fixture')
  const external = await measure()
  expect(external?.identity).toMatch(/^[a-f0-9]{64}$/)
  expect(external?.portableIdentity).toBeUndefined()
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
  expect(calls[0]![3]).toBeLessThanOrEqual(PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS)
  expect(await projectInstalledTreeIdentity(root)).toBe(before)
  await writeFile(unusual, 'two')
  expect(await projectInstalledTreeIdentity(root)).not.toBe(before)
})

test('installed identity deadline admits a complete slow walk and still distinguishes changed bytes', async () => {
  const { root } = await fixture()
  await mkdir(join(root, 'node_modules'))
  const local = join(root, 'local')
  await mkdir(local)
  const input = join(local, 'input.js')
  await writeFile(input, 'one')
  await symlink(local, join(root, 'node_modules', 'local'))
  const before = await projectInstalledTreeIdentity(root)
  expect(before).toMatch(/^[a-f0-9]{64}$/)
  const now = performance.now.bind(performance)
  let elapsed = 0
  const clock = spyOn(performance, 'now').mockImplementation(() => now() + elapsed)
  const slow = Object.assign(async (...args: Parameters<typeof spawnCapture>) => {
    const result = await spawnCapture(...args)
    // Model six seconds of shared-host scheduling without making every suite
    // spend six real seconds. The native observations and link reads are real.
    elapsed = 6000
    return result
  }, { writesDiffOutput: true as const })
  try {
    expect(await projectInstalledTreeIdentity(root, slow)).toBe(before)
    elapsed = 0
    const original = await stat(input)
    await writeFile(input, 'two')
    await utimes(input, original.atime, original.mtime)
    const changed = await projectInstalledTreeIdentity(root, slow)
    expect(changed).toMatch(/^[a-f0-9]{64}$/)
    expect(changed).not.toBe(before)
  } finally { clock.mockRestore() }
})

test('installed identity deadline refuses complete output returned after the total budget', async () => {
  const { root } = await fixture()
  await mkdir(join(root, 'node_modules'))
  const now = performance.now.bind(performance)
  let elapsed = 0
  const clock = spyOn(performance, 'now').mockImplementation(() => now() + elapsed)
  const late = Object.assign(async (...args: Parameters<typeof spawnCapture>) => {
    const result = await spawnCapture(...args)
    elapsed = PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS + 1000
    return result
  }, { writesDiffOutput: true as const })
  try { expect(await projectInstalledTreeIdentity(root, late)).toBeNull() }
  finally { clock.mockRestore() }
  expect(await projectInstalledTreeIdentity(root)).toMatch(/^[a-f0-9]{64}$/)
})

test('installed identity deadline carries the remaining budget to a hung local-target probe', async () => {
  const { root } = await fixture()
  await mkdir(join(root, 'node_modules'))
  const local = join(root, 'local')
  await mkdir(local)
  await symlink(local, join(root, 'node_modules', 'local'))
  const now = performance.now.bind(performance)
  let elapsed = 0, calls = 0
  let remaining: number | undefined, nativeRemaining: string | undefined
  let killed = false
  const clock = spyOn(performance, 'now').mockImplementation(() => now() + elapsed)
  const hung = Object.assign(async (...args: Parameters<typeof spawnCapture>) => {
    if (++calls === 1) {
      const result = await spawnCapture(...args)
      elapsed = PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS - 500
      return result
    }
    remaining = args[3]
    nativeRemaining = args[0][8]
    // A real child hangs indefinitely. Cap the test's watchdog independently
    // so a reset-budget mutation fails its assertion without delaying CI.
    const result = await spawnCapture([args[0][0]!, '-I', '-S', '-c', 'import time; time.sleep(3600)'],
      args[1], args[2], Math.min(remaining ?? Infinity, 500))
    killed = result.timed_out === true
    return result
  }, { writesDiffOutput: true as const })
  try {
    expect(await projectInstalledTreeIdentity(root, hung)).toBeNull()
    expect(calls).toBe(2)
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(500)
    expect(nativeRemaining).toBe(String(remaining))
    expect(killed).toBe(true)
  } finally { clock.mockRestore() }
  expect(await projectInstalledTreeIdentity(root)).toMatch(/^[a-f0-9]{64}$/)
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
