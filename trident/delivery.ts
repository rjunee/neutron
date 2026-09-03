/**
 * @neutronai/trident — async result delivery.
 *
 * Closes gap-audit P0-1 ("Async result delivery back to chat is missing").
 * Trident builds correctly — the state machine advances forge-init → argus
 * → fix loop → merge → done (or → failed) — but on a terminal phase NOTHING
 * was posted back to the originating chat topic. The run row already carries
 * the originating `chat_id`/`thread_id` (`code-command.ts`, persisted at
 * dispatch), but the tick loop never used them: the user ran `/code`, saw
 * "🛠 Building…", then silence.
 *
 * This module is the Neutron port of the legacy harness's `/forge/delivered` +
 * `/argus/delivered` delivery callbacks: a per-terminal-state result post
 * back to the topic the build came from. It is wired into the tick loop's
 * `on_terminal` seam (`tick.ts`), so it fires the instant a run reaches ANY
 * terminal phase (done OR failed) — not only at the very end of a happy
 * path.
 *
 * GENERIC BY DESIGN. The mechanism is "a terminal run carrying a
 * chat_id/thread_id → compose a result → post to the bound channel." It is
 * keyed on the run's own persisted routing fields, NOT on `/code` — so any
 * background agent dispatched into a `code_trident_runs` row (overnight
 * dispatcher, a future typed-agent dispatch) delivers its result through the
 * exact same path. Runs with no originating chat (`chat_id === null`, e.g. a
 * cron-seeded run) simply no-op: there is nothing to deliver to.
 *
 * Layering: this module depends only on the run shape (`store.ts`) and the
 * channel-agnostic outbound TYPES (`channels/types.ts`, type-only import).
 * It talks to the channel layer through a minimal structural `OutboundSink`
 * (one `send` method) that the production `ChannelRouter` satisfies, so the
 * trident package never imports the channels runtime.
 *
 * L2 (2026-07) — `OutboundSink` (independently declared here AND in
 * `gateway/proactive/sink.ts`, byte-identical shape) unified onto
 * `./outbound-sink.ts`; this file re-exports it so existing import
 * specifiers stay valid.
 */

import type { InlineChoice, OutgoingMessage, Topic } from '@neutronai/channels/types.ts'
import { deriveInfraBlock } from './infra-block.ts'
import { isPublishedUnreviewedReason } from './fire-evidence.ts'
import {
  TRIDENT_SALVAGE_MARKER,
  TRIDENT_SNAPSHOT_FAILURE_MARKER,
  TRIDENT_STASH_PARKED_MARKER,
} from './orchestrator.ts'
import { CONFIGURED_CODE_CAVEAT } from './wrong-base-remedy.ts'
import { isTerminalPhase } from './state-machine.ts'
import type { TridentRun } from './store.ts'
import type { TridentTerminalHook } from './tick.ts'
import type { OutboundSink } from './outbound-sink.ts'
export type { OutboundSink }

/** The composed body + optional buttons for a terminal result post. */
export interface ComposedDelivery {
  text: string
  inline_choices?: InlineChoice[]
}

export interface BuildTridentDeliveryOptions {
  /** The outbound seam — production passes the instance `ChannelRouter`. */
  sink: OutboundSink
  /**
   * Fallback channel for runs whose row carries no `channel_kind` (defensive
   * — every row written since migration 0081 carries one, defaulting to
   * `'telegram'`). The per-run `run.channel_kind` is authoritative (#317);
   * this is only consulted if that is somehow absent.
   */
  channel_kind?: Topic['channel_kind']
  /**
   * Override the result-message composer (else `composeTerminalDelivery`).
   * Lets a caller restyle the copy without touching the routing/send path.
   */
  compose?: (run: TridentRun) => ComposedDelivery | null
}

/**
 * Truncate a task line for a one-line result header. Mirrors the `/code`
 * dispatch ack's 60-char clamp so the build's start + end messages match.
 */
function truncateTask(task: string, n = 60): string {
  const clean = task.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : `${clean.slice(0, n - 1)}…`
}

/**
 * The recognised terminal-failure classes (#352). A build's `failure_reason`
 * (authored by the merge/orchestrator layer) is classified into ONE of these so
 * the chat announce is INTERPRETED — plain language + the specific input the
 * operator must give — instead of a raw git/tool error paste.
 */
export type FailureClass =
  | 'merge-conflict'
  | 'stale-state'
  | 'merge-mechanics'
  | 'review-unresolved'
  | 'hang'
  | 'infra'
  /**
   * THE BUILD WAS DEFERRED, NOT REJECTED — a required check never ran, the PR is
   * conflicting with base, a credential blinked. No reviewer read the code. The ONLY
   * class derived from the STRUCTURED harvested result (`deriveInfraBlock`) rather than
   * from the `failure_reason` string, and the only one composed with 🚧 instead of ❌.
   */
  | 'infra-blocked'
  /**
   * THE WORK WAS BUILT AND PUSHED; ONLY THE REVIEW NEVER RAN. A launcher settle
   * timeout landed on a row that already carried an `outer-published:<sha>:0:<round>`
   * checkpoint (`fire-evidence.ts`), so the branch is on origin and the PR exists at
   * that sha. Recorded under phase `failed` because there is no other terminal phase
   * for "not merged", but it is NOT a failure and must not wear ❌ — the second class
   * (with `infra-blocked`) composed under its own glyph.
   *
   * WHERE THIS LIVES, AND WHY IT IS NOT `trident/run-disposition.ts` (Argus r8
   * minor). The card names that module as the state's home, on the strength of a
   * SIBLING card introducing it at the write site. That module does not exist on
   * this branch, and inventing an empty one to hold a single union member would
   * have made the two cards conflict over a file neither had landed. So the
   * state is spelled HERE, as one more `FailureClass` over the existing columns —
   * no new column, no backfill, no second NAME for "built and published, review
   * not run". When the sibling lands `run-disposition.ts`, fold this member into
   * it; this note is the cross-reference that says so.
   */
  | 'published-unreviewed'
  | 'underspecified'
  /**
   * THE BUILD NEVER STARTED — the wrong-base launch guard refused because the branch is
   * another lane's. Its own class because the ONE thing that must not be said about it is
   * "reply to retry": the refusal's whole content is that re-dispatching now lands on work
   * somebody else owns.
   */
  | 'branch-held'
  | 'unknown'

export interface FailureInterpretation {
  klass: FailureClass
  /** One plain-language sentence: what happened, in terms a non-engineer follows.
   *  NEVER contains raw git/tool stderr. */
  summary: string
  /** The SPECIFIC decision/input needed to move the build forward. */
  input_needed: string
}

/** True when the reason is one of OUR authored, plain-language escalation
 *  questions (from `merge.ts` / `conflict-resolver.ts`) rather than a git error
 *  message — those are already safe + specific, so we surface them verbatim. */
function isAuthoredConflictQuestion(reason: string): boolean {
  const r = reason.toLowerCase()
  return (
    r.includes("couldn't auto-resolve") ||
    r.includes('hit conflicts across') ||
    r.includes('needs a manual') ||
    r.includes('needs your call') ||
    (r.includes('conflict') && !r.includes('failed:'))
  )
}

