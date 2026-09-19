import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnCapture } from '../git-mode.ts'
import type { RunHostCommand } from '../merge.ts'
import { commitMessageReadiness } from './commit-message-readiness.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'commit-message-test-'))
  dirs.push(repo)
  const command = async (...args: string[]) => {
    const result = await spawnCapture(['git', '-C', repo, ...args], repo)
    if (!result.ok) throw new Error(result.stderr)
    return result.stdout
  }
  await command('init', '--initial-branch=main')
  await command('config', 'user.name', 'Fixture')
  await command('config', 'user.email', 'fixture@example.invalid')
  const commit = async (message: string) => {
    const path = join(repo, 'message')
    await writeFile(path, message)
    await command('commit', '--allow-empty', '--cleanup=verbatim', '-F', path)
    return command('rev-parse', 'HEAD')
  }
  const base = await commit('Historical base\n\nClaude-Session: preexisting\n')
  return { repo, base, command, commit, check: (head: string, run: RunHostCommand = spawnCapture) => commitMessageReadiness(run, repo, base, head) }
}

test('clean range allows harmless body mention and unchanged Co-Authored-By; base message is excluded', async () => {
  const f = await fixture()
  const head = await f.commit('Describe Claude-Session removal\n\nThe Claude-Session token is documentation here.\n\nCo-Authored-By: Fixture <fixture@example.invalid>\n')
  const before = await f.command('show', '-s', '--format=%B', head)
  expect(await f.check(head)).toEqual({ kind: 'allow' })
  expect(await f.command('show', '-s', '--format=%B', head)).toBe(before)
  expect(await f.check(f.base)).toEqual({ kind: 'allow' })
})

test('refuses a dirty ancestor beneath a clean tip, including messages larger than captured stdout', async () => {
  const f = await fixture()
  await f.commit('Ancestor\n\n' + 'payload\n'.repeat(100_000) + '\nclaude-session: private-value\n')
  const head = await f.commit('Clean followup\n')
  const outcome = await f.check(head)
  expect(outcome).toMatchObject({ kind: 'blocked' })
  expect(JSON.stringify(outcome)).not.toContain('private-value')
})

test('includes merged side history, not only the first-parent chain', async () => {
  const f = await fixture()
  await f.command('checkout', '-b', 'side')
  await f.commit('Side change\n\nClaude-Session: hidden-side\n')
  await f.command('checkout', 'main')
  await f.commit('Main change\n')
  await f.command('merge', '--no-ff', 'side', '-m', 'Clean merge')
  expect(await f.check(await f.command('rev-parse', 'HEAD'))).toMatchObject({ kind: 'blocked' })
})

test('replacement objects cannot hide a prohibited message', async () => {
  const f = await fixture()
  const dirty = await f.commit('Dirty\n\nClaude-Session: hidden\n')
  await f.command('checkout', '--detach', f.base)
  const clean = await f.commit('Replacement\n')
  await f.command('replace', dirty, clean)
  expect(await f.check(dirty)).toMatchObject({ kind: 'blocked' })
})

test('legacy grafts cannot hide a prohibited ancestor', async () => {
  const f = await fixture()
  await f.commit('Dirty\n\nClaude-Session: hidden\n')
  const head = await f.commit('Clean tip\n')
  await writeFile(join(f.repo, '.git', 'info', 'grafts'), `${head} ${f.base}\n`)
  expect(await f.check(head)).toMatchObject({ kind: 'blocked' })
})

test('raw commit message bytes cannot conceal a trailer behind a NUL', async () => {
  const f = await fixture()
  const path = join(f.repo, 'raw-commit')
  const tree = await f.command('rev-parse', `${f.base}^{tree}`)
  await writeFile(path, `tree ${tree}\nparent ${f.base}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nClean prefix\0\nClaude-Session: concealed\n`)
  const head = await f.command('hash-object', '--literally', '-t', 'commit', '-w', path)
  expect(await f.check(head)).not.toEqual({ kind: 'allow' })
})

test('an IBM037 encoded trailer that Git decodes is refused', async () => {
  const f = await fixture()
  const tree = await f.command('rev-parse', `${f.base}^{tree}`)
  const path = join(f.repo, 'encoded-commit')
  // IBM037 bytes for "Test\n\nClaude-Session: synthetic\n"; no iconv executable needed.
  const message = Buffer.from('e385a2a32525c39381a4848560e285a2a28996957a40a2a895a38885a3898325', 'hex')
  await writeFile(path, Buffer.concat([Buffer.from(`tree ${tree}\nparent ${f.base}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\nencoding IBM037\n\n`), message]))
  const head = await f.command('hash-object', '-t', 'commit', '-w', path)
  expect(await f.command('show', '--encoding=UTF-8', '-s', '--format=%B', head)).toMatch(/^Claude-Session: synthetic$/m)
  expect(await f.check(head)).toMatchObject({ kind: 'unknown' })
})

