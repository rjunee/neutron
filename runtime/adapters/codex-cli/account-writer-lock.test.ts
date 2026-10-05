import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCodexAccountWriteLease, codexAccountWriterCommand, resolveCodexNativeBinary } from './account-writer-lock.ts'
import { createProjectControlStdioTransport } from './persistent/project-control-broker-transport.ts'
import { startCodexExec } from './exec.ts'

const roots: string[] = []
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'codex-writer-test-')); roots.push(dir); return dir }
let binary: string
let binaryRoot: string
beforeAll(() => {
  binaryRoot = mkdtempSync(join(tmpdir(), 'codex-writer-native-'))
  binary = join(binaryRoot, 'codex')
  const result = spawnSync('cc', ['-o', binary, join(import.meta.dir, 'fixtures/account-writer-native.c')])
  if (result.status !== 0) throw new Error('Synthetic native writer compilation failed')
})
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
afterAll(() => rmSync(binaryRoot, { recursive: true, force: true }))

function launch(home: string, nativeArgs: string[] = []) {
  const [command, ...args] = codexAccountWriterCommand(binary, nativeArgs, home)
  const child = spawn(command!, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const exit = new Promise<number | null>(resolve => child.once('exit', resolve))
  const output = new Promise<{ pid: number; locks: number; lifetimeFd: number; descendant: number }>((resolve, reject) => {
    child.stdout.once('data', data => { try { resolve(JSON.parse(String(data))) } catch (error) { reject(error) } })
    child.once('exit', code => reject(new Error(`writer refused ${code}`)))
  })
  return { child, output, exit }
}

/** Independent kernel oracle: process census must not hide a released lock. */
function kernelBusy(home: string, nativeOnly = false): boolean {
  const result = spawnSync('python3', ['-c', `import fcntl,sys
try:
 with open(sys.argv[1], 'r+') as reservation, open(sys.argv[2], 'r+') as native:
  if sys.argv[3] != 'native': fcntl.flock(reservation, fcntl.LOCK_EX | fcntl.LOCK_NB)
  fcntl.lockf(native, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: sys.exit(73)
`, join(home, '.neutron-account-writer.lock'), join(home, '.neutron-account-native.lock'), nativeOnly ? 'native' : 'either'])
  if (result.status !== 0 && result.status !== 73) throw new Error('Kernel oracle failed')
  return result.status === 73
}

test('same-account exclusion, distinct accounts, alias identity and permanent inode', () => {
  const home = root(), other = root(), alias = join(root(), 'alias')
  symlinkSync(home, alias)
  const first = acquireCodexAccountWriteLease(home)
  const inode = statSync(join(home, '.neutron-account-writer.lock')).ino
  const nativeInode = statSync(join(home, '.neutron-account-native.lock')).ino
  try {
    expect(() => acquireCodexAccountWriteLease(home)).toThrow('accountBusy')
    expect(() => acquireCodexAccountWriteLease(alias)).toThrow('accountBusy')
    const distinct = acquireCodexAccountWriteLease(other); distinct.close()
  } finally { first.close() }
  expect(statSync(join(home, '.neutron-account-writer.lock')).ino).toBe(inode)
  expect(statSync(join(home, '.neutron-account-native.lock')).ino).toBe(nativeInode)
  const successor = acquireCodexAccountWriteLease(alias); successor.close()
  expect(statSync(join(home, '.neutron-account-writer.lock')).ino).toBe(inode)
})

test('synthetic process census covers live, missing, changed, default-home and dead consumers', () => {
  const result = spawnSync('python3', ['-B', join(import.meta.dir, 'account-writer-test.py')])
  expect(result.status).toBe(0)
})

test('authenticated observation verifies real signatures and fences unknown in both consumers', () => {
  const result = spawnSync('python3', ['-B', join(import.meta.dir, 'account-observation-client-test.py')], { encoding: 'utf8' })
  expect({ status: result.status, error: result.status === 0 ? '' : result.stderr }).toEqual({ status: 0, error: '' })
})

test('observation contract rejects opposite-direction semantic mutants', () => {
  const result = spawnSync('python3', ['-B', join(import.meta.dir, 'account-observation-mutation-test.py')], { encoding: 'utf8' })
  expect({ status: result.status, error: result.status === 0 ? '' : result.stderr }).toEqual({ status: 0, error: '' })
})

test('private proc excludes unreadable outsiders but still refuses unknown insiders and finds known natives', () => {
  const result = spawnSync('python3', ['-B', join(import.meta.dir, 'account-writer-boundary-test.py')], {
    encoding: 'utf8', timeout: 25_000,
  })
  expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: '' })
  expect(result.stdout).toContain('outside refusal and isolated native positive/negative controls passed')
}, 30_000)