/**
 * `composeWrongBaseRefusal`'s prefix, anchored — the launch guard's refusal and nothing that
 * merely quotes it. Returns the EVIDENCE SENTENCE that follows the prefix (which arm fired), or
 * null when this reason is not that refusal. `ahead_count` renders `?` when the count could not
 * be read (orchestrator.ts), hence the alternation.
 *
 * THE NAME FIELDS ARE `[^ \n]+`, NOT `\S+`, AND THE DIFFERENCE IS THE WHOLE CLASSIFIER (Argus
 * blocker). What git actually forbids in a ref name is the ASCII SPACE (and control characters,
 * `~^:?*[`, ...) — it does NOT forbid other Unicode whitespace: `git check-ref-format --branch
 * $'trident/x\xc2\xa0stalled'` exits 0 on this host's git. JavaScript's `\s` INCLUDES U+00A0,
 * so `\S` refused to match that legal branch name, the anchor failed, and the refusal fell
 * through to the retry-advice classifiers below — where a name containing `stalled` (or
 * `git `, `rebase`, `checkout`) was answered with "Reply to retry the build", the one advice
 * this class exists to forbid, restored by nothing more than somebody's choice of branch name.
 * A class excluding exactly the two characters git's own rules exclude keeps the property the
 * anchor rests on — the field cannot swallow the prose around it, because that prose starts
 * with a space — without inheriting a definition of whitespace git does not share.
 */
const WRONG_BASE_PREFIX =
  /^branch [^ \n]+ already carries (?:\d+|\?) commit\(s\) not on origin\/[^ \n]+ — it was not cut from origin\/[^ \n]+; refusing to build on another lane's work\. /

function wrongBaseGuardEvidence(reason: string): string | null {
  const m = WRONG_BASE_PREFIX.exec(reason)
  return m === null ? null : reason.slice(m[0].length)
}

/**
 * THE PRE-LAUNCH REFUSALS, whose defining property is that no build ran. Authored in exactly one
 * place — `orchestrator.ts`'s launch path, which prefixes every one of them `trident infra: ` and
 * ends each with the clause below — and read in exactly this one. Anchored at position 0 for the
 * reason `WRONG_BASE_PREFIX` is: these reasons interpolate a repo path and a fragment of git's
 * stderr, and an unanchored match over attacker-shaped text lets a quotation of one refusal
 * reclassify an unrelated failure.
 */
const PRE_LAUNCH_PREFIX = /^trident infra: /
const BUILD_NOT_STARTED = 'the build was NOT started'

/**
 * THE ONE PRE-LAUNCH REFUSAL WHOSE REMEDY IS NOT "RETRY" (Argus blocker). The ancestry guard's
 * depth arms refuse because `merge-base --is-ancestor` exited 1 in a history git cannot see past:
 * the checkout is SHALLOW, or its depth could not be read at all. Both are UNKNOWN, both refuse
 * correctly — and both are DETERMINISTIC in the shape the operator is left holding. Nothing on
 * the launch path deepens that checkout (`healShallowCheckout` runs only on the replay path), so
 * a retry re-runs the identical probe against the identical truncated history and re-refuses,
 * forever. Delivered as the generic `retry` line, the only step that breaks that loop — the one
 * the refusal's own evidence names — never reached the person told to act.
 *
 * MATCHED BY THE AUTHORED CLAUSE, not by the word "shallow". `orchestrator.ts`'s `probeDetail`
 * writes this sentence at its two depth arms and nowhere else; the word "shallow" alone appears
 * in git stderr, in branch names and in repo paths, all of which are interpolated into reasons on
 * this same path. The clause is also read ONLY INSIDE the anchored pre-launch arm below, so it
 * can never pull a post-launch failure out of the class it belongs to.
 *
 * A FALSE POSITIVE HERE IS SAFE BY CONSTRUCTION, which is why an `includes()` is enough: the
 * worst it can do is add one additive, reversible step (`git fetch --unshallow origin`, which
 * only downloads history) to a refusal that did not need it. No arm of this branch authorises an
 * irreversible act — invariant 121, the same rule the composer obeys.
 */
const DEPTH_PROBE_CLAUSE =
  'is a proven "not an ancestor" only in a COMPLETE history'
const SHALLOW_CONFIRMED = 'says this checkout is SHALLOW'

/**
 * The reassurance actually owed, and NOT ONE WORD MORE. This used to end "— the guard only READ
 * state", which contradicted the very next sentence on the fetching arm: a fetch WRITES (a
 * tracking ref, FETCH_HEAD, objects), so the pair asserted read-only and then described writes,
 * in the one message whose subject is not claiming things nobody established (Argus finding).
 * Whether the arm that fired only read is now said by `wrongBaseWrites`, which knows.
 *
 * AND "FILE" IS SCOPED TO THE TREE (Argus finding). Unqualified, this sentence said no file was
 * changed and the very next sentence on the fetching arm named FETCH_HEAD — a file — as one of
 * that arm's writes, so the pair contradicted itself again one clause further along. The
 * reassurance actually owed is about the WORKING TREE and the refs in it; git's own bookkeeping
 * under `.git/` is what the per-arm sentence exists to enumerate.
 *
 * AND IT IS ATTRIBUTED TO GIT (Argus blocker). Unattributed, this was an ABSOLUTE about the
 * whole path, and a `reference-transaction` hook falsifies it: the hook fires INSIDE the very
 * ref update the fetch below makes and may write anywhere, which a reviewer demonstrated on the
 * exact fetch form this path uses (exit 0, two files created in the working-tree root). A round
 * ago that threat was answered by scoping `LAUNCH_PATH_FETCH` alone — which left this sentence,
 * the one every arm OPENS with, still promising away something no sentence here can bound. What
 * is measured is what git itself writes; the hook is named once, in `HOOK_CAVEAT`, and covers
 * every write sentence in the message rather than one of them.
 */
const NO_DESTRUCTIVE_WRITE =
  'No branch, worktree, commit or file in the tree was changed or deleted by git itself on this path.'

/**
 * THE ONE THING NONE OF THE WRITE SENTENCES CAN BOUND, said once and covering all of them. Every
 * sentence above and below enumerates GIT's own writes; a repo may configure git to run arbitrary
 * local code inside those operations. Naming it here — after the enumeration, before the next
 * step — is what makes the enumeration's scope true, and it is the honest form of the absolute it
 * replaces: this message says what was measured, not what cannot be promised.
 *
 * AND THE CLASS IS "CONFIGURED CODE", NOT "HOOKS" (Argus blocker). This caveat named hooks alone,
 * which left the identical hole open through the remote and credential configuration: an `ext::`
 * remote helper is spawned BY the fetch, and a reviewer reproduced one writing into the WORKING
 * TREE during the exact fetch form these guards run. The wording, and that reproduction, now live
 * once in `CONFIGURED_CODE_CAVEAT` (`wrong-base-remedy.ts`), shared with the launch guard's own
 * `noWrites` so the two cannot drift apart again.
 */
