/**
 * #1133 (G166) on the PRESERVATION PUSH — `checkBuildClaim` (G100) against REAL git and a REAL
 * origin.
 *
 * G100 pushes the measured branch head to origin before refusing a build whose claimed head is
 * not the measured one, so the work survives the refusal. That is an origin-facing push of a
 * build branch, and it is the one a wrapper provenance refusal (exit 76) leads to: Forge reports
 * the commit it created, the branch names a later commit, and the commit Forge created may
 * carry the `Claude-Session:` trailer. Until round 18 the preservation push ran no scan, so
 * the state the wrapper refused to publish was preserved onto the public remote silently by
 * the gate that noticed the mismatch; now it is preserved AND named.
 *
 * Owner decision 2026-09-19: G100's preservation guarantee stands (the inventory's G100 row is
 * authoritative), so the scan on this path OBSERVES and NAMES -- the refusal carries the
 * carriers, or the reason the range could not be measured -- and never withholds the push.
 * The checked publishers and the salvage push stay fail-closed; this is the one push whose job
 * is to preserve.
 *
 * Real git throughout: the scan reads raw commit objects and the push is a real
 * `--force-with-lease` to a bare remote. The push argv is recorded so the scan-before-push
 * order is an assertion about what the gate DID, and origin is read back so preservation is
 * also an assertion about what the remote HOLDS.
 */

import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { spawnCapture } from '../git-mode.ts'
import type { RunHostCommand } from '../merge.ts'
import { checkBuildClaim } from './build-claim.ts'

const BRANCH = 'trident/card'
const TRAILER = 'Claude-Session: https://claude.ai/code/session_01PRESERVE'
const CO_AUTHOR = 'Co-Authored-By: Trident Test <trident-test@neutron.local>'
const created: string[] = []
afterAll(() => { for (const dir of created) rmSync(dir, { recursive: true, force: true }) })

async function git(repo: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res.stdout.trim()
}

/** The sha origin holds for the branch ('' when it does not exist), read the way the lease reads it. */
async function observeRemote(repo: string): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, 'ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`], repo)
  return res.stdout.trim().split(/\s+/)[0] ?? ''
}

interface World { repo: string; base: string; own: string; foreign: string }

/**
 * A bare origin with nothing on it, a checkout on BRANCH whose history is
 * base <- own(<ownParagraphs>) <- foreign('foreign on top'): `own` is the commit Forge made and
 * will claim, `foreign` is what the branch names when the host measures it.
 */
async function seedWorld(ownParagraphs: string[]): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'trident-claim-trailer-'))
  created.push(root)
  const origin = join(root, 'origin.git')
  const repo = join(root, 'repo')
  const bare = await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
  if (!bare.ok) throw new Error(`bare init failed: ${bare.stderr}`)
  const init = await spawnCapture(['git', 'init', '-q', `--initial-branch=${BRANCH}`, repo], root)
  if (!init.ok) throw new Error(`init failed: ${init.stderr}`)
  await git(repo, 'config', 'user.email', 'trident-test@neutron.local')
  await git(repo, 'config', 'user.name', 'Trident Test')
  await git(repo, 'config', 'commit.gpgsign', 'false')
  await git(repo, 'remote', 'add', 'origin', `file://${origin}`)
  writeFileSync(join(repo, 'README.md'), 'base\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-q', '-m', 'base')
  const base = await git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'lib.txt'), 'built\n')
  await git(repo, 'add', 'lib.txt')
  await git(repo, 'commit', '-q', ...ownParagraphs.flatMap(paragraph => ['-m', paragraph]))
  const own = await git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'more.txt'), 'foreign\n')
  await git(repo, 'add', 'more.txt')
  await git(repo, 'commit', '-q', '-m', 'foreign on top')
  const foreign = await git(repo, 'rev-parse', 'HEAD')
  return { repo, base, own, foreign }
}

function host(): { run: RunHostCommand; calls: string[][] } {
  const calls: string[][] = []
  const run: RunHostCommand = async (argv, cwd, env, timeout) => {
    calls.push(argv)
    return spawnCapture(argv, cwd, env, timeout)
  }
  return { run, calls }
}

