/**
 * #1133 (G166) on the SALVAGE PUSH — `publishBuiltCommit` against REAL git and a REAL origin.
 *
 * The checked publishers run `publicationReadiness` before their push, but the stranded-work
 * salvage (`reconcile_stranded` → `publishBuiltCommit`) has its own lease push and used to run
 * no trailer scan at all — and it is exactly the path a refused wrapper commit takes: the
 * wrapper refuses and leaves the trailer commit on the branch, the checked gate blocks, the run
 * fails, and the salvage pushed the very commit the gate refused, as an unreviewed PR.
 *
 * Real git throughout: the scan reads raw commit objects and the push is a real
 * `--force-with-lease` to a bare remote, so a fake host would only prove the fake. `gh` is the
 * one thing intercepted (no GitHub here): `gh pr create` answers ok and the PR probe reports a
 * number after it, which is the shape the positive control needs to run to completion.
 */

import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture, type DiffOutputHost } from './git-mode.ts'
import { publishBuiltCommit, type PublicationDeps } from './publication.ts'
import type { TridentRun } from './store.ts'

const BRANCH = 'trident/card-trailer'
const created: string[] = []
afterAll(() => { for (const dir of created) rmSync(dir, { recursive: true, force: true }) })

async function git(repo: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res.stdout
}

async function identify(repo: string): Promise<void> {
  await git(repo, 'config', 'user.email', 'trident-test@neutron.local')
  await git(repo, 'config', 'user.name', 'Trident Test')
  await git(repo, 'config', 'commit.gpgsign', 'false')
}

/** The sha origin holds for `ref` ('' when the ref does not exist), read the way the lease reads it. */
async function observeRemote(repo: string, ref: string): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, 'ls-remote', '--heads', 'origin', ref], repo)
  return res.stdout.trim().split(/\s+/)[0] ?? ''
}

interface World { checkout: string; baseSha: string; branchTip: string }

/**
 * A bare origin holding `main`, a full clone on `BRANCH` cut from that tip, and ONE branch commit
 * whose message paragraphs are the caller's — the trailer arrives the way the CLI reminder makes
 * the agent write it, as a paragraph of its own beside `Co-Authored-By`.
 */
async function seedWorld(paragraphs: string[]): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'trident-salvage-trailer-'))
  created.push(root)
  const origin = join(root, 'origin.git')
  const author = join(root, 'author')
  const checkout = join(root, 'checkout')
  const init = await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
  if (!init.ok) throw new Error(`bare init failed: ${init.stderr}`)
  const authorInit = await spawnCapture(['git', 'init', '-q', '--initial-branch=main', author], root)
  if (!authorInit.ok) throw new Error(`author init failed: ${authorInit.stderr}`)
  await identify(author)
  await git(author, 'remote', 'add', 'origin', `file://${origin}`)
  writeFileSync(join(author, 'README.md'), 'base\n')
  await git(author, 'add', 'README.md')
  await git(author, 'commit', '-q', '-m', 'base')
  await git(author, 'push', '-q', 'origin', 'main')
  const baseSha = (await git(author, 'rev-parse', 'HEAD')).trim()
  const clone = await spawnCapture(['git', 'clone', '-q', `file://${origin}`, checkout], root)
  if (!clone.ok) throw new Error(`clone failed: ${clone.stderr}`)
  await identify(checkout)
  await git(checkout, 'switch', '-q', '-c', BRANCH)
  writeFileSync(join(checkout, 'lib.txt'), 'built\n')
  await git(checkout, 'add', 'lib.txt')
  await git(checkout, 'commit', '-q', ...paragraphs.flatMap(paragraph => ['-m', paragraph]))
  const branchTip = (await git(checkout, 'rev-parse', 'HEAD')).trim()
  return { checkout, baseSha, branchTip }
}

function salvageRun(world: World): TridentRun {
  return {
    id: 'salvage-trailer',
    slug: 'card-trailer',
    repo_path: world.checkout,
    branch: BRANCH,
    merge_mode: 'pr',
    base_sha: world.baseSha,
    reviewed_head: null,
    inner_result: null,
    task: 'realgit fixture: the stranded-work salvage push',
  } as unknown as TridentRun
}