const HOOK_CAVEAT = `All of that measures what GIT itself writes: ${CONFIGURED_CODE_CAVEAT}.`

/**
 * THE GUARD IS NOT THE ONLY THING THAT RAN ON THIS PATH (Argus blocker). The per-arm sentences
 * account for the WRONG-BASE GUARD's own writes, and on the held arms they say it "made no
 * network call at all" — true of the guard, and read by the owner as true of the refusal. It is
 * not: a fresh PR launch fetches origin's base ref in `orchestrator.ts` BEFORE the guard is ever
 * called, which moves origin's base pointer and rewrites git's own bookkeeping. So the scope is
 * stated, and that write is attributed to the step that made it.
 *
 * NOT ENUMERATED HERE, deliberately. This module reads a reason STRING and cannot know whether
 * the fetching arm ran (only a fresh PR build fetches), and enumerating a write that may not have
 * happened is the overcounting the per-arm conditional above exists to prevent. The launch path
 * counts its own writes at its own site, exactly (`noWrites` in `orchestrator.ts`).
 *
 * AND THE SENTENCE IS CONDITIONAL IN ITS OWN WORDS, because it is appended UNCONDITIONALLY
 * (Argus finding, raised as a blocker and weakened on verification). Only `wrongBaseWrites` is
 * arm-conditional; this clause rides along on the local-merge and already-pinned paths too,
 * where `orchestrator.ts`'s `freshBuild && merge_mode === 'pr'` gate means NO launcher fetch
 * ran. The old phrasing — "a fresh PR launch refreshes origin's base ref before this guard
 * runs" — was generic rather than false, but a reader on those paths reads it as a fetch that
 * happened. So it now says WHEN it applies and names the other case, which costs a clause and
 * removes the last reading in which this message reports a write nobody made. Conditioning the
 * concatenation instead would require this module to know which launch path ran, which is
 * exactly what the paragraph above says it cannot.
 *
 * THE ".git" IN IT IS THIS REPO'S OWN, and that is a property of the launcher's command, not of
 * fetch in general: `git fetch` recurses into submodules under `fetch.recurseSubmodules` and
 * then writes inside a submodule's git dir. `orchestrator.ts` passes `--no-recurse-submodules`
 * so this sentence is true; the two move together (Argus blocker).
 *
 * AND THE CLAIM IS SCOPED TO WHAT THE FETCH ITSELF DOES (Argus minor). "never the tree" and
 * "nothing outside .git" were absolutes about a fetch, and a fetch runs LOCAL CODE if this repo
 * configures it to: a `reference-transaction` hook fires inside the very ref update this
 * sentence describes and may write anywhere it likes, which a reviewer demonstrated on the
 * exact fetch form the launcher uses. A hook is arbitrary local code, so the honest fix is to
 * say what is measured — git's own writes — rather than to promise away something no sentence
 * here can bound. The reassurance actually owed is unchanged: nothing this path does on its own
 * touches the tree. THE CAVEAT ITSELF NOW LIVES IN `HOOK_CAVEAT`, once, because it was never
 * this sentence's alone to carry: it falsifies the opening reassurance and the failed-fetch
 * arm's absolute in exactly the same way (Argus blocker).
 */
const LAUNCH_PATH_FETCH =
  "That accounts for the guard itself. Separately, IF this refusal came from a fresh PR launch, the launcher refreshed origin's base ref before this guard ran; that write belongs to the launcher, is counted exactly where it happens, and moves only origin's base pointer and git's own bookkeeping under this repo's .git — git's own writes on that fetch touch nothing in the tree, and it recurses into no submodule. A launch that does not fetch — a local-merge build, or a re-entry whose base was already pinned — made no such write at all."

/**
 * THE COMPOSER'S ARM OPENINGS, named once because two things now read them: the write
 * attribution below and the next-step clause at the call site. They are
 * `composeWrongBaseRefusal`'s own sentences, in `wrong-base-remedy.ts`, and must move with it.
 */
const HELD_ARM = 'The wrong-base launch guard found the branch checked out in'
const HELD_ARM_MID_OPERATION = 'The wrong-base launch guard found no worktree with'
const UNHELD_ARM = 'The wrong-base launch guard found no worktree holding the branch'

/** Does the evidence say a worktree is standing on the branch? Held is not the same as UNKNOWN. */
function wrongBaseIsHeld(evidence: string): boolean {
  return evidence.startsWith(HELD_ARM) || evidence.startsWith(HELD_ARM_MID_OPERATION)
}

/**
 * THE NEXT STEP, PER ARM — because "re-dispatch once the branch is free" was appended to ALL of
 * them (Argus finding), and on the arms where NO worktree holds the branch it is the wrong
 * instruction twice over: the branch is already free, so the clause reads as "re-dispatch now",
 * and re-dispatching now is the ONE action this class must not suggest. Those arms' composed
 * remedy is a verified delete (published) or a salvage (unpublished) — a step that must happen
 * BEFORE any re-dispatch, and that a tail promising the branch is merely waiting on somebody
 * else quietly contradicts.
 *
 * THREE ANSWERS, NOT TWO, and the third is the point of the card: held, unheld, and "the holder
 * was never established". An UNKNOWN holder is not an unheld branch — telling its reader no
 * worktree holds this branch would assert exactly the fact the arm exists to say it could not
 * measure — so it gets its own tail, and that tail authorises nothing.
 */
function wrongBaseNextStep(evidence: string): string {
  const found = "The full evidence and the safe next step are in the run's failure reason"
  if (wrongBaseIsHeld(evidence)) {
    return `${found}; re-dispatch once the branch is free.`
  }
  if (evidence.startsWith(UNHELD_ARM)) {
    return `${found} — no worktree holds this branch, so nothing here becomes safe by waiting: take that step first, and re-dispatch only after it.`
  }
  return `${found}; the holder was never established, so do not re-dispatch until it is.`
}