test('#1133 G166 preservation: positive control — a claim conflict on clean history is preserved on origin', async () => {
  const world = await seedWorld(['feat: built work', CO_AUTHOR])
  expect(await observeRemote(world.repo)).toBe('')
  const h = host()
  const result = await checkBuildClaim(h.run, world.repo, BRANCH, world.base, world.own.slice(0, 7), { head: world.foreign, diff: '+built', pr: null }, 'run')
  expect(result).toEqual({ kind: 'blocked', on: `Build claim ${world.own.slice(0, 7)} resolves to ${world.own} but measured head is ${world.foreign}; branch preserved on origin` })
  expect(await observeRemote(world.repo)).toBe(world.foreign)
  // The scan ran on this path: the raw objects of both branch commits were read before the push.
  const push = h.calls.findIndex(argv => argv.includes('push'))
  expect(push).toBeGreaterThanOrEqual(0)
  expect(h.calls[push]).toEqual(['git', '-C', world.repo, 'push', `--force-with-lease=refs/heads/${BRANCH}:`, 'origin', `${world.foreign}:refs/heads/${BRANCH}`])
  for (const sha of [world.own, world.foreign]) {
    const read = h.calls.findIndex(argv => argv.includes('cat-file') && argv.includes(sha))
    expect(read).toBeGreaterThanOrEqual(0)
    expect(read).toBeLessThan(push)
  }
})

test('#1133 G166 preservation: a carrier in launch-base..head is preserved on origin (G100) and the carrier is named', async () => {
  const world = await seedWorld(['feat: built work', `${CO_AUTHOR}\n${TRAILER}`])
  expect(await git(world.repo, 'cat-file', 'commit', world.own)).toContain(`\n${TRAILER}`)
  const h = host()
  const result = await checkBuildClaim(h.run, world.repo, BRANCH, world.base, world.own.slice(0, 7), { head: world.foreign, diff: '+built', pr: null }, 'run')
  // Owner decision 2026-09-19: G100 preserves as the inventory specifies; the G166 scan on this
  // path observes and names the carrier so the branch is stripped before any PR. It is not a veto.
  expect(result).toEqual({
    kind: 'blocked',
    on: `Build claim ${world.own.slice(0, 7)} resolves to ${world.own} but measured head is ${world.foreign}; branch preserved on origin; preserved range: Publication branch carries a Claude-Session trailer on 1 commit(s) above the launch base: ${world.own} -- strip before any PR`,
  })
  const push = h.calls.findIndex(argv => argv.includes('push'))
  expect(push).toBeGreaterThanOrEqual(0)
  expect(h.calls[push]).toEqual(['git', '-C', world.repo, 'push', `--force-with-lease=refs/heads/${BRANCH}:`, 'origin', `${world.foreign}:refs/heads/${BRANCH}`])
  // The scan read the carrier's raw object BEFORE the push: what was named is what was pushed.
  const read = h.calls.findIndex(argv => argv.includes('cat-file') && argv.includes(world.own))
  expect(read).toBeGreaterThanOrEqual(0)
  expect(read).toBeLessThan(push)
  // Origin holds the measured head (the work is not stranded), and the local branch is where it was.
  expect(await observeRemote(world.repo)).toBe(world.foreign)
  expect(await git(world.repo, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(world.foreign)
})

test('#1133 G166 preservation: a range that cannot be measured is still preserved (G100) and reported unmeasured', async () => {
  const world = await seedWorld(['feat: built work', CO_AUTHOR])
  const h = host()
  // A launch base that names no object: rev-list fails. The gate must not read "nothing listed"
  // as "nothing to scan" -- it says so -- and it must still preserve the branch.
  const result = await checkBuildClaim(h.run, world.repo, BRANCH, '1'.repeat(40), world.own.slice(0, 7), { head: world.foreign, diff: '+built', pr: null }, 'run')
  expect(result).toEqual({
    kind: 'blocked',
    on: `Build claim ${world.own.slice(0, 7)} resolves to ${world.own} but measured head is ${world.foreign}; branch preserved on origin; session-trailer scan unmeasured: Publication commit range could not be listed`,
  })
  expect(h.calls.some(argv => argv.includes('push'))).toBe(true)
  expect(await observeRemote(world.repo)).toBe(world.foreign)
})
