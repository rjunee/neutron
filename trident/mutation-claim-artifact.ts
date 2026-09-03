/**
 * THE COMMITTED MUTATION NOMINATION, READ BACK OUT OF GIT.
 *
 * A build commits its nomination to `.trident/mutation-claim.json` alongside its
 * work; the gate call site reads that blob when the in-result claim is null. The
 * channel is a committed blob because it is the only one that survives every
 * process boundary the build crosses (in pr mode the workflow process ENDS at
 * each publish handoff and the resumed process re-enters with a null claim).
 *
 * Three invariants govern this reader:
 *
 * (a) The artifact is BRANCH-CONTROLLED, UNTRUSTED input. It is shape-decoded
 *     here by `parseMutationClaim` and NOTHING more — exactly as permissive as
 *     the agent route's decode (`mutation_claim: parseMutationClaim(...)`), so a
 *     nomination arriving this way is validated and actually RUN by the gate on
 *     byte-for-byte the same terms as an agent-supplied one. Validating here
 *     would fork the two routes' semantics.
 *
 * (b) ABSENCE IN ANY FORM DECODES TO NULL — missing file, unreadable revision,
 *     oversized body, malformed JSON, wrong shape. Null is what the gate already
 *     refuses. This reader can never turn a failure into a pass.
 *
 * (c) The revision argument is SANITIZED BEFORE it may touch git: a 40-hex OID,
 *     else `refs/heads/<branch>` for a branch name that passes
 *     `isPlainBranchName`, else no command is run at all.
 */

import { isPlainBranchName, parseMutationClaim, type MutationClaim } from './mutation-prover.ts'
import type { RunHostCommand } from './merge.ts'

/** Repo-relative path the build contract asks Forge to commit its nomination to. */
export const MUTATION_CLAIM_ARTIFACT_PATH = '.trident/mutation-claim.json'

/** Byte cap on the blob — branch-controlled input must not flood the harvester. */
export const MUTATION_CLAIM_ARTIFACT_MAX_BYTES = 32 * 1024

/** A full object id, the only form accepted without a ref prefix. */
const FULL_OID = /^[0-9a-f]{40}$/

/**
 * Read the nomination a build committed, at the revision the gate pins.
 *
 * Prefers `expected_head` (the reviewed OID — it binds the nomination to the
 * very commit the gate proves against); falls back to the branch tip. Returns
 * null for everything else, and never throws.
 */
export async function readCommittedMutationClaim(
  run_host: RunHostCommand,
  repo_path: string,
  source: { expected_head?: string | null; branch?: string | null },
): Promise<MutationClaim | null> {
  const oid = typeof source.expected_head === 'string' ? source.expected_head.trim().toLowerCase() : ''
  let revision: string | null = null
  if (FULL_OID.test(oid)) {
    revision = oid
  } else {
    const b = typeof source.branch === 'string' ? source.branch.trim() : ''
    // The `refs/heads/` prefix is load-bearing: with isPlainBranchName's
    // leading-dash and colon rejections it keeps the operand a ref PATH, never
    // an option and never a refspec.
    if (b.length > 0 && isPlainBranchName(b)) revision = `refs/heads/${b}`
  }
  if (revision === null) return null

  try {
    const res = await run_host(['git', '-C', repo_path, 'show', `${revision}:${MUTATION_CLAIM_ARTIFACT_PATH}`])
    if (!res.ok) return null
    // Cap BEFORE parsing — the cap exists so JSON.parse never runs on an
    // unbounded body.
    if (Buffer.byteLength(res.stdout, 'utf8') > MUTATION_CLAIM_ARTIFACT_MAX_BYTES) return null
    return parseMutationClaim(JSON.parse(res.stdout))
  } catch {
    return null
  }
}