test('exec adapter exposes accountBusy before the synthetic native can start', async () => {
  const home = root(), lease = acquireCodexAccountWriteLease(home)
  try {
    const events = []
    for await (const event of startCodexExec({ bin: binary, prompt: 'synthetic', spawn_env: { CODEX_HOME: home }, signal: new AbortController().signal })) events.push(event)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('accountBusy') }))
  } finally { lease.close() }
})

test('a reserved lease transfers only into its own canonical account', async () => {
  const home = root(), other = root(), lease = acquireCodexAccountWriteLease(home)
  try {
    expect(() => createProjectControlStdioTransport({ binary, cwd: other, codexHome: other, env: {}, accountWriteLease: lease })).toThrow('different home')
    expect(kernelBusy(home)).toBe(true)
    const transport = createProjectControlStdioTransport({ binary, cwd: home, codexHome: home,
      env: { PATH: process.env.PATH! }, accountWriteLease: lease })
    try {
      await new Promise((resolve, reject) => transport.listen(resolve, reject))
      lease.close()
      expect(kernelBusy(home)).toBe(true)
    } finally { transport.close(); await transport.exited }
    expect(kernelBusy(home)).toBe(false)
  } finally { lease.close() }
})

test('native transport owns the lock after parent lease closes; exact exit releases it', async () => {
  const home = root()
  const transport = createProjectControlStdioTransport({ binary, cwd: home, codexHome: home, env: { PATH: process.env.PATH! } })
  try {
    const native = await new Promise<{ pid: number; locks: number }>((resolve, reject) => transport.listen(v => resolve(v as { pid: number; locks: number }), reject))
    expect(native.pid).toBe(transport.processIdentity!.pid)
    expect(native.locks).toBeGreaterThan(0)
    expect(kernelBusy(home, true)).toBe(true)
    expect(kernelBusy(home)).toBe(true)
    expect(() => acquireCodexAccountWriteLease(home)).toThrow('accountBusy')
    transport.close(); await transport.exited
    expect(kernelBusy(home)).toBe(false)
    const successor = acquireCodexAccountWriteLease(home); successor.close()
  } finally { transport.close() }
})

test('closing a surviving parent descriptor cannot unlock an already-running native writer', async () => {
  const home = root(), lease = acquireCodexAccountWriteLease(home)
  const [command, ...args] = codexAccountWriterCommand(binary, [], home)
  args.splice(2, 0, '--inherited-lock-fd', '3')
  const child = spawn(command!, args, { stdio: ['ignore', 'pipe', 'pipe', lease.fd] })
  const exited = new Promise(resolve => child.once('exit', resolve))
  try {
    await new Promise((resolve, reject) => {
      child.stdout!.once('data', resolve)
      child.once('exit', () => reject(new Error('Native writer exited before readiness')))
    })
    expect(kernelBusy(home)).toBe(true)
    lease.close()
    expect(kernelBusy(home)).toBe(true)
  } finally { lease.close(); child.kill(); await exited }
  expect(kernelBusy(home)).toBe(false)
})

test('two racing admissions allow exactly one real native writer', async () => {
  const home = root()
  const attempts = [launch(home), launch(home)]
  try {
    const result = await Promise.allSettled(attempts.map(value => value.output))
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter(value => value.status === 'rejected')).toHaveLength(1)
    expect(() => acquireCodexAccountWriteLease(home)).toThrow('accountBusy')
  } finally {
    for (const attempt of attempts) attempt.child.kill()
    await Promise.all(attempts.map(value => value.exit))
  }
  const successor = acquireCodexAccountWriteLease(home); successor.close()
})

