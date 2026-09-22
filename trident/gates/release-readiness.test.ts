import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RAW_GRAPH_ENV, publicationReadiness, sessionTrailerReadiness } from './release-readiness.ts'
import type { RunHostCommand } from '../merge.ts'
import type { BuildSnapshot } from '../build-run.ts'
import { spawnCapture } from '../git-mode.ts'

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
async function scratch(objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<{ dir: string; repo: string; launchBase: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'release-readiness-'))
  const repo = join(dir, 'repo')
  await run(['git', 'init', '-q', `--object-format=${objectFormat}`, '-b', 'main', repo], dir)
  await git(repo, 'config', 'user.name', 'Fixture')
  await git(repo, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'f'), 'base\n')
  await git(repo, 'add', 'f')
  await git(repo, 'commit', '-q', '-m', 'base')
  const launchBase = await git(repo, 'rev-parse', 'HEAD')
  await run(['git', 'init', '-q', `--object-format=${objectFormat}`, '--bare', join(dir, 'origin.git')], dir)
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

/** The production shape: `makeCredentialedHostRunner` merges the per-command `extraEnv` over its
 * own, so the scan's graft override reaches git. A double that dropped the third parameter would
 * leave `$GIT_DIR/info/grafts` in force and the graft case below would go red.
 */
const productionRun: RunHostCommand = (argv, cwd, extraEnv) => spawnCapture(argv, cwd, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extraEnv,
})

/** The salvage path's host doubles (trident/stranded-salvage-realgit.test.ts,
 * gateway/composition/build-core-modules-trident-stranded-sweep.test.ts) admit only `git` and
 * `gh` argv and THROW on anything else. Round 19 listed the range as `env GIT_GRAFT_FILE=… git …`
 * and every salvage publish through those doubles died in that throw (7 reds, CI shards 2/4 and
 * 3/4). This double is that contract, so the scan cannot regress to a non-git argv again.
 */
const gitOnlyRun: RunHostCommand = async (argv, cwd, extraEnv) => {
  if (argv[0] !== 'git') throw new Error(`unexpected host command: ${argv.join(' ')}`)
  return productionRun(argv, cwd, extraEnv)
}