/** What the guard actually wrote, per arm; see the call site for why this is not one sentence. */
function wrongBaseWrites(evidence: string): string {
  if (evidence.startsWith(HELD_ARM)) {
    return 'The guard itself only READ state: it made no network call at all, because the branch has a holder and that settles the question locally.'
  }
  // THE REBASE/BISECT-HOLDER ARM IS A HELD ARM WEARING THE UNHELD ARM'S OPENING (Argus finding).
  // Its sentence begins "found no worktree with <branch> CHECKED OUT, but worktree ... has a
  // REBASE in progress" — so a prefix test for "found no worktree" matched it and reported a
  // fetch, which that arm RETURNS BEFORE MAKING. That is the exact overcounting the paragraph
  // at the call site says this conditional exists to prevent. The fetching arms all open "found
  // no worktree HOLDING THE BRANCH", so the discriminator is that whole phrase, not its prefix.
  if (evidence.startsWith(HELD_ARM_MID_OPERATION)) {
    return 'The guard itself only READ state: it made no network call at all, because a worktree mid-rebase or mid-bisect is standing on the branch and that settles the question locally.'
  }
  // THE FAILED-FETCH ARMS WEAR THE FETCHING ARM'S OPENING TOO (Argus blocker). Three of the
  // composer's unheld arms are reached BECAUSE the fetch did not deliver a readable
  // origin/<branch> — "this repo has no reachable 'origin' remote", "could not read
  // origin/<b> (…)", and "origin has no <b> at all" (the fetch exited on `couldn't find remote
  // ref`, so it updated nothing) — yet all three open with the "found no worktree holding the branch" phrase
  // as the arm that fetched successfully, so the prefix test below credited them with a
  // refreshed tracking ref, a reflog append and downloaded objects that a fetch exiting 128
  // never made. Reproduced in a scratch repo: with no `origin` configured, `git fetch --no-tags
  // origin +refs/heads/<b>:refs/remotes/origin/<b>` exits 128 and `rev-parse --verify
  // refs/remotes/origin/<b>` still fails afterwards — the tracking ref was never written.
  // Asserting writes that did not happen is exactly the overcounting the paragraph at the call
  // site says this conditional exists to prevent, so these arms get their own attribution.
  //
  // ONE ARM, NOT THREE, and it says UNKNOWN rather than "nothing" (the honest answer for each).
  // The "could not read" arm also covers a fetch that SUCCEEDED and whose tracking ref then
  // failed to resolve, so "the fetch wrote nothing" would be a fresh false claim of the same
  // class; the no-origin arm cannot establish where inside git's own bookkeeping the failed
  // attempt stopped either. What IS established is the CEILING, and it is the same one: the
  // only write this guard can make is a fetch of this one ref, and everything such a fetch can
  // touch lives under .git.
  if (
    evidence.startsWith(`${UNHELD_ARM}, but this repo has no reachable 'origin' remote`) ||
    evidence.startsWith(`${UNHELD_ARM}, but could not read origin/`) ||
    evidence.startsWith(`${UNHELD_ARM}, and origin has no `)
  ) {
    return "The guard's only possible write is a fetch of this branch's own ref, to establish whether the commits are published; that fetch did not yield a readable origin ref and may have failed before writing anything, so whether it refreshed the origin tracking ref (and that ref's reflog), FETCH_HEAD, or any objects is itself UNKNOWN. Whatever it did write lives under .git, and the guard makes no other write either way."
  }
  if (evidence.startsWith(UNHELD_ARM)) {
    // THE REFLOG IS ONE OF THE WRITES (Argus finding). `git fetch --no-tags origin
    // +refs/heads/<b>:refs/remotes/origin/<b>` also APPENDS to
    // `.git/logs/refs/remotes/origin/<b>` (reproduced in a scratch repo), so "the tracking
    // ref, FETCH_HEAD and the objects, and nothing else" was an undercount — the exact defect
    // the comment at the call site says this sentence exists to avoid. Naming it costs three
    // words and keeps the enumeration true.
    //
    // AND THE LIST IS BOUNDED BY WHAT IT NAMES, NOT BY "NOTHING ELSE" (Argus finding). A fetch
    // also runs whatever bookkeeping its own configuration asks for — `fetch.writeCommitGraph`
    // writes `.git/objects/info/commit-graphs/*`, `gc.auto` can fire maintenance — so a closed
    // "and nothing else" was falsifiable by a config this guard does not read. What is actually
    // established is the CLASS: everything a fetch of one ref can touch lives under `.git`, and
    // none of it is a branch, a worktree, a commit or a file in the tree.
    //
    // AND THE REF UPDATE IS CONDITIONAL, WHICH THE REFLOG CLAUSE ABOVE MADE UNCONDITIONAL (Argus
    // finding). A fetch whose tracking ref is ALREADY at origin's tip performs no ref
    // transaction at all: repeating the identical fetch against an unchanged remote leaves
    // `git reflog show refs/remotes/origin/<b>` at one line — no update, no append. So a
    // sentence that GUARANTEES a refresh and a reflog append asserts, in the no-op case, writes
    // that did not happen: the same overcounting the failed-fetch arm above exists to prevent,
    // one arm along. FETCH_HEAD is the one write that IS unconditional (this fetch does not
    // pass `--no-write-fetch-head`), so the conditional is spelled per item rather than over
    // the whole list.
    return "Its one write is a fetch of this branch's own ref, to establish whether the commits are published: that refreshes the origin tracking ref (appending to that ref's reflog) if origin has moved it, rewrites FETCH_HEAD, and writes any objects it downloads, plus whatever bookkeeping that fetch's own configuration adds under .git (fetch.writeCommitGraph writes a commit-graph, for one) — a fetch that finds the tracking ref already at origin's tip updates no ref and appends nothing to that reflog, and git's own writes on that fetch go nowhere outside .git."
  }
  // THE THROW ARM CAN FIRE ON EITHER SIDE OF THE FETCH (Argus finding). The composer's outer
  // catch wraps its WHOLE body — enumeration, fetch, and the composition after it — so a throw
  // from a post-fetch step landed on the fall-through below and told the reader the guard
  // "refused before it could establish the holder", asserting a fetch did NOT happen when it
  // may well have. Which side it threw on is precisely what is not established, so say that
  // rather than pick one; the bound that IS established is that a fetch of this branch's own
  // ref is the only write the guard can make at all.
  if (
    evidence.startsWith(
      "The wrong-base launch guard could not resolve the branch's holder or its publication because remedy resolution threw",
    )
  ) {
    return "The guard's only possible write is a fetch of this branch's own ref; resolution threw, and it can throw on either side of that fetch, so whether that one fetch was made is itself UNKNOWN, and the guard makes no other write either way."
  }
  // The remaining arms refuse BEFORE the holder is established, which is upstream of the fetch.
  return 'The guard itself only READ state: it refused before it could establish the holder, which is upstream of the one write it can make — a fetch of this branch\'s own ref.'
}

/**
 * #361 (same class as #175) — detect a "tools not enabled in this context"
 * failure: a build/resolver CC subprocess launched WITHOUT the file/shell tools
 * it needed (an empty `--tools` grant), so it reported it could not open/edit/run
 * anything. This is a PURELY INTERNAL misconfiguration — never the operator's
 * concern — so it is classified as `infra` (clearly-internal, retry) and the raw
 * "re-run with file/shell tools enabled" / "I don't have access to a bash tool"
 * stderr is NEVER surfaced to the user.
 */
function isToolsNotEnabled(reasonLower: string): boolean {
  return (
    reasonLower.includes('tools not enabled') ||
    reasonLower.includes('tool is not enabled') ||
    reasonLower.includes('not enabled in this context') ||
    reasonLower.includes('file/shell tools') ||
    reasonLower.includes('re-run with') ||
    reasonLower.includes('access to a bash') ||
    reasonLower.includes('only have reply and send_typing')
  )
}

/** Salvage metadata is machine-authored and can be much longer than the
 * operator-authored cause. Classify only the cause; the recovery pointer is
 * rendered separately by `composeTerminalDelivery`. */
