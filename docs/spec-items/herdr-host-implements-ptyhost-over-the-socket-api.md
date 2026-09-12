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
- [ ] Nothing is built on `pane.output_changed` — no `events.subscribe` or
      `events.wait` names it. The only permitted hit is the `herdr-host.ts` docstring
      recording WHY it is refused; a grep that simply finds nothing would also pass
      against a tree where the reasoning had been deleted, so the criterion is "one
      hit, and it is prose".
      verify: `rg -n "output_changed" runtime --type ts` returns exactly the
      `herdr-host.ts` comment, while the positive control
      `rg -n "pane.exited" runtime --type ts` finds the subscription that IS used.
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
- [ ] **Inbound buffering is linear in bytes, not quadratic in deliveries.** The frame
      cap bounds RETENTION and says nothing about CPU, which is the resource a
      fragmenting peer actually exhausts — one-byte deliveries against an 8 MiB cap force
      ~35 TB of copying before the cap trips. Neither the append nor the frame loop may
      re-copy the accumulation. The single-chunk boundary cases cannot see this: what
      distinguishes the implementations is the number of DELIVERIES, so the case must
      fragment. The load must be chosen by MEASUREMENT and the margin recorded — a first
      attempt at 200k×1 byte under 4 s let the quadratic mutant pass; at 200k×8 bytes the
      separation is 44 ms against 21,433 ms on the reference host. Pair it with proof the
      work was done rather than skipped (bytes still buffered, transport still open) and
      with reassembly of a frame delivered one byte at a time, or "fast" is satisfied by
      dropping input.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Retention is measured as ALLOCATION, not as logical length.** A `subarray` tail is
      a view that pins its whole parent, so a 1-byte remainder of a 2 MB delivery holds
      2 MB while the logical length truthfully reports 1. The leftover must be copied,
      and the assertion must read the allocation — a logical-length observable cannot see
      the defect at all (verified: view + logical-length accessor is green with the bug
      present).
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **The output gate fails open AND loudly — both halves asserted.** "The screen
      eventually arrived" is IMPLIED BY failing open and says nothing about loudly, so a
      test asserting only delivery passes with the warning silenced. Capture stderr and
      require exactly one warning that names the caller's wiring bug and the consequence,
      paired with the control that a timely `beginOutput()` emits none. The control is
      protected by two guards (`beginOutput` clears the timer; the timer checks
      `released`), so only a mutation disabling BOTH shows it discriminates.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **The frame limit is enforced BEFORE the allocation it exists to prevent.** A
      single oversized delivery must be refused without copying a byte — validation is a
      scan of the incoming chunk, measuring each FRAME (including bytes already buffered
      that belong to its first one), never the delivery's total size. Needs three cases,
      because each is satisfied by an implementation that fails the others: one huge
      chunk against a small cap refused with an EMPTY buffer; a delivery far larger than
      the cap made of many valid frames ACCEPTED; and an oversized frame SPLIT across two
      deliveries still refused. Fragmented accumulation and one-byte-over cannot see any
      of this.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **A PID is verified by IDENTITY before it is signalled.** The kernel reuses PIDs,
      so "is pid N alive?" is the wrong question and a liveness probe answers YES about a
      stranger that inherited the number. Capture `/proc/<pid>/stat` field 22 at spawn
      and require it to match before every signal; a DIFFERENT start time is positive
      proof our child exited, so it confirms death and signals nothing. No captured
      identity means no signal and no settle. The probe has THREE answers, not two:
      only ENOENT is absence, and any other errno — or an unparseable entry — is
      UNKNOWN, which may never confirm a death, including when it appears partway
      through the kill ladder's grace window. The errno mapping needs its own case with
      an injectable reader, because a probe injected at every call site is never itself
      exercised. The stat parser must be tested independently against a `comm`
      containing spaces and parentheses — `comm` is the
      executable name and is unescaped, so absolute field indexing reads the wrong field
      and passes on any host whose process name happens to be one word.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **The inbound buffer holds no per-fragment state at all.** Three bounded
      quantities in a row (copying, retention, allocation count) is the signal to change
      the SHAPE rather than add a third measurement: bytes are copied into a single
      buffer and the delivered chunk dropped, so a fragment cannot be retained
      individually and there is nothing to count. Growth must be amortised (doubling)
      and consumption must use a cursor, not a re-slice. Retention must track CURRENT
      NEED — right-sized when the remainder becomes a small fraction of capacity,
      released when fully drained — because bounded is not the same as small. And
      right-sizing must be proven distinct from truncation by a case with a LARGE
      outstanding partial frame; a one-byte leftover fits in any capacity and cannot
      tell them apart.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Transport loss never settles a child that may still be running.** A closed
      socket is not evidence the process exited (`pty-host.ts` says so), yet settlement
      runs the ordinary death handling in `spawn.ts` — sink unregistered, pool entry
      dropped, configs deleted — which authorises a replacement `claude` against the
      same transcript and breaks one-process-per-transcript, an invariant enforced ONLY
      by killing the old process. So the host must TERMINATE the pid it learned at
      spawn (adoption is #539 and unbuilt) and settle only on CONFIRMED death, with
      escalation SIGTERM → SIGKILL. When death cannot be confirmed it must NOT settle,
      because a stuck session is recoverable and two live processes on one transcript
      are not. Inject the process primitives: the default probe answers ESRCH for a fake
      pid, so an uninjected test proves "already dead" trivially and never attempts the
      kill — the arrangement must not perform the step under test. The liveness probe
      needs its own direct case: EPERM means the process EXISTS and is not ours, and
      reading it as dead reports a live child terminated exactly when we have least
      authority over it.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **Every live caller performs the readiness handshake.** Each converted E2E proof
      must call `beginOutput()` after wiring its consumers, and at least one live
      boundary test must assert NO fail-open warning across the whole run. Without it
      the opt-in proofs wait out the 5 s gate, trip the "WIRING BUG" warning and
      normalise the fail-open — a guard can be thoroughly unit-tested while every real
      caller sits on the wrong side of it, and only a live assertion catches that.
      verify: `grep -c 'beginOutput' runtime/adapters/claude-code/persistent/__tests__/dev-channel-pty-bind.e2e.test.ts runtime/adapters/claude-code/persistent/__tests__/ritual-write-containment.e2e.test.ts reminders/bundled-rituals.e2e.test.ts` — each ≥ 1
- [ ] **A CLOSED transport accepts nothing.** After `close()`, `onBytes` must neither
      dispatch nor buffer: a post-close frame must not reach a subscription handler
      (`pane_exited` is the one that would re-open a settled exit), and repeated chunks
      must leave the buffer teardown released at zero. Both halves need their own case —
      a guard placed after the append refuses to dispatch while still accumulating, and
      passes the first test alone. Both need a control taken on the SAME client with the
      SAME bytes while open, or "not delivered" is satisfied by a malformed frame or an
      unwired handler. The buffer must be observable for the accumulation half to be
      assertable at all.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Every entry point consults `closed`, not just the field existing.** The surface is
      walked as a class rather than patched at the reported door: report the count
      examined against the count changed. A rejected `subscribe` must leave no handler
      behind — registering before the acknowledgement is deliberate (an event can arrive
      in that window, and the host subscribes so a startup exit is still seen), which
      makes removal on failure the obligation rather than late registration. NOTE what is
      NOT a criterion: the order of `closed = true` against `failAll` is unobservable,
      because `failAll` only calls `p.reject()` and rejection handlers run as microtasks
      — a mutation moving that line survives, so any test asserting the ordering passes
      for both implementations.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **A settled terminal state is IMMUTABLE.** No later path may rewrite `exitCause`,
      `hasExited()` or `wasKilledByUs()` once the exit has settled — including the
      rejection of an RPC that the settlement itself caused, since `settleExit` closes
      the client and closing it fails every call still in flight. The assertion must be
      taken AFTER the last handler runs: releasing the held call and draining a macrotask
      turn, then re-asserting. Asserting while the call is still held measures an
      intermediate state and passes with the defect present. Pair it with the case that
      the flag DOES still clear while the child is unsettled, or "immutable" is satisfied
      by never clearing it at all — which re-breaks the failed-close requirement above.
      Note the fake must fail in-flight calls on `close()` as the real transport does; a
      forgiving fake makes this defect invisible (verified: host defect plus forgiving
      fake is green).
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **A `pane_exited` arriving while OUR close is in flight is ours.** With the close
      genuinely held mid-flight, an exit event must classify as intentional
      (`wasKilledByUs()` true); with no kill in flight the same event must classify as
      a crash. The held-call form is load-bearing — a fake that answers instantly
      collapses the in-flight window to nothing and makes the property vacuous — and
      the crash control is what stops a flag that is simply always true.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **The read cap is enforced AT its boundary, in both directions.** The request
      must clamp to `HERDR_READ_LINE_CAP` at a viewport of
      `HERDR_READ_LINE_CAP - HERDR_READ_WINDOW_LINES + 1` (= 800) and must NOT clamp
      at 24 — a guard that caps every request satisfies the first and fails the
      second, and viewports of 24/62/120 alone prove nothing about the boundary. The
      shrunken content window must be reported, not silently absorbed.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-poll-bounds.test.ts`
- [ ] **A failed spawn leaves no pane running.** Every initialization failure AFTER
      `layout.apply` returns — the pid never arriving, the subscription refusing —
      must send `pane.close`; the obligation starts when the pane exists, not when
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
      socket taking 0 or half a frame must fail the call AND the connection, routing
      to `'transport-lost'`. The comparison must be against BYTE length — comparing
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
- [ ] **A malformed inbound frame is terminal.** Assert BOTH halves — the pending
      call rejects AND a later call is refused without reaching the wire — because
      rejecting the pending call was already true before the fix. Control: a
      well-formed frame leaves the connection usable, or a client that closed on
      every frame would pass.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Teardown is an ACTION, reached by every terminal route.** All three — a
      malformed frame, a short write, a THROWN write — must end the socket exactly
      once and reject EVERY pending request, not just the newest. Assert the observed
      `end` count, never `isClosed()` alone: the flag is the symptom, and asserting it
      cannot distinguish a teardown from a relabelling. Control: a healthy exchange
      ends the socket zero times, and teardown is idempotent.
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
- [ ] **Every RPC is bounded by a clock, and the clock reaches `teardown`.** A socket
      that accepts the whole frame and never replies — no error, no close, no event —
      must fail the call and tear the transport down, INCLUDING `connectHerdr`'s
      handshake `ping` (an unbounded wait there means the gateway never starts).
      Assert the opposite direction too: a reply cancels the clock, so a healthy
      connection is never torn down — a timeout that always fires would pass the
      first case alone.
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
- [ ] **`data` is part of the event envelope, and each way of not being an object is
      its own case.** Absent, `null`, an array, a bare string and a bare number must
      each reach the malformed-frame teardown — listed and mutated INDIVIDUALLY, since
      they take different branches (`in`, `typeof null === 'object'`, `Array.isArray`,
      primitive `typeof`) and a partial check passes some while failing others.
      Coercing any of them to `{}` is the defect: the frame validates, handlers run
      with an empty object, `pane_exited`'s `pane_id` comparison fails, and the exit is
      SILENTLY DROPPED. Pair it with the control that `data:{}` — genuinely empty and
      known — stays VALID, or "require data" is satisfiable by rejecting anything
      falsy, which breaks a legitimate fieldless event.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
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
- [ ] **A frame that PARSES but matches no envelope is torn down.** "Malformed" must
      be defined by the protocol's requirement, not by the parser throwing: `null`,
      `[]`, `{}`, bare primitives, an id with no outcome and an outcome with no id all
      have to reach the same teardown, and none may throw out of `onBytes`. Assert
      `isClosed()` SYNCHRONOUSLY with a long RPC clock — with a short one the timeout
      tears the connection down anyway and the test passes without the validation
      existing (M53 survived exactly that way). Control: both legitimate envelopes
      still work, or a validator that rejects everything passes.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **Inbound framing is size-bounded.** A peer that never sends `0x0A` must be torn
      down rather than buffered to exhaustion — this is the UNDECLARED half of the
      protocol-drift risk the `ping` gate covers only when the server announces it.
      Test exactly AT the limit (a legitimate maximal frame must still complete — a
      bound that rejects one is a new failure mode), one byte over, and accumulation
      one byte at a time so the limit is on what has gathered rather than per chunk.
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
- [ ] **The frame bound runs BEFORE the frame is decoded or dispatched.** A guard after
      the thing it guards is not a guard: checking the remaining UNTERMINATED bytes let
      every oversized frame that arrived with its newline through. Test a COMPLETE
      one-byte-over frame, an oversized frame followed by a valid one (proving teardown
      rather than resynchronisation), and a COMPLETE frame exactly at the limit.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] `resize` is optional on `PtyChild` and unimplemented by `HerdrHost`, with
      the reason recorded — not a silent no-op that reports success.
      verify: `rg -n "resize" runtime/adapters/claude-code/persistent/pty-host.ts`
