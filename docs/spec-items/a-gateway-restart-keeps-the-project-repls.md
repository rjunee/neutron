---
title: A gateway restart keeps the project REPLs, conversation and all
group: platform
status: open
priority: P0
cutover: true
legacy_ref: "GitHub issue #539 (herdr step 2c)"
---

> **WHY THIS ITEM IS `status: open` WITH EVERY BOX UNCHECKED WHILE THE AS-BUILT RECORD
> SPEAKS IN THE PAST TENSE.** The two are not in conflict and the gap is deliberate. Each
> criterion below is ticked in a FOLLOW-UP PR immediately after this one merges, so every
> tick can cite a command run against the **merged** tree rather than against a branch that
> may still change — a box ticked from a branch is a claim about code that has not landed,
> which is the one kind of evidence this item's own record keeps refusing to accept
> elsewhere. The as-built (`.trident/as-built/feat/539-adopt-repls-across-restart.md`)
> records what shipped, which is its job; this file records what has been VERIFIED, which is
> a different question with a later answer. `status: done` only if no box is left unticked;
> any that cannot be honestly ticked stays open with its reason.

The owner's acceptance criterion, verbatim: *a gateway restart brings every project
REPL back with its conversation intact.*

**What "every" means here, stated so it is checkable:**

> Every project REPL whose substrate this gateway constructs is reconciled before that
> substrate's first turn, and **no row is ever reconciled under another row's options**.

**That restatement is NOT equivalent to the criterion above, and saying so is the point.**
An earlier revision of this paragraph introduced it as "without weakening what it asks
for". As quantified statements they differ — "every project REPL" and "every project REPL
whose substrate this gateway constructs" are not the same set — and this very file
documents the gap two sections down. Asserting equivalence while documenting the
difference is precisely the overclaim this item's own record catalogues, so the honest
version is three separate statements:

- **As a claim about boot-time mechanism it is narrower, explicitly.** Nothing is
  reconciled at boot for a project this gateway has not been asked to serve yet. A REPL
  exists, its row names it, and no pass has run.
- **As a claim about what the owner experiences it is equivalent, and that is the
  load-bearing half.** Reconciliation happens before that substrate's first turn, so no
  turn is ever served by a fresh process where a survivor existed. The criterion asks that
  a restart bring every project REPL back with its conversation intact; it does not say at
  what point in the boot that has to happen.
- **The observable difference is the window between the restart and first use**, in which
  the pane is alive, unreconciled and unreaped. That is stated in full under *Residual,
  named rather than hidden* below, and it is cross-referenced here so a reader meets the
  gap in the same place they meet the claim.

The second clause of the restatement is not a caveat on the first — it is the reason the
first is phrased by substrate rather than by registry; see *Why reconciliation is per key*.
The verbatim criterion above is unchanged and is what this item is answering.

**Say which process restarted, always.** A REPL is a pane of the **herdr server**, so:

- a **gateway** restart does not end it — the pane is in neither the gateway's process
  tree nor its cgroup — and this item is about re-finding it;
- a **herdr server** restart DOES end it, because panes are its children. Nothing here
  changes that, and no prose about this item may imply it does. What survives a herdr
  restart is the transcript, recovered the pre-existing way: `--resume`.

## What was true before

Nothing supported the criterion, in three separate places.

`orphan-adoption.ts` was adopt-or-**kill** and only ever killed: its verdicts were
`killed | not-ours | dead | no-pid`, with no adopt arm and no caller that could have
consumed one. `gateway/index.ts`'s SIGTERM handler killed the whole warm pool on the
way down — deliberately, because of the 2026-06-11 orphan incident (632 reparented
processes, ~19 GB). And a surviving child could not have been used even if it had been
found: authorization runs credential → session, so a restarted sink with nothing
registered refuses the survivor's `/reply` with 401 (that refusal is asserted, as a
refusal, in `durable-reply-sink-coordinates.md`).

## What this item delivers