function authoredFailureReason(reason: string): string {
  const salvageMarker = TRIDENT_SALVAGE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const captureFailureMarker = TRIDENT_SNAPSHOT_FAILURE_MARKER.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  )
  const annotation = reason.match(
    new RegExp(
      `(?:\\s+—\\s+(?:0 commits\\b|\\d+ commit\\(s\\),\\s+${salvageMarker}\\b|${salvageMarker}\\b|\\d+ uncommitted\\b)|;\\s+plus\\s+(?:\\d+ uncommitted\\b|\\d+ stash\\b|${captureFailureMarker}\\b))`,
    ),
  )
  return (annotation === null ? reason : reason.slice(0, annotation.index)).trim()
}

function salvageRecoveryTrail(run: TridentRun): string {
  const reason = run.failure_reason ?? ''
  const trails: string[] = []
  const snapshotRef = reason.match(/refs\/tags\/trident-salvage\/[^\s;—]+/)?.[0]
  if (snapshotRef !== undefined) trails.push(`Recovery snapshot: ${snapshotRef}.`)
  if (reason.includes(TRIDENT_STASH_PARKED_MARKER)) {
    trails.push("Recovery note: work was detected in this run's stash window.")
  }
  const captureFailure = reason.match(
    new RegExp(
      `${TRIDENT_SNAPSHOT_FAILURE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.*?)(?:\\s+—\\s+\\d+ commit\\(s\\),|$)`,
    ),
  )?.[1]
  if (captureFailure !== undefined) {
    trails.push(`Recovery warning: ${captureFailure.replace(/\.+$/, '')}.`)
  }
  const captureWarning = reason.match(
    /capture warning:\s*(.*?)(?:\s+—\s+\d+ commit\(s\),|$)/,
  )?.[1]
  if (captureWarning !== undefined) {
    trails.push(`Recovery warning: ${captureWarning.replace(/\.+$/, '')}.`)
  }
  return trails.length === 0 ? '' : `\n${trails.join('\n')}`
}

/**
 * #352 — INTERPRET a terminal failure into a plain-language summary + the specific
 * input needed, NEVER a raw error paste. Pure + deterministic (a bounded classifier
 * over the authored `failure_reason` — no LLM, so it is reliable + unit-testable):
 * every recoverable class (stale merge/rebase state, transient infra) is already
 * auto-recovered upstream in the merge path (`recoverStaleGitState`) or the #342
 * Forge conflict-resolver, so a run that reaches HERE is genuinely unrecoverable and
 * needs a human. Raw git stderr (a `TridentMergeError`-wrapped `merge failed: git …`
 * message) is DISCARDED — the operator sees only what happened + what to do.
 *
 * ONE CLASS IS NOT READ FROM THE REASON STRING. `'infra-blocked'` is derived from the
 * STRUCTURED harvested result (`deriveInfraBlock` → the workflow's own
 * `blockKind: 'infra-only'`), because a keyword classifier cannot safely be handed the
 * MEASURED cause: that text is model/CI prose. Measured on this repo — a cause reading
 * "PR is conflicting with base" hits `isAuthoredConflictQuestion`'s bare `conflict` token
 * and produces the FALSE sentence "two changes edited the same code in ways I could not
 * reconcile automatically", about a build whose code nobody read. So the structured check
 * runs FIRST, ahead of every string branch including `isToolsNotEnabled`: a fact beats a
 * keyword, and a deferral must never be told as a rejection.
 */
