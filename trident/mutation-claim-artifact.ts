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
 *     also stops concurrent lanes colliding on one file. A blob the branch did
 *     not touch reads as null.
 *
 *     THE MEMBERSHIP READ RESOLVES THE BASE AS A NAME, and is therefore only as
 *     honest as the local ref that name finds — WHICH IS WHERE THE BOUNDARY
 *     LEAKS, stated plainly because an earlier draft of this docblock claimed
 *     the check "catches the case a branch NAME is reused after its predecessor
 *     merged" and review REPRODUCED the case it does not catch: local `main` one
 *     commit behind `origin/main`, a branch name reused after its predecessor
 *     merged, the predecessor's committed nomination and the file it names both
 *     still inside `main...<head>` because the local base has not caught up. The
 *     inherited blob is then read as this branch's nomination, `claim.file` is
 *     in that same widened diff, and the gate can PROVE the predecessor's
 *     mutation while this branch's own work goes unproved. Rounds 9-10 pinned
 *     the base to close exactly this and review VETOED the pinning twice:
 *     trident's local merge path advances the local base ref and leaves the
 *     origin spelling STALE, so the union of both readings destroyed the prose
 *     exemption in local git-mode (documentation-only branches permanently
 *     unmergeable, reproduced A/B), and embedding a documented base like
 *     `HEAD~1` inside a remote ref path silently reinterpreted it. So the
 *     stale-base read stays a RECORDED LIMITATION for its own card rather than
 *     being closed here by the mechanism that was vetoed — and it is NOT a
 *     regression this channel introduced: the pre-change gate already read the
 *     base as a bare name for both the exemption and the `claim.file` binding.
 *     What bounds it meanwhile: the inherited nomination must name PRODUCTION
 *     code that is in that diff, it cannot name a nomination blob (the gate
 *     refuses those as targets), and the gate RUNS the mutation — so the claim
 *     it certifies is a real, executed proof about a real file, just not
 *     necessarily about the commit this run added.
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
 *     accepts on purpose — a fail-closed refusal, but a permanent one. It is
 *     instead FOLDED (`foldRefName`) wherever a NOTE quotes it: the notes are
 *     persisted into a `failure_reason` that is later replayed to a model
 *     verbatim, and git accepts a name carrying U+2028 or U+202E, so a raw base
 *     would be a forged line in that prose. A
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
import { foldRefName } from './wrong-base-remedy.ts'

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
 * being proved. For the same reason the fallback needs a CONCLUSIVE answer that
 * the ref is missing (`rev-parse --verify --quiet` exiting 1): a host that
 * failed to answer at all — spawn failure, watchdog kill, unreadable repository
 * — stops the read with a null claim rather than licensing the stale ref.
 * Returns a null claim for everything else, and never throws.
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
      note: `no committed nomination: ${JSON.stringify(foldRefName(branch.slice(0, 80)))} is not a plain branch name`,
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
  // THE BASE IS FOLDED WHEREVER A NOTE QUOTES IT — never where git receives it.
  // This note is appended verbatim to a persisted `failure_reason`, which is fed
  // back to a model as "Failure reason (verbatim)" (`terminal-build-wake.ts`),
  // and the base is branch/operator-supplied: git accepts a name carrying
  // U+2028 or U+202E (`check-ref-format --branch` exits 0 on it), so a raw base
  // could put a forged LINE into that prose. `foldRefName` is the repo's own
  // answer to exactly this forgery (Argus finding on the wrong-base refusal,
  // `orchestrator.ts` folds the base the same way where a refusal quotes it) and
  // it folds a name to ONE TOKEN, so the fold itself cannot introduce a space
  // either. The RAW `base` is what still reaches `changedFilesOnBranch`; folding
  // that operand would change which diff is read.
  const baseProse = foldRefName(base)

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
    if (pinned.oid === null) {
      if (pinned.why !== 'absent') {
        // A HOST THAT DID NOT ANSWER IS NOT AN ABSENT REF, AND MUST NOT MOVE THE
        // READ ONTO THE NEXT ONE. Collapsing every non-OK result into "absent"
        // made an UNANSWERED question license the fallback: a local rev-parse
        // that failed to spawn (`exit_code: -1`), or a repository git could not
        // read at all, sent the reader on to `refs/remotes/origin/<branch>` and
        // returned THAT commit's nomination — a nomination for whatever origin
        // last held — while the note claimed the local ref did not resolve. The
        // fallback exists for ONE situation, the one the comment below names:
        // the worktree holding the local branch was cleaned, so the ref
        // genuinely is not there. Anything else stops here with a null claim,
        // which is what the gate already refuses, and says in its own words
        // WHICH failure it was (invariant (c)).
        notes.push(`no committed nomination: ${pinned.detail} resolving ${revision}, so no further ref was tried`)
        return { claim: null, note: notes.join('; ') }
      }
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
    const read = await readAtRevision(run_host, repo_path, pinned.oid, path, base, baseProse)
    return { claim: read.claim, note: [...notes, read.note].join('; ') }
  }
  return { claim: null, note: notes.join('; ') }
}

