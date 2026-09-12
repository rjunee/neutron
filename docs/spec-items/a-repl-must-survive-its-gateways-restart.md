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
- [ ] **AUTHORIZATION — the caller must BE the session, not merely name it.** A
      session id is an IDENTIFIER, not a credential: `--session-id` / `--resume` publish
      it to the process table by design, and this tree's own `orphan-adoption.ts` parses
      exactly that. So no check that consults only a session id can distinguish its
      owner from a reader, however carefully the registry is maintained. The sink
      therefore authorizes CREDENTIAL → SESSION: each child is handed
      `HMAC(root token, childGeneration)` in its own 0600 config and the sink derives
      which session that is.
      *Verified by* "an orphan presenting a LIVE session's id — lifted from the process
      table — is refused", which uses a REAL id belonging to a live session, with a
      bridge and a tap wired so a 503 cannot make it pass vacuously.
- [ ] **…bound to the INCARNATION, not the session id.** Respawn-is-always-resume reuses
      the session id, so a credential keyed on the id would stay valid for the
      REPLACEMENT child — exactly the orphan-from-a-previous-generation case. A
      credential must die with the process it was minted for.
      *Verified by* "an orphan whose session has since RESPAWNED is refused, though the
      id is unchanged", which also asserts the replacement's credential works.
- [ ] **…and the LEGITIMATE child still succeeds on every privileged route**, carrying
      its own project scope. Without this the refusals above are satisfied by a sink
      that refuses everything, which trades a security hole for an outage.
      *Verified by* "the LEGITIMATE child still succeeds on every privileged route, with
      its scope".
- [ ] **Revocation is immediate**: unregistering a session kills its credential, or
      reaping an orphan (`persistent/orphan-adoption.ts`) is cosmetic while its
      credential still works.
      *Verified by* "unregistering a session revokes its credential immediately".

- [ ] **The port is per instance, not per box.** Two instances on one machine derive
      different ports; one instance derives the same port across restarts; and a port
      that cannot be bound FAILS LOUDLY rather than falling back to an ephemeral one,
      which would bake an unreproducible coordinate into every child spawned after it.
      *Verified by* the "sink port — per instance, never ephemeral" cases, and
      `classifySpawnError` mapping the bind failure to a fatal class.
- [ ] **A token path that is not a regular file is refused WITHOUT BLOCKING.** FIFO,
      directory and socket: each is replaced and the gateway starts. The non-blocking
      qualifier is the criterion, not a detail — a blocking `open` on a FIFO with no
      writer never returns, so the type check that would reject it cannot run and
      startup hangs instead of recovering. A validation downstream of an operation the
      invalid input can block is not a validation.
      *Verified by* the non-regular cases in `sink-restart-survival.test.ts`, each in a
      subprocess under a hard deadline so a hang fails AS a hang, and each asserting the
      REASON the operator is told.

      **Character and block DEVICES are deliberately outside this criterion, and are
      therefore not claimed.** Creating one needs `CAP_MKNOD`, which this suite does not
      have — measured, with a positive control: `mknod` of a character device returns
      `EPERM` for the service user while `mkfifo` on the same directory succeeds. An
      earlier revision of this criterion enumerated `device` alongside the other three
      and relegated the exclusion to a parenthetical in its *Verified by* line, which
      made the checkbox assert coverage the suite does not provide. The parenthetical
      is not the criterion; the sentence is.

      What can be said, and is only an argument: a device reaches the same
      `!st.isFile()` branch as the three verified types, through the same non-blocking
      open, which is exactly what `O_NONBLOCK` exists to guarantee for a device that
      would otherwise wait on a carrier. That is reasoning about shared code, not a
      measurement, and it does not become one by being persuasive. Closing the gap
      needs a privileged fixture; until one exists the gap stays named here.
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
today a surviving bridge is refused with **401**. Authorization runs CREDENTIAL ->
SESSION (`persistent/pool-state.ts`, `ReplSink.handle`): the lookup is `byCredential`
and it happens BEFORE body parsing and before any session lookup, so a restarted sink
that has registered nothing resolves the survivor's credential to no session and stops
there. There is no authenticated-but-unrouted state on this path and no `no-session`
404 — an earlier draft of this section claimed one, describing the shared-root-token
design this item replaced.

Adopting the survivor is the next item's work (`ISSUES #539`), and 401 is also the
right answer until then: an unadopted child is indistinguishable from an orphan, so it
must be refused until something adopts it. #539 must therefore RE-REGISTER a survivor,
not merely reconnect to it — reconnection alone leaves it refused.

WHAT THE CREDENTIAL DOES NOT CLOSE, so this item is not read as a clean bill:

  - **Same-uid read access defeats it.** The credential lives in the child's per-session
    config (dir 0700, files 0600) and in the child's process env. Anything running as
    the owner's uid that can read those can impersonate that child — which is the
    plaintext-token exposure `spawn.ts`'s owner-only note already states, and is why
    those modes are load-bearing rather than tidy.
  - **There is no kernel-supplied peer identity to check.** `SO_PEERCRED` would be the
    strongest discriminator available — an externally maintained handle the subject
    cannot rewrite — but it needs a unix socket, and the sink is loopback TCP
    (`Bun.serve({ port, hostname: '127.0.0.1' })`), where there is nothing to read.
    Moving the sink to a unix socket would change the child's transport and the two
    baking call sites; it is a real option for a later item, not a free addition here.
  - **The root token is a KEY, not a bearer credential.** It authorizes nothing by
    itself; it only derives per-child values. A process that reads the root token
    (0600, state dir) can derive any child's credential — but that process already has
    the instance's secrets.
