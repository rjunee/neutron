import { expect, test } from 'bun:test'
import { checkBuildClaim } from './build-claim.ts'
import type { RunHostCommand } from '../merge.ts'
const head = 'a'.repeat(40), other = 'b'.repeat(40), base = 'c'.repeat(40)
const snapshot = { head, diff: '+code', pr: null }
const ok = (stdout = '', exit_code = 0) => ({ ok: exit_code === 0, stdout, stderr: '', exit_code })
function fixture() {
  const calls: string[][] = []
  let remote = ''
  const run: RunHostCommand = async argv => {
    calls.push(argv)
    if (argv.includes('rev-parse')) return ok(other)
    if (argv.includes('ls-remote')) return ok(remote ? `${remote}\trefs/heads/change` : '')
    // G166: the trailer scan lists base..head; one clean commit by default.
    if (argv.includes('rev-list')) return ok(`${head}\n`)
    if (argv.includes('cat-file')) return ok(`tree ${'d'.repeat(40)}\nparent ${base}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nsubject\n\nCo-Authored-By: A <a@x>\n`)
    if (argv.includes('push')) remote = head
    return ok()
  }
  return { calls, run, setRemote: (value: string) => { remote = value } }
}
test('G100 resolves full and abbreviated conflict, pushes pinned object and witnesses before refusal', async () => {
  for (const claim of [other, other.slice(0, 7)]) {
    const f = fixture()
    expect(await checkBuildClaim(f.run, 'repo', 'change', base, claim, snapshot, 'run')).toMatchObject({ kind: 'blocked', on: expect.stringContaining('branch preserved') })
    // G166: the scan (rev-list, then one cat-file per listed commit) sits between the lease
    // observation and the push, so the object pushed is the object scanned.
    expect(f.calls.map(c => c[3] ?? c[1])).toEqual(['check-ref-format', 'rev-parse', 'ls-remote', 'rev-list', 'cat-file', 'push', 'ls-remote'])
    expect(f.calls[3]).toEqual(['git', '-C', 'repo', 'rev-list', '--end-of-options', `${base}..${head}`])
    expect(f.calls[5]).toEqual(['git', '-C', 'repo', 'push', '--force-with-lease=refs/heads/change:', 'origin', `${head}:refs/heads/change`])
  }
})
test('G100 same or nonexistent claim allows; uncertain resolution stays unknown', async () => {
  for (const [result, kind] of [[ok(head), 'allow'], [ok('', 1), 'allow'], [ok('', 128), 'unknown'], [ok('short'), 'unknown']] as const) {
    const f = fixture()
    const run: RunHostCommand = (argv, cwd) => argv.includes('rev-parse') ? Promise.resolve(result) : f.run(argv, cwd)
    expect((await checkBuildClaim(run, 'repo', 'change', base, 'aaaaaaa', snapshot, 'run')).kind).toBe(kind)
    expect(f.calls.some(c => c.includes('push'))).toBe(false)
  }
})
test('G100 unobserved preservation never claims a preserved conflict', async () => {
  for (const failure of ['push', 'receipt', 'remote', 'malformed'] as const) {
    const f = fixture(); let reads = 0
    const run: RunHostCommand = async (argv, cwd) => {
      if (argv.includes('push') && failure === 'push') { f.setRemote(head); return ok('', 1) }
      if (argv.includes('ls-remote')) {
        reads++
        if (failure === 'remote') return ok(`${head} refs/heads/change`, 128)
        if (failure === 'malformed' && reads === 1) return ok(`${head} refs/heads/wrong`)
        if (failure === 'receipt' && reads === 2) return ok(`${other} refs/heads/change`)
      }
      return f.run(argv, cwd)
    }
    expect((await checkBuildClaim(run, 'repo', 'change', base, other, snapshot, 'run')).kind).toBe('unknown')
  }
})
test('G100 an existing preservation receipt needs no push', async () => {
  const f = fixture(); f.setRemote(head)
  expect((await checkBuildClaim(f.run, 'repo', 'change', base, other, snapshot, 'run')).kind).toBe('blocked')
  expect(f.calls.some(c => c.includes('push'))).toBe(false)
})

test('G100 invalid head or branch and thrown host calls stay unknown', async () => {
  const f = fixture()
  expect((await checkBuildClaim(f.run, 'repo', 'change', base, other, { ...snapshot, head: 'short' }, 'run')).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
  expect((await checkBuildClaim(async () => ok('', 1), 'repo', 'bad ref', base, other, snapshot, 'run')).kind).toBe('unknown')
  expect((await checkBuildClaim(async () => { throw Error('offline') }, 'repo', 'change', base, other, snapshot, 'run')).kind).toBe('unknown')
})
test('G100 thrown host cause is bounded and normal refusal text is unchanged', async () => {
  expect(await checkBuildClaim(async () => { throw new Error('recognisable claim failure') }, 'repo', 'change', base, other, snapshot, 'run')).toEqual({
    kind: 'unknown', detail: 'Build claim resolution or preservation failed: Error: recognisable claim failure',
  })
  expect(await checkBuildClaim(async () => ok('', 1), 'repo', 'bad ref', base, other, snapshot, 'run')).toEqual({
    kind: 'unknown', detail: 'Build branch reference is invalid',
  })
})

test('G100/G166 a carrier in launch-base..head is refused WITHOUT the preservation push, naming the carrier', async () => {
  const f = fixture()
  const trailer = 'Claude-Session: https://claude.ai/code/session_01FAKE'
  const run: RunHostCommand = (argv, cwd) => argv.includes('cat-file')
    ? Promise.resolve(ok(`tree ${'d'.repeat(40)}\nparent ${base}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nsubject\n\n${trailer}\n`))
    : f.run(argv, cwd)
  expect(await checkBuildClaim(run, 'repo', 'change', base, other, snapshot, 'run')).toEqual({
    kind: 'blocked',
    on: `Build claim ${other} resolves to ${other} but measured head is ${head}; branch NOT preserved on origin: Publication branch carries a Claude-Session trailer on 1 commit(s) above the launch base: ${head}`,
  })
  expect(f.calls.some(c => c.includes('push'))).toBe(false)
})
test('G100/G166 a range that cannot be measured is refused WITHOUT the preservation push, not pushed on faith', async () => {
  for (const [launchBase, failing, detail] of [
    ['not-an-oid', '', 'Publication launch base is not a full OID'],
    [base, 'rev-list', 'Publication commit range could not be listed'],
    [base, 'cat-file', `Publication commit ${head} could not be read`],
  ] as const) {
    const f = fixture()
    const run: RunHostCommand = (argv, cwd) => failing !== '' && argv.includes(failing) ? Promise.resolve(ok('', 128)) : f.run(argv, cwd)
    expect(await checkBuildClaim(run, 'repo', 'change', launchBase, other, snapshot, 'run')).toEqual({
      kind: 'blocked',
      on: `Build claim ${other} resolves to ${other} but measured head is ${head}; branch NOT preserved on origin: ${detail}`,
    })
    expect(f.calls.some(c => c.includes('push'))).toBe(false)
  }
})
test('G100/G166 a remote already holding the measured head needs neither scan nor push', async () => {
  const f = fixture(); f.setRemote(head)
  expect(await checkBuildClaim(f.run, 'repo', 'change', base, other, snapshot, 'run')).toMatchObject({ kind: 'blocked', on: expect.stringContaining('; branch preserved on origin') })
  expect(f.calls.some(c => c.includes('rev-list') || c.includes('push'))).toBe(false)
})