/** Real git for everything; `gh` answered locally, and every argv recorded. */
function deps(world: World): PublicationDeps & { calls: string[][]; prCreated: () => boolean } {
  const calls: string[][] = []
  let created = false
  const host: DiffOutputHost = Object.assign(
    async (cmd: string[], cwd?: string, extraEnv?: Record<string, string>, timeoutMs?: number) => {
      calls.push(cmd)
      if (cmd[0] === 'gh') {
        if (cmd[1] === 'pr' && cmd[2] === 'create') { created = true; return { ok: true, stdout: '', stderr: '', exit_code: 0 } }
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      }
      return spawnCapture(cmd, cwd, extraEnv, timeoutMs)
    },
    { writesDiffOutput: true as const },
  )
  return {
    calls,
    prCreated: () => created,
    run_host: host,
    // The purity preflight is its own gate with its own tests; it is stood down here so the
    // only thing between the replay and the lease push is the scan under test.
    leak_preflight: async input => ({ status: 'skipped-no-gate', head: input.head, findings: [], skipped_rules: [], attempts: 0, note: 'stood down in test' }),
    resolveBase: async () => 'main',
    resolvedDiffBase: async () => world.baseSha,
    detectExistingPr: async () => (created ? 7 : null),
  }
}

const TRAILER = 'Claude-Session: https://claude.ai/code/session_01SALVAGE'
const CO_AUTHOR = 'Co-Authored-By: Trident Test <trident-test@neutron.local>'

test('#1133 G166 salvage: positive control — a branch with only Co-Authored-By is pushed and a PR is opened', async () => {
  const world = await seedWorld(['feat: built work', CO_AUTHOR])
  expect(await observeRemote(world.checkout, `refs/heads/${BRANCH}`)).toBe('')
  const d = deps(world)
  const published = await publishBuiltCommit(d, salvageRun(world), null)
  expect(published).toEqual({ pr: 7, head: world.branchTip, push: 'pushed' })
  expect(await observeRemote(world.checkout, `refs/heads/${BRANCH}`)).toBe(world.branchTip)
  expect(d.prCreated()).toBe(true)
  // The scan ran on this path: the raw object of the branch commit was read before the push.
  const catFile = d.calls.findIndex(cmd => cmd.includes('cat-file') && cmd.includes(world.branchTip))
  const push = d.calls.findIndex(cmd => cmd.some(arg => arg.startsWith('--force-with-lease=')))
  expect(catFile).toBeGreaterThanOrEqual(0)
  expect(push).toBeGreaterThan(catFile)
  // And the push names the OBJECT the scan read, not the local ref — a ref can move between
  // the scan and the push; the object cannot (#1133 round 18).
  expect(d.calls[push]).toEqual([
    'git', '-C', world.checkout, 'push', `--force-with-lease=refs/heads/${BRANCH}:`, 'origin', `${world.branchTip}:refs/heads/${BRANCH}`,
  ])
})

for (const concurrentMessage of ['concurrent clean work', `concurrent work\n\n${TRAILER}`]) {
  test(`#1133 G166 salvage: publishes the scanned object while preserving a concurrent local advance (${concurrentMessage.includes(TRAILER) ? 'trailer' : 'clean'})`, async () => {
    const world = await seedWorld(['feat: built work', CO_AUTHOR])
    const tree = (await git(world.checkout, 'rev-parse', `${world.branchTip}^{tree}`)).trim()
    const concurrent = (await git(world.checkout, 'commit-tree', tree, '-p', world.branchTip, '-m', concurrentMessage)).trim()
    const d = deps(world)
    let advanced = false
    const racing: DiffOutputHost = Object.assign(
      async (cmd: string[], cwd?: string, extraEnv?: Record<string, string>, timeoutMs?: number) => {
        // Advance only at the actual push boundary, after the real raw-object scan has passed.
        if (!advanced && cmd.includes('push')) {
          expect(d.calls.some(call => call.includes('cat-file') && call.includes(world.branchTip))).toBe(true)
          await git(world.checkout, 'update-ref', `refs/heads/${BRANCH}`, concurrent, world.branchTip)
          advanced = true
        }
        return d.run_host(cmd, cwd, extraEnv, timeoutMs)
      },
      { writesDiffOutput: true as const },
    )
    const published = await publishBuiltCommit({ ...d, run_host: racing }, salvageRun(world), null)
    expect(advanced).toBe(true)
    expect(published).toEqual({ pr: 7, head: world.branchTip, push: 'pushed' })
    expect(d.prCreated()).toBe(true)
    expect(await observeRemote(world.checkout, `refs/heads/${BRANCH}`)).toBe(world.branchTip)
    // Read the receiver's raw object, not a local copy or just the publisher's return value.
    const origin = join(world.checkout, '..', 'origin.git')
    expect(await git(origin, 'cat-file', 'commit', `refs/heads/${BRANCH}`)).not.toContain('\nClaude-Session:')
    expect((await git(world.checkout, 'rev-parse', `refs/heads/${BRANCH}`)).trim()).toBe(concurrent)
    expect(await git(world.checkout, 'cat-file', 'commit', concurrent)).toContain(concurrentMessage)
  })
}

