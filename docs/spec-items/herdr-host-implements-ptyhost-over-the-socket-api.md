---
title: HerdrHost implements PtyHost over the herdr socket API
group: platform
status: open
priority: P0
cutover: true
legacy_ref: "GitHub issue #538 (herdr step 2b)"
---

A `HerdrHost` implements the `PtyHost` interface over herdr's unix-socket API and
becomes the **only wired backend**: `spawn.ts` resolves `options.ptyHost ?? herdrHost`.

**SCOPE CHANGE, and this item does not carry it on its own authority — see SPEC.md
Decisions Log 2026-09-12, "THE REPL SUBSTRATE BECOMES SELECTABLE".** This item first
required `bun-terminal-host.ts` to be DELETED — no flag, no dual path — and that is what
the first sixteen commits on the branch did. The owner reversed it; the decision entry
records his words, what it supersedes (the "the opaque PTY host goes" clause of the
2026-09-11 pivot entry, which stays verbatim as that log requires), and the scoping of
`AGENTS.md`'s no-dual-code-paths rule. #540 is rewritten from "delete the in-process PTY
host" to "make the REPL substrate selectable".

A WORK ITEM CANNOT OVERRIDE AN AUTHORITY, which is why that entry exists: for one round
the reversal lived only here and in the as-built while `AGENTS.md` and the pivot entry
both still read as absolutes. The file is restored, adapted to the interface as it now
stands, and kept tested — but **not wired to a chooser**, because a switch between a
proven path and an unproven one hides which is which. A user-facing selector is
explicitly OUT of scope here and waits on the herdr path being verified live.

