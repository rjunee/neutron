## 2026-09-12 — herdr is the DEFAULT REPL container, the PTY host stays selectable, and the ring becomes a rendered screen

herdr is the **only wired** `PtyHost` backend: `spawn.ts` resolves
`options.ptyHost ?? herdrHost`, and `herdr-host.ts` drives herdr's unix-socket API
(`herdr-client.ts`, `herdr-protocol.ts`). The in-process `bun-terminal-host.ts` is
**KEPT as an injectable option**, adapted to the interface as it now stands and covered
by its own tests — reachable only by injecting it at that seam, with no user-facing
chooser. Governing record: SPEC.md Decisions Log **2026-09-12, "THE REPL SUBSTRATE
BECOMES SELECTABLE"**. This is step 2b of the cutover (ISSUES #538), on top of #537's
durable reply sink.

> **SUPERSEDED HISTORY, kept because this record is chronological and half of it was
> written under the old rule.** This section opened with *"`bun-terminal-host.ts` is
> deleted. … No flag, no dual path."* That was the item as specified and is what the
> first sixteen commits on the branch did. The owner reversed it mid-branch; the
> reversal, its reasoning and what it supersedes are recorded in the Decisions Log entry
> above and in "SCOPE REVERSAL" below. **A reader takes the opening as the outcome**, so
> the outcome is now what the opening says — the same correction `SPEC.md`'s body marker
> got, for the same reason. Everything below this line that speaks of the deletion is
> dated reasoning from before the reversal and is left verbatim.

Everything below that describes herdr was measured against the live server on
2026-09-12 (herdr 0.8.2, **protocol 20**), not read off a document. Where I
measured something the work order asserted, I say so; where I took the order's word,
I say that too.

### The central design problem: what scopes a turn when the ring is a screen

herdr has no raw output stream. Of its 91 methods the only output-bearing
subscription is `pane.output_matched`, which needs a pattern registered in advance,
and `pane.output_changed` is unusable despite being declared in the schema: I sent
both forms and the server rejected both — `events.subscribe` with `invalid request:
unknown variant 'pane.output_changed'` (the error enumerates the 27 it does accept),
and `events.wait` with `unsupported_event_wait_match: "events.wait currently
supports pane agent status matches"`. The work order said "rejected by
`events.wait`"; the schema declares `pane_output_changed` in both `EventKind` and
`EventMatch`, so I checked rather than assumed. The order is right and the schema
over-declares. Either way nothing is built on it.

So `onData` had to be synthesized by polling `pane.read` and diffing. Two shapes
exist and they break opposite invariants — diff-append breaks the detector falling
edge (`output-scan.ts:210-213`: `if (!present) { st.latched = false }` — a cleared
menu appends nothing, so `present` never falls and every content detector becomes a
one-shot for the session), and snapshot-replace breaks `PtyRing.textSince`
(`pty-ring.ts:89-93` before this change), which scoped a turn by **character
count**. Snapshot-replace was the ruling, and it is the fix `spawn.ts:336` already
named — "the proper fix is substrate-level (a rendered-screen ring …)", inside the
KNOWN LIMITATION block at `spawn.ts:327-338`. (The work order cited `314-317`; the
tree had moved ~20 lines.)

**The `textSince` decision: the mark stops being a number and becomes a baseline
screen.**

A count cannot work here, and not marginally. An Ink TUI repaints constantly, so
any byte counter advances by a full screen per poll on a screen that did not change
— `textSince` would return the entire screen forever, which *is* the stale-banner
re-arm that per-turn scoping exists to prevent. The counter cannot distinguish "the
screen was redrawn" from "the program printed something", and that distinction is
the whole question.

So `PtyRing.mark()` returns an opaque `RingMark` carrying the screen as it read at
the turn boundary, and `textSince(mark)` is an **order-preserving multiset
difference**: walk the current screen top to bottom, emitting each line only once
the baseline's remaining count for that exact line is used up.

- **A multiset, not a set.** An identical line legitimately recurs. A credential
  banner on screen from turn 1 that turn 2 prints *again* appears twice now and once
  at the mark, so exactly one copy is new. A set difference suppresses it and blinds
  the detector — a false negative on the signal the scoping was added to catch. This
  is not hypothetical: mutating the multiset decrement away (M8 below) reddens the
  real end-to-end warm-session re-arm case in
  `auth-failure-classification.test.ts`, not merely a unit test.
- **Order-preserving.** The consumers (`spawn.ts:453`, `types.ts:113-116`) feed the
  result straight to `buildDetectorContext`, which applies a bottom-N line slice and
  the doc-quote guard. Both are positional; a bag of lines breaks them.
- **The mark carries the baseline rather than indexing into ring-side history.** A
  numeric mark plus retained snapshots would need either unbounded history or a
  stale-mark path with no honest answer — `textSince` returns `string`, so a stale
  mark could only fail open (the stale banner re-arms) or fail closed (the detector
  goes blind). Making the mark self-contained deletes that failure mode instead of
  choosing a side of it. Cost: `turnOutputMark` changes type from `number` to
  `RingMark` at four sites, all of which were already known.

This is **strictly stronger** than the byte count for the case that motivated
per-turn scoping: a line already on screen at the mark is excluded no matter how
little has been printed since, whereas the count only excluded it once enough bytes
had arrived to push it past the mark offset — which is exactly the limitation
`spawn.ts:327-338` documents. It is weaker in one scoped way, recorded rather than
hidden: a line that was on screen at the mark, scrolled off, and returned
byte-identical reads as not-new.

The class keeps the name `PtyRing` even though it is no longer a ring, because "the
ring" is the component's name across the issue, the docs and this repo's prose, and
renaming it would churn ten files while making every existing citation wrong. The
*methods* are named honestly instead — `replace`, not `append`; `mark`, not
`totalBytesAppended` — and the docstring states what the object now is.

### Three things the poll loop has to get right

Each is a case where a naive loop looks correct on a steady screen and is wrong in
production.

1. **Deliver only on CHANGE.** `lastDataAt` drives the 900 ms idle gate
   (`DEFAULT_IDLE_QUIET_MS`, `signatures.ts:124`) that `waitForReplIdle`
   (`spawn.ts:1128-1134`) runs before every inject from `pool.ts:553`. A loop firing
   per tick keeps `lastDataAt` permanently fresh, so the REPL never reads as idle
   and every inject waits out the defensive cap instead of the quiet window. This is
   also *why* the poll bound is ≤250 ms: `lastDataAt` only advances when a poll
   observes a change, so the interval is the resolution at which "still emitting"
   is observable at all. 250 ms leaves 3.6× margin inside 900 ms.
2. **A failed read is not an empty screen.** A pane vanishes on exit taking its
   output with it, so the ring is the only record of a dead REPL's last output. A
   read that ERRORS is dropped; a read that SUCCEEDS and is empty is delivered,
   because that is a genuinely cleared pane and the falling edge needs it. The
   distinction is the whole guard: `try { read } catch { deliver('') }` satisfies
   either case alone.
3. **Ask for `viewport_rows + wanted` lines.** Measured decisively: on a pane with
   three content lines under a 62-row viewport, `recent_unwrapped lines=10` returned
   **empty** (`truncated: true`) while `lines=200` returned all three. Blank
   viewport rows count toward `lines` before trimming. `wanted` is 200 =
   `DISCLAIMER_BOTTOM_N` (`signatures.ts:78`), the widest window any detector reads.

### What I measured versus what I took on the order's word

**Measured on the wire myself:** protocol 20 and the `pong` shape carrying it;
`pane.read` returns `revision: 0` always (inert, so the bridge mints its own poll
sequence); `pane.output_changed` rejected by both `events.subscribe` and
`events.wait`; `pane_exited` carries only `{type, pane_id, workspace_id}`; 91
methods; `LayoutNode` type `pane` carries `command: string[]`; **`layout.apply`
genuinely execs** — `pane.process_info` reported `shell_pid: 2686118` equal to
`foreground_processes[0].pid`, the argv's own `/bin/sh -c …`, with no shell wrapper;
the read cap is exactly **999 lines** (`lines=5000` on a pane that printed 1500
returned 999, `truncated: true`) — so the request is CLAMPED to it rather than sent
unconditionally as `viewport + wanted`: the two constraints stop being jointly
satisfiable at a viewport of `cap - wanted` = **799**, and at 800 an unclamped
request asks for 1,000, gets 999, and silently delivers 199 of the promised 200
content lines. The policy is clamp AND SAY SO — `herdrReadWindow.contentAllowance`
reports what the request can still carry (negative past the cap, which is a
different fact from zero) and the host warns once naming the shortfall. The original
bounds test used viewports of 24, 62 and the 120 fallback, all well below 799, so it
proved the total was under the cap only for the values it happened to pick; the
blank-row rule above; `ctrl-c` **rejected**
(`invalid_key: unsupported key ctrl-c`) while `enter`, `esc`, `escape`, `tab`,
`up`, `down`, `left`, `right`, `ctrl+c` and bare digits are accepted (`arrow_up`
and `ArrowUp` also rejected); `viewport_rows` is on `PaneInfo.scroll` via
`pane.get`.

**Two things I found that the order did not mention, both load-bearing:**

- **`layout.apply` REPLACES a tab and mints new ids.** A request naming `w6:t2` was
  answered with `tab_id: w6:t3` and a fresh pane id, the old tab gone and its label
  inherited. A host that assumed the tab or pane it asked for would be driving the
  wrong pane. The client reads `result.layout.root.pane_id` out of the reply, and a
  test asserts the id used for reads is one the host could not have guessed.
- **An unparseable request comes back with `id: ""`.** The server cannot say which
  request failed, so a client correlating purely by id would wait forever on the one
  malformed request — precisely the shape a protocol bump produces. A reply whose id
  matches nothing pending therefore fails every in-flight request.

**Taken on the order's word:** that `agent.start` shell-quotes argv and types it
into a running shell and that its `kind` is a compiled-in enum (not re-tested — the
schema confirms `kind: string` against a server-side enum, and `layout.apply`
measured good, so nothing rested on it); that `ctrl+c` delivers a real SIGINT (I
confirmed the key is accepted, not that a SIGINT arrived); that `send_text` never
submits (I did not type into a live prompt — the design converts this into a loud
refusal rather than relying on it silently).

### Where the herdr API cannot express what `PtyHost` promises

- **No exit codes, anywhere.** `pane.exited` carries no status. `exited` therefore
  resolves **`null`** — the interface's existing "terminated, no code" value — and
  crash-vs-recycle collapses entirely onto `wasKilledByUs`. `null` is not only the
  honest value, it is the only one that preserves behaviour: `spawn.ts:565` reads
  `!killedByUs && exitCode !== 0`, so `null` keeps a real crash classifying as a
  crash, while resolving `0` would route every crash to `unregister()` and blind the
  crashed-agent detector.

  **There is a FOURTH route to a terminal child, and it is not a child event at
  all: the transport dying.** `pane_exited`, `pane.close` and a vanished pane each
  say something about the process; a closed socket says nothing about it — what died
  is the channel we would learn through. The poll loop used to simply return when
  `client.isClosed()` went true, so `exited` never resolved, `hasExited()` stayed
  false, and the pool kept handing out a REPL it could no longer observe or drive.
  "I cannot observe the child" now reaches the SAME terminal handling as "the child
  exited" — on a pool that hands out live sessions there is no other safe answer —
  and `PtyChild.exitCause` (`'pane-exited'` / `'closed-by-us'` / `'pane-vanished'` /
  `'transport-lost'`) keeps the two from being confused, since `exited` cannot carry
  the distinction when every death resolves `null`. Terminal is not the same claim
  as "the process ended", and nothing may report it as one.

  **One consequence, stated because it is a judgement and not a deduction.** A
  transport loss is not `wasKilledByUs`, so `spawn.ts`'s classifier sees
  `!killedByUs && exitCode !== 0` and marks the record CRASHED — surfacing it to the
  crashed-agent detector. That over-claims slightly: the process may well still be
  running and we simply cannot see it. The alternative is to treat it as an
  intentional termination, which unregisters silently and loses the signal entirely
  — and a REPL that disappears without trace is the same family as the bug being
  fixed. Surfacing beats silence here, and `exitCause` is what stops "crashed" being
  read as "the process crashed". Refining supervision to consume `exitCause` and
  report transport loss as its own class is a separate change, deliberately not made
  here.

  **The exit-code half of that condition now carries no
  information at all**, and that is pinned twice: at the host
  (`herdr-no-exit-codes.test.ts` — a crash and a recycle produce the *same* exit
  value and are told apart only by `wasKilledByUs`) and end-to-end through the real
  spawn exit handler (two new `herdr shape` cases in
  `crashed-agent-real-exit.test.ts`: the same `null` with opposite verdicts). The
  code-0 case there is kept, annotated as a guard on the classifier rather than a
  shape production can still produce, because deleting it would leave that branch
  untested.
- **`pane.resize` cannot set cols × rows.** It takes `{direction, amount}` — it
  nudges a split ratio; herdr's layout engine owns pane geometry and there is no
  cols × rows setter in the API. `PtyChild.resize` is therefore **optional** (the
  `writeKey?` / `wasKilledByUs?` pattern already in this interface) and `HerdrHost`
  does not implement it. It has **zero production callers** — the only `.resize(`
  in the repo was `bun-terminal-host.ts`'s own internal call, and the same grep
  finds that hit, so the absence is a real absence and not a broken grep. Nothing
  is narrowed. `PtySpawnOpts.cols`/`rows` are documented as advisory and ignored.
- **`send_text` never submits.** Rather than leave a silent no-op, `write()`
  **refuses** data containing `\r` or `\n` and names `writeKey('enter')` in the
  error; `writeKey`/`writeKeys` are the honest sibling that does submit, and the
  same test shows it working. The three production call sites send text then an
  `enter` key (`pool.ts`, `context-reset.ts`, `session-size-watchdog.ts`), and their
  tests require the **pair** — a `/clear` or `/compact` with no following `enter` is
  a command typed at a prompt and never run, so counting the text write alone would
  have kept passing while the feature was dead.

  **CORRECTED (review r2).** An earlier draft of this record claimed the pair was
  already sent at every production call site. It was not. Two of the three wrote
  `child.writeKey?.('enter')` — OPTIONALLY CHAINED, because `writeKey` is optional on
  `PtyChild`. For a child implementing `write` but not `writeKey` (a legal
  `PtyChild`) that typed `/clear` at the prompt, SKIPPED the submit, and returned
  `{status:'reset'}`: a reset that did not happen, reported as one.

  Worth recording rather than just fixing, because **I had already found this exact
  trap from the other side.** The `sendKey`/`sendKeys` byte fallback writes
  `encodeKey('enter')` = `\r`, which this backend's `write()` refuses — pinned with
  M24 and written up above as "one latent trap found on the way out". I fixed the
  path that would THROW and left the path that silently SKIPS, which is strictly
  worse because it reports success. **`?.` on a method whose absence changes the
  OUTCOME is a silent skip wearing the clothes of a safe default**, and having just
  reasoned about the throwing twin did not make me look at the optional-chained one.
  Submission is now mandatory: `submitCommand` (`signatures.ts`) refuses when the
  structured-key seam is absent, and `actuateSessionContextReset` turns that into
  `{status:'failed', detail}` — the honest sibling of the success it used to report.
- **`kill(signal)` has one real signal.** SIGINT maps to `ctrl+c`; anything else
  means "end this process", which only `pane.close` can do.

### One interface change beyond what the order specified, and why

**`PtyHost.spawn` is now `async`.** Creating the terminal is a socket round trip, so
the child's `pid` cannot exist when `spawn` returns — and `spawn.ts:504` reads
`child.pid` synchronously, feeding it into the live-process registry. `pid` is
load-bearing above the host: `supervision.ts:997-1003` probes it with
`process.kill(pid, 0)` and `supervision.ts:415-417` with `isPidAlive`, and the
crashed-agent registry keys entries on `(name, pid)`. The alternatives were to hand
back a child whose `pid` reads 0 for a window (a wrong pid registered permanently,
which is the silent narrowing this work explicitly forbids) or to add a second
`whenReady` concept for one caller to await. Awaiting the spawn fixes it at the
construction site rather than asking every reader to know about the window, which is
the preference `CONTRIBUTING.md` states. The host also **refuses** a spawn whose pid
never arrives rather than inventing one. Cost: ~40 test fakes gained `async` /
`Promise<PtyChild>` — mechanical, and `onData` → `onScreen` touched only the four
files that actually used it.

`onData` became `onScreen(screen: string)` for the same reason in the other
direction: a callback named for a byte chunk that delivers a whole rendered screen
would be false at every call site, and the ring beneath it would have gone on
appending screens to itself. The test fakes that drive it now keep an accumulating
`screen` and emit all of it, which is what a real scrolling pane looks like — and it
is what makes the existing auth-failure cases keep meaning what they meant: case 5
*requires* turn 1's banner to still be on screen during turn 2, which is exactly how
it proves the baseline diff excludes it.

### Protocol version

The socket server does **no** version check (only herdr's CLI guards) and the
protocol went 20 → 22 in 19 days. `connectHerdr` pings first, compares against
`HERDR_PROTOCOL_VERSION = 20`, and **throws**, naming both numbers — no warning, no
degraded mode. The gate is **equality, not a floor**: an older server is as
unverified as a newer one, and a `>=` check is a specific wrong implementation the
tests rule out in both directions.

### A green check count on a stacked PR is not a green PR

Recording this because the number looks complete on its own, and because the same
tell caught another lane the same day.

**A PR stacked on a non-`main` base gets 13 checks. A PR based on `main` gets 17.**
Measured: `gh pr view 641 --json statusCheckRollup` returned 13 entries, while
#636, #638 and #642 — all based on `main` — each returned 17. The four absent from
the stacked PR are exactly `CodeQL`, `Analyze (actions)`,
`Analyze (javascript-typescript)` and `Analyze (python)`.

**The reason is invisible from inside the tree.** `.github/workflows/` contains
only `ci.yml` and `leak-gate-nightly.yml` — there is no CodeQL workflow to read, so
grepping the repo for one finds nothing and proves nothing. CodeQL here is GitHub's
**default setup** (`GET /repos/:owner/:repo/code-scanning/default-setup` →
`state: configured`, languages `actions`, `javascript`, `javascript-typescript`,
`python`, `typescript`), and default setup scans pull requests against the DEFAULT
BRANCH only. `main` is the default branch, so a PR based on `feat/537-stable-reply-sink`
is never security-scanned at all.

So **13/13 on a stacked base is provisional, not green**, and this change — a new
socket client, a new ring implementation and a new key encoder — is exactly the
surface CodeQL exists to read. The same day, CodeQL failed #638 with two
high-severity alerts, one of which led to a guard blind to any `$`-prefixed
identifier that its author had shipped believing the file was covered.

**`gh pr checks` dedupes to the latest run; `statusCheckRollup` does not.**
Retargeting a PR's base cancels the in-flight run (ci.yml's concurrency group) and
starts a fresh one, and for several minutes `statusCheckRollup` returns BOTH — 28
entries here, the cancelled run's 13 plus the new run's 17, carrying a
`test: FAILURE` that belongs to the cancelled side. A count read in that window is
meaningless in both directions: inflated, and carrying a failure that describes
nothing. Read `gh pr checks` for a verdict, and treat a rollup count taken during a
re-run as no reading at all.

**A review can also be partial without saying so in its verdict.** One pass over
this branch read the first 6,000 of 6,269 diff lines; its conclusions simply did not
cover the remainder, and nothing in the verdict line said which part it had seen.
Same family as the check count: an output that looks complete because it is
well-formed. The tail here was re-read by hand — `repl-session.ts` (the `RingMark`
type change), `spawn.ts` (the host swap, the `await`, `onScreen` → `ring.replace`),
`supervision.ts` (a comment), `signatures.ts` (`submitCommand`),
`session-size-watchdog.ts` (`COMPACT_COMMAND` + the enter submit) and two mechanical
`async spawn` test edits — and every change in it is one already covered by a
mutation above (M7/M9, M23, M26, M22, M24). Nothing new was found, which is the
result, not the reason to skip the pass.

**The tell is a check count BELOW the rollup's**, and it is worth naming because
every individual check says `pass` and the summary line reads complete. Compare the
count against a `main`-based PR before calling a stacked one green, and gate the
REBASED head — the full 17, CodeQL included — not the stacked one.

