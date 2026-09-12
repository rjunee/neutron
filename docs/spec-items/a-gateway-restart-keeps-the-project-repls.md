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

## Acceptance

Bidirectional throughout: an adoption path that refuses everything satisfies every
refusal criterion and delivers nothing, so each refusal is paired with the acceptance
it must not swallow.

- [ ] **A TURN AFTER THE RESTART IS SERVED BY THE SAME CHILD.** Not "a REPL answers" —
      no `claude` is launched, and the answer comes back through the surviving
      dev-channel and the surviving child's own credential.
      *Verified by* `runtime/adapters/claude-code/persistent/__tests__/adopted-repl-serves-a-turn.test.ts`
      (the assertion that carries it is `spawns === 0`).
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
      in-process hosts, quarantined children, ephemeral one-shots, and any pane no row
      names — is still killed.
      *Verified by* `__tests__/gateway-shutdown-survival.test.ts` (the verdict table and
      the teardown cases).
- [ ] **A HANDLE DESCRIBES THE CURRENT CHILD OR IS ABSENT.** A spawn whose host issues
      no handle leaves no handle on the row, even when the row carried one a moment
      before.
      *Verified by* `__tests__/pane-handle-persistence.test.ts`.

## Residual, named rather than hidden

If the registry file is **lost** between a shutdown and the next boot, the pane it
named becomes unreferenced: nothing will reap it automatically. It is still a labelled,
visible pane in herdr rather than an invisible reparented process, and the loss is
bounded at one pane per session key per registry-loss event — but it is the price of
survival, and it is not zero. A sweep that enumerates `neutron-repl`-labelled panes and
reports the unclaimed ones is the obvious next step; it is deliberately NOT taken here,
because one herdr server can host several Neutron instances and a sweep that cannot
tell another instance's pane from a leaked one must not be allowed to close either.
