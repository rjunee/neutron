import { afterEach, expect, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'
import { projectInstalledTreeIdentity } from '../wiring/project-build-dependencies.ts'

const helper = new URL('../wiring/project-build-installed-tree.py', import.meta.url).pathname
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const holder = await mkdtemp(join(tmpdir(), 'installed-probe-')); roots.push(holder)
  const root = join(holder, 'workspace'), outside = join(holder, 'outside')
  const pkg = join(root, 'node_modules', 'pkg'), input = join(pkg, 'index.js')
  await mkdir(pkg, { recursive: true }); await mkdir(outside)
  await writeFile(input, 'module.exports = 1')
  await writeFile(join(outside, 'index.js'), 'EXTERNAL BYTES MUST NOT BE READ')
  return { holder, root, outside, pkg, input }
}

async function probe(f: Awaited<ReturnType<typeof fixture>>, injection = '') {
  const original = await stat(f.root)
  const script = `import os,runpy,sys
root, outside, pkg, leaf = ${JSON.stringify([f.root, f.outside, f.pkg, f.input])}
external = os.stat(outside + '/index.js')
external_reads = 0
original_read = os.read
def watched_read(fd, count):
    global external_reads
    observed = os.fstat(fd)
    if (observed.st_dev, observed.st_ino) == (external.st_dev, external.st_ino): external_reads += 1
    return original_read(fd, count)
os.read = watched_read
${injection}
sys.argv = ${JSON.stringify([helper, f.root, String(original.dev), String(original.ino), JSON.stringify([join(f.root, 'node_modules')]), '5000'])}
try:
    runpy.run_path(sys.argv[0], run_name='__main__')
finally:
    print('external_reads=' + str(external_reads), file=sys.stderr)
`
  return spawnCapture(['python3', '-I', '-S', '-c', script], new URL('../../', import.meta.url).pathname, undefined, 7000)
}

for (const target of ['root', 'ancestor', 'leaf', 'pinned ancestor'] as const) {
  test(`confined byte observation refuses a retargeted ${target} without reading external bytes`, async () => {
    const f = await fixture()
    const targetPath = target === 'root' ? 'root' : target === 'leaf' ? 'leaf' : 'pkg'
    const replacement = target === 'leaf' ? "outside + '/index.js'" : 'outside'
    const trigger = target === 'root' ? 'path == root' : target === 'leaf' ? "path == 'index.js'" : "path == 'pkg'"
    const swap = `os.rename(${targetPath}, ${targetPath} + '.saved')\n        os.symlink(${replacement}, ${targetPath})`
    const injected = target === 'pinned ancestor' ? `
done = False
def swap_after_read(fd, count):
    global done
    value = watched_read(fd, count)
    if not done:
        done = True
        ${swap}
    return value
os.read = swap_after_read
` : `
original_open = os.open
done = False
def swapped_open(path, flags, *args, **kwargs):
    global done
    if not done and ${trigger}:
        done = True
        ${swap}
    return original_open(path, flags, *args, **kwargs)
os.open = swapped_open
`
    const result = await probe(f, injected)
    expect(result.ok, result.stderr).toBe(false)
    expect(result.stderr).toContain('external_reads=0')
    const valid = await probe(await fixture())
    expect(valid.ok, valid.stderr).toBe(true)
  })
}

for (const change of ['bytes', 'hardlink', 'namespace'] as const) {
  test(`a ${change} change during a pinned read refuses, then a stable retry succeeds`, async () => {
    const f = await fixture()
    const before = await projectInstalledTreeIdentity(f.root)
    expect(before).toMatch(/^[a-f0-9]{64}$/)
    const mutation = change === 'hardlink' ? "os.link(leaf, outside + '/shared.js')" : change === 'namespace'
      ? "with open(pkg + '/new.js', 'wb') as stream: stream.write(b'new input')"
      : "original = os.stat(leaf)\n        with open(leaf, 'wb') as stream: stream.write(b'module.exports = 2')\n        os.utime(leaf, ns=(original.st_atime_ns, original.st_mtime_ns))"
    const result = await probe(f, `
done = False
def changed_read(fd, count):
    global done
    value = watched_read(fd, count)
    if not done:
        done = True
        ${mutation}
    return value
os.read = changed_read
`)
    expect(result.ok, result.stderr).toBe(false)
    expect(result.stderr).toContain(change === 'namespace' ? 'directory replaced' : 'file changed during read')
    const after = await projectInstalledTreeIdentity(f.root)
    expect(after).toMatch(/^[a-f0-9]{64}$/)
    if (change === 'hardlink') expect(after).toBe(before)
    else expect(after).not.toBe(before)
  })
}

test('file replacement, mode and ownership remain measured while valid local links work', async () => {
  const f = await fixture()
  // Make the initial permission input distinct from the restrictive mutation.
  await chmod(f.input, 0o644)
  expect((await stat(f.input)).mode & 0o777).toBe(0o644)
  const before = await projectInstalledTreeIdentity(f.root)
  expect(before).toMatch(/^[a-f0-9]{64}$/)
  const originalMode = (await stat(f.input)).mode & 0o777
  await chmod(f.input, 0o600)
  expect(await projectInstalledTreeIdentity(f.root)).not.toBe(before)
  await chmod(f.input, originalMode)
  expect(await projectInstalledTreeIdentity(f.root)).toBe(before)
  const ownerChanged = Object.assign(async (...args: Parameters<typeof spawnCapture>) => {
    const result = await spawnCapture(...args), fields = result.stdout.split('\0')
    for (let index = 0; index + 11 < fields.length; index += 12) {
      if (fields[index] === f.input) fields[index + 10] = String(Number(fields[index + 10]) + 1)
    }
    return { ...result, stdout: fields.join('\0') }
  }, { writesDiffOutput: true as const })
  expect(await projectInstalledTreeIdentity(f.root, ownerChanged)).not.toBe(before)
  const metadata = await stat(f.input)
  await copyFile(f.input, join(f.holder, 'replacement'))
  await utimes(join(f.holder, 'replacement'), metadata.atime, metadata.mtime)
  await rename(join(f.holder, 'replacement'), f.input)
  expect(await readFile(f.input, 'utf8')).toBe('module.exports = 1')
  expect(await projectInstalledTreeIdentity(f.root)).not.toBe(before)
  const local = join(f.root, 'local.js')
  await writeFile(local, 'module.exports = 3')
  await symlink(local, join(f.pkg, 'local.js'))
  expect(await projectInstalledTreeIdentity(f.root)).toMatch(/^[a-f0-9]{64}$/)
  await symlink(f.outside, join(f.pkg, 'external'))
  expect(await projectInstalledTreeIdentity(f.root)).toBeNull()
})

test('stable byte observations distinguish exact-mtime restored rewrites', async () => {
  const f = await fixture(), pinned = new Date('2020-01-01T00:00:00.000Z')
  await utimes(f.input, pinned, pinned)
  const first = await probe(f)
  expect(first.ok, first.stderr).toBe(true)
  const record = (stdout: string) => {
    const fields = stdout.split('\0')
    for (let index = 0; index + 11 < fields.length; index += 12) if (fields[index] === f.input) return fields.slice(index, index + 12)
    throw Error('missing input record')
  }
  const before = record(first.stdout)
  await writeFile(f.input, 'module.exports = 2')
  await utimes(f.input, pinned, pinned)
  const second = await probe(f)
  expect(second.ok, second.stderr).toBe(true)
  const after = record(second.stdout)
  expect(after.slice(0, 6)).toEqual(before.slice(0, 6))
  expect(after[9]).not.toBe(before[9])
})
