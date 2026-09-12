/**
 * Proactive backstop for the two things a Trident run leaks when it ends anywhere
 * other than the merge path: its WORKTREE, and its BRANCH REF.
 *
 * It NEVER forces removal and NEVER kills a process, and it skips the entire sweep
 * when liveness cannot be proven because `/proc` is absent. This mirrors
 * `codex-build.sh`'s `holder_is_live` prior art: unreadable entries owned by other
 * uids are skipped per pid, because every lane in one instance shares the gateway's
 * uid.
 *
 * ── WHY THIS MODULE NOW DELETES A BRANCH REF (ISSUES #547) ───────────────────────
 *
 * It used to delete none, deliberately: a failed run's committed work lived only on
 * its `trident/*` branch, so the branch was the rescue copy. The consequence was
 * measured on the repo of record on 2026-09-12: 79 `refs/heads/trident/*` refs, 78
 * of them held by no worktree at all, every one of them a ref whose run had ended.
 * A surviving ref is not inert — the next launch of the same card re-enters it
 * (`inner-workflow.mjs`: "RE-ENTER it rather than failing"), so the card's next
 * build starts on a stale base instead of on a fresh branch cut from origin.
 *
 * `worktree-cleanup.sh` tears the ref down too, but only in `delete-branch` mode
 * and only from the inner workflow's `finally{}` — so it never runs for a run whose
 * process died, was cancelled, or was reaped by the hang watchdog, which is every
 * path in the 79.
 *
 * ── WHY A STATE-DRIVEN SWEEP RATHER THAN A HOOK ON EACH TERMINAL PATH ────────────
 *
 * The ref reap is keyed on what the STORE says (every run owning the ref is in a
 * terminal phase), not on being called at the moment of the transition. That covers
 * every terminal path by construction — including the paths that run no code at all
 * (a gateway killed mid-run, whose row is only reaped on the next boot). The tick
 * loop's terminal chain already wakes this loop (`build-core-modules.ts`), so an
 * in-band terminal transition reaps within a tick; everything else reaps within the
 * 15-minute cadence or at the next boot (`immediate: true`).
 *
 * ── "FALSE" AND "UNKNOWN" MUST NEVER SHARE A BRANCH ─────────────────────────────
 *
 * Three review rounds produced three versions of ONE mistake: a boolean `ok` deciding a
 * question git answers with an EXIT CODE. Round 4's `refAlreadyExists` needed exit 128 AND
 * the message, not `!ok`. Round 6's delete needed success/timeout/other, not `!ok`. Round 7's
 * presence read needed exit 0/1/anything-else, not `!ok` — and until it did, a `fatal:
 * permission denied` recorded a DELETION with no evidence the ref was gone. Each fix was
 * right and each left the same latent shape next door, because `ok` collapses "the thing is
 * false" with "I could not find out", and on a destructive path those must take different
 * branches.
 *
 * THE TEST FOR WHETHER TWO VALUES ARE ENOUGH — and "failure class" means all THREE routes: a
 * non-ok result, a throw after the command had its chance, and a success whose output is
 * impossible. Does every failure class take the SAME branch,
 * and is that branch the REFUSING one? If yes, `ok` is fine and collapsing costs nothing. If
 * the branches differ — or if one of them is the destructive one — the decision must be keyed
 * on the value git actually returned. Every `.ok` in this module, classified:
 *
 *   TWO-VALUED, AND CORRECTLY SO — every failure class refuses identically:
 *     · `worktree list --porcelain` in the worktree pass → repo-unenumerable, skip the repo.
 *     · `checkout --detach` → preserve the worktree.
 *     · `worktree list -z` in `refClaimedNow` → answers "claimed", i.e. refuse the delete.
 *     · `for-each-ref` → refs-unenumerable, stand down.
 *     · `worktree list -z` for the holder map → holders-unenumerable, stand down.
 *     · `update-ref <salvage> <sha> ''` → does not decide; falls through to a MEASUREMENT.
 *     · `rev-parse --verify --quiet <salvage>` + sha compare → absent (exit 1) and error
 *       (128) both mean "the salvage is not proven to hold the tip", and both refuse. Same
 *       command as the presence read below, different question, and two values genuinely suffice.
 *     · `!deleted.ok` gating the presence read → decides only WHETHER TO MEASURE, not what
 *       the outcome was.
 *
 *   THREE-VALUED, NECESSARILY — the branches differ and one of them is destructive:
 *     · the delete: success / TIMED OUT (indeterminate) / refused (`deleted.timed_out`).
 *     · the presence read after an indeterminate delete: present / absent / unknown
 *       (`refPresence`, keyed on exit 0 / 1 / anything else).
 *     · the salvage restore: succeeded / refused because the ref EXISTS / failed for any
 *       other reason, which leaves a live claimant's HEAD dangling (`refAlreadyExists`).
 *
 * A THROWN HOST CALL IS THE SAME THREE-STATE PROBLEM, and the `.ok` audit above did not
 * cover it — which is how instance FOUR arrived. A `catch` is not an `.ok` decision, but
 * "the command threw AFTER having its chance to take effect" is a failure class, and it is
 * the one that looks least like one. So the extracted test has to be read with that
 * included: does every failure class — the throw-after-doing-it included — take the same
 * branch, and is that branch the refusing one?
 *
 * Every `catch` around a host call here, classified by whether the command MUTATES:
 *
 *   READ-ONLY, so a throw is simply no measurement and refusing is right:
 *     · `worktree list --porcelain` (worktree pass, and both `-z` holder reads).
 *     · `for-each-ref`.
 *     · `rev-parse --verify --quiet` (the salvage verify and the presence read).
 *
 *   MUTATING, so a throw leaves the side effect UNKNOWN:
 *     · `update-ref --no-deref -d` — THE ONE THAT WAS WRONG. A throw after the ref lock
 *       committed left the ref deleted while the catch recorded `delete-refused` and moved
 *       on, so gate 14 and the restore never ran and a claimant's HEAD dangled. It is now
 *       synthesised as indeterminate and MEASURED, exactly like a returned timeout.
 *     · `update-ref <ref> <sha> ''` (the restore) — infers on throw, deliberately: it lands
 *       on the LOUD branch, so a throw after a successful restore is a false "RESTORE
 *       FAILED" alarm rather than a silent loss. Wrong in the over-reporting direction,
 *       which is the acceptable one here; noted rather than hidden.
 *     · `update-ref <salvage> <sha> ''` — refuses the delete, so a throw after the salvage
 *       landed costs one un-reaped ref. Refusing direction.
 *     · `checkout --detach` — preserves the worktree. If the detach took effect and then
 *       threw, this sweep's memory of it is lost, but gate 5 is commit-keyed and catches the
 *       tree anyway; the recovery is that gate, not this catch.
 *     · `worktree prune` — administrative only; a throw either way changes nothing.
 *
 * AND A COMMAND CAN SUCCEED WHILE SAYING SOMETHING IMPOSSIBLE — the third route, and the
 * least visible of the three. Nothing fails: `ok` is true, nothing throws, there is no error
 * string, so neither of the audits above can see it. The signal is entirely SEMANTIC, and it
 * is per-command knowledge that cannot be derived from any type — which is exactly why it has
 * to be written down. For every host command whose output is parsed here: what output is
 * impossible, and does impossible take the refusing branch?
 *
 *   `git worktree list` (both the plain and the `-z` forms) — ZERO RECORDS IS IMPOSSIBLE. git
 *     always reports the main working tree, so a listing that parses to nothing is an answer
 *     that did not arrive. All three call sites now refuse on it: the worktree pass stands the
 *     repo down, the holder map stands the repo down, and the claim probe answers CLAIMED.
 *     THE GUARD IS ON THE PARSE RESULT, NOT THE STRING: measured against `parseHoldersZ`, an
 *     empty string, bare NULs, records with no `worktree` field, and arbitrary non-porcelain
 *     text all parse to zero records, so a `stdout === ''` check would catch one shape of four.
 *
 *   `git for-each-ref` scoped to `refs/heads/trident/` — ZERO RECORDS IS LEGITIMATE. A
 *     repository may genuinely have no trident refs. Nothing is impossible about that output,
 *     and the sweep correctly returns having done nothing rather than standing down.
 *
 *   `git rev-parse --verify --quiet <ref>` — EXIT 0 WITH EMPTY STDOUT IS IMPOSSIBLE. A ref
 *     that verified prints its sha. The presence read keys on the exit code and treats
 *     anything that is not 0-or-1 as unknown; the salvage verify compares the sha, so an empty
 *     stdout can never equal the tip and refuses.
 *
 *   `git update-ref` (all forms) — produces no stdout to parse; its outcome is the exit code,
 *     which the two classifications above already cover.
 *
 * ── THE EVIDENCE GUARD — FOURTEEN CHECKS BEHIND ONE BOUNDARY ─────────────────────
 *
 * Safer than the 2026-09-01 incident, and the fourteen sit behind a gate 0 that refuses any
 * ref the chain did not itself produce: the destructive half takes a `ReapableCandidate`,
 * which only `reapBranchRefs` can mint, bound to the canonical repository its gates ran
 * against — the attestation covers every input the delete consumes, `repo` included. Gates
 * 1-10 are therefore not advice to a caller: they are the thing the arguments attest to, and
 * there is no expression outside this module that fabricates the attestation. See
 * `ReapableCandidate` for why the proof is runtime identity rather than a phantom type.
 *
 * `docs/as-built/wrong-base-guard-prints-a-destructi.md` records a guard that
 * composed an unconditional `git branch -D` from NOTHING and pointed it at a branch
 * a LIVE locked worktree was holding. A deleted ref under a live lane destroys work;
 * an orphaned ref is a nuisance. So UNPROVABLE REFUSES, everywhere, and a ref is
 * deleted only when ALL of the following are established:
 *
 *   1. `/proc` is readable at all. It is not → the WHOLE sweep does nothing
 *      (`skipped_no_liveness`), worktrees and refs alike. This is the one global gate.
 *   2. The ref is under `refs/heads/trident/` — the namespace trident itself creates
 *      (`board-dispatch.ts`: `trident/${slug}`). A member-mode run builds on a PINNED
 *      branch outside it, and a person's branch is never in it.
 *   3. `git for-each-ref` and `git worktree list --porcelain -z` both answered for
 *      this repo. Either failing is the ABSENCE of a holder measurement, never the
 *      measurement that there is no holder — so no ref in that repo is touched.
 *   4. No worktree holds the ref BY NAME. `worktree list` alone is not enough: git
 *      reports a worktree mid-rebase or mid-bisect as DETACHED and prints no `branch`
 *      attribute, so every detached entry is asked directly (`readRebaseHead`, the
 *      prior art this reuses rather than re-derives — it reads exactly the four places
 *      git itself consults: the HEAD symref, `rebase-merge/head-name`,
 *      `rebase-apply/head-name` and `BISECT_START`). That read answering 'unknown'
 *      refuses every ref in the repo, because what it could not read may name any of
 *      them.
 *   5. No DETACHED LINKED worktree still on disk is standing on the ref's commit. Keyed on the
 *      COMMIT, not a name, which is what makes it survive the sweep boundary: the
 *      worktree pass's own `checkout --detach` leaves HEAD on the tip, so a tree that
 *      pass detached and then PRESERVED (dirty, or inside retention) still points at the
 *      ref however many sweeps later. The per-sweep `detachedThisSweep` map is only a
 *      nicer refusal reason; THIS is the gate. It does not cover a conflicted rebase —
 *      there HEAD is the `onto` commit — and does not need to, because gate 4 does. The
 *      SHARED checkout is excluded (see the loop): it is never a disposable build tree, so
 *      it is never the tree this protects, and including it only refuses on coincidence.
 *   6. No worktree THIS SWEEP detached still exists — a same-sweep fast path, kept only
 *      because it can name the detach in the refusal reason. Gate 5 is what holds that line;
 *      this map lives for ONE sweep. See the detach site in `sweepTridentWorktrees`.
 *   7. At least one run row in this repo names the branch. NO row is not evidence the
 *      ref is disposable — it is the absence of an owner, so it is kept. That single
 *      rule is what protects a hand-made branch and, measured against the 79, it is
 *      what keeps 6 of them.
 *   8. EVERY run row naming it is in a terminal phase. One non-terminal owner keeps
 *      the ref (`listBranchOwners` is unbounded for exactly this reason — see there).
 *   9. No owning run's recorded worktree still EXISTS on disk.
 *
 *      CREDIT THIS GATE WITH NOTHING TODAY. Measured read-only against the production
 *      store on 2026-09-12: 0 of 291 run rows carry a non-null `worktree` (the
 *      orchestrator writes `worktree: null`), so this gate cannot fire and the
 *      preservation of a dirty tree's ref rests on gates 4 and 4c, not on this. It is
 *      kept because it is correct and costs nothing the day that column is populated —
 *      not because it is load-bearing now. A follow-up populates it at provisioning.
 *  10. No live process is standing in an owning run's worktree path, and none is
 *      standing in a path bearing its `workflow_run_id`. The race it is aimed at is
 *      real — the row goes terminal (hang watchdog, cancel, crash latch) while the
 *      detached workflow is still running.
 *
 *      IT ALSO CANNOT FIRE TODAY, for two reasons, and neither is a licence to delete
 *      anything. The worktree half is dead for the same reason as gate 9 (no row carries
 *      a `worktree`). The generation half compares a 36-character run UUID against
 *      `wf_<8hex>-<3hex>-<n>` basenames: measured 0 of 17 matches, because they are
 *      different identifiers — which also makes `claimedByNonTerminalRun` above weaker
 *      than it reads. What actually protects a LIVE workflow is not this gate: its tree
 *      is `isLive`, so the worktree pass never detaches it, so it still holds its branch
 *      by name and gate 4 keeps the ref. A follow-up re-keys or drops this witness.
 *  11. A salvage ref was CREATED first — create-only, never a blind set. 67 of the 79
 *      measured refs carry commits origin does not have, so the delete would otherwise
 *      be the only copy's last reference. `refs/trident-reaped/<slug>/<sha>` keeps them
 *      reachable — outside `refs/heads` so it can never re-enter a launch, and outside
 *      `refs/tags` so it neither clutters `git tag` nor rides a `--follow-tags` push.
 *      Recovery is `git branch <name> <sha>`. Salvage failing REFUSES the delete.
 *  12. NOTHING CLAIMS THE REF AS OF NOW — holders, live owners AND process liveness
 *      RE-MEASURED, not remembered, immediately before the delete.
 *  13. THE DELETE IS ONE ATOMIC COMPARE-AND-SWAP: `git update-ref -d <ref>
 *      <expected-sha>` checks the old value and unlinks the ref under one ref lock, so a
 *      branch that has advanced since the enumeration cannot be deleted at all. There is
 *      no read-then-delete window, because there is no separate read.
 *
 *      THIS IS WHERE THE FIRST CUT OF THIS MODULE WAS WRONG, and it is worth saying so
 *      here rather than only at the call site. It used to `rev-parse` the sha and then
 *      run `git branch -D`, and call the pair a compare-and-swap. Anything could advance
 *      the branch between the two commands, `branch -D` has no old-value check at any
 *      price, and the commit that had just arrived went with it — while the salvage above
 *      preserved the OLD tip. `branch -D` was chosen for a real measurement (git 2.43: it
 *      refuses a branch a worktree holds, where `update-ref -d` does not) that answered
 *      the wrong question: holder safety is gates 4, 5 and 6, which do not depend on the
 *      delete primitive, whereas atomicity can only come FROM the primitive.
 *  14. AND NOTHING CLAIMED IT DURING THE DELETE. The same measurement again, afterwards,
 *      with a CREATE-ONLY restore at the unchanged sha if one did.
 *
 *      WHY BOTH (#547 round 3). The CAS below protects the ref's VALUE and nothing else. A
 *      dispatch can claim the slug and check the branch out at its UNCHANGED tip after the
 *      holder and owner snapshots are taken — so the sha is exactly what was expected, the
 *      CAS succeeds, and a branch a live run is standing on is deleted. `update-ref -d`
 *      does not refuse a checked-out branch, so nothing fails closed on its own.
 *
 *      9a is the ordinary case and 9b narrows the bad ordering from likely to unlikely and
 *      REPAIRS it where it can: git offers no primitive that compares a HOLDER and unlinks
 *      a ref in one operation (`update-ref --stdin` refuses `verify` + `delete` on one
 *      ref), so the remaining interleaving is repaired rather than raced. WHERE THE REPAIR
 *      SUCCEEDS it is lossless — the sha is unchanged by construction, so the claimant's
 *      HEAD symref resolves to the same commit, and the restore is create-only so a
 *      claimant that made its own branch wins.
 *
 *      IT IS NOT CORRECT FOR EVERY INTERLEAVING, and this file used to say it was. Two
 *      cases survive: a claimant 9b does not detect (it appears after 9b's own read), and
 *      a restore that FAILS. Both leave the ref absent under a live claimant, whose next
 *      commit is PARENTLESS — a whole-tree diff against unrelated history, which is the
 *      silently-wrong-base class this card exists to eliminate. Nothing automated repairs
 *      it, because a ref that does not exist does not enumerate on the next sweep; the
 *      `RESTORE FAILED` line and `refs_restore_failed` exist to make a human the recovery
 *      path. THIS IS THE WHOLE REASON THE DELETION IS DEFERRED TO #635: the claimant-side
 *      guard is what closes these two, and it closes them without a race. See the call
 *      site for the residue, stated at its worst.
 *
 * ── WHICH GATES ARE CURRENT AND WHICH ARE HISTORICAL ─────────────────────────────
 *
 * AN ATTESTATION PROVES THE GATES RAN; IT DOES NOT PROVE THEY STILL HOLD. Provenance is
 * not currency. A `ReapableCandidate` answers "were these inputs gated?" and cannot answer
 * "is that still the case?" — so for every gate the question has to be asked separately:
 * CAN ITS SUBJECT CHANGE between minting and the delete, and if so, is it measured again?
 *
 * Anyone enabling the deletion needs this list, because a gate that is merely historical is
 * a gate that was true once.
 *
 * EVERY CELL BELOW IS A CLAIM NEEDING ITS OWN EVIDENCE, and a table makes them all look
 * equally established. Round 16 caught exactly that: gate 7 sat under IMMUTABLE on the
 * strength of "rows are not deleted by the dispatch path" — a claim about ANOTHER MODULE,
 * asserted because it is the kind of thing that is usually true. `store.ts`'s `delete(id)` is
 * `/trident stop`'s hard delete (`DELETE FROM code_trident_runs WHERE id = ?`), so the cell
 * was wrong and the ref could be deleted with no owner row at all. Each entry here now names
 * a MECHANISM that can be pointed at, not an absence that was assumed; where the argument is
 * still "this cannot happen", it says which code makes it so.
 *
 *   MUTABLE AND RE-MEASURED at delete time, all inside `refClaimedNow`:
 *     · 4 (no worktree holds it by name) — a `git worktree add` can happen at any moment.
 *     · 5 (no detached linked tree on the tip) — same listing, same freshness.
 *     · 7 (at least one row still names the branch) — RE-MEASURED SINCE ROUND 16. `store.ts`'s
 *       `delete(id)`, `/trident stop`'s hard-delete path, removes rows outright, so the row that
 *       proved ownership can be GONE at delete time; an empty owner list is unprovable ownership
 *       and refuses, exactly as `owner-unknown` does in the sweep.
 *     · 8 (every owner row terminal) — a dispatch's claim is an INSERT of a non-terminal row.
 *     · 10 (no live process in an owning run's tree) — RE-MEASURED SINCE ROUND 15, and the
 *       omission that made this section necessary: a process can start inside an ordinary
 *       directory without anything in the holder listing or the phase changing.
 *     · 13 and 14 are themselves the atomic write and the measurement after it.
 *
 *   MUTABLE AND *NOT* RE-MEASURED, deliberately, with the reason:
 *     · 9 (no owning run's recorded worktree still exists on disk). A tree could be
 *       recreated between mint and delete, but gate 4/5's fresh listing sees any tree git
 *       knows about and gate 10's fresh `/proc` sees anything running in one, so the
 *       remaining case is an empty directory with nothing running in it and no git
 *       registration — which holds no work. Credit this gate with nothing today anyway: 0
 *       of 291 rows carry a `worktree` (see the gate).
 *     · 11 (the salvage) is not re-measured because it is a WRITE performed at delete time;
 *       there is nothing earlier to go stale.
 *
 *   IMMUTABLE FOR THE LIFE OF A CANDIDATE, so freshness is not a question — and each of these
 *   rests on a mechanism rather than on nothing having been observed to change it:
 *     · 2 (the ref is under `refs/heads/trident/`) — the candidate's `ref` is a frozen string
 *       on a frozen object, so the VALUE this gate examined cannot change. A different ref is
 *       a different candidate; renaming a branch in git does not mutate this one.
 *     · 6 (this sweep's own detach memory) — a statement about what THIS sweep did, so its
 *       subject is in the past. Nothing can make a past action un-happen. It is also only a
 *       nicer refusal reason; gate 5, which IS re-measured, holds that line.
 *     · the sha — pinned by the CAS itself: `update-ref -d <ref> <sha>` refuses unless the ref
 *       is still at that value, so staleness cannot be acted on rather than merely being
 *       unlikely. This is the strongest cell in the table, and the only one where the
 *       mechanism is the write itself.
 *
 *   MEASURED GLOBALLY, THEN AGAIN PER REF:
 *     · 1 (`/proc` is readable). The sweep aborts wholesale when it is not. Since round 15
 *       an unreadable `/proc` at DELETE time also refuses, per ref — the same posture
 *       applied at the second measurement rather than only the first.
 *     · 3 (the two listings answered for this repo) — re-asked by `refClaimedNow`'s own
 *       reads, which refuse when they fail.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, join } from 'node:path'

import { createLogger } from '@neutronai/logger'
import { SupervisedLoop } from '@neutronai/loop'

import type { HostCommandResult } from './git-mode.ts'
import { removeWorktreePath, type RunHostCommand } from './merge.ts'
import { isTerminalPhase } from './state-machine.ts'
import type { TridentBranchOwner, TridentRun } from './store.ts'
import { readRebaseHead, type RebaseHead } from './wrong-base-remedy.ts'

export const DEFAULT_WORKTREE_RETENTION_MS = 24 * 60 * 60 * 1000
export const DEFAULT_REAP_INTERVAL_MS = 15 * 60 * 1000
export const MAX_REMOVALS_PER_SWEEP = 50

/**
 * The ONLY namespace a ref delete may touch (gate 2). `board-dispatch.ts` composes
 * `trident/${slug}`; a member-mode run builds on a pinned branch outside it, and a
 * person's branch is never in it.
 */
