import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectAdmission } from './project-admission.ts'
import { buildRun, type BuildRunInput, type BuildRunDeps } from '../build-run.ts'
import { fakeRunner, type BoundedWorkOutcome } from '@neutronai/runtime/bounded-work.ts'
import { localMergeReadiness, type RunHostCommand } from '../merge.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const host: RunHostCommand = async (argv, cwd) => {
  const process = Bun.spawn(argv, { ...(cwd ? { cwd } : {}), stdout: 'pipe', stderr: 'pipe', env: {
    ...Bun.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test',
  } })
  const [stdout, stderr, exit_code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  return { ok: exit_code === 0, stdout, stderr, exit_code }
}
async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'local-gate-')); dirs.push(repo)
  const git = async (...args: string[]) => {
    const result = await host(['git', ...args], repo)
    if (!result.ok) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git('init', '-b', 'base')
  await writeFile(join(repo, 'code'), 'one\ntwo\nthree\n')
  await git('add', 'code'); await git('commit', '-m', 'base')
  const wt = join(repo, 'work')
  await git('worktree', 'add', '-b', 'change', wt)
  await writeFile(join(wt, 'code'), 'changed\ntwo\nthree\n')
  await git('-C', wt, 'commit', '-am', 'change')
  const head = await git('rev-parse', 'change')
  const check = (run = host, branch: string | null = 'change', worktree = wt, pin = head) => localMergeReadiness(run, repo, branch, 'base', worktree, pin)
  return { repo, wt, head, git, check }
}

test('G109 real local worktree and branch allow, landing retains the reviewed branch', async () => {
  const f = await fixture()
  expect(await f.check()).toEqual({ kind: 'allow' })
  const snapshot = { head: f.head, diff: await f.git('diff', 'base...change'), pr: null }
  const completed: BoundedWorkOutcome = { kind: 'completed', result: snapshot,
    usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null }
  const runner = fakeRunner('pi', { outcomes: new Map(['run:plan:0', 'run:build:0', 'run:review:1'].map(step => [step, completed])) })
  const request = { model_id: 'test', effort: null, cwd: f.wt, writable: true, network: false,
    tools: 'edit-and-run', brief: { path: 'brief', integrity: 'test' }, result: { path: 'result', schema: 'test' }, thread: null, budget: { wall_ms: 1000 } } as const
  const worker = { runner, request }
  const deps: BuildRunDeps = {
    prepareWork: async () => {}, admissionGate: async () => f.check(),
    measure: async () => ({ kind: 'known', value: { ...snapshot, head: await f.git('rev-parse', 'change'), diff: await f.git('diff', 'base...change') } }),
    runLeakGatePreflight: async () => ({ status: 'clean', head: f.head, findings: [], skipped_rules: [], attempts: 0, note: '' }),
    assessMergeDiff: () => ({ allow: true, measured_bytes: snapshot.diff.length }),
    reviewReadiness: async () => ({ kind: 'allow' }),
    reviewGate: async () => ({ kind: 'approve' }), publishGate: async () => f.check(), mergeGate: async () => f.check(),
    publish: async () => { throw new Error('local mode must not publish') },
    merge: async () => { await f.git('merge', '--no-ff', f.head, '-m', 'land reviewed head') },
    confirmLocalMerge: async () => {
      const result = await host(['git', 'merge-base', '--is-ancestor', f.head, 'base'], f.repo)
      return result.ok ? { kind: 'allow' } : { kind: 'blocked', on: 'not landed' }
    },
  }
  expect(await buildRun({ run_id: 'run', mode: 'pr', merge_mode: 'local', start: 'fresh', repl_provider: 'pi',
    workers: { plan: worker, build: worker, review: worker, fix: worker } }, deps, new AbortController().signal)).toMatchObject({ kind: 'merged', snapshot: { pr: null, diff: '' } })
  expect(await f.git('rev-parse', 'change')).toBe(f.head)
  expect(await f.git('merge-base', '--is-ancestor', f.head, 'base')).toBe('')
})

test('G109 branch, isolation, repository identity, dirt and head gates refuse', async () => {
  const f = await fixture()
  expect(await f.check(host, null)).toMatchObject({ kind: 'blocked' })
  expect(await f.check(host, 'base')).toMatchObject({ kind: 'blocked' })
  expect(await f.check(host, 'change', f.repo)).toMatchObject({ kind: 'blocked' })
  expect(await f.check(async (argv, cwd) => argv.includes('--show-toplevel') ? { ok: true, stdout: f.repo, stderr: '', exit_code: 0 } : host(argv, cwd))).toMatchObject({ kind: 'blocked' })
  const other = await fixture()
  expect(await f.check(host, 'change', other.wt)).toMatchObject({ kind: 'blocked' })
  expect(await f.check(host, 'change', f.wt, 'b'.repeat(40))).toMatchObject({ kind: 'blocked' })
  await writeFile(join(f.wt, 'untracked'), 'keep this')
  expect(await f.check()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('cannot be safely reused') })
})

test('G109 actual overlapping base drift blocks; unavailable observations remain unknown', async () => {
  const f = await fixture()
  await writeFile(join(f.repo, 'code'), 'one\ntwo\nbase changed\n')
  await f.git('commit', '-am', 'base moved')
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: 'Local base drift overlaps reviewed changes' })
  const unavailable: RunHostCommand = async () => ({ ok: false, stdout: '', stderr: 'unavailable', exit_code: 128 })
  expect(await f.check(async () => { throw new Error('offline') })).toMatchObject({ kind: 'unknown' })
  expect(await f.check(unavailable)).toMatchObject({ kind: 'unknown' })
  expect(await f.check(async (argv, cwd) => argv.includes('--git-common-dir') ? unavailable(argv, cwd) : host(argv, cwd))).toMatchObject({ kind: 'unknown' })
  expect(await f.check(async (argv, cwd) => argv.includes('merge-base') ? unavailable(argv, cwd) : host(argv, cwd))).toMatchObject({ kind: 'unknown', detail: 'Local base drift could not be assessed' })
})


test('local admission preserves branch ownership without a remote', async () => {
  const f = await fixture()
  // One query includes the known core key as a positive control for remote absence.
  expect(await f.git('config', '--local', '--get-regexp', '^(remote[.]|core[.]repositoryformatversion$)')).toBe('core.repositoryformatversion 0')
  const project = { runId: 'run', repo: f.repo, branch: 'change', baseBranch: 'base',
    prior: null as { base: string; head: string | null } | null }
  const input = { run_id: 'run', merge_mode: 'local' } as BuildRunInput
  const source = { observe: async () => project, run: host }
  expect(await projectAdmission(source, input)).toMatchObject({ kind: 'blocked', on: 'Project branch is not contained in the base and has no prior run ownership' })
  project.prior = { base: await f.git('rev-parse', 'base'), head: f.head }
  expect(await projectAdmission(source, input)).toEqual({ kind: 'allow' })
})
