import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { spawnCapture, type EnvCapableHostRunner } from './git-mode.ts'
import { BUILDER_COMMIT_RECOVERY, recoverBuilderCommit, recoveredBuildArtifact } from './recover-builder-commit.ts'
import { sessionTrailerReadiness } from './gates/release-readiness.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function git(repo: string, ...args: string[]) {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(result.stderr)
  return result.stdout.trim()
}
async function fixture(message = 'work\n\nClaude-Session: fixture\nCo-Authored-By: Fixture <fixture@example.invalid>\n') {
  const repo = await mkdtemp(join(tmpdir(), 'recover-builder-'))
  roots.push(repo)
  await git(repo, 'init', '-q', '-b', 'build')
  await git(repo, 'config', 'user.name', 'Fixture')
  await git(repo, 'config', 'user.email', 'fixture@example.invalid')
  await git(repo, 'config', 'commit.gpgsign', 'false')
  await git(repo, 'commit', '--allow-empty', '-m', 'base')
  const before = await git(repo, 'rev-parse', 'HEAD')
  await writeFile(join(repo, 'work'), 'built\n')
  await git(repo, 'add', 'work')
  await git(repo, 'commit', '-m', message)
  const head = await git(repo, 'rev-parse', 'HEAD')
  const request = { run_id: 'run', step_id: 'run:build:0', role: 'build', writable: true, cwd: repo,
    result: { path: join(repo, 'build.result'), schema: 'project-build' } } as BoundedWorkRequest
  const result = { head, diff: 'content', pr: null, payload: { branch: 'build', commitSha: head, mutationClaim: { preserved: true } } }
  const text = JSON.stringify({ run_id: request.run_id, step_id: request.step_id, schema: request.result.schema, kind: 'completed', result })
  await writeFile(request.result.path, text)
  const events: { stage: string; meta: string | null }[] = []
  const input = { runHost: spawnCapture as EnvCapableHostRunner, repo, branch: 'build', request, before, result,
    measured: { head, diff: 'content', pr: null }, events,
    record: async (meta: string) => { events.push({ stage: BUILDER_COMMIT_RECOVERY, meta }) } }
  return { repo, before, head, text, input, events, request, result }
}

test('exact direct builder commit recovers while raw headers, content and original artifact survive', async () => {
  const f = await fixture()
  const raw = await git(f.repo, 'cat-file', 'commit', f.head)
  expect(await sessionTrailerReadiness(spawnCapture, f.repo, f.before, f.head)).toMatchObject({ kind: 'blocked' })
  const recovered = await recoverBuilderCommit(f.input)
  expect(recovered).toMatchObject({ kind: 'known', recovered: true })
  if (recovered.kind !== 'known') throw new Error('recovery failed')
  expect(recovered.head).not.toBe(f.head)
  expect(await git(f.repo, 'rev-parse', 'HEAD')).toBe(recovered.head)
  const clean = await git(f.repo, 'cat-file', 'commit', recovered.head)
  expect(clean.split('\n\n')[0]).toBe(raw.split('\n\n')[0])
  expect(clean).toContain('Co-Authored-By: Fixture')
  expect(clean).not.toContain('Claude-Session:')
  expect(await git(f.repo, 'cat-file', 'commit', f.head)).toBe(raw)
  expect(await readFile(f.request.result.path, 'utf8')).toBe(f.text)
  expect(await sessionTrailerReadiness(spawnCapture, f.repo, f.before, recovered.head)).toEqual({ kind: 'allow' })
  expect(JSON.parse(recoveredBuildArtifact(f.text, recovered.head, f.events)).result).toEqual({ ...f.result,
    head: recovered.head, payload: { ...f.result.payload, commitSha: recovered.head } })
})

test('clean completed commit is a no-op with no recovery receipt or object rewrite', async () => {
  const f = await fixture('work\n\nCo-Authored-By: Fixture <fixture@example.invalid>')
  expect(await recoverBuilderCommit(f.input)).toEqual({ kind: 'known', head: f.head })
  expect(f.events).toEqual([])
  expect(await git(f.repo, 'rev-parse', 'HEAD')).toBe(f.head)
  expect(recoveredBuildArtifact(f.text, f.head, [])).toBe(f.text)
})