export const TRIDENT_REF_PREFIX = 'refs/heads/trident/'

/** Where a reaped tip is kept so its commits stay reachable (gate 11). */
export const SALVAGE_REF_PREFIX = 'refs/trident-reaped/'

/**
 * Deletions attempted per sweep, bounded for the same reason as
 * `MAX_REMOVALS_PER_SWEEP`: one sweep's work stays finite on a repo that has
 * accumulated hundreds. The measured backlog (79) therefore drains over two sweeps.
 */
export const MAX_REF_DELETIONS_PER_SWEEP = 50

/**
 * THE ONLY VALUE `deleteReapableRef` ACCEPTS, and the reason a caller cannot reach the
 * destructive write around the gates.
 *
 * WHY THIS EXISTS (#547 round 12). The destructive half was extracted so its tests would keep
 * covering the code the sweep declines to call — and the extraction turned a guarded inner
 * step into an exported entry point that documented its ten preconditions as "the caller's".
 * That is not a guard. A direct caller could hand it `refs/heads/feature/abcdefgh` with a
 * matching sha and delete a branch with no owner row, no terminal phase and no holder
 * evidence, and the tests established direct invocation as a supported pattern. Ten gates
 * protecting a path are worth nothing if the path is callable around them.
 *
 * So the preconditions became a VALUE. A candidate is minted at exactly one place — the end
 * of the gate chain in `reapBranchRefs` — and `mintReapableCandidate` is module-private, so
 * nothing outside this file can produce one. The proof is membership of a private `WeakMap`
 * rather than a phantom type, deliberately: a type-level brand is erased at runtime, so `as`
 * and plain JavaScript both walk straight through it, and the negative test cannot even
 * construct the forged input it needs to prove the refusal. Identity in a private `WeakMap` is
 * unforgeable in both — there is no expression outside this module that writes to it — and its
 * VALUE carries the repository the gates ran against, which a `WeakSet` had no room for.
 *
 * The tests obtain a candidate the way production will: run the sweep, take what the gates
 * minted, pass it back. That is the same object, not a reconstruction — which is the point.
 *
 * WHAT THE ATTESTATION COVERS is `(repo, ref, sha)`, not `(ref, sha)` — see `MINTED_CANDIDATES`
 * for the cross-repository hole that taught it. The repository is held in the mint's own map
 * rather than on this interface, because a field the caller can write cannot be the thing that
 * proves anything.
 */
