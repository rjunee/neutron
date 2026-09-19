import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'
import { gitRangeArgv } from '../git-range.ts'

const fullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const unreadable = (): GateResult => ({ kind: 'unknown', detail: 'Commit-message admission could not establish the complete pinned range' })

/** Check immutable objects, not the worker's report or the currently checked-out ref.
 * Both publication and merge must pass: an already published PR is not an exemption.
 */
export async function commitMessageReadiness(
  run: RunHostCommand, repo: string, base: string, head: string,
): Promise<GateResult> {
  if (!fullOid.test(base) || !fullOid.test(head) || base.length !== head.length) return unreadable()
  let dir: string | undefined
  try {
    // Replacement objects, legacy grafts and incomplete history must not conceal messages.
    const git = ['git', '-C', repo, '--no-replace-objects']
    const env = { GIT_GRAFT_FILE: '/dev/null' }
    const shallow = await run([...git, 'rev-parse', '--is-shallow-repository'], repo, env)
    if (!shallow.ok || shallow.timed_out || shallow.stdout.trim() !== 'false') return unreadable()
    for (const pin of [base, head]) {
      const resolved = await run([...git, 'rev-parse', '--verify', '--end-of-options', `${pin}^{commit}`], repo, env)
      if (!resolved.ok || resolved.timed_out || resolved.stdout.trim() !== pin) return unreadable()
    }
    const ancestry = await run([...git, 'merge-base', '--is-ancestor', base, head], repo, env)
    if (!ancestry.ok || ancestry.timed_out) return unreadable()
    dir = await mkdtemp(join(tmpdir(), 'build-commit-messages-'))
    const path = join(dir, 'commits')
    // Host runners may cap stdout. Git writes the entire measurement privately
    // to disk; neither messages nor stderr are included in gate diagnostics.
    const result = await run(gitRangeArgv({ repo_path: repo, config: ['--no-replace-objects'], subcommand: 'log',
      flags: ['--topo-order', '--no-show-signature', '--no-notes', '--no-decorate', '--no-color', '--encoding=none',
        '--format=%H', `--output=${path}`], base, head,
    }), repo, env)
    if (!result.ok || result.timed_out) return unreadable()
    const data = await readFile(path, 'utf8')
    const count = await run(gitRangeArgv({ repo_path: repo, config: ['--no-replace-objects'], subcommand: 'rev-list',
      flags: ['--count'], base, head,
    }), repo, env)
    const countText = count.stdout.trim()
    if (!count.ok || count.timed_out || !/^(?:0|[1-9]\d*)$/.test(countText) || !Number.isSafeInteger(Number(countText))) return unreadable()
    const commits = data === '' ? [] : data.trim().split('\n')
    // A successful log command with a valid prefix is not proof of complete history.
    if (commits.length !== Number(countText)) return unreadable()
    if (base === head) return commits.length === 0 ? { kind: 'allow' } : unreadable()
    if (commits[0] !== head) return unreadable()
    const seen = new Set<string>()
    for (const commit of commits) {
      if (!fullOid.test(commit) || commit.length !== head.length || commit === base || seen.has(commit)) return unreadable()
      seen.add(commit)
      // Pretty formats truncate a malformed message at NUL. Read the actual object,
      // with fixed shell text and positional arguments (never interpolated commands).
      const objectPath = join(dir, 'commit')
      const object = await run(['bash', '-c', 'exec git -C "$1" --no-replace-objects cat-file commit "$2" > "$3"',
        'commit-message-readiness', repo, commit, objectPath], repo, env)
      if (!object.ok || object.timed_out) return unreadable()
      const bytes = await readFile(objectPath)
      const hash = await run([...git, 'hash-object', '-t', 'commit', '--no-filters', objectPath], repo, env)
      if (!hash.ok || hash.timed_out || hash.stdout.trim() !== commit) return unreadable()
      const separator = bytes.indexOf('\n\n')
      if (separator < 0 || bytes.includes(0)) return unreadable()
      const encodings = bytes.subarray(0, separator).toString('latin1').split('\n')
        .filter(line => line.startsWith('encoding ')).map(line => line.slice('encoding '.length))
      // Git can transcode encodings such as EBCDIC whose bytes do not resemble the
      // token. Only validated UTF-8 is admitted, never an unchecked byte scan.
      if (encodings.length > 1 || encodings.some(encoding => !/^utf-?8$/i.test(encoding))) return unreadable()
      const message = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(separator + 2))
      if (/^Claude-Session:/mi.test(message)) {
        return { kind: 'blocked', on: 'Commit-message admission refuses a Claude-Session trailer in the pinned range' }
      }
    }
    return { kind: 'allow' }
  } catch {
    return unreadable()
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true })
  }
}
