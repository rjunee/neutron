import type { GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'

/** G084: check the produced head before replay rewrites its ancestry. */
export async function fixLineage(
  run: RunHostCommand, repo: string, branch: string, reviewedHead: string | null, producedHead: string,
): Promise<GateResult> {
  if (reviewedHead === null) return { kind: 'allow' }
  const pin = reviewedHead.trim().toLowerCase()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pin)) {
    return { kind: 'blocked', on: `fix-round refused: the reviewed-head pin '${reviewedHead}' is not a full 40- or 64-hex commit; refusing to publish ${producedHead} unverified` }
  }
  try {
    // Equality is accepted by git itself; no separate resume exemption.
    const ancestry = await run(['git', '-C', repo, 'merge-base', '--is-ancestor', pin, producedHead], repo)
    if (!ancestry.ok) {
      const detail = ancestry.stderr.trim()
      return detail === ''
        ? { kind: 'blocked', on: `fix-round refused: produced head ${producedHead} of branch ${branch} does not descend from the reviewed head ${pin} — the round abandoned the reviewed branch` }
        : { kind: 'unknown', detail: `fix-round refused: could not verify that produced head ${producedHead} descends from reviewed head ${pin} (${detail}); refusing to publish unverified` }
    }
    return { kind: 'allow' }
  } catch (error) {
    return { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) }
  }
}
