import { expect, test } from 'bun:test'
import { mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publicationReadiness } from './release-readiness.ts'
import type { RunHostCommand } from '../merge.ts'
import type { BuildSnapshot } from '../build-run.ts'

/**
 * #1133 (G166): publication refuses a branch that carries a `Claude-Session:` trailer on any
 * commit above the launch base. Real git throughout — the scan reads raw commit objects, so a
 * fake that answers strings would only prove the fake. Each scratch repo has a bare `origin`
 * (so `ls-remote` answers and the first-push ancestry arm runs, which is where the scan sits
 * after) and a base commit whose sha is the pinned launch base.
 */

const run: RunHostCommand = async argv => {
  const result = Bun.spawnSync(argv, {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  return { ok: result.exitCode === 0, exit_code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await run(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** A repo on branch `change` with one base commit (returned as `launchBase`) and a bare origin. */
async function scratch(): Promise<{ dir: string; repo: string; launchBase: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'release-readiness-'))
  const repo = join(dir, 'repo')
  await run(['git', 'init', '-q', '-b', 'main', repo], dir)
  await git(repo, 'config', 'user.name', 'Fixture')
  await git(repo, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'f'), 'base\n')
  await git(repo, 'add', 'f')
  await git(repo, 'commit', '-q', '-m', 'base')
  const launchBase = await git(repo, 'rev-parse', 'HEAD')
  await run(['git', 'init', '-q', '--bare', join(dir, 'origin.git')], dir)
  await git(repo, 'remote', 'add', 'origin', join(dir, 'origin.git'))
  await git(repo, 'checkout', '-q', '-b', 'change')
  return { dir, repo, launchBase }
}

/** One more commit on the current branch with the given `-m` paragraphs; returns its sha. */
async function commit(repo: string, ...paragraphs: string[]): Promise<string> {
  await appendFile(join(repo, 'f'), `${paragraphs[0]}\n`)
  await git(repo, 'add', 'f')
  await git(repo, 'commit', '-q', ...paragraphs.flatMap(paragraph => ['-m', paragraph]))
  return git(repo, 'rev-parse', 'HEAD')
}

async function readiness(repo: string, launchBase: string, host: RunHostCommand = run) {
  const snapshot: BuildSnapshot = { head: await git(repo, 'rev-parse', 'HEAD'), diff: '', pr: null }
  return publicationReadiness(host, repo, 'change', launchBase, snapshot, 'run')
}

const carrierText = (shas: string[]) =>
  `Publication branch carries a Claude-Session trailer on ${shas.length} commit(s) above the launch base: ${shas.join(', ')}`

test('#1133 G166: positive control — a clean commit with only Co-Authored-By publishes', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    await commit(repo, 'feat: subject', 'Co-Authored-By: Fixture <fixture@example.invalid>')
    expect(await readiness(repo, launchBase)).toEqual({ kind: 'allow' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('#1133 G166: one commit carrying the trailer is refused, named, and left untouched', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const sha = await commit(repo, 'feat: subject', 'Claude-Session: https://claude.ai/code/session_01TEST')
    expect(await readiness(repo, launchBase)).toEqual({ kind: 'blocked', on: carrierText([sha]) })
    expect(await git(repo, 'rev-parse', 'refs/heads/change')).toBe(sha)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('#1133 G166: the match is ASCII case-insensitive and line-anchored', async () => {
  for (const [paragraph, kind] of [
    ['claude-session: lower', 'blocked'],
    ['CLAUDE-SESSION: upper', 'blocked'],
    ['see Claude-Session: notes mid-line', 'allow'],
  ] as const) {
    const { dir, repo, launchBase } = await scratch()
    try {
      const sha = await commit(repo, 'feat: subject', paragraph)
      expect(await readiness(repo, launchBase)).toEqual(kind === 'allow' ? { kind } : { kind, on: carrierText([sha]) })
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})

test('#1133 G166: every carrier is named in rev-list order and a clean commit between them is not', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const oldest = await commit(repo, 'feat: one', 'Claude-Session: https://claude.ai/code/session_01A')
    const clean = await commit(repo, 'feat: two', 'Co-Authored-By: Fixture <fixture@example.invalid>')
    const newest = await commit(repo, 'feat: three', 'Claude-Session: https://claude.ai/code/session_01B')
    const result = await readiness(repo, launchBase)
    expect(result).toEqual({ kind: 'blocked', on: carrierText([newest, oldest]) })
    expect((result as { on: string }).on).not.toContain(clean)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('#1133 G166: a trailer below the launch base is not this publication\'s to refuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-readiness-'))
  const repo = join(dir, 'repo')
  try {
    await run(['git', 'init', '-q', '-b', 'main', repo], dir)
    await git(repo, 'config', 'user.name', 'Fixture')
    await git(repo, 'config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(repo, 'f'), 'base\n')
    await git(repo, 'add', 'f')
    await git(repo, 'commit', '-q', '-m', 'base')
    const launchBase = await commit(repo, 'history: already on main', 'Claude-Session: https://claude.ai/code/session_01OLD')
    await run(['git', 'init', '-q', '--bare', join(dir, 'origin.git')], dir)
    await git(repo, 'remote', 'add', 'origin', join(dir, 'origin.git'))
    await git(repo, 'checkout', '-q', '-b', 'change')
    await commit(repo, 'feat: subject', 'Co-Authored-By: Fixture <fixture@example.invalid>')
    expect(await readiness(repo, launchBase)).toEqual({ kind: 'allow' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('#1133 G166: a range that cannot be listed is unknown, and a short base asks git nothing', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    await commit(repo, 'feat: subject', 'Co-Authored-By: Fixture <fixture@example.invalid>')
    // With the remote branch present the first-push ancestry arm is skipped, so the scan is the
    // only measurement of the base: a well-formed sha that is no object cannot be listed.
    await git(repo, 'push', '-q', 'origin', 'change')
    expect(await readiness(repo, 'b'.repeat(40))).toEqual({ kind: 'unknown', detail: 'Publication commit range could not be listed' })
    const argvs: string[][] = []
    const counting: RunHostCommand = async (argv, cwd) => { argvs.push(argv); return run(argv, cwd) }
    expect(await readiness(repo, 'short', counting)).toEqual({ kind: 'unknown', detail: 'Publication launch base is not a full OID' })
    expect(argvs.some(argv => argv.includes('rev-list') || argv.includes('cat-file'))).toBe(false)
    expect(launchBase).toMatch(/^[0-9a-f]{40}$/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('#1133 G166: a commit that cannot be read is unknown, naming the sha', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const sha = await commit(repo, 'feat: subject', 'Co-Authored-By: Fixture <fixture@example.invalid>')
    const unreadable: RunHostCommand = async (argv, cwd) => argv.includes('cat-file')
      ? { ok: false, exit_code: 128, stdout: '', stderr: '' }
      : run(argv, cwd)
    expect(await readiness(repo, launchBase, unreadable)).toEqual({ kind: 'unknown', detail: `Publication commit ${sha} could not be read` })
    expect(await git(repo, 'rev-parse', 'refs/heads/change')).toBe(sha)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('#1133 G166: the scan is unconditional — a re-publication with the remote branch present is still refused', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const sha = await commit(repo, 'feat: subject', 'Claude-Session: https://claude.ai/code/session_01TEST')
    await git(repo, 'push', '-q', 'origin', 'change')
    expect((await git(repo, 'ls-remote', '--heads', 'origin', 'refs/heads/change')).startsWith(sha)).toBe(true)
    expect(await readiness(repo, launchBase)).toEqual({ kind: 'blocked', on: carrierText([sha]) })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('#1133 G166: a fake host — a raw object with the trailer is refused; a malformed listing is unknown', async () => {
  const head = 'a'.repeat(40)
  const carrier = 'c'.repeat(40)
  const snapshot: BuildSnapshot = { head, diff: '', pr: null }
  const fake = (listing: string): RunHostCommand => async argv => {
    if (argv.includes('rev-parse')) return { ok: true, exit_code: 0, stdout: `${head}\n`, stderr: '' }
    if (argv.includes('ls-remote')) return { ok: true, exit_code: 0, stdout: `${head}\trefs/heads/change\n`, stderr: '' }
    if (argv.includes('rev-list')) return { ok: true, exit_code: 0, stdout: listing, stderr: '' }
    if (argv.includes('cat-file')) {
      return { ok: true, exit_code: 0, stdout: 'tree t\nparent p\nauthor a <a@a> 1 +0000\ncommitter c <c@c> 1 +0000\n\nsubject\n\nClaude-Session: fake\n', stderr: '' }
    }
    throw new Error(`Unexpected command: ${argv.join(' ')}`)
  }
  expect(await publicationReadiness(fake(`${carrier}\n`), 'repo', 'change', 'b'.repeat(40), snapshot, 'run'))
    .toEqual({ kind: 'blocked', on: carrierText([carrier]) })
  expect(await publicationReadiness(fake('not-a-sha\n'), 'repo', 'change', 'b'.repeat(40), snapshot, 'run'))
    .toEqual({ kind: 'unknown', detail: 'Publication commit range listing is malformed' })
})
