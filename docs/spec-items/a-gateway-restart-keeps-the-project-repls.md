---
title: A gateway restart keeps the project REPLs, conversation and all
group: platform
status: open
priority: P0
cutover: true
legacy_ref: "GitHub issue #539 (herdr step 2c)"
---

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
