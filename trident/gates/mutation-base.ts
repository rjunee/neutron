import type { BaseIntegration, BuildSnapshot, GateResult } from '../build-run.ts'
import { assessBaseDrift, type RunHostCommand } from '../merge.ts'

/** A newer mutation range needs durable host provenance and a current actual PR
 * base. Keep the launch pin for history, trailers and every other release gate. */
export async function mutationBaseReadiness(run: RunHostCommand, repo: string, branch: string,
  baseBranch: string, snapshot: BuildSnapshot, integration: BaseIntegration, allowRefresh = false): Promise<GateResult> {
  const unknown = (): GateResult => ({ kind: 'unknown', detail: 'Integrated mutation base provenance is missing, changed or unreadable' })
  const oid = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
  try {
    if (!integration || !oid(integration.head) || !oid(integration.baseHead) || !oid(integration.integratedHead)
      || integration.head === integration.integratedHead || integration.base !== baseBranch
      || (integration.previousBaseHead !== undefined
        && (!oid(integration.previousBaseHead) || integration.previousBaseHead === integration.baseHead))
      || !Array.isArray(integration.overlap) || (!integration.overlap.length
        && (!oid(integration.previousBaseHead) || integration.previousBaseHead === integration.baseHead))
      || !integration.overlap.every(path => typeof path === 'string' && path.trim())
      || !snapshot.pr || snapshot.pr.state !== 'OPEN' || !Number.isSafeInteger(integration.pr)
      || integration.pr <= 0 || integration.pr !== snapshot.pr.number) return unknown()
    const readPr = () => run(['gh', 'pr', 'view', String(integration.pr), '--json',
      'number,headRefName,headRefOid,baseRefName,baseRefOid,isCrossRepository,state'], repo)
    const result = await readPr()
    if (!result.ok || result.timed_out) return unknown()
    const pr = JSON.parse(result.stdout)
    if (pr?.number !== integration.pr || pr.state !== 'OPEN' || pr.isCrossRepository !== false
      || pr.headRefName !== branch || pr.headRefOid !== snapshot.pr.head
      || pr.baseRefName !== baseBranch || !oid(pr.baseRefOid)) return unknown()
    for (const [ancestor, descendant] of [[integration.head, integration.integratedHead],
      [integration.baseHead, integration.integratedHead], [integration.integratedHead, snapshot.head],
      ...(integration.previousBaseHead ? [[integration.previousBaseHead, integration.baseHead]] : [])]) {
      const ancestry = await run(['git', '-C', repo, 'merge-base', '--is-ancestor', ancestor!, descendant!], repo)
      if (!ancestry.ok || ancestry.timed_out) return unknown()
    }
    if (pr.baseRefOid !== integration.baseHead) {
      if (!allowRefresh) return unknown()
      const valid = await run(['git', 'check-ref-format', `refs/heads/${baseBranch}`], repo)
      if (!valid.ok || valid.timed_out) return unknown()
      const fetched = await run(['git', '-C', repo, 'fetch', 'origin',
        `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], repo)
      if (!fetched.ok || fetched.timed_out) return unknown()
      const current = await run(['git', '-C', repo, 'rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`], repo)
      if (!current.ok || current.timed_out || current.stdout.trim() !== pr.baseRefOid) return unknown()
      const forward = await run(['git', '-C', repo, 'merge-base', '--is-ancestor', integration.baseHead, pr.baseRefOid], repo)
      if (!forward.ok || forward.timed_out) return unknown()
      const drift = await assessBaseDrift(run, repo, pr.baseRefOid, snapshot.head)
      if (!drift.assessable || !drift.moved || drift.current_base_sha !== pr.baseRefOid
        || drift.branch_head_sha !== snapshot.head) return unknown()
      const after = await readPr()
      if (!after.ok || after.timed_out || after.stdout !== result.stdout) return unknown()
      return { kind: 'blocked', on: 'Actual PR base advanced beyond the integrated mutation base',
        baseDrift: { head: snapshot.head, base: baseBranch, baseHead: pr.baseRefOid,
          previousBaseHead: integration.baseHead, overlap: drift.overlap } }
    }
    return { kind: 'allow' }
  } catch { return unknown() }
}
