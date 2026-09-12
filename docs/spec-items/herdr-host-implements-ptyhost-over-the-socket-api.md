---
title: HerdrHost implements PtyHost over the herdr socket API
group: platform
status: open
priority: P0
cutover: true
legacy_ref: "GitHub issue #538 (herdr step 2b)"
---

The in-process `Bun.Terminal` backend (`bun-terminal-host.ts`) is replaced by a
`HerdrHost` implementing the same `PtyHost` interface over herdr's unix-socket
API. `bun-terminal-host.ts` is **deleted**, not left beside the new backend: no
feature flag, no dual code path.

## The central design problem: what scopes a turn when the ring is a screen

herdr has no raw output stream. Measured on the live server 2026-09-12 (herdr
0.8.2, protocol 20): 91 methods, and `pane.output_changed` is **not
subscribable** — `events.subscribe` rejects it as an unknown variant, and
`events.wait` rejects it with `unsupported_event_wait_match` ("events.wait
currently supports pane agent status matches") even though the schema declares it
in both `EventKind` and `EventMatch`. So `onData` cannot be forwarded; it must be
**synthesized by polling `pane.read`**.

Two bridge shapes exist and they break opposite invariants:

- **diff-append** keeps `PtyRing` a byte stream, so `textSince` still works — but
  it breaks the detector falling edge at `output-scan.ts:210-213`. A cleared menu
  appends nothing, so `present` never goes false and the latch never drops.
- **snapshot-replace** makes the falling edge correct (a cleared pane *is* a
  screen without the menu) — but it destroys `PtyRing.textSince`
  (`pty-ring.ts:89-93`), which scopes a turn by **character count**: `textSince`
  returns the last `(totalAppended - mark)` characters. Under snapshot-replace a
  screen re-rendered unchanged would advance `totalAppended` by a full screen
  each poll, so `textSince` would return the entire screen forever — killing the
  stale-banner guard it exists to provide.

**Snapshot-replace is taken, and `textSince` is fixed.** This is not a
workaround: `spawn.ts:336` already names "a rendered-screen ring" as the proper
substrate-level fix for the limitation it documents at `spawn.ts:327-338` (a
just-approved prompt's text lingering in the bottom-N window because the ring is
an append-only byte log).

**The fix: the mark carries a baseline screen, not a character count.** On a
screen ring "what is new" is only answerable against a baseline, so `mark()`
returns an opaque `RingMark` holding the screen as it read at the turn boundary,
and `textSince(mark)` is an **order-preserving multiset difference** of the
current screen's lines against that baseline's lines: walk the current screen top
to bottom, and emit a line only once the baseline's remaining count for that
exact line is exhausted.

Why a multiset and not a set: an identical line can legitimately recur. A banner
that was on screen at the mark and is printed *again* this turn appears twice now
and once at the mark, so exactly one copy is new — a set difference would
suppress it and blind the detector. Why order-preserving: the consumers
(`spawn.ts:453`, `types.ts:113-116`) feed the result to `buildDetectorContext`,
which applies a bottom-N line slice and the doc-quote guard, both positional.

This is **strictly stronger** than the byte-count version for the case that
motivated it: a line already on screen at the mark is excluded no matter how
little output has arrived since, whereas the byte-count version only excluded it
once enough bytes had arrived to push it past the mark offset — which is exactly
the `spawn.ts:327-338` limitation. It is weaker in one scoped way: a line that
was on screen at the mark, scrolled off, and returned unchanged reads as
not-new. That is accepted and recorded here rather than hidden.

## What herdr cannot express, and what was done about it

- **No exit codes exist anywhere in herdr.** `pane.exited` carries exactly
  `{type, pane_id, workspace_id}` — verified against the live schema. So
  `PtyChild.exited` resolves **`null`** (the interface's existing "died on a
  signal, no code" value), never a number. `null` is the only honest value, and
  it is also the only one that preserves behaviour: `spawn.ts:565` classifies via
  `!killedByUs && exitCode !== 0`, which with `null` keeps crash-vs-recycle
  decided **entirely by `wasKilledByUs`**. Resolving `0` instead would silently
  route every real crash to `unregister()` and blind the crashed-agent detector.
  The exit-code half of that condition therefore **stops carrying information**
  and is pinned by a test so no later reader infers a meaning that is not there.
- **`pane.resize` cannot set cols × rows.** It takes `{direction, amount}` — it
  nudges a split ratio; herdr owns pane geometry. `PtyChild.resize` becomes
  **optional** (the pattern `writeKey?`/`wasKilledByUs?` already established in
  this interface) and `HerdrHost` does not implement it. It has **zero production
  callers**, so nothing is narrowed. `PtySpawnOpts.cols`/`rows` are documented as
  advisory and ignored by this backend.
- **`send_text` never submits.** A literal `\r` does not fire at a prompt. So
  `write()` **refuses** data containing `\r` or `\n` and names
  `writeKey('enter')` in the error, converting a silent never-submits into a loud
  refusal; `writeKey`/`writeKeys` are the honest sibling that does submit. The
  three production call sites become text-then-`enter`-key.
- **A pane vanishes on exit, taking its output.** The ring is the only record of
  a dead REPL's last output, so a poll that **errors** is dropped, while a poll
  that **succeeds and returns an empty screen** is delivered (that is a genuinely
  cleared pane, and the falling edge depends on it).

## Measured constraints (live server, 2026-09-12, herdr 0.8.2 / protocol 20)

- Poll **≤ 250 ms**, forced by the 900 ms idle gate (`DEFAULT_IDLE_QUIET_MS`,
  `signatures.ts:124`) that `waitForReplIdle` (`spawn.ts:1128-1134`) runs before
  every inject from `pool.ts:553`. A poll interval at or above the quiet window
  would let a continuously-emitting REPL look idle between observations.
- `pane.read` hard-caps at **999 lines** regardless of `lines` (`lines=5000`
  returned 999, `truncated: true`).
- `lines=N` counts **blank viewport rows before trimming**: on a pane with three
  content lines and a 62-row viewport, `recent_unwrapped lines=10` returned
  **empty** while `lines=200` returned all three. So requests are
  `viewport_rows + wanted`, with `wanted` = 200 = the largest detector window
  (`DISCLAIMER_BOTTOM_N`, `signatures.ts:78`).
- `revision` is **inert**: hardcoded `0` on every `pane.read`. Our own poll
  sequence is minted instead.
- Key names use `+`: `ctrl-c` is **rejected** on the wire (`invalid_key:
  unsupported key ctrl-c`). Our internal `Key` union is literally `'ctrl-c'`
  (`keystrokes.ts:31`), so the mapping must translate it.
- **`layout.apply` genuinely execs** `LayoutNode.command`: `pane.process_info`
  reported `shell_pid` equal to the argv's own pid, with the argv itself as
  `foreground_processes[0]`. `agent.start` is not used — it shell-quotes argv and
  types it into a running shell, and its `kind` is a compiled-in enum.
- **`layout.apply` replaces the tab and mints new ids**: applying to `w6:t2`
  returned `tab_id: w6:t3` with a new `pane_id`. Ids are read from the response,
  never assumed.
- The socket server does **no** version check (only the CLI guards), and protocol
  went 20 → 22 in 19 days. So the client `ping`s, compares, and **fails loudly**.
- An unparseable request comes back with `id: ""`, so id-correlation alone would
  hang forever on a malformed frame.

## Acceptance

- [ ] `bun-terminal-host.ts` is gone, with no second backend beside `HerdrHost`.
      A grep proving absence needs its positive control in the same run, or it
      proves nothing.
      verify: `rg -n "bun-terminal-host|BunTerminalHost" --type ts` finds nothing
      while `rg -n "herdr-host" --type ts` finds the new backend.
- [ ] The client `ping`s and **fails loudly** on a protocol mismatch, naming both
      the expected and the received number. A client with no check at all passes
      the matching case, so assert the **mismatch** case separately: a stub server
      reporting protocol 21 must make `spawn` reject, and 20 must not.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] `PtyChild.exited` resolves `null` and **never a number**, and crash-vs-recycle
      is decided by `wasKilledByUs` alone. Assert both halves against the *same*
      `null` exit: `killedByUs: false` must `markCrashed()`, `killedByUs: true`
      must `unregister()`. An implementation resolving `0` gets the recycle case
      right and the crash case wrong, so the recycle case alone is not a criterion.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-no-exit-codes.test.ts`
- [ ] `textSince` scopes a turn against a **baseline screen**, not a character
      count. A steady screen yields `''`; a line present at the mark and still
      present is **excluded**; a genuinely new line is included; a line present
      once at the mark and twice now yields **exactly one** copy. An
      implementation returning the whole current screen passes the "new line"
      case, so the two exclusion cases carry the criterion.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/pty-ring.test.ts`
- [ ] The detector **falling edge** works: a pane whose menu signature is present
      and then cleared drives `present` false, dropping the latch
      (`output-scan.ts:210-213`). A diff-append bridge passes the rising edge and
      fails exactly this, so the rising edge alone is not a criterion.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] The poll bound is pinned as a **value and a relation**, and so is the
      constant it is bounded by — a test asserting only `poll < quiet` is blind to
      either constant moving. Assert `HERDR_POLL_INTERVAL_MS === 250`,
      `DEFAULT_IDLE_QUIET_MS === 900`, and that the former is strictly less.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-poll-bounds.test.ts`
- [ ] The read request is `viewport_rows + wanted`, with the **values** pinned:
      `HERDR_READ_WINDOW_LINES === 200`, equal to `DISCLAIMER_BOTTOM_N`, and the
      total provably under the measured `999` cap. Assert the request actually
      sent carries the viewport allowance — a host that requests a bare `200`
      returns empty on a cleared pane, which is the defect this rule exists for.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-poll-bounds.test.ts`