export function interpretFailure(run: TridentRun): FailureInterpretation {
  const reason = authoredFailureReason((run.failure_reason ?? '').trim())
  const r = reason.toLowerCase()
  const retry = 'Reply to retry the build, or take it from here manually.'
  const saved = 'Your progress is saved.'

  // THE MACHINE WAS BROKEN, NOT THE CODE. Checked FIRST — see the docblock: this is the
  // one MEASURED class, and the measured cause is prose that a keyword branch below
  // would misroute (a "conflicting with base" cause → the merge-conflict class).
  const infra = deriveInfraBlock(run)
  if (infra !== null) {
    const cause = infra.cause
    const notRejected = 'Nothing about the code was rejected — it was never reviewed.'
    // A small BOUNDED mapping over the measured cause — deterministic and unit-testable
    // like the rest of this function, and it only ever changes the ADVICE, never the
    // class. An unrecognised cause gets the honest generic retry line.
    const c = (cause ?? '').toLowerCase()
    const input_needed = c.includes('conflicting with base')
      ? `Rebase or merge the base branch into the PR branch, then retry. ${notRejected}`
      : /required check .* has not run/.test(c)
        ? `Trigger the required check (or re-run CI on the PR), then retry. ${notRejected}`
        : `Retry the build once the infrastructure is healthy. ${notRejected} ${saved}`
    return {
      klass: 'infra-blocked',
      summary:
        cause !== null
          ? `The build was blocked by infrastructure before any reviewer judged the code: ${cause}.`
          : 'The build was blocked by infrastructure before any reviewer judged the code.',
      input_needed,
    }
  }

  // THE LAUNCH GUARD REFUSED — no build ran, nothing was merged, and the reason already
  // carries the resolved evidence and remedy. Retrying is the ONE action this class must not
  // suggest: the guard refused precisely because re-dispatching now would build on another
  // lane's branch, so the delivery would contradict the refusal it is delivering.
  //
  // CHECKED FIRST OF THE STRING BRANCHES, and that placement is load-bearing. This reason
  // EMBEDS a BRANCH NAME, a worktree path and a quoted lock reason — attacker-shaped data by
  // the same standard the composing module already applies to them. `git check-ref-format
  // --branch stalled` exits 0, so a branch legally named `stalled` (or one containing
  // `exhausted`, `rebase`, `checkout`, `unmerged`, `missing`) fell through to the hang, review
  // or merge-mechanics arms below and was answered with "Reply to retry the build" — the exact
  // advice this class forbids, restored by nothing more than someone's choice of branch name.
  // A LOCK REASON is quoted into the message verbatim and may contain SPACES, so the
  // multi-word tokens below are forgeable too — and so was THIS one. An unanchored
  // `includes()` over the whole reason matches the phrase WHEREVER it appears, and
  // `orchestrator.ts` interpolates raw workflow error text into failure reasons: an error that
  // merely QUOTES a previous refusal (or a lock reason that contains the sentence) was
  // classified as a launch refusal, and a real launch failure lost its retry advice. So the
  // reason is matched against the composer's WHOLE PREFIX, anchored at position 0 — a shape no
  // interpolated field can produce, because a branch name cannot contain a space and every
  // attacker-shaped field in that prefix (branch, base, count) is space-free. THE TWO HALVES
  // MUST STILL MOVE TOGETHER: this pattern is `composeWrongBaseRefusal`'s prefix, in
  // `wrong-base-remedy.ts`, and nothing else.
  const wrongBaseRest = wrongBaseGuardEvidence(reason)
  if (wrongBaseRest !== null) {
    return {
      klass: 'branch-held',
      // NOT "another lane's commits": the composer deliberately retracted that attribution
      // (wrong-base-remedy.ts, ALIVE arm — the args carry the refusing run's id but not its own
      // worktree path, and the card's second measured instance was held by the SAME card's
      // relocked tree), and a summary that re-asserts what the evidence beneath it withdrew is
      // the two layers disagreeing about what was established. What IS established is the
      // refusal's own premise: the branch was not cut from the base and carries commits the
      // guard did not put there. The composer's PREFIX is untouched — it is the classifier
      // token above, and the two must move together.
      summary:
        'I did not start this build: the branch it would use already carries commits that were not cut from the base, so it is not this run\'s to build on.',
      // The write is named EXACTLY, because "the single write" was not: the fetch that
      // establishes publication (`+refs/heads/<b>:refs/remotes/origin/<b>`) force-updates that
      // tracking ref AND appends that ref's reflog AND rewrites FETCH_HEAD AND writes whatever
      // objects it downloads (all verified on a scratch repo: FETCH_HEAD recreated and
      // `.git/logs/refs/remotes/origin/<b>` appended by that exact command). None of them is a
      // branch, a worktree, a commit or a file in the tree — which is the reassurance actually
      // owed — but a delivery that undercounts its own writes is the overclaiming this refusal
      // exists to stop.
      //
      // AND IT IS CONDITIONAL ON THE ARM THAT FIRED, because OVERcounting is the same defect in
      // the other direction. The held arms make no network call at all (the composer says so:
      // "HELD: no network call in this arm"), so telling their reader a fetch happened reports a
      // write that did not — in the one message whose subject is not claiming things nobody
      // established. Which arm fired is read from the evidence sentence the composer puts
      // immediately after its prefix, so a quoted lock reason further along cannot forge it.
      input_needed: `${NO_DESTRUCTIVE_WRITE} ${wrongBaseWrites(wrongBaseRest)} ${LAUNCH_PATH_FETCH} ${HOOK_CAVEAT} ${wrongBaseNextStep(wrongBaseRest)}`,
    }
  }

  // THE PRE-LAUNCH CHECKS REFUSED, AND NO BUILD EVER RAN. Sibling of the branch above and
  // checked in the same place, for the same reason: these reasons QUOTE git — the probe's exit
  // code, its stderr, the repo path — and every keyword branch below is a bare `includes()`
  // over that quotation. `git merge-base --is-ancestor exited 128` contains `git `, so the
  // ancestry-UNKNOWN refusal landed on the merge-mechanics arm and was delivered as "The build
  // finished but a git step failed while landing the branch" — a completed build and a merge
  // attempt, both asserted about a run whose own reason says, in words, that the build was NOT
  // started (Argus blocker). The watchdog-kill variant carries no `git ` token at all and fell
  // through to the bare `unknown` fallback, which is the same defect wearing a vaguer sentence.
  //
  // MATCHED BY AN ANCHORED PREFIX PLUS THE NOT-STARTED CLAUSE, not by a keyword. `^trident
  // infra: ` is a shape no interpolated field can produce — it is authored at position 0 by
  // `orchestrator.ts` and nowhere else — so a lock reason, a branch name or a fragment of git
  // stderr that merely QUOTES a previous refusal cannot route a real, post-launch failure here
  // and strip it of the retry advice it is owed. Both halves must move together: the clause is
  // authored verbatim at every one of these sites in `orchestrator.ts`.
  if (PRE_LAUNCH_PREFIX.test(reason) && reason.includes(BUILD_NOT_STARTED)) {
    // ONE SUB-SHAPE CARRIES ITS OWN STEP OUT (see `DEPTH_PROBE_CLAUSE`). The depth arms of the
    // ancestry guard refuse on a history git cannot see past, and nothing on this path deepens
    // it, so the bare retry line is advice that is KNOWN in advance to reproduce the refusal. The
    // step is named here, in the delivered text, because the delivered text is all the operator
    // sees — the persisted reason that carries the same evidence is never rendered.
    if (reason.includes(DEPTH_PROBE_CLAUSE)) {
      const depth = reason.includes(SHALLOW_CONFIRMED)
        ? 'this checkout is shallow, so the commits the check needs are simply absent from it'
        : 'the depth of this checkout could not be read, so the check cannot tell an unrelated branch from one whose parents are merely missing'
      return {
        klass: 'infra',
        summary: `I did not start this build: the check that compares the branch against its base could not reach a verdict — ${depth}. No build ran and nothing was merged.`,
        // Retry is still the destination, but it is second: retrying FIRST re-runs the same probe
        // over the same truncated history and lands on this same refusal.
        input_needed:
          'Complete the history in the build checkout first — `git fetch --unshallow origin` (already-complete checkouts are unaffected) — then reply to retry. Retrying without that step re-runs the same check against the same truncated history and stops here again.',
      }
    }
    return {
      klass: 'infra',
      // Says the one thing the misclassification denied: nothing ran, so nothing landed.
      summary:
        'I did not start this build: a check that runs before the build could not complete, so no build ran and nothing was merged.',
      // Retry IS the right advice here, unlike the refusal above — these are probe failures, not
      // a claim that another lane owns the branch, and the reason itself records that no branch,
      // worktree, commit or file was touched.
      input_needed: retry,
    }
  }

  // #361 — a toolless CC subprocess (empty `--tools` grant) is a PURELY INTERNAL
  // misconfiguration; classify it clearly-internal and NEVER leak the raw
  // "re-run with file/shell tools enabled" stderr. Checked FIRST so a stray
  // "conflict"/"git" token in the raw message can't misroute it to a user-facing
  // class.
  if (isToolsNotEnabled(r)) {
    return {
      klass: 'infra',
      summary: 'The build hit an internal configuration error and could not finish.',
      input_needed: retry,
    }
  }

  // THE WORK WAS BUILT AND PUSHED — ONLY THE REVIEW NEVER RAN. The launcher's
  // settle timeout fired over a row that already carried an `outer-published:…`
  // checkpoint (`fire-evidence.ts`), so the branch is on origin and the PR exists
  // at that sha. CHECKED EARLY and by the marker `publishedFailureReason` authors,
  // because the generic tail would otherwise offer `retry` — inviting exactly the
  // rebuild the rest of this seam exists to prevent, one line under a summary that
  // says the work is already done. THE TWO HALVES MUST MOVE TOGETHER: the
  // predicate is exported from `fire-evidence.ts` and imported here rather than
  // retyped — and it ANCHORS on the head `publishedFailureReason` writes rather
  // than looking for the marker anywhere in the string, so substrate text that
  // merely QUOTES the token (this repo builds itself, and the crash-recovery
  // reason below embeds substrate output verbatim) cannot claim a failed build
  // was published.
  if (isPublishedUnreviewedReason(r)) {
    return {
      klass: 'published-unreviewed',
      summary:
        'This build finished and pushed its work — the review round never ran, so I did not merge it.',
      input_needed:
        'Check the PR at its pushed commit and send it for review. Do not rebuild it: the work is already published.',
    }
  }

  // THE SUPERVISOR DIED REPEATEDLY AND THE RECOVERY BUDGET RAN OUT.
  // Checked EARLY and by its own token, because this reason deliberately EMBEDS the
  // latched launcher-crash text — whatever the substrate said — and that text is not
  // ours to keyword-proof. Left further down it would be captured by the branches
  // below on a stray 'stalled'/'exhausted'/'git ' token and reported as a review or a
  // hang outcome, which is the #240 failure shape: a confident sentence about a cause
  // nobody measured. `infra` is the honest class — nothing about the BUILD failed.
  if (r.includes('crash-recovery budget')) {
    return {
      klass: 'infra',
      summary:
        'The build supervisor died repeatedly, and I stopped relaunching after ' +
        'the recovery budget ran out. The work so far is saved on its branch.',
      input_needed: `${saved} ${retry}`,
    }
  }

  // T4 — AN INFRASTRUCTURE DEATH IS NOT A VERDICT (run `f384460d`, 2026-08-15).
  // The inner workflow THREW; its catch path writes `checkpoint:'inner-error'` with no
  // findings, and the owner was told "REQUEST_CHANGES" for work no reviewer ever judged.
  // Same for an `infra-only` block: no review seat ran.
  //
  // THE MATCHED STRINGS ARE AUTHORED IN EXACTLY TWO PLACES — `infraDeathSentence`
  // (below, this file) and `innerTerminalFailureReason` (`orchestrator.ts`), which also
  // composes the two measured-cause sentences. THE TWO HALVES MUST MOVE TOGETHER: a
  // reworded reason that stops matching here silently restores review-flavoured crash copy.
  //
  // CHECKED EARLY, and that placement is load-bearing. Two reasons EMBED the probe's or
  // lane's measured words, so causes containing 'stalled', 'exhausted', or 'git ' would
  // otherwise be misrouted as hang, review, or merge mechanics. `inner workflow failed at
  // round` is main's 2026-08-15 thrown-with-cause sentence, which the old branch predates.
  if (
    r.includes('build infrastructure failed') ||
    r.includes('review never ran (infra-only)') ||
    r.includes('inner workflow failed at round')
  ) {
    return {
      klass: 'infra',
      summary:
        'The build hit an internal error and stopped without a review verdict — this is not a rejection of the work.',
      input_needed: `${saved} ${retry}`,
    }
  }

  // Suspected agent hang / stalled inner workflow — already a plain reason.
  if (r.includes('suspected agent hang') || r.includes('no progress for') || r.includes('stalled')) {
    return {
      klass: 'hang',
      summary: 'The build stopped making progress and I stopped it before it could hang indefinitely.',
      input_needed: `${retry} ${saved}`,
    }
  }

  // ENDED WITHOUT AN APPROVED REVIEW, CAUSE UNKNOWN — checked BEFORE the review branch
  // below, which shares the "without argus approve" token and would otherwise swallow it.
  //
  // WHY THE ORDER MATTERS. The review summary below says the reviewer "had blocking
  // findings". For a run that stopped at round 1 with no reviewer having run, that is FALSE
  // — and confidently so: it sends the reader to look at review quality when the build never
  // started. That happened three times on 2026-08-13 (an unresolved CODEX_HOME, a truncated
  // build brief, an unauthenticated push).
  //
  // WHY THIS SUMMARY CLAIMS SO LITTLE. Codex review round 2 killed a stronger one. It read
  // "the build stopped before the review could finish… a problem with the build pipeline",
  // which is false for the below-ceiling exits that DID review: a round-2 lost fix has round
  // 1's blocking findings behind it. This branch covers exits whose causes genuinely differ
  // (early crash, lost fix, no-diff fix, infra-only synthesis stop) and the workflow emits no
  // terminal cause to tell them apart, so the ONE thing true of all of them is all it says.
  // `klass: 'unknown'` is the honest class — not a hedge, a measurement of what we know.
  //
  // THE TWO HALVES MUST MOVE TOGETHER — a reason that stops matching this string silently
  // reverts the operator to the old, wrong story.
  if (r.includes('inner workflow ended at round')) {
    return {
      klass: 'unknown',
      summary: 'The build ended without an approved review, so I did not merge it.',
      input_needed: `${saved} ${retry}`,
    }
  }

  // Argus still had blocking findings after the round budget — a review outcome.
  if (r.includes('without argus approve') || r.includes('request_changes') || r.includes('exhausted')) {
    return {
      klass: 'review-unresolved',
      summary: `The build ran its review rounds but the reviewer still had blocking findings, so I did not merge it.`,
      input_needed: `${saved} Reply to send it back for another fix pass, or take it over.`,
    }
  }

  // An AMBIGUOUS content conflict the resolver escalated — the reason IS the
  // authored, specific question. Surface it (plain by construction, no stderr).
  if (isAuthoredConflictQuestion(reason) && !r.startsWith('merge failed')) {
    return {
      klass: 'merge-conflict',
      summary:
        'The build finished, but two changes edited the same code in ways I could not reconcile automatically.',
      input_needed: reason,
    }
  }

  // A stale shared-checkout index surfaced DIRECTLY (a bare git error, not wrapped
  // in a `merge failed:` TridentMergeError — those are the mechanics class below).
  // Should be self-healed now, but classified for completeness — never surface the
  // raw "resolve your current index first".
  if (
    !r.startsWith('merge failed') &&
    (r.includes('resolve your current index') || r.includes('merge_head') || r.includes('unmerged'))
  ) {
    return {
      klass: 'stale-state',
      summary:
        'The build finished but the shared checkout was left mid-merge by an earlier build, which blocked this merge.',
      input_needed: `${retry} (I clean this up automatically now, so a retry should go through.)`,
    }
  }

  // Any other git-mechanics failure landing the branch — DISCARD the raw stderr.
  if (r.startsWith('merge failed') || r.includes('git ') || r.includes('rebase') || r.includes('checkout')) {
    return {
      klass: 'merge-mechanics',
      summary: 'The build finished but a git step failed while landing the branch, so it was not merged.',
      input_needed: `${saved} ${retry}`,
    }
  }

  // The task itself was too vague to act on.
  if (r.includes('underspecified') || r.includes('specified enough')) {
    return {
      klass: 'underspecified',
      summary: 'I could not start this build because the task was not specific enough to act on.',
      input_needed: reason.length > 0 ? reason : 'Add a short description or a design doc and dispatch it again.',
    }
  }

  // Couldn't start / internal / garbled result — an infrastructure failure.
  if (
    r.includes('fire failed') ||
    r.includes('could not prepare') ||
    r.includes('backend') ||
    r.includes('garbled') ||
    r.includes('missing') ||
    r.includes('provenance')
  ) {
    return {
      klass: 'infra',
      summary: 'The build hit an internal error and could not finish.',
      input_needed: retry,
    }
  }

  // Fallback — a reason we don't specifically classify. Keep it plain: show the
  // authored reason if it's short + question-like, else a generic line. Still
  // never a multi-line raw paste.
  const oneLine = reason.replace(/\s+/g, ' ').trim()
  const safe = oneLine.length > 0 && oneLine.length <= 200 && !oneLine.includes('failed:')
  return {
    klass: 'unknown',
    summary: safe && oneLine.length > 0 ? oneLine : 'The build did not complete.',
    input_needed: `${saved} ${retry}`,
  }
}

