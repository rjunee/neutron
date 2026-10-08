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

**What "every" means here, stated so it is checkable:** Open boot reconciles
General and each non-deleted project's durable active Claude or Codex conversation
whose selected provider and credential identity are currently authorized.
It derives exact pool keys from those authoritative inputs; it never parses
opaque registry keys or assigns another row's options. Reconciliation is awaited
after the production graph binds the tool bridge and before it accepts traffic.
No app message or synthetic chat turn is needed. A surviving pane is adopted;
a proven-dead recorded conversation resumes its native session and launch profile.
Clearing a dead pane handle does not erase the registry's session identity.
Explicitly retired sessions remain asleep; absent conversation authority never
becomes a fresh conversation. Unavailable terminal hosts are retried automatically.

Other substrate families retain reconciliation before their first turn. Foreign
identities, deleted projects, revoked credential identities and routes without a
native persistent owner are excluded. These are deliberate scope boundaries,
not evidence that those panes have been reconciled or reaped. Decisions Log
2026-09-26 supersedes the narrower 2026-09-19 startup policy.

**Say which process restarted, always.** A REPL is a pane of the **herdr server**, so:

- a **gateway** restart does not end it — the pane is in neither the gateway's process
  tree nor its cgroup — and this item is about re-finding it;
- a **herdr server** restart or **whole-host reboot** ends the process. Neutron
  automatically starts the recorded native session again after proving its prior
  owner is gone. The transcript survives; the process identity does not.

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

**A row outside the authorized boot-adoption scope whose substrate this process
never constructs.** Its pane keeps running, its row
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

The 2026-09-26 expansion is tracked in #1342. Existing adoption controls below
still bind; their old no-dead-spawn policy is superseded only for exact authorized
recorded project conversations. Workflow recovery keeps its existing durable
claims and budgets; chat readiness must never dispatch a second build.

- [ ] **AUTOMATIC RESUME WITHOUT A TURN.** After gateway, terminal-host or host
      restart, authorized active Claude and Codex conversations return on their
      recorded native session with intact history and exact scope/model/credential.
      Cleared dead handles still recover; an absent record, explicit retirement,
      deleted project, changed credential, ambiguous owner or unavailable transcript
      cannot start a fresh conversation. Verify isolated startup recovery tests and
      consuming Open boot tests, with positive and refusing controls.
- [ ] **RETRY AND FENCING.** Terminal-host startup delay requires no client action;
      retries never overlap and shutdown drains them. A changed registry row,
      concurrent claimant or fenced project prevents spawning. Recovery neither
      acquires a chat/build lease nor replays a native turn. Verify scheduler,
      pre-spawn reservation and provider recovery tests.
- [ ] **WORKFLOW CONTINUITY.** Previously active workflows resume through their
      durable continuation ledger, harvest completed work before relaunch, and
      preserve at-most-one dispatch and the existing review/merge gates. Verify
      `open/__tests__/project-build-e2e.test.ts` and a served unattended witness.

Bidirectional throughout: an adoption path that refuses everything satisfies every
refusal criterion and delivers nothing, so each refusal is paired with the acceptance
it must not swallow.

- [ ] **OPERATOR CAP REARM DOES NOT REQUIRE A RECOVERED SESSION.** An authenticated
      `POST /admin/rearm-session-cap` can release one exact cap episode on a current
      authorized Claude conversation before supervision has registered it. The JSON
      body is a short-lived Ed25519 `operator-repl-cap-rearm` envelope verified
      against independently pinned host/installation authority. The web/mobile
      owner bearer alone grants no release authority; an envelope cannot supply
      its verification key. Its request binds `projectId` (null for General),
      `sessionKey`, `sessionId`, `childGeneration` and `cappedAt`. Scope, selected provider, credential and
      fingerprint are resolved from current host authority. The locked write changes
      only `capped_at`; it never starts a turn, resumes a child or releases work.
      A foreign/deleted/retired scope, unresolved admission, changed identity or cap,
      in-flight respawn, unavailable authority or unheld lock refuses unchanged.
      The already-running recovery scheduler subsequently resumes through its
      existing gates without another gateway restart or synthetic chat.
      Later readiness and elapsed time never automatically clear the storm latch.
      The owner-authenticated `POST /admin/respawn-session` also refuses a capped
      row before any registry write, kill or replacement. After independently
      signed rearm, its existing uncapped forced-resume behavior remains available.
      Forced restart is not cancellation of an active turn: process death may
      enqueue that turn's input for replay.
      Verify: `runtime/adapters/claude-code/persistent/__tests__/operator-cap-rearm.test.ts`
      and `open/__tests__/boot-live-agent-adoption.test.ts`, plus
      `open/__tests__/operator-cap-rearm-authorization.test.ts`, with accepting and
      refusing semantic mutations.