- [ ] A **steady** screen produces no repeat callback, so `lastDataAt` stops
      advancing and `waitForReplIdle` can resolve; a screen changing every poll
      never yields 900 ms of quiet. A host that fires on every poll regardless of
      change gets a steady screen's *text* right and this wrong.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] A poll that **errors** (pane gone) does **not** replace the ring, so a dead
      REPL's last output survives; a poll that **succeeds** with an empty screen
      **does** replace it, so a cleared pane still drops the latch. Both, or the
      pair is not pinned: `try { read } catch { emit('') }` satisfies either one
      alone.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] `write()` **refuses** `\r`/`\n` and names `writeKey('enter')`; the honest
      sibling is shown to work in the same test (a refusal with no writable
      alternative is a deadlock, not a safeguard). All three production call sites
      (`pool.ts:464`, `context-reset.ts:229`, `session-size-watchdog.ts:327`) send
      text then an `enter` key.
      verify: `rg -n "write\(.*\\\\r" runtime/adapters/claude-code/persistent --type ts` finds no production call site
- [ ] Key names cross the wire with `+`, pinned **per key by value** — at minimum
      `'ctrl-c'` → `'ctrl+c'`, since that is the one our own `Key` union spells
      with a hyphen and the live server rejects.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-keys.test.ts`
- [ ] Nothing is built on `pane.output_changed` — and after the transport rewrite nothing
      is built on herdr EVENTS at all. The only permitted `output_changed` hit is the
      `herdr-host.ts` docstring recording WHY it was refused; a grep that simply finds
      nothing would also pass against a tree where the reasoning had been deleted, so the
      criterion is "one hit, and it is prose".
      verify: `rg -n "output_changed" runtime --type ts` returns exactly the
      `herdr-host.ts` comment, and `rg -n "call\('events\." runtime --type ts` returns
      NOTHING, against the positive control `rg -n "call\('pane\." runtime --type ts`
      which finds the 8 request sites that ARE used.
- [ ] The `sendKey`/`sendKeys` byte fallback is provably unreachable for the real
      backend: `HerdrHost`'s child provides BOTH `writeKey` and `writeKeys`. The
      fallback writes `encodeKey('enter')` = `\r`, which this backend's `write()`
      refuses, so a child missing either method would throw on the scan path. Assert
      the pin AND that the fallback would in fact throw — the pin alone reads as
      arbitrary without it.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-keys.test.ts`
