import type { BuildSnapshot, GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'
import { sessionTrailerReadiness } from './release-readiness.ts'
import { unknownCause } from './unknown-cause.ts'

const fullOid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })

/** G100: independently resolve the claim, then preserve before refusing review.
 *
 * `launchBase` is the run's pinned launch base (the same value `publicationReadiness` scans
 * from): the preservation push is an origin-facing push of the build branch, so it carries the
 * #1133 (G166) session-trailer scan the other publishers carry. A claim that differs from the
 * measured head is exactly the state the commit wrapper's provenance refusal (exit 76) leaves
 * behind -- Forge reports the sha it created while the branch names a later commit -- and the
 * commit it created may carry the trailer; preserving that branch would publish it.
 */
export async function checkBuildClaim(run: RunHostCommand, repo: string, branch: string, launchBase: string,
  claim: string, snapshot: BuildSnapshot, runId: string): Promise<GateResult> {
  try {
    if (!fullOid(snapshot.head)) return unknown('Measured build head is not a full commit OID')
    const ref = `refs/heads/${branch}`
    const valid = await run(['git', 'check-ref-format', ref], repo)
    if (!valid.ok) return unknown('Build branch reference is invalid')
    const resolved = await run(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${claim}^{commit}`], repo)
    // Quiet rev-parse exit 1 establishes that this claim names no commit.
    if (!resolved.ok && resolved.exit_code === 1 && !resolved.timed_out) return { kind: 'allow' }
    if (!resolved.ok || !fullOid(resolved.stdout.trim())) return unknown('Build claim could not be resolved')
    if (resolved.stdout.trim().toLowerCase() === snapshot.head.toLowerCase()) return { kind: 'allow' }
    const conflict = `Build claim ${claim} resolves to ${resolved.stdout.trim()} but measured head is ${snapshot.head}`
    const observed = await run(['git', '-C', repo, 'ls-remote', '--heads', 'origin', ref], repo)
    if (!observed.ok) return unknown('Preservation remote head could not be read')
    const parse = (text: string): string | null => {
      if (!text.trim()) return ''
      const fields = text.trim().split(/\s+/)
      return fields.length === 2 && fields[1] === ref && fullOid(fields[0]!) ? fields[0]! : null
    }
    const before = parse(observed.stdout)
    if (before === null) return unknown('Preservation remote head is malformed')
    if (before !== snapshot.head) {
      // #1133 (G166): scan launchBase..head for a `Claude-Session:` line BEFORE the push. The
      // claim conflict is already measured, so the refusal stands either way; what the scan
      // decides is whether the branch may reach origin. A carrier, or a range that cannot be
      // measured, means it may not: nothing is pushed and the refusal says so, naming why.
      const trailers = await sessionTrailerReadiness(run, repo, launchBase, snapshot.head)
      if (trailers.kind !== 'allow') {
        return { kind: 'blocked', on: `${conflict}; branch NOT preserved on origin: ${trailers.kind === 'blocked' ? trailers.on : trailers.detail}` }
      }
      // Push the measured object, never a branch that can move after measurement.
      const pushed = await run(['git', '-C', repo, 'push', `--force-with-lease=${ref}:${before}`, 'origin', `${snapshot.head}:${ref}`], repo)
      if (!pushed.ok) return unknown('Build branch preservation push was not confirmed')
      const receipt = await run(['git', '-C', repo, 'ls-remote', '--heads', 'origin', ref], repo)
      if (!receipt.ok || parse(receipt.stdout) !== snapshot.head) return unknown('Build branch preservation receipt does not match measured head')
    }
    return { kind: 'blocked', on: `${conflict}; branch preserved on origin` }
  } catch (error) { return unknownCause('Build claim resolution or preservation failed', error, runId) }
}
