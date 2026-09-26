import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareNativeBunCache } from './native-bun-cache.ts'
import { createProjectControlStdioTransport } from './project-control-broker-transport.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-bun-cache-test-')); roots.push(root)
  const source = join(root, 'source'), scratch = join(root, 'scratch')
  mkdirSync(source, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 })
  mkdirSync(join(source, 'fixture@1'), { mode: 0o700 })
  writeFileSync(join(source, 'fixture@1', 'index.js'), 'export const value = 7\n')
  return { root, source, scratch, uid: process.getuid!() }
}

describe.skipIf(process.platform !== 'linux')('native Bun cache hardlinks', () => {
  test('seeds shared inodes, adopts without reseeding, and survives source retirement', async () => {
    const { root, source, scratch, uid } = fixture()
    const cache = prepareNativeBunCache(source, scratch, uid)
    const original = lstatSync(join(source, 'fixture@1', 'index.js'))
    const installed = lstatSync(join(cache, 'fixture@1', 'index.js'))
    expect([installed.dev, installed.ino]).toEqual([original.dev, original.ino])
    expect(lstatSync(cache).mode & 0o777).toBe(0o700)
    expect(prepareNativeBunCache(source, scratch, uid)).toBe(cache)
    renameSync(source, join(root, 'retired'))
    expect((await import(join(cache, 'fixture@1', 'index.js'))).value).toBe(7)
    expect(prepareNativeBunCache(source, scratch, uid)).toBe(cache)
  })

  test('a missing initial source creates a usable private cold cache', () => {
    const { source, scratch, uid } = fixture()
    const cache = prepareNativeBunCache(join(source, 'not-yet-created'), scratch, uid)
    expect(readdirSync(cache)).toEqual(['.neutron-bun-cache.json'])
    writeFileSync(join(cache, 'new-package'), 'new cache entries are writable')
    expect(readFileSync(join(cache, 'new-package'), 'utf8')).toContain('writable')
  })

  test.each(['symlink', 'mode', 'marker', 'marker-symlink'] as const)('refuses untrusted adopted cache: %s', kind => {
    const { root, source, scratch, uid } = fixture()
    const cache = prepareNativeBunCache(source, scratch, uid)
    if (kind === 'symlink') {
      renameSync(cache, join(root, 'foreign')); symlinkSync(join(root, 'foreign'), cache)
    } else if (kind === 'mode') chmodSync(cache, 0o755)
    else if (kind === 'marker') writeFileSync(join(cache, '.neutron-bun-cache.json'), '{"version":99}')
    else {
      renameSync(join(cache, '.neutron-bun-cache.json'), join(root, 'marker'))
      symlinkSync(join(root, 'marker'), join(cache, '.neutron-bun-cache.json'))
    }
    expect(() => prepareNativeBunCache(source, scratch, uid)).toThrow()
  })

  test('refuses a foreign source owner, source aliases, writable source and escaping package links', () => {
    const { root, source, scratch, uid } = fixture()
    expect(() => prepareNativeBunCache(source, scratch, uid + 1)).toThrow('owned')
    symlinkSync(source, join(root, 'alias'))
    expect(() => prepareNativeBunCache(join(root, 'alias'), scratch, uid)).toThrow('canonical')
    chmodSync(source, 0o777)
    expect(() => prepareNativeBunCache(source, scratch, uid)).toThrow('owned')
    chmodSync(source, 0o700)
    symlinkSync('../../outside', join(source, 'fixture@1', 'escape'))
    expect(() => prepareNativeBunCache(source, scratch, uid)).toThrow('refused')
    expect(readdirSync(scratch)).toEqual([])
  })

  test('preserves an internal relative link', () => {
    const { source, scratch, uid } = fixture()
    symlinkSync('index.js', join(source, 'fixture@1', 'alias.js'))
    const cache = prepareNativeBunCache(source, scratch, uid)
    expect(readFileSync(join(cache, 'fixture@1', 'alias.js'), 'utf8')).toContain('value = 7')
  })

  test.each(['chained-escape', 'dangling', 'cycle'] as const)('refuses unresolved or canonically escaping links: %s', kind => {
    const { root, source, scratch, uid } = fixture()
    if (kind === 'chained-escape') {
      writeFileSync(join(root, 'outside'), 'outside source')
      writeFileSync(join(scratch, 'outside'), 'outside published cache')
      symlinkSync('.', join(source, 'a'))
      symlinkSync('../a/../outside', join(source, 'fixture@1', 'escape'))
    } else if (kind === 'dangling') symlinkSync('missing', join(source, 'missing-alias'))
    else symlinkSync('cycle', join(source, 'cycle'))
    expect(() => prepareNativeBunCache(source, scratch, uid)).toThrow('refused')
    expect(readdirSync(scratch)).toEqual(kind === 'chained-escape' ? ['outside'] : [])
  })

  test('relocates Bun absolute version aliases inside the new cache', () => {
    const { source, scratch, uid } = fixture()
    mkdirSync(join(source, 'fixture'), { mode: 0o700 })
    symlinkSync(join(source, 'fixture@1'), join(source, 'fixture', '1'))
    const cache = prepareNativeBunCache(source, scratch, uid)
    rmSync(source, { recursive: true })
    expect(readFileSync(join(cache, 'fixture', '1', 'index.js'), 'utf8')).toContain('value = 7')
  })

  test('retains Bun executable modes without mutating the shared inode', () => {
    const { source, scratch, uid } = fixture()
    const bin = join(source, 'fixture@1', 'index.js')
    chmodSync(bin, 0o777)
    const cache = prepareNativeBunCache(source, scratch, uid)
    expect(lstatSync(bin).mode & 0o777).toBe(0o777)
    expect(lstatSync(join(cache, 'fixture@1', 'index.js')).ino).toBe(lstatSync(bin).ino)
  })

  test('concurrent preparation publishes one complete cache', async () => {
    const { source, scratch, uid } = fixture()
    for (let i = 0; i < 200; i++) writeFileSync(join(source, 'fixture@1', `file-${i}`), 'fixture')
    const program = `import {prepareNativeBunCache} from ${JSON.stringify(new URL('./native-bun-cache.ts', import.meta.url).pathname)}; console.log(prepareNativeBunCache(...JSON.parse(process.argv[1])))`
    const children = [0, 1].map(() => Bun.spawn([process.execPath, '-e', program, JSON.stringify([source, scratch, uid])], { stdout: 'pipe', stderr: 'pipe' }))
    const results = await Promise.all(children.map(async child => ({ exit: await child.exited, path: (await new Response(child.stdout).text()).trim() })))
    expect(results.map(result => result.exit)).toEqual([0, 0])
    expect(results[0]!.path).toBe(results[1]!.path)
    expect(readdirSync(scratch)).toHaveLength(1)
    expect(readdirSync(join(results[0]!.path, 'fixture@1'))).toHaveLength(201)
  })

  test('refuses a real cross-filesystem seed without publishing a copied cache', () => {
    if (!existsSync('/dev/shm') || lstatSync('/dev/shm').dev === lstatSync(tmpdir()).dev) return
    const { source, uid } = fixture()
    const scratch = mkdtempSync('/dev/shm/native-bun-cache-test-'); roots.push(scratch)
    expect(() => prepareNativeBunCache(source, scratch, uid)).toThrow('refused')
    expect(readdirSync(scratch)).toEqual([])
  })

  test('production transport gives its child the cache while preserving unrelated env', async () => {
    const { root, source, uid } = fixture()
    const binary = join(root, 'fake-native')
    writeFileSync(binary, '#!/bin/sh\nprintf \'{"cache":"%s","control":"%s"}\\n\' "$BUN_INSTALL_CACHE_DIR" "$UNRELATED_CONTROL"\n', { mode: 0o700 })
    const expected = prepareNativeBunCache(source, tmpdir(), uid); roots.push(expected)
    const transport = createProjectControlStdioTransport({ binary, cwd: root, codexHome: root,
      env: { PATH: '/usr/bin:/bin', BUN_INSTALL_CACHE_DIR: source, UNRELATED_CONTROL: 'preserved' } })
    try {
      const message = await new Promise<unknown>((resolve, reject) => transport.listen(resolve, reject))
      expect(message).toEqual({ cache: expected, control: 'preserved' })
    } finally { transport.close() }
    chmodSync(expected, 0o755)
    expect(() => createProjectControlStdioTransport({ binary, cwd: root, codexHome: root,
      env: { BUN_INSTALL_CACHE_DIR: source } })).toThrow()
  })
})
