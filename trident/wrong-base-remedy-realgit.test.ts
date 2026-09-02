/**
 * REAL-git falsification for the wrong-base remedy. The mocked table tests hand the composer
 * both halves of the publication comparison, so they cannot catch the shape that matters most:
 * a fetch that EXITS 0 while `refs/remotes/origin/<branch>` stays stale. Under a narrowed
 * `remote.origin.fetch` — which every trident worktree clone can carry — `git fetch origin
 * <branch>` updates FETCH_HEAD and leaves the tracking ref where it was. Reading that stale ref
 * is how a `branch -D` gets printed for commits origin no longer has.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import { composeWrongBaseRefusal } from './wrong-base-remedy.ts'

const GIT_ID = [
  '-c',
  'user.name=Trident Test',
  '-c',
  'user.email=trident-test@neutron.local',
  '-c',
  'commit.gpgsign=false',
]
const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', ...GIT_ID, ...args], cwd)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res.stdout.trim()
}

async function commit(repo: string, name: string): Promise<string> {
  writeFileSync(join(repo, name), `${name}\n`)
  await git(repo, '-C', repo, 'add', '-A')
  await git(repo, '-C', repo, 'commit', '-qm', name)
  return await git(repo, '-C', repo, 'rev-parse', 'HEAD')
}

/** origin.git + two independent clones of it; `work` is the repo the guard inspects. */
async function world(): Promise<{ root: string; origin: string; work: string; other: string }> {
  const root = mkdtempSync(join(tmpdir(), 'wrong-base-realgit-'))
  created.push(root)
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const other = join(root, 'other')
  await git(root, 'init', '--bare', '-q', '--initial-branch=main', origin)
  await git(root, 'clone', '-q', origin, work)
  await commit(work, 'seed')
  await git(work, '-C', work, 'push', '-q', 'origin', 'main')
  await git(root, 'clone', '-q', origin, other)
  return { root, origin, work, other }
}

const REFUSAL = "refusing to build on another lane's work"
const RUN = 'run-realgit'
/** Deliberately UNqualified: `refs/tags/trident-salvage/...` in a failure_reason is read by
 * delivery.ts as a receipt for a snapshot that exists, and this module creates none. */
const SALVAGE_TAG = `trident-salvage/${RUN}`

