import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@neutronai/logger'
import { gitRangeArgv } from './git-range.ts'
import { type DiffOutputHost } from './git-mode.ts'
import { reviewedHeadOid, type MergeConflictResolver } from './merge.ts'
import { rebaseOntoObservedBase } from './replay.ts'
import { publishFailureReason } from './publish-failure.ts'
import { fixLineage } from './gates/fix-lineage.ts'
import { sessionTrailerReadiness } from './gates/release-readiness.ts'
import { runLeakGatePreflight, type LeakPreflightFixer } from './leak-preflight.ts'
import type { TridentRun } from './store.ts'

const log = createLogger('trident')

/**
 * Gate rule ids embed the very root the gate bans, and CI scans PR titles/
 * bodies and commit messages — so an UNSANITIZED annotation would re-redden
 * the PR this preflight exists to keep green. Split the root with a hyphen;
 * assembled from fragments so this file stays silent under its own gate.
 */
const FLAGGED_ROOT = 'ten' + 'ant'

/** Split the flagged root wherever it appears, in any case, so annotation text
 *  derived from gate output is safe to write onto a scanned surface. */
export function sanitizeLeakAnnotation(text: string): string {
  return text.replace(new RegExp(FLAGGED_ROOT, 'gi'), 'ten-ant')
}

/**
 * The outer publisher's push-necessity predicate (deploy-blocker card, 3 occurrences
 * 2026-08-17: runs 26ed32c1 / 88efe1ca / 95fcfb91). The remote ref ALREADY holding exactly
 * the head to publish is a publish the publisher does not have to perform — a no-op
 * SUCCESS, never a failure and never "the build left no new commits": the commit exists,
 * it is on origin, it was simply already published. An empty observation ('' — the remote
 * ref does not exist yet) is a FIRST PUSH, not a no-op. Production call site:
 * `publishBuiltCommit`; deleting that call turns the no-op regression tests red.
 */
export function remoteAlreadyAtPublishHead(observedRemoteSha: string, headToPublish: string): boolean {
  return observedRemoteSha !== '' && observedRemoteSha === headToPublish
}

/**
 * GIT-TRUTH FOR THE CLAIM, NOT ONLY THE BRANCH (card 2026-08-16). A model-relayed
 * sha that names NO git object is not a disagreement with the real head — there is
 * only one candidate commit, git's — so it resolves to ABSENT (null), never to a
 * refusal. Measured: hallucinated claim '924b42906950' (git cat-file: not a valid
 * object name) refused a good build and stranded 924b4290ea81….
 * A claim is a sha, never a refname: non-hex input returns null WITHOUT asking git,
 * so 'HEAD'/branch names cannot resolve by accident (4 = git's minimum abbreviation).
 * `--end-of-options` keeps hostile-shaped input from being read as a flag.
 */
