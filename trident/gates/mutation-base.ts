import type { BaseIntegration, BuildSnapshot, GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'

/** A newer mutation range needs durable host provenance and a current actual PR
 * base. Keep the launch pin for history, trailers and every other release gate. */
export async function mutationBaseReadiness(run: RunHostCommand, repo: string, branch: string,
  baseBranch: string, snapshot: BuildSnapshot, integration: BaseIntegration): Promise<GateResult> {
  const unknown = (): GateResult => ({ kind: 'unknown', detail: 'Integrated mutation base provenance is missing, changed or unreadable' })
  const oid = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
  try {
    if (!integration || !oid(integration.head) || !oid(integration.baseHead) || !oid(integration.integratedHead)
      || integration.head === integration.integratedHead || integration.base !== baseBranch
      || !Array.isArray(integration.overlap) || !integration.overlap.length
      || !integration.overlap.every(path => typeof path === 'string' && path.trim())
      || !snapshot.pr || snapshot.pr.state !== 'OPEN' || !Number.isSafeInteger(integration.pr)
      || integration.pr <= 0 || integration.pr !== snapshot.pr.number) return unknown()
    const result = await run(['gh', 'pr', 'view', String(integration.pr), '--json',
      'number,headRefName,headRefOid,baseRefName,baseRefOid,isCrossRepository,state'], repo)
    if (!result.ok || result.timed_out) return unknown()
    const pr = JSON.parse(result.stdout)
    if (pr?.number !== integration.pr || pr.state !== 'OPEN' || pr.isCrossRepository !== false
      || pr.headRefName !== branch || pr.headRefOid !== snapshot.pr.head
      || pr.baseRefName !== baseBranch || pr.baseRefOid !== integration.baseHead) return unknown()
    for (const [ancestor, descendant] of [[integration.head, integration.integratedHead],
      [integration.baseHead, integration.integratedHead], [integration.integratedHead, snapshot.head]]) {
      const ancestry = await run(['git', '-C', repo, 'merge-base', '--is-ancestor', ancestor!, descendant!], repo)
      if (!ancestry.ok || ancestry.timed_out) return unknown()
    }
    return { kind: 'allow' }
  } catch { return unknown() }
}