describe('wrong-base remedy against real git', () => {
  test('a narrowed refspec cannot leave the guard reading a stale origin ref', async () => {
    const { work, other } = await world()
    // The local branch, published once, then REPLACED on origin by an unrelated commit. Any
    // reader of the stale tracking ref concludes "origin has exactly this sha" and prints a
    // delete for commits origin no longer carries.
    await git(work, '-C', work, 'checkout', '-qb', 'feat-x')
    const localTip = await commit(work, 'local-work')
    await git(work, '-C', work, 'push', '-q', 'origin', 'feat-x')
    await git(work, '-C', work, 'checkout', '-q', 'main')
    // This is the configuration the blocker turns on: origin's fetch refspec names main only.
    await git(work, '-C', work, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main')

    await git(other, '-C', other, 'fetch', '-q', 'origin', 'feat-x')
    await git(other, '-C', other, 'checkout', '-qB', 'feat-x', 'origin/main')
    const remoteTip = await commit(other, 'someone-elses-work')
    await git(other, '-C', other, 'push', '-qf', 'origin', 'feat-x')

    const stale = await git(work, '-C', work, 'rev-parse', 'refs/remotes/origin/feat-x')
    expect(stale).toBe(localTip)

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    expect(msg).toContain(REFUSAL)
    // Origin does NOT carry these commits any more; nothing destructive may be offered.
    expect(msg).not.toContain('branch -D')
    expect(msg).toContain(`tag ${SALVAGE_TAG}`)
    expect(msg).not.toContain('refs/tags/trident-salvage')
    expect(msg).toContain(remoteTip)
    expect(msg).toContain(localTip)
    // And the guard left the tracking ref TRUE, not stale.
    expect(await git(work, '-C', work, 'rev-parse', 'refs/remotes/origin/feat-x')).toBe(remoteTip)
  })

  test('origin ahead of the local tip is published work: the safe remedy, on real history', async () => {
    const { work, other } = await world()
    await git(work, '-C', work, 'checkout', '-qb', 'feat-x')
    const localTip = await commit(work, 'local-work')
    await git(work, '-C', work, 'push', '-q', 'origin', 'feat-x')
    await git(work, '-C', work, 'checkout', '-q', 'main')

    // Another lane pushed ON TOP of the local tip: the shas differ, yet every local commit is
    // on origin. Equality alone would call this unpublished and refuse to say so.
    await git(other, '-C', other, 'fetch', '-q', 'origin', 'feat-x')
    await git(other, '-C', other, 'checkout', '-qB', 'feat-x', 'FETCH_HEAD')
    const remoteTip = await commit(other, 'more-work')
    await git(other, '-C', other, 'push', '-q', 'origin', 'feat-x')

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    expect(msg).toContain('already contains it')
    expect(msg).toContain(remoteTip)
    expect(msg).toContain(`branch -D -- feat-x`)
    // The remedy must be the delete git RE-CHECKS. `update-ref -d` bypasses the
    // checked-out-elsewhere refusal, which is the whole hazard this card is about.
    expect(msg).not.toContain('update-ref -d')
  })

  test("a real locked worktree's porcelain names the holder, and no delete is offered", async () => {
    const { root, work } = await world()
    const wt = join(root, 'held-tree')
    await git(work, '-C', work, 'worktree', 'add', '-q', '-b', 'feat-x', wt)
    const localTip = await commit(wt, 'live-edit')
    await git(work, '-C', work, 'worktree', 'lock', '--reason', 'claude agent wf_x (pid 4242 start 99)', wt)

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture, probe_pid: () => 'alive', probe_tree: () => ({ kind: 'clear' }) },
    )
    expect(msg).toContain(REFUSAL)
    expect(msg).toContain(wt)
    expect(msg).toContain('4242')
    expect(msg).toContain('claude agent wf_x (pid 4242 start 99)')
    expect(msg).toContain('ALIVE')
    expect(msg).not.toContain('branch -D')
  })

  test('a worktree path containing a NEWLINE still reads as a holder, on real git', async () => {
    // The whole hazard in one fixture. `git worktree list --porcelain` (no -z) separates
    // records with a BLANK LINE, and a path is allowed to contain one — so this record splits,
    // the half carrying `branch refs/heads/feat-x` has no `worktree` line, the branch reads as
    // UNHELD, and the composer prints a delete for a branch a live lane is standing on.
    const { root, work } = await world()
    const wt = join(root, 'held\n\ntree')
    await git(work, '-C', work, 'worktree', 'add', '-q', '-b', 'feat-x', wt)
    const localTip = await commit(wt, 'live-edit')
    await git(work, '-C', work, 'worktree', 'lock', '--reason', 'claude agent wf_x (pid 4242 start 99)', wt)

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture, probe_pid: () => 'alive', probe_tree: () => ({ kind: 'clear' }) },
    )
    expect(msg).toContain(REFUSAL)
    expect(msg).toContain('ALIVE')
    expect(msg).toContain('4242')
    expect(msg).not.toContain('branch -D')
    // AND THE PATH DID NOT BRING ITS LINE BREAKS WITH IT. This fixture's path is benign apart
    // from the newline, but the newline alone is the forgery primitive: interpolated raw, a
    // path can draw a whole extra LINE that reads as the guard's own evidence. The message is
    // one line, on real git, for a path real git accepted.
    expect(msg).not.toContain('\n')
    // ...and git really did refuse the delete, which is why the held arm must never offer it.
    const refused = await spawnCapture(['git', '-C', work, 'branch', '-D', 'feat-x'], work)
    expect(refused.ok).toBe(false)
    expect(refused.stderr).toContain('used by worktree')
  })

  test('a worktree whose directory is gone is prunable, not a holder anyone can wait for', async () => {
    const { root, work } = await world()
    const wt = join(root, 'vanished-tree')
    await git(work, '-C', work, 'worktree', 'add', '-q', '-b', 'feat-x', wt)
    const localTip = await commit(wt, 'work')
    rmSync(wt, { recursive: true, force: true })

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    expect(msg).toContain(REFUSAL)
    expect(msg).toContain('PRUNABLE')
    expect(msg).toContain('worktree prune')
    expect(msg).not.toContain('branch -D')
    expect(msg).not.toContain('worktree remove')
  })

  test('a repo with no origin at all gets a salvage command that can actually run there', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wrong-base-realgit-local-'))
    created.push(root)
    const repo = join(root, 'local-only')
    await git(root, 'init', '-q', '--initial-branch=main', repo)
    await commit(repo, 'seed')
    await git(repo, '-C', repo, 'checkout', '-qb', 'feat-x')
    const localTip = await commit(repo, 'unpublished')
    await git(repo, '-C', repo, 'checkout', '-q', 'main')

    const msg = await composeWrongBaseRefusal(
      { repo, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    expect(msg).toContain('UNKNOWN')
    expect(msg).toContain("no reachable 'origin' remote")
    expect(msg).not.toContain('branch -D')
    // The remedy it prints must be one this repo can execute.
    expect(msg).toContain(`tag ${SALVAGE_TAG} ${localTip}`)
    const salvage = await spawnCapture(['git', '-C', repo, 'tag', SALVAGE_TAG, localTip], repo)
    expect(salvage.ok).toBe(true)
    expect(await git(repo, '-C', repo, 'rev-parse', `refs/tags/${SALVAGE_TAG}`)).toBe(localTip)
    // CREATE-ONLY: a second salvage of the same name must be REFUSED, not silently moved on
    // top of the first receipt — an earlier receipt's commit would go unreachable.
    const again = await spawnCapture(['git', '-C', repo, 'tag', SALVAGE_TAG, 'HEAD'], repo)
    expect(again.ok).toBe(false)
    // ...and the reason never spells the fully-qualified ref, which delivery.ts would render
    // to the operator as "Recovery snapshot: <ref>." for a snapshot nobody has taken yet.
    expect(msg).not.toContain('refs/tags/trident-salvage')
  })
  test('the printed safe delete is bound to the evidenced sha: a branch that MOVED survives it', async () => {
    // The message is composed at refusal time and executed minutes to hours later. An
    // unconditional `branch -D` destroys whatever the ref points at THEN — here an
    // unpublished commit pushed onto the branch after the evidence was gathered, which no
    // remote and no reflog-free clone would carry.
    const { work } = await world()
    await git(work, '-C', work, 'checkout', '-qb', 'feat-x')
    const evidencedTip = await commit(work, 'published-work')
    await git(work, '-C', work, 'push', '-q', 'origin', 'feat-x')
    await git(work, '-C', work, 'checkout', '-q', 'main')

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: evidencedTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    const printed =
      `git -C ${work} fetch --no-tags --no-recurse-submodules origin +refs/heads/feat-x:refs/remotes/origin/feat-x && ` +
      `test "$(git -C ${work} rev-parse --verify refs/heads/feat-x)" = ${evidencedTip} && ` +
      `git -C ${work} merge-base --is-ancestor ${evidencedTip} refs/remotes/origin/feat-x && ` +
      `git -C ${work} tag ${SALVAGE_TAG} ${evidencedTip} && ` +
      `git -C ${work} branch -D -- feat-x`
    expect(msg).toContain(printed)

    // THE RACE: another lane commits onto the branch after the message was composed.
    await git(work, '-C', work, 'checkout', '-q', 'feat-x')
    const raced = await commit(work, 'unpublished-later-work')
    await git(work, '-C', work, 'checkout', '-q', 'main')
    expect(raced).not.toBe(evidencedTip)

    const ran = await spawnCapture(['sh', '-c', printed], work)
    expect(ran.ok).toBe(false)
    // The branch is still there, still at the commit that was never published.
    expect(await git(work, '-C', work, 'rev-parse', 'refs/heads/feat-x')).toBe(raced)

    // POSITIVE CONTROL: the very same printed command DOES delete when the ref is still at
    // the evidenced sha, so this is compare-and-delete rather than a delete that never runs.
    // The run above stopped at the `test`, so the create-only tag link has not fired yet.
    await git(work, '-C', work, 'update-ref', 'refs/heads/feat-x', evidencedTip)
    const deleted = await spawnCapture(['sh', '-c', printed], work)
    expect(deleted.ok).toBe(true)
    // ...and the snapshot it takes on the way is a real receipt for the evidenced commit.
    expect(await git(work, '-C', work, 'rev-parse', `refs/tags/${SALVAGE_TAG}`)).toBe(evidencedTip)
    const gone = await spawnCapture(['git', '-C', work, 'rev-parse', '--verify', 'refs/heads/feat-x'], work)
    expect(gone.ok).toBe(false)
  })

  test('the printed delete re-reads ORIGIN: a force-push after composition stops it', async () => {
    // The other half of the staleness. The evidence says "origin carries these commits", and
    // that fact is as perishable as the local ref: another lane force-pushes origin/feat-x
    // somewhere else, and the local commits this message called published are published
    // nowhere. A chain that only re-checks the LOCAL ref deletes them anyway.
    const { work, other } = await world()
    await git(work, '-C', work, 'checkout', '-qb', 'feat-x')
    const evidencedTip = await commit(work, 'published-work')
    await git(work, '-C', work, 'push', '-q', 'origin', 'feat-x')
    await git(work, '-C', work, 'checkout', '-q', 'main')

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: evidencedTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    const printed =
      `git -C ${work} fetch --no-tags --no-recurse-submodules origin +refs/heads/feat-x:refs/remotes/origin/feat-x && ` +
      `test "$(git -C ${work} rev-parse --verify refs/heads/feat-x)" = ${evidencedTip} && ` +
      `git -C ${work} merge-base --is-ancestor ${evidencedTip} refs/remotes/origin/feat-x && ` +
      `git -C ${work} tag ${SALVAGE_TAG} ${evidencedTip} && ` +
      `git -C ${work} branch -D -- feat-x`
    expect(msg).toContain(printed)

    // THE RACE: origin is replaced after the message was composed. The local ref never moved,
    // so the compare-and-delete alone would still fire.
    await git(other, '-C', other, 'checkout', '-qB', 'feat-x', 'origin/main')
    await commit(other, 'someone-elses-work')
    await git(other, '-C', other, 'push', '-qf', 'origin', 'feat-x')

    const ran = await spawnCapture(['sh', '-c', printed], work)
    expect(ran.ok).toBe(false)
    expect(await git(work, '-C', work, 'rev-parse', 'refs/heads/feat-x')).toBe(evidencedTip)
  })

  test('a force-push INSIDE the chain still cannot make the commits unreachable', async () => {
    // THE WINDOW THE CHAIN CANNOT CLOSE, and the disclosure used to deny. The ancestry link
    // compares against `refs/remotes/origin/feat-x` — a TRACKING ref, refreshed only by the
    // chain's OWN first command — so a force-push landing AFTER that fetch is seen by no link
    // that follows: the compare passes, the ancestry passes against the stale ref, and the
    // delete drops commits that are by then published nowhere. The existing race test above
    // force-pushes BEFORE the chain runs, so it never exercised this ordering at all.
    //
    // The delete is NOT prevented — nothing in git makes a ref-delete conditional on a remote
    // — so what the chain owes is that the loss is recoverable. It snapshots the evidenced
    // commit immediately before deleting, and this test drives the race all the way through to
    // prove the receipt survives it.
    const { work, other } = await world()
    await git(work, '-C', work, 'checkout', '-qb', 'feat-x')
    const evidencedTip = await commit(work, 'published-work')
    await git(work, '-C', work, 'push', '-q', 'origin', 'feat-x')
    await git(work, '-C', work, 'checkout', '-q', 'main')

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: evidencedTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    // The chain is run LINK BY LINK, split out of the printed text itself, so the race lands
    // between two commands the reader would really run back to back.
    const printed = msg.slice(msg.indexOf(`git -C ${work} fetch --no-tags`))
    const links = printed.slice(0, printed.indexOf(' -- feat-x') + ' -- feat-x'.length).split(' && ')
    expect(links).toHaveLength(5)
    expect(links[0]).toContain('fetch --no-tags')
    expect(links[3]).toContain(`tag ${SALVAGE_TAG}`)
    expect(links[4]).toContain('branch -D')

    const fetched = await spawnCapture(['sh', '-c', links[0]!], work)
    expect(fetched.ok).toBe(true)
    // ...and NOW origin is replaced, after the chain's only look at it.
    await git(other, '-C', other, 'checkout', '-qB', 'feat-x', 'origin/main')
    await commit(other, 'someone-elses-work')
    await git(other, '-C', other, 'push', '-qf', 'origin', 'feat-x')
    const rest = await spawnCapture(['sh', '-c', links.slice(1).join(' && ')], work)

    // The delete goes through — the stale tracking ref answered for origin, which is exactly
    // the window this message now DISCLOSES rather than claiming away.
    expect(rest.ok).toBe(true)
    const gone = await spawnCapture(['git', '-C', work, 'rev-parse', '--verify', 'refs/heads/feat-x'], work)
    expect(gone.ok).toBe(false)
    // ...and origin really has dropped the commit, so nothing but the snapshot carries it.
    const onOrigin = await spawnCapture(
      ['git', '-C', work, 'merge-base', '--is-ancestor', evidencedTip, 'refs/remotes/origin/feat-x'],
      work,
    )
    await git(work, '-C', work, 'fetch', '--no-tags', '-q', 'origin', '+refs/heads/feat-x:refs/remotes/origin/feat-x')
    expect(
      (await spawnCapture(
        ['git', '-C', work, 'merge-base', '--is-ancestor', evidencedTip, 'refs/remotes/origin/feat-x'],
        work,
      )).ok,
    ).toBe(false)
    expect(onOrigin.ok).toBe(true)
    // THE PROPERTY: the work is still reachable, by the receipt the chain took inside the gap.
    expect(await git(work, '-C', work, 'rev-parse', `refs/tags/${SALVAGE_TAG}`)).toBe(evidencedTip)

    // And the message says so rather than promising the race cannot happen.
    expect(msg).toContain('only as fresh as this chain')
    expect(msg).toContain('still reachable here by that tag')
  })

  test('a branch held by an IN-PROGRESS BISECT is found, though git prints no branch for that tree', async () => {
    // The same family as the rebase above, and the reason the probe reads more than the rebase
    // state directories: `git bisect` detaches HEAD too, records the branch it left in
    // `BISECT_START`, and the listing says only `detached`. Measured here rather than assumed.
    const { root, work } = await world()
    const wt = join(root, 'bisecting')
    await git(work, '-C', work, 'worktree', 'add', '-q', '-b', 'feat-x', wt)
    await commit(wt, 'one')
    await commit(wt, 'two')
    const localTip = await commit(wt, 'three')
    await spawnCapture(['git', ...GIT_ID, '-C', wt, 'bisect', 'start'], wt)
    await spawnCapture(['git', ...GIT_ID, '-C', wt, 'bisect', 'bad'], wt)
    await spawnCapture(['git', ...GIT_ID, '-C', wt, 'bisect', 'good', 'HEAD~2'], wt)

    // The premises, measured: git omits the branch attribute, and it still refuses the delete.
    const listed = await spawnCapture(['git', '-C', work, 'worktree', 'list', '--porcelain'], work)
    expect(listed.stdout).toContain('detached')
    expect(listed.stdout).not.toContain('branch refs/heads/feat-x')
    const refused = await spawnCapture(['git', '-C', work, 'branch', '-D', 'feat-x'], work)
    expect(refused.ok).toBe(false)

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    expect(msg).toContain(REFUSAL)
    expect(msg).toContain('BISECT in progress')
    expect(msg).toContain(wt)
    expect(msg).not.toContain('branch -D')
    expect(msg).not.toContain('found no worktree holding the branch')
    // The remedy it names is the one that works in a bisecting tree; `rebase --abort` is not.
    expect(msg).toContain('git bisect reset')
  })

  test('the DEAD-holder remedy discloses what worktree remove deletes: ignored local-only files', async () => {
    // Non-force `worktree remove` refuses tracked modifications and untracked non-ignored
    // files — and DELETES ignored ones without a word. The old message advertised the refusal
    // as the safety property, so following it destroyed local-only artifacts it promised to
    // protect. The message must disclose that and print a preflight that actually shows them.
    const { root, work } = await world()
    const wt = join(root, 'dead-tree')
    await git(work, '-C', work, 'worktree', 'add', '-q', '-b', 'feat-x', wt)
    writeFileSync(join(wt, '.gitignore'), 'ignored.log\n')
    const localTip = await commit(wt, 'tracked-work')
    writeFileSync(join(wt, 'ignored.log'), 'local-only artifact\n')
    await git(work, '-C', work, 'worktree', 'lock', '--reason', 'claude agent wf_x (pid 4242 start 99)', wt)

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture, probe_pid: () => 'dead', probe_tree: () => ({ kind: 'clear' }) },
    )
    expect(msg).toContain('worktree remove')
    expect(msg).toContain('ignored local-only files')
    expect(msg).not.toContain('branch -D')

    // The PREFLIGHT the message prints must actually surface the file that is about to go.
    const preflight = `git -C ${wt} status --porcelain --ignored`
    expect(msg).toContain(preflight)
    const listed = await spawnCapture(['sh', '-c', preflight], work)
    expect(listed.ok).toBe(true)
    expect(listed.stdout).toContain('ignored.log')

    // And the disclosure is TRUE of real git: the tree is clean by `remove`'s standard, the
    // non-force remove succeeds, and the ignored file is destroyed with it.
    await git(work, '-C', work, 'worktree', 'unlock', wt)
    const removed = await spawnCapture(['git', '-C', work, 'worktree', 'remove', wt], work)
    expect(removed.ok).toBe(true)
    expect(existsSync(join(wt, 'ignored.log'))).toBe(false)
  })

  test('the shared-checkout switch silently overwrites an ignored local-only file, so the arm preflights it', async () => {
    // THE BLOCKER, against real git. The arm used to say the guard "did not measure whether
    // that checkout is clean, and it does not need to — checkout REFUSES rather than
    // overwriting a modified file". The clause is true of a TRACKED modification and the
    // conclusion drawn from it is false: a file ignored on this branch but TRACKED on the base
    // is replaced with the base's copy, exit 0, no refusal and no output. Same blind spot the
    // DEAD arm already discloses for `worktree remove`, in the arm a crash mid-merge reaches.
    const { work } = await world()
    writeFileSync(join(work, 'local.env'), 'from-main\n')
    await git(work, '-C', work, 'add', '-A')
    await git(work, '-C', work, 'commit', '-qm', 'track local.env on main')

    // On the wrong-base branch the same path is untracked AND gitignored — the ordinary shape
    // of a local-only .env that a base branch happens to carry a template for.
    await git(work, '-C', work, 'checkout', '-qb', 'feat-x')
    await git(work, '-C', work, 'rm', '-q', '--cached', 'local.env')
    writeFileSync(join(work, '.gitignore'), 'local.env\n')
    await git(work, '-C', work, 'add', '.gitignore')
    await git(work, '-C', work, 'commit', '-qm', 'untrack local.env here')
    const localTip = await git(work, '-C', work, 'rev-parse', 'HEAD')
    writeFileSync(join(work, 'local.env'), 'local-only-secret\n')

    // The branch is checked out in the repo's OWN shared checkout: no lock, no other lane.
    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    expect(msg).toContain(REFUSAL)
    expect(msg).toContain("repo's OWN shared checkout")
    expect(msg).not.toContain('does not need to')
    expect(msg).not.toContain('branch -D')

    // The preflight it prints SURFACES the file the switch would take.
    const preflight = `git -C ${work} status --porcelain --ignored`
    expect(msg).toContain(preflight)
    const listed = await spawnCapture(['sh', '-c', preflight], work)
    expect(listed.ok).toBe(true)
    expect(listed.stdout).toContain('local.env')

    // And the disclosure is TRUE of real git: the switch the message prints exits 0, refuses
    // nothing, and the local-only content is gone.
    const printed = `git -C ${work} switch -- main`
    expect(msg).toContain(printed)
    const switched = await spawnCapture(['sh', '-c', printed], work)
    expect(switched.ok).toBe(true)
    expect(readFileSync(join(work, 'local.env'), 'utf8')).toBe('from-main\n')
  })

  test('a repo reached through a SYMLINK is still recognised as its own shared checkout', async () => {
    // `git worktree list` prints RESOLVED paths; a caller's `repo_path` need not be resolved.
    // Comparing the two as strings makes the shared checkout look like a separate worktree —
    // so the composer would tell the operator to stand down and wait for a lane that is this
    // process itself, and there is no release anybody can perform. Only the realpath fallback
    // separates the two, and only a non-canonical path exercises it.
    const { root, work } = await world()
    await git(work, '-C', work, 'checkout', '-qb', 'feat-x')
    const localTip = await commit(work, 'wrong-base-work')
    const link = join(root, 'work-link')
    symlinkSync(work, link)

    const msg = await composeWrongBaseRefusal(
      { repo: link, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    expect(msg).toContain(REFUSAL)
    expect(msg).toContain("repo's OWN shared checkout")
    expect(msg).not.toContain('branch -D')
    expect(msg).not.toContain('Stand down')
  })

  test('a branch held by an IN-PROGRESS REBASE is found, though git prints no branch for that tree', async () => {
    // Git reports a worktree mid-rebase as DETACHED — the porcelain carries no `branch`
    // attribute at all — so a listing alone reads the branch as unheld and the composer walks
    // to the publication comparison and its delete. Reachable in this repo's own flow:
    // `merge.ts` rebases in the shared checkout. The delete fails closed, but the sentence in
    // front of it would have asserted "found no worktree holding the branch", which is false.
    const { root, work } = await world()
    const wt = join(root, 'rebasing')
    await git(work, '-C', work, 'worktree', 'add', '-q', '-b', 'feat-x', wt)
    // Two commits that conflict with main's, so the rebase STOPS and stays in progress.
    writeFileSync(join(wt, 'clash.txt'), 'from-the-branch\n')
    await git(wt, '-C', wt, 'add', '-A')
    await git(wt, '-C', wt, 'commit', '-qm', 'branch side')
    const localTip = await git(wt, '-C', wt, 'rev-parse', 'HEAD')
    writeFileSync(join(work, 'clash.txt'), 'from-main\n')
    await git(work, '-C', work, 'add', '-A')
    await git(work, '-C', work, 'commit', '-qm', 'main side')
    const rebase = await spawnCapture(['git', ...GIT_ID, '-C', wt, 'rebase', 'main'], wt)
    expect(rebase.ok).toBe(false)

    // The premise, measured rather than assumed: git really does omit the branch attribute.
    const listed = await spawnCapture(['git', '-C', work, 'worktree', 'list', '--porcelain'], work)
    expect(listed.stdout).toContain('detached')
    expect(listed.stdout).not.toContain('branch refs/heads/feat-x')

    const msg = await composeWrongBaseRefusal(
      { repo: work, branch: 'feat-x', base: 'main', branch_tip: localTip, ahead_count: '1', run_id: RUN },
      { run_host: spawnCapture },
    )
    expect(msg).toContain(REFUSAL)
    expect(msg).toContain('REBASE in progress')
    expect(msg).toContain(wt)
    expect(msg).not.toContain('branch -D')
    expect(msg).not.toContain('found no worktree holding the branch')
    // ...and git agrees the branch is held: the delete the old message printed cannot run.
    const refused = await spawnCapture(['git', '-C', work, 'branch', '-D', 'feat-x'], work)
    expect(refused.ok).toBe(false)
  })
})