/**
 * T4's one infra-death sentence now lives in `infra-block.ts`, and is re-exported
 * here so this module's existing importers keep working unchanged.
 *
 * WHY IT MOVED. It is WRITTEN by the orchestrator and READ BACK by
 * `interpretFailure` in this file, so both ends need it — and `delivery.ts`
 * already imports `orchestrator.ts`. Declaring it here made the orchestrator
 * import back, which is a real `delivery → orchestrator → delivery` cycle. CI's
 * `no-cycles` rule caught it the moment this branch was brought up to a main
 * that already carried the first edge; on the branch's own stale base neither
 * PR could see it. A symbol both ends of an edge need belongs at neither end,
 * so it sits in the infra-classification leaf, which imports neither of them.
 */
export { infraDeathSentence } from './infra-block.ts'

/**
 * The human-readable name for the work — the `work_board_items.title` the run
 * was dispatched from (the board build-tool persists the item's linked design
 * doc, else its title, verbatim as `run.task`). Every result message LEADS with
 * this (#361 humanize) so the operator sees the WORK in plain words, not the
 * machine `slug`. Cleaned + clamped to a one-line header.
 */
function workTitle(run: TridentRun): string {
  return truncateTask(run.task, 80)
}

/**
 * Compose the result message for a terminal run. Pure — no I/O — so the
 * exact copy per terminal state is unit-testable in isolation. Returns
 * `null` for a NON-terminal run (defensive: the loop only ever hands this
 * terminal rows).
 *
 * Trident merges autonomously on Argus APPROVE, so `done` means "already
 * merged + deployed" — the message reports the landed result rather than
 * offering a merge button (the human-in-the-loop merge is the legacy harness's
 * Forge-delivery model; trident is the autonomous loop).
 *
 * #361 HUMANIZE — the copy names the work by its TITLE (not the raw run slug),
 * says "merged and deployed" plainly, and drops branch/round jargon. A PR-mode
 * run still carries its PR number (an openable artifact, not jargon).
 */
