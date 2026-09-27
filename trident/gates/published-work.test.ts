import { afterEach, expect, spyOn, test } from 'bun:test'
import { access, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publishedWorkPreserved } from './published-work.ts'
import { spawnCapture } from '../git-mode.ts'
import { checkBuildClaim, buildPreservationRef } from './build-claim.ts'
import type { RunHostCommand } from '../merge.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'published-work-test-')); dirs.push(dir)
  const repo = join(dir, 'repo'), origin = join(dir, 'origin.git')
  async function git(...args: string[]) {
    const r = await spawnCapture(['git', '-C', repo, ...args], dir)
    if (!r.ok) throw Error(r.stderr)
    return r.stdout.trim()
  }
  expect((await spawnCapture(['git', 'init', '-q', '--initial-branch=main', repo], dir)).ok).toBe(true)
  expect((await spawnCapture(['git', 'init', '-q', '--bare', origin], dir)).ok).toBe(true)
  await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.hooksPath', '/dev/null')
  await git('remote', 'add', 'origin', origin)
  async function commit(path: string, text: string) {
    await writeFile(join(repo, path), text); await git('add', path); await git('commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const base = await commit('base.txt', 'base\n')
  await git('switch', '-qc', 'change')
  const old = await commit('earlier.txt', 'earlier\n')
  await git('push', 'origin', 'change')
  await git('switch', 'main')
  const main = await commit('main-new.txt', 'main\n')
  await git('push', 'origin', 'main')
  await git('switch', '-qc', 'fresh')
  const fresh = await commit('fresh.txt', 'fresh\n')
  return { dir, repo, origin, base, old, main, fresh, git, commit }
}

test('published work rejects the real fresh sibling and allows a content-preserving replay with new OIDs', async () => {
  const w = await world()
  expect(await publishedWorkPreserved(spawnCapture, w.repo, w.old, w.fresh)).toMatchObject({ kind: 'blocked' })
  expect(await w.git('ls-remote', '--heads', 'origin', 'refs/heads/change')).toStartWith(w.old)
  await w.git('cherry-pick', w.old)
  const replayed = await w.git('rev-parse', 'HEAD')
  expect(replayed).not.toBe(w.old)
  expect((await spawnCapture(['git', '-C', w.repo, 'merge-base', '--is-ancestor', w.old, replayed], w.repo)).exit_code).toBe(1)
  expect(await publishedWorkPreserved(spawnCapture, w.repo, w.old, replayed)).toEqual({ kind: 'allow' })
  await w.git('push', `--force-with-lease=refs/heads/change:${w.old}`, 'origin', `${replayed}:refs/heads/change`)
  expect(await w.git('ls-tree', '-r', '--name-only', replayed)).toBe('base.txt\nearlier.txt\nfresh.txt\nmain-new.txt')
  expect(await publishedWorkPreserved(spawnCapture, w.repo, w.old, w.old)).toEqual({ kind: 'allow' })
  expect(await publishedWorkPreserved(spawnCapture, w.repo, '', w.fresh)).toEqual({ kind: 'allow' })
})

test('preservation refuses unavailable evidence and does not weaken the observed push lease', async () => {
  const w = await world()
  for (const failed of ['cat-file', 'merge-base', 'merge-tree', 'rev-parse']) {
    const run: RunHostCommand = (args, cwd, env, timeout) => args.includes(failed)
      ? Promise.resolve({ ok: false, exit_code: 128, stdout: '', stderr: 'unreadable' })
      : spawnCapture(args, cwd, env, timeout)
    expect((await publishedWorkPreserved(run, w.repo, w.old, w.fresh)).kind).toBe('unknown')
  }
  await w.git('cherry-pick', w.old)
  const candidate = await w.git('rev-parse', 'HEAD')
  expect((await publishedWorkPreserved(spawnCapture, w.repo, w.old, candidate)).kind).toBe('allow')
  await w.git('push', `--force-with-lease=refs/heads/change:${w.old}`, 'origin', `${w.fresh}:refs/heads/change`)
  expect((await spawnCapture(['git', '-C', w.repo, 'push', `--force-with-lease=refs/heads/change:${w.old}`, 'origin', `${candidate}:refs/heads/change`], w.repo)).ok).toBe(false)
})

test('snapshot capture, indexing, strict validation and exact roots are mandatory before ancestry', async () => {
  const w = await world()
  await w.git('switch', 'change')
  const candidate = await w.commit('next.txt', 'normal descendant\n')
  for (const failed of ['pack-objects', 'index-pack', 'fsck', 'root']) {
    let scratch = '', ancestry = false
    const run: RunHostCommand = async (args, cwd, env, timeout) => {
      if (args.includes('init')) scratch = args.at(-1)!
      if (args.includes('merge-base')) ancestry = true
      if (args.includes(failed)) return { ok: false, exit_code: 128, stdout: '', stderr: 'ordinary unavailable data' }
      if (failed === 'root' && args.includes('rev-parse')) return { ok: true, exit_code: 0, stdout: w.base, stderr: '' }
      return spawnCapture(args, cwd, env, timeout)
    }
    expect((await publishedWorkPreserved(run, w.repo, w.old, candidate)).kind).toBe('unknown')
    expect(ancestry).toBe(false)
    expect(scratch).not.toBe('')
    expect(await access(scratch).then(() => true, () => false)).toBe(false)
    expect(await w.git('ls-remote', '--heads', 'origin', 'refs/heads/change')).toStartWith(w.old)
  }
})

test('ordinary truncated pack and oversized snapshot refuse before calculation and clean up', async () => {
  const w = await world()
  for (const fault of ['truncated', 'oversized']) {
    let scratch = '', ancestry = false
    const run: RunHostCommand = async (args, cwd, env, timeout) => {
      if (args.includes('init')) scratch = args.at(-1)!
      if (args.includes('merge-base')) ancestry = true
      if (fault === 'truncated' && args.includes('index-pack')) await truncate(join(scratch, 'snapshot.pack'), 10)
      const result = await spawnCapture(args, cwd, env, timeout)
      // A sparse oversized file exercises the size refusal without allocating
      // a huge fixture or attempting object identity substitution.
      if (fault === 'oversized' && args.includes('pack-objects')) await truncate(join(scratch, 'snapshot.pack'), 512 * 1024 * 1024)
      return result
    }
    expect((await publishedWorkPreserved(run, w.repo, w.old, w.fresh)).kind).toBe('unknown')
    expect(ancestry).toBe(false)
    expect(await access(scratch).then(() => true, () => false)).toBe(false)
    expect(await w.git('ls-remote', '--heads', 'origin', 'refs/heads/change')).toStartWith(w.old)
  }
})

test('all snapshot commands share one deadline and generation plus index share one size budget', async () => {
  const w = await world()
  let clock = 0, scratch = '', expired = false
  const timeouts: number[] = [], limits: number[] = []
  const now = spyOn(performance, 'now').mockImplementation(() => clock)
  try {
    const run: RunHostCommand = async (args, cwd, env, timeout) => {
      timeouts.push(timeout!)
      if (args.includes('init')) scratch = args.at(-1)!
      if (args[0] === 'bash') limits.push(Number(args[args.indexOf('--') + 1]))
      const result = await spawnCapture(args, cwd, env, timeout)
      clock += 1000
      if (expired && args.includes('fsck')) clock += 60_000
      return result
    }
    expect((await publishedWorkPreserved(run, w.repo, w.old, w.fresh)).kind).toBe('blocked')
    expect(limits[0]).toBe(512 * 1024)
    expect(limits[1]).toBeLessThan(limits[0]!)
    expect(timeouts[0]).toBe(60_000)
    expect(timeouts.every((n, i) => i === 0 || n < timeouts[i - 1]!)).toBe(true)
    expired = true
    expect((await publishedWorkPreserved(run, w.repo, w.old, w.fresh)).kind).toBe('unknown')
    expect(await access(scratch).then(() => true, () => false)).toBe(false)
  } finally { now.mockRestore() }
})

test('verified snapshot does not borrow source objects during ancestry or merge', async () => {
  const w = await world()
  await w.git('cherry-pick', w.old)
  const candidate = await w.git('rev-parse', 'HEAD')
  let detached = false, validated = false
  const run: RunHostCommand = async (args, cwd, env, timeout) => {
    if (args.includes('merge-base') && !detached) {
      expect(validated).toBe(true)
      await rename(join(w.repo, '.git'), join(w.repo, 'detached-git'))
      detached = true
    }
    const result = await spawnCapture(args, cwd, env, timeout)
    if (args.includes('fsck')) validated = result.ok
    return result
  }
  try {
    expect((await publishedWorkPreserved(run, w.repo, w.old, candidate)).kind).toBe('allow')
    expect(detached).toBe(true)
  } finally { if (detached) await rename(join(w.repo, 'detached-git'), join(w.repo, '.git')) }
})

test('inherited Git object-store selectors cannot redirect the verified snapshot', async () => {
  const w = await world()
  const redirected = { GIT_OBJECT_DIRECTORY: join(w.dir, 'unavailable-objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(w.dir, 'unavailable-alternates'), GIT_COMMON_DIR: join(w.dir, 'unavailable-common') }
  expect((await spawnCapture(['git', '-C', w.repo, 'cat-file', '-e', w.old], w.repo, redirected)).ok).toBe(false)
  const run: RunHostCommand = (args, cwd, env, timeout) => spawnCapture(args, cwd, { ...env, ...redirected }, timeout)
  expect((await publishedWorkPreserved(run, w.repo, w.old, w.fresh)).kind).toBe('blocked')
})

test('replacement parents and a shallow view cannot manufacture published-work ancestry', async () => {
  const w = await world()
  await w.git('replace', '--graft', w.fresh, w.old)
  expect((await spawnCapture(['git', '-C', w.repo, 'merge-base', '--is-ancestor', w.old, w.fresh], w.repo)).ok).toBe(true)
  expect((await publishedWorkPreserved(spawnCapture, w.repo, w.old, w.fresh)).kind).toBe('blocked')
  await writeFile(join(w.repo, '.git', 'info', 'grafts'), `${w.fresh} ${w.old}\n`)
  expect((await spawnCapture(['git', '--no-replace-objects', '-C', w.repo, 'merge-base', '--is-ancestor', w.old, w.fresh], w.repo)).ok).toBe(true)
  expect((await publishedWorkPreserved(spawnCapture, w.repo, w.old, w.fresh)).kind).toBe('blocked')
  await writeFile(join(w.repo, '.git', 'shallow'), `${w.fresh}\n`)
  expect((await publishedWorkPreserved(spawnCapture, w.repo, w.old, w.fresh)).kind).toBe('blocked')
})

test('a real descendant may intentionally edit and delete earlier published work', async () => {
  const w = await world()
  await w.git('switch', 'change')
  await w.git('rm', 'earlier.txt')
  await w.git('commit', '-qm', 'Remove previous task intentionally')
  const candidate = await w.commit('base.txt', 'edited by subsequent task\n')
  expect((await publishedWorkPreserved(spawnCapture, w.repo, w.old, candidate)).kind).toBe('allow')
})

test('checkout-configured merge drivers cannot conceal lost published content', async () => {
  const w = await world()
  await w.git('switch', 'change')
  await w.commit('.gitattributes', 'base.txt merge=hide\n')
  const prior = await w.commit('base.txt', 'published content\n')
  await w.git('switch', 'fresh')
  await w.commit('.gitattributes', 'base.txt merge=hide\n')
  await w.commit('earlier.txt', 'earlier\n')
  const candidate = await w.commit('base.txt', 'lost published content\n')
  await w.git('config', 'merge.hide.driver', 'true')
  // Positive control: the checkout's configured driver really would conceal it.
  expect(await w.git('merge-tree', '--write-tree', '--no-messages', candidate, prior)).toBe(await w.git('rev-parse', `${candidate}^{tree}`))
  expect((await publishedWorkPreserved(spawnCapture, w.repo, prior, candidate)).kind).toBe('blocked')
})

test('G100 preserves an exact candidate without overwriting prior published work, including scans that throw', async () => {
  for (const fault of [false, true]) {
    const w = await world()
    const commands: string[][] = []
    const run: RunHostCommand = (args, cwd, env, timeout) => {
      commands.push(args)
      if (fault && args.includes('rev-list')) throw Error('scan unavailable')
      return spawnCapture(args, cwd, env, timeout)
    }
    const ref = buildPreservationRef(w.fresh)
    const result = await checkBuildClaim(run, w.repo, 'change', w.base, w.old, { head: w.fresh, diff: '+fresh', pr: null }, 'proof')
    expect(result.kind).toBe('blocked')
    if (result.kind !== 'blocked') throw Error('Expected preservation')
    expect(result.on).toContain(ref)
    if (fault) expect(result.on).toContain('scan unmeasured')
    expect(await w.git('ls-remote', '--heads', 'origin', 'refs/heads/change')).toStartWith(w.old)
    expect(await w.git('ls-remote', '--heads', 'origin', ref)).toStartWith(w.fresh)
    const pushes = commands.filter(args => args.includes('push')).length
    expect((await checkBuildClaim(run, w.repo, 'change', w.base, w.old, { head: w.fresh, diff: '+fresh', pr: null }, 'proof')).kind).toBe('blocked')
    expect(commands.filter(args => args.includes('push'))).toHaveLength(pushes)
    await w.git('push', `--force-with-lease=${ref}:${w.fresh}`, 'origin', `${w.old}:${ref}`)
    expect((await checkBuildClaim(run, w.repo, 'change', w.base, w.old, { head: w.fresh, diff: '+fresh', pr: null }, 'proof')).kind).toBe('unknown')
    expect(await w.git('ls-remote', '--heads', 'origin', ref)).toStartWith(w.old)
  }
})