test('gateway death leaves the native process holding the account until its own exit', async () => {
  const home = root()
  const program = `import {createProjectControlStdioTransport as create} from ${JSON.stringify(join(import.meta.dir, 'persistent/project-control-broker-transport.ts'))};
    const t=create({binary:process.argv[1],cwd:process.argv[2],codexHome:process.argv[2],env:{PATH:process.env.PATH}});
    t.listen(v=>console.log(JSON.stringify(v)),()=>{});`
  const parent = spawn(process.execPath, ['-e', program, binary, home], { stdio: ['ignore', 'pipe', 'pipe'] })
  const parentExit = new Promise(resolve => parent.once('exit', resolve))
  let nativePid: number | undefined
  try {
    nativePid = await new Promise<number>((resolve, reject) => {
      parent.stdout.once('data', data => resolve(JSON.parse(String(data)).pid))
      parent.once('exit', () => reject(new Error('Parent died before native readiness')))
    })
    parent.kill('SIGKILL'); await parentExit
    expect(() => process.kill(nativePid!, 0)).not.toThrow()
    expect(kernelBusy(home)).toBe(true)
    expect(kernelBusy(home, true)).toBe(true)
    expect(() => acquireCodexAccountWriteLease(home)).toThrow('accountBusy')
  } finally {
    parent.kill('SIGKILL'); await parentExit
    if (nativePid !== undefined) process.kill(nativePid, 'SIGTERM')
  }
  for (let i = 0; i < 100; i++) {
    try { const successor = acquireCodexAccountWriteLease(home); successor.close(); return }
    catch { await Bun.sleep(10) }
  }
  throw new Error('Native exit did not release account')
})

