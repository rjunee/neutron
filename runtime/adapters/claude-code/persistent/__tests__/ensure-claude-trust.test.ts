import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