- [ ] **Submitting a slash command is mandatory, and its absence is a refusal.** A
      `PtyChild` with no `submitLine` must make the reset report `{status:'failed'}`,
      never `{status:'reset'}` — and must write nothing rather than leave the command
      typed at the prompt. The refusing child must still provide `write` AND
      `writeKey`: what is refused is the UNACKNOWLEDGED seam, not the keyless one, and
      a child that cannot press enter makes the criterion satisfiable by any
      implementation that merely needs a key. Assert the CONTROL too (the same session
      WITH `submitLine` resets and submits), or "failed" could be coming from the
      harness.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/context-reset-sweep.test.ts runtime/adapters/claude-code/persistent/__tests__/herdr-keys.test.ts`
- [ ] **An actuation whose success is REPORTED is awaited and acknowledged.**
      `submitCommand` must resolve only after the backend has acknowledged BOTH the
      text and the Enter, and reject if either is refused — including the partial case
      (text accepted, Enter refused), which is precisely the state a fire-and-forget
      pair reports as a completed reset while the command sits unsubmitted at the
      prompt. A refused text must not be followed by an Enter, or the submit lands on
      whatever the prompt already held. Three cases or none: text-refused,
      Enter-refused, and the control where both succeed — any two of the three are
      satisfied by an implementation that rejects unconditionally or awaits only one
      half. The control must NOT poll for the calls: `await`ing and then asserting the
      call log is the only form that can tell "resolved after acknowledgement" from
      "resolved immediately".
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-keys.test.ts`
- [ ] **A reset that did not happen is never recorded as one, on EITHER caller path.**
      `context-reset.ts` reports `{status:'failed'}` with the backend's reason;
      `pool.ts`, whose policy is log-and-proceed, emits the operator-visible
      `context-reset /clear failed` line carrying that reason and still completes the
      import. The pool case needs the paired control (an accepted submit reports
      nothing), because a path that reports every reset as failed is exactly as blind
      as one that reports none — and because "the import still completed" is satisfied
      by the defect itself.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/import-warm-session-reset.test.ts runtime/adapters/claude-code/persistent/__tests__/context-reset-sweep.test.ts`
- [ ] **Exit settles only on CONFIRMED closure, and a failed close latches nothing.**
      A rejected `pane.close` must leave `exited` unresolved, `hasExited()` false,
      `exitCause()` undefined and `wasKilledByUs()` false — the pane is still there, so
      every one of those is the truth. Asserting the flags alone is not a criterion: an
      implementation that settles early gets the eventual state right and still leaks
      the process, because `terminateChild` returns at both of its `hasExited()` guards
      (`repl-session.ts:361,370`). So pin the CONSEQUENCE — drive `terminateChild`
      against a close that fails once and then succeeds, and require TWO `pane.close`
      calls and a pane that is actually closed. Control: a successful close settles,
      latches, and closes.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **Inbound buffering is linear in bytes — now by CONSTRUCTION, and the measured load
      case is retired with the shape it policed.** The frame cap bounds RETENTION and says
      nothing about CPU, which is the resource a fragmenting peer actually exhausts. Three
      rounds of defects lived here — re-copying the accumulation, a `subarray` leftover
      whose view pinned its whole 2 MB parent while its logical length truthfully reported
      1, and an unbounded allocation COUNT — and each was answered by narrowing a
      behaviour. The transport rewrite answered the class instead: ONE growable buffer per
      call, doubled in place, each delivered chunk copied in exactly once and dropped,
      nothing concatenated, nothing retained as a view, and the buffer discarded with the
      connection that owns it. A quadratic variant is no longer expressible without
      reintroducing an accumulation list. The 200k×8-byte load case (44 ms against
      21,433 ms for the quadratic mutant on the reference host) is therefore RETIRED
      rather than silently dropped, and this criterion records that it was, and why.
      What holds the property now: reassembly of a frame delivered one byte at a time
      asserting the exact decoded content, and the absence of the operations that made the
      old defects possible.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
      and `rg -n "concat|subarray" runtime/adapters/claude-code/persistent/herdr-client.ts`
      returns nothing, against the positive control `rg -c "Buffer\." <same file>` which
      finds the 3 buffer operations that ARE there — so the empty result is an absence in
      a file the pattern can reach, not a mistyped path.
- [ ] **The output gate fails open AND loudly — both halves asserted.** "The screen
      eventually arrived" is IMPLIED BY failing open and says nothing about loudly, so a
      test asserting only delivery passes with the warning silenced. Capture stderr and
      require exactly one warning that names the caller's wiring bug and the consequence,
      paired with the control that a timely `beginOutput()` emits none. The control is
      protected by two guards (`beginOutput` clears the timer; the timer checks
      `released`), so only a mutation disabling BOTH shows it discriminates.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **The frame limit is enforced BEFORE the allocation it exists to prevent.** The
      bound exists to stop us allocating for a reply we will not accept, so it cannot run
      after the allocation it guards: the check is `end + chunk.length > max` taken on the
      INCOMING chunk, before the grow-and-copy. The "many valid frames in one delivery"
      case that used to sit here is gone with the multiplexing client — one connection
      carries one reply — and what remains needs BOTH directions or either is satisfied
      alone: an over-cap reply accumulated across deliveries refused with nothing copied,
      and a reply EXACTLY at the cap accepted, because a bound that rejects a legitimate
      maximal frame is a new failure mode rather than a fix.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **One request, one reply, one connection — and no persistent socket anywhere.**
      MEASURED on herdr 0.8.2 / protocol 20: the server answers exactly ONE request per
      connection and then closes it (two pings pipelined in the same tick get one reply,
      socket gone 1 ms later; sending again raises a broken pipe). A persistent
      multiplexing client is therefore not a design choice, it is a design that cannot
      execute — and no test could have said so, because every fake modelled a persistent
      connection and the live proofs are opt-in and skipped in CI.
      COST, measured not estimated: **2.02 ms per call** (mean of 60: connect + send +
      reply + close over the unix socket). At the 250 ms poll interval that is ~0.8% of
      one REPL's wall clock, and the poll is one call per tick.
      What must be DELETED rather than left unreachable, because there is no long-lived
      socket: the transport-loss exit cause, post-close dispatch, teardown-of-pending,
      the event envelope, `events.subscribe`, and the `pane-exited` cause. Exit is
      discovered by polling `pane_not_found`, which cannot be missed while nobody is
      listening, cannot be replayed (a fresh subscriber IS delivered recent exits —
      measured), and cannot arrive for another pane.
      The version gate moves to ONE `ping` at spawn rather than per call: pinging every
      call would double every operation, and the server's protocol cannot change under a
      running host without restarting herdr, whose panes are its children.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **There is no "transport loss" to handle, and the criterion that described one is
      DELETED rather than left standing.** It required the host to terminate the pid it
      learned at spawn when the socket died. Both halves are gone: a connection ending is
      how EVERY exchange ends now, so it carries no information about the child, and PID
      signalling was deleted a round earlier because a pid is an identifier, not a handle
      (`pane.process_info` carries no start time at this protocol, so the reuse window
      cannot be closed by re-reading). What survives it is stated above and below — exit
      settles only on CONFIRMED closure, and only a typed `pane_not_found` proves absence.
      A criterion still demanding a kill path would contradict the one-connection
      criterion two entries up, and a contradicted criterion is worse than a missing one.
      verify: `rg -n "transport-lost" runtime/adapters/claude-code/persistent/pty-host.ts
      runtime/adapters/claude-code/persistent/herdr-host.ts` returns exactly ONE hit, and
      it is the `pty-host.ts` prose recording the deletion — the same "one hit, and it is
      prose" shape used for `output_changed`, because a grep finding nothing would also
      pass against a tree where the reasoning had been deleted. Paired with
      `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
      for what replaced it.