**Rebasing onto `main` is therefore not tidiness; it is the only path to being
scanned at all.** That distinction is the whole point, and getting it wrong is what
keeps a stacked PR unscanned indefinitely: "rebase when the base lands" sounds like
housekeeping that can wait, and it is in fact the difference between scanned and
unscanned. This branch was rebased onto `main` BEFORE #537 merged, once a pre-flight
showed the change was independent of it — `git rebase --onto origin/main HEAD~1`
applied cleanly and the suite came up 879 pass / 0 fail against plain `main`. #537
was a BASE, never a dependency, and treating it as one had turned two independent
merges into a serial chain behind someone else's open gate.

**And this is a third authority for an absence claim.** The repository's own rule is
that an absence needs a grep with a positive control. That is necessary and here it
is not sufficient: a working grep over a correct checkout still reports nothing,
because the fact does not live in the repository. Three places an absence can hide:
the FILESYSTEM (a stale checkout), the REF (the wrong commit), and — this one — the
API, where the configuration lives outside version control entirely. The last is the
least obvious, because the repo looks like the complete source of truth and the grep
looks like it worked.

### An obligation starts when the resource exists, not when the function succeeds

Review r3 found three more, and they are one defect in three costumes. Each is a
resource or state obligation that begins at an EARLIER moment than the code
acknowledged, and each was invisible for the same reason: **the happy path
established the obligation and the error path was written as though it had not.**

- **A failed spawn leaked the pane.** After `layout.apply` returns, the pane and the
  `claude` process inside it EXIST. Both initialization failures after that point —
  the pid never arriving, the exit subscription refusing — closed only the
  CONNECTION. The caller got a rejected spawn while the process kept running
  unmanaged, and nothing held a record of it, because the pool never learns about a
  spawn that failed. **That is an orphan manufactured in the constructor, on an error
  path, where nobody will ever look for it** — the same class two other lanes spent
  the day on (#642, a death nobody can attribute; #577's P0, an orphan holding a
  credential nobody revokes), except created at birth. `abandonPane` now sends a
  best-effort `pane.close` on every post-creation failure, and does NOT fire when
  `layout.apply` itself failed, because then there is no pane and no obligation.
- **The viewport was cached forever.** `viewport_rows` was read once, while
  undefined. A pane resized from 62 to 300 rows went on requesting 262 — and under
  this backend's own blank-row semantics, where blank rows count before trimming,
  that request can return NO CONTENT AT ALL. Every positional detector blind, nothing
  failing. Re-read every `HERDR_VIEWPORT_REFRESH_MS` (5 s ≈ 20 polls), keeping the
  last MEASURED height when a read cannot conclude rather than falling back to the
  constant.
- **The client ignored short writes.** `SocketLike.write` returns the bytes
  ACCEPTED, and `call()` discarded it. A socket that took zero bytes, or half a
  frame, left a pending promise whose request never reached the server: a HANG, not
  an error — and the one "the channel is not working" shape `'transport-lost'` did
  NOT cover, because the socket is open, nothing threw and nothing closed; the bytes
  simply did not all go. A short write is now terminal: it fails the call and kills
  the connection, which surfaces through the `'transport-lost'` route built one round
  earlier. Retrying partial frames was the alternative and was declined — correct
  resumption is real work, and a transport that cannot accept a frame is not one this
  host should keep driving a REPL over.

**The test fake could not see this class by construction.** Every framing test used a
transport returning `d.length` unconditionally, so no short write was expressible.
The fake now takes an `accepts(frame) => number` function, and two of the pre-existing
framing tests — which stubbed `write: () => 0` — went red the moment the guard
landed, which is the guard working rather than a harness detail.

**One thing my own mutation run corrected, and it is the useful part.** I wrote the
byte-vs-string-length comparison with the failure direction BACKWARDS, claiming that
comparing `String.length` would make a good write read as short. M34 survived, which
said otherwise: `String.length` counts UTF-16 units, which is SMALLER than the byte
count for any non-ASCII frame, so comparing against it makes the check too **lax**,
not too strict — a socket accepting 42 of 45 bytes on a 40-unit frame is genuinely
short, `42 < 40` is false, and it hangs exactly as before. One accented character in
an argv, cwd or env value opens that gap. The test now lands inside it (accepted >
units, accepted < bytes) and asserts the gap is real before asserting the refusal.

### A measurement is only about what it measured

Review r4, and the sibling to r3's lesson. Every one of these is a **false claim of
knowledge**: "the pane is gone" from a failed question, "the stream is fine" from a
stream the code had just declared bad, "this is 400,000 bytes" from a count of
something else. A rejection measures the CALL, not the pane. `.length` measures
UNITS, not bytes.

- **`PtyRing`'s byte bound was a UTF-16 code-unit bound.** `replace` and
  `clampLeadingLines` compared `String.length` against `maxBytes`, so
  `'é'.repeat(400_000)` — 400,000 units, **800,000 bytes** — was retained untrimmed
  against a documented 512 KiB limit. Every bound in that file is now measured with
  `utf8Bytes`, the tail cut walks off UTF-8 continuation bytes so it can never split
  a character (an astral char is 2 units and 4 bytes, and breaks both a code-unit
  slice and a naive byte slice), and a note at the constant says the unit out loud.
  **This is M34 a second time, in a file I wrote in the same PR.** I had already
  found the units confusion in the write path, documented that code units are FEWER
  than bytes so the check goes LAX, fixed it — and left the identical error, failing
  in the identical direction, three functions away. A units confusion is never one
  site: whoever wrote one wrote the others with the same mental model. The whole
  diff was grepped for `.length` against a byte budget (with a positive control that
  found the already-fixed client site); `pty-ring.ts` was the only other production
  file, and every one of its sites now tells the same story.
- **A transient RPC failure was read as a vanished pane.** `paneIsGone` returned
  true for EVERY `pane.get` rejection — timeouts, temporary server errors, transport
  hiccups — so a live REPL was recycled and stamped `'pane-vanished'`, a claim
  nothing had observed, contradicting the method's own "definite exit" docstring.
  Measured on the live server: a genuinely absent pane answers with a TYPED
  `{"code":"pane_not_found"}` (for `pane.get` and `pane.read`, and for a malformed
  id too), so absence IS discriminable from failure. Only that code now proves it.
  The cost of the strict reading — a pane we cannot ask about keeps being polled
  instead of being declared dead — is the correct side to err on: a dead connection
  is already terminal via `'transport-lost'`, and a turn against an unresponsive
  REPL is ended by the inactivity watchdog. A confident wrong answer is the thing
  that must not happen.
- **A malformed frame left the connection usable.** The parse-failure branch said
  the stream position was untrustworthy, failed the pending calls, and left
  `closed === false` — so the next RPC went out over the very stream it had just
  declared unusable. Exactly the short-write shape from r3: the code knows the
  channel is broken and keeps using it. It now routes to `onClose`, i.e. to
  `'transport-lost'`, and the test asserts BOTH halves — pending calls reject AND
  later calls are refused — because the first half was already true before the fix.

### "Terminal" was a flag, not an action — and the units confusion, a third time

Review r5. Three blockers, all in the client transport, and the first two share one
root worth naming as one thing.

**`onClose` marked; only `close` tore down.** `onClose` set `closed = true` and
rejected the pending calls; `socket.end()` lived in `close()`, which returns early
when `closed` is already true. So both terminal routes built in r3 and r4 — a
malformed frame and a short write — went through `onClose` and **left the socket open
until the peer happened to close it**, while this record claimed they killed the
connection. There is now ONE `teardown(err)`: idempotent, ends the socket exactly
once, rejects EVERY pending request, and is the only thing `onClose`, `close`, and
all three failure routes call.

**Why it was invisible, which is the part worth keeping.** `isClosed()` returning
true is the SYMPTOM of teardown, and that is what the tests asserted — against a
fake whose `end` was a no-op nobody observed. **Asserting the flag cannot distinguish
a teardown from a relabelling.** It is the same mistake as asserting a byte bound
instead of retention (M36, found the same way), and the fix is the same: observe the
ACTION. The fake's `end` is now counted, and every route asserts "ended exactly
once", with a control that a healthy exchange ends it zero times.

**A thrown `sock.write` was the third route, and was unhandled.** It rejected only the
new request, left `closed === false`, and left other in-flight requests untouched —
so an earlier unanswered request never settled and later calls went out over a socket
that had just refused one. It now takes the same teardown.

**Inbound UTF-8 was decoded per socket chunk.** The transport called `d.toString()` on
every arbitrary chunk and `onBytes` buffered decoded STRINGS, so a multi-byte
character split across two chunks became two U+FFFD — one per half — and **the JSON
still parsed**, so nothing failed: pane text and server error messages corrupted
silently. `onBytes` now takes `Uint8Array`, buffers BYTES, and decodes one complete
line at a time. That is safe precisely because the delimiter is the byte `0x0A` and a
UTF-8 continuation byte is always ≥ 0x80, so a newline can never fall inside a
multi-byte sequence: **a line boundary is always a character boundary.** Changing the
parameter type turned every string-feeding test into a compile error, which is the
boundary becoming explicit rather than a comment asking for care.

**This was the same mental model three times in one PR** — M34 in the write path,
`PtyRing`'s byte bound, and now inbound decoding — and each time the test that missed
it was ASCII-only. So the sweep this round was not for `.length`: it was for **every
place a byte sequence becomes a string or vice versa**, across every production file
the diff touches. Eight boundaries; seven correct (`herdr-client`'s `byteLength`,
`herdr-host`'s `write` — a complete caller payload, not a stream chunk — `pty-ring`'s
`utf8Bytes`/`tailBytes`, and three `randomBytes().toString('hex')` which involve no
UTF-8 at all); one wrong, the per-chunk decode. Worth noting that
`session-size-watchdog.ts:120-131` already had the right discipline and said why —
"a `string.length` would over/under-count" — so the correct pattern was in a
neighbouring file the whole time.

**The invariant now written at the boundary: bytes are decoded exactly once, at a
point where the byte stream is known to be complete.** The multibyte test splits a
frame at EVERY interior byte boundary, and again one byte per delivery, asserting the
exact decoded content rather than a successful parse — because a successful parse is
what made this silent.

### A channel can be unusable without anything about it being false

Review r6. Two blockers, and the first is the fourth route to a dead channel.

**An answered-nothing RPC hung forever.** `call()` installed a pending promise with
no clock after a SUCCESSFUL full write. Zero writes, partial writes, thrown writes,
malformed replies and closed sockets are all routes where SOMETHING GOES WRONG, and
each hands you something to react to. A socket that accepts the entire frame and then
never calls `onBytes` or `onClose` hands you nothing — no error, no close, no event —
with `isClosed()` cheerfully false. That is the step past r5's lesson: **asserting the
flag cannot distinguish a teardown from a relabelling, and here there is no flag to
assert at all. Liveness needs a clock, not a predicate.**

It hung the two worst places. `connectHerdr`'s `ping` is mandatory, so an unbounded
wait there means the gateway never finishes starting and there is nothing to read;
and any `pane.read` stalls the poll loop. `HERDR_RPC_TIMEOUT_MS` (10 s — far above
`layout.apply`, the slowest call this client makes, and 40× the poll cadence) now
bounds every request, and it fires through the SAME `teardown()` the other five routes
reach. The clock is cleared the moment a reply lands, so a healthy connection is never
torn down — mutated in both directions (M48 no clock, M49 clock never cancelled).

**`kill('SIGINT')` latched `wasKilledByUs` and blinded every later crash.** The host
set the flag BEFORE distinguishing the signal, then sent `ctrl+c` and returned without
terminating anything — leaving the child ALIVE and marked intentionally-terminated.
`spawn.ts` treats any `wasKilledByUs()` child as a clean recycle, so a genuine crash
after an interrupt was silently unregistered.

This matters more here than it would anywhere else, and this document's own brief says
why: **herdr has no exit codes, so crash-vs-recycle collapses entirely onto
`wasKilledByUs`.** Latching the only discriminator you have, on a NON-TERMINAL
operation, destroys it for the rest of the child's life. Only terminal operations latch
it now; SIGINT is a transient intent and has its own `wasInterruptedByUs`, documented
as never licensing an exit verdict.

**And my own test asserted the contradiction as intended behaviour** — `hasExited()`
false AND `wasKilledByUs()` true, with a comment explaining the second as correct.
That is the same failure as a "KNOWN GAP" arm: **a test that documents a contradiction
instead of refusing it.** When a test's own assertions describe a state that cannot be
coherent — alive *and* killed-by-us — the test is the signal, not the fixture. It now
refuses it, and the regression the gate named is pinned: SIGINT, then an unexpected
exit, classified as a crash through the exact expression `spawn.ts` evaluates.

### A category defined by how it fails, rather than by what it must be

Review r7. Two blockers, and neither is a mistake inside a category this build had
modelled — they are two categories that were never on the list. Six rounds hardened
the transitions between enumerated states; these are states nobody enumerated.

**Valid JSON of the wrong shape escaped the malformed-frame teardown.** The category
built for was **"the parser throws"**, so everything `JSON.parse` ACCEPTS and the
protocol forbids fell outside it. `JSON.parse('null')` returns `null`, and the first
property read (`null['event']`) throws a `TypeError` out of `onBytes` — past the
teardown entirely, leaving pending requests and socket cleanup to whatever happened
next. Worse, `[]\n` and `{}\n` did not even throw: they parsed, matched nothing,
and were **silently ignored**, which is the failure mode with no signal at all. `{}` is
the instructive one — it parses, it IS an object, and it answers nothing.

`classifyEnvelope` now requires a non-null non-array object carrying one of herdr's two
actual shapes (`{event, data}` or `{id, result|error}`, the latter including the
measured `id: ""`), and anything else reaches the same teardown as a parse failure.
Nine boundary shapes are pinned — `null`, `[]`, `{}`, a bare number, string and
boolean, an id with no outcome, an outcome with no id, a non-string `event` — with a
control that both legitimate envelopes still work.

**Inbound framing had no size bound.** Every chunk was concatenated with no maximum
before a newline arrived, so a peer that never sends `0x0A` grows the buffer until
exhaustion, copying quadratically on the way. The RPC clock cannot help: bytes keep
arriving whether or not a request is waiting.

**And this is the undeclared half of the risk this record already names.** The protocol
went 20 → 22 in nineteen days with no server-side version check, which is exactly why
the `ping` comparison exists — but that catches a change the server DECLARES. A framing
change it does not declare (a different delimiter, a length prefix, a binary envelope)
presents as precisely this: bytes that are well-formed so far and never terminate.
`HERDR_MAX_FRAME_BYTES` is 8 MiB, derived rather than picked (a 999-line screen bounded
at 512 KiB, times several-fold JSON escaping, is low single-digit megabytes), and
exceeding it tears down. Tested EXACTLY at the limit — where a legitimate maximal frame
must still complete, because a bound that rejects one is a new failure mode — one byte
over, and accumulating one byte at a time so the limit is on what has gathered rather
than on any single delivery.

**The shape worth keeping, and it extends r6 cleanly.** A channel can be unusable
without anything about it being false; and **a payload can be well-formed without being
valid, and well-formed-so-far without ever being complete.** "Malformed" was defined by
the parser's behaviour instead of by the protocol's requirement, and "a frame" was
assumed bounded because frames are normally small — an expectation, not a limit.

**M53 survived first, and the reason is this session's dominant defect again.** My
boundary tests used a 5 s RPC clock, so a client that simply IGNORED a bad frame was
still torn down — by the timeout, seconds later — and the tests passed without the
validation existing. They were asserting the observable (`isClosed()` eventually true)
rather than the requirement (torn down BECAUSE the frame was invalid). Fixed by pushing
the clock out to 60 s and asserting `isClosed()` SYNCHRONOUSLY on the same tick as the
frame, where no timer can have run. That is the fourth time this build a test of mine
asserted what the code does instead of what must be true.

### A guard must run before the thing it guards, and a producer must not start before its consumer can exist

Review r8, and this is the ordering twin of r3's lesson. Both failures are CORRECT CODE
IN THE WRONG POSITION, which is why every unit of it reads fine in isolation.

**The first screen could be delivered before anything could scan it.** `spawn()` started
the poll loop before constructing and returning the child. The caller cannot assign
`scanChild` until `await ptyHost.spawn(...)` resolves, and `onScreen` returns without
scanning when it is undefined — so with an immediately-resolving RPC (which the fake
server demonstrates) the poll continuation delivers the initial screen before the caller
resumes.

**And because snapshot-replace deliberately suppresses an unchanged screen, that screen
is never delivered again.** A startup trust prompt or approval dialog therefore goes
unscanned and undismissed for the life of the child — a REPL alive, polling, and
permanently waiting on a prompt nobody saw. That is the worst outcome available to the
detector path, and the first screen is exactly where trust prompts live.

**Provenance, worth recording because the earlier decision was right.** Making `spawn`
async was correct: a synchronous one handed back a child whose `pid` read 0 while
`supervision.ts` probed it, and fixing it at the construction site beat patching the
reader. It also created this window, which did not exist when the caller received the
child synchronously. The general form: **an `await` inserted between a producer and its
consumer creates a window for everything the producer already started.**

Fixed by ordering, not retry: `PtyChild.beginOutput()` is an explicit readiness boundary
the poll loop awaits BEFORE its first read — before it can mutate the ring or stamp
`lastDataAt`, not merely before it delivers. `spawn.ts` calls it as the last step of
wiring, after `scanChild` and `liveHandle`. The gate FAILS OPEN after
`HERDR_OUTPUT_GATE_MAX_MS` with a loud warning, because withholding output forever is
worse than delivering it late: a REPL whose screens never reach the detectors is wedged
silently and looks idle. The gate orders delivery; it does not authorise it.

**The frame bound was checked after the dispatch it should prevent.** `onBytes` located
and decoded each complete line, dispatched it, and only THEN checked `maxFrameBytes`
against what remained UNTERMINATED. So a valid 1 MiB reply followed by `\n` parsed
normally — by the time the check ran the buffer was empty. The bound guarded
ACCUMULATION, not A FRAME, and the exposure it was added to close stayed open for every
oversized frame that arrived terminated. Every earlier test fed bytes WITHOUT a newline,
exercising only the half that already worked.

The size check now runs on `nl` — the frame's byte length — before anything reads its
content. And per the review's prompt to check the rest of the ordering: the deliberate
order in `onBytes` is now (1) size on bytes, (2) one decode of a complete line, (3)
parse, (4) envelope validation. Steps 3 and 4 are necessarily after the decode — you
cannot parse bytes you have not decoded — so that ordering is inherited AND correct; the
size check's was inherited and wrong.

**One test of mine passed for the wrong reason again, and M58 found it.** The
first-screen-signature test registered its scanner synchronously after the await, which
with an immediately-resolving fake left the race tight enough that removing the gate
entirely still passed it. Widening the window with a deliberate `await` before wiring
made it real: the requirement is what must be pinned, not the narrowness of one caller's
window. Fifth instance this build of the same shape.

### Settlement is not confirmation, and a detached write cannot support any claim about its effect

Review r9, and the deepest of the seven, because the code was not wrong about anything
it *did* — it was wrong about what it was entitled to *say*.

**A failed `pane.close` reported a clean termination.** `kill()` settled from
`.finally()`:

```ts
client.call('pane.close', { pane_id: paneId }).finally(() => settleExit('closed-by-us'))
```

`.finally()` runs on rejection too. So a `pane.close` the server REFUSED still resolved
`exited`, flipped `hasExited()` to true and reported `exitCause()` as `'closed-by-us'` —
a live REPL recorded as cleanly ended, with the pane still sitting there. Two separate
things broke on that one word. `terminateChild` (`repl-session.ts:357-377`) returns early
at **both** of its `child.hasExited()` guards — 361 and 370 — so the SIGKILL rung of the
escalation ladder never ran and the process leaked; and `killedByUs` latched on an
attempt that closed nothing, which, with no exit codes anywhere in herdr, is the
*entire* crash-vs-recycle discriminator, so every later real crash on that still-living
child read as an intentional recycle for the rest of its life. Exactly the failure mode
r6 wrote up for SIGINT, reached by a different road: **only a CONFIRMED terminal
operation may latch it.**

The fix is not to settle later, it is to settle on a fact: `.then(onOk, onFail)`, with
`settleExit` only on the success arm, and the kill flag CLEARED on the failure arm. Not
settling is also what re-arms the ladder — `hasExited()` stays false, the grace race
times out, and `kill('SIGKILL')` makes a second bounded attempt. **Escalation is the
retry**; nothing else had to be built for it.

One simplification fell out of trying to mutate it. I first kept two flags — an
`attempting` and a confirmed `killedByUs` — and could not construct a mutation that
reddened for dropping the second, because after a confirmed close the two are true in
exactly the same states. **Unobservable state cannot be tested, only believed**, so it
collapsed to one flag: set when a terminal kill is REQUESTED (which is what makes a
`pane_exited` racing our own close read as intentional), cleared if that request fails.

