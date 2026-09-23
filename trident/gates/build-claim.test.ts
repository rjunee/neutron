import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { checkBuildClaim } from './build-claim.ts'
import type { RunHostCommand } from '../merge.ts'
const head = 'a'.repeat(40), other = 'b'.repeat(40), base = 'c'.repeat(40)
const snapshot = { head, diff: '+code', pr: null }
const CO_AUTHOR = 'Co-Authored-By: A <a@x>'
const ok = (stdout = '', exit_code = 0) => ({ ok: exit_code === 0, stdout, stderr: '', exit_code })
/** A whole raw commit object. G166 cross-checks the capture against `cat-file -s`, so a double
 * must answer the SIZE query for the exact bytes it hands back — a stub that conflated the two
 * would report the object's text as its size and every scan would come back unmeasured.
 */
const rawCommit = (lastParagraph: string) =>
  `tree ${'d'.repeat(40)}\nparent ${base}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nsubject\n\n${lastParagraph}\n`
const sized = (object: string) => ok(String(Buffer.byteLength(object, 'utf8')))
const commitOid = (object: string) => createHash('sha1')
  .update(Buffer.from(`commit ${Buffer.byteLength(object, 'utf8')}\0`, 'utf8'))
  .update(Buffer.from(object, 'utf8'))
  .digest('hex')
