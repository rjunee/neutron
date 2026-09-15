import type { BuildSnapshot, GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'
import { unknownCause } from './unknown-cause.ts'

const fullOid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })

/** G100: independently resolve the claim, then preserve before refusing review. */
export async function checkBuildClaim(run: RunHostCommand, repo: string, branch: string,
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
      // Push the measured object, never a branch that can move after measurement.
      const pushed = await run(['git', '-C', repo, 'push', `--force-with-lease=${ref}:${before}`, 'origin', `${snapshot.head}:${ref}`], repo)
      if (!pushed.ok) return unknown('Build branch preservation push was not confirmed')
      const receipt = await run(['git', '-C', repo, 'ls-remote', '--heads', 'origin', ref], repo)
      if (!receipt.ok || parse(receipt.stdout) !== snapshot.head) return unknown('Build branch preservation receipt does not match measured head')
    }
    return { kind: 'blocked', on: `Build claim ${claim} resolves to ${resolved.stdout.trim()} but measured head is ${snapshot.head}; branch preserved on origin` }
  } catch (error) { return unknownCause('Build claim resolution or preservation failed', error, runId) }
}
