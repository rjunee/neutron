import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDurableCodexOwner } from '../wiring/codex-durable-owner.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-owner-refusal-')); roots.push(root)
  const codexHome = join(root, 'home'); mkdirSync(codexHome, { mode: 0o700 })
  writeFileSync(join(codexHome, 'project-owner.json'), JSON.stringify('project-one'), { mode: 0o600 })
  writeFileSync(join(codexHome, 'auth.json'), '{}', { mode: 0o600 })
  return { projectId: 'project-one', cwd: root, codexHome, binary: 'must-not-launch', socketPath: join(codexHome, 'owner.sock'), env: {} }
}

test('an unfinished launch is not retried even when its descriptor has not appeared', async () => {
  const options = fixture()
  writeFileSync(join(options.codexHome, '.neutron-owner-launch.json'), '{}', { mode: 0o600 })
  await expect(openDurableCodexOwner(options)).rejects.toThrow('ENOENT')
})

test('a descriptor without the host launch provenance never becomes authority', async () => {
  const options = fixture()
  writeFileSync(join(options.codexHome, '.neutron-owner-helper.json'), '{}', { mode: 0o600 })
  await expect(openDurableCodexOwner(options)).rejects.toThrow('provenance')
})

test('foreign full-project marker refuses before launch', async () => {
  const options = fixture()
  await expect(openDurableCodexOwner({ ...options, projectId: 'project-two' })).rejects.toThrow('another project')
})

test('changed launch credentials refuse before any attachment or launch', async () => {
  const options = fixture()
  writeFileSync(join(options.codexHome, '.neutron-owner-launch.json'), JSON.stringify({ scope: { ...options, credential: 'old' } }), { mode: 0o600 })
  writeFileSync(join(options.codexHome, '.neutron-owner-authority.json'), '{}', { mode: 0o600 })
  await expect(openDurableCodexOwner(options)).rejects.toThrow('credential or project changed')
})
