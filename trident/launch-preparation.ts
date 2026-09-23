import type { BuildTridentOrchestratorOptions } from './orchestrator.ts'
import type { TridentRun } from './store.ts'
import type { AdvanceOutcome } from './state-machine.ts'
import { CONFIGURED_CODE_CAVEAT, composeWrongBaseRefusal, foldEvidence, foldRefName } from './wrong-base-remedy.ts'
import { gitRangeArgv } from './git-range.ts'
import { redactPushError } from './publish-failure.ts'
import { readBuildModeState } from './build-mode-state.ts'
import type { HostCommandResult } from './git-mode.ts'

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface PreparedLaunch {
  pinnedRun: TridentRun
  base: string
  base_sha: string | null
  resume_checkpoint: string | null
  resume_checkpoint_head: string | null
  resume_findings: string | null
  resume_live_head: string | undefined
  id: string
}

export interface LaunchPreparationDeps {
  resolveBase(run: TridentRun): Promise<string>
  detectExistingPr(run: TridentRun): Promise<number | null>
  mint(): unknown
  failedRun(run: TridentRun, reason: string, preserve: boolean): TridentRun
  resumeHeadUnreadable(run: TridentRun, cause: string, checkpoint: string | null): TridentRun
  resolveResumeLiveHead: typeof import('./orchestrator.ts').resolveResumeLiveHead
  resumeHeadDecides: typeof import('./orchestrator.ts').resumeHeadDecides
}