test('G166 raw graph: every command the scan issues is a `git` argv; the graft override is extraEnv, not an `env` prefix', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const carrier = await commit(repo, 'carrier', 'Claude-Session: fixture')
    const head = await commit(repo, 'clean tip')
    await git(repo, 'push', '-q', 'origin', 'change')
    // A git-only host answers the whole scan, including the ancestry and lease arms around it.
    expect(await readiness(repo, launchBase, gitOnlyRun)).toEqual({ kind: 'blocked', on: carrierText([carrier]) })
    expect(await sessionTrailerReadiness(gitOnlyRun, repo, launchBase, head)).toEqual({ kind: 'blocked', on: carrierText([carrier]) })
    // The graft override travels in the runner's third parameter, and only on the range listing.
    const seen: { argv: string[]; env: Record<string, string> | undefined }[] = []
    const recording: RunHostCommand = (argv, cwd, extraEnv) => { seen.push({ argv, env: extraEnv }); return gitOnlyRun(argv, cwd, extraEnv) }
    expect(await sessionTrailerReadiness(recording, repo, launchBase, head)).toEqual({ kind: 'blocked', on: carrierText([carrier]) })
    const listings = seen.filter(call => call.argv.includes('rev-list'))
    expect(listings).toHaveLength(1)
    expect(listings[0]!.env).toEqual({ GIT_GRAFT_FILE: '/dev/null' })
    expect(RAW_GRAPH_ENV).toEqual({ GIT_GRAFT_FILE: '/dev/null' })
    expect(listings[0]!.argv).toEqual(['git', '-C', repo, '--no-replace-objects', '--shallow-file', '/dev/null', '-c', 'core.commitGraph=false', '-c', 'advice.graftFileDeprecated=false', 'rev-list', '--end-of-options', `${launchBase}..${head}`])
    // Round 27 (carried round-26 finding): `.every()` over a FILTERED array passes vacuously on
    // an empty filter, so a scan that stopped issuing `cat-file` at all would still read green
    // here. Pin the count first — exactly as the sibling `toHaveLength(1)` pins the listings —
    // so the "no extraEnv on the object reads" claim is made about calls that demonstrably
    // happened: one `cat-file commit` and one `cat-file -s` for each of the two ranged commits.
    const objectReads = seen.filter(call => call.argv.includes('cat-file'))
    expect(objectReads).toHaveLength(4)
    expect(objectReads.every(call => call.env === undefined)).toBe(true)
    // Positive control for the "no env prefix" claim: the same double refuses a prefixed argv.
    await expect(gitOnlyRun(['env', 'GIT_GRAFT_FILE=/dev/null', 'git', '-C', repo, 'rev-list', '--end-of-options', `${launchBase}..${head}`], repo)).rejects.toThrow('unexpected host command: env')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('G166 raw graph: the range listing is silent on stderr — no graft-file deprecation hint', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const head = await commit(repo, 'clean tip')
    const stderr: string[] = []
    const capturing: RunHostCommand = async (argv, cwd, extraEnv) => {
      const result = await productionRun(argv, cwd, extraEnv)
      if (argv.includes('rev-list')) stderr.push(result.stderr)
      return result
    }
    expect(await sessionTrailerReadiness(capturing, repo, launchBase, head)).toEqual({ kind: 'allow' })
    expect(stderr).toEqual([''])
    // Positive control: the same listing WITHOUT the advice switch prints the hint, so silence is
    // the switch's doing and not an absence of the graft override.
    const noisy = await productionRun(['git', '-C', repo, '--no-replace-objects', '--shallow-file', '/dev/null', '-c', 'core.commitGraph=false', 'rev-list', '--end-of-options', `${launchBase}..${head}`], repo, RAW_GRAPH_ENV)
    expect(noisy.ok).toBe(true)
    expect(noisy.stderr).toContain('info/grafts is deprecated')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('G166 raw graph: the production runner allows a complete clean range even with a shallow view', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const head = await commit(repo, 'clean tip')
    expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'allow' })
    await git(repo, 'push', '-q', 'origin', 'change')
    await writeFile(join(repo, '.git', 'shallow'), `${head}\n`)
    expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'allow' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const view of ['message replacement', 'parent replacement', 'shallow boundary', 'graft'] as const) {
  test(`G166 raw graph: ${view} cannot conceal a carrier from the production runner`, async () => {
    const { dir, repo, launchBase } = await scratch()
    try {
      const carrier = await commit(repo, 'carrier', 'Claude-Session: fixture')
      const head = await commit(repo, 'clean tip')
      // Exercise the existing-remote arm too: ancestry is not an independent guard here.
      await git(repo, 'push', '-q', 'origin', 'change')
      expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'blocked', on: carrierText([carrier]) })
      const tree = await git(repo, 'rev-parse', `${head}^{tree}`)
      if (view.endsWith('replacement')) {
        const substitute = await git(repo, 'commit-tree', tree, '-p', launchBase, '-m', 'clean substitute')
        await git(repo, 'replace', view === 'message replacement' ? carrier : head, substitute)
      } else if (view === 'shallow boundary') {
        await writeFile(join(repo, '.git', 'shallow'), `${head}\n`)
      } else {
        await writeFile(join(repo, '.git', 'info', 'grafts'), `${head} ${launchBase}\n`)
      }
      expect(await git(repo, '--no-replace-objects', 'cat-file', 'commit', carrier)).toContain('\nClaude-Session:')
      expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'blocked', on: carrierText([carrier]) })
      expect(await sessionTrailerReadiness(productionRun, repo, launchBase, head)).toEqual({ kind: 'blocked', on: carrierText([carrier]) })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