**And `write`/`writeKey` could not support what their callers claimed.** The same defect
one layer up, and a repeat offender: r4 fixed `writeKey?.('enter')` silently skipping the
submit, and `context-reset.ts` still returned `{status:'reset'}` for a reset that never
happened — now because `write` and `writeKey` are `void`. Over a socket they hand a frame
to the transport and return; a REFUSED frame and a delivered one are the same observable
event. The worst case is the partial one: text accepted, Enter refused, so `/clear` sits
typed at the prompt with the full context intact, and the pool records an empty one.

So `PtyChild` grew `submitLine(command): Promise<void>` — the acknowledged operation —
and `submitCommand` uses only that, refusing a child that lacks it **even when that child
has both `write` and `writeKey`**. What is refused is the unacknowledged seam, not the
keyless one. Both callers now `await`: `context-reset.ts` turns a rejection into
`{status:'failed'}` with the backend's reason, and `pool.ts`, whose policy is
log-and-proceed, emits its `context-reset /clear failed` line — which, on that path, is
the only thing in the world that distinguishes a reset from a non-reset.

That last point is worth its own note, because I nearly recorded it as untestable.
M26b (r6) survived against the `pool.ts` path and I reported it inapplicable, reasoning
that a path which logs and proceeds has no discriminating outcome. That was wrong, and
M70 was the same mutation arriving again: the log **is** the outcome. The requirement is
not "the import fails" (it must not — a stranded import is worse than a stale context);
it is "the operator can tell". A test capturing stderr, plus the control that an accepted
submit reports nothing, kills it. *Inapplicable* was a conclusion about my test harness
that I had dressed up as a conclusion about the requirement.

**And one thing the tree caught that I did not.** My first fix was
`.then(onOk, onRej)`, which is correct JavaScript and wrong here: a two-arg `.then`
handles the rejection BEFORE `fireAndForget`'s own `.catch`, so the failed close would
never have been counted or logged as a background rejection — a second, quieter version of
the same mistake, losing the evidence instead of the escalation. `scripts/ci/lint.sh`'s
PRE-SWALLOW GATE named it with the file and line and told me the shape to use
(`logger/fire-and-forget.ts:119-137` takes an `onError` third argument). It is now a
one-arg `.then` with the failure handling in `onError`, so the rejection is counted, logged
and *then* acted on. Worth recording because the gate found a defect class I had just
written two thousand words about.

**The third submit site is left alone, deliberately.** `session-size-watchdog.ts:326-345`
also does escape + text + `enter`, still fire-and-forget. I checked whether it belongs in
this fix and it does not: it never claims the compaction HAPPENED. It returns "we pressed
it", and it stamps the mid-compact lock BEFORE the writes precisely so a transport failure
cannot double-send `/compact` — with `compactLockMaxMs` releasing the lock so a failed
compaction is retried (`:326-328`). That is already the shape the P0 asked for on the
other path: retain state that permits bounded retry rather than assert an outcome.
Converting it would mean making a synchronous policy function async for no change in what
anyone is entitled to believe. Scoped and named, not silently narrowed.

**And the fake had to stop being agreeable — for the third time.** `pane.close` returned
`{type:'ok'}` unconditionally, so no test could have caught any of this. That is the
third requirement class this one fake has hidden: a no-op `end` hid a teardown that never
closed the socket (r5), a `write` that always returned `d.length` hid the short-write
class (r6), and now an unfailable `pane.close`. Each was fixed one method at a time,
which is precisely why there was a third. Failure is now injectable for **any** method
(`failMethod`/`clearFailure`), and so is latency (`holdMethod`) — the in-flight window is
where the `pane_exited` race lives, and a fake that answers instantly collapses that
window to nothing and makes every in-flight property vacuously true.

### The same defect a third time, in the validator — and the document sweep

Review r10, and the shape is now unmistakable, because it arrived through a third
completely different door.

**An exit event was silently dropped.** `classifyEnvelope` built the event envelope as
`data: asObject(o['data']) ?? {}`. The `?? {}` turns an ABSENT, `null`, array or
primitive `data` into a well-formed empty object: the frame validates, the handler is
called with `{}`, the `pane_id` comparison in `herdr-host.ts` fails, and the exit is
**ignored without a word** — the child keeps polling a pane that no longer exists.
`{"event":"pane_exited","data":null}` was accepted as valid and did nothing.

That is the r9 lesson with the actors swapped: **a missing fact coerced into a
well-formed empty one, so `unknown` rides the branch reserved for `known-and-empty`.**
In r9 a failed close became a clean exit; here a malformed frame becomes an empty
event. The remedy is the same in both — keep the two states apart and let the unknown
one reach the path built for it, which in the client's case is the malformed-frame
teardown I had already built and then routed around. It is also the defect the repo's
own memory names (*false and unknown must not share a branch*), which I had written
about in this very file before writing it into the code.

Five cases, mutated **individually**, because they are not one case: `in`/`undefined`,
`typeof null === 'object'`, `Array.isArray`, and primitive `typeof` are four different
branches, so a partial check passes some and fails others. Each single-shape leak
(M75a–M75e) reddens exactly its own case and nothing else, which is the proof that no
case in the table is redundant. And the pair matters as much: `data:{}` is genuinely
empty and must stay VALID (M74b), or "require `data`" degenerates into "reject anything
falsy" and breaks a legitimate fieldless event.

And the typechecker caught a weak assertion the runtime could not. My first control
reused one `seen` variable, resetting it to `undefined` before the second event —
which `bun test` accepted and `tsc` rejected, because the reset narrows the type. The
narrowing was pointing at a real gap: with a single overwritten variable, "the second
event arrived carrying `{}`" and "the second event never arrived, and this is still the
first one" are the same observation when the payloads happen to match. Collecting the
deliveries into an array fixes both the type and the assertion. Fifth time on this
branch that a gate found something I had reasoned past — and a reminder that
`typecheck-all.sh` is the gate, since `bun test` alone was green.

**The document sweep, decided per file.** Deleting a backend narrows a guard, and this
tree's rule is that every document asserting the old rule is fixed in the same change.
I had missed the worst one: `runtime/adapters/claude-code/AGENTS.md:5` still said the
REPL is hosted "(Bun-native PTY + dev-channel)" inside a sentence beginning "**It MUST
spawn…**". A per-directory `AGENTS.md` is the worst possible place to leave a stale
mandate, because it is injected into the context of the next agent working in that
directory — it would have built against a backend that no longer exists.

The sweep also taught me something about my own grep. My first pattern
(`Bun\.Terminal|bun-terminal`) found five files; the tree spells it
`Bun.spawn({ terminal })`, `Bun PTY` and `Bun-native`, and the real pattern finds
seventeen. **A grep is only as good as its guess at the vocabulary** — the absence-claim
discipline says a grep finding nothing proves nothing without a positive control, and
this is its sibling: a grep finding *something* does not prove it found *everything*.
**A completeness claim is only as wide as the instrument that checks it** — the same
defect as #638's coverage test keyed to a single spelling of an identifier, which is
why the surviving-hits check is now written as a criterion the reader can re-run rather
than a count I once got right.

Three outcomes, all legitimate, and the reason not to blanket-edit:

