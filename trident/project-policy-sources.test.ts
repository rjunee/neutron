import { afterEach, expect, test, spyOn } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { TridentRunStore } from './store.ts'
import { withProjectPublication } from './project-publication-source.ts'
import * as leakPreflight from './leak-preflight.ts'
import { runProjectLeakSource } from './project-leak-source.ts'
import { withProjectPolicyDirectory } from './project-policy-resources.ts'
import type { EnvCapableHostRunner } from './git-mode.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'policy-test-')); roots.push(path); return path }
function fixture() {
  const row = { id: 'run', project_slug: 'project', repo_path: 'repo', branch: 'change', worktree: 'work',
    phase: 'building', task: 'Implement the request\nWith details', slug: 'request', base_sha: 'a'.repeat(40) }
  const identity = { store: { get: () => row } as unknown as TridentRunStore, runId: row.id,
    projectSlug: row.project_slug, repo: row.repo_path, branch: row.branch, worktree: row.worktree }
  return { row, identity }
}

test('publication reads the host row and writes a private body before calling publication', async () => {
  const { identity } = fixture()
  let bodyPath = ''
  const result = await withProjectPublication(identity, await root(), async publication => {
    bodyPath = publication.bodyFile
    expect(publication.title).toBe('Implement the request')
    expect(await readFile(bodyPath, 'utf8')).toContain('With details')
    expect(await readFile(bodyPath, 'utf8')).toContain('Launch base: ' + 'a'.repeat(40))
    expect((await stat(bodyPath)).mode & 0o777).toBe(0o600)
    return 'published'
  })
  expect(result).toEqual({ kind: 'known', value: 'published' })
  expect(await Bun.file(bodyPath).exists()).toBe(false)
})

test('publication refuses changed identity and missing task or base before calling publication', async () => {
  for (const patch of [{ id: 'other' }, { project_slug: 'other' }, { task: '' }, { base_sha: '' }, { slug: '' }, { phase: 'done' }]) {
    const { row, identity } = fixture()
    Object.assign(row, patch)
    let calls = 0
    const result = await withProjectPublication(identity, await root(), async () => ++calls)
    expect(result.kind).toBe('unknown')
    expect(calls).toBe(0)
  }
})

test('source cleanup survives a failed publication and allocation errors stay unknown', async () => {
  const { identity } = fixture()
  const directory = await root()
  expect((await withProjectPublication(identity, directory, async () => { throw new Error('write failed') })).kind).toBe('unknown')
  expect(await readdir(directory)).toEqual([])
  const file = join(directory, 'file')
  await writeFile(file, 'occupied')
  expect((await withProjectPublication(identity, file, async () => 'wrong')).kind).toBe('unknown')
})

test('resource scope isolates concurrent calls and reaps a dead host while retaining a live host', async () => {
  const directory = await root()
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  expect(child.status).toBe(0)
  const dead = `policy-${child.pid}-abandoned`
  const live = `policy-${process.pid}-retained`
  await mkdir(join(directory, dead))
  await writeFile(join(directory, dead, 'materialised'), 'bytes')
  await mkdir(join(directory, live))
  await withProjectPolicyDirectory(directory, async first => {
    await withProjectPolicyDirectory(directory, async second => {
      expect(first).not.toBe(second)
      expect((await readdir(directory)).includes(dead)).toBe(false)
      expect((await readdir(directory)).includes(live)).toBe(true)
    })
    expect((await readdir(directory)).includes(first.split('/').at(-1)!)).toBe(true)
  })
  expect(await readdir(directory)).toEqual([live])
})

for (const [output, code, expected] of [
  ['LEAK GATE: SILENT', 0, 'allow'], ['', 0, 'unknown'],
  ['LEAK GATE: INCOMPLETE', 3, 'unknown'],
  ['LEAK GATE: FAIL\n  [rule] file.ts:1:omitted', 1, 'blocked'],
] as const) {
  test(`leak source classifies ${expected} from exit ${code} and ${JSON.stringify(output)}`, async () => {
    const directory = await root()
    const scans: string[] = []
    const run_host: EnvCapableHostRunner = async argv => {
      if (argv.includes('add')) {
        const path = argv.at(-2)!
        scans.push(path)
        await mkdir(path)
        await writeFile(join(path, 'materialised'), 'bytes')
      }
      const scanner = argv.includes('bash')
      return { ok: scanner ? code === 0 : true, exit_code: scanner ? code : 0,
        stdout: scanner ? output : '', stderr: '', timed_out: false }
    }
    const result = await runProjectLeakSource({ run_host, repo_path: 'repo', branch: 'change', head: 'b'.repeat(40), base_sha: 'a'.repeat(40) }, directory)
    expect(result.kind).toBe(expected)
    expect(scans).toHaveLength(1)
    expect(await readdir(directory)).toEqual([])
  })
}

test('leak source refuses a missing project scanner', async () => {
  const run_host: EnvCapableHostRunner = async () => ({ ok: false, exit_code: 1, stdout: '', stderr: '', timed_out: false })
  expect((await runProjectLeakSource({ run_host, repo_path: 'repo', branch: 'change', head: 'b'.repeat(40), base_sha: 'a'.repeat(40) }, await root())).kind).toBe('unknown')
})


test('missing installation scanner is unknown even when the project scan would be clean', async () => {
  const scanner = spyOn(leakPreflight, 'ownLeakGateScript').mockReturnValue(null)
  try {
    const run_host: EnvCapableHostRunner = async () => ({ ok: true, exit_code: 0, stdout: 'LEAK GATE: SILENT', stderr: '', timed_out: false })
    expect((await runProjectLeakSource({ run_host, repo_path: 'repo', branch: 'change', head: 'b'.repeat(40), base_sha: 'a'.repeat(40) }, await root())).kind).toBe('unknown')
  } finally { scanner.mockRestore() }
})

test('unreadable process ownership cannot reap existing materialisations', async () => {
  const directory = await root()
  const retained = join(directory, `policy-${process.pid}-retained`)
  await mkdir(retained)
  await writeFile(join(retained, 'materialised'), 'bytes')
  const probe = spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('unreadable'), { code: 'EPERM' }) })
  try {
    let called = false
    await expect(withProjectPolicyDirectory(directory, async () => { called = true })).rejects.toThrow('unreadable')
    expect(called).toBe(false)
    expect(await readFile(join(retained, 'materialised'), 'utf8')).toBe('bytes')
  } finally { probe.mockRestore() }
})


test('missing leak pins cannot use scanner defaults', async () => {
  const run_host: EnvCapableHostRunner = async () => ({ ok: true, exit_code: 0, stdout: 'LEAK GATE: SILENT', stderr: '', timed_out: false })
  for (const patch of [{ head: '' }, { base_sha: '' }, { branch: '' }, { repo_path: '' }]) {
    expect((await runProjectLeakSource({ run_host, repo_path: 'repo', branch: 'change', head: 'b'.repeat(40), base_sha: 'a'.repeat(40), ...patch }, await root())).kind).toBe('unknown')
  }
})


test('timeout or contradictory success cannot certify scanner output', async () => {
  for (const patch of [{ timed_out: true }, { ok: false }]) for (const stage of ['bash', 'add']) {
    const run_host: EnvCapableHostRunner = async argv => ({ ok: true, exit_code: 0,
      stdout: 'LEAK GATE: SILENT', stderr: '', timed_out: false, ...(argv.includes(stage) ? patch : {}) })
    expect((await runProjectLeakSource({ run_host, repo_path: 'repo', branch: 'change', head: 'b'.repeat(40), base_sha: 'a'.repeat(40) }, await root())).kind).toBe('unknown')
  }
})