- [ ] **Every live caller performs the readiness handshake.** Each converted E2E proof
      must call `beginOutput()` after wiring its consumers, and at least one live
      boundary test must assert NO fail-open warning across the whole run. Without it
      the opt-in proofs wait out the 5 s gate, trip the "WIRING BUG" warning and
      normalise the fail-open — a guard can be thoroughly unit-tested while every real
      caller sits on the wrong side of it, and only a live assertion catches that.
      verify: `grep -c 'beginOutput' runtime/adapters/claude-code/persistent/__tests__/dev-channel-pty-bind.e2e.test.ts runtime/adapters/claude-code/persistent/__tests__/ritual-write-containment.e2e.test.ts reminders/bundled-rituals.e2e.test.ts` — each ≥ 1
- [ ] **A SETTLED CALL accepts nothing further.** There is no `close()` and no client
      flag to consult any more; what replaces both is that settlement is once-only and
      bytes arriving after it are DROPPED rather than accumulated. A second complete
      frame in the same connection must leave the FIRST result standing and must end the
      socket exactly once — once per settlement, not once per delivery. RECORDED because
      it changes how the case must be mutated: the two guards (`if (settled) return` in
      `onBytes`, and again at the top of `finish`) are redundant, so each absorbs the
      other and neither survives alone as a single mutation. Only the COMBINED mutation
      reddens, and the criterion is the pair rather than either line.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **The `closed`-flag sweep is DELETED with the flag.** It required every entry point
      of a long-lived client to consult `closed`, and a rejected `subscribe` to leave no
      handler behind. There is no long-lived client, no shared flag and no subscription:
      a client is one connection, and its only state is one call's settlement. The
      surviving obligation is the entry above. Kept as a deletion record rather than
      quietly dropped, because "walk the surface as a class" is the habit, not the flag.
      verify: `rg -n "isClosed|closed = " runtime/adapters/claude-code/persistent/herdr-client.ts`
      returns nothing, against the positive control `rg -c "settled"` on the same file,
      which finds the 7 uses of the per-call state that replaced it.