test('G166 raw graph: a shallow range with a missing raw parent is unknown', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const carrier = await commit(repo, 'carrier', 'Claude-Session: fixture')
    const head = await commit(repo, 'clean tip')
    await git(repo, 'push', '-q', 'origin', 'change')
    await writeFile(join(repo, '.git', 'shallow'), `${head}\n`)
    await rm(join(repo, '.git', 'objects', carrier.slice(0, 2), carrier.slice(2)))
    expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'unknown', detail: 'Publication commit range could not be listed' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

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

/** A WHOLE raw commit object, the bytes `git cat-file commit` hands back: headers, the blank
 * line, then the message. Real git never truncates, so the only way to measure what the scan does
 * with a SHORT read is a host double that returns one — and a double must answer `cat-file -s`
 * with the FULL object's size, the way git would, because the scan cross-checks the two.
 */
const FULL_OBJECT = `tree ${'d'.repeat(40)}\nparent ${'e'.repeat(40)}\nauthor a <a@a> 1 +0000\ncommitter c <c@c> 1 +0000\n\nsubject\n\nClaude-Session: fake\n`
const FULL_SIZE = Buffer.byteLength(FULL_OBJECT, 'utf8')
const objectOid = (raw: string) => createHash('sha1').update(`commit ${Buffer.byteLength(raw)}\0${raw}`).digest('hex')
const fakeHead = objectOid(FULL_OBJECT)
const fakeBase = 'b'.repeat(40)
const fakeSnapshot: BuildSnapshot = { head: fakeHead, diff: '', pr: null }
const hostOk = (stdout: string) => ({ ok: true, exit_code: 0, stdout, stderr: '' })

/** `capture` is what `cat-file commit` hands back; `size` is what `cat-file -s` answers.
 * `-s` is matched BEFORE the generic `cat-file` branch: a double that conflated them would
 * answer the size query with the object's text and every case would come back unmeasured for
 * the wrong reason (the positive controls below would then fail too).
 */
const fakeHost = (
  capture: string,
  size: { ok: boolean; exit_code: number; stdout: string; stderr: string } = hostOk(String(FULL_SIZE)),
  listing = `${fakeHead}\n`,
): RunHostCommand => async argv => {
  if (argv.includes('rev-parse')) return hostOk(`${fakeHead}\n`)
  if (argv.includes('ls-remote')) return hostOk(`${fakeHead}\trefs/heads/change\n`)
  if (argv.includes('rev-list')) return hostOk(listing)
  if (argv.includes('cat-file') && argv.includes('-s')) return size
  if (argv.includes('cat-file')) return hostOk(capture)
  throw new Error(`Unexpected command: ${argv.join(' ')}`)
}
const fakeReadiness = (host: RunHostCommand) => publicationReadiness(host, 'repo', 'change', fakeBase, fakeSnapshot, 'run')

test('#1133 G166: a fake host — a raw object with the trailer is refused; a malformed listing is unknown', async () => {
  const carrier = fakeHead
  expect(await publicationReadiness(fakeHost(FULL_OBJECT, hostOk(String(FULL_SIZE)), `${carrier}\n`), 'repo', 'change', fakeBase, fakeSnapshot, 'run'))
    .toEqual({ kind: 'blocked', on: carrierText([carrier]) })
  expect(await publicationReadiness(fakeHost(FULL_OBJECT, hostOk(String(FULL_SIZE)), 'not-a-sha\n'), 'repo', 'change', fakeBase, fakeSnapshot, 'run'))
    .toEqual({ kind: 'unknown', detail: 'Publication commit range listing is malformed' })
})

/** #1133 round 22 (cross-model finding): the scan's fail-closed property must not rest on the
 * INJECTED runner. A successful `cat-file commit` whose output was cut short used to be read as
 * a measured message — and a cut at or before the header/message boundary was read as a measured
 * EMPTY message and ALLOWED, so an unmeasured carrier would have published. Every capture is now
 * weighed against the object's own `cat-file -s` size and only a gap the object's own
 * terminators explain is clean.
 */
for (const [why, capture, detail] of [
  ['cut mid-header', FULL_OBJECT.slice(0, 30), ', no header/message boundary'],
  ['cut at the header/message boundary', FULL_OBJECT.slice(0, FULL_OBJECT.indexOf('\n\n')), ', no header/message boundary'],
  ['cut one byte past the last header line', FULL_OBJECT.slice(0, FULL_OBJECT.indexOf('\n\n') + 1), ', no header/message boundary'],
  ['cut inside the message, losing the trailer line', FULL_OBJECT.slice(0, FULL_OBJECT.indexOf('Claude-Session')), ''],
] as const) {
  test(`#1133 G166: a truncated raw read is unknown, never allowed (${why})`, async () => {
    const captured = Buffer.byteLength(capture, 'utf8')
    expect(capture).not.toContain('Claude-Session')
    expect(captured).toBeLessThan(FULL_SIZE)
    expect(await fakeReadiness(fakeHost(capture))).toEqual({
      kind: 'unknown',
      detail: `Publication commit ${fakeHead} was read incompletely (${captured} of ${FULL_SIZE} bytes${detail})`,
    })
  })
}

test('#1133 G166: a capture longer than the object, or an unmeasurable size, is unknown', async () => {
  const captured = Buffer.byteLength(FULL_OBJECT, 'utf8')
  expect(await fakeReadiness(fakeHost(FULL_OBJECT, hostOk(String(FULL_SIZE - 1))))).toEqual({
    kind: 'unknown',
    detail: `Publication commit ${fakeHead} was read incompletely (${captured} of ${FULL_SIZE - 1} bytes: the read returned more bytes than the object holds)`,
  })
  for (const size of [
    { ok: false, exit_code: 128, stdout: '', stderr: 'no such object' },
    hostOk(''),
    hostOk('sixteen'),
    hostOk('0x10'),
    hostOk('-1'),
    hostOk('012'),
  ]) {
    expect(await fakeReadiness(fakeHost(FULL_OBJECT, size)))
      .toEqual({ kind: 'unknown', detail: `Publication commit ${fakeHead} size could not be measured` })
  }
})

test('#1133 G166: the completeness check does not over-reject — a whole object, and one short by its own terminating newline, are still scanned', async () => {
  // missing === 0: an untrimming runner delivered every byte.
  expect(await fakeReadiness(fakeHost(FULL_OBJECT))).toEqual({ kind: 'blocked', on: carrierText([fakeHead]) })
  // missing === 1: the message's single terminating newline. The trailer line still matches, so
  // the carrier is still NAMED — the gap is tolerated, not the trailer.
  const trimmed = FULL_OBJECT.slice(0, -1)
  expect(Buffer.byteLength(trimmed, 'utf8')).toBe(FULL_SIZE - 1)
  expect(await fakeReadiness(fakeHost(trimmed))).toEqual({ kind: 'blocked', on: carrierText([fakeHead]) })
  // And the same one-byte gap over a CLEAN message allows.
  const clean = FULL_OBJECT.replace('Claude-Session: fake', 'Co-Authored-By: a <a@a>')
  const cleanSize = Buffer.byteLength(clean, 'utf8')
  expect(await fakeReadiness(fakeHost(clean.slice(0, -1), hostOk(String(cleanSize)), `${objectOid(clean)}\n`))).toEqual({ kind: 'allow' })
})

/** The production path was never the hole, and the round-23 check must not make it one: real
 * git, the real trimming runner, the exact `--cleanup=verbatim` shape the nit describes.
 */
test('#1133 G166: real git — a verbatim message ending in the trailer colon is measured WHOLE and refused', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    await appendFile(join(repo, 'f'), 'verbatim\n')
    await git(repo, 'add', 'f')
    await writeFile(join(dir, 'msg'), 'feat: subject\n\nClaude-Session:')
    await git(repo, 'commit', '-q', '--cleanup=verbatim', '-F', join(dir, 'msg'))
    const sha = await git(repo, 'rev-parse', 'HEAD')
    const raw = (await run(['git', '-C', repo, 'cat-file', 'commit', sha], repo)).stdout
    expect(raw.endsWith('Claude-Session:')).toBe(true)
    // `spawnCapture` `.trim()`s, and a message ending in `:` has no trailing whitespace to lose,
    // so the capture is WHOLE (`missing === 0`) and the carrier is NAMED, never tolerated.
    const size = Number((await run(['git', '-C', repo, 'cat-file', '-s', sha], repo)).stdout.trim())
    const production = (await productionRun(['git', '-C', repo, 'cat-file', 'commit', sha], repo)).stdout
    expect(Buffer.byteLength(production, 'utf8')).toBe(size)
    expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'blocked', on: carrierText([sha]) })
    expect(await readiness(repo, launchBase)).toEqual({ kind: 'blocked', on: carrierText([sha]) })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('#1133 G166: a commit with an EMPTY message is measured clean through BOTH a trimming and an untrimming runner', async () => {
  // The wrapper honours `--allow-empty-message` and rebuilds such a commit empty; the publisher
  // must accept the same shape. Real git on both sides — the completeness cross-check added in
  // round 22 must not turn either runner's view of a legitimate empty message into a refusal.
  const { dir, repo, launchBase } = await scratch()
  try {
    await appendFile(join(repo, 'f'), 'empty\n')
    await git(repo, 'add', 'f')
    await git(repo, 'commit', '-q', '--allow-empty-message', '-m', '')
    const sha = await git(repo, 'rev-parse', 'HEAD')
    // The UNTRIMMED object ends at the header/message boundary itself (`\n\n`), and its byte
    // length is exactly what `cat-file -s` reports: a complete read with an empty message.
    const raw = (await run(['git', '-C', repo, 'cat-file', 'commit', sha], repo)).stdout
    const size = Number((await run(['git', '-C', repo, 'cat-file', '-s', sha], repo)).stdout.trim())
    expect(raw.endsWith('\n\n')).toBe(true)
    expect(Buffer.byteLength(raw, 'utf8')).toBe(size)
    expect(await readiness(repo, launchBase)).toEqual({ kind: 'allow' })
    // The PRODUCTION runner trims, so the same object arrives as its headers alone with no
    // separator left — exactly two bytes short. That is the one gap a headers-only capture may
    // have, and it is the shape the round-21 finding said must not be waved through blindly.
    const production = (await productionRun(['git', '-C', repo, 'cat-file', 'commit', sha], repo)).stdout
    expect(production).not.toContain('\n\n')
    expect(size - Buffer.byteLength(production, 'utf8')).toBe(2)
    expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'allow' })
    // And an empty-message commit BESIDE a carrier does not hide the carrier, either way.
    const carrier = await commit(repo, 'feat: subject', 'Claude-Session: https://claude.ai/code/session_01TEST')
    expect(await readiness(repo, launchBase)).toEqual({ kind: 'blocked', on: carrierText([carrier]) })
    expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'blocked', on: carrierText([carrier]) })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('#1133 G166: sessionTrailerReadiness is the shared scan — the salvage publisher gets the same three answers', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const clean = await commit(repo, 'feat: one', 'Co-Authored-By: Fixture <fixture@example.invalid>')
    expect(await sessionTrailerReadiness(run, repo, launchBase, clean)).toEqual({ kind: 'allow' })
    const carrier = await commit(repo, 'feat: two', 'Claude-Session: https://claude.ai/code/session_01TEST')
    expect(await sessionTrailerReadiness(run, repo, launchBase, carrier)).toEqual({ kind: 'blocked', on: carrierText([carrier]) })
    // The window is the caller's: measured up to `clean`, the later carrier is not in range.
    expect(await sessionTrailerReadiness(run, repo, launchBase, clean)).toEqual({ kind: 'allow' })
    expect(await sessionTrailerReadiness(run, repo, '', carrier)).toEqual({ kind: 'unknown', detail: 'Publication launch base is not a full OID' })
    const unreadable: RunHostCommand = async (argv, cwd) => argv.includes('cat-file')
      ? { ok: false, exit_code: 128, stdout: '', stderr: '' }
      : run(argv, cwd)
    expect(await sessionTrailerReadiness(unreadable, repo, launchBase, clean)).toEqual({ kind: 'unknown', detail: `Publication commit ${clean} could not be read` })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/** An authenticated capture retains the stronger carrier verdict when its final LF is trimmed. */
test('#1133 G166: a last line that already IS the trailer token is NAMED as a carrier, not demoted to an unmeasured gap', async () => {
  const headers = `tree ${'d'.repeat(40)}\nparent ${'e'.repeat(40)}\nauthor a <a@a> 1 +0000\ncommitter c <c@c> 1 +0000\n`
  const object = `${headers}\nsubject\n\nClaude-Session:\n`
  const size = Buffer.byteLength(object, 'utf8')
  const capture = object.slice(0, -1)
  expect(Buffer.byteLength(capture, 'utf8')).toBe(size - 1)
  expect(capture.slice(capture.lastIndexOf('\n') + 1)).toBe('Claude-Session:')
  expect(await fakeReadiness(fakeHost(capture, hostOk(String(size)), `${objectOid(object)}\n`))).toEqual({ kind: 'blocked', on: carrierText([objectOid(object)]) })
})

/** #1133 round 24 (round-23 review, MAJOR, two seats, each verified empirically).
 * `publicationReadiness` returned `sessionTrailerReadiness(...)` WITHOUT `await` as the last
 * statement of its `try`, so the promise adopted after the block exited and a rejection escaped
 * the `catch` instead of becoming `unknownCause(...)`. A throwing runner is a live contract on
 * this path (`gitOnlyRun` above, and the fake host's `Unexpected command`), and `publishGate`
 * (`build-host.ts`) has no try/catch upstream — so the gate's "every failure is a GateResult"
 * contract rested on nothing. The assertion is `resolves`: it is red when the promise rejects.
 */
test('#1133 G166: a host runner that THROWS inside the scan resolves to `unknown`, never a rejected promise', async () => {
  const throwing: RunHostCommand = async argv => {
    if (argv.includes('rev-parse')) return hostOk(`${fakeHead}\n`)
    if (argv.includes('ls-remote')) return hostOk(`${fakeHead}\trefs/heads/change\n`)
    throw new Error('simulated host failure inside the session-trailer scan')
  }
  await expect(fakeReadiness(throwing)).resolves.toMatchObject({
    kind: 'unknown',
    detail: expect.stringContaining('Publication host observation failed'),
  })
  const resolved = await fakeReadiness(throwing) as { kind: string; detail: string }
  expect(resolved.detail).toContain('simulated host failure inside the session-trailer scan')
  // POSITIVE CONTROL: the identical fixture that does NOT throw still reaches a real verdict, so
  // the `unknown` above is the throw being converted and not the fixture failing to get that far.
  expect(await fakeReadiness(fakeHost(FULL_OBJECT))).toEqual({ kind: 'blocked', on: carrierText([fakeHead]) })
})

/** #1133 round 24 (round-1 synthesis MAJOR, confirmed by two panel seats).
 * `sessionTrailerCarriers` validated `launchBase` with `fullOid` and never `head`. Two things
 * then followed from an empty head: git reads `<base>..` as `<base>..HEAD` (exit 0), so the scan
 * measured the CHECKOUT instead of the commit being published and normally allowed; and
 * `publication.ts` pushed `'':refs/heads/<branch>`, which is git's branch-DELETE refspec. Both
 * ends of the range are validated now, and the scan asks git NOTHING when either end is bad.
 */
test('#1133 G166: the scan validates BOTH ends of the range — a head that is not a full OID is unknown and asks git nothing', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const clean = await commit(repo, 'feat: one', 'Co-Authored-By: Fixture <fixture@example.invalid>')
    // POSITIVE CONTROL FIRST: an ordinary full-OID head is scanned and allowed, so the refusals
    // below are the guard firing and not the fixture being unscannable.
    expect(await sessionTrailerReadiness(run, repo, launchBase, clean)).toEqual({ kind: 'allow' })
    // Uppercase is included deliberately: this module's `fullOid` is case-SENSITIVE for the
    // launch base and for every sha the range listing returns, `git rev-parse` only ever emits
    // lowercase, and an unknown from the scan is a refusal — never a silent publish.
    for (const head of ['', 'abc', 'refs/heads/change', `${clean} `, clean.toUpperCase()]) {
      const argvs: string[][] = []
      const counting: RunHostCommand = async (argv, cwd, extraEnv) => { argvs.push(argv); return run(argv, cwd, extraEnv) }
      expect(await sessionTrailerReadiness(counting, repo, launchBase, head))
        .toEqual({ kind: 'unknown', detail: `Publication head is not a full OID: '${head}'` })
      // No range listing, no raw read, and above all no push on the strength of what was not seen.
      expect(argvs).toEqual([])
    }
    // The value is bounded: a long malformed head cannot inflate the persisted refusal.
    const long = 'z'.repeat(500)
    expect(await sessionTrailerReadiness(run, repo, launchBase, long))
      .toEqual({ kind: 'unknown', detail: `Publication head is not a full OID: '${'z'.repeat(64)}'` })
    // The launch base is checked FIRST, so a bad base keeps its own detail when both are bad.
    expect(await sessionTrailerReadiness(run, repo, 'short', ''))
      .toEqual({ kind: 'unknown', detail: 'Publication launch base is not a full OID' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/** #1133 round 25 (round-24 review, MINOR: is `missing < 0` intended, or a bug?).
 *
 * It is INTENDED, and this is the real-git evidence for it. The host runner decodes the raw
 * object as UTF-8, so one invalid byte comes back as U+FFFD and re-encodes to three: a COMPLETE
 * non-UTF-8 commit captures MORE bytes than `cat-file -s` reports. The existing over-read test
 * reaches that branch only through a fake runner that LIES about the size, which proves the
 * comparison and not that the branch is reachable at all — this one builds the object with
 * `git hash-object -t commit -w`, the one way to store a message git's own `commit-tree` would
 * normalise away (measured on git 2.43: `commit-tree -F` with a lone `0xE9` warns and stores
 * `C3 A9`), and reads it through real git.
 *
 * Why fail closed rather than decode: under lossy decoding a complete non-UTF-8 object and a
 * TRUNCATED one whose U+FFFD inflation has reached `size` present the same `missing <= 0`, so
 * treating an over-read as complete would let a truncating runner hide a carrier behind an
 * inflated short read. The answer is a refusal that NAMES the sha and the gap — never a rewrite,
 * so G100 origin preservation is untouched — and the loop's own commits are always UTF-8.
 */
test('#1133 G166: a real non-UTF-8 commit message is REFUSED as an over-read, never decoded and allowed', async () => {
  const { dir, repo, launchBase } = await scratch()
  try {
    const tree = await git(repo, 'rev-parse', `${launchBase}^{tree}`)
    const headers = `tree ${tree}\nparent ${launchBase}\nauthor Fixture <fixture@example.invalid> 1 +0000\n`
      + 'committer Fixture <fixture@example.invalid> 1 +0000\n\n'
    const store = async (name: string, message: Buffer): Promise<string> => {
      const path = join(dir, name)
      await writeFile(path, Buffer.concat([Buffer.from(headers, 'utf8'), message]))
      return git(repo, 'hash-object', '-t', 'commit', '-w', path)
    }
    // POSITIVE CONTROL FIRST: the same character stored as valid UTF-8 decodes byte-for-byte,
    // measures complete and is scanned to `allow` — so the refusal below is the encoding, not
    // the hand-built object being unscannable.
    const utf8 = await store('utf8-object', Buffer.from('feat: café\n', 'utf8'))
    expect(await sessionTrailerReadiness(run, repo, launchBase, utf8)).toEqual({ kind: 'allow' })
    // The identical message with the character as a lone Latin-1 byte.
    const latin1 = await store('latin1-object', Buffer.concat([Buffer.from('feat: caf', 'utf8'), Buffer.from([0xe9]), Buffer.from('\n', 'utf8')]))
    const size = Number(await git(repo, 'cat-file', '-s', latin1))
    const object = await run(['git', '--no-replace-objects', '-C', repo, 'cat-file', 'commit', latin1], repo)
    const captured = Buffer.byteLength(object.stdout, 'utf8')
    // The inflation is what makes the branch reachable: 1 invalid byte in, 3 bytes out.
    expect(captured).toBe(size + 2)
    expect(object.stdout).toContain('�')
    expect(await sessionTrailerReadiness(run, repo, launchBase, latin1)).toEqual({
      kind: 'unknown',
      detail: `Publication commit ${latin1} was read incompletely (${captured} of ${size} bytes: the read returned more bytes than the object holds)`,
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const objectFormat of ['sha1', 'sha256'] as const) {
  test(`#1133 G166 authenticated capture (${objectFormat}): UTF-8 inflation cannot conceal an equal-byte-length truncated carrier`, async () => {
    const { dir, repo, launchBase } = await scratch(objectFormat)
    try {
      const tree = await git(repo, 'rev-parse', 'HEAD^{tree}')
      const headers = `tree ${tree}\nparent ${launchBase}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\n`
      const raw = Buffer.concat([Buffer.from(headers), Buffer.from([0xe9]), Buffer.from('\nClaude-Session:')])
      await writeFile(join(dir, 'object'), raw)
      const sha = await git(repo, 'hash-object', '-t', 'commit', '-w', join(dir, 'object'))
      await git(repo, 'update-ref', 'refs/heads/change', sha)
      const complete = await run(['git', '-C', repo, 'cat-file', 'commit', sha], repo)
      expect(Buffer.byteLength(complete.stdout)).toBe(raw.length + 2)
      const capture = complete.stdout.slice(0, -2)
      expect(Buffer.byteLength(capture)).toBe(raw.length)
      expect(capture).not.toMatch(/^claude-session:/im)
      const truncate: RunHostCommand = async (argv, cwd, extraEnv) => {
        const result = await run(argv, cwd, extraEnv)
        return argv.includes('cat-file') && argv.includes('commit')
          ? { ...result, stdout: result.stdout.slice(0, -2) }
          : result
      }
      const refused = { kind: 'unknown' as const, detail: `Publication commit ${sha} was read incompletely (${raw.length} of ${raw.length} bytes: captured bytes and proposed terminators do not match the commit OID)` }
      expect(await readiness(repo, launchBase, truncate)).toEqual(refused)
      expect(await sessionTrailerReadiness(truncate, repo, launchBase, sha)).toEqual(refused)
      // Positive control: a real UTF-8 replacement character is valid data, and the complete
      // carrier is still named. Refusing every U+FFFD would reject legitimate messages.
      await writeFile(join(dir, 'object'), complete.stdout)
      const valid = await git(repo, 'hash-object', '-t', 'commit', '-w', join(dir, 'object'))
      expect(await sessionTrailerReadiness(run, repo, launchBase, valid)).toEqual({ kind: 'blocked', on: carrierText([valid]) })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test(`#1133 G166 authenticated capture (${objectFormat}): a no-final-LF carrier blocks and losing its colon is unknown`, async () => {
    const { dir, repo, launchBase } = await scratch(objectFormat)
    try {
      // hash-object preserves the exact message bytes, including the absent final LF.
      const tree = await git(repo, 'rev-parse', 'HEAD^{tree}')
      const raw = `tree ${tree}\nparent ${launchBase}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nClaude-Session:`
      await writeFile(join(dir, 'object'), raw)
      const sha = await git(repo, 'hash-object', '-t', 'commit', '-w', join(dir, 'object'))
      await git(repo, 'update-ref', 'refs/heads/change', sha)
      const truncate: RunHostCommand = async (argv, cwd, extraEnv) => {
        const result = await productionRun(argv, cwd, extraEnv)
        return argv.includes('cat-file') && argv.includes('commit')
          ? { ...result, stdout: result.stdout.slice(0, -1) }
          : result
      }
      expect((await run(['git', '-C', repo, 'cat-file', 'commit', sha], repo)).stdout).toBe(raw)
      expect(raw.slice(0, -1)).toEndWith('\n\nClaude-Session')
      expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'blocked', on: carrierText([sha]) })
      const refused = { kind: 'unknown' as const, detail: `Publication commit ${sha} was read incompletely (${Buffer.byteLength(raw) - 1} of ${Buffer.byteLength(raw)} bytes: captured bytes and proposed terminators do not match the commit OID)` }
      expect(await readiness(repo, launchBase, truncate)).toEqual(refused)
      expect(await sessionTrailerReadiness(truncate, repo, launchBase, sha)).toEqual(refused)
      const replaceColon: RunHostCommand = async (argv, cwd, extraEnv) => {
        const result = await productionRun(argv, cwd, extraEnv)
        return argv.includes('cat-file') && argv.includes('commit')
          ? { ...result, stdout: result.stdout.slice(0, -1) + ';' }
          : result
      }
      expect(await readiness(repo, launchBase, replaceColon)).toEqual({
        kind: 'unknown', detail: `Publication commit ${sha} was read incompletely (${Buffer.byteLength(raw)} of ${Buffer.byteLength(raw)} bytes: captured bytes and proposed terminators do not match the commit OID)`,
      })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test(`#1133 G166 authenticated capture (${objectFormat}): genuine clean and empty one-byte-trimmed captures allow`, async () => {
    const { dir, repo, launchBase } = await scratch(objectFormat)
    try {
      const tree = await git(repo, 'rev-parse', 'HEAD^{tree}')
      const headers = `tree ${tree}\nparent ${launchBase}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\n`
      for (const message of ['clean café\n', 'Claude-Session\n', 'CLAUDE-session\n', 'literal �\n', '']) {
        const raw = headers + message
        await writeFile(join(dir, 'object'), raw)
        const sha = await git(repo, 'hash-object', '-t', 'commit', '-w', join(dir, 'object'))
        await git(repo, 'update-ref', 'refs/heads/change', sha)
        const trimOne: RunHostCommand = async (argv, cwd) => {
          const result = await run(argv, cwd)
          return argv.includes('cat-file') && argv.includes('commit')
            ? { ...result, stdout: result.stdout.slice(0, -1) }
            : result
        }
        expect(await readiness(repo, launchBase, run)).toEqual({ kind: 'allow' })
        expect(await readiness(repo, launchBase, trimOne)).toEqual({ kind: 'allow' })
        expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'allow' })
        expect(await sessionTrailerReadiness(trimOne, repo, launchBase, sha)).toEqual({ kind: 'allow' })
      }
      // A complete, clean message with no final LF also authenticates without reconstruction.
      await writeFile(join(dir, 'object'), headers + 'clean without LF')
      const sha = await git(repo, 'hash-object', '-t', 'commit', '-w', join(dir, 'object'))
      await git(repo, 'update-ref', 'refs/heads/change', sha)
      expect(await readiness(repo, launchBase, productionRun)).toEqual({ kind: 'allow' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test(`#1133 G166 authenticated capture (${objectFormat}): a headers-only cut that lost message data is unknown`, async () => {
    const { dir, repo, launchBase } = await scratch(objectFormat)
    try {
      const tree = await git(repo, 'rev-parse', 'HEAD^{tree}')
      const raw = `tree ${tree}\nparent ${launchBase}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nx`
      await writeFile(join(dir, 'object'), raw)
      const sha = await git(repo, 'hash-object', '-t', 'commit', '-w', join(dir, 'object'))
      const cutTwo: RunHostCommand = async (argv, cwd) => {
        const result = await run(argv, cwd)
        return argv.includes('cat-file') && argv.includes('commit')
          ? { ...result, stdout: result.stdout.slice(0, -2) }
          : result
      }
      expect(await sessionTrailerReadiness(run, repo, launchBase, sha)).toEqual({ kind: 'allow' })
      expect(await sessionTrailerReadiness(cutTwo, repo, launchBase, sha)).toEqual({
        kind: 'unknown', detail: `Publication commit ${sha} was read incompletely (${Buffer.byteLength(raw) - 2} of ${Buffer.byteLength(raw)} bytes: captured bytes and proposed terminators do not match the commit OID)`,
      })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}