test('#1133 G166 salvage: a branch head carrying the trailer is NOT pushed — origin unchanged, no PR, the sha named', async () => {
  const world = await seedWorld(['feat: built work', `${CO_AUTHOR}\n${TRAILER}`])
  expect(await git(world.checkout, 'cat-file', 'commit', world.branchTip)).toContain(`\n${TRAILER}`)
  const d = deps(world)
  let refused: Error | null = null
  try { await publishBuiltCommit(d, salvageRun(world), null) } catch (err) { refused = err as Error }
  expect(refused).not.toBeNull()
  expect(refused!.message).toContain(`outer publisher refused to push branch ${BRANCH}`)
  expect(refused!.message).toContain(`Publication branch carries a Claude-Session trailer on 1 commit(s) above the launch base: ${world.branchTip}`)
  expect(refused!.message).toContain('nothing was pushed')
  // The property the card states is of PUBLISHED history: origin never saw the branch.
  expect(await observeRemote(world.checkout, `refs/heads/${BRANCH}`)).toBe('')
  expect(d.calls.some(cmd => cmd.includes('push'))).toBe(false)
  expect(d.calls.some(cmd => cmd[0] === 'gh')).toBe(false)
  expect(d.prCreated()).toBe(false)
  // And the local branch is left exactly where it was, for inspection.
  expect((await git(world.checkout, 'rev-parse', `refs/heads/${BRANCH}`)).trim()).toBe(world.branchTip)
  expect(existsSync(join(world.checkout, 'lib.txt'))).toBe(true)
})

test('#1133 G166 salvage: the scan covers the REPLAYED head — a trailer carried through the rebase onto a moved main is refused', async () => {
  const world = await seedWorld(['feat: built work', `${CO_AUTHOR}\n${TRAILER}`])
  // main moves after the branch is cut, so the publisher must replay the branch before pushing —
  // and the replay re-commits the ORIGINAL message, trailer included.
  const author = join(world.checkout, '..', 'author')
  writeFileSync(join(author, 'OTHER.md'), 'landed after the cut\n')
  await git(author, 'add', 'OTHER.md')
  await git(author, 'commit', '-q', '-m', 'main moved')
  await git(author, 'push', '-q', 'origin', 'main')
  const movedMain = (await git(author, 'rev-parse', 'HEAD')).trim()
  const d = deps(world)
  let refused: Error | null = null
  try { await publishBuiltCommit(d, salvageRun(world), null) } catch (err) { refused = err as Error }
  expect(refused).not.toBeNull()
  expect(refused!.message).toContain('Publication branch carries a Claude-Session trailer on 1 commit(s) above the launch base')
  // The branch WAS replayed onto the moved tip (a new head, descending from it) and it is that
  // head — not the pre-replay one — the scan named and the push never carried.
  const replayed = (await git(world.checkout, 'rev-parse', `refs/heads/${BRANCH}`)).trim()
  expect(replayed).not.toBe(world.branchTip)
  expect((await git(world.checkout, 'rev-parse', `${replayed}^`)).trim()).toBe(movedMain)
  expect(refused!.message).toContain(replayed)
  expect(await git(world.checkout, 'cat-file', 'commit', replayed)).toContain(`\n${TRAILER}`)
  expect(await observeRemote(world.checkout, `refs/heads/${BRANCH}`)).toBe('')
  expect(d.calls.some(cmd => cmd.includes('push'))).toBe(false)
})