export interface ReapableCandidate {
  /**
   * The repository these gates ran against, SPELLED AS THE SWEEP SPELLED IT — routing data,
   * never the proof.
   *
   * NOT CANONICALISED, and round 16 is why. It was, briefly, and that broke the store read at
   * delete time: `listBranchOwners(repo_path)` is keyed by the path STRING the caller holds, so
   * a store configured with one spelling answers nothing for another. Canonicalising the
   * routing key therefore turned "which repo do I act on" into "which repo does the store think
   * I mean", and the two stopped agreeing whenever a symlink was involved. The ATTESTATION is
   * canonical — see `MINTED_CANDIDATES`, which resolves both sides — because that comparison
   * must be spelling-insensitive. The routing key must instead be FAITHFUL: `git -C` accepts
   * either spelling, and the store accepts only the one it was given.
   *
   * It is here because the destructive call is `(repo, candidate)` and a sweep covers MANY
   * repositories: a caller holding an inventory of candidates has to know which repository
   * each belongs to, and reading it off the candidate is the only way that cannot drift from
   * what was minted. #635 restores the call inside the per-repository loop, where `repo` is
   * already in scope; the inventory is what anything outside that loop has to work from.
   *
   * IT IS NOT WHAT THE BOUNDARY CHECKS. A forger writes this field as readily as `ref`, so
   * the comparison is against the mint's own map — see `MINTED_CANDIDATES`. This field is
   * checked against nothing and proves nothing; it tells a caller where to aim.
   */
  readonly repo: string
  readonly ref: string
  readonly sha: string
}

/**
 * Minted candidates, by IDENTITY, each mapped to THE CANONICAL REPOSITORY ITS GATES RAN
 * AGAINST. A `WeakMap` so a report that is dropped takes its candidates with it, and so a
 * serialised-and-revived candidate — which is a copy carrying no evidence — is correctly not
 * one.
 *
 * WHY THE REPO IS IN THE ATTESTATION AND NOT A FIELD ON THE CANDIDATE (#547 round 13). The
 * first cut attested to `(ref, sha)` while `deleteReapableRef` took `repo` as a SEPARATE
 * argument and aimed the destructive command at it. Mint in repo A, create the same ref at the
 * same commit in repo B, and a call with B's repo and A's candidate passed the membership test
 * and deleted B's ref — a repository whose gates never ran. The one input the attestation did
 * not cover was the one free to vary, and the boundary tests only ever forged within a single
 * repository, so the axis was never crossed.
 *
 * AN ATTESTATION MUST COVER EVERY INPUT THE ATTESTED OPERATION CONSUMES. A token proving
 * "these gates ran" is only as strong as the tuple it names; anything outside that tuple is
 * unattested by construction however carefully the rest is checked. A PUBLIC FIELD would not
 * fix it either — a forger sets fields freely, so the comparison has to be against something
 * the caller cannot write, which is what the map's value is.
 */
const MINTED_CANDIDATES = new WeakMap<ReapableCandidate, string>()

/**
 * A full object name, BOTH OBJECT FORMATS: 40 hex for sha1, 64 for sha256.
 *
 * HARD-CODING 40 BREAKS SHA-256 REPOSITORIES, and this tree had already written that down:
 * `trident/codex-build.sh`'s `sha_or_empty` carries the warning in as many words ("Both object
 * formats count: 40 for sha1, 64 for sha256 — hard-coding 40 would collapse every measured sha
 * on a sha256 repo"). The first cut of this check hard-coded 40 anyway, so on a repository
 * created with `--object-format=sha256` the destructive half refused ITS OWN minted candidate
 * as "not a full object name" and the reap silently did nothing.
 *
 * Length AND charset, because `update-ref` is not the only consumer: the salvage ref embeds
 * this value in its NAME, so an abbreviated or malformed sha would compose a salvage that
 * names something other than the tip it claims to preserve.
 */
const FULL_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * Canonical repository identity, so two spellings of one path cannot mint under one name and
 * be checked under another. Symlinked, relative and trailing-slash spellings all resolve here.
 *
 * A FAILURE FALLS BACK TO THE RAW STRING, and that direction is safe: an unresolvable path
 * compares equal only to the identical spelling, so the worst outcome is a candidate refused
 * for a repository that has just disappeared — never a candidate accepted for the wrong one.
 */
function canonicalRepo(repo: string): string {
  try {
    return realpathSync(repo)
  } catch {
    return repo
  }
}

/**
 * The ONE place a `ReapableCandidate` comes into existence: after gates 1-10 have passed,
 * bound to the repository they ran against.
 * Module-private on purpose — exporting it would hand back the bypass this type removes.
 *
 * TWO SPELLINGS, ON PURPOSE, AND THEY ARE NOT REDUNDANT. The FIELD keeps the caller's spelling
 * because it is the key to both `git -C` and `listBranchOwners`; the MAP holds the resolved one
 * because the boundary's comparison must not turn on how a path was written. Both come from
 * this one call, so they cannot drift for a minted candidate.
 */
function mintReapableCandidate(repo: string, ref: string, sha: string): ReapableCandidate {
  const candidate: ReapableCandidate = Object.freeze({ repo, ref, sha })
  MINTED_CANDIDATES.set(candidate, canonicalRepo(repo))
  return candidate
}

/**
 * Why this value may not be deleted, or `null` if it may — the boundary check, evaluated
 * before anything is written.
 *
 * THE NAMESPACE AND SHA CHECKS COME FIRST AND ARE NOT REDUNDANT. Minting already implies
 * both, so on the production path they can never fire; they are here because the checks that
 * matter are the ones that TRAVEL WITH THE OPERATION. A forged value is refused by the
 * membership test below, and a value that somehow carried membership while naming
 * `refs/heads/main` is refused by this one — which is the same posture as `--no-deref` at
 * the delete: "unreachable in this tree" has been the wrong answer more than once here.
 * Ordering them this way also makes each independently reddenable.
 */
function candidateRefusal(repo: string, candidate: ReapableCandidate): string | null {
  if (!candidate.ref.startsWith(TRIDENT_REF_PREFIX)) {
    return `${candidate.ref} is outside ${TRIDENT_REF_PREFIX}`
  }
  if (!FULL_OBJECT_NAME.test(candidate.sha)) {
    return `${candidate.sha} is not a full object name`
  }
  const mintedFor = MINTED_CANDIDATES.get(candidate)
  if (mintedFor === undefined) {
    return 'it was not minted by the gate chain'
  }
  // THE ATTESTED REPOSITORY AND THE OPERATED-ON REPOSITORY MUST BE THE SAME ONE. Checked
  // last so the two cheap shape checks stay independently reddenable above it, and compared
  // on canonical form at BOTH ends so a symlinked or relative spelling cannot be the thing
  // that decides it.
  const acting = canonicalRepo(repo)
  if (mintedFor !== acting) {
    return `its gates ran against ${mintedFor}, not ${acting}`
  }
  return null
}

/**
 * Attempts at putting a raced ref back (gate 14). Small and fixed: the failure it covers is
 * a transient ref-lock contention, and the thing it must not become is an unbounded wait
 * inside a sweep. Exported so the bound is pinned by VALUE in the tests and not merely by
 * the relation "more than one" — a test that only checks retrying happens cannot see this
 * number change.
 */
export const MAX_RESTORE_ATTEMPTS = 3

/**
 * The single named reason the sweep does not delete anything (#635). One constant, one
 * non-call-site, so "why is nothing being reaped" has exactly one answer to find.
 */
export const DEFERRED_PENDING_CLAIMANT_GUARD =
  'deferred-pending-claimant-guard: every gate passed and this ref IS reapable, but the reap ' +
  'performs no deletions until #635 lands (a run whose HEAD does not resolve must refuse to ' +
  'commit). Nothing deletes these refs today, so shipping the write before its guard would ' +
  'introduce a destructive operation ahead of the only check that can settle its failure mode ' +
  'without a race.'

/**
 * REF RETENTION IS DELIBERATELY ZERO, unlike the 24 h a worktree gets. A worktree can
 * hold work that exists nowhere else and no probe can read intent out of it, so age is
 * a stand-in for "somebody may still want this". A ref holds commits, which gate 11
 * copies elsewhere before the delete — and the whole point of #547 is that the ref
 * refuses the card's NEXT launch, which can be seconds away. A retention window here
 * would preserve exactly the failure being fixed.
 */

export interface WorktreeReaperStore {
  listRepoPaths(): string[]
  listNonTerminal(
    limit?: number,
  ): Pick<TridentRun, 'worktree' | 'branch' | 'repo_path' | 'workflow_run_id'>[]
  /**
   * Every run row in ONE repo that names a branch (#547, gates 5-8). REQUIRED rather
   * than optional: an optional seam would mean an unwired composition silently runs a
   * ref sweep with no ownership evidence, and "no owner" is the answer that keeps a
   * ref — so the sweep would be inert in exactly the boot where it matters, and the
   * inertness would be invisible. `TridentRunStore.listBranchOwners` satisfies it.
   */
  listBranchOwners(repo_path: string): TridentBranchOwner[]
}

export interface WorktreeReaperOptions {
  store: WorktreeReaperStore
  run_host: RunHostCommand
  now?: () => number
  retention_ms?: number
  proc_root?: string
  /**
   * Reads what a DETACHED worktree's in-progress rebase or bisect is standing on
   * (gate 4). Defaults to the prior art in `wrong-base-remedy.ts`; injectable so the
   * 'unknown' refusal is testable without corrupting a real rebase state directory.
   */
  rebase_head?: (worktree: string) => RebaseHead
  /**
   * MAY THE REF PASS RUN YET? (#547, found by CI against
   * `build-core-modules-trident-stranded-sweep.test.ts`.)
   *
   * The boot rescue for stranded failed PR runs (`sweepStrandedFailures`) publishes such
   * a run's commits by PUSHING ITS BRANCH — so on the very boot where both fire, this
   * sweep's startup pass would delete the ref the rescue was about to push, and the
   * rescue would then find nothing to publish. The composition therefore hands in a
   * predicate that goes true once that rescue has settled.
   *
   * A PREDICATE, not a promise to await: a tick must never block on a rescue that is
   * talking to a remote, and the WORKTREE pass has no reason to wait for it. Answering
   * false leaves every ref alone and records why, so a rescue that never settles costs a
   * nuisance rather than a deletion. Defaults to ready for a composition with no rescue
   * wired — there is then nothing whose turn this could be taking.
   */
  refs_ready?: () => boolean
}

