import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixLineage } from './fix-lineage.ts'
import type { RunHostCommand } from '../merge.ts'

const pin = 'a'.repeat(40)
const head = 'b'.repeat(40)
const ok: RunHostCommand = async () => ({ ok: true, exit_code: 0, stdout: '', stderr: '' })

test('fresh null pin allows without consulting git', async () => {
  let calls = 0
  expect(await fixLineage(async () => { calls++; throw Error('unexpected git') }, 'repo', 'change', null, head)).toEqual({ kind: 'allow' })
  expect(calls).toBe(0)
})

test('short and malformed pins are blocked before git', async () => {
  for (const value of ['deadbeef', '', 'g'.repeat(40), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65)]) {
    let calls = 0
    expect(await fixLineage(async (...args) => { calls++; return ok(...args) }, 'repo', 'change', value, head)).toEqual({
      kind: 'blocked', on: `fix-round refused: the reviewed-head pin '${value}' is not a full 40- or 64-hex commit; refusing to publish ${head} unverified`,
    })
    expect(calls).toBe(0)
  }
})

test('non-descendant is blocked with the original message', async () => {
  expect(await fixLineage(async () => ({ ok: false, exit_code: 1, stdout: '', stderr: '' }), 'repo', 'change', pin, head)).toEqual({
    kind: 'blocked', on: `fix-round refused: produced head ${head} of branch change does not descend from the reviewed head ${pin} — the round abandoned the reviewed branch`,
  })
})

test('unverifiable ancestry remains unknown with the original message', async () => {
  expect(await fixLineage(async () => ({ ok: false, exit_code: 128, stdout: '', stderr: ' fatal: missing object\n' }), 'repo', 'change', pin, head)).toEqual({
    kind: 'unknown', detail: `fix-round refused: could not verify that produced head ${head} descends from reviewed head ${pin} (fatal: missing object); refusing to publish unverified`,
  })
  expect(await fixLineage(async () => { throw Error('offline') }, 'repo', 'change', pin, head)).toEqual({ kind: 'unknown', detail: 'offline' })
})

test('full pins normalize and ask git even on equality', async () => {
  for (const value of [pin, 'a'.repeat(64)]) {
    const calls: string[][] = []
    expect(await fixLineage(async (argv) => { calls.push(argv); return ok(argv, 'repo') }, 'repo', 'change', ` ${value.toUpperCase()} `, value)).toEqual({ kind: 'allow' })
    expect(calls).toEqual([['git', '-C', 'repo', 'merge-base', '--is-ancestor', value, value]])
  }
})

test('real git accepts equality and descendants and rejects a sibling', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'fix-lineage-'))
  const run: RunHostCommand = async argv => {
    const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
    return { ok: result.exitCode === 0, exit_code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
  const git = async (...args: string[]) => {
    const result = await run(['git', '-C', repo, ...args], repo)
    expect(result.ok).toBe(true)
    return result.stdout.trim()
  }
  try {
    await git('init')
    const tree = await git('mktree')
    const commit = (...parents: string[]) => git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', String(parents.length))
    const root = await commit()
    const child = await commit(root)
    const sibling = await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit-tree', tree, '-p', root, '-m', 'sibling')
    expect(await fixLineage(run, repo, 'change', root, root)).toEqual({ kind: 'allow' })
    expect(await fixLineage(run, repo, 'change', root, child)).toEqual({ kind: 'allow' })
    expect(await fixLineage(run, repo, 'change', child, sibling)).toMatchObject({ kind: 'blocked' })
  } finally { await rm(repo, { recursive: true, force: true }) }
})