test('#1133 G166 salvage: a range that cannot be measured is refused the same as a carrier — never pushed on what was not seen', async () => {
  const world = await seedWorld(['feat: built work', CO_AUTHOR])
  const d = deps(world)
  const blind: DiffOutputHost = Object.assign(
    async (cmd: string[], cwd?: string, extraEnv?: Record<string, string>, timeoutMs?: number) =>
      cmd.includes('cat-file') && cmd.includes('commit')
        ? { ok: false, stdout: '', stderr: 'simulated unreadable object', exit_code: 128 }
        : d.run_host(cmd, cwd, extraEnv, timeoutMs),
    { writesDiffOutput: true as const },
  )
  let refused: Error | null = null
  try { await publishBuiltCommit({ ...d, run_host: blind }, salvageRun(world), null) } catch (err) { refused = err as Error }
  expect(refused).not.toBeNull()
  expect(refused!.message).toContain(`Publication commit ${world.branchTip} could not be read`)
  expect(await observeRemote(world.checkout, `refs/heads/${BRANCH}`)).toBe('')
  expect(d.calls.some(cmd => cmd.includes('push'))).toBe(false)
})

test('#1133 G166 salvage: with NO remote base the window is the review diff\'s own left-hand side, resolved to a commit — a ref naming none is refused as unmeasurable', async () => {
  const world = await seedWorld(['feat: built work', `${CO_AUTHOR}\n${TRAILER}`])
  // origin loses `main` after the clone: the replay observes no base tip and stands down, so
  // the scan must fall back to the same operand the review diff uses — here the qualified
  // local base ref (the delete push pruned the remote-tracking one), which is not a sha and
  // has to be resolved to the commit it names.
  const origin = join(world.checkout, '..', 'origin.git')
  await git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/detached-elsewhere')
  await git(world.checkout, 'push', '-q', 'origin', '--delete', 'main')
  expect(await observeRemote(world.checkout, 'refs/heads/main')).toBe('')
  const d = deps(world)
  const unpinned = { ...salvageRun(world), base_sha: null } as TridentRun
  let refused: Error | null = null
  try {
    await publishBuiltCommit({ ...d, resolvedDiffBase: async () => 'refs/heads/main' }, unpinned, null)
  } catch (err) { refused = err as Error }
  expect(refused).not.toBeNull()
  expect(refused!.message).toContain(`Publication branch carries a Claude-Session trailer on 1 commit(s) above the launch base: ${world.branchTip}`)
  expect(await observeRemote(world.checkout, `refs/heads/${BRANCH}`)).toBe('')
  // A base operand that names no commit is not a licence to push: unmeasurable is refused too.
  refused = null
  try {
    await publishBuiltCommit({ ...d, resolvedDiffBase: async () => 'refs/heads/no-such-base' }, unpinned, null)
  } catch (err) { refused = err as Error }
  expect(refused).not.toBeNull()
  expect(refused!.message).toContain('Publication launch base is not a full OID')
  expect(await observeRemote(world.checkout, `refs/heads/${BRANCH}`)).toBe('')
  expect(d.calls.some(cmd => cmd.includes('push'))).toBe(false)
})

/**
 * #1133 round 24 (round-1 synthesis MAJOR, raised independently by two panel seats).
 *
 * `publishBuiltCommit` pushes `${headToPublish}:refs/heads/<branch>`. With an EMPTY
 * `headToPublish` that object-pinned refspec is git's branch-DELETE form, and nothing downstream
 * noticed: measured here on git 2.43.0, `git push --force-with-lease=refs/heads/<b>:<observed>
 * origin ':refs/heads/<b>'` prints `- [deleted]` and EXITS 0 — the lease is satisfied, so it
 * protects nothing — and the post-push witness then compares a `remoteHead` of '' against a
 * `headToPublish` of '' and finds them EQUAL, so it does not throw. Origin loses the branch while
 * the run records a successful publish. The scan could not catch it either: it validated
 * `launchBase` with `fullOid` but never `head`, and git reads `<base>..` as `<base>..HEAD`.
 *
 * REACHABLE, not hypothetical: `headToPublish` is `stdout.trim()` of an injected runner's read at
 * `replay.ts:200`, `replay.ts:595` and `leak-preflight.ts:448`, each of which checks `.ok` and
 * nothing else. The double below is exactly that — `ok` with empty stdout on ONE narrow read (the
 * replay's branch-head `rev-parse`, which has no `--verify`); the publisher's own
 * `rev-parse --verify` and the replay's shallow probes all go to real git.
 */