- [ ] **A settled terminal state is IMMUTABLE.** No later path may rewrite `exitCause`,
      `hasExited()` or `wasKilledByUs()` once the exit has settled — including the
      rejection of an RPC that the settlement itself caused — a poll already in flight
      when the pane vanishes rejects AFTER the exit has settled. The assertion must be
      taken AFTER the last handler runs: releasing the held call and draining a macrotask
      turn, then re-asserting. Asserting while the call is still held measures an
      intermediate state and passes with the defect present. Pair it with the case that
      the flag DOES still clear while the child is unsettled, or "immutable" is satisfied
      by never clearing it at all — which re-breaks the failed-close requirement above.
      Note the fake must be able to FAIL a method while a call is in flight, as the real
      server does when the pane goes; a forgiving fake makes this defect invisible
      (verified: host defect plus forgiving fake is green).
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **A pane that VANISHES while OUR close is in flight is ours.** The event form of
      this race is gone with the subscription, but the race is not: the poll can observe
      `pane_not_found` while our own `pane.close` is still unanswered. With the close
      genuinely held mid-flight the vanishing must classify as intentional
      (`wasKilledByUs()` true); with no kill in flight the same vanishing must classify as
      a crash. The held-call form is load-bearing — a fake that answers instantly
      collapses the in-flight window to nothing and makes the property vacuous — and the
      crash control is what stops a flag that is simply always true.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **The read cap is enforced AT its boundary, in both directions.** The request
      must clamp to `HERDR_READ_LINE_CAP` at a viewport of
      `HERDR_READ_LINE_CAP - HERDR_READ_WINDOW_LINES + 1` (= 800) and must NOT clamp
      at 24 — a guard that caps every request satisfies the first and fails the
      second, and viewports of 24/62/120 alone prove nothing about the boundary. The
      shrunken content window must be reported, not silently absorbed.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-poll-bounds.test.ts`
- [ ] **A failed spawn leaves no pane running.** Every initialization failure AFTER
      `layout.apply` returns — at this version, the pid never arriving — must send
      `pane.close`; the obligation starts when the pane exists, not when
      the spawn succeeds. Assert the opposite direction too: a failure of
      `layout.apply` ITSELF must close nothing, and a successful spawn must close
      nothing, or a cleanup that fires unconditionally passes.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **The viewport is re-read, not cached for the life of the pane.** A pane
      resized after the first read must change the `lines` requested — assert BOTH
      growth and shrinkage, because an over-large request still returns content and
      a refresh that only fires upward would pass a growth-only test. A viewport that
      stops being readable keeps the last MEASURED height, not the fallback constant.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-poll-bounds.test.ts`
