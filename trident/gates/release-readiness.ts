import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitRangeArgv } from '../git-range.ts'
import { MERGE_DIFF_BYTES_MAX, mergeDiffTooLargeReason } from '../merge-diff-limit.ts'
import type { BuildSnapshot, GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'
import { assessBaseDrift, shouldHoldForBaseDrift } from '../merge.ts'
import { unknownCause } from './unknown-cause.ts'

const fullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })
const blocked = (on: string): GateResult => ({ kind: 'blocked', on })

/** G083, G085, G086: measure the branch and launch ancestry before publication.
 * Lease enforcement and the post-push witness stay in the publication effect.
 */
export async function publicationReadiness(
  run: RunHostCommand, repo: string, branch: string, launchBase: string, snapshot: BuildSnapshot, runId: string,
): Promise<GateResult> {
  try {
    const local = await run(['git', '-C', repo, 'rev-parse', '--verify', `refs/heads/${branch}`], repo)
    const head = local.stdout.trim()
    if (!local.ok || !fullOid.test(head)) return unknown('Publication branch head could not be resolved')
    if (head !== snapshot.head) return blocked('Publication branch differs from reviewed head')
    const remote = await run(['git', '-C', repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`], repo)
    if (!remote.ok) return unknown('Publication remote branch state could not be read')
    const rows = remote.stdout.trim()
    if (rows !== '' && !new RegExp(`^(?:[0-9a-f]{40}|[0-9a-f]{64})\\s+${escapeRegex(`refs/heads/${branch}`)}$`).test(rows)) {
      return unknown('Publication remote branch observation is malformed')
    }
    if (rows === '') {
      const ancestry = await run(['git', '-C', repo, 'merge-base', '--is-ancestor', launchBase, head], repo)
      if (!ancestry.ok) return ancestry.exit_code === 1
        ? blocked('Publication branch does not contain the pinned launch base')
        : unknown('Publication launch ancestry could not be established')
    }
    return { kind: 'allow' }
  } catch (error) { return unknownCause('Publication host observation failed', error, runId) }
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** G107, G108: use the PR's actual refs, never the configured default base.
 * The merge effect must enforce --match-head-commit (build-run.ts:195).
 */
export async function pinnedMergeReadiness(
  run: RunHostCommand, repo: string, snapshot: BuildSnapshot, runId: string,
): Promise<GateResult> {
  if (!fullOid.test(snapshot.head) || snapshot.pr === null || !Number.isSafeInteger(snapshot.pr.number) || snapshot.pr.number <= 0) {
    return blocked('Merge requires a PR number and full reviewed head OID')
  }
  if (snapshot.pr.state !== 'OPEN' || snapshot.pr.head !== snapshot.head) return blocked('Merge PR does not match the reviewed head')
  try {
    const observed = await run(['gh', 'pr', 'view', String(snapshot.pr.number), '--json', 'headRefName,baseRefName,isCrossRepository,headRefOid,state'], repo)
    if (!observed.ok) return unknown('Merge PR refs could not be read')
    const pr = JSON.parse(observed.stdout)
    if (typeof pr?.headRefName !== 'string' || !pr.headRefName || typeof pr.baseRefName !== 'string' || !pr.baseRefName || typeof pr.isCrossRepository !== 'boolean') {
      return unknown('Merge PR head, base or repository identity could not be established')
    }
    if (pr.isCrossRepository) return blocked('Merge head is in a different repository')
    if (pr.state !== 'OPEN' || pr.headRefOid !== snapshot.head) return blocked('Remote PR differs from reviewed head')
    for (const ref of [pr.baseRefName, pr.headRefName]) {
      const valid = await run(['git', 'check-ref-format', `refs/heads/${ref}`], repo)
      if (!valid.ok) return unknown('Merge PR ref could not be validated')
    }
    const base = `refs/remotes/origin/${pr.baseRefName}`
    const branch = `refs/remotes/origin/${pr.headRefName}`
    const fetched = await run(['git', '-C', repo, 'fetch', 'origin', `+refs/heads/${pr.baseRefName}:${base}`, `+refs/heads/${pr.headRefName}:${branch}`], repo)
    if (!fetched.ok) return unknown('Merge PR refs could not be refreshed')
    // Same file-backed measurement as merge.ts:203–238; stdout may be capped.
    const dir = await mkdtemp(join(tmpdir(), 'build-host-merge-diff-'))
    let bytes: number
    try {
      const path = join(dir, 'merge.diff')
      const diff = await run(gitRangeArgv({ repo_path: repo, subcommand: 'diff',
        flags: ['--binary', '--no-ext-diff', '--full-index', `--output=${path}`],
        base, head: branch, dots: '...',
      }), repo)
      if (!diff.ok) return unknown('Merge diff could not be read')
      bytes = (await stat(path)).size
    } finally { await rm(dir, { recursive: true, force: true }) }
    if (bytes > MERGE_DIFF_BYTES_MAX) return blocked(mergeDiffTooLargeReason(bytes))
    const drift = await assessBaseDrift(run, repo, base, branch)
    if (!drift.assessable) return unknown('Base drift could not be assessed')
    if (drift.branch_head_sha !== snapshot.head) return blocked('Fetched PR head differs from reviewed head')
    if (shouldHoldForBaseDrift(drift, new Set(), { hold_when_unassessable: true })) return blocked('Base drift overlaps reviewed changes')
    return { kind: 'allow' }
  } catch (error) { return unknownCause('Merge host observation could not be decoded', error, runId) }
}
