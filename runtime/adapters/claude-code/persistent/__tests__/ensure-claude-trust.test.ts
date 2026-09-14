import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, renameSync, symlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureClaudeTrust } from '../ensure-claude-trust.ts'
import { flockAvailable, setFlockImplForTests } from '../registry-lock.ts'
import { classifyThrownSpawnError } from '../classify-spawn-error.ts'

const dirs: string[] = []
afterEach(() => {
  setFlockImplForTests(undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trust-race-')))
  dirs.push(dir)
  const file = join(dir, '.claude.json')
  const projects = Object.fromEntries(Array.from({ length: 19531 }, (_, i) => [`/project-${i}`, { hasTrustDialogAccepted: true }]))
  writeFileSync(file, JSON.stringify({ projects, custom: 'preserved' }))
  return { dir, file }
}

test('a refused lock preserves config bytes and reports a local configuration failure', () => {
  const { dir, file } = fixture()
  const before = readFileSync(file, 'utf8')
  expect(flockAvailable()).toBe(true)
  setFlockImplForTests(() => -1)
  let error: unknown
  try { ensureClaudeTrust({ cwd: dir, configDir: dir }) } catch (e) { error = e }
  expect(classifyThrownSpawnError(error)).toBe('spawn_configuration')
  expect(readFileSync(file, 'utf8')).toBe(before)
})

test('unavailable FFI warns once and still seeds on repeated calls', () => {
  const { dir, file } = fixture()
  setFlockImplForTests(null)
  expect(flockAvailable()).toBe(false)
  const warning = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    for (const cwd of [dir, join(dir, 'another-project')]) {
      expect(ensureClaudeTrust({ cwd, configDir: dir })).toBe(file)
      const config = JSON.parse(readFileSync(file, 'utf8'))
      expect(config.projects[cwd]).toEqual({
        hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true,
      })
      expect(config.bypassPermissionsModeAccepted).toBe(true)
      expect(config.hasCompletedOnboarding).toBe(true)
      expect(config.custom).toBe('preserved')
      expect(config.projects['/project-0'].hasTrustDialogAccepted).toBe(true)
    }
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0]?.[0]).toContain('flock unavailable')
  } finally {
    warning.mockRestore()
  }
})

test('normal acquisition seeds without an unavailable warning', () => {
  const { dir, file } = fixture()
  expect(flockAvailable()).toBe(true)
  const warning = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(ensureClaudeTrust({ cwd: dir, configDir: dir })).toBe(file)
    const config = JSON.parse(readFileSync(file, 'utf8'))
    expect(config.projects[dir]).toEqual({
      hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true,
    })
    expect(config.bypassPermissionsModeAccepted).toBe(true)
    expect(config.hasCompletedOnboarding).toBe(true)
    expect(config.custom).toBe('preserved')
    expect(Object.keys(config.projects)).toHaveLength(19532)
    expect(warning).not.toHaveBeenCalled()
  } finally {
    warning.mockRestore()
  }
})

test('two overlapping process seeds retain both worktrees and existing config', async () => {
  const { dir, file } = fixture()
  const a = join(dir, 'a'), b = join(dir, 'b')
  mkdirSync(a); mkdirSync(b)
  const modulePath = new URL('../ensure-claude-trust.ts', import.meta.url).pathname
  const script = join(dir, 'seed.ts')
  // Delay only the first process AFTER its read. Without the lock the second
  // process reads the same snapshot and writes before the first overwrites it.
  // With the lock the second cannot read until the first releases its lock.
  writeFileSync(script, `
import { mock } from 'bun:test'
import * as fs from 'node:fs'
const [dir, cwd, role, modulePath] = process.argv.slice(2)
const originalRead = fs.readFileSync
mock.module('node:fs', () => ({ ...fs, readFileSync: (path, ...args) => {
  const result = originalRead(path, ...args)
  if (path === dir + '/.claude.json') {
    fs.writeFileSync(dir + '/' + role + '-read', '')
    if (role === 'a') {
      const deadline = Date.now() + 700
      while (!fs.existsSync(dir + '/b-read') && Date.now() < deadline) Bun.sleepSync(5)
      if (fs.existsSync(dir + '/b-read')) {
        while (!fs.existsSync(dir + '/b-done') && Date.now() < deadline) Bun.sleepSync(5)
      }
    }
  }
  return result
}}))
const { ensureClaudeTrust } = await import(modulePath)
ensureClaudeTrust({ cwd, configDir: dir })
fs.writeFileSync(dir + '/' + role + '-done', '')
`)
  const first = Bun.spawn([process.execPath, script, dir, a, 'a', modulePath], { stdout: 'pipe', stderr: 'pipe' })
  let second: ReturnType<typeof Bun.spawn> | undefined
  try {
    const deadline = Date.now() + 3000
    const { existsSync } = await import('node:fs')
    while (!existsSync(join(dir, 'a-read')) && Date.now() < deadline) await Bun.sleep(5)
    expect(existsSync(join(dir, 'a-read'))).toBe(true)
    second = Bun.spawn([process.execPath, script, dir, b, 'b', modulePath], { stdout: 'pipe', stderr: 'pipe' })
    expect(await first.exited).toBe(0)
    expect(await second.exited).toBe(0)
    const config = JSON.parse(readFileSync(file, 'utf8'))
    expect(config.projects[a]?.hasTrustDialogAccepted).toBe(true)
    expect(config.projects[b]?.hasTrustDialogAccepted).toBe(true)
    expect(Object.keys(config.projects)).toHaveLength(19533)
    expect(config.custom).toBe('preserved')
  } finally {
    first.kill(); second?.kill()
    await first.exited
    if (second) await second.exited
  }
}, 10000)

function retentionFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trust-retention-')))
  dirs.push(dir)
  const root = join(dir, 'projects')
  mkdirSync(root)
  const live = join(root, 'live'), stale = join(root, 'stale')
  mkdirSync(live); mkdirSync(stale)
  const file = join(dir, '.claude.json')
  const original = { hasCompletedOnboarding: true, theme: 'dark', custom: { nested: [1, 'keep'] }, projects: {} }
  writeFileSync(file, JSON.stringify(original))
  ensureClaudeTrust({ cwd: stale, configDir: dir })
  ensureClaudeTrust({ cwd: live, configDir: dir })
  return { dir, root, live, stale, file, original }
}

test('removes a recorded deleted child, preserves live projects and every unrelated config value', () => {
  const { dir, live, stale, file, original } = retentionFixture()
  const before = JSON.parse(readFileSync(file, 'utf8'))
  before.projects[live].custom = { allowedTools: ['Read'], value: 42 }
  writeFileSync(file, JSON.stringify(before))
  const beforeInode = statSync(file).ino
  rmSync(stale, { recursive: true })
  // Seed elsewhere so the live entry is tested by the sweep, not re-created.
  ensureClaudeTrust({ cwd: dir, configDir: dir })
  const after = JSON.parse(readFileSync(file, 'utf8'))
  expect(statSync(file).ino).not.toBe(beforeInode)
  expect(after.projects[stale]).toBeUndefined()
  expect(after.projects[live]).toEqual(before.projects[live])
  for (const key of ['hasCompletedOnboarding', 'theme', 'custom']) {
    expect(after[key]).toEqual(original[key as keyof typeof original])
  }
  expect(Object.keys(after.projects).sort()).toEqual([dir, live].sort())
})

test('preserves unrecorded history, foreign paths, and entries from a different parent identity', () => {
  const { dir, root, live, stale, file } = retentionFixture()
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const marker = config.projects[stale].neutronSeededProjectParentV1
  expect(typeof marker).toBe('string')
  const history = join(root, 'history'), foreign = join(dir, 'foreign')
  const unavailableHistory = join(dir, 'old-volume', 'history')
  config.projects[history] = { hasTrustDialogAccepted: true }
  config.projects[unavailableHistory] = { hasTrustDialogAccepted: true }
  config.projects[foreign] = { hasTrustDialogAccepted: true, neutronSeededProjectParentV1: marker }
  config.projects[stale].neutronSeededProjectParentV1 = 'different-volume'
  writeFileSync(file, JSON.stringify(config))
  rmSync(stale, { recursive: true })
  ensureClaudeTrust({ cwd: dir, configDir: dir })
  const after = JSON.parse(readFileSync(file, 'utf8'))
  for (const path of [history, unavailableHistory, foreign, stale, live]) expect(after.projects[path]).toEqual(config.projects[path])
})