test('a live execed tool retains its descriptor but cannot retain admission after native exit', async () => {
  const home = root(), native = launch(home, ['--descendant'])
  let descendant: number | undefined
  let birth: string | undefined
  const processState = (pid: number) => {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = value.slice(value.lastIndexOf(')') + 2).split(' ')
    return { state: fields[0], birth: fields[19] }
  }
  try {
    const ready = await native.output
    descendant = ready.descendant
    expect(descendant).toBeGreaterThan(0)
    birth = processState(descendant!).birth
    for (let attempt = 0; attempt < 100; attempt++) {
      if (readlinkSync(`/proc/${descendant}/exe`) === realpathSync('/bin/sleep')) break
      await Bun.sleep(5)
    }
    expect(readlinkSync(`/proc/${descendant}/exe`)).toBe(realpathSync('/bin/sleep'))
    const lifetimePath = join(home, '.neutron-account-native.lock')
    expect(ready.locks).toBe(1)
    expect(Number.isInteger(ready.lifetimeFd)).toBe(true)
    expect(ready.lifetimeFd).toBeGreaterThanOrEqual(3)
    // The fixture identified this descriptor by inode before fork. Unrelated
    // loader descriptors can disappear even after /proc/exe reports sleep.
    const inheritedPath = `/proc/${descendant}/fd/${ready.lifetimeFd}`
    expect(readlinkSync(inheritedPath)).toBe(lifetimePath)
    const inherited = statSync(inheritedPath), expected = statSync(lifetimePath)
    expect([inherited.dev, inherited.ino]).toEqual([expected.dev, expected.ino])
    expect(kernelBusy(home, true)).toBe(true)
    expect(() => acquireCodexAccountWriteLease(home)).toThrow('accountBusy')
    native.child.kill('SIGKILL'); await native.exit
    expect(processState(descendant!).birth).toBe(birth)
    expect(['Z', 'X']).not.toContain(processState(descendant!).state)
    expect(kernelBusy(home, true)).toBe(false)
    const successorLease = acquireCodexAccountWriteLease(home); successorLease.close()
    const successor = launch(home)
    try {
      await successor.output
      expect(kernelBusy(home, true)).toBe(true)
      expect(() => process.kill(descendant!, 0)).not.toThrow()
    } finally { successor.child.kill(); await successor.exit }
  } finally {
    native.child.kill(); await native.exit
    if (descendant !== undefined && birth !== undefined) {
      try {
        if (processState(descendant).birth === birth) process.kill(descendant, 'SIGTERM')
        for (let attempt = 0; attempt < 100; attempt++) {
          const state = processState(descendant)
          if (state.birth !== birth || ['Z', 'X'].includes(state.state ?? '')) break
          await Bun.sleep(5)
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
})

test('credential admission checks an independent process lock even without a native census hit', async () => {
  const home = root(), initial = acquireCodexAccountWriteLease(home); initial.close()
  const child = spawn('python3', ['-c', `import fcntl,sys
with open(sys.argv[1], 'r+') as handle:
 fcntl.lockf(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
 print('ready', flush=True)
 sys.stdin.readline()
`, join(home, '.neutron-account-native.lock')], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise(resolve => child.once('exit', resolve))
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve)
      child.once('exit', () => reject(new Error('Independent lock holder exited early')))
    })
    expect(kernelBusy(home, true)).toBe(true)
    expect(() => acquireCodexAccountWriteLease(home)).toThrow('accountBusy')
  } finally { child.stdin.end(); await exited }
  const admitted = acquireCodexAccountWriteLease(home); admitted.close()
})

test('startup reservation stays exclusive until the native process acquires its lifetime lock', async () => {
  const home = root(), lease = acquireCodexAccountWriteLease(home)
  const script = join(import.meta.dir, 'account-writer.py')
  const program = `import importlib.util,sys
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location('writer',sys.argv[1])
writer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)
original=writer.native_lock
def paused(home):
 print('before-lifetime',flush=True)
 sys.stdin.readline()
 return original(home)
writer.native_lock=paused
writer.main(['--home',sys.argv[2],'--inherited-lock-fd','3','--',sys.argv[3]])
`
  const child = spawn('python3', ['-B', '-c', program, script, home, binary], { stdio: ['pipe', 'pipe', 'pipe', lease.fd] })
  const exited = new Promise(resolve => child.once('exit', resolve))
  try {
    await new Promise((resolve, reject) => {
      child.stdout!.once('data', resolve)
      child.once('exit', () => reject(new Error('Admission exited before the lifetime handoff')))
    })
    lease.close()
    expect(kernelBusy(home)).toBe(true)
    expect(kernelBusy(home, true)).toBe(false)
    expect(() => acquireCodexAccountWriteLease(home)).toThrow('accountBusy')
    const ready = new Promise((resolve, reject) => {
      child.stdout!.once('data', resolve)
      child.once('exit', () => reject(new Error('Admission exited during lifetime handoff')))
    })
    child.stdin!.end('\n'); await ready
    expect(kernelBusy(home, true)).toBe(true)
    expect(() => acquireCodexAccountWriteLease(home)).toThrow('accountBusy')
  } finally { lease.close(); child.kill(); await exited }
  expect(kernelBusy(home)).toBe(false)
})

test('existing unwrapped native consumer refuses admission; distinct account remains usable', async () => {
  const home = root(), other = root()
  const native = spawn(binary, [], { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise(resolve => native.once('exit', resolve))
  try {
    await new Promise(resolve => native.stdout.once('data', resolve))
    expect(() => acquireCodexAccountWriteLease(home)).toThrow('accountBusy')
    const distinct = acquireCodexAccountWriteLease(other); distinct.close()
  } finally { native.kill(); await exited }
  const successor = acquireCodexAccountWriteLease(home); successor.close()
})

test('official npm wrapper resolves to the native writer, unknown wrappers refuse', () => {
  const dir = root(), packageRoot = join(dir, 'node_modules/@openai/codex')
  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
  const entry = join(packageRoot, 'bin/codex.js')
  writeFileSync(entry, '#!/usr/bin/env node\nthrow Error("wrapper must not run")\n', { mode: 0o755 })
  const nativeDir = join(packageRoot, `vendor/${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl/bin`)
  mkdirSync(nativeDir, { recursive: true }); symlinkSync(binary, join(nativeDir, 'codex'))
  expect(resolveCodexNativeBinary(entry, dir, {})).toBe(realpathSync(binary))
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'unknown-wrapper' }))
  expect(() => resolveCodexNativeBinary(entry, dir, {})).toThrow('accountAdmissionUnknown')
})

test('unsafe lock paths refuse without touching credential bytes', () => {
  const home = root(), auth = join(home, 'auth.json')
  writeFileSync(auth, 'synthetic credential sentinel')
  symlinkSync(auth, join(home, '.neutron-account-writer.lock'))
  expect(() => acquireCodexAccountWriteLease(home)).toThrow('accountAdmissionUnknown')
  expect(readFileSync(auth, 'utf8')).toBe('synthetic credential sentinel')
  expect(existsSync(auth)).toBe(true)
})