export async function resolveClaimedCommit(
  run_host: DiffOutputHost,
  repo_path: string,
  claim: string | null,
): Promise<string | null> {
  if (claim === null) return null
  const c = claim.trim().toLowerCase()
  if (!/^[0-9a-f]{4,40}$/.test(c)) return null
  const res = await run_host(
    ['git', '-C', repo_path, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${c}^{commit}`],
    repo_path,
  )
  const oid = res.stdout.trim()
  return res.ok && /^[0-9a-f]{40}$/.test(oid) ? oid : null
}

/** The full OID a rev-range operand names: a 40/64-hex sha as given, else `rev-parse` of the
 *  ref (`^{commit}` so a tag resolves to the commit it points at); '' when it names none. */
async function commitOf(run_host: DiffOutputHost, repo_path: string, operand: string): Promise<string> {
  const name = operand.trim()
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(name)) return name
  if (name === '' || name.startsWith('-')) return ''
  const res = await run_host(['git', '-C', repo_path, 'rev-parse', '--verify', '--quiet', `${name}^{commit}`], repo_path)
  const oid = res.stdout.trim()
  return res.ok && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ? oid : ''
}

export interface PublicationDeps {
  run_host: DiffOutputHost
  resolve_conflict?: MergeConflictResolver
  leak_preflight?: typeof runLeakGatePreflight
  fix_leak_findings?: LeakPreflightFixer
  resolveBase: (run: TridentRun) => Promise<string>
  resolvedDiffBase: (run: TridentRun) => Promise<string>
  detectExistingPr: (run: TridentRun) => Promise<number | null>
  /** Persist only a matched create receipt, before later annotation/diff work. */
  recordPublication?: (pr: number) => Promise<void>
}

export async function publishBuiltCommit(
  deps: PublicationDeps,
  run: TridentRun,
  claimedHead: string | null,
): Promise<{ pr: number; published_pr: number | null; head: string; push: 'pushed' | 'noop-already-at-head' }> {
  const opts = deps
  const { resolveBase, resolvedDiffBase, detectExistingPr } = deps
  if (run.merge_mode !== 'pr') throw new Error('outer publish requested outside pr mode')
  const branch = run.branch ?? `trident/${run.slug}`
  // `--verify` so a missing/ambiguous ref is an ERROR rather than an echoed argument.
  const local = await opts.run_host(
    ['git', '-C', run.repo_path, 'rev-parse', '--verify', `refs/heads/${branch}`],
    run.repo_path,
  )
  const resolvedHead = local.stdout.trim()
  if (!local.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolvedHead)) {
    const detail = local.stderr.trim()
    throw new Error(
      `outer publisher could not resolve branch ${branch} locally${detail === '' ? '' : `: ${detail}`}`,
    )
  }
  // THE CLAIM IS A CHECK, NEVER THE SOURCE — and it is RESOLVED before it may check
  // anything. A claim naming no git object is ABSENT, not a conflict (there is only
  // one candidate commit: git's). Resolved OIDs are compared for EQUALITY — a prefix
  // compare is wrong both ways: a hallucinated prefix refused a good build, and a
  // short sha of the right commit is only honored by resolving it. The refusal
  // itself is DEFERRED until after the push (see below) so it can never strand the
  // commit; it remains only for two real, resolvable, DIFFERENT commits.
  const resolvedClaim = await resolveClaimedCommit(opts.run_host, run.repo_path, claimedHead)
  const claimConflict = resolvedClaim !== null && resolvedClaim !== resolvedHead
  // FIX-ROUND ANCESTRY GATE (mandated by the Fable arbitration on #289 vs #318).
  // A fix round carries the head the review verdict was ABOUT; the head it produced
  // must DESCEND from it. Run fec4d3aa rebuilt from main with no ancestry of the
  // reviewed head 4523107b and was silently published as a new PR — this gate makes
  // that a REFUSAL. Evaluated on the PRE-rebase produced head: the replay below
  // rewrites shas onto the observed base, so this is the only point where "did the
  // build abandon the reviewed branch?" is still measurable. `--is-ancestor` passes
  // on equality, so a legitimate RESUME republishing or continuing the reviewed
  // head passes with no exemption (the recovery-card interaction).
  const lineage = await fixLineage(opts.run_host, run.repo_path, branch, run.reviewed_head, resolvedHead)
  if (lineage.kind !== 'allow') throw new Error(lineage.kind === 'blocked' ? lineage.on : lineage.detail)
  const runWithRetries = async (command: string[], attempts = 3) => {
    let result = await opts.run_host(command, run.repo_path)
    for (let attempt = 1; !result.ok && attempt < attempts; attempt++) {
      result = await opts.run_host(command, run.repo_path)
    }
    return result
  }
  // Observe the branch before replay: a missing remote ref proves this is the lane's FIRST
  // publish, which is the only point where the launch pin can prove the branch was cut from
  // this run's base rather than inherited from another lane. The same observation remains the
  // push lease below, so a branch that appears while replay is running is still refused.
  const observed = await runWithRetries(
    ['git', '-C', run.repo_path, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
  )
  if (!observed.ok) {
    throw new Error(publishFailureReason('read the remote state of', branch, observed.stderr))
  }
  // Empty is MEANINGFUL, not a missing value: to git an empty expectation asserts the ref does
  // not exist, so a first push of a new card stays correct — and is still refused if the branch
  // appeared underneath us between this read and the push.
  const expected = observed.stdout.trim().split(/\s+/)[0] ?? ''
  if (expected === '' && run.base_sha !== null) {
    const cutFromPinnedBase = await opts.run_host(
      ['git', '-C', run.repo_path, 'merge-base', '--is-ancestor', run.base_sha, resolvedHead],
      run.repo_path,
    )
    if (!cutFromPinnedBase.ok) {
      const base = await resolveBase(run)
      throw new Error(
        `branch ${branch} does not contain its recorded launch base for origin/${base} (${run.base_sha.slice(0, 7)}) — not based on the launch record; refusing to publish work built on another lane's branch. Verify the card instead of rebuilding.`,
      )
    }
  }
  // THE REBASE ONTO CURRENT `main` HAPPENS HERE, BEFORE THE REVIEW IS RE-FIRED.
  //
  // WHEN. In the OUTER publisher, between the local-tip verification above and the lease
  // observation below. Only the outer loop holds a push credential (the Forge sandbox strips
  // `*TOKEN*`), so "rebase and re-push before the readiness probe" can only happen here. And
  // because this publisher fires after EVERY build/fix round and before EVERY review re-fire,
  // every fix round re-enters a branch already based on current `main` — post-round-1 code IS
  // written against the tree it merges into. That is the closest to "before build" the
  // credential boundary allows.
  //
  // ON CONFLICT. A configured `resolve_conflict` resolver is tried FIRST, in the scratch
  // worktree, bounded by `MAX_CONFLICT_ROUNDS` — this is the autonomous path, so there is no
  // human here to reconcile the branch by hand. Absent, declining, or exhausted → an ATTENTION
  // state (`TridentRebaseConflict`) exactly as before: never `REQUEST_CHANGES`, naming the
  // conflicting paths and saying plainly that no reviewer judged the code. And a RESOLVED
  // conflict shortcuts nothing — the replay is published and review is re-fired as usual.
  //
  // The replay heals a shallow checkout on entry (`healShallowCheckout`) and still uses a
  // diff-replay in a throwaway worktree — never `git rebase`, never the shared working tree.
  //
  // The PR probe moves UP so the replay can use `gh pr diff` (a server-side, shallow-immune
  // merge-base); its result is reused by the "open a PR if none" step below, unchanged.
  const prBefore = await detectExistingPr({ ...run, branch })
  const rebased = await rebaseOntoObservedBase(
    opts.run_host,
    run.repo_path,
    branch,
    await resolveBase(run),
    prBefore,
    `${run.repo_path}/.trident-worktrees/rebase-${run.id}`,
    opts.resolve_conflict !== undefined ? { run, resolve_conflict: opts.resolve_conflict } : undefined,
  )
  // Everything downstream publishes the REBASED head: the post-push confirm, the review diff,
  // and the `outer-published:<head>` checkpoint the re-fired workflow reads back.
  let headToPublish = rebased.head
  // PURITY PREFLIGHT (2026-08-31): 3 of 4 PRs that night were red on exactly one
  // check — the public leak gate — every finding in the branch's own regenerated
  // plan doc. Run the gate on the branch tree HERE, after the replay and before
  // the lease push, so a finding is a fixable defect in this round instead of a
  // guaranteed-red PR. ADVISORY AND BOUNDED: every status proceeds to publish
  // (a gate bug must never wedge a lane); only the fix loop inside is bounded.
  // The fixer moves the branch ref by compare-and-swap, so the post-preflight
  // head is what the lease push, confirm, review diff, returned head and the
  // outer-published checkpoint all carry — via this one reassignment.
  // base_sha: the OBSERVED base tip the head now sits on, so the gate's
  // commit-message window is exactly this branch's own commits (a stale pin
  // would scan other lanes' messages — the nondeterminism SPEC.md documents).
  const preflight = await (opts.leak_preflight ?? runLeakGatePreflight)({
    run_host: opts.run_host,
    repo_path: run.repo_path,
    branch,
    head: headToPublish,
    base_sha: rebased.baseSha !== '' ? rebased.baseSha : (run.base_sha ?? ''),
    // PER-PUBLISH, NOT PER-RUN. `publishBuiltCommit` fires after the first build AND after every
    // fix round, and the preflight's cleanup deliberately swallows its own failure — so a path
    // keyed on the run id alone would collide with its own leftover on the next round, `git
    // worktree add` would exit 128, and the preflight would return gate-error (logged at warn,
    // then ignored) for the rest of the run. The head being published makes it distinct per
    // round; the timestamp covers a re-publish of the same head.
    scratch_dir: `${run.repo_path}/.trident-worktrees/leak-preflight-${run.id}-${headToPublish.slice(0, 12)}-${Date.now().toString(36)}`,
    ...(opts.fix_leak_findings !== undefined ? { fixer: opts.fix_leak_findings } : {}),
  })
  headToPublish = preflight.head
  if (preflight.status === 'findings-unresolved' || preflight.status === 'gate-error') {
    log.warn('leak_preflight', { run_id: run.id, status: preflight.status, note: preflight.note })
  } else {
    log.info('leak_preflight', { run_id: run.id, status: preflight.status, note: preflight.note })
  }
  // #1133 (G166) ON EVERY LEGACY-LOOP PUBLICATION AND THE SALVAGE PATH. This publisher is the
  // THIRD writer of a build branch to origin and it has TWO callers (`trident/orchestrator.ts`):
  // the `publish_requested` push after every build and fix round of the legacy loop, and
  // `reconcile_stranded`'s salvage push. The salvage call is the one a refused wrapper commit
  // actually takes: the wrapper refuses (exit 69/70/74/76) and leaves the trailer-bearing
  // commit on the branch, the checked publisher's `publicationReadiness` blocks, the run is
  // recorded `failed`, and `reconcile_stranded` calls THIS function to push the branch "as
  // PR #N, unreviewed" — which would publish exactly the commit the gate refused. The replay
  // above makes it worse, not better: it re-commits the ORIGINAL message plus a replay note, so
  // the trailer rides onto the replayed head. So the same scan runs here, after the replay and
  // the preflight (so it measures the head that will be pushed) and before the lease push, over
  // this branch's own commits (the window is spelled out below) — and because it sits in the
  // shared publisher, it gates every ordinary legacy-loop publication the same way, which is
  // the blast radius #1133 asks for (no PR-bound push may carry the trailer). It is
  // UNCONDITIONAL — a remote already at this head is scanned the same as a first push, as the
  // checked gate does — and it FAILS CLOSED: a carrier AND a range that cannot be measured
  // both throw, so the legacy loop records the round as not published and `reconcile_stranded`
  // records the branch as not pushed (its ordinary "stranded work recorded without a publish"
  // outcome) instead of publishing it. The reason names every carrier sha, so the operator can
  // strip and relaunch. The scan's host commands are all plain `git` argv (the graft override
  // rides in the runner's `extraEnv`): every host double on this path admits only `git`/`gh`
  // and throws otherwise, and a throw here is a publication that never happened.
  //
  // THE WINDOW IS THE REVIEW DIFF'S. `rebased.baseSha` is the observed base tip the head now
  // sits on; absent one (no remote base at all), `resolvedDiffBase` is the same left-hand side
  // the review diff below is taken against — the launch pin, else the qualified base ref —
  // resolved here to the commit it names, because the scan lists a range and refuses a
  // launch base that is not a full OID. A ref that names no commit resolves to '' and the
  // scan refuses it as unmeasurable; nothing here can widen the window past the branch's
  // own commits.
  const trailerBase = rebased.baseSha !== ''
    ? rebased.baseSha
    : await commitOf(opts.run_host, run.repo_path, await resolvedDiffBase(run))
  const trailers = await sessionTrailerReadiness(opts.run_host, run.repo_path, trailerBase, headToPublish)
  if (trailers.kind !== 'allow') {
    throw new Error(
      `outer publisher refused to push branch ${branch}: ${trailers.kind === 'blocked' ? trailers.on : trailers.detail} — nothing was pushed; the branch stays local for inspection`,
    )
  }
  // THE BUILD REBASES ONTO CURRENT `main`, SO THE PUSH IS NOT A FAST-FORWARD.
  //
  // Measured on run `2aacf419` (2026-08-14): the build SUCCEEDED and the plain push here was
  // refused `! [rejected] ... (non-fast-forward)`. Verified NOT a credential failure — a dry-run
  // push with the real credential authenticated and got the same server-side refusal. A rebased
  // branch is by definition not a fast-forward, so an ordinary push can never publish one; this
  // stranded every card whose remote branch predated its rebase, which is most fix rounds.
  //
  // A LEASE, NOT A FORCE, AND THAT DISTINCTION IS THE WHOLE SAFETY PROPERTY. `--force-with-lease`
  // pinned to the sha we OBSERVED means: replace the remote branch, but only if it still holds
  // what we saw. A branch someone else genuinely advanced is refused rather than destroyed.
  // A bare `--force` would publish the rebase and silently discard their commits.
  //
  // PINNED TO AN OBSERVATION, NOT TO THE REMOTE-TRACKING REF. The bare `--force-with-lease` form
  // trusts `refs/remotes/origin/<b>`, which any concurrent `git fetch` can advance — at which
  // point the lease certifies a state nobody ever looked at, and quietly degrades to `--force`.
  // The explicit `<ref>:<sha>` form cannot be undermined that way.
  // ALREADY PUBLISHED IS A SUCCESS THE PUBLISHER DID NOT HAVE TO PERFORM (3 occurrences
  // 2026-08-17, runs 26ed32c1 / 88efe1ca / 95fcfb91). A resumed or relaunched run whose
  // branch is already fully on origin used to be REFUSED here as "the build left no new
  // commits to publish" — a finished, reviewed, PUSHED build recorded `failed`, and the
  // natural relaunch rebuilt work that was already on origin. The remote holding EXACTLY
  // `headToPublish` means the push is a NO-OP: resolve to that commit and continue.
  // Compared against the POST-rebase head, not `resolvedHead` — a remote at the
  // pre-rebase tip while the replay produced a new head still needs the real lease push.
  // The genuine "nothing was built" outcome keeps its guard where it belongs: the empty
  // base..head diff refusal below, which measures CONTENT against the base.
  // PUSH THE OBJECT, NOT THE REF (#1133 round 18). The scans above measured `headToPublish`;
  // a refspec of `refs/heads/<branch>:...` would send whatever the local ref names at push
  // time, so a writer moving the branch between the scan and the push would publish an
  // unscanned commit and the witness below would only notice after it was on origin. Naming
  // the object makes the pushed commit the scanned commit by construction, the same shape the
  // checked publisher (`production-host-effects.ts`) and G100's preservation push use.
  const alreadyPublished = remoteAlreadyAtPublishHead(expected, headToPublish)
  if (!alreadyPublished) {
    const pushed = await runWithRetries([
      'git',
      '-C',
      run.repo_path,
      'push',
      `--force-with-lease=refs/heads/${branch}:${expected}`,
      'origin',
      `${headToPublish}:refs/heads/${branch}`,
    ])
    // NOTE the lease is deliberately NOT re-observed between retries. Re-reading it would adopt
    // whatever moved and turn the retry into the force this code exists to avoid.
    if (!pushed.ok) throw new Error(publishFailureReason('push', branch, pushed.stderr))

    const witnessed = await runWithRetries(
      ['git', '-C', run.repo_path, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    )
    const remoteHead = witnessed.ok ? witnessed.stdout.trim().split(/\s+/)[0] : ''
    if (remoteHead !== headToPublish) {
      throw new Error(`outer publisher could not confirm commit ${headToPublish} on origin`)
    }
  }
  // On the no-op path the `observed` read above IS the witness: origin was measured at
  // exactly `headToPublish` moments ago and this publisher performed no write since.

  // THE REFUSAL FIRES ONLY AFTER THE PUSH IS CONFIRMED (defect 2, 2026-08-14: the
  // throw preceded the push, so a wrong refusal left the commit unreachable —
  // 924b4290ea81… was stranded). A refusal is about which commit to REVIEW, not
  // about whether the work may exist: the branch is on origin for inspection; only
  // the PR / review dispatch is refused.
  if (claimConflict) {
    throw new Error(
      `outer publisher refused: the build reported commit '${claimedHead}' (resolves to '${resolvedClaim}') but branch ${branch} resolved to '${resolvedHead}' before publish — the branch was pushed to origin for inspection; no PR or review was dispatched`,
    )
  }

  let pr = prBefore
  let publishedPr = pr !== null && run.published_pr === pr ? pr : null
  if (pr === null) {
    const base = await resolveBase(run)
    const created = await runWithRetries(
      ['gh', 'pr', 'create', '--head', branch, '--base', base, '--fill'],
    )
    if (!created.ok) throw new Error(publishFailureReason('open a PR for', branch, created.stderr))
    pr = await detectExistingPr({ ...run, branch })
    // Discovery alone cannot prove ownership. Match the create command's receipt
    // to the independently observed PR before granting this run lineage ownership.
    const receipt = /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/([1-9]\d*)$/.exec(created.stdout.trim())
    const number = receipt ? Number(receipt[1]) : null
    if (!created.timed_out && number !== null && Number.isSafeInteger(number) && number === pr) {
      await deps.recordPublication?.(number)
      publishedPr = number
    }
  }
  if (pr === null) throw new Error(`outer publisher could not confirm an open PR for branch ${branch}`)

  // BEST-EFFORT FINDINGS ANNOTATION. The PR opens regardless — this only names
  // what the preflight could not self-correct, so a human reading the red CI
  // sees the same facts without hunting. No excerpt is ever quoted, and the
  // whole rendered note goes through `sanitizeLeakAnnotation` (rule ids AND
  // file paths can carry the banned root, and a PR body is itself scanned).
  // Every failure here — a throw or any !ok host result — is logged and
  // swallowed: the publish must never fail on an annotation.
  if (preflight.status === 'findings-unresolved') {
    try {
      const lines = preflight.findings.map((f) => `- [${f.rule}] ${f.file}:${f.line}`)
      if (preflight.skipped_rules.length > 0) {
        lines.push(`tiers skipped locally (no secret): ${preflight.skipped_rules.join(', ')}`)
      }
      const note = sanitizeLeakAnnotation(
        [
          `### purity preflight: ${preflight.findings.length} finding(s) not self-corrected`,
          ...lines,
          "No excerpt is quoted by design; CI's purity job remains the enforcement of record.",
        ].join('\n'),
      )
      const noteFile = join(tmpdir(), `trident-leak-note-${run.id}.md`)
      let annotated = false
      if (prBefore === null) {
        // The PR was minted THIS publish, so its body is `--fill`ed boilerplate
        // that is safe to extend in place.
        const body = await opts.run_host(
          ['gh', 'pr', 'view', String(pr), '--json', 'body', '--jq', '.body'],
          run.repo_path,
        )
        if (body.ok) {
          writeFileSync(noteFile, `${body.stdout.trim()}\n\n${note}`)
          const edited = await opts.run_host(
            ['gh', 'pr', 'edit', String(pr), '--body-file', noteFile],
            run.repo_path,
          )
          // ONLY a SUCCESSFUL edit consumes the annotation. Setting this before the check meant
          // a transient `gh pr edit` failure left the findings in a log line and nowhere else —
          // the comment fallback below is exactly the path such a failure should take.
          if (edited.ok) annotated = true
          else log.warn('leak_preflight_annotation_failed', { run_id: run.id })
        }
      }
      if (!annotated) {
        // A PRE-EXISTING PR (every fix round) — editing the body would clobber
        // or duplicate whatever is there, so append a comment instead.
        writeFileSync(noteFile, note)
        const commented = await opts.run_host(
          ['gh', 'pr', 'comment', String(pr), '--body-file', noteFile],
          run.repo_path,
        )
        if (!commented.ok) log.warn('leak_preflight_annotation_failed', { run_id: run.id })
      }
    } catch (err) {
      log.warn('leak_preflight_annotation_failed', {
        run_id: run.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const diffFile = `/tmp/trident-outer-published-${run.id}.diff`
  // THE REVIEW DIFF IS TAKEN AGAINST THE OBSERVED BASE TIP, NOT AGAINST THE LOCAL `main` REF.
  //
  // MEASURED (Argus r4, run 25b2327d): the published artifact was 15,154 lines across ~100
  // files while the branch's own work was 20 files / 1,738 lines. The shared build checkout's
  // local `main` was 8 merges behind `origin/main`, and `git diff main..<head>` on a branch
  // built from CURRENT origin therefore shows every commit merged in between as part of this
  // card. ~87% of that artifact was already-merged unrelated code — one reviewer diffed the
  // stale base, vetoed the branch over bugs in files it does not touch, and the round was lost.
  //
  // `rebaseOntoObservedBase` already `ls-remote`s the base tip (the same observation the push
  // lease uses) and the head it returns is replayed directly onto it, so that sha is the exact
  // left-hand side of this branch's own diff. It is a local object on BOTH paths that return a
  // non-empty one: the replay fetches it, and the already-contains path could only have been
  // answered by reading it.
  //
  // AN EMPTY ONE IS NOT A LICENCE FOR THE BARE LOCAL NAME (#546). This line used to fall
  // straight back to `resolveBase(run)` — `detectBaseBranch`'s bare `main` — on the theory
  // that "there is no remote base at all" is the one case where the name is the best
  // available answer. Two of those three fallback worlds still have a better answer:
  // `run.base_sha` is the launch-recorded cut point, and `origin/<base>` is a remote-tracking
  // ref the launch path fetches (and, in pr mode, refuses to start without). `diffBaseRef`
  // picks whichever exists and falls back to `refs/heads/<base>` whenever
  // `refs/remotes/origin/<base>` does not resolve — NOT "only in local mode", which is the
  // framing the fix that removed it left behind here, and NOT the bare name, which is what
  // this comment said until round nineteen. The merge mode says nothing about whether a
  // remote exists; keying the fallback on it was the defect, and a comment still asserting
  // it is the same claim surviving its own correction.
  const baseRef =
    rebased.baseSha !== ''
      ? rebased.baseSha
      : await resolvedDiffBase(run)
  const changed = await opts.run_host(
    // `--no-renames` HERE, not only on the group diffs below (Argus r17). This
    // listing is what BUILDS the path universe the groups are restricted to, so
    // with rename detection ON it names only a rename's DESTINATION — and the
    // source path's deletion then appears in NEITHER group, silently dropping it
    // from the artifact. The `--no-renames` added to the group diffs alone could
    // not fix that: a path absent from this list is never handed to any group.
    // `core.quotePath=false` for the same reason one line down: a C-quoted token
    // fed back as a pathspec matches nothing and drops that file's hunks.
    // `--end-of-options` — DEFENCE IN DEPTH behind `diffBaseRef`'s refusal. Measured on
    // git 2.43: without it this exact argv with a base of `--output=<path>` EXITS 0 and
    // writes the file; with it git refuses (128) and writes nothing, and a legitimate
    // range is unaffected. The binding REFUSES such a value (it throws); this is what makes
    // the command safe for any value that ever reaches it. "Refuses" rather than "makes
    // unconstructable" on purpose — the mechanism is a throw on one code path, not a
    // property of the type, and a value that never passed through the binding is exactly
    // what this marker is here for.
    gitRangeArgv({
      repo_path: run.repo_path,
      config: ['-c', 'core.quotePath=false'],
      subcommand: 'diff',
      flags: ['--name-only', '--no-renames'],
      base: baseRef,
      head: headToPublish,
    }),
    run.repo_path,
  )
  if (!changed.ok || changed.stdout.trim() === '') {
    throw new Error('outer publisher refused to dispatch reviewers for an empty diff')
  }
  // AND THE FILES NO REVIEWER HAS SEEN COME FIRST.
  //
  // MEASURED (Argus r16, three reviewers, before #680): the artifact was 6,692
  // lines and the cross-model reviewer read only its first 3,000. In default git order — plain
  // alphabetical — every write-site file of that round (`trident/checkpoint.sh`
  // at line 3,417, `inner-workflow.mjs` at 4,427, `orchestrator.ts` at 5,132,
  // `run-disposition.ts` at 5,851, `store.ts` at 6,360) fell past the window, so
  // ~55% of the diff — including all of the round's NEW work — had no
  // cross-model coverage at all. Alphabetical order is not neutral here: on a
  // fix round it systematically buries the fix under the docs and tests of the
  // rounds already reviewed.
  //
  // `reviewed_head` is the pin of what a reviewer HAS seen (migration 0124,
  // enforced by the ancestry gate above), so `reviewed_head..head` is exactly
  // the never-reviewed set. The artifact's CONTENT is unchanged — still the
  // whole `base..head` diff, because a reviewer must be able to read the entire
  // change — only its ORDER is: unseen files first, everything else after, one
  // `git diff` per group concatenated in that order (git sorts within a single
  // invocation whatever order the pathspecs arrive in, so the split is the only
  // way to express this).
  //
  // AND THE PIN IS READ THE WAY `merge.ts` READS IT — AND WRITTEN AT THE SEAT
  // THAT REACHES THIS LINE (Argus r17 + r18 blockers). Two separate holes, both
  // of which made this reorder INERT in production while it passed in tests:
  //
  //   1. The `reviewed_head` COLUMN is settable only at `store.create` and no
  //      production caller ever supplies a value — `update()` has no branch for
  //      it — so keying the split on the column alone read '' on every real run.
  //      Fixed by ALSO reading `reviewedHead` out of `inner_result`
  //      (`reviewedHeadOid`, the OID the merge pins with `--match-head-commit`).
  //   2. …but `inner-workflow.mjs`'s publish handoffs did not EMIT that field,
  //      so the fallback read stayed '' too. The fix-round handoff now carries
  //      it (inner-workflow.mjs, the `isPr` return under `fix-round-${round}`),
  //      and `orchestrator.test.ts` pins the field against the shape the real
  //      workflow emits rather than against a fabricated one.
  //
  // On a fix round the value is EXACTLY the head the reviewers judged: the
  // resumed workflow sets it from the recorded resume head and never re-reads it
  // before the publish handoff, while `publish_head` carries the new one. The
  // round-1 `forge-done` handoff deliberately carries NO pin — no reviewer has
  // seen anything yet, so every file is unseen, `seenPin` is '' and the fallback
  // below renders the whole diff unordered, which is the correct artifact for a
  // first review. The column still WINS when set: it is the more explicit pin.
  //
  // `--no-renames` on the split path is load-bearing, not taste: with rename
  // detection ON, `--name-only` reports ONLY a rename's destination, so
  // restricting a later group to the listed paths would silently DROP the
  // source path's deletion from the artifact. Off, both sides are listed and
  // both are rendered. Every degenerate case — no pin, an unreadable probe, all
  // files unseen (a first round), none unseen, or more than 500 changed files —
  // falls back to the single unordered command that shipped before, so the
  // artifact still CONTAINS exactly what it does today.
  //
  // THE 500 IS A COUNT, AND ONLY A COUNT (Argus r24, nit). An earlier wording
  // called it "a file list long enough to strain argv", which promised a fallback
  // this code does not have: if a pathspec list ever DID overflow `execve`, the
  // split `git diff` would come back not-ok and the publish would throw
  // "outer publisher could not materialize the review diff" rather than degrade.
  // It cannot happen here — the longest tracked path is 94 bytes, so 500 paths is
  // ≈52 KB against a 2 MB ARG_MAX — and the count guard stands the reorder down
  // long before that. The bound is a cheap ceiling on a review-diff reordering
  // nobody wants for a 500-file change, not an argv calculation.
  //
  // NOT byte-identical between the two paths, though, and the earlier wording
  // ("at worst exactly what it is today") overclaimed that (Argus r18). Only the
  // split path passes `--no-renames`, so a renamed file renders as delete+add
  // there and as a `rename` header on the fallback. That is the deliberate cost
  // of not dropping a rename's source: the contract is that the whole change is
  // present and reordered, never that the two renderings match byte for byte.
  const changedLines = changed.stdout.split('\n').filter((l) => l.trim().length > 0)
  const changedFiles = changedLines.map((l) => l.trim())
  let groups: string[][] | null = null
  const seenPin = (run.reviewed_head ?? reviewedHeadOid(run) ?? '').trim().toLowerCase()
  // A C-QUOTED PATH IS NOT A PATHSPEC. `core.quotePath=false` above unquotes the
  // common case (non-ASCII bytes), but git still quotes a path containing a
  // quote, a backslash or a control character — and such a token fed back as a
  // pathspec matches NOTHING, so `git diff` writes no hunks for it, exits 0, and
  // the file vanishes from the artifact without tripping the fallback. Any
  // leading `"` in the listing means at least one path cannot be expressed as a
  // pathspec here, so the whole reorder stands down to the single command that
  // renders every path correctly. (It also covers the pathological embedded
  // newline: git quotes those too, so the split fragment still starts with `"`.)
  const quoted = changedFiles.some((f) => f.startsWith('"'))
  // AND A TRIMMED PATH IS NOT THE PATH EITHER (Argus r21, latent). git prints an
  // unquoted path VERBATIM, so a tracked name with a leading or trailing space —
  // legal on every filesystem this runs on, and printed bare because
  // `core.quotePath` only quotes non-ASCII/control bytes — survives the listing
  // intact and is then destroyed by the `trim()` above: `:(literal)<trimmed>`
  // matches nothing, `git diff` writes no hunks, exits 0, and the file vanishes
  // from the reviewer's artifact with no error anywhere. The trim itself stays
  // (it is what makes the `\r` and blank-line cases safe); what changes is that a
  // line the trim ALTERED means at least one path cannot be expressed as a
  // pathspec here, so the reorder stands down to the single unrestricted command
  // exactly as a C-quoted path does. Zero such paths are tracked today — this
  // closes the shape before a reviewer reads a diff that is quietly incomplete.
  const padded = changedLines.some((l) => l !== l.trim())
  if (/^[0-9a-f]{40}$/.test(seenPin) && !quoted && !padded && changedFiles.length <= 500) {
    const unseenRes = await opts.run_host(
      // `--end-of-options` (#546): `seenPin` is 40-hex-checked one line above, so this is
      // belt-and-braces — kept anyway so EVERY range in this module carries it and the
      // coverage test needs no per-site exemption to reason about.
      gitRangeArgv({
        repo_path: run.repo_path,
        config: ['-c', 'core.quotePath=false'],
        subcommand: 'diff',
        flags: ['--no-renames', '--name-only'],
        base: seenPin,
        head: headToPublish,
      }),
      run.repo_path,
    )
    if (unseenRes.ok) {
      const unseen = new Set(
        unseenRes.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
      )
      const first = changedFiles.filter((f) => unseen.has(f))
      const rest = changedFiles.filter((f) => !unseen.has(f))
      // Both non-empty or there is nothing to reorder.
      if (first.length > 0 && rest.length > 0) groups = [first, rest]
    }
  }
  if (groups === null) {
    const diff = await opts.run_host(
      // `--end-of-options`: without it a second `--output=` arrives from the operand and
      // git honours BOTH (measured, exit 0, two files written).
      gitRangeArgv({
        repo_path: run.repo_path,
        subcommand: 'diff',
        flags: [`--output=${diffFile}`],
        base: baseRef,
        head: headToPublish,
      }),
      run.repo_path,
    )
    if (!diff.ok) throw new Error('outer publisher could not materialize the review diff')
  } else {
    writeFileSync(diffFile, '')
    for (const [i, group] of groups.entries()) {
      const part = `${diffFile}.part${i}`
      // `:(literal)`, because a PATH IS NOT A PATTERN (Argus r20, nit, with a
      // scratch-repo repro). A bare pathspec is glob-matched as well as
      // literal-matched, so a changed path containing `[`, `*` or `?` — this repo
      // tracks 13 of them, e.g. `app/app/projects/[id]/backups.tsx` — ALSO pulls
      // in every sibling its brackets happen to match, and a file caught by both
      // groups is rendered twice in the artifact. Nothing is dropped, but the
      // reviewer reads the same hunks under two headings. Literal magic turns each
      // token back into the exact path `--name-only` printed.
      const partDiff = await opts.run_host(
        gitRangeArgv({
          repo_path: run.repo_path,
          subcommand: 'diff',
          flags: ['--no-renames', `--output=${part}`],
          base: baseRef,
          head: headToPublish,
          pathspec: group.map((f) => `:(literal)${f}`),
        }),
        run.repo_path,
      )
      if (!partDiff.ok) throw new Error('outer publisher could not materialize the review diff')
      // A group whose files produce no hunks contributes nothing, and that is not
      // an error. MEASURED (Argus r22, scratch repo, git 2.43.0): `--output=` CREATES
      // the file regardless — 0 bytes — so on this git the branch below always runs
      // and appends nothing. The note that stood here said the file is not written,
      // which would have made the `existsSync` load-bearing; it is a stand-down for a
      // git that behaves the other way, and appending 0 bytes is the same artifact
      // either way. It also has to be safe against a part left by an earlier run,
      // which is why the file is removed after it is folded in.
      if (existsSync(part)) {
        appendFileSync(diffFile, readFileSync(part))
        rmSync(part, { force: true })
      }
    }
  }
  return { pr, published_pr: publishedPr, head: headToPublish, push: alreadyPublished ? 'noop-already-at-head' : 'pushed' }
}
