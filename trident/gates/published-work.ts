import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import type { GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const graph = ['--no-replace-objects', '--shallow-file', '/dev/null', '-c', 'core.commitGraph=false', '-c', 'advice.graftFileDeprecated=false']
const env = { GIT_GRAFT_FILE: '/dev/null' }
const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })
const lost = (): GateResult => ({ kind: 'blocked', on: 'Publication would discard previously published work; reconcile the observed branch before publishing' })

/** The same observed OID must be used by the caller's exact push lease. A clean
 * three-way merge whose tree is already the candidate proves content inclusion
 * without requiring rewritten commits to retain their old OIDs. No ref is moved.
 */
export async function publishedWorkPreserved(run: RunHostCommand, repo: string, expected: string, candidate: string): Promise<GateResult> {
  let scratch: string | undefined
  try {
    if (!oid.test(candidate) || (expected !== '' && !oid.test(expected))) return unknown('Publication preservation identity is malformed')
    if (expected === '' || expected === candidate) return { kind: 'allow' }
    const git = (args: string[]) => run(['git', '-C', repo, ...graph, ...args], repo, env)
    let present = await git(['cat-file', '-e', `${expected}^{commit}`])
    if (!present.ok || present.timed_out) {
      const fetched = await git(['fetch', '--no-tags', 'origin', expected])
      if (!fetched.ok || fetched.timed_out) return unknown('Previously published commit could not be fetched')
      present = await git(['cat-file', '-e', `${expected}^{commit}`])
      if (!present.ok || present.timed_out) return unknown('Previously published commit is unavailable')
    }
    const ancestor = await git(['merge-base', '--is-ancestor', '--end-of-options', expected, candidate])
    if (ancestor.ok && !ancestor.timed_out) return { kind: 'allow' }
    if (ancestor.exit_code !== 1 || ancestor.timed_out) return unknown('Publication preservation ancestry is unreadable')

    // Isolate config, refs and merge drivers. In particular a checkout-configured
    // "ours" driver must never manufacture an identical tree and authorize loss.
    const objects = await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])
    if (!objects.ok || objects.timed_out || !isAbsolute(objects.stdout.trim()) || /[\r\n]/.test(objects.stdout.trim())) return unknown('Publication object directory is unreadable')
    scratch = await mkdtemp(join(tmpdir(), 'trident-preservation-'))
    const isolated = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_ATTR_NOSYSTEM: '1', GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects.stdout.trim()) }
    const initialized = await run(['git', 'init', '--bare', '--template=', `--object-format=${candidate.length === 64 ? 'sha256' : 'sha1'}`, scratch], repo, isolated)
    if (!initialized.ok || initialized.timed_out) return unknown('Publication preservation workspace is unavailable')
    const measure = (args: string[]) => run(['git', '--git-dir', scratch!, ...graph, '-c', 'core.attributesFile=/dev/null', ...args], repo, isolated)
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
