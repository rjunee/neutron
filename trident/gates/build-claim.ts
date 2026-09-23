import type { BuildSnapshot, GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'
import { sessionTrailerReadiness } from './release-readiness.ts'
import { unknownCause } from './unknown-cause.ts'

/** #1133 round 25 (round-24 review nit): case-SENSITIVE, matching `release-readiness.ts`'s
 * `fullOid` exactly. This module carried `/i` and that one does not, so the two G166-facing
 * gates disagreed about the same value — the scan refuses an uppercase head as "not a full OID"
 * while this gate accepted one and went on to ask git about it. Git only ever emits lowercase
 * object names, so the stricter form is the measured one and they agree on it now.
 */
const fullOid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })

/** G100: independently resolve the claim, then preserve before refusing review.
 *
 * The preservation push is G100's guarantee (`docs/trident-gates-inventory.md`, G100): a real
 * claim/head disagreement refuses PR creation and review AFTER the measured branch is on
 * origin, so good work is never stranded by the refusal. Owner decision 2026-09-19: G100 is
 * not superseded by G166 -- the push happens whatever the scan finds.
 *
 * `launchBase` is the run's pinned launch base (the same value `publicationReadiness` scans
 * from). The push is an origin-facing push of the build branch, so it runs the #1133 (G166)
 * session-trailer scan the other publishers run, and it runs it BEFORE the push over the same
 * raw objects the push publishes. A claim that differs from the measured head is exactly the
 * state the commit wrapper's provenance refusal (exit 76) leaves behind -- Forge reports the
 * sha it created while the branch names a later commit -- and the commit it created may carry
 * the trailer. On THIS path the scan observes and names; it does not veto: the refusal already
 * stands (no PR, no review), and it carries the carriers or the unmeasured detail so the branch
 * is stripped before anything is published as a PR. The checked publishers and the salvage
 * push (`release-readiness.ts`, `publication.ts`) stay fail-closed; G100 is the one push whose
 * job is to preserve, and it preserves.
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
    let scanned = ''
    if (before !== snapshot.head) {
      // #1133 (G166): scan launchBase..head for a `Claude-Session:` line BEFORE the push, over
      // the raw objects the push publishes. The claim conflict is already measured, so the
      // refusal stands either way. The scan never withholds the push (G100 preserves; owner
      // decision 2026-09-19): a carrier, or a range that could not be measured, is NAMED in the
      // refusal so the branch is stripped before any PR, and the observation is not a veto.
      let trailers: GateResult
      try {
        trailers = await sessionTrailerReadiness(run, repo, launchBase, snapshot.head)
      } catch (error) {
        // Host exceptions are unmeasured scans too. Contain only the advisory scan:
        // claim resolution, the lease and the push receipt must still fail closed.
        trailers = unknownCause('Session-trailer host observation failed', error, runId)
      }
      if (trailers.kind === 'blocked') scanned = `; preserved range: ${trailers.on} -- strip before any PR`
      else if (trailers.kind === 'unknown') scanned = `; session-trailer scan unmeasured: ${trailers.detail}`
      // Push the measured object, never a branch that can move after measurement.
      const pushed = await run(['git', '-C', repo, 'push', `--force-with-lease=${ref}:${before}`, 'origin', `${snapshot.head}:${ref}`], repo)
      if (!pushed.ok) return unknown('Build branch preservation push was not confirmed')
      const receipt = await run(['git', '-C', repo, 'ls-remote', '--heads', 'origin', ref], repo)
      if (!receipt.ok || parse(receipt.stdout) !== snapshot.head) return unknown('Build branch preservation receipt does not match measured head')
    }
    return { kind: 'blocked', on: `${conflict}; branch preserved on origin${scanned}` }
  } catch (error) { return unknownCause('Build claim resolution or preservation failed', error, runId) }
}
