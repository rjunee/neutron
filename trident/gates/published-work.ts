import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const graph = ['--no-replace-objects', '--shallow-file', '/dev/null', '-c', 'core.commitGraph=false', '-c', 'advice.graftFileDeprecated=false']
const env = { GIT_GRAFT_FILE: '/dev/null' }
const snapshotBytes = 512 * 1024 * 1024
const snapshotMs = 60_000
// The runner merges its environment. Explicitly remove inherited object stores
// and repository selectors, including alternates, before Git sees this snapshot.
const clean = ['env', ...['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE',
  'GIT_CONFIG'].flatMap(key => ['-u', key])]
const isolated = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_ATTR_NOSYSTEM: '1',
  BASH_ENV: '/dev/null', ENV: '/dev/null' }
const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })
const lost = (): GateResult => ({ kind: 'blocked', on: 'Publication would discard previously published work; reconcile the observed branch before publishing' })

/** The same observed OID must be used by the caller's exact push lease. A clean
 * three-way merge whose tree is already the candidate proves content inclusion
 * without requiring rewritten commits to retain their old OIDs. No ref is moved.
 */
export async function publishedWorkPreserved(run: RunHostCommand, repo: string, expected: string, candidate: string): Promise<GateResult> {
  let scratch: string | undefined
  const deadline = performance.now() + snapshotMs
  try {
    if (!oid.test(candidate) || (expected !== '' && !oid.test(expected))) return unknown('Publication preservation identity is malformed')
    if (expected === '' || expected === candidate) return { kind: 'allow' }
    const command = async (args: string[]) => {
      const remaining = Math.floor(deadline - performance.now())
      if (remaining <= 0) throw Error('Preservation snapshot deadline exceeded')
      const result = await run(args, repo, isolated, remaining)
      if (result.timed_out || performance.now() >= deadline) throw Error('Preservation snapshot deadline exceeded')
      return result
    }
    const git = (args: string[]) => command([...clean, 'git', '-C', repo, ...graph, ...args])
    let present = await git(['cat-file', '-e', `${expected}^{commit}`])
    if (!present.ok || present.timed_out) {
      const fetched = await git(['fetch', '--no-tags', 'origin', expected])
      if (!fetched.ok || fetched.timed_out) return unknown('Previously published commit could not be fetched')
      present = await git(['cat-file', '-e', `${expected}^{commit}`])
      if (!present.ok || present.timed_out) return unknown('Previously published commit is unavailable')
    }
    // Copy and independently validate the complete reachable object closure.
    // Mutable alternates (even with an isolated config) are not evidence: objects
    // used by ancestry and merge must have authenticated, stable identities.
    scratch = await mkdtemp(join(tmpdir(), 'trident-preservation-'))
    const initialized = await command([...clean, 'git', 'init', '--bare', '--template=', `--object-format=${candidate.length === 64 ? 'sha256' : 'sha1'}`, scratch])
    if (!initialized.ok || initialized.timed_out) return unknown('Publication preservation workspace is unavailable')
    const roots = join(scratch, 'roots'), pack = join(scratch, 'snapshot.pack'), index = join(scratch, 'snapshot.idx')
    await writeFile(roots, `${expected}\n${candidate}\n`, { flag: 'wx' })
    // Bash's file limit is in KiB. exec makes the host watchdog own Git itself,
    // not a shell leaving the expensive producer alive after timeout. Reuse
    // compressed objects; independent indexing/fsck below does not trust them.
    const packed = await command(['bash', '--noprofile', '--norc', '-c',
      'ulimit -c 0; ulimit -f "$1" || exit; output=$2; input=$3; shift 3; exec "$@" < "$input" > "$output"',
      '--', String(snapshotBytes / 1024), pack, roots, ...clean, 'git', '-C', repo, ...graph,
      'pack-objects', '--stdout', '--revs', '--no-use-bitmap-index', '--window=0', '--threads=1'])
    if (!packed.ok) return unknown('Publication preservation snapshot could not be captured')
    const packSize = (await stat(pack)).size
    const indexBudget = Math.floor((snapshotBytes - packSize) / 1024)
    if (packSize <= 0 || indexBudget <= 0) return unknown('Publication preservation snapshot exceeds size budget')
    const indexed = await command(['bash', '--noprofile', '--norc', '-c',
      'ulimit -c 0; ulimit -f "$1" || exit; shift; exec "$@"', '--', String(indexBudget),
      ...clean, 'git', '--git-dir', scratch, ...graph, 'index-pack', '--threads=1', '-o', index, pack])
    if (!indexed.ok || !oid.test(indexed.stdout.trim())) return unknown('Publication preservation snapshot could not be indexed')
    if (packSize + (await stat(index)).size > snapshotBytes) return unknown('Publication preservation snapshot exceeds size budget')
    const stem = join(scratch, 'objects', 'pack', `pack-${indexed.stdout.trim()}`)
    await rename(pack, `${stem}.pack`)
    await rename(index, `${stem}.idx`)
    const measure = (args: string[]) => command([...clean, 'git', '--git-dir', scratch!, ...graph, '-c', 'core.attributesFile=/dev/null', ...args])
    // Validate only after installing the independently generated index so fsck
    // can read all delta-compressed attribute blobs too. No decision uses the
    // snapshot until full strict validation and both original root checks pass.
    const checked = await measure(['fsck', '--strict', '--full', '--no-reflogs', '--no-dangling', expected, candidate])
    if (!checked.ok) return unknown('Publication preservation snapshot integrity could not be verified')
    for (const root of [expected, candidate]) {
      const verified = await measure(['rev-parse', '--verify', `${root}^{commit}`])
      if (!verified.ok || verified.stdout.trim() !== root) return unknown('Publication preservation snapshot root could not be verified')
    }
    const ancestor = await measure(['merge-base', '--is-ancestor', '--end-of-options', expected, candidate])
    if (ancestor.ok) return { kind: 'allow' }
    if (ancestor.exit_code !== 1) return unknown('Publication preservation ancestry is unreadable')
    const fork = await measure(['merge-base', '--all', expected, candidate])
    if (!fork.ok || fork.timed_out || !oid.test(fork.stdout.trim())) return unknown('Publication preservation requires one provable fork point')
    const merged = await measure(['merge-tree', '--write-tree', '--no-messages', candidate, expected])
    if (merged.timed_out || (!merged.ok && merged.exit_code !== 1)) return unknown('Publication preservation tree could not be measured')
    if (!merged.ok) return lost()
    const tree = await measure(['rev-parse', '--verify', `${candidate}^{tree}`])
    if (!tree.ok || tree.timed_out || !oid.test(tree.stdout.trim()) || !oid.test(merged.stdout.trim())) return unknown('Publication preservation tree is malformed')
    return tree.stdout.trim() === merged.stdout.trim() ? { kind: 'allow' } : lost()
  } catch { return unknown('Publication preservation observation failed') }
  finally { if (scratch) await rm(scratch, { recursive: true, force: true }) }
}