export function composeTerminalDelivery(run: TridentRun): ComposedDelivery | null {
  if (!isTerminalPhase(run.phase)) return null
  const title = workTitle(run)

  switch (run.phase) {
    case 'done': {
      // pr === 0 is the no-PR sentinel — never render "PR #0" (card 01M01HGAWHA1KBK7CXXHC4R6RH; fixed here first, do not re-fix there).
      const prRef = run.merge_mode === 'pr' && run.pr !== null && run.pr > 0 ? ` (PR #${run.pr})` : ''
      return { text: `✅ ${title} — merged and deployed.${prRef}` }
    }
    case 'failed': {
      // #352 — INTERPRET the failure into plain language + the specific input
      // needed, never a raw git/tool error paste. The recoverable classes were
      // already auto-recovered upstream (stale merge state, the #342 conflict
      // resolver), so a run reaching here is genuinely unrecoverable.
      const interp = interpretFailure(run)
      const recoveryTrail = salvageRecoveryTrail(run)
      const prTrail =
        run.merge_mode === 'pr' && run.pr !== null && run.pr > 0
          ? `\nPR #${run.pr} left open for review.`
          : ''
      const trail = `${recoveryTrail}${prTrail}`
      // A DEFERRAL IS NOT A REJECTION. An infra-only block never reached a reviewer, so
      // it must not wear ❌ + rejection language: it leads with 🚧 and says "deferred".
      // Every other class keeps the ❌ line byte-identical.
      if (interp.klass === 'infra-blocked') {
        return {
          text: `🚧 ${title} — build deferred (infrastructure), not rejected.\n${interp.summary}\n${interp.input_needed}${trail}`,
        }
      }
      // A FINISHED, PUSHED BUILD IS NOT A FAILURE EITHER. The words already said
      // "this build finished and pushed its work"; leading them with ❌ told the
      // owner the opposite of the sentence underneath. Same carve-out shape as
      // `infra-blocked` above — every other class keeps the ❌ line byte-identical.
      if (interp.klass === 'published-unreviewed') {
        return {
          text: `📦 ${title} — built and pushed; the review never ran, so it is not merged.\n${interp.summary}\n${interp.input_needed}${trail}`,
        }
      }
      return { text: `❌ ${title} — ${interp.summary}\n${interp.input_needed}${trail}` }
    }
    case 'stopped':
      // `/code stop` flips a row straight to `stopped` via the store (not
      // the tick loop) and replies to the user synchronously, so the loop's
      // on_terminal hook never sees a stopped row in practice. Composed
      // anyway for completeness / direct callers.
      return { text: `🛑 ${title} — build stopped.` }
    default:
      return null
  }
}

/**
 * Build the run's originating chat topic from its persisted routing
 * fields. Returns `null` when `chat_id` is absent (a run with no
 * originating chat — e.g. cron-seeded — has nothing to deliver to).
 *
 * `channel_topic_id` is the `<chat_id>[:<thread_id>]` shape the Telegram
 * webhook decoder emits (`channels/adapters/telegram/webhook-server.ts`
 * `renderTopicId`) and the adapter's `send` parses back into
 * `chat_id` + `message_thread_id`. The other `Topic` fields are not read
 * by the outbound send path, so they carry safe placeholders.
 */
export function topicForRun(
  run: TridentRun,
  channel_kind: Topic['channel_kind'],
): Topic | null {
  if (run.chat_id === null || run.chat_id.length === 0) return null
  const channel_topic_id =
    run.thread_id !== null && run.thread_id.length > 0
      ? `${run.chat_id}:${run.thread_id}`
      : run.chat_id
  return {
    topic_id: channel_topic_id,
    channel_kind,
    channel_topic_id,
    project_id: null,
    privacy_mode: 'regular',
  }
}

/**
 * Build the `TridentTerminalHook` the tick loop fires on every terminal
 * transition. Composes the result message and posts it to the run's
 * originating topic through the outbound sink. No-ops (returns without
 * sending) when the run has no originating chat or the composer declines.
 *
 * Errors propagate to the loop's `on_terminal` try/catch, which logs them
 * and continues — the terminal row is already committed.
 */
export function buildTridentDelivery(
  opts: BuildTridentDeliveryOptions,
): TridentTerminalHook {
  const fallback_channel_kind = opts.channel_kind ?? 'telegram'
  const compose = opts.compose ?? composeTerminalDelivery
  return {
    async onTerminal(run: TridentRun): Promise<void> {
      // Derive the delivery channel from the RUN (#317) so a `/code` build
      // originating on the app-WebSocket surface posts its result back there
      // instead of misrouting to Telegram. Falls back to the build-time
      // default only for a row missing the field (pre-0081 / defensive).
      const channel_kind = run.channel_kind ?? fallback_channel_kind
      const topic = topicForRun(run, channel_kind)
      if (topic === null) return
      const composed = compose(run)
      if (composed === null) return
      const message: OutgoingMessage = { topic, text: composed.text }
      if (composed.inline_choices !== undefined && composed.inline_choices.length > 0) {
        message.inline_choices = composed.inline_choices
      }
      await opts.sink.send(message)
    },
  }
}