test('durable intent recovers a lost CAS acknowledgement with no second worker or artifact rewrite', async () => {
  const f = await fixture()
  const real = f.input.runHost
  f.input.runHost = async (...args) => {
    const value = await real(...args)
    return args[0].some(arg => arg.endsWith('/swap-builder-commit.sh'))
      ? { ...value, ok: false, timed_out: true } : value
  }
  expect(await recoverBuilderCommit(f.input)).toMatchObject({ kind: 'unknown' })
  const after = await git(f.repo, 'rev-parse', 'HEAD')
  expect(after).not.toBe(f.head)
  f.input.runHost = real
  f.input.measured.head = after
  expect(await recoverBuilderCommit(f.input)).toEqual({ kind: 'known', head: after, recovered: true })
  expect(await readFile(f.request.result.path, 'utf8')).toBe(f.text)
})

for (const change of ['parent', 'payload', 'artifact', 'branch', 'readonly', 'signature', 'merge', 'unknown-header', 'raw-cut', 'candidate-cut', 'empty-message'] as const) {
  test(`uncertain or foreign provenance refuses without moving the branch: ${change}`, async () => {
    const f = await fixture(change === 'empty-message' ? 'Claude-Session: fixture' : undefined)
    if (change === 'parent') f.input.before = 'f'.repeat(40)
    if (change === 'payload') f.result.payload.commitSha = f.before
    if (change === 'artifact') await writeFile(f.request.result.path, f.text.replace('run:build:0', 'another-step'))
    if (change === 'branch') f.result.payload.branch = 'someone-else'
    if (change === 'readonly') f.input.request = { ...f.request, writable: false }
    if (['signature', 'merge', 'unknown-header'].includes(change)) {
      const raw = await git(f.repo, 'cat-file', 'commit', f.head)
      const header = change === 'signature' ? 'gpgsig fixture\n continuation' : change === 'merge' ? `parent ${f.before}` : 'unknown fixture'
      const path = join(f.repo, 'raw')
      await writeFile(path, raw.replace('\n\n', `\n${header}\n\n`) + '\n')
      const head = await git(f.repo, 'hash-object', '-w', '-t', 'commit', path)
      await git(f.repo, 'update-ref', 'refs/heads/build', head, f.head)
      f.input.result.head = head; f.input.result.payload.commitSha = head; f.input.measured.head = head
    }
    if (change === 'raw-cut' || change === 'candidate-cut') {
      let reads = 0
      f.input.runHost = async (...args) => {
        const value = await spawnCapture(...args)
        if (args[0][0] === 'bash' && args[0][3] === 'read-builder-object') {
          reads++
          if (reads === (change === 'raw-cut' ? 1 : 2)) {
            const path = args[0].at(-1)!
            const raw = await readFile(path)
            await writeFile(path, raw.subarray(0, raw.length - 1))
          }
        }
        return value
      }
    }
    const tip = await git(f.repo, 'rev-parse', 'HEAD')
    const answer = await recoverBuilderCommit(f.input)
    expect(['blocked', 'unknown']).toContain(answer.kind)
    expect(await git(f.repo, 'rev-parse', 'HEAD')).toBe(tip)
    expect(f.events).toEqual([])
  })
}

for (const movement of ['child', 'sibling', 'symref'] as const) test(`locked CAS preserves a concurrent ${movement}`, async () => {
  const f = await fixture()
  let foreign = ''
  f.input.runHost = async (...args) => {
    if (args[0].some(arg => arg.endsWith('/swap-builder-commit.sh'))) {
      const tree = await git(f.repo, 'rev-parse', `${f.head}^{tree}`)
      foreign = await git(f.repo, 'commit-tree', tree, '-p', movement === 'child' ? f.head : f.before, '-m', 'foreign')
      if (movement === 'symref') {
        await git(f.repo, 'update-ref', 'refs/heads/foreign', f.head)
        await git(f.repo, 'symbolic-ref', 'refs/heads/build', 'refs/heads/foreign')
      } else await git(f.repo, 'update-ref', 'refs/heads/build', foreign, f.head)
    }
    return spawnCapture(...args)
  }
  expect(await recoverBuilderCommit(f.input)).toMatchObject({ kind: 'unknown' })
  expect(await git(f.repo, 'rev-parse', 'refs/heads/build')).toBe(movement === 'symref' ? f.head : foreign)
  if (movement === 'symref') {
    expect(await git(f.repo, 'symbolic-ref', 'refs/heads/build')).toBe('refs/heads/foreign')
    expect(await git(f.repo, 'rev-parse', 'refs/heads/foreign')).toBe(f.head)
  }
})