export interface WorktreeReapReport {
  repos_swept: number
  candidates: number
  live_skipped: number
  detached: string[]
  removed: string[]
  preserved: { path: string; reason: string }[]
  protected_nonterminal: string[]
  skipped_no_liveness: boolean
  /** How many `refs/heads/trident/*` refs the sweep looked at. */
  refs_examined: number
  /** Deleted refs with the sha each pointed at — the recovery handle, in the log. */
  refs_deleted: { ref: string; sha: string; salvage: string }[]
  /** Every ref the sweep declined to delete, and the gate that declined it. */
  refs_kept: { ref: string; reason: string }[]
  /**
   * WHOLE-REPO STAND-DOWNS — a ref sweep that declined to look at a repository at all
   * (the boot-rescue latch still shut, an unreadable rebase state, an enumeration that
   * would not answer, a throw). Counted APART from `refs_kept` because these are the
   * conditions that can persist silently forever, and `logSummaryIfActed` treats them as
   * action worth logging while ordinary per-ref refusals stay quiet.
   */
  refs_stood_down: number
  /**
   * Refs DELETED and then PUT BACK because a claim appeared inside the sweep (#547,
   * round 3). Non-zero is not an error — it is this guard doing its job — but it is the
   * signal that a dispatch and a reap collided, so it is counted and logged.
   */
  refs_restored: { ref: string; sha: string }[]
  /**
   * Refs this sweep DELETED, then found a claim for, and then COULD NOT PUT BACK for any
   * reason other than the claimant already owning the name. The ref is absent and a live
   * claimant's HEAD is dangling, so this is the loudest thing this module can report: it is
   * counted apart from `refs_restored` (which claims success), it breaks the summary log's
   * silence the way a whole-repo stand-down does, and the `refs_kept` reason carries the
   * one-line `git branch` recovery. The tip itself is still reachable via the salvage ref.
   */
  refs_restore_failed: { ref: string; sha: string }[]
  /**
   * THE DRY-RUN CANDIDATE INVENTORY — refs that passed gates 1-10. NOT "would be deleted":
   * this is an UPPER BOUND on that, and the name says so because an earlier version did not.
   *
   * GATES 11-14 ARE NOT IN THIS COUNT AND CANNOT BE. Gate 11 IS the salvage write, so a dry
   * run that evaluated it would not be dry — and a candidate whose salvage the host rejects is
   * correctly listed here and correctly never deleted, which is the distinction the report has
   * to carry rather than hide. Gates 12-14 are not merely skipped for convenience either: 12
   * re-reads the very sources gates 4, 5, 7 and 8 have just read, and 13's precondition is the
   * sha `for-each-ref` returned moments earlier. Their entire value is re-measuring AFTER time
   * has passed and AFTER writes, and in a dry sweep nothing has mutated in between — so
   * running them would re-derive the same answer from the same inputs and add the APPEARANCE
   * of rigour rather than any. Gate 14 requires the delete to have happened at all.
   *
   * So this is the strongest honest count available without writing anything, and the gap
   * between it and "what would actually be deleted" is named rather than papered over.
   */
  refs_candidates: ReapableCandidate[]
}

interface WorktreeEntry {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  locked: boolean
  prunable: boolean
  bare: boolean
}

interface TimerSeams {
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const log = createLogger('trident-worktree-reaper')

function emptyReport(): WorktreeReapReport {
  return {
    repos_swept: 0,
    candidates: 0,
    live_skipped: 0,
    detached: [],
    removed: [],
    preserved: [],
    protected_nonterminal: [],
    skipped_no_liveness: false,
    refs_examined: 0,
    refs_deleted: [],
    refs_kept: [],
    refs_stood_down: 0,
    refs_restored: [],
    refs_restore_failed: [],
    refs_candidates: [],
  }
}

function snapshotProcessCwds(procRoot: string): string[] | null {
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return null
  }

  const cwds: string[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      cwds.push(readlinkSync(join(procRoot, entry, 'cwd')))
    } catch {
      // Same-uid entries are readable; other uids and exit races are per-pid skips.
    }
  }
  return cwds
}

function parseWorktrees(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of stdout.trim().split(/\r?\n\r?\n/)) {
    if (block.trim() === '') continue
    const entry: WorktreeEntry = {
      path: '',
      head: null,
      branch: null,
      detached: false,
      locked: false,
      prunable: false,
      bare: false,
    }
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length)
      else if (line === 'detached') entry.detached = true
      else if (line === 'bare') entry.bare = true
      else if (line === 'locked' || line.startsWith('locked ')) entry.locked = true
      else if (line === 'prunable' || line.startsWith('prunable ')) entry.prunable = true
    }
    if (entry.path !== '') entries.push(entry)
  }
  return entries
}

function resolvedPath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function pathIsWithin(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(`${root}/`)
}

function isLive(path: string, processCwds: string[]): boolean {
  const resolved = resolvedPath(path)
  return processCwds.some(
    (cwd) => pathIsWithin(cwd, path) || (resolved !== null && pathIsWithin(cwd, resolved)),
  )
}

function samePath(left: string, right: string): boolean {
  if (left === right) return true
  const resolvedLeft = resolvedPath(left)
  const resolvedRight = resolvedPath(right)
  return resolvedLeft !== null && resolvedRight !== null && resolvedLeft === resolvedRight
}

function claimedByNonTerminalRun(
  entry: WorktreeEntry,
  repo: string,
  runs: ReturnType<WorktreeReaperStore['listNonTerminal']>,
): boolean {
  return runs.some((run) => {
    if (run.worktree !== null && samePath(run.worktree, entry.path)) return true
    if (
      run.repo_path === repo &&
      run.branch !== null &&
      entry.branch === `refs/heads/${run.branch}`
    ) {
      return true
    }
    return (
      run.workflow_run_id !== null &&
      run.workflow_run_id !== '' &&
      basename(entry.path).includes(run.workflow_run_id)
    )
  })
}

/** git's own words for a refusal, in the order the rest of this module reads them. */
function hostText(result: { stderr: string; stdout: string; exit_code: number }): string {
  return result.stderr || result.stdout || `exit ${result.exit_code}`
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function candidateAgeMs(path: string, now: number): number | null {
  try {
    const newestMtime = Math.max(lstatSync(path).mtimeMs, statSync(join(path, '.git')).mtimeMs)
    return now - newestMtime
  } catch {
    return null
  }
}

/** Sweep every store-known repository for leaked `wf_*` worktrees. */
export async function sweepTridentWorktrees(
  opts: WorktreeReaperOptions,
): Promise<WorktreeReapReport> {
  const report = emptyReport()
  const processCwds = snapshotProcessCwds(opts.proc_root ?? '/proc')
  if (processCwds === null) {
    report.skipped_no_liveness = true
    return report
  }

  const nonTerminalRuns = opts.store.listNonTerminal(500)
  const retentionMs = opts.retention_ms ?? DEFAULT_WORKTREE_RETENTION_MS
  const now = opts.now ?? (() => Date.now())
  let removalAttempts = 0
  // Shared across repos so one sweep's total destructive work stays bounded.
  const refDeletions = { attempts: 0 }
  // Read ONCE per sweep, so every repo in one sweep answers the same question.
  const refsReady = (opts.refs_ready ?? (() => true))()

  for (const repo of new Set(opts.store.listRepoPaths())) {
    if (!existsSync(repo)) continue

    let listed
    try {
      listed = await opts.run_host(['git', '-C', repo, 'worktree', 'list', '--porcelain'], repo)
    } catch (error) {
      // COUNTED, NOT JUST SKIPPED (#547 round 5). These three `continue`s predate the ref
      // reap and are right for the WORKTREE half — there is nothing to sweep in a repo that
      // will not answer. What was wrong was the silence: they also skip the REF half, so an
      // unreadable `worktree list` made a repository indistinguishable from one with nothing
      // to reap, which is precisely the mode this module claims to have fixed. A claim in a
      // header is worth no more than the counter behind it.
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: `repo-unenumerable: ${errText(error)}`,
      })
      report.refs_stood_down += 1
      continue
    }
    if (!listed.ok) {
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: `repo-unenumerable: ${hostText(listed)}`,
      })
      report.refs_stood_down += 1
      continue
    }

    const entries = parseWorktrees(listed.stdout)
    if (entries.length === 0) {
      // An EMPTY listing is not a measurement of a repository: git always reports at least
      // the main working tree, so zero entries means the output was not what was asked for.
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: 'repo-unenumerable: `worktree list` named no worktrees at all, not even the main one',
      })
      report.refs_stood_down += 1
      continue
    }
    report.repos_swept += 1
    /** `refs/heads/trident/*` → the worktree this sweep detached it from. */
    const detachedThisSweep = new Map<string, string>()

    const candidates = entries.slice(1).filter(
      (entry) =>
        basename(entry.path).startsWith('wf_') &&
        !entry.bare &&
        !entry.locked &&
        !entry.prunable,
    )
    report.candidates += candidates.length

    for (const entry of candidates) {
      if (isLive(entry.path, processCwds)) {
        report.live_skipped += 1
        continue
      }

      if (entry.branch?.startsWith('refs/heads/trident/') === true) {
        let detached
        try {
          detached = await opts.run_host(
            ['git', '-C', entry.path, 'checkout', '--detach'],
            entry.path,
          )
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          report.preserved.push({ path: entry.path, reason: `detach failed: ${reason}` })
          log.warn('worktree_reaper_detach_failed', { repo, worktree: entry.path, reason })
          continue
        }
        if (!detached.ok) {
          const reason = detached.stderr || detached.stdout || `exit ${detached.exit_code}`
          report.preserved.push({ path: entry.path, reason: `detach failed: ${reason}` })
          log.warn('worktree_reaper_detach_failed', { repo, worktree: entry.path, reason })
          continue
        }
        report.detached.push(entry.path)
        // THE DETACH THIS SWEEP JUST PERFORMED FREED THIS REF, and that is not the same
        // thing as the ref having been free (#547). A worktree can be detached here and
        // then PRESERVED below — dirty, or inside the retention window — and its ref is
        // the history its uncommitted work sits on top of.
        //
        // THIS MAP LIVES FOR ONE SWEEP AND IS NOT WHAT HOLDS THAT LINE. It is built per
        // repo inside `sweepTridentWorktrees`, so on the NEXT sweep the tree is already
        // detached, `entry.branch` is null, this block never runs, and this map is empty
        // — which is exactly how a preserved dirty tree lost its ref one sweep later.
        // GATE 5 in `reapBranchRefs` is the durable answer: it matches the ref's COMMIT
        // against the HEAD of every listed tree still on disk, and the `--detach` above
        // leaves HEAD on the tip. All this records is the nicer refusal REASON while the
        // sweep that performed the detach is still running.
        detachedThisSweep.set(entry.branch, entry.path)
      }

      const ageMs = candidateAgeMs(entry.path, now())
      if (ageMs === null) {
        report.preserved.push({ path: entry.path, reason: 'age unverifiable' })
        continue
      }
      if (ageMs <= retentionMs) {
        report.preserved.push({ path: entry.path, reason: 'within retention' })
        continue
      }

      if (claimedByNonTerminalRun(entry, repo, nonTerminalRuns)) {
        report.protected_nonterminal.push(entry.path)
        continue
      }

      if (removalAttempts >= MAX_REMOVALS_PER_SWEEP) {
        report.preserved.push({ path: entry.path, reason: 'removal limit reached' })
        continue
      }
      removalAttempts += 1
      const reason = await removeWorktreePath(opts.run_host, repo, entry.path)
      if (reason === null) report.removed.push(entry.path)
      else report.preserved.push({ path: entry.path, reason })
    }

    try {
      await opts.run_host(['git', '-C', repo, 'worktree', 'prune'], repo)
    } catch {
      // A failed administrative prune must not abort cleanup in another repo.
    }

    // THE BRANCH-REF REAP (#547), last in the repo so it reads the world the worktree
    // pass and the prune just left: a tree that was removed is no longer a holder, and a
    // tree that was PRESERVED still is — by its HEAD (gate 5), which is what makes that
    // true on every later sweep too and not just on the one that detached it. One
    // try/catch for the same reason the prune has one: a ref sweep that throws in one
    // repo must not abandon the next.
    if (!refsReady) {
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: 'awaiting-boot-rescue: the stranded-failure sweep has not settled yet',
      })
      report.refs_stood_down += 1
      continue
    }
    try {
      await reapBranchRefs(opts, repo, processCwds, report, refDeletions, detachedThisSweep)
    } catch (error) {
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: `sweep-failed: ${errText(error)}`,
      })
      report.refs_stood_down += 1
    }
  }

  return report
}