test('validated UTF-8 messages allow clean non-ASCII text and refuse invalid or unsupported encodings', async () => {
  const f = await fixture()
  const tree = await f.command('rev-parse', `${f.base}^{tree}`)
  for (const encoding of ['', 'encoding UTF-8\n', 'encoding utf8\n', 'encoding unknown\n', 'encoding ISO-8859-1\n', 'encoding UTF-8\nencoding IBM037\n']) {
    const path = join(f.repo, 'encoding-control')
    await writeFile(path, `tree ${tree}\nparent ${f.base}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n${encoding}\nClean café\n\nMention Claude-Session as data.\n\nCo-Authored-By: Fixture <fixture@example.invalid>\n`)
    const head = await f.command('hash-object', '-t', 'commit', '-w', path)
    const supported = ['', 'encoding UTF-8\n', 'encoding utf8\n'].includes(encoding)
    expect(await f.check(head)).toMatchObject({ kind: supported ? 'allow' : 'unknown' })
  }
  const path = join(f.repo, 'invalid-utf8')
  await writeFile(path, Buffer.concat([Buffer.from(`tree ${tree}\nparent ${f.base}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nClean `), Buffer.from([0xff, 0x0a])]))
  const head = await f.command('hash-object', '-t', 'commit', '-w', path)
  expect(await f.check(head)).toMatchObject({ kind: 'unknown' })
})

test('a valid-prefix truncated enumeration cannot omit a dirty ancestor', async () => {
  const f = await fixture()
  await f.commit('Dirty ancestor\n\nClaude-Session: synthetic\n')
  const head = await f.commit('Clean tip\n')
  const run: RunHostCommand = async (argv, cwd, env) => {
    const result = await spawnCapture(argv, cwd, env)
    if (result.ok && argv.includes('log')) {
      await writeFile(argv.find(arg => arg.startsWith('--output='))!.slice('--output='.length), `${head}\n`)
    }
    return result
  }
  expect(await f.check(head, run)).toMatchObject({ kind: 'unknown' })
  expect(await f.check(head)).toMatchObject({ kind: 'blocked' })
})

test('rejects wrong range, aliases, missing objects, reversed ancestry and shallow history', async () => {
  const f = await fixture()
  const head = await f.commit('Clean\n')
  for (const pin of ['HEAD', '--output=wrong', '0'.repeat(40)]) expect(await f.check(pin)).toMatchObject({ kind: 'unknown' })
  expect(await commitMessageReadiness(spawnCapture, f.repo, head, f.base)).toMatchObject({ kind: 'unknown' })
  await f.command('checkout', '--orphan', 'unrelated')
  expect(await f.check(await f.commit('Unrelated\n'))).toMatchObject({ kind: 'unknown' })
  await writeFile(join(f.repo, '.git', 'shallow'), `${head}\n`)
  expect(await f.check(head)).toMatchObject({ kind: 'unknown' })
})

test('git errors, timeouts and missing or malformed file evidence fail closed without disclosing messages', async () => {
  const f = await fixture()
  const head = await f.commit('Clean\n')
  for (const fault of ['rev-parse', 'merge-base', 'log', 'rev-list', 'hash-object', 'object-read', 'wrong-object', 'timeout', 'missing-file', 'empty-file', 'malformed-file', 'count-timeout', 'count-empty', 'count-malformed', 'count-unsafe']) {
    const run: RunHostCommand = async (argv, cwd, env) => {
      if (argv.includes(fault)) return { ok: false, stdout: 'private-message', stderr: 'private-message', exit_code: 128 }
      if (argv.includes('rev-list') && fault.startsWith('count-')) return {
        ok: true, stdout: fault === 'count-empty' ? '' : fault === 'count-malformed' ? '1junk' : fault === 'count-unsafe' ? '9007199254740993' : '1',
        stderr: '', exit_code: 0, ...(fault === 'count-timeout' ? { timed_out: true } : {}),
      }
      if (argv[0] === 'bash' && fault === 'object-read') return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      if (argv[0] === 'bash' && fault === 'wrong-object') {
        await writeFile(argv.at(-1)!, 'private-message')
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      }
      if (argv.includes('log') && ['timeout', 'missing-file', 'empty-file', 'malformed-file'].includes(fault)) {
        if (fault === 'timeout') return { ok: true, stdout: '', stderr: '', exit_code: 0, timed_out: true }
        const path = argv.find(arg => arg.startsWith('--output='))!.slice('--output='.length)
        if (fault === 'empty-file' || fault === 'malformed-file') await writeFile(path, fault === 'empty-file' ? '' : 'private-message')
        return { ok: true, stdout: '', stderr: '', exit_code: 0 }
      }
      return spawnCapture(argv, cwd, env)
    }
    const result = await f.check(head, run)
    expect(result).toMatchObject({ kind: 'unknown' })
    expect(JSON.stringify(result)).not.toContain('private-message')
  }
})

test('the measurement uses the supplied immutable pins and the range-operand shield', async () => {
  const f = await fixture()
  const head = await f.commit('Clean\n')
  await f.commit('Later unreviewed\n\nClaude-Session: later\n')
  const calls: string[][] = []
  expect(await f.check(head, async (argv, cwd, env) => {
    calls.push([...argv])
    return spawnCapture(argv, cwd, env)
  })).toEqual({ kind: 'allow' })
  const log = calls.find(argv => argv.includes('log'))!
  expect(log.slice(-2)).toEqual(['--end-of-options', `${f.base}..${head}`])
  expect(log).toContain('--no-replace-objects')
})