test('#1133 G166 round 24: an unmeasurable publication head can never become the branch-DELETE refspec', async () => {
  const world = await seedWorld(['feat: built work', CO_AUTHOR])
  const ref = `refs/heads/${BRANCH}`
  // origin HOLDS the branch, so the lease has a real expectation to satisfy and a delete is
  // observable. This is the "silent on every re-publish of an existing PR" shape.
  await git(world.checkout, 'push', '-q', 'origin', BRANCH)
  expect(await observeRemote(world.checkout, ref)).toBe(world.branchTip)
  // origin loses `main`, so the replay observes no base tip and returns its branch-head read
  // directly (replay.ts:205) — that read is the value that becomes `headToPublish`.
  const origin = join(world.checkout, '..', 'origin.git')
  await git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/detached-elsewhere')
  await git(world.checkout, 'push', '-q', 'origin', '--delete', 'main')
  const d = deps(world)
  let blanked = 0
  const emptyHeadRead: DiffOutputHost = Object.assign(
    async (cmd: string[], cwd?: string, extraEnv?: Record<string, string>, timeoutMs?: number) => {
      if (cmd.includes('rev-parse') && cmd.includes(ref) && !cmd.includes('--verify')) {
        blanked++
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      }
      return d.run_host(cmd, cwd, extraEnv, timeoutMs)
    },
    { writesDiffOutput: true as const },
  )
  let refused: Error | null = null
  try { await publishBuiltCommit({ ...d, run_host: emptyHeadRead }, salvageRun(world), null) } catch (err) { refused = err as Error }
  expect(blanked).toBeGreaterThan(0)
  expect(refused).not.toBeNull()
  expect(refused!.message).toContain(`outer publisher refused to push branch ${BRANCH}`)
  expect(refused!.message).toContain("Publication head is not a full OID: ''")
  expect(refused!.message).toContain('nothing was pushed')
  // THE PROPERTY, read off the receiver: origin still holds the branch at the commit it held.
  expect(await observeRemote(world.checkout, ref)).toBe(world.branchTip)
  expect(d.calls.some(cmd => cmd.includes('push'))).toBe(false)
  expect(d.prCreated()).toBe(false)
})

/** The measurement the guard above rests on, made HERE rather than quoted from a session: an
 * empty left-hand side in an object-pinned refspec deletes the branch, satisfies the lease, and
 * exits 0. Paired with its own positive control — the same lease and the same remote accept an
 * ordinary object-pinned push — so a green run cannot mean the fixture simply failed to push.
 */
test('#1133 G166 round 24: positive control for the branch-DELETE measurement — an empty refspec head deletes and exits 0', async () => {
  const world = await seedWorld(['feat: built work', CO_AUTHOR])
  const ref = `refs/heads/${BRANCH}`
  await git(world.checkout, 'push', '-q', 'origin', BRANCH)
  expect(await observeRemote(world.checkout, ref)).toBe(world.branchTip)
  // Control: the ordinary object-pinned form this publisher uses re-publishes the same commit.
  const ok = await spawnCapture(
    ['git', '-C', world.checkout, 'push', `--force-with-lease=${ref}:${world.branchTip}`, 'origin', `${world.branchTip}:${ref}`],
    world.checkout,
  )
  expect(ok.ok).toBe(true)
  expect(await observeRemote(world.checkout, ref)).toBe(world.branchTip)
  // The defect shape: the same argv with an EMPTY head is a delete that the lease does not stop.
  const deleted = await spawnCapture(
    ['git', '-C', world.checkout, 'push', `--force-with-lease=${ref}:${world.branchTip}`, 'origin', `:${ref}`],
    world.checkout,
  )
  expect(deleted.exit_code).toBe(0)
  expect(`${deleted.stdout}${deleted.stderr}`).toContain('[deleted]')
  expect(await observeRemote(world.checkout, ref)).toBe('')
})
