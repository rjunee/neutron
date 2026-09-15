import { expect, test } from 'bun:test'
import { projectAdmission, type AdmissionProject, type AdmissionSource } from './project-admission.ts'
import type { BuildRunInput } from '../build-run.ts'
const tip = 'a'.repeat(40), base = 'b'.repeat(40), prior = 'c'.repeat(40), recorded = 'd'.repeat(40)
const input = { run_id: 'run' } as BuildRunInput
const result = (stdout = '', exit_code = 0, timed_out = false) => ({ ok: exit_code === 0, exit_code, stdout, stderr: '', timed_out })
function fixture() {
  const project: AdmissionProject = { runId: 'run', repo: 'repo', branch: 'change', baseBranch: 'main', prior: null }
  const calls: string[][] = []
  const source: AdmissionSource = {
    observe: async () => project,
    run: async argv => {
      calls.push(argv)
      if (argv.includes('--is-shallow-repository')) return result('false')
      if (argv.includes('rev-parse')) return result(argv.some(a => a.includes('refs/heads/change')) ? tip : base)
      return result()
    },
  }
  const override = (token: string, answers: ReturnType<typeof result>[]) => {
    const run = source.run
    source.run = (argv, cwd) => argv.includes(token) ? Promise.resolve(answers.length > 1 ? answers.shift()! : answers[0]!) : run(argv, cwd)
  }
  const check = () => projectAdmission(source, input)
  return { source, project, calls, override, check }
}
test('admission admits a fresh absent or contained branch and refreshes the configured base', async () => {
  const f = fixture()
  expect(await f.check()).toEqual({ kind: 'allow' })
  expect(f.calls).toContainEqual(['git', '-C', 'repo', 'fetch', '--no-tags', '--no-recurse-submodules', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  expect(f.calls).toContainEqual(['git', '-C', 'repo', 'merge-base', '--is-ancestor', tip, base])
  f.override('show-ref', [result('', 1)])
  expect(await f.check()).toEqual({ kind: 'allow' })
})
test('admission missing facts refuse individually', async () => {
  expect(await projectAdmission(undefined, input)).toMatchObject({ kind: 'unknown' })
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.source.observe = async () => null },
    (f: ReturnType<typeof fixture>) => { f.project.runId = 'other' },
    (f: ReturnType<typeof fixture>) => { f.project.repo = '' },
    (f: ReturnType<typeof fixture>) => { f.project.branch = '' },
    ...['check-ref-format', 'fetch', 'show-ref', 'rev-parse'].map(token => (f: ReturnType<typeof fixture>) => f.override(token, [result('', 128)])),
    (f: ReturnType<typeof fixture>) => f.override('show-ref', [result('', 1, true)]),
    (f: ReturnType<typeof fixture>) => f.override('rev-parse', [result('short')]),
    (f: ReturnType<typeof fixture>) => f.override('rev-parse', [result(base), result('short')]),
    (f: ReturnType<typeof fixture>) => { f.source.observe = async () => { throw Error('offline') } },
  ]) {
    const f = fixture(); change(f)
    expect(await f.check()).toMatchObject({ kind: 'unknown' })
  }
})
test('admission negative ancestry requires repeated negatives bracketed by complete history', async () => {
  for (const [probes, depths, kind] of [
    [[result('', 1, true)], [result('false')], 'unknown'],
    [[result('', 1), result('', 1, true)], [result('false')], 'unknown'],
    [[result('', 128)], [result('false')], 'unknown'],
    [[result('', 1)], [result('true')], 'unknown'],
    [[result('', 1)], [result('', 128)], 'unknown'],
    [[result('', 1)], [result('invalid')], 'unknown'],
    [[result('', 1), result('', 128)], [result('false')], 'unknown'],
    [[result('', 1)], [result('false'), result('true')], 'unknown'],
    [[result('', 1)], [result('false'), result('', 128)], 'unknown'],
    [[result('', 1), result()], [result('false')], 'allow'],
    [[result('', 1)], [result('false')], 'blocked'],
  ] as const) {
    const f = fixture()
    f.override('merge-base', [...probes]); f.override('--is-shallow-repository', [...depths])
    expect(await f.check()).toMatchObject({ kind })
  }
})
test('admission prior run exception measures base descent and readable recorded ownership', async () => {
  for (const [priorAnswers, headAnswers, kind] of [
    [[result()], [result()], 'allow'],
    [[result('', 128)], [result()], 'unknown'],
    [[result('', 1)], [result()], 'blocked'],
    [[result()], [result('', 128)], 'unknown'],
    [[result()], [result('', 1)], 'blocked'],
  ] as const) {
    const f = fixture(); f.project.prior = { base: prior, head: recorded }
    const run = f.source.run
    f.source.run = (argv, cwd) => {
      if (argv.includes('merge-base')) return Promise.resolve(argv.at(-2) === tip ? result('', 1) : argv.at(-2) === prior ? priorAnswers[0]! : headAnswers[0]!)
      return run(argv, cwd)
    }
    expect(await f.check()).toMatchObject({ kind })
  }
  for (const pins of [{ base: 'short', head: null }, { base: prior, head: 'short' }]) {
    const f = fixture(); f.project.prior = pins; f.override('merge-base', [result('', 1)])
    expect(await f.check()).toMatchObject({ kind: 'unknown' })
  }
  for (const head of [null, recorded]) {
    const f = fixture(); f.project.prior = { base: prior, head }
    f.override('merge-base', [result('', 1), result('', 1), result()])
    f.override('cat-file', [result('', 128)])
    expect(await f.check()).toEqual({ kind: 'allow' })
  }
})

test('real git shallow ancestry remains unknown until history is complete', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { spawnSync } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'admission-git-'))
  const git = (...argv: string[]) => {
    const res = spawnSync('git', argv, { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
    if (res.status !== 0) throw Error(res.stderr)
    return res.stdout.trim()
  }
  try {
    const origin = join(dir, 'origin'), repo = join(dir, 'clone')
    git('init', '-b', 'main', origin)
    for (const message of ['first', 'second']) git('-C', origin, '-c', 'user.name=Test', '-c', 'user.email=fixture', 'commit', '--allow-empty', '-m', message)
    git('-C', origin, 'branch', 'change', 'HEAD~1')
    git('clone', '--depth=1', '--no-single-branch', pathToFileURL(origin).href, repo)
    git('-C', repo, 'branch', 'change', 'origin/change')
    const source: AdmissionSource = {
      observe: async () => ({ runId: 'run', repo, branch: 'change', baseBranch: 'main', prior: null }),
      run: async argv => {
        const res = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
        return { ok: res.status === 0, exit_code: res.status ?? 128, stdout: res.stdout, stderr: res.stderr }
      },
    }
    expect(await projectAdmission(source, input)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('shallow') })
    git('-C', repo, 'fetch', '--unshallow', 'origin')
    expect(await projectAdmission(source, input)).toEqual({ kind: 'allow' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