- [ ] **A short write is terminal, not a hang.** `write` returns bytes ACCEPTED; a
      socket taking 0 or half a frame must FAIL the call and end the connection, because
      the server frames on newlines and a truncated request can never be answered. The
      comparison must be against BYTE length — comparing
      `String.length` is too lax for non-ASCII, so a test must land in the gap
      (accepted > UTF-16 units, accepted < bytes) and prove the gap is real. The fake
      transport must NOT return `d.length` unconditionally, or the class is
      unreachable by construction.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Every bound in `pty-ring.ts` is UTF-8 BYTES, never UTF-16 code units.** An
      all-ASCII test cannot tell the two apart, so the criterion is multibyte:
      `'é'.repeat(400_000)` (400k units, 800k bytes) must be clamped under a 512 KiB
      cap, a multibyte screen that genuinely fits must be retained WHOLE, the clamp
      must cut on a character boundary (no U+FFFD, astral characters unsplit), and
      the drop loop must keep the MAXIMAL fitting tail — a bound-only assertion
      passes for an implementation that discards everything.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/pty-ring.test.ts`
- [ ] **Only a typed `pane_not_found` proves a pane is gone.** A transient rejection
      — timeout, temporary server error — must NOT settle the child, and the bridge
      must recover when it clears. Assert the control too: a typed not-found DOES
      settle with `'pane-vanished'`, or an implementation that never concludes
      absence passes.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **A malformed inbound frame fails the call, and cannot poison the next one.** The
      old second half — "a later call is refused without reaching the wire" — was a
      property of a shared connection and is DELETED with it. Its replacement is stronger
      and is the reason the one-connection shape is safe: the next call is a new
      connection, so a stream whose position is no longer known is discarded rather than
      resynchronised. Control: a well-formed frame resolves normally on an otherwise
      identical fake, or a client that failed every frame would pass.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Closing the socket is an ACTION, reached by every route — including the healthy
      one.** Every terminal route ends the connection exactly once: a malformed frame, a
      short write, a THROWN write, a deadline, a close before the reply, AND a successful
      call. The control INVERTED with the transport: it used to be "a healthy exchange
      ends the socket zero times", and it is now "a healthy exchange ends it exactly once",
      because the connection is per call and leaving it to the GC leaks a descriptor per
      request. Assert the observed `end` count, never a flag: the flag is the symptom, and
      asserting it cannot distinguish a close from a relabelling.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Inbound bytes are decoded exactly once, at a known-complete boundary.**
      `onBytes` takes bytes, buffers bytes, and decodes one complete line. A
      multi-byte character split across chunks must decode exactly — tested at EVERY
      interior byte boundary of a frame and again one byte per delivery, asserting
      the exact decoded content. A "the JSON parsed" assertion is what made the
      per-chunk decode silent, so it is not a criterion.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Every bytes↔string boundary in the diff tells one story.** The sweep is not
      for `.length`: it is for every place a byte sequence becomes a string or the
      reverse, since the defect has appeared in both directions and in a length
      comparison.
      verify: `rg -n "toString\(|Buffer\.from|Buffer\.byteLength|TextDecoder|TextEncoder" runtime/adapters/claude-code/persistent --type ts`
- [ ] **Every RPC is bounded by its own clock, and the deadline can fire before the
      socket even exists.** A peer that accepts the whole frame and never replies must
      fail the call and end the connection, INCLUDING the spawn-time handshake `ping` (an
      unbounded wait there means the gateway never starts). Assert the opposite direction
      too: a reply cancels the clock, so a healthy connection is not failed — a timeout
      that always fires would pass the first case alone. And assert the ABSENCE the shape
      depends on: the deadline can fire while the connect is still in flight, which is a
      window in which nothing yet holds the call's promise. The call therefore settles by
      RESOLVING an outcome record and never by rejecting one, because an unobserved
      rejection is fatal under Bun's process net (`logger/fire-and-forget.ts` states the
      policy). The test registers an `unhandledRejection` listener and requires both the
      right error and an EMPTY listener log — asserting the error alone passes with the
      hazard present.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Only TERMINAL operations latch `wasKilledByUs`.** `kill('SIGINT')` is an
      interrupt, not a termination: it must leave `wasKilledByUs()` false, record
      `wasInterruptedByUs()` instead, and an unexpected exit afterwards must classify
      as a CRASH through the expression `spawn.ts` evaluates. Assert the control — a
      terminal kill still latches and still reads as clean — or an implementation that
      never latches passes. herdr has no exit codes, so this flag is the entire
      discriminator; a test asserting the child is alive AND killed-by-us is
      documenting a contradiction rather than refusing it, and is not a criterion.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-keys.test.ts`