// ── THE BRANCH-REF REAP (#547) ────────────────────────────────────────────────

interface ZHolder {
  path: string
  /** The branch the entry has checked out BY NAME, absent for a detached tree. */
  branch: string | null
  /** The commit the entry's HEAD is at — present even when `branch` is not (gate 5). */
  head: string | null
  bare: boolean
}

/**
 * Parse `git worktree list --porcelain -z`. The NUL form, not the newline form
 * `parseWorktrees` above reads, and the difference is load-bearing HERE in a way it is
 * not there: a worktree path may legally contain a newline, such a path splits its own
 * record, and the branch it holds then reads as UNHELD — which in this half of the
 * module is the answer that reaches a delete. `wrong-base-remedy.ts` reaches for the
 * same form for the same reason. Each attribute is NUL-terminated; an EMPTY attribute
 * (a second NUL) ends the record.
 */
function parseHoldersZ(stdout: string): ZHolder[] {
  const holders: ZHolder[] = []
  let holder: ZHolder | null = null
  const close = (): void => {
    if (holder !== null && holder.path !== '') holders.push(holder)
    holder = null
  }
  for (const field of stdout.split('\0')) {
    if (field === '') {
      close()
      continue
    }
    holder ??= { path: '', branch: null, head: null, bare: false }
    if (field.startsWith('worktree ')) holder.path = field.slice('worktree '.length)
    else if (field.startsWith('branch ')) holder.branch = field.slice('branch '.length)
    else if (field.startsWith('HEAD ')) holder.head = field.slice('HEAD '.length)
    else if (field === 'bare') holder.bare = true
    // `detached` is deliberately NOT read. An entry with no `branch` attribute is asked
    // about its rebase/bisect state whatever else it says, because the SUPERSET is the
    // safe side: a git that stopped printing `detached` for a rebasing worktree would
    // otherwise make that tree's ref read as unheld.
  }
  close()
  return holders
}

/**
 * A HOLDER LISTING, OR NOTHING — and "nothing" means UNREADABLE, never "no worktrees".
 *
 * THE THIRD ROUTE INTO THE SAME MISTAKE (#547 round 9), and the least visible: a command that
 * SUCCEEDED, whose output cannot be what it says. Nothing failed — `ok` is true, no exception,
 * no error string — so neither the `.ok` audit nor the `catch` audit could see it. The signal
 * is purely semantic: `git worktree list` ALWAYS reports the main working tree, so a listing
 * that parses to zero records is not an empty repository, it is an answer that did not arrive.
 *
 * THE GUARD IS ON THE PARSE RESULT, NOT ON THE STRING, because empty stdout is only one of the
 * shapes. Measured against `parseHoldersZ`: `''`, a run of bare NULs, records carrying no
 * `worktree` field, and arbitrary non-porcelain text (`fatal: not a git repository`) ALL parse
 * to zero records. A check for `stdout === ''` would have caught one of four.
 *
 * The worktree pass has always got this right for its own listing; this is the same rule,
 * applied to the two `-z` listings that did not have it — the holder map and, critically, the
 * claim probe, where reading "no claimants" out of an unreadable listing permits a delete.
 */
function readHolders(stdout: string): ZHolder[] | null {
  const holders = parseHoldersZ(stdout)
  return holders.length === 0 ? null : holders
}

/**
 * `<full ref>\0<sha>` per line. A ref name cannot contain an ASCII control character —
 * `git check-ref-format` rejects one — so newline-delimited RECORDS are safe here in a
 * way they are not for worktree paths; the NUL only separates the two fields, so a
 * `%(refname)` is never confused with a sha.
 */
function parseRefLines(stdout: string): { ref: string; sha: string }[] {
  const refs: { ref: string; sha: string }[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') continue
    const nul = line.indexOf('\0')
    if (nul <= 0) continue
    const ref = line.slice(0, nul)
    const sha = line.slice(nul + 1).trim()
    if (ref === '' || sha === '') continue
    refs.push({ ref, sha })
  }
  return refs
}

/**
 * Is a process standing anywhere that belongs to this run (gate 10)? Two independent
 * witnesses, because a terminal row proves only what the STORE believes: a cwd inside
 * the worktree the run recorded, and a cwd under a path bearing the run's launcher
 * generation key — the same `workflow_run_id` basename match `claimedByNonTerminalRun`
 * uses, which is what catches a build whose worktree the row never recorded.
 */
function ownerProcessLive(owner: TridentBranchOwner, processCwds: string[]): boolean {
  if (owner.worktree !== null && owner.worktree !== '' && isLive(owner.worktree, processCwds)) {
    return true
  }
  const generation = owner.workflow_run_id
  if (generation === null || generation === '') return false
  return processCwds.some((cwd) => cwd.includes(generation))
}

/**
 * DID `update-ref <ref> <new> ''` REFUSE BECAUSE THE REF ALREADY EXISTS? That is the one
 * failure of a create-only write which proves something useful: the ref is THERE, so a
 * claimant has made its own and nothing is dangling.
 *
 * Matched on git's own words AND its fatal exit code, both required. Measured on git 2.43:
 * `fatal: update_ref failed for ref '<ref>': cannot lock ref '<ref>': reference already
 * exists`, exit 128. A tighter match than necessary is the safe direction here — a benign
 * case misread as unknown is merely reported loudly, while an unknown failure misread as
 * benign leaves a live claimant's HEAD dangling and says nothing.
 */
function refAlreadyExists(result: { stdout: string; stderr: string; exit_code: number }): boolean {
  return result.exit_code === 128 && /reference already exists/i.test(`${result.stderr}${result.stdout}`)
}

/**
 * DOES THIS REF EXIST? Three answers, keyed on `git rev-parse --verify --quiet`'s EXIT CODE
 * and never on a boolean.
 *
 * MEASURED on git 2.43: a ref that resolves exits **0**; one that does not exits **1**; a
 * hard failure — not a repository, an unreadable ref database — exits **128**. So exit 1 is
 * the ONLY value that means absent, and `ok` cannot express that: it folds 1 and 128 into
 * one `false`, which on this path is the difference between "the reap is real" and "I have no
 * idea what happened".
 *
 * WHY THIS FUNCTION EXISTS AT ALL (#547 round 7, and the third instance of one mistake).
 * The caller previously read presence as `after.ok && stdout !== ''` and treated everything
 * else as absent, so `{ok:false, exit_code:128}` — a real git error — recorded a DELETION
 * with no evidence the ref was gone. Round 4 made the same mistake with `refAlreadyExists`
 * (`!ok` instead of exit 128 plus the message) and round 6 made it with the delete itself
 * (`!ok` instead of present/absent/unknown). See the module header: on a destructive path
 * "false" and "unknown" must never share a branch, and a boolean result type is what makes
 * them share one.
 *
 * `1` also covers a ref that exists but does not RESOLVE — a corrupt ref file reads as exit 1
 * (measured). For this caller's question that is the right reading: an unusable ref is not a
 * ref the sweep left standing. The refs here come from `for-each-ref`, so a malformed name
 * (also exit 1) cannot reach it.
 */
function refPresence(result: HostCommandResult): 'present' | 'absent' | 'unknown' {
  if (result.exit_code === 0) return 'present'
  if (result.exit_code === 1) return 'absent'
  return 'unknown'
}

/**
 * IS ANYTHING CLAIMING THIS REF RIGHT NOW? Re-measured from scratch — a fresh worktree
 * listing, a fresh store read AND a fresh `/proc` snapshot — rather than from the snapshots
 * the per-ref gates use.
 *
 * WHY THIS EXISTS (#547 round 3, cross-model gate). The delete is an atomic
 * compare-and-swap on the ref's VALUE, and that is all it is. A new run can claim the
 * slug and `git worktree add` the branch at its UNCHANGED tip after the holder and owner
 * snapshots are taken — so the sha is exactly what was expected, the CAS succeeds, and a
 * branch a live run is standing on is deleted. `update-ref -d` will not refuse a
 * checked-out branch (this suite measures that deliberately), which is what makes the race
 * bite rather than fail closed.
 *
 * WHY `/proc` IS RE-READ HERE (#547 round 15). It was not, and that was the asymmetry: this
 * function refreshed the HOLDER questions and the OWNER rows and reused the sweep's one-time
 * liveness snapshot for the PROCESS question, so gate 10 was historical while 4, 5 and 12 were
 * current. Repro: mint a candidate for a terminal owner whose recorded worktree is an ordinary
 * directory with nothing running in it, then start a process whose cwd is under that directory
 * before the delete. The fresh listing shows no linked worktree, the owner is still terminal,
 * the candidate is genuinely minted — and the ref is deleted beneath a now-live process.
 *
 * AN ATTESTATION PROVES THE GATES RAN; IT DOES NOT PROVE THEY STILL HOLD. Provenance is not
 * currency. The mint's map answers "were these inputs gated?" and cannot answer "is that still
 * the case?", so every gate whose subject can change between mint and delete has to be measured
 * again here. The freshness audit in the module header says which those are.
 *
 * Returns a reason when something claims it, null when nothing provably does. A read that
 * FAILS returns a reason too: an unanswered question is not an absence of claimants.
 */
