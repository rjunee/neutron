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
 *     THE MEMBERSHIP READ RESOLVES THE BASE AS A NAME, and is only as honest as
 *     the local ref that name finds: a base ref fallen behind its remote widens
 *     the range, and a REUSED branch name cut after its predecessor merged can
 *     then read the inherited blob as its own nomination. Rounds 9-10 pinned the
 *     base to close that and review REVERTED the pinning: trident's local merge
 *     path advances the local base ref and leaves the origin spelling STALE, so
 *     the union of both readings destroyed the prose exemption in local
 *     git-mode, and embedding a documented base like `HEAD~1` inside a remote
 *     ref path silently reinterpreted it. The stale-base read is therefore a
 *     RECORDED LIMITATION for its own card, bounded by the rules that hold on
 *     every round: the target must be production code in the branch diff, and
 *     the gate RUNS the mutation.
 *
 *     WHAT (a) DOES NOT CATCH, stated so nobody reads it as more than it is: a
 *     nomination going STALE WITHIN ONE BRANCH. A fix round, or a later lane
 *     member on the same pinned branch, that changes code without rewriting the
 *     file is proved against the EARLIER round's nomination — the blob is in
 *     that branch's own diff by construction, so no diff-membership test can
 *     see the staleness. This is the same exposure the agent route has always
 *     had (a build may nominate whatever it likes), it is not a regression, and
 *     it is bounded by the rules that DO hold on every round: the target must
 *     be production code in the branch diff, and the gate RUNS the mutation, so
 *     a nomination that has gone stale fails to redden its guard and refuses.
 *     The contract therefore tells each round to re-write the file.
 *
 *     AND THE PRECEDENCE IS THE OTHER HALF OF THAT: the in-result claim WINS,
 *     and the artifact is not even read when one arrived (the agent route must
 *     never be shadowed — `orchestrator.test.ts`, "a schema-supplied claim
 *     WINS"). So on the AGENT route a fix round that rewrites the blob but
 *     reports no claim of its own is still proved against the round the inner
 *     loop is carrying forward (`inner-workflow.mjs`: "a fix round that
 *     nominates nothing leaves the previous nomination standing"). A round that
 *     re-nominates must re-nominate through BOTH, which is what the contract
 *     asks for. On the codex route — the one this module exists for — the
 *     in-result claim is structurally null every round, so the blob is always
 *     the answer and there is nothing to shadow.
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
 *     pass `isPlainBranchName` (it is both the path segment and the ref), and a
 *     revision is either a 40-hex OID or a full
 *     `refs/...` path — else no command is run at all. The BASE is deliberately
 *     NOT held to that allowlist: it is never a path segment here, git is the
 *     interpreter that receives it, and a name-shaped rule in this module alone
 *     would refuse legal bases (`release@v1`, `HEAD~1`) that the diff reader
 *     accepts on purpose — a fail-closed refusal, but a permanent one. A
 *     `refs/...` operand is
 *     then PINNED to an OID before the read's three legs run, so a ref that
 *     moves mid-read cannot have one leg describe a different commit than
 *     another (the byte cap in particular must size the object it then reads).
 */

import {
  changedFilesOnBranch,
  isPlainBranchName,
  MUTATION_CLAIM_ARTIFACT_DIR,
  parseMutationClaim,
  type MutationClaim,
} from './mutation-prover.ts'
import type { RunHostCommand } from './merge.ts'

/**
 * Directory the per-branch nominations live under — one file per branch.
 *
 * DEFINED IN THE GATE and re-exported here: `validateClaim` must refuse a
 * nomination that names a file under this directory (a nomination cannot
 * nominate itself) and `isProseOnlyChange` must treat one as inert. Two
 * literals would let the writer's path drift away from the rules that police it.
 */
export { MUTATION_CLAIM_ARTIFACT_DIR }

/**
 * Byte cap on the blob — branch-controlled input must not flood the harvester.
 * The contract says the object must stay UNDER 32 KiB, so a blob of exactly this
 * size is refused.
 */
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
 * `resolveMergeHeadSha` carries that fallback). Either fallback ref is RESOLVED
 * TO AN OID FIRST, so the three legs of the read cannot describe three different
 * commits — and the fallback is over REF EXISTENCE ONLY: the first revision that
 * names a commit is the one read, whether or not it carries a nomination. Read
 * ON past it and a local branch with no artifact would be answered by a stale
 * `origin/<branch>`, which is a nomination for a different commit than the one
 * being proved. Returns a null claim for everything else, and never throws.
 */
export async function readCommittedMutationClaim(
  run_host: RunHostCommand,
  repo_path: string,
  source: { expected_head?: string | null; branch?: string | null; base_branch?: string | null },
): Promise<CommittedMutationClaimRead> {
  const branch = typeof source.branch === 'string' ? source.branch.trim() : ''
  const path = mutationClaimArtifactPath(branch)
  if (path === null) {
    // SLICED, like the gate's own branch rejection: the name is model-supplied
    // and this note is appended to a `failure_reason` that is stored verbatim.
    return {
      claim: null,
      note: `no committed nomination: ${JSON.stringify(branch.slice(0, 80))} is not a plain branch name`,
    }
  }
  // AN EMPTY BASE IS THE ONLY BASE REFUSED HERE. A base git accepts is git's to
  // judge (`changedFilesOnBranch` says so in as many words, and its tests name
  // `release@v1` and `HEAD~1`); an allowlist in THIS module would make the two
  // halves of one channel enforce contradictory base policies, and an
  // operator-supplied base of a legal name would read every nomination as absent
  // and block every non-exempt merge in that repository forever. The membership
  // read below hands the name to `changedFilesOnBranch`, whose own guard refuses
  // an option-shaped base before any git command runs.
  const base = typeof source.base_branch === 'string' ? source.base_branch.trim() : ''
  if (base.length === 0) {
    return { claim: null, note: 'no committed nomination: no base branch to measure this branch\'s diff against' }
  }

  const oid = typeof source.expected_head === 'string' ? source.expected_head.trim().toLowerCase() : ''
  // The `refs/heads/` and `refs/remotes/` prefixes are load-bearing: with
  // isPlainBranchName's leading-dash and colon rejections they keep the operand
  // a ref PATH, never an option and never a refspec.
  const revisions = FULL_OID.test(oid) ? [oid] : [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]

  const notes: string[] = []
  for (const revision of revisions) {
    // PIN THE REF TO AN OID BEFORE ANY OF THE THREE LEGS RUN. A ref is mutable,
    // and `readAtRevision` resolves its operand independently three times (diff,
    // cat-file -s, git show): a ref that moves between the SIZE and the SHOW is
    // sized as the small blob and read as whatever landed, which is the byte cap
    // measuring one object and bounding another. Resolving once and passing the
    // OID makes all three legs describe the same commit — the same reason
    // `runMutationProofGate` pins its sha before reading anything off it.
    const pinned = await pinRevision(run_host, repo_path, revision)
    if (pinned === null) {
      // THE ONLY REASON TO TRY THE NEXT REF: this one names no commit here. The
      // fallback exists because the worktree holding the local branch is
      // routinely cleaned before the gate runs — an ABSENT ref, not an absent
      // nomination.
      notes.push(`no committed nomination: ${revision} does not resolve to a commit`)
      continue
    }
    // THE FIRST REF THAT RESOLVES IS THE ANSWER, claim or no claim. Continuing
    // past a resolved commit that carries no artifact breaks the binding this
    // reader exists for: a local branch that has been reset, or rebuilt without
    // a nomination, would be answered by a STALE `origin/<branch>` commit's
    // artifact — a nomination for work that is not the work the gate proves.
    // Absence at the commit we are reading is the honest null.
    const read = await readAtRevision(run_host, repo_path, pinned, path, base)
    return { claim: read.claim, note: [...notes, read.note].join('; ') }
  }
  return { claim: null, note: notes.join('; ') }
}

/**
 * The commit a revision names, as a 40-hex OID, or null when it names none.
 *
 * A revision that is ALREADY an OID is returned untouched — no command at all —
 * so the pinned-head path stays a three-command read.
 */
async function pinRevision(
  run_host: RunHostCommand,
  repo_path: string,
  revision: string,
): Promise<string | null> {
  if (FULL_OID.test(revision)) return revision
  try {
    // `^{commit}` is a suffix on an operand that already passed `isPlainBranchName`
    // and carries a `refs/` prefix, so it is still a ref PATH and never an option
    // — and `--end-of-options` says so to git as well. (`git diff`'s range form
    // takes no such marker, which is why `changedFilesOnBranch` has to reject a
    // hostile base by NAME instead.)
    const res = await run_host(
      ['git', '-C', repo_path, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`],
      repo_path,
    )
    if (!res.ok) return null
    const oid = res.stdout.trim().toLowerCase()
    return FULL_OID.test(oid) ? oid : null
  } catch {
    return null
  }
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
    if (!sized.ok) return { claim: null, note: `no committed nomination at ${at}` }
    const size = Number.parseInt(sized.stdout.trim(), 10)
    if (!Number.isFinite(size)) {
      return { claim: null, note: `no committed nomination: unreadable object size for ${at}` }
    }
    if (size >= MUTATION_CLAIM_ARTIFACT_MAX_BYTES) {
      return {
        claim: null,
        note: `committed nomination at ${at} is ${size} bytes, at or over the ${MUTATION_CLAIM_ARTIFACT_MAX_BYTES}-byte cap`,
      }
    }

    const res = await run_host(['git', '-C', repo_path, 'show', at], repo_path)
    if (!res.ok) return { claim: null, note: `no committed nomination at ${at}` }
    const claim = parseMutationClaim(JSON.parse(res.stdout))
    if (claim === null) {
      return { claim: null, note: `committed nomination at ${at} is not a well-formed nomination` }
    }
    return { claim, note: `committed nomination read from ${at}` }
  } catch {
    return { claim: null, note: `committed nomination at ${at} could not be read` }
  }
}