test('preserves trust while a parent is unavailable or replaced by a symlink', () => {
  const { dir, root, stale, file } = retentionFixture()
  const before = JSON.parse(readFileSync(file, 'utf8')).projects
  const moved = join(dir, 'detached')
  renameSync(root, moved)
  ensureClaudeTrust({ cwd: dir, configDir: dir })
  expect(JSON.parse(readFileSync(file, 'utf8')).projects[stale]).toEqual(before[stale])
  // A symlink back to the identical inode must not establish root provenance.
  rmSync(join(moved, 'stale'), { recursive: true })
  symlinkSync(moved, root)
  ensureClaudeTrust({ cwd: dir, configDir: dir })
  expect(JSON.parse(readFileSync(file, 'utf8')).projects[stale]).toEqual(before[stale])
})

test('preserves dangling links and does not record provenance for a missing cwd', () => {
  const { dir, root, stale, file } = retentionFixture()
  const before = JSON.parse(readFileSync(file, 'utf8')).projects[stale]
  rmSync(stale, { recursive: true })
  symlinkSync(join(dir, 'unmounted-target'), stale)
  const missing = join(root, 'missing')
  ensureClaudeTrust({ cwd: missing, configDir: dir })
  const after = JSON.parse(readFileSync(file, 'utf8'))
  expect(after.projects[stale]).toEqual(before)
  expect(after.projects[missing].hasTrustDialogAccepted).toBe(true)
  expect(after.projects[missing].neutronSeededProjectParentV1).toBeUndefined()
})

for (const contents of ['{broken', 'null', '[]', '{"projects":[]}', '{"projects":null}', '{"projects":{"x":null}}']) {
  test(`refuses unreadable config shape without replacing its bytes: ${contents}`, () => {
    const { dir, file } = fixture()
    writeFileSync(file, contents)
    let error: unknown
    try { ensureClaudeTrust({ cwd: dir, configDir: dir }) } catch (e) { error = e }
    expect(classifyThrownSpawnError(error)).toBe('spawn_configuration')
    expect(readFileSync(file, 'utf8')).toBe(contents)
  })
}

test('a missing current cwd retains its prior project fields; pre-existing projects are never adopted', () => {
  const { dir, stale, file } = retentionFixture()
  const before = JSON.parse(readFileSync(file, 'utf8'))
  before.projects[stale].custom = 'keep-current'
  before.projects[dir] = { hasTrustDialogAccepted: true, custom: 'pre-existing' }
  writeFileSync(file, JSON.stringify(before))
  rmSync(stale, { recursive: true })
  ensureClaudeTrust({ cwd: stale, configDir: dir })
  expect(JSON.parse(readFileSync(file, 'utf8')).projects[stale]).toEqual(before.projects[stale])
  ensureClaudeTrust({ cwd: dir, configDir: dir })
  expect(JSON.parse(readFileSync(file, 'utf8')).projects[dir].neutronSeededProjectParentV1).toBeUndefined()
})

test('a file used as cwd does not acquire directory provenance', () => {
  const { dir, root, file } = retentionFixture()
  const cwd = join(root, 'regular-file')
  writeFileSync(cwd, '')
  ensureClaudeTrust({ cwd, configDir: dir })
  expect(JSON.parse(readFileSync(file, 'utf8')).projects[cwd].neutronSeededProjectParentV1).toBeUndefined()
})

for (const fault of ['EACCES', 'parent-disappeared']) {
  test(`preserves a recorded project when deletion cannot be proved: ${fault}`, async () => {
    const { dir, stale, root, file } = retentionFixture()
    const before = JSON.parse(readFileSync(file, 'utf8')).projects[stale]
    rmSync(stale, { recursive: true })
    const script = join(dir, 'fault.ts')
    writeFileSync(script, `
import { mock } from 'bun:test'
import * as fs from 'node:fs'
const [dir, stale, root, fault, modulePath] = process.argv.slice(2)
const original = fs.lstatSync
let checkedChild = false
mock.module('node:fs', () => ({ ...fs, lstatSync: (path, ...args) => {
  if (path === stale) {
    checkedChild = true
    throw Object.assign(new Error('injected child probe'), { code: fault === 'EACCES' ? 'EACCES' : 'ENOENT' })
  }
  if (path === root && checkedChild && fault === 'parent-disappeared') {
    throw Object.assign(new Error('injected unavailable parent'), { code: 'ENOENT' })
  }
  return original(path, ...args)
}}))
const { ensureClaudeTrust } = await import(modulePath)
ensureClaudeTrust({ cwd: dir, configDir: dir })
if (!checkedChild) throw new Error('fault was unreachable')
`)
    const child = Bun.spawn([process.execPath, script, dir, stale, root, fault,
      new URL('../ensure-claude-trust.ts', import.meta.url).pathname], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8')).projects[stale]).toEqual(before)
  })
}