- [ ] **BOOT RESTORES AUTHORIZED LIVE-CHAT SURVIVORS WITHOUT AN APP TURN.** The
      production graph installs its tool bridge before adoption, then awaits
      reconciliation for General and current projects on Claude routes. The
      survivor keeps its pane, pid and session; its credential authorizes a real
      project-scoped tool call. No synthetic turn or fresh spawn occurs. Foreign
      owners, deleted projects, revoked identities, non-Claude routes, unknown
      registry state and absent/dead candidates never gain authority or a
      watchdog registration during adoption. Dead recorded conversations are
      separately eligible for the authorized startup-resume criteria above.
      A real first turn joining adoption retains its own
      supervision options and waits for the same pass.
      Stable credential IDs also require the survivor's recorded auth fingerprint
      to match the final current environment, including explicit empty ambient
      fingerprints; missing or changed evidence refuses without closing or claiming.
      The claim rechecks that evidence under the registry lock. A proactive caller
      cannot inherit an unguarded or differently guarded cached pass as a verified
      adoption; equal guarded policies can share the pass.
      *Verified by* `open/__tests__/boot-live-agent-adoption.test.ts`.
      Claim races and cached-policy controls:
      `runtime/adapters/claude-code/persistent/__tests__/boot-adoption.test.ts`.

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
      `__tests__/pane-ownership-is-one-fact.test.ts` (ownership writes require the entry
      point that consumes the outcome; pure comparison operands are permitted), and
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
      in-process hosts, quarantined children, ephemeral one-shots, any pane no row names —
      is still killed. A spawn resolving after the shutdown grace takes the same locked
      decision using registry coordinates captured before teardown (#674). Missing rows,
      mismatched panes or generations, unreadable data and unacquired locks must still
      kill, with distinct reasons. A matching late row must survive and release its old
      wrapper, while keeping its config files.
      *Verified by* `__tests__/gateway-shutdown-survival.test.ts` (the verdict table,
      teardown cases, and `late spawn survival after shutdown reset`, including the
      before-partition positive control).

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

**Startup recovery is scoped to authorized live-chat identities.** General and
non-deleted projects on Claude or Codex routes with currently authorized credential IDs
are reconciled without an app turn once graph tools are ready. Other substrate
families retain lazy reconciliation. A row excluded by ownership, project,
provider or credential eligibility is left untouched and is not claimed as
reconciled or reaped. Missing registry evidence is reported as unknown rather
than silently treated as successful recovery. Legacy Codex generations without
complete process-birth evidence can prove death after a machine reboot, but
same-boot legacy crash recovery remains refused. Interrupted native work with
unresolved durable work/lease evidence stays fenced until its authoritative
workflow reconciliation establishes what can continue; restored chat readiness
alone is not a workflow-continuation receipt.

### Passive late-result reconciliation

A native child may finish after the host stops observing its bounded request.
The failed workflow remains failed. Startup and periodic recovery inspect such
terminal runs without dispatching another actor or synthesizing a conversation.
The original signed child-bound dispatch must authenticate the full stored
lease and request; the canonical attempt must agree on provider, placement,
role and model. An exact armed reservation and a result at the canonical role
path must then pass the same envelope and payload validators as live execution.
This uses the existing validated-result completion contract, not parent-process
death: the persistent project REPL can remain alive after its native task ends.

- [ ] A late completed or blocked result releases only its original token and
      generation; duplicate identities and other project leases survive. Repeated
      recovery is idempotent, and neither the failed run nor attempt outcome is
      rewritten. Verify: `bun test open/wiring/__tests__/claude-native-dispatch-boot.test.ts`.
- [ ] Missing or unarmed reservations, malformed payloads, foreign steps or
      schemas, forged receipts, changed tokens or generations, and nonterminal
      runs retain ownership. The positive completed case must fail if recovery
      is disabled; negative cases must fail if validation is bypassed. Verify:
      the same suite with bidirectional mutations.
- [ ] Actual Open composition consumes a late result at startup and on a later
      recovery tick with no native turn, and ordinary project-build execution
      retains its existing validator behavior. Verify: the same suite and
      `bun test open/__tests__/project-build-e2e.test.ts`.

### Operator retirement of restricted planner authority

The owner-directed recovery policy (Decisions Log 2026-10-08) permits an
independent, pinned operator authority to retire an exact restricted planner's
workflow authority without rebooting the host or terminating its parent. Its
signed decision kind is `planner-authority-retired`. This establishes permanent
loss of that work's host authority; native-loop liveness and task outcome remain
unknown. Automatic parent task notifications may still arrive. The decision is
neither a completed/blocked result nor proof of native-task exit, parent idleness,
or containment of every native effect.

Eligibility requires a canonical terminal run, its original prepared/started
native dispatch attempt, and an original signed child-bound dispatch agreeing
with the full stored lease and request. The request must be a writable `plan`
with `tools: edit` and no network, using the restricted `neutron-planner-v1`
profile whose sole model tool is `mcp__neutron__planner_work`. The signed
operator decision binds the canonical installation and scope, full lease
identity, original dispatch/request digests, original parent and native child,
policy version, and retained evidence-bundle digest. Existing protected operator
trust configuration supplies the verification key; request data cannot choose it.

The original dispatch authenticates the requested profile, not the native
runtime's actual selection. A named operator observation must corroborate actual
selection using retained original invocation, parent/session and deployed native
tool-enforcement evidence. Record the producer, observation time and evidence
digests as operational corroboration, without relabelling unsigned transcript
bytes as an original signed observation. Deadline expiry, vanished worktrees,
gateway death, provider prose or an operator signature without this corroboration
do not independently establish eligibility.

Before release, persist an immutable retirement record for the exact
installation/scope/run/step and prevent new authority for that identity. Enforce
the retirement at child admission, planner grant binding, continuation and host
operation execution, including after restart or a change of token/generation.
Establish a barrier against concurrent grant creation and new calls, revoke
matching current grants, and drain already-accepted host operations before
consuming the retirement. The operator's recorded observation of the original
gateway's death establishes loss of its process-local grant and must account for
its accepted operations. The live consumer authenticates that operator judgment
and drains its own grant registry. An unreadable or incomplete barrier/drain
observation retains ownership. A failed or interrupted retirement remains fenced
and is retryable under the same exact authority; it cannot reopen the work.

Record consumption and delete only the unchanged full lease in one transaction.
Repeated consumption is idempotent. Never change the run or attempt outcome,
fabricate a result, remove the original dispatch/reservation, or redispatch the
retired work. Refuse any lease reserved by a pending whole-host termination
preparation: this policy cannot supersede, cancel or consume that preparation.
Unrelated leases, active workflows and existing maintenance fences survive.
Release matching workspace authority with an explicit retirement reason, without
claiming native completion. Recovery sends no parent control or ordinary native
input and grants no permission to close, replace or reconfigure a parent; its
independent activity and census guards remain authoritative.

- [ ] An authenticated eligible retirement releases only its exact lease after
      the authority barrier and drain, preserving all outcome and result evidence.
      The same flow succeeds with native-loop liveness unknown and the parent
      alive; no parent input or termination occurs. Verify: dedicated planner
      authority retirement integration tests and
      `bun test open/__tests__/project-build-e2e.test.ts`.
- [ ] Forged or foreign authority, changed request/lease/parent/child, missing
      profile corroboration, nonplanner work, nonterminal runs, pending host
      termination preparation and unknown grant/drain state retain ownership.
      Deadline expiry or a missing worktree alone never releases a lease.
- [ ] Retirement races with grant creation and an accepted operation cannot
      release before draining or admit a later operation. Rebinding, continuation,
      fresh-token admission and restart cannot restore the retired run/step.
      Atomic failure and retry preserve the immutable record and exact lease;
      duplicate consumption cannot affect a sibling lease or active workflow.
- [ ] Ordinary automatic reconciliation continues retaining unknown children.
      Positive controls fail if retirement is disabled; negative controls fail
      when authentication, identity, pending-preparation, barrier/drain or
      permanent-retirement guards are bypassed. Verify with bidirectional
      mutations in the dedicated integration tests and planner operation tests.

### Operator quarantine of a never-provider-admitted planner conversation

The owner-directed conversation quarantine policy (Decisions Log 2026-10-08)
adds a separately versioned eligibility case, `never-admitted-conversation-v1`,
for an exact expired planner request whose authenticated original dispatch ended
at `submission-started`, without a native child identity. It does not change the
child-bound restricted-profile retirement policy or whole-host termination.
It retires host-issued workflow authority, not native execution: parent liveness,
local hooks, other native effects and task outcome remain unknown. No completed
result, actual child-profile selection or physical cessation is inferred.

Eligibility requires the original signed request and dispatch, canonical terminal
run and prepared/started native attempt, exact unchanged live-child lease, expired
original signed deadline, and original parent process, session, generation and
launch relay identity. The request is writable `plan`, `tools: edit`, network
false. Retained evidence must bind the original one-shot consumed input to this
request, its pinned native executable and original routing configuration. A
missing child binding remains explicitly null. Parent-only metadata, deadline
expiry, a missing worktree, an API-error transcript or an operator signature
without complete custody evidence cannot establish eligibility.

An explicitly owner-authorized logical project-conversation reset may additionally
name exact stale `conversation` leases from `chat` or `acting-turn` producers.
The signed preparation and final authorization enumerate `{ lease,
retirementOperationId }` entries (`conversationLeases`, empty normally), plus a
`conversationReset` judgment containing the canonical `topicKey`,
`ownerAuthorized: true` and a protected `censusDigest` when the list is nonempty.
Each work reference must exactly match that project's canonical owner-chat topic
and the original producer's timestamp or UUID suffix. Every referenced retirement
must be an immutable, completed, independently authenticated restricted-planner
record in this installation, scope and kernel boot, with the same producer epoch
and observed original executor closure. Current producer epochs, unsigned,
incomplete, mismatched or merely asserted closure refuse.

These extra rows represent historical **logical conversation admission ownership**.
The closure record does not authenticate a separate chat turn's historical native
parent. No such join or zero-admission claim for old chat turns is inferred. All
historical native effects and outcomes remain unknown. The owner authorizes this
specific logical-topic reset; the complete current project census must contain
only the target native conversation, with no other live or unresolved session,
ordinary active turn, pending spawn or unrelated workspace. The entire canonical
lease multiset must equal the target planner lease plus the exact signed list.
Duplicates, unlisted rows, another topic or producer, and any changed lease refuse.
Preparation permanently tombstones each listed scope/work reference across tokens,
producer epochs and restarts before drain. The completed quarantine operation
atomically consumes only those unchanged rows with its planner lease, preserving
all authorization and closure records. A partial failure keeps every remaining
lease and fence; exact completed retry never revives or broadens authority.

Before any relay quarantine, an independently signed application preparation
binds the exact original lease, request, dispatch and conversation. The application
checks the complete affected-work census and commits its project maintenance hold,
conversation guard and exact-work tombstone together, then drains host grants.
The operator verifies that preparation before invoking root-only relay quarantine.
Final release authorization embeds that exact signed preparation and the capacity
owner receipt; neither phase can substitute another operation or authorization.

Before issuing release authority, the independent relay owner must persist an
irreversible quarantine for the installation and original native conversation
identity. The atomic boundary shares serialization with provider admission:
no request may pass admission/forwarding while an absence check is stale. The
owner must validate the complete current ledger and all linked historical
archives for the exact original launch scope. Any provider-admission record,
including unknown, rejected or zero-sequence admission, or any missing, corrupt,
ambiguous or unaccounted history refuses authorization. A request sequence alone
is not provider admission. Missing history is never treated as an empty history.
The historical source and routing pins must establish that admission was durable
before every possible provider forward under this original launch scope.

Quarantine denies registration, ingress and forwarding for that conversation
under every current or future relay scope, credential, token or generation,
including after daemon restart. It aborts and drains all already accepted relay
requests for the conversation; inability to establish the drain retains the
fence and cannot produce a completion receipt. A refusal or crash after fencing
must not reopen the conversation. The owner receipt binds operation, installation,
conversation and original scope, full lease, signed request/dispatch digests,
parent identity, custody/source evidence digests, and committed quarantine/drain
proof. The application verifies against its independently configured operator
key and verifies that the durable quarantine is still effective; bearer access
alone cannot authorize recovery or nominate the verification key.
The operator envelope uses the host-recovery authority’s configured identifier
namespace; relay registration, quarantine and fresh status use the independently
configured capacity authority’s namespace. These identifiers need not be equal.
Exact kernel boot, parent process/start/session, original scope/routing and operation
bind the proofs; neither proof may substitute the other authority’s identifiers.

This operation removes provider access for the entire affected conversation.
Its affected-work census must account for all current ownership and queued work
before preparation. Unrelated or ambiguous active work in that conversation
refuses; other conversations, project sessions and leases are untouched. Operator
execution requires authorization for this specific conversation consequence.
No parent input, signal, process termination or host reboot is part of quarantine.

Before releasing workflow ownership, persist the exact run/step retirement and
conversation quarantine in the canonical application store. Apply their guards
before admission, grant construction, host operations, continuation, adoption,
boot recovery and any resumable-session lookup. Drain constructing and accepted
planner host operations. Account for the original executor's operations through
verified original-executor closure or a positively identified live-executor
barrier, as well as the consuming executor's drain. An unknown original executor,
partial drain, changed lease, pending whole-host termination preparation or
conflicting maintenance fence retains ownership. Existing restriction and
whole-host receipt versions retain their original meanings.

Consume completion and remove only the unchanged exact planner lease and explicitly
prepared logical conversation leases atomically, retaining
immutable preparation, quarantine and completion records. Consumption is
idempotent and leaves native outcome, run/attempt history, dispatch, reservations
and result artifacts unchanged. Quarantine remains even after lease consumption.
Keep the original transcript as history, but never adopt, resume or copy its
pending input into an active replacement conversation through canonical recovery.
Any subsequent conversation must start with a fresh identity and no replay of
quarantined input; opening it does not redispatch the retired workflow. Permanent
run/step denial survives new tokens, generations, gateway restart and duplicate
requests. Normal parent lifecycle and composer guards remain authoritative.

- [ ] A complete zero-admission original scope can be quarantined and its exact
      terminal planner lease consumed with parent process and unknown native
      outcome preserved. A fresh conversation can perform new canonical work
      without loading the quarantined input; unrelated sessions remain usable.
- [ ] Any admission in current or archived history, missing/corrupt history,
      mismatched routing/source/session/lease or forged authority refuses.
      Positive historical-admission controls must fail an omission mutation.
- [ ] Concurrent admission and quarantine have one ordering: an admission that
      wins causes refusal; a quarantine that wins forbids provider forwarding.
      A delayed forward or accepted host operation prevents completion until
      drained. Unknown drains keep the durable fences and original lease.
- [ ] Re-registering the same conversation with a new token or scope, daemon and
      gateway restart, native adoption, continuation and replacement-session
      replay are refused. A fresh unrelated conversation is the positive control.
- [ ] An explicitly listed dead-producer logical conversation admission is retired
      only with its trusted consumed closure, exact canonical topic and owner reset
      judgment. A changed, omitted, duplicated, current-epoch, cross-topic or
      forged closure/lease refuses; an unrelated fresh topic remains usable and
      the same retired work reference cannot replay under a new epoch or token.
- [ ] Unrelated/ambiguous affected work, pending whole-host preparation, reused
      process identity, stale completion and changed canonical lease refuse.
      Duplicate consumption and interrupted recovery preserve sibling leases,
      all history and the irreversible conversation/workflow fences.
- [ ] Consuming integration and mutation controls exercise the actual relay
      admission/forward boundary and canonical session recovery. Removing the
      archive check, atomic fence, drain, signature/identity validation, replay
      guard or exact lease transaction must fail an opposing control. Existing
      child-bound retirement and automatic unknown reconciliation remain covered.

### Prepared whole-host termination of unresolved native work

An independent host/operator authority may prepare physical recovery of an exact
native-child lease after corroborating historical local placement with retained
host journal, original request/session evidence, and the deployed local transport.
The placement evidence establishes the hosting boundary, never child completion.
An unsigned legacy dispatch is eligible for this distinct termination protocol;
it cannot acquire a fabricated original `not-submitted` receipt.

Preparation binds the full stored lease, canonical database installation,
authenticated hosting identity, evidence-bundle digest, and current kernel boot.
It commits on that same kernel boot and creates a durable scope admission gate,
including against children joining already-admitted work. Only a canonical
terminal run with its original prepared/started native dispatch attempt qualifies;
this operation does not stop live workflows or authorize a reboot.

The operator delivers the signed preparation on stdin to
`bun open/prepare-native-host-termination.ts`, running as the server's effective
UID with its ordinary install environment. The bridge uses the standard frozen
configuration and existing database, never creates or migrates one, and obtains
its pin from the same protected operator configuration as the server. It emits
only `{"status":"prepared"}` (exit zero) or `{"status":"refused"}` (exit one).
Preparation is a durable hold, not evidence of termination or reboot permission.

On startup, before native actor construction or workflow/chat replay, Open asks
the independently pinned authority for a fresh challenged boot attestation and
compares it with the local kernel. A different kernel boot on the same authenticated
host can retire an already-prepared lease. An application boot UUID, machine-id
alone, restored chat, missing process, or provider prose cannot establish this.
Authority/key provisioning must be outside worker-writable state; an
envelope cannot supply its own public key. Without authority, recovery stays held.

The standard Open entrypoint loads this capability from the fixed operator-owned
`/etc/neutron/native-host-recovery/<effective-uid>.json`, never an environment-selected
key. Its version-one object names `publicKey` (Ed25519 PEM), `hostId`, `instanceId`
(the canonical database installation), and an absolute `socketPath`. The file and
every ancestor are root-owned, non-symlink and not group/other writable. A present
unsafe or malformed configuration refuses startup. Each request rechecks the
root-owned Unix socket and its protected ancestry. The supervisor authenticates
the peer UID and authorizes it for the requested instance. One newline-delimited
`{version:1,kind:"host-boot-request",instanceId,challenge}` receives one bounded
signed envelope; Open verifies the pinned key, identities, fresh challenge and
local kernel observation. Hosting identity must be independently authenticated,
not copied solely from machine-id. Supervisor deployment owns that measurement.

The consumer records `terminated-by-host-reboot` and deletes only the unchanged
scope/generation/token/reason/producer/work-reference lease in one transaction.
Preparation is consumed once. It preserves run, attempt, result, armed-request,
and publication provenance and never redispatches work. Other unresolved leases
remain held; existing maintenance replacement fences remain independent. Invalid,
foreign, replayed, same-boot, changed-lease, or interrupted evidence cannot reopen
the prepared scope. Hosting restoration must prevent independent agent replay
before this consumer runs; configuring or enabling a daemon alone is not proof.
Ordinary completion/release cannot delete a lease reserved by pending preparation;
unrelated releases still work. Operators retain the independently protected trust
pin until its preparations are consumed. An unavailable or changed pin holds
recovery; restoring the original authority allows authenticated consumption, not
an unsigned cancellation or a replacement key supplied by the worker.

Verify: `open/wiring/__tests__/native-host-termination.test.ts`, including actual
Open startup consumption, exact-scope admission, both directions of the kernel
boot gate and atomic rollback; `open/__tests__/project-build-e2e.test.ts` remains
the consuming workflow check. `open/__tests__/native-host-recovery-authority.test.ts`
checks the protected pin, transport refusals and actual server-entrypoint wiring.
Live host attestation and reboot restoration are
separate deployment acceptance and are not established by these offline tests.

### Authenticated dead Chat ownership after host termination

The consumed host-termination operation may also identify a dead project Chat
whose historical credential fingerprint or tool profile no longer matches the
current route. This is not survivor adoption and does not relax its fingerprint
guard. The installed owner may request `POST /admin/reconcile-host-terminated-chat`
with the operation ID, exact project ID, original evidence-bundle bytes and
registry-artifact bytes. The independently signed preparation must bind the
bundle digest; the bundle must bind the registry digest and original parent
session, generation, native PID and gateway claimant. Descriptor paths are data,
never instructions to read a local file. A consumed, authenticated different-boot
observation and a fresh signed current-boot challenge are both required.

Reconciliation fences this scope's admission and refuses any unresolved lease,
current transcript owner, uncertain process census, changed historical parent,
changed pane, changed journal, active spawn or foreign workspace. Under exact
registry and workspace-journal comparisons it relinquishes only the dead
process ownership and the Chat slot. The old bare-shell tab remains visible as
history; it is neither closed nor adopted and is never relabelled a placeholder.
A registry commit followed by an interrupted journal save remains placement-
blocked; retry requires the same authenticated historical identity. A historical
marker alone grants no permission. Other projects and worker holds are unchanged.
Project existence is rechecked at the ownership commit. Releasing the request's
maintenance fence may retry a transient failure once, only while its exact
generation, token and phase remain current; a lost acknowledgement is accepted
only when that same generation is already open. Persistent failure leaves the
durable fence held, and a replacement maintenance epoch is never released.

The next ordinary authorized owner turn uses the existing launch path, resumes
the same native session, and records its genuinely launched current credential,
tool and planner profile under a new child generation. Reconciliation itself
does not edit these grants or fingerprints and preserves `capped_at`. Clearing
that cap remains the separately signed exact cap-rearm operation, against the
new generation when a real relaunch has occurred. Neither operation retries old
native work or manufactures workflow completion.

Verify both acceptance and refusal in
`open/wiring/__tests__/host-terminated-chat-proof.test.ts`,
`open/wiring/__tests__/reconcile-host-terminated-chat.test.ts`,
`runtime/adapters/claude-code/persistent/__tests__/host-terminated-chat.test.ts`,
`gateway/http/__tests__/admin-respawn-surface.test.ts` and the consuming restoration
case in `open/__tests__/project-build-e2e.test.ts`. Include same-boot signed proof,
remapped but otherwise valid shell/journal, current-owner and commit races,
interrupted journal save/retry, retained cap and old-generation cap rearm refusal.

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

**Late resolution uses the same survival decision after teardown (#674).** The callback
must retain the registry path before supervision clears, then read the current row under
the flock after resolution. Failure to establish that the row names the exact pane and
generation costs one `--resume`; it must never grant survival on an unreadable registry.
The deferred-promise cases drive real shutdown to completion before publishing the row
and resolving the spawn, so this requirement covers the reset boundary itself.

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