/**
 * What the pin leg found: the commit a revision names, or WHY it names none.
 *
 * The nulls are kept apart because invariant (c) promises each null says which
 * failure it was, and they send an operator to different places: an absent ref
 * is the branch's story, a throwing or failing host is the machine's.
 *
 * AND THE SPLIT IS LOAD-BEARING, not just descriptive — only `absent` may be
 * followed by the next ref. `absent` is the one answer that MEANS "this
 * revision names no commit HERE"; the other two mean the question was never
 * answered, and an unanswered question that licensed the fallback would let a
 * stale `origin/<branch>` commit supply the nomination.
 */
type PinnedRevision =
  | { oid: string }
  | { oid: null; why: 'absent' }
  /** `detail` reads as a clause: "<detail> resolving <revision>". */
  | { oid: null; why: 'host-threw' | 'host-failed'; detail: string }

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
): Promise<PinnedRevision> {
  if (FULL_OID.test(revision)) return { oid: revision }
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
    if (res.ok) {
      const oid = res.stdout.trim().toLowerCase()
      if (FULL_OID.test(oid)) return { oid }
      // EXIT ZERO AND NOT AN OBJECT ID is not "this ref names no commit":
      // `--verify --quiet` prints an object id or nothing at all on success.
      // Something else answered, so the question stands unanswered.
      return { oid: null, why: 'host-failed', detail: 'git printed no object id' }
    }
    // THE ONE CONCLUSIVE "no such revision": `git rev-parse --verify --quiet`
    // exits 1, silently, for a revision that names nothing (measured, git
    // 2.43.0). Every other non-zero answer says the question was not ANSWERED —
    // 128 for a repository git could not read at all, -1 for a spawn that never
    // happened, a watchdog kill — and must not be reported, or acted on, as an
    // absent ref.
    if (res.exit_code === 1 && res.timed_out !== true && res.stdout.trim().length === 0) {
      return { oid: null, why: 'absent' }
    }
    return {
      oid: null,
      why: 'host-failed',
      detail: res.timed_out === true ? 'the git host timed out' : `the git host exited ${res.exit_code}`,
    }
  } catch {
    return { oid: null, why: 'host-threw', detail: 'the git host threw' }
  }
}

async function readAtRevision(
  run_host: RunHostCommand,
  repo_path: string,
  revision: string,
  path: string,
  base: string,
  baseProse: string,
): Promise<CommittedMutationClaimRead> {
  const at = `${revision}:${path}`
  try {
    // (1) THE BLOB MUST BE PART OF THIS BRANCH'S OWN DIFF. A tracked file that
    // merely came along from the base is not a nomination this build made.
    const changed = await changedFilesOnBranch(run_host, repo_path, base, revision)
    if (changed === null) {
      // BOTH READINGS, because the diff reader collapses them: it answers null
      // for a diff it could not read AND for a diff that is EMPTY (its last
      // line, `files.length === 0 ? null : files`). Saying only "could not read"
      // sent an operator hunting a git failure for a branch that simply changes
      // nothing — the exact note ambiguity invariant (c) exists to remove.
      return {
        claim: null,
        note: `no committed nomination: the diff ${baseProse}...${revision} is empty or could not be read`,
      }
    }
    if (!changed.includes(path)) {
      return { claim: null, note: `no committed nomination: ${path} is not in the diff ${baseProse}...${revision}` }
    }

    // (2) SIZE THE OBJECT BEFORE ITS BODY CROSSES THE PROCESS BOUNDARY. Checking
    // the length of an already-captured stdout does not bound the read at all
    // (the host buffers the whole child output first, and trims it), so the cap
    // is applied to git's own record of the blob.
    const sized = await run_host(['git', '-C', repo_path, 'cat-file', '-s', at], repo_path)
    if (!sized.ok) return { claim: null, note: `no committed nomination: nothing at ${at} to size` }
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
    if (!res.ok) return { claim: null, note: `no committed nomination: git could not show ${at}` }
    // DECODED IN ITS OWN try, so invariant (c) — "each null says WHICH failure it
    // was" — actually holds here. Sharing the outer catch made a malformed body
    // (`{nope`) and a host that THROWS produce the byte-identical note, which is
    // the one distinction an operator reading a refusal most needs: the first is
    // the build's file to fix, the second is the machine's.
    let decoded: unknown
    try {
      decoded = JSON.parse(res.stdout)
    } catch {
      return { claim: null, note: `committed nomination at ${at} is not valid JSON` }
    }
    const claim = parseMutationClaim(decoded)
    if (claim === null) {
      return { claim: null, note: `committed nomination at ${at} is not a well-formed nomination` }
    }
    return { claim, note: `committed nomination read from ${at}` }
  } catch {
    return { claim: null, note: `committed nomination at ${at} could not be read: the git host threw` }
  }
}