test('artifact projection refuses changed bytes, step, payload SHA or a different target with a positive receipt control', async () => {
  const f = await fixture()
  const recovered = await recoverBuilderCommit(f.input)
  if (recovered.kind !== 'known') throw new Error('control did not recover')
  expect(JSON.parse(recoveredBuildArtifact(f.text, recovered.head, f.events)).result.head).toBe(recovered.head)
  for (const text of [f.text + ' ', f.text.replace('run:build:0', 'wrong-step'), f.text.replace('"commitSha":"' + f.head, '"commitSha":"' + f.before)]) {
    expect(() => recoveredBuildArtifact(text, recovered.head, f.events)).toThrow()
  }
  expect(() => recoveredBuildArtifact(f.text, f.before, f.events)).toThrow()
  expect(() => recoveredBuildArtifact(f.text, recovered.head, [])).toThrow()
  // Relabelling BOTH commit fields must not bypass the immutable receipt just
  // because the forged envelope now happens to match the completed checkpoint.
  const relabelled = JSON.parse(f.text)
  relabelled.result.head = recovered.head
  relabelled.result.payload.commitSha = recovered.head
  expect(() => recoveredBuildArtifact(JSON.stringify(relabelled), recovered.head, f.events)).toThrow()
})

for (const finalLine of ['attribution', 'trailer'] as const) test(`raw recovery preserves non-UTF-8 bytes and a missing final newline (${finalLine})`, async () => {
  const f = await fixture()
  const original = await git(f.repo, 'cat-file', 'commit', f.head)
  const raw = Buffer.concat([Buffer.from(original.split('\n\n')[0] + '\nencoding ISO-8859-1\n\nwork '),
    Buffer.from([0xe9]), Buffer.from(finalLine === 'attribution'
      ? '\ncLaUdE-sEsSiOn: fixture\nCo-Authored-By: fixture'
      : '\nCo-Authored-By: fixture\ncLaUdE-sEsSiOn: fixture')])
  const path = join(f.repo, 'raw')
  await writeFile(path, raw)
  const from = await git(f.repo, 'hash-object', '-w', '-t', 'commit', path)
  await git(f.repo, 'update-ref', 'refs/heads/build', from, f.head)
  f.result.head = from; f.result.payload.commitSha = from; f.input.measured.head = from
  await writeFile(f.request.result.path, JSON.stringify({ ...JSON.parse(f.text), result: f.result }))
  const answer = await recoverBuilderCommit(f.input)
  expect(answer).toMatchObject({ kind: 'known', recovered: true })
  if (answer.kind !== 'known') throw Error('recovery failed')
  const read = await spawnCapture(['bash', '-c', 'git -C "$1" cat-file commit "$2" > "$3"', 'read', f.repo, answer.head, path], f.repo)
  expect(read.ok).toBe(true)
  expect(await readFile(path)).toEqual(Buffer.from(raw.toString('latin1')
    .replace('cLaUdE-sEsSiOn: fixture' + (finalLine === 'attribution' ? '\n' : ''), ''), 'latin1'))
})

test('replacement refs cannot hide a carrier or substitute its raw identity', async () => {
  const f = await fixture()
  const clean = await git(f.repo, 'commit-tree', `${f.head}^{tree}`, '-p', f.before, '-m', 'replacement')
  await git(f.repo, 'replace', f.head, clean)
  expect(await git(f.repo, 'cat-file', 'commit', f.head)).not.toContain('Claude-Session:')
  const answer = await recoverBuilderCommit(f.input)
  expect(answer).toMatchObject({ kind: 'known', recovered: true })
  if (answer.kind !== 'known') throw Error('recovery failed')
  expect(await git(f.repo, 'cat-file', 'commit', answer.head)).toContain('Co-Authored-By: Fixture')
  expect(await git(f.repo, 'rev-parse', `refs/replace/${f.head}`)).toBe(clean)
})
