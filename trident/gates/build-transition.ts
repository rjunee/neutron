import type { BuildSnapshot, GateResult } from '../build-run.ts'

/** G023: the assignment belongs to the host; a missing claim is not disagreement. */
export function builderBranch(assigned: string | undefined, payload: unknown): GateResult {
  if (!assigned?.trim()) return { kind: 'unknown', detail: 'Assigned builder branch is missing' }
  const claim = payload && typeof payload === 'object' && 'branch' in payload ? payload.branch : undefined
  const reported = typeof claim === 'string' ? claim.trim() : ''
  if (reported && reported !== assigned) return { kind: 'blocked', on: 'Reported builder branch disagrees with assigned branch' }
  return { kind: 'allow' }
}

/** G036: only a host-confirmed PR identity may terminate an already landed run. */
export function confirmedMerged(snapshot: BuildSnapshot, previousPr: BuildSnapshot['pr'] = null): boolean {
  const pr = snapshot.pr
  return pr !== null && pr.state === 'MERGED' && Number.isSafeInteger(pr.number) && pr.number > 0
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pr.head)
    && (previousPr === null || previousPr.number === pr.number)
}

/** G042: ask only after merge confirmation; a missing branch is not progress. */
export function fixLanded(before: string, after: string): boolean {
  const oid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.trim())
  return oid(before) && oid(after) && before.trim().toLowerCase() !== after.trim().toLowerCase()
}