function fixture(measuredHead = head, object = rawCommit(CO_AUTHOR)) {
  const calls: string[][] = []
  const envs: (Record<string, string> | undefined)[] = []
  let remote = ''
  const run: RunHostCommand = async (argv, _cwd, extraEnv) => {
    calls.push(argv)
    envs.push(extraEnv)
    if (argv.includes('rev-parse')) return ok(other)
    if (argv.includes('ls-remote')) return ok(remote ? `${remote}\trefs/heads/change` : '')
    // G166: the trailer scan lists base..head; one clean commit by default.
    if (argv.includes('rev-list')) return ok(`${measuredHead}\n`)
    if (argv.includes('cat-file') && argv.includes('-s')) return sized(object)
    if (argv.includes('cat-file')) return ok(object)
    if (argv.includes('push')) remote = measuredHead
    return ok()
  }
  return { calls, envs, run, setRemote: (value: string) => { remote = value } }
}
test('G100 resolves full and abbreviated conflict, pushes pinned object and witnesses before refusal', async () => {
  for (const claim of [other, other.slice(0, 7)]) {
    const f = fixture()
    expect(await checkBuildClaim(f.run, 'repo', 'change', base, claim, snapshot, 'run')).toMatchObject({ kind: 'blocked', on: expect.stringContaining('branch preserved') })
    // G166: the scan (rev-list, then a raw read AND a size read per listed commit) sits between
    // the lease observation and the push, so the object pushed is the object scanned.
    const commands = ['check-ref-format', 'rev-parse', 'ls-remote', 'rev-list', 'cat-file', 'push']
    expect(f.calls.map(c => c.find(arg => commands.includes(arg)))).toEqual(['check-ref-format', 'rev-parse', 'ls-remote', 'rev-list', 'cat-file', 'cat-file', 'push', 'ls-remote'])
    // The range listing is a plain `git` argv; the graft override rides in the runner's typed
    // extraEnv (git has no flag for it), so a git-only host double never sees a foreign command.
    expect(f.calls[3]).toEqual(['git', '-C', 'repo', '--no-replace-objects', '--shallow-file', '/dev/null', '-c', 'core.commitGraph=false', '-c', 'advice.graftFileDeprecated=false', 'rev-list', '--end-of-options', `${base}..${head}`])
    expect(f.envs[3]).toEqual({ GIT_GRAFT_FILE: '/dev/null' })
    expect(f.calls[4]).toEqual(['git', '--no-replace-objects', '-C', 'repo', 'cat-file', 'commit', head])
    // The completeness cross-check is `--no-replace-objects` too: a replacement object must not
    // be able to report the substitute's size and make a short read look whole.
    expect(f.calls[5]).toEqual(['git', '--no-replace-objects', '-C', 'repo', 'cat-file', '-s', head])
    expect(f.calls.every(argv => argv[0] === 'git')).toBe(true)
    expect(f.calls[6]).toEqual(['git', '-C', 'repo', 'push', '--force-with-lease=refs/heads/change:', 'origin', `${head}:refs/heads/change`])
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
/** #1133 round 25 (round-24 review nit): the two G166-facing modules disagreed about the same
 * value. `release-readiness.ts`'s `fullOid` is case-SENSITIVE and refuses an uppercase head as
 * "not a full OID" (asserted there, in the both-ends-of-the-range test); this module's carried
 * `/i` and accepted one, so the SAME sha was a valid head to the gate and an invalid one to the
 * scan the gate runs. Git only ever emits lowercase object names, so the stricter form is the
 * measured one. An uppercase head is now a value git did not produce, and the gate asks git
 * NOTHING about it -- no rev-parse, no scan, and above all no preservation push on the strength
 * of a head that was never measured.
 */
test('#1133 G166: an uppercase measured head is not a full OID here either, and the gate asks git nothing', async () => {
  const f = fixture()
  expect(await checkBuildClaim(f.run, 'repo', 'change', base, other, { ...snapshot, head: head.toUpperCase() }, 'run'))
    .toEqual({ kind: 'unknown', detail: 'Measured build head is not a full commit OID' })
  expect(f.calls).toHaveLength(0)
  // POSITIVE CONTROL: the identical fixture with the lowercase head git actually emits reaches a
  // real verdict and does call git, so the refusal above is the case check firing and not a
  // fixture that cannot get that far.
  const lower = fixture()
  expect(await checkBuildClaim(lower.run, 'repo', 'change', base, other, snapshot, 'run'))
    .toMatchObject({ kind: 'blocked', on: expect.stringContaining('branch preserved on origin') })
  expect(lower.calls.length).toBeGreaterThan(0)
  // The same strictness on the RESOLVED claim, which is the other `fullOid` call site.
  const resolved = fixture()
  const run: RunHostCommand = (argv, cwd) => argv.includes('rev-parse')
    ? Promise.resolve(ok(other.toUpperCase()))
    : resolved.run(argv, cwd)
  expect(await checkBuildClaim(run, 'repo', 'change', base, other, snapshot, 'run'))
    .toEqual({ kind: 'unknown', detail: 'Build claim could not be resolved' })
  expect(resolved.calls.some(c => c.includes('push'))).toBe(false)
})
test('G100 thrown host cause is bounded and normal refusal text is unchanged', async () => {
  expect(await checkBuildClaim(async () => { throw new Error('recognisable claim failure') }, 'repo', 'change', base, other, snapshot, 'run')).toEqual({
    kind: 'unknown', detail: 'Build claim resolution or preservation failed: Error: recognisable claim failure',
  })
  expect(await checkBuildClaim(async () => ok('', 1), 'repo', 'bad ref', base, other, snapshot, 'run')).toEqual({
    kind: 'unknown', detail: 'Build branch reference is invalid',
  })
})

test('G100/G166 a carrier in launch-base..head is preserved (G100) and the refusal names the carrier', async () => {
  const trailer = 'Claude-Session: https://claude.ai/code/session_01FAKE'
  const carrier = rawCommit(trailer)
  const carrierHead = commitOid(carrier)
  const f = fixture(carrierHead, carrier)
  expect(await checkBuildClaim(f.run, 'repo', 'change', base, other, { ...snapshot, head: carrierHead }, 'run')).toEqual({
    kind: 'blocked',
    on: `Build claim ${other} resolves to ${other} but measured head is ${carrierHead}; branch preserved on origin; preserved range: Publication branch carries a Claude-Session trailer on 1 commit(s) above the launch base: ${carrierHead} -- strip before any PR`,
  })
  // Owner decision 2026-09-19: G100's preservation push is not withheld by the scan. The scan
  // still runs first (rev-list, cat-file) and the object pushed is the object scanned.
  const push = f.calls.findIndex(c => c.includes('push'))
  expect(push).toBeGreaterThanOrEqual(0)
  expect(f.calls[push]).toEqual(['git', '-C', 'repo', 'push', '--force-with-lease=refs/heads/change:', 'origin', `${carrierHead}:refs/heads/change`])
  expect(f.calls.findIndex(c => c.includes('cat-file'))).toBeLessThan(push)
})
test('G100/G166 a range that cannot be measured is still preserved (G100), and the refusal says the scan was unmeasured', async () => {
  for (const [launchBase, failing, detail] of [
    ['not-an-oid', '', 'Publication launch base is not a full OID'],
    [base, 'rev-list', 'Publication commit range could not be listed'],
    [base, 'cat-file', `Publication commit ${head} could not be read`],
  ] as const) {
    const f = fixture()
    const run: RunHostCommand = (argv, cwd) => failing !== '' && argv.includes(failing) ? Promise.resolve(ok('', 128)) : f.run(argv, cwd)
    expect(await checkBuildClaim(run, 'repo', 'change', launchBase, other, snapshot, 'run')).toEqual({
      kind: 'blocked',
      on: `Build claim ${other} resolves to ${other} but measured head is ${head}; branch preserved on origin; session-trailer scan unmeasured: ${detail}`,
    })
    expect(f.calls.some(c => c.includes('push'))).toBe(true)
  }
})
test('G100/G166 a remote already holding the measured head needs neither scan nor push', async () => {
  const f = fixture(); f.setRemote(head)
  expect(await checkBuildClaim(f.run, 'repo', 'change', base, other, snapshot, 'run')).toMatchObject({ kind: 'blocked', on: expect.stringContaining('; branch preserved on origin') })
  expect(f.calls.some(c => c.includes('rev-list') || c.includes('push'))).toBe(false)
})