async function refClaimedNow(
  opts: WorktreeReaperOptions,
  repo: string,
  ref: string,
  short: string,
  sha: string,
): Promise<string | null> {
  let listed
  try {
    listed = await opts.run_host(['git', '-C', repo, 'worktree', 'list', '--porcelain', '-z'], repo)
  } catch (error) {
    return `holders-unreadable: ${errText(error)}`
  }
  if (!listed.ok) return `holders-unreadable: ${hostText(listed)}`
  const readRebase = opts.rebase_head ?? readRebaseHead
  const entries = readHolders(listed.stdout)
  if (entries === null) {
    // A SUCCESSFUL COMMAND WHOSE OUTPUT IS IMPOSSIBLE. Reading "no claimants" out of this is
    // what would permit the delete, so it answers CLAIMED — the refusing direction, like every
    // other unreadable measurement in this module.
    return 'holders-unreadable: the listing named no worktrees at all, not even the main one'
  }
  for (const [index, holder] of entries.entries()) {
    if (holder.branch === ref) return `checked out at ${holder.path}`
    // The commit-keyed witness, linked trees only, for the same reasons as gate 5.
    if (index > 0 && !holder.bare && holder.head === sha && existsSync(holder.path)) {
      return `a detached worktree stands on the tip at ${holder.path}`
    }
    if (holder.branch === null) {
      const rebasing = readRebase(holder.path)
      if (rebasing.kind === 'unknown') return `rebase/bisect state unreadable in ${holder.path}`
      if (rebasing.kind === 'branch' && rebasing.ref === ref) {
        return `a ${rebasing.state ?? 'rebase'} holds it at ${holder.path}`
      }
    }
  }
  // And the DB side, re-read: a dispatch's claim is an INSERT of a NON-TERMINAL row.
  let owners
  try {
    owners = opts.store.listBranchOwners(repo)
  } catch (error) {
    return `owners-unreadable: ${errText(error)}`
  }
  // GATE 7, RE-MEASURED (#547 round 16). AT LEAST ONE ROW MUST STILL NAME THE BRANCH.
  //
  // The audit classified this gate as immutable on the grounds that rows are not deleted. They
  // are: `store.ts`'s `delete(id)` is `/trident stop`'s hard-delete path, `DELETE FROM
  // code_trident_runs WHERE id = ?`. So the row that proved ownership can be GONE by the time
  // the delete runs, and without this check both `find` calls below miss, this function falls
  // through to `null`, and the delete is authorised on an empty owner list — the exact
  // condition the sweep refuses as `owner-unknown`. A ref with no owner is UNPROVABLE
  // OWNERSHIP, not a disposable ref, and that rule has to hold at both measurements or it is
  // not a rule.
  const named = owners.filter((owner) => owner.branch === short)
  if (named.length === 0) {
    return 'ownership-no-longer-provable: no run row names this branch any more'
  }
  const live = named.find((owner) => !isTerminalPhase(owner.phase))
  if (live !== undefined) return `a run in phase '${live.phase}' claims it`

  // GATE 10, RE-MEASURED. A process can start inside an owning run's recorded worktree between
  // the sweep's snapshot and this moment — the tree is an ordinary directory, so nothing about
  // the holder listing or the phase changes when something begins running in it.
  //
  // AN UNREADABLE `/proc` REFUSES, which is gate 1's posture applied at the second measurement
  // rather than only at the first. The sweep aborts wholesale when `/proc` cannot be read
  // (`skipped_no_liveness`); if it becomes unreadable between then and now, the question "is
  // anything running in there" has no answer, and an unanswered question is never an absence.
  const processCwds = snapshotProcessCwds(opts.proc_root ?? '/proc')
  if (processCwds === null) return 'liveness-unreadable: /proc could not be read at delete time'
  const busy = named.find((owner) => ownerProcessLive(owner, processCwds))
  if (busy !== undefined) {
    return `a process stands in ${busy.worktree ?? busy.workflow_run_id ?? '?'}`
  }
  return null
}

/**
 * Sweep ONE repository's `refs/heads/trident/*` refs. Every gate refuses by RECORDING
 * why and moving on; nothing here throws, and nothing here is reached at all when
 * `/proc` could not be read (gate 1, enforced by the caller).
 */
async function reapBranchRefs(
  opts: WorktreeReaperOptions,
  repo: string,
  processCwds: string[],
  report: WorktreeReapReport,
  deletionBudget: { attempts: number },
  detachedThisSweep: Map<string, string>,
): Promise<void> {
  let listed
  try {
    listed = await opts.run_host(
      ['git', '-C', repo, 'for-each-ref', `--format=%(refname)%00%(objectname)`, TRIDENT_REF_PREFIX],
      repo,
    )
  } catch (error) {
    report.refs_kept.push({ ref: `${TRIDENT_REF_PREFIX}* in ${repo}`, reason: `refs-unenumerable: ${errText(error)}` })
    report.refs_stood_down += 1
    return
  }
  if (!listed.ok) {
    report.refs_kept.push({
      ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
      reason: `refs-unenumerable: ${hostText(listed)}`,
    })
    report.refs_stood_down += 1
    return
  }
  const refs = parseRefLines(listed.stdout)
  if (refs.length === 0) return

  // GATE 3 — a FRESH holder listing, read AFTER the worktree pass above, so a tree that
  // pass removed no longer counts as a holder and a tree it PRESERVED still does.
  let holderList
  try {
    holderList = await opts.run_host(['git', '-C', repo, 'worktree', 'list', '--porcelain', '-z'], repo)
  } catch (error) {
    report.refs_kept.push({
      ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
      reason: `holders-unenumerable: ${errText(error)}`,
    })
    report.refs_stood_down += 1
    return
  }
  if (!holderList.ok) {
    report.refs_kept.push({
      ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
      reason: `holders-unenumerable: ${hostText(holderList)}`,
    })
    report.refs_stood_down += 1
    return
  }

  // GATE 4 — who holds what BY NAME. A detached entry is asked directly, because git
  // prints no `branch` attribute for a worktree mid-rebase or mid-bisect even though it
  // holds one, and `readRebaseHead` reads exactly the four places git itself looks:
  // the HEAD symref, `rebase-merge/head-name`, `rebase-apply/head-name`, `BISECT_START`.
  const readRebase = opts.rebase_head ?? readRebaseHead
  const holders = readHolders(holderList.stdout)
  if (holders === null) {
    // Same rule, same reason: git must report the main worktree, so zero records is an answer
    // that did not arrive and no ref in this repo may be touched on the strength of it.
    report.refs_kept.push({
      ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
      reason: 'holders-unenumerable: the listing named no worktrees at all, not even the main one',
    })
    report.refs_stood_down += 1
    return
  }
  const held = new Map<string, string>()
  // GATE 5 — DURABLE HOLDER-BY-HEAD. Keyed on the COMMIT, and it is what makes the
  // preservation of a detached tree outlive the sweep that detached it.
  const heads = new Map<string, string>()
  for (const [index, holder] of holders.entries()) {
    // LINKED TREES ONLY. `index === 0` is the shared checkout (git-worktree(1): "The main
    // worktree is listed first"), and it is excluded for the same reason the worktree pass
    // above excludes it: it is never a disposable build tree, so it can never be the tree
    // this gate exists to protect — the pass only ever detaches LINKED `wf_*` trees.
    //
    // Including it would add nothing but coincidence refusals on the one tree that is
    // never disposable: `merge.ts` legitimately leaves the shared checkout parked on a
    // feature branch, and a freshly-cut `trident/*` ref whose build committed nothing has
    // main's tip, which is exactly where the shared checkout usually stands. Measured
    // while writing this: with the shared checkout included, two existing cases refused a
    // ref whose worktree had genuinely been removed. The by-NAME case is not lost — gate 4
    // does not skip index 0, so a shared checkout holding a `trident/*` branch still keeps
    // its ref.
    //
    // A bare entry has no working tree and no HEAD of its own to stand on.
    //
    // `existsSync` HERE IS DEFENCE WITHOUT AN OBSERVABLE CONSEQUENCE, and it is kept
    // rather than removed. No test can distinguish it, because a listed entry whose
    // directory is gone is refused either way: if it still holds its branch BY NAME gate 4
    // takes it, and if it is detached then `readRebaseHead` cannot read a rebase state out
    // of a missing directory, answers 'unknown', and stands the whole repo down (pinned by
    // "a listed worktree whose DIRECTORY is gone stands the whole repo down"). Mutating it
    // away therefore changes no outcome. It stays because it costs one syscall and it keeps
    // this gate's claim — "a tree still on disk" — true on its own terms rather than by
    // relying on another gate to cover for it.
    if (
      index > 0 &&
      !holder.bare &&
      holder.head !== null &&
      holder.head !== '' &&
      existsSync(holder.path)
    ) {
      if (!heads.has(holder.head)) heads.set(holder.head, holder.path)
    }
    if (holder.branch !== null) {
      held.set(holder.branch, holder.path)
      continue
    }
    const rebasing = readRebase(holder.path)
    if (rebasing.kind === 'unknown') {
      // What could not be read may name ANY of these refs, so none of them is touched.
      report.refs_kept.push({
        ref: `${TRIDENT_REF_PREFIX}* in ${repo}`,
        reason: `holder-unprovable: cannot read rebase/bisect state in ${holder.path}`,
      })
      report.refs_stood_down += 1
      return
    }
    if (rebasing.kind === 'branch') held.set(rebasing.ref, holder.path)
  }
  // THE SAME-SWEEP FAST PATH, no longer load-bearing. It records the ref a detach in
  // THIS sweep freed, so the refusal reason can name the detach rather than the HEAD.
  // Gate 4c is what actually holds the line: this map lives for one sweep, and the tree
  // it remembers is still on disk on the next one.
  for (const [ref, path] of detachedThisSweep) {
    if (!held.has(ref) && existsSync(path)) held.set(ref, path)
  }

  // GATES 5-6 — ownership, keyed by the branch SHORT name the store records.
  const owners = new Map<string, TridentBranchOwner[]>()
  for (const owner of opts.store.listBranchOwners(repo)) {
    const list = owners.get(owner.branch)
    if (list === undefined) owners.set(owner.branch, [owner])
    else list.push(owner)
  }

  for (const { ref, sha } of refs) {
    report.refs_examined += 1
    // GATE 2 — belt and braces on the namespace `for-each-ref` was already scoped to.
    if (!ref.startsWith(TRIDENT_REF_PREFIX)) {
      report.refs_kept.push({ ref, reason: 'out-of-namespace' })
      continue
    }
    const short = ref.slice('refs/heads/'.length)

    const holder = held.get(ref)
    if (holder !== undefined) {
      const freedHere = detachedThisSweep.get(ref) === holder
      report.refs_kept.push({
        ref,
        reason: `${freedHere ? 'held-by-preserved-worktree' : 'held-by-worktree'}: ${holder}`,
      })
      continue
    }

    // GATE 5 — A DETACHED WORKTREE STANDING ON THIS EXACT COMMIT HOLDS IT, and this is
    // the gate that survives the sweep boundary.
    //
    // THE DEFECT THIS FIXES (adversarial review of PR #606, escalated and confirmed).
    // `detachedThisSweep` is built inside the per-repo loop, so it is memory for ONE
    // sweep. On the next sweep the tree is already detached, `entry.branch` is null, the
    // detach block never runs, nothing is recorded — and a dirty tree the previous sweep
    // deliberately preserved had its ref deleted anyway. Measured on the repo of record:
    // 16 `wf_*` trees were already detached by earlier sweeps of shipped main and ALL 16
    // were dirty (3-67 changed paths), one of them standing exactly on the tip of a
    // `trident/*` ref whose every other gate passes.
    //
    // Keyed on the COMMIT rather than on a name, which is precisely what makes it
    // durable: `git checkout --detach` in the worktree pass above leaves HEAD at the tip
    // it was on, so the tree still points at the ref's commit however many sweeps later.
    // It deliberately does NOT cover a conflicted rebase — there HEAD is the `onto`
    // commit, not the tip — and it does not need to, because gate 4 reads that state
    // directly from the rebase's own `head-name`.
    //
    // A tip that COINCIDES with some unrelated tree's HEAD is kept too. That is a
    // nuisance, not a bug, and it is small: measured against the 80 refs on the repo of
    // record it refuses exactly one. Refusing on a coincidence costs a sweep; deleting a
    // ref a preserved dirty tree is standing on costs the work in that tree.
    const standingOn = heads.get(sha)
    if (standingOn !== undefined) {
      report.refs_kept.push({ ref, reason: `held-by-detached-worktree: ${standingOn}` })
      continue
    }

    const claimants = owners.get(short)
    if (claimants === undefined || claimants.length === 0) {
      report.refs_kept.push({ ref, reason: 'owner-unknown: no run row names this branch' })
      continue
    }
    const live = claimants.find((owner) => !isTerminalPhase(owner.phase))
    if (live !== undefined) {
      report.refs_kept.push({ ref, reason: `owner-not-terminal: a run is in phase '${live.phase}'` })
      continue
    }
    const standing = claimants.find(
      (owner) => owner.worktree !== null && owner.worktree !== '' && existsSync(owner.worktree),
    )
    if (standing !== undefined) {
      report.refs_kept.push({ ref, reason: `run-worktree-present: ${standing.worktree ?? ''}` })
      continue
    }
    const busy = claimants.find((owner) => ownerProcessLive(owner, processCwds))
    if (busy !== undefined) {
      report.refs_kept.push({
        ref,
        reason: `run-process-live: a process stands in ${busy.worktree ?? busy.workflow_run_id ?? '?'}`,
      })
      continue
    }

    // ───────────────────────────────────────────────────────────────────────────────
    // THE DELETION IS DEFERRED TO #635, AND THIS IS THE ONE PLACE THAT SAYS SO.
    //
    // Every gate above has passed, so this ref IS reapable and is reported as such. The
    // destructive half lives in `deleteReapableRef` and the sweep does not call it — one
    // non-call, named here, and #635 turns this branch into that call.
    //
    // WHY, AND WHY IT IS THIS PR'S SCOPE RATHER THAN A FLAG. Nothing deletes these refs
    // today, so shipping the reap introduces a destructive operation that does not
    // currently exist — and with it a failure mode whose outcome is a run committing onto
    // no history at all, its PR a whole-tree diff against unrelated history. "The commits
    // are never lost" is true and is not the same as "nothing bad happens". The definitive
    // protection is on the claimant's side (#635: a run whose HEAD does not resolve must
    // refuse to commit), because that side can settle it with one `rev-parse --verify HEAD`
    // and no race — and it is not buildable here: the build's commit is the agent running
    // `git commit` in its worktree, driven by prompt text in `inner-workflow.mjs`, so there
    // is no function in this lane to guard.
    //
    // A change that introduces automation is measured against a world in which that
    // automation does not exist. Every gate, the measurement and the reporting ship; the
    // write waits for its guard.
    //
    // ZERO WRITES, and that is an improvement rather than merely a smaller change: not
    // creating salvage refs for deletions that are not happening avoids seeding a namespace
    // that has no pruner (see the record).
    // A CANDIDATE, not a decision: gates 1-10 passed. Gates 11-14 are evaluated only at
    // deletion time (see the field's own note), so a ref listed here can still be refused by
    // the salvage or by the claim probe when #635 turns this branch into a call.
    report.refs_candidates.push(mintReapableCandidate(repo, ref, sha))
    report.refs_kept.push({ ref, reason: DEFERRED_PENDING_CLAIMANT_GUARD })
    continue
    // ───────────────────────────────────────────────────────────────────────────────
  }
}

