/**
 * THE COMMITTED MUTATION NOMINATION, READ BACK OUT OF GIT.
 *
 * A build commits its nomination to `.trident/mutation-claims/<branch>.json`
 * alongside its work; the gate call site reads that blob when the in-result
 * claim is null. The channel is a committed blob because it is the only one that
 * survives every process boundary the build crosses (in pr mode the workflow
 * process ENDS at each publish handoff and the resumed process re-enters with a
 * null claim).
 *
 * Four invariants govern this reader:
 *
 * (a) THE PATH IS PER-BRANCH, and the blob must be IN THIS BRANCH'S DIFF. A
 *     fixed tracked path inherits: once one branch merges it, every later branch
 *     starts life already holding that file, and "this build nominated nothing"
 *     silently becomes "reuse whatever the last PR nominated". Both halves are
 *     load-bearing — the per-branch path (mirroring `.trident/plans/<branch>.md`)
 *     also stops concurrent lanes colliding on one file, and the diff-membership
 *     check still catches the case a branch NAME is reused after its predecessor
 *     merged. A blob the branch did not touch reads as null.
 *
 * (b) The artifact is BRANCH-CONTROLLED, UNTRUSTED input. It is shape-decoded
 *     here by `parseMutationClaim` and NOTHING more — exactly as permissive as
 *     the agent route's decode (`mutation_claim: parseMutationClaim(...)`), so a
 *     nomination arriving this way is validated and actually RUN by the gate on
 *     byte-for-byte the same terms as an agent-supplied one. Validating here
 *     would fork the two routes' semantics.
 *
 * (c) ABSENCE IN ANY FORM DECODES TO NULL — missing file, unreadable revision,
 *     oversized object, malformed JSON, wrong shape. Null is what the gate
 *     already refuses. This reader can never turn a failure into a pass. Each
 *     null carries a `note` saying WHICH failure it was, because the card this
 *     module exists for records that the undifferentiated refusal was
 *     misdiagnosed for days as an agent omission.
 *
 * (d) Every git operand is SANITIZED BEFORE it may touch git: the branch must
 *     pass `isPlainBranchName` (it is both the path segment and the ref), the
 *     base must too, and a revision is either a 40-hex OID or a full
 *     `refs/...` path — else no command is run at all.
 */

import { changedFilesOnBranch, isPlainBranchName, parseMutationClaim, type MutationClaim } from './mutation-prover.ts'
import type { RunHostCommand } from './merge.ts'

/** Directory the per-branch nominations live under — one file per branch. */
export const MUTATION_CLAIM_ARTIFACT_DIR = '.trident/mutation-claims'

/** Byte cap on the blob — branch-controlled input must not flood the harvester. */
export const MUTATION_CLAIM_ARTIFACT_MAX_BYTES = 32 * 1024

/** A full object id, the only form accepted without a ref prefix. */
const FULL_OID = /^[0-9a-f]{40}$/

/**
 * The repo-relative path THIS branch's nomination must live at, or null when the
 * branch name is not one this module will put in a path or hand to git.
 */
export function mutationClaimArtifactPath(branch: string | null | undefined): string | null {
  const b = typeof branch === 'string' ? branch.trim() : ''
  if (b.length === 0 || !isPlainBranchName(b)) return null
  return `${MUTATION_CLAIM_ARTIFACT_DIR}/${b}.json`
}

/** The read's outcome: the claim (null for every failure) and WHY it is null. */
export interface CommittedMutationClaimRead {
  claim: MutationClaim | null
  /** A short, human-readable account of the read — appended to the gate's refusal. */
  note: string
}

/**
 * Read the nomination a build committed, at the revision the gate pins.
 *
 * Prefers `expected_head` (the reviewed OID — it binds the nomination to the
 * very commit the gate proves against); falls back to the local branch ref and
 * then its origin remote-tracking ref, because the worktree holding the local
 * branch is routinely cleaned before the gate runs (the same reason
 * `resolveMergeHeadSha` carries that fallback). Returns a null claim for
 * everything else, and never throws.
 */
export async function readCommittedMutationClaim(
  run_host: RunHostCommand,
  repo_path: string,
  source: { expected_head?: string | null; branch?: string | null; base_branch?: string | null },
): Promise<CommittedMutationClaimRead> {
  const branch = typeof source.branch === 'string' ? source.branch.trim() : ''
  const path = mutationClaimArtifactPath(branch)
  if (path === null) {
    return { claim: null, note: `no committed nomination: ${JSON.stringify(branch)} is not a plain branch name` }
  }
  const base = typeof source.base_branch === 'string' ? source.base_branch.trim() : ''
  if (base.length === 0 || !isPlainBranchName(base)) {
    return { claim: null, note: `no committed nomination: ${JSON.stringify(base)} is not a plain base branch name` }
  }

  const oid = typeof source.expected_head === 'string' ? source.expected_head.trim().toLowerCase() : ''
  // The `refs/heads/` and `refs/remotes/` prefixes are load-bearing: with
  // isPlainBranchName's leading-dash and colon rejections they keep the operand
  // a ref PATH, never an option and never a refspec.
  const revisions = FULL_OID.test(oid) ? [oid] : [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]

  const notes: string[] = []
  for (const revision of revisions) {
    const read = await readAtRevision(run_host, repo_path, revision, path, base)
    if (read.claim !== null) return read
    notes.push(read.note)
  }
  return { claim: null, note: notes.join('; ') }
}

async function readAtRevision(
  run_host: RunHostCommand,
  repo_path: string,
  revision: string,
  path: string,
  base: string,
): Promise<CommittedMutationClaimRead> {
  const at = `${revision}:${path}`
  try {
    // (1) THE BLOB MUST BE PART OF THIS BRANCH'S OWN DIFF. A tracked file that
    // merely came along from the base is not a nomination this build made.
    const changed = await changedFilesOnBranch(run_host, repo_path, base, revision)
    if (changed === null) {
      return { claim: null, note: `no committed nomination: could not read the diff ${base}...${revision}` }
    }
    if (!changed.includes(path)) {
      return { claim: null, note: `no committed nomination: ${path} is not in the diff ${base}...${revision}` }
    }

    // (2) SIZE THE OBJECT BEFORE ITS BODY CROSSES THE PROCESS BOUNDARY. Checking
    // the length of an already-captured stdout does not bound the read at all
    // (the host buffers the whole child output first, and trims it), so the cap
    // is applied to git's own record of the blob.
    const sized = await run_host(['git', '-C', repo_path, 'cat-file', '-s', at], repo_path)
    if (!sized.ok) return { claim: null, note: `no committed nomination committed at ${at}` }
    const size = Number.parseInt(sized.stdout.trim(), 10)
    if (!Number.isFinite(size)) {
      return { claim: null, note: `no committed nomination: unreadable object size for ${at}` }
    }
    if (size > MUTATION_CLAIM_ARTIFACT_MAX_BYTES) {
      return {
        claim: null,
        note: `committed nomination at ${at} is ${size} bytes, over the ${MUTATION_CLAIM_ARTIFACT_MAX_BYTES}-byte cap`,
      }
    }

    const res = await run_host(['git', '-C', repo_path, 'show', at], repo_path)
    if (!res.ok) return { claim: null, note: `no committed nomination committed at ${at}` }
    const claim = parseMutationClaim(JSON.parse(res.stdout))
    if (claim === null) {
      return { claim: null, note: `committed nomination at ${at} is not a well-formed nomination` }
    }
    return { claim, note: `committed nomination read from ${at}` }
  } catch {
    return { claim: null, note: `committed nomination at ${at} could not be read` }
  }
}
