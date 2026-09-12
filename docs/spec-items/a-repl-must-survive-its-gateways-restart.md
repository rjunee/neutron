---
title: A REPL must survive its gateway's restart, and an orphan must not
group: platform
status: open
priority: P0
cutover: true
legacy_ref: "ISSUES #537"
---

**The linchpin of the herdr host.** A gateway restart must not strand the REPLs it
was driving, and the credential that makes that possible must not become a standing
grant for the children it no longer drives. Those two are one item because the
second is created by the first: **you cannot make a credential longer-lived without
making it narrower**, and #537 extends a lifetime.

## What was wrong

The reply sink bound `port: 0` and minted a fresh `randomBytes(24)` token per
process. Both coordinates are baked into each spawned child at spawn time — the
per-session MCP config env (`runtime/adapters/claude-code/persistent/spawn.ts`) and
the settings hooks, as a literal shell env prefix
(`runtime/adapters/claude-code/persistent/build-settings.ts`) — and the child reads
them once at startup (`dev-channel-impl.ts`) with no protocol to re-point a running
bridge. So a restarted gateway had a new port and a new secret, and every surviving
dev-channel POSTed into a dead port with a stale token. The bridge does survive a
restart: it exits when *claude's* stdio closes, which a restart does not touch when
the REPL is hosted outside the gateway process.

The same durability is the hazard. Before the fix the token died with the process,
so an orphaned `claude` from a previous incarnation was revoked for free. After it,
nothing revokes — and `/tool-call` is the most privileged route the sink has (`note`,
`dispatch_agent`, `reminders`, `project_*` all dispatch through it).

## Acceptance

Each criterion names the check that verifies it. All are bidirectional: a refusal
asserted without its paired acceptance is satisfied by a guard that refuses
everything, which is how a security fix becomes an outage.

- [ ] **RESTART SURVIVAL — the coordinates are reproducible.** A sink started, stopped,
      and started again against the same instance state dir binds the SAME port and
      presents the SAME token, and a request carrying the FIRST instance's token is
      accepted by the second.
      *Verified by* `runtime/adapters/claude-code/persistent/__tests__/sink-restart-survival.test.ts`
      — "sequential sink instances agree on port AND token".
- [ ] **…and a foreign token is still refused** (401), or the criterion above is met by
      a sink that authenticates nothing.
      *Verified by* the same test's final assertion.
- [ ] **AUTHORIZATION — a valid token does not authorize an action.** A request bearing
      a valid sink token that names a session this gateway is NOT driving is refused on
      `/tool-call`, `/activity` and `/tools`, and nothing is dispatched or recorded.
      *Verified by* `sink-restart-survival.test.ts` — "an ORPHAN with a valid token is
      refused on every privileged route". The check itself is the registered-session
      lookup at the top of `ReplSink.handle` (`persistent/pool-state.ts`).
- [ ] **…and a LIVE registered session with the same token still dispatches both**, so
      a re-adopted child keeps working.
      *Verified by* the paired test "a LIVE registered session with the same token
      still dispatches both".
- [ ] **Revocation has teeth.** Unregistering a session ends its authority immediately
      — otherwise reaping an orphan (`persistent/orphan-adoption.ts`) is cosmetic while
      its token still works.
      *Verified by* "unregistering a session revokes it immediately".
- [ ] **The port is per instance, not per box.** Two instances on one machine derive
      different ports; one instance derives the same port across restarts; and a port
      that cannot be bound FAILS LOUDLY rather than falling back to an ephemeral one,
      which would bake an unreproducible coordinate into every child spawned after it.
      *Verified by* the "sink port — per instance, never ephemeral" cases, and
      `classifySpawnError` mapping the bind failure to a fatal class.