- [ ] **The event-envelope `data` criterion is DELETED with the events — but its RULE is
      not, and moved to the reply envelope.** It required each way of not being an object
      (absent, `null`, an array, a bare string, a bare number) to be its own case, because
      they take different branches and a partial check passes some while failing others,
      with the control that a genuinely empty `{}` stays VALID. There are no events to
      validate. The same discipline now covers `result`/`error` in the reply envelope,
      fifteen cases plus the empty-result control — see the envelope criterion below.
      Recorded rather than dropped so the rule is not re-learned from the same defect.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
      — the fifteen envelope cases plus the empty-result control are where the rule lives now.
- [ ] **No document still mandates the deleted backend.** Deleting a backend is
      narrowing a guard, so every document asserting the old rule is fixed in the same
      change — above all the per-directory `runtime/adapters/claude-code/AGENTS.md`,
      which is injected into the next agent's context and whose "It MUST spawn…"
      sentence named the Bun-native PTY. The sweep must be decided PER FILE, because
      three outcomes are all legitimate and different: a live reference to a deleted
      backend is a defect; a dated historical statement (an archive, a `HISTORICAL
      NOTE`, a record of where a bug was reproduced) is correct AS HISTORY and must
      survive; a docstring describing a mechanism its own body no longer uses is
      misleading and gets corrected. A blanket find-and-replace fails this criterion
      by destroying the second category.
      verify: `grep -rniE 'bun[-. ]?terminal|Bun-native|Bun PTY|Bun\.spawn\(\{ ?terminal' --include='*.ts' --include='*.md' .` — every surviving hit is an archive, an explicitly dated historical note, or unrelated to the REPL backend