/**
 * THE DESTRUCTIVE HALF, extracted so the sweep can decline to call it (#635).
 *
 * Everything from the per-sweep deletion budget through the salvage, the claim probe, the
 * atomic compare-and-swap delete and the repair. Exported for two reasons and no others:
 * the sweep's ONE non-call of it is the deferral this PR ships, and the whole sequence stays
 * under test so the code #635 re-enables is code whose coverage never lapsed. There is no
 * flag here and no second path — production reaches this function from nowhere.
 *
 * THE PRECONDITIONS ARE CARRIED BY THE ARGUMENTS, NOT BY THE CALLER'S DISCIPLINE. Gates 1-10
 * — the ref is in trident's namespace, no worktree holds it by name or by commit, every
 * owning run row is terminal, no recorded worktree survives, no process stands in one — are
 * what `mintReapableCandidate` attests to, and only `reapBranchRefs` can mint. Gate 0 here
 * refuses anything else before a byte is written — including a candidate minted against a
 * DIFFERENT repository than the one `repo` names; gates 11-14 below are the four checks that
 * can only be made at the moment of the write.
 *
 * This used to read "preconditions, all fourteen of them, are the caller's", which was an
 * accurate description of an unguarded destructive primitive. See `ReapableCandidate`.
 */
export async function deleteReapableRef(
  opts: WorktreeReaperOptions,
  repo: string,
  candidate: ReapableCandidate,
  report: WorktreeReapReport,
  deletionBudget: { attempts: number },
): Promise<void> {
  const { ref, sha } = candidate

  // GATE 0 — THE BOUNDARY. Nothing below runs for a value the gate chain did not produce
  // FOR THIS REPOSITORY.
  // This is the difference between preconditions that are DOCUMENTED and preconditions that
  // are ENFORCED, and it is checked before the budget so that a forged value cannot even
  // consume a sweep's deletion allowance.
  const refused = candidateRefusal(repo, candidate)
  if (refused !== null) {
    report.refs_kept.push({ ref, reason: `not-a-reapable-candidate: ${refused}` })
    log.error('worktree_reaper_ref_boundary_refused', { repo, ref, sha, reason: refused })
    return
  }
  const short = ref.slice('refs/heads/'.length)

  if (deletionBudget.attempts >= MAX_REF_DELETIONS_PER_SWEEP) {
    report.refs_kept.push({ ref, reason: 'deletion limit reached' })
    return
  }

  // GATE 11 — SALVAGE FIRST, CREATE-ONLY. `refs/trident-reaped/<slug>/<sha>` embeds the
  // sha it carries, so the name is a function of its own value: two sweeps reaping the
  // same slug write the SAME ref when the tip matches and DIFFERENT refs when it does
  // not, and neither can overwrite the other's. The write is still made create-only
  // (`update-ref <ref> <new> ''`, whose empty old-value means "must not exist"; measured
  // on git 2.43: exit 128 "reference already exists") rather than an unconditional set,
  // so the one case the naming cannot rule out — an existing salvage at some OTHER sha —
  // is refused instead of clobbered.
  //
  // A refusal falls through to a read, and that read cannot be harmfully stale: it is
  // reached only because the ref already exists, and all it has to establish is that
  // what already exists is this tip. The CREATE path needs no read at all.
  const salvage = `${SALVAGE_REF_PREFIX}${short.slice('trident/'.length)}/${sha}`
  let saved
  try {
    saved = await opts.run_host(['git', '-C', repo, 'update-ref', salvage, sha, ''], repo)
  } catch (error) {
    report.refs_kept.push({ ref, reason: `salvage-failed: ${errText(error)}` })
    return
  }
  if (!saved.ok) {
    let confirmed
    try {
      confirmed = await opts.run_host(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', salvage], repo)
    } catch (error) {
      report.refs_kept.push({ ref, reason: `salvage-unverified: ${errText(error)}` })
      return
    }
    if (!confirmed.ok || confirmed.stdout.trim() !== sha) {
      report.refs_kept.push({
        ref,
        reason: `salvage-unverified: ${salvage} does not carry the tip (${hostText(saved)})`,
      })
      return
    }
  }

  // GATE 13 — THE DELETE IS ONE ATOMIC COMPARE-AND-SWAP, and that is the whole reason
  // `update-ref -d` is the primitive here rather than `git branch -D`.
  //
  // THE BUG THIS REPLACES (cross-model review of PR #606). This used to be a
  // `rev-parse` re-read followed by a SEPARATE `git branch -D`, described as a
  // compare-and-swap. It was not one: anything could advance the branch in the window
  // between the two commands, and `branch -D` — which has no old-value check at any
  // price — would then delete the commit that had just arrived. 67 of the 79 refs
  // measured on 2026-09-12 carried commits that exist nowhere else, so that window
  // destroyed work, and the salvage written above would have preserved the OLD tip
  // while the new one went with the branch.
  //
  // WHY GIVING UP `branch -D`'s HOLDER REFUSAL COSTS NOTHING. The measurement that put
  // it here was real (git 2.43: `branch -D` exits 1 with "cannot delete branch 'feat'
  // used by worktree at ...", `update-ref -d` deletes without a word) but it answered
  // the wrong question. Holder safety and atomicity are separate axes: holder safety is
  // already established by the worktree listing, the rebase/bisect read and this
  // sweep's own detach memory above, three gates that do not depend on the delete
  // primitive — while atomicity is a thing `branch -D` cannot supply from any of them.
  // `update-ref -d <ref> <expected-sha>` checks the old value and unlinks the ref under
  // ONE ref lock (measured on git 2.43: a stale expected sha exits 1 with "cannot lock
  // ref ... is at X but expected Y" and the ref survives), so there is no window left
  // to lose a commit in.
  //
  // EACH REF IS INDEPENDENTLY SAFE, which is what makes the per-sweep deletion cap and
  // a mid-sweep death harmless. One ref's work is exactly: create its salvage, then CAS
  // away its branch. A process that dies between the two leaves a salvage and an intact
  // branch — the next sweep confirms that salvage and finishes. A process that dies
  // after leaves the intended end state. Nothing spans two refs, so there is no
  // partially-applied state for a crash to leave behind.
  // GATE 12 — NOTHING CLAIMS IT AS OF NOW, re-measured rather than remembered. This
  // is the ordinary case: a dispatch that already committed its claim is seen here and
  // the destructive act is never performed at all.
  const claimedBefore = await refClaimedNow(opts, repo, ref, short, sha)
  if (claimedBefore !== null) {
    report.refs_kept.push({ ref, reason: `refuses-now: ${claimedBefore}` })
    return
  }

  deletionBudget.attempts += 1
  let deleted
  try {
    // `--no-deref` IS LOAD-BEARING AND ITS BLAST RADIUS IS THE DEFAULT BRANCH. Without
    // it, `update-ref -d` follows a SYMREF and deletes what it points AT, leaving the
    // symref itself standing. Measured on git 2.43: with `refs/heads/trident/evil` a
    // symref to `refs/heads/main`, every gate here passes on the symref's own name — 9b
    // included, since `holder.branch === ref` never matches — and the delete removed
    // `refs/heads/main`. Nothing in trident creates a symref under `refs/heads/` and
    // there are none on the repo of record, which is exactly why this is one flag rather
    // than a guard: "unreachable in this tree" has been the wrong answer twice in this
    // change already. The CAS is unaffected — the old-value compare still resolves
    // through the symref, so a stale sha still refuses.
    deleted = await opts.run_host(
      ['git', '-C', repo, 'update-ref', '--no-deref', '-d', ref, sha],
      repo,
    )
  } catch (error) {
    // A THROW AFTER THE COMMAND HAD ITS CHANCE IS *UNKNOWN*, NOT *FALSE* — instance four
    // of the same mistake, arriving by a route the `.ok` audit did not cover. The runner
    // can perform the delete and then throw (a broken pipe, a harness fault, a kill
    // reported as an exception rather than as `timed_out`), and until now the catch
    // recorded `delete-refused` and `continue`d: the ref stayed deleted, gate 14 and the
    // restore were never reached, and a claimant's HEAD was left dangling while the report
    // said the ref was kept.
    //
    // A thrown host call is EXACTLY the returned-timeout case in different clothing, so it
    // takes the same path — synthesised as an indeterminate result and measured below,
    // never inferred. See the module header: "threw after doing the thing" is a failure
    // class, and it is the one that looks least like one.
    deleted = { ok: false, stdout: '', stderr: errText(error), exit_code: 1, timed_out: true }
  }
  // A TIMEOUT IS NOT A REFUSAL, and collapsing the two skipped the repair. `spawnCapture`
  // kills the child on its watchdog and reports `ok:false` with `timed_out:true` — and a
  // kill that lands AFTER the ref lock committed leaves the ref gone while the result says
  // it failed. Read as a refusal, that `continue`d past gate 14: no restore was attempted
  // even with a claimant standing on the branch, and the report said the ref was kept.
  // Indeterminate means fall through to 9b and let it measure what actually happened.
  const deleteTimedOut = deleted.timed_out === true
  if (!deleted.ok && !deleteTimedOut) {
    // The overwhelmingly likely cause is the CAS losing — the ref moved, so something
    // is alive on it. Reported with git's own words rather than as a diagnosis.
    report.refs_kept.push({ ref, reason: `delete-refused: ${hostText(deleted)}` })
    return
  }
  // GATE 14 — AND NOTHING CLAIMED IT DURING THE DELETE. This narrows the bad ordering and
  // repairs what it catches. It does NOT make the outcome correct for every interleaving,
  // and this comment used to claim that it did (#547 round 14) — see the residue below,
  // which is the reason the deletion is deferred to #635 rather than a footnote to it.
  //
  // Gate 12 and the CAS together still leave one ordering: a dispatch claims the slug
  // and checks the branch out AFTER 11a read and BEFORE `update-ref -d` ran, at the
  // unchanged tip. Nothing git offers can close that from inside one command — there is
  // no primitive that compares a HOLDER and unlinks a ref atomically, and
  // `update-ref --stdin` refuses `verify` + `delete` on one ref — so this repairs it
  // instead of racing it: the same measurement is taken again, and a claim that appeared
  // puts the ref back at exactly the sha it had.
  //
  // THE REPAIR IS LOSSLESS, which is why it is a real answer and not a hedge. The sha is
  // unchanged by construction (the CAS proved it, and the salvage ref above holds it), so
  // the claimant's worktree HEAD symref resolves to the same commit it did before; no
  // commit, working tree or index is touched. The restore is CREATE-ONLY, so if the
  // claimant has meanwhile made its own branch at a different sha, that branch wins and
  // this reports rather than clobbers.
  //
  // THE RESIDUE, STATED AT ITS WORST RATHER THAN AT ITS BEST — and its best is what this
  // comment used to state. On the SUCCESS and EEXIST paths it is a sub-second window in
  // which the ref does not resolve, which can fail a concurrent `git switch` in the
  // claiming run's first step: a retryable error in a run that has just started.
  //
  // ON TWO OTHER PATHS IT IS NEITHER SUB-SECOND NOR RETRYABLE. A claimant this probe does
  // not see (it arrives after this read) and a restore that FAILS both leave the ref ABSENT
  // under a live claimant. Its HEAD symref then reports "No commits yet" and its next commit
  // is PARENTLESS, so its PR reads as a whole-tree diff against unrelated history — the
  // silently-wrong-base class this card exists to eliminate. No commit is lost and the
  // printed `git branch <name> <sha>` recovery works, but nothing AUTOMATED repairs it,
  // because a ref that does not exist does not enumerate on the next sweep.
  //
  // So the honest claim is: the bad ordering is narrowed and repaired where detected, never
  // eliminated from this side. #635 — a run whose HEAD does not resolve must refuse to
  // commit — is what eliminates the OUTCOME, from the side that can observe it without a
  // race. Anyone reading this while enabling deletion should read that clause first.
  const claimedDuring = await refClaimedNow(opts, repo, ref, short, sha)
  if (claimedDuring !== null) {
    // BOUNDED RETRY, CREATE-ONLY ON EVERY ATTEMPT (#547 round 5). The residue on the
    // FAILED branch is not the sub-second, retryable thing the comment above describes:
    // a claimant whose HEAD symref points at a deleted branch reports "No commits yet",
    // and its next commit is PARENTLESS — its PR becomes a whole-tree diff against
    // unrelated history, which is the silently-wrong-base class this card exists to
    // eliminate. Nothing automated repairs it either, because a ref that does not exist
    // does not enumerate on the next sweep. So a transient lock or a contended ref gets
    // more than one chance here.
    //
    // `''` — create-only — is repeated on every attempt and is not an optimisation to be
    // dropped later: a retry that degraded to a force-create would clobber a claimant
    // that had made its own branch between attempts, which is worse than not retrying.
    // The bound is a fixed count, not a deadline, because this sits inside a sweep that
    // must stay finite.
    //
    // LC_ALL=C is pinned for the ONE decision in this module that reads a git MESSAGE:
    // `refAlreadyExists` matches "reference already exists", and `spawnCapture` merges
    // `process.env`, so a localised environment would translate the string this branch
    // turns on. It fails safe (an unmatched message is treated as unknown and reported
    // loudly) and there are no translations on this host — pinned anyway, because a
    // guard that depends on the operator's locale is a guard with a hidden input.
    let restored: HostCommandResult = { ok: false, stdout: '', stderr: 'not attempted', exit_code: 1 }
    for (let attempt = 1; attempt <= MAX_RESTORE_ATTEMPTS; attempt++) {
      try {
        restored = await opts.run_host(
          ['git', '-C', repo, 'update-ref', ref, sha, ''],
          repo,
          { LC_ALL: 'C' },
        )
      } catch (error) {
        restored = { ok: false, stdout: '', stderr: errText(error), exit_code: 1 }
      }
      // Success, or a refusal that already tells us the ref is there: either way, done.
      if (restored.ok || refAlreadyExists(restored)) break
    }
    if (restored.ok) {
      report.refs_restored.push({ ref, sha })
      report.refs_kept.push({
        ref,
        reason: `raced-a-change: ${claimedDuring} — the ref was put back at ${sha}`,
      })
      log.warn('worktree_reaper_ref_restored', { repo, ref, sha, salvage, claim: claimedDuring })
    } else if (refAlreadyExists(restored)) {
      // THE BENIGN FAILURE, AND THE ONLY ONE. Create-only refused because the ref is
      // already there, so the claimant made its own branch — which is the outcome we
      // want and the reason the write is create-only. Not counted as a restore: we
      // did not put anything back.
      report.refs_kept.push({
        ref,
        reason: `raced-a-change: ${claimedDuring} — the claimant holds its own ref, ours was not forced back over it`,
      })
      log.warn('worktree_reaper_ref_claimant_owns', { repo, ref, sha, salvage, claim: claimedDuring })
    } else {
      // EVERY OTHER FAILURE MEANS THE REF IS ABSENT, and this is the one outcome gate 14
      // exists to prevent — the claimant's symbolic HEAD is dangling right now.
      //
      // THIS BRANCH IS HERE BECAUSE THE FIRST CUT DID NOT HAVE IT (#547 round 4). It read
      // ANY failure as "the claimant recreated the branch, so ours losing is correct", and
      // counted `refs_restored` unconditionally — so a lock failure, a permission error or
      // a transient host fault left the ref gone while the summary said it had been put
      // back. That is the same mistake this file corrects everywhere else: a command that
      // failed establishes that it did not succeed and NOTHING ELSE. Create-only is what
      // makes the benign case precisely checkable, so it is matched on rather than assumed.
      report.refs_restore_failed.push({ ref, sha })
      report.refs_kept.push({
        ref,
        reason:
          `RESTORE FAILED: ${claimedDuring} — the ref is ABSENT and could not be put back ` +
          `(${hostText(restored)}); recover with: git branch ${short} ${sha}`,
      })
      log.error('worktree_reaper_ref_restore_failed', {
        repo,
        ref,
        sha,
        salvage,
        claim: claimedDuring,
        error: hostText(restored),
      })
    }
    return
  }

  // AN INDETERMINATE DELETE IS MEASURED, NEVER INFERRED (#547 round 6). Making a timeout
  // indeterminate rather than a refusal was right, but the indeterminate path then fell
  // through to here and recorded a DELETION on the strength of gate 14 finding no
  // claimant — which is a different question entirely. "Nobody is standing on this ref"
  // does not say whether the ref still exists. `deleted.ok` was false, and the report
  // said the ref was reaped.
  //
  // So when the delete did not report success, ask git what the ref is now. Absent means
  // the kill landed after the lock committed and the reap is real; present means the kill
  // landed BEFORE it and nothing was deleted, which is a kept ref and is reported as one.
  // A rev-parse that will not answer either leaves the outcome unknown, and an unknown
  // outcome is not a deletion.
  if (!deleted.ok) {
    let after
    try {
      after = await opts.run_host(
        ['git', '-C', repo, 'rev-parse', '--verify', '--quiet', ref],
        repo,
      )
    } catch (error) {
      report.refs_kept.push({
        ref,
        reason: `delete-indeterminate: the delete timed out and the ref could not be re-read (${errText(error)})`,
      })
      report.refs_stood_down += 1
      return
    }
    // THE ANSWER IS KEYED ON THE EXIT CODE, not on `ok`. See `refPresence`.
    const presence = refPresence(after)
    if (presence === 'present') {
      report.refs_kept.push({
        ref,
        reason: `delete-timed-out: the ref is STILL PRESENT at ${after.stdout.trim()}, so nothing was deleted`,
      })
      return
    }
    if (presence === 'unknown') {
      report.refs_kept.push({
        ref,
        reason: `delete-indeterminate: the delete timed out and the ref did not read as present or absent (${hostText(after)})`,
      })
      report.refs_stood_down += 1
      return
    }
    log.warn('worktree_reaper_ref_deleted_after_timeout', { repo, ref, sha, salvage })
  }

  report.refs_deleted.push({ ref, sha, salvage })
  log.info('worktree_reaper_ref_deleted', { repo, ref, sha, salvage })
}
function logSummaryIfActed(report: WorktreeReapReport): void {
  // A SWEEP THAT STOOD DOWN IS NOT A QUIET SWEEP. Without `refs_stood_down` in this
  // condition, a ref-reap latch that never lifts — or ONE unreadable rebase state file —
  // silences the whole ref half of this loop forever and logs nothing at all,
  // indistinguishable from a repository with nothing to reap. Ordinary per-ref refusals
  // are deliberately NOT here: `owner-unknown` on a hand-made branch is the steady state
  // and would log every fifteen minutes for the life of the process.
  if (
    !report.skipped_no_liveness &&
    report.detached.length === 0 &&
    report.removed.length === 0 &&
    report.refs_deleted.length === 0 &&
    report.refs_candidates.length === 0 &&
    report.refs_stood_down === 0 &&
    report.refs_restored.length === 0 &&
    report.refs_restore_failed.length === 0
  ) {
    return
  }
  log.info('worktree_reaper_sweep', {
    repos_swept: report.repos_swept,
    candidates: report.candidates,
    live_skipped: report.live_skipped,
    detached: report.detached.length,
    removed: report.removed.length,
    preserved: report.preserved.length,
    protected_nonterminal: report.protected_nonterminal.length,
    skipped_no_liveness: report.skipped_no_liveness,
    refs_examined: report.refs_examined,
    refs_deleted: report.refs_deleted.length,
    refs_kept: report.refs_kept.length,
    refs_stood_down: report.refs_stood_down,
    refs_restored: report.refs_restored.length,
    refs_restore_failed: report.refs_restore_failed.length,
    refs_candidates: report.refs_candidates.length,
  })
}

/** Build the supervised timer; `immediate` provides the required startup sweep. */
export function buildWorktreeReaperLoop(
  opts: WorktreeReaperOptions & { interval_ms?: number },
): SupervisedLoop {
  const timerSeams = opts as WorktreeReaperOptions & TimerSeams
  return new SupervisedLoop({
    name: 'trident-worktree-reaper',
    intervalMs: opts.interval_ms ?? DEFAULT_REAP_INTERVAL_MS,
    immediate: true,
    tick: () => sweepTridentWorktrees(opts).then(logSummaryIfActed),
    ...(timerSeams.setTimer === undefined ? {} : { setTimer: timerSeams.setTimer }),
    ...(timerSeams.clearTimer === undefined ? {} : { clearTimer: timerSeams.clearTimer }),
  })
}
