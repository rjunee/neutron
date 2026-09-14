import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

import { stagingSecretPath } from '../persisted-secret.ts'

// A new process is essential: the old module counter must still be zero when
// the remnant is planted. Run the real loader, recording disk state and warnings.
function installWithRemnant(failWrite = false) {
  const child = spawnSync(process.execPath, ['--eval', `
    import { spyOn } from 'bun:test'
    import * as fs from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { resolvePersistedSecret } from './open/persisted-secret.ts'
    const dir = fs.mkdtempSync(join(tmpdir(), 'secret-remnant-'))
    const prefix = '.secret.tmp'
    const remnant = join(dir, prefix + '.' + process.pid + '.1')
    const path = join(dir, '.secret')
    const warnings = []
    const attempts = []
    const originalOpen = fs.openSync
    const originalWrite = fs.writeSync
    let stagingFd
    try {
      fs.writeFileSync(remnant, 'foreign crash bytes', { mode: 0o600 })
      fs.writeFileSync(path, 'weak', { mode: 0o600 })
      const openSpy = spyOn(fs, 'openSync').mockImplementation((p, ...args) => {
        if (String(p).startsWith(join(dir, prefix))) attempts.push(String(p))
        const fd = originalOpen(p, ...args)
        if (String(p).startsWith(join(dir, prefix))) stagingFd = fd
        return fd
      })
      const writeSpy = spyOn(fs, 'writeSync').mockImplementation((fd, ...args) => {
        if (${failWrite} && fd === stagingFd) throw new Error('injected staging write failure')
        return originalWrite(fd, ...args)
      })
      const result = resolvePersistedSecret({
        dir, path, lockPath: join(dir, '.secret.lock'), tmpPrefix: prefix,
        minLen: 32, mint: () => 'a'.repeat(48),
        log: { warn: (...args) => warnings.push(args) },
        unconvergedEvent: 'secret_unconverged', unconvergedNote: 'persistence failed',
      })
      writeSpy.mockRestore()
      openSpy.mockRestore()
      console.log(JSON.stringify({
        result, warnings, attempts: attempts.map(p => p.split('/').pop()),
        remnant: fs.readFileSync(remnant, 'utf8'),
        disk: fs.readFileSync(path, 'utf8'),
        mode: fs.statSync(path).mode & 0o777,
        staging: fs.readdirSync(dir).filter(p => p.startsWith(prefix)),
        remnantName: remnant.split('/').pop(),
      }))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  `], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' })
  expect(child.status).toBe(0)
  expect(child.stderr).toBe('')
  return JSON.parse(child.stdout)
}

test('fresh process preserves foreign PID remnant and persists through its own staging file', () => {
  const observed = installWithRemnant()
  expect(observed.result).toEqual({ value: 'a'.repeat(48), source: 'persisted' })
  expect(observed.disk).toBe('a'.repeat(48) + '\n')
  expect(observed.mode).toBe(0o600)
  expect(observed.warnings).toEqual([])
  expect(observed.remnant).toBe('foreign crash bytes')
  expect(observed.attempts).toHaveLength(1)
  expect(observed.attempts[0]).not.toBe(observed.remnantName)
  // Foreign remnant retained; our successful staging entry consumed by rename.
  expect(observed.staging).toEqual([observed.remnantName])
})

test('failed owned staging write cleans only our file and records the failure', () => {
  const observed = installWithRemnant(true)
  expect(observed.result.source).toBe('ephemeral')
  expect(observed.disk).toBe('weak')
  expect(observed.remnant).toBe('foreign crash bytes')
  expect(observed.attempts).toHaveLength(1)
  expect(observed.attempts[0]).not.toBe(observed.remnantName)
  expect(observed.staging).toEqual([observed.remnantName])
  expect(observed.warnings).toHaveLength(1)
  expect(observed.warnings[0][0]).toBe('secret_unconverged')
})

test('staging names have fresh random identity on every call with the same PID', () => {
  const names = Array.from({ length: 128 }, () => basename(stagingSecretPath('.', '.secret.tmp')))
  for (const name of names) {
    expect(name).toMatch(new RegExp('^\\.secret\\.tmp\\.' + process.pid + '\\.[0-9a-f]{16}$'))
  }
  expect(new Set(names).size).toBe(names.length)
})