A registry row carries the child's **pane handle** and the spawn-time properties the
warm-reuse guards compare against. A boot pass reconciles that row against what is
actually running: it re-attaches to the pane, restores `child_generation` (so the
child's `HMAC(root, generation)` credential resolves again) while minting a fresh
incarnation (so a pre-restart straggler cannot complete a post-restart turn), primes
the detector latches against the pane's current screen, and puts the session back in
`pool` / `childByKey` / the sink. The shutdown kill is gated on the pane being
re-findable, and everything else still dies exactly as before.

**herdr's own agent resume is OFF** (`[session] resume_agents_on_restore = false`).
Neutron owns relaunch: herdr's restore re-execs `claude --resume <id>` with none of our
flags — no dev-channel, no credential — so a pane it resumed could never answer a turn,
and two owners of one transcript is the failure the one-owner invariant exists to
prevent. The configuration makes that collision RARE; the `close-foreign-owner` verdict
below is what makes it SAFE, because a rule that lives only in a config file is not a
mechanism.

## Why reconciliation is per key, and why enumerating every row would be worse

One registry file holds **a row per pool key**, and a pool key folds the substrate
instance, the user, the **project** and the credential identity (`poolKeyFor`,
`pool.ts`). Two rows in one file therefore belong to substrates with different options —
a different `project_id` above all.

A pass runs with the options of the substrate that started it. Rebuilding a *different*
row's session from those options would put a REPL in the pool scoped to the wrong
project, with every tool call it made attributed there, and its child authorised on a
credential that belongs to another key. **Enumeration with the wrong options is a worse
defect than deferral**, and it is worse in the direction this whole item exists to avoid:
a REPL serving turns under an identity that is not its own.

So each substrate reconciles **its own key, with its own options**, and the boundary is
enforced rather than described: a pass inspects exactly one pane, attaches exactly one
pane, authorises exactly one session id, and leaves every other row byte-intact.
*Verified by* `runtime/adapters/claude-code/persistent/__tests__/boot-adoption.test.ts`
("one registry, two projects" — two rows in one registry belonging to different projects;
A is adopted, B's pane is never inspected, B's row is unchanged field for field, and B's
credential still gets a 401). The fixture deliberately writes **B's row first**, so a
pass that reconciled whichever row it found would land on the wrong one and the cases
red rather than passing against broken code.

**A row whose substrate this process never constructs.** Its pane keeps running, its row
stays exactly as it is, and the next construction of that substrate reconciles it — which
is the same pass, at the moment there are options to run it under.

Until then **nothing reconciles it and nothing reaps it**, and that has to be said without
a softening clause. An earlier revision of this paragraph claimed the pre-existing `#105`
orphan path in the watchdog covered such a pane if it wedged. It does not, and it cannot:
that path resolves the OWNING substrate's options by pool key, and on `respawn-and-alert`
a key with no registered options is pushed as **`unregistered-skip`** and skipped
(`supervision.ts`, the `keyOptions === undefined` branch) — precisely so it is not
actuated under the tick's own identity. `keyOptions === undefined` *is* the condition of
the row described here, so the sentence written to name the residual honestly was naming
as coverage the one path that declines to cover, and it was hiding it behind the same
premise the narrowing rests on.

What is true is narrower and still worth having: the pane is **labelled and visible** in
herdr rather than reparented and invisible, and the row that names it is durable, so the
next construction of its substrate finds it. What it is **not** is reconciled, reaped, or
watched in the meantime. That is a deliberate narrowing rather than an omission — see
*Why reconciliation is per key* for why actuating it under another substrate's options
would be the worse defect — but it is a gap, not a covered case.

## Acceptance

Bidirectional throughout: an adoption path that refuses everything satisfies every
refusal criterion and delivers nothing, so each refusal is paired with the acceptance
it must not swallow.

- [ ] **A TURN AFTER THE RESTART IS SERVED BY THE SAME CHILD.** Not "a REPL answers" —
      no `claude` is launched, and the answer is one only the ATTACHED child could have
      produced: its bridge refuses to answer until a gateway has attached to its pane
      and released its output gate, and every reply names the pane it was taken over
      through and the pid it runs as. A fixture that answered on its own authority would
      satisfy "a reply arrived" while the attach did nothing, which is what an earlier
      revision of this criterion's test did.
      *Verified by* `runtime/adapters/claude-code/persistent/__tests__/adopted-repl-serves-a-turn.test.ts`
      (`spawns === 0`, AND the reply naming this pane and pid).
- [ ] **NOTHING SPAWNS ON A KEY THAT HAS NOT BEEN RECONCILED.** A turn arriving while
      the pass is in flight WAITS; it does not cold-resume past it.
      *Verified by* the same file's "WAITS for the adoption rather than cold-spawning
      past it".
- [ ] **ADOPTION REQUIRES THREE POSITIVE PROBES, EACH ABLE TO SAY NO**: the host reports
      a live pane; that pane's foreground argv is a `claude` on this row's session id
      AND carrying this row's dev-channel; and the dev-channel at the row's recorded
      port answers `/health` with this row's session id.
      *Verified by* `__tests__/boot-adoption.test.ts` (adopt), plus the same file's
      `/health`-says-no and wrong-channel cases, and
      `__tests__/pane-adoption-verdict.test.ts` for the classifier alone.
- [ ] **A VERIFIED-OURS PANE IS ADOPTED OR CLOSED, NEVER LEFT.** A pane we have
      established is our child on our transcript and cannot adopt is closed, so nothing
      is left running that no handle reaches.
      *Verified by* `__tests__/boot-adoption.test.ts` (`closed-unadoptable`,
      `closed-foreign-owner`).
- [ ] **AN INCONCLUSIVE RECONCILIATION REFUSES THE SPAWN.** Where nothing established
      what happened to the previous REPL — the host could not be asked, the pane's
      contents could not be identified, a close is known to have FAILED, or the
      configured host cannot reach the pane at all — the turn FAILS, loudly and
      retryably, instead of starting a second `claude` on that transcript. The refusal
      is not remembered: the next turn re-probes.
      *Verified by* `runtime/adapters/claude-code/persistent/__tests__/adoption-refuses-a-second-owner.test.ts`,
      which drives the real `getOrSpawnSession` and asserts on the HOST's spawn counter.
- [ ] **A REFUSAL DOES NOT COOL THE CREDENTIAL.** The turn error is stamped
      `repl_unreconciled` at the producer, so the composer's ladder routes it to no
      cooldown — an UNSTAMPED retryable error is read as a 429 and would park a healthy
      credential for an hour after five refusals.
      *Verified by* `runtime/adapters/claude-code/persistent/__tests__/classify-spawn-error.test.ts`,
      with the table/union parity check in `runtime/__tests__/o3-substrate-error-codes.test.ts`.
- [ ] **AND A CONCLUSIVE ONE LETS IT THROUGH.** A pane positively gone, a survivor
      closed, a recorded pid the kernel says is dead or belongs to a stranger, or a row
      with no durable handle: the spawn proceeds. Without this half, a gate that refuses
      everything would satisfy the criterion above and stop the product working.
      *Verified by* the same file's second and third groups.
- [ ] **A HEALTHY REPL IS NEVER KILLED BY A FAILED PROBE.** When the host does not
      answer but the process table confirms the recorded child is alive and ours, it is
      LEFT RUNNING and the spawn is refused — a transport blip must not destroy the
      thing this item exists to preserve. Terminating a verified survivor is licensed
      only where the pane can never be adopted again (the host switch).
      *Verified by* `__tests__/boot-adoption.test.ts` ("LEFT RUNNING when only the host
      failed to answer" and "DOES kill a verified survivor — the one case that may").
- [ ] **A DEAD RECORDED PID IS NOT PROOF THE TRANSCRIPT IS FREE.** Where the pane
      authority cannot be consulted, a resume is licensed only by a scan that RAN over
      every live process and found no `claude` on this session — never by the recorded
      pid alone, because a pane relaunched under a NEW pid leaves that pid dead while a
      live process owns the transcript.
      *Verified by* `__tests__/boot-adoption.test.ts` ("REFUSES when another live process
      is a claude on this session", "REFUSES when the transcript-owner scan could not
      run at all", and the `tail -f` case that must not read as an owner).
- [ ] **IDENTITY IS RE-ESTABLISHED AT THE MOMENT OF A CLOSE.** A pane whose identity
      changed between the inspection that decided and the close that acts is LEFT ALONE
      (the id may have been reissued to a stranger); one that vanished in that window
      counts as closed.
      *Verified by* `__tests__/boot-adoption.test.ts` ("does NOT close a pane whose
      identity changed after the inspection", plus its vanished and positive-control
      siblings).
- [ ] **AN ADOPTION WHOSE ROW IS REPLACED MID-ATTACH GIVES THE CHILD BACK.** The pass
      publishes nothing until it has re-claimed the row; if another incarnation wrote
      its own child there, A's pool entry, sink registration, watchers and pane are all
      taken back and the verdict is `undecided`. Serving it would be a second live owner
      of a transcript the durable row assigns to somebody else.
      *Verified by* `__tests__/boot-adoption.test.ts` ("an adoption whose row is
      replaced mid-attach GIVES THE CHILD BACK" — asserting the pool, `childByKey`, a
      401 on the child's own credential and the closed pane, not just the row), with an
      uncontended positive control beside it.
- [ ] **TWO INCARNATIONS RACING FOR ONE UNCHANGED ROW: EXACTLY ONE PUBLISHES.** The row
      claim is a COMPARE-AND-SET, not a comparison — it writes `adoption_claim_by` and
      `adoption_claim_at` under the registry lock, so the second claimant reads a row that
      CHANGED and refuses with a reason naming the claim. A verification alone could not do
      this: both passes see the same restored `child_generation` and the same pane pid, so
      nothing distinguishes two readers of an unmodified row, and each would publish an
      attached wrapper onto the same pane.
      AN UNEXPIRED CLAIM MEANS A LIVE CLAIMANT, not merely a recent one. The owner RENEWS on
      its supervision tick and `ADOPTION_CLAIM_TAKEOVER_MS` is a multiple of that tick's
      interval, so what expires is a claim nobody is refreshing — a bare time-since-adoption
      let a healthy owner's claim lapse underneath it and handed a live pane to the next
      gateway to boot. The refresh is the same compare-and-set, so a gateway already taken
      over cannot re-assert ownership; the marker also carries the claiming gateway's pid, so
      a claimant whose process is provably gone is taken over at once rather than after the
      threshold (`alive` and "could not ask" both defer to the threshold, so the pid can only
      ever accelerate — and it needs its own three-valued probe, because `defaultIsPidAlive`
      answers `false` for a real ESRCH and an EPERM alike).
      Every path that stops owning a session gives its own claim back — CAS'd on the identity
      that took it, and only while the registry lock is confirmed held, since the give-back is
      a whole-registry write and an unguarded one would drop a concurrent incarnation's row.
      A claimant killed between marking and publishing therefore costs one bounded refusal,
      not a pane that can never be adopted again.
      *Verified by* `__tests__/adoption-claim-is-a-compare-and-set.test.ts` (the
      two-incarnation race, with the second pass run inside the real window between the
      first's compare-and-set and its publish; a LIVE owner that has renewed keeping its pane
      well past the old expiry, with the competitor arriving in the gap between two renewals;
      the single-incarnation positive control, which also proves the renewal is wired; an
      owner that STOPPED renewing losing the pane once the threshold passes; a claimant whose
      process is gone losing it at once, and one we could not ask about NOT losing it; the
      renewal refusing to overwrite a legitimate takeover; and the hand-over that clears the
      marker so the next boot is not refused).
- [ ] **CLEANUP MEASURES BOTH SIDES IN THE SAME SPACE.** The session-config containment check
      resolves the temp ROOT with `realpathSync` as well as the directory it is testing: with
      only the child resolved, any environment whose `tmpdir()` contains a symlink classified
      every legitimate directory as "outside" and skipped cleanup — retaining the plaintext
      credential files the check exists to remove. `TMPDIR=/var/run` does it on Linux; macOS
      aliases `/var` to `/private/var` out of the box.
      *Verified by* `__tests__/session-config-containment.test.ts` — an ALIASED temp root
      (built by the case, with the premise that the two namings disagree asserted before the
      behaviour) still cleans legitimate directories, and a victim outside the real temp tree
      is still refused through that same aliased root, so the widening did not widen too far.
- [ ] **AN OWNERSHIP WRITE THAT COULD NOT HOLD THE LOCK WRITES NOTHING, AND SAYS WHAT IT
      DID INSTEAD.** `withFlockSync` runs its callback even when `flock` fails, and the
      registry write saves whatever that callback returns — so an ownership transition that
      ignores the acquisition outcome rewrites the whole registry from a snapshot nobody had
      the right to read, dropping a concurrent gateway's rows. Every such write goes through
      one entry point whose failure disposition is a REQUIRED parameter, and the two
      dispositions differ on purpose: a child exit does NOT disown (the row keeps naming an
      exited child, which the next boot's probe answers as a positive absence), while a fresh
      spawn REFUSES and ends the child it just made — a durable pane whose ownership was
      never recorded is a REPL nothing can find again and one any other gateway may claim.
      **ANY WAY OF NOT LANDING IS A REFUSAL.** The registry helper has three ways to decline to
      persist — the lock was not acquired, the registry was unreadable (a non-ENOENT read
      failure), or the open/save threw — and only the first used to be visible, so an
      unreadable registry or a thrown save left the fresh spawn confirming its claim and
      serving a pane whose ownership nothing durable records. Persistence is now part of what
      the helper reports, and every ownership write treats a PREVENTED write the way it always
      treated an unacquired lock (a mutator's own `skipSave` is not one of these: that is a
      decision, and its result stands).
      **AND THE REFUSAL JOINS THE ERROR VOCABULARY**, carrying `repl_unreconciled` stamped on
      the thrown error rather than inferred from its prose: an unclassified retryable spawn
      error is mapped by the composer to a synthetic 429, so a local lock failure would cool
      a healthy credential — the provider charged for a filesystem problem. The stamp is
      VALIDATED against the taxonomy where it crosses into trusted use, because both consumers
      index a lookup table with it: an unrecognised stamp is treated as unstamped rather than
      trusted, since throwing there would replace the original failure with a `TypeError` and
      skip the `channel.close()` that ends the turn's stream.
      *Verified by* `__tests__/pane-handle-persistence.test.ts` (the real flock forced to
      fail at each transition, plus a non-ENOENT read failure and a thrown save — each
      asserting the refusal, the child terminated, no ownership confirmed and the registry
      bytes unchanged, asserting what was written, what the caller did about it and
      the class it emitted, each with a lock-held positive control),
      `__tests__/pane-ownership-is-one-fact.test.ts` (no transition is called under the entry
      point that does not consume the outcome), and
      `gateway/wiring/__tests__/build-llm-call-substrate.test.ts` (the credential is NOT
      cooled, asserted at the surface that spends the money, with a genuine-429 control).
- [ ] **A CLAIM PRECEDES CAPABILITY, NOT PUBLICATION.** An adopted pane's wrapper is blind and
      mute until its claim is confirmed: no screen is recorded, primed or scanned, so no
      detector can answer a prompt on a pane another gateway owns (priming does not cover this
      — it latches the FIRST screen, and the hazard is a fresh rising edge during the race). A
      fresh spawn reserves the session KEY under the registry lock before `PtyHost.spawn` is
      called, so the loser never starts a `claude --resume` at all — killing it afterwards
      would not unwrite what it had already appended to the transcript.
      *Verified by* `__tests__/adoption-claim-is-a-compare-and-set.test.ts` (a fresh actionable
      prompt delivered at attach time while the loser is mid-race: it sends no key and takes no
      screen, while the winner's priming line shows the same screen WAS delivered) and
      `__tests__/pane-handle-persistence.test.ts` (the loser never calls `PtyHost.spawn` — the
      spawn COUNT, not the cleanup — with an uncontended spawn and a dead reserver's expired
      reservation as controls, and a failed first spawn leaving the key usable).
- [ ] **EVERY SESSION THAT OWNS A PANE CONTENDS FOR IT, HOWEVER IT CAME TO EXIST.** A fresh
      spawn CONTENDS for the claim in the same write that records the pane handle, through the
      same predicate the adoption compare-and-set uses — writing a claim without contending
      let two gateways spawn `--resume` panes on one row and both serve. A pane cannot be
      claimed before it exists, so the loser kills the child it just spawned and refuses the
      turn retryably (`repl_unreconciled`, no credential cooldown): killing costs one respawn,
      leaving it alive costs a second owner. A claim stamped with this process's own pid never
      blocks it, or a replacement spawn would refuse itself on the strength of a claim its
      dead child left.
      A child's exit releases the handle and the claim together; a child's exit
      releases the handle and the claim together; a replacement spawn inherits neither.
      While only the adoption path claimed, a spawner served a pane it had not claimed — an
      adopter starting alongside it read an unclaimed row and attached a second wrapper, and
      the spawner could not even detect it, because a session with no claim has nothing to
      renew.
      The handle and its claim are written in ONE module through four named transitions
      (`ownPane`, `disownPane`, `handOverPane`, `refreshPaneClaim`); a row that is owned but
      unclaimed cannot be produced by any other module, and that is enforced rather than
      documented.
      *Verified by* `__tests__/pane-handle-persistence.test.ts` (a fresh spawn LOSING the
      contest for a row another gateway owns — its child ended, its refusal carrying the code,
      the winner's row untouched — with a replacement spawn NOT refused by its own
      predecessor's claim beside it; an actively-served fresh spawn refusing an overlapping
      adopter, with one wrapper attached and the pane left
      running; a replacement spawn clearing ownership its predecessor left behind, asserted
      field-for-field; and an ordinary spawn claiming, serving and giving both back on exit)
      and `__tests__/pane-ownership-is-one-fact.test.ts` (no module outside the funnel writes
      either field, with a positive control so the check cannot go vacuous).
- [ ] **A FENCED KEY IS NO LONGER THIS GATEWAY'S TO SUPERVISE.** The supervision tick cannot
      proceed past a renewal that fenced: the renewal returns a discriminated outcome and the
      tick switches exhaustively, so a future arm cannot default into "carry on". Before this,
      the tick discarded that answer and probed with the snapshot loaded before the fencing —
      and if the probe called the pane unhealthy, the losing gateway emitted a crash notice,
      patched the WINNER's row and attempted a respawn over it. The boundary is before the
      probe, because the probe's verdict is what turns a fenced tick from inert into
      destructive; and a fenced key stays out of supervision on every later tick too, not just
      the one that fenced it.
      *Verified by* `__tests__/adoption-claim-is-a-compare-and-set.test.ts` — a fenced key with
      an UNHEALTHY probe raises no crash notice, no alert and no respawn, and the winner's row
      is byte-identical afterwards; with an unfenced key under the same unhealthy probe still
      alerting and acting as the control.
- [ ] **A LEASE HOLDER STOPS ON ITS OWN EVIDENCE, WITHOUT OBSERVING THE WINNER.** Fencing
      only when a renewal answers "not ours" made safety depend on READING the other
      gateway's marker — which cannot work, because the same failure that costs a lease (an
      unacquired lock, an unwritable registry, a vanished row, a throw) is the failure that
      hides who took it: renewals stuck on one of those never become "not ours", so the old
      holder served forever while the new one served too. So the session fences itself once it
      has gone `SELF_FENCE_AFTER_MS` without a CONFIRMED renewal, whatever the reason, and
      that constant is DERIVED from the takeover window by subtracting one renewal interval —
      both measured from the same instant, so the holder stops at least a tick before any
      other gateway may take over. **Enforced by an autonomous timer** armed when the claim is
      confirmed and re-armed on each CONFIRMED renewal, so it fires without a tick, a turn or a
      probe — the earlier version evaluated the deadline only when a new turn arrived or a
      watchdog renewal ran, and both are things a stalled gateway has stopped doing, which is
      the one circumstance the deadline exists for. The fenced session also REFUSES an
      outstanding reply: a reply in flight arrives over the sink rather than over the pane, so
      detaching alone would not stop it.
      *Verified by* `__tests__/adoption-claim-is-a-compare-and-set.test.ts` — the first case
      has NO second gateway in it at all (if safety needed one, the case could not be
      written): renewals fail at the real flock, the deadline passes, and the session delivers
      no screen, sends no key, loses its pool entry and is refused a turn, with the pane left
      alive. A further case runs with an ACTIVE turn, the tick loop stopped and no new turn
      arriving — nothing that could evaluate the deadline on the session's behalf — and asserts
      it fences itself anyway and refuses the outstanding reply. Then the same with a second gateway taking over afterwards, asserting it serves
      and the old one does not; and a control where renewals keep confirming and the session
      serves indefinitely.
- [ ] **THE GATEWAY THAT LOSES THE CLAIM STOPS SERVING THE PANE, AND DOES NOT CLOSE IT.**
      A renewal that comes back `not-ours` means another incarnation took this row over while
      this gateway was not refreshing. Logging that and carrying on IS the two-owner state,
      reached by the losing party: the session would stay attached, stay in the pool, stay
      registered at the sink and go on answering turns on a pane it no longer owns. So it
      fences — detach the wrapper, release its OWN pool entry (the winner's may be under the
      same key), unregister its sink registration and watchers, release the live-process
      handle, and refuse turns for that key through the spawn gate's existing `undecided`
      refusal rather than a second vocabulary.
      **It must not close.** The winner's REPL is live and serving; a loser that closed would
      destroy the conversation the takeover just preserved, which is the distinction `detach`
      exists for.
      *Verified by* `__tests__/adoption-claim-is-a-compare-and-set.test.ts` (A publishes, its
      renewal lapses past the window, B takes the claim and publishes into the same pool, and
      A's next renewal fences it — asserting of A that it delivers no screen, sends no key,
      has no pool entry and is refused a turn, and of B that it is still attached, still
      served by a live pane, and its row untouched), with a successful renewal beside it as
      the control.
- [ ] **A WRITE ONLY EVER TOUCHES THE ROW IT DECIDED ABOUT.** Clearing a handle, and
      correcting an adopted pid, are compare-and-set on the (handle, generation) pair
      the pass inspected. A row another incarnation replaced mid-pass is left exactly as
      it is — stripping ITS handle would leave a live child unfindable, so the next boot
      could not adopt it and the shutdown gate would kill it.
      A row that moved also makes the pass's verdict `undecided`, so the REFUSAL follows
      the preservation: leaving the newer row intact and then reporting a verdict that
      licenses a resume would start the second owner anyway.
      *Verified by* `__tests__/adoption-refuses-a-second-owner.test.ts` ("starts NO
      second process on a transcript another incarnation just claimed" — asserting zero
      spawns end-to-end, with its positive control), and at the unit level by
      `__tests__/boot-adoption.test.ts`, both with the inspection held open so the race
      is actually constructed.
- [ ] **AN UNVERIFIED PANE IS NEVER CLOSED.** A pane running something else, or one the
      host could not speak for and whose pid the process table does not confirm, is left
      alone and reported undecided — the recycled-identifier rule, applied to a pane id.
      *Verified by* `__tests__/boot-adoption.test.ts` ("LEAVES a pane running something
      else", "leaves an UNVERIFIED process alone").
- [ ] **THE SURVIVOR IS RE-REGISTERED, NOT MERELY RECONNECTED TO.** The credential the
      child was baked with routes to the adopted session afterwards; a credential from
      any other generation is still refused 401.
      *Verified by* `__tests__/boot-adoption.test.ts` ("RE-REGISTERS the survivor in the
      sink").
- [ ] **A STALE SCREEN IS NOT A STIMULUS.** A pane whose screen already holds a
      tool-approval prompt at adoption time has NOTHING submitted to it — not on the
      first screen and not while that prompt stays up — while a prompt that appears
      AFTER adoption is answered exactly as on a fresh REPL.
      *Verified by* `__tests__/adopted-pane-latches.test.ts` (both directions).
- [ ] **THE SHUTDOWN KILL IS NARROWED, NOT REMOVED.** A child survives only when a
      persisted row names its exact pane and its exact generation; every other child —
      in-process hosts, quarantined children, ephemeral one-shots, any pane no row names,
      and a child whose spawn had not settled when shutdown reached the pool, which is
      killed when it later resolves regardless of the row it went on to write (#674) —
      is still killed.
      *Verified by* `__tests__/gateway-shutdown-survival.test.ts` (the verdict table and
      the teardown cases).

      The last entry is a case the shipped narrowing does NOT cover, and it is in the
      enumeration rather than only in the as-built because the second clause claims to
      partition every child. "Survives only when…" is a necessary condition and remains
      exactly true; a still-spawning child whose row DOES name its pane and generation
      satisfies neither half of the partition as it was first written, so the list
      claimed a completeness it did not have — which is a defect shape this item's own
      record names, and it is not one to commit while cataloguing it. #674 tracks the
      gap; it fails conservatively (one `--resume`, nothing orphaned and no second owner)
      and the fix has to take the registry lock from a callback that runs after the
      module state is torn down.
- [ ] **A HANDLE DESCRIBES THE CURRENT CHILD OR IS ABSENT.** A spawn whose host issues
      no handle leaves no handle on the row, even when the row carried one a moment
      before.
      *Verified by* `__tests__/pane-handle-persistence.test.ts`.

## The host switch is a supported configuration change, not a corner case

#540 keeps the in-process PTY host selectable, so "herdr → Bun with REPLs still
running" is something an operator can do on purpose. The configured host then cannot
see the pane the row names — but that pane may still be running this row's `claude`
under a herdr server this process is not talking to. The pass therefore falls back to
the **process table**: a recorded pid verified as ours is terminated (which takes the
pane with it), a pid that is dead or provably a stranger says the previous child is
gone, and anything else refuses the spawn. An honest log line is not a substitute for
refusing.

## Residual, named rather than hidden

**A row is reconciled when its substrate is constructed, not at process boot.** Stated
above under *Why reconciliation is per key*; repeated here because it is a residual and a
reader should not have to infer it. Nothing is reconciled for a project this gateway has
not been asked to serve yet.

**The close is licensed by the row as well as the process, but the window is narrowed
rather than eliminated.** A pane is only closed when the row still names it — checked
under the flock immediately before the close — because a newer incarnation of ours on a
reused pane id is indistinguishable, to a process-identity check, from a foreign owner.
That check makes the destructive act require the row and not just the process, and it
shrinks the exposed window from the whole close (an inspection round trip, a `/health`
probe and a close, each an await during which a spawn can complete) to the gap between
that read and the next statement, with no I/O in between. **It does not close the window.**
A row can still move inside that gap. Closing it properly would need a durable "closing"
marker written under the lock before the close, which trades this residual for a different
one — a crash between the marker and the close leaves a row marked closing over a live
pane — so the narrowing is what shipped and this paragraph is here so nobody reads it as
the stronger claim.

**A persisted channel name is a path input, and containment is enforced in three places —
none of which alone is enough.** The registry's parse boundary requires the generated shape
(`neutron-` + 32 hex), so a row that could not have come from this system is dropped;
`replSessionConfigPaths` enforces LEXICAL containment when it builds the paths, which
answers "could this string ever name something outside the temp dir" and nothing more; and
`unlinkSessionConfigs` resolves the directory on the FILESYSTEM before deleting, because a
perfectly-shaped name can still be a symlink and only the destructive site can see that. A
residual remains and is deliberate: a TOCTOU window between the resolve and the unlink that
would need a handle-relative unlink to close, and a refused delete leaves a plaintext
credential file in place rather than removing it — the safer direction, and not free.

**A REPL that was mid-spawn when the shutdown landed is killed rather than kept (#674).**
The shutdown's late-spawn path terminates a session whose spawn settled after the pending
grace expired, without consulting the survival gate — so a herdr-hosted child whose row
names its pane is ended anyway. This fails in the conservative direction: the cost is one
`--resume` on the next turn, and nothing is orphaned and nothing becomes a second owner of
a transcript. It is a residual of this feature rather than a defect introduced by it, and
it is tracked separately because the fix has to take the registry lock from a callback
that runs after the module state has been torn down.

If the registry file is **lost** between a shutdown and the next boot, the pane it
named becomes unreferenced: nothing will reap it automatically. It is still a labelled,
visible pane in herdr rather than an invisible reparented process, and the loss is
bounded at one pane per session key per registry-loss event — but it is the price of
survival, and it is not zero. A sweep that enumerates `neutron-repl`-labelled panes and
reports the unclaimed ones is the obvious next step; it is deliberately NOT taken here,
because one herdr server can host several Neutron instances and a sweep that cannot
tell another instance's pane from a leaked one must not be allowed to close either.


### Arbitration residual acceptance (#685)

- [ ] Readiness failure removes its own sink registration and preserves a replacement
      with the same session id. Verify with
      `__tests__/spawn-failure-revokes-credential.test.ts`, including an unguarded-removal mutation.
- [ ] The losing-adopter fixture also enters through `beginBootAdoption`: overlapping
      callers share the held pass, preserve the winner's authorization and mirrors,
      and a later call retries an undecided pass. Verify with
      `__tests__/pane-handle-persistence.test.ts`, including a pass-map bypass mutation.
- [ ] Fence duration follows SPEC.md Decisions Log 2026-09-14, "fence duration".
- [ ] The claimant liveness probe documents its shared PID namespace assumption beside
      the implementation; PID evidence is distinguished from claimant identity.

## Recorded-pid argv evidence (#672)

Identity and termination must consume a structured argv vector. On Linux, read
NUL-separated `/proc/<pid>/cmdline`; preserve spaces, newlines and empty arguments.
A flattened `ps` string may refuse a spawn but must never authorise adoption or
termination. Without a structured reader (including Darwin), the recorded-pid
fallback must report `unreadable`, leaving the process untouched and boot
reconciliation undecided. Structured pane inspection remains available.

This is the stricter task requirement for #672, superseding the filed brief's
proposal to retain a Darwin string identity fallback. See SPEC.md's 2026-09-14
recorded-pid identity decision.

Acceptance (verify with `bun test runtime/adapters/claude-code/persistent/__tests__/orphan-adoption.test.ts`):

- [ ] A live child whose flattened argv resembles our invocation but whose real
  argv[0] is `claude --resume` is refused, on the same input the string matcher accepts.
- [ ] A live child with our launch shape under a spaced binary path is accepted;
  empty arguments and paths containing newlines survive the reader unchanged.
- [ ] Failed, empty or unterminated reads yield `unreadable`, never `not-ours`.
- [ ] Unsupported platforms cannot derive identity from flattened output.
- [ ] Mutating the vector into a flattened parse and mutating the identity gate
  into an unconditional refusal each fail the regression; restoration passes.