- **Defect — a live claim about current behaviour that is now false (7 fixed).**
  `AGENTS.md:5` (the mandate) and `:15` (the sprint log, which gets the later fact
  APPENDED so S1's history survives); `types.ts:355`, which named "Bun-native terminal
  host" as the *default* when the default is `HerdrHost`; `pty-noise.ts:18`;
  `SYSTEM-OVERVIEW.md:7630`, a present-tense claim that the regression guard "spawns
  claude under a real `Bun.spawn({terminal})` PTY" when its body now uses `HerdrHost`;
  and the docstrings of `dev-channel-pty-bind.e2e.test.ts:4` and
  `reminders/bundled-rituals.e2e.test.ts:21`, both describing a mechanism their own
  converted bodies no longer use. Plus my own `herdr-host.ts:4`, which called the
  deleted thing `Bun.Terminal` — a symbol that never existed.
- **Correct AS HISTORY — kept deliberately (5).** `spawn.ts:260` is inside an
  explicit `HISTORICAL NOTE (P0, 2026-06-26)`; `post-spawn-assertion.ts:25` records
  where a still-live design decision was *verified*; `SYSTEM-OVERVIEW.md:7569` records
  where a bug was *reproduced*; and both `docs/research/AS-BUILT-*-archive-2026-07.md`
  are archives. Those sentences are true statements about the past, and the harness
  was the Bun PTY at the time. Rewriting them would forge the record — the same reason
  an immutable decision log is never edited to match today's architecture. A
  find-and-replace across the sweep would have destroyed all five.
- **Already correct (2).** `pty-host.ts:12` and `__tests__/pty-noise.test.ts:4` had
  already been updated to say the Bun backend is gone.

Filenames stay. `dev-channel-pty-bind` and `pty-noise` are still accurate: a herdr pane
IS a pty, and what changed is who allocates it, which is what the corrected docstrings
now say. Renaming would churn every citation to buy nothing.

### A missing CI run is not a passing CI run

Worth recording because the failure mode is silence, and the naive check is green.

After the r10 push, `gh pr checks` reported **4 checks, all pass**. The `ci` workflow —
typecheck, lint, layering, purity, the 8 test shards — **had not run at all**. Only
CodeQL's four jobs existed, and they passed, so any monitor asking "is everything
settled and non-failing?" would have answered yes on a PR whose entire test suite had
never executed.

The cause: `main` had moved (#636, #650) and the PR was `CONFLICTING`. `ci.yml` triggers
on `pull_request`, which runs against the *merge* ref — and GitHub cannot compute a merge
ref for a conflicting PR, so the workflow was never created. A conflict does not show up
as a failing check; it shows up as **checks that do not exist**.

This is the same tell as the stacked-PR check count earlier in this build (13 vs 17), and
it defeats the same instinct. So the count is now part of the condition: the watcher
requires **17 checks present AND all non-pending** before it will call CI green, rather
than "all present checks are non-pending". *All of the checks that exist have passed* is
not a claim about the checks that should exist.

And the conflict itself had a trap. `docs/spec-items/README.md` is a **generated** rollup:
`scripts/__tests__/spec-items-index.test.ts:32` asserts the committed file is byte-exact
with the renderer's output, so a hand-resolved index fails CI *even when it reads
correctly*. My hand resolution happened to be right — I checked the three counts against
the filesystem (24 items, 5 blocking, 1 needs-spec) rather than adding the two sides — and
regenerating produced a byte-identical file. That the diff was empty is the point worth
recording, not the reassurance: reading correctly and being the renderer's output are two
different properties, and only the second one is what the gate tests. Regenerate, then
assert drift is zero.

### `{}` was the representation of "nothing usable" — three doors, one defect

Review r11, and the third appearance closed the argument about what these three bugs
have in common.

**A refused RPC was reported as a successful one.** The reply envelope was validated as
`typeof o['id'] === 'string' && ('result' in o || 'error' in o)` — the PRESENCE of a key,
with no check on what it held and no objection to both. So
`{"id":"n1","error":"refused"}` passed: `error` is a string, which the protocol never
sends. The dispatcher then did `asObject(env.error)`, got `undefined` for a string,
SKIPPED the error branch, and fell through to `p.resolve(asObject(env.result) ?? {})` —
`result` was absent, so the call **resolved successfully with `{}`**. A `pane.close` or
`pane.send_keys` the server refused, handed to `kill()` as an acknowledgement.

Put the three side by side and the cause is one sentence:

| Door | The coercion | What it destroyed |
|---|---|---|
| `kill()` (r9) | `.finally()` settles either way | a failed close became a clean exit |
| event `data` (r10) | `asObject(o['data']) ?? {}` | a malformed frame became an empty event |
| reply outcome (r11) | `asObject(env.result) ?? {}` | a refused call became an empty success |

**`{}` was being used as the representation of "nothing usable", and `{}` is
indistinguishable from a legitimate empty success.** An unknown must never be spelled
the same way as a known — which is the repo's own *false and unknown must not share a
branch*, arriving a third time in a costume I did not recognise until it was pointed out.

The fix requires exactly one outcome and validates its shape, and then does something
the previous two rounds did not: it makes the invariant **the compiler's** rather than a
comment's. The reply envelope is now discriminated on `ok`, so the success path has no
default to write — with `result`/`error` both optional, TypeScript still demanded a
`?? {}` for a state the validator had already excluded, and that unreachable default is
precisely the shape being removed. A defence that relies on everyone remembering an
invariant is one refactor from being the bug again.

Eleven mutations. M76 restores the presence-only check (reddens nine cases at once);
M77 accepts both outcomes; M78 is the over-strict twin, rejecting a legitimately empty
`result:{}` — which must stay valid for exactly the reason the bug existed, since `{}`
is what the client used to invent. M79a–M79d and M80a–M80d leak one wrong-typed shape
each, and every one reddens only its own row.

### The sweep this earned, made general rather than a third instance-hunt

Having hunted this defect three times by instance, the fourth had to be found by
*class*: every place in the client, host, protocol, ring and signatures that turns an
absent or wrong-typed value into a default, asked one question — **is the default
distinguishable from a legitimate value of that type?**

**36 sites examined, 4 changed.**

Two changed by deletion (the reply path above: the validator and the dispatcher's
`?? {}`, which no longer exists). Two kept their default but stopped being silent,
because in both the fallback is genuinely needed and genuinely indistinguishable:

- **`viewportRows ?? HERDR_VIEWPORT_ROWS_FALLBACK`.** 120 assumed looks exactly like 120
  measured. A REPL whose geometry cannot be read must still poll, so the fallback stays
  — but on a 400-row pane it sizes every read for 120, each read comes back short, and
  positional detectors see less than the 200 lines they are written against with nothing
  anywhere saying why. It now says so once. The control measures a real **120**, the
  fallback's own value, so the pair cannot pass by warning unconditionally.
- **A `pane.read` that SUCCEEDS with an unusable payload.** Neither an error nor an
  answer, and the two-branch code put it in the wrong one by omission. Leaving the screen
  `undefined` was already right — the ring must not receive an empty screen, which would
  erase a dead REPL's last output — but doing it silently means a drifted reply shape is
  indistinguishable from a permanently idle REPL. The protocol-version gate catches a
  *declared* change; this catches a same-version one. Paired with a control proving the
  skip is not a latch: a client that gave up after one bad payload would pass the first
  case and never poll again.

The 32 left alone are configuration and dependency defaults (`opts.rpcTimeoutMs ??
HERDR_RPC_TIMEOUT_MS`, `options.cwd ?? process.cwd()`), casts already followed by a
`typeof` check on the field actually used, and boolean conditions that are not coercions
at all. In each the default IS the contractually correct meaning of "absent". One
deserves naming because I had to check rather than assume: `typeof err.code === 'string'
? err.code : 'unknown'` is a silent default by the letter of the test, but nothing in the
tree ever compares a code to `'unknown'` — the only code branched on is
`HERDR_PANE_NOT_FOUND` (`herdr-host.ts:605`, with the grep's positive control) — and the
message still carries `JSON.stringify(err)`, so no information is lost and the
reject-versus-resolve decision cannot flip. It is a diagnostic label, not a decision
input.

The fake gained the third lever to make any of this testable: `failMethod` (it errors),
`holdMethod` (it is slow), and now **`malformMethod` (it answers with something unusable)**.
That set is complete in the way the per-method fix was not — a successful call with an
unusable payload is its own class, and it is exactly how a same-version shape drift
arrives.

### The rule all three defects violate: once settled, a terminal state is immutable

Review r12, and it names the thing the other two were instances of.

**A cleanup path rewrote a correct answer after the fact.** `settleExit` closes the
client (`herdr-host.ts`), and closing the real client runs `failAll` — so every RPC
still in flight rejects, INCLUDING the `pane.close` we ourselves issued. The rejection
handler then reset `terminating` unconditionally. Sequence: `kill()` → `pane_exited`
arrives → the exit settles as ours → the client closes → our own close rejects as a
consequence → `wasKilledByUs()` flips from **true to false**, after the child had
already settled. With no exit codes anywhere in herdr that flag is the whole
crash-vs-recycle discriminator, so a deliberate recycle was rewritten into an apparent
crash — by a handler that never asked whether the question was still open.

The rejection is not even evidence. Once `exited` is true the pane IS gone, so the
handler's own message — "the pane was NOT closed" — would have been a false statement
about a dead pane. The handler is only meaningful while the child is still alive, which
is exactly the condition under which clearing the flag is the truth.

Put beside the other two, the three stop being three bugs:

| | What it did to the terminal state |
|---|---|
| r9 — `kill()` settling from `.finally()` | settled the WRONG outcome |
| r11 — `asObject(result) ?? {}` | settled an UNKNOWN as an empty success |
| r12 — the unconditional reset | UN-SETTLED a correct answer |

**Once a terminal state is settled, no later path may rewrite it.** Every one of the
three is that sentence violated from a different direction, and each cost a review round
because I fixed the instance rather than the sentence. The r10 sweep found the third by
class instead of by instance and was right to; this is the same move applied to
*ordering* rather than to *values*.

**The test was measuring an intermediate state.** It asserted at the point the close was
still held and never awaited the rejection handler — so the last writer to the value
under test ran after the last read of it. An assertion taken before the final handler
runs is not a measurement of the outcome; it is a measurement of a moment. It now
releases the held call, drains a macrotask turn, and asserts again.

**And the fake hid it — the fourth time.** Its `close()` only set a flag, so a held call
released after the connection closed quietly SUCCEEDED; the real client's `close()` runs
`failAll` and rejects it. The combined mutation is the proof and is worth recording
precisely: with the host defect restored AND the forgiving fake, **the test passes** —
zero failures, bug present. The fake is the enabling condition, not a convenience. So
`close()` now fails every in-flight call, because a connection closing does not leave
the requests on it in limbo; it ends them, and the code downstream has to cope with a
rejection arriving for a call it made before the close.

That is the general form of the hazard the #537 lane hit from the other side: **a fixture
that performs the step under test turns a missing implementation into a passing test**,
and a fixture that *refuses to perform a step reality performs* turns a real defect into
a passing test. Both are the fixture deciding the outcome. I checked this test's
arrangement against it: the fake only EMITS `pane_exited` — the host's own subscription
handler is what settles — and nothing in the arrangement writes the flag being asserted.

### The fourth row: the rule has to hold at the EDGE, not just in the bookkeeping

Review r13. The first three rounds were all the host's own bookkeeping; this one is the
transport, and it is the same sentence one layer down.

**`onBytes` accepted and dispatched after teardown.** It appended every chunk with no
`closed` check, so bytes arriving after `close()` still parsed into a valid frame and
still invoked subscription handlers. The event that matters is exactly `pane_exited` —
the host's handler calls `settleExit` — so a post-close frame could **re-open the
question the close had just settled**. `settleExit` closing the client is a meaningless
guarantee if the socket can still write into the host afterwards.

It also quietly undid teardown's other job. Teardown releases `this.bytes` because it may
hold up to `maxFrameBytes`; with no guard, chunks arriving afterwards started accumulating
again — the buffer teardown claims to have released grew back, bounded by nothing and
read by no one.

| | what it did to the terminal state |
|---|---|
| r9 — `.finally()` | settled the **wrong** outcome |
| r11 — `?? {}` | settled an **unknown** as an empty success |
| r12 — the close/exit race | **un-settled** a correct answer |
| r13 — `onBytes` after close | let the **transport** write after all of the above had settled |

### The sweep: `closed` existing is not the same as every path consulting it

**14 entry points examined, 2 changed.** The finding named one door; the rule names a
class, so the class was walked.

Changed:

- **`onBytes`** — the defect above.
- **`subscribe`** — it registers the handler BEFORE awaiting the acknowledgement, which
  is deliberate and must stay: an event can arrive between the request and its ack, and
  the host subscribes to `pane_exited` precisely so an exit *during startup* is still
  seen. But a REJECTED subscribe returned no unsubscribe function, so the caller could
  not remove the handler and believed it was never subscribed — a handler nobody can
  reach that the dispatcher still calls. It is now removed on failure. Registering early
  is a race win, not a licence to leave state behind.

Left, with reasons: `call` and `ping` already reject on a closed connection; `close` and
`onClose` both delegate to `teardown`, whose own `if (this.closed) return` makes it
idempotent; `dispatch` is private and reachable only from the now-guarded `onBytes`;
`failAll` is teardown-internal; `isClosed`, `bufferedBytes` and the constructor hold no
state to corrupt. The RPC timeout **timer callback** calls `teardown`, so a timer that
survives a close is a no-op — and `failAll` clears the timers as it drains. `attach` is
the one deliberate omission: it is called once by `connectHerdr` before any use, and a
silent no-op there would hide a wiring bug rather than prevent one.

### An ordering I was asked to check, which turned out not to be load-bearing — and the mutation is why I know

The question was whether `closed` is set before or after `failAll`, on the theory that
if `failAll`'s rejection handlers can re-enter the client, the ordering decides whether
the guard holds during teardown or only after it.

It is set **before**, and I initially wrote a test claiming to pin that. The test was
wrong, and the faithful mutation found it: **MOVING** the assignment below `failAll` —
rather than deleting it, which is what my first sloppy attempt did and which reddened 38
cases for the wrong reason — **SURVIVES the entire suite.**

The reason is structural. `failAll` only calls `p.reject()`, and a promise's rejection
handler runs as a **microtask**: it cannot execute inside `failAll`, so every caller
observes the flag after `teardown` has already returned, under either ordering. **The
ordering is unobservable through the promise API and therefore not a criterion** — an
assertion about it passes for both implementations, which is the exact defect I have
spent this branch removing from other people's reasoning and had now written myself.

So the line stays (it costs nothing and remains the correct ordering if `failAll` ever
gains a synchronous callback), the comment says plainly that it is not load-bearing
today, and the test was renamed to assert what it actually discriminates: a re-entrant
call from a rejection handler is refused rather than half-served.

Two smaller notes from the same run, both about my own mutations rather than the code:
M90 as first written was a copy of M89 and proved nothing, and M91 deleted the assignment
instead of moving it. **A mutation that changes more than the one thing it names cannot
tell you which thing the test caught** — M91's 38 failures looked like strong evidence
and were evidence of a different bug entirely. Rewritten, M90 now reddens exactly the
accumulation case and M89 exactly the dispatch case, which is what separates the two
requirements.

### A limit on how much you KEEP is not a limit on how much you DO

Review r14, and it is the resource version of the sentence this branch keeps rediscovering.

**Inbound buffering was quadratic.** Every chunk copied the whole accumulation through
`Buffer.concat`, so cost grew with the *number of deliveries* while the 8 MiB frame cap —
which bounds only *retention* — sat there looking like it covered the hostile case.
One-byte deliveries force on the order of **35 TB of cumulative copying** before the cap
ever trips. The guard bounded the wrong quantity: **CPU was the resource actually
exhausted, and nothing was watching it.**

There were two quadratic sources, not one. The append was the reported one; the frame
loop had the same defect a level in, rebuilding the buffer after every frame
(`Buffer.from(subarray(nl + 1))`), so a batch of N frames in a single delivery was
quadratic too. Fixed as a queue of chunks concatenated ONCE when a newline actually
arrives, plus a cursor instead of a re-slice.

**And the test load had to be chosen by measurement, not by guess.** My first attempt fed
200k one-byte chunks under a 4 s bound — and the quadratic mutant finished inside it, so
**M94 survived**. Measured on this host: the queue takes **44 ms**, the concat-per-chunk
version **21,433 ms** — a 487× separation at 200k × 8 bytes. The bound now sits ~113×
above the passing implementation and ~4× below the failing one. *The load, not just the
threshold, is what makes a performance test able to see the defect* — and a wall-clock
assertion whose margin you have not measured is a guess wearing a number.

**A third instance of the same shape fell out of the fix.** `subarray` returns a VIEW,
so a 1-byte remainder of a 2 MB delivery pins the whole 2 MB while `bufferedBytes()`
truthfully reports 1. Watching the logical length would say the buffer is empty while the
memory is still held — the identical error one layer down. The tail is copied, and
retention got its **own observable** (`retainedBytes`) rather than being taken on trust,
because the number that was already there could not see it.

### "Loudly" was half a criterion, and the half nobody asserted

The gate test named *"FAILS OPEN, loudly"* asserted only that the screen eventually
arrived. But **"the screen arrived" is IMPLIED BY failing open and says nothing about
loudly** — silence the warning and the test stayed green, against both its own name and
the spec. An assertion that is a *proxy* for the criterion is not the criterion, and
**half a compound criterion asserted is a criterion not asserted.**

It now captures stderr and requires exactly one warning that names the wiring bug and the
consequence, paired with a control that a timely `beginOutput()` warns not at all —
without which "warns once" is satisfied by warning on every spawn, making the diagnostic
worthless precisely when it is true.

The control needed a **combined** mutation to prove it discriminates, because two guards
protect it: `beginOutput` clears the timer AND the timer checks `released`. Disabling
either alone leaves the control green; disabling both reddens it (M97c).

### The evidence rule this branch converged on

Stated once, because it has now paid three times — M88b (the fake), M96c (the accessor),
M97c (the gate):

> **When a mutation survives, ask what is absorbing it; when it reddens loudly, ask
> whether it reddened for the reason you think.**

Both halves cost something real here. M88 surviving alone was what proved the fake was
the *enabling condition* rather than a convenience, and the same shape recurred exactly:
**M96b survives alone, and M96c — the view plus a logical-length accessor — is GREEN with
the bug present**, which is the proof that the accessor measuring ALLOCATION rather than
length is what makes the retention defect visible at all. And M91's 38 red cases looked
like strong evidence while being evidence of a different bug entirely, because I had
deleted the assignment instead of moving it. A mutation that changes more than the one
thing it names cannot tell you which thing the test caught.

### The fifth row, and the sign is flipped: settling on the ABSENCE of evidence

Review r15. The first four rows were a settled state being **rewritten**; this one
settles on nothing at all.

**Transport loss settled a child that might still be running.** `pollLoop` turned a
closed socket straight into `settleExit('transport-lost')` — and settlement runs the
ordinary death handling in `spawn.ts`: session marked dead, sink unregistered, pool
entry dropped, temp configs deleted. The next request then spawns another `claude`
against the same session id and the same transcript **while the original is still
alive**. That breaks one-process-per-transcript, the invariant this substrate is built
on and which is enforced ONLY by killing the old process, and it leaves a
credential-bearing process running with nothing managing it.

`pty-host.ts` says transport loss is not evidence the process exited — in the interface,
twenty lines from the code that conflated them. **"The socket closed" and "the process
exited" are different facts.** `transport-lost` is an *unknown* disposition being
consumed as a definite one, which is the `?? {}` row promoted from a field to a
lifecycle.

**Termination, not adoption — and the reason matters.** Re-attaching to a surviving pane
across a fresh socket is #539 (a gateway restart bringing REPLs back) and is not built.
Until it is, the only disposition that preserves the invariant is ending the process. So
the host now runs the SIGTERM → SIGKILL ladder against the pid it learned at spawn —
`process.kill` being exactly the right tool precisely *because* it does not need the
herdr transport that just died — and settles **only on confirmed death**, because this
branch already has a row for a kill reported as successful when it failed. What it does
not clean up is the herdr pane, which may survive empty; that is cosmetic, and the
credential-bearing process is what the invariant is about.

**And when death cannot be confirmed, it does not settle at all.** Settling would
authorise a replacement against a process we know nothing about. A stuck session is
recoverable by an operator; two live processes on one transcript are not. Loud,
deliberately not terminal.

Two survivors made this round better rather than just longer:

- **M101 (a missing pid read as confirmed death) survived because the branch is
  unreachable** — `spawn` refuses to return a child whose pane never reported a pid. An
  unreachable defensive branch is untestable by construction, so it was deleted and the
  parameter tightened to `number` rather than left as belief dressed as caution.
- **M102 (EPERM counted as dead) survived because my tests inject the probe**, so the
  real one was never exercised — and its most important case is exactly that EPERM means
  the process EXISTS and merely is not ours to signal. Reading that as "dead" is the same
  defect in its most classical form, and it would report a live child terminated
  precisely when we have least authority over it. The probe is now exported and tested
  directly against three real outcomes on this host: own pid (alive), pid 1 (EPERM →
  alive), a bogus pid (ESRCH → gone).

### The guard was well-tested and every real caller was on the wrong side of it

All three live E2E callers awaited `HerdrHost.spawn` and none called `beginOutput()`. So
each waited out the full 5 s gate, tripped the "WIRING BUG" warning, and only then began
polling — **the opt-in proofs were silently taking the fail-open path and normalising
it.** The sharpest part is the timing: I fixed the *unit* test this same round so the
warning is asserted, while the three tests that would actually trip the wiring bug in
production were the ones tripping it.

It matters most in `ritual-write-containment`, where the disclaimer and the tool-use
prompt are both answered from `onScreen` — five seconds of unwatched screens is exactly
where a prompt goes unanswered. All three now release the gate, and the flagship boundary
test captures stderr and asserts **no** fail-open warning across the whole run, so the
unit test proves the warning fires when the call is missing and the live test proves the
real caller is on the right side of it.

### A PID is an identifier, not a handle

Review r16, and it is the direct consequence of the previous round's fix — which is the
honest shape of that decision, not a reason to undo it. Deciding to *signal* a process
created an obligation the previous design never had: to be sure which process it is.

The host kept only the number, probed it with `signal 0`, and signalled it. Sequence:
the pane process exits without delivering `pane_exited`; the kernel reuses its PID for
another same-uid process; the transport closes; the probe reports the replacement alive;
`terminateLostChild` **kills a stranger**.

The EPERM reasoning was right and is exactly why this bites. "Exists and is not ours to
signal" was the correct reading of EPERM — and a reused PID is *also* a process that
exists and is not ours, in a sense no permission check can see. So the probe became an
**identity** question rather than a liveness one: `/proc/<pid>/stat` field 22, the
kernel-maintained start time, captured at spawn and compared before every signal. One
question replaces two, and a different start time at the same PID is *positive proof*
our child exited — confirmed death, with nothing signalled.

`defaultPidAlive` is gone rather than kept beside it. An unused function with a test that
documents superseded reasoning is decoration, and the EPERM insight survives where it
belongs: in the comment explaining why liveness was not enough.

Two survivors, both worth the detour:

- **M106** — parsing by absolute field index — survived because `comm` on this host is
  `bun`, with no space in it. `comm` is the executable NAME and the kernel does not
  escape it, so an absolute index reads a different field for any process whose name
  contains a space or a parenthesis. The parser is now extracted and tested against
  exactly those shapes. *The fixture's own tidiness was hiding the hazard.*
- **M107** — retaining the delivered chunk in an extra field — survived, and is invalid
  by construction: it adds state the class does not have. The guarantee is that no such
  state exists, and that is enforced by the shape rather than by a check, which is the
  entire point of the section below.

### Three rounds on one buffer, so the property was made structural

Copying, then retention, then allocation count. Each fix bounded the quantity the
previous one had missed — which is a pattern that ends only when the quantity cannot
exist. Asked directly whether there was a shape in which a fragment cannot be retained
individually at all, the answer was yes, and it was the right move:

| round | what was bounded | what was missed |
|---|---|---|
| copying | — | cost grew with the NUMBER of deliveries (~35 TB at the cap) |
| retention | copying | a `subarray` tail pinned its whole parent |
| allocation | retention | one `Buffer` object per fragment — ~8 million at the cap |

**One buffer.** Incoming bytes are copied into it and the delivered chunk is dropped
immediately, so there is no fragment to retain, nothing to count, and no per-fragment
overhead to bound. Growth is amortised doubling (so N fragments still cost O(bytes)), a
cursor replaces re-slicing, and consumed prefixes are reclaimed in place. **The guard is
the data structure, not a check** — which is why M107 could only survive by inventing a
field that does not exist.

Two things the rewrite then had to earn back, both caught by my own mutations rather than
by reasoning:

- **Bounded is not the same as small.** A high-water buffer kept 2 MB alive after one
  large frame. It now right-sizes when the remainder becomes a small fraction of
  capacity, and releases outright when fully drained — retention tracks *current need*.
- **Right-sizing is not truncation.** M108b (shrink always to the initial capacity)
  survived until a case existed with a LARGE outstanding partial frame; the earlier
  leftovers were one byte and fit in any capacity. A 300 KB remainder after a 2 MB frame
  is what separates right-sizing from silently dropping data.

And one ordering mistake of my own: I moved the unterminated bound ahead of the frame
loop, which made a complete oversized frame report "no newline" about bytes that contain
one. The per-frame check belongs inside the loop ahead of the decode; the leftover check
belongs after it. Five tests caught it immediately, which is the system working.

### One authoritative behaviour, not two reconciled ones

The transport-loss criteria had come to contradict each other — every socket close
settles, and settlement requires confirmed death. Both cannot hold. The obsolete
criterion and its two tests are **deleted rather than reworded**, because those tests
passed for a reason the second one had written down in its own comment: the fake's
default PID does not exist, so `signal 0` throws ESRCH and "already dead" was trivially
true. They observed settlement without ever exercising termination.

A test whose fixture decides the outcome is worse than no test — it certifies the
opposite of the requirement — and one whose comment *names* the false-positive mechanism
makes keeping it the more expensive choice.

### Each fix created a new obligation, and the new obligation's failure path inherited the old defect

Review r17, and this is the pattern worth naming above either specific — both defects
sat *inside* the two fixes from the previous round.

**The frame limit was enforced after the allocation it exists to prevent.** `onBytes`
called `append` first, and `append` doubles capacity until it can hold the whole
delivery — so with a 64-byte cap, one 1 GiB chunk attempted a ~1 GiB allocation and only
then tore down. The single-buffer rewrite genuinely solved fragmentation, and **a single
oversized delivery is exactly the case fragmentation never covered**: the earlier tests
were one-byte-over and fragmented accumulation, neither of which is one huge chunk.
"The guard is the data structure" was the right move and it has to include the door.

Validation now runs as a scan of the incoming chunk before a byte is copied: O(chunk),
allocating nothing, measuring each FRAME rather than the delivery — so a 700 KB batch of
20,000 small frames is still accepted while a 16 MiB single frame is refused with an
empty buffer. Complete frames lying wholly inside a delivery are now decoded straight
from it; only a frame spanning the boundary, or a trailing remainder, ever touches the
buffer at all.

**And a failed identity read was treated as confirmed death** — inside the very check
added to enforce "could not read is not absent". `readPidStartTime` mapped *every*
filesystem error to `undefined`, and `undefined` compared unequal to the captured start
time, so an EACCES, an EINTR or a namespace boundary read as "a different process holds
this pid" — which the code treats as proof our child exited. It settled the child, sent
no signal, and the process may have been alive.

The probe now has **three** states, and only one of them confirms:

| answer | meaning | may confirm death? |
|---|---|---|
| `running`, same start time | still ours | no — keep escalating |
| `running`, different start time | PID reused: our child is over | **yes** |
| `gone` (ENOENT) | positive absence | **yes** |
| `unknown` (any other errno, or unparseable) | the question failed | **no** |

A different start time is positive proof. An unreadable entry proves nothing. Unknown
must not settle — exactly as already decided for the case where death cannot be
confirmed, now applied to the case where it cannot be *asked*.

Three survivors, all the same shape as M102 and all resolved rather than excused: the
probe is injected everywhere it is used, so its own error mapping was never exercised.
It now takes an injectable reader purely so that mapping is reachable, and is tested
against ENOENT, EACCES, EPERM, EINTR, EIO and two unparseable lines. The third, M116,
was the grace-window check having no case of its own — an identity that is ours when the
ladder starts and unreadable while we wait. Confirming there would report a death on the
strength of having *sent* a signal, which is the settlement-is-not-confirmation row
again, one loop further in.

### Two sentences that had to move with the code

The spec item and this record both claimed buffering was bounded and settlement required
confirmed death. Both were inaccurate while the defects stood, so the claims moved with
the fixes rather than being left as aspirations — the same discipline as deleting a
criterion that contradicted its sibling rather than reconciling the wording.

### The PID path should not exist — measured, then deleted

Review r18 asked the right question rather than a third narrowing: *does this path need
to exist?* It does not, and the measurements say so.

**The reuse window cannot be closed from the client side.** It sits between
`pane.process_info` handing back a bare integer and anything the host reads about it —
so no amount of re-reading binds the number to a process, and losing that race kills an
unrelated one. A PID is an identifier; nothing after the fact turns it into a handle.

**What I measured on the live server (0.8.2, protocol 20), rather than reasoned:**

1. **It answers exactly ONE request per connection, then closes.** Two `ping` frames
   pipelined in the same tick got **one** reply, with the socket gone 1 ms later — so
   this is not an idle timeout. Every method works as the *first* request on a fresh
   connection and fails as the second.
2. **A fresh connection is therefore always available while the server lives**, and
   `pane.close` BY PANE ID on one returns `{type:'ok'}`, after which `pane.get` answers
   `pane_not_found`. `pane.close` on a pane that never existed also answers
   `pane_not_found` — so "already gone" is positively reportable.
3. **`pane.process_info` carries no identity token.** It has `shell_pid`,
   `foreground_process_group_id` and `foreground_processes[{pid,name,argv,cmdline,cwd}]`
   — and no start time. Closing the race inside the protocol is therefore *not
   available at this version*; it would be a protocol change, and this protocol moved
   20→22 in nineteen days with no server-side version check.

So the third option was never on the table, and of the remaining two the first is
strictly better: **a lost transport is a lost CLIENT CONNECTION** — which, on a server
that closes after every request, is the normal end of every exchange and says nothing
about the pane. Reconnect and ask the owner to close the pane by an id it maintains
atomically. PID signalling is deleted outright: no `killPid`, no `readPidIdentity`, no
`/proc` parsing, no start times, no kill ladder. **The PID-reuse class is gone rather
than narrowed a third time** — the same prevent-rather-than-measure move as the
single-buffer rewrite, which is the third time it has been the right answer on this PR.

The unknown case keeps the rule: a failed reconnect proves nothing (the server may be
gone and its pane's process reparented and still running), and a refused `pane.close`
proves nothing either. Only `ok` or `pane_not_found` confirms, and anything else settles
nothing.

**And the fake was unrepresentative in exactly the M106 way.** Its `pane.close` returned
ok even for a pane it had marked gone, so the branch treating `pane_not_found` as
confirmed closure was never reached and M120b survived. The real server rejects — I
measured it — and the fake now rejects too. *A fixture does not have to be permissive to
hide a defect; it only has to be unrepresentative.*

### One finding that outgrew this PR

The same probe establishes something larger, and I am flagging it rather than acting on
it: **`HerdrClient` assumes a persistent connection that this server does not offer.**
`connectHerdr` sends `ping` for the protocol gate — which consumes the connection — and
every subsequent call then fails on a closed socket. `events.subscribe` answers
`subscription_started` and the connection closes too, so no event can ever arrive on it.

Against 0.8.2 the host therefore cannot poll, cannot subscribe, and cannot drive a REPL
at all. Every test here runs against the fake, which models a persistent connection, and
the live E2E proofs are opt-in and skipped in CI — so nothing in the suite was in a
position to notice. That is a design question about the transport, not a defect inside
this round's blocker, and it is worth a decision before the cutover rather than a patch
inside it.

### The transport was rebuilt to the shape the server actually implements

Review r19, and this is the largest change on the branch: **one request, one reply, one
connection.**

The persistent multiplexing client could not execute against the server we run, and
**no test could have told us** — every fake modelled a persistent connection and the
live proofs are opt-in and skipped in CI. That is the clearest instance yet of "merged
is not done": a REPL host that cannot drive a REPL, with a green suite.

**Measured, on herdr 0.8.2 / protocol 20:**

| question | answer |
|---|---|
| requests per connection | exactly ONE, then the server closes it |
| two pings pipelined in one tick | ONE reply, socket gone 1 ms later — not an idle timeout |
| any method as the FIRST request | works (`layout.apply`, `pane.read`, `pane.close`, `pane.get`, `pane.process_info`, `pane.list`) |
| cost of a fresh connection | **2.02 ms** (mean of 60: connect + send + reply + close) |
| a SUCCESSFUL `events.subscribe` | connection STAYS OPEN and streams events |
| `pane.close` on a missing pane | `pane_not_found` — positive absence |
| `process_info` identity token | none (no start time) |

The exact subscribe frame and what came back, since the design turned on it:

```
{"id":"sub1","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.exited"}]}}
  +1ms    {"id":"sub1","result":{"type":"subscription_started"}}        ← socket STAYS OPEN
  +2ms    {"event":"pane_exited","data":{"pane_id":"w6:pD",...}}        ← a pane that had ALREADY exited
  +1604ms {"event":"pane_exited","data":{"pane_id":"w6:pE",...}}        ← the pane created during the probe
```

Note the second line: **a fresh subscriber is delivered an exit that happened before it
subscribed.** That is a replay hazard a subscription design would have had to defend
against, and it argues for the decision that was taken.

**What the rewrite DELETES rather than leaves unreachable**, because there is no
long-lived socket: the transport-loss exit cause, post-close dispatch, teardown-of-
pending, the pending-by-id map, the event envelope, `events.subscribe`, the
`pane-exited` cause, and the reconnect-and-close-by-pane-id path added one round
earlier. Three rounds of hardening on the transport-loss branch are gone with the branch
— which is the point: *a connection ending is how every exchange ends, not an event.*

`PtyExitCause` collapses from four to **two**: `closed-by-us` and `pane-vanished`. A
process that ends on its own is now discovered exactly as a vanished pane is, because it
IS one — and one fact deserves one name.

**What is KEPT, because it is still about a single reply:** the frame bound enforced
before the bytes are copied, one decode per complete line at a known character boundary,
and an envelope carrying exactly one well-formed outcome. The version gate MOVED rather
than went — one `ping` at spawn instead of per call, because pinging every call would
double every operation, and the protocol cannot change under a running host without
restarting herdr, whose panes are its children.

Tests were deleted rather than left passing: the subscription and transport-loss suites
described a client that could not run, against a fake that agreed with it. The
`herdr-protocol-gate` suite was rewritten around the new seam (31 cases), and the
`isClosed()` assertions went with the socket they guarded — the leak they protected
against cannot exist when nothing outlives a request, which is a structural guarantee
rather than an asserted one.

### The connect is awaited, and the call settles by resolving

The first cut of the one-connection client fired the connect into
`void connect(...).then(...).catch(...)`. The fire-and-forget gate rejected it, and the
gate was right about more than style. Voiding that chain put the call's ENTIRE
resolution inside a promise nobody held: `finish` was reachable from a timer, from two
socket callbacks and from a `.catch`, none of which the caller was awaiting.

It is now a plain `await` in the function body — a refused connect, a thrown write and a
short write all reach `finish` through one `try`/`catch` — and the pending call settles
by RESOLVING a `CallOutcome` record rather than by rejecting. That second half is the
part worth keeping: the deadline can fire while the connect is still in flight, which is
a window in which nothing is holding the call's promise. A rejection there is unobserved,
and Bun's process net treats an unobserved rejection as fatal (`logger/fire-and-forget.ts`
says so in its own header). A promise that is only ever resolved cannot enter that state;
the failure becomes a `throw` at the single `await` that hands the outcome back, where a
handler provably exists.

The test asserts the ABSENCE, not the presence: it registers an `unhandledRejection`
listener, drives a 1 ms deadline against a 40 ms connect, and requires both the right
error and an empty listener log.

### Three tests were fast because the code was broken

Fixing the transport broke four tests, and the reason is worth more than the fix.

`unconditional-persistent`, `select-substrate` and `repl-home-normalization` assert
substrate SELECTION, not spawning — but they call `start()`, which reaches the real
`HerdrHost`. They passed in milliseconds because **the client could not get past its own
protocol ping**: the spawn failed immediately and the assertions (about the handle's
identity) held anyway. With the transport fixed, those same tests connected to the
DEVELOPER'S LIVE HERDR SERVER, created real panes running `/usr/bin/false`, and sat out
the 5 s pid timeout.

Two things follow, and I would not have seen either without breaking them:

- **A green test can be green because of the defect.** These were not testing the spawn,
  so nothing about their assertions changed — only their speed and their side effects.
  "Fast and passing" concealed "never reached the code".
- **A unit suite that can touch a live server is not hermetic**, and nothing said so.
  They now point `HERDR_SOCKET_PATH` at a path that does not exist, so the spawn fails
  at connect rather than on a real machine's panes. That guard is new information the
  suite did not previously carry.

I checked the live server afterwards: four panes, all the owner's own `claude` and
`gh dash` sessions, none mine. The probe panes I created were closed explicitly, and the
timed-out spawns cleaned up after themselves — which is the `abandonPane` obligation from
an earlier round doing exactly its job, observed in the wild rather than in a fake.

### A gate the instrument cannot reach

`HerdrHost.spawn` verified the protocol only when no `connect` dependency was injected:

```ts
if (this.deps.connect === undefined) await herdrPing()
```

A runtime `if` keyed on whether a TEST SEAM is present, so the seam's presence changed
the safety property. The comment directly above claimed "a spawn that cannot verify the
protocol does not happen" — true of the production path, and not of `spawn`.

**The consequence that matters is not the bypass.** The injected path is the only path a
test can drive, so the acceptance criterion — a stub reporting protocol 21 makes `spawn`
reject — was UNWRITABLE against this code. `herdr-protocol-gate.test.ts` pinged
`herdrPing()` directly, which exercises the function in isolation rather than the
guarantee, and the file's own criterion said `spawn`. **A gate the instrument cannot
reach is the same class as an instrument that cannot fail** — which this branch found in
its own harness the same day, in the `tail` bug below.

The check moved behind the `HerdrRpc` seam and runs unconditionally, so the injected and
real paths run the same code. That also removes a smaller distinction rather than
reasoning about it: a separate `herdrPing()` establishes the version of the
server-in-general rather than of the handle in use. Under one request per connection they
are the same server, but asking through the handle costs nothing and needs no argument.

The alternative if the ping were ever too expensive would be a type — a verified-RPC that
only a verifying constructor can produce — never a runtime `if` on a seam, because that
is precisely what made the seam's presence load-bearing for safety.

M220 is worth its own line: moving the gate AFTER `layout.apply` reddens exactly one case,
the one asserting no pane is created. The cleanup obligation on this path is honoured by
ORDERING rather than by a handler, so it is asserted rather than assumed — a gate that ran
later would leave a real `claude` running behind a rejected spawn, which is the orphan
class this host has been fixed for twice.

### My own gate was measuring `tail`

Every local `TYPECHECK rc=0` I reported this whole branch was a lie, and the shape is the
one I have been finding in other people's instruments all week:

```
timeout 2400 bash scripts/ci/typecheck-all.sh 2>&1 | tail -3; echo "rc=$?"
```

`$?` after a pipeline is the exit code of the LAST stage — `tail` — which succeeds
unconditionally. Proven rather than asserted: `(exit 7) | tail -1; echo $?` prints 0. The
same bug was in my TESTS, LINT and DEPCRUISE lines.

**What saved it was that the other output was real.** I read pass/fail COUNTS for the
tests, and the lint/depcruise gates print their own verdicts, so those were genuine
signal. `typecheck-all.sh` prints `pass <tsconfig>` lines, and `tail -3` showed three of
them — which looked exactly like success while seven type errors sat above the window.
Nothing false reached CI, because CI's own `typecheck` job is a separate instrument and
it is what caught this. But for a whole branch my local pre-push gate was reporting
nothing about types at all.

The gate now captures output and status separately and prints the real code. **An
instrument that cannot fail is not a gate**, and I had been quoting one.

### A fake that is accidentally thenable

`main` moved to `3633ff62` (#642) mid-round, bringing three `PtyHost` fakes written
against the SYNCHRONOUS `spawn` this item made `Promise<PtyChild>`. Rebasing produced a
fake that returns a child where a promise is expected — and the object spread
`{...child}` then spreads a PROMISE, producing something with `then`/`catch` and none of
`pid`/`write`/`exited`.

**The tell was the timing, not the message.** Three failures, all at ~2005 ms: a uniform
timeout is a thing never settling, not an assertion disagreeing. A fake that is
accidentally thenable gets awaited by anything that awaits it, so the caller waits on the
fake's own resolution and the case dies on the clock rather than on its subject. The fix
is a real promise of a complete `PtyChild` — not a widened type until the error stops.

Worth naming what these tests are: all three are #642's own FAILURE paths, including one
about a `kill()` that throws — the same subject as this branch's Bun-host fix, arrived at
independently on two branches in the same week.

**The sweep, with its positive control.** Declared-return sync fakes
(`spawn(...): PtyChild`): three, all in that file, all fixed — zero remain. Arrow-form
fakes returning a child object: the hits are `BunTerminalHostDeps.spawn`, which is the
injected BUN-PROCESS spawn and is correctly synchronous, not `PtyHost.spawn`. POSITIVE
CONTROL: **45 objects implement `PtyHost`** across `runtime/`, `gateway/` and the test
trees, every one inside a checked tsconfig — and the compiler demonstrably reports these
errors when they exist, which is how the seven were found. The instrument here is tsc; the
sweep's job was to confirm its domain covers the fakes, and it does, including fakes
constructed inline in a test body.

**And the widened stderr guard earned itself.** `gateway-shutdown-kill.test.ts` arrived
from #642 with two more hand-rolled `process.stderr.write` patches, restoring a BOUND
COPY — the identical bug the five earlier suites had. Neither branch's author had reason
to re-read that file; the guard caught it because its domain is every test rather than the
files where the defect was first noticed. Both now delegate to the one sanctioned site,
which grew a synchronous sibling rather than a second copy.

### False and unknown shared a branch, in the one place the rule was already written down

`pane.close` settled only on its `.then` arm. Every rejection went to the handler for a
close that told us nothing — including `pane_not_found`, which is positive proof the pane
is gone, which the real server sends and which our own fake models because it does.

So a close that came back with the FACT was treated as the ABSENCE of a fact, and it
broke both things that handler exists to protect: `hasExited()` stayed false, so the
escalation ladder kept escalating against a pane that no longer existed; and `terminating`
was cleared, so when polling later settled the exit, `wasKilledByUs()` was false and a
deliberate recycle read as a crash — the defect the handler's own comment was written to
prevent, arriving through the other door. The poll path had the typed check in two places.
The close path had no case for it at all, while the as-built asserted "only `ok` or
`pane_not_found` confirms" — a sentence whose first half was implemented.

The existing race test could not see it: it lets polling settle the exit FIRST and then
releases the held close, so the close is never the thing that learns the pane is gone. The
new case parks the poll so the close is the only observer, and its pair keeps an UNTYPED
rejection settling nothing — or "settle on any rejection" passes the first case and loses
the distinction entirely (M211 reddens three).

### The rule does not attach to a file that has learned it

`herdr-host.ts` states the no-latch-on-a-failed-act rule for its close path — and the
SIGINT path **twenty lines above that comment** sets `interruptedByUs = true` and then
calls a fire-and-forget `send`, so a `pane.send_keys` the server refuses left a flag
asserting "WE sent this child an INTERRUPT" against the interface's own words. Same
defect and same direction as the Bun host's `kill()` latching before a `proc.kill` that
throws.

That makes the useful lesson the opposite of "copy this file's discipline". **The rule
attaches to every operation that latches intent before an act that can fail**, so I
enumerated them rather than fixing the one reported. **There are three across the two
hosts:**

| # | site | rollback |
| --- | --- | --- |
| 1 | `terminating` before `pane.close` (herdr) | present from the start |
| 2 | `interruptedByUs` before a fire-and-forget `pane.send_keys` (herdr) | added this round |
| 3 | `killedByUs`/`interruptedByUs` before `proc.kill` (Bun) | added last round |

**Two of the three were found by a reviewer rather than by the author of the rule**, which
is the number worth keeping: writing a rule down next to one instance of it does not find
its siblings. Every rollback is guarded on liveness (a settled terminal state is
immutable) and is as narrow as its latch (a failing interrupt must not erase a delivered
termination).

What was NOT done: making `send` awaitable or failable for every caller. Fire-and-forget
is the right shape for a keystroke; what was wrong is latching a claim on top of it, so
only the caller that latches gets a rollback hook.

**The enumeration found one more thing, of a different class.** Every non-intent flag
assignment was checked too, and `outputReleased` led to a real divergence: the Bun host
delivered `onScreen` synchronously from `beginOutput()` with no guard, so a throwing
detector came back out of the caller's own readiness handshake — while under herdr the
identical throw is swallowed by the poll loop. A caller must not be able to tell which
backend it has by how its own bug reaches it. Both dispatch sites are now guarded, and the
case went into the shared conformance suite (M214).

### The missing row is the operation that FAILS, in a table built from operations that work

`BunTerminalHost.kill()` latched `killedByUs` and then swallowed a throwing
`proc.kill(signal)` without clearing it — a signal that was never delivered leaving
behind a flag asserting it was. `spawn.ts` evaluates `!killedByUs && exitCode !== 0`, so
the flag short-circuits the exit code entirely and the child's later NONZERO exit — a
real crash, since nothing killed it — classifies as a clean recycle. It also disarms the
escalation ladder, whose `hasExited()` guards return early.

**The fix was already written in the sibling file**, for the herdr host's failed
`pane.close`, and states the rule outright: do not settle, and do not latch; clearing
leaves the child exactly as it is, alive and unflagged, which is both the truth and what
re-arms the ladder. Copying the whole shape rather than half of it is the point, and the
half that is easy to drop is the liveness guard on the clear.

Every existing kill case used a `proc.kill` that succeeds. **A host whose signal cannot
fail cannot test what a failed signal leaves behind** — the row missing from a table built
entirely from operations that work, which is the same shape as the missing well-formed
envelope row one section down, and the same shape as the fixture findings before it.

**Copying the shape exposed a real difference between the two backends, and it is worth
recording rather than papering.** herdr's failure arrives as an ASYNC rejection, so the
exit genuinely can settle in between and its `if (exited) return` is reachable and
load-bearing — it was added there for a defect that actually happened. The Bun host's
`kill()` is synchronous end to end and `exited` is set only in the `proc.exited`
microtask, so the equivalent inner guard is UNREACHABLE: M205 and M208 each survive
alone, absorbed by the other, and only M209 reddens. Rather than leave a guard that looks
tested and is not, the entry guard got its own observable — an already-exited child is not
signalled at all, which M208 now reddens — and the inner one is kept with its
unreachability stated, because the rule is the shared rule and the interface admits a host
whose `kill` awaits.

M206 is the other half: a widened clear, where a failing SIGINT erases a termination
already recorded, survived the SIGINT-only case because both flags are false there either
way. **The clear must be as narrow as the latch**, and that needs a case with a successful
terminal kill first.

### The row that was missing is the one that is well-formed

Every request sent `id: "r"`; `classifyReply` accepted any string id. So
`{"id":"wrong","result":{"type":"ok"}}` resolved the call successfully — a stray or
drifted response taken as acknowledgement, including of `pane.close`, which is the one
operation this branch spent four rounds making trustworthy.

The envelope table had fifteen cases and missed this one, and the reason is structural
rather than carelessness: **every other row is MALFORMED, and a mismatched id is
perfectly well-formed.** It is simply not ours. A table built around "reject what is
broken" has no natural place for "reject what is fine but unrelated", so the shape of the
table hid the shape of the defect.

Why it still matters on a one-request-per-connection transport, since the obvious
objection is that no other reply can arrive: **that is the server's guarantee, and this
is the client's own check that it holds.** This branch is itself the argument for
distrusting exactly that kind of assumption — the protocol moved 20 → 22 in nineteen days
with no server-side version check of any kind, and the persistent multiplexing design
that assumed a server matching its description could not execute at all. One comparison
removes a class.

One constant is used by both the request and the check, so the two cannot drift into two
facts that happen to agree today; M203 mutates the request side alone and reddens. M202
is the pair that stops the check being satisfied by rejecting everything — it fails
twelve cases, which is what "nothing correlates" should look like.

### An unfalsifiable check is believed rather than tested

M145 — moving the frame bound after the copy — survived every round for eight days, and
the as-built recorded it as surviving while the acceptance criterion claimed the
property. Both orders reject the same frame with the same message and the same outcome,
so end to end there was nothing to see. **A criterion standing over a mutation known to
survive is a claim nothing holds**, and the honest options were to make it falsifiable or
to narrow it.

It is the third instance of one lesson today, and the first two supplied the remedy: a
pure helper can prove the check works and cannot prove anything still calls it
(`writeAllOrThrow`), and neither can prove WHEN it runs unless the thing it guards is
observable. So the framing is extracted as a `FrameReader` that reports the bytes it has
COPIED, and "before the allocation" becomes a number. An over-cap chunk is refused with
`copiedBytes() === 0`; an over-cap frame split across deliveries keeps only what was
legitimately under the cap; and the CONTROL — an acceptable frame IS copied, terminator
excluded, coalesced surplus not — is what stops all of that being satisfied by a reader
that never copies anything.

One mutation to note for its own sake: my first attempt at "copy the whole delivery"
adjusted the byte counter back down afterwards, so it survived. It looked like the defect
and did not have it. **A mutation has to break the property, not resemble it.**

### A conditional assertion cannot fail for the host that produces nothing

The already-exited conformance case asserted delivery under `if (screens.length > 0)`.
For the pty that is a real assertion; for herdr, whose pane vanishes taking its output
with it, zero deliveries passed silently — so the case written to hold both hosts to one
contract held one. **A conformance case whose assertion is optional for one participant
is two tests wearing one name**, and it happened within two cases of the suite landing.

Each host now DECLARES what it must hand over — herdr exactly zero, with the reason (a
failed read is never delivered as a screen, so there is genuinely nothing, and zero is
the correct asserted outcome rather than an absent one); the pty exactly one containing
the startup text (it accumulated the screen before the process died and it is the only
record of what the child printed). Both are held to exactly that, and the reason travels
in the failure message, because the interesting half of a conformance failure is which
participant broke which promise. M198 and M199 are the proof: each reddens its own host's
declared outcome, and M198 was invisible while the branch was conditional.

**The rule is now written into the suite header** rather than left as this round's
correction: every conformance assertion is unconditional for every host in the table, and
a host that legitimately differs declares that difference as its own asserted expectation
rather than as a skipped branch. Cheaper to adopt at two cases than at twenty.

### A shared suite inherits the blind spots of its shared fixture

Two rounds ago I made `BunTerminalHost` RELEASE its held screen from the exit handler,
reasoning that a dead child's last screen is the only record of what it printed and must
not be withheld. The reasoning was right and the ordering was wrong. I wrote that it
"runs on a later tick than `spawn()` returning, so it cannot pre-empt the caller's
`await`" — and that sentence is false whenever `proc.exited` is ALREADY RESOLVED: the
callback is then queued as a microtask BEFORE the caller's continuation from
`await host.spawn(...)`, so `onScreen` fired before the caller even held the child. **A
child that dies instantly is also the child whose output most needs a detector already
attached**, so the race lands in exactly the case the gate exists for.

**The conformance suite could not see it, and that is the more important half.** Its
first fixture deliberately left `exited` pending until after `spawn()` returned — both
arms kept the child alive for the whole case. The suite is the mechanism that makes
keeping two backends maintainable, and its first fixture was unrepresentative in
precisely the way that hides a real divergence. Same lesson as the pty's
non-deterministic kernel buffer and `comm` being one word, now one level up: at the
instrument built to catch those.

The fix keeps the reason and drops the conflation. **The exit settles; it does not
release.** Recording that the child is gone is a different act from delivering its
screen. The held screen is still delivered — at release rather than before it — and the
fail-open timer stays armed across the exit, so a caller that never calls `beginOutput()`
gets the dead child's last screen late and loudly rather than never. M194 (release on
exit) and M195 (disarm without releasing) bracket it from both sides.

**The case went into the conformance TABLE, not the Bun suite**, and doing that honestly
required admitting the two substrates cannot reach "already gone" at the same moment: a
pty hands back a process that has already exited; herdr discovers a vanished pane only by
POLLING, and its poll loop is itself held behind the gate, so it cannot know until the
gate opens. The positive control is therefore taken AFTER the release on both arms —
taking it before would have been asserting that herdr breaks its own gate. What each arm
can assert about delivery also differs (herdr's pane vanishes taking its output with it,
so it has nothing to hand over), so the shared case asserts the shared contract and the
pty's own suite carries the delivery.

### The same rule, for the third time, and this time it was still in the host

**An obligation starts when the resource exists, not when the function succeeds.** The
host learned it as `abandonPane` — a `layout.apply` that returned left a pane and a
`claude` running, and both post-creation failures closed only the connection. The live
E2E suites learned it again by leaking four real panes, because their spawn sat outside
the `try`. It was STILL in `BunTerminalHost`: by the time `Bun.spawn` runs, the readiness
timer is armed and the pty is allocated, so an executable that does not exist is enough
to reject out of `spawn()` with an open terminal — and five seconds later emit a
`beginOutput()` wiring warning about a child that was never created. A false diagnostic
on top of a leak.

Both the allocation and the spawn are now inside one guard, because `createTerminal` can
throw too — with nothing to close, but with the timer already armed. The close is
best-effort, so a failing close cannot mask the error that caused the abandonment: the
same rule `abandonPane` follows on the herdr side.

Four cases, and the CONTROL is the one that matters most: a successful spawn must close
NOTHING and must still ARM the gate, or "closes on failure" is satisfied by a host that
closes unconditionally and "disarms on failure" by one that never arms. M193 — running
the cleanup on the success path — reddens five cases, including the fail-open warning
that proves the gate is still doing its job.

That the existing fixture could not see this is the familiar half: `__tests__` covered
the PRE-allocation empty-argv refusal, and the injected terminal modelled only successful
spawning. A fixture does not have to be permissive to hide a defect.

### The PR about making herdr the REPL container leaked REPL containers into herdr

The owner found four unexplained tabs in his own workspace and asked whether they were
us. They were: four real `claude` processes parented straight to the herdr server, no
title, the fixture cwd, ages spanning the hours this lane had been running its live
proofs. The orphaned-pane class this branch has been closing INSIDE the host, escaping
through the suite.

**Two defects, and both are shapes already fixed elsewhere on this branch.** The close
was never confirmed: `kill()` is `void` by contract and issues `pane.close` as a
background RPC, so a test that returns from its `finally` and exits has ASKED without
knowing — and a request still in the socket buffer when the process dies was never sent
at all. Settlement is not confirmation, one layer further out than the first time. And
the spawn sat OUTSIDE the `try` in two of the three suites, so a rejecting spawn skipped
the cleanup while the pane already existed — `abandonPane`'s own lesson, that the
obligation starts when the resource exists rather than when the function succeeds,
escaping through the test.

Fixed as a lifecycle guarantee rather than as four `pane.close` calls: one scoped helper
owns the spawn, the readiness handshake and the `try`/`finally`, and awaits
`child.exited` — which the host settles only from the `pane.close` REPLY — with a bounded
deadline. Bounded because an unbounded wait turns a leak into a hang, which is a worse
way to find out about the same problem; and reported when it expires, because an
unreported timeout turns it straight back into a leak.

**Why nothing automated saw it, and this is worth more than the fix.** The panes are
created THROUGH A SOCKET by a process the test does not own, so the test's own process
shows no leak at all — no fd, no child, no handle to notice. And CI never runs these,
because the live proofs are opt-in and skipped there. That is the same property that let
the one-request-per-connection transport defect survive eight green rounds: **this lane's
live surface has no automated observer.** Twice now the instrument that caught a real
defect on it was a human looking at a screen or a hand-written probe.

So the durable part is the standing check, not the helper. Each live suite records the
server's pane IDs before and after and fails on any that APPEARED — by id rather than by
count, because a count says something escaped and an id says what, and because a pane the
owner closed himself mid-run must not read as a leak. That turns "every suite remembers
to clean up", which is a claim about people, into a claim about the server that survives
a fifth live test written by someone who has not read the file.

The fourth guard in this family, and the first with a blast radius outside the test run:
no `*.e2e.test.ts` may construct `HerdrHost` directly. Its positive control has two parts
for the reason the last three taught — the pattern must find the construction where it
legitimately lives, AND every e2e file must be shown to reach the helper, or "no
offenders" would also be satisfied by "no spawns".

Verified afterwards: four panes on the live server, all legitimate — the owner's own two
`claude` sessions with real titles, and two shells. Nothing of ours.

### A queue moves the moment of execution away from the moment of the check

Third consequence of the serialisation, and the first two name the pattern: ordering was
lost because one connection per request removed it, the deadline had to cover connecting
because the connect moved inside the call, and now — **every precondition tested before
enqueueing is a claim about a world that may have moved by the time the work runs.**

`submitLine` checked `exited` at the door and not again inside its queued unit, so a
`submitLine` waiting behind a held actuation ran its text and Enter against a pane that
had vanished while it waited, and RESOLVED. That is the exact defect the method exists
for: a caller reporting a context reset that never happened.

The two queued paths now both re-check, and they do different things with the answer —
which is the contract's distinction, not an inconsistency. A fire-and-forget actuation is
no-op-safe and is silently dropped. `submitLine` is the acknowledged seam, so it THROWS:
"the child went while you were waiting" is a way the command was not submitted, and it
has to reach the caller. M181 is the mutation that proves the difference is load-bearing
— making the re-check drop instead of throw reddens, because a silent success here is
worse than no check at all.

Swept the queued paths for others: `send()` already re-checked (that was M141's fix), and
nothing else is enqueued. The one other precondition-after-an-await in the file, the
`pane.close` error handler's `if (exited) return`, is already an execution-time re-check
and documented as one.

### The prose describing a backend is invalidated by changing that backend

`pty-host.ts` said `BunTerminalHost.beginOutput()` "implements it as a no-op". True when
written; false the moment that host was given a gate, and left standing in the one
document whose job is telling callers what BOTH backends do. Same class as the eight
clauses swept last round, reappearing from the other direction: there the interface
described one backend's behaviour, here the implementation moved and the interface prose
did not. **A claim about a backend is invalidated by changing that backend, exactly as a
`file:line` is** — and the durable answer is that the shared conformance suite now holds
both hosts to that sentence, rather than the sentence being the record.

### The restored backend reintroduced the race `beginOutput()` exists to prevent

`BunTerminalHost` had the byte stream from the instant the child was spawned, so it
forwarded straight through and returned an empty `beginOutput`. I wrote the comment "no
gate to release" and it was wrong: `spawn.ts` cannot assign `scanChild` until
`await ptyHost.spawn(...)` RETURNS, and with an injectable `createTerminal` the `data`
callback can fire synchronously INSIDE `spawn` — so a startup trust or approval prompt is
recorded into a ring with no detector attached, and because the ring is snapshot-replace
it is never re-delivered. The keystroke never fires and the REPL waits forever on a
dialog nobody saw. That is the wedge class this substrate was built to avoid, restored by
the act of restoring the backend.

The gate now holds the CALL and never the bytes: output accumulates throughout and the
latest screen is delivered the moment the consumer exists. It fails open loudly on the
same window as herdr — the constant moved to `pty-host.ts` as part of the shared
contract, so the two cannot drift — and it releases on child exit rather than merely
cancelling, because a dead child's last screen is the only record of what it printed and
withholding it for a caller still wiring up loses it entirely.

**Four existing Bun tests started failing, and that is the finding.** They never called
`beginOutput()`, because there was nothing to call. They now do what production does.

### A per-backend suite can only prove what its own author remembered

No test noticed the missing gate, and the reason is structural rather than an oversight:
the requirement belongs to the INTERFACE, and each backend had its own suite. So an
interface requirement was asserted in the one place that happened to implement it first.

`__tests__/pty-host-conformance.test.ts` runs the readiness boundary against both hosts
from one table. M179 is the proof that it is genuinely shared: removing the HERDR gate
reddens the same suite that M176 reddens for Bun.

Three things in it are easy to omit and each was deliberate. A SETTLE step before the
"nothing delivered yet" assertion — without it the claim is vacuous for a host whose
producer is asynchronous, and passes against no gate at all. An assertion that the held
screen IS delivered after the release, because a host that drops what it held is as
broken as one that delivers too early, just silently (M177). And a CONTROL that the table
holds two DISTINCT hosts, since a conformance suite that lists one backend twice conforms
an implementation to itself — the same shape as the divergence it exists to catch.

Kept narrow on purpose: this is the readiness boundary only. A full conformance suite
over the whole `PtyChild` contract is worth having and is its own item — each remaining
property has backend-specific evidence requirements that would have to be modelled before
they could be shared honestly. Adding cases is the cheap part; agreeing what "the same
case" means for two substrates with different observables is not.

### A shared interface that encodes one backend's behaviour is the dual-path outcome

`PtyChild.write` said "DOES NOT SUBMIT, AND REFUSES TO PRETEND IT DOES" and described
herdr's CR/LF refusal as though it were the interface's rule. That was harmless while
herdr was the only implementation and became false the moment a second supported backend
had the opposite behaviour: under an in-process pty a `\r` genuinely submits. A caller
reading the shared type could no longer reason about its own bytes — which is the single
thing the type exists to tell it. Keeping two backends and letting the contract describe
one of them is precisely the "two diverging code paths" outcome the owner said he did not
want; the contract has to stay honest about both, and that is the ongoing cost of the
option.

`write` is now a byte-delivery operation that says nothing about submission in either
direction. herdr's CR/LF refusal moved to `HerdrHost` as its own documented precondition,
where it is enforced and where the reasoning belongs. The submission-bearing operation is
`submitLine`, which both backends implement honestly and differently — herdr awaits two
acknowledged round trips, the pty checks that every byte was accepted — and neither
fabricates the other's claim.

Swept the rest of the interface for the same shape rather than fixing the one clause
named. Eight more places stated a herdr fact as a universal: `writeKey` ("under herdr it
is also the ONLY way to submit"), `kill`, `wasKilledByUs`, `beginOutput`, `resize`,
`onScreen`, `onExit`, and `cols`/`rows`. Each now says what is true of BOTH, and where
they differ it says which is which. Two collaborators carried the same leak and were
corrected with it: `submitCommand`'s refusal message, which explained the refusal in
terms of herdr's `pane.send_text`, and `spawn.ts`'s `onScreen` comment.

### The guard was tested; its WIRING was not

M160 — deleting the Bun host's short-write check — survived every end-to-end test,
because a real pty does not short-write an eight-byte payload. It had been recorded as an
uncovered boundary, honestly, but the as-built simultaneously claimed "every mutation
reddened" and the acceptance criterion called that backend "contract-complete and
TESTED". Two false statements over one real gap.

Extracting `writeAllOrThrow` as a seam-taking function makes the CHECK assertable: zero
acceptance, partial acceptance, a UTF-16-unit count for a multibyte payload (which is the
lax direction — `é` is one unit and two bytes, so a half-delivered write looks complete),
and a `Uint8Array` measured by its own length, each with its control.

That was not enough, and the next mutation said so: replacing both calls in `submitLine`
with bare `terminal.write` still survived. **A pure helper can prove the check works and
cannot prove anything still calls it.** So the terminal is injectable — the same seam
`HerdrHost` has for its socket, added for the same reason. With it, a pty that refuses
the text makes `submitLine` reject AND leaves the Enter unsent (a blind Enter after a
text that did not land submits whatever was on the line), a pty that refuses only the
Enter rejects too, and the control shows text-then-`\r` on a healthy one. M172, M173 and
M174 all redden.

### A line count is not a bound, because a line is unbounded

Keeping the Bun host brought a pre-existing defect into scope, which is exactly the cost
of the option: **the old backend is no longer dormant code, it is supported code.** Its
accumulation was bounded by `bottomNLines(screen, 2000)` — "keep the last 2000 lines" —
and a child whose output contains no newline is ONE line forever. `yes x | tr -d '\n'`
is the whole repro: every trim retained everything, and the screen grew without limit.
Every test used newline-terminated output, so none of them could see it.

The answer is the herdr client's answer, for the third time on this branch: stop bounding
a proxy for the resource and bound the resource. The accumulation is now denominated in
UTF-8 BYTES, tracked incrementally so no delivery costs O(screen).

Two things made it cheap to do right. The cut REUSES `pty-ring.ts`'s `clampLeadingLines`
rather than growing a second copy — one implementation of "line-aligned, character-safe,
to a byte budget" instead of two chances to get the surrogate pair or the mid-line cut
wrong, and it already handles the case a line count could not reach (a single line longer
than the whole budget, cut on a byte boundary walked off continuation bytes). And it
trims to a LOW-WATER MARK rather than to the cap, because trimming to the cap means the
next chunk is over it again and the O(screen) clamp runs per chunk — the quadratic shape
this branch already removed once.

**The fixture had to stop being a pty, and that is the finding worth keeping.** A pty has
a fixed kernel buffer and no flow control: when the reader is slower than the writer the
kernel DROPS output, silently and by a varying amount. Measured on this host with a 3 MB
newline-free child: 490,432 bytes delivered on one run, 316,608 on the next. So a bound
asserted end-to-end through a pty can pass because the output never reached the cap — and
it did: the mutation that replaces the character-safe byte tail with a UTF-16 `slice`
SURVIVED the pty test and reddens immediately against the extracted accumulator. A
fixture does not have to be permissive to hide a defect; it only has to be
unrepresentative. The accumulator is exported and driven directly with synthetic chunks;
the pty tests keep the contract and no longer carry the bound.

M166 is the other one worth recording. A byte counter left stale after a clamp still
bounds the screen — it just clamps on EVERY chunk, pinning the accumulation at the
low-water mark. That produces no strict shrink, so a clamp-frequency count cannot see it,
and a peak recorded over the whole run cannot either, because the peak happened during
the one-off climb before the first clamp. What reddens it is measuring the maximum size
WHILE SATURATED: the budget has to be used between clamps, not merely respected.

### The fourth instrument whose domain was narrower than its claim

Five suites installed `process.stderr.write` by hand and "restored"
`original.bind(process.stderr)` — a different function object from the one they replaced,
so nested or repeated captures stack binds and the process never returns to where it
started. One of those suites is the one whose own test asserts identity restoration.

The guard I had added could not see any of them: it scanned `*.e2e.test.ts`, because that
is where I found the problem. **A guard scoped to the file type where the defect was
noticed is a guard scoped to the sample.** That is the fourth time on this PR — a pattern
that matched `===`, a grep without a line-start anchor, a per-delivery bound standing in
for a per-frame one, and now a file glob. Each time the instrument was narrower than the
claim it was making.

The domain is now the domain of the rule: every `*.test.ts` in the repo plus every module
under a `__tests__/` directory, since a helper is exactly where the next hand-rolled copy
would hide. The single sanctioned assignment lives in its own module
(`__tests__/capture-stderr.ts`), and the positive control has two parts — the pattern must
find that assignment, and the walk must reach the file holding it — because an empty
result proves nothing if either the pattern or the domain is wrong, and on this branch
both have been. The same widening was applied to the `HERDR_SOCKET_PATH` guard, which had
the same too-narrow walk.

### SCOPE REVERSAL: the in-process backend is kept as an option, not deleted

This item began as a hard delete — "`bun-terminal-host.ts` is deleted, not left beside
the new one; no feature flag, no dual code path" — and sixteen commits on this branch
are that change. The owner reversed it. **The governing record is SPEC.md's Decisions Log
entry of 2026-09-12, "THE REPL SUBSTRATE BECOMES SELECTABLE"**; this file cites it and
does not assert the reversal on its own authority. #540 is rewritten from "delete the
in-process PTY host" to "make the REPL substrate selectable".

That entry had to be written a round late, and the gap is the lesson: for one round the
reversal existed only in a spec item and in this file, while `AGENTS.md`'s "no feature
flags and no dual code paths" and the 2026-09-11 pivot entry's "the opaque PTY host goes"
both still stood as absolutes. **A work item cannot override an authority.** The
authorities are now amended in the shape they themselves prescribe — a new dated entry at
the top of the immutable log, the body marker edited in place, and the `AGENTS.md` rule
SCOPED rather than dropped, because a standing absolute the tree contradicts teaches the
next reader to ignore it. Note what was NOT done: the 2026-09-11 clause is inside a log
entry, and that log is immutable, so it stays verbatim and the new entry supersedes it —
the same treatment the 2026-09-12 codex entry gave the same pivot entry's outcome rule.

What was NOT done, deliberately: no user-facing chooser. herdr stays the only wired
default (`spawn.ts`: `options.ptyHost ?? herdrHost`), and the Bun host is reached by
injecting it at that seam. A switch between a proven path and an unproven one hides
which is which; the option is preserved at near-zero cost, not exercised.

**Three adaptations, not two.** The interface had moved twice while the file was gone:
`spawn` became `Promise<PtyChild>` (already-resolved here — the pid exists the moment
`Bun.spawn` returns) and `submitLine` became required. The third was not in the brief and
is the one that would have been a silent defect: `onData` had become `onScreen`, and
`PtyRing.replace` OVERWRITES with each delivery. Forwarding one byte chunk per call would
therefore erase all previous output every time, with the ring looking perfectly alive and
holding the last few bytes. The host accumulates instead.

Two details of that accumulation are the branch's own lessons reappearing. It decodes
with a STREAMING `TextDecoder`, because `stripPtyNoise` cuts at byte level and can leave
a chunk ending mid-character — the same defect fixed in the herdr client's inbound
framing. And it trims on a LINE boundary rather than a character count, because a
character cut would have to reason about surrogate pairs, which is the bytes-versus-units
lesson from `pty-ring.ts`.

**`submitLine` is implemented honestly rather than faked.** `submitCommand` refuses a
child without it because a detached write cannot support a claim about its effect — which
under herdr is literally true, since `pane.send_text` types without firing. Here the seam
is a local pty fd: a write that accepts every byte HAS delivered them to the kernel, and
`\r` on a pty genuinely submits, so "the bytes reached the child's terminal" is a fact
this host can assert and a short write is a fact it can refuse on. What it still cannot
assert is that the REPL acted on the line — no backend can, and the contract does not ask.

**One defect fixed rather than restored.** The old file latched `wasKilledByUs` on ANY
signal including SIGINT. That is the same defect the herdr backend was fixed for, and it
is the same defect here even though this backend has exit codes, because `spawn.ts`
evaluates `!killedByUs && exitCode !== 0` and a true flag short-circuits the code
entirely. SIGINT now records `wasInterruptedByUs`.

**The divergence is named, because it is the real cost.** Exit codes exist under Bun and
nowhere in herdr; exit is a push under Bun and a poll under herdr; `onScreen` is a
rendered pane under herdr and an accumulation under Bun. The last one has a consequence
that is a genuine defect and is written into the spec item rather than hidden:
`textSince` collapses an Ink repaint under herdr (the pane is redrawn; the multiset
difference is empty) and CANNOT under Bun, where a repaint really is new bytes. The Bun
path is no worse than it was before this item — the old byte-counter ring had the same
limitation, documented — but it does not get the fix. Swept for others: nothing
downstream consumes `exitCause` or `resize`, so their absence on one backend narrows
nothing today.

**And the deletion sweep had to be re-derived, for the third time on this PR — in the
opposite direction.** The earlier rounds corrected every document that still mandated the
Bun host. Reversing the deletion made those corrections the stale ones: `AGENTS.md` was
left asserting "there is no second backend and no flag to select one, so do not write
code against it" — false, in the file the next agent in that directory reads first. Also
corrected: `types.ts` ("is deleted; there is no second backend"), `pty-noise.ts` ("which
is GONE"), `herdr-host.ts`'s header, and `pty-host.ts`, which claimed a single backend
throughout. A claim about the tree has to be re-derived whenever the tree moves, and that
includes moving BACK.

**Three mutation survivors, each recorded with what absorbed it.** M159: a pty ECHOES
typed text, so the text appears on screen whether or not Enter was ever sent — the reader
was changed from `cat` to one that emits only on a complete line, and it reddens. M160: a
real pty does not short-write, and this host deliberately exposes no injection seam for
`Bun.Terminal`, so the guard's failure mode cannot be produced from outside; it stays a
defensive check with no case, said out loud rather than covered by a test that would only
test a fake. M161: the trim never runs at test volumes, so mutating its newline
preservation alone changes nothing — M162 runs the trim AND removes the preservation and
reddens, while M162b runs the trim with the preservation KEPT and stays green, which is
what identifies the preservation rather than the condition as the load-bearing half.

### The third cost of one connection per request: the deadline had to cover connecting

With a persistent connection, connecting happened ONCE at startup and every call was
bounded from an already-established socket. One connection per request moves the connect
inside every call — and that single move is why ordering was lost, why the frame bound
had to become per-frame, and now why the deadline had to be re-proved. The pattern is
worth naming: **a guarantee proved against a precondition has to be re-proved when the
precondition moves into the operation.**

Arming the timer was not enough. It settled the pending outcome, but the only `await` in
front of the first check of that outcome was the connect — so a connector that never
resolves parked there forever and `herdrCall` hung for good despite `timeoutMs`. The
connect now RACES the settlement, and because `pending` only ever resolves, the race
cannot turn a deadline into a rejection: `undefined` means the call ended while the
connect was still in flight, and a rejecting connect still rejects the race.

**The fixture, for the third time.** Every existing timeout case used a connector that
RESOLVES — after 40 ms, or instantly — and a connector that always resolves cannot test
one that does not. The unbounded path went in underneath an assertion about the ERROR
rather than about the call ending at all. The new case asserts TERMINATION: the call
races a sentinel, and a sentinel that wins is a hang. Same shape as the
`HERDR_SOCKET_PATH` finding and the stderr finding — in each, the tests could not reach
the state that mattered.

**Racing loses the reference, which is a new obligation.** The socket may still be
coming after the deadline, and nothing in the call's own lifetime can close it because
the call is already over. So the close is deferred to the connect itself, through
`fireAndForget` like every other piece of work that outlives its caller. M154 survived
until that case existed; M155 is its pair, and a deferred close that also fires for a
socket which arrived IN TIME reddens four end-count cases as a double close.

**The audit, not just the one await.** The blocker asked whether anything else between
arming the timer and the first observation of the deadline can block. `herdrCall` now has
exactly two awaits — the raced connect and the final outcome — and everything else on
that path (path resolution, framing, `socket.write`, every settlement) is synchronous.
The criterion carries that count as a check rather than as a claim.

### Unknown must not confirm — and known must not be discarded

Every rule on this branch so far has been the first half: an ambiguous failure settles
nothing, a failed question is not a negative answer, could-not-read is not absent. The
poll loop was breaking the OTHER half. Its `catch` took every read rejection alike,
threw the error away, and asked `pane.get` the same question — so a `pane.read` that came
back with the exact typed positive absence herdr offers settled nothing whenever the
follow-up probe happened to fail transiently. A definite answer discarded because the
code never looked at it.

The caught error is now examined: a typed `pane_not_found` settles immediately, and only
a genuinely ambiguous failure is worth a second question. The test that could see this
had to be the MIXED case — read typed, probe broken. Every existing test made BOTH calls
answer `pane_not_found`, which passes either way. M149 is the pair: widening the typed
check to any rejection reddens the three transient cases, so the fix did not buy the
definite case by giving up the ambiguous one.

### The live proof could leave stderr monkey-patched for the rest of the process

The hand-rolled capture is install, do the interesting thing, restore. The interesting
thing here is `await host.spawn(...)`, and the restore sat in a `finally` that began
AFTER it — so a protocol mismatch, an unreachable socket or a pid that never arrived left
`process.stderr.write` patched for the rest of the process. Two sites had that shape, one
of them the live boundary proof, where the failure mode is at its worst: the only test
that can see a real server fails, and its failure silently degrades every test after it.

Same family as the three suites that pointed `HERDR_SOCKET_PATH` at a dead path and never
put it back — process-wide state borrowed without a guaranteed return — which is why the
fix is a scoped helper rather than a fixed `finally`. The helper owns the `finally`, the
spawn runs inside its scope, and it needed one correction the first version got wrong:
restoring `original.bind(process.stderr)` leaves a DIFFERENT function object in place, so
two nested captures stack binds and nothing ever returns the process to where it started.
The test asserts IDENTITY for exactly that reason (M151 reddens it), and the reject case
asserts both that the write is restored AND that the error still propagates — a helper
that swallowed it would hide every live failure it exists to surface.

The rule is enforced, not observed: a guard fails any `*.e2e.test.ts` that assigns
`process.stderr.write` at all, with a positive control that the pattern finds the
assignment where it legitimately lives.

### The deletion sweep, done as a surface rather than as one symbol

Second deletion-claim mismatch on this PR, so this time the check was the whole exported
surface rather than the name in the review: every exported symbol in `herdr-host.ts`,
`herdr-client.ts`, `herdr-protocol.ts` and `pty-host.ts`, counted against its uses. It
found two.

`HerdrHostDeps.paneCloseTimeoutMs` — documented as the timeout for a post-transport-loss
`pane.close`, with no consumer and no such path left. Deleted: an exported option is a
promise, and this one promised a machine that had been removed.

`HerdrLayoutPaneNode` — a protocol shape carrying a live-server measurement (`command`
genuinely execs, which is the whole reason spawn is `layout.apply` and not `agent.start`),
also with no consumer. Deleting it would have thrown away the measurement; leaving it
exported and unused is the same dead-option defect. So it was made LIVE instead: the
`layout.apply` root is now typed with it, which is what turns a claim about the protocol
into a description of the request we actually send.

### A per-frame bound written as a per-delivery bound, and what the survivor means

The bound I built measured `end + chunk.length` — the DELIVERY — and then looked for the
newline afterwards. A peer is free to coalesce a complete, legal reply with the first
byte of whatever follows it into one write; against a cap equal to that reply's own
length, the legal reply is refused. That is a worse failure than the allocation problem
it replaced, because it rejects valid traffic rather than merely working too hard on
invalid traffic.

The newline is now located in the incoming chunk FIRST — a scan, not an allocation —
which is sound because everything already buffered is newline-free by construction (we
settle on the first one). Only the frame's own bytes are bounded, and only they are
copied; whatever the peer coalesced after the newline is dropped unread, since this
connection carries one reply and is about to close.

**My "second reply cannot overwrite the first" test had dodged the boundary.** It forced
the first frame into its own chunk with `chunkSize: 28`, so the coalesced case — the only
arrangement that can tell per-frame from per-delivery — was never exercised. It now runs
both shapes, and they exercise different code: chunked, the second frame reaches an
already-settled call and is refused by the settlement guards; coalesced, it never arrives
at all.

**M145 survived, and the honest reading is that the criterion over-claimed.** Moving the
check back after the copy changes nothing observable: both orders reject, with the same
message and the same outcome. The ordering is a structural property held by the check
preceding `append` and by nothing else. Saying that in the criterion is more useful than
a test that appears to cover it — and it is the second time on this branch that asking
"what is absorbing this mutation?" produced a correction to the RECORD rather than to the
code.

### `?? {}` came back, and that is the whole lesson

Round 11 removed a coercion that made an unknown indistinguishable from a legitimate
empty result, and wrote the criterion against it. Rewriting the transport around that
criterion put it back — on the success path this time, as an optional `value` settled
with `value ?? {}`.

A defect removed by a CHECK comes back when the code around it is rewritten. A defect
removed by a TYPE does not. This branch has now proved that in both directions: the
buffer, where the guard became the data structure, has not regressed across three
rewrites; this one, where the guard was a `??`, came back at the first one.

So the success settlement takes a required `Record<string, unknown>` — no optional
parameter, no default — and the only caller is the branch where `classifyReply` has
already proved the reply carried an object-valued `result`. The proof is a TYPECHECK
rather than a test: calling it with no argument is TS2554, "Expected 1 arguments, but got
0" (M146). There is no runtime mutation to run, which is the point.

### A unit test could switch off the only instrument that can see the real server

Three suites set `HERDR_SOCKET_PATH` to a dead path at module scope, with no teardown.
They were right to want it — `start()` reaches the real host, and without the guard they
create real panes on the owner's herdr server and sit out the pid timeout. What was wrong
is the scope: a process-wide write that is never put back disables the live herdr proofs
for everything that runs after it, and those proofs are the only tests in this repo that
can see a real server. They are also precisely the instrument that would have caught the
transport defect this branch exists to fix.

They now save and restore in `beforeAll`/`afterAll`, both halves (delete when the value
was absent, restore when it was set). And because "I fixed the three I know about" is not
an answer to "what else can do this", the rule is now enforced: a guard in
`tests/integration/pty-e2e-registered.test.ts` walks every `*.test.ts` and fails on any
suite that ASSIGNS `HERDR_SOCKET_PATH` or `NEUTRON_PTY_E2E` without restoring it. It
carries a positive control — an empty offender list means nothing if the pattern reaches
no code — and it needed one immediately: the first pattern matched the `===` of every
gated suite reading its own flag and reported all three e2e suites as offenders (M147).

That guard file was already the home for two incidents of the same family — a flag that
never arrived because it was set nowhere, and a flag scrubbed by the test preload. This
is the third direction on the same hole: a switch turned off by an unrelated suite in the
same process. A test that can disable the only instrument capable of catching a whole
defect class is a coverage hole no coverage measurement will show, because the instrument
reports "skipped", and skipped reads as a decision rather than as damage.

### One connection per request threw away ordering, and nothing in the tree noticed

A single multiplexed socket ordered our writes for free — frames left in the order we
wrote them, on one stream. One connection per request does not: two fire-and-forget
actuations started in the same tick are two independent connects racing, and the loser
can be the one that had to go first. The sequence that breaks was already in the tree
before this PR: `session-size-watchdog.ts` actuates `escape`, then the `/compact` text,
then `enter`, in three consecutive statements. An Enter that overtakes its text submits
whatever was on the line and leaves `/compact` typed and unsent — a compaction that
silently did not happen, and possibly a stray prompt that did.

Every actuation now goes through one chain and does not start until the previous one is
answered; `submitLine` is queued as one unit. `pane.read` and `pane.close` stay outside
it, and the code says why: the poll is a sampler and must not be blinded by a stalled
keystroke, and a teardown preempts rather than queues because `repl-session.ts`'s
escalation ladder depends on the close being prompt.

**Why the existing ordering test could not see this.** It compared indices in the fake's
`calls` array — which is pushed the moment the host hands the request over, before any
hold, before either connection is answered. That records the CALL SITE, not the
delivery, and it passes for an implementation with no ordering at all (M137 reddens the
three new held-RPC cases and none of the old one). The fake now records `delivered`
separately, pushed past the hold and the failure injection, and every ordering assertion
reads that. M140 mutates the fake itself — recording delivery at invocation time — and
reddens three cases, which is how I know the new array is load-bearing rather than a
second name for the old one.

**Two survivors taught me something and one did not.** M138 survived because my
atomicity test compared METHOD names, and `submitLine`'s Enter and the competing
`writeKey('enter')` are both `pane.send_keys` — the same sequence under either order. A
distinguishable competitor (`escape`) makes it red. M139 survived because the two-handler
`.then(run, run)` was dead code: the chain tail is already re-pointed at a neutralised
promise, so it can never reject, so the rejection handler never runs. That is a case
where the survivor meant the CODE was redundant rather than the test weak, and the fix
was to delete the handler and mutate the line that actually holds the property (M139b,
red). M142 — dropping the door-side exit check — survives and stays survived: the
post-queue check is strictly stronger, and the door check only avoids queueing work for
a dead pane.

**A fixture that had been passing by accident.** Making actuations one microtask slower
broke two tests that waited for an exit with the poll loop parked at 10 s. They had been
passing because `exitPane()` happened to land while the first poll iteration was still
in flight — the arrangement doing the step under test by coincidence. The poll interval
is now a parameter of the local `spawn` helper, and any test that waits for an exit
passes a short one.

### The implementation and the record disagreed about a deletion, for the third time

The as-built said PID signalling and the `/proc` parsing were deleted. The host still
imported `readFileSync`, still exported `HERDR_PID_KILL_GRACE_MS`, and still carried the
`/proc/<pid>/stat` field-22 parser with a doc comment pointing at a `terminateLostChild`
that no longer existed. All of it dead, none of it noticed, because nothing fails when an
export goes unused.

A claim of deletion is a claim about the TREE, and it has to be re-derived after the
deletion actually happens — the same rule as running the citation sweep last. The
machinery is gone; a short comment records what was removed and why, and the acceptance
criterion now carries an anchored grep (no declaration, no import) with a positive
control so the empty result is an absence rather than a mistyped path.

### Rewriting the transport left twelve criteria describing code that no longer exists

I replaced ONE acceptance criterion when the transport was rewritten — the one that
named the shape — and left the rest. That was the same mistake in a different file:
deleting the code and keeping the sentence that mandates it. Eleven more criteria still
described the multiplexing client, and their verify commands all still PASSED, because
the tests they named had been deleted alongside the code. A criterion whose verify runs a
suite that no longer contains the case is not weak evidence, it is evidence of the wrong
thing entirely.

Swept, with what happened to each:

| criterion | disposition |
| --- | --- |
| transport loss terminates the pid it learned at spawn | DELETED — contradicted the one-connection criterion two entries above it |
| every entry point consults `closed` | DELETED — no flag, no long-lived client |
| `data` is part of the event envelope (5 shapes + control) | DELETED, its RULE re-pointed at the reply envelope |
| a CLOSED transport accepts nothing | REWRITTEN as "a SETTLED CALL accepts nothing further" |
| a `pane_exited` while our close is in flight is ours | REWRITTEN to the polling form (`pane_not_found` mid-close) |
| teardown is an action, healthy exchange ends the socket ZERO times | REWRITTEN — the control INVERTED: exactly ONCE now, or a descriptor leaks per call |
| a malformed frame is terminal (and poisons the next call) | REWRITTEN — the next call is a new connection, which is stronger |
| every RPC bounded by a clock, reaching `teardown` | REWRITTEN + extended with the mid-connect deadline |
| a frame that parses but matches no envelope is torn down (`isClosed()`) | REWRITTEN — assert the envelope message, not a flag |
| inbound buffering is linear, proved by a 200k-delivery load case | REWRITTEN — the load case is RETIRED with the shape it policed, and the retirement is recorded rather than silent |
| retention is measured as ALLOCATION (`subarray` view) | FOLDED into the above — there is no leftover to retain |
| the frame limit's "many valid frames in one delivery" case | REWRITTEN — one connection carries one reply |
| short write routes to `'transport-lost'` | REWRITTEN — the cause is gone; the property is not |
| a failed spawn closes the pane ("the subscription refusing") | REWRITTEN — at this version the only post-creation failure is the pid never arriving |
| nothing is built on `output_changed` (control: "the subscription that IS used") | REWRITTEN — the positive control named a subscription that no longer exists |

Three of the rewrites needed NEW tests rather than new prose, because the property
survived the rewrite but nothing asserted it any more: a settled call accepting nothing
further, every terminal route closing the connection exactly once, and a deadline firing
mid-connect leaving no unobserved rejection. The first two of those are where M132–M136
came from.

The count went 50 → 49, which is the least interesting fact about the sweep.

### Mutation table

Every guard was mutated. **Not every mutation reddened**, and the survivors are in the
table with what absorbed each one — this sentence said otherwise for several rounds while
the table below it recorded the opposite, which is the plainest kind of false claim: one
contradicted by its own page. The rows that matter are the ones marked SURVIVED, because
each names either a redundancy in the code (two guards absorbing each other), a property
with no runtime observable, or a fixture that could not reach the state under test — and
in every case the correction went into the record or into the fixture rather than into a
looser claim.

Run against the named suites.

| # | Mutation | Result |
|---|---|---|
| M1 | protocol gate removed (`if (false)`) | RED 3 |
| M2 | gate becomes a floor (`<`) instead of equality | RED 2 |
| M3 | `exited` resolves `0` instead of `null` | RED 4 |
| M4 | deliver on every poll, not on change | RED 1 |
| M5b | `catch { text = '' }` with no pane probe | RED 3 |
| M6 | suppress an empty screen (breaks the falling edge) | RED 1 |
| M7 | `textSince` returns the whole current screen | RED 9 |
| M8 | set difference instead of multiset | RED 3 (incl. the live warm-latch-re-arm case) |
| M9 | `mark()` captures an empty baseline | RED 9 |
| M10 | `replace` appends (the diff-append shape) | RED 13 |
| M11 | byte-slice clamp instead of line-aligned | RED 1 |
| M12 | key map emits `ctrl-c` (the form the server rejects) | RED 5 |
| M13 | `write()` accepts `\r` (silent never-submits) | RED 2 |
| M14 | poll interval raised to the quiet window (250 → 900) | RED 2 |
| M15 | read window narrowed below the widest detector (200 → 40) | RED 1 |
| M16 | read drops the viewport allowance | RED 3 |
| M17 | viewport hardcoded instead of read | RED 2 |
| M18 | invent a pid instead of refusing the spawn | RED 1 |
| M19 | `pane_exited` not filtered by `pane_id` | RED 1 |
| M20 | `pool.ts` `/clear` with no submit | RED 1 |
| M21 | `context-reset.ts` `/clear` with no submit | RED 12 |
| M22 | `/compact` with no submit | RED 9 |
| M23 | `spawn.ts` appends screens into the ring | RED 1 (the stale-banner case) |
| M24 | the real child omits `writeKeys` (makes the byte fallback reachable) | RED 2 |
| M25 | transport loss does not settle the child | RED 2 |
| M26 | restore the silent skip (`?.` on `writeKey`) | RED 2 |
| M27 | drop the read-cap clamp | RED 4 |
| M28 | OVER-EAGER clamp — cap every request regardless of viewport | RED 5 |
| M29 | `exitCause` collapses to a constant | RED 2 |
| M26b | silent skip, run against the `pool.ts` reset path | SURVIVED — inapplicable, see below |
| M30 | an init failure leaks the pane (closes only the connection) | RED 2 |
| M31 | OVER-EAGER cleanup — close a pane `layout.apply` never created | RED 1 |
| M32 | viewport cached forever | RED 2 |
| M33 | short write ignored | RED 2 |
| M34 | compare `String.length` instead of byte length | RED 1 (after the gap test) |
| M35 | ring bound measured in code units | RED 1 |
| M36 | per-line drop accounting in code units | RED 1 (after the retention test) |
| M37 | tail cut by code units, splitting characters | RED 3 |
| M38 | any rejection means the pane is gone | RED 2 |
| M39 | OVER-STRICT — never conclude absence at all | RED 4 |
| M40 | malformed frame leaves the connection usable | RED 1 |
| M41 | OVER-EAGER — close on every inbound frame | RED 12 |
| M42 | teardown MARKS without closing the socket (the root) | RED 4 |
| M43 | malformed-frame route bypasses teardown | RED 2 |
| M44 | short-write route bypasses teardown | RED 4 |
| M45 | thrown-write route bypasses teardown | RED 1 |
| M46 | per-chunk decode restored | RED 2 |
| M47 | teardown not idempotent (closes more than once) | RED 1 |
| M48 | no RPC clock — a complete frame with no reply hangs | RED 2 |
| M49 | a reply does not cancel the clock (healthy conn torn down) | RED 1 |
| M50 | the timeout bypasses teardown | RED 1 |
| M51 | SIGINT latches `killedByUs` again | RED 3 |
| M52 | a TERMINAL kill stops latching `killedByUs` | RED 3 |
| M53 | no envelope validation (parsed treated as valid) | RED 9 (after the sync assertion) |
| M54 | OVER-STRICT envelope — reject everything | RED 18 |
| M55 | no inbound size bound | RED 2 |
| M56 | off-by-one — rejects a frame EXACTLY at the limit | RED 1 |
| M57 | frame size checked AFTER dispatch (the original defect) | RED 2 |
| M58 | poll loop ignores the output gate | RED 2 (after widening the window) |
| M59 | the gate never fails open | RED 1 |
| M60 | `beginOutput()` does not release | RED 17 |
| M61 | frame bound `>=` — rejects a maximal COMPLETE frame | RED 2 |
| M62 | settle from `.finally()` — settle whether or not the close succeeded | RED 2 |
| M62b | PAIR: settle ONLY on a failed close, never on a successful one | RED 3 |
| M63 | do not clear the kill flag when the close fails (latch on the attempt) | RED 1 |
| M63b | PAIR: clear the kill flag on a SUCCESSFUL close too | RED 2 |
| M64 | `wasKilledByUs` always false | RED 6 |
| M65 | `submitLine` sends the text fire-and-forget instead of awaiting it | RED 1 |
| M65b | PAIR: `submitLine` sends Enter BEFORE the text | RED 2 |
| M66 | `submitLine` swallows a refused Enter | RED 1 |
| M67 | `submitCommand` falls back to `write`+`writeKey` when `submitLine` is absent | RED 1 |
| M68 | `submitLine` no-ops after exit instead of rejecting | RED 1 |
| M69 | `context-reset.ts` drops the `await` on `submitCommand` | RED 2 |
| M70 | `pool.ts` drops the `await` on `submitCommand` | RED 1 |
| M70b | PAIR: `pool.ts` reports a failure even when the submit SUCCEEDS | RED 1 |
| M71 | the fake ignores injected per-method failures | RED 4 |
| M72 | a successful `pane.close` does not record the closure in the fake | RED 2 |
| M73 | the fake's `holdMethod` does not actually hold | RED 1 |
| M76 | restore the presence-only outcome check (the original defect) | RED 9 |
| M77 | accept BOTH `result` and `error` | RED 1 |
| M78 | PAIR: over-strict — reject a legitimately empty `result:{}` | RED 1 (the control) |
| M79a–M79d | accept ONLY a string / null / array / number `error` | RED 1 each, its own row |
| M80a–M80d | accept ONLY a string / null / array / boolean `result` | RED 1 each, its own row |
| M81 | the assumed viewport is silent again | RED 1 |
| M81b | PAIR: warn even when the viewport WAS measured | RED 1 (the control) |
| M82 | warn on every poll instead of once | RED 1 |
| M83 | a malformed read is delivered as an EMPTY screen | RED 2 |
| M83b | PAIR: a malformed read latches, so the loop never recovers | RED 2 |
| M84 | the malformed read is silent again | RED 1 |
| M85 | the fake ignores `malformMethod` | RED 2 |
| M86 | restore the UNCONDITIONAL reset (the reported defect) | RED 1 |
| M86b | PAIR: never clear the flag, even while the child is ALIVE | RED 1 |
| M87 | reset first, then guard — ordering inverted | RED 1 |
| M88 | the fake stops failing in-flight calls on close | SURVIVED alone — see M88b |
| M88b | M88 **combined** with the host defect restored | GREEN with the bug present: the fake is the enabling condition |
| M89 | remove the post-close guard on `onBytes` (the reported defect) | RED 2 |
| M89b | PAIR: refuse bytes ALWAYS, not only after close | RED 53 |
| M90 | guard placed AFTER buffering — refuses to dispatch but still accumulates | RED 1 (the accumulation case alone) |
| M91 | MOVE `closed = true` below `failAll` (ordering only) | SURVIVED — the ordering is unobservable; see above |
| M92 | a refused subscribe keeps its handler registered | RED 1 |
| M93 | unregister on EVERY subscribe, not only the failed one | RED 3 |
| M94 | restore the quadratic append (`concat` per chunk) | RED 1 — only after the load was re-chosen by measurement |
| M95 | drop the unterminated bound on the fast path | RED 3 |
| M95b | PAIR: bound at `>=` so a frame exactly at the cap is rejected | RED 2 |
| M96 | keep a `subarray` VIEW of the tail instead of copying it | RED 1 |
| M96b | `retainedBytes` reports logical length, not allocation | SURVIVED alone — see M96c |
| M96c | M96b **combined** with the view restored | GREEN with the bug present: the accessor's fidelity is the enabling condition |
| M97 | the fail-open gate releases but says NOTHING | RED 1 |
| M97b | warn even when `beginOutput()` was called in time | SURVIVED alone — `beginOutput` clears the timer |
| M97c | M97b **combined** with `clearTimeout` removed (both guards off) | RED 1 (the control) |
| M98 | restore the bare settle on transport loss (the reported defect) | RED 2 |
| M98b | PAIR: never settle on transport loss, even when death IS confirmed | RED 4 |
| M99 | attempt the kill but do not confirm it | RED 1 |
| M100 | no escalation — SIGTERM only, never SIGKILL | RED 1 |
| M101 | a missing pid read as confirmed death | SURVIVED — branch unreachable; deleted, type tightened |
| M102 | EPERM counted as dead | SURVIVED alone → probe exported and tested → RED 1 |
| M102b | PAIR: every failed probe counted as ALIVE (ESRCH read as running) | RED 3 |
| M103 | signal without checking identity (the PID-reuse defect) | RED 1 |
| M103b | PAIR: never signal — treat every transport loss as already dead | RED 2 |
| M104 | no captured identity treated as confirmed death | RED 1 |
| M105 | identity compares existence only, ignoring the start time | RED 1 |
| M106 | start time parsed by absolute field index | SURVIVED (comm had no space) → parser extracted and tested → RED 1 |
| M107 | retain the delivered chunk in an extra field | SURVIVED — invalid: adds state the shape forbids |
| M108 | never shrink — keep the buffer at its high-water mark | RED 1 |
| M108b | PAIR: shrink always to the initial capacity (truncation) | SURVIVED until a large remainder existed → RED 1 |
| M109 | linear growth instead of doubling | RED 1 |
| M110 | allocate first, validate after (the reported defect) | RED 17 |
| M110b | PAIR: reject on TOTAL delivery size instead of per frame | RED 3 |
| M111 | ignore the carried prefix when measuring the first frame | RED 3 |
| M112 | unterminated tail not measured before buffering | RED 4 |
| M113 | unknown identity treated as confirmed death (the reported defect) | RED 1 |
| M113b | PAIR: positively-absent treated as unknown (never confirms) | RED 2 |
| M114 | every errno read as gone | SURVIVED (probe injected everywhere) → reader injectable → RED 1 |
| M114b | PAIR: ENOENT read as unknown | RED 2 |
| M115 | an unparseable stat line read as gone | SURVIVED → RED 1 with the mapping test |
| M116 | unknown DURING the grace loop still confirms | SURVIVED (no case for that window) → RED 1 |
| M117 | settle without closing the pane | RED 3 |
| M117b | PAIR: never settle even when the close SUCCEEDS | RED 3 |
| M118 | reuse the dead client instead of reconnecting | RED 3 |
| M119 | an unreachable server counted as confirmed closure | RED 1 |
| M120 | any rejection counted as confirmed, not just `pane_not_found` | RED 1 |
| M120b | PAIR: `pane_not_found` NOT counted as confirmed | SURVIVED (fake returned ok) → fake corrected → RED 1 |
| M121 | the fake stops rejecting close on a missing pane | RED 4 |
| M122 | the frame bound runs AFTER the copy | RED 1 |
| M123 | a close before the reply resolves empty instead of failing | RED 1 |
| M124 | a short write accepted as a sent request | RED 1 |
| M125 | presence-only outcome check (no shape validation) | RED 5 |
| M126 | the per-call timeout never fires | RED 1 |
| M127 | the version gate accepts any protocol | RED 2 |
| M128 | the socket is never closed after a call | RED 1 |
| M129 | the call settles by REJECTING, restoring the unobserved-rejection window | RED 1 |
| M130 | a failed outcome returns `{}` instead of throwing | RED 24 |
| M130b | PAIR: a SUCCESSFUL outcome throws too | RED 8 |
| M131 | the connect is fired and forgotten again — its rejection dropped | RED 2 (both by hanging to the 5s default) |
| M132 | settlement is not once-only (`if (settled) return` dropped from `finish`) | SURVIVED — absorbed by the `onBytes` guard |
| M133 | bytes after settlement are still accumulated (guard dropped from `onBytes`) | SURVIVED — absorbed by the `finish` guard |
| M134 | COMBINED: BOTH settlement guards removed | RED 1 |
| M135 | the socket is closed only on SUCCESS, never on a failure route | RED 1 |
| M136 | PAIR: the socket is closed TWICE on the healthy route | RED 3 |
| M137 | no serialisation — actuations fire concurrently again | RED 3 |
| M138 | `submitLine` enqueues its text and its Enter SEPARATELY | SURVIVED (test compared METHOD, and both keys are `pane.send_keys`) → test fixed → RED 1 |
| M139 | the chain continues only on success (`.then(run)` not `.then(run, run)`) | SURVIVED — the tail is neutralised anyway, so the second handler was dead code; removed |
| M139b | the chain TAIL is not neutralised (`actuations = started`) | RED 1 |
| M140 | the fake records delivery at INVOCATION time, before the hold | RED 3 |
| M141 | the queued call skips the post-queue exit check | SURVIVED (no case) → RED 1 |
| M142 | PAIR: the door-side exit check is dropped | SURVIVED — unobservable; the post-queue check is strictly stronger |
| M143 | the bound measures the DELIVERY again (`end + chunk.length`) | RED 1 |
| M144 | PAIR: no bound at all once the frame is complete | RED 1 |
| M145 | the bound runs AFTER the copy | SURVIVED for eight rounds — both orders rejected identically → framing extracted as a `FrameReader` with a `copiedBytes()` observable → **RED 2** |
| M146 | settle a SUCCESS with no result | TS2554 at typecheck — refused by the type, not by a test |
| M147 | the live-proof guard's assignment pattern matches `===` too | RED 1 (it reported all three gated suites as offenders) |
| M148 | the typed `pane_not_found` from the READ is discarded again | RED 1 |
| M149 | PAIR: ANY read rejection settles, not only the typed one | RED 3 |
| M150 | the capture helper restores only on the happy path (no `finally`) | RED 1 |
| M151 | the helper restores a BOUND copy instead of the original reference | RED 2 |
| M152 | a live proof hand-rolls the stderr patch again | RED 1 |
| M153 | the connect is awaited again instead of raced against the deadline | RED 1 |
| M154 | a socket arriving after the deadline is abandoned | SURVIVED (no case) → RED 1 |
| M155 | PAIR: the deferred close fires for a socket that arrived IN TIME | RED 4 (a double close) |
| M156 | `onScreen` forwards each CHUNK instead of the accumulation | RED 1 |
| M157 | SIGINT latches `wasKilledByUs` again (the restored file's old behaviour) | RED 1 |
| M158 | `submitLine` no-ops after exit instead of refusing | RED 1 |
| M159 | `submitLine` sends the text and never the Enter | SURVIVED — a pty ECHOES, so the text appears unsubmitted → reader changed to emit only on a complete line → RED 1 |
| M160 | a SHORT write is accepted as delivered | SURVIVED — a real pty does not short-write, and this host deliberately has no injection seam |
| M161 | the trim's trailing-newline preservation is removed | SURVIVED — the trim never runs at test volumes |
| M162 | COMBINED: the trim always runs AND drops the trailing newline | RED 1 |
| M162b | CONTROL OF THE COMBINATION: the trim always runs, preservation KEPT | GREEN — so the preservation is the load-bearing half, not the condition |
| M163 | the screen bound is a LINE COUNT again | RED 5 |
| M164 | PAIR: no bound at all | RED 5 |
| M165 | the clamp cuts UTF-16 units instead of a character-safe byte tail | SURVIVED against a real pty (it drops output) → moved to the accumulator → RED 3 |
| M166 | the byte counter is not refreshed after a clamp | SURVIVED twice (no strict shrink to count) → budget-use-when-saturated assertion → RED 1 |
| M167 | the clamp trims to the CAP, not the low-water mark | RED 1 |
| M168 | the clamp uses `bottomNLines` (drops the trailing newline) | RED 5 |
| M169 | a test hand-rolls the stderr patch outside the helper | RED 1 (the widened guard) |
| M160b | the Bun short-write check is deleted | RED 4 (through the extracted seam) |
| M170 | the payload is measured in UTF-16 units, not bytes | RED 1 |
| M171 | PAIR: the check is over-strict (`<=`), rejecting a complete write | RED 6 |
| M172 | `submitLine` stops calling the guard (bare `terminal.write`) | SURVIVED (no pty short-writes 8 bytes) → terminal injected → RED 2 |
| M173 | a REFUSED text still sends the Enter — a blind submit | RED 1 |
| M174 | the injected terminal is ignored | RED 3 |
| M175 | the shared `write()` contract keeps herdr's "DOES NOT SUBMIT" clause | prose — no test; the defect is a FALSE STATEMENT to callers, and the check is that the interface names no backend-specific rule |
| M176 | the Bun readiness gate is removed (deliver straight through) | RED 1 (the SHARED suite) |
| M177 | the Bun gate holds but never delivers what it held | RED 1 |
| M178 | the Bun release is not once-only — it re-delivers on every call | RED 1 |
| M179 | the HERDR poll loop stops awaiting its gate | RED 1 — the same shared suite, which is the proof it runs against both |
| M180 | `submitLine` does not re-check exit at EXECUTION time | RED 1 |
| M181 | that re-check DROPS instead of throwing (a silent success) | RED 1 |
| M182 | PAIR: the door-side check is dropped | SURVIVED — unobservable; the execution-time check is strictly stronger, as with M142 |
| M183 | a live proof constructs `HerdrHost` directly again | RED 1 |
| M184 | a live proof stops using the scoped helper entirely | RED 1 |
| M185 | the close is fired and not awaited — the leak itself | RED 1 |
| M186 | an unconfirmed close is silent | RED 1 |
| M187 | the confirmation wait is UNBOUNDED (a leak becomes a hang) | RED 1 |
| M188 | an already-exited child is killed anyway | RED 1 |
| M189 | the leak diff is a length compare (a CLOSED pane reads as a leak) | RED 2 |
| M190 | a failing spawn does not close the terminal it already allocated | RED 2 |
| M191 | a failing spawn leaves the readiness timer armed (a FALSE wiring warning) | RED 1 |
| M192 | the allocation is outside the guard again | RED 2 |
| M193 | PAIR: the cleanup runs on SUCCESS too, closing a live pty | RED 5 |
| M194 | the exit RELEASES the gate again — the microtask race | RED 3, one of them the SHARED suite |
| M195 | PAIR: the exit disarms the gate WITHOUT releasing (the last screen is lost) | RED 2 |
| M196 | the frame's terminator is copied into the line | RED 2 |
| M197 | the whole delivery is copied, coalesced surplus included | RED 2 (first attempt adjusted the counter and survived — a mutation must break the property, not just look like it) |
| M198 | the pty DROPS the screen it held past the exit | RED 2 — invisible until the conformance assertion stopped being conditional |
| M199 | herdr delivers a FAILED read as an empty screen | RED 1 — which is what makes its ZERO an asserted outcome rather than an absent one |
| M200 | any string id is accepted again (no correlation) | RED 1 |
| M201 | the id check is dropped entirely | RED 3 |
| M202 | PAIR: the check is over-strict — nothing correlates | RED 12 |
| M203 | the REQUEST sends an id the check does not expect (they drift) | RED 1 |
| M204 | the flag is NOT cleared when the signal throws (the defect) | RED 2 |
| M205 | the INNER liveness guard alone | SURVIVED — unreachable in this host; `kill()` is synchronous end to end |
| M206 | the clear is WIDENED — a failing SIGINT erases a recorded termination | SURVIVED (both flags false in the SIGINT-only case) → own case added → RED 1 |
| M207 | PAIR: nothing latches at all | RED 4 |
| M208 | the TOP liveness guard alone | SURVIVED (absorbed) → entry-guard observable added → RED 1 |
| M209 | COMBINED: BOTH liveness guards removed | RED 1, and a DIFFERENT test from M204 |
| M210 | `pane_not_found` from the close is an unknown again (the defect) | RED 1 |
| M211 | PAIR: ANY close rejection settles — unknown treated as confirmation | RED 3 |
| M212 | a refused SIGINT keeps its latch (the defect) | RED 1 |
| M213 | PAIR: the SIGINT flag is never latched at all | RED 3 |
| M214 | the Bun release dispatch is unguarded again (a throwing consumer escapes) | RED 1 (the SHARED suite) |
| M215 | a `PtyHost` fake returns a child SYNCHRONOUSLY (the #642 fixtures) | RED 3 by TIMEOUT + 7 typecheck errors — and the timeout is the tell |
| M216 | a hand-rolled stderr patch arrives from another branch | RED 1 (the widened guard, on a file neither branch's author re-read) |
| M217 | the version gate is bypassed when a `connect` is injected (the defect) | RED 3 |
| M218 | the version gate is removed entirely | RED 3 |
| M219 | PAIR: the gate becomes a floor (`<`) instead of equality | RED 3 |
| M220 | the gate runs AFTER `layout.apply` — a pane behind a rejected spawn | RED 1, and only the no-pane case |
| M74 | restore `?? {}` — coerce any non-object `data` to an empty object | RED 5 |
| M74b | PAIR: over-strict — reject a genuinely EMPTY `data:{}` too | RED 1 (the control) |
| M75a | accept ONLY an absent `data` | RED 1 (its own case) |
| M75b | accept ONLY `data:null` | RED 1 (its own case) |
| M75c | accept ONLY an array `data` | RED 1 (its own case) |
| M75d | accept ONLY a string `data` | RED 1 (its own case) |
| M75e | accept ONLY a number `data` | RED 1 (its own case) |

M132 and M133 both SURVIVED, and the reason is the answer rather than a gap: the two
settlement guards are redundant, so each absorbs the other, and a single mutation of
either leaves the behaviour intact. M134 removes both and reddens. The criterion is
therefore the PAIR, not either line — and this is the third time on this branch that a
survivor meant "something else is holding the property" rather than "the test is weak".
Worth naming too: the resolve-only settlement makes the OUTCOME structurally
unoverwritable (a resolved promise ignores a second settle), so the only observable that
can see a second settlement at all is the socket end count. M135/M136 bracket that count
from both sides.

M75a–M75e are the individual-case proof: each leaks exactly ONE shape past the guard
and reddens exactly that shape's row, so no case in the `data` table is redundant.
M74 is the defect restored (all five), M74b the over-strict twin.

M62/M62b bracket settlement from both sides — settling on failure and failing to settle
on success — and M63/M63b do the same for the kill flag; without the pair, "never latch"
is satisfied by a flag that is never set at all. M64 is the collapse case. M65b is the
one that needed thinking about: sending Enter first still sends both frames, so the call
log alone cannot tell the orders apart — what separates them is that a refused text must
leave the Enter UNSENT, because a blind Enter submits whatever the prompt already held.
M71–M73 mutate the FAKE rather than the code, which is the only way to show that the new
levers are load-bearing: if disabling `failMethod` or `holdMethod` changes nothing, the
tests that depend on them were passing for some other reason.

M58/M60 bracket the gate from both sides (ignored entirely, and never opened), M59 pins
the fail-open, and M61 is M56's terminated-frame twin: the at-limit case must hold on
both the terminated and unterminated paths.

M53/M54 and M55/M56 are the pairs, and M56 is the one worth naming: a bound that fires
at `>=` instead of `>` rejects a legitimate maximal frame, which is a new failure mode
rather than a fix, so the at-limit case is asserted as hard as the over case.

M48/M49 and M51/M52 are the pairs: a clock that never fires and one that fires on a
healthy connection both redden, and so do a SIGINT that latches and a terminal kill
that does not.

M42 is the root and M43–M45 are the three routes to it, each mutated separately so no
route can silently stop reaching the teardown. M47 is the pairing habit again: a
teardown that fires more than once reddens too, alongside the CONTROL that a healthy
exchange ends the socket zero times.

M38/M39 and M40/M41 are pairs in the same way M27/M28 and M30/M31 are: the
discrimination has to fire on the definite case and NOT on the indefinite one, so
both over- and under-applying it redden.

**M36 survived first, and fixing my test taught me what the defect actually was.**
I had assumed wrong per-line accounting would break the byte BOUND. It does not —
under-charging each removed line makes `size` fall too slowly, so the loop drops
MORE lines than needed. The bound holds; what is lost is RETENTION, and a ring that
discards screen a correct implementation would have kept can fall below the detector
window. The test now pins the maximal fitting tail (4 lines at 83 bytes fit under a
100-byte cap; 5 at 104 do not) rather than only the ceiling — a bound-only check
passes for an implementation that discards everything.

M30/M31 are a pair on the same reasoning as M27/M28: the cleanup must fire when a
pane exists and NOT when one does not, so removing it and over-applying it both
redden. M34 is the one that survived first and is described above.

**M26b SURVIVED, and the honest reading is that the mutation is inapplicable, not
that coverage is missing.** Run against `import-warm-session-reset.test.ts` — which
exercises the OTHER reset site, `pool.ts` — restoring the silent skip changes
nothing, because that fake supplies `writeKey`, so `submitCommand` reaches
`child.writeKey('enter')` either way. The writeKey-less case there is pinned by
`submitCommand`'s own test and end-to-end through `actuateSessionContextReset`.

I deliberately did NOT add an end-to-end test for the pool site's writeKey-less
case, because it could not discriminate. That path is wrapped in a catch that logs
and proceeds ("a clear failure must not strand the import"), so with a missing
`writeKey` the observable is: no clear happened, the turn ran anyway — which is
EXACTLY what the silent skip produced. The only difference the fix makes there is
that it is now logged rather than invisible, and a test asserting a stderr line is
brittle enough to be worse than the gap. Naming the limit is the honest option;
a test that passes before and after the fix would have been decoration.

M27 and M28 are a pair, and neither alone is a criterion: the clamp must bite at a
viewport of 800 **and** stay out of the way at 24, so removing it reddens the
boundary cases while over-applying it reddens the ordinary ones. A guard that simply
capped every request would pass M27's test and fail M28's.

### One latent trap found on the way out, and closed

`sendKey`/`sendKeys` (`signatures.ts:185-198`) degrade to `child.write(encodeKey(...))`
for a child that omits the F2 extensions. That fallback **cannot work under herdr**:
`encodeKey('enter')` is `\r`, and this backend's `write()` refuses `\r`. A detector
firing `['1','enter']` down the fallback would throw on the scan path rather than
press a key. It is unreachable in practice because `HerdrHost` always provides both
methods — but they are OPTIONAL on the interface precisely so fakes may omit them,
so nothing asserted it. It is now pinned by a test (and M24), and the docstrings at
`signatures.ts:179` and `keystrokes.ts:24` say why, having also been carrying
dangling citations to the deleted `bun-terminal-host.ts` (fixed here along with
`__tests__/pty-noise.test.ts:4`).

Two of these changed a test rather than only confirming it. M5b initially reddened
only siblings, because the flagship "the ring keeps a dead REPL's last output" case
fired `pane_exited`, which settled the child before the next poll and so pinned the
*event* rather than the read handling it claimed to pin; the case now kills the pane
without an event. And the pid-refusal case used `sleep: async () => {}`, which
starves the event loop rather than running fast — a zero-cost `await` never yields
to a macrotask — so it now sleeps 1 ms.