export async function prepareLaunch(
  run: TridentRun,
  opts: Pick<BuildTridentOrchestratorOptions, 'run_host' | 'sleep' | 'list_stage_events'>,
  deps: LaunchPreparationDeps,
): Promise<AdvanceOutcome | PreparedLaunch> {
  const {
    resolveBase,
    detectExistingPr,
    mint,
    failedRun,
    resumeHeadUnreadable,
    resolveResumeLiveHead,
    resumeHeadDecides,
  } = deps
  let modeState: ReturnType<typeof readBuildModeState>
  try {
    modeState = readBuildModeState(opts.list_stage_events?.(run.id) ?? [], run)
  } catch {
    return {
      run: failedRun(run, 'Project driver canonical checkpoint is unreadable or has invalid identity or state', false),
      changed: true, waiting: false, note: `${run.phase} → failed (invalid project driver checkpoint)`,
    }
  }
  const base = await resolveBase(run)
  let resume_checkpoint = modeState?.checkpoint.stage ?? run.inner_checkpoint
  // MID-LOOP RESUME — the checkpoint travels WITH the commit it was recorded
  // against (and, for a REQUEST_CHANGES checkpoint, the findings recorded with
  // it). Threading the name alone is what forced every relaunch to rebuild: a
  // verdict is about a COMMIT, and without the OID the workflow cannot tell
  // whether the branch still holds the code that verdict was about.
  let resume_checkpoint_head = modeState ? modeState.checkpoint.head : run.inner_checkpoint_head
  let resume_findings = modeState ? JSON.stringify(modeState.checkpoint.findings) : run.inner_checkpoint_findings
  // MID-LOOP RESUME — READ the live branch head HERE, in the outer loop, because
  // THIS is the credentialed host boundary: `opts.run_host` already runs every other
  // git command for this run. The workflow's `head-probe-round-resume` agent seat
  // survives only as a fallback for launchers that predate this arg. Derive the
  // recorded OID EXACTLY as the workflow does (inner-workflow.mjs, resume site): the
  // `outer-published:<oid>:r:t` capture takes precedence over the checkpoint column.
  const published =
    typeof resume_checkpoint === 'string'
      ? resume_checkpoint.match(/^outer-published:([0-9a-f]{40}|[0-9a-f]{64}):(\d+):(\d+)(:deviated)?$/)
      : null
  const recorded = (published?.[1] ?? resume_checkpoint_head ?? '').trim().toLowerCase()
  // Only read when the answer can change a decision: no checkpoint, no recorded OID
  // to compare against, or no branch → the workflow rebuilds regardless, and a fresh
  // launch must stay byte-identical (no extra git command, no extra arg).
  let resume_live_head =
    // The typed host measures its own branch and validates the checkpoint head.
    // A remote legacy probe must not erase a pending provider arm or an unpushed build.
    modeState === null &&
    resume_checkpoint !== null &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(recorded) &&
    typeof run.branch === 'string' &&
    run.branch.length > 0
      ? await resolveResumeLiveHead(
          opts.run_host,
          {
            repo_path: run.repo_path,
            branch: run.branch,
            // Deferred Task sequence waves deliberately leave origin stale. These checkpoints
            // rebuild regardless of the head; the local match is planner-only, allowing
            // the clean name to open plan:next through cleanContinuation.
            merge_mode:
              resume_checkpoint === 'task-built' ||
              resume_checkpoint === 'task-built-deviated'
                ? 'local'
                : run.merge_mode,
          },
          // The RETRY SPACING seam (see `resolveResumeLiveHead`): a `pr`-mode read is a
          // network call and the consequence of `''` is terminal, so the attempts are
          // spread over real time in production and collapsed to nothing in the suite.
          opts.sleep,
        )
      : undefined
  // SEEDED RESUME — REVALIDATED AT LAUNCH, because the seed's proof was taken at
  // DISPATCH and is consumed here, one process later.
  //
  // The dispatch chokepoint may create a row already carrying a prior terminal
  // run's built-but-never-reviewed checkpoint (board-dispatch.ts), having proven
  // the branch tip was exactly that commit. That proof is what makes seeding safe
  // — a seeded row has a non-null `inner_checkpoint`, so `freshLaunch` below is
  // false and the base RE-PIN is skipped (the seed carries the prior run's pin).
  // The leftover-branch ancestry refusal is NOT skipped: it is armed for
  // `freshLaunch || seeded_resume` (Argus r3), and a legitimate seed satisfies it
  // through the containment / `ownCrashLeftover` exemptions. If the branch moved
  // in between (another lane, a human, a slug collision the task-text check could
  // not see), the premise is false and RESUMING on the strength of it would be
  // adopting work this lane does not own.
  //
  // `workflow_run_id === null` is what identifies a SEEDED row rather than a
  // genuine mid-run resume: it is written on the first fire (below) and stays
  // null until then, so a row holding a checkpoint it has never fired for can
  // only have been handed one. A genuine resume is deliberately untouched — its
  // branch legitimately advances past the last checkpoint with its OWN commits.
  //
  // FALSIFIED means the branch DEMONSTRABLY holds a different commit — a real
  // full OID that is not the recorded one. An unreadable head (`''`) or a branch
  // the remote says is gone (`'absent'`) is NOT evidence of another lane's work,
  // and both are already answered downstream: the bounded fast-exit below, and
  // `classifyResume`'s own rebuild. Narrow on purpose, because the only thing
  // this check is entitled to undo is the guard-stripping the seed bought.
  //
  // AND IT MUST STAY NARROW, which is not a preference: `beginCrashRecovery` and
  // `beginInfraRetry` (store.ts) NULL `workflow_run_id` on a row that earned its
  // checkpoint by firing, so `workflow_run_id === null` ALONE is ALSO true for a
  // recovered run whose branch legitimately advanced past its last checkpoint with
  // its OWN commits. Treating that row as a seed would throw away exactly the built
  // work this card exists to stop throwing away, the first time a launcher died or
  // an origin read blipped — the falsification below would null its checkpoint AND
  // its base pin, and the (now-armed) leftover-branch guard would then fail the run
  // terminally over the commits it just made. So the discriminator ALSO requires a
  // row that has never spent a recovery budget unit: `crash_recoveries` and
  // `infra_retries` are the durable counters those two store methods are the only
  // writers of, they are initialised to 0 at create, and a SEEDED row is brand new
  // (`createIfClaimsAvailable`, board-dispatch.ts) so both are 0 on it by
  // construction. A recovered row therefore reads as the genuine mid-run resume it
  // is: seed untouched, guard not armed by this branch.
  //
  // Falsified → drop the ENTIRE seed (checkpoint, head, findings, base pin) and
  // continue as the byte-identical fresh dispatch this card would have had before
  // the seed existed: base re-pinned, leftover-branch guard armed, no resume arg
  // threaded to the workflow. Not a failure — there is nothing wrong with the
  // card, only with the shortcut.
  const never_recovered = (run.crash_recoveries ?? 0) === 0 && (run.infra_retries ?? 0) === 0
  const seeded_resume =
    modeState === null && run.inner_checkpoint !== null && run.workflow_run_id === null && never_recovered
  const seed_falsified =
    seeded_resume &&
    typeof resume_live_head === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resume_live_head) &&
    resume_live_head !== recorded
  const falsification = seed_falsified
    ? { recordedHead: recorded, observedHead: resume_live_head!, baseSha: run.base_sha } : undefined
  if (seed_falsified) {
    resume_checkpoint = null
    resume_checkpoint_head = null
    resume_findings = null
    resume_live_head = undefined
  }
  const seedCheckedRun: TridentRun = seed_falsified
    ? {
        ...run,
        retry_seed_falsified: falsification!,
        inner_checkpoint: null,
        inner_checkpoint_head: null,
        inner_checkpoint_findings: null,
        base_sha: null,
      }
    : run

  // PART 2b, OUTER FAST-EXIT — the launcher itself just failed 3 code reads of the
  // head. Firing the workflow now would spend a fire only to have `classifyResume`
  // return the bounded stop ({ mode: 'stop', reason: 'head-unreadable' }) for every
  // checkpoint except 'pr-merged' (resolved to `merged` BEFORE the head check —
  // exempted here for exactly that reason). classifyResume stays the single semantic
  // decider; this is only the cheap exit for the one case whose outcome is already
  // known at this boundary. `failedRun` spreads `run`, so inner_checkpoint /
  // inner_checkpoint_head / inner_checkpoint_findings survive untouched — which
  // preserves the EVIDENCE (what was built, and where), and nothing more: a re-run is
  // a fresh dispatch with null checkpoints, so it rebuilds. See `resolveResumeLiveHead`
  // for why that is the trade, and IMPLEMENTATION_PLAN.md for the resume follow-up.
  //
  // SOME CHECKPOINT NAMES ARE EXEMPT, each because classifyResume does not consult
  // the head for them, so this exit would pre-empt a decision it does not share:
  // 'pr-merged' (resolved to `merged`) and the empty name (resolved to `rebuild`,
  // reason 'no-checkpoint' — there is nothing recorded to preserve) are answered
  // before the head check; the head-INDEPENDENT names rebuild on every head. See
  // `resumeHeadDecides`.
  //
  // KNOWN, AND DELIBERATELY NOT SPECIAL-CASED (Argus r3, minor): a salvage-SEEDED
  // brand-new dispatch whose head read fails at launch takes this exit and ends
  // `failed` without ever building — a run that has nothing of its own to preserve.
  // The tempting fix (drop the seed and build fresh) cannot be written safely with
  // the discriminator available here, because `beginCrashRecovery` /
  // `beginInfraRetry` null `workflow_run_id`, so the same test also matches a
  // recovered run whose committed work this exit exists to protect. It is loud and
  // self-healing — a re-dispatch re-seeds from the same prior row — so it costs one
  // re-dispatch, and the alternative risks the rebuild this card exists to stop.
  const resume_checkpoint_name = (resume_checkpoint ?? '').trim()
  // THE PR LINK IS RESOLVED BEFORE THE EXIT, NOT AFTER IT (Argus r5). This used to sit
  // below, so the one path that ends a run WITHOUT ever firing recorded a terminal row
  // with `pr: null` — and "re-run when the read succeeds" is advice a human follows by
  // opening the PR the recorded work is on. The exit is rare and already terminal; one
  // `gh pr view` to make the record point at the work is worth more than the call saved.
  const existingPr = run.pr ?? (await detectExistingPr(run))
  const launchRun: TridentRun =
    existingPr !== null && run.pr === null
      ? { ...seedCheckedRun, pr: existingPr }
      : seedCheckedRun
  if (resume_live_head === '' && resumeHeadDecides(resume_checkpoint_name, run.execution_strategy === 'task_sequence')) {
    const cause = `could not read the head of ${run.branch}; the recorded work is at ${recorded}; re-run when the read succeeds`
    return {
      run: resumeHeadUnreadable(launchRun, cause, resume_checkpoint),
      changed: true,
      waiting: false,
      note: `${launchRun.phase} → failed (resume head unreadable — bounded stop, no fire)`,
    }
  }

  const freshLaunch = resume_checkpoint === null
  const priorBaseSha = launchRun.base_sha
  const freshBuild = freshLaunch && priorBaseSha === null
  let base_sha: string | null = priorBaseSha
  let base_behind: number | null = null
  // Whether the base fetch below actually RAN. The UNKNOWN refusals downstream count their
  // own writes, and a fetch is not write-free (see `noWrites` there) — but only this arm
  // performs one, so a flat claim either over- or under-counts depending on the path taken.
  let fetchedBase = false
  // WHAT THE REFUSALS BELOW QUOTE, AND WHAT THE FETCH ARGV IS, ARE THE SAME STRING.
  //
  // AN EXPLICIT DESTINATION REFSPEC (Argus finding, reproduced on git 2.43). `git fetch
  // --no-tags origin <base>` updates FETCH_HEAD and only INCIDENTALLY
  // refs/remotes/origin/<base>: under a narrowed `remote.origin.fetch` it exits 0 while that
  // tracking ref does NOT move — and this path then rev-parses that ref for `base_sha`, pins
  // it, and cuts the build branch from it, while the refusal downstream states as fact that
  // the fetch wrote it. A stale base is the very thing the retry above exists to avoid, and a
  // false write-accounting sentence is the overclaiming this message class exists to stop.
  // Naming the destination closes both. `wrong-base-remedy.ts` already fetches its own branch
  // this way, for this reason.
  const baseRefspec = `+refs/heads/${base}:refs/remotes/origin/${base}`
  // AND THE BASE IS FOLDED WHEREVER A REFUSAL QUOTES IT (Argus finding). It arrives from
  // `detectBaseBranch`/`opts.base_branch`, and git accepts U+2028 and U+202E in a branch name
  // exactly as it does for the build branch — so a base name could forge a line inside these
  // pre-launch refusals the same way. `foldRefName`, not `foldEvidence`: a name field stays
  // one token, because folding a forgery codepoint to an ASCII space is what broke the
  // wrong-base classifier's anchor in `delivery.ts`.
  const baseProse = foldRefName(base)
  // AND THE REPO PATH IS FOLDED FOR EVERY PRE-LAUNCH REFUSAL, not only the ancestry ones
  // (Argus blocker, reproduced by two reviewers). This binding used to be declared INSIDE the
  // ancestry block below, so the two refusals composed before it — the fetch failure and the
  // tip-resolution failure — interpolated `launchRun.repo_path` RAW and passed git's stderr
  // through `redactPushError` alone, which redacts credentials and truncates but folds neither
  // a newline nor a delete command. Both messages are persisted, re-read, and routed by
  // `delivery.ts`'s PRE_LAUNCH_PREFIX classifier exactly like the ancestry ones, so a legal
  // path — `git init` and `git worktree add` both accept a newline, and store.ts persists it
  // verbatim — or a hostile fetch stderr could forge a line carrying `git branch -D -- victim`
  // inside the very message class this change exists to make evidence-honest. One binding,
  // declared once, above every path that can refuse.
  const repoProse = foldEvidence(launchRun.repo_path)
  // Git's own words about a failure, credential-redacted FIRST and then folded — the same
  // order the ancestry arms' `probeDetail` uses. `foldEvidence` also carries the 300-character
  // bound the hand-rolled `.slice(-300)` used to carry, and MARKS its truncation.
  const gitDetail = (text: string): string => foldEvidence(redactPushError(text).trim())
  if (freshBuild && launchRun.merge_mode === 'pr') {
    fetchedBase = true
    // `--no-recurse-submodules` IS PART OF THE WRITE BOUNDARY THIS PATH ASSERTS (Argus
    // blocker). `git fetch` recurses into submodules whenever `fetch.recurseSubmodules` says
    // so — the config default is `on-demand`, and a repo may set `true` outright — and a
    // recursed fetch writes inside the SUBMODULE's git dir, e.g. `<repo>/sub/.git/refs/
    // remotes/origin/main`. Reproduced on a populated old-form submodule with
    // `fetch.recurseSubmodules=true`: this exact command moved that ref. That is git's OWN
    // write, so the hook caveat does not cover it, and it falsifies the sentence this refusal
    // and `delivery.ts`'s LAUNCH_PATH_FETCH both print — that the only writes are origin's
    // base pointer and git's bookkeeping under `.git` (singular, this repo's). The flag is
    // free here: nothing on the launch path reads a submodule, only `refs/heads/<base>` is
    // wanted, and the explicit refspec above already says so.
    const fetchCmd = [
      'git',
      '-C',
      launchRun.repo_path,
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      'origin',
      baseRefspec,
    ]
    let fetched = await opts.run_host(fetchCmd, launchRun.repo_path)
    if (!fetched.ok) {
      await (opts.sleep ?? realSleep)(1000)
      fetched = await opts.run_host(fetchCmd, launchRun.repo_path)
    }
    if (!fetched.ok) {
      const detail = gitDetail(fetched.stderr)
      return {
        run: failedRun(launchRun, `trident infra: could not fetch origin/${baseProse} in ${repoProse} before cutting the build branch — refusing to branch from the stale local ref; the build was NOT started: ${detail}`, false),
        changed: true,
        waiting: false,
        note: `${launchRun.phase} → failed (base fetch failed — no fire)`,
      }
    }
    const remoteRef = `refs/remotes/origin/${base}`
    const resolved = await opts.run_host(
      ['git', '-C', launchRun.repo_path, 'rev-parse', '--verify', `${remoteRef}^{commit}`],
      launchRun.repo_path,
    )
    const oid = resolved.stdout.trim().toLowerCase()
    if (!resolved.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
      const detail = gitDetail(resolved.stderr || resolved.stdout)
      return {
        run: failedRun(launchRun, `trident infra: fetched origin/${baseProse} but could not resolve its tip in ${repoProse}; the build was NOT started: ${detail}`, false),
        changed: true,
        waiting: false,
        note: `${launchRun.phase} → failed (base resolve failed — no fire)`,
      }
    }
    base_sha = oid
    const behind = await opts.run_host(
      // `--end-of-options` (#546). The `refs/heads/` prefix already makes an option-shaped
      // base non-option-shaped, so this is the least exposed range here; it carries the
      // marker so the module's rule has no exceptions to remember.
      gitRangeArgv({
        repo_path: launchRun.repo_path,
        subcommand: 'rev-list',
        flags: ['--count'],
        base: `refs/heads/${base}`,
        head: remoteRef,
      }),
      launchRun.repo_path,
    )
    const count = Number.parseInt(behind.stdout.trim(), 10)
    if (behind.ok && Number.isFinite(count)) base_behind = count
  } else if (freshBuild && launchRun.merge_mode === 'local') {
    const resolved = await opts.run_host(
      ['git', '-C', launchRun.repo_path, 'rev-parse', '--verify', `refs/heads/${base}^{commit}`],
      launchRun.repo_path,
    )
    const oid = resolved.stdout.trim().toLowerCase()
    if (resolved.ok && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) base_sha = oid
  }
  let pinnedRun = freshBuild ? { ...launchRun, base_sha, base_behind } : launchRun

  // THE LOCAL-BRANCH OWNERSHIP CHECK RUNS FOR EVERY ROW THAT HAS NOT FIRED, not
  // only for `freshLaunch` ones (Argus r3 blocker). It used to be gated on
  // `inner_checkpoint === null`, so a salvage-SEEDED row skipped it — and the seed
  // is a proof about the ref `resolveResumeLiveHead` reads, which in `pr` mode is
  // the REMOTE. An absent-or-unreadable remote (and, in pr mode, even a matching
  // one) says nothing about the LOCAL branch, and the local branch is what Forge
  // is told to re-enter. So the one guard that can tell "this lane's commits" from
  // "another lane's" was being dropped on the strength of evidence that does not
  // speak to it: pre-seed the same card refused loudly, post-seed it silently
  // built on whatever was sitting there.
  //
  // Running it for a seeded row costs one `rev-parse` plus one `merge-base` and
  // refuses NOTHING that was previously fine: the check already exempts a tip
  // contained in the base, and `ownCrashLeftover` exempts a tip descended from
  // this row's OWN `base_sha` pin AND containing this row's OWN recorded
  // checkpoint head — which is precisely the shape a legitimate salvage seed has
  // (the pin and the head both travel with the seed), and which a sibling lane
  // cutting the same branch name from the same base does NOT. `seeded_resume` is
  // the "never fired, never recovered" test, and a row with no pin at all still
  // skips the whole block, so no legacy row can be refused for lacking one.
  if (
    (freshLaunch || seeded_resume) &&
    base_sha !== null &&
    typeof launchRun.branch === 'string' &&
    launchRun.branch.length > 0
  ) {
    const branchTipResult = await opts.run_host(
      ['git', '-C', launchRun.repo_path, 'rev-parse', '--verify', '--quiet', `refs/heads/${launchRun.branch}`],
      launchRun.repo_path,
    )
    const branchTip = branchTipResult.stdout.trim().toLowerCase()
    // A missing or ambiguous local ref is the normal first-launch shape: Forge
    // will cut it from pinnedRun.base_sha. Once git resolves a concrete tip,
    // however, only ancestry can prove that this lane owns what is already there.
    if (branchTipResult.ok && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(branchTip)) {
      // `merge-base --is-ancestor` answers with THREE exits, not two: 0 yes, 1 no, and
      // ANYTHING ELSE an error (128 on a corrupt or missing object, 124 when a watchdog
      // killed it, non-zero when the spawn itself failed). Reading "not ok" as "proven
      // divergence" turns a probe FAILURE into the positive claim the refusal below then
      // prints — "already carries N commit(s) not on origin/<base> — it was not cut from
      // origin/<base>" — evidence nothing established, in the one message class this whole
      // change exists to make evidence-honest (Argus blocker). The composer's inner
      // publication probe already distinguishes the three (`ancestryUnknown` in
      // wrong-base-remedy.ts); the OUTER guard now does too. UNKNOWN refuses — fail-closed,
      // the build is not started — but it refuses as what it is, and names no destructive
      // act (docs/INVARIANTS.md §12 invariant 122).
      //
      // AND EXIT 1 IS ONLY A "NO" IN A COMPLETE HISTORY (Argus blocker). Past a shallow
      // boundary the parent commits do not exist locally, so `merge-base --is-ancestor B C`
      // exits 1 for a B that IS an ancestor of C — reproduced on git 2.43 with a depth-1
      // clone and a true parent. This checkout MAY be shallow: `healShallowCheckout` above
      // documents that shape arriving in production ("install.sh used to clone at depth 1,
      // and hand-made clones still can") and it runs only on the REPLAY path, never before
      // this guard. So a shallow repo turned a true ancestor into the refusal "already
      // carries N commit(s) not on origin/<base> — it was not cut from origin/<base>": a
      // false positive, in the exact message class this change exists to make evidence-honest.
      // Exit 0 stays definitive — finding the ancestry is positive proof, and truncation can
      // only hide ancestry, never invent it. Exit 1 is downgraded to UNKNOWN unless the
      // checkout is PROVEN complete, by the same `rev-parse --is-shallow-repository` probe
      // `healShallowCheckout` uses; an unreadable depth is itself UNKNOWN, which is
      // fail-closed and authorises nothing.
      //
      // Probed LAZILY: a contained branch (the overwhelmingly common shape) never needs the
      // answer, and never pays for it.
      //
      // AND NOT MEMOISED (Argus blocker). An earlier draft cached the first answer for the
      // whole guard pass, on the premise that deepening is one-way. It is not: `git fetch
      // --depth=1` re-truncates a COMPLETE checkout in place, reproduced on git 2.43, where
      // `rev-parse --is-shallow-repository` flips false → true and `merge-base --is-ancestor`
      // starts exiting 1 on a genuine ancestor. Under the cache, a depth read taken while the
      // checkout was complete authorised BOTH later exit-1 reads — including reads taken after
      // a truncation — and the pair was published as proven divergence: the false wrong-base
      // refusal and its safe-delete chain on a correctly based branch, the exact outcome this
      // change exists to remove. `lastDepth` therefore records only the MOST RECENT answer, for
      // the detail line to quote, and every caller re-reads.
      let lastDepth: 'yes' | 'no' | 'unknown' | null = null
      const checkoutIsShallow = async (): Promise<'yes' | 'no' | 'unknown'> => {
        const probe = await opts.run_host(
          ['git', '-C', launchRun.repo_path, 'rev-parse', '--is-shallow-repository'],
          launchRun.repo_path,
        )
        const answer = probe.stdout.trim()
        lastDepth = !probe.ok ? 'unknown' : answer === 'true' ? 'yes' : answer === 'false' ? 'no' : 'unknown'
        return lastDepth
      }
      // AND THE TWO READS MUST DESCRIBE ONE HISTORY (Argus blocker). The exit-1 read and the
      // depth read are separate `git` invocations, so a checkout unshallowed BETWEEN them
      // pairs a STALE exit 1 — the one a TRUE ancestor produces past a shallow boundary — with
      // a now-complete depth answer, and the pair reads as proven divergence: the false
      // wrong-base refusal and its safe-delete chain, on a correctly based branch, which is the
      // exact outcome this change exists to remove. The race is not hypothetical here: the
      // refusal's own `probeDetail` tells the operator to run `git fetch --unshallow origin`,
      // which is precisely the event that closes the window, and an earlier comment asserting
      // "the depth cannot change under a single guard pass" enforced nothing.
      //
      // So "no" now rests on an exit 1 observed AFTER completeness was proven: the probe is
      // RE-RUN once the depth answers complete, and only a second exit 1 answers "no". A re-run
      // that exits 0 — the unshallow landed the missing parents between the reads — answers
      // "yes", and any other exit is UNKNOWN. The probe is spawned HERE rather than by the
      // caller so the re-run is the identical argv, and the RESULT that the detail line quotes
      // is the one the verdict actually rests on.
      //
      // AND THE RACE RUNS BOTH WAYS (Argus blocker). The re-read alone was justified by
      // "deepening is one-way — nothing re-truncates a checkout in place", which is false:
      // `git fetch --depth=1` truncates a complete checkout, and after it a TRUE ancestor exits
      // 1 again. One depth read taken BEFORE the confirming read therefore could not speak for
      // the history the confirming read saw. So the confirming read is BRACKETED: depth is read
      // once before it and once AFTER it, both non-cached, and "no" requires the checkout to
      // have measured complete on both sides of the read the verdict rests on. A truncation
      // landing anywhere across that read makes the closing probe answer "yes" (or fail), and
      // the verdict degrades to UNKNOWN, which authorises nothing. What remains is not a lock —
      // a truncate AND a re-deepen both completing inside the bracket would still be missed —
      // but that is a two-step adversarial sequence, where the shape actually observed in this
      // repo (a single depth-limited fetch, which LEAVES the checkout shallow) is caught.
      const ancestry = async (
        argv: string[],
      ): Promise<{ verdict: 'yes' | 'no' | 'unknown'; res: HostCommandResult }> => {
        const res = await opts.run_host(argv, launchRun.repo_path)
        if (res.ok) return { verdict: 'yes', res }
        if (res.exit_code !== 1 || res.timed_out === true) return { verdict: 'unknown', res }
        if ((await checkoutIsShallow()) !== 'no') return { verdict: 'unknown', res }
        const confirm = await opts.run_host(argv, launchRun.repo_path)
        if (confirm.ok) return { verdict: 'yes', res: confirm }
        if (confirm.exit_code !== 1 || confirm.timed_out === true) return { verdict: 'unknown', res: confirm }
        // The closing half of the bracket: the depth that licenses reading THIS exit 1 as
        // divergence is read after it, not inherited from before it.
        if ((await checkoutIsShallow()) !== 'no') return { verdict: 'unknown', res: confirm }
        return { verdict: 'no', res: confirm }
      }
      // EVERY FIELD THIS REFUSAL QUOTES IS FOLDED, on the same terms the remedy composer
      // already folds its own (Argus blocker). `repo_path` is persisted verbatim by store.ts
      // and both `git init` and `git worktree add` accept a newline in a path, so a legal path
      // — `/repo\nFORGED: run git branch -D -- victim` — otherwise forged a destructive line
      // inside the one message class whose whole subject is that UNKNOWN authorises nothing.
      // git's stderr is folded for the same reason and not a weaker one: `git -C <repo>` echoes
      // the path back on failure, so the raw path reaches this string by that route too.
      // `foldEvidence` also carries the bound the `.slice(-300)` used to carry, and MARKS its
      // truncation. Both folds now live ABOVE the fetch (`repoProse`, `gitDetail`), because the
      // two refusals composed before this block owed the identical contract and did not have it.
      //
      // AND THE BRANCH NAME IS FOLDED TOO (Argus blocker). An earlier draft exempted it on the
      // premise that "git's own ref rules have already excluded control characters" — true of
      // ASCII controls and FALSE of everything else `defang` folds. Reproduced on git 2.43:
      // `git branch` accepted, and `rev-parse --verify` resolved, both
      // `feat<U+2028>FORGED<U+00A0>run<U+00A0>git<U+00A0>branch<U+00A0>-D<U+00A0>victim` and
      // `feat<U+202E>evil` — a line separator several renderers break on, and a bidi override
      // that reorders what is DISPLAYED without changing a byte. The remedy composer folds
      // exactly those codepoints and names them as forgery vectors, so exempting the branch
      // here made this seam contradict the threat model of the module it exists to guard.
      // Only the shas stay raw, and they are full-width-tested above.
      // NAME FIELDS ARE FOLDED AS NAMES (Argus blocker/finding). `foldEvidence` folds a
      // forgery codepoint to an ASCII SPACE, and the ASCII space is the one character git's
      // ref rules forbid — the character `delivery.ts` anchors its wrong-base classifier on.
      // `foldRefName` folds a name to a single token instead, so the fold cannot put a space
      // inside a field the reader (and the classifier) reads as one name.
      //
      // AND THE BASE IS ONE OF THEM. The refusals below said "every field this refusal quotes
      // is folded" while interpolating `base` RAW — it arrives from `detectBaseBranch` or
      // `opts.base_branch` and git accepts U+2028 and U+202E in a branch name exactly as it
      // does for `launchRun.branch`, so the same forged line was available through the base.
      const branchProse = foldRefName(launchRun.branch)
      // AND THE BOUNDARY IS "THIS REPO'S OWN .git", which is only true because the fetch above
      // passes `--no-recurse-submodules` (Argus blocker): without it a repo configuring
      // `fetch.recurseSubmodules` makes that same command write inside a SUBMODULE's git dir,
      // which is neither this `.git` nor a hook's doing.
      //
      // WHAT THIS PATH WROTE, COUNTED EXACTLY. The base fetch above is not
      // write-free: it force-updates that tracking ref, appends the ref's reflog, rewrites
      // FETCH_HEAD and writes whatever objects it downloaded (delivery.ts names the same set
      // for the composer's own fetch). None of them is a branch, a worktree, a commit or a file
      // in the tree — which is the reassurance actually owed — but a refusal that undercounts
      // its own writes is the overclaiming this message class exists to stop. Conditional,
      // because OVERcounting is the same defect: only a fresh PR build fetches at all.
      //
      // THE LIST IS OPEN AT ITS TAIL, AND SAYS SO (Argus finding). A fetch also runs whatever
      // bookkeeping its own configuration asks for — `fetch.writeCommitGraph` writes
      // `.git/objects/info/commit-graphs/*`, `gc.auto` can fire maintenance — so naming four
      // items and closing the list was falsifiable by a config this path does not read. What
      // IS established is the class: everything that fetch can touch lives under `.git`, and
      // "file" in the clause below means a file in the TREE, which is the reassurance owed.
      //
      // AND THAT BOOKKEEPING IS UNCONDITIONAL (Argus finding). It used to ride inside the
      // "if origin had moved that ref" list, which asserted in the NO-OP case a boundary the
      // config falsifies: reproduced on git 2.43 with `fetch.writeCommitGraph=true` and a
      // tracking ref already at origin's tip — the ref did not move (reflog stayed at one
      // line) and the commit-graph files went 0 → 2 anyway. `delivery.ts` already phrases the
      // same enumeration correctly, so the split below matches it: FETCH_HEAD and the
      // configured bookkeeping are unconditional, the ref, its reflog and the objects are not.
      //
      // AND THE REF UPDATE IS CONDITIONAL (Argus finding, same one `delivery.ts` carries for
      // the composer's own fetch). A fetch whose tracking ref already sits at origin's tip
      // makes no ref transaction: repeating the identical fetch against an unchanged remote
      // leaves that ref's reflog at one line. Naming the refresh and the append flatly
      // asserted, in the no-op case, writes that did not happen — overcounting, which this
      // sentence exists to avoid in both directions. FETCH_HEAD is the unconditional one.
      const noWrites = fetchedBase
        ? `the build was NOT started; no branch, worktree, commit or file in the tree was changed or deleted by git itself, and the only writes on this path are the ones the earlier git fetch --no-tags --no-recurse-submodules origin ${foldRefName(baseRefspec)} made under this repo's own .git — FETCH_HEAD and whatever bookkeeping that fetch's own configuration adds on top, plus — if origin had moved that ref — refs/remotes/origin/${baseProse}, that ref's reflog and the objects it downloaded; ${CONFIGURED_CODE_CAVEAT}`
        : `the build was NOT started, and no branch, worktree, commit or file in the tree was changed or deleted by git itself; ${CONFIGURED_CODE_CAVEAT}`
      // The DETAIL names the shallow case as the shallow case. An exit-1 UNKNOWN reported as
      // "exited 1: no stderr" reads as a probe that malfunctioned; what actually happened is
      // that git answered honestly about a history it cannot see past, and the operator's next
      // step (`git fetch --unshallow`) follows only from being told so.
      const probeDetail = (res: HostCommandResult): string => {
        if (res.timed_out === true) return 'the ancestry probe was killed by its watchdog'
        if (res.exit_code === 1 && lastDepth !== 'no') {
          return lastDepth === 'yes'
            ? 'git merge-base --is-ancestor exited 1, which is a proven "not an ancestor" only in a COMPLETE history — and git rev-parse --is-shallow-repository says this checkout is SHALLOW, where the parent commits are absent and exit 1 is also what a TRUE ancestor produces (git fetch --unshallow origin makes the probe answerable)'
            : 'git merge-base --is-ancestor exited 1, which is a proven "not an ancestor" only in a COMPLETE history — and the depth of this checkout could not be read (git rev-parse --is-shallow-repository neither answered true nor false), so exit 1 cannot be read as divergence'
        }
        return `git merge-base --is-ancestor exited ${res.exit_code}: ${
          gitDetail(res.stderr || res.stdout) || 'no stderr'
        }`
      }
      const containedInBase = await ancestry([
        'git',
        '-C',
        launchRun.repo_path,
        'merge-base',
        '--is-ancestor',
        branchTip,
        base_sha,
      ])
      const contained = containedInBase.verdict
      if (contained === 'unknown') {
        return {
          run: failedRun(
            pinnedRun,
            `trident infra: could not establish whether branch ${branchProse} at ${branchTip} is contained in origin/${baseProse} at ${base_sha} in ${repoProse} (${probeDetail(containedInBase.res)}) — ancestry is UNKNOWN, and UNKNOWN authorises nothing; ${noWrites}.`,
            false,
          ),
          changed: true,
          waiting: false,
          note: `${launchRun.phase} → failed (ancestry probe UNKNOWN — no fire)`,
        }
      }
      // A fresh launch can find the branch left by an earlier dispatch. When that tip is
      // contained in the newly fetched base, the ancestry proof above also proves that the
      // branch tip is their merge-base. Adopt the branch's real pin instead of claiming it
      // was cut from today's base tip, and measure how far that same pin is behind today's
      // fetched base. The no-branch path keeps the fetched tip pinned as before.
      if (contained === 'yes' && freshBuild && launchRun.merge_mode === 'pr') {
        const fetchedBaseSha = base_sha
        const behind = await opts.run_host(
          gitRangeArgv({
            repo_path: launchRun.repo_path,
            subcommand: 'rev-list',
            flags: ['--count'],
            base: branchTip,
            head: fetchedBaseSha,
          }),
          launchRun.repo_path,
        )
        const count = Number.parseInt(behind.stdout.trim(), 10)
        base_sha = branchTip
        base_behind = behind.ok && Number.isFinite(count) ? count : null
        pinnedRun = { ...launchRun, base_sha, base_behind }
      }
      let ownCrashLeftover = false
      if (contained === 'no' && priorBaseSha !== null) {
        const descendsFromPriorBase = await ancestry([
          'git',
          '-C',
          launchRun.repo_path,
          'merge-base',
          '--is-ancestor',
          priorBaseSha,
          branchTip,
        ])
        const descends = descendsFromPriorBase.verdict
        // Same three exits, same rule. A failed probe here would otherwise read as "this is
        // NOT this run's own crash leftover", which routes a run's own restart debris into a
        // refusal that blames another lane for it.
        if (descends === 'unknown') {
          return {
            run: failedRun(
              pinnedRun,
              `trident infra: branch ${branchProse} at ${branchTip} is not contained in origin/${baseProse} at ${base_sha}, but whether it descends from this run's own prior base ${priorBaseSha} — the shape its own crash leaves behind — could NOT be established in ${repoProse} (${probeDetail(descendsFromPriorBase.res)}); that is UNKNOWN, and UNKNOWN authorises nothing; ${noWrites}.`,
              false,
            ),
            changed: true,
            waiting: false,
            note: `${launchRun.phase} → failed (prior-base ancestry probe UNKNOWN — no fire)`,
          }
        }
        ownCrashLeftover = descends === 'yes'
        // DESCENT FROM THE BASE PIN IS NOT OWNERSHIP (Argus r4 blocker). A SIBLING
        // lane that cut the same branch name from the same base also descends from
        // this row's pin, so the pin alone cannot tell "my leftover commits" from
        // "somebody else's". When this row records a checkpoint HEAD — which every
        // salvage seed does, `board-dispatch.ts` only seeds a candidate whose head
        // it just matched against the branch tip — that head is a commit THIS row
        // owns, so requiring it to be an ancestor-or-equal of the local tip is the
        // ownership proof the pin is not: a sibling's tip cannot contain it.
        //
        // Only when the recorded head is not a readable object HERE does the pin go
        // back to being the whole answer: an ancestry probe cannot distinguish "not
        // an ancestor" from "unknown object", and refusing a run on an object we
        // could not even read would discard built work on evidence we do not have.
        // No recorded head at all (the crash-leftover-before-any-checkpoint shape)
        // is unchanged for the same reason.
        //
        // THE PROBE GOES THROUGH `ancestry`, NOT A BARE `run_host` (rebase onto the
        // three-valued guard). Exit 1 past a shallow boundary is what a TRUE ancestor
        // produces, so a raw `.ok` read here would answer "not mine" for a head this
        // row really does own — the same false negative `ancestry` was written to
        // remove one probe above. UNKNOWN therefore refuses the way every other
        // UNKNOWN in this guard refuses: it authorises nothing and it names no
        // destructive act, rather than falling through to the wrong-base refusal,
        // which would blame another lane for a history we could not read.
        if (ownCrashLeftover && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(recorded)) {
          const recordedPresent = await opts.run_host(
            ['git', '-C', launchRun.repo_path, 'cat-file', '-e', `${recorded}^{commit}`],
            launchRun.repo_path,
          )
          if (recordedPresent.ok) {
            const containsRecorded = await ancestry([
              'git',
              '-C',
              launchRun.repo_path,
              'merge-base',
              '--is-ancestor',
              recorded,
              branchTip,
            ])
            if (containsRecorded.verdict === 'unknown') {
              return {
                run: failedRun(
                  pinnedRun,
                  `trident infra: branch ${branchProse} at ${branchTip} is not contained in origin/${baseProse} at ${base_sha} and descends from this run's own prior base ${priorBaseSha}, but whether it still contains this run's own recorded head ${recorded} — the proof the branch is THIS lane's leftover and not a sibling's — could NOT be established in ${repoProse} (${probeDetail(containsRecorded.res)}); that is UNKNOWN, and UNKNOWN authorises nothing; ${noWrites}.`,
                  false,
                ),
                changed: true,
                waiting: false,
                note: `${launchRun.phase} → failed (recorded-head ancestry probe UNKNOWN — no fire)`,
              }
            }
            ownCrashLeftover = containsRecorded.verdict === 'yes'
          }
        }
      }
      if (contained === 'no' && !ownCrashLeftover) {
        const ahead = await opts.run_host(
          // `--end-of-options` (#546): `base_sha` is the launcher's own resolved oid, and
          // `rev-list` is the family measured to write the smuggled file even while
          // exiting 129, so the marker goes here too.
          gitRangeArgv({
            repo_path: launchRun.repo_path,
            subcommand: 'rev-list',
            flags: ['--count'],
            base: base_sha,
            head: branchTip,
          }),
          launchRun.repo_path,
        )
        const rawAheadCount = ahead.stdout.trim()
        const aheadCount = /^\d+$/.test(rawAheadCount) ? rawAheadCount : '?'
        const reason = await composeWrongBaseRefusal(
          {
            repo: launchRun.repo_path,
            branch: launchRun.branch,
            base,
            branch_tip: branchTip,
            ahead_count: aheadCount,
            run_id: launchRun.id,
          },
          { run_host: opts.run_host },
        )
        return {
          run: failedRun(pinnedRun, reason, false),
          changed: true,
          waiting: false,
          note: `${launchRun.phase} → failed (local branch belongs to another lane — no fire)`,
        }
      }
    }
  }

  const id = mint()
  if (typeof id !== 'string' || id.length === 0) {
    return {
      run: failedRun(run, 'trident: mint_run_id produced an empty id', false),
      changed: true,
      waiting: false,
      note: `${run.phase} → failed (empty dispatch id)`,
    }
  }
  return { pinnedRun, base, base_sha, resume_checkpoint, resume_checkpoint_head, resume_findings, resume_live_head, id }
}