- [ ] **A reply carries EXACTLY ONE well-formed outcome.** `result` and `error` must
      each be a plain object; a primitive, `null`, an array, a missing outcome, and BOTH
      outcomes present all reach the malformed-frame teardown. Presence of the key is
      not a criterion — that was the defect: a string `error` passed the presence check,
      failed the object conversion in the dispatcher, skipped the error branch and
      RESOLVED the call with `{}`, so a refused `pane.close` was reported to `kill()` as
      acknowledged. Each shape listed and mutated individually, and paired with the
      control that an EMPTY `result:{}` stays a valid success — `{}` is what the client
      used to invent, so requiring "a usable outcome" must not become "a non-empty
      outcome". The invariant must be carried by the TYPE (a discriminated outcome), not
      by a comment: if the success path can still be written with a `?? {}` fallback,
      the next refactor restores the bug.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **No coercion turns an unknown into a value indistinguishable from a real one.**
      Swept by class, not by instance: every `??`, `||` and unchecked cast in the client,
      host, protocol, ring and signatures, each asked whether its default could be
      confused with a legitimate value of that type. Where a default is genuinely needed
      and genuinely ambiguous it stays and becomes AUDIBLE exactly once — the assumed
      viewport (120 guessed is indistinguishable from 120 measured) and a `pane.read`
      that succeeds with an unusable payload. Both need the pair: a control that a
      MEASURED viewport of the fallback's own value says nothing, and a control that the
      malformed-read skip is not a latch (the loop recovers when the payload becomes
      usable). A criterion that only checks the warning appears is satisfied by warning
      unconditionally, which carries no information.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **The fake can fail, stall, AND answer unusably.** `failMethod`, `holdMethod` and
      `malformMethod` are first-class per-method levers, because each corresponds to a
      requirement class that is otherwise untestable and therefore silently unmet — a
      successful call with an unusable payload is not an error and not an answer, and it
      is how a same-version reply-shape drift arrives. Each lever must itself be mutated:
      if disabling it changes no test, the tests that depend on it were passing for some
      other reason.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/`
- [ ] **A frame that PARSES but matches no envelope FAILS the call.** "Malformed" must be
      defined by the protocol's requirement, not by the parser throwing: `null`, `[]`,
      `{}`, bare primitives, an id with no outcome and an outcome with no id all have to
      fail the same way, and none may throw out of `onBytes`. The clock must be LONG
      enough that the deadline cannot be what failed the call — with a short one the
      timeout fails it anyway and the test passes without the validation existing (M53
      survived exactly that way), so each case asserts the ENVELOPE message rather than
      merely that something rejected. Control: both legitimate envelopes still work, or a
      validator that rejects everything passes.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Inbound framing is size-bounded.** A peer that never sends `0x0A` must be torn
      down rather than buffered to exhaustion — this is the UNDECLARED half of the
      protocol-drift risk the `ping` gate covers only when the server announces it.
      Test exactly AT the limit (a legitimate maximal frame must still complete — a
      bound that rejects one is a new failure mode), one byte over, and accumulation
      across MULTIPLE deliveries so the limit is on what has gathered rather than on any
      one chunk.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **No screen is delivered before the caller's consumer can exist.** The host must
      not poll at all until `beginOutput()`, and the criterion is **a first screen that
      already carries a detector signature, with the scanner registered after `spawn`
      resolves** — snapshot-replace never re-delivers an unchanged screen, so a startup
      trust prompt missed once is missed for the child's life. The window must be widened
      deliberately in the test: with a synchronous post-await wiring and an
      immediately-resolving fake, removing the gate still passes. Assert the fail-open
      too (a forgotten call delivers LATE, never never) and idempotence.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **The frame bound runs BEFORE the frame is copied, decoded or dispatched.** A guard
      after the thing it guards is not a guard — an earlier round checked the remaining
      UNTERMINATED bytes and let every oversized frame that arrived with its newline
      through, and a later one ran the check after the grow-and-copy it exists to prevent.
      The "oversized frame followed by a valid one" case is gone with the shared
      connection (there is no resynchronisation to prove, and no second frame to accept).
      What remains: an over-cap reply refused with nothing copied, and a COMPLETE reply
      exactly at the limit accepted.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] `resize` is optional on `PtyChild` and unimplemented by `HerdrHost`, with
      the reason recorded — not a silent no-op that reports success.
      verify: `rg -n "resize" runtime/adapters/claude-code/persistent/pty-host.ts`