- [ ] **A token path that is not a regular file is refused WITHOUT BLOCKING.** FIFO,
      directory, socket, device: each is replaced and the gateway starts. The
      non-blocking qualifier is the criterion, not a detail — a blocking `open` on a
      FIFO with no writer never returns, so the type check that would reject it cannot
      run and startup hangs instead of recovering. A validation downstream of an
      operation the invalid input can block is not a validation.
      *Verified by* the non-regular cases in `sink-restart-survival.test.ts`, each in a
      subprocess under a hard deadline so a hang fails AS a hang, and each asserting the
      REASON the operator is told (a device is excluded only because creating one needs
      privileges the suite does not have).
- [ ] **The token file is owner-only, and a stricter file is still usable.** A token
      granting group or other access is refused and re-minted; 0400/0500/0700 are
      accepted as they are. An exact-equality mode check fails closed against a safer
      file, which on a boot path means the gateway does not start.
      *Verified by* the two paired mode cases in `sink-restart-survival.test.ts`.
- [ ] **Concurrent CREATION converges unconditionally.** Processes creating an absent
      token at the same moment all end up presenting the value that is on disk. This
      needs no lock: the publish is one atomic `link`, so there is exactly one winner
      and every loser re-reads and adopts.
      *Verified by* the four-process creation case (subprocesses).
- [ ] **Concurrent REPLACEMENT converges WHILE THE ADVISORY LOCK IS HELD.** The
      condition is part of the criterion, because replacing an untrusted token is a
      compare-and-swap on a filename and POSIX offers none. `withFlockSync`
      (`persistent/registry-lock.ts`) runs the body UNGUARDED when Bun's FFI is
      unavailable, and in that mode a narrow window remains: if process B re-verifies
      in the instant before process A's `link` publishes, B quarantines the token A
      just published and publishes its own, so A returns a token the file no longer
      holds. Failing closed instead was considered and rejected — where FFI is missing
      it is missing always, so a replacement that refuses to proceed would mean an
      instance whose token file is invalid can never start, which is the boot-blocker
      class this item has already had to fix twice.
      *Verified by* the four-process replacement cases (one per invalid-token species)
      for the locked guarantee, and by the unlocked case below for the bounded
      degradation. Both INJECT their lock through the loader's `{ available, run }`
      seam rather than depending on the host: a test that required `flockAvailable()`
      would fail on the very host the fallback exists for, before it could test the
      fallback.
- [ ] **A region that was NOT SERIALISED is OBSERVABLE, and its outcome is bounded.**
      The condition is ACQUISITION, not capability: `flock(2)` can be unavailable (no
      FFI) or available-and-not-acquired (`withFlockSync` logs a nonzero `flock` and
      then runs the body unguarded anyway), and those two look different to a
      capability check while being identical to the guarantee. The lock seam therefore
      REPORTS whether it was held — `SinkTokenLock.run` returns `{ acquired, value }` —
      and the one-time warning fires on that, naming not "no lock" but the consequence:
      a restart can hand surviving REPLs a secret they do not have. Every process still
      returns a token that was PUBLISHED at the destination, never a private mint no
      reader could have seen. A guarantee that degrades silently is indistinguishable
      from one that holds, and a capability flag standing in for a held lock is the
      same defect one level up.
      *Verified by* "a region that was NOT SERIALISED says so, and its weaker outcome
      is bounded", its paired "the LOCKED path converges AND says nothing" — the second
      is what stops
      the first from being satisfied by a warning that always fires.

## What this item does NOT claim

Durable coordinates are a PRECONDITION for adopting a surviving REPL, not the
adoption. Nothing here re-registers a surviving REPL into the sink's session map,
and `persistent/pool.ts` needs an in-memory `session.channelPort` to inject, so
today a surviving bridge authenticates and then lands on 404 `no-session`. That is
the next item's work (`ISSUES #539`), and after the authorization criterion above it
is also the right answer: an unadopted child is indistinguishable from an orphan, so
it must be refused until something adopts it.

A PER-SESSION credential is the stronger shape and is deliberately out of scope: it
is a larger change, and narrowing authorization gets the property now. The residual
it would close is that any live child's token is accepted for any live session id —
the sink checks that the caller names a session it drives, not that it names its OWN.