**THE TWO BACKENDS ARE NOT INTERCHANGEABLE**, and that is the real cost of keeping both.
Stated here, at the selection seam (`types.ts`'s `ptyHost`), in `pty-host.ts` and in
`bun-terminal-host.ts`, so a reader meets it BEFORE choosing rather than after:

1. **Exit codes** exist under Bun and nowhere in herdr, where `exited` always resolves
   `null` and crash-versus-recycle collapses entirely onto `wasKilledByUs`.
2. **Exit detection** is a push under Bun (`proc.exited` settles) and a POLL under herdr
   (a typed `pane_not_found`), so herdr learns of an exit a tick late.
3. **A repaint is new output under Bun.** `onScreen` is a rendered pane under herdr and
   an accumulation of the byte stream under Bun, and `PtyRing.textSince` is a multiset
   difference against a baseline SCREEN. Under herdr an Ink repaint redraws the same
   pane and the difference is empty — the whole reason snapshot-replace was taken over
   diff-append. Under Bun the repaint really is new bytes, so the same content reads as
   new output and a per-turn detector can see it again.

The third is a genuine defect on the Bun path, and it is named rather than papered over:
that path is no worse than it was before this item — the old byte-counter ring had the
same limitation, documented — but it does not get the fix. **Anything that relies on
repaint collapsing works on herdr only.**

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

- [ ] **`HerdrHost` is the only WIRED backend, and `bun-terminal-host.ts` is kept as an
      injectable option — compiling, contract-complete and TESTED, with no surviving
      mutation left standing under that claim.** Not deleted (the
      scope change above), and not put behind a chooser either. What makes the option
      live rather than a supported-looking dead export — the failure this branch has now
      removed twice — is that the contract it claims is asserted: a real pty, a real pid,
      a REAL exit code, an accumulating `onScreen`, an honest `submitLine`, and the
      SIGINT-does-not-latch rule.
      THREE ADAPTATIONS, each named because each is a divergence:
      (a) `spawn` is `Promise<PtyChild>` — already-resolved here, since the pid exists
      the moment `Bun.spawn` returns; the interface widened for the backend that needed
      it and this one pays nothing.
      (b) `submitLine` is implemented HONESTLY, not faked. A local pty write that accepts
      every byte HAS delivered them to the kernel and `\r` on a pty genuinely submits, so
      a short write is refusable and a delivered line is assertable — whereas herdr's
      `pane.send_text` types without firing, which is the entire reason the acknowledged
      seam exists. Neither backend claims the REPL acted on the line.
      AND THE SHORT-WRITE PATH IS EXERCISED, not merely present. A real pty does not
      short-write an eight-byte payload, so this needs two seams and one is not enough:
      `writeAllOrThrow` takes the write function, which makes the CHECK assertable (zero
      acceptance, partial acceptance, a UTF-16-unit count for a multibyte payload — the
      LAX direction, since `é` is one unit and two bytes — and a `Uint8Array` measured by
      its own length, each with its control); and the TERMINAL is injectable, which makes
      the WIRING assertable, because a pure helper can prove the check works and cannot
      prove anything still calls it. With both: a pty refusing the text makes `submitLine`
      reject AND leaves the Enter unsent, a pty refusing only the Enter rejects too.
      (c) `onScreen` ACCUMULATES. `PtyRing.replace` overwrites with each delivery, so
      forwarding one byte chunk per call would erase all previous output every time —
      silently, with the ring looking alive and holding the last few bytes. Decoded with
      a STREAMING decoder, because `stripPtyNoise` cuts at byte level and can leave a
      chunk ending mid-character.
      AND THE ACCUMULATION IS BOUNDED IN UTF-8 BYTES, NOT LINES. A line count is not a
      bound, because A LINE IS UNBOUNDED: a child whose output contains no newline
      (`yes x | tr -d '\n'`) is one line forever and a line-count trim retains all of
      it. The quantity that bounds memory is bytes, so that is the quantity the code
      holds — the same move the herdr client's inbound buffer needed three times. The
      cut REUSES `pty-ring.ts`'s clamp rather than growing a second copy: one
      implementation of "line-aligned, character-safe, to a byte budget" instead of two
      chances to get the surrogate pair or the mid-line cut wrong. It trims to a
      LOW-WATER MARK, not to the cap, or the next chunk is over again and an O(screen)
      clamp runs per chunk — the quadratic shape already removed once on this branch.
      THE FIXTURE HAS TO BE THE ACCUMULATOR, NOT A PTY. A pty has a fixed kernel buffer
      and no flow control: when the reader is slower than the writer the kernel DROPS
      output, silently and by a varying amount (measured on this host: the same 3 MB
      child delivered 490,432 bytes on one run and 316,608 on the next). A bound
      asserted end-to-end through that fixture can pass because the output never reached
      the cap — verified, by a character-safety mutation that survived it. The
      accumulator is exported and driven directly; the pty tests keep the contract, not
      the bound. Cases: newline-free volume, newline-free MULTIBYTE, an ASTRAL character
      (a UTF-16 slice splits a surrogate pair), the trailing newline surviving a trim,
      and the budget being USED between clamps — which is the only thing that reddens a
      byte counter left stale after a clamp, since that variant clamps every chunk and
      produces no shrink to count.
      `exitCause` is deliberately ABSENT under Bun: both its values name herdr mechanisms,
      and `undefined` means "not known", which is the truth.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts`
      and `rg -n "ptyHost \?\?" runtime/adapters/claude-code/persistent/spawn.ts` shows
      `herdrHost` as the sole default.
- [ ] **A SHARED requirement is asserted from ONE suite, run against every backend.**
      The readiness gate (`beginOutput`) belongs to the interface: `spawn.ts` cannot
      assign `scanChild` until `await spawn(...)` returns and releases output only after
      wiring completes. herdr honoured it; the restored PTY host delivered straight from
      its terminal callback and returned an EMPTY `beginOutput`, so a startup trust or
      approval prompt could be recorded into a ring with no detector attached — and
      because the ring is snapshot-replace it is never re-delivered, so the keystroke
      never fires and the REPL waits forever on a dialog nobody saw. NO TEST NOTICED,
      and the reason is structural: each backend had its own suite, so an INTERFACE
      requirement was asserted only where it happened to be implemented first. A
      per-backend suite can prove one backend does what its own author remembered.
      THE CASE RUNS AGAINST BOTH HOSTS FROM ONE TABLE, with three things that are easy
      to omit: a SETTLE step before the "nothing yet" assertion (without it the claim is
      vacuous for a host whose producer is asynchronous, and passes against no gate at
      all); the held screen must be DELIVERED after the release, not dropped — a host
      that loses what it held is as broken as one that delivers too early, just silently;
      and a CONTROL that the table really holds two distinct hosts, or a "conformance"
      suite can conform one implementation to itself. Both hosts fail-open loudly on the
      SAME shared constant, so their windows cannot drift.
      SCOPE, deliberately: the readiness boundary only — the case the divergence was
      found on. A full conformance suite over the whole `PtyChild` contract (exit
      classification, the kill ladder, write ordering, `submitLine`'s acknowledgement) is
      its own item, because each of those has backend-specific evidence requirements that
      must be modelled before they can be shared honestly. Adding cases is the cheap part;
      agreeing what "the same case" means for two substrates with different observables
      is not.
      THIRD SHARED CASE, AND ITS REASON IS ABOUT THE SUITE ITSELF. A child that is dead
      AS EARLY AS ITS SUBSTRATE ALLOWS must still deliver nothing before `beginOutput()`.
      The first fixture could not see this: both arms kept the child alive for the whole
      case, and the pty backend released its held screen from the exit handler — so with
      an ALREADY-RESOLVED `exited` that callback is queued as a microtask BEFORE the
      caller's continuation from `await spawn(...)`, and `onScreen` fired before the
      caller held the child. **A SHARED SUITE INHERITS THE BLIND SPOTS OF ITS SHARED
      FIXTURE**, which is the pty-buffer lesson one level up — at the thing built to
      catch such lessons. THE EXIT SETTLES; IT DOES NOT RELEASE: recording that the child
      is gone is not the same act as delivering its screen, and the held screen is still
      delivered, at release rather than before it.
      "As early as allowed" CANNOT be made identical and the case must not pretend it
      is: a pty hands back a process that has already exited, while herdr discovers a
      vanished pane only by polling — and its poll loop is itself behind the gate, so it
      cannot know until the gate opens. The positive control (`hasExited()`) is therefore
      taken AFTER the release on both, or the assertion would be requiring herdr to break
      its own gate.
      EVERY CONFORMANCE ASSERTION IS UNCONDITIONAL FOR EVERY HOST IN THE TABLE, and a
      host that legitimately differs declares that difference as its OWN asserted
      expectation rather than as a skipped branch. The rule is written down because it
      was broken within two cases of the suite landing: the already-exited case asserted
      delivery under `if (screens.length > 0)`, which cannot fail for the participant that
      produces nothing — so herdr had no asserted post-release outcome at all and a case
      meant to hold both hosts to one contract held one. **A conformance case whose
      assertion is optional for one participant is two tests wearing one name.** Each host
      now declares what it must hand over and is held to exactly that, ZERO included, with
      its reason carried in the failure message — because the interesting half of a
      conformance failure is which participant broke which promise. Cheaper to adopt at
      two cases than at twenty.
      SECOND SHARED CASE, added because it is genuinely non-vacuous on both: `submitLine`
      after the child has exited must REJECT, by different mechanisms on each side —
      herdr learns of the exit by polling a vanished pane, the pty is told by its
      process. The case asserts what the contract says afterwards, not how each found
      out, which is the test of whether a case belongs in a shared suite at all.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/pty-host-conformance.test.ts`
- [ ] **The shared interface describes BOTH backends, or it describes neither.** A
      contract that encodes one implementation's behaviour is the "two diverging code
      paths" outcome that keeping a second backend was supposed to avoid — and it is
      worse than a divergence, because a caller reading the type is told something false
      about its own code. The instance: `PtyChild.write` said "DOES NOT SUBMIT" and gave
      herdr's CR/LF refusal as the interface's rule, while an in-process pty submits on
      `\r`. `write` now delivers bytes and promises nothing about submission in either
      direction; the refusal is a documented PRECONDITION of `HerdrHost`; and
      `submitLine` is the submission-bearing operation both backends implement honestly
      and differently.
      SWEPT AS A CLASS, not fixed at the clause that was reported — eight further places
      stated a herdr fact as a universal (`writeKey`, `kill`, `wasKilledByUs`,
      `beginOutput`, `resize`, `onScreen`, `onExit`, `cols`/`rows`), plus two
      collaborators that leaked the same way (`submitCommand`'s refusal message and
      `spawn.ts`'s `onScreen` comment). Each now says what is true of both and names
      which is which where they differ.
      verify: `rg -n "herdr" runtime/adapters/claude-code/persistent/pty-host.ts` — every
      hit either names BunTerminalHost in the same clause or is explicitly scoped ("under
      herdr", "the herdr backend"); no sentence states a herdr-only rule unqualified.
- [ ] **The divergence that is a DEFECT is named, not papered over.** Keeping two
      backends means a caller can work on one and not the other, and one case is real:
      `PtyRing.textSince` is an order-preserving multiset difference against a baseline
      SCREEN. Under herdr an Ink repaint redraws the same pane and the difference is
      empty — which is the whole reason snapshot-replace was taken over diff-append.
      Under Bun a repaint genuinely emits new bytes, so the same repaint reads as new
      output and a detector scoped per turn can see it again. The Bun path is therefore
      no WORSE than it was before this item (the old byte-counter ring had the same
      limitation, documented), but it does not get the fix. Anything that depends on
      repaint collapsing works on herdr only.
      Also asserted-by-absence rather than assumed: nothing downstream consumes
      `exitCause` or `resize`, so their absence on one backend narrows nothing today.
      verify: `rg -n "exitCause|\.resize\(" --type ts runtime/ | grep -v __tests__`
      finds only the two host files and the interface — no consumer.
- [ ] The client `ping`s and **fails loudly** on a protocol mismatch, naming both
      the expected and the received number. A client with no check at all passes
      the matching case, so assert the **mismatch** case separately: a stub server
      reporting protocol 21 must make `spawn` reject, and 20 must not.
      ASSERTED THROUGH `spawn`, WHICH IS WHERE THE GUARANTEE LIVES — and for several
      rounds that was unwritable. The gate ran only when no `connect` dependency was
      injected: a runtime `if` keyed on whether a TEST SEAM was present, so the seam's
      presence changed the safety property. The consequence that matters is not that an
      injected client skipped the check; it is that the injected path is THE ONLY PATH A
      TEST CAN DRIVE, so this criterion could not be written against the code at all, and
      `herdrPing()` called directly exercises the function in isolation rather than the
      guarantee. **A gate the instrument cannot reach is the same class as an instrument
      that cannot fail.** The verification now goes through the `HerdrRpc` handle, so the
      injected and real paths run the same check — and asking through the handle also
      removes, rather than argues about, the smaller point that a separate ping
      establishes the version of the server-in-general rather than of the handle in use.
      A BYPASS, IF ONE IS EVER WANTED, MUST BE CARRIED BY THE TYPE — a verified-RPC type
      only a verifying constructor can produce — never by a runtime `if` on a seam.
      AND NO PANE IS CREATED ON THE REFUSAL: the gate runs before `layout.apply`, so the
      cleanup obligation is honoured by ORDERING, and that is asserted (a gate that ran
      after would leave a real `claude` running behind a rejected spawn) rather than
      assumed. The CONTROL also pins that the ping happens ONCE per spawn, not per call.
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
- [ ] **`pane_not_found` FROM THE CLOSE IS CONFIRMATION, not a failure to find out.**
      FALSE AND UNKNOWN MUST NOT SHARE A BRANCH, and here they did: `pane.close` settled
      only on its `.then` arm, so a typed not-found — positive proof the pane is gone,
      which the real server sends and the fake models — went to the handler for "the
      close told us nothing". It broke both things that handler exists to protect:
      `hasExited()` stayed false, so `repl-session.ts`'s ladder kept escalating against a
      pane that no longer existed, and `terminating` was cleared, so when polling later
      settled the exit a deliberate recycle read as a crash. The poll path had the typed
      check in two places; the close path had no case for it at all.
      It settles exactly as `ok` does — we asked for the termination and the pane is
      gone, so the cause is ours and the flag stays latched — while every other rejection
      keeps the existing behaviour of clearing `terminating` and settling nothing. BOTH
      DIRECTIONS, or "settle on any rejection" passes the first case.
      THE BOUNDARY THE RACE TEST MISSES: it lets polling settle FIRST and then releases
      the held close, so the close is never the thing that learns the pane is gone. The
      new case parks the poll, so the close is the only observer — which is the
      arrangement in which the close path's own handling is the whole answer.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
- [ ] **EVERY `PtyHost` FAKE MATCHES THE CURRENT SIGNATURE — swept, with the compiler as
      the instrument and a positive control on its DOMAIN.** Making `spawn` async is an
      interface change, so every fake is a caller of it, including ones on branches that
      merged while this was in flight: #642 brought three fakes built on the synchronous
      signature. A fake that returns a child where a promise is expected becomes
      ACCIDENTALLY THENABLE once spread (`{...child}` over a promise yields `then`/`catch`
      and none of `pid`/`write`/`exited`), and anything that awaits it awaits the fake
      rather than the child — so the cases die on the CLOCK, at a uniform ~2 s, rather
      than on their subject. A uniform timeout is a thing never settling, not an
      assertion disagreeing. Fix by returning a real promise of a complete `PtyChild`,
      never by widening a type until the error stops, and never by adjusting the
      expectations of tests that are asserting the right thing.
      THE SWEEP IS THE COMPILER'S DOMAIN, NOT A GREP'S: 45 objects implement `PtyHost`
      across `runtime/`, `gateway/` and the test trees, every one inside a checked
      tsconfig — including fakes constructed inline in a test body. The positive control
      is that the compiler DID report these (seven errors in one file), which is what
      makes an empty result afterwards mean something.
      verify: `scripts/ci/typecheck-all.sh` — and read its exit STATUS, not the tail of
      its output: `cmd | tail -3; echo $?` reports `tail`'s code, so a matrix with seven
      errors above the window prints three `pass` lines and looks green. An instrument
      that cannot fail is not a gate.
- [ ] **EVERY CONSUMER CALLBACK IS GUARDED, ON EVERY PATH, IN BOTH HOSTS — enumerated,
      with the count.** A consumer belongs to the caller and may throw; a host that lets
      that throw escape does not merely lose the callback, it abandons whatever came
      after it. The instance: `BunTerminalHost` called `opts.onExit(code)` unguarded and
      then `exitResolve(code)`, so a throwing consumer rejected the promise
      `fireAndForget` holds — logged and swallowed — and the resolve never ran.
      `hasExited()` returned true while `child.exited` stayed PENDING FOREVER, which is
      every awaiter of the exit waiting on a child that is already gone.
      THE COUNT IS THE CRITERION, because "fixed the site that was reported" is how the
      second and third of these survived: **six invocation sites across the two hosts** —
      herdr's `onExit`, `onScreen` and the `onPollExit` test seam; Bun's two `onScreen`
      dispatches and its `onExit` — and all six are guarded. Two were unguarded when the
      enumeration was run, and the asymmetry had a direction worth naming: three times
      now the Bun host has lacked a guard the herdr host already had.
      THE THROWING-`onExit` CASE BELONGS IN THE CONFORMANCE TABLE, unlike the
      kill-before-`beginOutput` one: both hosts take `onExit`, both must settle `exited`,
      and both can be handed a consumer that throws — nothing about it is vacuous for
      either participant. Assert the settlement AND the count of consumer calls, because
      a promise cannot settle twice and "it resolved" therefore cannot detect a second
      exit path firing. The resolved VALUE is declared per host (`null` under herdr,
      which has no exit codes; the real status under a pty) rather than assumed equal.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/pty-host-conformance.test.ts`
- [ ] **A FRAME THAT IS NOT VALID UTF-8 IS A PROTOCOL ERROR, not a frame with odd
      characters in it.** `Buffer.toString('utf8')` substitutes U+FFFD for every invalid
      sequence and returns happily, so `c3 28` decodes to `"\uFFFD("` and `JSON.parse`
      SUCCEEDS on it. Two consequences, and the second is this item's own subject: a
      corrupt frame can be accepted as a valid ACKNOWLEDGEMENT, and pane text that
      detectors scan can be altered with nothing reporting it. Same class as the reply-id
      check — the client trusting that the wire carries what the server meant — and the
      same argument applies: the protocol moved 20 → 22 in nineteen days with no
      server-side version check, so the client's job is to verify.
      Decode with a FATAL decoder and give the failure its OWN outcome: a decode failure
      is the absence of a usable answer, not an empty reply, and false and unknown must
      not share a branch here either.
      FOUR CASES PLUS THE ONE THAT STOPS THE FIX BEING A DIFFERENT BUG: an invalid lead
      byte, an invalid continuation byte (the one that parses as JSON once substituted), a
      sequence truncated before the newline — and a VALID multi-byte sequence SPLIT ACROSS
      DELIVERIES, which must still decode. Without that last one, "reject malformed UTF-8"
      is satisfied by rejecting every fragmented multi-byte read, which is most of them.
      Decoding at the COMPLETE FRAME rather than per chunk is what makes fatal decoding
      safe: fragmentation is not corruption.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **NO FLAG MAY OUTLIVE THE ACT IT CLAIMS — enumerated across both hosts, not fixed
      where reported.** An operation that failed must not leave behind a latch saying it
      succeeded. THE RULE ATTACHES TO EVERY OPERATION THAT LATCHES INTENT BEFORE AN ACT
      THAT CAN FAIL, not to a file that has learned it: `herdr-host.ts` states the rule
      for its `pane.close` and the SIGINT path twenty lines above it did not follow it.
      THREE SITES EXIST across the two hosts, and the count is the criterion because
      "fixed the one reported" is how the second and third survived: (1) `terminating`
      before `pane.close` — rolled back from the start; (2) `interruptedByUs` before a
      fire-and-forget `pane.send_keys`; (3) `killedByUs`/`interruptedByUs` before
      `proc.kill`. Two of the three were found by a reviewer rather than by the author of
      the rule. Every rollback is guarded on liveness (a settled terminal state is
      immutable) and is as NARROW as its latch (a failing interrupt must not erase a
      delivered termination).
      WITHOUT MAKING THE ACT FAILABLE FOR EVERYONE: fire-and-forget is the right shape
      for a keystroke, and the fix is a rollback hook for the one caller that latches —
      not an `await` imposed on every caller that does not.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-keys.test.ts runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts`
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
- [ ] **The frame limit is PER FRAME, and it runs before the copy.** Two requirements,
      and satisfying one by breaking the other is exactly what happened: `end +
      chunk.length` is a bound on the DELIVERY, so a peer that coalesces a perfectly
      legal reply with the first byte of whatever follows has its legal reply refused —
      a new failure mode, and a worse one than the allocation it replaced. The first
      newline in the incoming chunk is located FIRST (a scan, not an allocation), which
      is sound because everything already buffered is newline-free; the frame's own bytes
      are then bounded, and only they are copied.
      FOUR cases, because each is satisfied by an implementation that fails the others:
      an over-cap reply accumulated across deliveries refused; an over-cap frame arriving
      COMPLETE in one chunk refused (the fragmenting case alone leaves the complete path
      unbounded); a reply EXACTLY at the cap accepted; and a maximal reply COALESCED with
      a trailing byte accepted, which is the only case that can tell per-frame from
      per-delivery.
      THE ORDERING IS NOW OBSERVABLE, AND THIS CRITERION PREVIOUSLY CONCEDED THAT IT WAS
      NOT. It said the check's position relative to the copy had no runtime observable —
      both orders reject with the same message and the same outcome — and recorded the
      mutation that moves it as SURVIVING. That was a criterion standing over a mutation
      known to survive, which is a claim nothing holds: an unfalsifiable check is
      believed rather than tested. The remedy is the one `writeAllOrThrow` got — make the
      guarded thing an observable. The framing is extracted as a `FrameReader` that
      reports the bytes it has COPIED, so "before" is a number: an over-cap chunk is
      refused with `copiedBytes() === 0`, and an over-cap frame split across deliveries
      keeps only what was legitimately under the cap. The CONTROL is what stops that
      being satisfied by a reader that never copies: an acceptable frame IS copied, its
      terminator excluded, and a coalesced surplus is NOT.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **A successful settlement REQUIRES a result — refused by the type, not by a check.**
      The client must not settle a success with a defaulted `{}`: "there was no result"
      and "the result was the empty object" are different facts, and the empty object is
      a legitimate reply. This is the round-11 event-envelope defect, and it CAME BACK on
      the success path when the transport was rewritten around it — which is the point.
      A defect removed by a check has to be re-passed by every rewrite; a defect removed
      by a TYPE does not. So the success settlement takes a required
      `Record<string, unknown>` with no default and no optional parameter, and the only
      caller is the branch where `classifyReply` has already proved the reply carried an
      object-valued `result`.
      verify: the mutation is a TYPECHECK, not a test — calling the success settlement
      with no argument must fail `scripts/ci/typecheck-all.sh` with TS2554 ("Expected 1
      arguments, but got 0"). Verified 2026-09-12.
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
- [ ] **No live proof borrows process state without a guaranteed return.** The
      hand-rolled capture is install, do the interesting thing, restore — and the
      interesting thing in a live proof is `await host.spawn(...)`, which rejects on a
      protocol mismatch, an unreachable socket or a pid that never arrives. The restore
      then never runs and `process.stderr.write` stays patched for the rest of the
      process. That is the worst failure shape available: the one test that can see a
      real server fails, and its failure silently degrades every test after it — the
      same family as a suite that points `HERDR_SOCKET_PATH` at a dead path and never
      puts it back. A scoped helper owns the `finally`, the spawn runs INSIDE its scope,
      and the helper restores the ORIGINAL reference rather than a bound copy, because
      identity is the only restoration that composes under nesting.
      The helper needs its own cases in both directions — a body that REJECTS restores
      AND still propagates its error (a helper that swallowed it would hide every live
      failure it exists to surface), and a body that resolves restores and returns what
      it captured.
      AND THE RESTORE MUST BE THE ORIGINAL REFERENCE, not a bound copy of it: installing
      `original.bind(process.stderr)` leaves a DIFFERENT function object in place, so
      nested or repeated captures stack binds and nothing ever returns the process to
      where it started. Five suites had exactly that, including the one whose own test
      asserts identity restoration.
      THE RULE IS ENFORCED, AND ITS DOMAIN IS THE DOMAIN OF THE RULE. The guard fails any
      test that assigns `process.stderr.write` at all — every `*.test.ts` and every module
      under a `__tests__/` directory, with ONE sanctioned assignment site
      (`__tests__/capture-stderr.ts`). It was first scoped to `*.e2e.test.ts`, which is
      where the defect was noticed, and that scoped it to the SAMPLE: none of the five
      offenders was an e2e file, so the guard could not see any of them. The positive
      control has two parts for the same reason — the pattern must find the sanctioned
      assignment, AND the walk must reach the file holding it. An empty result proves
      nothing if either the pattern or the domain is wrong, and on this branch both have
      been.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts tests/integration/pty-e2e-registered.test.ts`
- [ ] **A live proof leaves the owner's herdr exactly as it found it.** This item's
      subject is making herdr the REPL container, and its own live suites leaked REPL
      containers into the owner's session: four orphaned tabs, each a real `claude`
      parented straight to the server, with no title and the fixture cwd, ages spanning
      the hours these proofs had been running. He found them by looking at his own screen.
      TWO DEFECTS, both shapes already fixed elsewhere on this branch. The close was
      never CONFIRMED — `kill()` is `void` and issues `pane.close` as a background RPC,
      so a test process that returns from its `finally` and exits has ASKED without
      knowing, and a request still buffered when the process dies was never sent at all
      (settlement is not confirmation, one layer further out). And the SPAWN SAT OUTSIDE
      THE `try` in two suites, so a rejecting spawn skipped the cleanup while the pane
      already existed — the obligation starts when the resource exists, not when the
      function succeeds, which is `abandonPane`'s own correction escaping through the
      suite.
      FIXED AS A LIFECYCLE GUARANTEE, NOT AS CLEANUP CALLS: one scoped helper owns the
      spawn, the readiness handshake and the `try`/`finally`, and AWAITS `child.exited`
      — which the host settles only from the `pane.close` reply — with a bounded
      deadline, because an unbounded wait turns a leak into a hang and an unreported one
      turns it back into a leak.
      THREE THINGS ENFORCE IT, and the third is the one that survives a fifth live test:
      a guard fails any `*.e2e.test.ts` that constructs `HerdrHost` directly, with a
      positive control that every e2e file reaches the helper (so "no offenders" is not
      "no spawns"); the helper's confirmation, bounded-wait and already-exited paths have
      their own cases against a fake that settles ONLY when told, because a fake that
      settles on `kill()` cannot reproduce the defect; and each live suite records the
      server's pane IDs before and after and FAILS on any that appeared — by id, not by
      count, and a pane that CLOSED is not a leak.
      WHY NOTHING AUTOMATED SAW IT, which is the finding worth more than the fix: the
      panes are created THROUGH A SOCKET by a process the test does not own, so the
      test's own process shows no leak — no fd, no child, no handle — and CI never runs
      these at all because they are opt-in. That is the same property that let the
      one-request-per-connection transport defect survive eight green rounds. **This
      lane's live surface has no automated observer**, and twice now the instrument that
      caught a real defect was a human or a hand-written probe. The pane-count assertion
      exists because a standing check on that surface is worth more here than another
      unit test.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/live-herdr-child.test.ts tests/integration/pty-e2e-registered.test.ts`
- [ ] **No test may switch a live proof off.** The live herdr proofs are the only tests
      in this repo that can see a real server, and they are exactly the instrument that
      would have caught the transport defect this branch fixed. Three unit suites point
      `HERDR_SOCKET_PATH` at a dead path to keep themselves hermetic — correctly, since
      `start()` reaches the real host and would otherwise create real panes on the
      owner's server — but a module-scope write with no teardown turns "make my own case
      hermetic" into "disable the instrument for everything that runs after me in this
      process". Save and restore in a teardown hook, both halves (delete when the value
      was absent, restore when it was set). And the rule is enforced rather than
      observed: a guard walks every `*.test.ts` and fails on any suite that ASSIGNS
      `HERDR_SOCKET_PATH` or `NEUTRON_PTY_E2E` without restoring it, with a positive
      control that the detector sees the real writers — an empty offender list means
      nothing if the pattern reaches no code, and the first version of the pattern
      matched the `===` of every gated suite reading its own flag.
      A test that can disable the only instrument capable of catching a whole defect
      class is a coverage hole that no coverage measurement will ever show.
      verify: `bun test tests/integration/pty-e2e-registered.test.ts`
- [ ] **Actuations on a pane are ORDERED, and one connection per request is exactly why
      that now takes code.** A single multiplexed socket ordered writes for free: frames
      left in the order they were written, on one stream. Per-connection does not — two
      fire-and-forget calls started in the same tick are two independent connects racing,
      and the loser can be the one that had to go first. The sequence that breaks is in
      the tree: the session-size watchdog actuates `escape`, then the `/compact` text,
      then `enter` (`session-size-watchdog.ts`), and an Enter that overtakes its text
      submits whatever was on the line and leaves `/compact` typed and unsent. So every
      actuation goes through one chain — a call does not start until the previous one is
      ANSWERED — and `submitLine` is queued as ONE UNIT so nothing lands between its text
      and its Enter.
      THE TEST MUST HOLD THE FIRST RPC. An ordering assertion taken over INVOCATIONS
      compares when the host called the transport, before either connection has been
      answered, and passes for an implementation with no ordering at all; the fake
      therefore records DELIVERIES separately (pushed past the hold and the failure
      injection) and every ordering assertion reads that. The competing actuation must
      also be DISTINGUISHABLE — two `enter`s both arrive as `pane.send_keys`, and an
      assertion on method alone reads the same for both orders.
      Three directions, because each is satisfied by an implementation that fails the
      others: a held text keeps the Enter behind it; a FAILED actuation does not wedge
      the ones behind it (the chain tail is neutralised, or one rejected keystroke stops
      the session AND leaves an unobserved rejection); and an actuation queued before the
      pane exits is DROPPED rather than delivered to a dead pane.
      A QUEUE MOVES THE MOMENT OF EXECUTION AWAY FROM THE MOMENT OF THE CHECK, so EVERY
      precondition tested before enqueueing has to be re-tested when the work runs — a
      check at the door is a claim about a world that may have moved. The two queued
      paths differ in what the re-check DOES, and the difference is the contract's, not
      an inconsistency: a fire-and-forget actuation is no-op-safe and is silently
      dropped; `submitLine` is the acknowledged seam a caller reports an outcome from, so
      it THROWS. Resolving quietly there records a context reset that never happened —
      the defect the method exists for. The `writeKey` case cannot see this: it needs its
      own, with a held actuation ahead of the `submitLine` and the exit landing while it
      waits. NOT queued, deliberately:
      `pane.read` (the poll is a sampler; ordering it behind a stalled keystroke blinds us
      exactly when something is wrong) and `pane.close` (a teardown preempts — the
      escalation ladder in `repl-session.ts` depends on it being prompt).
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-keys.test.ts`
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
      AND THE IMPLEMENTATION HAS TO AGREE WITH THE RECORD. Deleting the path is not done
      while its machinery is still exported: the `/proc/<pid>/stat` start-time parser,
      the kill-grace constant and the `node:fs` import that fed them were still in
      `herdr-host.ts` after the as-built said they were gone. An unused export is
      indistinguishable from a supported one. A claim of deletion is a claim about the
      TREE, and it has to be re-derived after the deletion actually happens.
      verify: `rg -n "^(export|import).*(parseProcStatStartTime|HERDR_PID_KILL_GRACE_MS|node:fs)"
      runtime/adapters/claude-code/persistent/herdr-host.ts` returns nothing — no
      declaration and no import — against the positive control `rg -c "^export" <same
      file>` which finds the 5 exports that remain. The unanchored grep still finds the
      two lines of the deletion comment, which is the "one hit, and it is prose" shape
      again: the reasoning stays, the machinery does not.
      AND THE SWEEP IS THE SURFACE, NOT THE ONE SYMBOL NAMED. Fixing only what a review
      points at leaves the next one; the check is every exported name in `herdr-host.ts`,
      `herdr-client.ts`, `herdr-protocol.ts` and `pty-host.ts` counted against its uses.
      Run 2026-09-12 it found two more: `HerdrHostDeps.paneCloseTimeoutMs`, documented as
      a post-transport-loss `pane.close` timeout with no consumer — deleted; and
      `HerdrLayoutPaneNode`, a measured protocol shape with no consumer — made live by
      typing the `layout.apply` root with it, since the measurement it records is worth
      keeping and an unused export is not the way to keep it. An exported option is a
      promise.
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
- [ ] **A failed spawn leaves nothing allocated — on EITHER backend.** The rule is the
      interface's, not herdr's: an obligation starts when the resource exists, not when
      the function succeeds. Under `BunTerminalHost` the readiness timer is armed and the
      pty is allocated before `Bun.spawn` runs, so an executable that does not exist is
      enough to reject out of `spawn()` with an open terminal AND a live timer that
      five seconds later reports a `beginOutput()` wiring bug about a child that was
      never created — a false diagnostic on top of a leak. Both the allocation and the
      spawn go inside one guard, since `createTerminal` can throw too (nothing to close,
      timer already armed), and the close is best-effort so a failing close cannot mask
      the error that caused the abandonment.
      The CONTROL carries this one: a SUCCESSFUL spawn must close nothing and must still
      ARM the gate, or "closes on failure" is satisfied by closing unconditionally and
      "disarms on failure" by never arming. Note what the existing fixture could not see
      — it covered the PRE-allocation empty-argv refusal, and the injected terminal
      modelled only successful spawning.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts`
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
- [ ] **Only a typed `pane_not_found` proves a pane is gone — and a typed one must not
      be thrown away.** Two halves of one rule, and the second was the one being broken.
      UNKNOWN MUST NOT CONFIRM: a transient rejection — timeout, temporary server error
      — must NOT settle the child, and the bridge must recover when it clears. KNOWN
      MUST NOT BE DISCARDED: a `pane.read` that itself rejects with `pane_not_found` is
      already the conclusive evidence, and the poll must settle on it rather than
      throwing the error away and asking a second question — the handler caught every
      rejection alike, so a typed not-found settled nothing whenever the follow-up
      `pane.get` happened to fail transiently.
      THE MIXED CASE IS THE ONLY ONE THAT SEES IT. A test where both calls answer
      `pane_not_found` passes either way; the case must make the READ typed and the
      PROBE transiently broken. Both directions still needed: widening the typed check
      to any rejection must redden the transient cases.
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
      that always fires would pass the first case alone.
      THE DEADLINE MUST COVER ESTABLISHMENT, not only the reply. With a persistent
      connection, connecting happened once at startup and every call was bounded from an
      already-established socket; one connection per request moves the connect INSIDE
      the call, and a guarantee proved against a precondition has to be RE-PROVED when
      the precondition becomes part of the operation. Arming the timer is not enough: it
      settles the pending outcome, but if the only `await` in front of the first check is
      the connect, a connector that never resolves parks there forever and the deadline
      is never observed. So the connect RACES the settlement — and the case needs a
      connector that NEVER resolves, because one that always resolves cannot test one
      that does not. Assert TERMINATION (a race against a sentinel), not the error text:
      the unbounded path went in underneath an assertion about the error.
      RACING LOSES THE REFERENCE, so the close is deferred to the connect itself: a
      socket that arrives after the deadline must still be released, or a timed-out call
      leaks a descriptor per attempt. Both directions — the late socket IS closed, and
      the deferred close does NOT fire for a socket that arrived in time (a double close
      reddens the end-count cases).
      And assert the ABSENCE the shape depends on: the deadline can fire while the
      connect is still in flight, which is a window in which nothing yet holds the call's
      promise. The call therefore settles by RESOLVING an outcome record and never by
      rejecting one, because an unobserved rejection is fatal under Bun's process net
      (`logger/fire-and-forget.ts` states the policy). The test registers an
      `unhandledRejection` listener and requires both the right error and an EMPTY
      listener log — asserting the error alone passes with the hazard present.
      THE AUDIT, not just the one await: between arming the timer and the first check of
      the pending outcome there must be NOTHING that can block unbounded. Run 2026-09-12,
      `herdrCall` has exactly two awaits — the raced connect and the final outcome — and
      every other step (path resolution, framing, `socket.write`, settlement) is
      synchronous.
      verify (audit): `awk '/^export async function herdrCall/,/^}/'
      runtime/adapters/claude-code/persistent/herdr-client.ts | grep -c 'await '` is 2.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
- [ ] **A SIGNAL THAT COULD NOT BE DELIVERED LEAVES NO CLAIM THAT IT WAS — on either
      backend.** `kill()` latches before signalling (classify-before-latch is right and
      stays), so a `proc.kill` that THROWS must clear the flag it set: the signal never
      landed, and `spawn.ts` evaluates `!killedByUs && exitCode !== 0`, so a surviving
      flag short-circuits the exit code and the child's later NONZERO exit — a real
      crash, since nothing killed it — reads as a clean recycle. It also disarms
      `repl-session.ts`'s escalation, whose `hasExited()` guards return early; leaving
      the child unflagged is what RE-ARMS the SIGKILL retry. The rule is stated for the
      herdr backend's failed `pane.close` and is the same rule here, so the whole shape
      is copied rather than half of it.
      THE CLEAR MUST BE AS NARROW AS THE LATCH: a failing SIGINT clears only
      `wasInterruptedByUs`, never a termination already recorded — a widened clear erases
      a delivered kill and turns the recycle after it into an apparent crash. The
      SIGINT-only case cannot see that (both flags are false there either way), so it
      needs its own case with a successful terminal kill first.
      THE MISSING ROW IS THE OPERATION THAT FAILS, in a table built entirely from
      operations that work: a host whose `proc.kill` cannot fail cannot test what a
      failed signal leaves behind. Inject one that throws, resolve the exit NONZERO, and
      assert the classification through the expression `spawn.ts` actually evaluates —
      not through the flag alone.
      RECORDED, because copying the shape exposed a real difference between the two
      backends. herdr's failure arrives as an ASYNC rejection, so the exit genuinely can
      settle in between and its `if (exited) return` is reachable and load-bearing. The
      Bun host's `kill()` is synchronous end to end — `exited` is set only in the
      `proc.exited` microtask — so the equivalent inner guard is UNREACHABLE there: the
      two liveness guards are redundant, each absorbs a single mutation of the other, and
      only the COMBINED mutation reddens. The entry guard has its own observable (an
      already-exited child is not signalled at all) and is asserted directly. The inner
      one is kept because the rule is shared and the interface admits a host whose `kill`
      awaits — and said to be unreachable rather than left looking tested.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/bun-terminal-host.test.ts`
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
- [ ] **No document mandates a backend that is not the wired one — in EITHER direction.**
      Changing which backend is wired is narrowing a guard, so every document asserting
      the old rule is fixed in the same change — above all the per-directory
      `runtime/adapters/claude-code/AGENTS.md`, which is injected into the next agent's
      context and whose "It MUST spawn…" sentence named the Bun-native PTY. The sweep
      must be decided PER FILE, because three outcomes are all legitimate and different:
      a live reference to a backend that is not wired is a defect; a dated historical
      statement (an archive, a `HISTORICAL NOTE`, a record of where a bug was reproduced)
      is correct AS HISTORY and must survive; a docstring describing a mechanism its own
      body no longer uses is misleading and gets corrected. A blanket find-and-replace
      fails this criterion by destroying the second category.
      AND THE SAME RULE APPLIES INSIDE THE CHANGED MODULES, where the density is highest:
      a present-tense architectural claim in a file that just changed its architecture is
      the likeliest place for a false one. The class docblock of `HerdrHost` — the first
      thing a reader of the class meets — described "one herdr connection per `spawn`"
      and "its `pane.exited` subscription", both of which this item replaced, and
      `pty-noise.ts` claimed "both backends use it" when its only importer is
      `bun-terminal-host.ts` (herdr asks the server for `strip_ansi` and receives an
      already-rendered screen). Four such claims on this branch. The sweep is for the
      PHRASES — subscription, per spawn, both backends, long-lived socket — across the
      herdr and `pty-*` modules, and it must distinguish three outcomes: a live false
      claim is a defect; an explicitly dated deletion record ("this used to…", the
      `PtyExitCause` note) is correct AS HISTORY; and a measurement that explains a choice
      (a fresh subscriber IS delivered recent exits) stays.
      RE-DERIVED AFTER THE SCOPE CHANGE, which is the point of stating it this way: the
      first pass corrected every document that still mandated the Bun host, and then the
      deletion was reversed — so `AGENTS.md` was left carrying "there is no second
      backend and no flag to select one, so do not write code against it", which is now
      false in a file the next agent reads first. Corrected to say what is actually true:
      herdr is the only WIRED default, the Bun host is an injectable option, write
      against `PtyHost` and never against either by name, and the two are not
      interchangeable.
      verify: `grep -rniE 'bun[-. ]?terminal|Bun-native|Bun PTY|Bun\.spawn\(\{ ?terminal' --include='*.ts' --include='*.md' .` — every surviving hit is the restored backend and its test, an archive, an explicitly dated historical note, or the divergence note; none asserts either backend is the sole one
- [ ] **A reply must be the answer to the question we asked.** Every request carries an
      id and the client REQUIRES it back — one constant used by both the request and the
      check, so the two cannot drift into two facts that happen to agree. The obvious
      objection is that one connection carries one request, so no other reply can arrive:
      that is THE SERVER'S guarantee, and this is the client's own check that it holds.
      This item is the reason to distrust exactly that kind of assumption — the protocol
      moved 20 → 22 in nineteen days with no server-side version check of any kind, and
      the persistent multiplexing design that assumed a described server could not
      execute at all. One comparison removes a class, including a stray or drifted
      response being taken as the acknowledgement of `pane.close` — the one operation
      this item spent four rounds making trustworthy.
      THE ROW THAT WAS MISSING IS THE ONE THAT IS WELL-FORMED. Every other envelope case
      is malformed; a mismatched id is perfectly shaped and simply is not ours, which is
      why a table built around "reject what is broken" did not contain it. Needs the
      CONTROL in the same run — a matching id resolves — or "reject a mismatched id" is
      satisfied by rejecting every id, which fails every call ever made.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-protocol-gate.test.ts`
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
- [ ] **A child that dies BEFORE `beginOutput()` strands nothing.** `settleExit`
      cancelled the gate's fail-open timer and did not release the gate — and the poll
      loop is parked on `await outputGate`, whose only two resolvers are `beginOutput()`
      and that timer. So spawn, never wire the consumer, `kill()`, let `pane.close`
      succeed: the loop stayed pending FOREVER, holding its closure over the host and
      client after the child was gone. THE OBLIGATION WAS TO THE TASK; THE TIMER WAS ONLY
      ITS INSTRUMENT — the same shape as `pane_not_found` landing in the unknown branch
      and the SIGINT latch: a cleanup path that handles the object it can see and not the
      one that object was standing in for. The docblock on the timer names this exact
      scenario and the code discharged half of it.
      THE FIX MUST NOT TRADE A STRANDED TASK FOR A SPURIOUS CALL: releasing lets the loop
      run, so its first act has to be observing the exit and returning rather than
      reading a pane that is already closed. Asserted (no `pane.read`, no fail-open
      warning), not assumed.
      IT HAS NO OTHER OUTWARD SIGN, which is why the host reports the loop's completion
      through a test-only seam: the child settles either way, no read is issued either
      way, and the warning is cancelled on both paths — the ONLY difference is whether
      the task is still pending, so that is what is made observable. The control is the
      ordinary order still gating, or "release on exit" is satisfied by releasing at
      spawn, which removes the gate entirely.
      HERDR-ONLY, AND THAT IS AN ANSWER RATHER THAN AN OMISSION: `BunTerminalHost` has
      the same gate concept but NOTHING AWAITS IT — its gate holds the `onScreen` CALL,
      not a task — and its timer is deliberately left armed across the exit, so the same
      input delivers the dead child's last screen late and loudly instead of stranding
      anything. Putting this in the conformance table would need an observable on a host
      with nothing to observe, which is the vacuous-for-one-participant shape that table's
      own rule forbids.
      verify: `bun test runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts`
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
