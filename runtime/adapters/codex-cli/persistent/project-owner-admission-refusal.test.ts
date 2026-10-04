import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerAdmissionRefusalPath, releaseRefusedOwnerLaunch } from './project-owner-admission-refusal.ts'
import { helperIdentity } from './project-owner-helper-protocol.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-refusal-')); roots.push(root)
  const launch = join(root, '.neutron-owner-launch.json')
  const bytes = JSON.stringify({ operation: 'fixture-launch' })
  writeFileSync(launch, bytes, { mode: 0o600 })
  return { root, launch, bytes, receipt: ownerAdmissionRefusalPath(launch, bytes), pane: join(root, '.neutron-owner-pane.json') }
}

test('pre-native refusal acknowledges the exact helper and frees only its provisional launch after actual exit', async () => {
  const f = fixture()
  const module = new URL('./project-owner-admission-refusal.ts', import.meta.url).pathname
  const errors = new URL('../account-writer-lock.ts', import.meta.url).pathname
  const child = Bun.spawn([process.execPath, '-e', `import { recordOwnerAdmissionRefusal } from ${JSON.stringify(module)};
    import { CodexAccountWriterError } from ${JSON.stringify(errors)};
    await recordOwnerAdmissionRefusal(process.argv[1], process.argv[2], new CodexAccountWriterError('accountBusy', 'fixture')); process.exit(73)`, f.launch, f.bytes],
  { stdout: 'ignore', stderr: 'pipe' })
  try {
    const identity = helperIdentity(child.pid)
    writeFileSync(f.pane, JSON.stringify({ handle: 'fixture-pane', identity }), { mode: 0o600 })
    const deadline = Date.now() + 5_000
    while (!existsSync(f.receipt)) {
      if (Date.now() >= deadline) throw new Error('Fixture refusal receipt missing')
      await Bun.sleep(10)
    }
    expect(existsSync(f.launch)).toBe(true)
    expect(existsSync(f.pane)).toBe(true)
    const exit = child.exited
    expect(await releaseRefusedOwnerLaunch(f.launch, f.bytes, 5_000)).toMatchObject({ code: 'accountBusy' })
    expect(await exit).toBe(73)
    expect(existsSync(f.launch)).toBe(false)
    expect(existsSync(f.pane)).toBe(false)
    expect(existsSync(f.receipt)).toBe(true)
    const next = JSON.stringify({ operation: 'next-launch' })
    writeFileSync(f.launch, next, { mode: 0o600 })
    expect(await releaseRefusedOwnerLaunch(f.launch, next, 5)).toBeNull()
    expect(readFileSync(f.launch, 'utf8')).toBe(next)
  } finally { child.kill(); await child.exited }
})

test('missing, foreign and post-native receipts never free uncertain launch records', async () => {
  const f = fixture()
  expect(await releaseRefusedOwnerLaunch(f.launch, f.bytes, 1)).toBeNull()
  const helper = helperIdentity()
  writeFileSync(f.pane, JSON.stringify({ identity: helper }), { mode: 0o600 })
  writeFileSync(f.receipt, JSON.stringify({ version: 1, kind: 'pre-native-account-refusal', helper: { ...helper, start: '0' }, code: 'accountBusy' }), { mode: 0o600 })
  await expect(releaseRefusedOwnerLaunch(f.launch, f.bytes, 1)).rejects.toThrow('identity changed')
  writeFileSync(f.receipt, JSON.stringify({ version: 1, kind: 'pre-native-account-refusal', helper, code: 'accountBusy' }), { mode: 0o600 })
  writeFileSync(join(f.root, '.neutron-owner-bootstrap.sqlite'), 'native-evidence', { mode: 0o600 })
  await expect(releaseRefusedOwnerLaunch(f.launch, f.bytes, 1)).rejects.toThrow('native owner evidence')
  expect(readFileSync(f.launch, 'utf8')).toBe(f.bytes)
  expect(existsSync(f.pane)).toBe(true)
})
